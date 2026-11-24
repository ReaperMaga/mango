mod agent_proc;
mod attachments;
mod agents;
mod auth;
mod bin;
mod browser;
mod browser_mcp;
mod browser_remote;
mod chats;
mod chats_remote;
mod env_files;
mod envs;
mod file_ops;
mod files;
mod git;
mod github;
mod gitlab;
mod gitlab_items;
mod hosting;
mod gitlab_releases;
mod images;
mod lsp;
mod mcp;
mod notify;
mod plastic;
mod plugins;
mod projects;
mod releases;
mod pty;
mod setup;
mod shells;
mod trash_bin;
mod updater;
mod vcs;
mod voice;
mod windows;

use tauri::webview::{PageLoadEvent, PermissionKind, PermissionResponse};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = windows::with_quit_item(builder);
    builder
        // First: a second Mango (started by a mango:// link on Windows and Linux) hands its
        // arguments to this one (through the deep-link plugin, see `envs::join`) and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| envs::join::focus_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // Voice input records in the webview. Mango loads only its own pages, and recording
        // starts only when the user presses the microphone, so grant it without a second prompt
        // (WebKitGTK would otherwise deny it outright). Only for Mango's own views (`main`, `w-<n>`):
        // pages in the browser (`browser-*` webviews) get the webview's default answer.
        .on_permission_request(|webview, kind| match kind {
            PermissionKind::Microphone if windows::is_mango_window(webview.label()) => PermissionResponse::Allow,
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
        .manage(lsp::LspState::default())
        .manage(windows::CloseState::default())
        .manage(mcp::McpState::default())
        .manage(plugins::PluginsState::default())
        .manage(browser_remote::RemoteBrowserState::default())
        .setup(|app| {
            envs::join::setup_deep_link(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            lsp::on_window_event(window, event);
            windows::on_event(window, event);
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                lsp::on_page_started(webview);
                windows::on_page_started(webview);
            }
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
            plugins::plugins_list,
            plugins::plugins_probe,
            plugins::plugins_install,
            plugins::plugins_add_local,
            plugins::plugins_set_enabled,
            plugins::plugins_remove,
            plugins::plugins_check_updates,
            plugins::plugins_update,
            plugins::plugins_read,
            plugins::plugins_asset,
            plugins::plugins_catalog,
            plugins::plugins_dir,
            plugins::plugins_reveal,
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
            agent_proc::agent_reconnect_now,
            attachments::attachment_save,
            attachments::attachment_import,
            attachments::attachment_read,
            attachments::attachment_put_remote,
            images::chat_image,
            notify::notify,
            chats::chats_load,
            chats::chats_save,
            chats_remote::chats_remote_list,
            chats_remote::chats_remote_fetch,
            chats_remote::chats_remote_put,
            chats_remote::chats_remote_remove,
            auth::agent_auth_status,
            auth::agent_logout,
            setup::setup_check,
            setup::setup_install,
            lsp::lsp_servers,
            lsp::lsp_folder,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_install,
            vcs::git_status,
            vcs::git_diff,
            vcs::git_base,
            vcs::git_stage,
            vcs::git_unstage,
            vcs::git_discard,
            vcs::git_commit,
            vcs::git_fetch,
            vcs::git_pull,
            vcs::git_push,
            vcs::git_log,
            vcs::git_graph,
            vcs::git_commit_show,
            vcs::git_commit_diff,
            vcs::git_branches,
            vcs::git_checkout,
            vcs::git_checkout_commit,
            vcs::git_init,
            vcs::git_branch_list,
            vcs::git_branch_create,
            vcs::git_checkout_remote,
            vcs::git_merge,
            vcs::git_merge_preview,
            vcs::git_rebase,
            vcs::git_branch_rename,
            vcs::git_branch_delete,
            vcs::git_worktrees,
            vcs::git_worktree_add,
            vcs::git_worktree_remove,
            vcs::git_ahead,
            plastic::reviews::plastic_reviews,
            plastic::reviews::plastic_review_create,
            vcs::vcs_locks,
            vcs::vcs_lock,
            vcs::vcs_unlock,
            plastic::shelves::vcs_shelves,
            plastic::shelves::vcs_shelve,
            plastic::shelves::vcs_shelve_apply,
            plastic::shelves::vcs_shelve_delete,
            github::gh_item,
            github::gh_open_items,
            github::gh_repo_link,
            github::gh_merge,
            github::gh_pr_create,
            github::gh_job,
            gitlab::gitlab_hosts,
            gitlab::gitlab_hosts_save,
            hosting::hosting_status,
            hosting::hosting_login,
            hosting::hosting_logout,
            releases::gh_releases,
            releases::gh_tag_run,
            releases::gh_run,
            releases::gh_run_action,
            files::fs_list_dir,
            files::fs_read_file,
            files::fs_read_bytes,
            files::fs_write_file,
            files::fs_create_file,
            files::fs_delete_file,
            file_ops::fs_create_dir,
            file_ops::fs_rename,
            file_ops::fs_duplicate,
            file_ops::fs_delete,
            file_ops::fs_reveal,
            env_files::env_files,
            env_files::env_gitignore_add,
            updater::update_check,
            updater::update_download,
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
            envs::hosts::env_ping,
            envs::incus::env_instances,
            envs::incus::env_instance_action,
            envs::incus::env_create,
            envs::incus::env_rename,
            envs::incus::env_resize,
            envs::server::env_server_setup,
            envs::recipes::env_components,
            envs::recipes::env_install,
            envs::recipes::env_versions,
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
            mcp::mcp_servers,
            mcp::mcp_servers_save,
            windows::window_open,
            windows::window_focus,
            windows::window_list,
            windows::window_at,
            windows::window_alone,
            windows::window_close_heard,
            windows::window_close_answer,
            windows::window_unsaved,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mango")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
                app.state::<agent_proc::AgentProcState>().kill_all();
                app.state::<lsp::LspState>().kill_all();
                app.state::<envs::remote::DesktopState>().kill_all();
                app.state::<browser_remote::RemoteBrowserState>().kill_all();
            }
        });
}
