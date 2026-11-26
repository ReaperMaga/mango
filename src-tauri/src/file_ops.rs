//! The Files view's operations on entries: new folder, rename, duplicate, delete, show in the
//! file manager. They act on the entry named, never on what a link points at; they never
//! replace anything; they leave the repository's own data (`.git`, `.plastic`) alone. The
//! entry's folder must be inside the project with links resolved, as for `files.rs`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::files::{on_root, plain_name, resolve};
use crate::git::{blocking, clean_rel};
use crate::trash_bin::{move_to_trash, Trashed};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsDeleted {
    pub deleted: bool,
    /// Not deleted because the trash cannot take it: why. Deleting it for good is the user's call.
    pub reason: Option<String>,
}

impl FsDeleted {
    fn done() -> Self {
        Self { deleted: true, reason: None }
    }
}

/// The repository's own data.
fn is_repo_data(name: &str) -> bool {
    let name = name.trim_end_matches(['.', ' ']);
    name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case(".plastic")
}

fn repo_data_error(rel: &str) -> String {
    format!("{rel} belongs to the repository's own data; Mango does not change it")
}

/// `rel` split into its folder and its name. Stricter than a path that is only read: a backslash
/// is part of a name outside Windows, so taking it for a separator would change another entry.
fn split_entry(rel: &str) -> Result<(&str, &str), String> {
    let bad = || format!("\"{rel}\" is not a file or folder inside the project");
    clean_rel(rel).map_err(|_| bad())?;
    if rel.contains(['\\', '\n', '\r']) || rel.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(bad());
    }
    if rel.split('/').any(is_repo_data) {
        return Err(repo_data_error(rel));
    }
    Ok(rel.rsplit_once('/').unwrap_or(("", rel)))
}

/// A name to give an entry on any system: an environment's, whatever this computer runs.
fn any_new_name(name: &str) -> Result<&str, String> {
    plain_name(name)?;
    if is_repo_data(name) {
        return Err(format!("\"{name}\" is a name the repository keeps for itself"));
    }
    Ok(name)
}

/// A name to give an entry on this computer.
pub(crate) fn new_name(name: &str) -> Result<&str, String> {
    any_new_name(name)?;
    #[cfg(windows)]
    {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.chars().any(|c| c.is_control()) {
            return Err(format!("Windows does not allow < > : \" | ? * in a name: \"{}\"", name.escape_debug()));
        }
        if !crate::trash_bin::says_itself(name) {
            return Err(format!("Windows cannot use the name \"{name}\" (it ends in a dot or space, or is a device's name)"));
        }
    }
    Ok(name)
}

/// The entry `rel` itself: its folder resolved, its own name not followed. It need not exist.
fn locate(root: &str, rel: &str) -> Result<PathBuf, String> {
    let (dir, name) = split_entry(rel)?;
    // On Windows a colon names a stream: `.git::$INDEX_ALLOCATION` is .git itself.
    #[cfg(windows)]
    if rel.contains(':') {
        return Err(format!("\"{rel}\" is not a file or folder inside the project"));
    }
    let (project, parent) = resolve(root, dir)?;
    if !parent.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    let below = parent.strip_prefix(&project).unwrap_or(&parent);
    if below.components().any(|c| is_repo_data(&c.as_os_str().to_string_lossy())) {
        return Err(repo_data_error(rel));
    }
    Ok(parent.join(name))
}

/// [`locate`], for an entry that is there.
fn existing(root: &str, rel: &str) -> Result<(PathBuf, fs::Metadata), String> {
    let at = locate(root, rel)?;
    let meta = fs::symlink_metadata(&at).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{rel} no longer exists"),
        _ => format!("Could not read {rel}: {e}"),
    })?;
    // Windows also answers to short names (`GIT~1`): ask the entry what it is called.
    if !meta.file_type().is_symlink() {
        let real = at.canonicalize().ok();
        if real.as_deref().and_then(Path::file_name).is_some_and(|n| is_repo_data(&n.to_string_lossy())) {
            return Err(repo_data_error(rel));
        }
    }
    Ok((at, meta))
}

fn beside(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn failed(what: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => format!("Could not {what}: access was denied (read-only, or in use by another program)"),
        _ => format!("Could not {what}: {e}"),
    }
}

pub(crate) fn create_dir(root: &str, dir: &str) -> Result<(), String> {
    new_name(split_entry(dir)?.1)?;
    let at = locate(root, dir)?;
    fs::create_dir(&at).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{dir} already exists"),
        _ => failed(&format!("create {dir}"), &e),
    })
}

pub(crate) fn rename(root: &str, path: &str, name: &str) -> Result<(), String> {
    new_name(name)?;
    let (from, _) = existing(root, path)?;
    let to = from.with_file_name(name);
    if from.file_name() == to.file_name() {
        return Ok(());
    }
    let shown = beside(split_entry(path)?.0, name);
    move_no_replace(&from, &to).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{shown} already exists"),
        _ => failed(&format!("rename {path}"), &e),
    })
}

/// A rename that fails when the new name is taken. A change of case alone works.
#[cfg(windows)]
fn move_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};

    let wide = |p: &Path| p.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>();
    let (wide_from, wide_to) = (wide(from), wide(to));
    // `fs::rename` replaces; MoveFileEx without flags refuses.
    // SAFETY: both strings end in NUL and live through the call.
    unsafe { MoveFileExW(PCWSTR(wide_from.as_ptr()), PCWSTR(wide_to.as_ptr()), MOVE_FILE_FLAGS(0)) }.map_err(|_| {
        let e = std::io::Error::last_os_error();
        // A folder moved onto one that exists is refused as "access denied". The name is taken unless
        // it is the entry itself (a change of case alone).
        let taken = fs::symlink_metadata(to).is_ok() && to.canonicalize().ok() != from.canonicalize().ok();
        if e.kind() != std::io::ErrorKind::AlreadyExists && taken {
            std::io::ErrorKind::AlreadyExists.into()
        } else {
            e
        }
    })
}

/// A rename that fails when the new name is taken. A change of case alone works.
#[cfg(unix)]
fn move_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    if let Ok(there) = fs::symlink_metadata(to) {
        let here = fs::symlink_metadata(from)?;
        // Where case does not count, the new name finds the entry itself: the same inode, and no entry spelt so.
        let itself = (there.dev(), there.ino()) == (here.dev(), here.ino())
            && match (to.parent(), to.file_name()) {
                (Some(parent), Some(name)) => !fs::read_dir(parent)?.flatten().any(|e| e.file_name() == name),
                _ => false,
            };
        if !itself {
            return Err(std::io::ErrorKind::AlreadyExists.into());
        }
    }
    fs::rename(from, to)
}

/// A copy of a file next to it. A link is copied as the file it shows, which must be in the project.
pub(crate) fn duplicate(root: &str, file: &str, name: &str) -> Result<(), String> {
    new_name(name)?;
    let (from, _) = existing(root, file)?;
    let (_, source) = resolve(root, file)?;
    if !source.is_file() {
        return Err(format!("{file} is not a file"));
    }
    let copy = beside(split_entry(file)?.0, name);
    let what = format!("copy {file}");
    let mut input = fs::File::open(&source).map_err(|e| failed(&what, &e))?;
    let to = from.with_file_name(name);
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&to).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{copy} already exists"),
        _ => failed(&what, &e),
    })?;
    if let Err(e) = std::io::copy(&mut input, &mut out) {
        drop(out);
        // Ours, and only part of the file.
        let _ = fs::remove_file(&to);
        return Err(failed(&what, &e));
    }
    #[cfg(unix)]
    if let Ok(meta) = input.metadata() {
        // An executable's copy stays one.
        let _ = out.set_permissions(meta.permissions());
    }
    Ok(())
}

/// Delete an entry: into the trash, or for good when `permanent`. `is_dir` is what the user was
/// asked about (links followed, as the tree shows it): something else by that name now is left alone.
pub(crate) fn delete(
    root: &str,
    path: &str,
    is_dir: bool,
    permanent: bool,
    trash: impl Fn(&Path) -> Result<Trashed, String>,
) -> Result<FsDeleted, String> {
    let (at, meta) = existing(root, path)?;
    if fs::metadata(&at).is_ok_and(|m| m.is_dir()) != is_dir {
        return Err(format!("{path} has changed since you were asked. Refresh and try again."));
    }
    if permanent {
        let removed = if meta.file_type().is_symlink() {
            // A link to a folder is removed as a folder on Windows, as a file elsewhere.
            fs::remove_file(&at).or_else(|e| fs::remove_dir(&at).map_err(|_| e))
        } else if meta.is_dir() {
            fs::remove_dir_all(&at)
        } else {
            fs::remove_file(&at)
        };
        removed.map_err(|e| failed(&format!("delete all of {path}"), &e))?;
        return Ok(FsDeleted::done());
    }
    match trash(&at).map_err(|e| format!("Could not delete {path}. {e}"))? {
        Trashed::Unavailable(reason) => Ok(FsDeleted { deleted: false, reason: Some(reason) }),
        Trashed::Done if fs::symlink_metadata(&at).is_ok() => Err(format!("{path} is still there after moving it to the trash")),
        Trashed::Done => Ok(FsDeleted::done()),
    }
}

/// Show an entry in the system's file manager ("" is the project folder). Nothing is ever opened with its own program.
fn reveal(root: &str, path: &str) -> Result<(), String> {
    let (at, is_project) = if path.is_empty() { (resolve(root, "")?.1, true) } else { (existing(root, path)?.0, false) };
    let mut cmd = file_manager(&at, is_project)?;
    crate::bin::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not open the file manager: {e}"))?;
    // Explorer's exit code says nothing; waiting only reaps it.
    std::thread::spawn(move || child.wait());
    Ok(())
}

#[cfg(windows)]
fn file_manager(at: &Path, is_project: bool) -> Result<std::process::Command, String> {
    use std::os::windows::process::CommandExt;

    let shown = crate::trash_bin::shell_path(at).map_err(|_| "Explorer cannot show a name like this.".to_string())?;
    // Given a longer path Explorer opens Documents instead.
    if shown.encode_utf16().count() >= 260 {
        return Err("This path is too long for Explorer. Use Copy path instead.".into());
    }
    let mut cmd = std::process::Command::new("explorer");
    if is_project {
        cmd.arg(shown);
    } else {
        // Explorer reads its own command line: the quotes go around the path alone. Names cannot hold quotes.
        cmd.raw_arg(format!("/select,\"{shown}\""));
    }
    Ok(cmd)
}

#[cfg(target_os = "macos")]
fn file_manager(at: &Path, is_project: bool) -> Result<std::process::Command, String> {
    let mut cmd = std::process::Command::new("open");
    // `-R` shows the entry; without it `open` would launch it.
    if !is_project {
        cmd.arg("-R");
    }
    cmd.arg(at);
    Ok(cmd)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn file_manager(at: &Path, is_project: bool) -> Result<std::process::Command, String> {
    // xdg-open launches what it is given: only ever give it a folder.
    let folder = if is_project { at } else { at.parent().unwrap_or(at) };
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(folder);
    Ok(cmd)
}

/// The same inside an environment (`env://…`): constant scripts, the paths as arguments.
/// There is no trash there, so deleting is only ever for good, and only when that was said.
mod remote {
    use super::{any_new_name, beside, split_entry, FsDeleted};
    use crate::files::remote::{prelude, remote_rel, MISSING, NOT_DIR, NOT_FILE, OUTSIDE, READ_ONLY};
    use crate::git::{EnvAt, Output, LOCAL_TIMEOUT, SLOW_TIMEOUT};

    const EXISTS: i32 = 15;
    const CHANGED: i32 = 16;
    const REPO_DATA: i32 = 17;
    const CAP: usize = 4096;

    /// After the prelude (`$1`, the folder, is resolved in `$t`): `$p` is the entry `$2` in it, itself.
    macro_rules! entry {
        () => {
            r#"[ -d "$t" ] || exit 12
p=${t%/}/$2
case "/${p#"$root"}/" in */.git/*|*/.plastic/*) exit 17 ;; esac
"#
        };
    }

    pub(super) const MKDIR: &str = concat!(
        prelude!(),
        entry!(),
        r#"if [ -e "$p" ] || [ -L "$p" ]; then exit 15; fi
[ -w "$t" ] || exit 14
mkdir -- "$p" || exit 1
"#
    );

    /// `$3`: the new name. `-T`: a folder by that name is never moved into; `-n`: never replaced.
    pub(super) const RENAME: &str = concat!(
        prelude!(),
        entry!(),
        r#"[ -e "$p" ] || [ -L "$p" ] || exit 10
to=${t%/}/$3
[ "$p" = "$to" ] && exit 0
if [ -e "$to" ] || [ -L "$to" ]; then exit 15; fi
[ -w "$t" ] || exit 14
mv -n -T -- "$p" "$to" || exit 1
if [ -e "$p" ] || [ -L "$p" ]; then exit 15; fi
exit 0
"#
    );

    /// `$3`: the copy's name.
    pub(super) const DUPLICATE: &str = concat!(
        prelude!(),
        entry!(),
        r#"[ -e "$p" ] || exit 10
s=$(readlink -f "$p" 2>/dev/null) || exit 10
case $root in /) ;; *) case $s in "$root"/*) ;; *) exit 11 ;; esac ;; esac
[ -f "$s" ] || exit 13
to=${t%/}/$3
if [ -e "$to" ] || [ -L "$to" ]; then exit 15; fi
[ -w "$t" ] || exit 14
[ -r "$s" ] || exit 1
set -C
: > "$to" || exit 1
set +C
cat < "$s" > "$to" || { rm -f -- "$to"; exit 1; }
if [ -x "$s" ]; then chmod +x "$to"; fi
exit 0
"#
    );

    /// `$3`: `d` or `f`, what the user was asked about. No trailing slash, so a link goes itself.
    pub(super) const REMOVE: &str = concat!(
        prelude!(),
        entry!(),
        r#"[ -e "$p" ] || [ -L "$p" ] || exit 10
kind=f
[ -d "$p" ] && kind=d
[ "$kind" = "$3" ] || exit 16
[ -w "$t" ] || exit 14
if [ -L "$p" ] || [ "$kind" = f ]; then rm -f -- "$p" || exit 1; else rm -rf -- "$p" || exit 1; fi
exit 0
"#
    );

    fn split(path: &str) -> Result<(String, String), String> {
        remote_rel(path)?;
        let (dir, name) = split_entry(path)?;
        Ok((dir.to_string(), name.to_string()))
    }

    /// Run a script and put a refusal in the local commands' words. `new` is the path being made.
    fn act(env: &EnvAt, script: &str, path: &str, args: &[&str], verb: &str, new: &str) -> Result<(), String> {
        let timeout = if verb == "delete" { SLOW_TIMEOUT } else { LOCAL_TIMEOUT };
        let mut argv: Vec<String> = ["sh", "-c", script, "sh"].map(String::from).to_vec();
        argv.extend(args.iter().map(|a| a.to_string()));
        let out: Output = env.run_plain(&[], &argv, None, CAP, timeout)?;
        if out.ok() {
            return Ok(());
        }
        Err(match out.code {
            Some(MISSING) => format!("{path} no longer exists"),
            Some(OUTSIDE) => format!("{path} links to a place outside the project"),
            Some(NOT_DIR) => format!("The folder of {path} is not a folder"),
            Some(NOT_FILE) => format!("{path} is not a file"),
            Some(READ_ONLY) => format!("Could not {verb} {path}: its folder is read-only"),
            Some(EXISTS) => format!("{new} already exists"),
            Some(CHANGED) => format!("{path} has changed since you were asked. Refresh and try again."),
            Some(REPO_DATA) => super::repo_data_error(path),
            _ => out.error(&format!("Could not {verb} {path}")),
        })
    }

    pub(super) fn create_dir(env: &EnvAt, path: &str) -> Result<(), String> {
        let (dir, name) = split(path)?;
        any_new_name(&name)?;
        act(env, MKDIR, path, &[&dir, &name], "create", path)
    }

    pub(super) fn rename(env: &EnvAt, path: &str, to: &str) -> Result<(), String> {
        let (dir, name) = split(path)?;
        any_new_name(to)?;
        act(env, RENAME, path, &[&dir, &name, to], "rename", &beside(&dir, to))
    }

    pub(super) fn duplicate(env: &EnvAt, path: &str, to: &str) -> Result<(), String> {
        let (dir, name) = split(path)?;
        any_new_name(to)?;
        act(env, DUPLICATE, path, &[&dir, &name, to], "copy", &beside(&dir, to))
    }

    pub(super) fn delete(env: &EnvAt, path: &str, is_dir: bool, permanent: bool) -> Result<FsDeleted, String> {
        let (dir, name) = split(path)?;
        if !permanent {
            return Ok(FsDeleted { deleted: false, reason: Some("Remote environments have no trash.".into()) });
        }
        act(env, REMOVE, path, &[&dir, &name, if is_dir { "d" } else { "f" }], "delete", path)?;
        Ok(FsDeleted::done())
    }
}

#[tauri::command]
pub async fn fs_create_dir(app: AppHandle, root: String, dir: String) -> Result<(), String> {
    let d = dir.clone();
    on_root(app, root, move |r| create_dir(r, &dir), move |e| remote::create_dir(e, &d)).await
}

#[tauri::command]
pub async fn fs_rename(app: AppHandle, root: String, path: String, name: String) -> Result<(), String> {
    let (p, n) = (path.clone(), name.clone());
    on_root(app, root, move |r| rename(r, &path, &name), move |e| remote::rename(e, &p, &n)).await
}

#[tauri::command]
pub async fn fs_duplicate(app: AppHandle, root: String, file: String, name: String) -> Result<(), String> {
    let (f, n) = (file.clone(), name.clone());
    on_root(app, root, move |r| duplicate(r, &file, &name), move |e| remote::duplicate(e, &f, &n)).await
}

#[tauri::command]
pub async fn fs_delete(app: AppHandle, root: String, path: String, is_dir: bool, permanent: bool) -> Result<FsDeleted, String> {
    let p = path.clone();
    on_root(
        app,
        root,
        move |r| delete(r, &path, is_dir, permanent, move_to_trash),
        move |e| remote::delete(e, &p, is_dir, permanent),
    )
    .await
}

#[tauri::command]
pub async fn fs_reveal(root: String, path: String) -> Result<(), String> {
    blocking(move || {
        if crate::envs::parse_env_path(&root).is_some() {
            return Err("A remote project's files are not on this computer.".into());
        }
        reveal(&root, &path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project with a file, a folder and a repository, next to a folder that is not part of it.
    fn project() -> (PathBuf, PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("mango-file-ops-{}", uuid::Uuid::new_v4()));
        let root = dir.join("proj");
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join(".git/refs")).unwrap();
        fs::create_dir_all(dir.join("outside")).unwrap();
        fs::write(root.join("src/main.rs"), "main").unwrap();
        fs::write(root.join("src/other.rs"), "other").unwrap();
        fs::write(root.join("src/deep/x"), "x").unwrap();
        fs::write(root.join(".git/HEAD"), "ref").unwrap();
        fs::write(dir.join("outside/keep"), "keep").unwrap();
        let r = root.to_string_lossy().into_owned();
        (dir, root, r)
    }

    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) {
        // mklink reads a forward slash as a switch: rebuild the paths with backslashes.
        let (link, target): (PathBuf, PathBuf) = (link.components().collect(), target.components().collect());
        let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&target).output().unwrap();
        assert!(out.status.success());
    }
    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn no_trash(_: &Path) -> Result<Trashed, String> {
        Ok(Trashed::Unavailable("No trash here.".into()))
    }
    /// For what must be refused before any trash is reached.
    fn never(_: &Path) -> Result<Trashed, String> {
        panic!("reached the trash")
    }

    #[test]
    fn creates_folders_and_replaces_nothing() {
        let (dir, root, r) = project();
        create_dir(&r, "src/new").unwrap();
        assert!(root.join("src/new").is_dir());
        assert!(create_dir(&r, "src/new").unwrap_err().contains("already exists"));
        assert!(create_dir(&r, "src/main.rs").unwrap_err().contains("already exists"));
        assert!(create_dir(&r, "missing/new").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn renames_and_never_replaces() {
        let (dir, root, r) = project();
        assert!(rename(&r, "src/main.rs", "other.rs").unwrap_err().contains("already exists"));
        assert_eq!(fs::read_to_string(root.join("src/other.rs")).unwrap(), "other");
        assert_eq!(fs::read_to_string(root.join("src/main.rs")).unwrap(), "main");
        // An empty folder is what a plain rename would replace.
        fs::create_dir_all(root.join("empty")).unwrap();
        assert!(rename(&r, "src", "empty").unwrap_err().contains("already exists"));
        assert!(root.join("src/main.rs").exists());

        rename(&r, "src/main.rs", "lib.rs").unwrap();
        assert!(!root.join("src/main.rs").exists() && root.join("src/lib.rs").exists());
        rename(&r, "src", "source").unwrap();
        assert!(root.join("source/deep/x").exists());
        assert!(rename(&r, "src", "x").unwrap_err().contains("no longer exists"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn renames_by_case_alone() {
        let (dir, root, r) = project();
        rename(&r, "src/main.rs", "Main.rs").unwrap();
        let names: Vec<_> = fs::read_dir(root.join("src")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"Main.rs".to_string()) && !names.contains(&"main.rs".to_string()), "{names:?}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicates_files_only_and_replaces_nothing() {
        let (dir, root, r) = project();
        duplicate(&r, "src/main.rs", "main copy.rs").unwrap();
        assert_eq!(fs::read_to_string(root.join("src/main copy.rs")).unwrap(), "main");
        assert!(duplicate(&r, "src/main.rs", "other.rs").unwrap_err().contains("already exists"));
        assert_eq!(fs::read_to_string(root.join("src/other.rs")).unwrap(), "other");
        assert!(duplicate(&r, "src/deep", "deep copy").unwrap_err().contains("not a file"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_the_project_itself_and_paths_out_of_it() {
        let (dir, root, r) = project();
        for bad in ["", ".", "./", "src/..", "..", "../outside", "src/", "src//main.rs", "/etc", "src\\main.rs", "src/.", "./src", "C:"] {
            assert!(delete(&r, bad, true, true, never).is_err(), "{bad:?}");
            assert!(rename(&r, bad, "x").is_err(), "{bad:?}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "x\ny"] {
            assert!(rename(&r, "src/main.rs", bad).is_err(), "{bad:?}");
        }
        assert!(root.join("src/main.rs").exists() && dir.join("outside/keep").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn leaves_the_repository_alone() {
        let (dir, root, r) = project();
        for bad in [".git", ".GIT", ".git/HEAD", ".git.", "src/.git", ".plastic/x", ".git::$INDEX_ALLOCATION"] {
            assert!(delete(&r, bad, true, true, never).is_err(), "{bad:?}");
            assert!(delete(&r, bad, false, true, never).is_err(), "{bad:?}");
        }
        assert!(create_dir(&r, "src/.git").is_err());
        assert!(rename(&r, "src", ".git").is_err());
        // Not by a link into it either.
        link_dir(&root.join(".git"), &root.join("alias"));
        assert!(delete(&r, "alias/HEAD", false, true, never).is_err());
        assert!(root.join(".git/HEAD").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deleting_a_link_leaves_what_it_points_at() {
        let (dir, root, r) = project();
        let outside = dir.join("outside");
        link_dir(&outside, &root.join("link"));
        assert!(delete(&r, "link/keep", false, true, never).unwrap_err().contains("outside"));
        assert!(rename(&r, "link/keep", "gone").is_err());
        delete(&r, "link", true, true, never).unwrap();
        assert!(fs::symlink_metadata(root.join("link")).is_err());

        // Nor through one inside a folder that goes.
        link_dir(&outside, &root.join("src/link"));
        delete(&r, "src", true, true, never).unwrap();
        assert!(!root.join("src").exists());
        assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "keep");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nothing_is_deleted_for_good_unless_asked() {
        let (dir, root, r) = project();
        let got = delete(&r, "src", true, false, no_trash).unwrap();
        assert_eq!(got, FsDeleted { deleted: false, reason: Some("No trash here.".into()) });
        assert!(root.join("src/main.rs").exists());
        assert!(delete(&r, "src", true, false, |_| Err("in use".into())).is_err());
        assert!(delete(&r, "src", true, false, |_| Ok(Trashed::Done)).unwrap_err().contains("still there"));
        assert!(root.join("src/main.rs").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deletes_only_the_kind_that_was_confirmed() {
        let (dir, root, r) = project();
        assert!(delete(&r, "src", false, true, never).unwrap_err().contains("has changed"));
        assert!(delete(&r, "src/main.rs", true, true, never).unwrap_err().contains("has changed"));
        assert!(root.join("src/main.rs").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deletes_read_only_files_for_good_when_asked() {
        let (dir, root, r) = project();
        let file = root.join("src/deep/x");
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file, perms).unwrap();
        delete(&r, "src", true, true, never).unwrap();
        assert!(!root.join("src").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn refuses_names_windows_reads_as_others() {
        let (dir, _, r) = project();
        for bad in ["notes.", "notes ", "CON", "nul.txt", "a:b", "a*", "what?"] {
            assert!(create_dir(&r, bad).is_err(), "{bad:?}");
            assert!(rename(&r, "src/main.rs", bad).is_err(), "{bad:?}");
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_name_ending_in_a_dot_never_takes_its_neighbour() {
        let (dir, root, r) = project();
        let exact = root.canonicalize().unwrap().join("notes.");
        fs::write(&exact, "dotted").unwrap();
        fs::write(root.join("notes"), "plain").unwrap();
        // The real trash: it refuses before touching the bin.
        let got = delete(&r, "notes.", false, false, move_to_trash).unwrap();
        assert!(!got.deleted && exact.exists() && root.join("notes").exists());
        delete(&r, "notes.", false, true, never).unwrap();
        assert!(!exact.exists());
        assert_eq!(fs::read_to_string(root.join("notes")).unwrap(), "plain");
        fs::remove_dir_all(fs::canonicalize(&dir).unwrap()).ok();
    }

    /// Puts a file in this computer's real trash: `cargo test --lib real_trash -- --ignored`.
    #[test]
    #[ignore]
    fn real_trash() {
        let (dir, root, r) = project();
        assert!(delete(&r, "src/other.rs", false, false, move_to_trash).unwrap().deleted);
        assert!(!root.join("src/other.rs").exists() && root.join("src/main.rs").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    mod remote_scripts {
        use super::*;
        use std::process::{Command, Stdio};

        fn sh(root: &Path, script: &str, args: &[&str]) -> Option<i32> {
            Command::new("sh")
                .current_dir(root)
                .args(["-c", script, "sh"])
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .code()
        }

        #[test]
        fn create_rename_and_copy_like_a_local_project() {
            let (dir, root, _) = project();
            assert_eq!(sh(&root, remote::MKDIR, &["src", "new"]), Some(0));
            assert_eq!(sh(&root, remote::MKDIR, &["src", "new"]), Some(15));
            assert_eq!(sh(&root, remote::RENAME, &["src", "main.rs", "other.rs"]), Some(15));
            assert_eq!(sh(&root, remote::RENAME, &["src", "main.rs", "new"]), Some(15), "never moved into a folder");
            assert_eq!(fs::read_to_string(root.join("src/other.rs")).unwrap(), "other");
            assert_eq!(sh(&root, remote::RENAME, &["src", "main.rs", "-n"]), Some(0));
            assert_eq!(sh(&root, remote::DUPLICATE, &["src", "-n", "copy"]), Some(0));
            assert_eq!(fs::read_to_string(root.join("src/copy")).unwrap(), "main");
            assert_eq!(sh(&root, remote::DUPLICATE, &["src", "copy", "other.rs"]), Some(15));
            assert_eq!(sh(&root, remote::DUPLICATE, &["src", "deep", "deep2"]), Some(13));
            fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn delete_like_a_local_project() {
            let (dir, root, _) = project();
            let outside = dir.join("outside");
            link_dir(&outside, &root.join("link"));
            link_dir(&outside, &root.join("src/link"));
            link_dir(&root.join(".git"), &root.join("alias"));
            assert_eq!(sh(&root, remote::REMOVE, &["link", "keep", "f"]), Some(11));
            assert_eq!(sh(&root, remote::REMOVE, &["", ".git", "d"]), Some(17));
            assert_eq!(sh(&root, remote::REMOVE, &["alias", "HEAD", "f"]), Some(17));
            assert_eq!(sh(&root, remote::REMOVE, &["", "src", "f"]), Some(16));
            assert_eq!(sh(&root, remote::REMOVE, &["", "link", "d"]), Some(0));
            assert_eq!(sh(&root, remote::REMOVE, &["", "src", "d"]), Some(0));
            assert!(!root.join("src").exists() && root.join(".git/HEAD").exists());
            assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "keep");
            fs::remove_dir_all(&dir).ok();
        }
    }
}
