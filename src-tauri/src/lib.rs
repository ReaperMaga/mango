mod agent_proc;
mod attachments;
mod agents;
mod auth;
mod bin;
mod browser;
mod browser_mcp;
mod browser_remote;
mod chats;
mod env_files;
mod envs;
mod files;
mod git;
mod github;
mod images;
mod plastic;
mod projects;
mod pty;
mod setup;
mod shells;
mod updater;
mod vcs;
mod voice;

use tauri::webview::{PageLoadEvent, PermissionKind, PermissionResponse};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First: a second Mango (started by a mango:// link on Windows and Linux) hands its
        // arguments to this one (through the deep-link plugin, see `envs::join`) and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| envs::join::focus_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Voice input records in the webview. Mango loads only its own pages, and recording
        // starts only when the user presses the microphone, so grant it without a second prompt
        // (WebKitGTK would otherwise deny it outright). Only for Mango's own view: pages in the
        // browser (`browser-*` webviews) get the webview's default answer.
        .on_permission_request(|webview, kind| match kind {
            PermissionKind::Microphone if webview.label() == "main" => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .manage(pty::PtyState::default())
        .manage(agent_proc::AgentProcState::default())
        .manage(projects::ProjectsState::default())
        .manage(updater::UpdaterState::default())
        .manage(voice::VoiceState::default())
        .manage(envs::hosts::EnvsState::default())
        .manage(envs::remote::DesktopState::default())
        .manage(envs::join::JoinLinkState::default())
        .manage(browser::BrowserState::default())
        .manage(chats::ChatsState::default())
        .manage(browser_remote::RemoteBrowserState::default())
        .setup(|app| {
            envs::join::setup_deep_link(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished && webview.label() == "main" {
                envs::join::page_loaded(webview.app_handle());
            }
        })
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
            attachments::attachment_save,
            attachments::attachment_import,
            attachments::attachment_read,
            images::chat_image,
            chats::chats_load,
            chats::chats_save,
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
            vcs::git_worktrees,
            vcs::git_worktree_add,
            vcs::git_worktree_remove,
            vcs::git_ahead,
            plastic::reviews::plastic_reviews,
            plastic::reviews::plastic_review_create,
            github::gh_item,
            github::gh_merge,
            github::gh_pr_create,
            github::gh_job,
            files::fs_list_dir,
            files::fs_read_file,
            files::fs_read_bytes,
            files::fs_write_file,
            files::fs_create_file,
            files::fs_delete_file,
            env_files::env_files,
            env_files::env_gitignore_add,
            updater::update_check,
            updater::update_install,
            voice::voice_models,
            voice::voice_download,
            voice::voice_download_cancel,
            voice::voice_delete,
            voice::voice_transcribe,
            envs::hosts::env_hosts,
            envs::hosts::env_host_save,
            envs::hosts::env_host_remove,
            envs::hosts::env_probe,
            envs::incus::env_instances,
            envs::incus::env_instance_action,
            envs::incus::env_create,
            envs::incus::env_rename,
            envs::incus::env_resize,
            envs::server::env_server_setup,
            envs::recipes::env_components,
            envs::recipes::env_install,
            envs::remote::env_shell,
            envs::remote::env_login,
            envs::remote::env_prepare_dir,
            envs::remote::env_list_dir,
            envs::remote::env_desktop_open,
            envs::remote::env_desktop_close,
            envs::shares::env_shares,
            envs::shares::env_share_create,
            envs::shares::env_share_revoke,
            envs::join::env_join_preview,
            envs::join::env_join,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_navigate,
            browser::browser_go,
            browser::browser_devtools,
            browser::browser_close,
            browser::browser_reset,
            browser::browser_screenshot,
            browser_mcp::browser_mcp,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mango")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
                app.state::<agent_proc::AgentProcState>().kill_all();
                app.state::<envs::remote::DesktopState>().kill_all();
                app.state::<browser_remote::RemoteBrowserState>().kill_all();
            }
        });
}
