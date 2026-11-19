//! Desktop notifications: a chat finished, needs an approval, or failed while Mango is in the
//! background. The frontend decides when (Settings > Notifications); this only shows one.
//! Notifications are plain text from Mango and the agent's reply, shown by the system, so the
//! text is cut to a length the system will show and nothing in it is interpreted.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// What a notification can hold before systems start to cut it off themselves.
const MAX_TITLE: usize = 80;
const MAX_BODY: usize = 240;

/// `text` on one line, at most `max` characters, with an ellipsis when it was cut.
fn clip(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let mut cut: String = one_line.chars().take(max.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// Show a system notification. `sound` plays the system's notification sound.
#[tauri::command]
pub async fn notify(app: AppHandle, title: String, body: String, sound: bool) -> Result<(), String> {
    let title = clip(&title, MAX_TITLE);
    let body = clip(&body, MAX_BODY);
    if title.is_empty() {
        return Err("A notification needs a title.".into());
    }
    // `show` talks to the system's notification service: keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let mut n = app.notification().builder().title(title).body(body);
        if sound {
            n = n.sound("default");
        }
        n.show().map_err(|e| format!("Could not show the notification: {e}"))
    })
    .await
    .map_err(|e| format!("Could not show the notification: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_kept_on_one_line() {
        assert_eq!(clip("Fix the\n  build", 40), "Fix the build");
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis() {
        let cut = clip(&"word ".repeat(100), 20);
        assert!(cut.chars().count() <= 20, "{cut}");
        assert!(cut.ends_with('…'));
        assert!(!cut.contains("  "));
    }

    #[test]
    fn cutting_respects_characters_not_bytes() {
        let cut = clip(&"é".repeat(50), 10);
        assert_eq!(cut.chars().count(), 10);
    }
}
