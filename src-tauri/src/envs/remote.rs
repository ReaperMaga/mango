//! Terminals inside an instance (shell, CLI sign-in), project folders, and the
//! desktop tunnel. STUB: filled in by the backend work on this branch.

use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct DesktopState {}

impl DesktopState {
    pub fn kill_all(&self) {}
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDesktop {
    /// The noVNC page to load, e.g. http://127.0.0.1:53211/vnc.html?autoconnect=1&resize=remote
    pub url: String,
}

#[tauri::command]
pub async fn env_shell(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    instance: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let _ = (app, state, host_id, instance, cwd, cols, rows);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_login(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    instance: String,
    tool: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let _ = (app, state, host_id, instance, tool, cols, rows);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_prepare_dir(
    app: AppHandle,
    host_id: String,
    instance: String,
    dir: String,
    clone_url: Option<String>,
) -> Result<String, String> {
    let _ = (app, host_id, instance, dir, clone_url);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_desktop_open(
    app: AppHandle,
    state: State<'_, DesktopState>,
    host_id: String,
    instance: String,
) -> Result<EnvDesktop, String> {
    let _ = (app, state, host_id, instance);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_desktop_close(state: State<'_, DesktopState>, host_id: String, instance: String) -> Result<(), String> {
    let _ = (state, host_id, instance);
    Ok(())
}
