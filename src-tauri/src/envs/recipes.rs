//! One-click components for an instance and their install/update scripts.
//! STUB: filled in by the backend work on this branch.

use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvComponent {
    /// "base" | "claude" | "codex" | "gh" | "node" | "desktop" | "tailscale"
    pub id: String,
    pub name: String,
    pub description: String,
    pub installed: bool,
    pub version: Option<String>,
    /// Components this one needs first (installed along with it).
    pub requires: Vec<String>,
}

#[tauri::command]
pub async fn env_components(app: AppHandle, host_id: String, instance: String) -> Result<Vec<EnvComponent>, String> {
    let _ = (app, host_id, instance);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_install(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    instance: String,
    components: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let _ = (app, state, host_id, instance, components, cols, rows);
    Err("Not built yet".into())
}
