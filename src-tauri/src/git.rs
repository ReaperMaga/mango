//! Source control for the Changes panel: status, diffs, staging, commits,
//! branches and sync. Everything shells out to the user's own `git`, so
//! hooks, credentials and config behave exactly as they do in a terminal.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::envs::ssh::{self, Mode};
use crate::envs::{self, EnvHost};

/// Local commands finish in milliseconds; this only catches a stuck process.
pub(crate) const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
/// Fetch, pull, push, and commit (hooks may run a test suite).
pub(crate) const SLOW_TIMEOUT: Duration = Duration::from_secs(600);
/// A diff larger than this is cut off with a marker line.
pub(crate) const DIFF_CAP: usize = 400 * 1024;
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

/// Which version control a folder is under.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Vcs {
    #[default]
    Git,
    /// Unity Version Control (formerly Plastic SCM), driven through `cm`.
    Plastic,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub vcs: Vcs,
    /// Unity VCS only: the repository the workspace is bound to, e.g. "game@org@cloud".
    pub repository: Option<String>,
    pub is_repo: bool,
    pub root: Option<String>,
    /// Set when the folder is a linked worktree: the root of the repository's main
    /// working tree, in the same form as `root`.
    pub main_root: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

/// One working tree of a repository, from `git worktree list`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    /// Its folder: as git prints it on this computer, an `env://` path for a remote project.
    pub path: String,
    /// Checked-out branch; None when detached.
    pub branch: Option<String>,
    /// Short hash of its HEAD; None when unborn.
    pub head: Option<String>,
    pub is_main: bool,
    pub is_current: bool,
    pub locked: bool,
    /// Its folder is gone; `git worktree prune` would drop it.
    pub prunable: bool,
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

pub(crate) fn lossy(bytes: &[u8]) -> String {
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
pub(crate) fn clean_rel(file: &str) -> Result<&str, String> {
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
pub(crate) fn chunks(paths: &[String]) -> Vec<&[String]> {
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
pub(crate) fn tidy_output(text: &str) -> String {
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
pub(crate) fn safe_ref(name: &str) -> Result<&str, String> {
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

pub(crate) struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// stdout hit its cap and the rest was dropped.
    pub truncated: bool,
}

impl Output {
    pub(crate) fn ok(&self) -> bool {
        self.code == Some(0)
    }
    pub(crate) fn text(&self) -> String {
        lossy(&self.stdout)
    }
    pub(crate) fn line(&self) -> String {
        self.text().trim_end_matches(['\n', '\r']).to_string()
    }
    /// stderr then stdout, cleaned up for display.
    pub(crate) fn combined(&self) -> String {
        tidy_output(&format!("{}\n{}", lossy(&self.stderr), lossy(&self.stdout)))
    }
    /// A human-readable reason for a failed command.
    pub(crate) fn error(&self, what: &str) -> String {
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
pub(crate) fn read_capped(mut source: impl Read, cap: usize, drain: bool) -> (Vec<u8>, bool) {
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

/// Run `cmd` to completion with no terminal: stdin from `stdin` (or
/// nothing), stdout kept up to `cap` bytes, and the process stopped after
/// `timeout`. `program` names it in messages; `missing` is the error when it
/// cannot be found. Shared by the git and Unity VCS backends.
pub(crate) fn run_process(
    mut cmd: Command,
    mut stdin: Option<Vec<u8>>,
    cap: usize,
    timeout: Duration,
    program: &str,
    missing: &str,
) -> Result<Output, String> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => missing.to_string(),
        _ => format!("Could not run {program}: {e}"),
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = std::thread::spawn(move || match stdout {
        Some(s) => read_capped(s, cap, false),
        None => (Vec::new(), false),
    });
    let err = std::thread::spawn(move || match stderr {
        Some(s) => read_capped(s, STDERR_CAP, true).0,
        None => Vec::new(),
    });
    if let (Some(mut pipe), Some(bytes)) = (child.stdin.take(), stdin.take()) {
        // A command that exits early closes the pipe; its error says why.
        let _ = pipe.write_all(&bytes);
    }

    let deadline = Instant::now() + timeout;
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
                    "{program} did not finish within {} seconds and was stopped",
                    timeout.as_secs()
                ));
            }
            Err(e) => return Err(format!("Could not wait for {program}: {e}")),
        }
    };
    let (stdout, truncated) = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    Ok(Output { code: status.code(), stdout, stderr, truncated })
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

// ---------------------------------------------------------------------------
// Where the repository is
// ---------------------------------------------------------------------------

/// A folder git runs in: on this computer, or inside a remote environment, where
/// the instance's own `git` runs as its agent user over SSH (see `envs/`).
#[derive(Debug, Clone)]
pub(crate) enum At {
    Local(PathBuf),
    Env(Box<EnvAt>),
}

#[derive(Debug, Clone)]
pub(crate) struct EnvAt {
    pub host: EnvHost,
    pub instance: String,
    /// Absolute folder inside the instance (checked by `envs::valid_instance_dir`).
    pub dir: String,
}

impl At {
    pub(crate) fn local(path: impl Into<PathBuf>) -> At {
        At::Local(path.into())
    }

    /// The same place, another folder (a work tree's root, as git printed it).
    fn moved(&self, dir: String) -> At {
        match self {
            At::Local(_) => At::Local(PathBuf::from(dir)),
            At::Env(e) => At::Env(Box::new(EnvAt { dir, ..(**e).clone() })),
        }
    }

    /// The folder, for messages.
    fn shown(&self) -> String {
        match self {
            At::Local(p) => p.display().to_string(),
            At::Env(e) => format!("{} in {}", e.dir, e.instance),
        }
    }

    /// Refuse a folder that isn't there. Inside an environment the command itself
    /// checks (it starts with `cd`), which saves a connection.
    fn check(&self) -> Result<(), String> {
        match self {
            At::Local(p) => existing_dir(&p.to_string_lossy()).map(|_| ()),
            At::Env(_) => Ok(()),
        }
    }

    /// Key for the work tree root cache (remote folders only).
    fn env_key(&self) -> Option<String> {
        match self {
            At::Local(_) => None,
            At::Env(e) => Some(format!("{}\u{0}{}\u{0}{}", e.host.id, e.instance, e.dir)),
        }
    }
}

impl EnvAt {
    /// The command line for the master (or a joined environment) running `argv` here.
    fn remote(&self, login: bool, env: &[(String, String)], argv: &[String]) -> Result<Vec<String>, String> {
        let inner = if login {
            ssh::as_agent(Some(&self.dir), env, argv)
        } else {
            ssh::as_agent_plain(Some(&self.dir), env, argv)
        };
        ssh::in_instance(&self.host, &self.instance, Mode::Batch, &inner)
    }

    /// Run `argv` as the agent user in this folder, in a login shell (git hooks and
    /// credential helpers may need what the profile sets up). A connection or environment
    /// problem is an error; anything else is the command's own result, as for a local process.
    pub(crate) fn run(
        &self,
        env: &[(String, String)],
        argv: &[String],
        stdin: Option<Vec<u8>>,
        cap: usize,
        timeout: Duration,
    ) -> Result<Output, String> {
        self.exec(true, env, argv, stdin, cap, timeout)
    }

    /// [`EnvAt::run`] without the login shell (`ssh::as_agent_plain`): for reads and fixed
    /// scripts that run often. When it finds a tool missing ([`profile_needed`]), it runs
    /// again in the login shell, and so does everything after it in this environment.
    pub(crate) fn run_plain(
        &self,
        env: &[(String, String)],
        argv: &[String],
        stdin: Option<Vec<u8>>,
        cap: usize,
        timeout: Duration,
    ) -> Result<Output, String> {
        if self.needs_profile() {
            return self.exec(true, env, argv, stdin, cap, timeout);
        }
        let out = self.exec_raw(false, env, argv, stdin.clone(), cap, timeout)?;
        if !profile_needed(&out) {
            return Ok(out);
        }
        self.remember_needs_profile();
        self.exec(true, env, argv, stdin, cap, timeout)
    }

    /// This environment's tools are found only through the login shell's PATH.
    fn needs_profile(&self) -> bool {
        login_only().lock().is_ok_and(|s| s.contains(&self.place()))
    }

    fn remember_needs_profile(&self) {
        if let Ok(mut s) = login_only().lock() {
            s.insert(self.place());
        }
    }

    fn place(&self) -> String {
        format!("{}\u{0}{}", self.host.id, self.instance)
    }

    fn exec(
        &self,
        login: bool,
        env: &[(String, String)],
        argv: &[String],
        stdin: Option<Vec<u8>>,
        cap: usize,
        timeout: Duration,
    ) -> Result<Output, String> {
        let out = self.exec_raw(login, env, argv, stdin, cap, timeout)?;
        match self.git_missing(&out) {
            Some(missing) => Err(missing),
            None => Ok(out),
        }
    }

    /// [`EnvAt::exec`] that leaves a missing git to the caller.
    fn exec_raw(
        &self,
        login: bool,
        env: &[(String, String)],
        argv: &[String],
        stdin: Option<Vec<u8>>,
        cap: usize,
        timeout: Duration,
    ) -> Result<Output, String> {
        let cmd = ssh::command(&ssh::batch_argv(&self.host, &self.remote(login, env, argv)?, timeout)?);
        let out = run_process(cmd, stdin, cap, timeout, "ssh", "ssh was not found. Install the OpenSSH client.")?;
        if out.ok() {
            return Ok(out);
        }
        let stderr = lossy(&out.stderr);
        // ssh exits 255 on connection trouble (a capped read can also end it that way);
        // incus says `Error: …` (instance stopped or gone), and sudo explains itself.
        let infra = (out.code == Some(255) && !out.truncated)
            || stderr.lines().any(|l| l.starts_with("Error: ") || l.starts_with("sudo: "));
        if infra {
            return Err(ssh::explain(&self.host, out.code, &stderr, ""));
        }
        // `as_agent` could not enter the folder.
        if let Some(line) = stderr.lines().find(|l| l.starts_with("Mango: the folder ")) {
            return Err(format!("The folder {}", &line["Mango: the folder ".len()..]));
        }
        Ok(out)
    }

    /// The message for a command that failed because git isn't installed here.
    fn git_missing(&self, out: &Output) -> Option<String> {
        let stderr = lossy(&out.stderr);
        (out.code == Some(127) && (stderr.contains("git: command not found") || stderr.contains("git: not found") || stderr.contains("'git': No such file"))).then(|| {
            format!(
                "git is not installed in {}. Install it there (for example `sudo apt install git` in its terminal), then try again.",
                self.instance
            )
        })
    }

    /// Run a fixed `sh` script in this folder; `args` are its `$1`, `$2`, ….
    fn sh(&self, script: &str, args: &[&str]) -> Result<Output, String> {
        let mut argv: Vec<String> = ["sh", "-c", script, "sh"].map(String::from).to_vec();
        argv.extend(args.iter().map(|a| a.to_string()));
        self.run_plain(&[], &argv, None, usize::MAX, LOCAL_TIMEOUT)
    }
}

/// A command that failed because something it runs isn't on the plain PATH: the shell's
/// `command not found` (bash) or `not found` (dash), `env` not finding git, or git not
/// finding a filter or helper.
fn profile_needed(out: &Output) -> bool {
    let stderr = lossy(&out.stderr);
    !out.ok()
        && (out.code == Some(127)
            || stderr.contains(": command not found")
            || stderr.contains(": not found")
            || stderr.contains("'git': No such file")
            // git's own words for a filter, textconv driver or helper it can't start.
            || stderr.lines().any(|l| l.contains("cannot run ") && l.ends_with("No such file or directory")))
}

/// Environments (host, instance) whose tools only the login shell finds ([`EnvAt::run_plain`]).
fn login_only() -> &'static Mutex<std::collections::HashSet<String>> {
    static SET: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

/// Work tree roots of remote folders, so an action costs one SSH connection instead of
/// two. Every status read refreshes it; a stale entry only makes git fail with its own message.
fn env_roots() -> &'static Mutex<HashMap<String, String>> {
    static ROOTS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ROOTS.get_or_init(Default::default)
}

fn remember_root(at: &At, root: Option<&str>) {
    let (Some(key), Ok(mut roots)) = (at.env_key(), env_roots().lock()) else { return };
    match root {
        Some(r) => roots.insert(key, r.to_string()),
        None => roots.remove(&key),
    };
}

/// One git invocation: a local process, or an SSH command line for a remote folder.
struct Git<'a> {
    at: &'a At,
    args: Vec<String>,
    env: Vec<(&'static str, &'static str)>,
    stdin: Option<Vec<u8>>,
    cap: usize,
    timeout: Duration,
    /// In an environment, start git from a login shell (see `EnvAt::run`). Off for reads.
    login: bool,
}

/// A git invocation in `at` that can never wait for a terminal.
fn git(at: &At) -> Git<'_> {
    Git {
        at,
        args: ["--no-pager", "-c", "core.quotepath=off", "-c", "color.ui=never"].map(String::from).to_vec(),
        env: vec![
            // Never hang on a credential prompt nobody can see.
            ("GIT_TERMINAL_PROMPT", "0"),
            // File names are data, not glob patterns (`pages/[id].vue`).
            ("GIT_LITERAL_PATHSPECS", "1"),
        ],
        stdin: None,
        cap: usize::MAX,
        timeout: LOCAL_TIMEOUT,
        login: true,
    }
}

impl Git<'_> {
    fn arg(mut self, arg: impl AsRef<str>) -> Self {
        self.args.push(arg.as_ref().to_string());
        self
    }
    fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.args.extend(args.into_iter().map(|a| a.as_ref().to_string()));
        self
    }
    /// For commands that only look: don't take the index lock, so polling
    /// never collides with the user's (or an agent's) own git. In an environment they
    /// also skip the login shell, as they run on every refresh (`EnvAt::run_plain`).
    fn read_only(mut self) -> Self {
        self.env.push(("GIT_OPTIONAL_LOCKS", "0"));
        self.login = false;
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
    fn env_remove(mut self, key: &str) -> Self {
        self.env.retain(|(k, _)| *k != key);
        self
    }

    fn run(self) -> Result<Output, String> {
        match self.at {
            At::Local(dir) => {
                let (bin, path) = tools();
                let mut cmd = Command::new(bin);
                crate::bin::hide_console(&mut cmd);
                cmd.current_dir(dir).envs(self.env.iter().copied()).args(&self.args);
                if let Some(path) = path {
                    cmd.env("PATH", path);
                }
                run_process(cmd, self.stdin, self.cap, self.timeout, "git", "git is not installed or not on PATH")
            }
            At::Env(e) => {
                let env: Vec<(String, String)> = self.env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                let mut argv = vec!["git".to_string()];
                argv.extend(self.args);
                if self.login {
                    e.run(&env, &argv, self.stdin, self.cap, self.timeout)
                } else {
                    e.run_plain(&env, &argv, self.stdin, self.cap, self.timeout)
                }
            }
        }
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

/// Run `cmds` (all in the same place, none with stdin) and return each one's output, in
/// order; a failing command doesn't stop the ones after it. In an environment they go
/// together, one after another, in a single SSH call ([`BATCH`]) instead of one each.
fn run_all(cmds: Vec<Git<'_>>) -> Result<Vec<Output>, String> {
    let Some(At::Env(e)) = cmds.first().map(|c| c.at) else {
        return cmds.into_iter().map(Git::run).collect();
    };
    let login = cmds.iter().any(|c| c.login);
    let timeout = cmds.iter().map(|c| c.timeout).max().unwrap_or(LOCAL_TIMEOUT);
    let mut argv: Vec<String> = ["bash", "-c", BATCH, "mango"].map(String::from).to_vec();
    let mut caps = Vec::new();
    for c in &cmds {
        debug_assert!(c.stdin.is_none() && matches!(c.at, At::Env(o) if o.dir == e.dir));
        let mut one: Vec<String> = vec!["env".into()];
        one.extend(c.env.iter().map(|(k, v)| format!("{k}={v}")));
        one.push("git".into());
        one.extend(c.args.iter().cloned());
        let cap = c.cap.min(1 << 40);
        argv.extend([one.len().to_string(), cap.to_string()]);
        argv.extend(one);
        caps.push(cap);
    }
    let batch = |login: bool| -> Result<Vec<Output>, String> {
        let out = e.exec(login, &[], &argv, None, usize::MAX, timeout)?;
        parse_batch(&out.stdout, &caps).ok_or_else(|| {
            let detail = tidy_output(&lossy(&out.stderr));
            format!("Could not read git's answer from {}.{}", e.instance, if detail.is_empty() { String::new() } else { format!("\n{detail}") })
        })
    };
    let mut outs = batch(login || e.needs_profile())?;
    // git (or a tool it runs, like git-lfs) only on the login shell's PATH.
    if !login && !e.needs_profile() && outs.iter().any(profile_needed) {
        e.remember_needs_profile();
        outs = batch(true)?;
    }
    if let Some(missing) = outs.iter().find_map(|o| e.git_missing(o)) {
        return Err(missing);
    }
    Ok(outs)
}

/// `bash` script (in an environment's work tree) behind [`run_all`]. Its arguments are, per
/// command, the number of words, the most stdout to send back, then the words. Each command
/// prints a header (`MANGO-RUN <exit code> <stdout bytes> <stderr bytes>`), its stdout up
/// to the cap, then its stderr. Stdout is cut at the source (as a local capped read does),
/// so a huge diff never lands in full on the instance's disk; the size in the header is
/// then one past the cap. It all goes out in one write at the end: sshd sends small
/// writes of a session without a terminal one round trip apart (Nagle), so piece by piece
/// costs a round trip each.
const BATCH: &str = r#"d=$(mktemp -d) || exit 1
trap 'rm -rf -- "$d"' EXIT
while [ "$#" -gt 0 ]; do
  n=$1 cap=$2
  shift 2
  # One byte past the cap tells a cut-off answer apart; git stops once head has it.
  "${@:1:$n}" 2>"$d/e" </dev/null | head -c "$((cap + 1))" >"$d/o"
  c=${PIPESTATUS[0]}
  shift "$n"
  {
    printf 'MANGO-RUN %s %s %s\n' "$c" $(wc -c <"$d/o") $(wc -c <"$d/e")
    head -c "$cap" "$d/o"
    cat "$d/e"
  } >>"$d/all" || exit 1
done
cat "$d/all""#;

/// The outputs [`BATCH`] printed, one per cap; `None` when they aren't all there.
fn parse_batch(stdout: &[u8], caps: &[usize]) -> Option<Vec<Output>> {
    const HEAD: &[u8] = b"MANGO-RUN ";
    // A login shell's profile may print something first.
    let mut at = stdout.windows(HEAD.len()).position(|w| w == HEAD)?;
    let mut outs = Vec::with_capacity(caps.len());
    for &cap in caps {
        let rest = stdout.get(at..)?.strip_prefix(HEAD)?;
        let nl = rest.iter().position(|b| *b == b'\n')?;
        let mut fields = std::str::from_utf8(&rest[..nl]).ok()?.split_whitespace();
        let code: i32 = fields.next()?.parse().ok()?;
        let out_len: usize = fields.next()?.parse().ok()?;
        let err_len: usize = fields.next()?.parse().ok()?;
        let kept = out_len.min(cap);
        let body = rest.get(nl + 1..nl + 1 + kept + err_len)?;
        outs.push(Output {
            code: Some(code),
            stdout: body[..kept].to_vec(),
            stderr: body[kept..].to_vec(),
            truncated: out_len > cap,
        });
        at += HEAD.len() + nl + 1 + kept + err_len;
    }
    Some(outs)
}

pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
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

pub(crate) fn existing_dir(path: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Err("No folder given".into());
    }
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    Ok(dir)
}

/// Where a folder sits in its repository, from one `git rev-parse`.
struct Located {
    /// The work tree root, as git prints it.
    root: String,
    /// Short hash of HEAD; None on an unborn branch.
    head: Option<String>,
    /// For a linked worktree, the main working tree's root.
    main_root: Option<String>,
}

/// The work tree containing `dir`, the short hash of its HEAD (when it has a
/// commit) and, for a linked worktree, the main one's root. `None` when `dir`
/// is not inside a work tree.
fn locate(dir: &At) -> Result<Option<Located>, String> {
    located(dir, &locate_cmd(dir).run()?)
}

fn locate_cmd(dir: &At) -> Git<'_> {
    git(dir).read_only().args(["rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir", "--short", "HEAD"])
}

/// What [`locate_cmd`] found, run in `dir`.
fn located(dir: &At, out: &Output) -> Result<Option<Located>, String> {
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
    let (common, git_dir) = (lines.next().unwrap_or_default(), lines.next().unwrap_or_default());
    // On an unborn branch the command fails after printing the paths.
    let head = lines
        .next()
        .filter(|h| out.ok() && !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_string);
    let cwd = match dir {
        At::Local(p) => p.to_string_lossy().into_owned(),
        At::Env(e) => e.dir.clone(),
    };
    Ok(Some(Located { root: root.to_string(), head, main_root: main_root_of(&cwd, common, git_dir) }))
}

/// Whether a path git printed is absolute (`/x`, `C:/x`, `\\server\x`).
fn is_absolute_path(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with(['/', '\\']) || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'))
}

/// `p` made absolute against `cwd` (when relative) with `.` and `..` folded away,
/// forward slashes throughout. Purely textual: nothing is looked up on disk.
fn resolve_path(cwd: &str, p: &str) -> String {
    let joined = if is_absolute_path(p) { p.replace('\\', "/") } else { format!("{}/{}", cwd.replace('\\', "/"), p.replace('\\', "/")) };
    let mut prefix = String::new();
    let mut rest = joined.as_str();
    if let Some(r) = rest.strip_prefix("//") {
        prefix.push_str("//");
        rest = r;
    } else if let Some(r) = rest.strip_prefix('/') {
        prefix.push('/');
        rest = r;
    } else if rest.len() >= 2 && rest.as_bytes()[1] == b':' {
        prefix.push_str(&rest[..2]);
        prefix.push('/');
        rest = rest[2..].trim_start_matches('/');
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    prefix + &parts.join("/")
}

/// The parent folder of a `/`-separated path; None at the top.
fn parent_path(p: &str) -> Option<&str> {
    let p = p.trim_end_matches('/');
    let at = p.rfind('/')?;
    let parent = &p[..at];
    // Keep the root itself: "/x" -> "/", "C:/x" -> "C:/".
    if parent.is_empty() || parent.ends_with(':') {
        return Some(&p[..=at]);
    }
    Some(parent)
}

/// The main working tree's root when `git_dir` is a linked worktree's (git keeps those in
/// `<common dir>/worktrees/<name>`). None for the main one, and when the main one has no
/// working tree of its own (a bare repository) or keeps its `.git` elsewhere.
fn main_root_of(cwd: &str, common: &str, git_dir: &str) -> Option<String> {
    if common.is_empty() || git_dir.is_empty() {
        return None;
    }
    let common = resolve_path(cwd, common);
    let git_dir = resolve_path(cwd, git_dir);
    let name = git_dir.strip_prefix(&format!("{}/worktrees/", common.trim_end_matches('/')))?;
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let (parent, last) = common.rsplit_once('/')?;
    (last == ".git" && !parent.is_empty() && !parent.ends_with(':')).then(|| parent.to_string())
}

/// Repository root for a command that needs one.
fn require_root(at: &At) -> Result<At, String> {
    at.check()?;
    let cached = at.env_key().and_then(|k| env_roots().lock().ok()?.get(&k).cloned());
    if let Some(root) = cached {
        return Ok(at.moved(root));
    }
    match locate(at)? {
        Some(found) => {
            remember_root(at, Some(&found.root));
            Ok(at.moved(found.root))
        }
        None => Err(format!("{} is not inside a git repository", at.shown())),
    }
}

fn read_status(dir: &At, untracked: bool) -> Result<ParsedStatus, String> {
    let out = status_cmd(dir, untracked).run_ok("git status")?;
    Ok(parse_status(&out.stdout))
}

fn status_cmd(dir: &At, untracked: bool) -> Git<'_> {
    git(dir)
        .read_only()
        .args(["status", "--porcelain=v2", "--branch", "-z"])
        // Every untracked file, not just its folder: each one is a row with a diff.
        .arg(if untracked { "--untracked-files=all" } else { "--untracked-files=no" })
}

fn has_head_cmd(root: &At) -> Git<'_> {
    git(root).read_only().args(["rev-parse", "-q", "--verify", "HEAD^{commit}"])
}

/// Which of `paths` (relative to `dir`, forward slashes) git ignores. Empty
/// when `dir` is not in a repository or git is missing: ignoring is a hint
/// for the file tree, never a reason to fail a listing.
pub(crate) fn ignored_paths(dir: &Path, paths: &[String]) -> Vec<String> {
    if paths.is_empty() {
        return Vec::new();
    }
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        input.push(0);
    }
    let at = At::local(dir);
    // check-ignore refuses literal pathspecs; the paths arrive on stdin, never as patterns.
    let cmd = git(&at).read_only().args(["check-ignore", "-z", "--stdin"]).stdin(input).env_remove("GIT_LITERAL_PATHSPECS");
    // Exit 0: some are ignored, 1: none are, 128: not a repository.
    match cmd.run() {
        Ok(out) if out.ok() => out
            .stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(lossy)
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn status_of(at: &At) -> Result<GitStatus, String> {
    at.check()?;
    // Both at once: one round trip to an environment. Outside a work tree status just fails.
    let [where_, status]: [Output; 2] =
        run_all(vec![locate_cmd(at), status_cmd(at, true)])?.try_into().map_err(|_| "git gave no answer")?;
    let found = located(at, &where_)?;
    remember_root(at, found.as_ref().map(|f| f.root.as_str()));
    let Some(Located { root, head, main_root }) = found else {
        return Ok(GitStatus::default());
    };
    if !status.ok() {
        return Err(status.error("git status"));
    }
    let parsed = parse_status(&status.stdout);
    Ok(GitStatus {
        vcs: Vcs::Git,
        repository: None,
        is_repo: true,
        root: Some(root),
        main_root,
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

pub(crate) fn diff_of(at: &At, file: &str, staged: bool) -> Result<String, String> {
    let root = require_root(at)?;
    let file = clean_rel(file)?;
    let diff_cmd = |paths: &[&str]| {
        let cmd = git(&root).read_only().cap(DIFF_CAP).args(["diff", "--no-color", "--no-ext-diff", "-M"]);
        let cmd = if staged { cmd.arg("--cached") } else { cmd };
        cmd.arg("--").args(paths.iter().copied())
    };
    let diff_text = |out: Output| -> Result<String, String> {
        // A capped diff ends git with a broken pipe; that is still a result.
        if !out.ok() && !out.truncated {
            return Err(out.error("git diff"));
        }
        Ok(finish_diff(out.stdout, out.truncated))
    };
    let diff = |paths: &[&str]| diff_text(diff_cmd(paths).run()?);
    let tracked_cmd = || git(&root).read_only().args(["ls-files", "-z", "--"]).arg(file);

    if !staged {
        // Whether the file is tracked only matters when there's no diff, but asking right
        // away saves a second round trip to an environment.
        let [out, tracked]: [Output; 2] =
            run_all(vec![diff_cmd(&[file]), tracked_cmd()])?.try_into().map_err(|_| "git gave no answer")?;
        let text = diff_text(out)?;
        if !text.is_empty() {
            return Ok(text);
        }
        // Nothing against the index: either unchanged or not tracked at all.
        if !tracked.ok() {
            return Err(tracked.error("git ls-files"));
        }
        if !tracked.stdout.is_empty() {
            return Ok(String::new());
        }
        return untracked_diff(&root, file);
    }
    let text = diff(&[file])?;
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
    Ok(text)
}

/// An untracked file as an added one.
fn untracked_diff(root: &At, file: &str) -> Result<String, String> {
    if !matches!(entry(root, file), Ok(Entry::File)) {
        return Ok(String::new());
    }
    let out = git(root)
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

pub(crate) fn stage(at: &At, files: &[String]) -> Result<(), String> {
    let root = require_root(at)?;
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

pub(crate) fn unstage(at: &At, files: &[String]) -> Result<(), String> {
    let root = require_root(at)?;
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

/// `sh` script (in an environment's work tree): what `$1` is, like `fs::symlink_metadata`.
const ENTRY_KIND: &str = r#"if [ -L "$1" ]; then echo file; elif [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else echo missing; fi"#;

/// `sh` script (in an environment's work tree) doing what [`remove_untracked`] does: a real
/// folder is refused (exit 3), then the file goes, then each parent folder that is now empty,
/// up to (never including) the work tree root.
const REMOVE_UNTRACKED: &str = r#"f=$1
if [ -d "$f" ] && [ ! -L "$f" ]; then exit 3; fi
if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 0; fi
rm -f -- "$f" || exit 1
d=$(dirname -- "$f")
while [ "$d" != . ] && [ "$d" != / ] && rmdir -- "$d" 2>/dev/null; do d=$(dirname -- "$d"); done
exit 0"#;

/// What is at a path in the work tree, not following a symlink.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Missing,
    Dir,
    File,
}

fn entry(root: &At, rel: &str) -> Result<Entry, String> {
    let rel = clean_rel(rel)?;
    match root {
        At::Local(root) => match fs::symlink_metadata(root.join(rel)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Entry::Missing),
            Err(e) => Err(format!("Could not read {rel}: {e}")),
            Ok(meta) if meta.is_dir() => Ok(Entry::Dir),
            Ok(_) => Ok(Entry::File),
        },
        At::Env(e) => {
            let out = e.sh(ENTRY_KIND, &[rel])?;
            match out.line().as_str() {
                "dir" => Ok(Entry::Dir),
                "file" => Ok(Entry::File),
                "missing" => Ok(Entry::Missing),
                _ => Err(out.error(&format!("Reading {rel}"))),
            }
        }
    }
}

/// [`remove_untracked`] for a work tree here or in an environment.
fn remove_untracked_at(root: &At, rel: &str) -> Result<(), String> {
    let e = match root {
        At::Local(root) => return remove_untracked(root, rel),
        At::Env(e) => e,
    };
    let rel = clean_rel(rel)?;
    let out = e.sh(REMOVE_UNTRACKED, &[rel])?;
    match out.code {
        Some(0) => Ok(()),
        Some(3) => Err(format!(
            "{} is a folder with its own repository; delete it yourself if you mean to",
            rel.trim_end_matches('/')
        )),
        _ => Err(format!("Could not delete {rel}: {}", out.combined())),
    }
}

/// Delete an untracked file, then any folders that only existed to hold it.
pub(crate) fn remove_untracked(root: &Path, rel: &str) -> Result<(), String> {
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
pub(crate) fn discard(at: &At, files: &[String]) -> Result<(), String> {
    let root = require_root(at)?;
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
        remove_untracked_at(&root, file)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commit, sync, history, branches
// ---------------------------------------------------------------------------

fn short_head(root: &At) -> Result<String, String> {
    Ok(git(root)
        .read_only()
        .args(["rev-parse", "--short", "HEAD"])
        .run_ok("git rev-parse")?
        .line())
}

pub(crate) fn commit(at: &At, message: &str, amend: bool) -> Result<String, String> {
    let root = require_root(at)?;
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

fn remotes(root: &At) -> Result<Vec<String>, String> {
    let out = git(root).read_only().arg("remote").run_ok("git remote")?;
    Ok(out.text().lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// `git remote -v` in `at` (URLs with `insteadOf` applied), for finding which GitHub repository
/// a project belongs to. `Ok(None)` when git refused, for example outside a repository; a
/// connection or environment problem is an error.
pub(crate) fn remote_list(at: &At) -> Result<Option<String>, String> {
    at.check()?;
    let out = git(at).read_only().args(["remote", "-v"]).run()?;
    Ok(out.ok().then(|| out.text()))
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

// ---------------------------------------------------------------------------
// Sync summaries: what a fetch, pull, push, merge or rebase did, in one or two
// lines, read from the repository before and after rather than from git's own
// (localised, progress-laden) output.
// ---------------------------------------------------------------------------

/// "1 commit", "3 commits".
fn count(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Files and lines that differ between two commits.
#[derive(Debug, Default, PartialEq, Eq)]
struct DiffSize {
    files: u64,
    added: u64,
    removed: u64,
}

/// `git diff --numstat` lines: `added<TAB>removed<TAB>path`, `-` for binary files.
fn parse_numstat(text: &str) -> DiffSize {
    let mut size = DiffSize::default();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut parts = line.splitn(3, '\t');
        size.files += 1;
        size.added += parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        size.removed += parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    }
    size
}

/// "12 files changed, +80 −10" (the line counts only when there are any).
fn describe_size(size: &DiffSize) -> String {
    let files = format!("{} changed", count(size.files, "file", "files"));
    match (size.added, size.removed) {
        (0, 0) => files,
        (a, 0) => format!("{files}, +{a}"),
        (0, r) => format!("{files}, \u{2212}{r}"),
        (a, r) => format!("{files}, +{a} \u{2212}{r}"),
    }
}

/// Full hash of HEAD, `None` on an unborn branch.
fn head_oid(root: &At) -> Option<String> {
    let out = git(root).read_only().args(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).run().ok()?;
    Some(out.line()).filter(|s| out.ok() && !s.is_empty())
}

/// Commits reachable from `to` but not from `from`, merges left out.
fn commits_between(root: &At, from: &str, to: &str) -> u64 {
    git(root)
        .read_only()
        .args(["rev-list", "--count", "--no-merges"])
        .arg(format!("{from}..{to}"))
        .run()
        .ok()
        .filter(Output::ok)
        .and_then(|o| o.line().parse().ok())
        .unwrap_or(0)
}

fn diff_size(root: &At, from: &str, to: &str) -> DiffSize {
    git(root)
        .read_only()
        .args(["diff", "--numstat", "--no-color", "--no-ext-diff"])
        .arg(from)
        .arg(to)
        .run()
        .ok()
        .filter(Output::ok)
        .map(|o| parse_numstat(&o.text()))
        .unwrap_or_default()
}

/// Every remote-tracking ref and the commit it points at.
fn remote_refs(root: &At) -> HashMap<String, String> {
    git(root)
        .read_only()
        .args(["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes"])
        .run()
        .ok()
        .filter(Output::ok)
        .map(|o| {
            o.text()
                .lines()
                .filter_map(|l| l.split_once(' '))
                .filter(|(_, name)| !name.ends_with("/HEAD"))
                .map(|(oid, name)| (name.to_string(), oid.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// What a fetch changed among the remote-tracking branches.
fn describe_fetch(before: &HashMap<String, String>, after: &HashMap<String, String>) -> String {
    let updated = after.iter().filter(|(k, v)| before.get(*k).is_some_and(|b| b != *v)).count() as u64;
    let added = after.keys().filter(|k| !before.contains_key(*k)).count() as u64;
    let removed = before.keys().filter(|k| !after.contains_key(*k)).count() as u64;
    let mut parts = Vec::new();
    if updated > 0 {
        parts.push(format!("{} updated", count(updated, "branch", "branches")));
    }
    if added > 0 {
        parts.push(format!("{} new", count(added, "branch", "branches")));
    }
    if removed > 0 {
        parts.push(format!("{} removed", count(removed, "branch", "branches")));
    }
    if parts.is_empty() {
        "Fetched. Nothing new on the remote.".into()
    } else {
        format!("Fetched: {}.", parts.join(", "))
    }
}

/// The second line after a fetch: how far behind the current branch now is.
fn describe_behind(status: &ParsedStatus) -> Option<String> {
    let (branch, upstream) = (status.branch.as_deref()?, status.upstream.as_deref()?);
    (status.behind > 0).then(|| {
        format!("{branch} is {} behind {upstream}. Update to bring them in.", count(status.behind.into(), "commit", "commits"))
    })
}

pub(crate) fn fetch(at: &At) -> Result<String, String> {
    let root = require_root(at)?;
    if remotes(&root)?.is_empty() {
        return Err(NO_REMOTE.into());
    }
    let before = remote_refs(&root);
    let out = git(&root).slow().arg("fetch").run()?;
    if !out.ok() {
        return Err(explain_sync_failure(out.error("git fetch")));
    }
    let title = describe_fetch(&before, &remote_refs(&root));
    let behind = read_status(&root, false).ok().as_ref().and_then(describe_behind);
    Ok(match behind {
        Some(line) => format!("{title}\n{line}"),
        None => title,
    })
}

pub(crate) fn pull(at: &At) -> Result<String, String> {
    let root = require_root(at)?;
    if remotes(&root)?.is_empty() {
        return Err(NO_REMOTE.into());
    }
    let before = read_status(&root, false)?;
    let Some(branch) = before.branch else {
        return Err("HEAD is detached, so there is no branch to pull into. Switch to a branch first.".into());
    };
    let Some(upstream) = before.upstream else {
        return Err(format!(
            "{branch} isn't tracking a remote branch yet. Publish it first, then pull."
        ));
    };
    let out = git(&root).slow().arg("pull").run()?;
    if out.ok() {
        let after = head_oid(&root);
        return Ok(match (before.oid, after) {
            (Some(from), Some(to)) if from == to => format!("{branch} is already up to date with {upstream}."),
            (Some(from), Some(to)) => {
                let commits = commits_between(&root, &from, &upstream);
                let title = if commits > 0 {
                    format!("Pulled {} into {branch}.", count(commits, "commit", "commits"))
                } else {
                    format!("Updated {branch} from {upstream}.")
                };
                format!("{title}\n{}", describe_size(&diff_size(&root, &from, &to)))
            }
            _ => format!("Pulled {upstream} into {branch}."),
        });
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

pub(crate) fn push(at: &At) -> Result<String, String> {
    let root = require_root(at)?;
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
    Ok(match status.upstream {
        Some(upstream) if status.ahead == 0 => format!("Nothing to push. {upstream} already has every commit."),
        Some(upstream) => format!("Pushed {} to {upstream}.", count(status.ahead.into(), "commit", "commits")),
        None => {
            let tracks = read_status(&root, false).ok().and_then(|s| s.upstream);
            match tracks {
                Some(upstream) => format!("Published {branch} to {upstream}.\n{branch} now tracks it, so Update and Push work from here."),
                None => format!("Published {branch}."),
            }
        }
    })
}

pub(crate) fn log(at: &At, limit: u32) -> Result<Vec<GitCommit>, String> {
    let root = require_root(at)?;
    let log = git(&root)
        .read_only()
        .args(["log", "--no-show-signature", "--no-color"])
        .arg(format!("--max-count={}", limit.clamp(1, 500)))
        .arg("--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e");
    // Together: one round trip to an environment. On an unborn branch the log just fails.
    let [head, out]: [Output; 2] = run_all(vec![has_head_cmd(&root), log])?.try_into().map_err(|_| "git gave no answer")?;
    if !head.ok() {
        return Ok(Vec::new());
    }
    if !out.ok() {
        return Err(out.error("git log"));
    }
    Ok(parse_log(&out.text()))
}

pub(crate) fn branches(at: &At) -> Result<GitBranches, String> {
    let root = require_root(at)?;
    let [head, out]: [Output; 2] = run_all(vec![
        git(&root).read_only().args(["symbolic-ref", "-q", "--short", "HEAD"]),
        git(&root).read_only().args(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]),
    ])?
    .try_into()
    .map_err(|_| "git gave no answer")?;
    let current = Some(head.line()).filter(|b| head.ok() && !b.is_empty());
    if !out.ok() {
        return Err(out.error("git for-each-ref"));
    }
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

pub(crate) fn checkout(at: &At, branch: &str, create: bool) -> Result<(), String> {
    let root = require_root(at)?;
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

pub(crate) fn branch_list(at: &At) -> Result<GitBranchList, String> {
    let root = require_root(at)?;
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

fn valid_new_branch(root: &At, name: &str) -> Result<(), String> {
    let ok = git(root).read_only().args(["check-ref-format", "--branch"]).arg(name).run()?;
    if ok.ok() { Ok(()) } else { Err(format!("\"{name}\" is not a valid branch name")) }
}

/// Create `name` at `from` (or at HEAD) and optionally switch to it.
pub(crate) fn branch_create(at: &At, name: &str, from: Option<&str>, checkout: bool) -> Result<(), String> {
    let root = require_root(at)?;
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
pub(crate) fn checkout_remote(at: &At, branch: &str) -> Result<String, String> {
    let root = require_root(at)?;
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
fn conflict_report(root: &At, what: &str, abort: &str) -> Option<String> {
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
pub(crate) fn merge(at: &At, branch: &str) -> Result<String, String> {
    let root = require_root(at)?;
    let branch = safe_ref(branch)?;
    let before = head_oid(&root);
    let current = read_status(&root, false).ok().and_then(|s| s.branch).unwrap_or_else(|| "HEAD".into());
    let out = git(&root).slow().args(["merge", "--no-edit"]).arg(branch).run()?;
    if out.ok() {
        let after = head_oid(&root);
        return Ok(match (before, after) {
            (Some(from), Some(to)) if from == to => format!("{current} already has every commit from {branch}."),
            (Some(from), Some(to)) => format!(
                "Merged {} from {branch} into {current}.\n{}",
                count(commits_between(&root, &from, &to), "commit", "commits"),
                describe_size(&diff_size(&root, &from, &to)),
            ),
            _ => format!("Merged {branch} into {current}."),
        });
    }
    Err(conflict_report(&root, "Merge", "git merge --abort").unwrap_or_else(|| out.error("git merge")))
}

/// Rebase the current branch onto `onto`.
pub(crate) fn rebase(at: &At, onto: &str) -> Result<String, String> {
    let root = require_root(at)?;
    let onto = safe_ref(onto)?;
    let before = head_oid(&root);
    let current = read_status(&root, false).ok().and_then(|s| s.branch).unwrap_or_else(|| "HEAD".into());
    let out = git(&root).slow().arg("rebase").arg(onto).run()?;
    if out.ok() {
        let after = head_oid(&root);
        return Ok(match (before, after) {
            (Some(from), Some(to)) if from == to => format!("{current} is already up to date with {onto}."),
            (Some(from), Some(_)) => {
                let under = commits_between(&root, &from, onto);
                if under > 0 {
                    format!("Rebased {current} onto {onto}.\nPicked up {} from {onto}.", count(under, "commit", "commits"))
                } else {
                    format!("Rebased {current} onto {onto}.")
                }
            }
            _ => format!("Rebased {current} onto {onto}."),
        });
    }
    Err(conflict_report(&root, "Rebase", "git rebase --abort").unwrap_or_else(|| out.error("git rebase")))
}

pub(crate) fn branch_rename(at: &At, from: &str, to: &str) -> Result<(), String> {
    let root = require_root(at)?;
    let from = safe_ref(from)?;
    let to = safe_ref(to)?;
    valid_new_branch(&root, to)?;
    git(&root).args(["branch", "-m"]).arg(from).arg(to).run_ok("git branch -m")?;
    Ok(())
}

/// Delete a local branch. Without `force`, git refuses branches whose commits
/// are not merged anywhere; that refusal comes back as an error mentioning
/// "not fully merged" so the UI can offer to delete anyway.
pub(crate) fn branch_delete(at: &At, branch: &str, force: bool) -> Result<(), String> {
    let root = require_root(at)?;
    let branch = safe_ref(branch)?;
    git(&root)
        .arg("branch")
        .arg(if force { "-D" } else { "-d" })
        .arg(branch)
        .run_ok("git branch -d")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

/// One entry of `git worktree list --porcelain`, as git printed it.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RawWorktree {
    pub path: String,
    /// Full hash; None for an unborn branch.
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// Parse `git worktree list --porcelain`, with `-z` (`sep` NUL) or without (`sep` newline):
/// attribute lines, each entry ended by an empty one. The main working tree comes first.
pub(crate) fn parse_worktrees(text: &str, sep: char) -> Vec<RawWorktree> {
    let mut out = Vec::new();
    let mut cur: Option<RawWorktree> = None;
    for line in text.split(sep) {
        let line = if sep == '\n' { line.trim_end_matches('\r') } else { line };
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "" => out.extend(cur.take()),
            "worktree" => {
                out.extend(cur.take());
                cur = Some(RawWorktree { path: value.to_string(), ..Default::default() });
            }
            _ => {
                let Some(w) = cur.as_mut() else { continue };
                match key {
                    "HEAD" => w.head = Some(value.to_string()).filter(|h| !h.is_empty() && h.bytes().any(|b| b != b'0')),
                    "branch" => w.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string()),
                    "bare" => w.bare = true,
                    "locked" => w.locked = true,
                    "prunable" => w.prunable = true,
                    _ => {}
                }
            }
        }
    }
    out.extend(cur);
    out
}

/// The repository's worktrees, main first. Git before 2.36 has no `-z` here; it gets the
/// line form (only a folder name with a line break in it would read wrong).
fn worktree_list(root: &At) -> Result<Vec<RawWorktree>, String> {
    let out = git(root).read_only().args(["worktree", "list", "--porcelain", "-z"]).run()?;
    if out.ok() {
        return Ok(parse_worktrees(&out.text(), '\0'));
    }
    if !lossy(&out.stderr).contains("unknown switch") {
        return Err(out.error("git worktree list"));
    }
    let out = git(root).read_only().args(["worktree", "list", "--porcelain"]).run_ok("git worktree list")?;
    Ok(parse_worktrees(&out.text(), '\n'))
}

/// A folder path reduced for comparing: the real path when it exists on this computer,
/// forward slashes, no trailing one. Remote folders compare as given.
fn folder_key(at: &At, dir: &str) -> String {
    let dir = match at {
        At::Local(_) => fs::canonicalize(dir).map_or_else(|_| dir.to_string(), |p| p.to_string_lossy().into_owned()),
        At::Env(_) => dir.to_string(),
    };
    let dir = dir.replace('\\', "/");
    let trimmed = dir.trim_end_matches('/');
    let key = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(windows) { key.to_lowercase() } else { key.to_string() }
}

/// A worktree folder in the form the frontend uses: as is on this computer,
/// `env://<hostId>/<instance>/<dir>` inside an environment (see `envs::parse_env_path`).
fn worktree_path(at: &At, dir: &str) -> String {
    match at {
        At::Local(_) => dir.to_string(),
        At::Env(e) => {
            let dir = dir.trim_end_matches('/');
            format!("env://{}/{}{}", e.host.id, e.instance, if dir.is_empty() { "/" } else { dir })
        }
    }
}

fn to_worktree(at: &At, current: &str, raw: RawWorktree, is_main: bool) -> GitWorktree {
    GitWorktree {
        is_current: folder_key(at, &raw.path) == current,
        path: worktree_path(at, &raw.path),
        branch: raw.branch,
        head: raw.head.map(|h| h.chars().take(7).collect()),
        is_main,
        locked: raw.locked,
        prunable: raw.prunable,
    }
}

/// The worktrees of the repository `at` is in: the main one first, bare entries left out.
pub(crate) fn worktrees(at: &At) -> Result<Vec<GitWorktree>, String> {
    let root = require_root(at)?;
    let current = folder_key(&root, &root_dir(&root));
    Ok(worktree_list(&root)?
        .into_iter()
        .enumerate()
        .filter(|(_, w)| !w.bare)
        .map(|(i, w)| to_worktree(&root, &current, w, i == 0))
        .collect())
}

/// The folder an `At` points at, as a string.
fn root_dir(at: &At) -> String {
    match at {
        At::Local(p) => p.to_string_lossy().into_owned(),
        At::Env(e) => e.dir.clone(),
    }
}

/// Where a new worktree for `branch` goes: `<parent>/<repo>.worktrees/<branch, '/' as '-'>`
/// beside the main working tree.
pub(crate) fn worktree_folder(main_root: &str, branch: &str) -> Result<String, String> {
    let main = main_root.replace('\\', "/");
    let main = main.trim_end_matches('/');
    let parent = parent_path(main).ok_or_else(|| format!("{main_root} has no parent folder to put worktrees in"))?;
    let name = &main[main.rfind('/').map_or(0, |i| i + 1)..];
    if name.is_empty() || name.ends_with(':') {
        return Err(format!("{main_root} has no parent folder to put worktrees in"));
    }
    let leaf = branch.replace(['/', '\\'], "-");
    Ok(format!("{}/{name}.worktrees/{leaf}", parent.trim_end_matches('/')))
}

/// Add a linked worktree for `branch` beside the repository (see [`worktree_folder`]).
/// `create`: a new branch from `from` (HEAD when None); otherwise an existing local
/// branch that no other worktree has checked out.
pub(crate) fn worktree_add(at: &At, branch: &str, from: Option<&str>, create: bool) -> Result<GitWorktree, String> {
    let root = require_root(at)?;
    let branch = safe_ref(branch)?;
    let list = worktree_list(&root)?;
    let main = list.first().filter(|w| !w.bare).ok_or("This repository has no main working tree to put worktrees beside")?;
    let folder = worktree_folder(&main.path, branch)?;
    if let At::Local(_) = root {
        if Path::new(&folder).exists() {
            return Err(format!("{folder} already exists; pick another branch name"));
        }
    }
    let local_branch = git(&root)
        .read_only()
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .run()?
        .ok();
    let mut cmd = git(&root).args(["worktree", "add"]);
    if create {
        valid_new_branch(&root, branch)?;
        if local_branch {
            return Err(format!("A branch named \"{branch}\" already exists"));
        }
        cmd = cmd.arg("-b").arg(branch).arg("--").arg(&folder);
        if let Some(from) = from.map(str::trim).filter(|f| !f.is_empty()) {
            cmd = cmd.arg(safe_ref(from)?);
        }
    } else {
        if !local_branch {
            return Err(format!("There is no local branch named \"{branch}\""));
        }
        if let Some(other) = list.iter().find(|w| w.branch.as_deref() == Some(branch)) {
            return Err(format!("{branch} is already checked out in {}", worktree_path(&root, &other.path)));
        }
        cmd = cmd.arg("--").arg(&folder).arg(branch);
    }
    let out = cmd.run()?;
    if !out.ok() {
        let detail = out.error("git worktree add");
        if detail.contains("already exists") || detail.contains("already registered") {
            return Err(format!("{} already exists; pick another branch name", worktree_path(&root, &folder)));
        }
        if let Some(line) = detail.lines().find(|l| l.contains("is already used by worktree at") || l.contains("is already checked out at")) {
            return Err(format!("{branch} is already checked out in another worktree ({})", line.trim_start_matches("fatal: ")));
        }
        return Err(detail);
    }
    let current = folder_key(&root, &root_dir(&root));
    worktree_list(&root)?
        .into_iter()
        .enumerate()
        .find(|(_, w)| !w.bare && w.branch.as_deref() == Some(branch))
        .map(|(i, w)| to_worktree(&root, &current, w, i == 0))
        .ok_or_else(|| format!("git added the worktree, but it is not in `git worktree list`; look in {folder}"))
}

/// Remove the linked worktree whose folder is `worktree` (same form as [`worktrees`] gives);
/// its branch is kept. Refuses the main one, and one with uncommitted or untracked
/// changes unless `force`. A worktree whose folder is already gone is only pruned.
pub(crate) fn worktree_remove(at: &At, worktree: &str, force: bool) -> Result<(), String> {
    let root = require_root(at)?;
    let dir = match (&root, envs::parse_env_path(worktree)) {
        (At::Local(_), None) => worktree.trim().to_string(),
        (At::Env(e), Some(Ok(folder))) if folder.host_id == e.host.id && folder.instance == e.instance => folder.dir,
        (_, Some(Err(e))) => return Err(e),
        _ => return Err(format!("{worktree} is not a worktree of this repository")),
    };
    if dir.is_empty() {
        return Err("No worktree folder given".into());
    }
    let key = folder_key(&root, &dir);
    let list = worktree_list(&root)?;
    let (index, entry) = list
        .iter()
        .enumerate()
        .find(|(_, w)| folder_key(&root, &w.path) == key)
        .ok_or_else(|| format!("{worktree} is not a worktree of this repository"))?;
    if index == 0 {
        return Err("The main worktree can't be removed; it is the repository itself".into());
    }
    // Run from the main working tree: never from inside the folder being removed.
    let main = root.moved(list[0].path.clone());
    let prune = || git(&main).args(["worktree", "prune"]).run_ok("git worktree prune").map(|_| ());
    if entry.prunable {
        return prune();
    }
    let name = entry.branch.clone().unwrap_or_else(|| "This worktree".into());
    let place = root.moved(entry.path.clone());
    if !force {
        // Its folder may be gone without git knowing yet (older git, or a lock): let git say.
        if let Ok(status) = git(&place).read_only().args(["status", "--porcelain", "-z"]).run() {
            if status.ok() && !status.stdout.is_empty() {
                return Err(format!("{name} has uncommitted changes; commit or discard them first"));
            }
        }
    }
    let mut cmd = git(&main).args(["worktree", "remove"]);
    if force {
        cmd = cmd.arg("--force");
    }
    let out = cmd.arg("--").arg(&entry.path).run()?;
    if !out.ok() {
        let detail = out.error("git worktree remove");
        if detail.contains("contains modified or untracked files") {
            return Err(format!("{name} has uncommitted changes; commit or discard them first"));
        }
        if detail.contains("locked working tree") {
            return Err(format!("{name} is locked (`git worktree lock`); unlock it first with `git worktree unlock`"));
        }
        return Err(detail);
    }
    prune()
}

pub(crate) fn init(at: &At) -> Result<(), String> {
    at.check()?;
    if locate(at)?.is_some() {
        return Ok(());
    }
    let dir = at;
    let configured = git(dir)
        .read_only()
        .args(["config", "--get", "init.defaultBranch"])
        .run()?;
    let mut cmd = git(dir);
    if !configured.ok() || configured.line().is_empty() {
        // Git's built-in default is still "master"; follow the hosts instead.
        cmd = cmd.args(["-c", "init.defaultBranch=main"]);
    }
    cmd.args(["init", "-q"]).run_ok("git init")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_tools_ask_for_the_login_shell() {
        let out = |code: i32, err: &str| Output { code: Some(code), stdout: Vec::new(), stderr: err.into(), truncated: false };
        assert!(profile_needed(&out(127, "")));
        assert!(profile_needed(&out(127, "env: 'git': No such file or directory")));
        assert!(profile_needed(&out(128, "git-lfs filter-process: git-lfs: command not found\nfatal: the remote end hung up")));
        assert!(profile_needed(&out(1, "sh: 1: git-lfs: not found")));
        assert!(profile_needed(&out(128, "error: cannot run mangofakefilter: No such file or directory\nerror: cannot fork to run external filter")));
        assert!(!profile_needed(&out(128, "fatal: not a git repository")));
        assert!(!profile_needed(&out(0, "")));
    }

    /// The batch script, run by a local bash, and its output read back.
    #[cfg(unix)]
    #[test]
    fn batch_script_round_trip() {
        let cmds: Vec<(Vec<&str>, usize)> = vec![
            (vec!["printf", "a\\nb"], 100),
            (vec!["sh", "-c", "printf 'MANGO-RUN 9 9 9\\n'; echo oops >&2; exit 3"], 100),
            (vec!["printf", "%s", "0123456789"], 4),
            (vec!["true"], 100),
            (vec!["printf", "\\000\\377 x"], 100),
            // Endless output: the cap stops the command itself.
            (vec!["yes"], 6),
        ];
        let mut cmd = Command::new("bash");
        cmd.args(["-c", BATCH, "mango"]);
        for (argv, cap) in &cmds {
            cmd.args([argv.len().to_string(), cap.to_string()]).args(argv);
        }
        let out = cmd.output().unwrap();
        let caps: Vec<usize> = cmds.iter().map(|c| c.1).collect();
        // Something a profile printed first is skipped.
        let mut noisy = b"welcome\n".to_vec();
        noisy.extend(&out.stdout);
        let got = parse_batch(&noisy, &caps).expect("parsed");
        assert_eq!(got.len(), 6);
        assert_eq!((got[0].code, got[0].stdout.as_slice(), got[0].truncated), (Some(0), &b"a\nb"[..], false));
        assert_eq!(got[1].code, Some(3));
        assert_eq!(got[1].stdout, b"MANGO-RUN 9 9 9\n");
        assert_eq!(got[1].stderr, b"oops\n");
        assert_eq!((got[2].stdout.as_slice(), got[2].truncated), (&b"0123"[..], true));
        assert_eq!((got[3].code, got[3].stdout.len(), got[3].stderr.len()), (Some(0), 0, 0));
        assert_eq!(got[4].stdout, b"\0\xff x");
        assert_eq!((got[5].stdout.as_slice(), got[5].truncated), (&b"y\ny\ny\n"[..], true));
        // A cut-off answer is not a result.
        assert!(parse_batch(&out.stdout[..out.stdout.len() - 1], &caps).is_none());
        assert!(parse_batch(b"", &caps).is_none());
    }

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
        let path = &At::local(&work);

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

        // Merge and rebase say what they did.
        checkout(path, "main", false).unwrap();
        assert_eq!(merge(path, "feature/x").unwrap(), "Merged 1 commit from feature/x into main.\n1 file changed, +1");
        assert!(work.join("b.txt").exists());
        assert_eq!(merge(path, "feature/x").unwrap(), "main already has every commit from feature/x.");

        // Push, fetch and pull say what they did.
        assert_eq!(push(path).unwrap(), "Pushed 1 commit to origin/main.");
        assert_eq!(push(path).unwrap(), "Nothing to push. origin/main already has every commit.");
        sh(&base, &["clone", "-q", origin.to_str().unwrap(), "other"]);
        let other = base.join("other");
        for (k, v) in [("user.email", "o@example.com"), ("user.name", "Other"), ("commit.gpgsign", "false")] {
            sh(&other, &["config", k, v]);
        }
        std::fs::write(other.join("a.txt"), "one\nmore\n").unwrap();
        sh(&other, &["commit", "-q", "-am", "from elsewhere"]);
        sh(&other, &["push", "-q"]);
        let behind = "main is 1 commit behind origin/main. Update to bring them in.";
        assert_eq!(fetch(path).unwrap(), format!("Fetched: 1 branch updated.\n{behind}"));
        assert_eq!(fetch(path).unwrap(), format!("Fetched. Nothing new on the remote.\n{behind}"));
        assert_eq!(pull(path).unwrap(), "Pulled 1 commit into main.\n1 file changed, +1");
        assert_eq!(pull(path).unwrap(), "main is already up to date with origin/main.");

        checkout(path, "spike", false).unwrap();
        assert_eq!(rebase(path, "main").unwrap(), "Rebased spike onto main.\nPicked up 2 commits from main.");
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
    fn sizes_and_fetch_summaries() {
        let size = parse_numstat("3\t1\tsrc/a.rs\n-\t-\timg.png\n10\t0\tdocs/{old => new}.md\n");
        assert_eq!(size, DiffSize { files: 3, added: 13, removed: 1 });
        assert_eq!(describe_size(&size), "3 files changed, +13 \u{2212}1");
        assert_eq!(describe_size(&DiffSize { files: 1, added: 0, removed: 0 }), "1 file changed");

        let refs = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
        };
        let before = refs(&[("refs/remotes/origin/main", "a"), ("refs/remotes/origin/old", "b")]);
        assert_eq!(describe_fetch(&before, &before), "Fetched. Nothing new on the remote.");
        let after = refs(&[("refs/remotes/origin/main", "c"), ("refs/remotes/origin/x", "d"), ("refs/remotes/origin/y", "e")]);
        assert_eq!(describe_fetch(&before, &after), "Fetched: 1 branch updated, 2 branches new, 1 branch removed.");
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
    fn remote_folders_run_git_as_the_agent() {
        let host = EnvHost {
            id: "h".into(), name: "Lab".into(), ssh: "me@lab".into(), port: None, identity_file: None,
            incus_remote: None, tailscale: None, public_address: None, direct: None,
        };
        let at = At::Env(Box::new(EnvAt { host, instance: "dev".into(), dir: "/home/agent/work/my shop".into() }));
        let root = at.moved("/home/agent/work".into());
        assert_eq!(root.shown(), "/home/agent/work in dev");
        assert!(root.check().is_ok(), "no local disk check for a remote folder");
        let At::Env(e) = &root else { unreachable!() };
        let cmd = git(&root).read_only().args(["add", "-A", "--", "pages/[id].vue", "it's.txt"]);
        let env: Vec<(String, String)> = cmd.env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let mut argv = vec!["git".to_string()];
        argv.extend(cmd.args.iter().cloned());
        let line = ssh::line(&e.remote(cmd.login, &env, &argv).unwrap());
        assert!(line.starts_with("incus exec dev -T -- runuser -u agent -- env HOME=/home/agent"), "{line}");
        // A read skips the login shell; anything else keeps it (hooks, credential helpers).
        assert!(!cmd.login && line.contains(" bash -c ") && !line.contains(" -lc "), "{line}");
        assert!(git(&root).args(["commit"]).login);
        for part in ["GIT_TERMINAL_PROMPT=0", "GIT_LITERAL_PATHSPECS=1", "GIT_OPTIONAL_LOCKS=0", "mango /home/agent/work git --no-pager"] {
            assert!(line.contains(part), "{part}: {line}");
        }
        assert!(line.ends_with(r"add -A -- 'pages/[id].vue' 'it'\''s.txt'"), "{line}");
        // Roots are remembered per remote folder only.
        assert_eq!(At::local("/x").env_key(), None);
        remember_root(&at, Some("/home/agent/work"));
        assert_eq!(require_root(&at).unwrap().shown(), "/home/agent/work in dev");
        remember_root(&at, None);
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

    #[test]
    fn parses_worktree_lists() {
        let z = "worktree /r/app\0HEAD 1234567890abcdef1234567890abcdef12345678\0branch refs/heads/main\0\0\
worktree /r/app.worktrees/feat-x\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/feat/x\0locked\0\0\
worktree /r/app.worktrees/d y\0HEAD abcdef1abcdef1abcdef1abcdef1abcdef1abcde\0detached\0locked because\0prunable gitdir file points to non-existent location\0\0";
        let list = parse_worktrees(z, '\0');
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], RawWorktree {
            path: "/r/app".into(),
            head: Some("1234567890abcdef1234567890abcdef12345678".into()),
            branch: Some("main".into()),
            ..Default::default()
        });
        assert_eq!((list[1].head.as_deref(), list[1].branch.as_deref(), list[1].locked), (None, Some("feat/x"), true));
        assert_eq!((list[2].path.as_str(), list[2].branch.as_deref(), list[2].locked, list[2].prunable), ("/r/app.worktrees/d y", None, true, true));

        // Older git: lines, and a bare main entry.
        let lines = "worktree /r/app.git\r\nbare\r\n\r\nworktree /r/w\r\nHEAD 1234567890abcdef1234567890abcdef12345678\r\nbranch refs/heads/w\r\n";
        let list = parse_worktrees(lines, '\n');
        assert_eq!(list.len(), 2);
        assert!(list[0].bare && !list[1].bare);
        assert_eq!(list[1].branch.as_deref(), Some("w"));
        assert!(parse_worktrees("", '\0').is_empty());
    }

    #[test]
    fn worktree_folders_and_main_roots() {
        assert_eq!(worktree_folder("/home/me/shop", "feat/new-ui").unwrap(), "/home/me/shop.worktrees/feat-new-ui");
        assert_eq!(worktree_folder("/home/me/shop/", "fix").unwrap(), "/home/me/shop.worktrees/fix");
        assert_eq!(worktree_folder("C:/Users/me/shop", "a/b/c").unwrap(), "C:/Users/me/shop.worktrees/a-b-c");
        assert_eq!(worktree_folder(r"C:\Users\me\shop", "x").unwrap(), "C:/Users/me/shop.worktrees/x");
        assert_eq!(worktree_folder("/shop", "x").unwrap(), "/shop.worktrees/x");
        assert!(worktree_folder("/", "x").is_err());

        assert_eq!(resolve_path("/a/b/sub", "../.git"), "/a/b/.git");
        assert_eq!(resolve_path(r"C:\a\sub", "../.git"), "C:/a/.git");
        assert_eq!(resolve_path("/x", "/a/./b/../c/"), "/a/c");
        // Main working tree (from a subfolder: a relative common dir).
        assert_eq!(main_root_of("/r/app/sub", "../.git", "/r/app/.git"), None);
        assert_eq!(main_root_of("/r/app", ".git", ".git"), None);
        // A main folder that happens to be called "worktrees".
        assert_eq!(main_root_of("/r/worktrees", ".git", ".git"), None);
        // Linked.
        assert_eq!(main_root_of("/r/app.worktrees/x/s", "/r/app/.git", "/r/app/.git/worktrees/x").as_deref(), Some("/r/app"));
        assert_eq!(main_root_of("C:/r/w", "C:/r/app/.git", "C:/r/app/.git/worktrees/w").as_deref(), Some("C:/r/app"));
        // A bare repository's worktree has no main working tree.
        assert_eq!(main_root_of("/r/w", "/r/app.git", "/r/app.git/worktrees/w"), None);
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
        fn at(&self) -> At {
            At::local(&self.0)
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
            let out = git(&At::local(&self.0)).args(args).run().unwrap();
            assert!(out.ok(), "git {args:?}: {}", out.combined());
            out
        }
        /// A repository with an identity that doesn't depend on the machine.
        fn repo() -> Self {
            let s = Scratch::new();
            init(&s.at()).unwrap();
            s.git(&["config", "user.name", "Mango Test"]);
            s.git(&["config", "user.email", "test@mango.invalid"]);
            s.git(&["config", "commit.gpgsign", "false"]);
            s
        }
        fn entry(&self, rel: &str) -> Option<GitFile> {
            status_of(&self.at()).unwrap().files.into_iter().find(|f| f.path == rel)
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
        git(&At::local(std::env::temp_dir())).arg("--version").run().map(|o| o.ok()).unwrap_or(false)
    }

    #[test]
    fn worktrees_add_list_and_remove() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        // Worktrees land beside the repository; clean them up with it.
        struct Gone(PathBuf);
        impl Drop for Gone {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let beside = Gone(PathBuf::from(format!("{}.worktrees", s.path())));
        s.write("a.txt", "base\n");
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "base", false).unwrap();
        let main_branch = status_of(&s.at()).unwrap().branch.unwrap();
        assert_eq!(status_of(&s.at()).unwrap().main_root, None);

        let only = worktrees(&s.at()).unwrap();
        assert_eq!(only.len(), 1);
        assert!(only[0].is_main && only[0].is_current);
        assert_eq!(only[0].path, s.path());

        // A new branch, in a folder named after it.
        let added = worktree_add(&s.at(), "feat/side", None, true).unwrap();
        let folder = beside.0.join("feat-side");
        assert_eq!(PathBuf::from(&added.path), folder);
        assert_eq!(added.branch.as_deref(), Some("feat/side"));
        assert_eq!(added.head.as_ref().map(String::len), Some(7));
        assert!(!added.is_main && !added.is_current && !added.locked && !added.prunable);
        assert!(worktree_add(&s.at(), "feat/side", None, true).unwrap_err().contains("already exists"));
        assert!(worktree_add(&s.at(), &main_branch, None, false).unwrap_err().contains("already checked out"));
        assert!(worktree_add(&s.at(), "nope", None, false).unwrap_err().contains("no local branch"));

        // Seen from inside the linked one (a subfolder, even).
        let inside = At::local(folder.join("sub"));
        fs::create_dir_all(folder.join("sub")).unwrap();
        let status = status_of(&inside).unwrap();
        assert_eq!(status.main_root.as_deref(), Some(s.path()));
        assert_eq!(status.branch.as_deref(), Some("feat/side"));
        let list = worktrees(&inside).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].is_main && !list[0].is_current);
        assert!(!list[1].is_main && list[1].is_current);

        // An existing branch.
        checkout(&s.at(), "other", true).unwrap();
        checkout(&s.at(), &main_branch, false).unwrap();
        let other = worktree_add(&s.at(), "other", None, false).unwrap();
        assert_eq!(PathBuf::from(&other.path), beside.0.join("other"));

        // Dirty: refused unless forced; the main one never.
        fs::write(folder.join("new.txt"), "x").unwrap();
        let err = worktree_remove(&s.at(), &added.path, false).unwrap_err();
        assert_eq!(err, "feat/side has uncommitted changes; commit or discard them first");
        assert!(worktree_remove(&s.at(), s.path(), true).unwrap_err().contains("main worktree"));
        assert!(worktree_remove(&s.at(), "/nowhere/at/all", true).unwrap_err().contains("not a worktree"));
        worktree_remove(&s.at(), &added.path, true).unwrap();
        assert!(!folder.exists());
        // The branch stays.
        assert!(branches(&s.at()).unwrap().local.contains(&"feat/side".to_string()));

        // A folder that is already gone is just pruned.
        fs::remove_dir_all(beside.0.join("other")).unwrap();
        worktree_remove(&s.at(), &other.path, false).unwrap();
        assert_eq!(worktrees(&s.at()).unwrap().len(), 1);
    }

    #[test]
    fn not_a_repository_is_not_an_error() {
        if !have_git() {
            return;
        }
        let s = Scratch::new();
        // Keep discovery from finding a repository above the temp folder.
        fs::create_dir_all(s.0.join("plain")).unwrap();
        let status = status_of(&At::local(s.0.join("plain"))).unwrap();
        if status.is_repo {
            return; // the temp folder itself lives inside a repository
        }
        assert_eq!(status.root, None);
        assert!(status.files.is_empty());
        assert!(status_of(&At::local(s.0.join("missing"))).is_err());
        assert!(stage(&s.at(), &[]).unwrap_err().contains("not inside a git repository"));
    }

    #[test]
    fn unborn_branch_stage_unstage_commit() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        let status = status_of(&s.at()).unwrap();
        assert!(status.is_repo);
        assert_eq!(status.root.as_deref(), Some(s.path()));
        assert_eq!(status.head, None);
        assert!(status.branch.is_some());
        assert!(log(&s.at(), 20).unwrap().is_empty());
        let b = branches(&s.at()).unwrap();
        assert_eq!(b.current, status.branch);
        assert_eq!(b.local, [status.branch.clone().unwrap()]);

        s.write("a.txt", "one\n");
        s.write("docs/read me.md", "hello\n");
        assert_eq!(s.codes("docs/read me.md"), pair(None, Some("?")));

        stage(&s.at(), &[]).unwrap();
        assert_eq!(s.codes("a.txt"), pair(Some("A"), None));
        // No HEAD yet: unstaging has to go through `git rm --cached`.
        unstage(&s.at(), &["a.txt".into()]).unwrap();
        assert_eq!(s.codes("a.txt"), pair(None, Some("?")));
        assert_eq!(s.codes("docs/read me.md"), pair(Some("A"), None));
        unstage(&s.at(), &[]).unwrap();
        assert_eq!(s.codes("docs/read me.md"), pair(None, Some("?")));
        assert_eq!(s.read("a.txt").as_deref(), Some("one\n"));

        let err = commit(&s.at(), "nothing yet", false).unwrap_err();
        assert!(err.contains("Nothing is staged"), "{err}");
        assert!(commit(&s.at(), "   ", false).is_err());

        stage(&s.at(), &[]).unwrap();
        let hash = commit(&s.at(), "First commit\n\n# kept: not a comment", false).unwrap();
        let status = status_of(&s.at()).unwrap();
        assert_eq!(status.head.as_deref(), Some(hash.as_str()));
        assert!(status.files.is_empty());
        let history = log(&s.at(), 20).unwrap();
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
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "base", false).unwrap();

        // Unstaged edit.
        s.write("app/pages/[id].vue", "<template>two</template>\n");
        let d = diff_of(&s.at(), "app/pages/[id].vue", false).unwrap();
        assert!(d.contains("-<template>one</template>") && d.contains("+<template>two</template>"), "{d}");
        assert_eq!(diff_of(&s.at(), "app/pages/[id].vue", true).unwrap(), "");
        // Brackets are literal: the decoy `i.vue` matches the glob but is not touched.
        stage(&s.at(), &["app/pages/[id].vue".into()]).unwrap();
        s.write("i.vue", "decoy changed\n");
        assert_eq!(s.codes("i.vue"), pair(None, Some("M")));
        assert_eq!(s.codes("app/pages/[id].vue"), pair(Some("M"), None));
        assert!(diff_of(&s.at(), "app/pages/[id].vue", true).unwrap().contains("+<template>two</template>"));
        assert_eq!(diff_of(&s.at(), "app/pages/[id].vue", false).unwrap(), "");

        // Untracked: all added, from the repository root or a subfolder.
        s.write("notes/to do.md", "- first\n- second\n");
        let d = diff_of(&s.at(), "notes/to do.md", false).unwrap();
        assert!(d.contains("new file mode") && d.contains("+- first") && d.contains("+- second"), "{d}");
        let sub = s.0.join("src");
        assert_eq!(diff_of(&At::local(&sub), "notes/to do.md", false).unwrap(), d);

        // Staged rename with an edit shows only the edit.
        s.git(&["mv", "src/keep.rs", "src/moved.rs"]);
        s.write("src/moved.rs", &body.replace("line 7\n", "line seven\n"));
        stage(&s.at(), &["src/moved.rs".into()]).unwrap();
        let entry = s.entry("src/moved.rs").unwrap();
        assert_eq!(entry.index.as_deref(), Some("R"));
        assert_eq!(entry.orig_path.as_deref(), Some("src/keep.rs"));
        let d = diff_of(&s.at(), "src/moved.rs", true).unwrap();
        assert!(d.contains("rename from src/keep.rs") && d.contains("+line seven"), "{d}");
        assert!(!d.contains("+line 1\n"), "{d}");

        // Binary files are a one-line notice.
        fs::write(s.0.join("blob.bin"), [0u8, 159, 146, 150, 0, 1, 2, 3]).unwrap();
        let d = diff_of(&s.at(), "blob.bin", false).unwrap();
        assert!(d.lines().any(|l| l.starts_with("Binary files ") && l.ends_with(" differ")), "{d}");

        // Oversized diffs are cut at a line boundary with the marker.
        let big: String = (0..60_000).map(|i| format!("row number {i:07}\n")).collect();
        s.write("big.txt", &big);
        let d = diff_of(&s.at(), "big.txt", false).unwrap();
        assert!(d.len() <= DIFF_CAP + DIFF_TRUNCATED.len() + 1, "{}", d.len());
        assert!(d.ends_with(&format!("\n{DIFF_TRUNCATED}\n")));
        assert!(d.len() > DIFF_CAP / 2);

        assert!(diff_of(&s.at(), "../escape", false).is_err());
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
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "base", false).unwrap();

        // Unstaged edit goes back to HEAD.
        s.write("tracked.txt", "v2\n");
        discard(&s.at(), &["tracked.txt".into()]).unwrap();
        assert_eq!(s.read("tracked.txt").as_deref(), Some("v1\n"));

        // Staged + unstaged: only the unstaged part goes; the staged version survives.
        s.write("both.txt", "staged\n");
        stage(&s.at(), &["both.txt".into()]).unwrap();
        s.write("both.txt", "unstaged\n");
        assert_eq!(s.codes("both.txt"), pair(Some("M"), Some("M")));
        discard(&s.at(), &["both.txt".into()]).unwrap();
        assert_eq!(s.read("both.txt").as_deref(), Some("staged\n"));
        assert_eq!(s.codes("both.txt"), pair(Some("M"), None));

        // A deleted file comes back.
        fs::remove_file(s.0.join("removed.txt")).unwrap();
        assert_eq!(s.codes("removed.txt"), pair(None, Some("D")));
        discard(&s.at(), &["removed.txt".into()]).unwrap();
        assert_eq!(s.read("removed.txt").as_deref(), Some("v1\n"));

        // Untracked file is deleted along with the folders made for it; its neighbour stays.
        s.write("new dir/deep/scratch file.txt", "x\n");
        s.write("new dir/keep.txt", "x\n");
        discard(&s.at(), &["new dir/deep/scratch file.txt".into()]).unwrap();
        assert!(!s.0.join("new dir/deep").exists());
        assert_eq!(s.read("new dir/keep.txt").as_deref(), Some("x\n"));

        // Brackets are not a glob: `pages/i.vue` keeps its edit.
        s.write("pages/[id].vue", "v2\n");
        s.write("pages/i.vue", "v2\n");
        discard(&s.at(), &["pages/[id].vue".into()]).unwrap();
        assert_eq!(s.read("pages/[id].vue").as_deref(), Some("v1\n"));
        assert_eq!(s.read("pages/i.vue").as_deref(), Some("v2\n"));

        // Staged-only new file: unstaged and deleted. Staged-only edit: back to HEAD.
        s.write("fresh.txt", "new\n");
        s.write("staged-edit.txt", "v2\n");
        stage(&s.at(), &["fresh.txt".into(), "staged-edit.txt".into()]).unwrap();
        discard(&s.at(), &["fresh.txt".into(), "staged-edit.txt".into()]).unwrap();
        assert!(!s.0.join("fresh.txt").exists());
        assert_eq!(s.entry("fresh.txt"), None);
        assert_eq!(s.read("staged-edit.txt").as_deref(), Some("v1\n"));
        assert_eq!(s.entry("staged-edit.txt"), None);

        // `add -N` placeholder: removed like an untracked file, not emptied.
        s.write("intent.txt", "content\n");
        s.git(&["add", "-N", "intent.txt"]);
        discard(&s.at(), &["intent.txt".into()]).unwrap();
        assert!(!s.0.join("intent.txt").exists());
        assert_eq!(s.entry("intent.txt"), None);

        // Paths that are clean, unknown or outside are left alone.
        discard(&s.at(), &["tracked.txt".into(), "no/such/file".into()]).unwrap();
        assert!(discard(&s.at(), &["../outside.txt".into()]).is_err());
        assert_eq!(s.read("tracked.txt").as_deref(), Some("v1\n"));

        // Discard everything: working-tree changes go, staged work is kept.
        s.write("tracked.txt", "again\n");
        s.write("loose.txt", "x\n");
        s.write("kept-staged.txt", "staged new\n");
        stage(&s.at(), &["kept-staged.txt".into()]).unwrap();
        discard(&s.at(), &[]).unwrap();
        let status = status_of(&s.at()).unwrap();
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
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "base", false).unwrap();

        s.git(&["mv", "old name.txt", "new name.txt"]);
        assert_eq!(s.entry("new name.txt").unwrap().orig_path.as_deref(), Some("old name.txt"));
        unstage(&s.at(), &["new name.txt".into()]).unwrap();
        assert_eq!(s.codes("old name.txt"), pair(None, Some("D")));
        assert_eq!(s.codes("new name.txt"), pair(None, Some("?")));

        // And discarding a staged rename puts the original back.
        stage(&s.at(), &[]).unwrap();
        discard(&s.at(), &["new name.txt".into()]).unwrap();
        assert!(status_of(&s.at()).unwrap().files.is_empty());
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
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "base", false).unwrap();
        let main = status_of(&s.at()).unwrap().branch.unwrap();

        checkout(&s.at(), "feat/side panel", true).unwrap_err();
        assert!(checkout(&s.at(), "-x", true).is_err());
        checkout(&s.at(), "feat/panel", true).unwrap();
        let b = branches(&s.at()).unwrap();
        assert_eq!(b.current.as_deref(), Some("feat/panel"));
        assert!(b.local.contains(&main) && b.local.contains(&"feat/panel".to_string()));

        s.write("a.txt", "theirs\n");
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "side", false).unwrap();
        let amended = commit(&s.at(), "side, reworded", true).unwrap();
        let history = log(&s.at(), 1).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].subject, "side, reworded");
        assert_eq!(history[0].short_hash, amended);

        checkout(&s.at(), &main, false).unwrap();
        assert_eq!(s.read("a.txt").as_deref(), Some("base\n"));
        s.write("a.txt", "ours\n");
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "main side", false).unwrap();
        assert_eq!(log(&s.at(), 20).unwrap().len(), 2);

        // A real conflict: reported as such, and neither discard nor unstage touches it.
        let merge = git(&s.at()).args(["merge", "feat/panel"]).run().unwrap();
        assert!(!merge.ok());
        let entry = s.entry("a.txt").unwrap();
        assert!(entry.conflicted);
        assert!(discard(&s.at(), &["a.txt".into()]).unwrap_err().contains("merge conflicts"));
        discard(&s.at(), &[]).unwrap();
        unstage(&s.at(), &[]).unwrap();
        assert!(s.entry("a.txt").unwrap().conflicted);
        assert!(s.read("a.txt").unwrap().contains("<<<<<<<"));
        let err = commit(&s.at(), "merge", false).unwrap_err();
        assert!(err.contains("merge conflicts"), "{err}");
        assert!(diff_of(&s.at(), "a.txt", false).unwrap().contains("@@@"));

        // Staging the resolved file ends the conflict and the merge can be committed.
        s.write("a.txt", "resolved\n");
        stage(&s.at(), &["a.txt".into()]).unwrap();
        commit(&s.at(), "Merge feat/panel", false).unwrap();
        assert!(status_of(&s.at()).unwrap().files.is_empty());

        // Detached HEAD has no branch.
        let first = log(&s.at(), 20).unwrap().last().unwrap().hash.clone();
        s.git(&["checkout", "-q", "--detach", &first]);
        let status = status_of(&s.at()).unwrap();
        assert_eq!(status.branch, None);
        assert!(first.starts_with(status.head.as_deref().unwrap()));
        assert_eq!(branches(&s.at()).unwrap().current, None);
        assert!(push(&s.at()).unwrap_err().contains("detached"));
    }

    #[test]
    fn sync_with_a_local_remote() {
        if !have_git() {
            return;
        }
        let s = Scratch::repo();
        s.write("a.txt", "one\n");
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "one", false).unwrap();
        let branch = status_of(&s.at()).unwrap().branch.unwrap();

        // No remote at all: a readable error, not a silent success.
        assert!(fetch(&s.at()).unwrap_err().contains("no remote"));
        assert!(push(&s.at()).unwrap_err().contains("no remote"));

        // A bare repository next door stands in for the server.
        let remote = Scratch::new();
        git(&remote.at()).args(["init", "-q", "--bare"]).run_ok("init").unwrap();
        s.git(&["remote", "add", "origin", remote.path()]);
        assert!(pull(&s.at()).unwrap_err().contains("Publish it first"));

        // First push publishes and starts tracking.
        push(&s.at()).unwrap();
        let status = status_of(&s.at()).unwrap();
        assert_eq!(status.upstream.as_deref(), Some(format!("origin/{branch}").as_str()));
        assert_eq!((status.ahead, status.behind), (0, 0));

        s.write("a.txt", "two\n");
        stage(&s.at(), &[]).unwrap();
        commit(&s.at(), "two", false).unwrap();
        assert_eq!(status_of(&s.at()).unwrap().ahead, 1);
        push(&s.at()).unwrap();
        assert_eq!(status_of(&s.at()).unwrap().ahead, 0);

        // A second clone pushes; the first sees it after fetch and gets it with pull.
        let other = Scratch::new();
        // The bare repository's own HEAD may name a different default branch.
        git(&other.at())
            .args(["clone", "-q", "-b", branch.as_str(), remote.path(), "."])
            .run_ok("clone")
            .unwrap();
        other.git(&["config", "user.name", "Other"]);
        other.git(&["config", "user.email", "other@mango.invalid"]);
        other.git(&["config", "commit.gpgsign", "false"]);
        other.write("b.txt", "from other\n");
        stage(&other.at(), &[]).unwrap();
        commit(&other.at(), "other", false).unwrap();
        push(&other.at()).unwrap();

        fetch(&s.at()).unwrap();
        assert_eq!(status_of(&s.at()).unwrap().behind, 1);
        pull(&s.at()).unwrap();
        assert_eq!(s.read("b.txt").as_deref(), Some("from other\n"));
        assert_eq!(status_of(&s.at()).unwrap().behind, 0);
    }
}
