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
    }
    #[cfg(unix)]
    for abs in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(abs));
    }
    dirs
}

/// `$PATH` entries followed by the extra dirs, de-duplicated, in order.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let from_env = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
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
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
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
