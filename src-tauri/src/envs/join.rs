//! Joining an environment from a share link: a direct host (no master, no Incus).
//! STUB: filled in by the sharing work on this branch.

use tauri::AppHandle;

use super::EnvHost;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvJoinPreview {
    pub instance: String,
    pub shared_from: String,
    pub endpoint: String,
    pub expires_at: Option<u64>,
    pub already_joined: bool,
}

#[tauri::command]
pub async fn env_join_preview(app: AppHandle, link: String) -> Result<EnvJoinPreview, String> {
    let _ = (app, link);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_join(app: AppHandle, link: String, name: Option<String>) -> Result<EnvHost, String> {
    let _ = (app, link, name);
    Err("Not built yet".into())
}
