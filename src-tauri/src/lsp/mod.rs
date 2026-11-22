//! The language server bridge (`lsp_*`, `lsp://*`).
//!
//! The frontend speaks LSP (`app/lsp/`); this starts the server, moves framed JSON-RPC messages
//! both ways and makes sure it ends. Which program runs is decided here (`servers.rs`, `resolve.rs`),
//! never by the webview or the project. A session belongs to the window that started it: only that
//! window hears it or can talk to it, and it ends when that window closes or reloads.

mod folder;
mod framing;
mod resolve;
mod servers;
mod session;
mod tree;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview, Window, WindowEvent};

use crate::git::blocking;
use crate::setup::this_os;
use resolve::{Root, Search};
use session::{Event, Session};

/// Servers one window may have at a time, the starting ones included.
const MAX_PER_WINDOW: usize = 32;
/// How many ids are remembered to tell an early `lsp_stop` from a late one.
const MAX_REMEMBERED: usize = 128;

struct Entry {
    owner: String,
    /// Tells this session from a later one with the same id.
    token: u64,
    /// `None` while it is starting.
    session: Option<Arc<Session>>,
}

#[derive(Default)]
struct Sessions {
    /// Mango is exiting: nothing starts any more.
    closed: bool,
    next: u64,
    by_id: HashMap<String, Entry>,
    /// `(window, id)` of stops for ids not seen yet: they can overtake an async `lsp_start`.
    stopped_early: VecDeque<(String, String)>,
    /// `(window, id)` of sessions that ended by themselves: stopping one is not an early stop.
    ended: VecDeque<(String, String)>,
    /// By window and folder: the project a server there belongs to, and that folder's identity when
    /// the user allowed them (`lsp_folder`).
    allowed: HashMap<(String, String), Allowed>,
}

#[derive(Debug, Clone)]
struct Allowed {
    project: String,
    folder: String,
}

/// The last word before a server starts, as the page's answer can be from before the folder was
/// deleted and made again.
fn check_consent(root: &str, allowed: Option<&Allowed>) -> Result<(), String> {
    let same = allowed.is_some_and(|a| consent_folder(root, &a.project).is_some_and(|now| now == a.folder));
    same.then_some(()).ok_or_else(|| "Language servers need your permission for this folder again.".to_string())
}

/// The folder whose consent holds in `root`: `project`'s, where `root` is that or, now, a linked
/// worktree of it. Never just because `root` sits where a worktree of it was.
fn consent_folder(root: &str, project: &str) -> Option<String> {
    (root == project || folder::is_worktree_of(root, project)).then(|| folder::id(project)).flatten()
}

fn remember(list: &mut VecDeque<(String, String)>, owner: &str, id: &str) {
    list.push_back((owner.to_string(), id.to_string()));
    if list.len() > MAX_REMEMBERED {
        list.pop_front();
    }
}

impl Sessions {
    fn reserve(&mut self, owner: &str, id: &str) -> Result<u64, String> {
        if self.closed {
            return Err("Mango is closing.".into());
        }
        let this = |(o, i): &(String, String)| o == owner && i == id;
        if let Some(at) = self.stopped_early.iter().position(this) {
            self.stopped_early.remove(at);
            return Err("The language server was stopped before it started.".into());
        }
        if self.by_id.contains_key(id) {
            return Err("A language server with this id is already running.".into());
        }
        if self.by_id.values().filter(|e| e.owner == owner).count() >= MAX_PER_WINDOW {
            return Err("Too many language servers are running in this window. Close some projects, then try again.".into());
        }
        self.ended.retain(|e| !this(e));
        self.next += 1;
        self.by_id.insert(id.to_string(), Entry { owner: owner.to_string(), token: self.next, session: None });
        Ok(self.next)
    }

    /// False when it was stopped, or its window went, while it was starting.
    fn attach(&mut self, id: &str, token: u64, session: &Arc<Session>) -> bool {
        match self.by_id.get_mut(id) {
            Some(entry) if entry.token == token => {
                entry.session = Some(session.clone());
                true
            }
            _ => false,
        }
    }

    fn allow(&mut self, owner: &str, root: &str, allowed: Option<Allowed>) {
        let key = (owner.to_string(), root.to_string());
        match allowed {
            Some(allowed) => self.allowed.insert(key, allowed),
            None => self.allowed.remove(&key),
        };
    }

    fn allowed(&self, owner: &str, root: &str) -> Option<Allowed> {
        self.allowed.get(&(owner.to_string(), root.to_string())).cloned()
    }

    fn forget(&mut self, id: &str, token: u64) {
        if self.by_id.get(id).is_some_and(|e| e.token == token) {
            if let Some(entry) = self.by_id.remove(id) {
                remember(&mut self.ended, &entry.owner, id);
            }
        }
    }

    fn session(&self, owner: &str, id: &str) -> Option<Arc<Session>> {
        self.by_id.get(id).filter(|e| e.owner == owner)?.session.clone()
    }

    /// The session to stop. One still starting is forgotten instead, so it never begins.
    fn stop(&mut self, owner: &str, id: &str) -> Option<Arc<Session>> {
        match self.by_id.get(id) {
            Some(entry) if entry.owner != owner => None,
            // It stays listed until it has ended, so exiting Mango still kills one that is stopping.
            Some(Entry { session: Some(session), .. }) => Some(session.clone()),
            Some(_) => {
                self.by_id.remove(id);
                remember(&mut self.ended, owner, id);
                None
            }
            None => {
                if !self.ended.iter().any(|(o, i)| o == owner && i == id) {
                    remember(&mut self.stopped_early, owner, id);
                }
                None
            }
        }
    }

    /// The page in window `owner` is gone: its running sessions, and an end to its starting ones.
    fn page_gone(&mut self, owner: &str) -> Vec<Arc<Session>> {
        self.stopped_early.retain(|(o, _)| o != owner);
        self.ended.retain(|(o, _)| o != owner);
        self.by_id.retain(|_, e| e.owner != owner || e.session.is_some());
        self.by_id.values().filter(|e| e.owner == owner).filter_map(|e| e.session.clone()).collect()
    }

    /// Mango exits: every session there is, and no more.
    fn close(&mut self) -> Vec<Arc<Session>> {
        self.closed = true;
        self.by_id.drain().filter_map(|(_, entry)| entry.session).collect()
    }
}

#[derive(Default)]
pub struct LspState {
    sessions: Mutex<Sessions>,
}

impl LspState {
    fn lock(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Kill every server's tree now; used when the app exits.
    pub fn kill_all(&self) {
        let sessions = self.lock().close();
        for session in sessions {
            session.kill();
        }
    }

    fn page_gone(&self, owner: &str) {
        let sessions = self.lock().page_gone(owner);
        for session in sessions {
            session.stop();
        }
    }
}

/// A page began loading (from `lib.rs`): what the one before it started has nobody left. Only
/// Mango's own pages count, not a browser tab's.
pub fn on_page_started(webview: &Webview) {
    if crate::windows::is_mango_window(webview.label()) {
        webview.state::<LspState>().page_gone(webview.label());
    }
}

/// A window is gone (from `lib.rs`). Closing the main window may only hide it: that is not this.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) && crate::windows::is_mango_window(window.label()) {
        window.state::<LspState>().page_gone(window.label());
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServer {
    id: &'static str,
    name: &'static str,
    languages: &'static [&'static str],
    installed: bool,
    path: Option<String>,
    install: Option<String>,
    help_url: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStarted {
    root: String,
    pid: u32,
}

#[derive(Clone, Serialize)]
struct MessageEvent<'a> {
    id: &'a str,
    message: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent<'a> {
    id: &'a str,
    code: Option<i32>,
    stderr: String,
}

fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b));
    ok.then_some(()).ok_or_else(|| "Bad language server id.".to_string())
}

fn list_servers(search: &Search) -> Vec<LspServer> {
    let find = |bin: &str| search.first(bin);
    servers::SERVERS
        .iter()
        .map(|server| {
            let found = search.find(server);
            LspServer {
                id: server.id,
                name: server.name_of(found.as_ref().map(|(program, _)| *program)),
                languages: server.languages,
                installed: found.is_some(),
                path: found.map(|(_, path)| path.to_string_lossy().into_owned()),
                install: servers::plan_for(server, this_os(), &find).map(|plan| plan.display),
                help_url: server.help_url,
            }
        })
        .collect()
}

/// `roots`: the open projects, whose own programs never count as installed.
#[tauri::command]
pub async fn lsp_servers(roots: Option<Vec<String>>) -> Result<Vec<LspServer>, String> {
    blocking(move || Ok(list_servers(&Search::system_outside(&roots.unwrap_or_default())))).await
}

/// Which folder `project` is now, whose consent `root` goes by (none: `root` is no linked worktree
/// of it, or there is no such folder on this computer). `allowed` is the identity the user allowed
/// language servers for, if they did: servers start in `root` only while both hold.
#[tauri::command]
pub async fn lsp_folder(
    webview: Webview,
    state: State<'_, LspState>,
    root: String,
    project: String,
    allowed: Option<String>,
) -> Result<Option<String>, String> {
    let owner = webview.label();
    if !crate::windows::is_mango_window(owner) {
        return Err("Only Mango's own windows can allow language servers.".into());
    }
    state.lock().allow(owner, &root, allowed.map(|folder| Allowed { project: project.clone(), folder }));
    blocking(move || Ok(consent_folder(&root, &project))).await
}

#[tauri::command]
pub async fn lsp_start(
    webview: Webview,
    state: State<'_, LspState>,
    id: String,
    root: String,
    server: String,
) -> Result<LspStarted, String> {
    check_id(&id)?;
    let known = servers::by_id(&server)?;
    let owner = webview.label().to_string();
    if !crate::windows::is_mango_window(&owner) {
        return Err("Only Mango's own windows can start language servers.".into());
    }
    // Before the first await, so a stop or a reload from here on finds it.
    let (token, allowed) = {
        let mut sessions = state.lock();
        (sessions.reserve(&owner, &id)?, sessions.allowed(&owner, &root))
    };

    let app = webview.app_handle().clone();
    let key = id.clone();
    let started = blocking(move || {
        check_consent(&root, allowed.as_ref())?;
        start(app, owner, key, token, known, &root)
    })
    .await;
    if started.is_err() {
        state.lock().forget(&id, token);
    }
    started
}

fn start(
    app: AppHandle,
    owner: String,
    id: String,
    token: u64,
    server: &'static servers::Server,
    root: &str,
) -> Result<LspStarted, String> {
    let root = Root::open(root)?;
    let started = LspStarted { root: root.real.to_string_lossy().into_owned(), pid: std::process::id() };
    let search = Search::system(Some(&root));
    let (session, io) = spawn_server(&search, server, &root)?;
    if !app.state::<LspState>().lock().attach(&id, token, &session) {
        session.abandon(io);
        return Err("The language server was stopped before it started.".into());
    }
    session.begin(io, move |event| emit(&app, &owner, &id, token, event));
    Ok(started)
}

fn spawn_server(search: &Search, server: &servers::Server, root: &Root) -> Result<(Arc<Session>, session::Io), String> {
    let (program, path) = search.find(server).ok_or_else(|| {
        format!(
            "{} was not found outside the project. Install it, then try again: Mango never runs a language server from the project's own folders.",
            server.name
        )
    })?;
    let name = server.name_of(Some(program));
    let cmd = search.launch(program, path, root).command(search)?;
    Session::spawn(cmd).map_err(|e| format!("Could not start {name}: {e}"))
}

/// To the owning window only. `on()` in useBackend.ts listens to `lsp://*` with its own label as
/// target: a listener without one would get every event, whatever it was sent to.
fn emit(app: &AppHandle, owner: &str, id: &str, token: u64, event: Event) {
    let to = EventTarget::webview(owner);
    match event {
        Event::Message(message) => {
            let _ = app.emit_to(to, "lsp://message", MessageEvent { id, message });
        }
        Event::Exit { code, stderr } => {
            if let Some(state) = app.try_state::<LspState>() {
                state.lock().forget(id, token);
            }
            let _ = app.emit_to(to, "lsp://exit", ExitEvent { id, code, stderr });
        }
    }
}

/// Not async, unlike other commands: those each run as a task of their own, which would let one
/// message overtake another. This only puts it in a queue; the session's own thread writes.
#[tauri::command]
pub fn lsp_send(webview: Webview, state: State<'_, LspState>, id: String, message: String) -> Result<(), String> {
    let session = state.lock().session(webview.label(), &id);
    session.ok_or("The language server is no longer running.")?.send(message)
}

/// Not async for the same reason (it must not overtake the last messages). Returns at once; the end
/// is `lsp://exit`.
#[tauri::command]
pub fn lsp_stop(webview: Webview, state: State<'_, LspState>, id: String) -> Result<(), String> {
    check_id(&id)?;
    let session = state.lock().stop(webview.label(), &id);
    if let Some(session) = session {
        session.stop();
    }
    Ok(())
}

/// What the PTY runs for a plan.
struct Installer {
    argv: Vec<String>,
    env: Vec<(&'static str, String)>,
}

/// The program as found here, never a name looked up again, with the search's PATH: installers look
/// up their own tools (npm's shim looks for node, npm runs node again for a package's scripts).
fn installer(search: &Search, plan: &crate::setup::Plan) -> Option<Installer> {
    let (name, args) = plan.argv.split_first()?;
    let program = search.first(name)?.to_str()?.to_string();
    let mut env: Vec<(&'static str, String)> = plan.env.iter().map(|(key, value)| (*key, value.to_string())).collect();
    env.push((resolve::NO_CWD_SEARCH, "1".into()));
    env.push(("PATH", search.path_var().ok()?.into_string().ok()?));
    let mut argv = vec![program.clone()];
    // npm is a .cmd here, and the PTY's quoting is not cmd.exe's: so the command line names only a
    // variable, which holds the path in quotes, and cmd expands it just the once.
    #[cfg(windows)]
    if resolve::is_batch(std::path::Path::new(&program)) {
        argv = vec![resolve::cmd_exe().to_str()?.to_string()];
        argv.extend(["/d", "/e:on", "/v:off", "/c"].map(String::from));
        argv.push(format!("%{}%", resolve::SHIM_VAR));
        env.push((resolve::SHIM_VAR, format!("\"{program}\"")));
    }
    argv.extend(args.iter().cloned());
    Some(Installer { argv, env })
}

/// Run a server's installer in a terminal. Returns the pty id, as `setup_install` does.
#[tauri::command]
pub async fn lsp_install(app: AppHandle, server: String, cols: u16, rows: u16, roots: Option<Vec<String>>) -> Result<String, String> {
    let server = servers::by_id(&server)?;
    blocking(move || {
        let search = Search::system_outside(&roots.unwrap_or_default());
        let find = |bin: &str| search.first(bin);
        let cannot = || format!("Mango can't install {} on this computer. Follow its install page instead.", server.name);
        let plan = servers::plan_for(server, this_os(), &find).ok_or_else(cannot)?;
        let Installer { argv, env } = installer(&search, &plan).ok_or_else(cannot)?;
        let env: Vec<(&str, &str)> = env.iter().map(|(key, value)| (*key, value.as_str())).collect();
        let state = app.state::<crate::pty::PtyState>();
        crate::pty::start(app.clone(), &state, None, cols, rows, Some(argv), &env)
    })
    .await
}
