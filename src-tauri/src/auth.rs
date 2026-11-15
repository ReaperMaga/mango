//! Sign-in state of the agent CLIs. Signing in itself is interactive, so the
//! frontend runs `<cli> login` in a terminal (see `pty_spawn`'s `command`).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub agent: String,
    pub installed: bool,
    pub logged_in: bool,
    /// e.g. the account email, when the CLI reports one.
    pub account: Option<String>,
    /// e.g. "max", "pro", when the CLI reports one.
    pub plan: Option<String>,
    /// How the CLI is authenticated, e.g. "claude.ai", "ChatGPT", "API key".
    pub method: Option<String>,
    /// Raw first line of the CLI's status output, for display when nothing else parses.
    pub detail: Option<String>,
}

/// Run a CLI to completion with a timeout. Returns (success, stdout, stderr).
pub fn run_capture(bin: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String, String)> {
    let mut cmd = Command::new(bin);
    crate::bin::hide_console(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = crate::bin::augmented_path(bin.parent()) {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    Some((status.map(|s| s.success()).unwrap_or(false), stdout, stderr))
}

fn first_line(s: &str) -> Option<String> {
    s.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

fn parse_claude(stdout: &str, status: &mut AuthStatus) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout) {
        status.logged_in = v.get("loggedIn").and_then(|b| b.as_bool()).unwrap_or(false);
        let text = |k: &str| v.get(k).and_then(|s| s.as_str()).map(str::to_string);
        status.account = text("email");
        status.plan = text("subscriptionType");
        status.method = text("authMethod");
    } else {
        let lower = stdout.to_lowercase();
        status.logged_in = lower.contains("logged in") && !lower.contains("not logged in");
        status.detail = first_line(stdout);
    }
}

fn parse_codex(ok: bool, stdout: &str, stderr: &str, status: &mut AuthStatus) {
    // `codex login status` prints e.g. "Logged in using ChatGPT" or "Not logged in".
    let line = first_line(stdout).or_else(|| first_line(stderr)).unwrap_or_default();
    let lower = line.to_lowercase();
    status.logged_in = ok && lower.contains("logged in") && !lower.contains("not logged in");
    if status.logged_in {
        status.method = line
            .split_once("using ")
            .map(|(_, m)| m.trim().trim_end_matches('.').to_string());
    }
    status.detail = Some(line).filter(|l| !l.is_empty());
}

fn status_of(agent: &str) -> Result<AuthStatus, String> {
    let name = crate::agent_proc::binary_for(agent)?;
    let mut status = AuthStatus { agent: agent.to_string(), ..Default::default() };
    let Some(bin) = crate::bin::find(name) else { return Ok(status) };
    status.installed = true;

    let args: &[&str] = if agent == "claude" { &["auth", "status"] } else { &["login", "status"] };
    match run_capture(&bin, args, Duration::from_secs(10)) {
        Some((ok, stdout, stderr)) => {
            if agent == "claude" {
                parse_claude(&stdout, &mut status);
                if status.detail.is_none() && !status.logged_in {
                    status.detail = first_line(&stderr);
                }
            } else {
                parse_codex(ok, &stdout, &stderr, &mut status);
            }
        }
        None => status.detail = Some(format!("{name} did not answer in time")),
    }
    Ok(status)
}

#[tauri::command]
pub async fn agent_auth_status(agent: String) -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_of(&agent))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_logout(agent: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = crate::agent_proc::binary_for(&agent)?;
        let bin = crate::bin::find(name).ok_or_else(|| format!("{name} is not installed"))?;
        let args: &[&str] = if agent == "claude" { &["auth", "logout"] } else { &["logout"] };
        match run_capture(&bin, args, Duration::from_secs(15)) {
            Some((true, _, _)) => Ok(()),
            Some((false, out, err)) => Err(first_line(&err).or_else(|| first_line(&out)).unwrap_or_else(|| "Sign-out failed".into())),
            None => Err(format!("{name} did not answer in time")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_json() {
        let mut s = AuthStatus::default();
        parse_claude(r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"}"#, &mut s);
        assert!(s.logged_in);
        assert_eq!(s.account.as_deref(), Some("a@b.c"));
        assert_eq!(s.plan.as_deref(), Some("max"));
    }

    #[test]
    fn parses_codex_lines() {
        let mut s = AuthStatus::default();
        parse_codex(true, "Logged in using ChatGPT\n", "", &mut s);
        assert!(s.logged_in);
        assert_eq!(s.method.as_deref(), Some("ChatGPT"));
        let mut s = AuthStatus::default();
        parse_codex(false, "", "Not logged in\n", &mut s);
        assert!(!s.logged_in);
    }
}
