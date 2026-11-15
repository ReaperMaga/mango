//! Discovery of the shells a terminal can run ("terminal profiles").
//!
//! Unix: /etc/shells, $SHELL and well-known shell names on PATH.
//! Windows: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash,
//! MSYS2/Cygwin, Nushell and every installed WSL distribution.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    /// Stable id, e.g. "zsh", "git-bash", "wsl:Ubuntu".
    pub id: String,
    /// Display name, e.g. "Zsh", "PowerShell 7", "WSL · Ubuntu".
    pub name: String,
    /// Program to start.
    pub path: String,
    pub args: Vec<String>,
    /// The shell a new terminal uses when the user has not chosen one.
    pub is_default: bool,
}

fn profile(id: &str, name: &str, path: &Path, args: &[&str]) -> TerminalProfile {
    TerminalProfile {
        id: id.to_string(),
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        args: args.iter().map(|a| a.to_string()).collect(),
        is_default: false,
    }
}

/// Display name and start arguments for a Unix shell binary name, or `None`
/// for things listed in /etc/shells that are not interactive shells.
#[cfg(any(unix, test))]
fn describe_unix(file_name: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match file_name {
        "bash" => ("Bash", &["-l"]),
        "zsh" => ("Zsh", &["-l"]),
        "fish" => ("fish", &["-l"]),
        "nu" => ("Nushell", &["-l"]),
        "pwsh" => ("PowerShell", &["-NoLogo"]),
        "sh" => ("sh", &["-l"]),
        "dash" => ("Dash", &["-l"]),
        "ksh" | "ksh93" | "mksh" => ("Korn shell", &["-l"]),
        "tcsh" => ("tcsh", &["-l"]),
        "csh" => ("csh", &["-l"]),
        "elvish" => ("Elvish", &[]),
        "xonsh" => ("Xonsh", &[]),
        "ion" => ("Ion", &[]),
        _ => return None,
    })
}

/// Order in the list: everyday shells first, bare-bones ones last.
#[cfg(any(unix, test))]
fn rank(file_name: &str) -> usize {
    const ORDER: [&str; 13] = ["zsh", "bash", "fish", "nu", "pwsh", "elvish", "xonsh", "ion", "tcsh", "ksh", "csh", "dash", "sh"];
    ORDER.iter().position(|n| *n == file_name).unwrap_or(ORDER.len())
}

/// Pure part of Unix discovery: candidate paths (already known to exist) → profiles.
/// `login_shell` is $SHELL. One entry per shell name; the login shell's own path wins.
#[cfg(any(unix, test))]
pub fn unix_profiles(candidates: &[PathBuf], login_shell: Option<&Path>) -> Vec<TerminalProfile> {
    let login_name = login_shell.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned());
    let mut out: Vec<(usize, TerminalProfile)> = Vec::new();

    let mut ordered: Vec<&PathBuf> = Vec::new();
    if let Some(login) = login_shell {
        if let Some(p) = candidates.iter().find(|c| c.as_path() == login) {
            ordered.push(p);
        }
    }
    ordered.extend(candidates.iter());

    for path in ordered {
        let Some(file_name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        let Some((name, args)) = describe_unix(&file_name) else { continue };
        if out.iter().any(|(_, p)| p.id == file_name) {
            continue;
        }
        let mut p = profile(&file_name, name, path, args);
        p.is_default = login_name.as_deref() == Some(file_name.as_str());
        out.push((rank(&file_name), p));
    }

    out.sort_by_key(|(rank, p)| (!p.is_default, *rank));
    let mut profiles: Vec<TerminalProfile> = out.into_iter().map(|(_, p)| p).collect();
    if !profiles.iter().any(|p| p.is_default) {
        if let Some(first) = profiles.first_mut() {
            first.is_default = true;
        }
    }
    profiles
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(unix)]
pub fn discover(_include_slow: bool) -> Vec<TerminalProfile> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let login = std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    if let Some(l) = &login {
        candidates.push(l.clone());
    }
    if let Ok(text) = std::fs::read_to_string("/etc/shells") {
        for line in text.lines().map(str::trim) {
            if !line.is_empty() && !line.starts_with('#') {
                candidates.push(PathBuf::from(line));
            }
        }
    }
    for name in ["zsh", "bash", "fish", "nu", "pwsh", "elvish", "xonsh", "sh"] {
        if let Some(p) = crate::bin::find(name) {
            candidates.push(p);
        }
    }
    candidates.retain(|p| is_executable(p));
    unix_profiles(&candidates, login.as_deref().filter(|p| is_executable(p)))
}

/// WSL distribution names from `wsl.exe -l -q` output, which is UTF-16LE.
#[cfg(any(windows, test))]
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0').to_string())
        // docker-desktop's helper distros are not places to work in.
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

#[cfg(windows)]
pub fn discover(include_slow: bool) -> Vec<TerminalProfile> {
    use std::time::Duration;

    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let system_root = env("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let system32 = system_root.join("System32");
    let program_files = env("ProgramFiles").unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let program_files_x86 = env("ProgramFiles(x86)").unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    let local_app = env("LOCALAPPDATA");
    let first_existing = |paths: Vec<PathBuf>| paths.into_iter().find(|p| p.is_file());

    let mut out: Vec<TerminalProfile> = Vec::new();

    let pwsh = crate::bin::find("pwsh").or_else(|| first_existing(vec![program_files.join(r"PowerShell\7\pwsh.exe")]));
    if let Some(p) = &pwsh {
        out.push(profile("pwsh", "PowerShell 7", p, &["-NoLogo"]));
    }
    let windows_ps = system32.join(r"WindowsPowerShell\v1.0\powershell.exe");
    if windows_ps.is_file() {
        out.push(profile("powershell", "Windows PowerShell", &windows_ps, &["-NoLogo"]));
    }
    let cmd = system32.join("cmd.exe");
    if cmd.is_file() {
        out.push(profile("cmd", "Command Prompt", &cmd, &[]));
    }

    // Git for Windows: next to git.exe (…\Git\cmd\git.exe → …\Git\bin\bash.exe) or the usual install folders.
    let mut git_bash = vec![
        program_files.join(r"Git\bin\bash.exe"),
        program_files_x86.join(r"Git\bin\bash.exe"),
    ];
    if let Some(local) = &local_app {
        git_bash.push(local.join(r"Programs\Git\bin\bash.exe"));
    }
    if let Some(git) = crate::bin::find("git") {
        if let Some(root) = git.parent().and_then(Path::parent) {
            git_bash.insert(0, root.join(r"bin\bash.exe"));
        }
    }
    if let Some(p) = first_existing(git_bash) {
        out.push(profile("git-bash", "Git Bash", &p, &["--login", "-i"]));
    }

    if let Some(p) = first_existing(vec![PathBuf::from(r"C:\msys64\usr\bin\bash.exe")]) {
        out.push(profile("msys2", "MSYS2", &p, &["--login", "-i"]));
    }
    if let Some(p) = first_existing(vec![PathBuf::from(r"C:\cygwin64\bin\bash.exe"), PathBuf::from(r"C:\cygwin\bin\bash.exe")]) {
        out.push(profile("cygwin", "Cygwin", &p, &["--login", "-i"]));
    }
    if let Some(p) = crate::bin::find("nu") {
        out.push(profile("nu", "Nushell", &p, &[]));
    }

    // One profile per WSL distribution. Asking wsl.exe takes a moment, so only on request.
    let wsl = system32.join("wsl.exe");
    if include_slow && wsl.is_file() {
        if let Some((true, stdout)) = run_bytes(&wsl, &["-l", "-q"], Duration::from_secs(4)) {
            for distro in parse_wsl_list(&stdout) {
                let mut p = profile(&format!("wsl:{distro}"), &format!("WSL · {distro}"), &wsl, &["-d"]);
                p.args.push(distro);
                out.push(p);
            }
        }
    }

    if let Some(first) = out.first_mut() {
        first.is_default = true;
    }
    out
}

/// Run a program to completion with a timeout, returning (success, raw stdout).
#[cfg(windows)]
fn run_bytes(bin: &Path, args: &[&str], timeout: std::time::Duration) -> Option<(bool, Vec<u8>)> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let mut cmd = Command::new(bin);
    crate::bin::hide_console(&mut cmd);
    let mut child = cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    Some((ok, reader.join().unwrap_or_default()))
}

/// The shell for a terminal opened without an explicit choice.
pub fn default_profile() -> Option<TerminalProfile> {
    discover(false).into_iter().find(|p| p.is_default)
}

#[tauri::command]
pub async fn terminal_profiles() -> Result<Vec<TerminalProfile>, String> {
    tauri::async_runtime::spawn_blocking(|| discover(true)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn login_shell_is_default_and_first() {
        let c = paths(&["/bin/sh", "/bin/bash", "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/tmux", "/usr/sbin/nologin"]);
        let p = unix_profiles(&c, Some(Path::new("/usr/bin/fish")));
        let ids: Vec<&str> = p.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["fish", "zsh", "bash", "sh"]);
        assert!(p[0].is_default);
        assert_eq!(p.iter().filter(|x| x.is_default).count(), 1);
    }

    #[test]
    fn one_entry_per_shell_and_login_path_wins() {
        let c = paths(&["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"]);
        let p = unix_profiles(&c, Some(Path::new("/opt/homebrew/bin/bash")));
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].path, "/opt/homebrew/bin/bash");
        assert_eq!(p[0].args, ["-l"]);
    }

    #[test]
    fn falls_back_to_first_when_login_shell_is_unknown() {
        let c = paths(&["/bin/sh", "/bin/bash"]);
        let p = unix_profiles(&c, None);
        assert_eq!(p[0].id, "bash");
        assert!(p[0].is_default);
        assert!(unix_profiles(&[], None).is_empty());
    }

    #[test]
    fn parses_wsl_utf16_list() {
        let text = "Ubuntu\r\ndocker-desktop\r\nDebian\r\n\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu", "Debian"]);
    }
}
