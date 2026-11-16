//! Chat history: a SQLite file (`chats.sqlite3` in the app data folder).
//!
//! One row per chat, holding the chat as the frontend's JSON, so the frontend's `Thread` type stays
//! the single description of a chat and loading old data stays its job (`normalizeLoaded`). Saves
//! are incremental: the frontend sends only the chats that changed, and the ones it deleted.
//! The layout (tabs, panes) is one small JSON value in `meta`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "chats.sqlite3";
const UI_KEY: &str = "ui";

#[derive(Default)]
pub struct ChatsState {
    db: Mutex<Option<Connection>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRow {
    pub id: String,
    pub project_path: String,
    pub updated_at: i64,
    /// The chat as JSON. Checked to be JSON before it is stored.
    pub data: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    /// Every saved chat, as the JSON the frontend stored.
    pub threads: Vec<String>,
    /// The saved layout (JSON), or None before the first save.
    pub ui: Option<String>,
}

fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("Could not open the chat history ({}): {e}", path.display()))?;
    init(&conn).map_err(|e| format!("Could not prepare the chat history ({}): {e}", path.display()))?;
    Ok(conn)
}

fn init(conn: &Connection) -> rusqlite::Result<()> {
    // WAL: a save never blocks a read and survives a crash mid-write; NORMAL sync is safe with WAL.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS threads (
             id           TEXT PRIMARY KEY,
             project_path TEXT NOT NULL,
             updated_at   INTEGER NOT NULL,
             data         TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS threads_project ON threads(project_path);
         CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         PRAGMA user_version = 1;",
    )
}

fn load(conn: &Connection) -> rusqlite::Result<ChatSnapshot> {
    let mut stmt = conn.prepare("SELECT data FROM threads ORDER BY rowid")?;
    let threads = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let ui = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [UI_KEY], |r| r.get::<_, String>(0))
        .optional()?;
    Ok(ChatSnapshot { threads, ui })
}

fn save(conn: &mut Connection, upsert: &[ChatRow], remove: &[String], ui: Option<&str>) -> Result<(), String> {
    for row in upsert {
        if row.id.is_empty() || serde_json::from_str::<serde::de::IgnoredAny>(&row.data).is_err() {
            return Err(format!("Chat {:?} was not saved: its data is not valid JSON.", row.id));
        }
    }
    if let Some(ui) = ui {
        serde_json::from_str::<serde::de::IgnoredAny>(ui).map_err(|_| "The layout was not saved: it is not valid JSON.".to_string())?;
    }
    let fail = |e: rusqlite::Error| format!("Could not save the chat history: {e}");
    // One transaction: a save lands whole or not at all.
    let tx = conn.transaction().map_err(fail)?;
    {
        let mut put = tx
            .prepare_cached(
                "INSERT INTO threads (id, project_path, updated_at, data) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET project_path = excluded.project_path,
                     updated_at = excluded.updated_at, data = excluded.data",
            )
            .map_err(fail)?;
        for row in upsert {
            put.execute(params![row.id, row.project_path, row.updated_at, row.data]).map_err(fail)?;
        }
        let mut del = tx.prepare_cached("DELETE FROM threads WHERE id = ?1").map_err(fail)?;
        for id in remove {
            del.execute([id]).map_err(fail)?;
        }
        if let Some(ui) = ui {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![UI_KEY, ui],
            )
            .map_err(fail)?;
        }
    }
    tx.commit().map_err(fail)
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

/// Run `f` on the open database (opening it on first use), off the UI thread.
async fn with_db<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ChatsState>();
        let mut guard = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(open(&db_path(&app)?)?);
        }
        f(guard.as_mut().expect("opened above"))
    })
    .await
    .map_err(|e| format!("The chat history task failed: {e}"))?
}

/// Every saved chat and the layout.
#[tauri::command]
pub async fn chats_load(app: AppHandle) -> Result<ChatSnapshot, String> {
    with_db(app, |c| load(c).map_err(|e| format!("Could not read the chat history: {e}"))).await
}

/// Save the chats that changed, delete the ones that are gone, and the layout when given.
#[tauri::command]
pub async fn chats_save(app: AppHandle, upsert: Vec<ChatRow>, remove: Vec<String>, ui: Option<String>) -> Result<(), String> {
    with_db(app, move |c| save(c, &upsert, &remove, ui.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, data: &str) -> ChatRow {
        ChatRow { id: id.into(), project_path: "/p".into(), updated_at: 1, data: data.into() }
    }

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn saves_updates_and_deletes() {
        let mut c = mem();
        save(&mut c, &[row("a", r#"{"id":"a"}"#), row("b", r#"{"id":"b"}"#)], &[], Some(r#"{"tabs":[]}"#)).unwrap();
        save(&mut c, &[row("a", r#"{"id":"a","title":"x"}"#)], &["b".into()], None).unwrap();
        let snap = load(&c).unwrap();
        assert_eq!(snap.threads, vec![r#"{"id":"a","title":"x"}"#.to_string()]);
        assert_eq!(snap.ui.as_deref(), Some(r#"{"tabs":[]}"#));
    }

    #[test]
    fn rejects_bad_json_without_saving_anything() {
        let mut c = mem();
        let err = save(&mut c, &[row("a", "{}"), row("b", "{not json")], &[], None).unwrap_err();
        assert!(err.contains("\"b\""), "{err}");
        assert!(load(&c).unwrap().threads.is_empty());
    }

    #[test]
    fn empty_database_has_no_layout() {
        let snap = load(&mem()).unwrap();
        assert!(snap.threads.is_empty() && snap.ui.is_none());
    }

    #[test]
    fn reopens_a_file() {
        let dir = std::env::temp_dir().join(format!("mango-chats-{}", uuid::Uuid::new_v4()));
        let path = dir.join(FILE);
        save(&mut open(&path).unwrap(), &[row("a", "{}")], &[], None).unwrap();
        assert_eq!(load(&open(&path).unwrap()).unwrap().threads.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
