//! Instances on a master: list, create, start/stop/restart/delete.
//! STUB: filled in by the backend work on this branch.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInstance {
    pub name: String,
    /// "container" or "vm"
    pub kind: String,
    /// "running" | "stopped" | "starting" | "stopping" | "frozen" | "error" | "unknown"
    pub status: String,
    /// The image's description, e.g. "Ubuntu noble amd64 (20261101_07:42)".
    pub image: Option<String>,
    pub ipv4: Vec<String>,
    /// The instance's address on the tailnet (100.64.0.0/10), when it has joined one.
    pub tailscale_ip: Option<String>,
    pub cpus: Option<u32>,
    /// e.g. "8GiB", as `limits.memory` says
    pub memory: Option<String>,
    /// Unix ms
    pub created_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCreateInput {
    pub host_id: String,
    pub name: String,
    pub image: String,
    /// "container" or "vm"
    pub kind: String,
    pub cpus: Option<u32>,
    pub memory_gib: Option<u32>,
    pub disk_gib: Option<u32>,
    /// Component ids to install once it is up (see `recipes`).
    pub components: Vec<String>,
}

#[tauri::command]
pub async fn env_instances(app: AppHandle, host_id: String) -> Result<Vec<EnvInstance>, String> {
    let _ = (app, host_id);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_instance_action(app: AppHandle, host_id: String, instance: String, action: String) -> Result<(), String> {
    let _ = (app, host_id, instance, action);
    Err("Not built yet".into())
}

#[tauri::command]
pub async fn env_create(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    input: EnvCreateInput,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let _ = (app, state, input, cols, rows);
    Err("Not built yet".into())
}
