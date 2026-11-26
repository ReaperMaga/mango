//! The git calls plugins need: clone, fetch, reset, read a file at a commit.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use super::validate::is_sha_like;

/// Lines of git's stderr kept for an error message.
const ERROR_LINES: usize = 6;

/// git with the settings every plugin call gets: no `ext::` transport, no symlinks checked out
/// (a plugin folder must not point outside itself), never a credential prompt nobody sees.
/// Local (`file`) transports are refused outside tests: plugin sources are remote.
pub fn git() -> Command {
    let mut cmd = Command::new(crate::bin::git());
    crate::bin::hide_console(&mut cmd);
    cmd.args(["-c", "protocol.ext.allow=never", "-c", "core.symlinks=false"]);
    if !cfg!(test) {
        cmd.args(["-c", "protocol.file.allow=never"]);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());
    cmd
}

fn spawn_error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "git is not installed or not on PATH".to_string(),
        _ => format!("Could not run git: {e}"),
    }
}

/// Runs git in `dir` and returns its stdout (trimmed), or its stderr as the error.
pub fn run(dir: &Path, args: &[&str], what: &str) -> Result<String, String> {
    let out = git()
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(spawn_error)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("{what} failed ({})", out.status) } else { format!("{what} failed: {err}") })
    }
}

/// Runs a git command whose stderr is progress, passing each line to `progress`.
fn stream(mut cmd: Command, what: &str, progress: &dyn Fn(&str)) -> Result<(), String> {
    let mut child = cmd.stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(spawn_error)?;
    let mut tail: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for_each_line(stderr, |line| {
            progress(line);
            if !line.contains('%') {
                // progress meters are noise in an error
                tail.push(line.to_string());
                if tail.len() > ERROR_LINES {
                    tail.remove(0);
                }
            }
        });
    }
    let status = child.wait().map_err(|e| format!("{what} did not finish: {e}"))?;
    if status.success() {
        return Ok(());
    }
    let detail = tail.join("\n");
    Err(if detail.is_empty() { format!("{what} failed ({status})") } else { format!("{what} failed:\n{detail}") })
}

/// Calls `f` for every non-empty line, splitting on both `\r` and `\n` (git redraws progress
/// meters with `\r`). The same as `projects.rs` does for `git_clone`.
fn for_each_line(mut source: impl Read, mut f: impl FnMut(&str)) {
    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::new();
    let mut flush = |line: &mut Vec<u8>| {
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end();
        if !text.is_empty() {
            f(text);
        }
        line.clear();
    };
    loop {
        match source.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\r' || b == b'\n' {
                        flush(&mut line);
                    } else {
                        line.push(b);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    flush(&mut line);
}

/// Clones `url` at `reference` into `dest` (which must not exist yet), shallowly when it can.
/// A commit can't be cloned with `--branch`: then the whole repository is cloned and checked out.
pub fn clone(url: &str, reference: Option<&str>, dest: &Path, progress: &dyn Fn(&str)) -> Result<(), String> {
    let mut cmd = git();
    cmd.args(["clone", "--depth", "1", "--progress"]);
    if let Some(r) = reference {
        cmd.args(["--branch", r]);
    }
    cmd.arg("--").arg(url).arg(dest);
    match stream(cmd, "git clone", progress) {
        Ok(()) => Ok(()),
        Err(e) => {
            let Some(sha) = reference.filter(|r| is_sha_like(r)) else {
                return Err(e);
            };
            let _ = super::store::remove_tree(dest);
            let mut cmd = git();
            cmd.args(["clone", "--no-checkout", "--progress", "--"]).arg(url).arg(dest);
            stream(cmd, "git clone", progress)?;
            run(dest, &["checkout", "--force", "--detach", sha, "--"], "git checkout")
                .map_err(|e| format!("The repository has no commit {sha}: {e}"))?;
            Ok(())
        }
    }
}

/// Fetches the latest commit of `reference` (or the default branch) into FETCH_HEAD and returns it.
pub fn fetch(repo: &Path, reference: Option<&str>, progress: &dyn Fn(&str)) -> Result<String, String> {
    let mut cmd = git();
    cmd.arg("-C").arg(repo).args(["fetch", "--depth", "1", "--progress", "origin", reference.unwrap_or("HEAD")]);
    stream(cmd, "git fetch", progress)?;
    run(repo, &["rev-parse", "FETCH_HEAD"], "git rev-parse")
}

/// The commit a pinned ref names, in a repository that has it.
pub fn resolve(repo: &Path, reference: &str) -> Result<String, String> {
    run(repo, &["rev-parse", "--verify", "--end-of-options", &format!("{reference}^{{commit}}")], "git rev-parse")
}

pub fn head(repo: &Path) -> Result<String, String> {
    run(repo, &["rev-parse", "HEAD"], "git rev-parse")
}

/// Moves the checkout to `commit`, dropping anything else in the folder.
pub fn reset_to(repo: &Path, commit: &str) -> Result<(), String> {
    run(repo, &["reset", "--hard", "--quiet", commit], "git reset")?;
    run(repo, &["clean", "-ffdxq"], "git clean")?;
    Ok(())
}

/// The `version` of the manifest at `<subpath>/mango-plugin.json` in `commit`, if it can be read.
pub fn version_at(repo: &Path, commit: &str, subpath: &str) -> Option<String> {
    let file = if subpath.is_empty() {
        super::validate::MANIFEST_FILE.to_string()
    } else {
        format!("{subpath}/{}", super::validate::MANIFEST_FILE)
    };
    let text = run(repo, &["show", &format!("{commit}:{file}")], "git show").ok()?;
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    v.get("version")?.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
