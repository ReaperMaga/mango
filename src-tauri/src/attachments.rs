//! Files attached to a chat message: pasted images, picked or dropped files.
//!
//! Each one is copied into Mango's own store (`<app data>/attachments/<id>/<name>`), so the
//! agent reads a stable copy that the user cannot move away mid-run and the chat history can
//! point at it later. The webview can only read back files inside that store.
//!
//! A remote project's agent cannot read this computer's disk, so before a run there each file
//! it reads by path is put into the environment (`attachment_put_remote`), where the phone app
//! puts its attachments too (`mobile/src/remote/sshBackend.ts`, `ATTACH`: keep them in step):
//!
//! ```text
//! ~/.local/share/mango/attachments/<id>/<name>   in the agent user's home inside the instance
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Larger files are refused: agents cannot do much with them and they fill the disk.
const MAX_BYTES: u64 = 25 * 1024 * 1024;
const MAX_NAME: usize = 120;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    /// File name as shown to the user and the agent.
    pub name: String,
    /// Absolute path of the stored copy.
    pub path: String,
    pub mime: String,
    pub size: u64,
    /// "image" for formats agents take as pictures (PNG, JPEG, GIF, WebP), else "file".
    pub kind: String,
}

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("attachments"))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

/// A name that is safe as a single path component on every OS.
fn safe_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut name: String = if trimmed.is_empty() { "attachment".into() } else { trimmed.into() };
    if name.chars().count() > MAX_NAME {
        // Keep the extension when shortening.
        let ext = Path::new(&name).extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
        let keep = MAX_NAME.saturating_sub(ext.chars().count());
        name = name.chars().take(keep).collect::<String>() + &ext;
    }
    // Reserved device names on Windows.
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    name
}

fn mime_for(name: &str) -> &'static str {
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "txt" | "log" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn kind_for(mime: &str) -> &'static str {
    match mime {
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" => "image",
        _ => "file",
    }
}

fn too_large(size: u64) -> String {
    format!(
        "That file is {:.1} MB; attachments can be at most {} MB.",
        size as f64 / 1024.0 / 1024.0,
        MAX_BYTES / 1024 / 1024
    )
}

/// Writes `bytes` as a new attachment under `root`.
fn store(root: &Path, name: &str, bytes: &[u8]) -> Result<AttachmentInfo, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    let name = safe_name(name);
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let dir = root.join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create the attachments folder: {e}"))?;
    let path = dir.join(&name);
    fs::write(&path, bytes).map_err(|e| format!("Could not save {name}: {e}"))?;
    let mime = mime_for(&name);
    Ok(AttachmentInfo {
        id,
        path: path.to_string_lossy().into_owned(),
        mime: mime.into(),
        size: bytes.len() as u64,
        kind: kind_for(mime).into(),
        name,
    })
}

fn import(root: &Path, source: &str) -> Result<AttachmentInfo, String> {
    let src = PathBuf::from(source);
    let meta = fs::metadata(&src).map_err(|e| format!("Could not open {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Folders cannot be attached; attach the files inside, or mention the folder in your message.".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(too_large(meta.len()));
    }
    let bytes = fs::read(&src).map_err(|e| format!("Could not read {source}: {e}"))?;
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    store(root, &name, &bytes)
}

/// Reads a stored attachment. Anything outside the store is refused.
fn read(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let outside = || "That file is not an attachment.".to_string();
    let root = root.canonicalize().map_err(|_| outside())?;
    let file = Path::new(path).canonicalize().map_err(|_| "The attachment is gone from disk.".to_string())?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(outside());
    }
    fs::read(&file).map_err(|e| format!("Could not read the attachment: {e}"))
}

/// Puts the attachment into the environment: `$1` its id, `$2` its file name, the bytes base64
/// on stdin. Prints where it is there. The same script as the phone's `ATTACH`.
const ATTACH: &str = r#"
d="$HOME/.local/share/mango/attachments"
mkdir -p "$d/$1" && chmod 700 "$d" "$d/$1" && cd "$d/$1" || exit 1
base64 -d > ".$2.part" && mv -f -- ".$2.part" "$2" || { rm -f -- ".$2.part"; exit 1; }
printf '%s/%s\n' "$PWD" "$2"
"#;

/// The id and file name a stored attachment keeps in the environment: its folder's name, and
/// its own name made safe there (one segment, not hidden, not an option; as the phone checks it).
fn remote_names(root: &Path, path: &str) -> Result<(String, String), String> {
    let root = root.canonicalize().map_err(|_| "That file is not an attachment.".to_string())?;
    let file = Path::new(path).canonicalize().map_err(|_| "The attachment is gone from disk.".to_string())?;
    let rel = file.strip_prefix(&root).map_err(|_| "That file is not an attachment.".to_string())?;
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let [id, name] = parts.as_slice() else {
        return Err("That file is not an attachment.".into());
    };
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("That file is not an attachment.".into());
    }
    let cleaned: String = name.chars().map(|c| if c.is_control() || c == '/' || c == '\\' { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches(['.', '-', ' ']);
    let name = if trimmed.is_empty() { "attachment".to_string() } else { trimmed.to_string() };
    Ok((id.clone(), name))
}

/// Saves pasted or browser-picked bytes (`data` is base64) as an attachment named `name`.
#[tauri::command]
pub async fn attachment_save(app: AppHandle, name: String, data: String) -> Result<AttachmentInfo, String> {
    let root = store_dir(&app)?;
    crate::git::blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|_| "The pasted data could not be read.".to_string())?;
        store(&root, &name, &bytes)
    })
    .await
}

/// Copies a file the user picked or dropped (absolute path) into the attachment store.
#[tauri::command]
pub async fn attachment_import(app: AppHandle, path: String) -> Result<AttachmentInfo, String> {
    let root = store_dir(&app)?;
    crate::git::blocking(move || import(&root, &path)).await
}

/// The bytes of a stored attachment, base64.
#[tauri::command]
pub async fn attachment_read(app: AppHandle, path: String) -> Result<String, String> {
    let root = store_dir(&app)?;
    crate::git::blocking(move || read(&root, &path).map(|b| base64::engine::general_purpose::STANDARD.encode(b))).await
}

/// Puts a stored attachment into a remote environment, for its agent to read; answers its
/// absolute path there. Only files inside this computer's store go.
#[tauri::command]
pub async fn attachment_put_remote(app: AppHandle, host_id: String, instance: String, path: String) -> Result<String, String> {
    crate::envs::valid_instance(&instance)?;
    let root = store_dir(&app)?;
    crate::git::blocking(move || {
        let (id, name) = remote_names(&root, &path)?;
        let data = base64::engine::general_purpose::STANDARD.encode(read(&root, &path)?);
        let env = crate::git::EnvAt {
            host: crate::envs::hosts::get(&app, &host_id)?,
            instance: instance.clone(),
            dir: crate::envs::AGENT_HOME.to_string(),
        };
        let argv: Vec<String> = ["sh", "-c", ATTACH, "sh", &id, &name].map(String::from).to_vec();
        let out = env.run_plain(&[], &argv, Some(data.into_bytes()), 4096, crate::git::LOCAL_TIMEOUT)?;
        if !out.ok() {
            return Err(format!("Could not put {name} into {instance}: {}", out.error("The upload")));
        }
        let there = out.line();
        if !there.starts_with('/') || !there.ends_with(&format!("/{name}")) {
            return Err(format!("Putting {name} into {instance} gave an unexpected answer."));
        }
        Ok(there)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mango-attach-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_are_single_safe_components() {
        assert_eq!(safe_name("shot.png"), "shot.png");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Users\\me\\a:b?.txt"), "a_b_.txt");
        assert_eq!(safe_name("  ..  "), "attachment");
        assert_eq!(safe_name("con.txt"), "_con.txt");
        assert_eq!(safe_name("COM1"), "_COM1");
        assert_eq!(safe_name("communication.txt"), "communication.txt");
        let long = format!("{}.png", "x".repeat(300));
        let short = safe_name(&long);
        assert_eq!(short.chars().count(), MAX_NAME);
        assert!(short.ends_with(".png"));
    }

    #[test]
    fn kinds_follow_what_agents_take_as_images() {
        assert_eq!(kind_for(mime_for("a.PNG")), "image");
        assert_eq!(kind_for(mime_for("a.jpeg")), "image");
        assert_eq!(kind_for(mime_for("a.svg")), "file");
        assert_eq!(kind_for(mime_for("Makefile")), "file");
    }

    #[test]
    fn store_import_and_read_round_trip() {
        let root = scratch();
        let a = store(&root, "notes.txt", b"hello").unwrap();
        assert_eq!(a.name, "notes.txt");
        assert_eq!(a.size, 5);
        assert_eq!(a.kind, "file");
        assert!(Path::new(&a.path).starts_with(&root));
        assert_eq!(read(&root, &a.path).unwrap(), b"hello");

        let b = import(&root, &a.path).unwrap();
        assert_ne!(a.path, b.path);
        assert_eq!(read(&root, &b.path).unwrap(), b"hello");

        assert!(import(&root, root.to_str().unwrap()).unwrap_err().contains("Folders"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reading_outside_the_store_is_refused() {
        let root = scratch();
        let elsewhere = scratch();
        let secret = elsewhere.join("secret.txt");
        fs::write(&secret, "no").unwrap();
        assert!(read(&root, secret.to_str().unwrap()).unwrap_err().contains("not an attachment"));
        let sneaky = root.join("..").join(elsewhere.file_name().unwrap()).join("secret.txt");
        assert!(read(&root, sneaky.to_str().unwrap()).is_err());
        assert!(read(&root, root.to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&elsewhere).unwrap();
    }

    #[test]
    fn remote_names_come_from_the_store() {
        let root = scratch();
        let a = store(&root, "report final.pdf", b"%PDF").unwrap();
        assert_eq!(remote_names(&root, &a.path).unwrap(), (a.id.clone(), "report final.pdf".to_string()));
        // Not hidden and not an option there.
        let b = store(&root, "-rf .pdf", b"x").unwrap();
        assert_eq!(remote_names(&root, &b.path).unwrap().1, "rf .pdf");
        // Only files directly in an attachment's folder.
        let elsewhere = scratch();
        let other = elsewhere.join("x.txt");
        fs::write(&other, "no").unwrap();
        assert!(remote_names(&root, other.to_str().unwrap()).is_err());
        fs::write(root.join("loose.txt"), "no").unwrap();
        assert!(remote_names(&root, root.join("loose.txt").to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&elsewhere).unwrap();
    }

    /// The script itself, run by the local `sh` against a scratch HOME.
    #[cfg(unix)]
    #[test]
    fn attach_script_puts_the_file() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let home = scratch();
        let mut child = Command::new("sh")
            .args(["-c", ATTACH, "sh", "abc123", "my file.pdf"])
            .env("HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(base64::engine::general_purpose::STANDARD.encode(b"%PDF-1.7").as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        let there = String::from_utf8(out.stdout).unwrap();
        assert!(there.trim_end().ends_with("/.local/share/mango/attachments/abc123/my file.pdf"), "{there}");
        assert_eq!(fs::read(there.trim_end()).unwrap(), b"%PDF-1.7");
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn oversized_data_is_refused() {
        let root = scratch();
        let big = vec![0u8; (MAX_BYTES + 1) as usize];
        assert!(store(&root, "big.bin", &big).unwrap_err().contains("at most"));
        fs::remove_dir_all(&root).unwrap();
    }
}
