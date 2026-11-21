//! Checks on everything that comes from the webview or from a repository: source URLs, refs,
//! folders inside a repository, manifests.

use std::collections::HashSet;

use sha2::{Digest, Sha256};

use super::PluginManifest;

pub const MANIFEST_FILE: &str = "mango-plugin.json";
/// A manifest is a small JSON file; anything bigger is not one.
pub const MANIFEST_MAX: u64 = 256 * 1024;

const SETTING_TYPES: [&str; 5] = ["boolean", "string", "text", "number", "select"];

/// A repository URL git may clone: `https://`, `http://`, `ssh://` or scp-like `[user@]host:path`.
/// Everything git would treat as a command or a local transport is refused (`-…` options,
/// `ext::`/`fd::` and other `<helper>::` remotes, `file:`), and so are local folders, which
/// `plugins_add_local` handles. `allow_local` is for tests only.
pub fn validate_url(raw: &str, allow_local: bool) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("Enter a repository URL".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("\"{url}\" is not a repository URL: it contains spaces or control characters"));
    }
    if url.starts_with('-') {
        return Err(format!("\"{url}\" is not a repository URL"));
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("file:") {
        return Err("file: URLs are not supported; add a folder on this computer with \"Add local folder\"".into());
    }
    if lower.contains("::") {
        return Err(format!("\"{url}\" is not supported: use an https://, ssh:// or git@host:path URL"));
    }
    for scheme in ["https://", "http://", "ssh://"] {
        if let Some(rest) = lower.strip_prefix(scheme) {
            let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            if host.is_empty() || host.starts_with('-') || authority.starts_with('-') {
                return Err(format!("\"{url}\" has no valid host"));
            }
            if path.trim_matches('/').is_empty() {
                return Err(format!("\"{url}\" names no repository"));
            }
            return Ok(url.to_string());
        }
    }
    if lower.contains("://") {
        return Err(format!("\"{url}\" is not supported: use an https://, ssh:// or git@host:path URL"));
    }
    // scp-like: [user@]host:path. A single letter before the colon is a Windows drive.
    if let Some((left, path)) = url.split_once(':') {
        let (user, host) = match left.rsplit_once('@') {
            Some((u, h)) => (Some(u), h),
            None => (None, left),
        };
        let host_ok = !host.is_empty()
            && !host.starts_with('-')
            && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            && !(host.len() == 1 && user.is_none());
        let user_ok = user.is_none_or(|u| {
            !u.is_empty() && !u.starts_with('-') && u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        });
        if host_ok && user_ok && !path.is_empty() && !path.starts_with('-') {
            return Ok(url.to_string());
        }
    }
    if allow_local {
        return Ok(url.to_string());
    }
    Err(format!(
        "\"{url}\" is not a repository URL. Use https://, ssh:// or git@host:path; for a folder on this computer use \"Add local folder\""
    ))
}

/// A branch, tag or commit. Empty means the repository's default branch.
pub fn normalize_ref(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(r) = raw.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    let r = crate::git::safe_ref(r).map_err(|_| format!("\"{r}\" is not a valid branch, tag or commit"))?;
    // Passed to `git fetch` as a refspec: nothing that could make it a mapping or a pattern.
    if r.chars().any(|c| c.is_control() || matches!(c, ':' | '^' | '~' | '?' | '*' | '[' | '\\' | '+')) {
        return Err(format!("\"{r}\" is not a valid branch, tag or commit"));
    }
    Ok(Some(r.to_string()))
}

/// A ref that names a commit (7 to 40 hex digits): pinned, never moves.
pub fn is_sha_like(r: &str) -> bool {
    (7..=40).contains(&r.len()) && r.chars().all(|c| c.is_ascii_hexdigit())
}

/// A relative `/`-separated path inside a folder: no absolute paths, drives, backslashes or `..`.
/// `.` segments and repeated or trailing slashes are dropped. May come back empty.
fn rel_segments(raw: &str, what: &str) -> Result<Vec<String>, String> {
    let s = raw.trim();
    if s.chars().any(|c| c.is_control()) {
        return Err(format!("{what} \"{s}\" contains control characters"));
    }
    if s.contains('\\') || s.contains(':') {
        return Err(format!("{what} \"{s}\" must be a relative path with / between folders"));
    }
    if s.starts_with('/') {
        return Err(format!("{what} \"{s}\" must be relative, not absolute"));
    }
    let mut out = Vec::new();
    for seg in s.split('/') {
        match seg {
            "" | "." => {}
            ".." => return Err(format!("{what} \"{s}\" may not use \"..\"")),
            other => out.push(other.to_string()),
        }
    }
    Ok(out)
}

/// A folder inside a repository; `''` is the root.
pub fn normalize_subpath(raw: &str) -> Result<String, String> {
    Ok(rel_segments(raw, "The folder")?.join("/"))
}

/// A file inside a plugin's folder (`main`, `styles`, `plugins_read`). Never empty.
pub fn safe_rel_file(raw: &str, what: &str) -> Result<String, String> {
    let segs = rel_segments(raw, what)?;
    if segs.is_empty() {
        return Err(format!("{what} \"{}\" names no file", raw.trim()));
    }
    Ok(segs.join("/"))
}

pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

fn valid_setting_key(key: &str) -> bool {
    let b = key.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|&c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

/// Parses and checks a manifest. `file` names it in errors (e.g. `plugins/foo/mango-plugin.json`).
/// Fills in `main` (`main.js`) and normalises `main`/`styles`.
pub fn parse_manifest(bytes: &[u8], file: &str) -> Result<PluginManifest, String> {
    if bytes.len() as u64 > MANIFEST_MAX {
        return Err(format!("{file} is larger than 256 KB; that is not a plugin manifest"));
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let mut m: PluginManifest =
        serde_json::from_slice(bytes).map_err(|e| format!("{file} is not a valid plugin manifest: {e}"))?;
    check_manifest(&mut m).map_err(|e| format!("{file}: {e}"))?;
    Ok(m)
}

pub fn check_manifest(m: &mut PluginManifest) -> Result<(), String> {
    m.id = m.id.trim().to_string();
    if !valid_id(&m.id) {
        return Err(format!(
            "the id \"{}\" is not valid (use 1 to 64 lower-case letters, digits, '.', '_' or '-', starting with a letter or digit)",
            m.id
        ));
    }
    m.name = m.name.trim().to_string();
    if m.name.is_empty() {
        return Err(format!("plugin \"{}\" has no name", m.id));
    }
    if m.name.chars().count() > 80 {
        return Err(format!("plugin \"{}\" has a name longer than 80 characters", m.id));
    }
    m.version = m.version.trim().to_string();
    if m.version.is_empty() {
        return Err(format!("plugin \"{}\" has no version", m.id));
    }
    if m.version.chars().count() > 40 {
        return Err(format!("plugin \"{}\" has a version longer than 40 characters", m.id));
    }
    let main = m.main.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("main.js");
    m.main = Some(safe_rel_file(main, "The entry module").map_err(|e| format!("plugin \"{}\": {e}", m.id))?);
    if let Some(styles) = m.styles.as_deref().map(str::trim) {
        m.styles = if styles.is_empty() {
            None
        } else {
            Some(safe_rel_file(styles, "The stylesheet").map_err(|e| format!("plugin \"{}\": {e}", m.id))?)
        };
    }
    if let Some(fields) = m.settings.as_mut() {
        let mut keys = HashSet::new();
        for f in fields.iter_mut() {
            f.key = f.key.trim().to_string();
            if !valid_setting_key(&f.key) {
                return Err(format!("plugin \"{}\" has a setting with the invalid key \"{}\"", m.id, f.key));
            }
            if !keys.insert(f.key.clone()) {
                return Err(format!("plugin \"{}\" declares the setting \"{}\" twice", m.id, f.key));
            }
            if !SETTING_TYPES.contains(&f.kind.as_str()) {
                return Err(format!(
                    "setting \"{}\" of plugin \"{}\" has the unknown type \"{}\" (use boolean, string, text, number or select)",
                    f.key, m.id, f.kind
                ));
            }
            if f.label.trim().is_empty() {
                f.label = f.key.clone();
            }
            if f.kind == "select" && f.options.as_ref().is_none_or(|o| o.is_empty()) {
                return Err(format!("setting \"{}\" of plugin \"{}\" is a select without options", f.key, m.id));
            }
            if let Some(d) = &f.default {
                let fits = match f.kind.as_str() {
                    "boolean" => d.is_boolean(),
                    "number" => d.is_number(),
                    _ => d.is_string(),
                };
                if !fits {
                    return Err(format!(
                        "setting \"{}\" of plugin \"{}\" has a default that is not a {}",
                        f.key, m.id, f.kind
                    ));
                }
            }
        }
    }
    Ok(())
}

/// The folder name for a repository clone: a readable slug of the URL plus a hash of URL and ref,
/// so two refs of one repository get separate clones.
pub fn repo_key(url: &str, reference: Option<&str>) -> String {
    let url = url.trim();
    let mut s = url.to_ascii_lowercase();
    for scheme in ["https://", "http://", "ssh://"] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest.to_string();
            break;
        }
    }
    // Drop a user name (`git@`), only when it comes before the path.
    if let Some(at) = s.find('@') {
        if !s[..at].contains('/') {
            s = s[at + 1..].to_string();
        }
    }
    let s = s.trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    let mut slug = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(48).collect();
    let slug = slug.trim_end_matches('-');
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    hasher.update(b"\n");
    hasher.update(reference.unwrap_or("").as_bytes());
    let hash: String = hasher.finalize().iter().take(6).map(|b| format!("{b:02x}")).collect();
    if slug.is_empty() {
        hash
    } else {
        format!("{slug}-{hash}")
    }
}
