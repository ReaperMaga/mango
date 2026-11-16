//! The browser: web pages in tabs beside the chats, for the user and for the agents.
//!
//! Each browser is a native child webview (label `browser-<id>`) laid over the main window
//! where the frontend's browser pane leaves room for it; the frontend keeps its bounds in step
//! and hides it whenever its tab is not on screen or an HTML overlay (menu, dialog) would end up
//! underneath it. Pages are untrusted:
//! - only `http(s)` pages and `about:blank` load, never Mango's own UI (`tauri://`, the dev
//!   server) or local files, checked on every navigation and again when a page has loaded;
//! - Tauri refuses Mango's commands to remote origins (no capability names one), so a page
//!   cannot reach the backend;
//! - new windows open in the same browser, downloads are refused, and permission requests
//!   (microphone, camera, …) are left to the webview's default, which is to deny.
//!
//! Agents drive a browser through `browser_mcp` (the MCP server in `browser_mcp.rs`): it calls
//! [`run_script`] and friends here. Results come back through `eval_with_callback`, which needs
//! no IPC from the page.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

use crate::git::blocking;

/// Where a browser sits, in CSS pixels of the main window.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A page as the frontend sees it (`browser://state`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageState {
    pub id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
}

/// An agent asks for a browser for its chat (`browser://agent-open`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentOpen {
    id: String,
    thread_id: String,
    url: String,
}

#[derive(Default)]
pub struct BrowserState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Every open browser's page, by id.
    pages: HashMap<String, Page>,
    /// The browser an agent opened for a chat (root thread id → browser id).
    agent_tabs: HashMap<String, String>,
    pub(crate) mcp: Option<crate::browser_mcp::Server>,
}

#[derive(Default, Clone)]
struct Page {
    state: PageState,
    /// The project the browser belongs to: in a remote environment, local addresses are its own.
    project: String,
    /// Counts loads that started, so a caller can wait for the one its action caused.
    loads_started: u64,
}

impl BrowserState {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut inner)
    }

    pub(crate) fn with_mcp<T>(&self, f: impl FnOnce(&mut Option<crate::browser_mcp::Server>) -> T) -> T {
        self.with(|i| f(&mut i.mcp))
    }
}

pub(crate) fn label(id: &str) -> String {
    format!("browser-{id}")
}

fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err("Invalid browser id".into())
    }
}

fn webview(app: &AppHandle, id: &str) -> Result<Webview, String> {
    check_id(id)?;
    app.get_webview(&label(id)).ok_or_else(|| "That browser tab is closed.".to_string())
}

/* ---------- which pages may load ---------- */

/// What a person or agent typed, as a URL: `localhost:3000` and other local hosts get
/// `http://`, anything else without a scheme gets `https://`.
pub(crate) fn normalize_url(input: &str) -> Result<Url, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("No address given.".into());
    }
    if text == "about:blank" {
        return Url::parse(text).map_err(|e| e.to_string());
    }
    let has_scheme = text.split_once("://").is_some_and(|(s, _)| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)));
    let full = if has_scheme {
        text.to_string()
    } else {
        let host = text.split(['/', '?', '#']).next().unwrap_or("");
        let bare = host.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host }).unwrap_or(host);
        let local = matches!(bare, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]") || bare.ends_with(".localhost");
        format!("{}://{text}", if local { "http" } else { "https" })
    };
    Url::parse(&full).map_err(|_| format!("\"{text}\" is not a web address."))
}

/// Pages a browser may show: http(s) and about:blank, but none of Mango's own.
fn allowed(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "http" | "https" => {
            let host = url.host_str().unwrap_or("").to_ascii_lowercase();
            // Mango's UI and IPC on Windows (`http://tauri.localhost`, `http://ipc.localhost`).
            if matches!(host.as_str(), "tauri.localhost" | "ipc.localhost" | "asset.localhost") {
                return false;
            }
            // The dev server that serves Mango's UI in `pnpm app`: loading it would be a local origin.
            if let Some(dev) = app.config().build.dev_url.as_ref() {
                if cfg!(debug_assertions) && dev.origin() == url.origin() {
                    return false;
                }
            }
            true
        }
        _ => false,
    }
}

fn checked(app: &AppHandle, input: &str) -> Result<Url, String> {
    let url = normalize_url(input)?;
    if allowed(app, &url) {
        Ok(url)
    } else {
        Err(format!("Mango's browser only opens web pages (http and https), not {}.", url.as_str()))
    }
}

/* ---------- page events ---------- */

fn update(app: &AppHandle, id: &str, f: impl FnOnce(&mut Page)) {
    let state = app.state::<BrowserState>();
    let snapshot = state.with(|i| {
        let page = i.pages.entry(id.to_string()).or_default();
        page.state.id = id.to_string();
        f(page);
        page.state.clone()
    });
    let _ = app.emit("browser://state", snapshot);
}

fn project_of(app: &AppHandle, id: &str) -> String {
    app.state::<BrowserState>().with(|i| i.pages.get(id).map(|p| p.project.clone()).unwrap_or_default())
}

/// A typed address, checked, and routed into the project's environment when it is a local one there.
fn resolve(app: &AppHandle, project: &str, input: &str) -> Result<Url, String> {
    let url = checked(app, input)?;
    crate::browser_remote::map_url(app, project, url)
}

/// Console messages and uncaught errors, kept for the `console_logs` tool (newest 500, top frame).
const INIT_SCRIPT: &str = r#"(function () {
  if (window.top !== window) return;
  var K = Symbol.for('mango.console');
  if (window[K]) return;
  var buf = [];
  Object.defineProperty(window, K, { value: buf });
  function show(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || String(a);
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  function push(level, args) {
    try {
      buf.push({ level: level, text: Array.prototype.map.call(args, show).join(' ').slice(0, 2000), at: Date.now() });
      if (buf.length > 500) buf.splice(0, buf.length - 500);
    } catch (e) {}
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () { push(level, arguments); return orig.apply(this, arguments); };
  });
  addEventListener('error', function (e) { push('error', [e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')]); });
  addEventListener('unhandledrejection', function (e) { push('error', ['Unhandled promise rejection:', e.reason]); });
})();"#;

fn builder(app: &AppHandle, id: &str, url: Url) -> WebviewBuilder<tauri::Wry> {
    let (nav_app, load_app, title_app, window_app) = (app.clone(), app.clone(), app.clone(), app.clone());
    let (load_id, title_id, window_id) = (id.to_string(), id.to_string(), id.to_string());
    WebviewBuilder::new(label(id), WebviewUrl::External(url))
        .initialization_script(INIT_SCRIPT)
        .on_navigation(move |url| allowed(&nav_app, url))
        .on_page_load(move |webview, payload| {
            let url = payload.url().clone();
            if !allowed(&load_app, &url) {
                // Got here without a navigation we could refuse (a redirect): leave at once.
                let _ = webview.navigate(Url::parse("about:blank").expect("valid url"));
                return;
            }
            let started = payload.event() == PageLoadEvent::Started;
            let project = project_of(&load_app, &load_id);
            let shown = crate::browser_remote::display_url(&load_app, &project, url.as_str());
            update(&load_app, &load_id, |p| {
                p.state.url = shown;
                p.state.loading = started;
                if started {
                    p.loads_started += 1;
                }
            });
        })
        .on_document_title_changed(move |_, title| update(&title_app, &title_id, |p| p.state.title = title))
        // Links that open a new window (target=_blank, window.open) open here instead.
        .on_new_window(move |url, _| {
            if allowed(&window_app, &url) {
                if let Ok(w) = webview(&window_app, &window_id) {
                    let _ = w.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_download(|_, _| false)
}

/* ---------- placing the webview over the main window ---------- */

#[cfg(target_os = "linux")]
mod gtk_overlay {
    //! Tauri packs a child webview into the window's GTK box, next to (not over) Mango's own
    //! webview. Move both into a `gtk::Overlay` instead: Mango's webview as its main child and each
    //! browser as an overlay child. A child's bounds ride in its widget name (`mango-browser:x:y:w:h`)
    //! and the overlay's `get-child-position` places it exactly there (its default would stretch a
    //! webview to its natural size). Everything here runs on the main thread.
    use gtk::glib;
    use gtk::glib::translate::ToGlibPtr;
    use gtk::prelude::*;
    use std::cell::RefCell;

    thread_local! {
        static OVERLAY: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
    }

    const PREFIX: &str = "mango-browser:";

    /// GdkRectangle.
    #[repr(C)]
    struct Rect {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    }

    fn bounds_of(child: &gtk::Widget) -> Option<[i32; 4]> {
        let name = child.widget_name();
        let mut it = name.strip_prefix(PREFIX)?.split(':').map(|v| v.parse::<i32>().ok());
        Some([it.next()??, it.next()??, it.next()??, it.next()??])
    }

    /// Fill in the allocation of a browser child from its bounds; false for anything else.
    fn position(values: &[glib::Value]) -> bool {
        let (Some(child), Some(out)) = (values.get(1).and_then(|v| v.get::<gtk::Widget>().ok()), values.get(2)) else {
            return false;
        };
        let Some([x, y, width, height]) = bounds_of(&child) else { return false };
        // SAFETY: the signal's third argument is the GdkRectangle (boxed) the handler fills in.
        unsafe {
            let gvalue: *const glib::gobject_ffi::GValue = out.to_glib_none().0;
            let rect = glib::gobject_ffi::g_value_get_boxed(gvalue) as *mut Rect;
            if rect.is_null() {
                return false;
            }
            *rect = Rect { x, y, width, height };
        }
        true
    }

    /// The overlay, made on first use from the box Tauri packed `child` into: Mango's own webview
    /// (the box's other webview) becomes its main child.
    fn overlay(child: &gtk::Widget) -> Result<gtk::Overlay, String> {
        OVERLAY.with(|o| {
            if let Some(o) = o.borrow().as_ref() {
                return Ok(o.clone());
            }
            let vbox = child.parent().and_then(|p| p.downcast::<gtk::Box>().ok()).ok_or("The window has no layout box")?;
            let main = vbox
                .children()
                .into_iter()
                .find(|w| w != child && w.is::<webkit2gtk::WebView>())
                .ok_or("Mango's own view was not found")?;
            let overlay = gtk::Overlay::new();
            // The signal must always answer (glib aborts otherwise): false leaves a child to GTK.
            overlay.connect_local("get-child-position", false, |values| Some(position(values).to_value()));
            vbox.remove(&main);
            overlay.add(&main);
            vbox.pack_start(&overlay, true, true, 0);
            overlay.show_all();
            *o.borrow_mut() = Some(overlay.clone());
            Ok(overlay)
        })
    }

    /// Take `child` (a browser webview Tauri just packed into the window's box) into the overlay.
    pub fn adopt(child: &gtk::Widget) -> Result<(), String> {
        let overlay = overlay(child)?;
        if let Some(parent) = child.parent() {
            if let Ok(container) = parent.downcast::<gtk::Container>() {
                container.remove(child);
            }
        }
        overlay.add_overlay(child);
        Ok(())
    }

    pub fn place(child: &gtk::Widget, x: f64, y: f64, width: f64, height: f64) {
        let px = |v: f64| v.round().clamp(0.0, 100_000.0) as i32;
        child.set_widget_name(&format!("{PREFIX}{}:{}:{}:{}", px(x), px(y), px(width).max(1), px(height).max(1)));
        if let Some(parent) = child.parent() {
            parent.queue_resize();
        }
    }
}

fn place(app: &AppHandle, webview: &Webview, bounds: Bounds, visible: bool) -> Result<(), String> {
    let (w, h) = (bounds.width.max(1.0), bounds.height.max(1.0));
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        webview
            .with_webview(move |pw| {
                let widget: gtk::Widget = gtk::prelude::Cast::upcast(pw.inner());
                gtk_overlay::place(&widget, bounds.x, bounds.y, w, h);
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        webview
            .set_bounds(tauri::Rect {
                position: LogicalPosition::new(bounds.x, bounds.y).into(),
                size: LogicalSize::new(w, h).into(),
            })
            .map_err(|e| e.to_string())?;
    }
    if visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

fn create(app: &AppHandle, id: &str, project: &str, url: Url, bounds: Bounds, visible: bool) -> Result<(), String> {
    let window = app.get_window("main").ok_or("Mango's main window is gone.")?;
    let size = LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0));
    let shown = crate::browser_remote::display_url(app, project, url.as_str());
    update(app, id, |p| {
        p.project = project.to_string();
        p.state.url = shown;
        p.state.loading = true;
    });
    let webview = window
        .add_child(builder(app, id, url), LogicalPosition::new(bounds.x, bounds.y), size)
        .map_err(|e| format!("Could not open the browser: {e}"))?;

    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = mpsc::channel();
        webview
            .with_webview(move |pw| {
                let child: gtk::Widget = gtk::prelude::Cast::upcast(pw.inner());
                let _ = tx.send(gtk_overlay::adopt(&child));
            })
            .map_err(|e| e.to_string())?;
        if let Err(e) = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| Err("no answer".into())) {
            let _ = webview.close();
            return Err(format!("Could not place the browser in the window: {e}"));
        }
    }

    place(app, &webview, bounds, visible)
}

/* ---------- commands for the frontend ---------- */

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    id: String,
    url: String,
    bounds: Bounds,
    visible: bool,
    project_path: Option<String>,
) -> Result<(), String> {
    check_id(&id)?;
    let project = project_path.unwrap_or_default();
    blocking(move || {
        let url = resolve(&app, &project, &url)?;
        match app.get_webview(&label(&id)) {
            Some(w) => {
                place(&app, &w, bounds, visible)?;
                w.navigate(url).map_err(|e| e.to_string())
            }
            None => create(&app, &id, &project, url, bounds, visible),
        }
    })
    .await
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, id: String, bounds: Bounds, visible: bool) -> Result<(), String> {
    let w = webview(&app, &id)?;
    blocking(move || place(&app, &w, bounds, visible)).await
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let w = webview(&app, &id)?;
    blocking(move || {
        let url = resolve(&app, &project_of(&app, &id), &url)?;
        w.navigate(url).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn browser_go(app: AppHandle, id: String, action: String) -> Result<(), String> {
    go(&webview(&app, &id)?, &action)
}

fn go(w: &Webview, action: &str) -> Result<(), String> {
    match action {
        "back" => w.eval("history.back()"),
        "forward" => w.eval("history.forward()"),
        "reload" => w.reload(),
        "stop" => w.eval("window.stop()"),
        _ => return Err(format!("Unknown browser action \"{action}\"")),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_devtools(app: AppHandle, id: String) -> Result<(), String> {
    webview(&app, &id)?.open_devtools();
    Ok(())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    check_id(&id)?;
    app.state::<BrowserState>().with(|i| {
        i.pages.remove(&id);
        i.agent_tabs.retain(|_, b| *b != id);
    });
    if let Some(w) = app.get_webview(&label(&id)) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_reset(app: AppHandle) -> Result<(), String> {
    app.state::<BrowserState>().with(|i| {
        i.pages.clear();
        i.agent_tabs.clear();
    });
    for (name, w) in app.webviews() {
        if name.starts_with("browser-") {
            let _ = w.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_screenshot(app: AppHandle, id: String) -> Result<String, String> {
    use base64::Engine as _;
    let w = webview(&app, &id)?;
    let png = blocking(move || screenshot(&w)).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/* ---------- for the agents (browser_mcp.rs) ---------- */

/// The browser an agent already has for this chat, if its tab is still open.
pub(crate) fn agent_browser(app: &AppHandle, thread: &str) -> Option<String> {
    let id = app.state::<BrowserState>().with(|i| i.agent_tabs.get(thread).cloned())?;
    app.get_webview(&label(&id)).map(|_| id)
}

/// Ask the frontend for a browser tab for this chat and wait until its webview exists.
pub(crate) fn open_for_agent(app: &AppHandle, thread: &str, url: &Url) -> Result<String, String> {
    // The frontend opens it with the chat's project, which routes local addresses (browser_open).
    let id = format!("agent-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    app.state::<BrowserState>().with(|i| i.agent_tabs.insert(thread.to_string(), id.clone()));
    app.emit("browser://agent-open", AgentOpen { id: id.clone(), thread_id: thread.to_string(), url: url.to_string() })
        .map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(15);
    while Instant::now() < until {
        if app.get_webview(&label(&id)).is_some() {
            return Ok(id);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    app.state::<BrowserState>().with(|i| i.agent_tabs.remove(thread));
    Err("Mango could not open a browser tab for this chat. Is the chat's project open in Mango?".into())
}

pub(crate) fn page(app: &AppHandle, id: &str) -> PageState {
    app.state::<BrowserState>().with(|i| i.pages.get(id).map(|p| p.state.clone()).unwrap_or_default())
}

pub(crate) fn loads_started_pub(app: &AppHandle, id: &str) -> u64 {
    loads_started(app, id)
}

fn loads_started(app: &AppHandle, id: &str) -> u64 {
    app.state::<BrowserState>().with(|i| i.pages.get(id).map(|p| p.loads_started).unwrap_or(0))
}

pub(crate) fn navigate(app: &AppHandle, id: &str, input: &str) -> Result<(), String> {
    let w = webview(app, id)?;
    let url = resolve(app, &project_of(app, id), input)?;
    let before = loads_started(app, id);
    w.navigate(url).map_err(|e| e.to_string())?;
    wait_for_load(app, id, before, Duration::from_secs(3));
    Ok(())
}

pub(crate) fn history(app: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    let w = webview(app, id)?;
    let before = loads_started(app, id);
    go(&w, action)?;
    wait_for_load(app, id, before, Duration::from_millis(1500));
    Ok(())
}

/// After something that may load a page: wait (up to `start_within`) for a load to start,
/// then up to 20 seconds for it to finish. Pages that never start one return quickly.
pub(crate) fn wait_for_load(app: &AppHandle, id: &str, before: u64, start_within: Duration) {
    let started = Instant::now();
    while loads_started(app, id) == before {
        if started.elapsed() > start_within {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let until = Instant::now() + Duration::from_secs(20);
    while page(app, id).loading && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(80));
    }
    // Let scripts that run on load put the page together.
    std::thread::sleep(Duration::from_millis(250));
}

/// Evaluate `js` (an expression whose value is a string) and return that string.
fn eval_string(w: &Webview, js: String, timeout: Duration) -> Result<Option<String>, String> {
    let (tx, rx) = mpsc::channel::<String>();
    w.eval_with_callback(js, move |raw| {
        let _ = tx.send(raw);
    })
    .map_err(|e| e.to_string())?;
    let raw = rx.recv_timeout(timeout).map_err(|_| "The page did not answer in time.".to_string())?;
    // The value comes back JSON-encoded: a string is quoted, anything else (null, undefined) is not one.
    Ok(serde_json::from_str::<Value>(&raw).ok().and_then(|v| v.as_str().map(str::to_string)))
}

/// Run `body` (the body of an async function: `return` gives the result) in the page's top
/// frame and wait for its result, up to `timeout`. The result must be JSON-serialisable.
/// The page sees a short-lived global holding the result; the page is untrusted anyway.
pub(crate) fn run_script(app: &AppHandle, id: &str, body: &str, timeout: Duration) -> Result<Value, String> {
    let w = webview(app, id)?;
    let key = format!("__mango_{}", uuid::Uuid::new_v4().simple());
    let start = format!(
        r#"(function () {{
  var K = {key:?};
  function put(v) {{ try {{ window[K] = JSON.stringify(v); }} catch (e) {{ window[K] = JSON.stringify({{ error: 'The result could not be read: ' + e }}); }} }}
  try {{
    (async function () {{
{body}
    }})().then(function (v) {{ put({{ ok: v === undefined ? null : v }}); }}, function (e) {{ put({{ error: String((e && e.stack) || e) }}); }});
  }} catch (e) {{ put({{ error: String((e && e.stack) || e) }}); }}
  return 'started';
}})()"#
    );
    match eval_string(&w, start, Duration::from_secs(5))? {
        Some(s) if s == "started" => {}
        _ => return Err("The script did not run in the page (check its syntax).".into()),
    }
    let poll = format!("(function () {{ var K = {key:?}; var v = window[K]; if (v !== undefined) {{ delete window[K]; return v; }} return null; }})()");
    let until = Instant::now() + timeout;
    loop {
        if let Some(text) = eval_string(&w, poll.clone(), Duration::from_secs(5))? {
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if let Some(err) = v.get("error") {
                return Err(err.as_str().unwrap_or("The script failed.").to_string());
            }
            return Ok(v.get("ok").cloned().unwrap_or(Value::Null));
        }
        if Instant::now() > until {
            return Err("The script did not finish in time (or the page navigated away while it ran).".into());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// The page's top frame as a PNG.
#[cfg(target_os = "linux")]
pub(crate) fn screenshot(w: &Webview) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    w.with_webview(move |pw| {
        use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
        let view = pw.inner();
        view.snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, None::<&webkit2gtk::gio::Cancellable>, move |res| {
            let _ = tx.send(res.map_err(|e| e.to_string()).and_then(|surface| to_png(&surface)));
        });
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "The page did not hand over a picture in time.".to_string())?
        .map_err(|e| format!("Could not take a screenshot ({e}). The browser tab may be hidden behind another tab or a menu."))
}

/// A WebKit snapshot as PNG, scaled down so its long edge is at most 1568 px (what vision models take in).
#[cfg(target_os = "linux")]
fn to_png(surface: &cairo::Surface) -> Result<Vec<u8>, String> {
    const MAX_EDGE: f64 = 1568.0;
    let image = cairo::ImageSurface::try_from(surface.clone()).map_err(|_| "unexpected snapshot format".to_string())?;
    let (w, h) = (image.width() as f64, image.height() as f64);
    if w < 1.0 || h < 1.0 {
        return Err("the page has no size".into());
    }
    let scale = (MAX_EDGE / w.max(h)).min(1.0);
    let mut png = Vec::new();
    if scale >= 1.0 {
        image.write_to_png(&mut png).map_err(|e| e.to_string())?;
        return Ok(png);
    }
    let out = cairo::ImageSurface::create(cairo::Format::ARgb32, (w * scale).round() as i32, (h * scale).round() as i32)
        .map_err(|e| e.to_string())?;
    {
        let cr = cairo::Context::new(&out).map_err(|e| e.to_string())?;
        cr.scale(scale, scale);
        cr.set_source_surface(&image, 0.0, 0.0).map_err(|e| e.to_string())?;
        cr.paint().map_err(|e| e.to_string())?;
    }
    out.write_to_png(&mut png).map_err(|e| e.to_string())?;
    Ok(png)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn screenshot(_w: &Webview) -> Result<Vec<u8>, String> {
    Err("Screenshots of the browser work on Linux only for now. Read the page with the snapshot tool instead.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_addresses() {
        let n = |s: &str| normalize_url(s).map(|u| u.to_string());
        assert_eq!(n("localhost:3000").unwrap(), "http://localhost:3000/");
        assert_eq!(n("127.0.0.1:8080/x?y=1").unwrap(), "http://127.0.0.1:8080/x?y=1");
        assert_eq!(n("[::1]:5173").unwrap(), "http://[::1]:5173/");
        assert_eq!(n("app.localhost").unwrap(), "http://app.localhost/");
        assert_eq!(n("example.com/docs").unwrap(), "https://example.com/docs");
        assert_eq!(n("https://example.com").unwrap(), "https://example.com/");
        assert_eq!(n("about:blank").unwrap(), "about:blank");
        assert!(n("").is_err());
        // Schemes are kept as given; `allowed` refuses the ones that are not web pages.
        assert_eq!(Url::parse("file:///etc/passwd").unwrap().scheme(), "file");
        assert_eq!(n("javascript://x").unwrap().split(':').next(), Some("javascript"));
    }

    #[test]
    fn ids() {
        assert!(check_id("agent-1a2b").is_ok());
        assert!(check_id("b_3").is_ok());
        assert!(check_id("").is_err());
        assert!(check_id("../x").is_err());
        assert!(check_id(&"a".repeat(65)).is_err());
    }
}
