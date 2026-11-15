mod agent_proc;
mod agents;
mod auth;
mod bin;
mod git;
mod plastic;
mod projects;
mod pty;
mod setup;
mod shells;
mod updater;
mod vcs;
mod voice;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Voice input records in the webview. Mango loads only its own pages, and recording
        // starts only when the user presses the microphone, so grant it without a second prompt
        // (WebKitGTK would otherwise deny it outright).
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .manage(pty::PtyState::default())
        .manage(agent_proc::AgentProcState::default())
        .manage(projects::ProjectsState::default())
        .manage(updater::UpdaterState::default())
        .manage(voice::VoiceState::default())
        .invoke_handler(tauri::generate_handler![
            projects::recent_projects,
            projects::open_project,
            projects::forget_project,
            projects::create_project,
            projects::git_clone,
            projects::default_projects_dir,
            agents::detect_agents,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            shells::terminal_profiles,
            agent_proc::agent_spawn,
            agent_proc::agent_write,
            agent_proc::agent_close_stdin,
            agent_proc::agent_kill,
            auth::agent_auth_status,
            auth::agent_logout,
            setup::setup_check,
            setup::setup_install,
            vcs::git_status,
            vcs::git_diff,
            vcs::git_stage,
            vcs::git_unstage,
            vcs::git_discard,
            vcs::git_commit,
            vcs::git_fetch,
            vcs::git_pull,
            vcs::git_push,
            vcs::git_log,
            vcs::git_branches,
            vcs::git_checkout,
            vcs::git_init,
            vcs::git_branch_list,
            vcs::git_branch_create,
            vcs::git_checkout_remote,
            vcs::git_merge,
            vcs::git_rebase,
            vcs::git_branch_rename,
            vcs::git_branch_delete,
            updater::update_check,
            updater::update_install,
            voice::voice_models,
            voice::voice_download,
            voice::voice_download_cancel,
            voice::voice_delete,
            voice::voice_transcribe,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mango")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
                app.state::<agent_proc::AgentProcState>().kill_all();
            }
        });
}
