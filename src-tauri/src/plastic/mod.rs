//! Unity Version Control (formerly Plastic SCM) behind the same commands as
//! git, so a Unity VCS workspace uses the Changes view, diffs and branch
//! popup unchanged. Everything shells out to the user's own `cm`, signed in
//! the way they signed in themselves; Mango never handles credentials.
//!
//! How the ideas map:
//! - pending changes are the Changes list; `cm` has no staging area, so
//!   "staged" is a per-workspace selection kept here in memory: it decides
//!   which files the next checkin takes (nothing selected means everything);
//! - commit is `cm checkin`, a commit is a changeset (`cs:12`);
//! - pull is `cm update`; there is no fetch, push, rebase or remote branch;
//! - merge is `cm merge` into the workspace (`merge.rs`): its result is
//!   pending changes that a checkin finishes;
//! - branches are paths such as `/main/task-12`, and a new branch is a child
//!   of the branch it starts from.

pub(crate) mod workspaces;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

mod merge;
pub(crate) mod reviews;
pub(crate) mod shelves;

pub(crate) use merge::{merge, preview as merge_preview, MergePreview};

use crate::git::{
    chunks, clean_rel, finish_diff, lossy, remove_untracked, run_process, tidy_output, GitBranchList,
    GitBranches, GitCommit, GitFile, GitLocalBranch, GitStatus, Output, Vcs, DIFF_CAP, LOCAL_TIMEOUT,
    SLOW_TIMEOUT,
};

/// Files larger than this are not compared line by line.
const DIFF_INPUT_CAP: usize = 16 * 1024 * 1024;
/// How long the count of newer changesets on the branch is reused.
const BEHIND_TTL: Duration = Duration::from_secs(60);
/// How long "this folder is not a workspace" is believed before asking `cm` again.
const MISS_TTL: Duration = Duration::from_secs(60);
/// Windows caps a command line at 32k characters; stay well below.
const MAX_ARGS_BYTES: usize = 24_000;

pub(crate) mod locks;

const NOT_INSTALLED: &str = "Unity Version Control's `cm` command isn't installed or isn't on PATH. Install Unity VCS (or the Plastic SCM client), then reopen Mango.";

// ---------------------------------------------------------------------------
// Finding cm and the workspace
// ---------------------------------------------------------------------------

/// The `cm` binary: on PATH, or where the installers put it.
fn cm_bin() -> Option<&'static PathBuf> {
    static CM: OnceLock<Option<PathBuf>> = OnceLock::new();
    CM.get_or_init(|| {
        crate::bin::find("cm").or_else(|| {
            let mut known: Vec<PathBuf> = Vec::new();
            #[cfg(windows)]
            for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
                if let Some(dir) = std::env::var_os(var) {
                    known.push(PathBuf::from(dir).join("PlasticSCM5").join("client").join("cm.exe"));
                }
            }
            #[cfg(not(windows))]
            known.extend(["/opt/plasticscm5/client/cm", "/usr/local/bin/cm"].map(PathBuf::from));
            known.into_iter().find(|p| p.is_file())
        })
    })
    .as_ref()
}

/// Ask `cm` which workspace holds `dir`, for workspaces whose `.plastic`
/// folder is not where it usually is. Answers are remembered (a miss for a
/// minute) because the folder is asked about on every refresh.
pub(crate) fn workspace_by_cm(dir: &Path) -> Option<PathBuf> {
    type Seen = HashMap<PathBuf, (Option<PathBuf>, Instant)>;
    static SEEN: OnceLock<Mutex<Seen>> = OnceLock::new();
    let seen = SEEN.get_or_init(Default::default);
    if let Some((root, at)) = seen.lock().ok()?.get(dir).cloned() {
        if root.is_some() || at.elapsed() < MISS_TTL {
            return root;
        }
    }
    cm_bin()?;
    let root = cm(dir)
        .ok()?
        .args(["gwp", "."])
        .arg("--format={wkpath}")
        .timeout(Duration::from_secs(15))
        .run()
        .ok()
        .filter(Output::ok)
        .map(|out| out.line())
        .map(|line| PathBuf::from(line.trim()))
        .filter(|p| p.is_dir());
    if let Ok(mut map) = seen.lock() {
        map.insert(dir.to_path_buf(), (root.clone(), Instant::now()));
    }
    root
}

/// The branch a workspace is on, from its selector file, without running
/// `cm`. For the project list; the Changes view asks `cm` itself.
pub(crate) fn selector_branch(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join(".plastic").join("plastic.selector")).ok()?;
    parse_selector_branch(&text)
}

pub(crate) fn parse_selector_branch(text: &str) -> Option<String> {
    // `smartbranch "/main"` or `br "/main"`; a selector pinned to a changeset or label names no branch to show.
    if text.contains("changeset \"") || text.contains("label \"") {
        return None;
    }
    text.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix("smartbranch ").or_else(|| line.strip_prefix("br "))?;
        let name = rest.trim().strip_prefix('"')?.split('"').next()?;
        Some(name.to_string()).filter(|n| !n.is_empty())
    })
}

// ---------------------------------------------------------------------------
// Running cm
// ---------------------------------------------------------------------------

struct Cm {
    cmd: Command,
    cap: usize,
    timeout: Duration,
}

/// A `cm` invocation in `dir` that can never wait for an editor or a prompt.
fn cm(dir: &Path) -> Result<Cm, String> {
    let bin = cm_bin().ok_or(NOT_INSTALLED)?;
    let mut cmd = Command::new(bin);
    crate::bin::hide_console(&mut cmd);
    cmd.current_dir(dir)
        // An empty comment would otherwise open this editor and wait for it.
        .env_remove("PLASTICEDITOR");
    if let Some(path) = crate::bin::augmented_path(bin.parent()) {
        cmd.env("PATH", path);
    }
    Ok(Cm { cmd, cap: usize::MAX, timeout: LOCAL_TIMEOUT })
}

impl Cm {
    fn arg(mut self, arg: impl AsRef<std::ffi::OsStr>) -> Self {
        self.cmd.arg(arg);
        self
    }
    fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        self.cmd.args(args);
        self
    }
    fn slow(mut self) -> Self {
        self.timeout = SLOW_TIMEOUT;
        self
    }
    fn timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }
    fn run(self) -> Result<Output, String> {
        run_process(self.cmd, None, self.cap, self.timeout, "cm", NOT_INSTALLED)
    }
    /// Run and turn a non-zero exit into a readable error.
    fn run_ok(self, what: &str) -> Result<Output, String> {
        let out = self.run()?;
        if out.ok() {
            Ok(out)
        } else {
            Err(explain(out.error(what)))
        }
    }
}

/// Add a plain-language first line to the failures people actually hit.
pub(crate) fn explain(detail: String) -> String {
    let lower = detail.to_lowercase();
    let lead = if ["authenticat", "credential", "unauthorized", "not logged", "log in", "login", "sign in", "token"]
        .iter()
        .any(|w| lower.contains(w))
    {
        "Unity VCS couldn't sign in to the server. Sign in with the Unity Version Control app (or Unity Hub) first, then try again."
    } else if ["unable to connect", "could not connect", "connection refused", "no such host", "timed out"]
        .iter()
        .any(|w| lower.contains(w))
    {
        "Couldn't reach the Unity VCS server. Check the connection and try again."
    } else {
        return detail;
    };
    format!("{lead}\n\n{detail}")
}

/// Ask for XML in UTF-8: `cm`'s plain output is written in the console
/// code page, which mangles or drops characters in names and comments.
const XML: [&str; 2] = ["--xml", "--encoding=utf-8"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Unescape the five XML entities and numeric character references.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let ch = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .map(|h| u32::from_str_radix(h, 16).ok())
                .unwrap_or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The inside of every `<tag>…</tag>` in `xml`, in order. `cm`'s XML is
/// flat and well-formed, so this is all the parsing it needs.
fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(&after[..j]);
        rest = &after[j + close.len()..];
    }
    out
}

/// The text of the first `<tag>` in `xml`; `<tag />` is empty.
fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let full = xml.find(&open);
    let empty = [format!("<{tag} />"), format!("<{tag}/>")].iter().filter_map(|e| xml.find(e.as_str())).min();
    match (full, empty) {
        (Some(f), Some(e)) if e < f => Some(String::new()),
        (None, Some(_)) => Some(String::new()),
        (Some(f), _) => {
            let after = &xml[f + open.len()..];
            let end = after.find(&format!("</{tag}>"))?;
            Some(unescape(&after[..end]))
        }
        (None, None) => None,
    }
}

/// What the workspace is loaded from.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct WorkspaceInfo {
    /// e.g. "/main/task-1"; None when pinned to a changeset, label or shelve.
    pub branch: Option<String>,
    /// e.g. "game@org@cloud".
    pub repository: Option<String>,
    pub changeset: Option<u64>,
}

/// One pending change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    /// Git-style letter: M, A, D, R, C, or `?` for a private (not yet controlled) file.
    pub letter: &'static str,
    /// Relative to the workspace root, forward slashes.
    pub path: String,
    pub orig: Option<String>,
    pub dir: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ParsedStatus {
    pub info: WorkspaceInfo,
    pub entries: Vec<Entry>,
}

/// A root-relative path from `cm` (backslashes on Windows) in our form, or
/// None for anything that is not inside the workspace.
fn rel_path(p: &str) -> Option<String> {
    let p = p.replace('\\', "/");
    let p = p.trim_start_matches("./").trim_end_matches('/');
    clean_rel(p).ok().map(str::to_string)
}

/// The git letter for a `cm status` code such as `CH`, `CO+CH`, `LM`, `PR`.
fn letter(code: &str) -> Option<&'static str> {
    let parts: Vec<&str> = code.split('+').collect();
    let has = |c: &str| parts.contains(&c);
    Some(if has("IG") || has("CL") {
        return None;
    } else if has("LM") || has("MV") {
        "R"
    } else if has("PR") {
        "?"
    } else if has("AD") {
        "A"
    } else if has("LD") || has("DE") {
        "D"
    } else if has("CP") {
        "C"
    } else {
        "M"
    })
}

/// Parse `cm status --xml`, run from the workspace root (paths are relative to it).
pub(crate) fn parse_status(xml: &str) -> ParsedStatus {
    let mut out = ParsedStatus::default();
    let config = xml_text(xml, "WkConfigName").unwrap_or_default();
    let (name, repo) = config.split_once('@').unwrap_or((config.as_str(), ""));
    out.info = WorkspaceInfo {
        branch: (xml_text(xml, "WkConfigType").as_deref() == Some("Branch") && name.starts_with('/'))
            .then(|| name.to_string()),
        repository: Some(repo.to_string()).filter(|r| !r.is_empty()),
        changeset: xml_blocks(xml, "Status").first().and_then(|s| xml_text(s, "Changeset")).and_then(|c| c.trim().parse().ok()),
    };
    let mut seen = HashSet::new();
    for change in xml_blocks(xml, "Change") {
        let Some(letter) = xml_text(change, "Type").as_deref().and_then(letter) else { continue };
        let Some(path) = xml_text(change, "Path").as_deref().and_then(rel_path) else { continue };
        let orig = xml_text(change, "OldPath").as_deref().and_then(rel_path).filter(|o| *o != path);
        let dir = xml_text(change, "RevisionType").as_deref() == Some("enDirectory");
        // A folder's added or changed files are listed one by one; only a
        // moved or deleted folder is a change of its own.
        if dir && !matches!(letter, "R" | "D") {
            continue;
        }
        if seen.insert(path.clone()) {
            out.entries.push(Entry { letter, orig: if letter == "R" || letter == "C" { orig } else { None }, path, dir });
        }
    }
    out
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Unix ms from the round-trip date format (`--dateformat=o`), e.g.
/// `2026-11-15T18:52:55.0000000+03:00` or `…Z`.
pub(crate) fn parse_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut rest = &s[19..];
    let mut ms = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        ms = format!("{digits:0<3}")[..3].parse().unwrap_or(0);
        rest = &frac[digits.len()..];
    }
    let offset_min = match rest.as_bytes().first() {
        None | Some(b'Z') => 0,
        Some(&sign) if sign == b'+' || sign == b'-' => {
            let oh: i64 = rest.get(1..3)?.parse().ok()?;
            let om: i64 = rest.get(4..6).and_then(|m| m.parse().ok()).unwrap_or(0);
            let total = oh * 60 + om;
            if sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + ms)
}

/// A branch name that is safe to hand to `cm` (`/main/task-1`).
pub(crate) fn safe_branch(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a branch name".into());
    }
    let bad = name.starts_with('-')
        || name.contains("..")
        || name.contains("//")
        || (name.len() > 1 && name.ends_with('/'))
        || name.chars().any(|c| c.is_whitespace() || c.is_control() || "\"'@#:;*?<>|\\$`".contains(c));
    if bad || name == "/" {
        return Err(format!("\"{name}\" is not a valid branch name"));
    }
    Ok(if name.starts_with('/') { name.to_string() } else { format!("/{name}") })
}

/// The full name of a new branch: as typed when it starts with `/`,
/// otherwise a child of `parent`.
pub(crate) fn child_branch(name: &str, parent: &str) -> Result<String, String> {
    let name = name.trim();
    if name.starts_with('/') {
        return safe_branch(name);
    }
    safe_branch(name)?;
    safe_branch(&format!("{}/{name}", parent.trim_end_matches('/')))
}

fn parent_of(branch: &str) -> &str {
    match branch.rfind('/') {
        Some(0) | None => "",
        Some(i) => &branch[..i],
    }
}

/// Text that is shown as `\0`-free lines; anything else is binary.
fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// A git-style unified diff of one file, so the diff view needs no second parser.
pub(crate) fn unified_diff(old_path: Option<&str>, new_path: Option<&str>, old: Option<&[u8]>, new: Option<&[u8]>) -> String {
    let a = old_path.or(new_path).unwrap_or_default();
    let b = new_path.or(old_path).unwrap_or_default();
    let mut out = format!("diff --git a/{a} b/{b}\n");
    match (old, new) {
        (None, Some(_)) => out.push_str("new file mode 100644\n"),
        (Some(_), None) => out.push_str("deleted file mode 100644\n"),
        _ if a != b => out.push_str(&format!("rename from {a}\nrename to {b}\n")),
        _ => {}
    }
    let old_bytes = old.unwrap_or_default();
    let new_bytes = new.unwrap_or_default();
    if is_binary(old_bytes) || is_binary(new_bytes) {
        let from = if old.is_some() { format!("a/{a}") } else { "/dev/null".into() };
        let to = if new.is_some() { format!("b/{b}") } else { "/dev/null".into() };
        out.push_str(&format!("Binary files {from} and {to} differ\n"));
        return out;
    }
    let old_text = lossy(old_bytes);
    let new_text = lossy(new_bytes);
    if old_text == new_text {
        return out;
    }
    out.push_str(&format!("--- {}\n", if old.is_some() { format!("a/{a}") } else { "/dev/null".into() }));
    out.push_str(&format!("+++ {}\n", if new.is_some() { format!("b/{b}") } else { "/dev/null".into() }));
    let diff = similar::TextDiff::configure()
        .algorithm(similar::Algorithm::Myers)
        .timeout(Duration::from_secs(3))
        .diff_lines(&old_text, &new_text);
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        out.push_str(&hunk.to_string());
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Per-workspace state kept by Mango
// ---------------------------------------------------------------------------

fn key(root: &Path) -> String {
    let k = root.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { k.to_lowercase() } else { k }
}

/// Files picked for the next checkin, by workspace.
fn staged() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    static STAGED: OnceLock<Mutex<HashMap<String, HashSet<String>>>> = OnceLock::new();
    STAGED.get_or_init(Default::default)
}

/// The pending changes from the last status read, so a diff does not need
/// another full scan of the workspace.
fn last_status() -> &'static Mutex<HashMap<String, Vec<Entry>>> {
    static LAST: OnceLock<Mutex<HashMap<String, Vec<Entry>>>> = OnceLock::new();
    LAST.get_or_init(Default::default)
}

/// Newer changesets on the branch: (what it was counted for, count, when).
fn behind_cache() -> &'static Mutex<HashMap<String, (String, u32, Instant)>> {
    static BEHIND: OnceLock<Mutex<HashMap<String, (String, u32, Instant)>>> = OnceLock::new();
    BEHIND.get_or_init(Default::default)
}

fn forget_behind(root: &Path) {
    if let Ok(mut map) = behind_cache().lock() {
        map.remove(&key(root));
    }
}

// ---------------------------------------------------------------------------
// Reading the workspace
// ---------------------------------------------------------------------------

/// Branch, repository and changeset, without scanning for changes.
fn workspace_info(root: &Path) -> Result<WorkspaceInfo, String> {
    let out = cm(root)?.args(["status", "--header"]).args(XML).run_ok("cm status")?;
    Ok(parse_status(&out.text()).info)
}

fn read_status(root: &Path) -> Result<ParsedStatus, String> {
    let out = cm(root)?.arg("status").args(XML).run_ok("cm status")?;
    let parsed = parse_status(&out.text());
    if let Ok(mut map) = last_status().lock() {
        map.insert(key(root), parsed.entries.clone());
    }
    Ok(parsed)
}

/// How many changesets the branch has past the one the workspace is on.
fn behind(root: &Path, branch: &str, changeset: u64) -> u32 {
    let what = format!("{branch}@{changeset}");
    if let Ok(map) = behind_cache().lock() {
        if let Some((w, n, at)) = map.get(&key(root)) {
            if *w == what && at.elapsed() < BEHIND_TTL {
                return *n;
            }
        }
    }
    let n = cm(root)
        .and_then(|c| {
            c.args(["find", "changeset"])
                .arg(format!("where branch='{branch}' and changesetid > {changeset}"))
                .args(["--format={changesetid}", "--nototal"])
                .timeout(Duration::from_secs(30))
                .run_ok("cm find")
        })
        .map(|out| out.text().lines().filter(|l| !l.trim().is_empty()).count() as u32)
        // Not knowing is not worth failing the whole status for.
        .unwrap_or(0);
    if let Ok(mut map) = behind_cache().lock() {
        map.insert(key(root), (what, n, Instant::now()));
    }
    n
}

pub(crate) fn status(root: &Path) -> Result<GitStatus, String> {
    let parsed = read_status(root)?;
    let info = &parsed.info;
    let mut picked = staged().lock().map_err(|_| "Internal error: state lock")?;
    let picked = picked.entry(key(root)).or_default();
    // Forget picks for files that are no longer pending.
    picked.retain(|p| parsed.entries.iter().any(|e| &e.path == p));
    let files = parsed
        .entries
        .iter()
        .map(|e| {
            let is_staged = picked.contains(&e.path);
            let staged_letter = if e.letter == "?" { "A" } else { e.letter };
            GitFile {
                path: e.path.clone(),
                orig_path: e.orig.clone(),
                index: is_staged.then(|| staged_letter.to_string()),
                worktree: (!is_staged).then(|| e.letter.to_string()),
                conflicted: false,
            }
        })
        .collect();
    let behind = match (&info.branch, info.changeset) {
        (Some(b), Some(cs)) => behind(root, b, cs),
        _ => 0,
    };
    Ok(GitStatus {
        vcs: Vcs::Plastic,
        repository: info.repository.clone(),
        is_repo: true,
        root: Some(root.to_string_lossy().into_owned()),
        main_root: None,
        branch: info.branch.clone(),
        head: info.changeset.map(|c| c.to_string()),
        upstream: None,
        ahead: 0,
        behind,
        files,
    })
}

/// The pending change for `file`, from the last status read (or a new one).
fn entry_for(root: &Path, file: &str) -> Result<Option<Entry>, String> {
    let cached = last_status().lock().ok().and_then(|m| m.get(&key(root)).cloned());
    let entries = match cached {
        Some(e) => e,
        None => read_status(root)?.entries,
    };
    Ok(entries.into_iter().find(|e| e.path == file))
}

/// Contents of the revision the workspace has loaded for `rel`.
fn base_content(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let tmp = std::env::temp_dir().join(format!("mango-cm-{}", uuid::Uuid::new_v4()));
    let result = cm(root)?
        .arg("cat")
        .arg(root.join(rel))
        .arg(format!("--file={}", tmp.display()))
        .run_ok("cm cat")
        .and_then(|_| read_capped_file(&tmp));
    let _ = std::fs::remove_file(&tmp);
    result
}

fn read_capped_file(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if meta.len() as usize > DIFF_INPUT_CAP {
        return Err(format!(
            "This file is {} MB, too large to compare here.",
            meta.len() / (1024 * 1024)
        ));
    }
    std::fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

pub(crate) fn diff(root: &Path, file: &str) -> Result<String, String> {
    let file = clean_rel(file)?;
    let Some(entry) = entry_for(root, file)? else {
        return Ok(String::new());
    };
    if entry.dir {
        // Folders have no content of their own; a move still says where from.
        return Ok(match (&entry.orig, entry.letter) {
            (Some(orig), "R") => unified_diff(Some(orig), Some(&entry.path), Some(b""), Some(b"")),
            _ => String::new(),
        });
    }
    let current = || read_capped_file(&root.join(&entry.path));
    let (old_path, old, new) = match entry.letter {
        "?" | "A" => (None, None, Some(current()?)),
        "D" => (Some(entry.path.as_str()), Some(base_content(root, &entry.path)?), None),
        "R" | "C" => {
            let from = entry.orig.as_deref().unwrap_or(&entry.path);
            (Some(from), Some(base_content(root, from)?), Some(current()?))
        }
        _ => (Some(entry.path.as_str()), Some(base_content(root, &entry.path)?), Some(current()?)),
    };
    let text = unified_diff(old_path, Some(&entry.path).filter(|_| new.is_some()).map(|p| p.as_str()), old.as_deref(), new.as_deref());
    let truncated = text.len() > DIFF_CAP;
    let mut bytes = text.into_bytes();
    if truncated {
        bytes.truncate(DIFF_CAP);
    }
    Ok(finish_diff(bytes, truncated))
}

// ---------------------------------------------------------------------------
// Picking files, undoing, checking in
// ---------------------------------------------------------------------------

pub(crate) fn stage(root: &Path, files: &[String]) -> Result<(), String> {
    for f in files {
        clean_rel(f)?;
    }
    let pending = read_status(root)?.entries;
    let mut map = staged().lock().map_err(|_| "Internal error: state lock")?;
    let picked = map.entry(key(root)).or_default();
    for e in pending {
        if files.is_empty() || files.contains(&e.path) {
            picked.insert(e.path);
        }
    }
    Ok(())
}

pub(crate) fn unstage(root: &Path, files: &[String]) -> Result<(), String> {
    let mut map = staged().lock().map_err(|_| "Internal error: state lock")?;
    let picked = map.entry(key(root)).or_default();
    if files.is_empty() {
        picked.clear();
    } else {
        picked.retain(|p| !files.contains(p));
    }
    Ok(())
}

/// A path argument `cm` can't mistake for an option.
fn path_arg(rel: &str) -> String {
    if rel.starts_with('-') { format!("./{rel}") } else { rel.to_string() }
}

/// Throw away pending changes. Controlled changes are undone with `cm undo`
/// (a move goes back to where it was, a deletion comes back); private files,
/// and files that were only added, are deleted. An empty list means every
/// change that is not picked for the checkin.
pub(crate) fn discard(root: &Path, files: &[String]) -> Result<(), String> {
    for f in files {
        clean_rel(f)?;
    }
    let pending = read_status(root)?.entries;
    let picked = staged().lock().ok().and_then(|m| m.get(&key(root)).cloned()).unwrap_or_default();
    let targets: Vec<&Entry> = pending
        .iter()
        .filter(|e| if files.is_empty() { !picked.contains(&e.path) } else { files.contains(&e.path) })
        .collect();

    let undo: Vec<String> = targets.iter().filter(|e| e.letter != "?").map(|e| path_arg(&e.path)).collect();
    for chunk in chunks(&undo) {
        cm(root)?.arg("undo").args(chunk).run_ok("cm undo")?;
    }
    for e in targets.iter().filter(|e| matches!(e.letter, "?" | "A") && !e.dir) {
        remove_untracked(root, &e.path)?;
    }
    Ok(())
}

/// The changeset spec in checkin output, e.g. `cs:12` from `CHANGESET cs:12@br:/main@repo@server`.
pub(crate) fn changeset_of(output: &str) -> Option<String> {
    output.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("CHANGESET ")?;
        let spec = rest.split('@').next()?.trim();
        spec.starts_with("cs:").then(|| spec.to_string())
    })
}

/// Check in the picked files with `message`. Returns the new changeset, `cs:12`.
pub(crate) fn checkin(root: &Path, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a checkin comment first".into());
    }
    let pending = read_status(root)?.entries;
    let picked = staged().lock().ok().and_then(|m| m.get(&key(root)).cloned()).unwrap_or_default();
    let include: Vec<&Entry> = pending.iter().filter(|e| picked.contains(&e.path)).collect();
    if include.is_empty() {
        return Err("Nothing is staged. Stage the changes you want in this checkin first.".into());
    }
    let paths: Vec<String> = include.iter().map(|e| path_arg(&e.path)).collect();
    let everything = include.len() == pending.len();
    let too_long = paths.iter().map(|p| p.len() + 3).sum::<usize>() > MAX_ARGS_BYTES;
    if too_long && !everything {
        return Err(format!(
            "{} files are too many to name on one checkin. Stage everything, or fewer files, and check in again.",
            include.len()
        ));
    }
    let mut cmd = cm(root)?.slow().arg("checkin");
    if !too_long {
        cmd = cmd.args(&paths);
    }
    let out = cmd
        // Locally changed, moved and deleted items count too; private files
        // are added, with the folders they need.
        .args(["--all", "--private", "--dependencies", "--machinereadable"])
        .arg(format!("-c={message}"))
        .run()?;
    if !out.ok() {
        let detail = out.error("cm checkin");
        let lower = detail.to_lowercase();
        if ["merge_needed", "merge is needed", "up-to-date", "up to date", "--update"].iter().any(|w| lower.contains(w)) {
            return Err(format!(
                "The branch has changesets your workspace doesn't have yet. Update the workspace, then check in again.\n\n{detail}"
            ));
        }
        return Err(explain(detail));
    }
    if let Ok(mut map) = staged().lock() {
        if let Some(set) = map.get_mut(&key(root)) {
            for e in &include {
                set.remove(&e.path);
            }
        }
    }
    forget_behind(root);
    Ok(changeset_of(&out.text()).unwrap_or_else(|| "a new changeset".into()))
}

/// Bring the workspace up to the latest changeset on its branch (`cm update`).
pub(crate) fn update(root: &Path) -> Result<String, String> {
    let out = cm(root)?.slow().args(["update", "--noinput"]).run_ok("cm update")?;
    forget_behind(root);
    Ok(update_summary(&tidy_output(&out.combined())))
}

/// One line for what `cm update` did; its own output is a line per file.
/// Empty when there was nothing to do.
pub(crate) fn update_summary(text: &str) -> String {
    let downloaded = text.lines().filter(|l| l.starts_with("Downloaded ")).count();
    if downloaded > 0 {
        return format!("Updated. Downloaded {downloaded} file{}.", if downloaded == 1 { "" } else { "s" });
    }
    if text.contains("is up-to-date") || text.trim().is_empty() {
        return String::new();
    }
    "Updated to the latest changeset.".into()
}

// ---------------------------------------------------------------------------
// History and branches
// ---------------------------------------------------------------------------

pub(crate) fn log(root: &Path, limit: u32) -> Result<Vec<GitCommit>, String> {
    let info = workspace_info(root)?;
    let filter = match (&info.branch, info.changeset) {
        (Some(b), _) => format!("where branch='{}'", safe_branch(b)?),
        (None, Some(cs)) => format!("where changesetid <= {cs}"),
        (None, None) => "where changesetid >= 0".to_string(),
    };
    let out = cm(root)?
        .args(["find", "changeset"])
        .arg(filter)
        .arg("order by changesetid desc")
        .arg(format!("limit {}", limit.clamp(1, 500)))
        .args(XML)
        .arg("--nototal")
        .run_ok("cm find")?;
    Ok(parse_changesets(&out.text())
        .into_iter()
        .map(|c| GitCommit {
            hash: c.guid.unwrap_or_else(|| c.id.to_string()),
            short_hash: format!("cs:{}", c.id),
            subject: c.comment.lines().next().unwrap_or_default().trim().to_string(),
            author: c.owner,
            time: c.time.max(0) as u64,
        })
        .collect())
}

/// One record of `cm find changeset --xml`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Changeset {
    pub id: u64,
    pub guid: Option<String>,
    pub branch: String,
    pub owner: String,
    pub comment: String,
    /// Unix ms.
    pub time: i64,
}

pub(crate) fn parse_changesets(xml: &str) -> Vec<Changeset> {
    xml_blocks(xml, "CHANGESET")
        .into_iter()
        .filter_map(|b| {
            Some(Changeset {
                id: xml_text(b, "CHANGESETID")?.trim().parse().ok()?,
                guid: xml_text(b, "GUID").filter(|g| !g.is_empty()),
                branch: xml_text(b, "BRANCH").unwrap_or_default(),
                owner: xml_text(b, "OWNER").unwrap_or_default(),
                comment: xml_text(b, "COMMENT").unwrap_or_default(),
                time: xml_text(b, "DATE").as_deref().and_then(parse_date).unwrap_or(0),
            })
        })
        .collect()
}

/// Records of `cm find branch --xml`: name, creation time, comment.
pub(crate) fn parse_branches(xml: &str) -> Vec<(String, i64, String)> {
    xml_blocks(xml, "BRANCH")
        .into_iter()
        .filter_map(|b| {
            let name = xml_text(b, "NAME")?.trim().to_string();
            name.starts_with('/').then(|| {
                let time = xml_text(b, "DATE").as_deref().and_then(parse_date).unwrap_or(0);
                (name, time, xml_text(b, "COMMENT").unwrap_or_default())
            })
        })
        .collect()
}

/// Every branch with its creation date and comment.
fn all_branches(root: &Path) -> Result<Vec<(String, i64, String)>, String> {
    let out = cm(root)?.args(["find", "branch"]).args(XML).arg("--nototal").run_ok("cm find")?;
    Ok(parse_branches(&out.text()))
}

pub(crate) fn branches(root: &Path) -> Result<GitBranches, String> {
    let current = workspace_info(root)?.branch;
    let mut local: Vec<String> = all_branches(root)?.into_iter().map(|b| b.0).collect();
    local.sort();
    Ok(GitBranches { current, local })
}

pub(crate) fn branch_list(root: &Path) -> Result<GitBranchList, String> {
    let current = workspace_info(root)?.branch;
    // The newest changesets say when each branch was last worked on and what was said.
    let recent = cm(root)?
        .args(["find", "changeset", "order by changesetid desc", "limit 1000"])
        .args(XML)
        .arg("--nototal")
        .run_ok("cm find")?;
    let mut last: HashMap<String, (i64, String)> = HashMap::new();
    for c in parse_changesets(&recent.text()) {
        last.entry(c.branch).or_insert_with(|| (c.time, c.comment.lines().next().unwrap_or_default().to_string()));
    }
    let mut local: Vec<GitLocalBranch> = all_branches(root)?
        .into_iter()
        .map(|(name, created, comment)| {
            let (time, subject) = last.get(&name).cloned().unwrap_or((created, comment.lines().next().unwrap_or_default().to_string()));
            GitLocalBranch {
                is_current: current.as_deref() == Some(name.as_str()),
                name,
                upstream: None,
                upstream_gone: false,
                ahead: 0,
                behind: 0,
                time,
                subject,
            }
        })
        .collect();
    local.sort_by(|a, b| b.time.cmp(&a.time));
    Ok(GitBranchList { current, local, remote: Vec::new(), remotes: Vec::new() })
}

/// Switch the workspace to `branch`. Pending changes come along (`cm`
/// shelves and reapplies them) instead of stopping at a prompt nobody sees.
pub(crate) fn switch(root: &Path, branch: &str) -> Result<(), String> {
    let branch = safe_branch(branch)?;
    let out = cm(root)?.slow().arg("switch").arg(format!("br:{branch}")).arg("--noinput").run_ok("cm switch")?;
    forget_behind(root);
    // `cm switch` can stop without failing; believe only where the workspace ended up.
    if workspace_info(root)?.branch.as_deref() != Some(branch.as_str()) {
        let detail = out.combined();
        return Err(if detail.is_empty() {
            format!("Unity VCS didn't switch to {branch}.")
        } else {
            explain(format!("Unity VCS didn't switch to {branch}.\n\n{detail}"))
        });
    }
    Ok(())
}

/// `git switch -c` for Unity VCS: a new child of the current branch, switched to.
pub(crate) fn checkout(root: &Path, branch: &str, create: bool) -> Result<(), String> {
    if create {
        branch_create(root, branch, None, true)
    } else {
        switch(root, branch)
    }
}

/// Create a branch. `name` is a full path (`/main/x`) or a child name
/// (`x`), which goes under `from`, or the current branch. Unity VCS starts
/// it at the newest changeset of its parent.
pub(crate) fn branch_create(root: &Path, name: &str, from: Option<&str>, checkout: bool) -> Result<(), String> {
    let parent = match from.map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => safe_branch(f)?,
        None => workspace_info(root)?
            .branch
            .ok_or("The workspace isn't on a branch. Switch to one, or give the new branch a full name like /main/task.")?,
    };
    let full = child_branch(name, &parent)?;
    cm(root)?.args(["branch", "create"]).arg(&full).run_ok("cm branch create")?;
    if checkout {
        switch(root, &full)?;
    }
    Ok(())
}

/// Rename keeps a branch under its parent: `to` is a new last segment, or a
/// full path with the same parent.
pub(crate) fn branch_rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let from = safe_branch(from)?;
    let to_full = if to.trim().contains('/') { safe_branch(to)? } else { child_branch(to, parent_of(&from))? };
    if parent_of(&to_full) != parent_of(&from) {
        return Err(format!(
            "Unity VCS renames a branch in place. Keep it under {}.",
            if parent_of(&from).is_empty() { "the top level" } else { parent_of(&from) }
        ));
    }
    let leaf = to_full.rsplit('/').next().unwrap_or_default();
    cm(root)?.args(["branch", "rename"]).arg(format!("br:{from}")).arg(leaf).run_ok("cm branch rename")?;
    Ok(())
}

/// Delete a branch. Unity VCS itself refuses one with changesets or child
/// branches; that refusal is the error.
pub(crate) fn branch_delete(root: &Path, branch: &str) -> Result<(), String> {
    let branch = safe_branch(branch)?;
    if workspace_info(root)?.branch.as_deref() == Some(branch.as_str()) {
        return Err(format!("The workspace is on {branch}. Switch to another branch before deleting it."));
    }
    cm(root)?.args(["branch", "delete"]).arg(format!("br:{branch}")).run_ok("cm branch delete")?;
    Ok(())
}

pub(crate) fn unsupported<T>(what: &str) -> Result<T, String> {
    Err(format!("{what} isn't part of Unity Version Control. Checkins go straight to the server."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_xml() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<StatusOutput>
  <WorkspaceStatus><Status><RepSpec><Server>org@cloud</Server><Name>Crop Chop/Crop Chop</Name></RepSpec><Changeset>274</Changeset></Status></WorkspaceStatus>
  <WkConfigType>Branch</WkConfigType>
  <WkConfigName>/main/task@Crop Chop/Crop Chop@org@cloud</WkConfigName>
  <Changes>
    <Change><Type>PR</Type><Path>dä</Path><OldPath /><RevisionType>enDirectory</RevisionType></Change>
    <Change><Type>PR</Type><Path>dä\ü 日本 &amp; co.txt</Path><OldPath /><RevisionType>enTextFile</RevisionType></Change>
    <Change><Type>LM</Type><Path>sub\d.cs</Path><OldPath>sub\c.cs</OldPath><PrintableMovedPath>sub\c.cs -&gt; sub\d.cs</PrintableMovedPath><RevisionType>enTextFile</RevisionType></Change>
    <Change><Type>CO+CH</Type><Path>Assets\x.unity</Path><OldPath /><RevisionType>enTextFile</RevisionType></Change>
    <Change><Type>LD</Type><Path>Old</Path><OldPath /><RevisionType>enDirectory</RevisionType></Change>
    <Change><Type>AD</Type><Path>Assets\new.cs</Path><OldPath /><RevisionType>enTextFile</RevisionType></Change>
    <Change><Type>IG</Type><Path>Library\junk</Path><OldPath /><RevisionType>enTextFile</RevisionType></Change>
    <Change><Type>CH</Type><Path>..\outside.txt</Path><OldPath /><RevisionType>enTextFile</RevisionType></Change>
  </Changes>
</StatusOutput>"#;
        let p = parse_status(xml);
        assert_eq!(
            p.info,
            WorkspaceInfo {
                branch: Some("/main/task".into()),
                repository: Some("Crop Chop/Crop Chop@org@cloud".into()),
                changeset: Some(274)
            }
        );
        let rows: Vec<(&str, &str, Option<&str>)> =
            p.entries.iter().map(|e| (e.letter, e.path.as_str(), e.orig.as_deref())).collect();
        assert_eq!(
            rows,
            vec![
                ("?", "dä/ü 日本 & co.txt", None),
                ("R", "sub/d.cs", Some("sub/c.cs")),
                ("M", "Assets/x.unity", None),
                ("D", "Old", None),
                ("A", "Assets/new.cs", None),
            ]
        );
        assert!(p.entries[3].dir);

        let pinned = parse_status("<WkConfigType>Changeset</WkConfigType><WkConfigName>2@game@local</WkConfigName>");
        assert_eq!((pinned.info.branch, pinned.info.repository.as_deref()), (None, Some("game@local")));
    }

    #[test]
    fn xml_helpers() {
        assert_eq!(unescape("a &lt;b&gt; &amp;amp; &#252;&#x65E5; &bogus; & x"), "a <b> &amp; ü日 &bogus; & x");
        assert_eq!(xml_text("<A /><A>x</A>", "A").as_deref(), Some(""));
        assert_eq!(xml_text("<AB>no</AB><A>yes</A>", "A").as_deref(), Some("yes"));
        assert_eq!(xml_text("<B/>", "A"), None);
        assert_eq!(xml_blocks("<CHANGESET><CHANGESETID>1</CHANGESETID></CHANGESET><CHANGESET>x</CHANGESET>", "CHANGESET").len(), 2);
    }

    #[test]
    fn find_xml() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<PLASTICQUERY>
  <CHANGESET><ID>9</ID><CHANGESETID>2</CHANGESETID><COMMENT>Grün &lt;3

body</COMMENT><DATE>2026-11-15T18:52:55+03:00</DATE><OWNER>me</OWNER><BRANCH>/main/x</BRANCH><GUID>g2</GUID></CHANGESET>
  <CHANGESET><ID>6</ID><CHANGESETID>0</CHANGESETID><COMMENT></COMMENT><DATE>2026-11-15T18:51:03+03:00</DATE><OWNER>me</OWNER><BRANCH>/main</BRANCH><GUID>g0</GUID></CHANGESET>
</PLASTICQUERY>"#;
        let cs = parse_changesets(xml);
        assert_eq!(cs.len(), 2);
        assert_eq!((cs[0].id, cs[0].branch.as_str(), cs[0].comment.as_str()), (2, "/main/x", "Grün <3\n\nbody"));
        assert_eq!(cs[0].time, 1_794_757_975_000);
        assert_eq!(cs[1].comment, "");

        let br = parse_branches("<PLASTICQUERY><BRANCH><COMMENT>feature x</COMMENT><DATE>1970-01-01T00:00:01Z</DATE><NAME>/main/x</NAME><CHANGESET>5</CHANGESET></BRANCH></PLASTICQUERY>");
        assert_eq!(br, vec![("/main/x".to_string(), 1000, "feature x".to_string())]);
    }

    #[test]
    fn selector_branch() {
        assert_eq!(parse_selector_branch("repository \"g@local\"\r\n  path \"/\"\r\n    smartbranch \"/main\"").as_deref(), Some("/main"));
        assert_eq!(parse_selector_branch("repository \"g\"\n  path \"/\"\n    br \"/main/x\"\n    co \"/main\"").as_deref(), Some("/main/x"));
        assert_eq!(parse_selector_branch("    smartbranch \"/main\" changeset \"2\""), None);
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_date("2026-11-15T18:52:55.0000000+03:00"), Some(1_794_757_975_000));
        assert_eq!(parse_date("2026-11-15T15:52:55.25Z"), Some(1_794_757_975_250));
        assert_eq!(parse_date("2026-11-15T10:52:55-05:00"), Some(1_794_757_975_000));
        assert_eq!(parse_date("nope"), None);
    }

    #[test]
    fn branch_names() {
        assert_eq!(safe_branch("main/task").unwrap(), "/main/task");
        assert_eq!(safe_branch(" /main ").unwrap(), "/main");
        for bad in ["", "-x", "/main/a b", "/main/../x", "/main//x", "/main/", "/", "/main/x@repo", "br:/main"] {
            assert!(safe_branch(bad).is_err(), "{bad}");
        }
        assert_eq!(child_branch("task", "/main").unwrap(), "/main/task");
        assert_eq!(child_branch("/dev", "/main").unwrap(), "/dev");
        assert_eq!(child_branch("a/b", "/main").unwrap(), "/main/a/b");
        assert_eq!(parent_of("/main/x"), "/main");
        assert_eq!(parent_of("/main"), "");
    }

    #[test]
    fn update_output() {
        assert_eq!(update_summary("Downloading file c:\\w\\a.txt (16 bytes) from g@local\nDownloaded c:\\w\\a.txt from g@local"), "Updated. Downloaded 1 file.");
        assert_eq!(update_summary("The workspace c:\\w is up-to-date (cset:8@g@local)"), "");
        assert_eq!(update_summary("Processing directory operations (applying filesystem protections)"), "Updated to the latest changeset.");
    }

    #[test]
    fn checkin_output() {
        let out = "CI_START\nAD \\a.txt\nCHANGESET cs:12@br:/main@game@local (mount:'/')\n";
        assert_eq!(changeset_of(out).as_deref(), Some("cs:12"));
        assert_eq!(changeset_of("nothing"), None);
    }

    #[test]
    fn diffs_look_like_git() {
        let d = unified_diff(Some("a.txt"), Some("a.txt"), Some(b"one\ntwo\nthree\n"), Some(b"one\n2\nthree\n"));
        assert!(d.starts_with("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n"), "{d}");
        assert!(d.contains("\n-two\n+2\n"), "{d}");

        let added = unified_diff(None, Some("n.txt"), None, Some(b"x\n"));
        assert!(added.contains("new file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+x\n"), "{added}");

        let gone = unified_diff(Some("g.txt"), None, Some(b"x\ny\n"), None);
        assert!(gone.contains("deleted file mode 100644\n--- a/g.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n"), "{gone}");

        let moved = unified_diff(Some("a.cs"), Some("b.cs"), Some(b"same\n"), Some(b"same\n"));
        assert_eq!(moved, "diff --git a/a.cs b/b.cs\nrename from a.cs\nrename to b.cs\n");

        let bin = unified_diff(Some("t.png"), Some("t.png"), Some(b"\x89PNG\0a"), Some(b"\x89PNG\0b"));
        assert!(bin.ends_with("Binary files a/t.png and b/t.png differ\n"), "{bin}");

        let empty = unified_diff(None, Some("e.txt"), None, Some(b""));
        assert_eq!(empty, "diff --git a/e.txt b/e.txt\nnew file mode 100644\n");
    }

    /// Drives a real `cm` against a scratch workspace: set `MANGO_CM_WORKSPACE`
    /// to the root of a throwaway workspace (e.g. on the `local` server) and run
    /// `cargo test --lib plastic::tests::real_cm -- --ignored --nocapture`.
    /// It checks in, creates, switches, renames and deletes branches there.
    #[test]
    #[ignore]
    fn real_cm() {
        let Some(root) = std::env::var_os("MANGO_CM_WORKSPACE").map(PathBuf::from) else {
            eprintln!("MANGO_CM_WORKSPACE is not set; skipping");
            return;
        };
        let file_of = |s: &GitStatus, p: &str| s.files.iter().find(|f| f.path == p).cloned();
        let id = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        let start = status(&root).unwrap();
        assert_eq!(start.vcs, Vcs::Plastic);
        let home = start.branch.clone().expect("workspace should be on a branch");
        println!("on {home} at cs:{}", start.head.as_deref().unwrap_or("?"));
        assert!(start.files.is_empty(), "start from a clean workspace: {:?}", start.files);

        // New files, including one with a space and non-ASCII in a new folder.
        let dir = format!("mango-{id}");
        std::fs::create_dir_all(root.join(&dir)).unwrap();
        std::fs::write(root.join(&dir).join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(root.join(&dir).join("ü b.txt"), "grün\n").unwrap();
        let s = status(&root).unwrap();
        let a = format!("{dir}/a.txt");
        let u = format!("{dir}/ü b.txt");
        assert_eq!(file_of(&s, &a).unwrap().worktree.as_deref(), Some("?"), "{:?}", s.files);
        assert_eq!(file_of(&s, &u).unwrap().worktree.as_deref(), Some("?"), "{:?}", s.files);
        assert!(diff(&root, &u).unwrap().contains("+grün"));

        // Stage one, check in just that one.
        stage(&root, std::slice::from_ref(&a)).unwrap();
        let s = status(&root).unwrap();
        assert_eq!(file_of(&s, &a).unwrap().index.as_deref(), Some("A"));
        if s.behind > 0 {
            // Someone else checked in on this branch: checkin must say to update first.
            println!("behind by {}", s.behind);
            let err = checkin(&root, "should fail").unwrap_err();
            assert!(err.starts_with("The branch has changesets"), "{err}");
            println!("update: {}", update(&root).unwrap());
            assert_eq!(status(&root).unwrap().behind, 0);
        }
        let cs = checkin(&root, &format!("Mango test {id}\n\nbody")).unwrap();
        println!("checked in {cs}");
        assert!(cs.starts_with("cs:"));
        let s = status(&root).unwrap();
        assert!(file_of(&s, &a).is_none());
        assert!(file_of(&s, &u).is_some());
        assert_eq!(log(&root, 5).unwrap()[0].subject, format!("Mango test {id}"));

        // Edit, diff, undo.
        std::fs::write(root.join(&a), "one\n2\nthree\n").unwrap();
        status(&root).unwrap();
        let d = diff(&root, &a).unwrap();
        assert!(d.contains("-two\n+2\n"), "{d}");
        discard(&root, std::slice::from_ref(&a)).unwrap();
        let back = std::fs::read_to_string(root.join(&a)).unwrap();
        assert_eq!(back.replace('\r', ""), "one\ntwo\nthree\n");

        // Discarding a private file deletes it.
        discard(&root, std::slice::from_ref(&u)).unwrap();
        assert!(!root.join(&u).exists());

        // Move and delete show up as R and D with diffs.
        std::fs::rename(root.join(&a), root.join(&dir).join("moved.txt")).unwrap();
        let s = status(&root).unwrap();
        let moved = file_of(&s, &format!("{dir}/moved.txt")).expect("move detected");
        assert_eq!((moved.worktree.as_deref(), moved.orig_path.as_deref()), (Some("R"), Some(a.as_str())));
        assert!(diff(&root, &format!("{dir}/moved.txt")).unwrap().contains(&format!("rename from {a}")));
        discard(&root, &[]).unwrap();
        assert!(status(&root).unwrap().files.is_empty());

        // Branches: create a child, switch, rename, back, delete.
        let child = format!("{home}/mango-{id}");
        branch_create(&root, &format!("mango-{id}"), None, true).unwrap();
        assert_eq!(status(&root).unwrap().branch.as_deref(), Some(child.as_str()));
        let list = branch_list(&root).unwrap();
        assert!(list.local.iter().any(|b| b.name == child && b.is_current));
        switch(&root, &home).unwrap();
        branch_rename(&root, &child, &format!("mango-{id}-renamed")).unwrap();
        let renamed = format!("{child}-renamed");
        assert!(branches(&root).unwrap().local.contains(&renamed));
        assert!(branch_delete(&root, &home).is_err());
        branch_delete(&root, &renamed).unwrap();
        assert!(!branches(&root).unwrap().local.contains(&renamed));
        assert!(switch(&root, "/no/such/branch").is_err());
        assert_eq!(status(&root).unwrap().branch.as_deref(), Some(home.as_str()));

        // Update on an up-to-date workspace is harmless.
        println!("update: {}", update(&root).unwrap());
    }
}
