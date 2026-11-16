//! Process bridge for coding-agent CLIs (Claude Code, Codex).
//!
//! The frontend owns the protocols (stream-json, JSON-RPC); this module only
//! starts the CLI, forwards its stdout/stderr line by line as events, and
//! writes to its stdin. Only the known agent binaries can be started.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct Proc {
    stdin: Option<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: u32,
}

#[derive(Default)]
pub struct AgentProcState(Mutex<HashMap<String, Proc>>);

impl AgentProcState {
    pub fn kill_all(&self) {
        let procs: Vec<Proc> = self.0.lock().unwrap().drain().map(|(_, p)| p).collect();
        for p in procs {
            kill_tree(p.pid, &p.child);
        }
    }
}

#[derive(Clone, Serialize)]
struct LineEvent<'a> {
    id: &'a str,
    line: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent<'a> {
    id: &'a str,
    code: Option<i32>,
}

/// The binary name for a known agent id. Anything else is refused.
pub fn binary_for(agent: &str) -> Result<&'static str, String> {
    match agent {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        other => Err(format!("Unknown agent \"{other}\"")),
    }
}

/// Kill a process and everything it started (agents run shells and tools).
fn kill_tree(pid: u32, child: &Arc<Mutex<Child>>) {
    #[cfg(unix)]
    {
        // The child leads its own process group (see `process_group(0)` below).
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        crate::bin::hide_console(&mut cmd);
        let _ = cmd
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = pid;
    if let Ok(mut c) = child.lock() {
        let _ = c.kill();
    }
}

fn pump<R: Read + Send + 'static>(app: AppHandle, id: String, event: &'static str, reader: R) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::with_capacity(64 * 1024, reader);
        let mut buf = Vec::with_capacity(8 * 1024);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n' | b'\r')) {
                        buf.pop();
                    }
                    if buf.is_empty() {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    let _ = app.emit(event, LineEvent { id: &id, line });
                }
            }
        }
    })
}

#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentProcState>,
    agent: String,
    args: Vec<String>,
    cwd: String,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let name = binary_for(&agent)?;
    let bin = crate::bin::find(name)
        .ok_or_else(|| format!("{name} was not found. Install it, then check Settings > Agents."))?;

    // No folder: questions that need no project (usage limits) run in the home folder.
    let cwd = if cwd.trim().is_empty() {
        dirs::home_dir().ok_or("Could not find the home folder to start the agent in.")?
    } else {
        std::path::PathBuf::from(cwd)
    };

    let mut cmd = Command::new(&bin);
    crate::bin::hide_console(&mut cmd);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = crate::bin::augmented_path(bin.parent()) {
        cmd.env("PATH", path);
    }
    if let Some(env) = env {
        cmd.envs(env);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", bin.display()))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("No stdout from the agent process")?;
    let stderr = child.stderr.take().ok_or("No stderr from the agent process")?;
    let child = Arc::new(Mutex::new(child));

    let id = uuid::Uuid::new_v4().to_string();
    state.0.lock().unwrap().insert(
        id.clone(),
        Proc { stdin, child: child.clone(), pid },
    );

    let out = pump(app.clone(), id.clone(), "agent://stdout", stdout);
    let err = pump(app.clone(), id.clone(), "agent://stderr", stderr);

    // Reaper: once both streams hit EOF, collect the exit code and announce it.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let _ = out.join();
            let _ = err.join();
            let code = child.lock().ok().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
            if let Some(state) = tauri::Manager::try_state::<AgentProcState>(&app) {
                state.0.lock().unwrap().remove(&id);
            }
            let _ = app.emit("agent://exit", ExitEvent { id: &id, code });
        });
    }

    Ok(id)
}

#[tauri::command]
pub async fn agent_write(state: State<'_, AgentProcState>, id: String, data: String) -> Result<(), String> {
    let mut procs = state.0.lock().unwrap();
    let proc = procs.get_mut(&id).ok_or("The agent process is no longer running")?;
    let stdin = proc.stdin.as_mut().ok_or("The agent's input is closed")?;
    stdin
        .write_all(data.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Could not write to the agent: {e}"))
}

/// Close stdin so a CLI reading a stream of input knows no more is coming.
#[tauri::command]
pub async fn agent_close_stdin(state: State<'_, AgentProcState>, id: String) -> Result<(), String> {
    if let Some(proc) = state.0.lock().unwrap().get_mut(&id) {
        proc.stdin = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_kill(state: State<'_, AgentProcState>, id: String) -> Result<(), String> {
    let proc = state.0.lock().unwrap().remove(&id);
    if let Some(p) = proc {
        kill_tree(p.pid, &p.child);
    }
    Ok(())
}
