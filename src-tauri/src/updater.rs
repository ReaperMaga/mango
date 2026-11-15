//! Self-update from GitHub releases.
//!
//! The release workflow (`.github/workflows/release.yml`) signs every installer and
//! uploads a `latest.json` manifest to each release. The updater reads the manifest
//! of the latest release (endpoint in `tauri.conf.json`), compares versions, and
//! installs the bundle that matches how Mango was installed (NSIS or MSI on Windows;
//! AppImage, deb or rpm on Linux). Signatures are checked against the public key in
//! `tauri.conf.json` before anything is installed.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, kept so `update_install` installs exactly
/// what the user was shown.
#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Release notes from the manifest (markdown), if any.
    pub notes: Option<String>,
    /// Publish date, milliseconds since the epoch.
    pub date_ms: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    /// Total size in bytes when the server sends it.
    pub total: Option<u64>,
}

/// Turns updater errors into something a person can act on.
fn explain(e: tauri_plugin_updater::Error) -> String {
    let text = e.to_string();
    let lower = text.to_lowercase();
    if lower.contains("404") || lower.contains("not found") {
        "No published release with update information was found on GitHub.".into()
    } else if lower.contains("signature") {
        format!("The downloaded update failed its signature check and was not installed ({text}).")
    } else if lower.contains("dns") || lower.contains("connect") || lower.contains("timed out") {
        "Could not reach GitHub to check for updates. Check your connection and try again.".into()
    } else {
        format!("Update failed: {text}")
    }
}

/// Asks GitHub for the latest release. `None` when Mango is up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdaterState>) -> Result<Option<UpdateInfo>, String> {
    // On Windows the installer ends this process before it runs: stop the terminals and
    // agent CLIs first so none outlive Mango. (Elsewhere `update_install` does it.)
    let handle = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || stop_children(&handle))
        .build()
        .map_err(explain)?;
    let update = updater.check().await.map_err(explain)?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date_ms: u.date.map(|d| d.unix_timestamp() * 1000),
    });
    *state.pending.lock().map_err(|_| "Updater state is unavailable.")? = update;
    Ok(info)
}

/// Downloads and installs the update found by the last check, then restarts Mango.
/// Emits `update://progress` while downloading. On Windows the installer closes
/// Mango itself and starts the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let update = state
        .pending
        .lock()
        .map_err(|_| "Updater state is unavailable.")?
        .clone()
        .ok_or("There is no update to install. Check for updates first.")?;

    let mut downloaded: u64 = 0;
    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit("update://progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(explain)?;

    stop_children(&app);
    app.restart();
}

/// Kills every terminal and agent process Mango started.
fn stop_children(app: &AppHandle) {
    app.state::<crate::pty::PtyState>().kill_all();
    app.state::<crate::agent_proc::AgentProcState>().kill_all();
}
