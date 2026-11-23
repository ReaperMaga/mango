//! Files changed on disk in a language server's folder, for the servers that leave watching to their
//! client (`workspace/didChangeWatchedFiles`). Whatever changes them: an agent, a terminal, Unity,
//! a git checkout, files no version control lists. The page matches them against the globs the
//! server asked for; this only drops the folders no server wants to hear about, and gathers bursts.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::event::{EventKind, MetadataKind, ModifyKind, RenameMode};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

/// `FileChangeType`, as LSP numbers them.
pub const CREATED: u8 = 1;
pub const CHANGED: u8 = 2;
pub const DELETED: u8 = 3;

/// Changes are gathered this long after the first of a burst, then sent together.
const GATHER: Duration = Duration::from_millis(300);
/// More files than this in one burst are not listed one by one: the page is told there were more.
const MAX_BATCH: usize = 2000;

/// Folders whose insides change all the time and are no project's source, wherever they are.
const SKIP_ANYWHERE: &[&str] = &[".git", ".hg", ".svn", ".plastic", ".vs", ".idea", "node_modules", "obj"];
/// The same at the top of the folder only: Unity's caches, Rust's builds.
const SKIP_TOP: &[&str] = &["Library", "Temp", "Logs", "target"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileChange {
    /// Relative to the folder, forward slashes.
    pub file: String,
    #[serde(rename = "type")]
    pub kind: u8,
}

/// One burst of changes.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Batch {
    pub changes: Vec<FileChange>,
    /// Some were not listed: too many, or the system lost track (its buffer overflowed).
    pub more: bool,
}

/// Watching one folder; dropping it ends the watching, and its thread with it.
pub struct Watch {
    _watcher: RecommendedWatcher,
}

/// Watch `root` (canonical) and its folders. `on_batch` runs on a thread of this watch's own.
pub fn start(root: &Path, on_batch: impl Fn(Batch) + Send + 'static) -> Result<Watch, String> {
    let (sender, events) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|e| format!("Could not watch the project folder: {e}"))?;
    watcher.watch(root, RecursiveMode::Recursive).map_err(|e| format!("Could not watch the project folder: {e}"))?;
    let root = root.to_path_buf();
    std::thread::spawn(move || {
        // Ends when the watcher, and the sender in its handler, is gone.
        while let Ok(first) = events.recv() {
            let mut gathered = Gathered::default();
            gathered.add(&root, first);
            let until = Instant::now() + GATHER;
            loop {
                match events.recv_timeout(until.saturating_duration_since(Instant::now())) {
                    Ok(event) => gathered.add(&root, event),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let batch = gathered.batch(&root);
            if !batch.changes.is_empty() || batch.more {
                on_batch(batch);
            }
        }
    });
    Ok(Watch { _watcher: watcher })
}

/// `path` relative to `root` with forward slashes; none for one outside it, in a skipped folder,
/// or with a name that is not text.
fn relative(root: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for (i, part) in rest.components().enumerate() {
        let Component::Normal(name) = part else { return None };
        let name = name.to_str()?;
        if SKIP_ANYWHERE.contains(&name) || (i == 0 && SKIP_TOP.contains(&name)) {
            return None;
        }
        parts.push(name);
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// What one event says happened to each of its paths.
fn kinds(event: &notify::Event) -> Vec<(&Path, u8)> {
    let one = |kind: u8| event.paths.iter().map(|p| (p.as_path(), kind)).collect();
    match event.kind {
        EventKind::Access(_) => Vec::new(),
        EventKind::Create(_) => one(CREATED),
        EventKind::Remove(_) => one(DELETED),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => one(DELETED),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => one(CREATED),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            let mut out = Vec::new();
            if let Some(from) = event.paths.first() {
                out.push((from.as_path(), DELETED));
            }
            if let Some(to) = event.paths.get(1) {
                out.push((to.as_path(), CREATED));
            }
            out
        }
        // A rename the system could not pair: what is there now says which end this is.
        EventKind::Modify(ModifyKind::Name(_)) => {
            event.paths.iter().map(|p| (p.as_path(), if p.exists() { CREATED } else { DELETED })).collect()
        }
        // Permissions, owners, access times: the text is the same.
        EventKind::Modify(ModifyKind::Metadata(kind)) if !matches!(kind, MetadataKind::Any | MetadataKind::WriteTime) => {
            Vec::new()
        }
        _ => one(CHANGED),
    }
}

/// A burst's changes, one per file, in the order they first came.
#[derive(Default)]
struct Gathered {
    order: Vec<PathBuf>,
    by_path: HashMap<PathBuf, u8>,
    more: bool,
}

impl Gathered {
    fn add(&mut self, root: &Path, event: notify::Result<notify::Event>) {
        let event = match event {
            Ok(event) => event,
            Err(_) => {
                self.more = true;
                return;
            }
        };
        if event.need_rescan() {
            self.more = true;
        }
        for (path, kind) in kinds(&event) {
            self.note(root, path, kind);
        }
    }

    fn note(&mut self, root: &Path, path: &Path, kind: u8) {
        if relative(root, path).is_none() {
            return;
        }
        match self.by_path.get_mut(path) {
            Some(was) => {
                *was = match (*was, kind) {
                    // Saved by writing another file and renaming it over this one.
                    (DELETED, CREATED) => CHANGED,
                    // New to the server, whatever happened to it after.
                    (CREATED, CHANGED) => CREATED,
                    (_, now) => now,
                }
            }
            None if self.order.len() >= MAX_BATCH => self.more = true,
            None => {
                self.order.push(path.to_path_buf());
                self.by_path.insert(path.to_path_buf(), kind);
            }
        }
    }

    fn batch(self, root: &Path) -> Batch {
        let changes = self
            .order
            .iter()
            .filter_map(|path| Some(FileChange { file: relative(root, path)?, kind: *self.by_path.get(path)? }))
            .collect();
        Batch { changes, more: self.more }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::test_support::Scratch;
    use notify::event::{CreateKind, DataChange, RemoveKind};

    fn event(kind: EventKind, paths: &[&Path]) -> notify::Result<notify::Event> {
        Ok(paths.iter().fold(notify::Event::new(kind), |e, p| e.add_path(p.to_path_buf())))
    }

    #[test]
    fn skips_caches_and_names_files_relative() {
        let root = Path::new(if cfg!(windows) { r"C:\work\game" } else { "/work/game" });
        let at = |rel: &str| root.join(rel.split('/').collect::<PathBuf>());
        assert_eq!(relative(root, &at("Assets/Scripts/Player.cs")).as_deref(), Some("Assets/Scripts/Player.cs"));
        assert_eq!(relative(root, &at("Library/ScriptAssemblies/a.dll")), None);
        assert_eq!(relative(root, &at("Packages/x/Library/a.cs")).as_deref(), Some("Packages/x/Library/a.cs"));
        assert_eq!(relative(root, &at("src/node_modules/a.ts")), None);
        assert_eq!(relative(root, &at(".git/index")), None);
        assert_eq!(relative(root, root), None);
        assert_eq!(relative(root, Path::new(if cfg!(windows) { r"C:\elsewhere\a.cs" } else { "/elsewhere/a.cs" })), None);
    }

    #[test]
    fn a_burst_says_once_per_file_what_the_server_needs() {
        let root = Path::new(if cfg!(windows) { r"C:\work" } else { "/work" });
        let (a, b, c, d) = (root.join("a.cs"), root.join("b.cs"), root.join("c.cs"), root.join("d.cs"));
        let mut g = Gathered::default();
        g.add(root, event(EventKind::Create(CreateKind::File), &[&a]));
        g.add(root, event(EventKind::Modify(ModifyKind::Data(DataChange::Content)), &[&a]));
        g.add(root, event(EventKind::Remove(RemoveKind::File), &[&b]));
        g.add(root, event(EventKind::Modify(ModifyKind::Name(RenameMode::To)), &[&b]));
        g.add(root, event(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &[&c, &d]));
        g.add(root, event(EventKind::Access(notify::event::AccessKind::Any), &[&c]));
        g.add(root, event(EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions)), &[&a]));
        let batch = g.batch(root);
        let got: Vec<(&str, u8)> = batch.changes.iter().map(|c| (c.file.as_str(), c.kind)).collect();
        assert_eq!(got, [("a.cs", CREATED), ("b.cs", CHANGED), ("c.cs", DELETED), ("d.cs", CREATED)]);
        assert!(!batch.more);
    }

    #[test]
    fn too_many_or_lost_says_there_were_more() {
        let root = Path::new("/work");
        let mut g = Gathered::default();
        for i in 0..MAX_BATCH + 5 {
            g.note(root, &root.join(format!("f{i}.go")), CHANGED);
        }
        let batch = g.batch(root);
        assert_eq!(batch.changes.len(), MAX_BATCH);
        assert!(batch.more);
        let mut g = Gathered::default();
        g.add(root, Err(notify::Error::generic("overflow")));
        assert_eq!(g.batch(root), Batch { changes: Vec::new(), more: true });
    }

    #[test]
    fn hears_files_made_changed_and_deleted_on_disk() {
        let scratch = Scratch::new("watch");
        let root = scratch.path().to_path_buf();
        let (sender, batches) = mpsc::channel();
        let watch = start(&root, move |batch| {
            let _ = sender.send(batch);
        })
        .unwrap();
        let wait_for = |file: &str, kind: u8| {
            let until = Instant::now() + Duration::from_secs(10);
            while let Ok(batch) = batches.recv_timeout(until.saturating_duration_since(Instant::now())) {
                if batch.changes.iter().any(|c| c.file == file && c.kind == kind) {
                    return;
                }
            }
            panic!("never heard {file} {kind}");
        };
        scratch.write("Assets/New.cs", "class A {}");
        wait_for("Assets/New.cs", CREATED);
        std::thread::sleep(GATHER * 2);
        std::fs::write(root.join("Assets").join("New.cs"), "class B {}").unwrap();
        wait_for("Assets/New.cs", CHANGED);
        std::fs::remove_file(root.join("Assets").join("New.cs")).unwrap();
        wait_for("Assets/New.cs", DELETED);
        scratch.write("Library/cache.bin", "x");
        std::thread::sleep(GATHER * 3);
        while let Ok(batch) = batches.try_recv() {
            assert!(batch.changes.iter().all(|c| !c.file.starts_with("Library/")), "{batch:?}");
        }
        drop(watch);
    }
}
