//! Pictures in an agent's reply: markdown `![alt](path)` pointing at a file on this computer.
//! Agents save screenshots wherever suits them (a temp folder, the project), so the path is
//! not confined to a folder. Instead only real raster images are read: the file's own bytes
//! must say PNG, JPEG, GIF, WebP, AVIF or BMP, whatever its name. Anything else is refused,
//! so this command cannot be used to read other files. SVG is text and is not read here.
//!
//! In a remote project (`env://…`) the path is a file inside the environment (an agent there
//! saves its screenshots there). One fixed script reads it as the agent user over SSH
//! ([`remote`]); the path reaches it only as an argument, and the same byte check runs here.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::AppHandle;

use crate::git::blocking;

/// Larger pictures are not shown in a chat.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatImage {
    /// The whole file, base64.
    pub data: String,
    /// From the file's bytes, not its name.
    pub mime: String,
    pub size: u64,
    pub modified_ms: u64,
}

/// The image type the bytes start with; None for anything that is not a raster image.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let at = |i: usize, sig: &[u8]| bytes.get(i..i + sig.len()) == Some(sig);
    if at(0, b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if at(0, b"\xFF\xD8\xFF") {
        Some("image/jpeg")
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some("image/gif")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some("image/webp")
    } else if at(4, b"ftyp") && (at(8, b"avif") || at(8, b"avis")) {
        Some("image/avif")
    } else if at(0, b"BM") && bytes.len() >= 26 && bmp_size_matches(bytes) {
        // "BM" alone is too weak a mark; the header must also state the file's real length.
        Some("image/bmp")
    } else {
        None
    }
}

fn bmp_size_matches(bytes: &[u8]) -> bool {
    let stated = u32::from_le_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
    stated as usize == bytes.len()
}

/// `path` as given when absolute, else inside `base` (the chat's project folder).
fn locate(path: &str, base: Option<&str>) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("No picture path given".into());
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Ok(p.to_path_buf());
    }
    match base.map(Path::new) {
        Some(b) if b.is_absolute() => Ok(b.join(p)),
        _ => Err(format!("{path} is a relative path and the chat has no project folder to find it in")),
    }
}

fn too_large(path: &str, size: u64) -> String {
    format!(
        "{path} is {} MB; pictures up to {} MB are shown in a chat",
        size / (1024 * 1024),
        MAX_BYTES / (1024 * 1024)
    )
}

/// The picture in `bytes`, or why it is not one.
fn picture(path: &str, bytes: &[u8], modified_ms: u64) -> Result<ChatImage, String> {
    use base64::Engine as _;
    let mime = sniff(bytes).ok_or_else(|| format!("{path} is not a PNG, JPEG, GIF, WebP, AVIF or BMP picture"))?;
    Ok(ChatImage {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime: mime.into(),
        size: bytes.len() as u64,
        modified_ms,
    })
}

pub(crate) fn read_image(path: &str, base: Option<&str>) -> Result<ChatImage, String> {
    let target = locate(path, base)?;
    let meta = fs::metadata(&target).map_err(|e| format!("Could not read {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if meta.len() > MAX_BYTES {
        return Err(too_large(path, meta.len()));
    }
    let bytes = fs::read(&target).map_err(|e| format!("Could not read {path}: {e}"))?;
    let modified_ms =
        meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    picture(path, &bytes, modified_ms)
}

/// Pictures inside a remote project's environment.
pub(crate) mod remote {
    use super::*;
    use crate::files::remote::{body, header, run};
    use crate::git::EnvAt;

    const MISSING: i32 = 10;
    const NOT_FILE: i32 = 13;

    /// `$1`: the path, absolute or relative to the project (the working folder); `$2`: the size
    /// limit. Prints `<size> <mtime ms>\n`, then the file's bytes unless it is larger. Runs as
    /// the agent user, so it reads only what that user may read; [`picture`] decides what is shown.
    pub(crate) const READ: &str = r#"printf '\000mango-fs\000'
p=$1
[ -e "$p" ] || exit 10
[ -f "$p" ] || exit 13
size=$(stat -L -c %s -- "$p") || exit 1
m=$(stat -L -c %Y -- "$p") || exit 1
printf '%s %s000\n' "$size" "$m"
[ "$size" -gt "$2" ] && exit 0
exec cat -- "$p"
"#;

    /// A path the script can take as one argument.
    pub(crate) fn checked(path: &str) -> Result<&str, String> {
        if path.trim().is_empty() || path.contains(['\0', '\n', '\r']) {
            return Err("No picture path given".into());
        }
        Ok(path)
    }

    /// Turn the script's answer into the picture.
    pub(crate) fn parse(path: &str, code: Option<i32>, stdout: &[u8], truncated: bool) -> Result<ChatImage, String> {
        match code {
            Some(MISSING) => return Err(format!("Could not read {path}: it does not exist in the environment")),
            Some(NOT_FILE) => return Err(format!("{path} is not a file")),
            _ => {}
        }
        let unexpected = || format!("Could not read {path}: the environment gave an answer Mango does not understand");
        let (size, modified_ms, bytes) = body(stdout).and_then(header).ok_or_else(unexpected)?;
        if size > MAX_BYTES || truncated || bytes.len() as u64 > MAX_BYTES {
            return Err(too_large(path, size.max(bytes.len() as u64)));
        }
        if bytes.len() as u64 != size {
            return Err(format!("Could not read {path}: it changed while it was read. Try again."));
        }
        picture(path, bytes, modified_ms)
    }

    pub(crate) fn read_image(env: &EnvAt, path: &str) -> Result<ChatImage, String> {
        let path = checked(path)?;
        let out = run(env, READ, &[path, &MAX_BYTES.to_string()], None, MAX_BYTES as usize + 256)?;
        if !out.ok() && !out.truncated && !matches!(out.code, Some(MISSING | NOT_FILE)) {
            return Err(out.error(&format!("Could not read {path}")));
        }
        parse(path, out.code, &out.stdout, out.truncated)
    }
}

/// A picture an agent's reply points at. `base` (the chat's project folder) resolves relative
/// paths; null when there is none. For a remote project, the picture is read inside its environment.
#[tauri::command]
pub async fn chat_image(app: AppHandle, path: String, base: Option<String>) -> Result<ChatImage, String> {
    blocking(move || match base.as_deref().and_then(|b| crate::vcs::env_at(&app, b)) {
        Some(env) => remote::read_image(&env?, &path),
        None => read_image(&path, base.as_deref()),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mango-images-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn knows_images_by_their_bytes() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(b"\xFF\xD8\xFF\xE0\0\x10JFIF"), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a\x01\0"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x24\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0\0\0"), Some("image/avif"));
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff(b"-----BEGIN OPENSSH PRIVATE KEY-----"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn a_bmp_must_state_its_own_length() {
        let mut bmp = vec![0u8; 30];
        bmp[0] = b'B';
        bmp[1] = b'M';
        bmp[2..6].copy_from_slice(&30u32.to_le_bytes());
        assert_eq!(sniff(&bmp), Some("image/bmp"));
        let mut text = b"BM is how this note starts, and it is long enough".to_vec();
        assert_eq!(sniff(&text), None);
        text.truncate(10);
        assert_eq!(sniff(&text), None);
    }

    #[test]
    fn reads_absolute_and_project_relative_pictures() {
        let dir = scratch();
        fs::create_dir_all(dir.join("shots")).unwrap();
        fs::write(dir.join("shots/a.png"), PNG).unwrap();
        let abs = dir.join("shots/a.png").to_string_lossy().into_owned();
        let base = dir.to_string_lossy().into_owned();

        let img = read_image(&abs, None).unwrap();
        assert_eq!(img.mime, "image/png");
        assert_eq!(img.size, PNG.len() as u64);
        assert_eq!(read_image("shots/a.png", Some(&base)).unwrap().data, img.data);
        assert!(read_image("shots/a.png", None).unwrap_err().contains("relative path"));
        fs::remove_dir_all(dir).ok();
    }

    /// The remote script, run by this computer's `sh` in a scratch project: what `EnvAt::run`
    /// does inside an instance, minus SSH.
    #[cfg(unix)]
    fn remote_read(root: &Path, path: &str) -> Result<ChatImage, String> {
        let path = remote::checked(path)?;
        let out = std::process::Command::new("sh")
            .current_dir(root)
            .args(["-c", remote::READ, "sh", path, &MAX_BYTES.to_string()])
            .output()
            .unwrap();
        remote::parse(path, out.status.code(), &out.stdout, false)
    }

    #[cfg(unix)]
    #[test]
    fn reads_pictures_inside_an_environment() {
        let dir = scratch();
        let root = dir.join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.join("shot.png"), PNG).unwrap();
        fs::write(root.join("local.png"), PNG).unwrap();
        fs::write(root.join("key.png"), "-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        let abs = dir.join("shot.png").to_string_lossy().into_owned();

        let img = remote_read(&root, &abs).unwrap();
        assert_eq!((img.mime.as_str(), img.size), ("image/png", PNG.len() as u64));
        assert!(img.modified_ms > 0);
        assert_eq!(remote_read(&root, "local.png").unwrap().data, img.data);
        assert!(remote_read(&root, "key.png").unwrap_err().contains("is not a PNG"));
        assert!(remote_read(&root, "nope.png").unwrap_err().contains("does not exist"));
        assert!(remote_read(&root, ".").unwrap_err().contains("is not a file"));
        // Odd names stay one argument: nothing runs, nothing is read.
        assert!(remote_read(&root, "$(touch pwned).png").unwrap_err().contains("does not exist"));
        assert!(!root.join("pwned").exists());
        assert!(remote_read(&root, "a\nb.png").is_err());
        assert!(remote_read(&root, "").is_err());

        // The answer is checked, not trusted.
        let mut fake = b"\0mango-fs\0".to_vec();
        fake.extend_from_slice(b"99 0\n");
        fake.extend_from_slice(PNG);
        assert!(remote::parse("x", Some(0), &fake, false).unwrap_err().contains("changed while"));
        assert!(remote::parse("x", Some(0), b"hello", false).unwrap_err().contains("does not understand"));
        let big = format!("\0mango-fs\0{} 0\n", MAX_BYTES + 1);
        assert!(remote::parse("x", Some(0), big.as_bytes(), false).unwrap_err().contains("MB"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_files_that_are_not_pictures_whatever_their_name() {
        let dir = scratch();
        fs::write(dir.join("secret.png"), "token=abc").unwrap();
        let path = dir.join("secret.png").to_string_lossy().into_owned();
        assert!(read_image(&path, None).unwrap_err().contains("is not a PNG"));
        let folder = dir.to_string_lossy().into_owned();
        assert!(read_image(&folder, None).unwrap_err().contains("is not a file"));
        assert!(read_image("", None).is_err());
        fs::remove_dir_all(dir).ok();
    }
}
