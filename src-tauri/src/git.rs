//! Source control for the Changes panel: status, diffs, staging, commits,
//! branches and sync. Everything shells out to the user's own `git`, so
//! hooks, credentials and config behave exactly as they do in a terminal.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Local commands finish in milliseconds; this only catches a stuck process.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
/// Fetch, pull, push, and commit (hooks may run a test suite).
const SLOW_TIMEOUT: Duration = Duration::from_secs(600);
/// A diff larger than this is cut off with a marker line.
const DIFF_CAP: usize = 400 * 1024;
/// The last line of a diff that was cut off at [`DIFF_CAP`].
const DIFF_TRUNCATED: &str = "\\ Diff truncated at 400 KB";
/// How much of stderr is kept for error messages.
const STDERR_CAP: usize = 64 * 1024;
/// Upper bounds for one command line's worth of paths.
const CHUNK_PATHS: usize = 200;
const CHUNK_BYTES: usize = 8000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Relative to the repository root, forward slashes.
    pub path: String,
    /// Previous path for renames and copies.
    pub orig_path: Option<String>,
    /// Staged side: M, A, D, R or C.
    pub index: Option<String>,
    /// Working-tree side: M, D, `?` for untracked, `U` for a conflict.
    pub worktree: Option<String>,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    /// Unix ms.
    pub time: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: Option<String>,
    pub local: Vec<String>,
}

/// One local branch, with how it stands against its upstream.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitLocalBranch {
    pub name: String,
    pub is_current: bool,
    /// e.g. "origin/main"; None when the branch tracks nothing.
    pub upstream: Option<String>,
    /// The upstream ref no longer exists (deleted on the remote).
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Tip commit time, unix ms.
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteBranch {
    /// Full short name, e.g. "origin/feature/x".
    pub name: String,
    /// The remote it lives on, e.g. "origin".
    pub remote: String,
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchList {
    pub current: Option<String>,
    pub local: Vec<GitLocalBranch>,
    pub remote: Vec<GitRemoteBranch>,
    pub remotes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// What `git status --porcelain=v2 --branch -z` says.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ParsedStatus {
    /// Full hash of HEAD; `None` on an unborn branch.
    pub oid: Option<String>,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

/// One side of an `XY` status pair. `.` means unchanged; a type change is
/// shown as a modification.
fn side(code: u8) -> Option<String> {
    match code {
        b'.' | b' ' => None,
        b'T' => Some("M".into()),
        other => Some((other as char).to_string()),
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Parse porcelain v2 output (`-z`: records end in NUL, paths are verbatim).
pub(crate) fn parse_status(bytes: &[u8]) -> ParsedStatus {
    let mut out = ParsedStatus::default();
    let mut records = bytes.split(|&b| b == 0);
    while let Some(record) = records.next() {
        let Some(&kind) = record.first() else { continue };
        match kind {
            b'#' => {
                let line = lossy(record);
                let mut words = line.splitn(3, ' ').skip(1);
                let (Some(key), Some(value)) = (words.next(), words.next()) else { continue };
                match key {
                    "branch.oid" if value != "(initial)" => out.oid = Some(value.to_string()),
                    "branch.head" if value != "(detached)" => out.branch = Some(value.to_string()),
                    "branch.upstream" => out.upstream = Some(value.to_string()),
                    "branch.ab" => {
                        for part in value.split(' ') {
                            if let Some(n) = part.strip_prefix('+') {
                                out.ahead = n.parse().unwrap_or(0);
                            } else if let Some(n) = part.strip_prefix('-') {
                                out.behind = n.parse().unwrap_or(0);
                            }
                        }
                    }
                    _ => {}
                }
            }
            // 1 XY sub mH mI mW hH hI path
            // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
            b'1' | b'2' => {
                let renamed = kind == b'2';
                let fields: Vec<&[u8]> = record
                    .splitn(if renamed { 10 } else { 9 }, |&b| b == b' ')
                    .collect();
                // The original path is its own record; take it even if this one is malformed.
                let orig = if renamed { records.next() } else { None };
                let (Some(xy), Some(path)) = (fields.get(1), fields.last()) else { continue };
                if xy.len() != 2 || fields.len() != if renamed { 10 } else { 9 } {
                    continue;
                }
                out.files.push(GitFile {
                    path: lossy(path),
                    orig_path: orig.filter(|o| !o.is_empty()).map(lossy),
                    index: side(xy[0]),
                    worktree: side(xy[1]),
                    conflicted: false,
                });
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            b'u' => {
                let fields: Vec<&[u8]> = record.splitn(11, |&b| b == b' ').collect();
                if fields.len() != 11 {
                    continue;
                }
                out.files.push(GitFile {
                    path: lossy(fields[10]),
                    orig_path: None,
                    index: None,
                    worktree: Some("U".into()),
                    conflicted: true,
                });
            }
            b'?' => {
                if let Some(path) = record.get(2..).filter(|p| !p.is_empty()) {
                    out.files.push(GitFile {
                        path: lossy(path),
                        orig_path: None,
                        index: None,
                        worktree: Some("?".into()),
                        conflicted: false,
                    });
                }
            }
            // `!` (ignored) and anything unknown.
            _ => {}
        }
    }
    out
}

/// Parse `git log --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e`.
pub(crate) fn parse_log(text: &str) -> Vec<GitCommit> {
    text.split('\x1e')
        .filter_map(|record| {
            let mut fields = record.trim_matches(['\n', '\r']).split('\x1f');
            let hash = fields.next().filter(|h| !h.is_empty())?;
            let short_hash = fields.next()?;
            let subject = fields.next()?;
            let author = fields.next()?;
            let seconds: u64 = fields.next()?.trim().parse().ok()?;
            Some(GitCommit {
                hash: hash.to_string(),
                short_hash: short_hash.to_string(),
                subject: subject.to_string(),
                author: author.to_string(),
                time: seconds.saturating_mul(1000),
            })
        })
        .collect()
}

/// Old path of a staged rename whose new path is `file`, from
/// `git diff --cached -M --name-status -z --diff-filter=R`.
pub(crate) fn rename_source(name_status: &[u8], file: &str) -> Option<String> {
    let mut tokens = name_status.split(|&b| b == 0);
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        let (old, new) = (tokens.next()?, tokens.next()?);
        if status.first() == Some(&b'R') && new == file.as_bytes() {
            return Some(lossy(old));
        }
    }
    None
}

/// Turn captured diff bytes into text, cutting at a line boundary and adding
/// the marker line when the output was capped.
pub(crate) fn finish_diff(mut bytes: Vec<u8>, truncated: bool) -> String {
    if !truncated {
        return lossy(&bytes);
    }
    match bytes.iter().rposition(|&b| b == b'\n') {
        Some(end) => bytes.truncate(end + 1),
        None => bytes.clear(),
    }
    let mut text = lossy(&bytes);
    text.push_str(DIFF_TRUNCATED);
    text.push('\n');
    text
}

/// Git's own "new file" header line, present before the first hunk.
fn is_new_file_diff(diff: &str) -> bool {
    diff.lines()
        .take_while(|l| !l.starts_with("@@"))
        .any(|l| l.starts_with("new file mode "))
}

/// A path relative to the repository root that cannot escape it.
fn clean_rel(file: &str) -> Result<&str, String> {
    let bad = || format!("\"{file}\" is not a path inside the repository");
    if file.is_empty() || file.contains('\0') || file.starts_with(['/', '\\']) {
        return Err(bad());
    }
    let path = Path::new(file);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(bad());
    }
    Ok(file)
}

/// Split a path list so no single command line gets too long (Windows caps
/// it at 32k characters).
fn chunks(paths: &[String]) -> Vec<&[String]> {
    let mut out = Vec::new();
    let (mut start, mut bytes) = (0, 0);
    for (i, p) in paths.iter().enumerate() {
        if i > start && (i - start >= CHUNK_PATHS || bytes + p.len() > CHUNK_BYTES) {
            out.push(&paths[start..i]);
            start = i;
            bytes = 0;
        }
        bytes += p.len() + 1;
    }
    if start < paths.len() {
        out.push(&paths[start..]);
    }
    out
}

/// Git redraws progress with `\r`; keep only the final state of each line.
fn tidy_output(text: &str) -> String {
    text.lines()
        .map(|l| l.rsplit('\r').next().unwrap_or(l).trim_end())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Field separator in our `for-each-ref` format (never appears in ref data).
const REF_SEP: char = '\u{1f}';

/// "ahead 2, behind 1" / "gone" / "" → (ahead, behind, gone).
fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    let mut gone = false;
    for part in track.split(',').map(str::trim) {
        if part == "gone" {
            gone = true;
        } else if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, gone)
}

/// Parse `for-each-ref` output in the format used by `branch_list`.
fn parse_refs(text: &str, current: Option<&str>) -> (Vec<GitLocalBranch>, Vec<GitRemoteBranch>) {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split(REF_SEP).collect();
        if f.len() < 6 {
            continue;
        }
        let (full, upstream, track, time, subject) = (f[0], f[2], f[3], f[4], f[5]);
        let time = time.trim().parse::<i64>().unwrap_or(0) * 1000;
        if let Some(name) = full.strip_prefix("refs/heads/") {
            let (ahead, behind, gone) = parse_track(track);
            local.push(GitLocalBranch {
                name: name.to_string(),
                is_current: current == Some(name),
                upstream: Some(upstream.to_string()).filter(|u| !u.is_empty()),
                upstream_gone: gone,
                ahead,
                behind,
                time,
                subject: subject.to_string(),
            });
        } else if let Some(name) = full.strip_prefix("refs/remotes/") {
            // "origin/HEAD" is a pointer to the default branch, not a branch.
            if name.ends_with("/HEAD") || !name.contains('/') {
                continue;
            }
            let remote_name = name.split('/').next().unwrap_or_default().to_string();
            remote.push(GitRemoteBranch { name: name.to_string(), remote: remote_name, time, subject: subject.to_string() });
        }
    }
    (local, remote)
}

/// A ref name that is safe to hand to git as an argument.
fn safe_ref(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a branch name".into());
    }
    if name.starts_with('-') || name.contains(char::is_whitespace) || name.contains("..") {
        return Err(format!("\"{name}\" is not a valid branch name"));
    }
    Ok(name)
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

struct Output {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// stdout hit its cap and the rest was dropped.
    truncated: bool,
}

impl Output {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }
    fn text(&self) -> String {
        lossy(&self.stdout)
    }
    fn line(&self) -> String {
        self.text().trim_end_matches(['\n', '\r']).to_string()
    }
    /// stderr then stdout, cleaned up for display.
    fn combined(&self) -> String {
        tidy_output(&format!("{}\n{}", lossy(&self.stderr), lossy(&self.stdout)))
    }
    /// A human-readable reason for a failed command.
    fn error(&self, what: &str) -> String {
        let detail = self.combined();
        if !detail.is_empty() {
            return detail;
        }
        match self.code {
            Some(code) => format!("{what} failed (exit code {code})"),
            None => format!("{what} was interrupted"),
        }
    }
}

/// Read up to `cap` bytes. With `drain`, keep reading (and dropping) after
/// the cap so the writer never blocks; without it, stop, which closes the
/// pipe and ends the writer.
fn read_capped(mut source: impl Read, cap: usize, drain: bool) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 16 * 1024];
    loop {
        match source.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let room = cap - out.len();
                out.extend_from_slice(&buf[..n.min(room)]);
                if n > room {
                    truncated = true;
                    if !drain {
                        break;
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    (out, truncated)
}

/// The git binary and a PATH on which it can find its helpers (ssh,
/// credential helpers, hooks' interpreters) when the app was started from a
/// launcher with a minimal environment.
fn tools() -> &'static (PathBuf, Option<OsString>) {
    static TOOLS: OnceLock<(PathBuf, Option<OsString>)> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let git = crate::bin::git();
        let path = crate::bin::augmented_path(git.parent().filter(|p| !p.as_os_str().is_empty()));
        (git, path)
    })
}

struct Git {
    cmd: Command,
    stdin: Option<Vec<u8>>,
    cap: usize,
    timeout: Duration,
}

/// A git invocation in `dir` that can never wait for a terminal.
fn git(dir: &Path) -> Git {
    let (bin, path) = tools();
    let mut cmd = Command::new(bin);
    crate::bin::hide_console(&mut cmd);
    cmd.current_dir(dir)
        // Never hang on a credential prompt nobody can see.
        .env("GIT_TERMINAL_PROMPT", "0")
        // File names are data, not glob patterns (`pages/[id].vue`).
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["--no-pager", "-c", "core.quotepath=off", "-c", "color.ui=never"]);
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    Git { cmd, stdin: None, cap: usize::MAX, timeout: LOCAL_TIMEOUT }
}

impl Git {
    fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.cmd.arg(arg);
        self
    }
    fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.cmd.args(args);
        self
    }
    /// For commands that only look: don't take the index lock, so polling
    /// never collides with the user's (or an agent's) own git.
    fn read_only(mut self) -> Self {
        self.cmd.env("GIT_OPTIONAL_LOCKS", "0");
        self
    }
    fn slow(mut self) -> Self {
        self.timeout = SLOW_TIMEOUT;
        self
    }
    fn stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }
    /// Keep at most `bytes` of stdout and stop the command there.
    fn cap(mut self, bytes: usize) -> Self {
        self.cap = bytes;
        self
    }

    fn run(mut self) -> Result<Output, String> {
        self.cmd
            .stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = self.cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "git is not installed or not on PATH".to_string(),
            _ => format!("Could not run git: {e}"),
        })?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let cap = self.cap;
        let out = std::thread::spawn(move || match stdout {
            Some(s) => read_capped(s, cap, false),
            None => (Vec::new(), false),
        });
        let err = std::thread::spawn(move || match stderr {
            Some(s) => read_capped(s, STDERR_CAP, true).0,
            None => Vec::new(),
        });
        if let (Some(mut pipe), Some(bytes)) = (child.stdin.take(), self.stdin.take()) {
            // A command that exits early closes the pipe; its error says why.
            let _ = pipe.write_all(&bytes);
        }

        let deadline = Instant::now() + self.timeout;
        let mut nap = Duration::from_millis(1);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(nap);
                    nap = (nap * 2).min(Duration::from_millis(20));
                }
                Ok(None) => {
                    // The readers are left to finish on their own: a helper
                    // process may still hold the pipes open.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git did not finish within {} seconds and was stopped",
                        self.timeout.as_secs()
                    ));
                }
                Err(e) => return Err(format!("Could not wait for git: {e}")),
            }
        };
        let (stdout, truncated) = out.join().unwrap_or_default();
        let stderr = err.join().unwrap_or_default();
        Ok(Output { code: status.code(), stdout, stderr, truncated })
    }

    /// Run and turn a non-zero exit into an error.
    fn run_ok(self, what: &str) -> Result<Output, String> {
        let out = self.run()?;
        if out.ok() {
            Ok(out)
        } else {
            Err(out.error(what))
        }
    }
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

fn existing_dir(path: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Err("No folder given".into());
    }
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    Ok(dir)
}

/// The work tree containing `dir` and the short hash of its HEAD (when it
/// has a commit). `None` when `dir` is not inside a work tree.
fn locate(dir: &Path) -> Result<Option<(String, Option<String>)>, String> {
    let out = git(dir)
        .read_only()
        .args(["rev-parse", "--show-toplevel", "--short", "HEAD"])
        .run()?;
    let text = out.text();
    let mut lines = text.lines();
    let Some(root) = lines.next().filter(|l| !l.is_empty()) else {
        let reason = lossy(&out.stderr);
        // Git refuses repositories owned by someone else; that is not "no repo".
        if reason.contains("safe.directory") {
            return Err(tidy_output(&reason));
        }
        return Ok(None);
    };
    // On an unborn branch the command fails after printing the root.
    let head = lines
        .next()
        .filter(|h| out.ok() && !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_string);
    Ok(Some((root.to_string(), head)))
}

/// Repository root for a command that needs one.
fn require_root(path: &str) -> Result<PathBuf, String> {
    let dir = existing_dir(path)?;
    match locate(&dir)? {
        Some((root, _)) => Ok(PathBuf::from(root)),
        None => Err(format!("{} is not inside a git repository", dir.display())),
    }
}

fn read_status(dir: &Path, untracked: bool) -> Result<ParsedStatus, String> {
    let out = git(dir)
        .read_only()
        .args(["status", "--porcelain=v2", "--branch", "-z"])
        // Every untracked file, not just its folder: each one is a row with a diff.
        .arg(if untracked { "--untracked-files=all" } else { "--untracked-files=no" })
        .run_ok("git status")?;
    Ok(parse_status(&out.stdout))
}

fn has_head(root: &Path) -> Result<bool, String> {
    Ok(git(root)
        .read_only()
        .args(["rev-parse", "-q", "--verify", "HEAD^{commit}"])
        .run()?
        .ok())
}

fn status_of(path: &str) -> Result<GitStatus, String> {
    let dir = existing_dir(path)?;
    let Some((root, head)) = locate(&dir)? else {
        return Ok(GitStatus::default());
    };
    let parsed = read_status(&dir, true)?;
    Ok(GitStatus {
        is_repo: true,
        root: Some(root),
        branch: parsed.branch,
        head: match (&parsed.oid, head) {
            (None, _) => None,
            (Some(oid), Some(short)) if oid.starts_with(&short) => Some(short),
            (Some(oid), _) => Some(oid.chars().take(7).collect()),
        },
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        files: parsed.files,
    })
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

fn diff_of(path: &str, file: &str, staged: bool) -> Result<String, String> {
    let root = require_root(path)?;
    let file = clean_rel(file)?;
    let diff = |paths: &[&str]| -> Result<String, String> {
        let mut cmd = git(&root)
            .read_only()
            .cap(DIFF_CAP)
            .args(["diff", "--no-color", "--no-ext-diff", "-M"]);
        if staged {
            cmd = cmd.arg("--cached");
        }
        let out = cmd.arg("--").args(paths).run()?;
        // A capped diff ends git with a broken pipe; that is still a result.
        if !out.ok() && !out.truncated {
            return Err(out.error("git diff"));
        }
        Ok(finish_diff(out.stdout, out.truncated))
    };

    let text = diff(&[file])?;
    if staged {
        // A staged rename limited to its new path looks like a brand-new
        // file; ask for both sides so only the real edits show.
        if is_new_file_diff(&text) {
            let renames = git(&root)
                .read_only()
                .args(["diff", "--cached", "-M", "--name-status", "-z", "--diff-filter=R"])
                .run()?;
            if let Some(old) = renames.ok().then(|| rename_source(&renames.stdout, file)).flatten() {
                return diff(&[old.as_str(), file]);
            }
        }
        return Ok(text);
    }
    if !text.is_empty() {
        return Ok(text);
    }

    // Nothing against the index: either unchanged or not tracked at all.
    let tracked = git(&root)
        .read_only()
        .args(["ls-files", "-z", "--"])
        .arg(file)
        .run_ok("git ls-files")?;
    if !tracked.stdout.is_empty() {
        return Ok(String::new());
    }
    let target = root.join(file);
    match fs::symlink_metadata(&target) {
        Err(_) => return Ok(String::new()),
        Ok(meta) if meta.is_dir() => return Ok(String::new()),
        Ok(_) => {}
    }
    let out = git(&root)
        .read_only()
        .cap(DIFF_CAP)
        .args(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null"])
        .arg(file)
        .run()?;
    // --no-index exits 1 when the two sides differ, which is the expected case.
    if !matches!(out.code, Some(0) | Some(1)) && !out.truncated {
        return Err(out.error("git diff"));
    }
    Ok(finish_diff(out.stdout, out.truncated))
}

// ---------------------------------------------------------------------------
// Staging and discarding
// ---------------------------------------------------------------------------

fn stage(path: &str, files: &[String]) -> Result<(), String> {
    let root = require_root(path)?;
    if files.is_empty() {
        git(&root).args(["add", "-A"]).run_ok("git add")?;
        return Ok(());
    }
    for file in files {
        clean_rel(file)?;
    }
    for chunk in chunks(files) {
        git(&root).args(["add", "-A", "--"]).args(chunk).run_ok("git add")?;
    }
    Ok(())
}

fn unstage(path: &str, files: &[String]) -> Result<(), String> {
    let root = require_root(path)?;
    for file in files {
        clean_rel(file)?;
    }
    let status = read_status(&root, false)?;
    // Only what is actually staged, and never a conflicted path: resetting
    // one would silently drop its conflict state.
    let mut paths: Vec<String> = Vec::new();
    for f in status.files.iter().filter(|f| f.index.is_some() && !f.conflicted) {
        if !files.is_empty() && !files.iter().any(|want| want == &f.path) {
            continue;
        }
        paths.push(f.path.clone());
        // The other half of a rename, or it would stay behind as a staged deletion.
        if let Some(orig) = &f.orig_path {
            paths.push(orig.clone());
        }
    }
    paths.sort();
    paths.dedup();

    let unborn = status.oid.is_none();
    for chunk in chunks(&paths) {
        if unborn {
            // No HEAD to restore from: take the entries out of the index.
            git(&root)
                .args(["rm", "--cached", "-q", "--ignore-unmatch", "--"])
                .args(chunk)
                .run_ok("git rm --cached")?;
        } else {
            git(&root)
                .args(["restore", "--staged", "--"])
                .args(chunk)
                .run_ok("git restore --staged")?;
        }
    }
    Ok(())
}

/// Delete an untracked file, then any folders that only existed to hold it.
fn remove_untracked(root: &Path, rel: &str) -> Result<(), String> {
    let target = root.join(clean_rel(rel)?);
    match fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Could not read {rel}: {e}")),
        // Only a nested repository is reported as a folder. Too much to delete on a click.
        Ok(meta) if meta.is_dir() => {
            return Err(format!(
                "{} is a folder with its own repository; delete it yourself if you mean to",
                rel.trim_end_matches('/')
            ))
        }
        Ok(_) => {}
    }
    fs::remove_file(&target).map_err(|e| format!("Could not delete {rel}: {e}"))?;
    let mut dir = target.parent();
    while let Some(d) = dir {
        // remove_dir only succeeds on an empty folder.
        if d == root || !d.starts_with(root) || fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
    Ok(())
}

/// Throw away changes. For each file:
/// - untracked (or added with `add -N`): the file is deleted;
/// - changed in the working tree: the working tree goes back to the staged
///   version (to HEAD when nothing is staged), staged changes are kept;
/// - only staged: it goes back to HEAD, so a staged new file is unstaged
///   and deleted.
///
/// An empty list means every working-tree change; staged-only files and
/// conflicts are left alone.
fn discard(path: &str, files: &[String]) -> Result<(), String> {
    let root = require_root(path)?;
    for file in files {
        clean_rel(file)?;
    }
    let status = read_status(&root, true)?;
    let by_path: HashMap<&str, &GitFile> =
        status.files.iter().map(|f| (f.path.as_str(), f)).collect();

    let targets: Vec<&GitFile> = if files.is_empty() {
        status
            .files
            .iter()
            .filter(|f| f.worktree.is_some() && !f.conflicted)
            .collect()
    } else {
        // A path with no changes any more (a stale click) is simply skipped.
        files.iter().filter_map(|f| by_path.get(f.as_str()).copied()).collect()
    };
    if let Some(f) = targets.iter().find(|f| f.conflicted) {
        return Err(format!(
            "{} has merge conflicts. Resolve them, or abort the merge, instead of discarding.",
            f.path
        ));
    }

    let mut untracked: Vec<String> = Vec::new();
    let mut intent_to_add: Vec<String> = Vec::new();
    let mut worktree: Vec<String> = Vec::new();
    let mut staged_only: Vec<String> = Vec::new();
    for f in targets {
        match (f.index.as_deref(), f.worktree.as_deref()) {
            (_, Some("?")) => untracked.push(f.path.clone()),
            // `git add -N`: the index holds an empty placeholder, not content.
            (None, Some("A" | "R" | "C")) => intent_to_add.push(f.path.clone()),
            (_, Some(_)) => worktree.push(f.path.clone()),
            (Some(_), None) => {
                staged_only.push(f.path.clone());
                if let Some(orig) = &f.orig_path {
                    staged_only.push(orig.clone());
                }
            }
            (None, None) => {}
        }
    }

    for chunk in chunks(&worktree) {
        git(&root)
            .args(["restore", "--worktree", "--"])
            .args(chunk)
            .run_ok("git restore")?;
    }
    for chunk in chunks(&staged_only) {
        if status.oid.is_none() {
            git(&root).args(["rm", "-f", "-q", "--"]).args(chunk).run_ok("git rm")?;
        } else {
            // Paths missing from HEAD are removed from the index and the folder.
            git(&root)
                .args(["restore", "--source=HEAD", "--staged", "--worktree", "--"])
                .args(chunk)
                .run_ok("git restore")?;
        }
    }
    for chunk in chunks(&intent_to_add) {
        git(&root)
            .args(["rm", "--cached", "-f", "-q", "--"])
            .args(chunk)
            .run_ok("git rm --cached")?;
    }
    for file in intent_to_add.iter().chain(&untracked) {
        remove_untracked(&root, file)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commit, sync, history, branches
// ---------------------------------------------------------------------------

fn short_head(root: &Path) -> Result<String, String> {
    Ok(git(root)
        .read_only()
        .args(["rev-parse", "--short", "HEAD"])
        .run_ok("git rev-parse")?
        .line())
}

fn commit(path: &str, message: &str, amend: bool) -> Result<String, String> {
    let root = require_root(path)?;
    let message = message.trim();
    if message.is_empty() && !amend {
        return Err("Write a commit message first".into());
    }

    let mut cmd = git(&root).slow().args(["commit", "-q"]);
    if amend {
        cmd = cmd.arg("--amend");
    }
    cmd = if message.is_empty() {
        cmd.arg("--no-edit")
    } else {
        cmd.args(["-F", "-"]).stdin(format!("{message}\n").into_bytes())
    };
    let out = cmd.run()?;
    if out.ok() {
        return short_head(&root);
    }

    // Work out why, without depending on the language of git's messages.
    let status = read_status(&root, false).unwrap_or_default();
    let conflicts = status.files.iter().filter(|f| f.conflicted).count();
    if conflicts > 0 {
        return Err(format!(
            "{conflicts} file{} still {} merge conflicts. Resolve and stage {} before committing.",
            if conflicts == 1 { "" } else { "s" },
            if conflicts == 1 { "has" } else { "have" },
            if conflicts == 1 { "it" } else { "them" },
        ));
    }
    let identity = git(&root).read_only().args(["var", "GIT_AUTHOR_IDENT"]).run()?;
    if !identity.ok() {
        return Err("Git doesn't know who you are yet. Set your name and email, then commit again:\n  git config --global user.name \"Your Name\"\n  git config --global user.email you@example.com".into());
    }
    let merging = git(&root)
        .read_only()
        .args(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .run()?
        .ok();
    if !amend && !merging && !status.files.iter().any(|f| f.index.is_some()) {
        return Err("Nothing is staged. Stage the changes you want in this commit first.".into());
    }
    Err(out.error("git commit"))
}

fn remotes(root: &Path) -> Result<Vec<String>, String> {
    let out = git(root).read_only().arg("remote").run_ok("git remote")?;
    Ok(out.text().lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

const NO_REMOTE: &str =
    "This repository has no remote yet. Add one first:\n  git remote add origin <url>";

/// Add a plain-language first line to the failures people actually hit.
fn explain_sync_failure(detail: String) -> String {
    let lower = detail.to_lowercase();
    let lead = if lower.contains("terminal prompts disabled")
        || lower.contains("authentication failed")
        || lower.contains("permission denied (publickey")
    {
        "The remote asked for credentials Mango can't enter. Sign in from a terminal first (a credential helper, `gh auth login`, or an SSH key), then try again."
    } else if lower.contains("non-fast-forward") || lower.contains("fetch first") {
        "The remote has commits you don't have yet. Pull, then push again."
    } else if lower.contains("could not resolve host") || lower.contains("could not read from remote") {
        "Couldn't reach the remote. Check the connection and the remote's address."
    } else {
        return detail;
    };
    format!("{lead}\n\n{detail}")
}

fn fetch(path: &str) -> Result<String, String> {
    let root = require_root(path)?;
    if remotes(&root)?.is_empty() {
        return Err(NO_REMOTE.into());
    }
    let out = git(&root).slow().arg("fetch").run()?;
    if !out.ok() {
        return Err(explain_sync_failure(out.error("git fetch")));
    }
    Ok(out.combined())
}

fn pull(path: &str) -> Result<String, String> {
    let root = require_root(path)?;
    if remotes(&root)?.is_empty() {
        return Err(NO_REMOTE.into());
    }
    let before = read_status(&root, false)?;
    let Some(branch) = before.branch else {
        return Err("HEAD is detached, so there is no branch to pull into. Switch to a branch first.".into());
    };
    if before.upstream.is_none() {
        return Err(format!(
            "{branch} isn't tracking a remote branch yet. Publish it first, then pull."
        ));
    }
    let out = git(&root).slow().arg("pull").run()?;
    if out.ok() {
        return Ok(out.combined());
    }
    let conflicted: Vec<String> = read_status(&root, false)
        .map(|s| s.files.into_iter().filter(|f| f.conflicted).map(|f| f.path).collect())
        .unwrap_or_default();
    if !conflicted.is_empty() {
        let shown: Vec<String> = conflicted.iter().take(12).map(|p| format!("  {p}")).collect();
        let more = conflicted.len().saturating_sub(shown.len());
        return Err(format!(
            "Pull stopped: merge conflicts in {} file{}.\n{}{}\nResolve them and commit, or run `git merge --abort` to go back.",
            conflicted.len(),
            if conflicted.len() == 1 { "" } else { "s" },
            shown.join("\n"),
            if more > 0 { format!("\n  …and {more} more") } else { String::new() },
        ));
    }
    Err(explain_sync_failure(out.error("git pull")))
}

fn push(path: &str) -> Result<String, String> {
    let root = require_root(path)?;
    let status = read_status(&root, false)?;
    let Some(branch) = status.branch else {
        return Err("HEAD is detached, so there is no branch to push. Switch to a branch first.".into());
    };
    if status.oid.is_none() {
        return Err("There are no commits to push yet.".into());
    }
    let cmd = if status.upstream.is_some() {
        git(&root).slow().arg("push")
    } else {
        // First push: publish the branch and start tracking it.
        let all = remotes(&root)?;
        let preferred = git(&root)
            .read_only()
            .args(["config", "--get", "remote.pushDefault"])
            .run()?
            .line();
        let remote = if all.contains(&preferred) {
            preferred
        } else if all.iter().any(|r| r == "origin") {
            "origin".to_string()
        } else {
            all.first().cloned().ok_or(NO_REMOTE)?
        };
        git(&root).slow().args(["push", "-u"]).arg(remote).arg(&branch)
    };
    let out = cmd.run()?;
    if !out.ok() {
        return Err(explain_sync_failure(out.error("git push")));
    }
    Ok(out.combined())
}

fn log(path: &str, limit: u32) -> Result<Vec<GitCommit>, String> {
    let root = require_root(path)?;
    if !has_head(&root)? {
        return Ok(Vec::new());
    }
    let out = git(&root)
        .read_only()
        .args(["log", "--no-show-signature", "--no-color"])
        .arg(format!("--max-count={}", limit.clamp(1, 500)))
        .arg("--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e")
        .run_ok("git log")?;
    Ok(parse_log(&out.text()))
}

fn branches(path: &str) -> Result<GitBranches, String> {
    let root = require_root(path)?;
    let head = git(&root)
        .read_only()
        .args(["symbolic-ref", "-q", "--short", "HEAD"])
        .run()?;
    let current = Some(head.line()).filter(|b| head.ok() && !b.is_empty());
    let out = git(&root)
        .read_only()
        .args(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"])
        .run_ok("git for-each-ref")?;
    let mut local: Vec<String> =
        out.text().lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
    // A branch with no commits yet has no ref, but it is still where you are.
    if let Some(current) = &current {
        if !local.contains(current) {
            local.insert(0, current.clone());
        }
    }
    Ok(GitBranches { current, local })
}

fn checkout(path: &str, branch: &str, create: bool) -> Result<(), String> {
    let root = require_root(path)?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Enter a branch name".into());
    }
    if branch.starts_with('-') {
        return Err(format!("\"{branch}\" is not a valid branch name"));
    }
    if create {
        let valid = git(&root)
            .read_only()
            .args(["check-ref-format", "--branch"])
            .arg(branch)
            .run()?;
        if !valid.ok() {
            return Err(format!("\"{branch}\" is not a valid branch name"));
        }
        git(&root).args(["switch", "-c"]).arg(branch).run_ok("git switch")?;
    } else {
        git(&root).arg("switch").arg(branch).run_ok("git switch")?;
    }
    Ok(())
}

fn branch_list(path: &str) -> Result<GitBranchList, String> {
    let root = require_root(path)?;
    let head = git(&root).read_only().args(["symbolic-ref", "-q", "--short", "HEAD"]).run()?;
    let current = Some(head.line()).filter(|b| head.ok() && !b.is_empty());
    let format = [
        "%(refname)", "%(refname:short)", "%(upstream:short)", "%(upstream:track,nobracket)",
        "%(committerdate:unix)", "%(contents:subject)",
    ]
    .join("%1f");
    let out = git(&root)
        .read_only()
        .args(["for-each-ref", "--sort=-committerdate"])
        .arg(format!("--format={format}"))
        .args(["refs/heads", "refs/remotes"])
        .run_ok("git for-each-ref")?;
    let (mut local, remote) = parse_refs(&out.text(), current.as_deref());
    // A branch with no commits yet has no ref, but it is still where you are.
    if let Some(cur) = &current {
        if !local.iter().any(|b| &b.name == cur) {
            local.insert(0, GitLocalBranch {
                name: cur.clone(), is_current: true, upstream: None, upstream_gone: false,
                ahead: 0, behind: 0, time: 0, subject: String::new(),
            });
        }
    }
    Ok(GitBranchList { current, local, remote, remotes: remotes(&root)? })
}

fn valid_new_branch(root: &Path, name: &str) -> Result<(), String> {
    let ok = git(root).read_only().args(["check-ref-format", "--branch"]).arg(name).run()?;
    if ok.ok() { Ok(()) } else { Err(format!("\"{name}\" is not a valid branch name")) }
}

/// Create `name` at `from` (or at HEAD) and optionally switch to it.
fn branch_create(path: &str, name: &str, from: Option<&str>, checkout: bool) -> Result<(), String> {
    let root = require_root(path)?;
    let name = safe_ref(name)?;
    valid_new_branch(&root, name)?;
    let mut cmd = if checkout { git(&root).args(["switch", "-c"]) } else { git(&root).arg("branch") };
    cmd = cmd.arg(name);
    if let Some(from) = from.map(str::trim).filter(|f| !f.is_empty()) {
        cmd = cmd.arg(safe_ref(from)?);
    }
    cmd.run_ok(if checkout { "git switch" } else { "git branch" })?;
    Ok(())
}

/// Check out a remote branch such as "origin/feature": switch to the local
/// branch of that name if there is one, otherwise create it tracking the remote.
fn checkout_remote(path: &str, branch: &str) -> Result<String, String> {
    let root = require_root(path)?;
    let branch = safe_ref(branch)?;
    let remote = remotes(&root)?
        .into_iter()
        .filter(|r| branch.starts_with(&format!("{r}/")))
        .max_by_key(String::len)
        .ok_or_else(|| format!("\"{branch}\" is not a remote branch"))?;
    let local = &branch[remote.len() + 1..];
    let exists = git(&root)
        .read_only()
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{local}"))
        .run()?
        .ok();
    if exists {
        git(&root).arg("switch").arg(local).run_ok("git switch")?;
    } else {
        git(&root).args(["switch", "-c"]).arg(local).arg("--track").arg(branch).run_ok("git switch")?;
    }
    Ok(local.to_string())
}

/// What to tell the user when a merge or rebase stopped on conflicts.
fn conflict_report(root: &Path, what: &str, abort: &str) -> Option<String> {
    let conflicted: Vec<String> = read_status(root, false)
        .map(|s| s.files.into_iter().filter(|f| f.conflicted).map(|f| f.path).collect())
        .unwrap_or_default();
    if conflicted.is_empty() {
        return None;
    }
    let shown: Vec<String> = conflicted.iter().take(12).map(|p| format!("  {p}")).collect();
    let more = conflicted.len().saturating_sub(shown.len());
    Some(format!(
        "{what} stopped: conflicts in {} file{}.\n{}{}\nResolve them in the Changes view, or run `{abort}` in the terminal to go back.",
        conflicted.len(),
        if conflicted.len() == 1 { "" } else { "s" },
        shown.join("\n"),
        if more > 0 { format!("\n  …and {more} more") } else { String::new() },
    ))
}

/// Merge `branch` into the current branch.
fn merge(path: &str, branch: &str) -> Result<String, String> {
    let root = require_root(path)?;
    let branch = safe_ref(branch)?;
    let out = git(&root).slow().args(["merge", "--no-edit"]).arg(branch).run()?;
    if out.ok() {
        return Ok(out.combined());
    }
    Err(conflict_report(&root, "Merge", "git merge --abort").unwrap_or_else(|| out.error("git merge")))
}

/// Rebase the current branch onto `onto`.
fn rebase(path: &str, onto: &str) -> Result<String, String> {
    let root = require_root(path)?;
    let onto = safe_ref(onto)?;
    let out = git(&root).slow().arg("rebase").arg(onto).run()?;
    if out.ok() {
        return Ok(out.combined());
    }
    Err(conflict_report(&root, "Rebase", "git rebase --abort").unwrap_or_else(|| out.error("git rebase")))
}

fn branch_rename(path: &str, from: &str, to: &str) -> Result<(), String> {
    let root = require_root(path)?;
    let from = safe_ref(from)?;
    let to = safe_ref(to)?;
    valid_new_branch(&root, to)?;
    git(&root).args(["branch", "-m"]).arg(from).arg(to).run_ok("git branch -m")?;
    Ok(())
}

/// Delete a local branch. Without `force`, git refuses branches whose commits
/// are not merged anywhere; that refusal comes back as an error mentioning
/// "not fully merged" so the UI can offer to delete anyway.
fn branch_delete(path: &str, branch: &str, force: bool) -> Result<(), String> {
    let root = require_root(path)?;
    let branch = safe_ref(branch)?;
    git(&root)
        .arg("branch")
        .arg(if force { "-D" } else { "-d" })
        .arg(branch)
        .run_ok("git branch -d")?;
    Ok(())
}

fn init(path: &str) -> Result<(), String> {
    let dir = existing_dir(path)?;
    if locate(&dir)?.is_some() {
        return Ok(());
    }
    let configured = git(&dir)
        .read_only()
        .args(["config", "--get", "init.defaultBranch"])
        .run()?;
    let mut cmd = git(&dir);
    if !configured.ok() || configured.line().is_empty() {
        // Git's built-in default is still "master"; follow the hosts instead.
        cmd = cmd.args(["-c", "init.defaultBranch=main"]);
    }
    cmd.args(["init", "-q"]).run_ok("git init")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    blocking(move || status_of(&path)).await
}

#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: bool) -> Result<String, String> {
    blocking(move || diff_of(&path, &file, staged)).await
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || stage(&path, &files)).await
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || unstage(&path, &files)).await
}

#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || discard(&path, &files)).await
}

#[tauri::command]
pub async fn git_commit(path: String, message: String, amend: bool) -> Result<String, String> {
    blocking(move || commit(&path, &message, amend)).await
}

#[tauri::command]
pub async fn git_fetch(path: String) -> Result<String, String> {
    blocking(move || fetch(&path)).await
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    blocking(move || pull(&path)).await
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<String, String> {
    blocking(move || push(&path)).await
}

#[tauri::command]
pub async fn git_log(path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    blocking(move || log(&path, limit)).await
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<GitBranches, String> {
    blocking(move || branches(&path)).await
}

#[tauri::command]
pub async fn git_checkout(path: String, branch: String, create: bool) -> Result<(), String> {
    blocking(move || checkout(&path, &branch, create)).await
}

/// Local and remote branches with upstream state, newest commit first.
#[tauri::command]
pub async fn git_branch_list(path: String) -> Result<GitBranchList, String> {
    blocking(move || branch_list(&path)).await
}

#[tauri::command]
pub async fn git_branch_create(path: String, name: String, from: Option<String>, checkout: bool) -> Result<(), String> {
    blocking(move || branch_create(&path, &name, from.as_deref(), checkout)).await
}

/// Returns the name of the local branch that is now checked out.
#[tauri::command]
pub async fn git_checkout_remote(path: String, branch: String) -> Result<String, String> {
    blocking(move || checkout_remote(&path, &branch)).await
}

#[tauri::command]
pub async fn git_merge(path: String, branch: String) -> Result<String, String> {
    blocking(move || merge(&path, &branch)).await
}

#[tauri::command]
pub async fn git_rebase(path: String, onto: String) -> Result<String, String> {
    blocking(move || rebase(&path, &onto)).await
}

#[tauri::command]
pub async fn git_branch_rename(path: String, from: String, to: String) -> Result<(), String> {
    blocking(move || branch_rename(&path, &from, &to)).await
}

#[tauri::command]
pub async fn git_branch_delete(path: String, branch: String, force: bool) -> Result<(), String> {
    blocking(move || branch_delete(&path, &branch, force)).await
}

/// `git init` in `path`. Does nothing when it is already inside a repository.
#[tauri::command]
pub async fn git_init(path: String) -> Result<(), String> {
    blocking(move || init(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Branch operations against a real repository with a real remote.
    #[test]
    fn branch_operations_on_a_real_repo() {
        let base = std::env::temp_dir().join(format!("mango-branch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let sh = |dir: &Path, args: &[&str]| {
            let out = Command::new("git").current_dir(dir).args(args).output().expect("git runs");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        let origin = base.join("origin.git");
        let work = base.join("work");
        std::fs::create_dir_all(&origin).unwrap();
        sh(&origin, &["init", "-q", "--bare", "-b", "main"]);
        sh(&base, &["clone", "-q", origin.to_str().unwrap(), "work"]);
        for (k, v) in [("user.email", "t@example.com"), ("user.name", "Test"), ("commit.gpgsign", "false")] {
            sh(&work, &["config", k, v]);
        }
        std::fs::write(work.join("a.txt"), "one\n").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["commit", "-q", "-m", "first"]);
        sh(&work, &["push", "-q", "-u", "origin", "HEAD:main"]);
        sh(&work, &["switch", "-q", "-c", "feature/x"]);
        std::fs::write(work.join("b.txt"), "two\n").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["commit", "-q", "-m", "feature work"]);
        sh(&work, &["push", "-q", "-u", "origin", "feature/x"]);
        sh(&work, &["switch", "-q", "main"]);
        sh(&work, &["branch", "-q", "-D", "feature/x"]);
        let path = work.to_str().unwrap();

        // Listing: one local branch, two remote ones, no origin/HEAD.
        let list = branch_list(path).unwrap();
        assert_eq!(list.current.as_deref(), Some("main"));
        assert_eq!(list.local.len(), 1);
        assert_eq!(list.local[0].upstream.as_deref(), Some("origin/main"));
        let remote: Vec<&str> = list.remote.iter().map(|b| b.name.as_str()).collect();
        assert!(remote.contains(&"origin/feature/x") && remote.contains(&"origin/main"), "{remote:?}");
        assert_eq!(list.remotes, ["origin"]);

        // Checking out a remote branch creates the tracking local branch.
        assert_eq!(checkout_remote(path, "origin/feature/x").unwrap(), "feature/x");
        let list = branch_list(path).unwrap();
        assert_eq!(list.current.as_deref(), Some("feature/x"));
        assert_eq!(list.local.iter().find(|b| b.is_current).unwrap().upstream.as_deref(), Some("origin/feature/x"));

        // New branch from a start point, without switching.
        branch_create(path, "spike", Some("main"), false).unwrap();
        assert!(branch_create(path, "bad name", None, false).is_err());
        assert_eq!(branch_list(path).unwrap().current.as_deref(), Some("feature/x"));

        // Merge and rebase report success.
        checkout(path, "main", false).unwrap();
        merge(path, "feature/x").unwrap();
        assert!(work.join("b.txt").exists());
        checkout(path, "spike", false).unwrap();
        rebase(path, "main").unwrap();
        assert!(work.join("b.txt").exists());

        // Rename, then delete: an unmerged branch is refused until forced.
        branch_rename(path, "spike", "spike-2").unwrap();
        std::fs::write(work.join("c.txt"), "three\n").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["commit", "-q", "-m", "unmerged work"]);
        checkout(path, "main", false).unwrap();
        let refused = branch_delete(path, "spike-2", false).unwrap_err();
        assert!(refused.contains("not fully merged"), "{refused}");
        branch_delete(path, "spike-2", true).unwrap();
        assert!(!branch_list(path).unwrap().local.iter().any(|b| b.name == "spike-2"));
        assert!(branch_delete(path, "-D", false).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parses_branch_refs() {
        let s = REF_SEP;
        let text = format!(
            "refs/heads/main{s}main{s}origin/main{s}ahead 2, behind 1{s}1700000000{s}Fix the thing\n\
             refs/heads/old{s}old{s}origin/old{s}gone{s}1600000000{s}Old work\n\
             refs/heads/solo{s}solo{s}{s}{s}1500000000{s}\n\
             refs/remotes/origin/HEAD{s}origin/HEAD{s}{s}{s}1700000000{s}x\n\
             refs/remotes/origin/feature/a b{s}origin/feature/a b{s}{s}{s}1650000000{s}Remote work\n"
        );
        let (local, remote) = parse_refs(&text, Some("main"));
        assert_eq!(local.len(), 3);
        assert!(local[0].is_current);
        assert_eq!((local[0].ahead, local[0].behind), (2, 1));
        assert_eq!(local[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(local[0].time, 1_700_000_000_000);
        assert!(local[1].upstream_gone);
        assert_eq!(local[2].upstream, None);
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0].name, "origin/feature/a b");
        assert_eq!(remote[0].remote, "origin");
    }

    #[test]
    fn rejects_unsafe_ref_names() {
        assert!(safe_ref("-D").is_err());
        assert!(safe_ref("  ").is_err());
        assert!(safe_ref("a b").is_err());
        assert!(safe_ref("a..b").is_err());
        assert_eq!(safe_ref(" feature/x ").unwrap(), "feature/x");
    }

    fn file(path: &str, index: Option<&str>, worktree: Option<&str>) -> GitFile {
        GitFile {
            path: path.into(),
            orig_path: None,
            index: index.map(str::to_string),
            worktree: worktree.map(str::to_string),
            conflicted: false,
        }
    }

    const H: &str = "1111111111111111111111111111111111111111";
    const Z: &str = "0000000000000000000000000000000000000000";

    #[test]
    fn status_branch_headers() {
        let out = format!("# branch.oid {H}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0");
        let s = parse_status(out.as_bytes());
        assert_eq!(s.oid.as_deref(), Some(H));
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert!(s.files.is_empty());
    }

    #[test]
    fn status_no_upstream() {
        let out = format!("# branch.oid {H}\0# branch.head feat/panel\0? notes.md\0");
        let s = parse_status(out.as_bytes());
        assert_eq!(s.branch.as_deref(), Some("feat/panel"));
        assert_eq!(s.upstream, None);
        assert_eq!((s.ahead, s.behind), (0, 0));
        assert_eq!(s.files, [file("notes.md", None, Some("?"))]);
    }

    #[test]
    fn status_gone_upstream_has_no_counts() {
        // The upstream is configured but its ref was deleted: no `branch.ab` line.
        let out = format!("# branch.oid {H}\0# branch.head old\0# branch.upstream origin/old\0");
        let s = parse_status(out.as_bytes());
        assert_eq!(s.upstream.as_deref(), Some("origin/old"));
        assert_eq!((s.ahead, s.behind), (0, 0));
    }

    #[test]
    fn status_detached_and_unborn() {
        let s = parse_status(format!("# branch.oid {H}\0# branch.head (detached)\0").as_bytes());
        assert_eq!(s.branch, None);
        assert_eq!(s.oid.as_deref(), Some(H));

        let s = parse_status(b"# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(s.oid, None);
        assert_eq!(s.branch.as_deref(), Some("main"));
    }

    #[test]
    fn status_ordinary_entries() {
        let out = format!(
            "1 .M N... 100644 100644 100644 {H} {H} app/stores/git.ts\0\
             1 M. N... 100644 100644 100644 {H} {H} README.md\0\
             1 MM N... 100644 100644 100644 {H} {H} src-tauri/src/lib.rs\0\
             1 A. N... 000000 100644 100644 {Z} {H} app/components/git/GitPanel.vue\0\
             1 .D N... 100644 100644 000000 {H} {H} old.txt\0\
             1 D. N... 100644 000000 000000 {H} {Z} gone.txt\0\
             1 .T N... 100644 100644 120000 {H} {H} link\0"
        );
        let s = parse_status(out.as_bytes());
        assert_eq!(
            s.files,
            [
                file("app/stores/git.ts", None, Some("M")),
                file("README.md", Some("M"), None),
                file("src-tauri/src/lib.rs", Some("M"), Some("M")),
                file("app/components/git/GitPanel.vue", Some("A"), None),
                file("old.txt", None, Some("D")),
                file("gone.txt", Some("D"), None),
                file("link", None, Some("M")),
            ]
        );
    }

    #[test]
    fn status_rename_takes_the_next_record_as_origin() {
        let out = format!(
            "2 R. N... 100644 100644 100644 {H} {H} R100 app/utils/time ago.ts\0app/utils/old time.ts\0\
             1 .M N... 100644 100644 100644 {H} {H} after.txt\0"
        );
        let s = parse_status(out.as_bytes());
        assert_eq!(s.files.len(), 2);
        assert_eq!(
            s.files[0],
            GitFile {
                path: "app/utils/time ago.ts".into(),
                orig_path: Some("app/utils/old time.ts".into()),
                index: Some("R".into()),
                worktree: None,
                conflicted: false,
            }
        );
        // The origin path was consumed, not mistaken for a record of its own.
        assert_eq!(s.files[1], file("after.txt", None, Some("M")));
    }

    #[test]
    fn status_rename_with_worktree_edit() {
        let out = format!("2 RM N... 100644 100644 100644 {H} {H} R087 b.rs\0a.rs\0");
        let s = parse_status(out.as_bytes());
        assert_eq!(s.files[0].index.as_deref(), Some("R"));
        assert_eq!(s.files[0].worktree.as_deref(), Some("M"));
        assert_eq!(s.files[0].orig_path.as_deref(), Some("a.rs"));
    }

    #[test]
    fn status_untracked_with_spaces_and_unicode() {
        let out = "? docs/release notes (draft).md\0? grüße/日本語 ファイル.txt\0! node_modules/\0";
        let s = parse_status(out.as_bytes());
        assert_eq!(
            s.files,
            [
                file("docs/release notes (draft).md", None, Some("?")),
                file("grüße/日本語 ファイル.txt", None, Some("?")),
            ]
        );
    }

    #[test]
    fn status_conflict() {
        let out = format!(
            "u UU N... 100644 100644 100644 100644 {H} {H} {H} app/pages/merge me.vue\0\
             u DU N... 100644 000000 100644 100644 {H} {Z} {H} deleted-by-us.txt\0"
        );
        let s = parse_status(out.as_bytes());
        assert_eq!(s.files.len(), 2);
        for (f, path) in s.files.iter().zip(["app/pages/merge me.vue", "deleted-by-us.txt"]) {
            assert_eq!(f.path, path);
            assert!(f.conflicted);
            assert_eq!(f.index, None);
            assert_eq!(f.worktree.as_deref(), Some("U"));
        }
    }

    #[test]
    fn status_ignores_garbage() {
        let s = parse_status(b"\0\x001 short\0x unknown\0? \0#\0# branch.ab\0");
        assert_eq!(s, ParsedStatus::default());
    }

    #[test]
    fn log_records() {
        let text = "aaaa\x1faa\x1fFix: a | b \u{1f96d}\x1fAda L.\x1f1700000000\x1e\nbbbb\x1fbb\x1f\x1fBob\x1f1700000060\x1e";
        let log = parse_log(text);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].hash, "aaaa");
        assert_eq!(log[0].short_hash, "aa");
        assert_eq!(log[0].subject, "Fix: a | b \u{1f96d}");
        assert_eq!(log[0].author, "Ada L.");
        assert_eq!(log[0].time, 1_700_000_000_000);
        assert_eq!(log[1].subject, "");
        assert!(parse_log("").is_empty());
    }

    #[test]
    fn rename_lookup() {
        let out = b"R100\0a.txt\0b.txt\0R090\0old name.rs\0new name.rs\0";
        assert_eq!(rename_source(out, "new name.rs").as_deref(), Some("old name.rs"));
        assert_eq!(rename_source(out, "b.txt").as_deref(), Some("a.txt"));
        assert_eq!(rename_source(out, "a.txt"), None);
        assert_eq!(rename_source(b"", "a.txt"), None);
    }

    #[test]
    fn truncated_diff_ends_on_a_line_with_the_marker() {
        let text = finish_diff(b"@@ -1 +1 @@\n-a\n+b\n+half a li".to_vec(), true);
        assert_eq!(text, format!("@@ -1 +1 @@\n-a\n+b\n{DIFF_TRUNCATED}\n"));
        assert_eq!(finish_diff(b"+b\n".to_vec(), false), "+b\n");
    }

    #[test]
    fn relative_paths_only() {
        assert!(clean_rel("app/pages/[id].vue").is_ok());
        assert!(clean_rel("a b/c.txt").is_ok());
        for bad in ["", "/etc/passwd", "../outside", "a/../../b", "\\\\server\\share"] {
            assert!(clean_rel(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn path_chunks() {
        let paths: Vec<String> = (0..450).map(|i| format!("f{i}")).collect();
        let parts = chunks(&paths);
        assert_eq!(parts.iter().map(|c| c.len()).collect::<Vec<_>>(), [200, 200, 50]);
        let long = vec!["x".repeat(5000), "y".repeat(5000), "z".into()];
        assert_eq!(chunks(&long).len(), 2);
        assert!(chunks(&[]).is_empty());
    }

    #[test]
    fn output_keeps_the_last_progress_state() {
        assert_eq!(
            tidy_output("Counting:  10%\rCounting: 100%, done.\n\nTo origin\n   a..b  main -> main\n"),
            "Counting: 100%, done.\nTo origin\n   a..b  main -> main"
        );
    }

    // -- against a real repository ------------------------------------------

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("mango-git-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            // The canonical path is what git reports back as the root.
            Scratch(dir.canonicalize().unwrap())
        }
        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn write(&self, rel: &str, text: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        fn read(&self, rel: &str) -> Option<String> {
            fs::read_to_string(self.0.join(rel)).ok()
        }
        fn git(&self, args: &[&str]) -> Output {
            let out = git(&self.0).args(args).run().unwrap();
            assert!(out.ok(), "git {args:?}: {}", out.combined());
            out
        }
        /// A repository with an identity that doesn't depend on the machine.
        fn repo() -> Self {
            let s = Scratch::new();
            init(s.path()).unwrap();
            s.git(&["config", "user.name", "Mango Test"]);
            s.git(&["config", "user.email", "test@mango.invalid"]);
            s.git(&["config", "commit.gpgsign", "false"]);
            s
        }
        fn entry(&self, rel: &str) -> Option<GitFile> {
            status_of(self.path()).unwrap().files.into_iter().find(|f| f.path == rel)
        }
        fn codes(&self, rel: &str) -> (Option<String>, Option<String>) {
            self.entry(rel).map(|f| (f.index, f.worktree)).unwrap_or((None, None))
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn pair(index: Option<&str>, worktree: Option<&str>) -> (Option<String>, Option<String>) {
        (index.map(str::to_string), worktree.map(str::to_string))
    }

    fn have_git() -> bool {
        git(&std::env::temp_dir()).arg("--version").run().map(|o| o.ok()).unwrap_or(false)
    }

    #[test]
    fn not_a_repository_is_not_an_error() {
        if !have_git() {
            return;
        }
        let s = Scratch::new();
        // Keep discovery from finding a repository above the temp folder.
        fs::create_dir_all(s.0.join("plain")).unwrap();
        let status = status_of(s.0.join("plain").to_str().unwrap()).unwrap();
        if status.is_repo {
            return; // the temp folder itself lives inside a repository
        }
        assert_eq!(status.root, None);
        assert!(status.files.is_empty());
        assert!(status_of(s.0.join("missing").to_str().unwrap()).is_err());
        assert!(stage(s.path(), &[]).unwrap_err().contains("not inside a git repository"));
    }

    #[test]
    fn unborn_branch_stage_unstage_commit() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        let status = status_of(s.path()).unwrap();
        assert!(status.is_repo);
        assert_eq!(status.root.as_deref(), Some(s.path()));
        assert_eq!(status.head, None);
        assert!(status.branch.is_some());
        assert!(log(s.path(), 20).unwrap().is_empty());
        let b = branches(s.path()).unwrap();
        assert_eq!(b.current, status.branch);
        assert_eq!(b.local, [status.branch.clone().unwrap()]);

        s.write("a.txt", "one\n");
        s.write("docs/read me.md", "hello\n");
        assert_eq!(s.codes("docs/read me.md"), pair(None, Some("?")));

        stage(s.path(), &[]).unwrap();
        assert_eq!(s.codes("a.txt"), pair(Some("A"), None));
        // No HEAD yet: unstaging has to go through `git rm --cached`.
        unstage(s.path(), &["a.txt".into()]).unwrap();
        assert_eq!(s.codes("a.txt"), pair(None, Some("?")));
        assert_eq!(s.codes("docs/read me.md"), pair(Some("A"), None));
        unstage(s.path(), &[]).unwrap();
        assert_eq!(s.codes("docs/read me.md"), pair(None, Some("?")));
        assert_eq!(s.read("a.txt").as_deref(), Some("one\n"));

        let err = commit(s.path(), "nothing yet", false).unwrap_err();
        assert!(err.contains("Nothing is staged"), "{err}");
        assert!(commit(s.path(), "   ", false).is_err());

        stage(s.path(), &[]).unwrap();
        let hash = commit(s.path(), "First commit\n\n# kept: not a comment", false).unwrap();
        let status = status_of(s.path()).unwrap();
        assert_eq!(status.head.as_deref(), Some(hash.as_str()));
        assert!(status.files.is_empty());
        let history = log(s.path(), 20).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].subject, "First commit");
        assert_eq!(history[0].short_hash, hash);
        assert_eq!(history[0].author, "Mango Test");
        assert!(history[0].time > 1_600_000_000_000);
    }

    #[test]
    fn diffs_for_every_kind_of_change() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        let body: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        s.write("src/keep.rs", &body);
        s.write("app/pages/[id].vue", "<template>one</template>\n");
        s.write("i.vue", "decoy\n");
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "base", false).unwrap();

        // Unstaged edit.
        s.write("app/pages/[id].vue", "<template>two</template>\n");
        let d = diff_of(s.path(), "app/pages/[id].vue", false).unwrap();
        assert!(d.contains("-<template>one</template>") && d.contains("+<template>two</template>"), "{d}");
        assert_eq!(diff_of(s.path(), "app/pages/[id].vue", true).unwrap(), "");
        // Brackets are literal: the decoy `i.vue` matches the glob but is not touched.
        stage(s.path(), &["app/pages/[id].vue".into()]).unwrap();
        s.write("i.vue", "decoy changed\n");
        assert_eq!(s.codes("i.vue"), pair(None, Some("M")));
        assert_eq!(s.codes("app/pages/[id].vue"), pair(Some("M"), None));
        assert!(diff_of(s.path(), "app/pages/[id].vue", true).unwrap().contains("+<template>two</template>"));
        assert_eq!(diff_of(s.path(), "app/pages/[id].vue", false).unwrap(), "");

        // Untracked: all added, from the repository root or a subfolder.
        s.write("notes/to do.md", "- first\n- second\n");
        let d = diff_of(s.path(), "notes/to do.md", false).unwrap();
        assert!(d.contains("new file mode") && d.contains("+- first") && d.contains("+- second"), "{d}");
        let sub = s.0.join("src");
        assert_eq!(diff_of(sub.to_str().unwrap(), "notes/to do.md", false).unwrap(), d);

        // Staged rename with an edit shows only the edit.
        s.git(&["mv", "src/keep.rs", "src/moved.rs"]);
        s.write("src/moved.rs", &body.replace("line 7\n", "line seven\n"));
        stage(s.path(), &["src/moved.rs".into()]).unwrap();
        let entry = s.entry("src/moved.rs").unwrap();
        assert_eq!(entry.index.as_deref(), Some("R"));
        assert_eq!(entry.orig_path.as_deref(), Some("src/keep.rs"));
        let d = diff_of(s.path(), "src/moved.rs", true).unwrap();
        assert!(d.contains("rename from src/keep.rs") && d.contains("+line seven"), "{d}");
        assert!(!d.contains("+line 1\n"), "{d}");

        // Binary files are a one-line notice.
        fs::write(s.0.join("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2, 3]).unwrap();
        let d = diff_of(s.path(), "blob.bin", false).unwrap();
        assert!(d.lines().any(|l| l.starts_with("Binary files ") && l.ends_with(" differ")), "{d}");

        // Oversized diffs are cut at a line boundary with the marker.
        let big: String = (0..60_000).map(|i| format!("row number {i:07}\n")).collect();
        s.write("big.txt", &big);
        let d = diff_of(s.path(), "big.txt", false).unwrap();
        assert!(d.len() <= DIFF_CAP + DIFF_TRUNCATED.len() + 1, "{}", d.len());
        assert!(d.ends_with(&format!("\n{DIFF_TRUNCATED}\n")));
        assert!(d.len() > DIFF_CAP / 2);

        assert!(diff_of(s.path(), "../escape", false).is_err());
    }

    #[test]
    fn discard_only_destroys_what_was_asked() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        s.write("tracked.txt", "v1\n");
        s.write("both.txt", "v1\n");
        s.write("removed.txt", "v1\n");
        s.write("staged-edit.txt", "v1\n");
        s.write("pages/[id].vue", "v1\n");
        s.write("pages/i.vue", "v1\n");
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "base", false).unwrap();

        // Unstaged edit goes back to HEAD.
        s.write("tracked.txt", "v2\n");
        discard(s.path(), &["tracked.txt".into()]).unwrap();
        assert_eq!(s.read("tracked.txt").as_deref(), Some("v1\n"));

        // Staged + unstaged: only the unstaged part goes; the staged version survives.
        s.write("both.txt", "staged\n");
        stage(s.path(), &["both.txt".into()]).unwrap();
        s.write("both.txt", "unstaged\n");
        assert_eq!(s.codes("both.txt"), pair(Some("M"), Some("M")));
        discard(s.path(), &["both.txt".into()]).unwrap();
        assert_eq!(s.read("both.txt").as_deref(), Some("staged\n"));
        assert_eq!(s.codes("both.txt"), pair(Some("M"), None));

        // A deleted file comes back.
        fs::remove_file(s.0.join("removed.txt")).unwrap();
        assert_eq!(s.codes("removed.txt"), pair(None, Some("D")));
        discard(s.path(), &["removed.txt".into()]).unwrap();
        assert_eq!(s.read("removed.txt").as_deref(), Some("v1\n"));

        // Untracked file is deleted along with the folders made for it; its neighbour stays.
        s.write("new dir/deep/scratch file.txt", "x\n");
        s.write("new dir/keep.txt", "x\n");
        discard(s.path(), &["new dir/deep/scratch file.txt".into()]).unwrap();
        assert!(!s.0.join("new dir/deep").exists());
        assert_eq!(s.read("new dir/keep.txt").as_deref(), Some("x\n"));

        // Brackets are not a glob: `pages/i.vue` keeps its edit.
        s.write("pages/[id].vue", "v2\n");
        s.write("pages/i.vue", "v2\n");
        discard(s.path(), &["pages/[id].vue".into()]).unwrap();
        assert_eq!(s.read("pages/[id].vue").as_deref(), Some("v1\n"));
        assert_eq!(s.read("pages/i.vue").as_deref(), Some("v2\n"));

        // Staged-only new file: unstaged and deleted. Staged-only edit: back to HEAD.
        s.write("fresh.txt", "new\n");
        s.write("staged-edit.txt", "v2\n");
        stage(s.path(), &["fresh.txt".into(), "staged-edit.txt".into()]).unwrap();
        discard(s.path(), &["fresh.txt".into(), "staged-edit.txt".into()]).unwrap();
        assert!(!s.0.join("fresh.txt").exists());
        assert_eq!(s.entry("fresh.txt"), None);
        assert_eq!(s.read("staged-edit.txt").as_deref(), Some("v1\n"));
        assert_eq!(s.entry("staged-edit.txt"), None);

        // `add -N` placeholder: removed like an untracked file, not emptied.
        s.write("intent.txt", "content\n");
        s.git(&["add", "-N", "intent.txt"]);
        discard(s.path(), &["intent.txt".into()]).unwrap();
        assert!(!s.0.join("intent.txt").exists());
        assert_eq!(s.entry("intent.txt"), None);

        // Paths that are clean, unknown or outside are left alone.
        discard(s.path(), &["tracked.txt".into(), "no/such/file".into()]).unwrap();
        assert!(discard(s.path(), &["../outside.txt".into()]).is_err());
        assert_eq!(s.read("tracked.txt").as_deref(), Some("v1\n"));

        // Discard everything: working-tree changes go, staged work is kept.
        s.write("tracked.txt", "again\n");
        s.write("loose.txt", "x\n");
        s.write("kept-staged.txt", "staged new\n");
        stage(s.path(), &["kept-staged.txt".into()]).unwrap();
        discard(s.path(), &[]).unwrap();
        let status = status_of(s.path()).unwrap();
        let left: Vec<&str> = status.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(left, ["both.txt", "kept-staged.txt"]);
        assert!(status.files.iter().all(|f| f.worktree.is_none()));
        assert_eq!(s.read("kept-staged.txt").as_deref(), Some("staged new\n"));
        assert_eq!(s.read("tracked.txt").as_deref(), Some("v1\n"));
        assert!(!s.0.join("loose.txt").exists());
        assert!(!s.0.join("new dir").exists());
    }

    #[test]
    fn unstaging_a_rename_releases_both_paths() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        let body: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        s.write("old name.txt", &body);
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "base", false).unwrap();

        s.git(&["mv", "old name.txt", "new name.txt"]);
        assert_eq!(s.entry("new name.txt").unwrap().orig_path.as_deref(), Some("old name.txt"));
        unstage(s.path(), &["new name.txt".into()]).unwrap();
        assert_eq!(s.codes("old name.txt"), pair(None, Some("D")));
        assert_eq!(s.codes("new name.txt"), pair(None, Some("?")));

        // And discarding a staged rename puts the original back.
        stage(s.path(), &[]).unwrap();
        discard(s.path(), &["new name.txt".into()]).unwrap();
        assert!(status_of(s.path()).unwrap().files.is_empty());
        assert_eq!(s.read("old name.txt"), Some(body));
        assert!(!s.0.join("new name.txt").exists());
    }

    #[test]
    fn branches_amend_and_conflicts() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        s.write("a.txt", "base\n");
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "base", false).unwrap();
        let main = status_of(s.path()).unwrap().branch.unwrap();

        checkout(s.path(), "feat/side panel", true).unwrap_err();
        assert!(checkout(s.path(), "-x", true).is_err());
        checkout(s.path(), "feat/panel", true).unwrap();
        let b = branches(s.path()).unwrap();
        assert_eq!(b.current.as_deref(), Some("feat/panel"));
        assert!(b.local.contains(&main) && b.local.contains(&"feat/panel".to_string()));

        s.write("a.txt", "theirs\n");
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "side", false).unwrap();
        let amended = commit(s.path(), "side, reworded", true).unwrap();
        let history = log(s.path(), 1).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].subject, "side, reworded");
        assert_eq!(history[0].short_hash, amended);

        checkout(s.path(), &main, false).unwrap();
        assert_eq!(s.read("a.txt").as_deref(), Some("base\n"));
        s.write("a.txt", "ours\n");
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "main side", false).unwrap();
        assert_eq!(log(s.path(), 20).unwrap().len(), 2);

        // A real conflict: reported as such, and neither discard nor unstage touches it.
        let merge = git(&s.0).args(["merge", "feat/panel"]).run().unwrap();
        assert!(!merge.ok());
        let entry = s.entry("a.txt").unwrap();
        assert!(entry.conflicted);
        assert!(discard(s.path(), &["a.txt".into()]).unwrap_err().contains("merge conflicts"));
        discard(s.path(), &[]).unwrap();
        unstage(s.path(), &[]).unwrap();
        assert!(s.entry("a.txt").unwrap().conflicted);
        assert!(s.read("a.txt").unwrap().contains("<<<<<<<"));
        let err = commit(s.path(), "merge", false).unwrap_err();
        assert!(err.contains("merge conflicts"), "{err}");
        assert!(diff_of(s.path(), "a.txt", false).unwrap().contains("@@@"));

        // Staging the resolved file ends the conflict and the merge can be committed.
        s.write("a.txt", "resolved\n");
        stage(s.path(), &["a.txt".into()]).unwrap();
        commit(s.path(), "Merge feat/panel", false).unwrap();
        assert!(status_of(s.path()).unwrap().files.is_empty());

        // Detached HEAD has no branch.
        let first = log(s.path(), 20).unwrap().last().unwrap().hash.clone();
        s.git(&["checkout", "-q", "--detach", &first]);
        let status = status_of(s.path()).unwrap();
        assert_eq!(status.branch, None);
        assert!(first.starts_with(status.head.as_deref().unwrap()));
        assert_eq!(branches(s.path()).unwrap().current, None);
        assert!(push(s.path()).unwrap_err().contains("detached"));
    }

    #[test]
    fn sync_with_a_local_remote() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        s.write("a.txt", "one\n");
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "one", false).unwrap();
        let branch = status_of(s.path()).unwrap().branch.unwrap();

        // No remote at all: a readable error, not a silent success.
        assert!(fetch(s.path()).unwrap_err().contains("no remote"));
        assert!(push(s.path()).unwrap_err().contains("no remote"));

        // A bare repository next door stands in for the server.
        let remote = Scratch::new();
        git(&remote.0).args(["init", "-q", "--bare"]).run_ok("init").unwrap();
        s.git(&["remote", "add", "origin", remote.path()]);
        assert!(pull(s.path()).unwrap_err().contains("Publish it first"));

        // First push publishes and starts tracking.
        push(s.path()).unwrap();
        let status = status_of(s.path()).unwrap();
        assert_eq!(status.upstream.as_deref(), Some(format!("origin/{branch}").as_str()));
        assert_eq!((status.ahead, status.behind), (0, 0));

        s.write("a.txt", "two\n");
        stage(s.path(), &[]).unwrap();
        commit(s.path(), "two", false).unwrap();
        assert_eq!(status_of(s.path()).unwrap().ahead, 1);
        push(s.path()).unwrap();
        assert_eq!(status_of(s.path()).unwrap().ahead, 0);

        // A second clone pushes; the first sees it after fetch and gets it with pull.
        let other = Scratch::new();
        // The bare repository's own HEAD may name a different default branch.
        git(&other.0)
            .args(["clone", "-q", "-b", branch.as_str(), remote.path(), "."])
            .run_ok("clone")
            .unwrap();
        other.git(&["config", "user.name", "Other"]);
        other.git(&["config", "user.email", "other@mango.invalid"]);
        other.git(&["config", "commit.gpgsign", "false"]);
        other.write("b.txt", "from other\n");
        stage(other.path(), &[]).unwrap();
        commit(other.path(), "other", false).unwrap();
        push(other.path()).unwrap();

        fetch(s.path()).unwrap();
        assert_eq!(status_of(s.path()).unwrap().behind, 1);
        pull(s.path()).unwrap();
        assert_eq!(s.read("b.txt").as_deref(), Some("from other\n"));
        assert_eq!(status_of(s.path()).unwrap().behind, 0);
    }
}
