//! Terminals inside an instance (shell, CLI sign-in), project folders, and the
//! desktop tunnel.
//!
//! Sign-in always runs the tool's own flow in a terminal the user watches;
//! Mango never sees the credentials.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};

use super::ssh::{self, Mode};
use super::{blocking, hosts, valid_instance, valid_instance_dir, valid_tag, EnvHost};

/* ---------- terminals ---------- */

/// A folder from the webview: `None`/empty is the agent's home, anything else must be absolute.
fn clean_dir(dir: Option<String>) -> Result<Option<String>, String> {
    let Some(dir) = dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) else { return Ok(None) };
    let dir = if dir.len() > 1 { dir.trim_end_matches('/').to_string() } else { dir };
    let dir = if dir.is_empty() { "/".to_string() } else { dir };
    valid_instance_dir(&dir)?;
    Ok(Some(dir))
}

/// Master-side argv: an interactive login shell as the agent user, in `cwd`.
fn shell_line(host: &EnvHost, instance: &str, cwd: Option<&str>) -> Result<Vec<String>, String> {
    let inner = ssh::as_agent(cwd, &[], &["bash".into(), "-l".into()]);
    ssh::in_instance(host, instance, Mode::Tty, &inner)
}

#[tauri::command]
pub async fn env_shell(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    instance: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    valid_instance(&instance)?;
    let cwd = clean_dir(cwd)?;
    let host = {
        let app = app.clone();
        blocking(move || hosts::get(&app, &host_id)).await?
    };
    let argv = ssh::argv(&host, Mode::Tty, &shell_line(&host, &instance, cwd.as_deref())?)?;
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[])
}

/// A bash snippet that stops with a readable line when `bin` is missing.
fn need(bin: &str, what: &str) -> String {
    format!(
        "command -v {bin} >/dev/null 2>&1 || {{ echo \"{what} is not installed in this environment. Install it from the environment's components first.\"; exit 1; }}; "
    )
}

/// Master-side argv running `tool`'s own sign-in inside the instance.
fn login_line(host: &EnvHost, instance: &str, tool: &str) -> Result<Vec<String>, String> {
    let as_agent = |script: String| ssh::as_agent(None, &[], &["bash".into(), "-c".into(), script]);
    let inner = match tool {
        // The same command Settings > Agents runs locally; it prints a link and asks for the code.
        "claude" => as_agent(need("claude", "Claude Code") + "exec claude auth login"),
        // Device-code sign-in: nothing needs to reach a browser on the instance.
        "codex" => as_agent(need("codex", "Codex") + "exec codex login --device-auth"),
        // Browser (device) sign-in without prompts: there is no browser in the instance, so GH_BROWSER=echo
        // prints the device page and Mango opens it here. Then git uses gh's sign-in for https remotes.
        "gh" => as_agent(need("gh", "The GitHub CLI") + "GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web && exec gh auth setup-git"),
        // Root (incus exec runs as root; sudo in a joined environment): it joins the whole instance to the tailnet.
        "tailscale" => {
            let mut script = need("tailscale", "Tailscale") + "exec tailscale up --ssh";
            let tags = host.tailscale.as_ref().map(|t| t.tags.clone()).unwrap_or_default();
            if !tags.is_empty() {
                for t in &tags {
                    valid_tag(t)?;
                }
                script.push_str(&format!(" --advertise-tags={}", tags.join(",")));
            }
            vec!["bash".into(), "-lc".into(), script]
        }
        other => return Err(format!("Mango can't sign in to \"{other}\" in an environment.")),
    };
    ssh::in_instance(host, instance, Mode::Tty, &inner)
}

#[tauri::command]
pub async fn env_login(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    instance: String,
    tool: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    valid_instance(&instance)?;
    let host = {
        let app = app.clone();
        blocking(move || hosts::get(&app, &host_id)).await?
    };
    let argv = ssh::argv(&host, Mode::Tty, &login_line(&host, &instance, &tool)?)?;
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[])
}

/* ---------- project folders ---------- */

/// A repository URL Mango will hand to `git clone`: https://, ssh://, or scp-like `user@host:path`.
pub fn valid_clone_url(s: &str) -> Result<(), String> {
    let bad = || Err(format!("\"{s}\" doesn't look like a git URL. Use https://…, ssh://… or git@host:owner/repo.git."));
    if s.is_empty() || s.len() > 2000 || s.starts_with('-') || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return bad();
    }
    let word = |w: &str| {
        !w.is_empty() && !w.starts_with('-') && w.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    let ok = if let Some(rest) = s.strip_prefix("https://") {
        let authority = rest.split('/').next().unwrap_or("");
        if authority.contains('@') {
            return Err(
                "Leave the sign-in out of the URL: sign in to GitHub (gh) in the environment instead, and git will use it."
                    .into(),
            );
        }
        let host = authority.split(':').next().unwrap_or("");
        word(host) && rest.len() > authority.len() + 1
    } else if let Some(rest) = s.strip_prefix("ssh://") {
        let authority = rest.split('/').next().unwrap_or("");
        let host = authority.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("");
        word(host) && rest.len() > authority.len() + 1
    } else if let Some((user_host, path)) = s.split_once(':') {
        // scp-like `user@host:path` (no scheme, and no `::` transport helpers such as `ext::`).
        let (user, host) = user_host.split_once('@').unwrap_or(("", ""));
        word(user) && word(host) && !path.is_empty() && !path.starts_with(':') && !path.starts_with("//")
    } else {
        false
    };
    if ok {
        Ok(())
    } else {
        bad()
    }
}

/// `bash -c` script, `$1` = folder, `$2` = URL or empty, `$3` = `1` to `git init` the folder
/// (without a URL, and only when it has no `.git` yet, files or not, like `git init` itself).
/// Always exits 0 and reports on stdout with a `MANGO-DIR:` or `MANGO-ERR:` line, so a failure inside the instance is
/// never mistaken for an SSH problem (git's own "Permission denied (publickey)" included).
const PREPARE_SCRIPT: &str = r#"dir=$1; url=$2; init=$3
if [ -z "$url" ]; then
  out=$(mkdir -p -- "$dir" 2>&1) || { printf 'MANGO-ERR:mkdir\n%s\n' "$out"; exit 0; }
  if [ "$init" = 1 ] && [ ! -e "$dir/.git" ]; then
    command -v git >/dev/null 2>&1 || { echo MANGO-ERR:nogit; exit 0; }
    out=$(cd -- "$dir" && git init --quiet 2>&1) || { printf 'MANGO-ERR:init\n%s\n' "$out"; exit 0; }
  fi
else
  if [ -e "$dir" ] && { [ ! -d "$dir" ] || [ -n "$(ls -A -- "$dir" 2>/dev/null)" ]; }; then
    echo MANGO-ERR:notempty; exit 0
  fi
  command -v git >/dev/null 2>&1 || { echo MANGO-ERR:nogit; exit 0; }
  out=$(mkdir -p -- "$(dirname -- "$dir")" 2>&1) || { printf 'MANGO-ERR:mkdir\n%s\n' "$out"; exit 0; }
  export GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new}"
  out=$(timeout 570 git clone --quiet -- "$url" "$dir" 2>&1); code=$?
  [ $code -eq 0 ] || { printf 'MANGO-ERR:clone %s\n%s\n' "$code" "$out"; exit 0; }
fi
cd -- "$dir" 2>/dev/null && printf 'MANGO-DIR:%s\n' "$(pwd)""#;

fn prepare_line(
    host: &EnvHost,
    instance: &str,
    dir: &str,
    url: Option<&str>,
    git_init: bool,
) -> Result<Vec<String>, String> {
    let argv: Vec<String> = vec![
        "bash".into(),
        "-c".into(),
        PREPARE_SCRIPT.into(),
        "mango-prepare".into(),
        dir.into(),
        url.unwrap_or("").into(),
        if git_init { "1" } else { "" }.into(),
    ];
    let inner = ssh::as_agent(None, &[], &argv);
    ssh::in_instance(host, instance, Mode::Batch, &inner)
}

/// Turn [`PREPARE_SCRIPT`]'s report into the folder or a message a person can act on.
fn parse_prepare(out: &str, dir: &str, url: Option<&str>) -> Result<String, String> {
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    let url = url.unwrap_or("");
    if let Some(i) = lines.iter().position(|l| l.starts_with("MANGO-ERR:")) {
        let kind = &lines[i]["MANGO-ERR:".len()..];
        let detail: Vec<&str> = lines[i + 1..].iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        let tail = detail[detail.len().saturating_sub(4)..].join("\n");
        let with_tail = |msg: String| if tail.is_empty() { msg } else { format!("{msg}\n{tail}") };
        let lower = tail.to_lowercase();
        return Err(match kind.split_whitespace().next().unwrap_or("") {
            "notempty" => format!("{dir} already exists and is not empty, so Mango won't clone into it. Pick a new or empty folder."),
            "nogit" => "git is not installed in this environment. Install the base component first.".into(),
            "init" => with_tail(format!("Could not start a git repository in {dir}.")),
            "mkdir" => with_tail(format!(
                "Could not create {dir} in the environment. The agent user can only write inside its home ({}) and folders it owns.",
                super::AGENT_HOME
            )),
            "clone" if kind.ends_with(" 124") => {
                format!("Cloning {url} took longer than 10 minutes and was stopped. Clone it from the environment's terminal instead.")
            }
            "clone"
                if [
                    "could not read username",
                    "authentication failed",
                    "terminal prompts disabled",
                    "permission denied (publickey",
                    "repository not found",
                    "invalid username or password",
                    "host key verification failed",
                ]
                .iter()
                .any(|p| lower.contains(p)) =>
            {
                with_tail(format!(
                    "Could not clone {url}: the server refused access. For a private GitHub repository, sign in to GitHub (gh) in this environment, then try again."
                ))
            }
            "clone" if lower.contains("could not resolve host") || lower.contains("connection timed out") => {
                with_tail(format!("Could not clone {url}: the environment could not reach its server. Check the URL and the environment's network."))
            }
            "clone" => with_tail(format!("Could not clone {url}.")),
            _ => with_tail(format!("Could not prepare {dir} in the environment.")),
        });
    }
    lines
        .iter()
        .rev()
        .find_map(|l| l.strip_prefix("MANGO-DIR:"))
        .map(str::to_string)
        .ok_or_else(|| {
            let tail: Vec<&str> = lines.iter().copied().filter(|l| !l.trim().is_empty()).collect();
            format!(
                "Could not prepare {dir} in the environment.\n{}",
                tail[tail.len().saturating_sub(4)..].join("\n")
            )
            .trim_end()
            .to_string()
        })
}

#[tauri::command]
pub async fn env_prepare_dir(
    app: AppHandle,
    host_id: String,
    instance: String,
    dir: String,
    clone_url: Option<String>,
    git_init: Option<bool>,
) -> Result<String, String> {
    valid_instance(&instance)?;
    let dir = clean_dir(Some(dir))?.ok_or("Pick a folder inside the environment.")?;
    let url = clone_url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    if let Some(u) = &url {
        valid_clone_url(u)?;
    }
    // A clone is already a repository: `gitInit` only applies to a plain folder.
    let git_init = url.is_none() && git_init.unwrap_or(false);
    blocking(move || {
        let host = hosts::get(&app, &host_id)?;
        let line = prepare_line(&host, &instance, &dir, url.as_deref(), git_init)?;
        let timeout = Duration::from_secs(if url.is_some() { 600 } else { 30 });
        let out = ssh::run(&host, &line, timeout)?;
        parse_prepare(&out, &dir, url.as_deref())
    })
    .await
}

/* ---------- folder browser ---------- */

/// Most sub-folders [`env_list_dir`] returns.
const LIST_LIMIT: usize = 500;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvDirEntry {
    pub name: String,
    pub path: String,
    pub is_git: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvDirListing {
    pub dir: String,
    pub parent: Option<String>,
    pub entries: Vec<EnvDirEntry>,
    pub truncated: bool,
}

/// `/a//b/./c` -> `/a/b/c`; `/` stays `/`. Expects an absolute path without `..`.
fn normalize_dir(p: &str) -> String {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    format!("/{}", parts.join("/"))
}

/// A folder to list, from the webview: `~` (or empty) and `~/…` are the agent's home.
fn resolve_list_dir(dir: &str) -> Result<String, String> {
    let home = super::AGENT_HOME;
    let abs = if dir.is_empty() || dir == "~" {
        home.to_string()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        dir.to_string()
    };
    valid_instance_dir(&abs)?;
    Ok(normalize_dir(&abs))
}

fn parent_dir(dir: &str) -> Option<String> {
    match dir.rsplit_once('/') {
        _ if dir == "/" => None,
        Some(("", _)) => Some("/".into()),
        Some((p, _)) => Some(p.to_string()),
        None => None,
    }
}

/// `bash -c` script, `$1` = absolute folder. Reports `MANGO-ERR:<kind>`, or one
/// `MANGO-LIST:<base64>` line whose payload is NUL-terminated records: `D<folder>`, then
/// `G<name>` (has `.git`) / `F<name>` per non-hidden sub-folder in byte order (symlinks to
/// folders included), and `+` when more than the limit exist. Names never pass through
/// the shell as code, and base64 keeps newlines and odd bytes intact.
const LIST_SCRIPT: &str = r#"export LC_ALL=C
shopt -s nullglob
d=$1
if [ ! -e "$d" ]; then echo MANGO-ERR:missing; exit 0; fi
if [ ! -d "$d" ]; then echo MANGO-ERR:notdir; exit 0; fi
{ cd -- "$d" 2>/dev/null && [ -r . ]; } || { echo MANGO-ERR:denied; exit 0; }
command -v base64 >/dev/null 2>&1 || { echo MANGO-ERR:nobase64; exit 0; }
list() {
  printf 'D%s\0' "$PWD"
  n=0
  for e in *; do
    [ -d "$e" ] || continue
    if [ "$n" -ge 500 ]; then printf '+\0'; break; fi
    n=$((n + 1))
    if [ -e "$e/.git" ]; then printf 'G%s\0' "$e"; else printf 'F%s\0' "$e"; fi
  done
}
printf 'MANGO-LIST:%s\n' "$(list | base64 | tr -d '\n')""#;

fn list_line(host: &EnvHost, instance: &str, dir: &str) -> Result<Vec<String>, String> {
    let argv: Vec<String> =
        vec!["bash".into(), "-c".into(), LIST_SCRIPT.into(), "mango-list".into(), dir.into()];
    ssh::in_instance(host, instance, Mode::Batch, &ssh::as_agent(None, &[], &argv))
}

/// Turn [`LIST_SCRIPT`]'s report for `dir` into a listing or a message a person can act on.
fn parse_listing(out: &str, dir: &str) -> Result<EnvDirListing, String> {
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    if let Some(kind) = lines.iter().find_map(|l| l.strip_prefix("MANGO-ERR:")) {
        return Err(match kind {
            "missing" => format!("{dir} does not exist in the environment (or the agent user can't reach it)."),
            "notdir" => format!("{dir} is a file, not a folder."),
            "denied" => format!("The agent user is not allowed to open {dir}."),
            "nobase64" => "base64 is not installed in this environment. Install the base component first.".into(),
            _ => format!("Could not list {dir} in the environment."),
        });
    }
    let unreadable = || {
        let tail: Vec<&str> = lines.iter().copied().filter(|l| !l.trim().is_empty()).collect();
        format!("Could not list {dir} in the environment.\n{}", tail[tail.len().saturating_sub(4)..].join("\n"))
            .trim_end()
            .to_string()
    };
    let payload = lines.iter().rev().find_map(|l| l.strip_prefix("MANGO-LIST:")).ok_or_else(unreadable)?;
    let bytes = STANDARD.decode(payload.trim()).map_err(|_| unreadable())?;

    let mut listed = dir.to_string();
    let mut names: Vec<(String, bool)> = Vec::new();
    let mut truncated = false;
    for rec in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let text = String::from_utf8_lossy(&rec[1..]).into_owned();
        match rec[0] {
            b'D' if text.starts_with('/') && !text.split('/').any(|p| p == "..") => listed = normalize_dir(&text),
            b'G' | b'F' if !text.is_empty() && !text.contains('/') => names.push((text, rec[0] == b'G')),
            b'+' => truncated = true,
            _ => {}
        }
    }
    names.sort();
    names.dedup();
    if names.len() > LIST_LIMIT {
        names.truncate(LIST_LIMIT);
        truncated = true;
    }
    let base = if listed == "/" { String::new() } else { listed.clone() };
    let entries =
        names.into_iter().map(|(name, is_git)| EnvDirEntry { path: format!("{base}/{name}"), name, is_git }).collect();
    Ok(EnvDirListing { parent: parent_dir(&listed), dir: listed, entries, truncated })
}

#[tauri::command]
pub async fn env_list_dir(app: AppHandle, host_id: String, instance: String, dir: String) -> Result<EnvDirListing, String> {
    valid_instance(&instance)?;
    let dir = resolve_list_dir(&dir)?;
    blocking(move || {
        let host = hosts::get(&app, &host_id)?;
        let out = ssh::run(&host, &list_line(&host, &instance, &dir)?, Duration::from_secs(30))?;
        parse_listing(&out, &dir)
    })
    .await
}

/* ---------- desktop tunnel ----------
 * The instance runs `mango-novnc.service`: websockify serving noVNC on 127.0.0.1:6080 inside the
 * instance (installed by the `desktop` component; `socat` comes with `base`). Mango listens on a
 * random local port and carries every accepted connection over its own
 * `ssh … incus exec T -T -- socat - TCP:127.0.0.1:6080` (`sudo -n -- socat …` in a joined environment).
 */

/// Where websockify listens inside the instance.
const NOVNC_ADDR: &str = "TCP:127.0.0.1:6080";

/// The far end of one tunnelled connection.
pub(crate) struct Upstream {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    /// Ends it (kills the ssh); safe to call more than once.
    close: Arc<dyn Fn() + Send + Sync>,
}

pub(crate) type Dialer = Arc<dyn Fn() -> Result<Upstream, String> + Send + Sync>;

struct Live {
    client: TcpStream,
    close: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    serving: AtomicBool,
    next: AtomicU64,
    conns: Mutex<HashMap<u64, Live>>,
}

pub(crate) struct Tunnel {
    pub(crate) port: u16,
    shared: Arc<Shared>,
}

/// Which pages may use a tunnel: only its own (the desktop), or any page served from this
/// computer's loopback (the browser's tunnels to dev servers, which call each other across ports).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Origins {
    Own,
    Loopback,
}

impl Tunnel {
    /// Listen on a random local port and serve every connection through `dialer`.
    fn start(dialer: Dialer) -> Result<Tunnel, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Could not open a local port for the desktop: {e}"))?;
        Self::serve_on(listener, dialer, Origins::Own)
    }

    /// Serve every connection to `listener` (bound to 127.0.0.1) through `dialer`.
    pub(crate) fn serve_on(listener: TcpListener, dialer: Dialer, origins: Origins) -> Result<Tunnel, String> {
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let shared = Arc::new(Shared::default());
        shared.serving.store(true, Ordering::SeqCst);
        let s = shared.clone();
        std::thread::Builder::new()
            .name(format!("desktop-tunnel-{port}"))
            .spawn(move || serve(listener, s, dialer, port, origins))
            .map_err(|e| format!("Could not start the tunnel: {e}"))?;
        Ok(Tunnel { port, shared })
    }

    pub(crate) fn alive(&self) -> bool {
        !self.shared.stop.load(Ordering::SeqCst) && self.shared.serving.load(Ordering::SeqCst)
    }

    /// Stop listening and end every open connection (and its ssh).
    pub(crate) fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop so it sees the flag and drops the listener.
        let _ = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], self.port)), Duration::from_millis(500));
        let live: Vec<Live> = self.shared.conns.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, l)| l).collect();
        for l in live {
            let _ = l.client.shutdown(Shutdown::Both);
            (l.close)();
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/vnc.html?autoconnect=1&resize=remote&reconnect=1", self.port)
    }
}

fn serve(listener: TcpListener, shared: Arc<Shared>, dialer: Dialer, port: u16, origins: Origins) {
    for conn in listener.incoming() {
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(client) = conn else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        let (shared, dialer) = (shared.clone(), dialer.clone());
        let _ = std::thread::Builder::new()
            .name("desktop-conn".into())
            .spawn(move || handle(client, &shared, &dialer, port, origins));
    }
    // Close the port before saying so: a connection in between would still be accepted by the kernel.
    drop(listener);
    shared.serving.store(false, Ordering::SeqCst);
}

/// Read the first request's head (up to the blank line), keeping whatever came with it.
fn read_head(client: &mut TcpStream) -> io::Result<(Vec<u8>, usize)> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok((buf, i + 4));
        }
        if buf.len() > 32 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
        let n = client.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// Only pages of the tunnel itself may use it. A browser always sends the real
/// `Host`, and `Origin` on cross-origin and WebSocket requests, so this turns
/// away other web pages (including DNS rebinding) trying to reach the desktop
/// through the local port. Browsers never reuse a connection across origins
/// and open every WebSocket on a fresh one, so the first request is enough.
fn check_request(head: &[u8], port: u16, origins: Origins) -> Result<(), &'static str> {
    let text = std::str::from_utf8(head).map_err(|_| "not HTTP")?;
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    if !first.ends_with(" HTTP/1.1") && !first.ends_with(" HTTP/1.0") {
        return Err("not HTTP");
    }
    let ours = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let mut host_ok = false;
    for l in lines {
        let Some((name, value)) = l.split_once(':') else { continue };
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            host_ok = ours.iter().any(|o| o == value);
        } else if name.eq_ignore_ascii_case("origin") && !ours.iter().any(|o| value == format!("http://{o}")) {
            if origins == Origins::Loopback && loopback_origin(value) {
                continue;
            }
            return Err("foreign origin");
        }
    }
    if host_ok {
        Ok(())
    } else {
        Err("foreign host")
    }
}

/// `http(s)://localhost[:port]`, `http(s)://127.0.0.1[:port]` or `http(s)://[::1][:port]`.
fn loopback_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else { return false };
    let host = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => rest,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn handle(mut client: TcpStream, shared: &Shared, dialer: &Dialer, port: u16, origins: Origins) {
    let _ = client.set_nodelay(true);
    let _ = client.set_read_timeout(Some(Duration::from_secs(15)));
    let Ok((head, end)) = read_head(&mut client) else { return };
    if let Err(why) = check_request(&head[..end], port, origins) {
        let body = format!("Mango refused this request ({why}).\n");
        let _ = client.write_all(
            format!("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                .as_bytes(),
        );
        return;
    }
    let _ = client.set_read_timeout(None);
    let up = match dialer() {
        Ok(up) => up,
        Err(e) => {
            let _ = client.write_all(
                format!("HTTP/1.1 502 Bad Gateway\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{e}", e.len()).as_bytes(),
            );
            return;
        }
    };
    let Upstream { reader: mut up_r, writer: mut up_w, close } = up;

    let id = shared.next.fetch_add(1, Ordering::SeqCst);
    match client.try_clone() {
        Ok(c) => {
            shared.conns.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Live { client: c, close: close.clone() });
        }
        Err(_) => {
            close();
            return;
        }
    }
    // `stop()` may have drained the map just before the insert.
    if shared.stop.load(Ordering::SeqCst) {
        shared.conns.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        close();
        return;
    }

    // Instance -> browser. When the instance side ends, so does the browser connection.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let down = client.try_clone().ok().map(|mut client_w| {
        std::thread::spawn(move || {
            let _ = io::copy(&mut up_r, &mut client_w);
            let _ = client_w.shutdown(Shutdown::Both);
            let _ = done_tx.send(());
        })
    });

    // Browser -> instance: the head we already read, then the rest.
    if up_w.write_all(&head).and_then(|_| up_w.flush()).is_ok() {
        let _ = io::copy(&mut client, &mut up_w);
    }
    // Browser finished: EOF to socat, which then closes its side; give it a moment.
    drop(up_w);
    if down.is_some() && done_rx.recv_timeout(Duration::from_secs(5)).is_err() {
        close();
    }
    if let Some(d) = down {
        let _ = d.join();
    }
    close();
    let _ = client.shutdown(Shutdown::Both);
    shared.conns.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
}

/// Connections through `ssh … incus exec T -T -- socat - TCP:127.0.0.1:6080`.
fn ssh_dialer(host: &EnvHost, instance: &str) -> Result<Dialer, String> {
    ssh_dialer_to(host, instance, NOVNC_ADDR)
}

/// Connections to `addr` (a socat address such as `TCP:127.0.0.1:3000`) inside the instance.
pub(crate) fn ssh_dialer_to(host: &EnvHost, instance: &str, addr: &str) -> Result<Dialer, String> {
    let inner = ["socat".to_string(), "-".into(), addr.to_string()];
    let argv = ssh::argv(host, Mode::Batch, &ssh::in_instance(host, instance, Mode::Batch, &inner)?)?;
    Ok(Arc::new(move || {
        let mut cmd = ssh::command(&argv);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child: Child = cmd.spawn().map_err(|e| format!("Could not start ssh: {e}"))?;
        let reader = child.stdout.take().ok_or("No output from ssh")?;
        let writer = child.stdin.take().ok_or("No input to ssh")?;
        let child = Arc::new(Mutex::new(child));
        let close = Arc::new(move || {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
                let _ = c.wait();
            }
        });
        Ok(Upstream { reader: Box::new(reader), writer: Box::new(writer), close })
    }))
}

/// Is the desktop service up (and `socat` there to reach it)? Reads [`desktop_check_line`]'s output.
fn desktop_status(out: &str, instance: &str) -> Result<(), String> {
    let last = out.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("");
    match last {
        "active" => Ok(()),
        "no-socat" => Err(format!("socat is missing in {instance}. Install (or update) the base component first.")),
        "activating" | "reloading" => Err(format!("The desktop in {instance} is still starting. Try again in a moment.")),
        other => Err(format!(
            "Install the Desktop component first: the desktop is not running in {instance}{}. If it is installed, restart the environment.",
            if other.is_empty() { String::new() } else { format!(" (its service is {other})") }
        )),
    }
}

fn desktop_check_line(host: &EnvHost, instance: &str) -> Result<Vec<String>, String> {
    let script = "command -v socat >/dev/null 2>&1 || { echo no-socat; exit 0; }; systemctl is-active mango-novnc.service 2>/dev/null; exit 0";
    ssh::in_instance(host, instance, Mode::Batch, &["sh".into(), "-c".into(), script.into()])
}

#[derive(Default)]
pub struct DesktopState {
    tunnels: Mutex<HashMap<String, Tunnel>>,
}

impl DesktopState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Tunnel>> {
        self.tunnels.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn kill_all(&self) {
        let all: Vec<Tunnel> = self.lock().drain().map(|(_, t)| t).collect();
        for t in all {
            t.stop();
        }
    }
}

fn tunnel_key(host_id: &str, instance: &str) -> String {
    format!("{host_id}\n{instance}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDesktop {
    /// The noVNC page to load, e.g. http://127.0.0.1:53211/vnc.html?autoconnect=1&resize=remote
    pub url: String,
}

#[tauri::command]
pub async fn env_desktop_open(
    app: AppHandle,
    state: State<'_, DesktopState>,
    host_id: String,
    instance: String,
) -> Result<EnvDesktop, String> {
    valid_instance(&instance)?;
    let host = {
        let (host_id, instance) = (host_id.clone(), instance.clone());
        blocking(move || {
            let host = hosts::get(&app, &host_id)?;
            let out = ssh::run(&host, &desktop_check_line(&host, &instance)?, Duration::from_secs(30))?;
            desktop_status(&out, &instance)?;
            Ok(host)
        })
        .await?
    };
    let key = tunnel_key(&host_id, &instance);
    let mut tunnels = state.lock();
    if let Some(t) = tunnels.get(&key) {
        if t.alive() {
            return Ok(EnvDesktop { url: t.url() });
        }
        if let Some(t) = tunnels.remove(&key) {
            t.stop();
        }
    }
    let tunnel = Tunnel::start(ssh_dialer(&host, &instance)?)?;
    let url = tunnel.url();
    tunnels.insert(key, tunnel);
    Ok(EnvDesktop { url })
}

#[tauri::command]
pub async fn env_desktop_close(state: State<'_, DesktopState>, host_id: String, instance: String) -> Result<(), String> {
    let tunnel = state.lock().remove(&tunnel_key(&host_id, &instance));
    if let Some(t) = tunnel {
        // Killing the ssh processes can take a moment; keep it off the UI thread.
        blocking(move || {
            t.stop();
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envs::EnvTailscale;

    fn host() -> EnvHost {
        EnvHost {
            id: "h".into(),
            name: "Lab".into(),
            ssh: "me@lab".into(),
            port: None,
            identity_file: None,
            incus_remote: None,
            tailscale: None,
            public_address: None,
            direct: None,
        }
    }

    #[test]
    fn dirs() {
        assert_eq!(clean_dir(None).unwrap(), None);
        assert_eq!(clean_dir(Some("  ".into())).unwrap(), None);
        assert_eq!(clean_dir(Some("/home/agent/work/app/".into())).unwrap().as_deref(), Some("/home/agent/work/app"));
        assert_eq!(clean_dir(Some("/".into())).unwrap().as_deref(), Some("/"));
        assert!(clean_dir(Some("work".into())).is_err());
        assert!(clean_dir(Some("/a/../b".into())).is_err());
    }

    #[test]
    fn shell_and_login_lines() {
        let h = host();
        let l = ssh::line(&shell_line(&h, "dev", Some("/home/agent/work/my app")).unwrap());
        assert!(l.starts_with("incus exec dev -t -- runuser -u agent -- env HOME=/home/agent"), "{l}");
        assert!(l.ends_with("mango '/home/agent/work/my app' bash -l"), "{l}");

        let l = ssh::line(&login_line(&h, "dev", "claude").unwrap());
        assert!(l.starts_with("incus exec dev -t -- runuser -u agent"), "{l}");
        assert!(l.contains("exec claude auth login'"), "{l}");
        let l = ssh::line(&login_line(&h, "dev", "codex").unwrap());
        assert!(l.contains("exec codex login --device-auth'"), "{l}");
        let l = ssh::line(&login_line(&h, "dev", "gh").unwrap());
        assert!(l.contains("GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web && exec gh auth setup-git'"), "{l}");

        // Tailscale runs as root, with the server's tags.
        let mut ts = h.clone();
        ts.tailscale = Some(EnvTailscale { tags: vec!["tag:mango".into(), "tag:dev".into()], auth_key_file: None });
        let l = ssh::line(&login_line(&ts, "dev", "tailscale").unwrap());
        assert!(l.starts_with("incus exec dev -t -- bash -lc '"), "{l}");
        assert!(!l.contains("runuser"), "{l}");
        assert!(l.ends_with("exec tailscale up --ssh --advertise-tags=tag:mango,tag:dev'"), "{l}");

        assert!(login_line(&h, "dev", "rm -rf").is_err());
        ts.tailscale = Some(EnvTailscale { tags: vec!["tag:x;id".into()], auth_key_file: None });
        assert!(login_line(&ts, "dev", "tailscale").is_err());
    }

    #[test]
    fn clone_urls() {
        for ok in [
            "https://github.com/owner/repo.git",
            "https://github.com/owner/repo",
            "ssh://git@github.com/owner/repo.git",
            "ssh://git@host:2222/srv/repo.git",
            "git@github.com:owner/repo.git",
            "git@gitlab.example.com:group/sub/repo",
            "me@host:/srv/git/repo.git",
        ] {
            assert!(valid_clone_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-uhttps://x",
            "--upload-pack=touch /tmp/x",
            "https://github.com/a b",
            "https://github.com/a\nb",
            "ext::sh -c touch% /tmp/pwned",
            "ext::sh",
            "file:///etc",
            "/srv/repo",
            "http://example.com/repo",
            "https://",
            "https://github.com",
            "https://me:ghp_secret@github.com/o/r.git",
            "git@github.com:",
            "github.com:owner/repo",
            "git@-oProxyCommand=x:repo",
            "fd::17",
        ] {
            assert!(valid_clone_url(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn prepare_line_passes_dir_and_url_as_arguments() {
        let l =
            ssh::line(&prepare_line(&host(), "dev", "/home/agent/work/a b", Some("git@github.com:o/r.git"), false).unwrap());
        assert!(l.starts_with("incus exec dev -T -- runuser -u agent"), "{l}");
        assert!(l.ends_with("mango-prepare '/home/agent/work/a b' git@github.com:o/r.git ''"), "{l}");
        let l = ssh::line(&prepare_line(&host(), "dev", "/w", None, false).unwrap());
        assert!(l.ends_with("mango-prepare /w '' ''"), "{l}");
        let l = ssh::line(&prepare_line(&host(), "dev", "/w", None, true).unwrap());
        assert!(l.ends_with("mango-prepare /w '' 1"), "{l}");
    }

    #[test]
    fn prepare_reports() {
        let d = "/home/agent/work/app";
        let u = Some("https://github.com/o/r.git");
        assert_eq!(parse_prepare("welcome\nMANGO-DIR:/home/agent/work/app\n", d, None).unwrap(), d);
        let e = parse_prepare("MANGO-ERR:notempty\n", d, u).unwrap_err();
        assert!(e.contains("not empty"), "{e}");
        let e = parse_prepare(
            "MANGO-ERR:clone 128\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
            d,
            u,
        )
        .unwrap_err();
        assert!(e.contains("sign in to GitHub (gh)"), "{e}");
        assert!(e.contains("terminal prompts disabled"), "{e}");
        let e = parse_prepare("MANGO-ERR:clone 128\ngit@github.com: Permission denied (publickey).\n", d, u).unwrap_err();
        assert!(e.contains("refused access") && !e.contains("SSH sign-in"), "{e}");
        let e = parse_prepare("MANGO-ERR:clone 124\n", d, u).unwrap_err();
        assert!(e.contains("10 minutes"), "{e}");
        let e = parse_prepare("MANGO-ERR:mkdir\nmkdir: cannot create directory '/srv/x': Permission denied\n", "/srv/x", None)
            .unwrap_err();
        assert!(e.starts_with("Could not create /srv/x") && e.contains("Permission denied"), "{e}");
        assert!(parse_prepare("", d, None).is_err());
        let e = parse_prepare("MANGO-ERR:nogit\n", d, None).unwrap_err();
        assert!(e.contains("base component"), "{e}");
        let e = parse_prepare("MANGO-ERR:init\nfatal: cannot mkdir .git: Permission denied\n", d, None).unwrap_err();
        assert!(e.starts_with("Could not start a git repository in /home/agent/work/app"), "{e}");
        assert!(e.contains("cannot mkdir .git"), "{e}");
    }

    #[test]
    fn list_dirs_resolve() {
        assert_eq!(resolve_list_dir("~").unwrap(), "/home/agent");
        assert_eq!(resolve_list_dir("").unwrap(), "/home/agent");
        assert_eq!(resolve_list_dir("~/").unwrap(), "/home/agent");
        assert_eq!(resolve_list_dir("~/work/my app/").unwrap(), "/home/agent/work/my app");
        assert_eq!(resolve_list_dir("/").unwrap(), "/");
        assert_eq!(resolve_list_dir("//srv//./x/").unwrap(), "/srv/x");
        for bad in ["work", "~other", "~/../etc", "/a/../b", "/a\nb", "~root/x"] {
            assert!(resolve_list_dir(bad).is_err(), "{bad:?}");
        }
        assert_eq!(parent_dir("/"), None);
        assert_eq!(parent_dir("/home"), Some("/".into()));
        assert_eq!(parent_dir("/home/agent"), Some("/home".into()));
    }

    #[test]
    fn list_line_passes_dir_as_argument() {
        let l = ssh::line(&list_line(&host(), "dev", "/home/agent/a b").unwrap());
        assert!(l.starts_with("incus exec dev -T -- runuser -u agent"), "{l}");
        assert!(l.ends_with("mango-list '/home/agent/a b'"), "{l}");
        assert!(l.is_ascii(), "keep scripts ASCII: they cross Windows argv conversion");
    }

    fn encoded(records: &[&[u8]]) -> String {
        let mut b = Vec::new();
        for r in records {
            b.extend_from_slice(r);
            b.push(0);
        }
        STANDARD.encode(b)
    }

    #[test]
    fn listings() {
        let payload = encoded(&[
            b"D/home/agent/work",
            b"Gzeta",
            "Fünï".as_bytes(),
            b"Fa b",
            b"Fline\nbreak",
            b"F$(id)",
            b"F-x",
            b"Fbad/name",
            b"F\xff\xfe",
            b"Grepo",
        ]);
        let out = format!("Welcome to the box\nMANGO-LIST:{payload}\n");
        let l = parse_listing(&out, "/home/agent/work").unwrap();
        assert_eq!(l.dir, "/home/agent/work");
        assert_eq!(l.parent.as_deref(), Some("/home/agent"));
        assert!(!l.truncated);
        let names: Vec<&str> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["$(id)", "-x", "a b", "line\nbreak", "repo", "zeta", "ünï", "\u{fffd}\u{fffd}"]);
        let repo = &l.entries[4];
        assert_eq!((repo.path.as_str(), repo.is_git), ("/home/agent/work/repo", true));
        assert_eq!(l.entries[2].path, "/home/agent/work/a b");
        assert!(!l.entries[2].is_git);

        // The root: no parent, no double slash.
        let l = parse_listing(&format!("MANGO-LIST:{}\n", encoded(&[b"D/", b"Fsrv"])), "/").unwrap();
        assert_eq!((l.dir.as_str(), l.parent.as_deref()), ("/", None));
        assert_eq!(l.entries[0].path, "/srv");

        // An empty folder.
        let l = parse_listing(&format!("MANGO-LIST:{}\n", encoded(&[b"D/home/agent"])), "/home/agent").unwrap();
        assert!(l.entries.is_empty() && !l.truncated);
    }

    #[test]
    fn listing_truncation() {
        let names: Vec<Vec<u8>> = (0..LIST_LIMIT).map(|i| format!("F{i:04}").into_bytes()).collect();
        let mut recs: Vec<&[u8]> = vec![b"D/w"];
        recs.extend(names.iter().map(|n| n.as_slice()));
        recs.push(b"+");
        let l = parse_listing(&format!("MANGO-LIST:{}\n", encoded(&recs)), "/w").unwrap();
        assert_eq!(l.entries.len(), LIST_LIMIT);
        assert!(l.truncated);

        // More than the limit without the marker is still capped.
        let more: Vec<Vec<u8>> = (0..LIST_LIMIT + 20).map(|i| format!("F{i:04}").into_bytes()).collect();
        let mut recs: Vec<&[u8]> = vec![b"D/w"];
        recs.extend(more.iter().map(|n| n.as_slice()));
        let l = parse_listing(&format!("MANGO-LIST:{}\n", encoded(&recs)), "/w").unwrap();
        assert_eq!(l.entries.len(), LIST_LIMIT);
        assert!(l.truncated);
        assert_eq!(l.entries.last().unwrap().name, format!("{:04}", LIST_LIMIT - 1));
    }

    #[test]
    fn listing_errors() {
        let d = "/home/agent/nope";
        assert!(parse_listing("MANGO-ERR:missing\n", d).unwrap_err().starts_with("/home/agent/nope does not exist"));
        assert!(parse_listing("MANGO-ERR:notdir\n", d).unwrap_err().contains("not a folder"));
        assert!(parse_listing("MANGO-ERR:denied\n", d).unwrap_err().contains("not allowed to open /home/agent/nope"));
        assert!(parse_listing("MANGO-ERR:nobase64\n", d).unwrap_err().contains("base component"));
        let e = parse_listing("bash: something odd\n", d).unwrap_err();
        assert!(e.starts_with("Could not list /home/agent/nope") && e.contains("something odd"), "{e}");
        assert!(parse_listing("MANGO-LIST:%%%\n", d).is_err());
        assert!(parse_listing("", d).is_err());
    }

    /// A shell that can run the scripts here (not WSL's bash.exe launcher).
    fn real_bash() -> Option<std::path::PathBuf> {
        crate::bin::find("bash").filter(|p| {
            let s = p.to_string_lossy().to_lowercase();
            !s.contains("system32") && !s.contains("windowsapps")
        })
    }

    #[test]
    fn scripts_parse() {
        use std::io::Write;
        let Some(bash) = real_bash() else { return eprintln!("no bash found; skipping") };
        for (name, script) in [("prepare", PREPARE_SCRIPT), ("list", LIST_SCRIPT)] {
            // Through stdin: MSYS/Cygwin shells re-parse a Windows command line with their own quoting rules.
            let mut child = std::process::Command::new(&bash)
                .arg("-n")
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("run bash");
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stderr));
        }
    }

    /// Runs [`LIST_SCRIPT`] against a scratch folder with the local bash (Git Bash on Windows).
    #[test]
    fn list_script_runs() {
        use std::io::Write;
        let Some(bash) = real_bash() else { return eprintln!("no bash found; skipping") };
        let root = std::env::temp_dir().join(format!("mango-list-{}-{}", std::process::id(), crate::envs::now_ms()));
        for d in ["a b", "ünï", "-x", ".hidden", "$(id)", "repo/.git", "plain"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("file.txt"), "x").unwrap();
        let mut child = std::process::Command::new(&bash)
            .args(["-s", "--"])
            .arg(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run bash");
        child.stdin.take().unwrap().write_all(LIST_SCRIPT.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let l = parse_listing(&stdout, "/x").unwrap_or_else(|e| panic!("{e}\n{}", String::from_utf8_lossy(&out.stderr)));
        let names: Vec<(&str, bool)> = l.entries.iter().map(|e| (e.name.as_str(), e.is_git)).collect();
        assert_eq!(
            names,
            [("$(id)", false), ("-x", false), ("a b", false), ("plain", false), ("repo", true), ("ünï", false)]
        );
        assert!(!l.truncated);
    }

    #[test]
    fn desktop_states() {
        assert!(desktop_status("active\n", "dev").is_ok());
        assert!(desktop_status("no-socat\n", "dev").unwrap_err().contains("base component"));
        assert!(desktop_status("inactive\n", "dev").unwrap_err().starts_with("Install the Desktop component first"));
        assert!(desktop_status("", "dev").unwrap_err().starts_with("Install the Desktop component first"));
        assert!(desktop_status("activating", "dev").unwrap_err().contains("still starting"));
        let l = ssh::line(&desktop_check_line(&host(), "dev").unwrap());
        assert!(l.starts_with("incus exec dev -T -- sh -c ") && l.contains("mango-novnc.service"), "{l}");
    }

    #[test]
    fn request_checks() {
        let ok = b"GET /vnc.html HTTP/1.1\r\nHost: 127.0.0.1:5000\r\n\r\n";
        assert!(check_request(ok, 5000, Origins::Own).is_ok());
        let ws = b"GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nUpgrade: websocket\r\nOrigin: http://127.0.0.1:5000\r\n\r\n";
        assert!(check_request(ws, 5000, Origins::Own).is_ok());
        let foreign = b"GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: https://evil.example\r\n\r\n";
        assert_eq!(check_request(foreign, 5000, Origins::Own), Err("foreign origin"));
        let rebound = b"GET / HTTP/1.1\r\nHost: evil.example:5000\r\n\r\n";
        assert_eq!(check_request(rebound, 5000, Origins::Own), Err("foreign host"));
        assert_eq!(check_request(b"GET / HTTP/1.1\r\n\r\n", 5000, Origins::Own), Err("foreign host"));
        assert_eq!(check_request(b"\x16\x03\x01garbage\r\n\r\n", 5000, Origins::Own), Err("not HTTP"));
        // The browser's tunnels also take pages from other loopback ports (a dev frontend calling its API).
        let api = b"GET / HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: http://localhost:3000\r\n\r\n";
        assert_eq!(check_request(api, 5000, Origins::Own), Err("foreign origin"));
        assert!(check_request(api, 5000, Origins::Loopback).is_ok());
        let web = b"GET / HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nOrigin: https://evil.example\r\n\r\n";
        assert_eq!(check_request(web, 5000, Origins::Loopback), Err("foreign origin"));
        assert!(!loopback_origin("http://localhost.evil.example"));
        assert!(loopback_origin("https://[::1]:8443"));
    }

    /* A tunnel whose far end is a local echo server instead of ssh + socat. */

    struct HalfClose(TcpStream);
    impl Write for HalfClose {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.write(b)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    impl Drop for HalfClose {
        fn drop(&mut self) {
            let _ = self.0.shutdown(Shutdown::Write);
        }
    }

    fn echo_dialer(dials: Arc<AtomicU64>) -> Dialer {
        let echo = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = echo.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in echo.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut r = s.try_clone().unwrap();
                    let mut w = s;
                    let _ = io::copy(&mut r, &mut w);
                    let _ = w.shutdown(Shutdown::Write);
                });
            }
        });
        Arc::new(move || {
            dials.fetch_add(1, Ordering::SeqCst);
            let s = TcpStream::connect(addr).map_err(|e| e.to_string())?;
            let killer = s.try_clone().map_err(|e| e.to_string())?;
            Ok(Upstream {
                reader: Box::new(s.try_clone().map_err(|e| e.to_string())?),
                writer: Box::new(HalfClose(s)),
                close: Arc::new(move || {
                    let _ = killer.shutdown(Shutdown::Both);
                }),
            })
        })
    }

    fn connect(port: u16) -> TcpStream {
        let c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        c
    }

    #[test]
    fn tunnel_pumps_both_ways_and_stops() {
        let dials = Arc::new(AtomicU64::new(0));
        let t = Tunnel::start(echo_dialer(dials.clone())).unwrap();
        assert!(t.url().starts_with(&format!("http://127.0.0.1:{}/vnc.html?", t.port)));

        // A whole exchange: request head plus payload comes back, then EOF after we finish.
        let mut c = connect(t.port);
        let req = format!("GET /vnc.html HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\nhello", t.port);
        c.write_all(req.as_bytes()).unwrap();
        c.shutdown(Shutdown::Write).unwrap();
        let mut got = String::new();
        c.read_to_string(&mut got).unwrap();
        assert_eq!(got, req);

        // A foreign page is refused without dialling.
        let before = dials.load(Ordering::SeqCst);
        let mut c = connect(t.port);
        c.write_all(format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: https://evil.example\r\n\r\n", t.port).as_bytes())
            .unwrap();
        let mut got = String::new();
        c.read_to_string(&mut got).unwrap();
        assert!(got.starts_with("HTTP/1.1 403"), "{got}");
        assert_eq!(dials.load(Ordering::SeqCst), before);

        // An open connection ends when the tunnel stops, and nothing new gets in.
        let mut c = connect(t.port);
        c.write_all(format!("GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", t.port).as_bytes()).unwrap();
        let mut buf = [0u8; 256];
        let n = c.read(&mut buf).unwrap();
        assert!(n > 0);
        // Wait until the handler registered it, then stop.
        for _ in 0..100 {
            if !t.shared.conns.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        t.stop();
        let mut rest = Vec::new();
        let _ = c.read_to_end(&mut rest);
        // The accept loop closes the port on its own thread; a busy test runner can take a while to
        // schedule it, so wait generously and say so if it never happens.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while t.shared.serving.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "the accept loop did not stop within 10 s");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!t.alive());
        // `serving` turns false only after the listener is dropped, so the port is closed. Probing it
        // would be flaky: other tests running at the same time may already have bound the freed port.
        assert!(t.shared.conns.lock().unwrap().is_empty());
    }
}
