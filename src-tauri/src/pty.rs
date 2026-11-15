//! Pseudo-terminals running the user's login shell.
//!
//! Each session has a reader thread that streams output as `pty://data`
//! events and a waiter thread that reports `pty://exit` once the shell ends.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const READ_BUF_SIZE: usize = 16 * 1024;
/// How long the waiter gives the reader to drain output after the child exits.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(1000);

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PtySession>> {
        // A panic while holding the lock leaves the map itself usable.
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn remove(&self, id: &str) -> Option<PtySession> {
        self.lock().remove(id)
    }

    /// Kill every shell; used when the app exits.
    pub fn kill_all(&self) {
        let sessions: Vec<PtySession> = self.lock().drain().map(|(_, s)| s).collect();
        for mut session in sessions {
            let _ = session.killer.kill();
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyDataEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    id: String,
    code: Option<i32>,
}

/// Incremental UTF-8 decoder: a multi-byte character split across two reads
/// is held back until its remaining bytes arrive. Invalid bytes become U+FFFD.
#[derive(Default)]
pub(crate) struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn decode(&mut self, input: &[u8]) -> String {
        let joined;
        let mut rest: &[u8] = if self.pending.is_empty() {
            input
        } else {
            let mut buf = std::mem::take(&mut self.pending);
            buf.extend_from_slice(input);
            joined = buf;
            &joined
        };

        let mut out = String::with_capacity(rest.len());
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    // Safe: `valid_up_to` guarantees this prefix is valid UTF-8.
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[bad..];
                        }
                        None => {
                            // Incomplete sequence at the end: keep for next read.
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// Flush whatever is left at EOF (an incomplete sequence becomes U+FFFD).
    pub fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

/// The shell for a terminal opened without an explicit choice: the user's
/// login shell on Unix, PowerShell on Windows (see `shells::discover`).
fn default_shell() -> (String, Vec<String>) {
    if let Some(p) = crate::shells::default_profile() {
        return (p.path, p.args);
    }
    #[cfg(windows)]
    {
        ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
    }
    #[cfg(not(windows))]
    {
        ("/bin/sh".to_string(), vec!["-l".to_string()])
    }
}

fn resolve_cwd(cwd: Option<String>) -> PathBuf {
    cwd.map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    command: Option<Vec<String>>,
) -> Result<String, String> {
    start(app, &state, cwd, cols, rows, command, &[])
}

/// Open a PTY running `command` (or the login shell) with extra `env`, and
/// stream it as `pty://data` / `pty://exit`. Returns the terminal id.
pub(crate) fn start(
    app: AppHandle,
    state: &PtyState,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    command: Option<Vec<String>>,
    env: &[(&str, &str)],
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| format!("Could not open a terminal: {e}"))?;

    // A specific program (e.g. `claude auth login` from Settings) or the login shell.
    let (shell, mut cmd) = match command.filter(|c| !c.is_empty()) {
        Some(argv) => {
            // Bare names are resolved the way agents are found, so GUI launches
            // with a minimal PATH still find CLIs in ~/.local/bin and friends.
            let program = crate::bin::find(&argv[0])
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| argv[0].clone());
            let mut cmd = CommandBuilder::new(&program);
            cmd.args(&argv[1..]);
            if let Some(path) = crate::bin::augmented_path(std::path::Path::new(&program).parent()) {
                cmd.env("PATH", path);
            }
            (program, cmd)
        }
        None => {
            let (shell, args) = default_shell();
            let mut cmd = CommandBuilder::new(&shell);
            cmd.args(args);
            (shell, cmd)
        }
    };
    cmd.cwd(resolve_cwd(cwd));
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "mango");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Could not start {shell}: {e}"))?;
    // Only the child should hold the slave side, so EOF arrives when it exits.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not read from the terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Could not write to the terminal: {e}"))?;
    let killer = child.clone_killer();

    let id = uuid::Uuid::new_v4().to_string();
    state.lock().insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            killer,
        },
    );

    // Reader: stream output until EOF.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                read_loop(&app, &id, reader);
                let _ = done_tx.send(());
            })
            .map_err(|e| format!("Could not start terminal reader: {e}"))?;
    }

    // Waiter: report the exit code once the shell is gone and output drained.
    {
        let id = id.clone();
        std::thread::Builder::new()
            .name(format!("pty-wait-{id}"))
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                let _ = done_rx.recv_timeout(DRAIN_TIMEOUT);
                // Dropping the session closes the master (needed on Windows
                // for the reader to see EOF). No-op if pty_kill already did.
                let session = app.state::<PtyState>().remove(&id);
                drop(session);
                let _ = app.emit("pty://exit", PtyExitEvent { id, code });
            })
            .map_err(|e| format!("Could not start terminal waiter: {e}"))?;
    }

    Ok(id)
}

fn read_loop(app: &AppHandle, id: &str, mut reader: Box<dyn Read + Send>) {
    let mut buf = vec![0u8; READ_BUF_SIZE];
    let mut decoder = Utf8Decoder::default();
    let emit = |data: String| {
        if !data.is_empty() {
            let _ = app.emit(
                "pty://data",
                PtyDataEvent {
                    id: id.to_string(),
                    data,
                },
            );
        }
    };
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => emit(decoder.decode(&buf[..n])),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // EIO on Linux once the slave side is closed.
            Err(_) => break,
        }
    }
    emit(decoder.finish());
}

#[tauri::command]
pub async fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let writer = state
        .lock()
        .get(&id)
        .map(|s| Arc::clone(&s.writer))
        .ok_or_else(|| format!("Terminal {id} is not running"))?;
    // Write without holding the sessions lock so one busy shell can't block others.
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Could not write to terminal: {e}"))
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.lock();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("Terminal {id} is not running"))?;
    session
        .master
        .resize(size(cols, rows))
        .map_err(|e| format!("Could not resize terminal: {e}"))
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    // Killing an unknown/finished terminal is not an error: the goal is met.
    if let Some(mut session) = state.remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Utf8Decoder;

    #[test]
    fn ascii_passthrough() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.decode(b"hello"), "hello");
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn split_multibyte_across_reads() {
        // "é" = C3 A9, "€" = E2 82 AC, "🥭" = F0 9F A5 AD
        let bytes = "aé€🥭z".as_bytes();
        for split in 0..=bytes.len() {
            let mut d = Utf8Decoder::default();
            let mut out = d.decode(&bytes[..split]);
            out.push_str(&d.decode(&bytes[split..]));
            out.push_str(&d.finish());
            assert_eq!(out, "aé€🥭z", "split at {split}");
        }
    }

    #[test]
    fn byte_by_byte() {
        let mut d = Utf8Decoder::default();
        let out: String = "🥭 mango ✓".bytes().map(|b| d.decode(&[b])).collect();
        assert_eq!(out, "🥭 mango ✓");
    }

    #[test]
    fn holds_back_only_incomplete_tail() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.decode(&[b'x', 0xF0, 0x9F]), "x");
        assert_eq!(d.decode(&[0xA5, 0xAD, b'y']), "🥭y");
    }

    #[test]
    fn invalid_bytes_become_replacement() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.decode(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        // Truncated sequence at EOF is flushed as a replacement character.
        assert_eq!(d.decode(&[0xE2, 0x82]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
    }
}
