//! Joining an environment from a share link (`token`): a "direct" host. SSH goes
//! straight into the environment as its agent user, with the key from the link
//! and the host key it pins; there is no master and no Incus.
//!
//! The key lives in the app data folder (`env-keys/<hostId>`, next to
//! `env-keys/<hostId>.known_hosts`), readable by this user only, because
//! OpenSSH refuses a private key others can read: mode 0600 on Unix, and on
//! Windows an ACL with no inherited entries and full control for the current
//! user alone (Windows OpenSSH accepts only the user, SYSTEM and Administrators).
//!
//! Also here: the `mango://` deep link. Opening `mango://join/…` brings Mango
//! up and sends `envs://join { link }` to the webview (see [`setup_deep_link`]).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::token::{self, ShareToken};
use super::{blocking, hosts, now_ms, utc_text, EnvDirect, EnvHost};

const KEYS_DIR: &str = "env-keys";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvJoinPreview {
    pub instance: String,
    pub shared_from: String,
    pub endpoint: String,
    pub expires_at: Option<u64>,
    pub already_joined: bool,
}

/* ---------- from a token to a saved host ---------- */

/// When access ends (unix ms), `None` for a link without an end.
fn expires_ms(t: &ShareToken) -> Option<u64> {
    (t.e != 0).then(|| t.e.saturating_mul(1000))
}

/// `host:port`, with brackets around an IPv6 address.
fn endpoint(t: &ShareToken) -> String {
    if t.h.contains(':') {
        format!("[{}]:{}", t.h, t.p)
    } else {
        format!("{}:{}", t.h, t.p)
    }
}

fn preview(t: &ShareToken, saved: &[EnvHost]) -> EnvJoinPreview {
    EnvJoinPreview {
        instance: t.n.clone(),
        shared_from: t.f.clone(),
        endpoint: endpoint(t),
        expires_at: expires_ms(t),
        already_joined: saved.iter().any(|h| h.direct.as_ref().is_some_and(|d| d.share_id == t.id)),
    }
}

/// Refuse a link whose access has ended.
fn check_not_expired(t: &ShareToken, now: u64) -> Result<(), String> {
    match expires_ms(t) {
        Some(at) if at <= now => Err(format!(
            "This link expired on {}. Ask whoever shared it ({}) for a new one.",
            utc_text(at),
            t.f
        )),
        _ => Ok(()),
    }
}

/// The name to show: what the user typed, else what it was called before, else the instance.
fn pick_name(typed: Option<String>, before: Option<&str>, t: &ShareToken) -> Result<String, String> {
    let name = typed
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| before.map(String::from))
        .unwrap_or_else(|| t.n.clone());
    if name.chars().count() > 60 {
        return Err("Keep the name under 60 characters.".into());
    }
    if name.chars().any(char::is_control) {
        return Err("The name can't contain control characters.".into());
    }
    Ok(name)
}

fn host_from_token(t: &ShareToken, id: &str, name: &str, key_file: &str) -> EnvHost {
    EnvHost {
        id: id.to_string(),
        name: name.to_string(),
        ssh: format!("{}@{}", t.u, t.h),
        port: (t.p != 22).then_some(t.p),
        identity_file: Some(key_file.to_string()),
        incus_remote: None,
        tailscale: None,
        public_address: None,
        direct: Some(EnvDirect {
            instance: t.n.clone(),
            host_key: t.hk.clone(),
            shared_from: t.f.clone(),
            share_id: t.id.clone(),
            expires_at: expires_ms(t),
        }),
    }
}

/* ---------- key files ---------- */

fn keys_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(KEYS_DIR))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

/// A folder only this user can open.
fn private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .and_then(|_| fs::set_permissions(dir, fs::Permissions::from_mode(0o700)))
            .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    #[cfg(windows)]
    restrict_acl(dir, true)?;
    Ok(())
}

/// Write `content` to `path` (replacing it) so that only this user can read it.
fn write_private(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let fail = |e: std::io::Error| format!("Could not write {}: {e}", path.display());
    let _ = fs::remove_file(&tmp);
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).map_err(fail)?;
        f.write_all(content.as_bytes()).and_then(|_| f.sync_all()).map_err(fail)?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(fail)?;
    }
    #[cfg(not(unix))]
    fs::write(&tmp, content).map_err(fail)?;
    #[cfg(windows)]
    if let Err(e) = restrict_acl(&tmp, false) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        fail(e)
    })
}

/// Write the link's private key and pinned host key for host `id` into `dir`; returns the key's path.
fn write_key_files(dir: &Path, id: &str, t: &ShareToken) -> Result<PathBuf, String> {
    let seed = token::decode_seed(&t.k)?;
    let pem = token::openssh_private_key(&seed, &format!("mango-share:{}", t.id))?;
    private_dir(dir)?;
    let key = dir.join(id);
    write_private(&key, &pem)?;
    let known = PathBuf::from(super::ssh::known_hosts_for(&key.to_string_lossy()));
    write_private(&known, &format!("{}\n", token::known_hosts_line(&t.h, t.p, &t.hk)))?;
    Ok(key)
}

/// Delete a joined environment's key and pinned host key. Only files inside Mango's own
/// key folder are touched, whatever the saved entry says.
pub(crate) fn forget_key_files(app: &AppHandle, host: &EnvHost) -> Result<(), String> {
    let dir = keys_dir(app)?;
    remove_key_files(&dir, host);
    Ok(())
}

fn remove_key_files(dir: &Path, host: &EnvHost) {
    let Some(key) = host.identity_file.as_deref().map(Path::new) else { return };
    let name = key.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if key.parent() != Some(dir) || name != host.id || name.is_empty() {
        return;
    }
    let _ = fs::remove_file(key);
    let _ = fs::remove_file(super::ssh::known_hosts_for(&key.to_string_lossy()));
}

/* ---------- Windows: an ACL for the current user alone ---------- */

/// `<SystemRoot>\System32\<exe>`, so PATH can't put another program in its place.
#[cfg(windows)]
fn system32(exe: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(exe)
}

/// The SID in `whoami /user /fo csv /nh` output (`"pc\name","S-1-5-21-…"`).
#[cfg(any(windows, test))]
fn parse_whoami_sid(out: &str) -> Option<String> {
    let last = out.trim().rsplit(',').next()?.trim().trim_matches('"');
    let ok = last.starts_with("S-1-") && last.chars().all(|c| c.is_ascii_digit() || c == '-' || c == 'S');
    ok.then(|| last.to_string())
}

/// The current user as icacls takes it: `*S-1-5-21-…` (unambiguous), else `DOMAIN\name`.
#[cfg(windows)]
fn current_user() -> Result<String, String> {
    static USER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(u) = USER.get() {
        return Ok(u.clone());
    }
    let u = find_current_user()?;
    Ok(USER.get_or_init(|| u).clone())
}

#[cfg(windows)]
fn find_current_user() -> Result<String, String> {
    let mut cmd = std::process::Command::new(system32("whoami.exe"));
    crate::bin::hide_console(&mut cmd);
    if let Ok(out) = cmd.args(["/user", "/fo", "csv", "/nh"]).output() {
        if let Some(sid) = parse_whoami_sid(&String::from_utf8_lossy(&out.stdout)) {
            return Ok(format!("*{sid}"));
        }
    }
    let user = std::env::var("USERNAME").map_err(|_| "Could not tell which Windows user is signed in.".to_string())?;
    Ok(match std::env::var("USERDOMAIN") {
        Ok(d) if !d.is_empty() => format!("{d}\\{user}"),
        _ => user,
    })
}

/// icacls arguments: drop inherited entries and grant `who` (alone) full control.
/// A folder's entry is inherited by what is created in it.
#[cfg(any(windows, test))]
fn icacls_args(path: &Path, who: &str, dir: bool) -> Vec<std::ffi::OsString> {
    let grant = if dir { format!("{who}:(OI)(CI)F") } else { format!("{who}:F") };
    vec![path.as_os_str().to_owned(), "/inheritance:r".into(), "/grant:r".into(), grant.into(), "/Q".into()]
}

#[cfg(windows)]
fn restrict_acl(path: &Path, dir: bool) -> Result<(), String> {
    let who = current_user()?;
    let mut cmd = std::process::Command::new(system32("icacls.exe"));
    crate::bin::hide_console(&mut cmd);
    let out = cmd
        .args(icacls_args(path, &who, dir))
        .output()
        .map_err(|e| format!("Could not run icacls to protect {}: {e}", path.display()))?;
    if out.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim().to_string();
    Err(format!("Could not make {} private to your Windows user (icacls: {text}).", path.display()))
}

/* ---------- commands ---------- */

#[tauri::command]
pub async fn env_join_preview(app: AppHandle, link: String) -> Result<EnvJoinPreview, String> {
    blocking(move || {
        let t = token::decode(&link)?;
        Ok(preview(&t, &hosts::load(&app)?))
    })
    .await
}

/// Save the environment a link shares (or refresh it, joining the same share again).
#[tauri::command]
pub async fn env_join(app: AppHandle, link: String, name: Option<String>) -> Result<EnvHost, String> {
    blocking(move || {
        let t = token::decode(&link)?;
        check_not_expired(&t, now_ms())?;
        let dir = keys_dir(&app)?;
        let mut fresh: Option<EnvHost> = None;
        let saved = hosts::update(&app, |list| {
            let at = list.iter().position(|h| h.direct.as_ref().is_some_and(|d| d.share_id == t.id));
            let id = at.map_or_else(|| uuid::Uuid::new_v4().to_string(), |i| list[i].id.clone());
            let name = pick_name(name, at.map(|i| list[i].name.as_str()), &t)?;
            let key = write_key_files(&dir, &id, &t)?;
            let host = host_from_token(&t, &id, &name, &key.to_string_lossy());
            if at.is_none() {
                fresh = Some(host.clone());
            }
            let host = hosts::clean(host)?;
            match at {
                Some(i) => list[i] = host.clone(),
                None => list.push(host.clone()),
            }
            Ok(host)
        });
        if saved.is_err() {
            // Nothing was saved: don't leave a key behind for an entry that doesn't exist.
            if let Some(h) = &fresh {
                remove_key_files(&dir, h);
            }
        }
        saved
    })
    .await
}

/* ---------- the mango:// deep link ---------- */

/// A link opened before the page could listen, kept until the page has loaded.
#[derive(Default)]
pub struct JoinLinkState {
    pending: Mutex<Option<String>>,
    loaded: AtomicBool,
}

/// The event payload of `envs://join`.
#[derive(Clone, Serialize)]
struct JoinEvent {
    link: String,
}

/// The first `mango://join/…` link among `urls`; anything else is ignored.
fn join_link<I: IntoIterator<Item = String>>(urls: I) -> Option<String> {
    urls.into_iter().map(|u| u.trim().to_string()).find(|u| {
        u.len() > token::SCHEME_PREFIX.len()
            && u.len() <= 4096
            && u.get(..token::SCHEME_PREFIX.len()).is_some_and(|p| p.eq_ignore_ascii_case(token::SCHEME_PREFIX))
    })
}

pub fn focus_main(app: &AppHandle) {
    let _ = crate::windows::focus(app, "main");
}

/// A link arrived (at start-up, from a second instance, or from the OS on macOS).
fn opened(app: &AppHandle, urls: Vec<String>) {
    let Some(link) = join_link(urls) else { return };
    focus_main(app);
    let state = app.state::<JoinLinkState>();
    if !state.loaded.load(Ordering::SeqCst) {
        // The page may not be listening yet: [`page_loaded`] sends it again.
        *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(link.clone());
    }
    let _ = app.emit("envs://join", JoinEvent { link });
}

/// Wire the deep link up (call from `setup`, after the deep-link plugin is registered).
pub fn setup_deep_link(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let dl = app.deep_link();
    // The installers register the scheme on Windows and macOS. Linux AppImages need it done at
    // run time, and dev builds on Windows too (which then take mango:// links until the next install).
    #[cfg(any(target_os = "linux", all(windows, debug_assertions)))]
    if let Err(e) = dl.register_all() {
        eprintln!("mango: could not register the mango:// link handler: {e}");
    }
    let handle = app.clone();
    dl.on_open_url(move |event| opened(&handle, event.urls().into_iter().map(|u| u.to_string()).collect()));
    // Started by a link (Windows and Linux pass it as the argument; the plugin read it already).
    if let Ok(Some(urls)) = dl.get_current() {
        opened(app, urls.into_iter().map(|u| u.to_string()).collect());
    }
}

/// The main page finished loading: hand it a link that came in before it could listen.
/// The page sets up its listeners while it starts, so the link goes out a few times over
/// the next seconds; the page treats the same link arriving again as one.
pub fn page_loaded(app: &AppHandle) {
    let state = app.state::<JoinLinkState>();
    state.loaded.store(true, Ordering::SeqCst);
    let Some(link) = state.pending.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        for wait in [300u64, 1200, 3000] {
            std::thread::sleep(Duration::from_millis(wait));
            let _ = app.emit("envs://join", JoinEvent { link: link.clone() });
        }
        let state = app.state::<JoinLinkState>();
        let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.as_deref() == Some(link.as_str()) {
            *pending = None;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    fn host_key() -> String {
        // The wire blob of an ssh-ed25519 key: string "ssh-ed25519", string <32 bytes>.
        let mut b = vec![0, 0, 0, 11];
        b.extend_from_slice(b"ssh-ed25519");
        b.extend_from_slice(&[0, 0, 0, 32]);
        b.extend_from_slice(&[5u8; 32]);
        STANDARD.encode(b)
    }

    fn token(e: u64) -> ShareToken {
        ShareToken {
            v: 1,
            id: "s-1".into(),
            n: "dev".into(),
            f: "forge/dev".into(),
            h: "203.0.113.24".into(),
            p: 22001,
            u: "agent".into(),
            k: token::encode_seed(&[9u8; 32]),
            hk: host_key(),
            e,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mango-join-{name}-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn token_to_host() {
        let t = token(1_900_000_000);
        let h = host_from_token(&t, "id1", "My dev", "/data/env-keys/id1");
        assert_eq!(h.ssh, "agent@203.0.113.24");
        assert_eq!(h.port, Some(22001));
        assert_eq!(h.identity_file.as_deref(), Some("/data/env-keys/id1"));
        assert_eq!((h.incus_remote.clone(), h.tailscale.clone(), h.public_address.clone()), (None, None, None));
        let d = h.direct.unwrap();
        assert_eq!(d.instance, "dev");
        assert_eq!(d.share_id, "s-1");
        assert_eq!(d.shared_from, "forge/dev");
        assert_eq!(d.host_key, host_key());
        assert_eq!(d.expires_at, Some(1_900_000_000_000));

        let mut t = token(0);
        t.p = 22;
        let h = host_from_token(&t, "id1", "dev", "/k");
        assert_eq!(h.port, None);
        assert_eq!(h.direct.unwrap().expires_at, None);
    }

    #[test]
    fn previews() {
        let t = token(0);
        let p = preview(&t, &[]);
        assert_eq!((p.instance.as_str(), p.shared_from.as_str(), p.endpoint.as_str()), ("dev", "forge/dev", "203.0.113.24:22001"));
        assert_eq!(p.expires_at, None);
        assert!(!p.already_joined);
        let saved = host_from_token(&t, "x", "dev", "/k");
        assert!(preview(&t, &[saved]).already_joined);
        let mut v6 = token(5);
        v6.h = "fd7a:115c:a1e0::1".into();
        let p = preview(&v6, &[]);
        assert_eq!(p.endpoint, "[fd7a:115c:a1e0::1]:22001");
        assert_eq!(p.expires_at, Some(5000));
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("sharedFrom").is_some() && v.get("alreadyJoined").is_some() && v.get("expiresAt").is_some());
    }

    #[test]
    fn expired_links_are_refused() {
        assert!(check_not_expired(&token(0), u64::MAX).is_ok());
        assert!(check_not_expired(&token(2_000_000_000), 1_000).is_ok());
        let e = check_not_expired(&token(1_000), 1_000_001).unwrap_err();
        assert_eq!(e, "This link expired on 1970-01-01 00:16 UTC. Ask whoever shared it (forge/dev) for a new one.");
    }

    #[test]
    fn names() {
        let t = token(0);
        assert_eq!(pick_name(None, None, &t).unwrap(), "dev");
        assert_eq!(pick_name(Some("  ".into()), Some("Old"), &t).unwrap(), "Old");
        assert_eq!(pick_name(Some(" Mine ".into()), Some("Old"), &t).unwrap(), "Mine");
        assert!(pick_name(Some("x".repeat(61)), None, &t).is_err());
        assert!(pick_name(Some("a\nb".into()), None, &t).is_err());
    }

    #[test]
    fn deep_links() {
        let l = format!("{}abc", token::SCHEME_PREFIX);
        assert_eq!(join_link(vec!["mango://settings".into(), l.clone()]), Some(l.clone()));
        assert_eq!(join_link(vec![format!(" {l} ")]), Some(l));
        assert_eq!(join_link(vec!["MANGO://JOIN/abc".into()]).as_deref(), Some("MANGO://JOIN/abc"));
        assert_eq!(join_link(vec!["mango://join/".into(), "https://x".into(), "mango://joinx".into()]), None);
        assert_eq!(join_link(vec![format!("{}{}", token::SCHEME_PREFIX, "a".repeat(5000))]), None);
    }

    #[test]
    fn writes_key_files() {
        let dir = scratch("keys");
        let t = token(0);
        let key = write_key_files(&dir, "host-1", &t).unwrap();
        assert_eq!(key, dir.join("host-1"));
        let pem = fs::read_to_string(&key).unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        let known = fs::read_to_string(dir.join("host-1.known_hosts")).unwrap();
        assert_eq!(known, format!("[203.0.113.24]:22001 ssh-ed25519 {}\n", host_key()));
        assert!(!dir.join("host-1.tmp").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&key).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }

        // Joining again replaces the key in place.
        let mut again = token(0);
        again.k = token::encode_seed(&[3u8; 32]);
        write_key_files(&dir, "host-1", &again).unwrap();
        assert_ne!(fs::read_to_string(&key).unwrap(), pem);

        // Removing the host takes its files, and only files of that host inside the folder.
        let h = host_from_token(&t, "host-1", "dev", &key.to_string_lossy());
        let mut stranger = h.clone();
        stranger.identity_file = Some(dir.join("other").to_string_lossy().into_owned());
        fs::write(dir.join("other"), "x").unwrap();
        remove_key_files(&dir, &stranger);
        assert!(dir.join("other").exists(), "the file name must be the host's id");
        remove_key_files(&dir, &h);
        assert!(!key.exists() && !dir.join("host-1.known_hosts").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whoami_sid() {
        assert_eq!(
            parse_whoami_sid("\"desktop-1\\user\",\"S-1-5-21-111-222-333-1001\"\r\n").as_deref(),
            Some("S-1-5-21-111-222-333-1001")
        );
        assert_eq!(parse_whoami_sid("Access denied"), None);
        assert_eq!(parse_whoami_sid(""), None);
    }

    #[test]
    fn icacls_command_line() {
        let a = icacls_args(Path::new(r"C:\Users\Jo Do\AppData\Roaming\dev.mango.app\env-keys\h1"), "*S-1-5-21-1", false);
        let a: Vec<String> = a.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(
            a,
            [r"C:\Users\Jo Do\AppData\Roaming\dev.mango.app\env-keys\h1", "/inheritance:r", "/grant:r", "*S-1-5-21-1:F", "/Q"]
        );
        let d = icacls_args(Path::new("C:/k"), r"PC\jo", true);
        assert_eq!(d[3].to_string_lossy(), r"PC\jo:(OI)(CI)F");
    }

    /// The real thing on Windows: the ACL icacls leaves behind, and OpenSSH reading the key.
    #[cfg(windows)]
    #[test]
    fn windows_key_is_private_and_readable_by_openssh() {
        let dir = scratch("acl");
        let t = token(0);
        let key = write_key_files(&dir, "host-2", &t).unwrap();

        let mut cmd = std::process::Command::new(system32("icacls.exe"));
        let out = cmd.arg(&key).output().unwrap();
        let acl = String::from_utf8_lossy(&out.stdout).to_string();
        let entries: Vec<&str> = acl.lines().filter(|l| l.contains(":(")).collect();
        assert_eq!(entries.len(), 1, "only the current user may have access:\n{acl}");
        assert!(!acl.contains("(I)"), "nothing inherited:\n{acl}");

        let keygen = system32(r"OpenSSH\ssh-keygen.exe");
        if keygen.exists() {
            let out = std::process::Command::new(&keygen).arg("-y").arg("-f").arg(&key).output().unwrap();
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert!(out.status.success(), "ssh-keygen refused the key: {stderr}");
            let public = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let expected = token::public_line(&[9u8; 32], "").unwrap();
            assert!(public.starts_with(&expected), "{public} vs {expected}");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
