//! The Files view: list a project's folders, read a file into the editor (or
//! an image into the image viewer) and write it back. Every path is relative to the project and must stay inside
//! it, symlinks included, so the webview can never reach the rest of the disk.
//! A remote project (`env://…`) gets the same operations and answers, run inside its
//! instance (see `remote` below).

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::AppHandle;

use crate::git::{self, blocking, clean_rel, existing_dir, EnvAt, Vcs};

/// Larger files are not opened in the editor.
const MAX_OPEN: u64 = 5 * 1024 * 1024;
/// Larger images are not shown in the image viewer.
const MAX_IMAGE: u64 = 25 * 1024 * 1024;
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
pub struct FileBytes {
    /// The whole file, base64.
    pub data: String,
    pub size: u64,
    /// Last modification, ms since the epoch.
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    /// False when the file changed on disk since it was read; nothing was written.
    pub saved: bool,
    pub modified_ms: u64,
}

pub(crate) fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// The project folder (canonical) and `rel` inside it (canonical, existing).
/// Refuses anything that leaves the project, through `..` or a symlink.
pub(crate) fn resolve(root: &str, rel: &str) -> Result<(PathBuf, PathBuf), String> {
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
    Ok(content(bytes, size, modified_ms))
}

/// The raw bytes of a file, for the image viewer. Refuses files over [`MAX_IMAGE`].
pub(crate) fn read_bytes(root: &str, file: &str) -> Result<FileBytes, String> {
    use base64::Engine as _;
    let (_, target) = resolve(root, file)?;
    let meta = fs::metadata(&target).map_err(|e| format!("Could not read {file}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{file} is not a file"));
    }
    let size = meta.len();
    if size > MAX_IMAGE {
        return Err(too_large_image(file, size));
    }
    let bytes = fs::read(&target).map_err(|e| format!("Could not read {file}: {e}"))?;
    Ok(FileBytes {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size,
        modified_ms: modified_ms(&meta),
    })
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
    fs::write(&target, with_bom(text, bom)).map_err(|e| format!("Could not save {file}: {e}"))?;
    let after = fs::metadata(&target).map(|m| modified_ms(&m)).unwrap_or(0);
    Ok(WriteResult { saved: true, modified_ms: after })
}

/// One file or folder name: not empty, not `.` or `..`, no separators, NUL or line breaks.
pub(crate) fn plain_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0', '\n', '\r']) {
        return Err(format!("\"{}\" is not a file name", name.escape_debug()));
    }
    Ok(name)
}

/// A project-relative file path split into its folder ("" for the project itself) and its
/// plain file name. Refuses absolute paths, `..` and a last part that is not a name.
fn split_rel(rel: &str) -> Result<(&str, &str), String> {
    let bad = || format!("\"{rel}\" is not a path inside the project");
    clean_rel(rel).map_err(|_| bad())?;
    let name = rel.rsplit(['/', '\\']).next().unwrap_or_default();
    plain_name(name).map_err(|_| bad())?;
    let dir = rel[..rel.len() - name.len()].trim_end_matches(['/', '\\']);
    Ok((dir, name))
}

/// Create a new file with `text`. Never replaces anything: an existing file, folder or
/// symlink (even a dangling one) at that name is an error. The folder must be inside the project.
pub(crate) fn create_file(root: &str, file: &str, text: &str) -> Result<WriteResult, String> {
    use std::io::Write as _;
    let (dir, name) = split_rel(file)?;
    let (_, parent) = resolve(root, dir)?;
    if !parent.is_dir() {
        return Err(format!("{dir} is not a folder"));
    }
    let target = parent.join(name);
    // `create_new` is O_EXCL: it does not follow a symlink at the final name.
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{file} already exists"),
        std::io::ErrorKind::PermissionDenied => format!("Could not create {file}: the folder is read-only"),
        _ => format!("Could not create {file}: {e}"),
    })?;
    out.write_all(text.as_bytes()).map_err(|e| format!("Could not write {file}: {e}"))?;
    drop(out);
    let after = fs::metadata(&target).map(|m| modified_ms(&m)).unwrap_or(0);
    Ok(WriteResult { saved: true, modified_ms: after })
}

/// Delete one file. A symlink is removed itself (never what it points at); folders are refused.
pub(crate) fn delete_file(root: &str, file: &str) -> Result<(), String> {
    let (dir, name) = split_rel(file)?;
    let (_, parent) = resolve(root, dir)?;
    let target = parent.join(name);
    let meta = fs::symlink_metadata(&target).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{file} no longer exists"),
        _ => format!("Could not delete {file}: {e}"),
    })?;
    if meta.is_dir() || fs::metadata(&target).is_ok_and(|m| m.is_dir()) {
        return Err(format!("{file} is a folder; only files can be deleted here"));
    }
    fs::remove_file(&target).map_err(|e| format!("Could not delete {file}: {e}"))
}

// ---------------------------------------------------------------------------
// Remote projects
// ---------------------------------------------------------------------------

/// Remote projects (`env://…`): the same four operations, each one fixed `sh` script run
/// as the agent user inside the instance over one SSH connection (`git::EnvAt::run`).
/// The scripts are constant text; the path and limits arrive only as positional
/// arguments, and file contents only on stdin. Paths are checked here first
/// ([`remote_rel`]) and confined again inside the instance, where the script resolves
/// symlinks (`readlink -f`) and refuses anything outside the project folder's real path.
pub(crate) mod remote {
    use super::*;
    use crate::git::{EnvAt, Output, LOCAL_TIMEOUT};

    /// Printed before anything else, so whatever a login profile prints is skipped.
    const MARK: &[u8] = b"\0mango-fs\0";
    /// Room for the header line in front of a file's bytes.
    const HEADER: usize = 256;
    /// A folder listing: at most [`MAX_ENTRIES`] names of at most 255 bytes, plus the ignored ones.
    const LIST_CAP: usize = 8 * 1024 * 1024;

    // Exit codes the scripts use for the refusals a person should read.
    pub(crate) const MISSING: i32 = 10;
    pub(crate) const OUTSIDE: i32 = 11;
    pub(crate) const NOT_DIR: i32 = 12;
    pub(crate) const NOT_FILE: i32 = 13;
    pub(crate) const READ_ONLY: i32 = 14;
    const EXISTS: i32 = 15;
    const IS_DIR: i32 = 16;

    /// Shared start of every script: `$1` is the path relative to the project (the working
    /// folder), already checked by [`remote_rel`]. Leaves the resolved path in `$t` and defines
    /// `mtime` (ms since the epoch into `$m`, whole seconds where `date` has no `%N`).
    macro_rules! prelude {
        () => {
            r#"printf '\000mango-fs\000'
root=$(pwd -P) || exit 1
rel=$1
t=$root
if [ -n "$rel" ]; then t=$(readlink -f "$root/$rel" 2>/dev/null) || exit 10; fi
[ -n "$t" ] && [ -e "$t" ] || exit 10
case $root in /) ;; *) case $t in "$root"|"$root"/*) ;; *) exit 11 ;; esac ;; esac
mtime() {
  # Whole nanoseconds, cut to milliseconds here: uutils' date drops the zeros `%3N` should keep.
  m=$(date -r "$1" +%s.%N 2>/dev/null)
  mtime_s=${m%%.*} mtime_n=${m#*.}
  mtime_n=${mtime_n%"${mtime_n#???}"}
  case $mtime_s in ''|*[!0-9]*) m= ;; *) case $mtime_n in [0-9][0-9][0-9]) m=$mtime_s$mtime_n ;; *) m= ;; esac ;; esac
  [ -n "$m" ] || m=$(stat -c %Y "$1")000
}
"#
        };
    }
    pub(crate) use prelude;

    /// `$2`: how many entries at most. Prints `d<name>\0` / `f<name>\0` per entry (symlinks
    /// followed for the kind), `t\0` when cut off, then `i\0` and the names git ignores.
    pub(super) const LIST: &str = concat!(
        prelude!(),
        r#"[ -d "$t" ] || exit 12
max=$2
n=0
set --
for e in "$t"/* "$t"/.[!.]* "$t"/..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  name=${e##*/}
  [ "$name" = .git ] && continue
  if [ "$n" -ge "$max" ]; then printf 't\000'; break; fi
  n=$((n + 1))
  if [ -d "$e" ]; then printf 'd%s\000' "$name"; else printf 'f%s\000' "$name"; fi
  set -- "$@" "${rel:+$rel/}$name"
done
printf 'i\000'
if [ "$#" -gt 0 ] && command -v git >/dev/null 2>&1; then
  for p in "$@"; do printf '%s\000' "$p"; done | GIT_OPTIONAL_LOCKS=0 git check-ignore -z --stdin 2>/dev/null
fi
exit 0
"#
    );

    /// `$2`: the size limit. Prints `<size> <mtime>\n`, then the file unless it is larger.
    pub(super) const READ: &str = concat!(
        prelude!(),
        r#"[ -f "$t" ] || exit 13
size=$(stat -c %s "$t") || exit 1
mtime "$t"
printf '%s %s\n' "$size" "$m"
[ "$size" -gt "$2" ] && exit 0
exec cat "$t"
"#
    );

    /// `$2`: the modification time the file must still have (empty: any). Writes stdin over
    /// the file and prints `saved <mtime>`, or leaves it alone and prints `stale <mtime>`.
    pub(super) const WRITE: &str = concat!(
        prelude!(),
        r#"[ -f "$t" ] || exit 13
[ -w "$t" ] || exit 14
mtime "$t"
if [ -n "$2" ] && [ "$2" != "$m" ]; then printf 'stale %s\n' "$m"; exit 0; fi
cat > "$t" || exit 1
mtime "$t"
printf 'saved %s\n' "$m"
"#
    );

    /// `$1` is the folder, `$2` the new file's name. Creates it from stdin (never over anything
    /// that exists, a dangling symlink included: `set -C`) and prints `saved <mtime>`.
    pub(super) const CREATE: &str = concat!(
        prelude!(),
        r#"[ -d "$t" ] || exit 12
p=$t/$2
if [ -e "$p" ] || [ -L "$p" ]; then exit 15; fi
[ -w "$t" ] || exit 14
set -C
cat > "$p" || exit 1
mtime "$p"
printf 'saved %s\n' "$m"
"#
    );

    /// `$1` is the folder, `$2` the file's name. Deletes the file (a symlink itself, not
    /// what it points at); refuses folders.
    pub(super) const DELETE: &str = concat!(
        prelude!(),
        r#"[ -d "$t" ] || exit 12
p=$t/$2
[ -e "$p" ] || [ -L "$p" ] || exit 10
[ -d "$p" ] && exit 16
rm -f -- "$p" || exit 1
printf 'deleted\n'
"#
    );

    /// A path relative to the project, safe to hand to the scripts: "" for the project
    /// itself, otherwise no absolute path, no `..`, no NUL and no line breaks.
    pub(crate) fn remote_rel(rel: &str) -> Result<String, String> {
        let trimmed = rel.trim_end_matches('/');
        if trimmed.is_empty() && rel.is_empty() {
            return Ok(String::new());
        }
        let bad = || format!("\"{rel}\" is not a path inside the project");
        if trimmed.is_empty() || trimmed.contains(['\n', '\r']) || trimmed.split('/').any(|s| s == "..") {
            return Err(bad());
        }
        clean_rel(trimmed).map_err(|_| bad())?;
        Ok(trimmed.to_string())
    }

    pub(crate) fn run(env: &EnvAt, script: &str, args: &[&str], stdin: Option<Vec<u8>>, cap: usize) -> Result<Output, String> {
        let mut argv: Vec<String> = ["sh", "-c", script, "sh"].map(String::from).to_vec();
        argv.extend(args.iter().map(|a| a.to_string()));
        env.run_plain(&[], &argv, stdin, cap, LOCAL_TIMEOUT)
    }

    /// The script's own output, after [`MARK`].
    pub(crate) fn body(stdout: &[u8]) -> Option<&[u8]> {
        let at = stdout.windows(MARK.len()).position(|w| w == MARK)?;
        Some(&stdout[at + MARK.len()..])
    }

    /// A refusal or failure, in the same words as for a local project.
    fn failure(out: &Output, rel: &str, verb: &str) -> String {
        let shown = if rel.is_empty() { "The project folder" } else { rel };
        match out.code {
            Some(MISSING) => format!("{shown} no longer exists"),
            Some(OUTSIDE) => format!("{shown} links to a place outside the project"),
            Some(NOT_DIR) => format!("{shown} is not a folder"),
            Some(NOT_FILE) => format!("{shown} is not a file"),
            Some(READ_ONLY) => format!("{shown} is read-only"),
            _ => out.error(&format!("Could not {verb} {shown}")),
        }
    }

    fn unexpected(rel: &str) -> String {
        format!("Could not read {rel}: the environment gave an answer Mango does not understand")
    }

    /// `<size> <mtime>\n` and what follows it.
    pub(super) fn header(body: &[u8]) -> Option<(u64, u64, &[u8])> {
        let nl = body.iter().position(|b| *b == b'\n')?;
        let line = std::str::from_utf8(&body[..nl]).ok()?;
        let (size, mtime) = line.split_once(' ')?;
        Some((size.parse().ok()?, mtime.parse().ok()?, &body[nl + 1..]))
    }

    /// Parse [`LIST`]'s records into the same listing a local folder gives.
    pub(super) fn parse_listing(body: &[u8], dir: &str) -> FsListing {
        let mut entries = Vec::new();
        let mut truncated = false;
        let mut ignored: Vec<String> = Vec::new();
        let mut in_ignored = false;
        for rec in body.split(|b| *b == 0) {
            if rec.is_empty() {
                continue;
            }
            if in_ignored {
                ignored.push(git::lossy(rec));
                continue;
            }
            match rec[0] {
                b'i' if rec.len() == 1 => in_ignored = true,
                b't' if rec.len() == 1 => truncated = true,
                b'd' | b'f' if rec.len() > 1 => {
                    let name = git::lossy(&rec[1..]);
                    entries.push(FsEntry { path: join_rel(dir, &name), name, is_dir: rec[0] == b'd', ignored: false });
                }
                _ => {}
            }
        }
        for e in &mut entries {
            e.ignored = ignored.iter().any(|p| p.trim_end_matches('/') == e.path);
        }
        sort_entries(&mut entries);
        FsListing { entries, truncated }
    }

    pub(super) fn list_dir(env: &EnvAt, dir: &str) -> Result<FsListing, String> {
        let rel = remote_rel(dir)?;
        let max = MAX_ENTRIES.to_string();
        let out = run(env, LIST, &[&rel, &max], None, LIST_CAP)?;
        if !out.ok() || out.truncated {
            return Err(failure(&out, &rel, "list"));
        }
        let body = body(&out.stdout).ok_or_else(|| unexpected(&rel))?;
        Ok(parse_listing(body, &rel))
    }

    /// The header and bytes of a file no larger than `limit` (bytes are empty when it is larger).
    fn read_raw(env: &EnvAt, rel: &str, limit: u64) -> Result<(u64, u64, Vec<u8>, bool), String> {
        let cap = limit as usize + HEADER;
        let out = run(env, READ, &[rel, &limit.to_string()], None, cap)?;
        if !out.ok() && !out.truncated {
            return Err(failure(&out, rel, "read"));
        }
        let body = body(&out.stdout).ok_or_else(|| unexpected(rel))?;
        let (size, mtime, bytes) = header(body).ok_or_else(|| unexpected(rel))?;
        // The file grew past the limit while it was read.
        let too_large = size > limit || out.truncated || bytes.len() as u64 > limit;
        if !too_large && bytes.len() as u64 != size {
            return Err(format!("Could not read {rel}: it changed while it was read. Try again."));
        }
        Ok((size.max(bytes.len() as u64), mtime, if too_large { Vec::new() } else { bytes.to_vec() }, too_large))
    }

    pub(super) fn read_file(env: &EnvAt, file: &str) -> Result<FileContent, String> {
        let rel = remote_rel(file)?;
        if rel.is_empty() {
            return Err("The project folder is not a file".into());
        }
        let (size, modified_ms, bytes, too_large) = read_raw(env, &rel, MAX_OPEN)?;
        if too_large {
            return Ok(FileContent { text: None, binary: false, too_large: true, size, bom: false, modified_ms });
        }
        Ok(content(bytes, size, modified_ms))
    }

    pub(super) fn read_bytes(env: &EnvAt, file: &str) -> Result<FileBytes, String> {
        use base64::Engine as _;
        let rel = remote_rel(file)?;
        if rel.is_empty() {
            return Err("The project folder is not a file".into());
        }
        let (size, modified_ms, bytes, too_large) = read_raw(env, &rel, MAX_IMAGE)?;
        if too_large {
            return Err(too_large_image(&rel, size));
        }
        Ok(FileBytes { data: base64::engine::general_purpose::STANDARD.encode(&bytes), size, modified_ms })
    }

    /// `saved <mtime>` or `stale <mtime>`.
    pub(super) fn parse_write(body: &[u8]) -> Option<WriteResult> {
        let text = std::str::from_utf8(body).ok()?.trim_end();
        let (word, mtime) = text.split_once(' ')?;
        let modified_ms = mtime.parse().ok()?;
        match word {
            "saved" => Some(WriteResult { saved: true, modified_ms }),
            "stale" => Some(WriteResult { saved: false, modified_ms }),
            _ => None,
        }
    }

    pub(super) fn write_file(
        env: &EnvAt,
        file: &str,
        text: &str,
        bom: bool,
        expected_modified_ms: Option<u64>,
    ) -> Result<WriteResult, String> {
        let rel = remote_rel(file)?;
        if rel.is_empty() {
            return Err("The project folder is not a file".into());
        }
        let expected = expected_modified_ms.map(|m| m.to_string()).unwrap_or_default();
        let out = run(env, WRITE, &[&rel, &expected], Some(with_bom(text, bom)), HEADER)?;
        if !out.ok() {
            return Err(failure(&out, &rel, "save"));
        }
        body(&out.stdout)
            .and_then(parse_write)
            .ok_or_else(|| format!("Saved {rel}, but the environment's answer was not understood. Reopen the file to check it."))
    }

    /// A checked project-relative file path, split into its folder ("" for the project) and name.
    fn split_remote(file: &str) -> Result<(String, String, String), String> {
        // `remote_rel` forgives a trailing slash (a folder); a file has none.
        if file.ends_with('/') {
            return Err(format!("\"{file}\" is not a path inside the project"));
        }
        let rel = remote_rel(file)?;
        let (dir, name) = split_rel(&rel)?;
        Ok((dir.to_string(), name.to_string(), rel.clone()))
    }

    /// Why the folder part of `rel` was refused, or `None` for a code about the file itself.
    fn folder_failure(out: &Output, dir: &str) -> Option<String> {
        let shown = if dir.is_empty() { "The project folder" } else { dir };
        match out.code {
            Some(MISSING) => Some(format!("{shown} no longer exists")),
            Some(OUTSIDE) => Some(format!("{shown} links to a place outside the project")),
            Some(NOT_DIR) => Some(format!("{shown} is not a folder")),
            _ => None,
        }
    }

    pub(super) fn create_file(env: &EnvAt, file: &str, text: &str) -> Result<WriteResult, String> {
        let (dir, name, rel) = split_remote(file)?;
        let out = run(env, CREATE, &[&dir, &name], Some(text.as_bytes().to_vec()), HEADER)?;
        if !out.ok() {
            let shown = if dir.is_empty() { "The project folder" } else { &dir };
            return Err(match out.code {
                Some(EXISTS) => format!("{rel} already exists"),
                Some(READ_ONLY) => format!("{shown} is read-only"),
                _ => folder_failure(&out, &dir).unwrap_or_else(|| out.error(&format!("Could not create {rel}"))),
            });
        }
        body(&out.stdout)
            .and_then(parse_write)
            .ok_or_else(|| format!("Created {rel}, but the environment's answer was not understood. Reopen the file to check it."))
    }

    pub(super) fn delete_file(env: &EnvAt, file: &str) -> Result<(), String> {
        let (dir, name, rel) = split_remote(file)?;
        let out = run(env, DELETE, &[&dir, &name], None, HEADER)?;
        if out.ok() {
            return Ok(());
        }
        Err(match out.code {
            Some(IS_DIR) => format!("{rel} is a folder; only files can be deleted here"),
            Some(MISSING) => format!("{rel} no longer exists"),
            _ => folder_failure(&out, &dir).unwrap_or_else(|| out.error(&format!("Could not delete {rel}"))),
        })
    }
}

/// The text (and BOM flag) of a file read whole, or binary when it has NUL bytes or is not UTF-8.
fn content(bytes: Vec<u8>, size: u64, modified_ms: u64) -> FileContent {
    let bom = bytes.starts_with(BOM);
    let body = if bom { &bytes[BOM.len()..] } else { &bytes[..] };
    let text = if body[..body.len().min(SNIFF)].contains(&0) {
        None
    } else {
        String::from_utf8(body.to_vec()).ok()
    };
    FileContent { binary: text.is_none(), text, too_large: false, size, bom, modified_ms }
}

fn too_large_image(file: &str, size: u64) -> String {
    format!("{file} is {} MB; images up to {} MB are shown here", size / (1024 * 1024), MAX_IMAGE / (1024 * 1024))
}

fn with_bom(text: &str, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + BOM.len());
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

/// Run `local` for a folder on this computer, `env` for a remote project, off the UI thread.
pub(crate) async fn on_root<T, L, E>(app: AppHandle, root: String, local: L, env: E) -> Result<T, String>
where
    T: Send + 'static,
    L: FnOnce(&str) -> Result<T, String> + Send + 'static,
    E: FnOnce(&EnvAt) -> Result<T, String> + Send + 'static,
{
    blocking(move || match crate::vcs::env_at(&app, &root) {
        Some(at) => env(&at?),
        None => local(&root),
    })
    .await
}

#[tauri::command]
pub async fn fs_list_dir(app: AppHandle, root: String, dir: String) -> Result<FsListing, String> {
    let d = dir.clone();
    on_root(app, root, move |r| list_dir(r, &dir), move |e| remote::list_dir(e, &d)).await
}

#[tauri::command]
pub async fn fs_read_file(app: AppHandle, root: String, file: String) -> Result<FileContent, String> {
    let f = file.clone();
    on_root(app, root, move |r| read_file(r, &file), move |e| remote::read_file(e, &f)).await
}

#[tauri::command]
pub async fn fs_read_bytes(app: AppHandle, root: String, file: String) -> Result<FileBytes, String> {
    let f = file.clone();
    on_root(app, root, move |r| read_bytes(r, &file), move |e| remote::read_bytes(e, &f)).await
}

#[tauri::command]
pub async fn fs_write_file(
    app: AppHandle,
    root: String,
    file: String,
    text: String,
    bom: bool,
    expected_modified_ms: Option<u64>,
) -> Result<WriteResult, String> {
    let (f, t) = (file.clone(), text.clone());
    on_root(
        app,
        root,
        move |r| write_file(r, &file, &text, bom, expected_modified_ms),
        move |e| remote::write_file(e, &f, &t, bom, expected_modified_ms),
    )
    .await
}

#[tauri::command]
pub async fn fs_create_file(app: AppHandle, root: String, file: String, text: String) -> Result<WriteResult, String> {
    let (f, t) = (file.clone(), text.clone());
    on_root(app, root, move |r| create_file(r, &file, &text), move |e| remote::create_file(e, &f, &t)).await
}

#[tauri::command]
pub async fn fs_delete_file(app: AppHandle, root: String, file: String) -> Result<(), String> {
    let f = file.clone();
    on_root(app, root, move |r| delete_file(r, &file), move |e| remote::delete_file(e, &f)).await
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
    fn reads_bytes_inside_the_project_only() {
        use base64::Engine as _;
        let dir = scratch();
        let png = [0x89u8, b'P', b'N', b'G', 0, 1, 2, 255];
        fs::write(dir.join("logo.png"), png).unwrap();
        let root = path_of(&dir);
        let got = read_bytes(&root, "logo.png").unwrap();
        assert_eq!(got.size, png.len() as u64);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(got.data).unwrap(), png);
        assert!(read_bytes(&root, "../logo.png").is_err());
        assert!(read_bytes(&root, "missing.png").is_err());
        assert!(read_bytes(&root, "").is_err());
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

    #[test]
    fn creates_new_files_only() {
        let dir = scratch();
        let root = dir.join("proj");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join(".env"), "OLD=1").unwrap();
        fs::write(dir.join("outside"), "x").unwrap();
        let r = path_of(&root);

        let made = create_file(&r, ".env.local", "A=1\n").unwrap();
        assert!(made.saved && made.modified_ms > 0);
        assert_eq!(fs::read_to_string(root.join(".env.local")).unwrap(), "A=1\n");
        create_file(&r, "sub/x.env", "").unwrap();
        assert!(root.join("sub/x.env").is_file());

        // Never over an existing file or folder.
        let err = create_file(&r, ".env", "NEW=1").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(root.join(".env")).unwrap(), "OLD=1");
        assert!(create_file(&r, "sub", "").is_err());

        for bad in ["", "../outside", "../new", "/tmp/x", "sub/../../x", "sub/", ".", "..", "sub/..", "missing/x"] {
            assert!(create_file(&r, bad, "x").is_err(), "{bad:?}");
        }
        assert!(!dir.join("new").exists());
        assert_eq!(fs::read_to_string(dir.join("outside")).unwrap(), "x");

        #[cfg(unix)]
        {
            // Through a linked folder out of the project, or onto a (dangling) link.
            std::os::unix::fs::symlink(&dir, root.join("up")).unwrap();
            assert!(create_file(&r, "up/new", "x").is_err());
            std::os::unix::fs::symlink(dir.join("planted"), root.join("trap.env")).unwrap();
            assert!(create_file(&r, "trap.env", "x").is_err());
            assert!(!dir.join("new").exists() && !dir.join("planted").exists());
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deletes_files_but_not_folders() {
        let dir = scratch();
        let root = dir.join("proj");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join(".env"), "").unwrap();
        fs::write(root.join("sub/x.env"), "").unwrap();
        fs::write(dir.join("outside"), "x").unwrap();
        let r = path_of(&root);

        delete_file(&r, ".env").unwrap();
        assert!(!root.join(".env").exists());
        delete_file(&r, "sub/x.env").unwrap();
        assert!(!root.join("sub/x.env").exists());
        assert!(delete_file(&r, ".env").unwrap_err().contains("no longer exists"));

        let err = delete_file(&r, "sub").unwrap_err();
        assert!(err.contains("folder"), "{err}");
        assert!(root.join("sub").is_dir());
        for bad in ["", "../outside", "/etc/hostname", "sub/..", ".", "sub/"] {
            assert!(delete_file(&r, bad).is_err(), "{bad:?}");
        }
        assert!(dir.join("outside").exists());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&dir, root.join("up")).unwrap();
            assert!(delete_file(&r, "up/outside").is_err());
            assert!(delete_file(&r, "up").is_err(), "a link to a folder is a folder");
            // A link to a file: the link goes, its target stays.
            std::os::unix::fs::symlink(dir.join("outside"), root.join("link.env")).unwrap();
            delete_file(&r, "link.env").unwrap();
            assert!(root.join("link.env").symlink_metadata().is_err());
            assert_eq!(fs::read_to_string(dir.join("outside")).unwrap(), "x");
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_names_have_no_path_in_them() {
        for ok in [".env", "prod.env", "a b.env", "..x"] {
            assert!(plain_name(ok).is_ok(), "{ok:?}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "a\0b", "a\nb", "a\rb"] {
            assert!(plain_name(bad).is_err(), "{bad:?}");
        }
    }

    // ----- remote projects -----

    #[test]
    fn remote_paths_are_checked_before_they_leave() {
        use remote::remote_rel;
        assert_eq!(remote_rel("").unwrap(), "");
        assert_eq!(remote_rel("src/").unwrap(), "src");
        assert_eq!(remote_rel("src/main.rs").unwrap(), "src/main.rs");
        assert_eq!(remote_rel("a b/it's [x].vue").unwrap(), "a b/it's [x].vue");
        for bad in ["/etc/passwd", "..", "../x", "a/../../x", "a/..", "a\0b", "a\nb", "a\rb", "/", "//"] {
            assert!(remote_rel(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn parses_remote_listings() {
        let mut out = b"profile noise\n".to_vec();
        out.extend_from_slice(b"\0mango-fs\0fb.txt\0dsrc\0fA.txt\0dtarget\0fa\nb\0t\0i\0src/target\0src/b.txt\0");
        let body = remote::body(&out).unwrap();
        let listing = remote::parse_listing(body, "src");
        let got: Vec<_> = listing.entries.iter().map(|e| (e.path.as_str(), e.is_dir, e.ignored)).collect();
        assert_eq!(
            got,
            [
                ("src/src", true, false),
                ("src/target", true, true),
                ("src/a\nb", false, false),
                ("src/A.txt", false, false),
                ("src/b.txt", false, true),
            ]
        );
        assert!(listing.truncated);
        assert!(remote::body(b"no marker").is_none());
    }

    #[test]
    fn parses_remote_headers_and_write_answers() {
        assert_eq!(remote::header(b"12 1700000000123\nhello"), Some((12, 1_700_000_000_123, &b"hello"[..])));
        assert_eq!(remote::header(b"12 x\n"), None);
        assert_eq!(remote::header(b"12 5"), None);
        let saved = remote::parse_write(b"saved 42\n").unwrap();
        assert!(saved.saved && saved.modified_ms == 42);
        let stale = remote::parse_write(b"stale 7\n").unwrap();
        assert!(!stale.saved && stale.modified_ms == 7);
        assert!(remote::parse_write(b"what 7\n").is_none());
    }

    /// The remote scripts, run by this computer's `sh` in a scratch project: what
    /// `EnvAt::run` does inside an instance, minus SSH.
    #[cfg(unix)]
    mod remote_scripts {
        use super::*;
        use std::io::Write as _;
        use std::process::{Command, Stdio};

        fn sh(root: &Path, script: &str, args: &[&str], stdin: &[u8]) -> (Option<i32>, Vec<u8>) {
            let mut child = Command::new("sh")
                .current_dir(root)
                .args(["-c", script, "sh"])
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(stdin).unwrap();
            let out = child.wait_with_output().unwrap();
            (out.status.code(), out.stdout)
        }

        fn project() -> (PathBuf, PathBuf) {
            let dir = scratch();
            let root = dir.join("proj");
            fs::create_dir_all(root.join("src/deep")).unwrap();
            fs::create_dir_all(root.join(".git")).unwrap();
            fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
            fs::write(root.join(".env"), "A=1\n").unwrap();
            fs::write(root.join("..dots"), "").unwrap();
            fs::write(root.join("we ird $(x) 'q'.txt"), "").unwrap();
            fs::write(dir.join("secret.txt"), "secret").unwrap();
            std::os::unix::fs::symlink(dir.join("secret.txt"), root.join("leak")).unwrap();
            std::os::unix::fs::symlink(&dir, root.join("up")).unwrap();
            std::os::unix::fs::symlink(root.join("src"), root.join("inside")).unwrap();
            std::os::unix::fs::symlink(root.join("nowhere"), root.join("broken")).unwrap();
            (dir, root)
        }

        #[test]
        fn lists_like_a_local_folder() {
            let (dir, root) = project();
            let (code, out) = sh(&root, remote::LIST, &["", "5000"], b"");
            assert_eq!(code, Some(0));
            let listing = remote::parse_listing(remote::body(&out).unwrap(), "");
            let mut local = list_dir(&path_of(&root), "").unwrap();
            local.entries.iter_mut().for_each(|e| e.ignored = false);
            assert_eq!(listing.entries, local.entries);
            assert!(listing.entries.iter().any(|e| e.name == "..dots"));
            assert!(listing.entries.iter().any(|e| e.name == "inside" && e.is_dir));
            assert!(listing.entries.iter().any(|e| e.name == "broken" && !e.is_dir));
            assert!(!listing.entries.iter().any(|e| e.name == ".git"));

            let (code, out) = sh(&root, remote::LIST, &["src", "5000"], b"");
            assert_eq!(code, Some(0));
            let names: Vec<_> = remote::parse_listing(remote::body(&out).unwrap(), "src").entries.into_iter().map(|e| e.path).collect();
            assert_eq!(names, ["src/deep", "src/main.rs"]);

            let (_, out) = sh(&root, remote::LIST, &["", "2"], b"");
            let cut = remote::parse_listing(remote::body(&out).unwrap(), "");
            assert!(cut.truncated && cut.entries.len() == 2);

            let (code, _) = sh(&root, remote::LIST, &["src/main.rs", "5000"], b"");
            assert_eq!(code, Some(12));
            fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn marks_ignored_entries() {
            let (dir, root) = project();
            fs::remove_dir_all(root.join(".git")).unwrap();
            let ok = Command::new("git").current_dir(&root).args(["init", "-q"]).status();
            if !matches!(ok, Ok(s) if s.success()) {
                return; // no git on this machine
            }
            fs::write(root.join(".gitignore"), "deep/\n*.rs\n").unwrap();
            let (_, out) = sh(&root, remote::LIST, &["src", "5000"], b"");
            let listing = remote::parse_listing(remote::body(&out).unwrap(), "src");
            let ignored: Vec<_> = listing.entries.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
            assert_eq!(ignored, ["deep", "main.rs"]);
            fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn never_leaves_the_project() {
            let (dir, root) = project();
            for (rel, want) in [("leak", 11), ("up", 11), ("up/secret.txt", 11), ("broken", 10), ("missing", 10), ("inside/main.rs", 0)] {
                let (code, out) = sh(&root, remote::READ, &[rel, "100"], b"");
                assert_eq!(code, Some(want), "{rel}");
                if want != 0 {
                    assert!(!String::from_utf8_lossy(&out).contains("secret"), "{rel}");
                }
            }
            let (code, _) = sh(&root, remote::LIST, &["up", "5000"], b"");
            assert_eq!(code, Some(11));
            let (code, _) = sh(&root, remote::WRITE, &["leak", ""], b"pwned");
            assert_eq!(code, Some(11));
            assert_eq!(fs::read_to_string(dir.join("secret.txt")).unwrap(), "secret");
            // The project reached through a symlink is still confined to its real folder.
            let alias = dir.join("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            let (code, _) = sh(&alias, remote::READ, &["leak", "100"], b"");
            assert_eq!(code, Some(11));
            let (code, _) = sh(&alias, remote::READ, &["src/main.rs", "100"], b"");
            assert_eq!(code, Some(0));
            fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn reads_and_writes_with_the_stale_check() {
            let (dir, root) = project();
            let (code, out) = sh(&root, remote::READ, &["src/main.rs", "100"], b"");
            assert_eq!(code, Some(0));
            let (size, mtime, bytes) = remote::header(remote::body(&out).unwrap()).unwrap();
            assert_eq!((size, bytes), (13, &b"fn main() {}\n"[..]));
            assert!(mtime > 1_000_000_000_000);

            // Over the limit: the header only.
            let (_, out) = sh(&root, remote::READ, &["src/main.rs", "5"], b"");
            let (size, _, bytes) = remote::header(remote::body(&out).unwrap()).unwrap();
            assert_eq!((size, bytes.len()), (13, 0));

            let (code, _) = sh(&root, remote::READ, &["src", "100"], b"");
            assert_eq!(code, Some(13));

            let stale = (mtime - 5000).to_string();
            let (code, out) = sh(&root, remote::WRITE, &["src/main.rs", &stale], b"nope");
            assert_eq!(code, Some(0));
            let res = remote::parse_write(remote::body(&out).unwrap()).unwrap();
            assert!(!res.saved && res.modified_ms == mtime);
            assert_eq!(fs::read_to_string(root.join("src/main.rs")).unwrap(), "fn main() {}\n");

            let text = with_bom("hey \u{e9}", true);
            let (code, out) = sh(&root, remote::WRITE, &["src/main.rs", &mtime.to_string()], &text);
            assert_eq!(code, Some(0));
            assert!(remote::parse_write(remote::body(&out).unwrap()).unwrap().saved);
            assert_eq!(fs::read(root.join("src/main.rs")).unwrap(), text);

            // Without an expected time it always writes; it never creates a file.
            let (code, _) = sh(&root, remote::WRITE, &["new.txt", ""], b"x");
            assert_eq!(code, Some(10));
            assert!(!root.join("new.txt").exists());

            let mut perms = fs::metadata(root.join(".env")).unwrap().permissions();
            perms.set_readonly(true);
            fs::set_permissions(root.join(".env"), perms).unwrap();
            let (code, _) = sh(&root, remote::WRITE, &[".env", ""], b"x");
            // root ignores the write bit; everyone else is refused.
            assert!(code == Some(14) || code == Some(0));
            fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn creates_and_deletes_like_a_local_project() {
            let (dir, root) = project();
            let (code, out) = sh(&root, remote::CREATE, &["", ".env.local"], b"A=1\n");
            assert_eq!(code, Some(0));
            let made = remote::parse_write(remote::body(&out).unwrap()).unwrap();
            assert!(made.saved && made.modified_ms > 1_000_000_000_000);
            assert_eq!(fs::read_to_string(root.join(".env.local")).unwrap(), "A=1\n");
            let (code, _) = sh(&root, remote::CREATE, &["src/deep", "x.env"], b"");
            assert_eq!(code, Some(0));
            assert!(root.join("src/deep/x.env").is_file());

            // Never over anything: a file, a folder, a dangling link.
            assert_eq!(sh(&root, remote::CREATE, &["", ".env"], b"NEW").0, Some(15));
            assert_eq!(fs::read_to_string(root.join(".env")).unwrap(), "A=1\n");
            assert_eq!(sh(&root, remote::CREATE, &["", "src"], b"").0, Some(15));
            assert_eq!(sh(&root, remote::CREATE, &["", "broken"], b"x").0, Some(15));
            assert!(!root.join("nowhere").exists());
            // Not through a link out of the project, nor into a file or missing folder.
            assert_eq!(sh(&root, remote::CREATE, &["up", "new"], b"x").0, Some(11));
            assert!(!dir.join("new").exists());
            assert_eq!(sh(&root, remote::CREATE, &[".env", "x"], b"").0, Some(12));
            assert_eq!(sh(&root, remote::CREATE, &["missing", "x"], b"").0, Some(10));

            assert_eq!(sh(&root, remote::DELETE, &["", ".env.local"], b"").0, Some(0));
            assert!(!root.join(".env.local").exists());
            assert_eq!(sh(&root, remote::DELETE, &["", ".env.local"], b"").0, Some(10));
            assert_eq!(sh(&root, remote::DELETE, &["", "src"], b"").0, Some(16));
            assert_eq!(sh(&root, remote::DELETE, &["", "inside"], b"").0, Some(16));
            assert_eq!(sh(&root, remote::DELETE, &["up", "secret.txt"], b"").0, Some(11));
            // A link goes, not what it points at.
            assert_eq!(sh(&root, remote::DELETE, &["", "leak"], b"").0, Some(0));
            assert!(root.join("leak").symlink_metadata().is_err());
            assert_eq!(fs::read_to_string(dir.join("secret.txt")).unwrap(), "secret");
            assert_eq!(sh(&root, remote::DELETE, &["", "broken"], b"").0, Some(0));
            fs::remove_dir_all(&dir).ok();
        }
    }

    /// Times the remote Changes and Files reads against a real joined environment, the way a
    /// poll does them: `MANGO_SSH_BENCH=user@host`, with `MANGO_SSH_BENCH_PORT`,
    /// `MANGO_SSH_BENCH_KEY` (the key; its pinned host key in `<key>.known_hosts`) and
    /// `MANGO_SSH_BENCH_DIR` (a git work tree there, with a changed file `a.txt`).
    /// `cargo test --lib remote_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn remote_timing() {
        use crate::envs::{EnvDirect, EnvHost};
        use crate::git::{At, EnvAt, LOCAL_TIMEOUT as LOCAL};
        use std::time::Instant;
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let host = EnvHost {
            id: "bench".into(),
            name: "Bench".into(),
            ssh: var("MANGO_SSH_BENCH"),
            port: std::env::var("MANGO_SSH_BENCH_PORT").ok().and_then(|p| p.parse().ok()),
            identity_file: Some(var("MANGO_SSH_BENCH_KEY")),
            incus_remote: None,
            tailscale: None,
            public_address: None,
            direct: Some(EnvDirect {
                instance: "bench".into(),
                host_key: String::new(),
                shared_from: String::new(),
                share_id: String::new(),
                expires_at: None,
            }),
        };
        let env = EnvAt { host, instance: "bench".into(), dir: var("MANGO_SSH_BENCH_DIR") };
        let at = At::Env(Box::new(env.clone()));
        let time = |what: &str, f: &dyn Fn() -> Result<(), String>| {
            let mut runs = Vec::new();
            for _ in 0..5 {
                let t = Instant::now();
                f().unwrap_or_else(|e| panic!("{what}: {e}"));
                runs.push(t.elapsed().as_millis());
            }
            println!("{what:<16} first {:>5} ms, then {:?} ms", runs[0], &runs[1..]);
        };
        time("ssh true", &|| env.run_plain(&[], &["true".into()], None, 1 << 20, LOCAL).map(|_| ()));
        time("git status", &|| git::status_of(&at).map(|s| assert!(s.is_repo)));
        time("git diff", &|| git::diff_of(&at, "a.txt", false).map(|d| assert!(!d.is_empty())));
        time("git log", &|| git::log(&at, 50).map(|_| ()));
        time("git branches", &|| git::branches(&at).map(|_| ()));
        time("files list", &|| remote::list_dir(&env, "").map(|_| ()));
    }
}
