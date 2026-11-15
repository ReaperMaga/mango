//! Detection of installed coding agents (Claude Code, Codex).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

const AGENTS: [(&str, &str, &str); 2] = [
    ("claude", "Claude Code", "claude"),
    ("codex", "Codex", "codex"),
];

fn detect(id: &str, name: &str, binary: &str) -> AgentInfo {
    let path = crate::bin::find(binary);
    AgentInfo {
        id: id.to_string(),
        name: name.to_string(),
        installed: path.is_some(),
        version: path.as_deref().and_then(version_of),
        path: path.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// First line of `<bin> --version`, or `None` on failure or after the timeout.
pub(crate) fn version_of(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    crate::bin::hide_console(&mut cmd);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Node-based CLIs need `node` on PATH, which a GUI launch may lack.
    if let Some(path) = crate::bin::augmented_path(bin.parent()) {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().ok()?;

    let deadline = Instant::now() + VERSION_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    first_line(&out)
}

pub(crate) fn first_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

#[tauri::command]
pub async fn detect_agents() -> Result<Vec<AgentInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // Probe both in parallel so the worst case is one timeout, not two.
        std::thread::scope(|s| {
            let handles: Vec<_> = AGENTS
                .iter()
                .map(|&(id, name, bin)| s.spawn(move || detect(id, name, bin)))
                .collect();
            handles
                .into_iter()
                .zip(AGENTS)
                .map(|(h, (id, name, _))| {
                    h.join().unwrap_or_else(|_| AgentInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                        installed: false,
                        version: None,
                        path: None,
                    })
                })
                .collect()
        })
    })
    .await
    .map_err(|e| format!("Agent detection failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::first_line;

    #[test]
    fn version_first_line() {
        assert_eq!(
            first_line("2.0.14 (Claude Code)\n").as_deref(),
            Some("2.0.14 (Claude Code)")
        );
        assert_eq!(
            first_line("\n  codex-cli 0.46.0  \nextra\n").as_deref(),
            Some("codex-cli 0.46.0")
        );
        assert_eq!(first_line("  \n"), None);
    }
}
