//! Project folders: recent list, git branch detection, create and clone (git, or Lore through
//! `lore_servers`).

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::git::Vcs;

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
        // Lore keeps its branch in its own store; the Changes view's first status read fills it in.
        Some((crate::git::Vcs::Lore, _)) => (true, None, Some(crate::git::Vcs::Lore)),
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

/// A new project's Lore repository: on `server` (`lore://host[:port]`), or only on this computer
/// (`server` null, `lore repository create --offline`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreNew {
    #[serde(default)]
    pub server: Option<String>,
    pub repository: String,
}

/// `lore` (validated) as what to run: the server, if any, and the repository name.
pub(crate) fn lore_target(lore: &LoreNew) -> Result<(Option<crate::lore_servers::ServerUrl>, String), String> {
    let server = match lore.server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(crate::lore_servers::parse_server_url(s)?),
        None => None,
    };
    let name = lore.repository.trim();
    crate::lore_servers::valid_repo_name(name)?;
    Ok((server, name.to_string()))
}

/// `lore repository create` in `dir` (new and empty).
fn lore_create(dir: &Path, lore: &LoreNew) -> Result<(), String> {
    use crate::lore_servers as lore_cli;
    let (server, name) = lore_target(lore)?;
    let bin = lore_cli::find().ok_or(lore_cli::MISSING)?;
    let mut cmd = lore_cli::command(&bin);
    cmd.args(lore_cli::create_argv(server.as_ref(), &name)).current_dir(dir);
    let out = crate::git::run_process(cmd, None, 256 * 1024, lore_cli::CREATE_TIMEOUT, "lore", lore_cli::MISSING)?;
    if out.ok() {
        return Ok(());
    }
    let place = server.map(|s| s.to_string()).unwrap_or_else(|| "this computer".into());
    Err(lore_cli::explain(out.code, &out.combined(), &place, &format!("create the Lore repository {name}")))
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    parent: String,
    name: String,
    git_init: bool,
    lore: Option<LoreNew>,
) -> Result<ProjectInfo, String> {
    blocking(move || {
        let name = validate_folder_name(&name)?;
        if let Some(l) = &lore {
            lore_target(l)?;
        }
        let dir = normalize(&parent)?.join(name);
        let existed = dir.exists();
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

        if let Some(l) = &lore {
            // Unlike `git init`, this can fail for reasons the user must see (server, sign-in, name):
            // then nothing is left behind that was not there before.
            if let Err(e) = lore_create(&dir, l) {
                if existed {
                    let _ = fs::remove_dir_all(dir.join(".lore"));
                } else {
                    let _ = fs::remove_dir_all(&dir);
                }
                return Err(e);
            }
        } else if git_init {
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

// ---------------------------------------------------------------------------
// A Lore repository in an existing project folder
// ---------------------------------------------------------------------------

/// The largest ignore file Mango reads or writes for Lore.
const IGNORE_CAP: u64 = 256 * 1024;

/// What `lore_init` needs to know about a folder before it asks: what it is under now, and the
/// ignore files a `.loreignore` could be made from (`utils/loreIgnore.ts` converts them).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreInitInfo {
    /// The version control Mango sees for the folder now (this folder or one above), if any.
    pub vcs: Option<Vcs>,
    /// Where that one's root is.
    pub vcs_root: Option<String>,
    /// `.git` in the folder itself: git keeps winning there, so Mango goes on showing git.
    pub git_here: bool,
    /// `.plastic` in the folder itself: Lore will win over Unity VCS there.
    pub plastic_here: bool,
    /// `Assets/` and `ProjectSettings/`: a Unity project.
    pub unity: bool,
    /// The folder already has a `.loreignore` (never overwritten).
    pub loreignore: bool,
    pub gitignore: Option<String>,
    /// Unity VCS's `ignore.conf`.
    pub plastic_ignore: Option<String>,
}

/// A small text file, or None when it is missing, too big or not text.
fn read_small(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > IGNORE_CAP {
        return None;
    }
    let text = String::from_utf8(fs::read(path).ok()?).ok()?;
    Some(text.trim_start_matches('\u{feff}').to_string())
}

fn local_folder(path: &str) -> Result<PathBuf, String> {
    if crate::envs::parse_env_path(path).is_some() {
        return Err("Lore repositories in environments are made with New project there.".into());
    }
    let dir = normalize(path)?;
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    Ok(dir)
}

fn lore_init_info_at(dir: &Path) -> LoreInitInfo {
    let (vcs, root) = match crate::vcs::detect_on_disk(dir) {
        Some((v, r)) => (Some(v), Some(path_string(&r))),
        None => (None, None),
    };
    LoreInitInfo {
        vcs,
        vcs_root: root,
        git_here: dir.join(".git").exists(),
        plastic_here: dir.join(".plastic").is_dir(),
        unity: dir.join("Assets").is_dir() && dir.join("ProjectSettings").is_dir(),
        loreignore: dir.join(".loreignore").exists(),
        gitignore: read_small(&dir.join(".gitignore")),
        plastic_ignore: read_small(&dir.join("ignore.conf")),
    }
}

/// Why Lore would refuse `ignore` (and then fail `lore status` for the whole repository), or None.
/// Mirrors `loreIgnoreProblem` in `utils/loreIgnore.ts`.
fn ignore_problem(ignore: &str) -> Option<String> {
    if ignore.len() as u64 > IGNORE_CAP {
        return Some("The ignore file is too large.".into());
    }
    if ignore.contains('\0') {
        return Some("The ignore file holds a NUL character.".into());
    }
    ignore.lines().enumerate().find_map(|(i, l)| {
        let rule = l.trim();
        let rest = rule.strip_prefix('!')?.trim_start();
        rest.starts_with("**").then(|| {
            format!("Line {} of the ignore file, {rule}, is an exception that starts with **, which Lore refuses. Remove it or anchor it.", i + 1)
        })
    })
}

#[tauri::command]
pub async fn lore_init_info(path: String) -> Result<LoreInitInfo, String> {
    blocking(move || Ok(lore_init_info_at(&local_folder(&path)?))).await
}

/// `.loreignore` (when given) and then `lore repository create` in an existing folder. Its files stay as
/// they are and show as new. On failure the folder is left as it was.
fn lore_init_at(dir: &Path, lore: &LoreNew, ignore: Option<&str>) -> Result<(), String> {
    lore_target(lore)?;
    if let Some((Vcs::Lore, root)) = crate::vcs::detect_on_disk(dir) {
        return Err(if root == dir {
            "This folder is already a Lore repository.".into()
        } else {
            format!("This folder is already inside the Lore repository at {}.", root.display())
        });
    }
    let meta = dir.join(".lore");
    if meta.exists() {
        return Err("This folder already has a .lore folder.".into());
    }
    let ignore = ignore.filter(|s| !s.trim().is_empty());
    let ignore_path = dir.join(".loreignore");
    if let Some(text) = ignore {
        if let Some(problem) = ignore_problem(text) {
            return Err(problem);
        }
        // `create_new`: an ignore file that is there is never replaced.
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&ignore_path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                "This folder already has a .loreignore; Mango leaves it as it is.".to_string()
            } else {
                format!("Could not write {}: {e}", ignore_path.display())
            }
        })?;
        let text = if text.ends_with('\n') { text.to_string() } else { format!("{text}\n") };
        if let Err(e) = std::io::Write::write_all(&mut f, text.as_bytes()) {
            drop(f);
            let _ = fs::remove_file(&ignore_path);
            return Err(format!("Could not write {}: {e}", ignore_path.display()));
        }
    }
    if let Err(e) = lore_create(dir, lore) {
        let _ = fs::remove_dir_all(&meta);
        if ignore.is_some() {
            let _ = fs::remove_file(&ignore_path);
        }
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn lore_init(path: String, lore: LoreNew, ignore: Option<String>) -> Result<(), String> {
    blocking(move || lore_init_at(&local_folder(&path)?, &lore, ignore.as_deref())).await
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
        let lore = is_lore_url(&url);
        let url = if lore {
            let (server, name) = crate::lore_servers::parse_repo_url(&url)?;
            server.repo(&name)
        } else {
            url
        };
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

        if lore {
            return lore_clone(&app, &url, &dir, &job_id).and_then(|_| open_dir(&app, &dir));
        }

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

/// A `lore://` or `lores://` address (any case), cloned with `lore` rather than git.
pub(crate) fn is_lore_url(url: &str) -> bool {
    crate::lore_servers::strip_scheme(url.trim()).is_some()
}

/// `lore clone <url> <dir>`, its lines streamed as `clone://progress`. A failed clone leaves no folder
/// (the CLI removes what it started).
fn lore_clone(app: &AppHandle, url: &str, dir: &Path, job_id: &str) -> Result<(), String> {
    use crate::lore_servers as lore_cli;
    let bin = lore_cli::find().ok_or(lore_cli::MISSING)?;
    let mut cmd = lore_cli::command(&bin);
    let mut child = cmd
        .args(lore_cli::clone_argv(url, &dir.to_string_lossy()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => lore_cli::MISSING.to_string(),
            _ => format!("Could not run lore: {e}"),
        })?;
    // Errors come on stderr, progress on stdout: both are shown, the errors kept for the message.
    let stderr = child.stderr.take();
    let (app2, job2) = (app.clone(), job_id.to_string());
    let errors = std::thread::spawn(move || {
        let mut said = String::new();
        if let Some(stderr) = stderr {
            for_each_line(stderr, |line| {
                let _ = app2.emit("clone://progress", CloneProgress { job_id: job2.clone(), line: line.to_string() });
                if said.len() < 16 * 1024 {
                    said.push_str(line);
                    said.push('\n');
                }
            });
        }
        said
    });
    if let Some(stdout) = child.stdout.take() {
        for_each_line(stdout, |line| {
            let _ = app.emit("clone://progress", CloneProgress { job_id: job_id.to_string(), line: line.to_string() });
        });
    }
    let status = child.wait().map_err(|e| format!("lore clone did not finish: {e}"))?;
    let said = errors.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let server = crate::lore_servers::parse_repo_url(url).map(|(s, _)| s.to_string()).unwrap_or_else(|_| url.to_string());
    Err(lore_cli::explain(status.code(), &said, &server, &format!("clone {url}")))
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
        // Lore: the repository's last part names the folder.
        assert_eq!(repo_name_from_url("lore://lore.example.com:41337/game/art").as_deref(), Some("art"));
        assert_eq!(repo_name_from_url("lore://127.0.0.1/demo").as_deref(), Some("demo"));
        assert!(is_lore_url("LORE://h/x") && !is_lore_url("https://h/x"));
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

    /// Against a real `lore` and server, with a scratch HOME:
    /// `MANGO_LORE_URL=lore://127.0.0.1 cargo test real_lore_create -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_lore_create() {
        let server = std::env::var("MANGO_LORE_URL").unwrap_or_else(|_| "lore://127.0.0.1".into());
        let root = std::env::temp_dir().join(format!("mango-lore-create-{}", uuid::Uuid::new_v4().simple()));
        let name = format!("mango-test-{}", uuid::Uuid::new_v4().simple());
        let on_server = LoreNew { server: Some(server.clone()), repository: name.clone() };
        fs::create_dir_all(root.join("a")).unwrap();
        lore_create(&root.join("a"), &on_server).unwrap();
        assert!(root.join("a/.lore/config.toml").is_file());
        // The same name again: refused, in plain words.
        fs::create_dir_all(root.join("b")).unwrap();
        let e = lore_create(&root.join("b"), &on_server).unwrap_err();
        println!("again: {e}");
        assert!(e.contains("already has a repository"), "{e}");
        fs::create_dir_all(root.join("c")).unwrap();
        lore_create(&root.join("c"), &LoreNew { server: None, repository: "offline".into() }).unwrap();
        fs::create_dir_all(root.join("d")).unwrap();
        let e = lore_create(&root.join("d"), &LoreNew { server: Some("lore://127.0.0.1:1".into()), repository: "x".into() }).unwrap_err();
        println!("unreachable: {e}");
        assert!(e.contains("did not answer"), "{e}");
        fs::remove_dir_all(&root).unwrap();
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mango-{tag}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ignore_files_lore_refuses() {
        assert_eq!(ignore_problem("Library\n!keep.txt\n!a/**/b\n# !**/c\n"), None);
        let e = ignore_problem("a\n  !**/Gen/**/*.csproj\n").unwrap();
        assert!(e.starts_with("Line 2 ") && e.contains("!**/Gen"), "{e}");
        assert!(ignore_problem("! **/x").is_some());
        assert!(ignore_problem("a\0b").is_some());
        assert!(ignore_problem(&"x".repeat(IGNORE_CAP as usize + 1)).is_some());
    }

    #[test]
    fn lore_init_reads_the_folder() {
        let dir = scratch("lore-info");
        let info = lore_init_info_at(&dir);
        assert!(info.vcs.is_none() && !info.unity && !info.git_here && !info.loreignore && info.gitignore.is_none());
        fs::create_dir_all(dir.join("Assets")).unwrap();
        fs::create_dir_all(dir.join("ProjectSettings")).unwrap();
        fs::create_dir_all(dir.join(".plastic")).unwrap();
        fs::write(dir.join("ignore.conf"), "\u{feff}Library\n").unwrap();
        fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        let info = lore_init_info_at(&dir);
        assert_eq!(info.vcs, Some(Vcs::Plastic));
        assert!(info.unity && info.plastic_here && !info.git_here);
        assert_eq!(info.plastic_ignore.as_deref(), Some("Library\n"));
        assert_eq!(info.gitignore.as_deref(), Some("node_modules/\n"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lore_init_refuses_without_touching_the_folder() {
        let dir = scratch("lore-refuse");
        let offline = LoreNew { server: None, repository: "ok".into() };
        // A bad name or ignore file: refused before anything is written.
        assert!(lore_init_at(&dir, &LoreNew { server: None, repository: "-bad".into() }, Some("x")).is_err());
        assert!(lore_init_at(&dir, &offline, Some("!**/x")).is_err());
        assert!(!dir.join(".loreignore").exists() && !dir.join(".lore").exists());
        // An ignore file that is there is never replaced.
        fs::write(dir.join(".loreignore"), "mine\n").unwrap();
        let e = lore_init_at(&dir, &offline, Some("theirs")).unwrap_err();
        assert!(e.contains(".loreignore"), "{e}");
        assert_eq!(fs::read_to_string(dir.join(".loreignore")).unwrap(), "mine\n");
        // Already a Lore repository, here or above.
        fs::create_dir_all(dir.join(".lore")).unwrap();
        assert!(lore_init_at(&dir, &offline, None).unwrap_err().contains("already a Lore repository"));
        fs::create_dir_all(dir.join("sub")).unwrap();
        assert!(lore_init_at(&dir.join("sub"), &offline, None).unwrap_err().contains("inside the Lore repository"));
        assert!(local_folder("env://h/i/dir").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Against the real `lore` CLI, offline only (no server, nothing spent):
    /// `cargo test real_lore_init -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_lore_init() {
        let dir = scratch("lore-init");
        fs::create_dir_all(dir.join(".plastic")).unwrap();
        fs::create_dir_all(dir.join("Library")).unwrap();
        fs::write(dir.join("Library/cache.bin"), "x").unwrap();
        fs::write(dir.join("keep.txt"), "kept").unwrap();
        fs::write(dir.join(".plastic/p"), "x").unwrap();
        let name = format!("mango-init-{}", uuid::Uuid::new_v4().simple());
        lore_init_at(&dir, &LoreNew { server: None, repository: name }, Some(".plastic/\n/Library/")).unwrap();
        assert!(dir.join(".lore").is_dir());
        assert_eq!(fs::read_to_string(dir.join(".loreignore")).unwrap(), ".plastic/\n/Library/\n");
        assert_eq!(fs::read_to_string(dir.join("keep.txt")).unwrap(), "kept");
        // Lore now wins over Unity VCS in the same folder.
        assert_eq!(crate::vcs::detect_on_disk(&dir).map(|d| d.0), Some(Vcs::Lore));
        let bin = crate::lore_servers::find().unwrap();
        let mut cmd = crate::lore_servers::command(&bin);
        cmd.args(["-P", "--non-interactive", "status", "--scan"]).current_dir(&dir);
        let out = cmd.output().unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        println!("{said}");
        assert!(out.status.success());
        assert!(said.contains("keep.txt") && said.contains(".loreignore"));
        assert!(!said.contains("Library") && !said.contains(".plastic"));
        // Again: refused, and the folder keeps its repository.
        assert!(lore_init_at(&dir, &LoreNew { server: None, repository: "again".into() }, None).is_err());
        assert!(dir.join(".lore").is_dir());
        // A server that does not answer: nothing is left behind, the ignore file included.
        let other = scratch("lore-init-fail");
        let e = lore_init_at(&other, &LoreNew { server: Some("lore://127.0.0.1:1".into()), repository: "x".into() }, Some("a")).unwrap_err();
        println!("unreachable: {e}");
        assert!(!other.join(".lore").exists() && !other.join(".loreignore").exists());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&other).unwrap();
    }

    #[test]
    fn normalize_paths() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(normalize("~").unwrap(), home);
        assert_eq!(normalize("~/x/./y/../z/").unwrap(), home.join("x/z"));
        assert!(normalize("  ").is_err());
    }
}
