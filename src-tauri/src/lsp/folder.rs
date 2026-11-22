//! Which folder a path names, to bind the user's consent to it: a folder deleted and made again at
//! the same path (another repository cloned there) is another folder, while what happens inside it,
//! a rename of its files or a restart of the computer leave it the same.

use std::io::Read;
use std::path::{Component, Path, PathBuf, Prefix};

/// None when there is no such folder on this computer.
pub fn id(path: &str) -> Option<String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return None;
    }
    identity(path)
}

/// Whether `root` is, now, a linked git worktree of the repository `project` is in, read without
/// running git. The folder's word alone is not enough, as anyone can write one: its `.git` file
/// names an entry of that repository, and that entry names the `.git` file back.
///
/// Unity VCS workspaces have nothing like the entry (what `.plastic` says is the folder's own claim,
/// and can come with a clone), so they never count: each is asked about for itself.
pub fn is_worktree_of(root: &str, project: &str) -> bool {
    linked(root, project).unwrap_or(false)
}

fn linked(root: &str, project: &str) -> Option<bool> {
    let (root, project) = (real(Path::new(root))?, real(Path::new(project))?);
    let entry = gitdir_of(&root)?;
    let back = entry.join(line(&entry.join("gitdir"))?);
    let entries = common_dir(&project)?.join("worktrees");
    // By which folders they are, not by how their paths are spelled.
    Some(back.file_name()? == ".git" && same(back.parent()?, &root) && same(entry.parent()?, &entries))
}

fn real(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    // Without `\\?\`, after which Windows takes `/` and `..` literally.
    super::resolve::plain(path.canonicalize().ok()?.to_str()?).map(PathBuf::from)
}

/// The folder `top`'s `.git` file names; None where `.git` is a folder or a link.
fn gitdir_of(top: &Path) -> Option<PathBuf> {
    let dot_git = top.join(".git");
    if !std::fs::symlink_metadata(&dot_git).ok()?.is_file() {
        return None;
    }
    let named = top.join(line(&dot_git)?.strip_prefix("gitdir: ")?);
    // Only looking must not sign this computer in to a server the file names (Windows).
    if !on_drive(&named) && on_drive(top) {
        return None;
    }
    real(&named)
}

fn on_drive(path: &Path) -> bool {
    match path.components().next() {
        Some(Component::Prefix(prefix)) => matches!(prefix.kind(), Prefix::Disk(_)),
        _ => true,
    }
}

/// What the worktrees of the repository `dir` is in share; `dir` may be a linked worktree itself.
fn common_dir(dir: &Path) -> Option<PathBuf> {
    let top = dir.ancestors().find(|at| at.join(".git").exists())?;
    let dot_git = top.join(".git");
    let git_dir = if dot_git.is_dir() { dot_git } else { gitdir_of(top)? };
    match line(&git_dir.join("commondir")) {
        Some(common) => real(&git_dir.join(common)),
        None => Some(git_dir),
    }
}

/// The one line of one of git's small files.
fn line(file: &Path) -> Option<String> {
    if !file.is_file() {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(file).ok()?.take(8192).read_to_string(&mut text).ok()?;
    let text = text.trim_end_matches(['\r', '\n']);
    (!text.is_empty() && !text.contains(['\n', '\0'])).then(|| text.to_string())
}

#[cfg(windows)]
fn same(a: &Path, b: &Path) -> bool {
    identity(a).is_some_and(|a| identity(b) == Some(a))
}

/// Right now the device tells apart what the inode alone can't (two mounts).
#[cfg(unix)]
fn same(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let at = |path: &Path| std::fs::metadata(path).ok().filter(|m| m.is_dir()).map(|m| (m.dev(), m.ino()));
    at(a).is_some_and(|a| at(b) == Some(a))
}

/// The volume, the file index and the creation time together: FAT can give a deleted folder's index
/// to a new one, and a folder made again at once can inherit the creation time (tunneling).
#[cfg(windows)]
fn identity(path: &Path) -> Option<String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS,
    };

    // No access is asked for, so nothing that uses the folder is in the way.
    let dir = std::fs::OpenOptions::new().access_mode(0).custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0).open(path).ok()?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for as long as `dir` lives, and `info` is ours to write.
    unsafe { GetFileInformationByHandle(HANDLE(dir.as_raw_handle()), &mut info) }.ok()?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
        return None;
    }
    let pair = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    Some(format!(
        "{:x}-{:x}-{:x}",
        info.dwVolumeSerialNumber,
        pair(info.nFileIndexHigh, info.nFileIndexLow),
        pair(info.ftCreationTime.dwHighDateTime, info.ftCreationTime.dwLowDateTime),
    ))
}

/// Not the device number, which can differ after a restart. An inode is given again once free, so
/// the time the folder was made goes with it, where the system keeps one.
#[cfg(unix)]
fn identity(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;

    let meta = std::fs::metadata(path).ok().filter(|m| m.is_dir())?;
    let made = meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    Some(format!("{:x}-{made:x}", meta.ino()))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;

    #[test]
    fn a_folder_made_again_at_the_same_path_is_another() {
        let scratch = Scratch::new("folder");
        let dir = scratch.dir("app");
        let path = dir.to_str().unwrap();
        let first = id(path).unwrap();

        // Normal work, a branch switch among it, changes nothing.
        scratch.write("app/src/a.ts", "a");
        scratch.write("app/.git/HEAD", "ref: refs/heads/other");
        std::fs::remove_dir_all(dir.join("src")).unwrap();
        assert_eq!(id(path).as_deref(), Some(first.as_str()));
        assert_eq!(id(dir.join("..").join("app").to_str().unwrap()).as_deref(), Some(first.as_str()), "spelled otherwise");

        // Deleted and made again soon after. (A moment apart: where an inode is given out again only
        // the time tells the two apart, and file systems keep it in ticks.)
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(id(path), None);
        std::fs::create_dir(&dir).unwrap();
        let second = id(path).unwrap();
        assert_ne!(second, first);

        // Moved away, and another put in its place.
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::rename(&dir, scratch.path().join("moved")).unwrap();
        std::fs::create_dir(&dir).unwrap();
        assert_ne!(id(path).unwrap(), second);
        assert_eq!(id(scratch.path().join("moved").to_str().unwrap()).as_deref(), Some(second.as_str()));
    }

    /// What `git worktree add` leaves in `repo` and at `tree` for a worktree called `name`.
    fn add_worktree(scratch: &Scratch, repo: &str, tree: &str, name: &str) {
        let top = scratch.path().to_str().unwrap().replace('\\', "/");
        scratch.write(&format!("{repo}/.git/worktrees/{name}/gitdir"), &format!("{top}/{tree}/.git\n"));
        scratch.write(&format!("{repo}/.git/worktrees/{name}/commondir"), "../..\n");
        scratch.write(&format!("{tree}/.git"), &format!("gitdir: {top}/{repo}/.git/worktrees/{name}\n"));
    }

    #[test]
    fn only_a_projects_own_worktree_follows_it() {
        let scratch = Scratch::new("worktree");
        let path = |rel: &str| scratch.dir(rel).to_str().unwrap().to_string();
        add_worktree(&scratch, "app", "app.worktrees/fix", "fix");
        add_worktree(&scratch, "app", "app.worktrees/other one", "other one");
        let (app, fix, other) = (path("app"), path("app.worktrees/fix"), path("app.worktrees/other one"));
        assert!(is_worktree_of(&fix, &app));
        assert!(is_worktree_of(&fix.replace('\\', "/"), &app.replace('\\', "/")), "spelled otherwise");
        #[cfg(windows)]
        assert!(is_worktree_of(&fix.to_uppercase(), &app.to_lowercase()), "case");
        assert!(is_worktree_of(&other, &fix), "the project is a linked worktree itself");
        assert!(is_worktree_of(&fix, &path("app/packages/web")), "the project is a folder in its repository");
        assert!(!is_worktree_of(&app, &fix), "the main working tree is no linked one");
        assert!(!is_worktree_of(&path("app.worktrees/fix/inner"), &app), "a folder inside one");

        // Relative paths, as `worktree.useRelativePaths` writes them.
        scratch.write("app/.git/worktrees/fix/gitdir", "../../../../app.worktrees/fix/.git\r\n");
        scratch.write("app.worktrees/fix/.git", "gitdir: ../../app/.git/worktrees/fix\n");
        assert!(is_worktree_of(&fix, &app));
        assert!(is_worktree_of(&other, &fix), "from a project linked that way");

        // Removed, then another repository cloned there, or only a folder.
        std::fs::remove_dir_all(&fix).unwrap();
        assert!(!is_worktree_of(&fix, &app), "gone");
        scratch.dir("app.worktrees/fix/.git");
        assert!(!is_worktree_of(&fix, &app), "a clone");
        std::fs::remove_dir_all(&fix).unwrap();
        scratch.dir("app.worktrees/fix");
        assert!(!is_worktree_of(&fix, &app), "no repository");

        // Another repository's worktree at that path, and a folder claiming another's entry.
        add_worktree(&scratch, "evil", "app.worktrees/fix", "fix");
        assert!(!is_worktree_of(&fix, &app), "another repository's worktree");
        scratch.write("claims/.git", "gitdir: ../app/.git/worktrees/other one\n");
        assert!(!is_worktree_of(&path("claims"), &app), "its own claim alone");
        #[cfg(windows)]
        {
            scratch.write("claims/.git", "gitdir: //192.0.2.1/share/x\n");
            let began = std::time::Instant::now();
            assert!(!is_worktree_of(&path("claims"), &app));
            assert!(began.elapsed() < std::time::Duration::from_secs(1), "no server is asked");
        }

        // A Unity VCS workspace where Mango puts them.
        scratch.write("game/.plastic/plastic.workspace", "game");
        scratch.write("game.worktrees/fix/.plastic/plastic.workspace", "game-fix");
        assert!(!is_worktree_of(&path("game.worktrees/fix"), &path("game")));
    }

    #[test]
    fn gits_own_worktrees_follow_their_project() {
        let scratch = Scratch::new("git-worktree");
        let app = scratch.dir("app");
        let git = |args: &[&str]| {
            let mut cmd = std::process::Command::new("git");
            crate::bin::hide_console(&mut cmd);
            cmd.current_dir(&app).args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]);
            cmd.args(["-c", "core.hooksPath=.no-hooks", "-c", "init.templateDir="]).args(args);
            let out = cmd.output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "first"]);
        git(&["worktree", "add", "-q", "-b", "fix", "../app.worktrees/fix"]);
        let fix = scratch.path().join("app.worktrees").join("fix");
        assert!(is_worktree_of(fix.to_str().unwrap(), app.to_str().unwrap()));
    }

    #[test]
    fn only_folders_on_this_computer() {
        let scratch = Scratch::new("no-folder");
        assert_eq!(id(scratch.write("file.txt", "x").to_str().unwrap()), None);
        for path in ["", ".", "relative", "env://host/dev/srv"] {
            assert_eq!(id(path), None, "{path}");
        }
    }
}
