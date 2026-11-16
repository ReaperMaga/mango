//! Process bridge for coding-agent CLIs (Claude Code, Codex).
//!
//! The frontend owns the protocols (stream-json, JSON-RPC); this module only
//! starts the CLI, forwards its stdout/stderr line by line as events, and
//! writes to its stdin. Only the known agent binaries can be started.
//!
//! A run can also happen inside a remote environment (an Incus instance on a
//! master server): then the local process is `ssh … incus exec … -T -- <cli>`
//! and the pipes are the same, only longer. See [`remote`] for how such a run
//! is stopped.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::envs::{self, hosts, ssh, EnvHost, EnvRemote};

struct Proc {
    stdin: Option<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: u32,
    /// Set for runs inside a remote environment.
    remote: Option<remote::Run>,
}

#[derive(Default)]
pub struct AgentProcState(Mutex<HashMap<String, Proc>>);

impl AgentProcState {
    /// Stop every run; used when the app exits. Remote runs are stopped inside
    /// their instance too, waiting a few seconds at most (the `ssh` calls keep
    /// going on their own if the app is gone first).
    pub fn kill_all(&self) {
        let procs: Vec<Proc> = self.0.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, p)| p).collect();
        let (tx, rx) = mpsc::channel::<()>();
        let mut pending = 0;
        for p in procs {
            kill_tree(p.pid, &p.child);
            if let Some(run) = p.remote {
                pending += 1;
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let _ = run.stop(Duration::from_secs(20));
                    let _ = tx.send(());
                });
            }
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        while pending > 0 {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(()) => pending -= 1,
                Err(_) => break,
            }
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

/// Read `reader` line by line (without the line ending, skipping empty lines) until EOF.
fn pump<R: Read + Send + 'static>(reader: R, mut each: impl FnMut(String) + Send + 'static) -> std::thread::JoinHandle<()> {
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
                    each(String::from_utf8_lossy(&buf).into_owned());
                }
            }
        }
    })
}

fn emit_line(app: &AppHandle, event: &str, id: &str, line: String) {
    let _ = app.emit(event, LineEvent { id, line });
}

#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentProcState>,
    agent: String,
    args: Vec<String>,
    cwd: String,
    env: Option<HashMap<String, String>>,
    remote: Option<EnvRemote>,
) -> Result<String, String> {
    let name = binary_for(&agent)?;
    let id = uuid::Uuid::new_v4().to_string();

    let (mut cmd, run) = match remote {
        Some(target) => {
            let host = {
                let app = app.clone();
                let host_id = target.host_id.clone();
                envs::blocking(move || hosts::get(&app, &host_id)).await?
            };
            let line = remote::spawn_line(&host, &target.instance, &cwd, env, &id, name, &args)?;
            let cmd = ssh::command(&ssh::argv(&host, ssh::Mode::Batch, &line)?);
            (cmd, Some(remote::Run { host, instance: target.instance, id: id.clone() }))
        }
        None => (local_command(name, &args, &cwd, env)?, None),
    };

    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| match &run {
        Some(_) => format!("Could not start ssh: {e}"),
        None => format!("Could not start {name}: {e}"),
    })?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("No stdout from the agent process")?;
    let stderr = child.stderr.take().ok_or("No stderr from the agent process")?;
    let child = Arc::new(Mutex::new(child));

    state.0.lock().unwrap_or_else(|e| e.into_inner()).insert(
        id.clone(),
        Proc { stdin, child: child.clone(), pid, remote: run.clone() },
    );

    // What the reaper needs to explain a remote run that failed before it started.
    let saw_stdout = Arc::new(AtomicBool::new(false));
    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));

    let out = {
        let (app, id, saw) = (app.clone(), id.clone(), saw_stdout.clone());
        pump(stdout, move |line| {
            saw.store(true, Ordering::Relaxed);
            emit_line(&app, "agent://stdout", &id, line);
        })
    };
    let err = {
        let (app, id, tail) = (app.clone(), id.clone(), stderr_tail.clone());
        pump(stderr, move |line| {
            if let Ok(mut t) = tail.lock() {
                if t.len() == 20 {
                    t.remove(0);
                }
                t.push(line.clone());
            }
            emit_line(&app, "agent://stderr", &id, line);
        })
    };

    // Reaper: once both streams hit EOF, collect the exit code and announce it.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let _ = out.join();
            let _ = err.join();
            let code = child.lock().ok().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
            // Still registered: it ended on its own rather than through `agent_kill`.
            let ended_itself = tauri::Manager::try_state::<AgentProcState>(&app)
                .and_then(|state| state.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id))
                .is_some();
            // Stopped on request: nothing to explain, and `agent_kill` already stops it remotely.
            if let Some(run) = run.filter(|_| ended_itself) {
                let saw = saw_stdout.load(Ordering::Relaxed);
                let tail = stderr_tail.lock().map(|t| t.join("\n")).unwrap_or_default();
                if let Some(hint) = remote::hint(&run.host, &run.instance, name, code, &tail, saw) {
                    emit_line(&app, "agent://stderr", &id, hint);
                }
                // The connection dropped mid-run: the CLI may still be working in the instance.
                if saw && matches!(code, Some(255) | None) {
                    std::thread::spawn(move || {
                        let _ = run.stop(Duration::from_secs(30));
                    });
                }
            }
            let _ = app.emit("agent://exit", ExitEvent { id: &id, code });
        });
    }

    Ok(id)
}

/// The agent CLI on this computer.
fn local_command(name: &str, args: &[String], cwd: &str, env: Option<HashMap<String, String>>) -> Result<Command, String> {
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
    cmd.args(args).current_dir(&cwd);
    if let Some(path) = crate::bin::augmented_path(bin.parent()) {
        cmd.env("PATH", path);
    }
    if let Some(env) = env {
        cmd.envs(env);
    }
    Ok(cmd)
}

#[tauri::command]
pub async fn agent_write(state: State<'_, AgentProcState>, id: String, data: String) -> Result<(), String> {
    let mut procs = state.0.lock().unwrap_or_else(|e| e.into_inner());
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
    if let Some(proc) = state.0.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&id) {
        proc.stdin = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_kill(state: State<'_, AgentProcState>, id: String) -> Result<(), String> {
    let proc = state.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if let Some(p) = proc {
        kill_tree(p.pid, &p.child);
        // Best effort, in the background: the local ssh is already gone, so the UI is not kept waiting.
        if let Some(run) = p.remote {
            std::thread::spawn(move || {
                let _ = run.stop(Duration::from_secs(30));
            });
        }
    }
    Ok(())
}

/// Agent runs inside an Incus instance.
///
/// Stopping one: killing the local `ssh` does not reliably stop the CLI in the
/// instance. With `ssh -T` the master's sshd only closes the pipes of the
/// `incus` client there; that client notices when it next writes output (and
/// dies of SIGPIPE), and only then does incusd see the exec websockets close
/// and SIGKILL the command, which is only the top process (`runuser`), not the
/// CLI below it or the tools it started. An idle CLI never writes, so it can
/// linger indefinitely. So every remote run is tagged with `MANGO_RUN=<run id>`
/// in its environment (inherited by everything it starts), and stopping it runs
/// [`STOP_SCRIPT`] in the instance as root: TERM every process carrying the tag
/// and all their descendants, then KILL what is left after a few seconds.
mod remote {
    use super::*;

    /// The environment variable that marks every process of one run.
    pub const RUN_TAG: &str = "MANGO_RUN";

    /// `sh -c` script, `$1` = run id. Finds the tagged processes through
    /// `/proc/*/environ` (no PID file to go stale or be reused), adds their
    /// descendants (in case a tool cleared its environment), TERMs them, and
    /// KILLs any still there after ~3 s.
    pub const STOP_SCRIPT: &str = r#"tag="MANGO_RUN=$1"
tree() {
  roots=""
  for d in /proc/[0-9]*; do
    grep -qzxF -- "$tag" "$d/environ" 2>/dev/null && roots="$roots ${d#/proc/}"
  done
  [ -n "$roots" ] || return 0
  cat /proc/[0-9]*/status 2>/dev/null | awk -v roots="$roots" '
    /^Pid:/ { pid = $2 }
    /^PPid:/ { parent[pid] = $2 }
    END {
      n = split(roots, r, " "); for (i = 1; i <= n; i++) keep[r[i]] = 1
      do { more = 0; for (p in parent) if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; more = 1 } } while (more)
      for (p in keep) print p
    }'
}
pids=$(tree)
[ -n "$pids" ] || exit 0
kill -TERM $pids 2>/dev/null
i=0
while [ $i -lt 12 ]; do
  sleep 0.25
  pids=$(tree)
  [ -n "$pids" ] || exit 0
  i=$((i + 1))
done
kill -KILL $pids 2>/dev/null
exit 0"#;

    #[derive(Clone)]
    pub struct Run {
        pub host: EnvHost,
        pub instance: String,
        /// The run id, which is also the `MANGO_RUN` tag.
        pub id: String,
    }

    impl Run {
        /// Stop the run's processes inside the instance (blocking, up to `timeout`).
        pub fn stop(&self, timeout: Duration) -> Result<(), String> {
            ssh::run(&self.host, &stop_line(&self.host, &self.instance, &self.id), timeout).map(|_| ())
        }
    }

    /// The master-side argv of [`STOP_SCRIPT`] for one run.
    pub fn stop_line(host: &EnvHost, instance: &str, run_id: &str) -> Vec<String> {
        let inner: Vec<String> = vec!["sh".into(), "-c".into(), STOP_SCRIPT.into(), "mango-stop".into(), run_id.into()];
        ssh::incus_exec(host, instance, ssh::Mode::Batch, &inner)
    }

    /// The master-side argv starting `program args…` as the agent user inside
    /// `instance`, from `cwd` (the agent's home when empty), tagged with the run id.
    pub fn spawn_line(
        host: &EnvHost,
        instance: &str,
        cwd: &str,
        env: Option<HashMap<String, String>>,
        run_id: &str,
        program: &str,
        args: &[String],
    ) -> Result<Vec<String>, String> {
        envs::valid_instance(instance)?;
        let cwd = cwd.trim();
        let cwd = if cwd.is_empty() {
            None
        } else {
            envs::valid_instance_dir(cwd)?;
            Some(cwd)
        };
        let mut vars: Vec<(String, String)> = Vec::new();
        for (k, v) in env.unwrap_or_default() {
            if !envs::valid_env_key(&k) || k == RUN_TAG {
                return Err(format!("\"{k}\" can't be passed to an agent in an environment."));
            }
            if v.contains('\0') {
                return Err(format!("The value of {k} contains a NUL character."));
            }
            vars.push((k, v));
        }
        vars.sort();
        vars.push((RUN_TAG.to_string(), run_id.to_string()));
        if args.iter().any(|a| a.contains('\0')) {
            return Err("An argument for the agent contains a NUL character.".into());
        }
        let mut argv = vec![program.to_string()];
        argv.extend(args.iter().cloned());
        Ok(ssh::incus_exec(host, instance, ssh::Mode::Batch, &ssh::as_agent(cwd, &vars, &argv)))
    }

    /// A `Mango: …` line explaining why a remote run ended, when it is not
    /// already clear from what it printed. `stderr` is its last stderr lines.
    pub fn hint(
        host: &EnvHost,
        instance: &str,
        program: &str,
        code: Option<i32>,
        stderr: &str,
        saw_stdout: bool,
    ) -> Option<String> {
        let lower = stderr.to_lowercase();
        let first = |s: String| s.lines().next().unwrap_or_default().to_string();
        if saw_stdout {
            // It ran; only a dropped connection needs saying.
            return (code == Some(255)).then(|| {
                format!("Mango: the SSH connection to {} was lost, so this run was stopped.", host.name)
            });
        }
        if code == Some(255) {
            return Some(format!("Mango: {}", first(ssh::explain(host, code, stderr, ""))));
        }
        if lower.contains("incus: command not found") || lower.contains("incus: not found") {
            return Some(format!("Mango: {}", first(ssh::explain(host, code, stderr, ""))));
        }
        if lower.contains("instance is not running") {
            return Some(format!("Mango: the environment {instance} is not running. Start it under Environments, then try again."));
        }
        if lower.contains("instance not found") || lower.contains("error: not found") {
            return Some(format!("Mango: there is no environment named {instance} on {} any more.", host.name));
        }
        if code == Some(127) && lower.contains(&format!("{program}: not found")) {
            return Some(format!(
                "Mango: {program} is not installed in the environment {instance}. Install it from the environment's components, then try again."
            ));
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn host() -> EnvHost {
            EnvHost {
                id: "h".into(),
                name: "Lab".into(),
                ssh: "me@lab".into(),
                port: None,
                identity_file: None,
                incus_remote: Some("os1".into()),
                tailscale: None,
            }
        }

        #[test]
        fn spawn_line_runs_the_cli_as_agent_tagged() {
            let env = HashMap::from([("B".to_string(), "2".to_string()), ("A".to_string(), "x y".to_string())]);
            let args = ["-p".to_string(), "--output-format".into(), "stream-json".into()];
            let argv = spawn_line(&host(), "dev", "/home/agent/work/my app", Some(env), "run-1", "claude", &args).unwrap();
            let l = ssh::line(&argv);
            assert!(l.starts_with("incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent"), "{l}");
            assert!(l.contains(" 'A=x y' B=2 MANGO_RUN=run-1 bash -lc "), "{l}");
            assert!(l.ends_with("mango '/home/agent/work/my app' claude -p --output-format stream-json"), "{l}");

            // No folder: the agent's home.
            let l = ssh::line(&spawn_line(&host(), "dev", " ", None, "r", "codex", &[]).unwrap());
            assert!(l.ends_with("mango /home/agent codex"), "{l}");
        }

        #[test]
        fn spawn_line_refuses_bad_input() {
            let h = host();
            assert!(spawn_line(&h, "dev;rm", "", None, "r", "claude", &[]).is_err());
            assert!(spawn_line(&h, "dev", "work", None, "r", "claude", &[]).is_err());
            assert!(spawn_line(&h, "dev", "/a/../etc", None, "r", "claude", &[]).is_err());
            let bad_key = HashMap::from([("A=B".to_string(), "x".to_string())]);
            assert!(spawn_line(&h, "dev", "", Some(bad_key), "r", "claude", &[]).is_err());
            let tag = HashMap::from([(RUN_TAG.to_string(), "other".to_string())]);
            assert!(spawn_line(&h, "dev", "", Some(tag), "r", "claude", &[]).is_err());
            assert!(spawn_line(&h, "dev", "", None, "r", "claude", &["a\0b".into()]).is_err());
        }

        #[test]
        fn stop_line_targets_the_run() {
            let l = ssh::line(&stop_line(&host(), "dev", "6f1c-77"));
            assert!(l.starts_with("incus exec os1:dev -T -- sh -c '"), "{l}");
            assert!(l.ends_with("' mango-stop 6f1c-77"), "{l}");
            assert!(STOP_SCRIPT.contains(&format!("{RUN_TAG}=$1")));
            // The awk program's quotes survive the master's shell as one word.
            assert!(l.contains(r"awk -v roots=") && l.contains(r"'\''"), "{l}");
        }

        #[test]
        fn hints() {
            let h = host();
            let denied = "me@lab: Permission denied (publickey).";
            let m = hint(&h, "dev", "claude", Some(255), denied, false).unwrap();
            assert!(m.starts_with("Mango: Lab refused the SSH sign-in."), "{m}");
            assert!(!m.contains('\n'));
            let m = hint(&h, "dev", "claude", Some(1), "Error: Instance is not running", false).unwrap();
            assert!(m.contains("dev is not running"), "{m}");
            let m = hint(&h, "dev", "claude", Some(127), "mango: line 1: exec: claude: not found", false).unwrap();
            assert!(m.contains("claude is not installed"), "{m}");
            assert!(hint(&h, "dev", "claude", Some(255), "", true).unwrap().contains("connection to Lab was lost"));
            assert_eq!(hint(&h, "dev", "claude", Some(1), "some CLI error", true), None);
            assert_eq!(hint(&h, "dev", "claude", Some(0), "", false), None);
        }
    }
}
