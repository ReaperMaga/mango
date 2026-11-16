//! The saved master servers (`environments.json` in the app data folder).
//!
//! Commands that act on a server take its id and look it up here, so the SSH
//! destination and options always come from validated, saved settings.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::{ssh, valid_master_path, valid_remote, valid_ssh_dest, valid_tag, EnvHost, EnvTailscale};

const FILE: &str = "environments.json";

#[derive(Default)]
pub struct EnvsState {
    lock: Mutex<()>,
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

fn load(app: &AppHandle) -> Result<Vec<EnvHost>, String> {
    let file = file(app)?;
    match fs::read_to_string(&file) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Could not read {}: {e}", file.display())),
    }
}

fn save(app: &AppHandle, list: &[EnvHost]) -> Result<(), String> {
    let file = file(app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json)
        .and_then(|_| fs::rename(&tmp, &file))
        .map_err(|e| format!("Could not save {}: {e}", file.display()))
}

/// The saved server `id`, or an error for one that was removed.
pub fn get(app: &AppHandle, id: &str) -> Result<EnvHost, String> {
    load(app)?
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| "That server is no longer in Mango's list. Add it again under Environments.".to_string())
}

/// Trim and check user input; the id is kept or assigned by the caller.
pub(crate) fn clean(mut h: EnvHost) -> Result<EnvHost, String> {
    h.name = h.name.trim().to_string();
    h.ssh = h.ssh.trim().to_string();
    valid_ssh_dest(&h.ssh)?;
    if h.name.is_empty() {
        h.name = h.ssh.rsplit('@').next().unwrap_or(&h.ssh).to_string();
    }
    if h.name.chars().count() > 60 {
        return Err("Keep the name under 60 characters.".into());
    }
    if h.port == Some(0) {
        h.port = None;
    }
    h.identity_file = h.identity_file.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(key) = &h.identity_file {
        if key.starts_with('-') || key.chars().any(|c| c.is_control()) {
            return Err(format!("\"{key}\" is not a key file path."));
        }
        if !std::path::Path::new(key).is_file() {
            return Err(format!("The key file {key} does not exist on this computer."));
        }
    }
    h.incus_remote = h.incus_remote.map(|s| s.trim().trim_end_matches(':').to_string()).filter(|s| !s.is_empty());
    if let Some(r) = &h.incus_remote {
        valid_remote(r)?;
    }
    if let Some(ts) = &mut h.tailscale {
        ts.tags = ts.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        for t in &ts.tags {
            valid_tag(t)?;
        }
        ts.auth_key_file = ts.auth_key_file.take().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(p) = &ts.auth_key_file {
            valid_master_path(p)?;
        }
    }
    Ok(h)
}

#[tauri::command]
pub async fn env_hosts(app: AppHandle) -> Result<Vec<EnvHost>, String> {
    super::blocking(move || load(&app)).await
}

/// Add (`host.id` empty) or update a server.
#[tauri::command]
pub async fn env_host_save(app: AppHandle, host: EnvHost) -> Result<EnvHost, String> {
    super::blocking(move || {
        let mut h = clean(host)?;
        let state = app.state::<EnvsState>();
        let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = load(&app)?;
        if h.id.trim().is_empty() {
            h.id = uuid::Uuid::new_v4().to_string();
            list.push(h.clone());
        } else if let Some(slot) = list.iter_mut().find(|x| x.id == h.id) {
            *slot = h.clone();
        } else {
            return Err("That server is no longer in Mango's list.".into());
        }
        save(&app, &list)?;
        Ok(h)
    })
    .await
}

/// Forget a server. Its instances are untouched.
#[tauri::command]
pub async fn env_host_remove(app: AppHandle, state: State<'_, EnvsState>, id: String) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load(&app)?;
    list.retain(|h| h.id != id);
    save(&app, &list)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProbe {
    /// SSH worked and `incus` answered.
    pub ok: bool,
    pub incus_version: Option<String>,
    /// Remotes the master's `incus` knows (`incus remote list`).
    pub remotes: Vec<String>,
    pub error: Option<String>,
}

fn parse_remotes(json: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let mut names: Vec<String> = v
        .as_object()
        .map(|m| {
            m.iter()
                // Image servers (simplestreams) hold no instances.
                .filter(|(_, r)| r.get("Protocol").and_then(|p| p.as_str()) != Some("simplestreams"))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Can Mango reach the server, and what does its `incus` know?
#[tauri::command]
pub async fn env_probe(app: AppHandle, host_id: String) -> Result<EnvProbe, String> {
    super::blocking(move || {
        let host = get(&app, &host_id)?;
        let version = ssh::run(&host, &["incus".into(), "version".into()], Duration::from_secs(20));
        let version = match version {
            Ok(v) => v,
            Err(e) => return Ok(EnvProbe { ok: false, incus_version: None, remotes: vec![], error: Some(e) }),
        };
        // `incus version` prints "Client version: x\nServer version: y".
        let server = version
            .lines()
            .find_map(|l| l.strip_prefix("Server version:"))
            .or_else(|| version.lines().find_map(|l| l.strip_prefix("Client version:")))
            .map(|v| v.trim().to_string());
        let remotes = ssh::run(
            &host,
            &["incus", "remote", "list", "--format", "json"].map(String::from),
            Duration::from_secs(20),
        )
        .map(|j| parse_remotes(&j))
        .unwrap_or_default();
        Ok(EnvProbe { ok: true, incus_version: server, remotes, error: None })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> EnvHost {
        EnvHost {
            id: String::new(),
            name: "  ".into(),
            ssh: " ops@lab ".into(),
            port: Some(0),
            identity_file: Some("".into()),
            incus_remote: Some("os1:".into()),
            tailscale: Some(EnvTailscale { tags: vec![" tag:mango ".into(), "".into()], auth_key_file: Some(" ".into()) }),
        }
    }

    #[test]
    fn cleans_input() {
        let h = clean(base()).unwrap();
        assert_eq!(h.ssh, "ops@lab");
        assert_eq!(h.name, "lab");
        assert_eq!(h.port, None);
        assert_eq!(h.identity_file, None);
        assert_eq!(h.incus_remote.as_deref(), Some("os1"));
        let ts = h.tailscale.unwrap();
        assert_eq!(ts.tags, ["tag:mango"]);
        assert_eq!(ts.auth_key_file, None);
    }

    #[test]
    fn rejects_bad_input() {
        let mut h = base();
        h.ssh = "-oProxyCommand=sh".into();
        assert!(clean(h).is_err());
        let mut h = base();
        h.tailscale = Some(EnvTailscale { tags: vec!["admins".into()], auth_key_file: None });
        assert!(clean(h).is_err());
        let mut h = base();
        h.identity_file = Some("/definitely/not/here/id".into());
        assert!(clean(h).is_err());
    }

    #[test]
    fn remotes_skip_image_servers() {
        let j = r#"{"images":{"Protocol":"simplestreams"},"local":{"Protocol":"incus"},"os1":{"Protocol":"incus"}}"#;
        assert_eq!(parse_remotes(j), ["local", "os1"]);
    }
}
