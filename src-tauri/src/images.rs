//! Pictures in an agent's reply: markdown `![alt](path)` pointing at a file on this computer.
//! Agents save screenshots wherever suits them (a temp folder, the project), so the path is
//! not confined to a folder. Instead only real raster images are read: the file's own bytes
//! must say PNG, JPEG, GIF, WebP, AVIF or BMP, whatever its name. Anything else is refused,
//! so this command cannot be used to read other files. SVG is text and is not read here.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

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

pub(crate) fn read_image(path: &str, base: Option<&str>) -> Result<ChatImage, String> {
    use base64::Engine as _;
    let target = locate(path, base)?;
    let meta = fs::metadata(&target).map_err(|e| format!("Could not read {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let size = meta.len();
    if size > MAX_BYTES {
        return Err(format!(
            "{path} is {} MB; pictures up to {} MB are shown in a chat",
            size / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("Could not read {path}: {e}"))?;
    let mime = sniff(&bytes).ok_or_else(|| format!("{path} is not a PNG, JPEG, GIF, WebP, AVIF or BMP picture"))?;
    Ok(ChatImage {
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: mime.into(),
        size,
        modified_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64),
    })
}

/// A picture an agent's reply points at. `base` resolves relative paths; null when there is none.
#[tauri::command]
pub async fn chat_image(path: String, base: Option<String>) -> Result<ChatImage, String> {
    blocking(move || read_image(&path, base.as_deref())).await
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
