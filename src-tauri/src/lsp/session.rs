//! One running language server: its pipes, its threads and its end. Knows nothing of Tauri.

use std::collections::VecDeque;
use std::io::{BufReader, Read};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::framing::{self, MAX_BODY};
use super::tree::Tree;

/// How long a server has to end by itself after its input closed.
pub const STOP_GRACE: Duration = Duration::from_millis(2000);
/// How long the pipes get to deliver what is left after the server ended.
const DRAIN: Duration = Duration::from_millis(2000);
/// How much may wait to be written before the server counts as hung.
pub const MAX_QUEUED: usize = MAX_BODY;
const STDERR_TAIL: usize = 8 * 1024;

#[derive(Debug)]
pub enum Event {
    Message(String),
    /// The last one, exactly once.
    Exit { code: Option<i32>, stderr: String },
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Session {
    /// `None` once stopping: no more input.
    input: Mutex<Option<mpsc::Sender<String>>>,
    /// Bytes handed over and not yet written.
    queued: AtomicUsize,
    tree: Tree,
    ended: Mutex<bool>,
    ended_now: Condvar,
    /// Why Mango ended it, for the exit event.
    reason: Mutex<Option<String>>,
}

/// What [`Session::begin`] needs and nobody else does.
pub struct Io {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    queue: mpsc::Receiver<String>,
}

impl Session {
    /// Start the process. Nothing is read or written until [`Session::begin`], so the caller can
    /// register it first.
    pub fn spawn(mut cmd: Command) -> Result<(Arc<Session>, Io), String> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (mut child, tree) = Tree::spawn(&mut cmd).map_err(|e| e.to_string())?;
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            tree.kill();
            let _ = child.wait();
            return Err("it has no input or output".into());
        };
        let (sender, queue) = mpsc::channel();
        let session = Session {
            input: Mutex::new(Some(sender)),
            queued: AtomicUsize::new(0),
            tree,
            ended: Mutex::new(false),
            ended_now: Condvar::new(),
            reason: Mutex::new(None),
        };
        Ok((Arc::new(session), Io { child, stdin, stdout, stderr, queue }))
    }

    /// Give up on a session that never began: no events.
    pub fn abandon(&self, mut io: Io) {
        self.kill();
        let _ = self.tree.wait(&mut io.child);
    }

    /// Start moving bytes. `on_event` gets every message in order, then the exit, and nothing after it.
    pub fn begin(self: &Arc<Self>, io: Io, on_event: impl Fn(Event) + Send + Sync + 'static) {
        let Io { mut child, mut stdin, stdout, stderr, queue } = io;
        let on_event = Arc::new(on_event);
        // Held while an event goes out, so no message follows the exit.
        let over = Arc::new(Mutex::new(false));
        let (drained, all_drained) = mpsc::channel::<()>();

        // Writer: a server that stops reading blocks only this thread, until it is killed.
        let me = self.clone();
        std::thread::spawn(move || {
            while let Ok(message) = queue.recv() {
                if framing::write_message(&mut stdin, &message).is_err() {
                    me.stop();
                    return;
                }
                me.queued.fetch_sub(message.len(), Ordering::SeqCst);
            }
            // Dropping stdin is the server's end of input.
        });

        let (me, emit, done, out_drained) = (self.clone(), on_event.clone(), over.clone(), drained.clone());
        std::thread::spawn(move || {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            loop {
                match framing::read_message(&mut reader) {
                    Ok(Some(message)) => {
                        let done = lock(&done);
                        if *done {
                            break;
                        }
                        emit(Event::Message(message));
                    }
                    // Without its output a server is of no use.
                    Ok(None) => {
                        me.stop();
                        break;
                    }
                    Err(e) => {
                        me.fail(format!("Mango stopped the language server: {e}."));
                        break;
                    }
                }
            }
            let _ = out_drained.send(());
        });

        let tail = Arc::new(Mutex::new(Tail::default()));
        let kept = tail.clone();
        std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut buf = [0u8; 8 * 1024];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => lock(&kept).push(&buf[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            let _ = drained.send(());
        });

        let me = self.clone();
        std::thread::spawn(move || {
            let code = me.tree.wait(&mut child).ok().and_then(|status| status.code());
            lock(&me.input).take();
            *lock(&me.ended) = true;
            me.ended_now.notify_all();

            // A process that escaped the tree could hold the pipes open for good: don't wait forever.
            let deadline = Instant::now() + DRAIN;
            for _ in 0..2 {
                if all_drained.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() {
                    break;
                }
            }
            let mut stderr = lock(&tail).text();
            if let Some(reason) = lock(&me.reason).take() {
                if !stderr.is_empty() && !stderr.ends_with('\n') {
                    stderr.push('\n');
                }
                stderr.push_str(&reason);
            }
            let mut over = lock(&over);
            *over = true;
            on_event(Event::Exit { code, stderr });
        });
    }

    /// Queue one message. Never waits for the server.
    pub fn send(self: &Arc<Self>, message: String) -> Result<(), String> {
        let len = message.len();
        if len > MAX_BODY {
            return Err("That message is too large to send to a language server.".into());
        }
        let input = lock(&self.input);
        let sender = input.as_ref().ok_or("The language server is stopping.")?;
        if self.queued.load(Ordering::SeqCst) + len > MAX_QUEUED {
            drop(input);
            // Dropping a change would leave it with a wrong idea of the document: end it instead.
            let reason = "Mango stopped the language server: it no longer reads its input.";
            self.fail(reason.into());
            return Err(reason.into());
        }
        self.queued.fetch_add(len, Ordering::SeqCst);
        sender.send(message).map_err(|_| "The language server is no longer running.".to_string())
    }

    /// Close its input once what is queued is written, and kill the tree if that does not end it
    /// within [`STOP_GRACE`]. Returns at once.
    pub fn stop(self: &Arc<Self>) {
        if lock(&self.input).take().is_none() {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let (ended, _) = me
                .ended_now
                .wait_timeout_while(lock(&me.ended), STOP_GRACE, |ended| !*ended)
                .unwrap_or_else(|e| e.into_inner());
            let hung = !*ended;
            drop(ended);
            if hung {
                me.tree.kill();
            }
        });
    }

    /// End it for `reason`. On a thread of its own: `send` is called on the UI thread, and finding
    /// a tree's processes takes a moment on Unix.
    fn fail(self: &Arc<Self>, reason: String) {
        lock(&self.reason).get_or_insert(reason);
        lock(&self.input).take();
        let me = self.clone();
        std::thread::spawn(move || me.tree.kill());
    }

    /// End the whole tree now.
    pub fn kill(&self) {
        lock(&self.input).take();
        self.tree.kill();
    }
}

/// The last [`STDERR_TAIL`] bytes written to it.
#[derive(Default)]
struct Tail {
    bytes: VecDeque<u8>,
    cut: bool,
}

impl Tail {
    fn push(&mut self, data: &[u8]) {
        self.bytes.extend(data);
        let extra = self.bytes.len().saturating_sub(STDERR_TAIL);
        self.bytes.drain(..extra);
        self.cut |= extra > 0;
    }

    fn text(&self) -> String {
        // Cut in the middle of a character: leave its rest out.
        let bytes: Vec<u8> = self.bytes.iter().copied().skip_while(|b| self.cut && b & 0xC0 == 0x80).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[test]
fn stderr_tail_is_bounded() {
    let mut tail = Tail::default();
    tail.push("é".repeat(STDERR_TAIL).as_bytes());
    tail.push(b"!");
    let text = tail.text();
    assert!(text.len() <= STDERR_TAIL);
    assert!(text.starts_with('é') && text.ends_with("é!"));
}
