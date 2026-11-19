//! Process bridge for coding-agent CLIs (Claude Code, Codex).
//!
//! The frontend owns the protocols (stream-json, JSON-RPC); this module only
//! starts the CLI, forwards its stdout/stderr line by line as events, and
//! writes to its stdin. Only the known agent binaries can be started.
//!
//! A run can also happen inside a remote environment (an Incus instance on a
//! master server): then the CLI runs detached there (see [`remote::RUN_SCRIPT`])
//! and the local process is `ssh … incus exec …` attached to it. When the
//! connection drops, the run goes on in the environment and Mango attaches to
//! it again under the same run id; see [`remote`].

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::envs::{self, hosts, EnvRemote};

/// A CLI on this computer.
struct Proc {
    stdin: Option<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: u32,
}

enum Entry {
    Local(Proc),
    Remote(Arc<remote::Live>),
}

#[derive(Default)]
pub struct AgentProcState {
    procs: Mutex<HashMap<String, Entry>>,
    /// Remote runs the user stopped while their environment was out of reach: stopped again on
    /// the next reconnect signal ([`agent_reconnect_now`]).
    unstopped: Arc<Mutex<Vec<remote::Run>>>,
}

impl AgentProcState {
    fn procs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.procs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stop every run; used when the app exits. Remote runs are stopped inside
    /// their instance too, waiting a few seconds at most (the `ssh` calls keep
    /// going on their own if the app is gone first).
    pub fn kill_all(&self) {
        let procs: Vec<Entry> = self.procs().drain().map(|(_, p)| p).collect();
        let (tx, rx) = mpsc::channel::<()>();
        let mut pending = 0;
        for p in procs {
            match p {
                Entry::Local(p) => kill_tree(p.pid, &p.child),
                Entry::Remote(live) => {
                    live.kill();
                    pending += 1;
                    let tx = tx.clone();
                    let run = live.run.clone();
                    std::thread::spawn(move || {
                        let _ = run.stop(Duration::from_secs(20));
                        let _ = tx.send(());
                    });
                }
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

/// A remote run lost its connection (`lost`, the run goes on there) or has it again (`back`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEvent<'a> {
    id: &'a str,
    state: &'a str,
    host_id: &'a str,
    instance: &'a str,
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
        // The child leads its own process group (see `process_group(0)` below). The `--` matters:
        // procps-ng 3.3.17 (Ubuntu 22.04) misreads `kill -TERM -<pgid>` and kills only itself.
        let _ = Command::new("kill")
            .args(["-TERM", "--", &format!("-{pid}")])
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

/// Read `reader` until EOF, handing each complete line (with its `\n`) to `each`.
/// Returns what came after the last `\n`: a partial line, or nothing.
fn read_lines<R: Read>(reader: R, mut each: impl FnMut(&[u8])) -> Vec<u8> {
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    let mut buf = Vec::with_capacity(8 * 1024);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => return Vec::new(),
            Ok(_) if buf.last() == Some(&b'\n') => each(&buf),
            // EOF (or a read error) in the middle of a line.
            Ok(_) | Err(_) => return std::mem::take(&mut buf),
        }
    }
}

/// A line as the frontend gets it: without its line ending, `None` when that leaves nothing.
fn line_text(raw: &[u8]) -> Option<String> {
    let mut end = raw.len();
    while end > 0 && matches!(raw[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    (end > 0).then(|| String::from_utf8_lossy(&raw[..end]).into_owned())
}

/// Read `reader` line by line (without the line ending, skipping empty lines) until EOF.
fn pump<R: Read + Send + 'static>(reader: R, mut each: impl FnMut(String) + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let rest = read_lines(reader, |raw| {
            if let Some(line) = line_text(raw) {
                each(line);
            }
        });
        if let Some(line) = line_text(&rest) {
            each(line);
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

    if let Some(target) = remote {
        let host = {
            let app = app.clone();
            let host_id = target.host_id.clone();
            envs::blocking(move || hosts::get(&app, &host_id)).await?
        };
        let run = remote::Run { host, instance: target.instance, id: id.clone() };
        let start = remote::start_line(&run.host, &run.instance, &cwd, env, &id, name, &args)?;
        let live = Arc::new(remote::Live::new(app.clone(), run, name));
        // Registered first: output can't arrive before the attach it belongs to is known.
        state.procs().insert(id.clone(), Entry::Remote(live.clone()));
        if let Err(e) = live.begin(start) {
            state.procs().remove(&id);
            return Err(e);
        }
        return Ok(id);
    }

    let mut cmd = local_command(name, &args, &cwd, env)?;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Could not start {name}: {e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("No stdout from the agent process")?;
    let stderr = child.stderr.take().ok_or("No stderr from the agent process")?;
    let child = Arc::new(Mutex::new(child));

    state.procs().insert(id.clone(), Entry::Local(Proc { stdin, child: child.clone(), pid }));

    let out = {
        let (app, id) = (app.clone(), id.clone());
        pump(stdout, move |line| emit_line(&app, "agent://stdout", &id, line))
    };
    let err = {
        let (app, id) = (app.clone(), id.clone());
        pump(stderr, move |line| emit_line(&app, "agent://stderr", &id, line))
    };

    // Reaper: once both streams hit EOF, collect the exit code and announce it.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let _ = out.join();
            let _ = err.join();
            let code = child.lock().ok().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
            if let Some(state) = tauri::Manager::try_state::<AgentProcState>(&app) {
                state.procs().remove(&id);
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
    let live = {
        let mut procs = state.procs();
        match procs.get_mut(&id).ok_or("The agent process is no longer running")? {
            Entry::Local(proc) => {
                let stdin = proc.stdin.as_mut().ok_or("The agent's input is closed")?;
                return stdin
                    .write_all(data.as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("Could not write to the agent: {e}"));
            }
            Entry::Remote(live) => live.clone(),
        }
    };
    // Outside the map's lock: a slow connection holds up only its own run.
    live.write(data.into_bytes())
}

/// Close stdin so a CLI reading a stream of input knows no more is coming.
#[tauri::command]
pub async fn agent_close_stdin(state: State<'_, AgentProcState>, id: String) -> Result<(), String> {
    let live = match state.procs().get_mut(&id) {
        Some(Entry::Local(proc)) => {
            proc.stdin = None;
            return Ok(());
        }
        Some(Entry::Remote(live)) => live.clone(),
        None => return Ok(()),
    };
    live.close_stdin();
    Ok(())
}

#[tauri::command]
pub async fn agent_kill(state: State<'_, AgentProcState>, id: String) -> Result<(), String> {
    let proc = state.procs().remove(&id);
    match proc {
        Some(Entry::Local(p)) => kill_tree(p.pid, &p.child),
        Some(Entry::Remote(live)) => {
            live.kill();
            // Best effort, in the background: the local ssh is already gone, so the UI is not kept waiting.
            // Out of reach now: tried again when the connection is back.
            let (run, unstopped) = (live.run.clone(), state.unstopped.clone());
            std::thread::spawn(move || remote::stop_or_keep(run, &unstopped));
        }
        None => {}
    }
    Ok(())
}

/// The connection to `host_id` (every host when `None`) is back: remote runs waiting to
/// reattach try now instead of at the end of their wait, runs stopped while it was gone are
/// stopped in their environment now, and the browser tools' reverse forwards are made again.
#[tauri::command]
pub async fn agent_reconnect_now(app: AppHandle, state: State<'_, AgentProcState>, host_id: Option<String>) -> Result<(), String> {
    let wanted = |h: &str| host_id.as_deref().is_none_or(|id| id == h);
    for entry in state.procs().values() {
        if let Entry::Remote(live) = entry {
            if wanted(&live.run.host.id) {
                live.nudge();
            }
        }
    }
    let retry: Vec<remote::Run> = {
        let mut list = state.unstopped.lock().unwrap_or_else(|e| e.into_inner());
        let (now, later) = list.drain(..).partition(|r: &remote::Run| wanted(&r.host.id));
        *list = later;
        now
    };
    for run in retry {
        let unstopped = state.unstopped.clone();
        std::thread::spawn(move || remote::stop_or_keep(run, &unstopped));
    }
    // The browser tools' way back from the environment died with the connection too.
    std::thread::spawn(move || crate::browser_remote::revive(&app, host_id.as_deref()));
    Ok(())
}

/// Agent runs inside an Incus instance.
///
/// A run outlives its connection: [`RUN_SCRIPT`] starts the CLI detached in
/// the instance, writing its output to files there, and every `ssh` that
/// Mango keeps open is only attached to it, streaming those files from the
/// byte offsets it has already seen. When the connection drops, the run goes
/// on; [`Live`] reports it (`agent://connection`), waits (1 s, 2 s, 4 s … 15 s,
/// or less when [`super::agent_reconnect_now`] says the host is back), and
/// attaches again under the same run id. What the frontend writes meanwhile
/// waits in a queue. The protocol is shared with the phone app
/// (`mobile/src/remote/sshBackend.ts`).
///
/// Stopping one: killing the local `ssh` does not stop the CLI in the
/// instance (now by design). So every remote run is tagged with
/// `MANGO_RUN=<run id>` in its environment (inherited by everything it
/// starts), and stopping it runs [`STOP_SCRIPT`] in the instance as root:
/// TERM every process carrying the tag and all their descendants, then KILL
/// what is left after a few seconds. A run nobody is attached to for 30
/// minutes stops itself.
mod remote {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Condvar;

    use crate::envs::{ssh, EnvHost};

    /// The environment variable that marks every process of one run.
    pub const RUN_TAG: &str = "MANGO_RUN";

    /// `sh -c` script (`$0` = `mango-run`, `$1` = start | attach | close, `$2` = run id) that
    /// keeps a run going without a connection. Shared verbatim with the phone app: change both.
    pub const RUN_SCRIPT: &str = r#"# mango-run: an agent run that outlives the connection. $1 = start | attach | close, $2 = run id.
# start <id> <program> <args…>: start the run detached, then attach from the beginning.
# attach <id> <out offset> <err offset>: stream its stdout and stderr from those byte offsets,
#   feed this stdin to it, and end with the line "mango-run:exit <code>" on stderr. Offsets count
#   only bytes after the line "mango-run:attached" each stream starts with (a login shell may print first).
# close <id>: end its input.
mode=$1 id=$2
shift 2
case $id in ''|*[!A-Za-z0-9-]*) echo "Mango: bad run id." >&2; exit 2 ;; esac
base="$HOME/.cache/mango/runs" dir="$HOME/.cache/mango/runs/$id"
gone() { echo "mango-run:gone" >&2; exit 1; }
case $mode in
start)
  umask 077
  mkdir -p "$base" || exit 1
  find "$base" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null
  mkdir "$dir" && mkfifo "$dir/in" && : >"$dir/out" && : >"$dir/err" && touch "$dir/alive" || exit 1
  setsid sh -c '
    dir=$1; shift
    echo $$ >"$dir/pid.tmp" && mv "$dir/pid.tmp" "$dir/pid"
    exec 3<>"$dir/in"
    "$@" <"$dir/in" >>"$dir/out" 2>>"$dir/err" 3>&- &
    pid=$! stopped=
    while kill -0 $pid 2>/dev/null; do
      sleep 1
      [ -e "$dir/closed" ] && exec 3>&-
      if [ -z "$stopped" ] && [ -n "$(find "$dir/alive" -mmin +30 2>/dev/null)" ]; then
        echo "Mango: nothing was connected to this run for 30 minutes, so it was stopped." >>"$dir/err"
        kill -TERM $pid; stopped=1
      fi
    done
    wait $pid; echo $? >"$dir/code.tmp" && mv "$dir/code.tmp" "$dir/code"
  ' mango-runner "$dir" "$@" </dev/null >/dev/null 2>&1 &
  i=0
  while [ ! -e "$dir/pid" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  set -- 0 0
  ;;
attach) ;;
close) [ -d "$dir" ] || gone; touch "$dir/closed"; exit 0 ;;
*) exit 2 ;;
esac
[ -e "$dir/pid" ] || gone
pid=$(cat "$dir/pid")
touch "$dir/alive"
exec 4<&0
feed=
if [ ! -e "$dir/closed" ]; then cat <&4 >"$dir/in" 2>/dev/null & feed=$!; fi
( while kill -0 $$ 2>/dev/null; do
    touch "$dir/alive"
    [ -n "$feed" ] && [ -e "$dir/closed" ] && kill $feed 2>/dev/null
    sleep 1
  done ) </dev/null >/dev/null 2>&1 &
beat=$!
echo "mango-run:attached"
echo "mango-run:attached" >&2
tail -c +$(($2 + 1)) --pid="$pid" -f "$dir/err" >&2 &
e=$!
tail -c +$(($1 + 1)) --pid="$pid" -f "$dir/out"
wait $e
kill $beat $feed 2>/dev/null
i=0
while [ ! -e "$dir/code" ] && [ $i -lt 25 ]; do sleep 0.2; i=$((i + 1)); done
code=$(cat "$dir/code" 2>/dev/null)
echo "mango-run:exit ${code:-143}" >&2
exit "${code:-143}"
"#;

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
            ssh::run(&self.host, &stop_line(&self.host, &self.instance, &self.id)?, timeout).map(|_| ())
        }
    }

    /// How many reconnects a stop that keeps failing is tried again on.
    const STOP_TRIES: usize = 5;

    /// Stop `run`; when that fails (most likely the connection), keep it in `unstopped` for the
    /// next reconnect. A run that can't be stopped stops itself after 30 minutes anyway.
    pub fn stop_or_keep(run: Run, unstopped: &Mutex<Vec<Run>>) {
        if run.stop(Duration::from_secs(30)).is_ok() {
            return;
        }
        let mut list = unstopped.lock().unwrap_or_else(|e| e.into_inner());
        if list.len() < 50 && list.iter().filter(|r| r.id == run.id).count() < STOP_TRIES {
            list.push(run);
        }
    }

    /// The master-side argv of [`STOP_SCRIPT`] for one run.
    /// Root (`sudo -n` in a joined environment) sees every process's environment.
    pub fn stop_line(host: &EnvHost, instance: &str, run_id: &str) -> Result<Vec<String>, String> {
        let inner: Vec<String> = vec!["sh".into(), "-c".into(), STOP_SCRIPT.into(), "mango-stop".into(), run_id.into()];
        ssh::in_instance(host, instance, ssh::Mode::Batch, &inner)
    }

    /// `sh -c RUN_SCRIPT mango-run <mode> <run id> <rest…>`.
    fn script(mode: &str, run_id: &str, rest: impl IntoIterator<Item = String>) -> Vec<String> {
        let mut a: Vec<String> = vec!["sh".into(), "-c".into(), RUN_SCRIPT.into(), "mango-run".into(), mode.into(), run_id.into()];
        a.extend(rest);
        a
    }

    /// The run id is the only variable the attach and close calls need.
    fn tag(run_id: &str) -> Vec<(String, String)> {
        vec![(RUN_TAG.to_string(), run_id.to_string())]
    }

    /// The master-side argv starting `program args…` as the agent user inside
    /// `instance`, from `cwd` (the agent's home when empty), tagged with the run id,
    /// detached through [`RUN_SCRIPT`] and attached from the beginning.
    pub fn start_line(
        host: &EnvHost,
        instance: &str,
        cwd: &str,
        env: Option<HashMap<String, String>>,
        run_id: &str,
        program: &str,
        args: &[String],
    ) -> Result<Vec<String>, String> {
        envs::valid_instance(instance)?;
        valid_run_id(run_id)?;
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
        vars.extend(tag(run_id));
        if args.iter().any(|a| a.contains('\0')) {
            return Err("An argument for the agent contains a NUL character.".into());
        }
        let inner = script("start", run_id, std::iter::once(program.to_string()).chain(args.iter().cloned()));
        ssh::in_instance(host, instance, ssh::Mode::Batch, &ssh::as_agent(cwd, &vars, &inner))
    }

    /// The master-side argv attaching to a run again, from the bytes of its stdout and stderr already seen.
    /// From the agent's home: the run's folder may be gone by now, the run is not.
    pub fn attach_line(host: &EnvHost, instance: &str, run_id: &str, out: u64, err: u64) -> Result<Vec<String>, String> {
        envs::valid_instance(instance)?;
        valid_run_id(run_id)?;
        let inner = script("attach", run_id, [out.to_string(), err.to_string()]);
        ssh::in_instance(host, instance, ssh::Mode::Batch, &ssh::as_agent(None, &tag(run_id), &inner))
    }

    /// The master-side argv ending a run's input.
    pub fn close_line(host: &EnvHost, instance: &str, run_id: &str) -> Result<Vec<String>, String> {
        envs::valid_instance(instance)?;
        valid_run_id(run_id)?;
        let inner = script("close", run_id, []);
        ssh::in_instance(host, instance, ssh::Mode::Batch, &ssh::as_agent(None, &tag(run_id), &inner))
    }

    /// What [`RUN_SCRIPT`] accepts as a run id (Mango's are UUIDs).
    fn valid_run_id(id: &str) -> Result<(), String> {
        if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            Ok(())
        } else {
            Err("Bad run id.".into())
        }
    }

    /// A line [`RUN_SCRIPT`] ends an attach with.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Marker {
        /// The run ended with this code.
        Exit(i32),
        /// The run is not in the environment (never started there, or cleaned up).
        Gone,
    }

    /// Split a stderr line (without its line ending) into what it says and the marker it
    /// ends with. The marker is normally a line of its own; it lands at the end of one when
    /// the run's last stderr output had no line ending.
    pub fn split_marker(line: &str) -> (&str, Option<Marker>) {
        if let Some(rest) = line.strip_suffix("mango-run:gone") {
            return (rest, Some(Marker::Gone));
        }
        const EXIT: &str = "mango-run:exit ";
        if let Some(i) = line.rfind(EXIT) {
            if let Ok(code) = line[i + EXIT.len()..].parse::<i32>() {
                return (&line[..i], Some(Marker::Exit(code)));
            }
        }
        (line, None)
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Phase {
        /// The `ssh` that started the run.
        Start,
        /// An `ssh` that attached to it again.
        Attach,
    }

    /// How one `ssh` to the run ended, and so what happens next.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Outcome {
        /// The run ended with this code.
        Ended(i32),
        /// The run is no longer in the environment.
        Gone,
        /// It never got going (or the environment is gone): explain, and end with the ssh's code.
        Failed,
        /// The connection dropped; the run goes on: attach again.
        Lost,
    }

    /// Decide what an ended `ssh` means. `attached`: it printed [`ATTACHED`] (the run was there).
    /// `reached`: attached, or it stayed up longer than connecting can take.
    /// `env_gone`: what it printed says the instance is stopped or deleted.
    pub fn classify(phase: Phase, marker: Option<Marker>, code: Option<i32>, reached: bool, attached: bool, env_gone: bool) -> Outcome {
        match marker {
            Some(Marker::Exit(c)) => return Outcome::Ended(c),
            Some(Marker::Gone) => return Outcome::Gone,
            None => {}
        }
        // ssh exits 255 on connection problems; no code at all means it was killed.
        let dropped = matches!(code, Some(255) | None);
        match phase {
            // Never reached the environment: the error it is (bad key, unknown host), not a drop.
            Phase::Start if dropped => if reached { Outcome::Lost } else { Outcome::Failed },
            // The script or `incus` failed before the run started (no folder, instance stopped).
            Phase::Start => if attached { Outcome::Lost } else { Outcome::Failed },
            Phase::Attach if dropped => Outcome::Lost,
            Phase::Attach => if env_gone { Outcome::Failed } else { Outcome::Lost },
        }
    }

    /// The wait before attaching again after `fails` attempts in a row: 1 s, 2 s, 4 s, 8 s, then 15 s.
    pub fn backoff(fails: u32) -> Duration {
        Duration::from_secs((1u64 << fails.min(4)).min(15))
    }

    /// What an `ssh` printed says the instance is stopped or no longer there.
    fn env_gone(text: &str) -> bool {
        let lower = text.to_lowercase();
        lower.contains("instance is not running") || lower.contains("instance not found") || lower.contains("error: not found")
    }

    /// The line an attach (and a start) prints on stdout and on stderr right before the run's
    /// output: what comes before it (a login profile's noise) is not the run's, and byte offsets
    /// count only what comes after it. It also says the attach is connected.
    pub const ATTACHED: &str = "mango-run:attached";

    /// What a line of one stream of an attach is.
    #[derive(Debug, PartialEq, Eq)]
    pub enum Seen {
        /// Before [`ATTACHED`]: not the run's (its text, when it has any).
        Before(Option<String>),
        /// The [`ATTACHED`] line itself.
        Attached,
        /// The run's own output: counts with all its bytes (its text, when it has any).
        Run(Option<String>),
    }

    /// One stream of an attach, line by line.
    #[derive(Default)]
    pub struct Stream {
        pub attached: bool,
    }

    impl Stream {
        /// `raw` is a complete line with its `\n`.
        pub fn take(&mut self, raw: &[u8]) -> Seen {
            let text = line_text(raw);
            if self.attached {
                return Seen::Run(text);
            }
            if text.as_deref() == Some(ATTACHED) {
                self.attached = true;
                return Seen::Attached;
            }
            Seen::Before(text)
        }
    }

    /// Longer than connecting and signing in can take: a start that stayed up this long reached the environment.
    const REACHED_AFTER: Duration = Duration::from_secs(20);

    /// A file for one `ssh`'s own messages (`-E`), so they never mix with the run's stderr and its
    /// byte count. Made here (owner-only, new) before ssh appends to it.
    fn ssh_log(run_id: &str, n: u64) -> Option<PathBuf> {
        let path = std::env::temp_dir().join(format!("mango-ssh-{run_id}-{n}.log"));
        let _ = std::fs::remove_file(&path);
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        o.open(&path).ok().map(|_| path)
    }

    /// One `ssh` process attached to the run.
    struct Attach {
        child: Arc<Mutex<Child>>,
        pid: u32,
        stdin: Option<ChildStdin>,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
        log: Option<PathBuf>,
        started: Instant,
    }

    /// How an attach went.
    struct Report {
        marker: Option<Marker>,
        code: Option<i32>,
        /// The run printed on stdout (after the marker).
        saw_out: bool,
        /// Either stream got as far as [`ATTACHED`]: the run is there, and this attach reached it.
        attached: bool,
        up: Duration,
        /// Its last stderr lines from the run.
        tail: String,
        /// Stderr lines from before [`ATTACHED`] (login noise, or why the start failed).
        before: Vec<String>,
        /// The ssh's own messages.
        log: String,
        /// What came after the last line ending on each stream.
        rest_out: Vec<u8>,
        rest_err: Vec<u8>,
        /// It counted as connected.
        through: bool,
    }

    #[derive(Default)]
    struct LiveState {
        /// The current attach's input, while it is connected.
        stdin: Option<ChildStdin>,
        child: Option<(Arc<Mutex<Child>>, u32)>,
        /// Writes waiting for a connection, in order.
        queue: Vec<Vec<u8>>,
        /// The frontend closed the input.
        closing: bool,
        /// The `close` is on its way to the environment, or got there.
        close_sent: bool,
        killed: bool,
        /// The frontend was told the connection is lost (and not yet that it is back).
        lost: bool,
        /// The host was found reachable again: attach without waiting.
        nudged: bool,
        /// The current attach (0 = the start).
        attach: u64,
        /// The current attach counts as connected.
        through: bool,
    }

    /// A remote run, across the `ssh` processes attached to it.
    pub struct Live {
        pub run: Run,
        app: AppHandle,
        program: &'static str,
        st: Mutex<LiveState>,
        wake: Condvar,
        /// Bytes of complete lines seen on the run's stdout and stderr: where an attach starts.
        out_bytes: AtomicU64,
        err_bytes: AtomicU64,
    }

    impl Live {
        pub fn new(app: AppHandle, run: Run, program: &'static str) -> Self {
            Self {
                run,
                app,
                program,
                st: Mutex::new(LiveState::default()),
                wake: Condvar::new(),
                out_bytes: AtomicU64::new(0),
                err_bytes: AtomicU64::new(0),
            }
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, LiveState> {
            self.st.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// Start the run (`start`, from [`start_line`]) and look after it from then on.
        pub fn begin(self: &Arc<Self>, start: Vec<String>) -> Result<(), String> {
            let first = self.spawn(&start, 0)?;
            let me = self.clone();
            std::thread::spawn(move || me.supervise(first));
            Ok(())
        }

        fn spawn(&self, line: &[String], n: u64) -> Result<Attach, String> {
            let log = ssh_log(&self.run.id, n);
            let mut argv = ssh::argv(&self.run.host, ssh::Mode::Batch, line)?;
            if let Some(path) = &log {
                argv.splice(1..1, ["-E".to_string(), path.to_string_lossy().into_owned()]);
            }
            let mut cmd = ssh::command(&argv);
            cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0);
            }
            let mut child = cmd.spawn().map_err(|e| {
                if let Some(path) = &log {
                    let _ = std::fs::remove_file(path);
                }
                format!("Could not start ssh: {e}")
            })?;
            let stdin = child.stdin.take();
            let stdout = child.stdout.take().ok_or("No stdout from ssh")?;
            let stderr = child.stderr.take().ok_or("No stderr from ssh")?;
            Ok(Attach { pid: child.id(), child: Arc::new(Mutex::new(child)), stdin, stdout, stderr, log, started: Instant::now() })
        }

        fn emit_connection(&self, state: &str) {
            let _ = self.app.emit(
                "agent://connection",
                ConnectionEvent { id: &self.run.id, state, host_id: &self.run.host.id, instance: &self.run.instance },
            );
        }

        /// The frontend writes a line: to the run now, or when it is connected again.
        pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
            let mut st = self.lock();
            if st.killed {
                return Err("The agent process is no longer running".into());
            }
            if st.closing {
                return Err("The agent's input is closed".into());
            }
            if st.queue.is_empty() {
                if let Some(stdin) = st.stdin.as_mut() {
                    if stdin.write_all(&data).and_then(|_| stdin.flush()).is_ok() {
                        return Ok(());
                    }
                    // The ssh is going away: this attach is over.
                    st.stdin = None;
                }
            }
            st.queue.push(data);
            Ok(())
        }

        pub fn close_stdin(self: &Arc<Self>) {
            let mut st = self.lock();
            if st.closing || st.killed {
                return;
            }
            st.closing = true;
            self.maybe_close(&mut st);
        }

        /// Send the `close` once the input is all there: nothing queued, and the attach that
        /// carries the last writes is connected (so its `cat` runs before the run is closed).
        fn maybe_close(self: &Arc<Self>, st: &mut LiveState) {
            if !st.closing || st.close_sent || !st.through || !st.queue.is_empty() || st.killed {
                return;
            }
            st.stdin = None;
            st.close_sent = true;
            let me = Arc::downgrade(self);
            let run = self.run.clone();
            std::thread::spawn(move || {
                let sent = close_line(&run.host, &run.instance, &run.id)
                    .and_then(|line| ssh::run(&run.host, &line, Duration::from_secs(30)));
                if sent.is_err() {
                    if let Some(me) = me.upgrade() {
                        // Out of reach: sent again once an attach is connected.
                        me.lock().close_sent = false;
                    }
                }
            });
        }

        /// The user stopped the run: no more attaching, and the current `ssh` goes.
        pub fn kill(&self) {
            let child = {
                let mut st = self.lock();
                st.killed = true;
                st.stdin = None;
                st.queue.clear();
                self.wake.notify_all();
                st.child.take()
            };
            if let Some((child, pid)) = child {
                kill_tree(pid, &child);
            }
        }

        /// The host is reachable again: a run waiting to attach tries now.
        pub fn nudge(&self) {
            self.lock().nudged = true;
            self.wake.notify_all();
        }

        /// Attach `n` is connected: it printed [`ATTACHED`].
        fn through(self: &Arc<Self>, n: u64) {
            let mut st = self.lock();
            if st.attach != n || st.through || st.killed || st.child.is_none() {
                return;
            }
            st.through = true;
            if st.lost {
                st.lost = false;
                self.emit_connection("back");
            }
            self.maybe_close(&mut st);
        }

        /// Wait `delay` before attaching again, or less when nudged (the host is reachable again).
        /// False: the user stopped the run.
        fn wait_retry(&self, delay: Duration) -> bool {
            let deadline = Instant::now() + delay;
            let mut st = self.lock();
            loop {
                if st.killed {
                    return false;
                }
                if st.nudged {
                    st.nudged = false;
                    return true;
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return true;
                }
                st = self.wake.wait_timeout(st, left).unwrap_or_else(|e| e.into_inner()).0;
            }
        }

        /// Make `a` the current attach: queued writes go to it first, in order.
        /// False when the run was stopped meanwhile (and `a` is killed).
        fn install(&self, n: u64, a: &mut Attach) -> bool {
            let mut st = self.lock();
            if st.killed {
                drop(st);
                kill_tree(a.pid, &a.child);
                return false;
            }
            st.attach = n;
            st.through = false;
            st.child = Some((a.child.clone(), a.pid));
            let mut stdin = a.stdin.take();
            if let Some(s) = stdin.as_mut() {
                let mut sent = 0;
                for chunk in &st.queue {
                    if s.write_all(chunk).and_then(|_| s.flush()).is_err() {
                        break;
                    }
                    sent += 1;
                }
                let all = sent == st.queue.len();
                st.queue.drain(..sent);
                if !all {
                    stdin = None;
                }
            }
            // Closed already: the run has its input end, this attach needs none.
            if st.closing && st.close_sent {
                stdin = None;
            }
            st.stdin = stdin;
            true
        }

        /// Follow attach `n` until its `ssh` ends.
        fn watch(self: &Arc<Self>, n: u64, mut a: Attach) -> Option<Report> {
            if !self.install(n, &mut a) {
                return None;
            }
            let saw_out = Arc::new(AtomicBool::new(false));
            let attached = Arc::new(AtomicBool::new(false));
            let marker = Arc::new(Mutex::new(None::<Marker>));
            let tail = Arc::new(Mutex::new(Vec::<String>::new()));
            let before = Arc::new(Mutex::new(Vec::<String>::new()));
            let keep = |lines: &Mutex<Vec<String>>, line: &str| {
                if let Ok(mut t) = lines.lock() {
                    if t.len() == 20 {
                        t.remove(0);
                    }
                    t.push(line.to_string());
                }
            };

            let out = {
                let (me, saw, attached) = (self.clone(), saw_out.clone(), attached.clone());
                let stdout = a.stdout;
                std::thread::spawn(move || {
                    let mut stream = Stream::default();
                    let rest = read_lines(stdout, |raw| match stream.take(raw) {
                        // Login-shell noise: neither shown nor counted.
                        Seen::Before(_) => {}
                        Seen::Attached => {
                            attached.store(true, Ordering::SeqCst);
                            me.through(n);
                        }
                        Seen::Run(text) => {
                            me.out_bytes.fetch_add(raw.len() as u64, Ordering::SeqCst);
                            saw.store(true, Ordering::SeqCst);
                            if let Some(line) = text {
                                emit_line(&me.app, "agent://stdout", &me.run.id, line);
                            }
                        }
                    });
                    // A partial line only counts as the run's after the marker.
                    if stream.attached { rest } else { Vec::new() }
                })
            };
            let err = {
                let (me, attached, marker, tail, before) = (self.clone(), attached.clone(), marker.clone(), tail.clone(), before.clone());
                let stderr = a.stderr;
                std::thread::spawn(move || {
                    let mut stream = Stream::default();
                    let set = |m: Marker| *marker.lock().unwrap_or_else(|e| e.into_inner()) = Some(m);
                    let rest = read_lines(stderr, |raw| match stream.take(raw) {
                        Seen::Attached => {
                            attached.store(true, Ordering::SeqCst);
                            me.through(n);
                        }
                        // Before the run: login noise, or what explains a start that failed
                        // (`gone`, a missing folder, a stopped instance). Kept, not shown or counted.
                        Seen::Before(text) => {
                            let Some(t) = text else { return };
                            let (said, mark) = split_marker(&t);
                            if let Some(m) = mark {
                                set(m);
                            }
                            if !said.trim().is_empty() {
                                keep(&before, said);
                            }
                        }
                        Seen::Run(text) => {
                            let (said, mark) = match text.as_deref() {
                                Some(t) => split_marker(t),
                                None => ("", None),
                            };
                            if let Some(m) = mark {
                                set(m);
                                if said.is_empty() {
                                    return;
                                }
                            }
                            // Only the run's own bytes count (`said` without a marker is the whole line).
                            let counted = if mark.is_some() { said.len() as u64 } else { raw.len() as u64 };
                            me.err_bytes.fetch_add(counted, Ordering::SeqCst);
                            if said.trim().is_empty() {
                                return;
                            }
                            keep(&tail, said);
                            emit_line(&me.app, "agent://stderr", &me.run.id, said.to_string());
                        }
                    });
                    if stream.attached { rest } else { Vec::new() }
                })
            };

            let rest_out = out.join().unwrap_or_default();
            let rest_err = err.join().unwrap_or_default();
            let code = a.child.lock().ok().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
            let up = a.started.elapsed();
            let log = a
                .log
                .as_ref()
                .map(|p| {
                    let text = std::fs::read_to_string(p).unwrap_or_default();
                    let _ = std::fs::remove_file(p);
                    text
                })
                .unwrap_or_default();
            let through = {
                let mut st = self.lock();
                st.child = None;
                st.stdin = None;
                st.attach == n && st.through
            };
            let marker = *marker.lock().unwrap_or_else(|e| e.into_inner());
            let tail = tail.lock().map(|t| t.join("\n")).unwrap_or_default();
            let before = before.lock().map(|t| t.clone()).unwrap_or_default();
            Some(Report {
                marker,
                code,
                saw_out: saw_out.load(Ordering::SeqCst),
                attached: attached.load(Ordering::SeqCst),
                up,
                tail,
                before,
                log,
                rest_out,
                rest_err,
                through,
            })
        }

        /// Look after the run until it ends or the user stops it, attaching again after each drop.
        fn supervise(self: Arc<Self>, first: Attach) {
            let (mut phase, mut attach, mut n) = (Phase::Start, first, 0u64);
            let mut fails = 0u32;
            loop {
                let Some(r) = self.watch(n, attach) else {
                    return self.finish(None);
                };
                if self.lock().killed {
                    return self.finish(r.code);
                }
                let reached = r.attached || r.up >= REACHED_AFTER;
                let said = format!("{}\n{}", r.before.join("\n"), r.tail);
                match classify(phase, r.marker, r.code, reached, r.attached, env_gone(&said)) {
                    Outcome::Ended(code) => {
                        if let Some(line) = line_text(&r.rest_out) {
                            emit_line(&self.app, "agent://stdout", &self.run.id, line);
                        }
                        if let Some(line) = line_text(&r.rest_err) {
                            emit_line(&self.app, "agent://stderr", &self.run.id, line);
                        }
                        // It ran but printed nothing: the CLI may be missing there.
                        if !r.saw_out {
                            let all = format!("{said}\n{}", r.log);
                            if let Some(h) = hint(&self.run.host, &self.run.instance, self.program, Some(code), &all) {
                                emit_line(&self.app, "agent://stderr", &self.run.id, h);
                            }
                        }
                        return self.finish(Some(code));
                    }
                    Outcome::Gone => {
                        let line = format!("Mango: this run is no longer in the environment {}.", self.run.instance);
                        emit_line(&self.app, "agent://stderr", &self.run.id, line);
                        return self.finish(None);
                    }
                    Outcome::Failed => {
                        // What the environment said before the run started is the explanation now.
                        for line in &r.before {
                            emit_line(&self.app, "agent://stderr", &self.run.id, line.clone());
                        }
                        // The ssh's own messages last: they explain a failed connection.
                        let all = format!("{said}\n{}", r.log);
                        if let Some(h) = hint(&self.run.host, &self.run.instance, self.program, r.code, &all) {
                            emit_line(&self.app, "agent://stderr", &self.run.id, h);
                        }
                        return self.finish(r.code);
                    }
                    Outcome::Lost => {}
                }
                {
                    let mut st = self.lock();
                    if !st.lost {
                        st.lost = true;
                        self.emit_connection("lost");
                    }
                }
                if r.through {
                    fails = 0;
                }
                // Attach again: from where the output stopped, after a wait that grows.
                attach = loop {
                    if !self.wait_retry(backoff(fails)) {
                        return self.finish(None);
                    }
                    fails = fails.saturating_add(1);
                    n += 1;
                    let (out, err) = (self.out_bytes.load(Ordering::SeqCst), self.err_bytes.load(Ordering::SeqCst));
                    let spawned = attach_line(&self.run.host, &self.run.instance, &self.run.id, out, err)
                        .and_then(|line| self.spawn(&line, n));
                    if let Ok(a) = spawned {
                        break a;
                    }
                };
                phase = Phase::Attach;
            }
        }

        /// The run is over: forget it and say so (once).
        fn finish(&self, code: Option<i32>) {
            if let Some(state) = tauri::Manager::try_state::<AgentProcState>(&self.app) {
                let mut procs = state.procs();
                if matches!(procs.get(&self.run.id), Some(Entry::Remote(l)) if std::ptr::eq(Arc::as_ptr(l), self)) {
                    procs.remove(&self.run.id);
                }
            }
            let _ = self.app.emit("agent://exit", ExitEvent { id: &self.run.id, code });
        }
    }

    /// A `Mango: …` line explaining why a remote run ended, when it is not
    /// already clear from what it printed. `stderr` is its last stderr lines
    /// and ssh's own messages. Only for runs that never got going: a dropped
    /// connection is not an ending any more.
    pub fn hint(host: &EnvHost, instance: &str, program: &str, code: Option<i32>, stderr: &str) -> Option<String> {
        let lower = stderr.to_lowercase();
        let first = |s: String| s.lines().next().unwrap_or_default().to_string();
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
                public_address: None,
                direct: None,
            }
        }

        #[test]
        fn run_script_is_the_shared_one() {
            // The phone app embeds the same bytes (mobile/src/remote/sshBackend.ts): keep them in step.
            use sha2::{Digest, Sha256};
            let hex: String = Sha256::digest(RUN_SCRIPT.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, "338dba48fba498e81524ad8a79688ab786d911741e84698a4475a299a73e81b9");
        }

        #[test]
        fn start_line_runs_the_cli_as_agent_tagged() {
            let env = HashMap::from([("B".to_string(), "2".to_string()), ("A".to_string(), "x y".to_string())]);
            let args = ["-p".to_string(), "--output-format".into(), "stream-json".into()];
            let argv = start_line(&host(), "dev", "/home/agent/work/my app", Some(env), "run-1", "claude", &args).unwrap();
            let l = ssh::line(&argv);
            assert!(l.starts_with("incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent"), "{l}");
            assert!(l.contains(" 'A=x y' B=2 MANGO_RUN=run-1 bash -lc "), "{l}");
            assert!(l.contains("mango '/home/agent/work/my app' sh -c '# mango-run:"), "{l}");
            assert!(l.ends_with("' mango-run start run-1 claude -p --output-format stream-json"), "{l}");
            // The script reaches `sh -c` as one argument, unchanged.
            let inner = argv.iter().position(|a| a == RUN_SCRIPT).expect("script as one argument");
            assert_eq!(argv[inner - 1], "-c");

            // No folder: the agent's home.
            let l = ssh::line(&start_line(&host(), "dev", " ", None, "r", "codex", &[]).unwrap());
            assert!(l.ends_with("mango-run start r codex"), "{l}");
            assert!(l.contains("mango /home/agent sh -c"), "{l}");
        }

        #[test]
        fn attach_and_close_lines() {
            let argv = attach_line(&host(), "dev", "6f1c-77", 120, 7).unwrap();
            let l = ssh::line(&argv);
            assert!(l.contains(" MANGO_RUN=6f1c-77 bash -lc "), "{l}");
            assert!(l.contains("mango /home/agent sh -c"), "{l}");
            assert!(l.ends_with("' mango-run attach 6f1c-77 120 7"), "{l}");
            let l = ssh::line(&close_line(&host(), "dev", "6f1c-77").unwrap());
            assert!(l.ends_with("' mango-run close 6f1c-77"), "{l}");
            assert!(attach_line(&host(), "dev", "a b", 0, 0).is_err());
            assert!(close_line(&host(), "dev;x", "r", ).is_err());
        }

        #[test]
        fn start_line_refuses_bad_input() {
            let h = host();
            assert!(start_line(&h, "dev;rm", "", None, "r", "claude", &[]).is_err());
            assert!(start_line(&h, "dev", "work", None, "r", "claude", &[]).is_err());
            assert!(start_line(&h, "dev", "/a/../etc", None, "r", "claude", &[]).is_err());
            let bad_key = HashMap::from([("A=B".to_string(), "x".to_string())]);
            assert!(start_line(&h, "dev", "", Some(bad_key), "r", "claude", &[]).is_err());
            let tag = HashMap::from([(RUN_TAG.to_string(), "other".to_string())]);
            assert!(start_line(&h, "dev", "", Some(tag), "r", "claude", &[]).is_err());
            assert!(start_line(&h, "dev", "", None, "r", "claude", &["a\0b".into()]).is_err());
            assert!(start_line(&h, "dev", "", None, "r/../x", "claude", &[]).is_err());
        }

        #[test]
        fn stop_line_targets_the_run() {
            let l = ssh::line(&stop_line(&host(), "dev", "6f1c-77").unwrap());
            assert!(l.starts_with("incus exec os1:dev -T -- sh -c '"), "{l}");
            assert!(l.ends_with("' mango-stop 6f1c-77"), "{l}");
            assert!(STOP_SCRIPT.contains(&format!("{RUN_TAG}=$1")));
            // The awk program's quotes survive the master's shell as one word.
            assert!(l.contains(r"awk -v roots=") && l.contains(r"'\''"), "{l}");
        }

        #[test]
        fn markers() {
            assert_eq!(split_marker("mango-run:exit 0"), ("", Some(Marker::Exit(0))));
            assert_eq!(split_marker("mango-run:exit 143"), ("", Some(Marker::Exit(143))));
            assert_eq!(split_marker("mango-run:gone"), ("", Some(Marker::Gone)));
            // The run's last stderr had no line ending: the marker follows it on the same line.
            assert_eq!(split_marker("panic: boommango-run:exit 2"), ("panic: boom", Some(Marker::Exit(2))));
            assert_eq!(split_marker("mango-run:exit x"), ("mango-run:exit x", None));
            assert_eq!(split_marker("Error: something"), ("Error: something", None));
        }

        #[test]
        fn line_counting_and_text() {
            let mut seen: Vec<Vec<u8>> = Vec::new();
            let rest = read_lines(&b"one\r\n\ntwo\npart"[..], |raw| seen.push(raw.to_vec()));
            assert_eq!(seen, vec![b"one\r\n".to_vec(), b"\n".to_vec(), b"two\n".to_vec()]);
            assert_eq!(rest, b"part");
            // Every complete line counts, the empty one and the `\r` too; the partial one does not.
            assert_eq!(seen.iter().map(Vec::len).sum::<usize>(), 10);
            assert_eq!(line_text(b"one\r\n").as_deref(), Some("one"));
            assert_eq!(line_text(b"\n"), None);
            assert_eq!(read_lines(&b""[..], |_| panic!()), b"");
        }

        #[test]
        fn outcomes() {
            use Outcome::*;
            use Phase::*;
            // Markers decide, whatever the code.
            assert_eq!(classify(Attach, Some(Marker::Exit(3)), Some(3), true, true, false), Ended(3));
            assert_eq!(classify(Start, Some(Marker::Gone), Some(1), false, false, false), Gone);
            // Never reached the environment: an error, not a drop.
            assert_eq!(classify(Start, None, Some(255), false, false, false), Failed);
            // The script or `incus` failed before the run started (no marker yet).
            assert_eq!(classify(Start, None, Some(1), true, false, true), Failed);
            // Reached it (the run attached, or the start stayed up), then the connection went: the run goes on.
            assert_eq!(classify(Start, None, Some(255), true, true, false), Lost);
            assert_eq!(classify(Start, None, None, true, false, false), Lost);
            assert_eq!(classify(Start, None, Some(1), true, true, false), Lost);
            assert_eq!(classify(Attach, None, Some(255), false, false, false), Lost);
            assert_eq!(classify(Attach, None, Some(1), false, false, false), Lost);
            // The instance was stopped or deleted meanwhile: nothing to attach to.
            assert_eq!(classify(Attach, None, Some(1), false, false, true), Failed);
            assert!(env_gone("Error: Instance is not running"));
        }

        #[test]
        fn backoff_grows_to_15s() {
            let s: Vec<u64> = (0..7).map(|f| backoff(f).as_secs()).collect();
            assert_eq!(s, vec![1, 2, 4, 8, 15, 15, 15]);
        }

        #[test]
        fn hints() {
            let h = host();
            let denied = "me@lab: Permission denied (publickey).";
            let m = hint(&h, "dev", "claude", Some(255), denied).unwrap();
            assert!(m.starts_with("Mango: Lab refused the SSH sign-in."), "{m}");
            assert!(!m.contains('\n'));
            let m = hint(&h, "dev", "claude", Some(1), "Error: Instance is not running").unwrap();
            assert!(m.contains("dev is not running"), "{m}");
            let m = hint(&h, "dev", "claude", Some(127), "sh: 1: claude: not found").unwrap();
            assert!(m.contains("claude is not installed"), "{m}");
            assert_eq!(hint(&h, "dev", "claude", Some(1), "some CLI error"), None);
            assert_eq!(hint(&h, "dev", "claude", Some(0), ""), None);
        }

        #[test]
        fn attached_marker_splits_noise_from_the_run() {
            let mut st = Stream::default();
            // A login profile's output: not the run's, whatever it says.
            assert_eq!(st.take(b"Welcome to Ubuntu\n"), Seen::Before(Some("Welcome to Ubuntu".into())));
            assert_eq!(st.take(b"\n"), Seen::Before(None));
            // Only the exact line counts as the marker.
            assert_eq!(st.take(b"x mango-run:attached\n"), Seen::Before(Some("x mango-run:attached".into())));
            assert_eq!(st.take(b"mango-run:attached\n"), Seen::Attached);
            assert!(st.attached);
            // From here on everything is the run's, a second marker line too.
            assert_eq!(st.take(b"{\"type\":\"x\"}\r\n"), Seen::Run(Some("{\"type\":\"x\"}".into())));
            assert_eq!(st.take(b"\n"), Seen::Run(None));
            assert_eq!(st.take(b"mango-run:attached\n"), Seen::Run(Some(ATTACHED.into())));
            assert!(RUN_SCRIPT.contains(&format!("echo \"{ATTACHED}\"\necho \"{ATTACHED}\" >&2\n")));
        }

        /// The script itself, on this computer: start behind a noisy login, a dropped attach,
        /// attach again from the byte offsets (no output repeated), the exit marker, the channel
        /// closing with stdin still open, and `gone`. Needs `setsid`, `mkfifo` and GNU `tail --pid`.
        #[cfg(target_os = "linux")]
        #[test]
        fn run_script_survives_a_drop() {
            use std::os::unix::fs::PermissionsExt;
            use std::os::unix::process::CommandExt;

            const FAKE_CLI: &str = "#!/bin/sh\necho \"env=$MANGO_RUN\"\nwhile read -r l; do echo \"got:$l\"; echo \"err:$l\" >&2; [ \"$l\" = quit ] && exit 7; done\necho \"eof\"; exit 3\n";
            let home = std::env::temp_dir().join(format!("mango-run-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&home).unwrap();
            let cli = home.join("fake-cli.sh");
            std::fs::write(&cli, FAKE_CLI).unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
            let id = "t-1";
            // Like the login shell `as_agent` runs it in: a profile that prints first, on both streams.
            let run = |args: &[&str]| {
                let mut c = Command::new("sh");
                c.arg("-c")
                    .arg("echo 'profile says hi'; echo 'profile warns' >&2; exec sh -c \"$MANGO_SCRIPT\" mango-run \"$@\"")
                    .arg("login")
                    .args(args);
                c.env("HOME", &home).env(RUN_TAG, id).env("MANGO_SCRIPT", RUN_SCRIPT);
                c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
                c.spawn().unwrap()
            };
            // The run's lines on a stream as the pump sees them: (line with its bytes) after the marker only.
            let lines = |r: Box<dyn Read + Send>| {
                let (tx, rx) = mpsc::channel::<Vec<u8>>();
                std::thread::spawn(move || {
                    let mut st = Stream::default();
                    read_lines(r, |raw| {
                        if let Seen::Run(_) = st.take(raw) {
                            let _ = tx.send(raw.to_vec());
                        }
                    })
                });
                rx
            };
            // On a stall, say where, with what the run folder and the processes looked like (CI has no shell).
            let report = |stage: &str| -> String {
                let dir = home.join(".cache/mango/runs").join(id);
                let mut s = format!("stalled at {stage}\n");
                for f in ["pid", "code", "closed", "out", "err"] {
                    let v = std::fs::read_to_string(dir.join(f)).unwrap_or_else(|e| format!("<{e}>"));
                    s.push_str(&format!("{f}: {v:?}\n"));
                }
                if let Ok(o) = Command::new("ps").args(["-eo", "pid,ppid,pgid,sid,stat,args"]).output() {
                    s.push_str(&String::from_utf8_lossy(&o.stdout));
                }
                s
            };
            let next = |rx: &mpsc::Receiver<Vec<u8>>, stage: &str| match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(l) => l,
                Err(_) => panic!("{}", report(stage)),
            };
            // A child that must end by itself, bounded so a stall fails the test instead of hanging CI.
            let ends = |c: &mut std::process::Child, stage: &str| -> std::process::ExitStatus {
                let t = std::time::Instant::now();
                loop {
                    if let Some(st) = c.try_wait().unwrap() {
                        return st;
                    }
                    if t.elapsed() > Duration::from_secs(20) {
                        let r = report(stage);
                        let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", c.id())]).status();
                        let _ = c.wait();
                        panic!("{r}");
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            };

            let mut a = run(&["start", id, cli.to_str().unwrap()]);
            let mut stdin = a.stdin.take().unwrap();
            let out = lines(Box::new(a.stdout.take().unwrap()));
            let err = lines(Box::new(a.stderr.take().unwrap()));
            writeln!(stdin, "one").unwrap();
            let (o1, o2, e1) = (next(&out, "start: env"), next(&out, "start: got:one"), next(&err, "start: err:one"));
            assert_eq!((o1.as_slice(), o2.as_slice(), e1.as_slice()), (&b"env=t-1\n"[..], &b"got:one\n"[..], &b"err:one\n"[..]));
            // The connection drops: everything of this attach goes, the run stays.
            Command::new("kill").args(["-KILL", "--", &format!("-{}", a.id())]).status().unwrap();
            ends(&mut a, "the dropped attach going away");
            drop(stdin);

            // Offsets: only the run's bytes, the profile's and the marker's left out.
            let (ob, eb) = (o1.len() + o2.len(), e1.len());
            let mut b = run(&["attach", id, &ob.to_string(), &eb.to_string()]);
            let mut stdin = b.stdin.take().unwrap();
            let out = lines(Box::new(b.stdout.take().unwrap()));
            let err = lines(Box::new(b.stderr.take().unwrap()));
            writeln!(stdin, "two").unwrap();
            writeln!(stdin, "quit").unwrap();
            // Nothing from before the drop comes again.
            assert_eq!(next(&out, "attach: got:two"), b"got:two\n");
            assert_eq!(next(&out, "attach: got:quit"), b"got:quit\n");
            assert_eq!(next(&err, "attach: err:two"), b"err:two\n");
            assert_eq!(next(&err, "attach: err:quit"), b"err:quit\n");
            let marker = String::from_utf8(next(&err, "attach: exit marker")).unwrap();
            assert_eq!(split_marker(marker.trim_end()), ("", Some(Marker::Exit(7))));
            // The channel ends by itself after the run, with its stdin still open.
            assert_eq!(ends(&mut b, "attach: channel end after exit").code(), Some(7));
            assert!(out.recv_timeout(Duration::from_secs(1)).is_err());
            drop(stdin);

            // A run that is not there: `gone` on stderr, after the profile's noise.
            let mut c = run(&["attach", "nope", "0", "0"]);
            drop(c.stdin.take());
            ends(&mut c, "gone");
            let c = c.wait_with_output().unwrap();
            assert_eq!(String::from_utf8_lossy(&c.stderr), "profile warns\nmango-run:gone\n");
            let _ = std::fs::remove_dir_all(&home);
        }
    }
}
