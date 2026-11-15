mod agent_proc;
mod agents;
mod auth;
mod bin;
mod git;
mod projects;
mod pty;
mod shells;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(pty::PtyState::default())
        .manage(agent_proc::AgentProcState::default())
        .manage(projects::ProjectsState::default())
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
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_log,
            git::git_branches,
            git::git_checkout,
            git::git_init,
            git::git_branch_list,
            git::git_branch_create,
            git::git_checkout_remote,
            git::git_merge,
            git::git_rebase,
            git::git_branch_rename,
            git::git_branch_delete,
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
