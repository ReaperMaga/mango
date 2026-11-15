//! The Files view: list a project's folders, read a file into the editor and
//! write it back. Every path is relative to the project and must stay inside
//! it, symlinks included, so the webview can never reach the rest of the disk.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::git::{self, blocking, clean_rel, existing_dir, Vcs};

/// Larger files are not opened in the editor.
const MAX_OPEN: u64 = 5 * 1024 * 1024;
/// A folder with more entries than this is listed only up to here.
const MAX_ENTRIES: usize = 5000;
/// How much of a file is looked at to decide whether it is binary.
const SNIFF: usize = 8000;
const BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    /// Relative to the project, forward slashes.
    pub path: String,
    pub is_dir: bool,
    /// Matched by the repository's ignore rules (only known for git).
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    pub entries: Vec<FsEntry>,
    /// The folder has more than [`MAX_ENTRIES`] entries; the rest are left out.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// The file as text; None when it is binary or too large to open.
    pub text: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    pub size: u64,
    /// The file started with a UTF-8 byte order mark (not part of `text`).
    pub bom: bool,
    /// Last modification, ms since the epoch: hand it back on save.
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    /// False when the file changed on disk since it was read; nothing was written.
    pub saved: bool,
    pub modified_ms: u64,
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// The project folder (canonical) and `rel` inside it (canonical, existing).
/// Refuses anything that leaves the project, through `..` or a symlink.
fn resolve(root: &str, rel: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = existing_dir(root)?
        .canonicalize()
        .map_err(|e| format!("Could not open the project folder: {e}"))?;
    if rel.is_empty() {
        return Ok((root.clone(), root));
    }
    let rel = clean_rel(rel).map_err(|_| format!("\"{rel}\" is not a path inside the project"))?;
    let target = root.join(rel).canonicalize().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{rel} no longer exists"),
        _ => format!("Could not open {rel}: {e}"),
    })?;
    if !target.starts_with(&root) {
        return Err(format!("{rel} links to a place outside the project"));
    }
    Ok((root, target))
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{name}", dir.trim_end_matches('/'))
    }
}

/// Folders first, then by name, ignoring case.
fn sort_entries(entries: &mut [FsEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

pub(crate) fn list_dir(root: &str, dir: &str) -> Result<FsListing, String> {
    let (_, target) = resolve(root, dir)?;
    if !target.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    let read = fs::read_dir(&target).map_err(|e| format!("Could not list {}: {e}", target.display()))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        // The repository's own database is not project content.
        if name == ".git" {
            continue;
        }
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        // Follow symlinks for the kind; a broken link shows as a file.
        let is_dir = fs::metadata(item.path()).map(|m| m.is_dir()).unwrap_or(false);
        entries.push(FsEntry { path: join_rel(dir, &name), name, is_dir, ignored: false });
    }
    sort_entries(&mut entries);

    // Git runs in the folder as given: on Windows the canonical form is a
    // `\\?\` path, which git does not accept as a working directory.
    let project = existing_dir(root)?;
    if matches!(crate::vcs::detect_on_disk(&project), Some((Vcs::Git, _))) {
        let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
        let ignored = git::ignored_paths(&project, &paths);
        for e in &mut entries {
            e.ignored = ignored.iter().any(|p| p.trim_end_matches('/') == e.path);
        }
    }
    Ok(FsListing { entries, truncated })
}

pub(crate) fn read_file(root: &str, file: &str) -> Result<FileContent, String> {
    let (_, target) = resolve(root, file)?;
    let meta = fs::metadata(&target).map_err(|e| format!("Could not read {file}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{file} is not a file"));
    }
    let size = meta.len();
    let modified_ms = modified_ms(&meta);
    if size > MAX_OPEN {
        return Ok(FileContent { text: None, binary: false, too_large: true, size, bom: false, modified_ms });
    }
    let bytes = fs::read(&target).map_err(|e| format!("Could not read {file}: {e}"))?;
    let bom = bytes.starts_with(BOM);
    let body = if bom { &bytes[BOM.len()..] } else { &bytes[..] };
    let text = if body[..body.len().min(SNIFF)].contains(&0) {
        None
    } else {
        String::from_utf8(body.to_vec()).ok()
    };
    Ok(FileContent { binary: text.is_none(), text, too_large: false, size, bom, modified_ms })
}

/// Write `text` over an existing file. With `expected_modified_ms`, refuse
/// (`saved: false`) when the file changed on disk since it was read: an
/// agent may have edited it in the meantime.
pub(crate) fn write_file(
    root: &str,
    file: &str,
    text: &str,
    bom: bool,
    expected_modified_ms: Option<u64>,
) -> Result<WriteResult, String> {
    let (_, target) = resolve(root, file)?;
    let meta = fs::metadata(&target).map_err(|e| format!("Could not save {file}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{file} is not a file"));
    }
    if meta.permissions().readonly() {
        return Err(format!("{file} is read-only"));
    }
    if let Some(expected) = expected_modified_ms {
        let now = modified_ms(&meta);
        if now != expected {
            return Ok(WriteResult { saved: false, modified_ms: now });
        }
    }
    let mut bytes = Vec::with_capacity(text.len() + BOM.len());
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    fs::write(&target, bytes).map_err(|e| format!("Could not save {file}: {e}"))?;
    let after = fs::metadata(&target).map(|m| modified_ms(&m)).unwrap_or(0);
    Ok(WriteResult { saved: true, modified_ms: after })
}

#[tauri::command]
pub async fn fs_list_dir(root: String, dir: String) -> Result<FsListing, String> {
    blocking(move || list_dir(&root, &dir)).await
}

#[tauri::command]
pub async fn fs_read_file(root: String, file: String) -> Result<FileContent, String> {
    blocking(move || read_file(&root, &file)).await
}

#[tauri::command]
pub async fn fs_write_file(
    root: String,
    file: String,
    text: String,
    bom: bool,
    expected_modified_ms: Option<u64>,
) -> Result<WriteResult, String> {
    blocking(move || write_file(&root, &file, &text, bom, expected_modified_ms)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn path_of(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mango-files-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_folders_first_and_hides_git() {
        let dir = scratch();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        fs::write(dir.join("A.txt"), "a").unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}").unwrap();
        let root = path_of(&dir);

        let top = list_dir(&root, "").unwrap();
        let names: Vec<_> = top.entries.iter().map(|e| (e.name.as_str(), e.is_dir)).collect();
        assert_eq!(names, [("src", true), ("A.txt", false), ("b.txt", false)]);
        assert!(!top.truncated);

        let src = list_dir(&root, "src").unwrap();
        assert_eq!(src.entries[0].path, "src/main.rs");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_paths_outside_the_project() {
        let dir = scratch();
        fs::create_dir_all(dir.join("inner")).unwrap();
        fs::write(dir.join("secret.txt"), "x").unwrap();
        let root = path_of(&dir.join("inner"));
        assert!(read_file(&root, "../secret.txt").is_err());
        assert!(list_dir(&root, "..").is_err());
        assert!(read_file(&root, &path_of(&dir.join("secret.txt"))).is_err());
        assert!(write_file(&root, "../secret.txt", "y", false, None).is_err());
        assert_eq!(fs::read_to_string(dir.join("secret.txt")).unwrap(), "x");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_text_binary_and_bom() {
        let dir = scratch();
        fs::write(dir.join("t.txt"), "hello\r\nworld").unwrap();
        fs::write(dir.join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        fs::write(dir.join("bom.txt"), b"\xEF\xBB\xBFhi").unwrap();
        let root = path_of(&dir);

        let t = read_file(&root, "t.txt").unwrap();
        assert_eq!(t.text.as_deref(), Some("hello\r\nworld"));
        assert!(!t.binary && !t.bom);

        let b = read_file(&root, "b.bin").unwrap();
        assert!(b.binary && b.text.is_none());

        let bom = read_file(&root, "bom.txt").unwrap();
        assert_eq!(bom.text.as_deref(), Some("hi"));
        assert!(bom.bom);
        write_file(&root, "bom.txt", "hey", true, Some(bom.modified_ms)).unwrap();
        assert_eq!(fs::read(dir.join("bom.txt")).unwrap(), b"\xEF\xBB\xBFhey");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_stale_write() {
        let dir = scratch();
        fs::write(dir.join("f.txt"), "one").unwrap();
        let root = path_of(&dir);
        let read = read_file(&root, "f.txt").unwrap();

        let saved = write_file(&root, "f.txt", "two", false, Some(read.modified_ms)).unwrap();
        assert!(saved.saved);
        assert_eq!(fs::read_to_string(dir.join("f.txt")).unwrap(), "two");

        // Someone else wrote in between: the old timestamp no longer matches.
        let stale = write_file(&root, "f.txt", "three", false, Some(saved.modified_ms.wrapping_sub(5000))).unwrap();
        assert!(!stale.saved);
        assert_eq!(fs::read_to_string(dir.join("f.txt")).unwrap(), "two");

        // Writing never creates files.
        assert!(write_file(&root, "new.txt", "x", false, None).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn marks_ignored_entries_in_a_git_repo() {
        let dir = scratch();
        let ok = std::process::Command::new("git").current_dir(&dir).args(["init", "-q"]).status();
        if !matches!(ok, Ok(s) if s.success()) {
            return; // no git on this machine
        }
        fs::write(dir.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::create_dir_all(dir.join("target")).unwrap();
        fs::write(dir.join("app.log"), "").unwrap();
        fs::write(dir.join("main.rs"), "").unwrap();
        let listing = list_dir(&path_of(&dir), "").unwrap();
        let ignored: Vec<_> = listing.entries.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
        assert_eq!(ignored, ["target", "app.log"]);
        fs::remove_dir_all(&dir).ok();
    }
}
