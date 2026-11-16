//! `ssh` command lines to the master, and the `incus` commands they carry.
//!
//! SSH hands the remote command to the master user's shell as one string, so
//! every argument is POSIX-quoted here (`quote`). `incus exec` then passes its
//! argv to the instance verbatim, without another shell in between.
//!
//! A joined environment (`EnvHost::direct`) has no master: SSH lands inside
//! the environment as its agent user, and [`in_instance`] runs what would be
//! `incus exec` through `sudo -n` there instead. Its connection takes nothing
//! from the user's SSH configuration (`-F none`): the link describes it
//! completely, and the environment's host key is pinned to the one in the link.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{utc_text, EnvHost, AGENT_HOME, AGENT_USER};

/// How a command talks to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// No terminal, never prompts (`BatchMode`): for captured output and agent stdio.
    Batch,
    /// A terminal the user watches (installers, shells): SSH may ask about host keys or passphrases.
    Tty,
}

/// POSIX shell quoting: plain words stay as they are, anything else is single-quoted.
pub fn quote(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// Join an argv into one shell line for the master.
pub fn line(argv: &[String]) -> String {
    argv.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ")
}

/// The `ssh` binary on this computer.
pub fn ssh_bin() -> Result<PathBuf, String> {
    crate::bin::find("ssh").ok_or_else(|| {
        "ssh was not found. Install the OpenSSH client (on Windows: Settings > System > Optional features).".to_string()
    })
}

/// The options and destination for `host`, without the command.
pub fn ssh_args(host: &EnvHost, mode: Mode) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if host.direct.is_some() {
        // Nothing from ~/.ssh/config (or the system's ssh_config) applies: no option there can
        // loosen the host key pin, swap the key, or route the connection somewhere else.
        // (This also drops proxy settings, which a link to a public or tailnet address never needs.)
        a.extend(["-F", "none"].map(String::from));
    }
    match mode {
        Mode::Batch => a.extend(["-T", "-o", "BatchMode=yes"].map(String::from)),
        Mode::Tty => a.push("-tt".into()),
    }
    a.extend(
        ["-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"].map(String::from),
    );
    if let Some(port) = host.port {
        a.extend(["-p".into(), port.to_string()]);
    }
    let key = host.identity_file.as_deref().filter(|k| !k.trim().is_empty());
    if host.direct.is_some() {
        // The host key from the link is the only one accepted; ssh never asks and never adds keys.
        // Without a key file (a damaged entry) there is no pin file either, and ssh refuses: it fails closed.
        // Quoted: ssh splits these values at spaces (a list of files), and the path may have some.
        let known = key.map_or_else(|| "none".to_string(), known_hosts_for);
        for o in [
            "StrictHostKeyChecking=yes".to_string(),
            format!("UserKnownHostsFile=\"{known}\""),
            format!("GlobalKnownHostsFile=\"{known}\""),
            "UpdateHostKeys=no".into(),
            "CheckHostIP=no".into(),
            "HostKeyAlgorithms=ssh-ed25519".into(),
            "PreferredAuthentications=publickey".into(),
        ] {
            a.extend(["-o".into(), o]);
        }
    }
    if let Some(key) = key {
        a.extend(["-i".into(), key.to_string(), "-o".into(), "IdentitiesOnly=yes".into()]);
    }
    a.push(host.ssh.clone());
    a
}

/// The pinned `known_hosts` file kept next to a joined environment's key.
pub fn known_hosts_for(key_file: &str) -> String {
    format!("{key_file}.known_hosts")
}

/// Full argv (`ssh …options… dest 'remote line'`) running `remote` on the master.
pub fn argv(host: &EnvHost, mode: Mode, remote: &[String]) -> Result<Vec<String>, String> {
    let mut a = vec![ssh_bin()?.to_string_lossy().into_owned()];
    a.extend(ssh_args(host, mode));
    a.push(line(remote));
    Ok(a)
}

/// [`argv`] in [`Mode::Batch`] over a shared connection (see [`mux_args`]): for short
/// commands whose output is captured (git, file access, `incus` queries). After the first,
/// each one skips the SSH handshake, which is most of its time on a distant server.
/// Long-lived sessions (terminals, agents, tunnels) keep their own connections, so a
/// stalled shared one never takes them down.
pub fn shared_argv(host: &EnvHost, remote: &[String]) -> Result<Vec<String>, String> {
    let mut a = vec![ssh_bin()?.to_string_lossy().into_owned()];
    let args = ssh_args(host, Mode::Batch);
    // ssh takes the first value given for an option, so these go before `ssh_args`'s own.
    a.extend(mux_args(&args));
    a.extend(args);
    a.push(line(remote));
    Ok(a)
}

/// How long a shared connection stays open after its last command.
const MUX_PERSIST: &str = "ControlPersist=120";

/// SSH connection sharing for a connection made with `args` (from [`ssh_args`]): the first
/// command opens a master connection in the background, later ones run through its socket.
/// The socket name is a hash of the whole connection (destination, port, key, host key pin),
/// so a changed host never reuses an old connection. Empty where it can't work: Windows'
/// OpenSSH has no connection sharing, and without a private, short socket folder.
fn mux_args(args: &[String]) -> Vec<String> {
    let Some(dir) = mux_dir() else { return Vec::new() };
    let path = dir.join(mux_name(args));
    let path = path.to_string_lossy();
    // ssh expands `%` tokens in the path, and splits unquoted values at spaces.
    let path = path.replace('%', "%%");
    [
        "-o".to_string(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath=\"{path}\""),
        "-o".into(),
        MUX_PERSIST.into(),
        // The master outlives the command that opened it: notice a dropped network within
        // about 15 s, or every command sent through it would wait for the dead connection.
        "-o".into(),
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ]
    .to_vec()
}

fn mux_name(args: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(args.join("\0").as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// The folder for shared-connection sockets, made once: private to this user (0700), and short
/// enough for a Unix socket path (ssh also adds a temporary suffix while it sets one up).
#[cfg(unix)]
fn mux_dir() -> Option<&'static std::path::Path> {
    use std::sync::OnceLock;
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let mut bases: Vec<PathBuf> = Vec::new();
        if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
            bases.push(PathBuf::from(run));
        }
        if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
            bases.push(PathBuf::from(home).join(".ssh"));
        }
        bases.into_iter().find_map(|base| private_dir(&base.join("mango-mux")))
    })
    .as_deref()
}

#[cfg(not(unix))]
fn mux_dir() -> Option<&'static std::path::Path> {
    None
}

/// `dir`, created 0700 if missing, when it is a real folder (not a link) that only its owner
/// can enter, that owner is us (we can write in it), and a socket path in it fits. A folder
/// others can write to would let them plant a socket that receives our commands.
#[cfg(unix)]
fn private_dir(dir: &std::path::Path) -> Option<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    // 16 hex digits of name, plus ssh's `.` and 16 random characters while it binds; sun_path is 104 on macOS.
    if dir.as_os_str().len() + 1 + 16 + 17 >= 104 || !dir.parent()?.is_dir() {
        return None;
    }
    let _ = std::fs::DirBuilder::new().mode(0o700).create(dir);
    let meta = std::fs::symlink_metadata(dir).ok()?;
    if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return None;
    }
    let probe = dir.join(format!(".probe-{}", std::process::id()));
    std::fs::File::create(&probe).ok()?;
    let _ = std::fs::remove_file(&probe);
    Some(dir.to_path_buf())
}

/// `remote:instance`, or just `instance` on the master's default remote.
pub fn target(host: &EnvHost, instance: &str) -> String {
    match host.incus_remote.as_deref().filter(|r| !r.is_empty()) {
        Some(r) => format!("{r}:{instance}"),
        None => instance.to_string(),
    }
}

/// `remote:` (for `incus list`), or empty for the default remote.
pub fn remote_prefix(host: &EnvHost) -> Option<String> {
    host.incus_remote.as_deref().filter(|r| !r.is_empty()).map(|r| format!("{r}:"))
}

/// `incus exec <target> -T|-t -- <inner…>` (runs as root inside the instance).
fn incus_exec(host: &EnvHost, instance: &str, mode: Mode, inner: &[String]) -> Vec<String> {
    let mut a = vec![
        "incus".to_string(),
        "exec".into(),
        target(host, instance),
        match mode {
            Mode::Batch => "-T".into(),
            Mode::Tty => "-t".into(),
        },
        "--".into(),
    ];
    a.extend(inner.iter().cloned());
    a
}

/// The remote argv (for [`argv`]/[`run`]) running `inner` as root inside `instance`.
///
/// The one place that decides how to get into an instance: `incus exec` on a master, and
/// `sudo -n` on a joined environment, where SSH already lands inside as the agent user
/// (with passwordless sudo, from the base component). There an [`as_agent`] argv skips
/// `sudo` and `runuser` and runs as the SSH user itself.
pub fn in_instance(host: &EnvHost, instance: &str, mode: Mode, inner: &[String]) -> Result<Vec<String>, String> {
    let Some(d) = &host.direct else { return Ok(incus_exec(host, instance, mode, inner)) };
    if instance != d.instance {
        return Err(format!("{} gives access to {} only, not to {instance}.", host.name, d.instance));
    }
    let ssh_user = host.ssh.rsplit_once('@').map(|(u, _)| u);
    let runuser = ["runuser", "-u", AGENT_USER, "--"];
    if ssh_user == Some(AGENT_USER) && inner.len() > runuser.len() && inner[..runuser.len()] == runuser {
        return Ok(inner[runuser.len()..].to_vec());
    }
    let mut a: Vec<String> = ["sudo", "-n", "--"].map(String::from).to_vec();
    a.extend(inner.iter().cloned());
    Ok(a)
}

/// Instance-side argv running `argv` as the agent user, from `cwd` (home when `None`),
/// in a login shell so `~/.local/bin` and friends are on PATH. `env` must be validated.
pub fn as_agent(cwd: Option<&str>, env: &[(String, String)], argv: &[String]) -> Vec<String> {
    as_agent_in(true, cwd, env, argv)
}

/// [`as_agent`] without the login shell: no profile scripts run, and PATH is a fixed list
/// (with `~/.local/bin`). For quick reads (git status, file listings) that run often and
/// need nothing a profile sets up. Anything that may run user hooks keeps [`as_agent`].
pub fn as_agent_plain(cwd: Option<&str>, env: &[(String, String)], argv: &[String]) -> Vec<String> {
    as_agent_in(false, cwd, env, argv)
}

/// The fixed PATH of [`as_agent_plain`].
const PLAIN_PATH: &str = "$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

fn as_agent_in(login: bool, cwd: Option<&str>, env: &[(String, String)], argv: &[String]) -> Vec<String> {
    let mut a: Vec<String> = vec!["runuser", "-u", AGENT_USER, "--", "env"].into_iter().map(String::from).collect();
    a.push(format!("HOME={AGENT_HOME}"));
    a.extend([format!("USER={AGENT_USER}"), format!("LOGNAME={AGENT_USER}"), "SHELL=/bin/bash".into()]);
    a.extend(env.iter().map(|(k, v)| format!("{k}={v}")));
    let enter = r#"cd -- "$1" || { echo "Mango: the folder $1 does not exist in this environment." >&2; exit 1; }; shift; exec "$@""#;
    a.extend([
        "bash".into(),
        if login { "-lc".into() } else { "-c".into() },
        if login { enter.into() } else { format!("PATH=\"{PLAIN_PATH}\"; export PATH; {enter}") },
        "mango".into(),
        cwd.unwrap_or(AGENT_HOME).to_string(),
    ]);
    a.extend(argv.iter().cloned());
    a
}

/// A `Command` for `argv` (from [`argv`]) with no console window.
pub fn command(argv: &[String]) -> Command {
    let mut cmd = Command::new(&argv[0]);
    crate::bin::hide_console(&mut cmd);
    cmd.args(&argv[1..]);
    cmd
}

/// Run `remote` on the master and wait (up to `timeout`). Ok(stdout) on exit 0,
/// otherwise an error built from what the command printed.
pub fn run(host: &EnvHost, remote: &[String], timeout: Duration) -> Result<String, String> {
    let argv = shared_argv(host, remote)?;
    let mut cmd = command(&argv);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start ssh: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("No output from ssh")?;
    let mut stderr = child.stderr.take().ok_or("No output from ssh")?;
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
            Ok(Some(s)) => break Some(s),
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
    match status {
        None => Err(format!("{} did not answer within {} s.", host.name, timeout.as_secs())),
        Some(s) if s.success() => Ok(stdout),
        Some(s) => Err(explain(host, s.code(), &stderr, &stdout)),
    }
}

/// A message a person can act on, from a failed ssh/incus run.
pub fn explain(host: &EnvHost, code: Option<i32>, stderr: &str, stdout: &str) -> String {
    let text = if stderr.trim().is_empty() { stdout } else { stderr };
    let last: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = last[last.len().saturating_sub(4)..].join("\n");
    if host.direct.is_some() {
        if let Some(m) = explain_direct(host, code, &text.to_lowercase(), &tail) {
            return m;
        }
    }
    let lower = tail.to_lowercase();
    // ssh itself exits 255 on connection and authentication problems.
    if code == Some(255) || lower.contains("permission denied (") || lower.contains("could not resolve hostname") {
        if lower.contains("permission denied") {
            return format!(
                "{} refused the SSH sign-in. Mango uses your SSH keys and agent without prompting: check that `ssh {}` works in a terminal without a password.\n{tail}",
                host.name, host.ssh
            );
        }
        if lower.contains("host key verification failed") {
            return format!(
                "{} is not a known host yet. Connect once with `ssh {}` in a terminal to accept its key.\n{tail}",
                host.name, host.ssh
            );
        }
        return format!("Could not connect to {} over SSH.\n{tail}", host.name);
    }
    if lower.contains("incus: command not found") || lower.contains("incus: not found") {
        return format!("{} has no `incus` command. Install the Incus client on the server, or pick another server.", host.name);
    }
    if tail.is_empty() {
        format!("The command on {} failed (exit {}).", host.name, code.map_or("?".into(), |c| c.to_string()))
    } else {
        tail
    }
}

/// [`explain`] for a joined environment, where the usual advice (check your SSH setup,
/// accept the host key, install Incus) does not apply. `lower` is all of the output.
fn explain_direct(host: &EnvHost, code: Option<i32>, lower: &str, tail: &str) -> Option<String> {
    let d = host.direct.as_ref()?;
    let ended = d.expires_at.filter(|at| *at <= super::now_ms());
    let ask = format!("Ask whoever shared it ({}) for a new link.", d.shared_from);
    if lower.contains("sudo: a password is required") || lower.contains("sudo: a terminal is required") {
        return Some(format!(
            "The agent user in {} may not use sudo without a password, which Mango needs for this. Ask the owner to install (or update) the Base system component.",
            host.name
        ));
    }
    // ssh itself exits 255 on connection and authentication problems; anything else came from inside.
    if code != Some(255) {
        return None;
    }
    if lower.contains("host key verification failed") || lower.contains("remote host identification has changed") {
        return Some(format!(
            "The environment's identity changed since the link was made, so Mango did not connect to {}: it may have been rebuilt, or someone is in between. {ask}",
            host.name
        ));
    }
    if lower.contains("permission denied (") || lower.contains("too many authentication failures") {
        return Some(match ended {
            Some(at) => format!("Your access to {} ended on {}. {ask}", host.name, utc_text(at)),
            None => format!("{} no longer accepts this link: access was probably revoked. {ask}", host.name),
        });
    }
    let unreachable = [
        "connection refused",
        "connection timed out",
        "operation timed out",
        "no route to host",
        "network is unreachable",
        "could not resolve hostname",
        "connection reset",
        "connection closed by",
    ];
    let mut m = if unreachable.iter().any(|p| lower.contains(p)) {
        let endpoint = host.ssh.rsplit_once('@').map_or(host.ssh.as_str(), |(_, h)| h);
        let mut m = format!("Could not reach {} at {endpoint} port {}.", host.name, host.port.unwrap_or(22));
        if let Some(at) = ended {
            m.push_str(&format!(" Access ended on {}.", utc_text(at)));
        } else if super::incus::is_tailnet(endpoint) || endpoint.ends_with(".ts.net") {
            m.push_str(" It is shared over Tailscale: check that this computer is on the owner's tailnet and Tailscale is running.");
        } else {
            m.push_str(" The environment may be stopped, or a firewall blocks that port: ask whoever shared it to check.");
        }
        m
    } else {
        format!("Could not connect to {} over SSH.", host.name)
    };
    if !tail.is_empty() {
        m.push('\n');
        m.push_str(tail);
    }
    Some(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envs::EnvDirect;

    fn host() -> EnvHost {
        EnvHost {
            id: "h".into(),
            name: "Lab".into(),
            ssh: "me@lab".into(),
            port: Some(2222),
            identity_file: Some("/k/id_ed25519".into()),
            incus_remote: Some("os1".into()),
            tailscale: None,
            public_address: None,
            direct: None,
        }
    }

    #[test]
    fn quoting() {
        assert_eq!(quote("incus"), "incus");
        assert_eq!(quote("os1:dev"), "os1:dev");
        assert_eq!(quote(""), "''");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("$(id)"), "'$(id)'");
        assert_eq!(quote("x;y"), "'x;y'");
    }

    #[test]
    fn ssh_options() {
        let a = ssh_args(&host(), Mode::Batch);
        assert_eq!(&a[..3], ["-T", "-o", "BatchMode=yes"]);
        assert!(a.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(a.windows(2).any(|w| w == ["-i", "/k/id_ed25519"]));
        assert_eq!(a.last().unwrap(), "me@lab");
        assert_eq!(ssh_args(&host(), Mode::Tty)[0], "-tt");
    }

    fn direct() -> EnvHost {
        EnvHost {
            id: "j".into(),
            name: "dev (shared)".into(),
            ssh: "agent@203.0.113.24".into(),
            port: Some(22001),
            identity_file: Some("/data/env-keys/j".into()),
            incus_remote: None,
            tailscale: None,
            public_address: None,
            direct: Some(EnvDirect {
                instance: "dev".into(),
                host_key: "AAAAC3NzaC1lZDI1NTE5AAAAIA".into(),
                shared_from: "forge/dev".into(),
                share_id: "s1".into(),
                expires_at: None,
            }),
        }
    }

    #[test]
    fn direct_hosts_pin_the_host_key() {
        let a = ssh_args(&direct(), Mode::Batch);
        assert_eq!(&a[..2], ["-F", "none"], "nothing from the user's ssh config");
        for o in [
            "StrictHostKeyChecking=yes",
            r#"UserKnownHostsFile="/data/env-keys/j.known_hosts""#,
            r#"GlobalKnownHostsFile="/data/env-keys/j.known_hosts""#,
            "UpdateHostKeys=no",
            "HostKeyAlgorithms=ssh-ed25519",
            "IdentitiesOnly=yes",
        ] {
            assert!(a.windows(2).any(|w| w == ["-o", o]), "{o}: {a:?}");
        }
        assert!(a.windows(2).any(|w| w == ["-i", "/data/env-keys/j"]));
        assert!(a.windows(2).any(|w| w == ["-p", "22001"]));
        assert!(a.contains(&"BatchMode=yes".to_string()));
        assert_eq!(a.last().unwrap(), "agent@203.0.113.24");
        // Interactive terminals too: still strict, so never a host key prompt.
        let a = ssh_args(&direct(), Mode::Tty);
        assert_eq!(&a[..3], ["-F", "none", "-tt"]);
        assert!(a.windows(2).any(|w| w == ["-o", "StrictHostKeyChecking=yes"]));
        // A damaged entry without a key: no pin file, so ssh refuses rather than trusting anything.
        let mut h = direct();
        h.identity_file = None;
        let a = ssh_args(&h, Mode::Batch);
        assert!(a.windows(2).any(|w| w == ["-o", r#"UserKnownHostsFile="none""#]));
        // Masters keep the user's own setup.
        assert!(!ssh_args(&host(), Mode::Batch).contains(&"-F".to_string()));
    }

    #[test]
    fn direct_hosts_use_sudo_instead_of_incus() {
        let h = direct();
        let root = in_instance(&h, "dev", Mode::Batch, &["sh".into(), "-c".into(), "id -u".into()]).unwrap();
        assert_eq!(line(&root), "sudo -n -- sh -c 'id -u'");
        // As the agent: SSH already is the agent user, so no sudo and no runuser.
        let inner = as_agent(Some("/home/agent/work"), &[], &["claude".into()]);
        let l = line(&in_instance(&h, "dev", Mode::Tty, &inner).unwrap());
        assert!(l.starts_with("env HOME=/home/agent USER=agent"), "{l}");
        assert!(l.ends_with("mango /home/agent/work claude"), "{l}");
        // Another user in the link: through sudo, which runs runuser as root.
        let mut other = h.clone();
        other.ssh = "dev@203.0.113.24".into();
        let l = line(&in_instance(&other, "dev", Mode::Batch, &inner).unwrap());
        assert!(l.starts_with("sudo -n -- runuser -u agent -- env"), "{l}");
        // Only the shared environment.
        let e = in_instance(&h, "other", Mode::Batch, &inner).unwrap_err();
        assert!(e.contains("dev only"), "{e}");
        // A master still goes through incus.
        assert!(line(&in_instance(&host(), "dev", Mode::Batch, &inner).unwrap()).starts_with("incus exec os1:dev -T -- runuser"));
    }

    #[test]
    fn direct_errors() {
        let h = direct();
        let changed = "@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.";
        assert!(explain(&h, Some(255), changed, "").contains("identity changed"));
        let e = explain(&h, Some(255), "agent@203.0.113.24: Permission denied (publickey).", "");
        assert!(e.contains("no longer accepts this link") && e.contains("forge/dev"), "{e}");
        let mut expired = h.clone();
        expired.direct.as_mut().unwrap().expires_at = Some(1_000);
        let e = explain(&expired, Some(255), "agent@203.0.113.24: Permission denied (publickey).", "");
        assert!(e.starts_with("Your access to dev (shared) ended on 1970-01-01"), "{e}");
        let e = explain(&h, Some(255), "ssh: connect to host 203.0.113.24 port 22001: Connection refused", "");
        assert!(e.starts_with("Could not reach dev (shared) at 203.0.113.24 port 22001.") && e.contains("firewall"), "{e}");
        let mut ts = h.clone();
        ts.ssh = "agent@100.101.7.8".into();
        let e = explain(&ts, Some(255), "ssh: connect to host 100.101.7.8 port 22: Connection timed out", "");
        assert!(e.contains("tailnet"), "{e}");
        let e = explain(&h, Some(1), "sudo: a password is required", "");
        assert!(e.contains("Base system"), "{e}");
        // Anything else reads as it does for a master.
        assert_eq!(explain(&h, Some(2), "boom", ""), "boom");
    }

    #[test]
    fn incus_lines() {
        let h = host();
        assert_eq!(target(&h, "dev"), "os1:dev");
        let mut local = h.clone();
        local.incus_remote = None;
        assert_eq!(target(&local, "dev"), "dev");
        assert_eq!(remote_prefix(&local), None);

        let inner = as_agent(Some("/home/agent/work/my app"), &[("K".into(), "v w".into())], &["claude".into(), "-p".into()]);
        let l = line(&in_instance(&h, "dev", Mode::Batch, &inner).unwrap());
        assert!(l.starts_with("incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent"), "{l}");
        assert!(l.contains("'K=v w'"), "{l}");
        assert!(l.ends_with("mango '/home/agent/work/my app' claude -p"), "{l}");
    }

    #[test]
    fn plain_agent_skips_the_login_shell() {
        let login = as_agent(Some("/w"), &[], &["git".into(), "status".into()]);
        let plain = as_agent_plain(Some("/w"), &[], &["git".into(), "status".into()]);
        assert!(login.contains(&"-lc".to_string()));
        assert!(plain.contains(&"-c".to_string()) && !plain.contains(&"-lc".to_string()));
        let script = plain.iter().find(|a| a.starts_with("PATH=")).expect("fixed PATH");
        assert!(script.contains("$HOME/.local/bin:") && script.contains("cd -- \"$1\""), "{script}");
        assert!(plain.ends_with(&["mango".into(), "/w".into(), "git".into(), "status".into()]));
    }

    #[test]
    fn shared_connections_are_keyed_by_the_whole_connection() {
        let a = ssh_args(&host(), Mode::Batch);
        let mut other = host();
        other.identity_file = Some("/k/other".into());
        assert_ne!(mux_name(&a), mux_name(&ssh_args(&other, Mode::Batch)));
        assert_eq!(mux_name(&a), mux_name(&ssh_args(&host(), Mode::Batch)));
        assert_eq!(mux_name(&a).len(), 16);
    }

    #[cfg(unix)]
    #[test]
    fn shared_argv_puts_its_options_first() {
        let Ok(a) = shared_argv(&host(), &["true".into()]) else { return }; // no ssh here
        assert_eq!(a.last().unwrap(), "true");
        assert_eq!(a[a.len() - 2], "me@lab");
        if mux_dir().is_some() {
            assert_eq!(a[2], "ControlMaster=auto");
            let alive = a.iter().position(|o| o.starts_with("ServerAliveInterval=")).unwrap();
            assert_eq!(a[alive], "ServerAliveInterval=5");
        }
    }

    #[cfg(unix)]
    #[test]
    fn socket_folder_must_be_private() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("mango-mux-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.join("m");
        assert_eq!(private_dir(&dir), Some(dir.clone()));
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(private_dir(&dir), None);
        let link = base.join("l");
        std::os::unix::fs::symlink(&base, &link).unwrap();
        assert_eq!(private_dir(&link), None);
        assert_eq!(private_dir(&base.join("x".repeat(120))), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
