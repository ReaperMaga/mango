//! Plugins' saved documents (`mango.data`): a SQLite file (`plugin-data.sqlite3` in the app data folder).
//!
//! One row per document, holding its data as the frontend's JSON text. Built so a copy elsewhere can follow it
//! later: every write raises the document's `rev` and takes the plugin's next `seq`, which is never used twice
//! (not even after a clear), and a deleted document stays as a tombstone. A plugin's documents outlive the
//! plugin: only `plugin_data_clear`, which the user asks for when removing it, deletes them.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::plugins::valid_id;

const FILE: &str = "plugin-data.sqlite3";
const CHANGED: &str = "plugins://data";
const MAX_DOC: usize = 1024 * 1024;
const MAX_OPS: usize = 2000;

#[derive(Default)]
pub struct PluginDataState {
    db: Mutex<Option<Connection>>,
    /// Cleared in this run. Such a plugin may still be stopping in another window and save what it holds:
    /// refused while it is not installed, or it would bring back what the user deleted.
    cleared: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDocRow {
    pub collection: String,
    pub id: String,
    pub rev: i64,
    pub seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted: bool,
    /// JSON text; None once deleted.
    pub data: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum PluginDataOp {
    Put { collection: String, id: String, data: String, expected_rev: Option<i64> },
    Delete { collection: String, id: String, expected_rev: Option<i64> },
}

impl PluginDataOp {
    fn key(&self) -> (&str, &str) {
        match self {
            Self::Put { collection, id, .. } | Self::Delete { collection, id, .. } => (collection, id),
        }
    }
    fn expected_rev(&self) -> Option<i64> {
        match self {
            Self::Put { expected_rev, .. } | Self::Delete { expected_rev, .. } => *expected_rev,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataWritten {
    /// The document after each operation, in the operations' order. Empty when there are conflicts.
    pub docs: Vec<PluginDocRow>,
    /// The documents not at their `expectedRev`, as they are now (`rev` 0: there is none). Then nothing was written.
    pub conflicts: Vec<PluginDocRow>,
    pub seq: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDataChanges {
    pub seq: i64,
    pub docs: Vec<PluginDocRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginDataChanged {
    plugin_id: String,
    seq: i64,
    docs: Vec<PluginDocRow>,
    origin: String,
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

fn check_plugin(id: &str) -> Result<(), String> {
    if valid_id(id) { Ok(()) } else { Err(format!("\"{id}\" is not a plugin id")) }
}

fn check_collection(name: &str) -> Result<(), String> {
    let ok = !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { Ok(()) } else { Err(format!("{name:?} is not a collection name: use letters, digits, _ and -, up to 64")) }
}

fn check_doc_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.chars().count() <= 128 && !id.chars().any(char::is_control);
    if ok { Ok(()) } else { Err(format!("{id:?} is not a document id: use 1 to 128 characters, no control characters")) }
}

fn check_ops(ops: &[PluginDataOp]) -> Result<(), String> {
    if ops.len() > MAX_OPS {
        return Err(format!("{} changes in one write are too many: the most is {MAX_OPS}", ops.len()));
    }
    for op in ops {
        let (collection, id) = op.key();
        check_collection(collection)?;
        check_doc_id(id)?;
        if op.expected_rev().is_some_and(|r| r < 0) {
            return Err(format!("{collection}/{id} was not saved: expectedRev may not be negative"));
        }
        if let PluginDataOp::Put { data, .. } = op {
            if data.len() > MAX_DOC {
                return Err(format!("{collection}/{id} was not saved: it is larger than 1 MB"));
            }
            if serde_json::from_str::<serde::de::IgnoredAny>(data).is_err() {
                return Err(format!("{collection}/{id} was not saved: its data is not valid JSON"));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("Could not open the plugins' documents ({}): {e}", path.display()))?;
    init(&conn).map_err(|e| format!("Could not prepare the plugins' documents ({}): {e}", path.display()))?;
    Ok(conn)
}

fn init(conn: &Connection) -> rusqlite::Result<()> {
    // Waiting first: switching to WAL needs the file to itself for a moment.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // FULL: a write that was reported saved survives a power cut.
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS docs (
             plugin_id  TEXT NOT NULL,
             collection TEXT NOT NULL,
             id         TEXT NOT NULL,
             rev        INTEGER NOT NULL,
             seq        INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL,
             deleted    INTEGER NOT NULL,
             data       TEXT,
             PRIMARY KEY (plugin_id, collection, id)
         );
         CREATE UNIQUE INDEX IF NOT EXISTS docs_seq ON docs(plugin_id, seq);
         CREATE TABLE IF NOT EXISTS seqs (
             plugin_id TEXT PRIMARY KEY,
             last      INTEGER NOT NULL
         );
         PRAGMA user_version = 1;",
    )
}

const COLUMNS: &str = "collection, id, rev, seq, created_at, updated_at, deleted, data";

fn doc(r: &Row) -> rusqlite::Result<PluginDocRow> {
    Ok(PluginDocRow {
        collection: r.get(0)?,
        id: r.get(1)?,
        rev: r.get(2)?,
        seq: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted: r.get(6)?,
        data: r.get(7)?,
    })
}

/// What stands for a document that was never written.
fn absent(collection: &str, id: &str) -> PluginDocRow {
    PluginDocRow { collection: collection.into(), id: id.into(), rev: 0, seq: 0, created_at: 0, updated_at: 0, deleted: true, data: None }
}

/// A document, tombstones included.
fn find(conn: &Connection, plugin: &str, collection: &str, id: &str) -> rusqlite::Result<Option<PluginDocRow>> {
    conn.prepare_cached(&format!("SELECT {COLUMNS} FROM docs WHERE plugin_id = ?1 AND collection = ?2 AND id = ?3"))?
        .query_row([plugin, collection, id], doc)
        .optional()
}

fn last_seq(conn: &Connection, plugin: &str) -> rusqlite::Result<i64> {
    Ok(conn.query_row("SELECT last FROM seqs WHERE plugin_id = ?1", [plugin], |r| r.get(0)).optional()?.unwrap_or(0))
}

fn list(conn: &Connection, plugin: &str, collection: &str) -> rusqlite::Result<Vec<PluginDocRow>> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM docs WHERE plugin_id = ?1 AND collection = ?2 AND deleted = 0 ORDER BY created_at, id"
    ))?
    .query_map([plugin, collection], doc)?
    .collect()
}

fn count(conn: &Connection, plugin: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM docs WHERE plugin_id = ?1 AND deleted = 0", [plugin], |r| r.get(0))
}

fn changes(conn: &mut Connection, plugin: &str, since: i64) -> rusqlite::Result<PluginDataChanges> {
    // One transaction, so `seq` and the documents are of the same moment.
    let tx = conn.transaction()?;
    let seq = last_seq(&tx, plugin)?;
    let docs = tx
        .prepare_cached(&format!("SELECT {COLUMNS} FROM docs WHERE plugin_id = ?1 AND seq > ?2 ORDER BY seq"))?
        .query_map(params![plugin, since], doc)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(PluginDataChanges { seq, docs })
}

/// The result, and the documents that really changed (each once, oldest first).
fn write(
    conn: &mut Connection,
    plugin: &str,
    ops: &[PluginDataOp],
    now: i64,
) -> rusqlite::Result<(PluginDataWritten, Vec<PluginDocRow>)> {
    // IMMEDIATE: the revisions read here are still the ones when it writes.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let before = last_seq(&tx, plugin)?;
    let mut seq = before;
    let mut docs = Vec::with_capacity(ops.len());
    let mut conflicts: Vec<(&str, &str)> = Vec::new();
    let mut changed: HashMap<(&str, &str), PluginDocRow> = HashMap::new();
    for op in ops {
        let key @ (collection, id) = op.key();
        let current = find(&tx, plugin, collection, id)?;
        let rev = current.as_ref().map_or(0, |d| d.rev);
        let gone = current.as_ref().is_none_or(|d| d.deleted);
        if op.expected_rev().is_some_and(|want| want != rev && !(want == 0 && gone)) {
            if !conflicts.contains(&key) {
                conflicts.push(key);
            }
            continue;
        }
        let data = match op {
            PluginDataOp::Put { data, .. } => Some(data.clone()),
            PluginDataOp::Delete { .. } if gone => {
                // Nothing to delete.
                docs.push(current.unwrap_or_else(|| absent(collection, id)));
                continue;
            }
            PluginDataOp::Delete { .. } => None,
        };
        seq += 1;
        let next = PluginDocRow {
            collection: collection.into(),
            id: id.into(),
            rev: rev + 1,
            seq,
            // A document put again after it was deleted is a new one.
            created_at: current.filter(|d| !d.deleted).map_or(now, |d| d.created_at),
            updated_at: now,
            deleted: data.is_none(),
            data,
        };
        tx.prepare_cached(
            "INSERT INTO docs (plugin_id, collection, id, rev, seq, created_at, updated_at, deleted, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(plugin_id, collection, id) DO UPDATE SET rev = excluded.rev, seq = excluded.seq,
                 created_at = excluded.created_at, updated_at = excluded.updated_at,
                 deleted = excluded.deleted, data = excluded.data",
        )?
        .execute(params![
            plugin, next.collection, next.id, next.rev, next.seq, next.created_at, next.updated_at, next.deleted, next.data
        ])?;
        changed.insert(key, next.clone());
        docs.push(next);
    }
    if !conflicts.is_empty() {
        tx.rollback()?;
        let conflicts = conflicts
            .into_iter()
            .map(|(c, id)| Ok(find(conn, plugin, c, id)?.unwrap_or_else(|| absent(c, id))))
            .collect::<rusqlite::Result<_>>()?;
        return Ok((PluginDataWritten { docs: Vec::new(), conflicts, seq: before }, Vec::new()));
    }
    if seq != before {
        tx.execute(
            "INSERT INTO seqs (plugin_id, last) VALUES (?1, ?2) ON CONFLICT(plugin_id) DO UPDATE SET last = excluded.last",
            params![plugin, seq],
        )?;
    }
    tx.commit()?;
    let mut changed: Vec<_> = changed.into_values().collect();
    changed.sort_by_key(|d| d.seq);
    Ok((PluginDataWritten { docs, conflicts: Vec::new(), seq }, changed))
}

/// Deletes the plugin's documents for good, tombstones too. Its `seq` stays, so it goes on from there.
fn clear(conn: &Connection, plugin: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM docs WHERE plugin_id = ?1", [plugin]).map(|_| ())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Run `f` on the open database (opening it on first use), off the UI thread.
async fn with_db<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginDataState>();
        let mut guard = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(open(&db_path(&app)?)?);
        }
        f(guard.as_mut().expect("opened above"))
    })
    .await
    .map_err(|e| format!("The plugin documents task failed: {e}"))?
}

fn unread(e: rusqlite::Error) -> String {
    format!("Could not read the plugin's documents: {e}")
}

/// A collection's documents, without the deleted ones.
#[tauri::command]
pub async fn plugin_data_list(app: AppHandle, plugin_id: String, collection: String) -> Result<Vec<PluginDocRow>, String> {
    check_plugin(&plugin_id)?;
    check_collection(&collection)?;
    with_db(app, move |c| list(c, &plugin_id, &collection).map_err(unread)).await
}

#[tauri::command]
pub async fn plugin_data_get(app: AppHandle, plugin_id: String, collection: String, id: String) -> Result<Option<PluginDocRow>, String> {
    check_plugin(&plugin_id)?;
    check_collection(&collection)?;
    check_doc_id(&id)?;
    with_db(app, move |c| Ok(find(c, &plugin_id, &collection, &id).map_err(unread)?.filter(|d| !d.deleted))).await
}

/// How many documents a plugin has.
#[tauri::command]
pub async fn plugin_data_count(app: AppHandle, plugin_id: String) -> Result<i64, String> {
    check_plugin(&plugin_id)?;
    with_db(app, move |c| count(c, &plugin_id).map_err(unread)).await
}

/// Everything written after `since`, tombstones included.
#[tauri::command]
pub async fn plugin_data_changes(app: AppHandle, plugin_id: String, since: i64) -> Result<PluginDataChanges, String> {
    check_plugin(&plugin_id)?;
    with_db(app, move |c| changes(c, &plugin_id, since).map_err(unread)).await
}

/// All of `ops` or none; conflicts are part of the answer. `origin` goes back out with the event.
#[tauri::command]
pub async fn plugin_data_write(
    app: AppHandle,
    plugin_id: String,
    ops: Vec<PluginDataOp>,
    origin: String,
) -> Result<PluginDataWritten, String> {
    check_plugin(&plugin_id)?;
    if is_cleared(&app, &plugin_id) {
        if !crate::plugins::plugins_list(app.clone()).await?.iter().any(|p| p.manifest.id == plugin_id) {
            return Err(REMOVED.into());
        }
        cleared(&app).remove(&plugin_id);
    }
    let events = app.clone();
    with_db(app, move |c| {
        check_ops(&ops)?;
        // Again, now that the database is ours: a clear may have run meanwhile.
        if is_cleared(&events, &plugin_id) {
            return Err(REMOVED.into());
        }
        let (written, changed) =
            write(c, &plugin_id, &ops, now_ms()).map_err(|e| format!("Could not save the plugin's documents: {e}"))?;
        // Still holding the database, so events go out in the order of their `seq`.
        if !changed.is_empty() {
            let _ = events.emit(CHANGED, PluginDataChanged { plugin_id, seq: written.seq, docs: changed, origin });
        }
        Ok(written)
    })
    .await
}

const REMOVED: &str = "The plugin was removed together with its documents";

/// Delete a plugin's documents for good (the user asked for it when removing the plugin).
#[tauri::command]
pub async fn plugin_data_clear(app: AppHandle, plugin_id: String) -> Result<(), String> {
    check_plugin(&plugin_id)?;
    let state_of = app.clone();
    with_db(app, move |c| {
        clear(c, &plugin_id).map_err(|e| format!("Could not delete the plugin's documents: {e}"))?;
        cleared(&state_of).insert(plugin_id);
        Ok(())
    })
    .await
}

fn cleared(app: &AppHandle) -> std::sync::MutexGuard<'_, HashSet<String>> {
    app.state::<PluginDataState>().inner().cleared.lock().unwrap_or_else(|e| e.into_inner())
}

fn is_cleared(app: &AppHandle, plugin: &str) -> bool {
    cleared(app).contains(plugin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn put(id: &str, data: &str, expected_rev: Option<i64>) -> PluginDataOp {
        PluginDataOp::Put { collection: "notes".into(), id: id.into(), data: data.into(), expected_rev }
    }

    fn del(id: &str, expected_rev: Option<i64>) -> PluginDataOp {
        PluginDataOp::Delete { collection: "notes".into(), id: id.into(), expected_rev }
    }

    fn run(c: &mut Connection, ops: &[PluginDataOp], now: i64) -> PluginDataWritten {
        write(c, "p", ops, now).unwrap().0
    }

    #[test]
    fn writes_raise_rev_and_seq() {
        let mut c = mem();
        let w = run(&mut c, &[put("a", "1", None), put("b", "2", Some(0))], 10);
        assert_eq!(w.docs.iter().map(|d| (d.rev, d.seq)).collect::<Vec<_>>(), [(1, 1), (1, 2)]);
        let w = run(&mut c, &[put("a", r#"{"z":1,"a":0.1}"#, Some(1))], 20);
        let d = &w.docs[0];
        assert_eq!((d.rev, d.seq, d.created_at, d.updated_at, w.seq), (2, 3, 10, 20, 3));
        // The text comes back as it went in.
        assert_eq!(find(&c, "p", "notes", "a").unwrap().unwrap().data.as_deref(), Some(r#"{"z":1,"a":0.1}"#));
        assert_eq!(list(&c, "p", "notes").unwrap().len(), 2);
    }

    #[test]
    fn a_conflict_writes_nothing_and_is_returned() {
        let mut c = mem();
        run(&mut c, &[put("a", "1", None)], 1);
        let ops = [put("new", "1", None), put("a", "8", None), put("a", "9", Some(7)), del("gone", Some(3))];
        let (w, changed) = write(&mut c, "p", &ops, 2).unwrap();
        assert!(w.docs.is_empty() && changed.is_empty());
        // As stored, not as the rolled back write had it.
        assert_eq!(w.conflicts[0], find(&c, "p", "notes", "a").unwrap().unwrap());
        assert_eq!(w.conflicts[0].data.as_deref(), Some("1"));
        assert_eq!(w.conflicts[1], absent("notes", "gone"));
        assert_eq!((w.seq, last_seq(&c, "p").unwrap()), (1, 1));
        assert!(find(&c, "p", "notes", "new").unwrap().is_none());
        // 0: it must not exist.
        assert_eq!(run(&mut c, &[put("a", "2", Some(0))], 3).conflicts.len(), 1);
    }

    #[test]
    fn deleting_leaves_a_tombstone_that_can_be_put_again() {
        let mut c = mem();
        run(&mut c, &[put("a", "1", None)], 1);
        let d = run(&mut c, &[del("a", Some(1))], 2).docs.remove(0);
        assert!(d.deleted && d.data.is_none());
        assert_eq!((d.rev, d.seq, d.created_at, d.updated_at), (2, 2, 1, 2));
        assert!(list(&c, "p", "notes").unwrap().is_empty());
        assert_eq!(count(&c, "p").unwrap(), 0);
        // Deleting again, or what never was, changes nothing.
        let (w, changed) = write(&mut c, "p", &[del("a", None), del("x", None)], 3).unwrap();
        assert!(changed.is_empty());
        assert_eq!((w.docs[0].rev, w.docs[1].rev, w.seq), (2, 0, 2));
        let d = run(&mut c, &[put("a", "2", Some(0))], 4).docs.remove(0);
        assert_eq!((d.rev, d.seq, d.created_at, d.deleted), (3, 3, 4, false));
    }

    #[test]
    fn the_same_document_twice_in_one_write() {
        let mut c = mem();
        let (w, changed) = write(&mut c, "p", &[put("a", "1", Some(0)), put("b", "1", None), put("a", "2", Some(1))], 1).unwrap();
        assert_eq!(w.docs.iter().map(|d| d.rev).collect::<Vec<_>>(), [1, 1, 2]);
        assert_eq!(changed.iter().map(|d| (d.id.as_str(), d.seq)).collect::<Vec<_>>(), [("b", 2), ("a", 3)]);
    }

    #[test]
    fn changes_since_include_tombstones_in_order() {
        let mut c = mem();
        run(&mut c, &[put("a", "1", None), put("b", "1", None)], 1);
        run(&mut c, &[put("a", "2", None), del("b", None)], 2);
        let all = changes(&mut c, "p", 0).unwrap();
        assert_eq!(all.seq, 4);
        assert_eq!(all.docs.iter().map(|d| (d.id.as_str(), d.deleted)).collect::<Vec<_>>(), [("a", false), ("b", true)]);
        assert_eq!(changes(&mut c, "p", 3).unwrap().docs.len(), 1);
        let none = changes(&mut c, "p", 4).unwrap();
        assert!(none.docs.is_empty() && none.seq == 4);
    }

    #[test]
    fn plugins_are_apart_and_a_clear_never_gives_a_seq_twice() {
        let mut c = mem();
        run(&mut c, &[put("a", "1", None), put("b", "1", None)], 1);
        let other = write(&mut c, "q", &[put("a", "1", None)], 1).unwrap().0;
        assert_eq!(other.docs[0].seq, 1);
        clear(&c, "p").unwrap();
        assert_eq!((count(&c, "p").unwrap(), count(&c, "q").unwrap()), (0, 1));
        assert!(changes(&mut c, "p", 0).unwrap().docs.is_empty());
        let d = run(&mut c, &[put("a", "1", Some(0))], 2).docs.remove(0);
        assert_eq!((d.rev, d.seq), (1, 3));
    }

    #[test]
    fn two_connections_write_one_after_the_other() {
        let dir = std::env::temp_dir().join(format!("mango-plugin-data-{}", uuid::Uuid::new_v4()));
        let path = dir.join(FILE);
        drop(open(&path).unwrap());
        let threads: Vec<_> = (0..2)
            .map(|t| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut c = open(&path).unwrap();
                    (0..25)
                        .map(|i| run(&mut c, &[put(&format!("{t}-{i}"), "1", Some(0)), put("shared", "1", None)], 1).seq)
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut seqs: Vec<i64> = threads.into_iter().flat_map(|t| t.join().unwrap()).collect();
        seqs.sort_unstable();
        assert_eq!(seqs, (1..=50).map(|n| n * 2).collect::<Vec<_>>());
        assert_eq!(find(&open(&path).unwrap(), "p", "notes", "shared").unwrap().unwrap().rev, 50);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_what_does_not_fit() {
        assert!(check_plugin("planner").is_ok() && check_plugin("../x").is_err());
        assert!(check_collection("My_notes-2").is_ok());
        for bad in ["", "a b", "a/b", "é", &"x".repeat(65)] {
            assert!(check_collection(bad).is_err(), "{bad}");
        }
        assert!(check_doc_id(&"é".repeat(128)).is_ok());
        for bad in ["", "a\nb", &"x".repeat(129)] {
            assert!(check_doc_id(bad).is_err(), "{bad}");
        }
        assert!(check_ops(&[put("a", &format!("\"{}\"", "x".repeat(MAX_DOC - 2)), None)]).is_ok());
        assert!(check_ops(&[put("a", &format!("\"{}\"", "x".repeat(MAX_DOC - 1)), None)]).is_err());
        assert!(check_ops(&[put("a", "{nope", None)]).is_err());
        assert!(check_ops(&[put("a", "1", Some(-1))]).is_err());
        assert!(check_ops(&vec![del("a", None); MAX_OPS]).is_ok());
        assert!(check_ops(&vec![del("a", None); MAX_OPS + 1]).is_err());
    }

    #[test]
    fn reads_operations_as_the_frontend_sends_them() {
        let ops: Vec<PluginDataOp> = serde_json::from_str(
            r#"[{"op":"put","collection":"c","id":"a","data":"{}","expectedRev":3},{"op":"delete","collection":"c","id":"b"}]"#,
        )
        .unwrap();
        assert_eq!((ops[0].expected_rev(), ops[1].expected_rev()), (Some(3), None));
        assert!(matches!(ops[1], PluginDataOp::Delete { .. }));
    }
}
