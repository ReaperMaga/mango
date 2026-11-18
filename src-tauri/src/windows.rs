//! Mango's windows: the main one (`main`, from tauri.conf.json) and more, labelled `w-<n>`, each
//! opened on one project or one chat (`window_open`).
//!
//! Every window loads the same page; what it shows comes from its URL's query
//! (`?window=project&path=…`, `?window=chat&thread=…&path=…`), read once at start-up
//! (`app/utils/windows.ts`). Which window holds which project or chat is the frontend's business
//! (`app/stores/windows.ts`): the backend only opens, focuses and lists windows, and says when one
//! is gone (`window://closed`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const MAIN: &str = "main";
const PREFIX: &str = "w-";
/// The smallest window Mango is laid out for (tauri.conf.json says the same for the main window).
const MIN_W: f64 = 960.0;
const MIN_H: f64 = 600.0;

static NEXT: AtomicU32 = AtomicU32::new(1);

/// One of Mango's own windows (never a browser tab's webview).
pub fn is_mango_window(label: &str) -> bool {
    label == MAIN || label.strip_prefix(PREFIX).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Clone, Serialize)]
struct Closed {
    label: String,
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
        if app.get_webview_window(&label).is_none() {
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
    if let Some(w) = finite(width) {
        config.width = w.max(MIN_W);
    }
    if let Some(h) = finite(height) {
        config.height = h.max(MIN_H);
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
    let w = app.get_webview_window(&label).ok_or("That window is closed.")?;
    let _ = w.unminimize();
    let _ = w.show();
    w.set_focus().map_err(|e| e.to_string())
}

/// The labels of Mango's open windows (browser webviews left out).
#[tauri::command]
pub async fn window_list(app: AppHandle) -> Result<Vec<String>, String> {
    let mut labels: Vec<String> = app.webview_windows().into_keys().filter(|l| is_mango_window(l)).collect();
    labels.sort();
    Ok(labels)
}

/// Window events, from `lib.rs`.
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    match event {
        // Closing the main window closes the others too: each saves what it holds first
        // (its own close handler), then goes.
        tauri::WindowEvent::CloseRequested { .. } if window.label() == MAIN => {
            for (label, w) in app.webview_windows() {
                if label != MAIN && is_mango_window(&label) {
                    let _ = w.close();
                }
            }
            // A window that does not finish closing must not keep Mango running with no main window.
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                if app.get_webview_window(MAIN).is_none() {
                    app.exit(0);
                }
            });
        }
        tauri::WindowEvent::Destroyed if is_mango_window(window.label()) => {
            let _ = app.emit("window://closed", Closed { label: window.label().to_string() });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
