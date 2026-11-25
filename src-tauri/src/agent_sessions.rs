//! The transcripts Claude Code keeps of its sessions, read (never written) to find out whether a session
//! went on outside Mango. What the lines mean is the adapter's business (`app/agents/claude.ts`).

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::blocking;

/// At most this much of a transcript's end is handed out.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTail {
    /// Complete lines, oldest first.
    lines: Vec<String>,
    /// They are the whole file.
    whole: bool,
}

/// Where Claude Code keeps its sessions: a folder per project, in it a file per session.
fn projects_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
        .map(|d| d.join("projects"))
}

/// The session's transcript under `projects`. A session that moved folders may have left one behind: the newest counts.
fn find(projects: &Path, session_id: &str) -> Option<PathBuf> {
    // Only an id as Claude Code makes them, so it is a file name and nothing more.
    let id = uuid::Uuid::try_parse(session_id).ok()?;
    let name = format!("{}.jsonl", id.hyphenated());
    fs::read_dir(projects)
        .ok()?
        .flatten()
        .filter_map(|dir| {
            let path = dir.path().join(&name);
            let meta = fs::metadata(&path).ok().filter(|m| m.is_file())?;
            Some((meta.modified().ok()?, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn tail(path: &Path, max_bytes: u64) -> std::io::Result<TranscriptTail> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    // One byte more, to see whether the tail starts with a line of its own.
    let start = size.saturating_sub(max_bytes.min(MAX_BYTES).saturating_add(1));
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(size - start).read_to_end(&mut bytes)?;
    // What follows the last line break is a line still being written.
    let end = bytes.iter().rposition(|&b| b == b'\n').unwrap_or(0);
    let from = if start == 0 { 0 } else { bytes.iter().position(|&b| b == b'\n').map_or(end, |i| i + 1).min(end) };
    let lines = String::from_utf8_lossy(&bytes[from..end]).lines().map(str::to_owned).collect();
    Ok(TranscriptTail { lines, whole: start == 0 })
}

/// The last lines of a Claude Code session's transcript on this computer; none when it has no transcript.
#[tauri::command]
pub async fn agent_transcript(session_id: String, max_bytes: u64) -> Result<Option<TranscriptTail>, String> {
    blocking(move || {
        let Some(path) = projects_dir().and_then(|dir| find(&dir, &session_id)) else { return Ok(None) };
        tail(&path, max_bytes).map(Some).map_err(|e| format!("Could not read the session's transcript: {e}"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0dacbe9a-6066-4834-849b-e6a16e2af169";

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mango-sessions-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_tail_holds_complete_lines_only() {
        let dir = scratch();
        let path = dir.join("t.jsonl");
        let read = |text: &str, max: u64| {
            fs::write(&path, text).unwrap();
            let t = tail(&path, max).unwrap();
            (t.lines, t.whole)
        };
        let all = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(read("one\ntwo\nthree\n", 100), (all(&["one", "two", "three"]), true));
        assert_eq!(read("one\ntwo\nthr", 100), (all(&["one", "two"]), true));
        assert_eq!(read("one\ntwo\nthree\n", 8), (all(&["three"]), false));
        assert_eq!(read("one\ntwo\nthree\n", 10), (all(&["two", "three"]), false));
        assert_eq!(read("one\ntwo\nthree\n", 3), (all(&[]), false));
        assert_eq!(read("é\né\n", 4), (all(&["é"]), false));
        assert_eq!(read("", 100), (all(&[]), true));
        assert_eq!(read("unfinished", 100), (all(&[]), true));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_newest_transcript_of_a_session_is_found_and_nothing_else() {
        let dir = scratch();
        for (project, age) in [("a", 60), ("b", 0), ("c", 120)] {
            let path = dir.join(project).join(format!("{ID}.jsonl"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let file = File::create(&path).unwrap();
            file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age)).unwrap();
        }
        fs::write(dir.join("secret.jsonl"), "x").unwrap();
        assert_eq!(find(&dir, ID), Some(dir.join("b").join(format!("{ID}.jsonl"))));
        for bad in ["", "../secret", "secret", "..\\secret", "00000000-0000-0000-0000-000000000000"] {
            assert_eq!(find(&dir, bad), None, "{bad}");
        }
        assert_eq!(find(&dir.join("missing"), ID), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
