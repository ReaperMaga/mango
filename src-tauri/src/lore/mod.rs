//! Epic Games' Lore (https://github.com/EpicGames/lore) behind the same commands as git, so
//! a Lore repository uses the Changes view, diffs, branch popup and log unchanged. Everything
//! shells out to the user's own `lore`, signed in the way they signed in themselves; Mango
//! never handles credentials. In a remote project (`env://…`) the instance's own `lore` runs
//! there, like git (`git::At`).
//!
//! Lore has no machine-readable output: `parse.rs` reads its text, proven against
//! lore 0.14.0+2389. Every command gets `-P` (no pager) and `--non-interactive`, and runs at the
//! repository root (Lore prints paths relative to the folder it runs in).
//!
//! How the ideas map:
//! - status is `lore status --scan`: without `--scan` only files already marked dirty show. The
//!   scan walks the whole working tree, once per refresh of the Changes view;
//! - staging is Lore's own (`stage`/`unstage`); a staged path commits with what is on disk at
//!   commit time. Staging a conflicted path resolves it (`branch merge resolve`), as in git;
//! - commit is `lore commit`; amend is `lore revision amend`, which changes only the message
//!   of a revision not pushed yet;
//! - a revision is shown as `r<number>` and named by its signature (64 hex digits);
//! - fetch asks the server where the branch is (`status --revision-only`), pull is `lore sync`
//!   (which merges when the branch diverged), push is `lore push` (which also publishes a new branch);
//! - the server is the one remote, shown as `remote`; ahead and behind are the difference of
//!   revision numbers, as Lore says only which way the branch differs;
//! - branches: `branch create` (which switches to it), `switch`, `merge` (Lore commits a clean
//!   merge itself), and delete is `branch archive`, which takes the branch off the server too;
//! - the log is linear: Lore's history follows a revision's first parent;
//! - locks (`locks.rs`) are `lore lock`;
//! - no rebase, rename, linked worktrees, stash, pull requests or releases.

pub(crate) mod conflicts;
pub(crate) mod locks;
pub(crate) mod parse;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::git::{
    chunks, clean_rel, finish_diff, lossy, remove_untracked_at, run_process, safe_hash, At, EnvAt, GitBranchList, GitBranches,
    GitCommit, GitCommitDetail, GitCommitFile, GitFile, GitGraph, GitGraphCommit, GitLocalBranch, GitRef, GitRefKind,
    GitRemoteBranch, GitStatus, GraphQuery, Output, Vcs, BASE_CAP, DIFF_CAP, LOCAL_TIMEOUT, SLOW_TIMEOUT,
};
use parse::{Entry, Remote, Revision, Section};

const NOT_INSTALLED: &str = "Lore's `lore` command isn't installed or isn't on PATH. Install Lore (github.com/EpicGames/lore), then reopen Mango.";

/// The name Mango gives the server's side of a branch (Lore has one remote and doesn't name it).
pub(crate) const REMOTE: &str = "remote";

/// A file larger than this is not compared or read as a base.
const DIFF_INPUT_CAP: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Finding lore
// ---------------------------------------------------------------------------

/// The `lore` binary: on PATH (with `~/.local/bin`, where Lore's installer puts it on Linux and
/// macOS), or `%USERPROFILE%\bin`, where its Windows installer does.
fn lore_bin() -> Option<&'static PathBuf> {
    static LORE: OnceLock<Option<PathBuf>> = OnceLock::new();
    LORE.get_or_init(|| {
        crate::bin::find("lore").or_else(|| {
            let mut known: Vec<PathBuf> = Vec::new();
            #[cfg(windows)]
            if let Some(home) = dirs::home_dir() {
                known.push(home.join("bin").join("lore.exe"));
            }
            #[cfg(not(windows))]
            if let Some(home) = dirs::home_dir() {
                known.push(home.join(".local").join("bin").join("lore"));
            }
            known.into_iter().find(|p| crate::bin::is_executable(p))
        })
    })
    .as_ref()
}

// ---------------------------------------------------------------------------
// Running lore
// ---------------------------------------------------------------------------

/// One `lore` invocation at a repository root, here or in an environment.
pub(crate) struct Lore<'a> {
    at: &'a At,
    args: Vec<String>,
    cap: usize,
    timeout: Duration,
    /// In an environment, start it from a login shell (see `EnvAt::run`). Off for reads.
    login: bool,
}

/// A `lore` invocation at `root` that never waits for a pager or a prompt.
pub(crate) fn lore(root: &At) -> Lore<'_> {
    Lore {
        at: root,
        args: ["-P", "--non-interactive"].map(String::from).to_vec(),
        cap: usize::MAX,
        timeout: LOCAL_TIMEOUT,
        login: false,
    }
}

impl Lore<'_> {
    pub(crate) fn arg(mut self, arg: impl AsRef<str>) -> Self {
        self.args.push(arg.as_ref().to_string());
        self
    }
    pub(crate) fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.args.extend(args.into_iter().map(|a| a.as_ref().to_string()));
        self
    }
    /// For what talks to the server or writes: a longer timeout, and the login shell in an environment.
    pub(crate) fn slow(mut self) -> Self {
        self.timeout = SLOW_TIMEOUT;
        self.login = true;
        self
    }
    /// Writes that are quick: the login shell in an environment (a signed-in session may need it).
    pub(crate) fn write(mut self) -> Self {
        self.login = true;
        self
    }
    pub(crate) fn cap(mut self, bytes: usize) -> Self {
        self.cap = bytes;
        self
    }
    /// Work without the server (`--offline`), for a repository that has none.
    fn offline(mut self) -> Self {
        self.args.insert(0, "--offline".into());
        self
    }
    /// The command line, `lore` first.
    pub(crate) fn words(&self) -> Vec<String> {
        let mut w = vec!["lore".to_string()];
        w.extend(self.args.iter().cloned());
        w
    }

    pub(crate) fn run(self) -> Result<Output, String> {
        match self.at {
            At::Local(dir) => {
                let bin = lore_bin().ok_or(NOT_INSTALLED)?;
                let mut cmd = Command::new(bin);
                crate::bin::hide_console(&mut cmd);
                cmd.current_dir(dir).args(&self.args).env("NO_COLOR", "1");
                if let Some(path) = crate::bin::augmented_path(bin.parent()) {
                    cmd.env("PATH", path);
                }
                run_process(cmd, None, self.cap, self.timeout, "lore", NOT_INSTALLED)
            }
            At::Env(e) => {
                let env = [("NO_COLOR".to_string(), "1".to_string())];
                let words = self.words();
                let out = if self.login {
                    e.run(&env, &words, None, self.cap, self.timeout)?
                } else {
                    e.run_plain(&env, &words, None, self.cap, self.timeout)?
                };
                missing_in_env(e, &out).map_or(Ok(out), Err)
            }
        }
    }

    /// Run and turn a failure into a readable error.
    pub(crate) fn run_ok(self) -> Result<Output, String> {
        let out = self.run()?;
        if out.ok() {
            Ok(out)
        } else {
            Err(explain(&out))
        }
    }

    /// [`Lore::run_ok`], once more with `--offline` when the repository has no server (Lore refuses
    /// a merge or an archive there otherwise).
    fn run_ok_offline_too(self) -> Result<Output, String> {
        let again = Lore { at: self.at, args: self.args.clone(), cap: self.cap, timeout: self.timeout, login: self.login };
        let out = self.run()?;
        if out.ok() {
            return Ok(out);
        }
        if no_remote(&out) {
            return again.offline().run_ok();
        }
        Err(explain(&out))
    }
}

/// The message for a command that failed because `lore` isn't installed in the environment.
pub(crate) fn missing_in_env(e: &EnvAt, out: &Output) -> Option<String> {
    let stderr = lossy(&out.stderr);
    (out.code == Some(127) && stderr.contains("lore") && (stderr.contains("not found") || stderr.contains("No such file"))).then(|| {
        format!("Lore is not installed in {}. Install it there (its terminal), then try again.", e.instance)
    })
}

fn no_remote(out: &Output) -> bool {
    out.combined().contains("No remote configured")
}

/// Lore's own error lines without the source locations it prints under them (`  at lore/src/…`).
pub(crate) fn tidy_error(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .filter(|l| !l.trim_start().starts_with("at ") && !l.trim().is_empty())
        .map(|l| l.strip_prefix("[Error] ").unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A failed command's reason, with a plain-language first line for the failures people hit.
pub(crate) fn explain(out: &Output) -> String {
    let detail = tidy_error(&out.combined());
    let detail = if detail.is_empty() {
        match out.code {
            Some(code) => format!("lore failed (exit code {code})"),
            None => "lore was interrupted".to_string(),
        }
    } else {
        detail
    };
    explain_text(detail)
}

pub(crate) fn explain_text(detail: String) -> String {
    let lower = detail.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    let lead = if has(&["not authorized", "unauthorized", "unauthenticated", "permission denied", "forbidden", "login required", "not logged in", "token expired", "invalid token"]) {
        "Lore couldn't sign in to the server. Sign in to it first (`lore login` in a terminal), then try again."
    } else if has(&["disconnected from server", "transport error", "connection refused", "timed out", "could not connect", "unreachable"]) {
        "Couldn't reach the Lore server. Check that it is running and reachable, then try again."
    } else if has(&["no remote configured"]) {
        "This Lore repository has no server, so there is nothing to send to or read from."
    } else if has(&["branch has diverged"]) {
        "The server has revisions this branch doesn't have yet. Pull first, then try again."
    } else if has(&["local modifications prevent synchronization", "file has local changes"]) {
        "Your changes touch files that are changing here. Commit or discard them, then try again."
    } else if has(&["unable to sync when there is a staged state", "cannot merge with staged state"]) {
        "Lore can't do this while changes are staged. Commit or unstage them first."
    } else if has(&["a merge is already in progress"]) {
        "A merge is in progress. Resolve its conflicts and commit it, or abort it from the bar at the top of the Changes view, first."
    } else if has(&["repository not found"]) {
        "This folder isn't in a Lore repository any more."
    } else {
        return detail;
    };
    format!("{lead}\n\n{detail}")
}

pub(crate) fn unsupported<T>(what: &str) -> Result<T, String> {
    Err(format!("{what} isn't available for Lore projects."))
}

/// A branch name that is safe to hand to `lore` (after `--`).
pub(crate) fn safe_branch(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a branch name".into());
    }
    let bad = name.starts_with(['-', '/'])
        || name.ends_with('/')
        || name.contains("..")
        || name.contains("//")
        || name.chars().any(|c| c.is_whitespace() || c.is_control() || "\"'@:;*?<>|\\$`~^[]{}".contains(c));
    if bad {
        return Err(format!("\"{name}\" is not a valid branch name"));
    }
    Ok(name)
}

/// A revision signature from the UI: 64 hex digits (shorter is refused: Lore wants the whole one).
fn safe_signature(hash: &str) -> Result<&str, String> {
    let hash = safe_hash(hash)?;
    if hash.len() != 64 {
        return Err(format!("\"{hash}\" is not a Lore revision signature"));
    }
    Ok(hash)
}

// ---------------------------------------------------------------------------
// Where the repository is
// ---------------------------------------------------------------------------

/// `sh` script (in an environment's folder): prints `lore <root>` when the nearest of `.git` and
/// `.lore` walking up from here is a `.lore` folder (git wins in the same folder, as on disk).
const PROBE: &str = r#"d=$PWD
while :; do
  [ -e "$d/.git" ] && exit 0
  if [ -d "$d/.lore" ]; then printf 'lore %s\n' "$d"; exit 0; fi
  case $d in /|'') exit 0 ;; esac
  d=$(dirname -- "$d")
done"#;

/// The probe as words for a batch: run with the status read, it costs no round trip of its own.
pub(crate) fn probe_words() -> Vec<String> {
    ["sh", "-c", PROBE].map(String::from).to_vec()
}

/// The Lore root the probe found; None when the folder is git or nothing.
pub(crate) fn probe_root(out: &Output) -> Option<String> {
    out.text().lines().find_map(|l| l.strip_prefix("lore ").map(str::to_string)).filter(|r| r.starts_with('/'))
}

/// What is known about remote folders: the Lore root, or None for "not Lore" (git or nothing).
/// Each status read refreshes it; a stale entry only makes a command fail with its own message.
fn env_roots() -> &'static Mutex<HashMap<String, Option<String>>> {
    static ROOTS: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    ROOTS.get_or_init(Default::default)
}

fn env_key(e: &EnvAt) -> String {
    format!("{}\u{0}{}\u{0}{}", e.host.id, e.instance, e.dir)
}

/// What the last status read (or probe) found for this remote folder; None when it was never asked.
pub(crate) fn env_known(e: &EnvAt) -> Option<Option<String>> {
    env_roots().lock().ok()?.get(&env_key(e)).cloned()
}

pub(crate) fn remember_env(e: &EnvAt, root: Option<String>) {
    if let Ok(mut map) = env_roots().lock() {
        map.insert(env_key(e), root);
    }
}

/// Look for a Lore repository around a remote folder: one round trip, for a command that comes
/// before any status read of the folder.
pub(crate) fn probe_env(e: &EnvAt) -> Result<Option<String>, String> {
    let out = e.sh(PROBE, &[])?;
    Ok(probe_root(&out))
}

/// The repository root `root` points at, as a string.
fn root_text(root: &At) -> String {
    match root {
        At::Local(p) => p.to_string_lossy().into_owned(),
        At::Env(e) => e.dir.clone(),
    }
}

/// `file` (relative to `folder`, a folder inside the repository at `root`) relative to the root.
fn rel_to_root(root: &At, folder: &str, file: &str) -> Result<String, String> {
    let file = clean_rel(file)?.replace('\\', "/");
    let root = root_text(root).replace('\\', "/");
    let folder = folder.trim().replace('\\', "/");
    let root_t = root.trim_end_matches('/');
    let inner = folder.trim_end_matches('/').strip_prefix(root_t).ok_or_else(|| format!("{folder} is not inside the Lore repository at {root}"))?;
    if !(inner.is_empty() || inner.starts_with('/')) {
        return Err(format!("{folder} is not inside the Lore repository at {root}"));
    }
    let inner = inner.trim_start_matches('/');
    Ok(if inner.is_empty() { file } else { format!("{inner}/{file}") })
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// The pending changes from the last status read, by root, so a diff needs no second scan. Shared,
/// not copied: a large repository lists tens of thousands of them.
fn last_status() -> &'static Mutex<HashMap<String, Arc<Vec<Entry>>>> {
    static LAST: OnceLock<Mutex<HashMap<String, Arc<Vec<Entry>>>>> = OnceLock::new();
    LAST.get_or_init(Default::default)
}

/// The last status read's entries for `root`, if any (the lock is held only to clone the `Arc`).
fn cached_entries(root: &At) -> Option<Arc<Vec<Entry>>> {
    last_status().lock().ok().and_then(|m| m.get(&key(root)).cloned())
}

fn key(root: &At) -> String {
    match root {
        At::Local(p) => {
            let k = p.to_string_lossy().replace('\\', "/");
            if cfg!(windows) { k.to_lowercase() } else { k }
        }
        At::Env(e) => env_key(e),
    }
}

/// `lore status --scan`, read. Its entries are also kept for the diffs that follow.
fn read_status(root: &At) -> Result<(parse::Status, Arc<Vec<Entry>>), String> {
    let out = lore(root).args(["status", "--scan"]).run_ok()?;
    let mut parsed = parse::parse_status(&out.text());
    if parsed.branch.is_none() && parsed.revision.is_none() {
        return Err(format!("Lore gave no status for {}.\n\n{}", root.shown(), tidy_error(&out.combined())));
    }
    let entries = Arc::new(std::mem::take(&mut parsed.entries));
    if let Ok(mut map) = last_status().lock() {
        map.insert(key(root), entries.clone());
    }
    Ok((parsed, entries))
}

/// Every folder with something listed under it (of `entries`, or only their files when `files_only`):
/// each path's ancestors, so a folder is looked up instead of every path being scanned for it.
fn parents_listed<'a>(entries: impl IntoIterator<Item = &'a Entry>, files_only: bool) -> HashSet<&'a str> {
    let mut out = HashSet::new();
    for e in entries {
        if files_only && e.dir {
            continue;
        }
        let mut path = e.path.as_str();
        while let Some(cut) = path.rfind('/') {
            path = &path[..cut];
            // Already there: so are its own ancestors.
            if !out.insert(path) {
                break;
            }
        }
    }
    out
}

/// The changes the Changes view lists: a directory is a row of its own only when it is deleted (or
/// moved) and none of its files are listed; an added directory's files are listed one by one.
fn files_of(entries: &[Entry]) -> Vec<GitFile> {
    let parents = parents_listed(entries, false);
    let mut out: Vec<GitFile> = Vec::with_capacity(entries.len());
    let mut row: HashMap<&str, usize> = HashMap::with_capacity(entries.len());
    for e in entries {
        if e.dir && (!matches!(e.letter, "D" | "R") || parents.contains(e.path.as_str())) {
            continue;
        }
        let (index, worktree, conflicted) = match e.section {
            Section::Staged => (Some(e.letter.to_string()), None, false),
            Section::Unstaged => (None, Some(e.letter.to_string()), false),
            Section::Untracked => (None, Some("?".to_string()), false),
            Section::Conflict => (None, Some("U".to_string()), true),
        };
        if let Some(&i) = row.get(e.path.as_str()) {
            // Listed twice (staged and changed again): both sides, as git shows it.
            let f = &mut out[i];
            f.index = f.index.take().or(index);
            f.worktree = f.worktree.take().or(worktree);
            f.conflicted |= conflicted;
            continue;
        }
        row.insert(e.path.as_str(), out.len());
        out.push(GitFile { path: e.path.clone(), orig_path: e.orig.clone().filter(|_| e.letter == "R"), index, worktree, conflicted });
    }
    out
}

/// Ahead and behind, from revision numbers: Lore says only which way the branch differs. A revision
/// number is one more than its parent's highest, so along one line of history the difference is
/// the count; across a merge it is a fair guess, and at least 1 whichever way it says.
fn ahead_behind(s: &parse::Status) -> (u32, u32) {
    let (Some(local), Some(remote)) = (s.revision, s.remote_revision) else { return (0, 0) };
    let up = (local.saturating_sub(remote)).max(1) as u32;
    let down = (remote.saturating_sub(local)).max(1) as u32;
    match s.remote {
        Remote::Ahead => (up, 0),
        Remote::Behind => (0, down),
        Remote::Diverged => (up, down),
        // "In sync" counts the branch's latest; the working tree may sit on an older revision.
        Remote::InSync if remote > local => (0, (remote - local) as u32),
        _ => (0, 0),
    }
}

pub(crate) fn status_from(root: &At, s: &parse::Status, entries: &[Entry]) -> GitStatus {
    let (ahead, behind) = ahead_behind(&s);
    let upstream = match (&s.branch, s.remote) {
        (Some(b), Remote::InSync | Remote::Ahead | Remote::Behind | Remote::Diverged) => Some(format!("{REMOTE}/{b}")),
        _ => None,
    };
    GitStatus {
        vcs: Vcs::Lore,
        repository: None,
        is_repo: true,
        root: Some(root_text(root)),
        main_root: None,
        branch: s.branch.clone(),
        head: s.revision.filter(|&n| n > 0).map(|n| format!("r{n}")),
        upstream,
        ahead,
        behind,
        files: files_of(entries),
        operation: conflicts::operation(s),
    }
}

pub(crate) fn status(root: &At) -> Result<GitStatus, String> {
    root.check()?;
    let (s, entries) = read_status(root)?;
    conflicts::learn_name(root, &s);
    Ok(status_from(root, &s, &entries))
}

/// The pending change for `file`, from the last status read (or a new one).
fn entry_for(root: &At, file: &str) -> Result<Option<Entry>, String> {
    let entries = match cached_entries(root) {
        Some(e) => e,
        None => read_status(root)?.1,
    };
    Ok(entries.iter().find(|e| e.path == file).cloned())
}

// ---------------------------------------------------------------------------
// Diffs and file contents
// ---------------------------------------------------------------------------

/// `sh` script (in an environment's repository): `lore file write` of `$1` (at revision `$2`, or
/// the current one when empty) into a temporary file, printed. Exits like lore when it fails.
const FILE_AT: &str = r#"t=$(mktemp) || exit 1
trap 'rm -f -- "$t"' EXIT
if [ -n "$2" ]; then
  lore -P --non-interactive file write --path "$1" --revision "$2" --output "$t" >/dev/null || exit $?
else
  lore -P --non-interactive file write --path "$1" --output "$t" >/dev/null || exit $?
fi
cat -- "$t""#;

/// What `rel` holds in the current revision (or `revision`), up to `cap` bytes; None when it
/// isn't there or is larger.
fn content_at(root: &At, rel: &str, revision: Option<&str>, cap: usize) -> Result<Option<Vec<u8>>, String> {
    let rel = clean_rel(rel)?;
    match root {
        At::Local(_) => {
            let tmp = std::env::temp_dir().join(format!("mango-lore-{}", uuid::Uuid::new_v4()));
            let mut cmd = lore(root).args(["file", "write", "--path", rel]);
            if let Some(r) = revision {
                cmd = cmd.args(["--revision", r]);
            }
            let out = cmd.arg("--output").arg(tmp.to_string_lossy()).run();
            let result = match out {
                Ok(o) if o.ok() => read_capped(&tmp, cap),
                Ok(o) if o.combined().contains("not found") => Ok(None),
                Ok(o) => Err(explain(&o)),
                Err(e) => Err(e),
            };
            let _ = std::fs::remove_file(&tmp);
            result
        }
        At::Env(e) => {
            let out = e.run_plain(&[], &sh_words(FILE_AT, &[rel, revision.unwrap_or("")]), None, cap.saturating_add(1), LOCAL_TIMEOUT)?;
            if let Some(missing) = missing_in_env(e, &out) {
                return Err(missing);
            }
            if !out.ok() {
                return if out.combined().contains("not found") { Ok(None) } else { Err(explain(&out)) };
            }
            Ok((!out.truncated && out.stdout.len() <= cap).then_some(out.stdout))
        }
    }
}

fn sh_words(script: &str, args: &[&str]) -> Vec<String> {
    let mut w: Vec<String> = ["sh", "-c", script, "sh"].map(String::from).to_vec();
    w.extend(args.iter().map(|a| a.to_string()));
    w
}

fn read_capped(path: &std::path::Path, cap: usize) -> Result<Option<Vec<u8>>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if meta.len() as usize > cap {
        return Ok(None);
    }
    std::fs::read(path).map(Some).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// The working tree's copy of `rel`, up to `cap` bytes; None when it is missing or larger.
fn current_content(root: &At, rel: &str, cap: usize) -> Result<Option<Vec<u8>>, String> {
    let rel = clean_rel(rel)?;
    match root {
        At::Local(dir) => match std::fs::metadata(dir.join(rel)) {
            Ok(m) if m.is_file() => read_capped(&dir.join(rel), cap),
            _ => Ok(None),
        },
        At::Env(e) => {
            let out = e.sh(r#"[ -f "$1" ] && exec cat -- "$1"; exit 3"#, &[rel])?;
            Ok((out.ok() && out.stdout.len() <= cap).then_some(out.stdout))
        }
    }
}

fn cap_diff(text: String) -> String {
    let truncated = text.len() > DIFF_CAP;
    let mut bytes = text.into_bytes();
    if truncated {
        bytes.truncate(DIFF_CAP);
    }
    finish_diff(bytes, truncated)
}

/// The diff of one changed file against the current revision, git-style. Staged or not is the same
/// diff in Lore: a staged path commits with what is on disk.
pub(crate) fn diff(root: &At, file: &str) -> Result<String, String> {
    let file = clean_rel(file)?;
    let entry = entry_for(root, file)?;
    if let Some(e) = &entry {
        if e.dir {
            return Ok(match (&e.orig, e.letter) {
                (Some(orig), "R") => crate::plastic::unified_diff(Some(orig), Some(&e.path), Some(b""), Some(b"")),
                _ => String::new(),
            });
        }
        // A move: Lore diffs the new path as a new file; compare it with where it came from.
        if let (Some(orig), "R") = (&e.orig, e.letter) {
            let old = content_at(root, orig, None, DIFF_INPUT_CAP)?;
            let new = current_content(root, &e.path, DIFF_INPUT_CAP)?;
            return Ok(cap_diff(crate::plastic::unified_diff(Some(orig), Some(&e.path), old.as_deref(), new.as_deref())));
        }
    }
    let out = lore(root).cap(DIFF_CAP * 2).args(["diff", "--"]).arg(file).run()?;
    if !out.ok() && !out.truncated {
        return Err(explain(&out));
    }
    Ok(cap_diff(parse::to_git_diff(&out.text())))
}

/// What `file` (relative to `folder`, inside the repository at `root`) holds in the current
/// revision, for the editor's change markers. None for a new file, a binary or too large one.
pub(crate) fn base(root: &At, folder: &str, file: &str) -> Result<Option<String>, String> {
    let rel = rel_to_root(root, folder, file)?;
    let bytes = match entry_for(root, &rel)? {
        // Unchanged: on this computer the file is its own base, no need to ask Lore.
        None if matches!(root, At::Local(_)) => current_content(root, &rel, BASE_CAP)?,
        None => content_at(root, &rel, None, BASE_CAP)?,
        Some(e) if e.dir || e.letter == "A" || e.section == Section::Untracked => return Ok(None),
        Some(e) => content_at(root, e.orig.as_deref().unwrap_or(&e.path), None, BASE_CAP)?,
    };
    Ok(bytes.filter(|b| b.len() <= BASE_CAP && !b.contains(&0)).and_then(|b| String::from_utf8(b).ok()))
}

// ---------------------------------------------------------------------------
// Staging, discarding, committing
// ---------------------------------------------------------------------------

fn check_paths(files: &[String]) -> Result<(), String> {
    files.iter().try_for_each(|f| clean_rel(f).map(|_| ()))
}

/// Stage paths; a conflicted path is resolved with what is on disk (as `git add` does). Empty: everything.
pub(crate) fn stage(root: &At, files: &[String]) -> Result<(), String> {
    check_paths(files)?;
    if files.is_empty() {
        lore(root).write().args(["stage", "--scan", "--", "."]).run_ok()?;
        return Ok(());
    }
    let asked: HashSet<&str> = files.iter().map(String::as_str).collect();
    let conflicted: Vec<String> = cached_entries(root)
        .iter()
        .flat_map(|entries| entries.iter())
        .filter(|e| e.section == Section::Conflict && asked.contains(e.path.as_str()))
        .map(|e| e.path.clone())
        .collect();
    let resolving: HashSet<&str> = conflicted.iter().map(String::as_str).collect();
    let plain: Vec<String> = files.iter().filter(|f| !resolving.contains(f.as_str())).cloned().collect();
    let mut left: Vec<String> = Vec::new();
    for chunk in chunks(&conflicted) {
        let out = lore(root).write().args(["branch", "merge", "resolve", "--"]).args(chunk).run_ok()?;
        // Lore refuses a file that still has conflict markers, and exits 0 all the same.
        left.extend(parse::markers_left(&out.combined()));
    }
    for chunk in chunks(&plain) {
        lore(root).write().args(["stage", "--"]).args(chunk).run_ok()?;
    }
    if let Some(first) = left.first() {
        return Err(if left.len() == 1 {
            format!("{first} still has conflict markers, so Lore keeps it in conflict. Remove them (or take one side whole), then mark it resolved.")
        } else {
            format!("{} files still have conflict markers, so Lore keeps them in conflict: {}. Remove them (or take one side whole), then mark them resolved.", left.len(), left.join(", "))
        });
    }
    Ok(())
}

pub(crate) fn unstage(root: &At, files: &[String]) -> Result<(), String> {
    check_paths(files)?;
    if files.is_empty() {
        lore(root).write().args(["unstage", "--", "."]).run_ok()?;
        return Ok(());
    }
    // The other half of a move, or it stays behind staged.
    let mut paths: Vec<String> = files.to_vec();
    let asked: HashSet<&str> = files.iter().map(String::as_str).collect();
    for e in cached_entries(root).iter().flat_map(|entries| entries.iter()) {
        if e.section == Section::Staged && asked.contains(e.path.as_str()) {
            paths.extend(e.orig.clone());
        }
    }
    paths.sort();
    paths.dedup();
    for chunk in chunks(&paths) {
        lore(root).write().args(["unstage", "--"]).args(chunk).run_ok()?;
    }
    Ok(())
}

/// Throw away changes: a changed or deleted file goes back to the current revision (`lore reset`),
/// a new one is deleted, a staged one is unstaged first (Lore resets only unstaged paths). An
/// empty list means every change that isn't staged; conflicts are never discarded here.
pub(crate) fn discard(root: &At, files: &[String]) -> Result<(), String> {
    check_paths(files)?;
    let (_, entries) = read_status(root)?;
    let asked: HashSet<&str> = files.iter().map(String::as_str).collect();
    let with_files = parents_listed(entries.iter(), true);
    let targets: Vec<&Entry> = entries
        .iter()
        .filter(|e| if files.is_empty() { matches!(e.section, Section::Unstaged | Section::Untracked) } else { asked.contains(e.path.as_str()) })
        // A directory's files are listed (and discarded) one by one, unless only the directory is.
        .filter(|e| !e.dir || !with_files.contains(e.path.as_str()))
        .collect();
    if let Some(e) = targets.iter().find(|e| e.section == Section::Conflict) {
        return Err(format!("{} has merge conflicts. Resolve them, or abort the merge, instead of discarding.", e.path));
    }
    let staged: Vec<String> = targets
        .iter()
        .filter(|e| e.section == Section::Staged)
        .flat_map(|e| std::iter::once(e.path.clone()).chain(e.orig.clone()))
        .collect();
    for chunk in chunks(&staged) {
        lore(root).write().args(["unstage", "--"]).args(chunk).run_ok()?;
    }
    let mut reset: Vec<String> = Vec::new();
    let mut delete: Vec<String> = Vec::new();
    for e in &targets {
        match (e.section, e.letter) {
            (Section::Untracked, _) | (Section::Staged, "A") => {
                if !e.dir {
                    delete.push(e.path.clone());
                }
            }
            (_, "R") => {
                // Back to where it was: the old path comes back, the new one goes.
                reset.extend(e.orig.clone());
                reset.push(e.path.clone());
                if !e.dir {
                    delete.push(e.path.clone());
                }
            }
            _ => reset.push(e.path.clone()),
        }
    }
    for chunk in chunks(&reset) {
        lore(root).write().args(["reset", "--"]).args(chunk).run_ok()?;
    }
    for path in &delete {
        remove_untracked_at(root, path)?;
    }
    Ok(())
}

/// The revision a commit, amend or merge made, as `r<n>`.
fn made(out: &Output) -> String {
    parse::parse_revisions(&out.text())
        .first()
        .map(Revision::short)
        .or_else(|| parse::committed_merge(&out.text()).map(|n| format!("r{n}")))
        .unwrap_or_else(|| "a new revision".into())
}

/// Commit what is staged (`lore commit`). Returns the new revision, `r12`.
pub(crate) fn commit(root: &At, message: &str, amend: bool) -> Result<String, String> {
    if amend {
        return amend_message(root, message);
    }
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a commit message first".into());
    }
    let out = lore(root).slow().args(["commit", "--"]).arg(message).run()?;
    if !out.ok() {
        if out.combined().contains("Nothing staged for commit") {
            return Err("Nothing is staged. Stage the changes you want in this commit first.".into());
        }
        return Err(explain(&out));
    }
    Ok(made(&out))
}

/// Lore amends only the message of the newest revision, and only before it is pushed.
fn amend_message(root: &At, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write the new message first: Lore can change only the last revision's message.".into());
    }
    let (s, entries) = read_status(root)?;
    if entries.iter().any(|e| e.section == Section::Staged) {
        return Err("Lore can change only the last revision's message, not its files. Commit the staged changes as a new revision, or unstage them to amend the message.".into());
    }
    if s.revision.unwrap_or(0) == 0 {
        return Err("There is no revision to amend yet.".into());
    }
    if matches!(s.remote, Remote::InSync | Remote::Behind) && s.remote_revision.is_some_and(|r| r >= s.revision.unwrap_or(0)) {
        return Err("The last revision is already on the server, so it can't be amended. Commit a new revision instead.".into());
    }
    let out = lore(root).write().args(["revision", "amend", "--"]).arg(message).run_ok()?;
    Ok(made(&out))
}

/// Lore has no fetch: ask the server where the branch is, which the status then shows.
pub(crate) fn fetch(root: &At) -> Result<String, String> {
    let out = lore(root).slow().args(["status", "--revision-only"]).run_ok()?;
    let s = parse::parse_status(&out.text());
    if s.remote == Remote::Unknown {
        return Err(explain_text(
            "Lore didn't say where the server's copy of this branch is: the repository has no server, or it didn't answer.".into(),
        ));
    }
    Ok(String::new())
}

/// Pull is `lore sync`: up to the server's latest revision of the branch, merging when the branch
/// diverged (conflicts stay in the Changes view). Empty when there was nothing to do.
pub(crate) fn pull(root: &At) -> Result<String, String> {
    let out = lore(root).slow().arg("sync").run_ok()?;
    let text = out.combined();
    if text.contains("could not read remote revision") {
        return Err(explain_text(format!(
            "Couldn't reach the Lore server, so nothing was pulled.\n\n{}",
            tidy_error(&text)
        )));
    }
    if text.contains("performing merge") {
        return Ok("Merged the server's revisions into this branch. Conflicts, if any, are in the Changes list.".into());
    }
    Ok(match parse::synced_to(&text) {
        Some(n) => format!("Synced to r{n}."),
        None => String::new(),
    })
}

/// `lore push`: sends the branch's new revisions, and publishes a branch the server doesn't have.
pub(crate) fn push(root: &At) -> Result<String, String> {
    let out = lore(root).slow().arg("push").run_ok()?;
    Ok(match parse::pushed(&out.text()) {
        Some((n, branch)) => format!("Pushed r{n} to {branch}."),
        None => String::new(),
    })
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

fn history(root: &At, count: u32, from: Option<&str>) -> Result<Vec<Revision>, String> {
    let mut cmd = lore(root).arg("history");
    if let Some(from) = from {
        cmd = cmd.args(["--revision", from]);
    }
    let out = cmd.arg("--").arg(count.max(1).to_string()).run_ok()?;
    Ok(parse::parse_revisions(&out.text()))
}

pub(crate) fn log(root: &At, limit: u32) -> Result<Vec<GitCommit>, String> {
    Ok(history(root, limit.clamp(1, 500), None)?
        .into_iter()
        .map(|r| GitCommit { short_hash: r.short(), subject: r.subject(), author: r.author.clone(), time: r.time.max(0) as u64, hash: r.signature })
        .collect())
}

/// Revisions read (per line of history) when the log is filtered by text (Lore filters nothing itself).
const SEARCH_DEPTH: u32 = 2000;

/// Where one line of the log starts: a branch's latest revision (named, for its label), the
/// working tree's (`spec: None`, what `lore history` reads with no revision), or one revision.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Start {
    branch: Option<String>,
    spec: Option<String>,
}

/// A revision as the UI names it: `r12`, `12` or a signature.
fn is_revision(rev: &str) -> bool {
    rev.strip_prefix('r').unwrap_or(rev).parse::<u64>().is_ok() || (rev.len() == 64 && rev.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The starts for `refs`: none is every local branch (each its own line of history, as git's "all
/// branches"), `HEAD` the working tree's branch (Lore has no HEAD), anything else a branch or revision.
fn starts(refs: &[&str], current: Option<&str>, local: impl FnOnce() -> Vec<String>) -> Result<Vec<Start>, String> {
    let here = || Start { branch: current.map(String::from), spec: None };
    let branch = |name: &str| -> Result<Start, String> {
        if Some(name) == current {
            return Ok(here());
        }
        Ok(Start { branch: Some(safe_branch(name)?.to_string()), spec: Some(revision_spec(name)?) })
    };
    let mut out: Vec<Start> = Vec::new();
    if refs.is_empty() {
        out.push(here());
        out.extend(local().iter().filter(|n| Some(n.as_str()) != current).filter_map(|n| branch(n).ok()));
        return Ok(out);
    }
    for r in refs {
        let start = if *r == "HEAD" {
            here()
        } else if is_revision(r) {
            Start { branch: None, spec: Some(revision_spec(r)?) }
        } else {
            // The server's side of a branch (`remote/main`) reads as the branch.
            branch(r.strip_prefix(&format!("{REMOTE}/")).unwrap_or(r))?
        };
        if !out.contains(&start) {
            out.push(start);
        }
    }
    Ok(out)
}

/// One revision of the merged log: its parents and the branches whose latest it is.
type Line = (Revision, Vec<String>, Vec<String>);

/// Several lines of history as one list, newest first: by revision number (one more than its
/// parent's highest, so a child always comes before its parents), then date. A revision's parent is
/// the next one on its line, and a merge's other side its second parent. Also says whether any line
/// was cut short at `read`.
fn merge_lines(lines: Vec<(Start, Vec<Revision>)>, read: u32) -> (Vec<Line>, bool) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut all: Vec<Line> = Vec::new();
    let mut cut = false;
    for (start, revs) in lines {
        cut |= revs.len() >= read as usize;
        for (i, r) in revs.iter().enumerate() {
            let at = *seen.entry(r.signature.clone()).or_insert_with(|| {
                let mut parents: Vec<String> = revs.get(i + 1).map(|p| p.signature.clone()).into_iter().collect();
                parents.extend(r.merge.clone().filter(|m| !parents.contains(m)));
                all.push((r.clone(), parents, Vec::new()));
                all.len() - 1
            });
            if let (0, Some(b)) = (i, &start.branch) {
                if !all[at].2.contains(b) {
                    all[at].2.push(b.clone());
                }
            }
        }
    }
    all.sort_by(|a, b| b.0.number.cmp(&a.0.number).then(b.0.time.cmp(&a.0.time)));
    (all, cut)
}

/// A page of the log, newest first. `refs` empty is every local branch; otherwise branches (`remote/x`
/// reads as `x`), `HEAD` (the working tree's) or revisions. Text matches messages and revisions, author
/// the creator. Lore can't filter by file.
pub(crate) fn graph(root: &At, q: &GraphQuery) -> Result<GitGraph, String> {
    if q.paths.iter().flatten().any(|p| !p.trim().is_empty()) {
        return unsupported("Filtering the log by file");
    }
    let status = parse::parse_status(&lore(root).args(["status", "--revision-only"]).run_ok()?.text());
    let refs: Vec<&str> = q.refs.iter().flatten().map(|r| r.trim()).filter(|r| !r.is_empty()).collect();
    // `branch list` is local; without it the current branch's line alone.
    let starts = starts(&refs, status.branch.as_deref(), || read_branches(root).map(|b| b.local).unwrap_or_default())?;
    let text = q.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_lowercase);
    let author = q.author.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(str::to_lowercase);
    let filtered = text.is_some() || author.is_some();
    let limit = q.limit.clamp(1, 1000);
    let want = q.skip.saturating_add(limit);
    let read = if filtered { SEARCH_DEPTH } else { want.saturating_add(1) };
    // One `lore history` per line, side by side: each is a process, or an SSH round trip.
    let answers: Vec<(Start, Result<Vec<Revision>, String>)> = std::thread::scope(|s| {
        let running: Vec<_> = starts
            .into_iter()
            .map(|start| {
                let spec = start.spec.clone();
                (start, s.spawn(move || history(root, read, spec.as_deref())))
            })
            .collect();
        running
            .into_iter()
            .map(|(start, h)| (start, h.join().unwrap_or_else(|_| Err("Reading Lore's history failed.".to_string()))))
            .collect()
    });
    // A line that can't be read fails the log when it was the only one asked for, and is left out otherwise.
    let only = answers.len() == 1;
    let mut lines = Vec::new();
    for (start, revs) in answers {
        match revs {
            Ok(revs) => lines.push((start, revs)),
            Err(e) if only => return Err(e),
            Err(_) => {}
        }
    }
    let (all, cut) = merge_lines(lines, read);
    let kept: Vec<&Line> = all
        .iter()
        .filter(|(r, ..)| text.as_ref().is_none_or(|t| r.message.to_lowercase().contains(t) || r.signature.starts_with(t.as_str()) || r.short() == *t))
        .filter(|(r, ..)| author.as_ref().is_none_or(|a| r.author.to_lowercase().contains(a)))
        .collect();
    let more = kept.len() > want as usize || (!filtered && cut);
    let commits = kept
        .into_iter()
        .skip(q.skip as usize)
        .take(limit as usize)
        .map(|(r, parents, branches)| {
            let mut refs: Vec<GitRef> = branches
                .iter()
                .map(|b| GitRef {
                    name: b.clone(),
                    kind: GitRefKind::Branch,
                    current: status.branch.as_ref() == Some(b) && status.signature.as_ref() == Some(&r.signature),
                })
                .collect();
            if let (Some(b), Some(sig)) = (&status.branch, &status.remote_signature) {
                if *sig == r.signature {
                    refs.push(GitRef { name: format!("{REMOTE}/{b}"), kind: GitRefKind::Remote, current: false });
                }
            }
            GitGraphCommit {
                hash: r.signature.clone(),
                short_hash: r.short(),
                parents: parents.clone(),
                subject: r.subject(),
                author: r.author.clone(),
                author_email: String::new(),
                time: r.time,
                refs,
            }
        })
        .collect();
    Ok(GitGraph { head: status.signature.clone(), branch: status.branch.clone(), commits, more })
}

/// A revision named in the UI: a signature, `r12` / `12`, or a branch (its latest revision).
fn revision_spec(rev: &str) -> Result<String, String> {
    let rev = rev.trim();
    if let Some(n) = rev.strip_prefix('r').unwrap_or(rev).parse::<u64>().ok().filter(|_| !rev.is_empty()) {
        return Ok(n.to_string());
    }
    if rev.len() == 64 && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(rev.to_string());
    }
    // The server's side of a branch (`remote/main`) reads as the branch.
    let rev = rev.strip_prefix(&format!("{REMOTE}/")).unwrap_or(rev);
    Ok(format!("{}@LATEST", safe_branch(rev)?))
}

/// One revision with its full message and the files it changed.
pub(crate) fn commit_show(root: &At, hash: &str) -> Result<GitCommitDetail, String> {
    let sig = safe_signature(hash)?;
    let out = lore(root).args(["revision", "info", "--delta", "--"]).arg(sig).run_ok()?;
    let r = parse::parse_revisions(&out.text()).into_iter().next().ok_or_else(|| format!("Lore has no revision {sig}"))?;
    let (subject, body) = match r.message.split_once('\n') {
        Some((s, b)) => (s.trim().to_string(), b.trim().to_string()),
        None => (r.message.trim().to_string(), String::new()),
    };
    // A directory is listed without its slash here; it is a directory when other paths sit under it.
    let parents = parents_listed(&r.changes, false);
    let files = r
        .changes
        .iter()
        .filter(|e| !e.dir && !parents.contains(e.path.as_str()))
        .map(|e| GitCommitFile { path: e.path.clone(), old_path: e.orig.clone(), status: e.letter.to_string(), additions: None, deletions: None })
        .collect();
    Ok(GitCommitDetail {
        hash: r.signature.clone(),
        short_hash: r.short(),
        parents: r.parents.clone(),
        subject,
        body,
        author: r.author.clone(),
        author_email: String::new(),
        time: r.time,
        committer: r.committer.clone(),
        commit_time: r.time,
        refs: Vec::new(),
        files,
    })
}

/// One file of a revision against its first parent.
pub(crate) fn commit_diff(root: &At, hash: &str, file: &str) -> Result<String, String> {
    let sig = safe_signature(hash)?;
    let file = clean_rel(file)?;
    let info = lore(root).args(["revision", "info", "--"]).arg(sig).run_ok()?;
    let parent = parse::parse_revisions(&info.text()).into_iter().next().and_then(|r| r.parents.into_iter().next());
    let Some(parent) = parent else {
        // The first revision: everything in it is new.
        let new = content_at(root, file, Some(sig), DIFF_INPUT_CAP)?;
        return Ok(cap_diff(crate::plastic::unified_diff(None, Some(file), None, new.as_deref())));
    };
    let out = lore(root).cap(DIFF_CAP * 2).args(["diff", "--source", &parent, "--target", sig, "--"]).arg(file).run()?;
    if !out.ok() && !out.truncated {
        return Err(explain(&out));
    }
    Ok(cap_diff(parse::to_git_diff(&out.text())))
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

fn read_branches(root: &At) -> Result<parse::Branches, String> {
    Ok(parse::parse_branches(&lore(root).args(["branch", "list"]).run_ok()?.text()))
}

pub(crate) fn branches(root: &At) -> Result<GitBranches, String> {
    let b = read_branches(root)?;
    let mut local = b.local;
    local.sort();
    Ok(GitBranches { current: b.current, local })
}

pub(crate) fn branch_list(root: &At) -> Result<GitBranchList, String> {
    let b = read_branches(root)?;
    let local = b
        .local
        .iter()
        .map(|name| GitLocalBranch {
            is_current: b.current.as_deref() == Some(name.as_str()),
            upstream: b.remote.contains(name).then(|| format!("{REMOTE}/{name}")),
            upstream_gone: false,
            ahead: 0,
            behind: 0,
            time: 0,
            subject: String::new(),
            name: name.clone(),
        })
        .collect();
    let remote: Vec<GitRemoteBranch> = b
        .remote
        .iter()
        .map(|name| GitRemoteBranch { name: format!("{REMOTE}/{name}"), remote: REMOTE.into(), time: 0, subject: String::new() })
        .collect();
    let remotes = if remote.is_empty() { Vec::new() } else { vec![REMOTE.to_string()] };
    Ok(GitBranchList { current: b.current, local, remote, remotes })
}

fn switch(root: &At, branch: &str) -> Result<(), String> {
    let branch = safe_branch(branch)?;
    lore(root).slow().args(["branch", "switch", "--"]).arg(branch).run_ok()?;
    Ok(())
}

pub(crate) fn checkout(root: &At, branch: &str, create: bool) -> Result<(), String> {
    if create {
        branch_create(root, branch, None, true)
    } else {
        switch(root, branch)
    }
}

/// Bring the working tree to one revision of its branch (`lore sync <signature>`).
pub(crate) fn checkout_commit(root: &At, hash: &str) -> Result<(), String> {
    let sig = safe_signature(hash)?;
    lore(root).slow().args(["sync", "--"]).arg(sig).run_ok()?;
    Ok(())
}

/// A branch on the server: switching to it makes it local. Returns its name.
pub(crate) fn checkout_remote(root: &At, branch: &str) -> Result<String, String> {
    let name = branch.trim();
    let name = name.strip_prefix(&format!("{REMOTE}/")).unwrap_or(name);
    switch(root, name)?;
    Ok(safe_branch(name)?.to_string())
}

/// Create a branch. Lore starts it at the revision the working tree is on and switches to it, so
/// `from` (a branch or a revision) is switched to first, and without `checkout` the working tree
/// goes back to its branch afterwards.
pub(crate) fn branch_create(root: &At, name: &str, from: Option<&str>, checkout: bool) -> Result<(), String> {
    let name = safe_branch(name)?;
    let status = parse::parse_status(&lore(root).args(["status", "--revision-only"]).run_ok()?.text());
    let home = status.branch.clone();
    match from.map(str::trim).filter(|f| !f.is_empty()) {
        None => {}
        Some(f) if Some(f) == home.as_deref() => {}
        Some(f) if status.signature.as_deref() == Some(f) => {}
        Some(f) if f.len() == 64 && f.bytes().all(|b| b.is_ascii_hexdigit()) => checkout_commit(root, f)?,
        Some(f) => switch(root, f)?,
    }
    lore(root).write().args(["branch", "create", "--"]).arg(name).run_ok_offline_too()?;
    if !checkout {
        if let Some(home) = home {
            switch(root, &home)?;
        }
    }
    Ok(())
}

/// `lore branch merge`: Lore commits a clean merge itself; conflicts stay for the Changes view.
pub(crate) fn merge(root: &At, branch: &str) -> Result<String, String> {
    let branch = safe_branch(branch)?;
    let out = lore(root).slow().args(["branch", "merge", "--"]).arg(branch).run_ok_offline_too()?;
    let text = out.text();
    conflicts::remember_merge(&text, branch);
    let conflicts = parse::listed_under(&text, "Files in conflict:");
    if !conflicts.is_empty() {
        return Ok(format!(
            "Merged {branch} with conflicts in {} file{}. Resolve them in the Changes view, then commit the merge.",
            conflicts.len(),
            if conflicts.len() == 1 { "" } else { "s" }
        ));
    }
    Ok(match parse::committed_merge(&text) {
        Some(n) => format!("Merged {branch}; Lore committed the merge as r{n}."),
        None => format!("Merged {branch}."),
    })
}

/// Delete is `lore branch archive`: the branch leaves every branch list, on the server too; its
/// revisions are kept.
pub(crate) fn branch_delete(root: &At, branch: &str) -> Result<Option<String>, String> {
    let branch = safe_branch(branch)?;
    if read_branches(root)?.current.as_deref() == Some(branch) {
        return Err(format!("{branch} is the branch you are on. Switch to another branch before deleting it."));
    }
    lore(root).slow().args(["branch", "archive", "--"]).arg(branch).run_ok_offline_too()?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(text: &str) -> parse::Status {
        parse::parse_status(text)
    }

    fn read_text(root: &At, text: &str) -> GitStatus {
        let s = st(text);
        status_from(root, &s, &s.entries)
    }

    fn entry(section: Section, letter: &'static str, path: &str, dir: bool) -> Entry {
        Entry { section, letter, path: path.into(), orig: None, dir }
    }

    /// The list as it was worked out before (a scan of every entry per entry), to compare with.
    fn files_of_slowly(entries: &[Entry]) -> Vec<GitFile> {
        let mut out: Vec<GitFile> = Vec::new();
        for e in entries {
            if e.dir {
                let prefix = format!("{}/", e.path);
                if !matches!(e.letter, "D" | "R") || entries.iter().any(|o| o.path.starts_with(&prefix)) {
                    continue;
                }
            }
            let (index, worktree, conflicted) = match e.section {
                Section::Staged => (Some(e.letter.to_string()), None, false),
                Section::Unstaged => (None, Some(e.letter.to_string()), false),
                Section::Untracked => (None, Some("?".to_string()), false),
                Section::Conflict => (None, Some("U".to_string()), true),
            };
            if let Some(f) = out.iter_mut().find(|f| f.path == e.path) {
                f.index = f.index.take().or(index);
                f.worktree = f.worktree.take().or(worktree);
                f.conflicted |= conflicted;
                continue;
            }
            out.push(GitFile { path: e.path.clone(), orig_path: e.orig.clone().filter(|_| e.letter == "R"), index, worktree, conflicted });
        }
        out
    }

    /// A Unity-sized change list: folders added with their files, some changed again after
    /// staging, deleted and moved folders with and without files listed, names sharing prefixes.
    fn big_list(files: usize) -> Vec<Entry> {
        let mut out = Vec::new();
        let mut i = 0;
        let mut folder = 0;
        while i < files {
            let dir = format!("Assets/Area{}/Folder{folder}", folder % 7);
            out.push(entry(Section::Staged, "A", &format!("Assets/Area{}", folder % 7), true));
            out.push(entry(Section::Staged, "A", &dir, true));
            for k in 0..15 {
                let path = format!("{dir}/File{k}.prefab");
                out.push(entry(Section::Staged, "A", &path, false));
                out.push(entry(Section::Staged, "A", &format!("{path}.meta"), false));
                if k % 5 == 0 {
                    out.push(entry(Section::Unstaged, "M", &path, false));
                }
                i += 2;
            }
            match folder % 4 {
                // Deleted with nothing listed under it: a row of its own.
                0 => out.push(entry(Section::Unstaged, "D", &format!("Gone/Folder{folder}"), true)),
                // Deleted with its files listed: they are the rows.
                1 => {
                    out.push(entry(Section::Unstaged, "D", &format!("Gone/Folder{folder}"), true));
                    out.push(entry(Section::Unstaged, "D", &format!("Gone/Folder{folder}/a.txt"), false));
                }
                // A folder whose name is a prefix of another's, not its parent.
                2 => out.push(entry(Section::Unstaged, "D", &format!("Gone/Folder{folder}0x"), true)),
                _ => out.push(Entry {
                    section: Section::Staged,
                    letter: "R",
                    path: format!("Moved/Folder{folder}"),
                    orig: Some(format!("Old/Folder{folder}")),
                    dir: true,
                }),
            }
            folder += 1;
        }
        out
    }

    #[test]
    fn changes_list_matches_the_slow_way() {
        let entries = big_list(3_000);
        let fast = files_of(&entries);
        assert_eq!(fast, files_of_slowly(&entries));
        // Staged and changed again: one row with both sides.
        let twice = fast.iter().find(|f| f.path == "Assets/Area0/Folder0/File0.prefab").unwrap();
        assert_eq!((twice.index.as_deref(), twice.worktree.as_deref()), (Some("A"), Some("M")));
        assert!(fast.iter().any(|f| f.path == "Gone/Folder0"));
        assert!(!fast.iter().any(|f| f.path == "Gone/Folder1"));
        assert!(fast.iter().any(|f| f.path == "Gone/Folder1/a.txt"));
        assert!(fast.iter().any(|f| f.path == "Gone/Folder20x"));
        assert!(!fast.iter().any(|f| f.path.starts_with("Assets/Area") && !f.path.contains('.')));
    }

    #[test]
    fn a_large_change_list_is_quick() {
        let entries = big_list(70_000);
        assert!(entries.len() > 70_000);
        let started = std::time::Instant::now();
        let files = files_of(&entries);
        let took = started.elapsed();
        let staged = entries.iter().filter(|e| !e.dir && e.section == Section::Staged).count();
        assert_eq!(files.iter().filter(|f| f.path.starts_with("Assets/")).count(), staged);
        // The old quadratic way took 3 s here in a release build; this takes milliseconds.
        assert!(took < std::time::Duration::from_secs(1), "{took:?} for {} entries", entries.len());
    }

    #[test]
    fn folders_with_files_listed() {
        let entries = vec![
            entry(Section::Unstaged, "D", "a", true),
            entry(Section::Unstaged, "D", "a/b", true),
            entry(Section::Unstaged, "D", "a/b/c.txt", false),
            entry(Section::Unstaged, "D", "ab", true),
        ];
        let all = parents_listed(&entries, false);
        assert!(all.contains("a") && all.contains("a/b") && !all.contains("ab"));
        let files = parents_listed(&entries[..2], true);
        assert!(files.is_empty());
    }

    #[test]
    fn changes_list() {
        let s = st("On branch main revision 1 -> 1a3b
Changes staged for commit:
A src/
A src/main.rs
V a.txt -> b.txt
Changes not staged for commit:
D gone/
M k.txt
Untracked files:
A new/
A new/n.txt
Changes in conflict:
M  c.txt (M)!
");
        let files = files_of(&s.entries);
        let rows: Vec<(&str, Option<&str>, Option<&str>, Option<&str>, bool)> = files
            .iter()
            .map(|f| (f.path.as_str(), f.orig_path.as_deref(), f.index.as_deref(), f.worktree.as_deref(), f.conflicted))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("src/main.rs", None, Some("A"), None, false),
                ("b.txt", Some("a.txt"), Some("R"), None, false),
                ("gone", None, None, Some("D"), false),
                ("k.txt", None, None, Some("M"), false),
                ("new/n.txt", None, None, Some("?"), false),
                ("c.txt", None, None, Some("U"), true),
            ]
        );
    }

    #[test]
    fn upstream_and_counts() {
        let root = At::local("/w");
        let s = read_text(&root, "On branch main revision 5 -> aa\nRemote revision 3 -> bb\nLocal branch is ahead of remote\n");
        assert_eq!((s.vcs, s.upstream.as_deref(), s.ahead, s.behind, s.head.as_deref()), (Vcs::Lore, Some("remote/main"), 2, 0, Some("r5")));
        let s = read_text(&root, "On branch main revision 2 -> aa\nRemote revision 2 -> bb\nLocal branch has diverged, synchronize to merge\n");
        assert_eq!((s.ahead, s.behind), (1, 1));
        let s = read_text(&root, "On branch main revision 4 -> aa\nRemote revision 5 -> bb\nLocal branch in sync with remote\n");
        assert_eq!((s.ahead, s.behind), (0, 1));
        let s = read_text(&root, "On branch yb revision 6 -> aa\nRemote branch does not exist\n");
        assert_eq!((s.upstream, s.ahead, s.behind), (None, 0, 0));
        let s = read_text(&root, "On branch main revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000\n");
        assert_eq!((s.upstream, s.head, s.is_repo), (None, None, true));
    }

    #[test]
    fn names_and_paths() {
        assert_eq!(safe_branch(" feat/x-1 ").unwrap(), "feat/x-1");
        for bad in ["", "-x", "/x", "x/", "a b", "a..b", "a@1", "a:b", "a//b", "x\u{1}"] {
            assert!(safe_branch(bad).is_err(), "{bad}");
        }
        assert_eq!(revision_spec("r12").unwrap(), "12");
        assert_eq!(revision_spec("7").unwrap(), "7");
        assert_eq!(revision_spec("main").unwrap(), "main@LATEST");
        assert_eq!(revision_spec("remote/feat/x").unwrap(), "feat/x@LATEST");
        assert!(revision_spec("-x").is_err());
        assert!(safe_signature("abcd").is_err());
        assert!(safe_signature(&"a".repeat(64)).is_ok());

        let root = At::local("/w/game");
        assert_eq!(rel_to_root(&root, "/w/game", "a.txt").unwrap(), "a.txt");
        assert_eq!(rel_to_root(&root, "/w/game/src/", "a.txt").unwrap(), "src/a.txt");
        assert!(rel_to_root(&root, "/w/gamex", "a.txt").is_err());
        assert!(rel_to_root(&root, "/w/game", "../a.txt").is_err());
    }

    #[test]
    fn errors_read_well() {
        let out = |text: &str, code| Output { code: Some(code), stdout: Vec::new(), stderr: text.as_bytes().to_vec(), truncated: false };
        let e = explain(&out("[Error] Disconnected from server\n  at lore-transport/src/grpc/mod.rs:701:36\n  at lore/src/branch.rs:917 - acquiring remote\n", 28));
        assert!(e.starts_with("Couldn't reach the Lore server."), "{e}");
        assert!(e.ends_with("\n\nDisconnected from server"), "{e}");
        let e = explain(&out("[Error] Branch has diverged, sync to merge remote changes\n  at lore-revision/src/branch/push.rs:1216:19\n", 255));
        assert!(e.starts_with("The server has revisions"), "{e}");
        assert_eq!(explain(&out("", 3)), "lore failed (exit code 3)");
        assert_eq!(explain(&out("[Error] something new\n", 1)), "something new");
    }

    #[test]
    fn probe_output() {
        let out = |s: &str| Output { code: Some(0), stdout: s.as_bytes().to_vec(), stderr: Vec::new(), truncated: false };
        assert_eq!(probe_root(&out("lore /home/agent/game\n")).as_deref(), Some("/home/agent/game"));
        assert_eq!(probe_root(&out("")), None);
        assert_eq!(probe_root(&out("lore relative\n")), None);
    }

    #[test]
    fn log_starts() {
        let none = || -> Vec<String> { panic!("the branch list is read only for every branch") };
        let at = |b: Option<&str>, s: Option<&str>| Start { branch: b.map(String::from), spec: s.map(String::from) };
        // The log's own "current branch": Lore has no HEAD, it is the working tree's line.
        assert_eq!(starts(&["HEAD"], Some("main"), none).unwrap(), vec![at(Some("main"), None)]);
        assert_eq!(starts(&["main", "remote/main", "HEAD"], Some("main"), none).unwrap(), vec![at(Some("main"), None)]);
        assert_eq!(
            starts(&["remote/feat/x", "r3", &"a".repeat(64)], Some("main"), none).unwrap(),
            vec![at(Some("feat/x"), Some("feat/x@LATEST")), at(None, Some("3")), at(None, Some(&"a".repeat(64)))]
        );
        assert!(starts(&["-x"], Some("main"), none).is_err());
        // Every branch: the current one first, read where the working tree is.
        let all = starts(&[], Some("main"), || vec!["feat".into(), "main".into(), "bad name".into()]).unwrap();
        assert_eq!(all, vec![at(Some("main"), None), at(Some("feat"), Some("feat@LATEST"))]);
        assert_eq!(starts(&[], None, Vec::new).unwrap(), vec![at(None, None)]);
    }

    #[test]
    fn log_lines_merge() {
        let rev = |n: u64, sig: &str, merge: Option<&str>| Revision {
            number: n,
            signature: sig.into(),
            merge: merge.map(String::from),
            time: n as i64,
            ..Default::default()
        };
        let main = Start { branch: Some("main".into()), spec: None };
        let feat = Start { branch: Some("feat".into()), spec: Some("feat@LATEST".into()) };
        // main: m5 (merging f4) m3 m2 m1; feat: f4 m3 m2 m1.
        let (all, cut) = merge_lines(
            vec![
                (main, vec![rev(5, "m5", Some("f4")), rev(3, "m3", None), rev(2, "m2", None), rev(1, "m1", None)]),
                (feat, vec![rev(4, "f4", None), rev(3, "m3", None), rev(2, "m2", None)]),
            ],
            4,
        );
        let rows: Vec<(&str, Vec<&str>, Vec<&str>)> = all
            .iter()
            .map(|(r, p, b)| (r.signature.as_str(), p.iter().map(String::as_str).collect(), b.iter().map(String::as_str).collect()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("m5", vec!["m3", "f4"], vec!["main"]),
                ("f4", vec!["m3"], vec!["feat"]),
                ("m3", vec!["m2"], vec![]),
                ("m2", vec!["m1"], vec![]),
                ("m1", vec![], vec![]),
            ]
        );
        assert!(cut, "main's line filled the read");
    }

    /// The Git log against a real `lore` in an offline scratch repository (no server needed):
    /// `cargo test --lib lore::tests::real_lore_log -- --ignored --nocapture`. With
    /// `MANGO_LORE_LOG_REPO` set to an existing repository it also reads that one's log (read only).
    #[test]
    #[ignore]
    fn real_lore_log() {
        let all = |root: &At, text: Option<&str>, refs: Option<Vec<String>>, skip: u32, limit: u32| {
            graph(root, &GraphQuery { refs, skip, limit, text: text.map(String::from), author: None, paths: None })
        };
        if let Ok(repo) = std::env::var("MANGO_LORE_LOG_REPO") {
            let root = At::local(&repo);
            for refs in [None, Some(vec!["HEAD".to_string()])] {
                let g = all(&root, None, refs.clone(), 0, 50).unwrap();
                println!("{repo} {refs:?}: branch {:?}, head {:?}", g.branch, g.head);
                for c in &g.commits {
                    println!("  {} {} {} {:?}", c.short_hash, c.subject, c.author, c.refs.iter().map(|r| &r.name).collect::<Vec<_>>());
                }
                assert!(g.branch.is_some() && !g.commits.is_empty());
            }
            let first = all(&root, None, None, 0, 1).unwrap().commits.remove(0);
            let detail = commit_show(&root, &first.hash).unwrap();
            println!("{} files in {}", detail.files.len(), detail.short_hash);
            if let Some(f) = detail.files.iter().find(|f| f.status != "D") {
                println!("diff of {}: {} bytes", f.path, commit_diff(&root, &first.hash, &f.path).unwrap().len());
            }
        }

        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let dir = std::env::temp_dir().join(format!("mango-lore-log-{id}"));
        std::fs::create_dir_all(&dir).unwrap();
        let root = At::local(&dir);
        lore(&root).args(["repository", "create", "--offline", "--"]).arg(format!("log-{id}")).run_ok().unwrap();
        let commit_all = |msg: &str| {
            lore(&root).args(["stage", "--scan", "--", "."]).run_ok().unwrap();
            commit(&root, msg, false).unwrap()
        };
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        assert_eq!(commit_all("first: add a"), "r1");
        std::fs::write(dir.join("a.txt"), "a\nb\n").unwrap();
        commit_all("second change");
        std::fs::create_dir_all(dir.join("d")).unwrap();
        std::fs::write(dir.join("d").join("c.txt"), "c\n").unwrap();
        commit_all("third\n\nbody line");
        branch_create(&root, "feat-x", None, true).unwrap();
        std::fs::write(dir.join("x.txt"), "x\n").unwrap();
        commit_all("on feat");
        checkout(&root, "main", false).unwrap();
        std::fs::write(dir.join("a.txt"), "a\nb\nmain\n").unwrap();
        commit_all("main moves on");

        let subjects = |g: &GitGraph| g.commits.iter().map(|c| c.subject.clone()).collect::<Vec<_>>();
        // Every branch (the default), and the current one (`HEAD`).
        let g = all(&root, None, None, 0, 50).unwrap();
        println!("{:#?}", g.commits.iter().map(|c| (&c.short_hash, &c.subject, &c.parents, &c.refs)).collect::<Vec<_>>());
        assert_eq!(g.branch.as_deref(), Some("main"));
        let mut got = subjects(&g);
        got.sort();
        assert_eq!(got, vec!["first: add a", "main moves on", "on feat", "second change", "third"]);
        assert_eq!(g.commits[4].subject, "first: add a");
        assert!(g.commits.iter().any(|c| c.subject == "on feat" && c.refs.iter().any(|r| r.name == "feat-x" && !r.current)));
        assert!(g.commits.iter().any(|c| c.subject == "main moves on" && c.refs.iter().any(|r| r.name == "main" && r.current)));
        let third = g.commits.iter().find(|c| c.subject == "third").unwrap().hash.clone();
        assert!(g.commits.iter().filter(|c| c.parents == vec![third.clone()]).count() == 2, "both branches start at the third");
        assert!(!g.more);
        let head = all(&root, None, Some(vec!["HEAD".into()]), 0, 50).unwrap();
        assert_eq!(subjects(&head), vec!["main moves on", "third", "second change", "first: add a"]);
        let feat = all(&root, None, Some(vec!["feat-x".into()]), 0, 50).unwrap();
        assert_eq!(subjects(&feat)[0], "on feat");
        assert!(all(&root, None, Some(vec!["no-such".into()]), 0, 50).is_err());

        // Pages, and search.
        let p1 = all(&root, None, None, 0, 2).unwrap();
        let p2 = all(&root, None, None, 2, 2).unwrap();
        let p3 = all(&root, None, None, 4, 2).unwrap();
        assert!(p1.more && p2.more && !p3.more);
        assert_eq!([subjects(&p1), subjects(&p2), subjects(&p3)].concat(), subjects(&g));
        assert_eq!(subjects(&all(&root, Some("BODY"), None, 0, 50).unwrap()), vec!["third"]);
        assert_eq!(subjects(&all(&root, Some("r1"), None, 0, 50).unwrap()), vec!["first: add a"]);

        // A revision's files and a file's diff.
        let detail = commit_show(&root, &third).unwrap();
        assert_eq!((detail.subject.as_str(), detail.body.as_str()), ("third", "body line"));
        assert_eq!(detail.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(), vec![("d/c.txt", "A")]);
        assert!(commit_diff(&root, &third, "d/c.txt").unwrap().contains("+c"));
        let second = g.commits.iter().find(|c| c.subject == "second change").unwrap().hash.clone();
        assert!(commit_diff(&root, &second, "a.txt").unwrap().contains("+b"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Drives a real `lore` against a throwaway repository on a server: set `MANGO_LORE_SERVER`
    /// (e.g. `lore://127.0.0.1`, a server with sign-in off) and run
    /// `cargo test --lib lore::tests::real_lore -- --ignored --nocapture`. `MANGO_LORE_BIN` names
    /// the binary when it isn't on PATH (put its folder first on PATH). Uses a scratch HOME.
    #[test]
    #[ignore]
    fn real_lore() {
        let Some(server) = std::env::var("MANGO_LORE_SERVER").ok() else {
            eprintln!("MANGO_LORE_SERVER is not set; skipping");
            return;
        };
        if let Ok(bin) = std::env::var("MANGO_LORE_BIN") {
            let dir = PathBuf::from(bin).parent().unwrap().to_path_buf();
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut dirs = vec![dir];
            dirs.extend(std::env::split_paths(&path));
            std::env::set_var("PATH", std::env::join_paths(dirs).unwrap());
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let scratch = std::env::temp_dir().join(format!("mango-lore-{id}"));
        let home = scratch.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        let dir = scratch.join("a");
        std::fs::create_dir_all(&dir).unwrap();
        let root = At::local(&dir);
        let name = format!("mango-test-{id}");
        lore(&root).args(["repository", "create", "--"]).arg(format!("{}/{name}", server.trim_end_matches('/'))).run_ok().unwrap();
        assert_eq!(crate::vcs::detect_on_disk(&dir.join("sub")).map(|d| d.0), Some(Vcs::Lore));
        let file_of = |s: &GitStatus, p: &str| s.files.iter().find(|f| f.path == p).cloned();

        // Empty repository.
        let s = status(&root).unwrap();
        assert_eq!((s.vcs, s.branch.as_deref(), s.head.as_deref()), (Vcs::Lore, Some("main"), None));
        assert!(s.files.is_empty());
        assert!(log(&root, 10).unwrap().is_empty());

        // New files, one with a space and non-ASCII in a new folder, one starting with a dash.
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.join("src").join("ü b.txt"), "grün\n").unwrap();
        std::fs::write(dir.join("-x.txt"), "dash\n").unwrap();
        let s = status(&root).unwrap();
        for p in ["a.txt", "src/ü b.txt", "-x.txt"] {
            assert_eq!(file_of(&s, p).and_then(|f| f.worktree).as_deref(), Some("?"), "{p}: {:?}", s.files);
        }
        assert!(file_of(&s, "src").is_none(), "{:?}", s.files);
        assert!(diff(&root, "src/ü b.txt").unwrap().contains("+grün"));

        // Stage two, commit them; the third stays new.
        stage(&root, &["a.txt".into(), "-x.txt".into()]).unwrap();
        let s = status(&root).unwrap();
        assert_eq!(file_of(&s, "a.txt").unwrap().index.as_deref(), Some("A"));
        unstage(&root, &["-x.txt".into()]).unwrap();
        assert_eq!(file_of(&status(&root).unwrap(), "-x.txt").unwrap().worktree.as_deref(), Some("?"));
        assert!(commit(&root, "", false).is_err());
        let r = commit(&root, &format!("-first {id}\n\nbody"), false).unwrap();
        println!("committed {r}");
        assert_eq!(r, "r1");
        let s = status(&root).unwrap();
        assert!(file_of(&s, "a.txt").is_none());
        assert_eq!((s.upstream, s.ahead), (Some("remote/main".to_string()), 1));
        assert_eq!(log(&root, 5).unwrap()[0].subject, format!("-first {id}"));
        assert!(matches!(commit(&root, "nothing", false), Err(e) if e.starts_with("Nothing is staged")));

        // Amend the message before pushing; push; amending now is refused.
        assert_eq!(commit(&root, &format!("first {id}"), true).unwrap(), "r1");
        assert_eq!(log(&root, 1).unwrap()[0].subject, format!("first {id}"));
        println!("push: {}", push(&root).unwrap());
        let s = status(&root).unwrap();
        assert_eq!((s.ahead, s.behind), (0, 0));
        assert!(commit(&root, "again", true).unwrap_err().contains("already on the server"));
        fetch(&root).unwrap();

        // Edit, diff, base, discard.
        std::fs::write(dir.join("a.txt"), "one\n2\nthree\n").unwrap();
        let s = status(&root).unwrap();
        assert_eq!(file_of(&s, "a.txt").unwrap().worktree.as_deref(), Some("M"));
        let d = diff(&root, "a.txt").unwrap();
        assert!(d.starts_with("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@"), "{d}");
        assert!(d.contains("-two\n+2\n"), "{d}");
        assert_eq!(base(&root, &dir.to_string_lossy(), "a.txt").unwrap().as_deref(), Some("one\ntwo\nthree\n"));
        discard(&root, &["a.txt".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\nthree\n");

        // A staged edit is discarded too; a new file is deleted.
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        status(&root).unwrap();
        stage(&root, &["a.txt".into()]).unwrap();
        status(&root).unwrap();
        discard(&root, &["a.txt".into(), "src/ü b.txt".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\ntwo\nthree\n");
        assert!(!dir.join("src").join("ü b.txt").exists());

        // Delete, then discard brings it back.
        std::fs::remove_file(dir.join("a.txt")).unwrap();
        let s = status(&root).unwrap();
        assert_eq!(file_of(&s, "a.txt").unwrap().worktree.as_deref(), Some("D"));
        assert!(diff(&root, "a.txt").unwrap().contains("deleted file mode"));
        discard(&root, &[]).unwrap();
        assert!(dir.join("a.txt").exists());
        assert!(!dir.join("-x.txt").exists(), "discard all deletes new files");
        assert!(status(&root).unwrap().files.is_empty());

        // Stage all, commit, history and a revision's files and diff.
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        status(&root).unwrap();
        stage(&root, &[]).unwrap();
        assert_eq!(commit(&root, "second", false).unwrap(), "r2");
        let g = graph(&root, &GraphQuery { refs: None, skip: 0, limit: 10, text: None, author: None, paths: None }).unwrap();
        assert_eq!(g.commits.len(), 2);
        assert_eq!(g.commits[0].parents, vec![g.commits[1].hash.clone()]);
        assert!(g.commits[0].refs.iter().any(|r| r.name == "main" && r.current));
        let found = graph(&root, &GraphQuery { refs: None, skip: 0, limit: 10, text: Some("FIRST".into()), author: None, paths: None }).unwrap();
        assert_eq!(found.commits.len(), 1);
        let detail = commit_show(&root, &g.commits[0].hash).unwrap();
        let mut paths: Vec<(&str, &str)> = detail.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
        paths.sort();
        assert_eq!(paths, vec![("a.txt", "M"), ("b.txt", "A")]);
        let d = commit_diff(&root, &g.commits[0].hash, "a.txt").unwrap();
        assert!(d.contains("+four"), "{d}");
        let first = commit_diff(&root, &g.commits[1].hash, "a.txt").unwrap();
        assert!(first.contains("new file mode") && first.contains("+one"), "{first}");

        // Branches: create (switches), list, switch back, merge, archive.
        let feat = format!("feat/m-{id}");
        branch_create(&root, &feat, None, true).unwrap();
        assert_eq!(status(&root).unwrap().branch.as_deref(), Some(feat.as_str()));
        assert_eq!(status(&root).unwrap().upstream, None);
        std::fs::write(dir.join("f.txt"), "f\n").unwrap();
        status(&root).unwrap();
        stage(&root, &["f.txt".into()]).unwrap();
        commit(&root, "on feat", false).unwrap();
        println!("publish: {}", push(&root).unwrap());
        let list = branch_list(&root).unwrap();
        assert!(list.local.iter().any(|b| b.name == feat && b.is_current && b.upstream.is_some()));
        assert!(list.remote.iter().any(|b| b.name == format!("remote/{feat}")));
        checkout(&root, "main", false).unwrap();
        assert!(!dir.join("f.txt").exists());
        println!("merge: {}", merge(&root, &feat).unwrap());
        assert!(dir.join("f.txt").exists());
        assert!(branch_delete(&root, "main").is_err());
        branch_delete(&root, &feat).unwrap();
        assert!(!branches(&root).unwrap().local.contains(&feat));
        assert!(checkout(&root, "no-such-branch", false).is_err());

        // Not supported, honestly.
        assert!(safe_branch("bad name").is_err());
        println!("pull: {:?}", pull(&root));

        // Locks.
        println!("lock: {:?}", locks::lock(&root, &["a.txt".into()]));
        let held = locks::locks(&root).unwrap();
        println!("locks: {held:?}");
        assert!(held.iter().any(|l| l.path == "a.txt"));
        locks::unlock(&root, &["a.txt".into()]).unwrap();
        assert!(!locks::locks(&root).unwrap().iter().any(|l| l.path == "a.txt"));

        let _ = std::fs::remove_dir_all(&scratch);
    }
}
