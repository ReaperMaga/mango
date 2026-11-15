//! Project folders: recent list, git branch detection, create and clone.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_RECENT: usize = 30;
const RECENT_FILE: &str = "recent-projects.json";
/// How many trailing stderr lines to include in a failed clone's error.
const CLONE_ERROR_LINES: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    /// Under version control: git, or a Unity VCS workspace (see `vcs`).
    pub is_git: bool,
    /// Which version control; None when there is none.
    #[serde(default)]
    pub vcs: Option<crate::git::Vcs>,
    pub branch: Option<String>,
    pub last_opened: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneProgress {
    job_id: String,
    line: String,
}

/// Serializes read-modify-write cycles of the recent-projects file.
#[derive(Default)]
pub struct ProjectsState {
    lock: Mutex<()>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Branch name from the contents of a `HEAD` file. Detached → `None`.
pub(crate) fn parse_head(contents: &str) -> Option<String> {
    let reference = contents.trim().strip_prefix("ref:")?.trim();
    if reference.is_empty() {
        return None;
    }
    Some(
        reference
            .strip_prefix("refs/heads/")
            .unwrap_or(reference)
            .to_string(),
    )
}

/// Target of a `.git` *file* (worktrees, submodules): `gitdir: <path>`.
pub(crate) fn parse_gitdir_file(contents: &str, base: &Path) -> Option<PathBuf> {
    let line = contents.lines().find_map(|l| l.trim().strip_prefix("gitdir:"))?;
    let target = Path::new(line.trim());
    if target.as_os_str().is_empty() {
        return None;
    }
    Some(if target.is_absolute() {
        target.to_path_buf()
    } else {
        base.join(target)
    })
}

/// Folder name git would use for `git clone <url>`.
pub(crate) fn repo_name_from_url(url: &str) -> Option<String> {
    let mut s = url.trim().trim_end_matches(['/', '\\']);
    if let Some(stripped) = s.strip_suffix(".git") {
        s = stripped.trim_end_matches(['/', '\\']);
    }
    let name = s.rsplit(['/', '\\', ':']).next()?.trim();
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name.to_string())
    }
}

fn validate_folder_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name can't be empty".into());
    }
    if name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("\"{name}\" is not a valid folder name"));
    }
    #[cfg(windows)]
    if name.contains([':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("\"{name}\" is not a valid folder name"));
    }
    Ok(name)
}

/// Absolute, `~`-expanded, lexically normalized path (symlinks untouched).
fn normalize(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No folder given".into());
    }
    let expanded = match trimmed.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => dirs::home_dir()
            .ok_or("Could not determine your home folder")?
            .join(rest.trim_start_matches(['/', '\\'])),
        _ => PathBuf::from(trimmed),
    };
    let abs = std::path::absolute(&expanded)
        .map_err(|e| format!("Invalid path {trimmed}: {e}"))?;
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_string(path))
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/// Find the repo containing `dir` (walking up like git does) and read its branch.
fn git_info(dir: &Path) -> (bool, Option<String>) {
    for ancestor in dir.ancestors() {
        let dot_git = ancestor.join(".git");
        let git_dir = if dot_git.is_dir() {
            dot_git
        } else if dot_git.is_file() {
            match fs::read_to_string(&dot_git)
                .ok()
                .and_then(|c| parse_gitdir_file(&c, ancestor))
            {
                Some(dir) => dir,
                None => continue,
            }
        } else {
            continue;
        };
        let branch = fs::read_to_string(git_dir.join("HEAD"))
            .ok()
            .and_then(|c| parse_head(&c));
        return (true, branch);
    }
    (false, None)
}

fn inspect(path: &Path, last_opened: u64) -> ProjectInfo {
    let (is_git, branch, vcs) = match crate::vcs::detect_on_disk(path) {
        Some((crate::git::Vcs::Plastic, root)) => (true, crate::plastic::selector_branch(&root), Some(crate::git::Vcs::Plastic)),
        _ => {
            let (is_git, branch) = git_info(path);
            (is_git, branch, is_git.then_some(crate::git::Vcs::Git))
        }
    };
    ProjectInfo {
        vcs,
        path: path_string(path),
        name: folder_name(path),
        is_git,
        branch,
        last_opened,
    }
}

fn recent_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(RECENT_FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

fn load_recent(app: &AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let file = recent_file(app)?;
    match fs::read_to_string(&file) {
        // A corrupt file shouldn't brick the app: start over.
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Could not read {}: {e}", file.display())),
    }
}

fn save_recent(app: &AppHandle, list: &[ProjectInfo]) -> Result<(), String> {
    let file = recent_file(app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    // Write-then-rename so a crash never leaves a half-written file.
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json)
        .and_then(|_| fs::rename(&tmp, &file))
        .map_err(|e| format!("Could not save {}: {e}", file.display()))
}

fn record_recent(app: &AppHandle, info: &ProjectInfo) -> Result<(), String> {
    let state = app.state::<ProjectsState>();
    let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_recent(app)?;
    list.retain(|p| p.path != info.path);
    list.insert(0, info.clone());
    list.truncate(MAX_RECENT);
    save_recent(app, &list)
}

fn open_dir(app: &AppHandle, dir: &Path) -> Result<ProjectInfo, String> {
    let info = inspect(dir, now_ms());
    record_recent(app, &info)?;
    Ok(info)
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn recent_projects(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    blocking(move || {
        let list = {
            let state = app.state::<ProjectsState>();
            let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
            load_recent(&app)?
        };
        // Missing folders are hidden but kept, in case a drive is just unmounted.
        Ok(list
            .into_iter()
            .filter(|p| Path::new(&p.path).is_dir())
            .map(|p| inspect(Path::new(&p.path), p.last_opened))
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn open_project(app: AppHandle, path: String) -> Result<ProjectInfo, String> {
    blocking(move || {
        let dir = normalize(&path)?;
        if !dir.is_dir() {
            return Err(format!("{} is not a folder", dir.display()));
        }
        open_dir(&app, &dir)
    })
    .await
}

#[tauri::command]
pub async fn forget_project(
    app: AppHandle,
    state: State<'_, ProjectsState>,
    path: String,
) -> Result<(), String> {
    let target = normalize(&path).map(|p| path_string(&p)).unwrap_or(path);
    let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_recent(&app)?;
    let before = list.len();
    list.retain(|p| p.path != target);
    if list.len() != before {
        save_recent(&app, &list)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    parent: String,
    name: String,
    git_init: bool,
) -> Result<ProjectInfo, String> {
    blocking(move || {
        let name = validate_folder_name(&name)?;
        let dir = normalize(&parent)?.join(name);
        if dir.exists() {
            if !dir.is_dir() {
                return Err(format!("{} already exists and is not a folder", dir.display()));
            }
            if !is_empty_dir(&dir) {
                return Err(format!("{} already exists and is not empty", dir.display()));
            }
        }
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

        if git_init {
            // Best effort: without git the project is still created, just not a repo.
            let mut init = Command::new(crate::bin::git());
            crate::bin::hide_console(&mut init);
            let _ = init
                .arg("init")
                .current_dir(&dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        open_dir(&app, &dir)
    })
    .await
}

#[tauri::command]
pub async fn git_clone(
    app: AppHandle,
    url: String,
    parent: String,
    name: Option<String>,
    job_id: String,
) -> Result<ProjectInfo, String> {
    blocking(move || {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err("No repository URL given".into());
        }
        let name = match name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => validate_folder_name(n)?.to_string(),
            None => repo_name_from_url(&url)
                .ok_or_else(|| format!("Could not derive a folder name from {url}"))?,
        };
        let parent = normalize(&parent)?;
        let dir = parent.join(&name);
        if dir.exists() && !(dir.is_dir() && is_empty_dir(&dir)) {
            return Err(format!("{} already exists and is not empty", dir.display()));
        }
        fs::create_dir_all(&parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;

        let mut clone = Command::new(crate::bin::git());
        crate::bin::hide_console(&mut clone);
        let mut child = clone
            .args(["clone", "--progress", "--"])
            .arg(&url)
            .arg(&dir)
            .current_dir(&parent)
            // Never hang waiting for credentials on a terminal nobody sees.
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => "git is not installed or not on PATH".to_string(),
                _ => format!("Could not run git: {e}"),
            })?;

        let mut tail: Vec<String> = Vec::new();
        if let Some(stderr) = child.stderr.take() {
            for_each_line(stderr, |line| {
                let _ = app.emit(
                    "clone://progress",
                    CloneProgress {
                        job_id: job_id.clone(),
                        line: line.to_string(),
                    },
                );
                tail.push(line.to_string());
                if tail.len() > CLONE_ERROR_LINES {
                    tail.remove(0);
                }
            });
        }

        let status = child
            .wait()
            .map_err(|e| format!("git clone did not finish: {e}"))?;
        if !status.success() {
            let detail = tail
                .iter()
                .filter(|l| !l.contains('%')) // progress meters are noise in an error
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(if detail.is_empty() {
                format!("git clone failed ({status})")
            } else {
                format!("git clone failed:\n{detail}")
            });
        }
        open_dir(&app, &dir)
    })
    .await
}

/// Calls `f` for every non-empty line, splitting on both `\r` and `\n`
/// (git redraws progress meters with `\r`).
fn for_each_line(mut source: impl Read, mut f: impl FnMut(&str)) {
    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::new();
    let mut flush = |line: &mut Vec<u8>| {
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end();
        if !text.is_empty() {
            f(text);
        }
        line.clear();
    };
    loop {
        match source.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\r' || b == b'\n' {
                        flush(&mut line);
                    } else {
                        line.push(b);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    flush(&mut line);
}

#[tauri::command]
pub async fn default_projects_dir() -> Result<String, String> {
    let dir = dirs::home_dir()
        .ok_or("Could not determine your home folder")?
        .join("Projects");
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(path_string(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_branch() {
        assert_eq!(parse_head("ref: refs/heads/main\n").as_deref(), Some("main"));
        assert_eq!(
            parse_head("ref: refs/heads/feature/x-1\n").as_deref(),
            Some("feature/x-1")
        );
        assert_eq!(parse_head("ref:refs/heads/dev").as_deref(), Some("dev"));
    }

    #[test]
    fn head_detached() {
        assert_eq!(parse_head("3f786850e387550fdab836ed7e6dc881de23001b\n"), None);
        assert_eq!(parse_head(""), None);
        assert_eq!(parse_head("ref: "), None);
    }

    #[test]
    fn gitdir_file() {
        let base = Path::new("/work/repo-wt");
        assert_eq!(
            parse_gitdir_file("gitdir: /work/repo/.git/worktrees/wt\n", base),
            Some(PathBuf::from("/work/repo/.git/worktrees/wt"))
        );
        assert_eq!(
            parse_gitdir_file("gitdir: ../repo/.git/modules/sub\n", base),
            Some(base.join("../repo/.git/modules/sub"))
        );
        assert_eq!(parse_gitdir_file("nonsense", base), None);
    }

    #[test]
    fn worktree_branch_on_disk() {
        let root = std::env::temp_dir().join(format!("mango-test-{}", uuid::Uuid::new_v4()));
        let main_git = root.join("repo/.git");
        let wt_git = main_git.join("worktrees/wt");
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(main_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(wt_git.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        let wt = root.join("wt");
        fs::create_dir_all(wt.join("src")).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();

        assert_eq!(git_info(&root.join("repo")), (true, Some("main".into())));
        assert_eq!(git_info(&wt), (true, Some("topic".into())));
        assert_eq!(git_info(&wt.join("src")), (true, Some("topic".into())));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn repo_names() {
        let cases = [
            ("https://github.com/a/b.git", "b"),
            ("https://github.com/a/b", "b"),
            ("https://github.com/a/b/", "b"),
            ("git@github.com:a/b.git", "b"),
            ("git@host:repo.git", "repo"),
            ("ssh://git@host:22/a/my-repo.git", "my-repo"),
            ("/srv/git/project.git/", "project"),
            ("/srv/git/project/.git", "project"),
            ("  https://gitlab.com/group/sub/tool.git  ", "tool"),
        ];
        for (url, want) in cases {
            assert_eq!(repo_name_from_url(url).as_deref(), Some(want), "{url}");
        }
        assert_eq!(repo_name_from_url(""), None);
        assert_eq!(repo_name_from_url("https://"), None);
    }

    #[test]
    fn folder_names() {
        assert!(validate_folder_name("my-app").is_ok());
        assert!(validate_folder_name("").is_err());
        assert!(validate_folder_name("..").is_err());
        assert!(validate_folder_name("a/b").is_err());
    }

    #[test]
    fn lines_split_on_cr_and_lf() {
        let input: &[u8] = b"Cloning into 'b'...\nReceiving objects:  10%\rReceiving objects: 100%\r\ndone.\n";
        let mut lines = Vec::new();
        for_each_line(input, |l| lines.push(l.to_string()));
        assert_eq!(
            lines,
            [
                "Cloning into 'b'...",
                "Receiving objects:  10%",
                "Receiving objects: 100%",
                "done."
            ]
        );
    }

    #[test]
    fn normalize_paths() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(normalize("~").unwrap(), home);
        assert_eq!(normalize("~/x/./y/../z/").unwrap(), home.join("x/z"));
        assert!(normalize("  ").is_err());
    }
}
