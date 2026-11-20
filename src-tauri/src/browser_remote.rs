//! The browser for projects in a remote environment (`env://<host>/<instance>/<dir>`).
//!
//! Two ways through, both over the user's own SSH:
//!
//! - **Pages.** In a remote project, `localhost:3000` means the dev server inside the environment.
//!   [`map_url`] opens a local port (the same number when it is free, else any) whose every
//!   connection runs `ssh … incus exec … -- socat - TCP:127.0.0.1:3000` (the desktop tunnel of
//!   `envs::remote`), and points the browser there; [`display_url`] maps it back for the address bar
//!   and the agent. Like the desktop tunnel it serves only requests addressed to itself, from
//!   pages on this computer's loopback.
//! - **Agent tools.** The agent runs inside the environment, where Mango's MCP server on this
//!   computer's 127.0.0.1 is out of reach. [`agent_port`] keeps one `ssh -N -R` per environment that
//!   forwards back to it: on a master, to a unix socket of the SSH user (mode 0600) that an Incus
//!   proxy device (`mango-browser`) exposes inside the instance as `127.0.0.1:<port>`; in a joined
//!   environment SSH lands inside already, so the forward is a loopback port there. The per-chat
//!   secret in the URL is what admits a call; the port alone reaches nothing.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};

use crate::envs::remote::{ssh_dialer_run, Origins, Tunnel};
use crate::envs::{hosts, parse_env_path, ssh, EnvFolder, EnvHost};

#[derive(Default)]
pub struct RemoteBrowserState {
    /// Page tunnels by (host, instance, port inside).
    tunnels: Mutex<HashMap<(String, String, u16), Tunnel>>,
    /// Reverse forwards for the agent tools, by (host, instance).
    back: Mutex<HashMap<(String, String), Back>>,
}

struct Back {
    child: Child,
    /// The loopback port inside the instance that leads to Mango.
    port: u16,
    /// The forwarded port on this computer (Mango's MCP server) it was made for.
    to: u16,
    host: EnvHost,
    instance: String,
    /// Set on a master: the proxy device to remove when Mango quits.
    device: bool,
}

impl RemoteBrowserState {
    /// Mango quits: stop the forwards and take the proxy devices out again (briefly, best effort).
    pub fn kill_all(&self) {
        for (_, t) in self.tunnels.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            t.stop();
        }
        let backs: Vec<Back> = self.back.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, b)| b).collect();
        let cleanups: Vec<_> = backs
            .into_iter()
            .map(|mut b| {
                let _ = b.child.kill();
                let _ = b.child.wait();
                std::thread::spawn(move || {
                    if b.device {
                        let _ = remove_device(&b.host, &b.instance);
                    }
                })
            })
            .collect();
        let until = std::time::Instant::now() + Duration::from_secs(4);
        for c in cleanups {
            while !c.is_finished() && std::time::Instant::now() < until {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn folder(project: &str) -> Result<Option<EnvFolder>, String> {
    parse_env_path(project).transpose()
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]" | "::1") || host.ends_with(".localhost")
}

/* ---------- pages ---------- */

/// Where the browser really goes for `url` in `project`: unchanged on this computer and for
/// addresses outside the environment, through a tunnel for the environment's own local ports.
pub fn map_url(app: &AppHandle, project: &str, url: Url) -> Result<Url, String> {
    let Some(f) = folder(project)? else { return Ok(url) };
    if url.scheme() != "http" || !url.host_str().is_some_and(is_loopback) {
        if url.scheme() == "https" && url.host_str().is_some_and(is_loopback) {
            return Err("Local https addresses in a remote environment can't be opened yet: use http.".into());
        }
        return Ok(url);
    }
    let inside = url.port_or_known_default().unwrap_or(80);
    let local = tunnel(app, &f, inside)?;
    let mut out = url.clone();
    out.set_host(Some("127.0.0.1")).map_err(|e| e.to_string())?;
    out.set_port(Some(local)).map_err(|_| "Could not set the port".to_string())?;
    Ok(out)
}

/// The address as the environment knows it, for a URL that went through [`map_url`].
pub fn display_url(app: &AppHandle, project: &str, url: &str) -> String {
    let Ok(Some(f)) = folder(project) else { return url.to_string() };
    let Ok(mut parsed) = Url::parse(url) else { return url.to_string() };
    if parsed.host_str() != Some("127.0.0.1") {
        return url.to_string();
    }
    let Some(local) = parsed.port() else { return url.to_string() };
    let state = app.state::<RemoteBrowserState>();
    let tunnels = state.tunnels.lock().unwrap_or_else(|e| e.into_inner());
    let found = tunnels.iter().find(|((h, i, _), t)| *h == f.host_id && *i == f.instance && t.port == local).map(|((_, _, p), _)| *p);
    drop(tunnels);
    match found {
        Some(inside) => {
            let _ = parsed.set_host(Some("localhost"));
            let _ = parsed.set_port(Some(inside));
            parsed.to_string()
        }
        None => url.to_string(),
    }
}

fn tunnel(app: &AppHandle, f: &EnvFolder, inside: u16) -> Result<u16, String> {
    let state = app.state::<RemoteBrowserState>();
    let key = (f.host_id.clone(), f.instance.clone(), inside);
    {
        let mut tunnels = state.tunnels.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = tunnels.get(&key) {
            if t.alive() {
                return Ok(t.port);
            }
            if let Some(t) = tunnels.remove(&key) {
                t.stop();
            }
        }
    }
    let host = hosts::get(app, &f.host_id)?;
    // The same port number keeps the page's own absolute links and cookies working.
    let listener = TcpListener::bind(("127.0.0.1", inside))
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|e| format!("Could not open a local port for {}: {e}", f.instance))?;
    let dialer = ssh_dialer_run(&host, &f.instance, &relay(inside))?;
    let t = Tunnel::serve_on(listener, dialer, Origins::Loopback)?;
    let port = t.port;
    state.tunnels.lock().unwrap_or_else(|e| e.into_inner()).insert(key, t);
    Ok(port)
}

/// Instance-side argv relaying stdin and stdout to the dev server on `port` there. Dev servers
/// that listen on "localhost" often take only `[::1]` (Node resolves it to IPv6 first), so
/// IPv4 loopback is tried, then IPv6. socat connects before it reads anything, so a refused
/// first try leaves the request for the second. When neither answers, the page gets a 502 that
/// says why instead of an empty response.
fn relay(port: u16) -> Vec<String> {
    let script = format!(
        "command -v socat >/dev/null 2>&1 || {{ {}; exit 0; }}; \
         socat - TCP4:127.0.0.1:{port} 2>/dev/null || socat - 'TCP6:[::1]:{port}' 2>/dev/null || {}",
        bad_gateway("socat is missing in this environment. Install (or update) its base component."),
        bad_gateway(&format!("Nothing in this environment answers on port {port}. Is the dev server running?")),
    );
    vec!["sh".into(), "-c".into(), script]
}

/// A shell `printf` writing a whole `502 Bad Gateway` response saying `body` (plain ASCII, no `'`, `%` or `\`).
fn bad_gateway(body: &str) -> String {
    format!(
        "printf 'HTTP/1.1 502 Bad Gateway\\r\\nContent-Type: text/plain; charset=utf-8\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{body}\\n'",
        body.len() + 1,
    )
}

/* ---------- agent tools ---------- */

const DEVICE: &str = "mango-browser";

/// The loopback port inside the project's environment that leads to Mango's MCP server
/// (listening on `mcp_port` here); `None` for a project on this computer.
pub fn agent_port(app: &AppHandle, project: &str, mcp_port: u16) -> Result<Option<u16>, String> {
    let Some(f) = folder(project)? else { return Ok(None) };
    let state = app.state::<RemoteBrowserState>();
    let key = (f.host_id.clone(), f.instance.clone());
    {
        let mut back = state.back.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(b) = back.get_mut(&key) {
            if b.to == mcp_port && matches!(b.child.try_wait(), Ok(None)) {
                return Ok(Some(b.port));
            }
            if let Some(mut old) = back.remove(&key) {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
        }
    }
    let host = hosts::get(app, &f.host_id)?;
    let b = forward(&host, &f.instance, mcp_port, None)?;
    let port = b.port;
    state.back.lock().unwrap_or_else(|e| e.into_inner()).insert(key, b);
    Ok(Some(port))
}

fn forward(host: &EnvHost, instance: &str, mcp_port: u16, want: Option<u16>) -> Result<Back, String> {
    if host.direct.is_some() {
        forward_direct(host, instance, mcp_port, want)
    } else {
        forward_master(host, instance, mcp_port, want)
    }
}

/// The connection to `host_id` (every host when `None`) is back: forwards that died with it are
/// made again, on the same port inside where it is still free, so agents that kept running
/// through the drop find their browser tools where they were. Blocking; best effort.
pub fn revive(app: &AppHandle, host_id: Option<&str>) {
    let state = app.state::<RemoteBrowserState>();
    let dead: Vec<((String, String), Back)> = {
        let mut back = state.back.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<(String, String)> = back
            .iter_mut()
            .filter_map(|(k, b)| (host_id.is_none_or(|id| id == k.0) && !matches!(b.child.try_wait(), Ok(None))).then(|| k.clone()))
            .collect();
        keys.into_iter().filter_map(|k| back.remove(&k).map(|b| (k, b))).collect()
    };
    for (key, mut old) in dead {
        let _ = old.child.wait();
        // Made again by a new turn meanwhile, or the host is still out of reach (tried on the next reconnect).
        if state.back.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&key) {
            continue;
        }
        match forward(&old.host, &old.instance, old.to, Some(old.port)) {
            Ok(b) => {
                let mut back = state.back.lock().unwrap_or_else(|e| e.into_inner());
                if back.contains_key(&key) {
                    let mut b = b;
                    let _ = b.child.kill();
                    let _ = b.child.wait();
                } else {
                    back.insert(key, b);
                }
            }
            Err(_) => {
                // Keep the dead one: the next reconnect tries again.
                state.back.lock().unwrap_or_else(|e| e.into_inner()).entry(key).or_insert(old);
            }
        }
    }
}

/// `ssh <options> -N -R <spec> <destination>`: the options of `ssh::ssh_args` before the destination.
fn forward_argv(host: &EnvHost, spec: &str, extra: &[&str]) -> Result<Vec<String>, String> {
    let mut args = ssh::ssh_args(host, ssh::Mode::Batch);
    let dest = args.pop().ok_or("No SSH destination")?;
    let mut a = vec![ssh::ssh_bin()?.to_string_lossy().into_owned()];
    a.extend(args);
    a.extend(["-N", "-o", "ExitOnForwardFailure=yes"].map(String::from));
    a.extend(extra.iter().map(|s| s.to_string()));
    a.extend(["-R".to_string(), spec.to_string(), "--".into(), dest]);
    Ok(a)
}

fn spawn_forward(argv: &[String]) -> Result<(Child, mpsc::Receiver<String>), String> {
    let mut cmd = ssh::command(argv);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start ssh: {e}"))?;
    let stderr = child.stderr.take().ok_or("No output from ssh")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    Ok((child, rx))
}

/// A joined environment: SSH lands inside it, so ask its sshd for `want` (the port a dropped
/// forward had), or any free loopback port.
fn forward_direct(host: &EnvHost, instance: &str, mcp_port: u16, want: Option<u16>) -> Result<Back, String> {
    if let Some(port) = want {
        let argv = forward_argv(host, &format!("127.0.0.1:{port}:127.0.0.1:{mcp_port}"), &[])?;
        let (mut child, _lines) = spawn_forward(&argv)?;
        // A fixed port says nothing when it is up (`ExitOnForwardFailure` ends it when taken).
        std::thread::sleep(Duration::from_millis(1500));
        if let Ok(None) = child.try_wait() {
            return Ok(Back { child, port, to: mcp_port, host: host.clone(), instance: instance.into(), device: false });
        }
        let _ = child.wait();
    }
    let argv = forward_argv(host, &format!("127.0.0.1:0:127.0.0.1:{mcp_port}"), &[])?;
    let (mut child, lines) = spawn_forward(&argv)?;
    let until = std::time::Instant::now() + Duration::from_secs(20);
    let mut seen = Vec::new();
    while std::time::Instant::now() < until {
        match lines.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Some(port) = allocated_port(&line) {
                    return Ok(Back { child, port, to: mcp_port, host: host.clone(), instance: instance.into(), device: false });
                }
                seen.push(line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(format!("Could not connect the browser tools to {instance}: {}", ssh::explain(host, None, &seen.join("\n"), "")))
}

/// `Allocated port 41234 for remote forward to 127.0.0.1:5000`
fn allocated_port(line: &str) -> Option<u16> {
    line.trim().strip_prefix("Allocated port ")?.split_whitespace().next()?.parse().ok()
}

/// A master: forward to a unix socket of the SSH user there, and expose it inside the instance
/// with a proxy device on a loopback port.
fn forward_master(host: &EnvHost, instance: &str, mcp_port: u16, want: Option<u16>) -> Result<Back, String> {
    let tag = &uuid::Uuid::new_v4().simple().to_string()[..16];
    let socket = format!("/tmp/mango-browser-{tag}.sock");
    let argv = forward_argv(host, &format!("{socket}:127.0.0.1:{mcp_port}"), &["-o", "StreamLocalBindUnlink=yes", "-o", "StreamLocalBindMask=0177"])?;
    let (mut child, lines) = spawn_forward(&argv)?;
    // A unix socket forward says nothing when it is up; give it a moment to fail instead.
    std::thread::sleep(Duration::from_millis(1500));
    if let Ok(Some(_)) = child.try_wait() {
        let said: Vec<String> = lines.try_iter().collect();
        return Err(format!("Could not connect the browser tools to {instance}: {}", ssh::explain(host, None, &said.join("\n"), "")));
    }
    // Any port in a quiet range; the proxy device fails if it is taken, so try a few.
    let mut last = String::new();
    // The port a dropped forward had comes first: agents still running know it.
    let ports = want.into_iter().chain(std::iter::repeat_with(|| 41000 + (uuid::Uuid::new_v4().as_u128() % 8000) as u16).take(3));
    for port in ports {
        match ssh::run(host, &device_line(host, instance, port, &socket), Duration::from_secs(30)) {
            Ok(_) => return Ok(Back { child, port, to: mcp_port, host: host.clone(), instance: instance.into(), device: true }),
            Err(e) => last = e,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(format!("Could not connect the browser tools to {instance}: {last}"))
}

/// Replace the instance's `mango-browser` proxy device with one from `127.0.0.1:<port>` inside to `socket` on the master.
fn device_line(host: &EnvHost, instance: &str, port: u16, socket: &str) -> Vec<String> {
    let target = ssh::quote(&ssh::target(host, instance));
    let script = format!(
        "incus config device remove {target} {DEVICE} >/dev/null 2>&1; incus config device add {target} {DEVICE} proxy {} {} bind=instance >/dev/null",
        ssh::quote(&format!("listen=tcp:127.0.0.1:{port}")),
        ssh::quote(&format!("connect=unix:{socket}")),
    );
    vec!["sh".into(), "-c".into(), script]
}

fn remove_device(host: &EnvHost, instance: &str) -> Result<String, String> {
    let line = vec!["incus".into(), "config".into(), "device".into(), "remove".into(), ssh::target(host, instance), DEVICE.into()];
    ssh::run(host, &line, Duration::from_secs(3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_allocated_port() {
        assert_eq!(allocated_port("Allocated port 41234 for remote forward to 127.0.0.1:5000"), Some(41234));
        assert_eq!(allocated_port("Warning: Permanently added"), None);
    }

    #[test]
    fn relay_tries_both_loopbacks() {
        let line = relay(3000);
        assert_eq!(line[..2], ["sh".to_string(), "-c".to_string()]);
        let script = &line[2];
        let v4 = script.find("TCP4:127.0.0.1:3000").unwrap();
        let v6 = script.find("'TCP6:[::1]:3000'").unwrap();
        assert!(v4 < v6);
        assert!(script.contains("answers on port 3000"));
    }

    #[test]
    fn bad_gateway_counts_its_body() {
        let p = bad_gateway("Nope.");
        assert!(p.starts_with("printf 'HTTP/1.1 502 Bad Gateway\\r\\n"));
        assert!(p.contains("Content-Length: 6\\r\\n"));
        assert!(p.ends_with("\\r\\n\\r\\nNope.\\n'"));
    }

    #[test]
    fn loopback_hosts() {
        for h in ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "app.localhost"] {
            assert!(is_loopback(h), "{h}");
        }
        assert!(!is_loopback("example.com"));
    }

    #[test]
    fn device_command_is_quoted() {
        let host = EnvHost {
            id: "h".into(),
            name: "forge".into(),
            ssh: "me@forge".into(),
            port: None,
            identity_file: None,
            incus_remote: None,
            tailscale: None,
            public_address: None,
            direct: None,
        };
        let line = device_line(&host, "dev", 41001, "/tmp/mango-browser-ab.sock");
        assert_eq!(line[..2], ["sh".to_string(), "-c".to_string()]);
        assert!(line[2].contains("incus config device add dev mango-browser proxy listen=tcp:127.0.0.1:41001 connect=unix:/tmp/mango-browser-ab.sock bind=instance"));
    }
}
