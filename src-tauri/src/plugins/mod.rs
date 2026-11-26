//! Plugins: installing, updating and serving the files of Mango plugins.
//!
//! A plugin is a folder holding `mango-plugin.json` and one bundled ES module. It comes from a git
//! repository (cloned shallowly, the plugin's folder copied out) or from a local folder used in place.
//! The frontend runs them (`app/plugins/`); this side only stores them and hands out their files.
//!
//! Layout under `<app data>/plugins/`:
//! - `plugins.json`: the registry (one record per installed plugin), written atomically.
//! - `repos/<key>/`: a clone per source repository and ref, kept for updates.
//! - `installed/<id>/`: a copy of each git plugin's folder; what it runs from.
//! - `.staging/<probeId>/`: a probe's checkout, waiting for `plugins_install`.
//! - `catalog-cache.json`: the last official catalog fetched.
//!
//! The logic lives in `store.rs` and takes a plain base folder (no `AppHandle`), so it is testable.

mod catalog;
mod store;
mod gitops;
mod validate;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) use self::store::Ctx;
pub(crate) use self::validate::valid_id;

// ---------------------------------------------------------------------------
// Types (app/types/ipc.ts, "Plugins")
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingField {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SelectOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Fields this build doesn't know, passed through untouched.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub styles: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Vec<PluginSettingField>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginSource {
    Git {
        url: String,
        #[serde(rename = "ref")]
        reference: Option<String>,
        subpath: Option<String>,
    },
    Local {
        path: String,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub source: PluginSource,
    pub dir: String,
    pub enabled: bool,
    pub commit: Option<String>,
    pub installed_at: u64,
    pub updated_at: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginCandidate {
    pub subpath: String,
    pub manifest: PluginManifest,
    pub installed: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginProbe {
    pub probe_id: String,
    pub url: String,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub commit: String,
    pub candidates: Vec<PluginCandidate>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInfo {
    pub id: String,
    pub current: Option<String>,
    pub latest: Option<String>,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginProgress {
    pub job_id: String,
    pub line: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct PluginAsset {
    pub mime: String,
    pub data: String,
}

/// The git source `plugins_probe` receives (`kind` is always `git` and not needed).
#[derive(Deserialize, Clone, Debug)]
pub struct ProbeSource {
    pub url: String,
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub subpath: Option<String>,
}

use catalog::PluginCatalogResult;

// ---------------------------------------------------------------------------
// State and plumbing
// ---------------------------------------------------------------------------

/// The plugins folder, resolved once from the app data folder.
#[derive(Default)]
pub struct PluginsState {
    ctx: Mutex<Option<Arc<Ctx>>>,
}

fn ctx(app: &AppHandle) -> Result<Arc<Ctx>, String> {
    let state = app.state::<PluginsState>();
    let mut slot = state.ctx.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ctx) = slot.as_ref() {
        return Ok(ctx.clone());
    }
    let base: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the app data folder: {e}"))?
        .join("plugins");
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("Could not create the plugins folder {}: {e}", base.display()))?;
    let ctx = Arc::new(Ctx::new(base));
    *slot = Some(ctx.clone());
    Ok(ctx)
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

/// Sends git's progress lines to the frontend as `plugins://progress`.
fn progress(app: AppHandle, job_id: String) -> impl Fn(&str) {
    move |line: &str| {
        let _ = app.emit(
            "plugins://progress",
            PluginProgress { job_id: job_id.clone(), line: line.to_string() },
        );
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    let ctx = ctx(&app)?;
    blocking(move || Ok(ctx.list())).await
}

#[tauri::command]
pub async fn plugins_probe(app: AppHandle, source: ProbeSource, job_id: String) -> Result<PluginProbe, String> {
    let ctx = ctx(&app)?;
    let emit = progress(app, job_id);
    blocking(move || ctx.probe(&source.url, source.reference.as_deref(), source.subpath.as_deref(), &emit)).await
}

#[tauri::command]
pub async fn plugins_install(
    app: AppHandle,
    probe_id: String,
    subpaths: Vec<String>,
) -> Result<Vec<InstalledPlugin>, String> {
    let ctx = ctx(&app)?;
    blocking(move || ctx.install(&probe_id, &subpaths)).await
}

#[tauri::command]
pub async fn plugins_add_local(app: AppHandle, path: String) -> Result<InstalledPlugin, String> {
    let ctx = ctx(&app)?;
    blocking(move || ctx.add_local(&path)).await
}

#[tauri::command]
pub async fn plugins_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<InstalledPlugin, String> {
    let ctx = ctx(&app)?;
    blocking(move || ctx.set_enabled(&id, enabled)).await
}

#[tauri::command]
pub async fn plugins_remove(app: AppHandle, id: String) -> Result<(), String> {
    let ctx = ctx(&app)?;
    blocking(move || ctx.remove(&id)).await
}

#[tauri::command]
pub async fn plugins_check_updates(
    app: AppHandle,
    ids: Option<Vec<String>>,
    job_id: String,
) -> Result<Vec<PluginUpdateInfo>, String> {
    let ctx = ctx(&app)?;
    let emit = progress(app, job_id);
    blocking(move || Ok(ctx.check_updates(ids.as_deref(), &emit))).await
}

#[tauri::command]
pub async fn plugins_update(app: AppHandle, id: String, job_id: String) -> Result<InstalledPlugin, String> {
    let ctx = ctx(&app)?;
    let emit = progress(app, job_id);
    blocking(move || ctx.update(&id, &emit)).await
}

#[tauri::command]
pub async fn plugins_read(app: AppHandle, id: String, path: String) -> Result<String, String> {
    let ctx = ctx(&app)?;
    blocking(move || {
        let bytes = ctx.read_file(&id, &path)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
}

#[tauri::command]
pub async fn plugins_asset(app: AppHandle, id: String, path: String) -> Result<PluginAsset, String> {
    use base64::Engine;
    let ctx = ctx(&app)?;
    blocking(move || {
        let bytes = ctx.read_file(&id, &path)?;
        Ok(PluginAsset {
            mime: store::mime_for(&path).to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    })
    .await
}

#[tauri::command]
pub async fn plugins_catalog(app: AppHandle, force: bool) -> Result<PluginCatalogResult, String> {
    let ctx = ctx(&app)?;
    catalog::catalog(&ctx.base, force).await
}

#[tauri::command]
pub async fn plugins_dir(app: AppHandle) -> Result<String, String> {
    let ctx = ctx(&app)?;
    Ok(ctx.base.to_string_lossy().into_owned())
}

/// Shows a plugin's folder (or, with no id, the plugins folder) in the system file manager.
#[tauri::command]
pub async fn plugins_reveal(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let ctx = ctx(&app)?;
    blocking(move || {
        let dir = match id {
            Some(id) => ctx.dir_of(&id)?,
            None => {
                std::fs::create_dir_all(&ctx.base).map_err(|e| format!("Could not create the plugins folder: {e}"))?;
                ctx.base.clone()
            }
        };
        if !dir.is_dir() {
            return Err(format!("The folder {} is not there any more", dir.display()));
        }
        let program = if cfg!(windows) {
            "explorer"
        } else if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        let mut cmd = std::process::Command::new(program);
        cmd.arg(&dir);
        crate::bin::hide_console(&mut cmd);
        // Not waited on: explorer exits non-zero even when it opened the folder.
        cmd.spawn().map(|_| ()).map_err(|e| format!("Could not open the file manager ({program}): {e}"))
    })
    .await
}
