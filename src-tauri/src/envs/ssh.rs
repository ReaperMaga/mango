//! `ssh` command lines to the master, and the `incus` commands they carry.
//!
//! SSH hands the remote command to the master user's shell as one string, so
//! every argument is POSIX-quoted here (`quote`). `incus exec` then passes its
//! argv to the instance verbatim, without another shell in between.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{EnvHost, AGENT_HOME, AGENT_USER};

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
    if let Some(key) = host.identity_file.as_deref().filter(|k| !k.trim().is_empty()) {
        a.extend(["-i".into(), key.to_string(), "-o".into(), "IdentitiesOnly=yes".into()]);
    }
    a.push(host.ssh.clone());
    a
}

/// Full argv (`ssh …options… dest 'remote line'`) running `remote` on the master.
pub fn argv(host: &EnvHost, mode: Mode, remote: &[String]) -> Result<Vec<String>, String> {
    let mut a = vec![ssh_bin()?.to_string_lossy().into_owned()];
    a.extend(ssh_args(host, mode));
    a.push(line(remote));
    Ok(a)
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
pub fn incus_exec(host: &EnvHost, instance: &str, mode: Mode, inner: &[String]) -> Vec<String> {
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

/// Instance-side argv running `argv` as the agent user, from `cwd` (home when `None`),
/// in a login shell so `~/.local/bin` and friends are on PATH. `env` must be validated.
pub fn as_agent(cwd: Option<&str>, env: &[(String, String)], argv: &[String]) -> Vec<String> {
    let mut a: Vec<String> = vec!["runuser", "-u", AGENT_USER, "--", "env"].into_iter().map(String::from).collect();
    a.push(format!("HOME={AGENT_HOME}"));
    a.extend([format!("USER={AGENT_USER}"), format!("LOGNAME={AGENT_USER}"), "SHELL=/bin/bash".into()]);
    a.extend(env.iter().map(|(k, v)| format!("{k}={v}")));
    a.extend([
        "bash".into(),
        "-lc".into(),
        r#"cd -- "$1" || { echo "Mango: the folder $1 does not exist in this environment." >&2; exit 1; }; shift; exec "$@""#
            .into(),
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
    let argv = argv(host, Mode::Batch, remote)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> EnvHost {
        EnvHost {
            id: "h".into(),
            name: "Lab".into(),
            ssh: "me@lab".into(),
            port: Some(2222),
            identity_file: Some("/k/id_ed25519".into()),
            incus_remote: Some("os1".into()),
            tailscale: None,
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

    #[test]
    fn incus_lines() {
        let h = host();
        assert_eq!(target(&h, "dev"), "os1:dev");
        let mut local = h.clone();
        local.incus_remote = None;
        assert_eq!(target(&local, "dev"), "dev");
        assert_eq!(remote_prefix(&local), None);

        let inner = as_agent(Some("/home/agent/work/my app"), &[("K".into(), "v w".into())], &["claude".into(), "-p".into()]);
        let l = line(&incus_exec(&h, "dev", Mode::Batch, &inner));
        assert!(l.starts_with("incus exec os1:dev -T -- runuser -u agent -- env HOME=/home/agent"), "{l}");
        assert!(l.contains("'K=v w'"), "{l}");
        assert!(l.ends_with("mango '/home/agent/work/my app' claude -p"), "{l}");
    }
}
