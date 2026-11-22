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
    /// Its installer, once `update_download` has it.
    downloaded: Mutex<Option<Vec<u8>>>,
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
    *state.downloaded.lock().map_err(|_| "Updater state is unavailable.")? = None;
    Ok(info)
}

fn pending(state: &UpdaterState) -> Result<Update, String> {
    let update = state.pending.lock().map_err(|_| "Updater state is unavailable.")?.clone();
    update.ok_or_else(|| "There is no update to install. Check for updates first.".to_string())
}

/// The installer, its signature checked. Emits `update://progress`.
async fn download(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let mut downloaded: u64 = 0;
    let emitter = app.clone();
    update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit("update://progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(explain)
}

/// Downloads the update found by the last check, without installing it: installing ends Mango, so
/// what was typed during the download is saved between the two.
#[tauri::command]
pub async fn update_download(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let bytes = download(&app, &pending(&state)?).await?;
    *state.downloaded.lock().map_err(|_| "Updater state is unavailable.")? = Some(bytes);
    Ok(())
}

/// Installs what `update_download` fetched, then restarts Mango. It never downloads: nothing typed
/// meanwhile would be saved. On Windows the installer closes Mango itself and starts the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdaterState>) -> Result<(), String> {
    let update = pending(&state)?;
    let bytes = take_downloaded(&state)?;
    update.install(bytes).map_err(explain)?;

    stop_children(&app);
    app.restart();
}

fn take_downloaded(state: &UpdaterState) -> Result<Vec<u8>, String> {
    let kept = state.downloaded.lock().map_err(|_| "Updater state is unavailable.")?.take();
    kept.ok_or_else(|| "The update has not finished downloading. Check for updates, then install it again.".to_string())
}

/// Kills every terminal and agent process Mango started.
fn stop_children(app: &AppHandle) {
    app.state::<crate::pty::PtyState>().kill_all();
    app.state::<crate::agent_proc::AgentProcState>().kill_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_takes_only_what_was_downloaded() {
        let state = UpdaterState::default();
        assert!(take_downloaded(&state).unwrap_err().contains("install it again"));
        *state.downloaded.lock().unwrap() = Some(vec![1, 2]);
        assert_eq!(take_downloaded(&state).unwrap(), [1, 2]);
        assert!(take_downloaded(&state).is_err(), "only once");
    }
}
