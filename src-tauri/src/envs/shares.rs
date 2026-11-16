//! Sharing an environment with a one-line link (see `token`).
//! STUB: filled in by the sharing work on this branch.

use tauri::AppHandle;

use super::token;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvShare {
    pub id: String,
    pub label: String,
    /// "public" | "tailscale"
    pub via: String,
    pub endpoint: String,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvShareLink {
    pub share: EnvShare,
    pub url: String,
}

#[tauri::command]
pub async fn env_shares(app: AppHandle, host_id: String, instance: String) -> Result<Vec<EnvShare>, String> {
    let _ = (app, host_id, instance);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_share_create(
    app: AppHandle,
    host_id: String,
    instance: String,
    label: String,
    via: String,
    expires_in_days: Option<u32>,
) -> Result<EnvShareLink, String> {
    let _ = (app, host_id, instance, label, via, expires_in_days, token::SCHEME_PREFIX);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_share_revoke(app: AppHandle, host_id: String, instance: String, share_id: String) -> Result<(), String> {
    let _ = (app, host_id, instance, share_id);
    Err("Not built yet".into())
}
