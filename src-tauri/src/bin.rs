//! Locating executables. GUI apps are often launched with a minimal PATH
//! (no shell profile), so the search also covers common user install dirs.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Directories searched in addition to `$PATH`.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".bun/bin",
            ".cargo/bin",
            ".local/share/mise/shims",
            ".claude/local",
            ".npm-global/bin",
            ".volta/bin",
        ] {
            dirs.push(home.join(rel));
        }
    }
    // Where Windows installers put things. A running app keeps the PATH it was
    // started with, so tools installed from the setup dialog live here until
    // Mango restarts.
    #[cfg(windows)]
    {
        // Lore's installer (install.ps1) puts lore.exe in %USERPROFILE%\bin.
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join("bin"));
        }
        if let Some(local) = dirs::data_local_dir() {
            dirs.push(local.join(r"Programs\OpenAI\Codex\bin"));
            dirs.push(local.join(r"Microsoft\WinGet\Links"));
        }
        if let Some(roaming) = dirs::data_dir() {
            dirs.push(roaming.join("npm"));
        }
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        dirs.push(program_files.join(r"Git\cmd"));
        dirs.push(program_files.join("nodejs"));
        dirs.push(program_files.join("GitHub CLI"));
        dirs.push(program_files.join("glab"));
        if let Some(x86) = std::env::var_os("ProgramFiles(x86)") {
            dirs.push(PathBuf::from(x86).join("glab"));
        }
    }
    #[cfg(unix)]
    for abs in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(abs));
    }
    dirs
}

/// The PATH Windows gives a program started now: the system's entries, then the
/// user's, read from the registry. An installer run from the setup dialog adds
/// its folder there, which the PATH this process started with never sees.
#[cfg(windows)]
fn registry_path() -> Vec<PathBuf> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    fn read(root: HKEY, key: PCWSTR) -> Option<Vec<u16>> {
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        let mut bytes = 0u32;
        // SAFETY: a size query, then a read into a buffer of the size it gave.
        unsafe {
            if RegGetValueW(root, key, w!("Path"), flags, None, None, Some(&mut bytes)).is_err() || bytes == 0 {
                return None;
            }
            let mut buf = vec![0u16; (bytes as usize).div_ceil(2) + 1];
            bytes = (buf.len() * 2) as u32;
            if RegGetValueW(root, key, w!("Path"), flags, None, Some(buf.as_mut_ptr().cast()), Some(&mut bytes)).is_err() {
                return None;
            }
            buf.truncate(buf.iter().position(|&c| c == 0).unwrap_or(buf.len()));
            buf.push(0);
            Some(buf)
        }
    }

    fn expand(raw: &[u16]) -> Option<OsString> {
        use std::os::windows::ffi::OsStringExt;
        let src = PCWSTR(raw.as_ptr());
        // SAFETY: `raw` ends in a NUL; the second call gets a buffer of the size the first asked for.
        unsafe {
            let needed = ExpandEnvironmentStringsW(src, None);
            if needed == 0 {
                return None;
            }
            let mut out = vec![0u16; needed as usize];
            let written = ExpandEnvironmentStringsW(src, Some(&mut out));
            if written == 0 || written > needed {
                return None;
            }
            out.truncate(out.iter().position(|&c| c == 0).unwrap_or(out.len()));
            Some(OsString::from_wide(&out))
        }
    }

    [
        (HKEY_LOCAL_MACHINE, w!(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")),
        (HKEY_CURRENT_USER, w!("Environment")),
    ]
    .into_iter()
    .filter_map(|(root, key)| read(root, key))
    .filter_map(|raw| expand(&raw))
    .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
    .collect()
}

/// `$PATH` entries followed by the extra dirs, de-duplicated, in order.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let from_env = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    #[cfg(windows)]
    let from_env = from_env.into_iter().chain(registry_path()).collect::<Vec<_>>();
    for dir in from_env.into_iter().chain(extra_dirs()) {
        if !dir.as_os_str().is_empty() && !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// A PATH value made of [`search_dirs`], for child processes that may need
/// to find their own interpreters (e.g. `claude` is a node script).
pub fn augmented_path(first: Option<&Path>) -> Option<OsString> {
    let mut dirs = search_dirs();
    if let Some(first) = first {
        dirs.retain(|d| d != first);
        dirs.insert(0, first.to_path_buf());
    }
    std::env::join_paths(dirs).ok()
}

/// Resolve `name` to an executable path, like `which`.
pub fn find(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates: Vec<String> = [".exe", ".cmd", ".bat", ".com", ""]
        .iter()
        .map(|ext| format!("{name}{ext}"))
        .collect();
    #[cfg(not(windows))]
    let candidates: Vec<String> = vec![name.to_string()];

    search_dirs().into_iter().find_map(|dir| {
        candidates
            .iter()
            .map(|c| dir.join(c))
            .find(|p| is_executable(p))
    })
}

#[cfg(unix)]
pub(crate) fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub(crate) fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// The `git` binary, falling back to the bare name so the OS can try.
pub fn git() -> PathBuf {
    find("git").unwrap_or_else(|| PathBuf::from("git"))
}

/// Stop Windows from flashing a console window for a child process started by
/// a GUI app. No-op elsewhere.
pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A real `name` (`sh`, `bash`) for tests that syntax-check scripts. Not WSL's launcher in
/// System32 (or the Store's alias), which cannot run without a distribution installed.
#[cfg(test)]
pub(crate) fn test_shell(name: &str) -> Option<PathBuf> {
    find(name).filter(|p| {
        let s = p.to_string_lossy().to_lowercase();
        !s.contains("system32") && !s.contains("windowsapps")
    })
}

/// `name -n` the script when a real one is around (skipped otherwise). Through stdin:
/// MSYS/Cygwin shells re-parse a Windows command line with their own quoting rules.
#[cfg(test)]
pub(crate) fn assert_parses(name: &str, script: &str) {
    use std::io::Write;
    let Some(shell) = test_shell(name) else { return eprintln!("no {name} found; skipping") };
    let mut child = std::process::Command::new(&shell)
        .arg("-n")
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("run shell");
    child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stderr));
}
