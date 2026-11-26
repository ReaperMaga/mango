//! Mango's windows: the main one (`main`, from tauri.conf.json) and more, labelled `w-<n>`, each
//! opened on one project or one chat (`window_open`).
//!
//! Every window loads the same page; what it shows comes from its URL's query
//! (`?window=project&path=…`, `?window=chat&thread=…&path=…`), read once at start-up
//! (`app/utils/windows.ts`). Which window holds which project or chat is the frontend's business
//! (`app/stores/windows.ts`): the backend only opens, focuses and lists windows, and says when one
//! is gone (`window://closed`). Closing a window closes that window only (see [`on_event`]).
//!
//! Closing is asked of the page, which may have files to save (`window://close`): it says that it
//! heard (`window_close_heard`) and later whether the window may go (`window_close_answer`). The
//! decision stays here, so a page that hung or crashed cannot keep its window open ([`HEARD_WITHIN`]):
//! it closes, or, when its page last said that it has unsaved text (`window_unsaved`), the user decides
//! in a dialog of the system's.
//!
//! Windows are looked up as windows (`get_window`, `windows`), never as webview windows: Tauri
//! counts a window with a browser tab (a child webview) as no webview window at all.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

const MAIN: &str = "main";
const PREFIX: &str = "w-";
/// The smallest window Mango is laid out for (tauri.conf.json says the same for the main window).
const MIN_W: f64 = 960.0;
const MIN_H: f64 = 600.0;
/// A chat window has no sidebar: it may be smaller, and starts smaller (`app/utils/windows.ts` agrees).
const CHAT_MIN_W: f64 = 640.0;
const CHAT_MIN_H: f64 = 480.0;
const CHAT_W: f64 = 880.0;
const CHAT_H: f64 = 820.0;
/// A page that did not say it heard a close within this long has stopped answering ([`Silent`]).
const HEARD_WITHIN: Duration = Duration::from_secs(5);
/// Whether the system's dialog belongs to its window and so stays above it. GTK's (Linux) has no
/// parent: raised, its window would cover it.
const DIALOG_ABOVE_WINDOW: bool = cfg!(any(windows, target_os = "macos"));
/// A hidden window that heard and still has not answered after this much more comes into view:
/// nobody could press Close on it again.
const SHOWN_AFTER: Duration = Duration::from_secs(12);
// The dialog's buttons. Enter gives the first and Esc the last: neither loses text.
const TRY_AGAIN: &str = "Try again";
const CLOSE_ANYWAY: &str = "Close without saving";
const CANCEL: &str = "Cancel";
/// The id of the menu's Quit on macOS (see [`with_quit_item`]).
const QUIT: &str = "mango-quit";

static NEXT: AtomicU32 = AtomicU32::new(1);

/// One of Mango's own windows (never a browser tab's webview).
pub fn is_mango_window(label: &str) -> bool {
    label == MAIN || label.strip_prefix(PREFIX).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Clone, Serialize)]
struct Closed {
    label: String,
}

#[derive(Clone, Serialize)]
struct Parked {}

#[derive(Clone, Serialize)]
struct Close {
    label: String,
    id: u32,
}

struct Asked {
    id: u32,
    heard: bool,
}

/// What becomes of a window whose page never heard its close.
#[derive(Debug, PartialEq)]
enum Silent {
    Go,
    /// It has unsaved text, as far as is known: only the user closes it.
    AskUser,
}

/// The user's answer to that dialog.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Choice {
    Again,
    Close,
    Stay,
}

/// Dismissed in whatever way, it stays.
fn choice(result: &MessageDialogResult) -> Choice {
    match result {
        MessageDialogResult::Custom(label) if label == TRY_AGAIN => Choice::Again,
        MessageDialogResult::Custom(label) if label == CLOSE_ANYWAY => Choice::Close,
        _ => Choice::Stay,
    }
}

/// The closes being asked of pages.
#[derive(Default)]
struct Closing {
    last: u32,
    asked: HashMap<String, Asked>,
    /// The windows with unsaved text. Only a page's own word takes one out: while a page crashed or
    /// is reloading it counts as having some, and the next page says as it starts.
    unsaved: HashSet<String>,
    /// The windows the user is being asked about.
    confirming: HashSet<String>,
    /// The main window was hidden by [`go`]: hidden also if it was minimised then.
    parked: bool,
    /// Quit was chosen: the main window closes after the others ([`quit`]).
    quitting: bool,
}

impl Closing {
    /// Close was pressed: the id to ask with, and whether it needs a deadline of its own. Pressing
    /// again before the page heard keeps the first deadline; after, the page must answer again.
    fn press(&mut self, label: &str) -> (u32, bool) {
        if let Some(asked) = self.asked.get(label).filter(|a| !a.heard) {
            return (asked.id, false);
        }
        self.last = self.last.wrapping_add(1);
        self.asked.insert(label.to_string(), Asked { id: self.last, heard: false });
        (self.last, true)
    }

    /// False: that close is not the page's to answer (any more).
    fn heard(&mut self, label: &str, id: u32) -> bool {
        let Some(asked) = self.asked.get_mut(label).filter(|a| a.id == id) else { return false };
        asked.heard = true;
        true
    }

    fn set_unsaved(&mut self, label: &str, unsaved: bool) {
        if unsaved {
            self.unsaved.insert(label.to_string());
        } else {
            self.unsaved.remove(label);
        }
    }

    /// The user answered the dialog; false when its window went meanwhile. Staying ends a Quit.
    fn decided(&mut self, label: &str, choice: Choice) -> bool {
        if !self.confirming.remove(label) {
            return false;
        }
        if choice == Choice::Stay {
            self.quitting = false;
        }
        true
    }

    /// Another page began loading: true when the one before had heard a close, which nobody answers
    /// now (that window stays). One not heard yet keeps its deadline.
    fn reloaded(&mut self, label: &str) -> bool {
        let left = self.asked.get(label).is_some_and(|a| a.heard);
        if left {
            self.asked.remove(label);
            self.quitting = false;
        }
        left
    }

    fn gone(&mut self, label: &str) {
        self.asked.remove(label);
        self.unsaved.remove(label);
        self.confirming.remove(label);
    }

    /// Whether this answer is to the close being asked; that is then over.
    fn answered(&mut self, label: &str, id: u32) -> bool {
        let current = self.asked.get(label).is_some_and(|a| a.id == id);
        if current {
            self.asked.remove(label);
        }
        current
    }

    /// The deadline passed: what becomes of the window when the page never heard. Either way that
    /// close is no longer the page's.
    fn overdue(&mut self, label: &str, id: u32) -> Option<Silent> {
        self.asked.get(label).filter(|a| a.id == id && !a.heard)?;
        self.asked.remove(label);
        if !self.unsaved.contains(label) {
            return Some(Silent::Go);
        }
        self.confirming.insert(label.to_string());
        Some(Silent::AskUser)
    }

    /// Whether this close is still waiting for its answer.
    fn waiting(&self, label: &str, id: u32) -> bool {
        self.asked.get(label).is_some_and(|a| a.id == id)
    }
}

#[derive(Default)]
pub struct CloseState {
    closing: Mutex<Closing>,
}

impl CloseState {
    // Held for one look only: window calls on the main thread can raise events that look again.
    fn lock(&self) -> MutexGuard<'_, Closing> {
        self.closing.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Percent-encode a query value: everything but unreserved characters.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn check_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        return Err("That project path cannot be opened in a window.".into());
    }
    Ok(())
}

fn check_thread(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err("That chat cannot be opened in a window.".into())
    }
}

/// The query a new window starts with: what it shows.
fn query(kind: &str, path: Option<&str>, thread: Option<&str>) -> Result<String, String> {
    if let Some(p) = path {
        check_path(p)?;
    }
    match kind {
        "project" => Ok(match path {
            Some(p) => format!("window=project&path={}", encode(p)),
            None => "window=project".to_string(),
        }),
        "chat" => {
            let thread = thread.ok_or("No chat given for the window.")?;
            check_thread(thread)?;
            let mut q = format!("window=chat&thread={}", encode(thread));
            if let Some(p) = path {
                q.push_str(&format!("&path={}", encode(p)));
            }
            Ok(q)
        }
        _ => Err(format!("Unknown kind of window \"{kind}\".")),
    }
}

fn next_label(app: &AppHandle) -> String {
    loop {
        let label = format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::SeqCst));
        if app.get_window(&label).is_none() {
            return label;
        }
    }
}

/// Open a window on a project (`kind` "project", `path` the project; none: the welcome screen) or a
/// chat (`kind` "chat", `thread_id`, and its project in `path`). `x`/`y` put its top-left corner
/// there (logical pixels on the screen), otherwise it is centred; `width`/`height` default to the
/// main window's. Settings come from the main window's config, so a new window looks like it
/// (and on macOS keeps the overlay titlebar and traffic lights). Returns the new window's label.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn window_open(
    app: AppHandle,
    kind: String,
    path: Option<String>,
    thread_id: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let q = query(&kind, path.as_deref(), thread_id.as_deref())?;
    let label = next_label(&app);
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .cloned()
        .ok_or("Mango's window settings are missing.")?;
    config.label = label.clone();
    config.url = WebviewUrl::App(format!("?{q}").into());
    let finite = |v: Option<f64>| v.filter(|v| v.is_finite());
    let (min_w, min_h) = if kind == "chat" {
        config.min_width = Some(CHAT_MIN_W);
        config.min_height = Some(CHAT_MIN_H);
        config.width = CHAT_W;
        config.height = CHAT_H;
        (CHAT_MIN_W, CHAT_MIN_H)
    } else {
        (MIN_W, MIN_H)
    };
    if let Some(w) = finite(width) {
        config.width = w.max(min_w);
    }
    if let Some(h) = finite(height) {
        config.height = h.max(min_h);
    }
    match (finite(x), finite(y)) {
        (Some(x), Some(y)) => {
            config.x = Some(x);
            config.y = Some(y);
            config.center = false;
        }
        _ => {
            config.x = None;
            config.y = None;
            config.center = true;
        }
    }
    // Windows are made on the main thread; the builder hands it over itself.
    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| format!("Could not open a window: {e}"))?
        .build()
        .map_err(|e| format!("Could not open a window: {e}"))?;
    Ok(label)
}

/// Bring one of Mango's windows to the front.
#[tauri::command]
pub async fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    if !is_mango_window(&label) {
        return Err("Unknown window.".into());
    }
    focus(&app, &label)
}

/// Bring a window into view, hidden or minimised, browser tabs in it or not.
pub fn focus(app: &AppHandle, label: &str) -> Result<(), String> {
    let w = app.get_window(label).ok_or("That window is closed.")?;
    if label == MAIN {
        app.state::<CloseState>().lock().parked = false;
    }
    let _ = w.unminimize();
    let _ = w.show();
    w.set_focus().map_err(|e| e.to_string())
}

/// The labels of Mango's open windows (browser webviews left out).
#[tauri::command]
pub async fn window_list(app: AppHandle) -> Result<Vec<String>, String> {
    let mut labels: Vec<String> = app.windows().into_keys().filter(|l| is_mango_window(l)).collect();
    labels.sort();
    Ok(labels)
}

/// A window's place on the screen, in physical pixels.
#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

/// Of `windows` (label, place), the first one holding the point, the main window first.
fn window_under(mut windows: Vec<(String, Rect)>, x: f64, y: f64) -> Option<String> {
    windows.sort_by(|a, b| (a.0 != MAIN, &a.0).cmp(&(b.0 != MAIN, &b.0)));
    windows.into_iter().find(|(_, r)| r.contains(x, y)).map(|(l, _)| l)
}

/// Another of Mango's windows under a point of the screen (`x`/`y` in the calling window's logical
/// pixels, as a pointer event's `screenX`/`screenY`), or null: where a dragged chat was let go.
/// Hidden and minimised windows are left out.
#[tauri::command]
pub async fn window_at(window: tauri::Window, x: f64, y: f64) -> Result<Option<String>, String> {
    if !x.is_finite() || !y.is_finite() {
        return Ok(None);
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let app = window.app_handle();
    let mut places = Vec::new();
    for (label, w) in app.windows() {
        if label == window.label() || !is_mango_window(&label) {
            continue;
        }
        if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
            continue;
        }
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { continue };
        places.push((label, Rect { x: pos.x as f64, y: pos.y as f64, w: size.width as f64, h: size.height as f64 }));
    }
    Ok(window_under(places, x * scale, y * scale))
}

/// Whether no other of Mango's windows stays on screen: closing this one ends the app (the main
/// window may still be there, hidden or on its way, see [`on_event`]).
#[tauri::command]
pub async fn window_alone(window: tauri::Window) -> Result<bool, String> {
    let app = window.app_handle();
    let main_leaves = app.state::<CloseState>().lock().asked.contains_key(MAIN);
    Ok(!app.windows().iter().any(|(label, w)| {
        label != window.label() && is_mango_window(label) && !(label == MAIN && main_leaves) && !is_hidden(w)
    }))
}

/// Mango's windows other than the main one and `except`.
fn others(app: &AppHandle, except: &str) -> usize {
    app.windows().keys().filter(|l| *l != MAIN && *l != except && is_mango_window(l)).count()
}

/// Minimised to the Dock (macOS) a window is not visible, and not hidden either. A parked one is
/// hidden, also when it was minimised as it was parked (it then still says it is).
fn hidden(visible: bool, minimized: bool, parked: bool) -> bool {
    !visible && (parked || !minimized)
}

fn is_hidden(window: &tauri::Window) -> bool {
    let parked = window.label() == MAIN && window.app_handle().state::<CloseState>().lock().parked;
    hidden(window.is_visible().unwrap_or(true), window.is_minimized().unwrap_or(false), parked)
}

/// Ask `label`'s page whether its window may go.
fn ask(app: &AppHandle, label: &str) {
    let confirming = app.state::<CloseState>().lock().confirming.contains(label);
    if confirming {
        // The dialog that is up decides.
        if DIALOG_ABOVE_WINDOW {
            let _ = focus(app, label);
        }
        return;
    }
    let (id, new) = app.state::<CloseState>().lock().press(label);
    let _ = app.emit_to(EventTarget::webview(label), "window://close", Close { label: label.to_string(), id });
    if !new {
        return;
    }
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(HEARD_WITHIN);
        let (handle, window) = (app.clone(), label.clone());
        // On the main thread, after whatever the page said before the deadline.
        let _ = app.run_on_main_thread(move || {
            let silent = handle.state::<CloseState>().lock().overdue(&window, id);
            match silent {
                Some(Silent::Go) => go(&handle, &window),
                Some(Silent::AskUser) => confirm_close(&handle, &window),
                None => {}
            }
        });
        std::thread::sleep(SHOWN_AFTER);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let waiting = handle.state::<CloseState>().lock().waiting(&label, id);
            if waiting && handle.get_window(&label).is_some_and(|w| is_hidden(&w)) {
                let _ = focus(&handle, &label);
            }
        });
    });
}

/// A silent page with unsaved text: the user decides, in a dialog of the system's. Showing it waits
/// for nothing, and its window (a parked one too) comes into view for it.
fn confirm_close(app: &AppHandle, label: &str) {
    let Some(window) = app.get_window(label) else { return };
    let _ = focus(app, label);
    let (handle, label) = (app.clone(), label.to_string());
    app.dialog()
        .message("This window is not responding and has changes that are not saved. Closing it now loses them.")
        .title("Close without saving?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(TRY_AGAIN.into(), CLOSE_ANYWAY.into(), CANCEL.into()))
        .parent(&window)
        .show_with_result(move |result| {
            let choice = choice(&result);
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let current = app.state::<CloseState>().lock().decided(&label, choice);
                match choice {
                    Choice::Again if current => ask(&app, &label),
                    Choice::Close if current => go(&app, &label),
                    _ => {}
                }
            });
        });
}

/// A page began loading (from `lib.rs`).
pub fn on_page_started(webview: &tauri::Webview) {
    let label = webview.label();
    if !is_mango_window(label) || !webview.state::<CloseState>().lock().reloaded(label) {
        return;
    }
    let app = webview.app_handle();
    // Nobody could press Close again on a hidden one.
    if app.get_window(label).is_some_and(|w| is_hidden(&w)) {
        let _ = focus(app, label);
    }
}

/// The window may go. The main one only hides while others are open ("parks").
fn go(app: &AppHandle, label: &str) {
    let Some(window) = app.get_window(label) else { return };
    if label == MAIN && others(app, MAIN) > 0 {
        app.state::<CloseState>().lock().parked = true;
        let _ = window.hide();
        let _ = app.emit_to(MAIN, "window://parked", Parked {});
    } else {
        let _ = window.destroy();
    }
}

/// The page heard `window://close`; false when that close is no longer its to answer. Not async: it
/// must not land after that close's deadline.
#[tauri::command]
pub fn window_close_heard(webview: tauri::Webview, state: State<'_, CloseState>, id: u32) -> Result<bool, String> {
    if !is_mango_window(webview.label()) {
        return Err("Unknown window.".into());
    }
    Ok(state.lock().heard(webview.label(), id))
}

/// Whether the page has unsaved text, said as that changes. Not async: they must land in order.
#[tauri::command]
pub fn window_unsaved(webview: tauri::Webview, state: State<'_, CloseState>, unsaved: bool) -> Result<(), String> {
    if !is_mango_window(webview.label()) {
        return Err("Unknown window.".into());
    }
    state.lock().set_unsaved(webview.label(), unsaved);
    Ok(())
}

/// The page's answer: `close`, or stay (it shows why, so the window comes into view). Not async,
/// to decide on the main thread, where windows open and go.
#[tauri::command]
pub fn window_close_answer(webview: tauri::Webview, state: State<'_, CloseState>, id: u32, close: bool) -> Result<(), String> {
    let label = webview.label();
    if !is_mango_window(label) {
        return Err("Unknown window.".into());
    }
    {
        let mut closing = state.lock();
        if !closing.answered(label, id) {
            return Ok(()); // An older press: the newest one's answer counts.
        }
        if !close {
            closing.quitting = false;
        }
    }
    if close {
        go(webview.app_handle(), label);
    } else {
        let _ = focus(webview.app_handle(), label);
    }
    Ok(())
}

/// Quit, as closing every window: the others first, then the main one, each saving as it goes.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn quit(app: &AppHandle) {
    let (main, rest): (Vec<_>, Vec<_>) = app.windows().into_iter().filter(|(l, _)| is_mango_window(l)).partition(|(l, _)| l == MAIN);
    app.state::<CloseState>().lock().quitting = !rest.is_empty();
    for (_, window) in if rest.is_empty() { main } else { rest } {
        let _ = window.close();
    }
}

/// macOS: the menu's Quit (and Cmd+Q with it) closes the windows instead of ending the process at
/// once, which asks nobody. Quit from the Dock and logging out still end it at once.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn with_quit_item(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    use tauri::menu::{Menu, MenuItem};

    builder
        .menu(|app| {
            let menu = Menu::default(app)?;
            let Some(app_menu) = menu.items()?.first().and_then(|first| first.as_submenu().cloned()) else { return Ok(menu) };
            let items = app_menu.items()?;
            // Tauri's default app menu ends with the system's Quit.
            if items.last().is_some_and(|last| last.as_predefined_menuitem().is_some()) {
                app_menu.remove_at(items.len() - 1)?;
                let title = format!("Quit {}", app.package_info().name);
                app_menu.append(&MenuItem::with_id(app, QUIT, title, true, Some("CmdOrCtrl+Q"))?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().0 == QUIT {
                quit(app);
            }
        })
}

/// Window events, from `lib.rs`.
///
/// Each window closes on its own, as in JetBrains IDEs, once its page agrees or stopped answering
/// (with unsaved text, only if the user then says so).
/// The main window holds what no other window claims (`app/utils/windows.ts`), so it never goes while
/// others are open: closing it then hides it ("parks" it), and its page closes its projects
/// (`window://parked`). When the last window on screen closes, a parked main one is asked to close
/// too, which ends the app: it must neither run on unseen nor be cut off while it saves.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } if is_mango_window(window.label()) => {
            api.prevent_close();
            ask(app, window.label());
        }
        tauri::WindowEvent::Destroyed if is_mango_window(window.label()) => {
            let label = window.label();
            let quitting = {
                let state = app.state::<CloseState>();
                let mut closing = state.lock();
                closing.gone(label);
                closing.quitting
            };
            let _ = app.emit("window://closed", Closed { label: label.to_string() });
            if label == MAIN || others(app, label) > 0 {
                return;
            }
            if quitting || app.get_window(MAIN).is_some_and(|w| is_hidden(&w)) {
                ask(app, MAIN);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_that_never_heard_lets_its_window_go() {
        let mut c = Closing::default();
        let (id, new) = c.press("main");
        assert!(new);
        assert_eq!(c.overdue("main", id), Some(Silent::Go), "hung or crashed with nothing unsaved: it closes");
        assert!(!c.heard("main", id), "and the page is not to start on it");
        assert!(!c.answered("main", id), "too late to matter");
    }

    #[test]
    fn a_page_that_heard_takes_its_time() {
        let mut c = Closing::default();
        let (id, _) = c.press("main");
        assert!(c.heard("main", id));
        assert_eq!(c.overdue("main", id), None);
        assert!(c.waiting("main", id));
        assert!(c.answered("main", id));
        assert!(!c.waiting("main", id));
    }

    #[test]
    fn a_later_press_on_a_page_that_stopped_answering_closes() {
        let mut c = Closing::default();
        let (first, _) = c.press("main");
        c.heard("main", first);
        // It hangs while it saves; Close is pressed again.
        let (second, new) = c.press("main");
        assert!(new && second != first);
        assert_eq!(c.overdue("main", first), None, "the older press decides nothing");
        assert!(!c.answered("main", first));
        assert_eq!(c.overdue("main", second), Some(Silent::Go));
    }

    #[test]
    fn pressing_again_and_again_does_not_put_the_deadline_off() {
        let mut c = Closing::default();
        let (id, _) = c.press("main");
        for _ in 0..5 {
            assert_eq!(c.press("main"), (id, false));
        }
        assert_eq!(c.overdue("main", id), Some(Silent::Go));
    }

    #[test]
    fn a_silent_page_with_unsaved_text_is_the_users_to_close() {
        let mut c = Closing::default();
        c.set_unsaved("w-1", true);
        c.quitting = true;
        let (id, _) = c.press("w-1");
        assert_eq!(c.overdue("w-1", id), Some(Silent::AskUser));
        assert!(c.confirming.contains("w-1"));
        assert_eq!(c.overdue("w-1", id), None, "no second dialog");
        assert!(!c.heard("w-1", id) && !c.answered("w-1", id), "the dialog decides, not a page back too late");

        assert!(c.decided("w-1", Choice::Again));
        assert!(c.quitting, "Quit goes on");
        let (again, new) = c.press("w-1");
        assert!(new);
        assert_eq!(c.overdue("w-1", again), Some(Silent::AskUser));
        assert!(c.decided("w-1", Choice::Stay));
        assert!(!c.quitting, "staying ends Quit");

        let (id, _) = c.press("w-1");
        assert!(c.heard("w-1", id));
        assert_eq!(c.overdue("w-1", id), None, "a page that hears asks for itself");
        assert!(c.answered("w-1", id));
        // Saved, or a new page said so.
        c.set_unsaved("w-1", false);
        let (id, _) = c.press("w-1");
        assert_eq!(c.overdue("w-1", id), Some(Silent::Go));
    }

    #[test]
    fn a_reload_ends_the_close_its_page_heard() {
        let mut c = Closing::default();
        c.quitting = true;
        let (id, _) = c.press("main");
        assert!(!c.reloaded("main"), "not heard: it keeps its deadline");
        assert!(c.waiting("main", id));
        assert!(c.heard("main", id));
        assert!(!c.reloaded("w-1"), "another window's page");
        assert!(c.reloaded("main"));
        assert!(!c.asked.contains_key("main"), "it is no longer taken to be leaving");
        assert!(!c.answered("main", id) && !c.quitting);
        assert!(c.press("main").1, "asked afresh");
    }

    #[test]
    fn a_window_that_went_under_its_dialog() {
        let mut c = Closing::default();
        c.set_unsaved("w-1", true);
        c.set_unsaved("main", true);
        let (id, _) = c.press("w-1");
        assert_eq!(c.overdue("w-1", id), Some(Silent::AskUser));
        c.gone("w-1");
        assert!(!c.decided("w-1", Choice::Close));
        assert!(!c.unsaved.contains("w-1") && c.unsaved.contains("main"));
    }

    #[test]
    fn only_its_own_button_closes() {
        let of = |label: &str| choice(&MessageDialogResult::Custom(label.into()));
        assert_eq!((of(TRY_AGAIN), of(CLOSE_ANYWAY), of(CANCEL)), (Choice::Again, Choice::Close, Choice::Stay));
        for other in [MessageDialogResult::Cancel, MessageDialogResult::No, MessageDialogResult::Yes, MessageDialogResult::Ok] {
            assert_eq!(choice(&other), Choice::Stay, "dismissed");
        }
    }

    #[test]
    fn minimised_is_not_hidden() {
        assert!(!hidden(false, true, false), "in the Dock");
        assert!(!hidden(true, true, false), "on a taskbar");
        assert!(!hidden(true, false, false));
        assert!(!hidden(true, false, true), "shown again");
        assert!(hidden(false, false, false));
        assert!(hidden(false, true, true), "parked while it was minimised");
    }

    #[test]
    fn windows_are_asked_apart() {
        let mut c = Closing::default();
        let (main, _) = c.press("main");
        let (other, _) = c.press("w-1");
        assert!(!c.heard("w-1", main), "not its id");
        assert!(!c.answered("w-1", main));
        assert_eq!(c.overdue("w-1", other), Some(Silent::Go));
        assert!(c.heard("main", main));
        assert!(c.answered("main", main));
    }

    #[test]
    fn labels() {
        assert!(is_mango_window("main"));
        assert!(is_mango_window("w-1"));
        assert!(is_mango_window("w-42"));
        assert!(!is_mango_window("w-"));
        assert!(!is_mango_window("w-x"));
        assert!(!is_mango_window("browser-abc"));
        assert!(!is_mango_window("mainx"));
    }

    #[test]
    fn under_a_point() {
        let r = |x, y, w, h| Rect { x, y, w, h };
        let wins = vec![("w-2".to_string(), r(0.0, 0.0, 800.0, 600.0)), ("main".to_string(), r(400.0, 300.0, 800.0, 600.0))];
        assert_eq!(window_under(wins.clone(), 10.0, 10.0).as_deref(), Some("w-2"));
        // Both hold it: the main window wins.
        assert_eq!(window_under(wins.clone(), 500.0, 400.0).as_deref(), Some("main"));
        assert_eq!(window_under(wins.clone(), 1199.0, 899.0).as_deref(), Some("main"));
        assert_eq!(window_under(wins.clone(), 1200.0, 900.0), None);
        assert_eq!(window_under(wins, -1.0, 10.0), None);
        assert_eq!(window_under(vec![], 0.0, 0.0), None);
    }

    #[test]
    fn queries() {
        assert_eq!(query("project", Some("/home/me/a b"), None).unwrap(), "window=project&path=%2Fhome%2Fme%2Fa%20b");
        assert_eq!(query("project", None, None).unwrap(), "window=project");
        assert_eq!(query("project", Some("C:\\Users\\me\\x&y=1"), None).unwrap(), "window=project&path=C%3A%5CUsers%5Cme%5Cx%26y%3D1");
        assert_eq!(query("project", Some("env://h1/dev/srv"), None).unwrap(), "window=project&path=env%3A%2F%2Fh1%2Fdev%2Fsrv");
        assert_eq!(query("chat", Some("/p"), Some("t-abc_1")).unwrap(), "window=chat&thread=t-abc_1&path=%2Fp");
        assert_eq!(encode("é"), "%C3%A9");
        assert!(query("chat", None, None).is_err());
        assert!(query("chat", None, Some("../x")).is_err());
        assert!(query("project", Some(""), None).is_err());
        assert!(query("project", Some("a\nb"), None).is_err());
        assert!(query("settings", None, None).is_err());
    }
}
