//! The bridge end to end: a fake server (this test binary again, see [`fake_server`]) and,
//! ignored, the real ones:
//!
//! `cargo test lsp::tests::real -- --ignored --nocapture --test-threads=1`
//!
//! `MANGO_LSP_TEST_DIRS` (PATH syntax) is searched first, for servers installed in a scratch folder.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::resolve::{Root, Search};
use super::session::{Event, Session, MAX_QUEUED, STOP_GRACE};
use super::test_support::Scratch;
use super::*;

const FAKE: &str = "MANGO_LSP_FAKE";
const WAIT: Duration = Duration::from_secs(15);

// ---------------------------------------------------------------------------
// The fake server
// ---------------------------------------------------------------------------

/// This test binary as a server. The test harness prints to stdout first, with no line ending
/// before the first header: the stray output a bridge has to live with.
fn fake(mode: &str) -> Command {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    crate::bin::hide_console(&mut cmd);
    cmd.args(["lsp::tests::fake_server", "--exact", "--nocapture", "--test-threads=1"]).env(FAKE, mode);
    cmd
}

/// A child holding the server's pipes, as tsserver does below node.
fn fake_grandchild() -> u32 {
    let mut cmd = fake("sleep");
    cmd.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    cmd.spawn().unwrap().id()
}

#[test]
fn fake_server() {
    let Ok(mode) = std::env::var(FAKE) else { return };
    let mut out = std::io::stdout();
    let mut input = std::io::BufReader::new(std::io::stdin());
    let forever = || std::thread::sleep(Duration::from_secs(60));
    let send_pids = |out: &mut std::io::Stdout| {
        let pids = json!({ "pids": [std::process::id(), fake_grandchild()] });
        framing::write_message(out, &pids.to_string()).unwrap();
    };
    match mode.as_str() {
        "sleep" => forever(),
        "echo" => {
            while let Some(message) = framing::read_message(&mut input).unwrap() {
                framing::write_message(&mut out, &message).unwrap();
            }
            eprintln!("bye");
            std::process::exit(0);
        }
        // Ends at the end of its input, leaving a child behind.
        "children" => {
            send_pids(&mut out);
            while framing::read_message(&mut input).unwrap().is_some() {}
            std::process::exit(0);
        }
        // Takes no notice of the end of its input.
        "stubborn" => {
            send_pids(&mut out);
            while framing::read_message(&mut input).unwrap().is_some() {}
            forever();
        }
        // Never reads at all.
        "deaf" => {
            send_pids(&mut out);
            forever();
        }
        "crash" => {
            send_pids(&mut out);
            let mut err = std::io::stderr();
            err.write_all(&b"noise\n".repeat(20_000)).unwrap();
            err.write_all(b"the cause\n").unwrap();
            std::process::exit(3);
        }
        "broken" => {
            out.write_all(format!("\nContent-Length: {}\r\n\r\n", framing::MAX_BODY + 1).as_bytes()).unwrap();
            out.flush().unwrap();
            forever();
        }
        // Stands for Mango: starts a server tree, says its pids, and dies without cleaning up.
        "owner" => {
            let run = Run::start(fake("deaf"));
            let pids = json!({ "pids": run.pids() });
            framing::write_message(&mut out, &pids.to_string()).unwrap();
            // Until the test has handles on them.
            let _ = framing::read_message(&mut input);
            std::process::exit(0);
        }
        other => panic!("unknown fake {other}"),
    }
}

// ---------------------------------------------------------------------------
// Watching a run
// ---------------------------------------------------------------------------

struct Run {
    session: Arc<Session>,
    events: mpsc::Receiver<Event>,
}

impl Run {
    fn start(cmd: Command) -> Run {
        let (session, io) = Session::spawn(cmd).unwrap();
        Run::begin(session, io)
    }

    fn begin(session: Arc<Session>, io: session::Io) -> Run {
        let (tx, events) = mpsc::channel();
        session.begin(io, move |event| {
            let _ = tx.send(event);
        });
        Run { session, events }
    }

    fn message(&self, within: Duration) -> String {
        match self.events.recv_timeout(within) {
            Ok(Event::Message(message)) => message,
            other => panic!("expected a message, got {other:?}"),
        }
    }

    fn pids(&self) -> Vec<u32> {
        let value: Value = serde_json::from_str(&self.message(WAIT)).unwrap();
        value["pids"].as_array().unwrap().iter().map(|p| p.as_u64().unwrap() as u32).collect()
    }

    /// The exit, and that it is the last event and the only exit.
    fn exit(&self, within: Duration) -> (Option<i32>, String) {
        let deadline = Instant::now() + within;
        loop {
            match self.events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Event::Message(_)) => {}
                Ok(Event::Exit { code, stderr }) => {
                    if let Ok(after) = self.events.recv_timeout(Duration::from_millis(400)) {
                        panic!("{after:?} came after the exit");
                    }
                    return (code, stderr);
                }
                Err(e) => panic!("no exit: {e}"),
            }
        }
    }
}

/// A process of a tree, followed by handle on Windows so a reused pid can't fool the test.
struct Watched {
    pid: u32,
    #[cfg(windows)]
    handle: Option<std::os::windows::io::OwnedHandle>,
}

impl Watched {
    #[cfg(windows)]
    fn new(pid: u32) -> Watched {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        // SAFETY: plain call; the handle is owned from here on. None: it is gone already.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).ok().map(|h| OwnedHandle::from_raw_handle(h.0)) };
        Watched { pid, handle }
    }

    #[cfg(windows)]
    fn alive(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{HANDLE, WAIT_TIMEOUT};
        use windows::Win32::System::Threading::WaitForSingleObject;
        // SAFETY: the handle is open for as long as `self` is.
        self.handle.as_ref().is_some_and(|h| unsafe { WaitForSingleObject(HANDLE(h.as_raw_handle()), 0) } == WAIT_TIMEOUT)
    }

    #[cfg(unix)]
    fn new(pid: u32) -> Watched {
        Watched { pid }
    }

    #[cfg(unix)]
    fn alive(&self) -> bool {
        // SAFETY: signal 0 only asks.
        unsafe { libc::kill(self.pid as libc::pid_t, 0) == 0 }
    }
}

fn all_gone(watched: &[Watched]) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let left: Vec<u32> = watched.iter().filter(|w| w.alive()).map(|w| w.pid).collect();
        if left.is_empty() {
            return;
        }
        assert!(Instant::now() < deadline, "still running: {left:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn watch(pids: Vec<u32>) -> Vec<Watched> {
    let watched: Vec<Watched> = pids.into_iter().map(Watched::new).collect();
    assert!(watched.iter().all(Watched::alive), "the tree should be up first");
    watched
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[test]
fn messages_keep_their_order_and_a_stop_delivers_them() {
    let run = Run::start(fake("echo"));
    let big = format!("\"{}\"", "größer 🥭 ".repeat(150_000));
    let mut sent: Vec<String> = (0..2000).map(|i| json!({ "id": i }).to_string()).collect();
    sent.insert(7, big);
    for message in &sent {
        run.session.send(message.clone()).unwrap();
    }
    // Stopped with all of that still queued: it is written first, then the input closes.
    run.session.stop();
    assert!(run.session.send("{}".into()).is_err(), "no input after a stop");
    for message in &sent {
        assert_eq!(&run.message(WAIT), message);
    }
    let (code, stderr) = run.exit(WAIT);
    assert_eq!(code, Some(0));
    assert!(stderr.contains("bye"), "{stderr}");
}

#[test]
fn a_stop_right_after_a_send_still_delivers_it() {
    let run = Run::start(fake("echo"));
    run.session.send("{\"method\":\"exit\"}".into()).unwrap();
    run.session.stop();
    assert_eq!(run.message(WAIT), "{\"method\":\"exit\"}");
    assert_eq!(run.exit(WAIT).0, Some(0));
}

#[test]
fn a_stop_ends_what_the_server_started() {
    let run = Run::start(fake("children"));
    let tree = watch(run.pids());
    run.session.stop();
    run.session.stop();
    let (code, _) = run.exit(WAIT);
    assert_eq!(code, Some(0), "it got to end by itself");
    all_gone(&tree);
}

#[test]
fn a_server_ignoring_the_end_of_its_input_is_killed() {
    let run = Run::start(fake("stubborn"));
    let tree = watch(run.pids());
    let started = Instant::now();
    run.session.stop();
    assert!(started.elapsed() < Duration::from_millis(100), "stop returns at once");
    run.exit(STOP_GRACE + Duration::from_secs(5));
    assert!(started.elapsed() >= STOP_GRACE);
    all_gone(&tree);
}

#[test]
fn a_server_not_reading_blocks_nobody() {
    let run = Run::start(fake("deaf"));
    let tree = watch(run.pids());
    let message = "x".repeat(8 * 1024 * 1024);
    let mut refused = None;
    for _ in 0..=MAX_QUEUED / message.len() {
        let copy = message.clone();
        let started = Instant::now();
        let result = run.session.send(copy);
        assert!(started.elapsed() < Duration::from_millis(250), "a send waited for the server");
        if let Err(e) = result {
            refused = Some(e);
            break;
        }
    }
    assert!(refused.expect("the queue has a limit").contains("no longer reads"));
    assert!(run.exit(WAIT).1.contains("no longer reads"));
    all_gone(&tree);
}

#[test]
fn a_stop_gets_through_to_a_server_not_reading() {
    let run = Run::start(fake("deaf"));
    let tree = watch(run.pids());
    // Enough to block the writer.
    run.session.send("x".repeat(4 * 1024 * 1024)).unwrap();
    run.session.stop();
    run.exit(STOP_GRACE + Duration::from_secs(5));
    all_gone(&tree);
}

#[test]
fn a_kill_is_immediate() {
    let run = Run::start(fake("deaf"));
    let tree = watch(run.pids());
    run.session.kill();
    all_gone(&tree);
    run.exit(WAIT);
}

#[test]
fn a_crash_is_one_exit_with_the_end_of_stderr() {
    let run = Run::start(fake("crash"));
    let tree: Vec<Watched> = run.pids().into_iter().map(Watched::new).collect();
    let (code, stderr) = run.exit(WAIT);
    assert_eq!(code, Some(3));
    assert!(stderr.ends_with("the cause\n") && stderr.len() <= 8 * 1024, "{} bytes", stderr.len());
    all_gone(&tree);
}

#[test]
fn broken_framing_ends_the_session() {
    let run = Run::start(fake("broken"));
    let (_, stderr) = run.exit(WAIT);
    assert!(stderr.contains("more than Mango accepts"), "{stderr}");
}

#[test]
fn abandoning_leaves_nothing_running() {
    let cmd = fake("echo");
    let (session, io) = Session::spawn(cmd).unwrap();
    let started = Instant::now();
    session.abandon(io);
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// Only Windows can promise this; elsewhere a crash is the end of the servers' input.
#[cfg(windows)]
#[test]
fn nothing_outlives_mango() {
    let mut cmd = fake("owner");
    let mut owner = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut out = std::io::BufReader::new(owner.stdout.take().unwrap());
    let value: Value = serde_json::from_str(&framing::read_message(&mut out).unwrap().unwrap()).unwrap();
    let tree = watch(value["pids"].as_array().unwrap().iter().map(|p| p.as_u64().unwrap() as u32).collect());
    drop(owner.stdin.take());
    owner.wait().unwrap();
    all_gone(&tree);
}

// ---------------------------------------------------------------------------
// Who owns what
// ---------------------------------------------------------------------------

#[test]
fn ids() {
    for good in ["a", "ts-1", "lsp:6f1c_77.2", "0b9f4c0e-1d2a-4b7e-9c55-6a1f0f3d2e11"] {
        assert!(check_id(good).is_ok(), "{good}");
    }
    for bad in ["", "a b", "a/b", "a\\b", "ü", "a\n", &"x".repeat(129)] {
        assert!(check_id(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn starting_sessions_can_be_stopped() {
    let (session, io) = Session::spawn(fake("echo")).unwrap();
    let mut all = Sessions::default();

    // Stopped while starting.
    let token = all.reserve("main", "a").unwrap();
    assert!(all.stop("main", "a").is_none());
    assert!(all.attach("a", token, &session, None).is_err());
    // Stopping it again is late, not early: the id can start again.
    all.stop("main", "a");
    assert!(all.reserve("main", "a").is_ok());

    // Stopped before the start got to run.
    all.stop("main", "b");
    assert!(all.reserve("main", "b").is_err());
    assert!(all.reserve("main", "b").is_ok(), "it counts once");

    // Stopped after it ended.
    let token = all.reserve("main", "c").unwrap();
    let _ = all.forget("c", token);
    all.stop("main", "c");
    assert!(all.reserve("main", "c").is_ok());

    // The page reloaded while it was starting.
    let token = all.reserve("w-1", "d").unwrap();
    assert!(all.page_gone("w-1").is_empty());
    assert!(all.attach("d", token, &session, None).is_err());
    session.abandon(io);
}

#[test]
fn each_window_has_its_own_sessions() {
    let (session, io) = Session::spawn(fake("echo")).unwrap();
    let mut all = Sessions::default();
    let token = all.reserve("w-1", "x").unwrap();
    assert!(all.attach("x", token, &session, None).is_ok());
    assert!(all.reserve("main", "x").is_err(), "the id is taken");
    assert!(all.session("main", "x").is_none() && all.session("w-1", "x").is_some());
    assert!(all.stop("main", "x").is_none() && all.page_gone("main").is_empty(), "another window's");

    // Still listed while it stops, so exiting kills it.
    assert!(all.stop("w-1", "x").is_some());
    assert_eq!(all.page_gone("w-1").len(), 1);
    assert_eq!(all.close().len(), 1);
    assert!(all.reserve("main", "y").is_err(), "closed");
    session.abandon(io);
}

#[test]
fn a_window_has_a_limit() {
    let mut all = Sessions::default();
    for i in 0..MAX_PER_WINDOW {
        all.reserve("main", &format!("s{i}")).unwrap();
    }
    assert!(all.reserve("main", "more").is_err());
    assert!(all.reserve("w-1", "more").is_ok());
}

#[test]
fn the_contract_uses_camel_case() {
    let list = list_servers(&Search::new([], None));
    let value = serde_json::to_value(&list).unwrap();
    assert_eq!(value.as_array().unwrap().len(), 6);
    let first = &value[0];
    assert_eq!(first["id"], "typescript");
    assert_eq!(first["installed"], false);
    assert!(first["path"].is_null() && first["install"].is_null(), "nothing to install it with");
    assert!(first["helpUrl"].as_str().unwrap().starts_with("https://"));
}

// ---------------------------------------------------------------------------
// What the project can't do
// ---------------------------------------------------------------------------

/// cmd.exe in a shim looking for `node`, with one planted in the project.
#[cfg(windows)]
#[test]
fn a_shim_does_not_run_the_projects_node() {
    const PLANTED: &str = "@echo off\r\necho planted 1>&2\r\n";
    let server = servers::by_id("typescript").unwrap();
    let scratch = Scratch::new("hijack");
    let name = "pro ject & %PATH% ^ größer (1)!";
    let project = scratch.dir(name);
    for file in ["node.cmd", "node.bat", "cmd.cmd", "typescript-language-server.cmd"] {
        scratch.write(&format!("{name}/{file}"), PLANTED);
    }
    scratch.write(&format!("{name}/node_modules/.bin/node.cmd"), PLANTED);
    let root = Root::open(project.to_str().unwrap()).unwrap();

    let odd = "tools R&D %PATH% ^ größer (1)!";
    // As pnpm's shim does: the node beside it, else whatever `node` finds.
    scratch.write(
        &format!("{odd}/typescript-language-server.cmd"),
        "@echo off\r\necho shim %* 1>&2\r\nnode %*\r\n",
    );
    let mut dirs = vec![PathBuf::new(), PathBuf::from("."), project.clone(), project.join(r"node_modules\.bin"), scratch.dir(odd)];

    let run = |dirs: &[PathBuf]| {
        let search = Search::new(dirs.to_vec(), Some(&root));
        let (session, io) = spawn_server(&search, server, &root).unwrap();
        Run::begin(session, io).exit(WAIT).1
    };
    let stderr = run(&dirs);
    assert!(stderr.contains("shim --stdio"), "the shim with the odd path didn't run: {stderr}");
    assert!(!stderr.contains("planted"), "{stderr}");

    scratch.write("node dir/node.cmd", "@echo off\r\necho real node %* 1>&2\r\n");
    dirs.push(scratch.dir("node dir"));
    let stderr = run(&dirs);
    assert!(stderr.contains("real node --stdio") && !stderr.contains("planted"), "{stderr}");
}

/// What the server looks up by name itself, with the project as its working folder.
#[cfg(windows)]
#[test]
fn the_child_does_not_search_the_project_either() {
    let server = servers::by_id("go").unwrap();
    let scratch = Scratch::new("implicit");
    let project = scratch.dir("app");
    let tools = scratch.dir("tools");
    // where.exe stands in for a program, cmd.exe for a server looking it up by name.
    std::fs::copy(Path::new(r"C:\Windows\System32\where.exe"), project.join("plantedtool.exe")).unwrap();
    super::test_support::program_file(&tools, "gopls");
    let root = Root::open(project.to_str().unwrap()).unwrap();
    let search = Search::new([tools], Some(&root));
    let (program, path) = search.find(server).unwrap();
    let launch = search.launch(program, path, &root);
    let configured = launch.command(&search).unwrap();

    let mut probe = Command::new(resolve::cmd_exe());
    crate::bin::hide_console(&mut probe);
    // Only what the bridge sets counts, not what this test happens to inherit.
    probe.args(["/d", "/c", "plantedtool", "/?"]).current_dir(&launch.cwd).env_remove(resolve::NO_CWD_SEARCH);
    let mut control = Command::new(resolve::cmd_exe());
    crate::bin::hide_console(&mut control);
    control.args(["/d", "/c", "plantedtool", "/?"]).current_dir(&launch.cwd).env_remove(resolve::NO_CWD_SEARCH);
    assert!(control.output().unwrap().status.success(), "without the variable the project's program runs");
    for (key, value) in configured.get_envs() {
        probe.env(key, value.unwrap());
    }
    assert!(!probe.output().unwrap().status.success(), "the project's program ran");
}

#[cfg(unix)]
#[test]
fn a_script_does_not_run_the_projects_node() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("hijack");
    let script = |rel: &str, text: &str| {
        let file = scratch.write(rel, text);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    let project = scratch.dir("pro ject");
    script("pro ject/node", "#!/bin/sh\necho planted >&2\n");
    script("tools/typescript-language-server", "#!/usr/bin/env node\n");
    script("tools/node", "#!/bin/sh\necho real node >&2\n");
    let root = Root::open(project.to_str().unwrap()).unwrap();
    let search = Search::new([PathBuf::from("."), project, scratch.dir("tools"), PathBuf::from("/usr/bin"), PathBuf::from("/bin")], Some(&root));
    let (session, io) = spawn_server(&search, servers::by_id("typescript").unwrap(), &root).unwrap();
    let (_, stderr) = Run::begin(session, io).exit(WAIT);
    assert!(stderr.contains("real node") && !stderr.contains("planted"), "{stderr}");
}

// ---------------------------------------------------------------------------
// The real servers
// ---------------------------------------------------------------------------

fn test_dirs() -> Vec<PathBuf> {
    std::env::var_os("MANGO_LSP_TEST_DIRS").map(|v| std::env::split_paths(&v).collect()).unwrap_or_default()
}

/// The search Mango would use, with the test folders first.
fn real_search(root: &Root) -> Search {
    let go = dirs::home_dir().unwrap().join("go").join("bin");
    let dirs = test_dirs().into_iter().chain(crate::bin::search_dirs()).chain([go]);
    Search::new(dirs, Some(root))
}

/// Everything below this test that runs now, children of children included.
#[cfg(windows)]
fn descendants() -> Vec<u32> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut pairs = Vec::new();
    // SAFETY: the handle is owned at once and `entry` says its own size.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).unwrap();
        let _snapshot = OwnedHandle::from_raw_handle(snapshot.0);
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut next = Process32FirstW(snapshot, &mut entry);
        while next.is_ok() {
            pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
            next = Process32NextW(snapshot, &mut entry);
        }
    }
    below(&pairs)
}

#[cfg(unix)]
fn descendants() -> Vec<u32> {
    let mut cmd = Command::new("/bin/ps");
    crate::bin::hide_console(&mut cmd);
    let out = cmd.args(["-A", "-o", "pid=,ppid="]).output().unwrap();
    let pairs: Vec<(u32, u32)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            Some((words.next()?.parse().ok()?, words.next()?.parse().ok()?))
        })
        .collect();
    below(&pairs)
}

fn below(pairs: &[(u32, u32)]) -> Vec<u32> {
    let me = std::process::id();
    let mut found = vec![me];
    let mut at = 0;
    while let Some(&parent) = found.get(at) {
        for &(pid, ppid) in pairs {
            if ppid == parent && pid != 0 && !found.contains(&pid) {
                found.push(pid);
            }
        }
        at += 1;
    }
    found.remove(0);
    found
}

struct Case {
    server: &'static str,
    language: &'static str,
    file: &'static str,
    text: &'static str,
    extra: &'static [(&'static str, &'static str)],
    /// Where to complete, and what must be among the answers.
    at: (u32, u32),
    expect: &'static str,
}

const TYPESCRIPT: Case = Case {
    server: "typescript",
    language: "typescript",
    file: "main.ts",
    text: "const word = 'mango'\nword.toUpp\n",
    extra: &[("package.json", "{}"), ("tsconfig.json", "{}")],
    at: (1, 10),
    expect: "toUpperCase",
};
const PYTHON: Case = Case {
    server: "python",
    language: "python",
    file: "main.py",
    text: "word = 'mango'\nword.uppe\n",
    extra: &[],
    at: (1, 9),
    expect: "upper",
};
const GO: Case = Case {
    server: "go",
    language: "go",
    file: "main.go",
    text: "package main\n\nimport \"strings\"\n\nfunc main() {\n\t_ = strings.ToUpp\n}\n",
    extra: &[("go.mod", "module example.com/scratch\n\ngo 1.21\n")],
    at: (5, 18),
    expect: "ToUpper",
};
const CPP: Case = Case {
    server: "clangd",
    language: "cpp",
    file: "main.cpp",
    text: "int mango_ripeness() { return 1; }\n\nint main() {\n    return mango_ripe\n}\n",
    extra: &[],
    at: (3, 21),
    expect: "mango_ripeness",
};
const CSHARP: Case = Case {
    server: "csharp",
    language: "csharp",
    file: "Program.cs",
    text: "class Program {\n    static int MangoRipeness() => 1;\n\n    static void Main() {\n        MangoRipe\n    }\n}\n",
    extra: &[(
        "scratch.csproj",
        "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup></Project>",
    )],
    at: (4, 17),
    expect: "MangoRipeness",
};
/// A workspace on TypeScript 7, which has no tsserver: the installed TypeScript takes over.
const TYPESCRIPT_7: Case = Case {
    extra: &[("package.json", "{}"), ("node_modules/typescript/package.json", "{\"name\":\"typescript\",\"version\":\"7.0.2\"}")],
    ..TYPESCRIPT
};
const RUST: Case = Case {
    server: "rust",
    language: "rust",
    file: "src/main.rs",
    text: "fn mango_ripeness() -> u8 {\n    1\n}\n\nfn main() {\n    mango_ripe\n}\n",
    extra: &[("Cargo.toml", "[package]\nname = \"scratch\"\nversion = \"0.0.0\"\nedition = \"2021\"\n")],
    at: (5, 14),
    expect: "mango_ripeness",
};

/// `file:` URI of an absolute path.
fn uri(path: &Path) -> String {
    let path = path.to_str().unwrap().replace('\\', "/");
    // A UNC path's server is the URI's host.
    let mut out = String::from(match path.as_bytes() {
        [b'/', b'/', ..] => "file:",
        [b'/', ..] => "file://",
        _ => "file:///",
    });
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The answer to request `id`, the server's own requests answered meanwhile.
fn answer(run: &Run, id: u64, within: Duration) -> Value {
    let deadline = Instant::now() + within;
    loop {
        let message: Value = match run.events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Message(text)) => serde_json::from_str(&text).unwrap_or_else(|e| panic!("not JSON ({e}): {text}")),
            other => panic!("no answer to {id}: {other:?}"),
        };
        match (message.get("method").and_then(Value::as_str), message.get("id")) {
            (Some(method), Some(asked)) => {
                let items = message["params"]["items"].as_array().map_or(0, Vec::len);
                let result = if method == "workspace/configuration" { json!(vec![Value::Null; items]) } else { Value::Null };
                run.session.send(json!({ "jsonrpc": "2.0", "id": asked, "result": result }).to_string()).unwrap();
            }
            (None, Some(got)) if got.as_u64() == Some(id) => return message,
            _ => {}
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum End {
    /// `shutdown`, `exit`, then `lsp_stop`, as the frontend does.
    Polite,
    /// Only `lsp_stop`.
    Stop,
    /// The app exiting.
    Kill,
}

/// initialize, didOpen, completion, the end, and nothing left running.
fn drive(case: &Case, search_for: &dyn Fn(&Root) -> Search, through_cmd: bool, end: End) {
    let scratch = Scratch::new(case.server);
    let project = format!("pro ject & 100% ^ größer/{}", case.file);
    let file = scratch.write(&project, case.text);
    for (name, text) in case.extra {
        scratch.write(&format!("pro ject & 100% ^ größer/{name}"), text);
    }
    let root = Root::open(scratch.dir("pro ject & 100% ^ größer").to_str().unwrap()).unwrap();
    let search = search_for(&root);
    let server = servers::by_id(case.server).unwrap();
    let Some((program, path)) = search.find(server) else {
        panic!("{} is not installed here; see MANGO_LSP_TEST_DIRS", server.name);
    };
    let mut launch = search.launch(program, path.clone(), &root);
    if through_cmd {
        launch.program = path;
        launch.script = None;
    }
    eprintln!("{}: {} {:?}, {end:?}", case.server, launch.program.display(), launch.script);

    let before = descendants();
    let (session, io) = Session::spawn(launch.command(&search).unwrap()).unwrap();
    let run = Run::begin(session, io);
    let send = |value: Value| run.session.send(value.to_string()).unwrap();
    let root_uri = uri(&root.real);
    send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "processId": std::process::id(),
        "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": "scratch" }],
        "capabilities": {
            "workspace": { "configuration": true, "workspaceFolders": true },
            "textDocument": { "completion": { "completionItem": { "snippetSupport": false } } },
            "window": { "workDoneProgress": true }
        }
    }}));
    let initialized = answer(&run, 1, Duration::from_secs(90));
    assert!(initialized["result"]["capabilities"]["completionProvider"].is_object(), "{initialized}");
    send(json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }));
    let document = uri(&file);
    send(json!({ "jsonrpc": "2.0", "method": "textDocument/didOpen", "params": { "textDocument": {
        "uri": document, "languageId": case.language, "version": 1, "text": case.text
    }}}));

    // Some answer before they have read the project: ask until it is there.
    let deadline = Instant::now() + Duration::from_secs(150);
    let mut id = 1;
    loop {
        id += 1;
        send(json!({ "jsonrpc": "2.0", "id": id, "method": "textDocument/completion", "params": {
            "textDocument": { "uri": document }, "position": { "line": case.at.0, "character": case.at.1 }
        }}));
        let reply = answer(&run, id, Duration::from_secs(90));
        if reply["result"].to_string().contains(case.expect) {
            break;
        }
        assert!(Instant::now() < deadline, "no {} among the completions: {reply}", case.expect);
        std::thread::sleep(Duration::from_millis(500));
    }

    let tree: Vec<Watched> = descendants().into_iter().filter(|pid| !before.contains(pid)).map(Watched::new).collect();
    assert!(!tree.is_empty());
    let count = tree.len();
    if let End::Polite = end {
        id += 1;
        send(json!({ "jsonrpc": "2.0", "id": id, "method": "shutdown" }));
        answer(&run, id, Duration::from_secs(20));
        send(json!({ "jsonrpc": "2.0", "method": "exit" }));
    }
    let ending = Instant::now();
    match end {
        End::Polite | End::Stop => run.session.stop(),
        End::Kill => run.session.kill(),
    }
    let (code, stderr) = run.exit(STOP_GRACE + Duration::from_secs(8));
    let took = ending.elapsed();
    all_gone(&tree);
    eprintln!("{}: {count} processes, all gone; exit {code:?} after {took:?}; stderr {} bytes", case.server, stderr.len());
}

#[test]
#[ignore = "needs typescript-language-server and node"]
fn real_typescript() {
    for end in [End::Polite, End::Stop, End::Kill] {
        drive(&TYPESCRIPT, &real_search, false, end);
    }
}

/// cmd.exe > node > tsserver.
#[cfg(windows)]
#[test]
#[ignore = "needs typescript-language-server installed with npm, and node"]
fn real_typescript_through_the_cmd_shim() {
    for end in [End::Polite, End::Stop, End::Kill] {
        drive(&TYPESCRIPT, &real_search, true, end);
    }
}

/// The npm prefix in a folder npm's own shim can't cope with.
#[cfg(windows)]
#[test]
#[ignore = "needs an npm prefix with typescript-language-server in MANGO_LSP_TEST_DIRS"]
fn real_typescript_from_an_odd_path() {
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &to.join(entry.file_name()));
            } else {
                std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
            }
        }
    }
    let shim = "typescript-language-server.cmd";
    let prefix = test_dirs().into_iter().find(|d| d.join(shim).is_file()).expect("an npm prefix in MANGO_LSP_TEST_DIRS");
    let scratch = Scratch::new("odd-prefix");
    let odd = scratch.dir("npm R&D %25 ^ #1 größer (x)!");
    copy(&prefix, &odd);
    let search = |root: &Root| Search::new([odd.clone()].into_iter().chain(crate::bin::search_dirs()), Some(root));
    drive(&TYPESCRIPT, &search, false, End::Stop);
}

#[test]
#[ignore = "needs pyright"]
fn real_python() {
    for end in [End::Polite, End::Stop, End::Kill] {
        drive(&PYTHON, &real_search, false, end);
    }
}

#[test]
#[ignore = "needs typescript-language-server and node"]
fn real_typescript_with_a_typescript_7_project() {
    drive(&TYPESCRIPT_7, &real_search, false, End::Polite);
}

#[test]
#[ignore = "needs clangd"]
fn real_clangd() {
    for end in [End::Polite, End::Stop, End::Kill] {
        drive(&CPP, &real_search, false, end);
    }
}

#[test]
#[ignore = "needs csharp-ls and the .NET SDK"]
fn real_csharp_ls() {
    for end in [End::Polite, End::Stop, End::Kill] {
        drive(&CSHARP, &real_search, false, end);
    }
}

#[test]
#[ignore = "needs gopls and Go"]
fn real_gopls() {
    for end in [End::Polite, End::Stop, End::Kill] {
        drive(&GO, &real_search, false, end);
    }
}

#[test]
#[ignore = "needs rust-analyzer and cargo"]
fn real_rust_analyzer() {
    for end in [End::Polite, End::Stop, End::Kill] {
        drive(&RUST, &real_search, false, end);
    }
}

/// What this computer would be offered, and how long finding out takes.
#[test]
#[ignore = "reports on this computer"]
fn real_listing() {
    let started = Instant::now();
    let list = list_servers(&Search::system(None));
    eprintln!("{}\nin {:?}", serde_json::to_string_pretty(&list).unwrap(), started.elapsed());
    assert!(started.elapsed() < Duration::from_secs(2));
}

/// The way installers are started, each only saying its version.
#[test]
#[ignore = "runs the installers' programs; installs nothing"]
fn real_installer_invocation() {
    let search = Search::system(None);
    for probe in [["npm", "--version"], ["rustup", "--version"], ["go", "version"], ["dotnet", "--version"], ["winget", "--version"]] {
        let Some(installer) = installer(&search, &crate::setup::Plan::direct(&probe, "test")) else {
            eprintln!("{}: not here", probe[0]);
            continue;
        };
        run_in_pty(&installer, &dirs::home_dir().unwrap(), &crate::bin::augmented_path(None).unwrap());
    }
}

/// An installer gets the program that was found, and finds its tools where that was found: never
/// in a project's folders or the current one.
#[cfg(windows)]
#[test]
fn installers_never_look_in_the_project() {
    let scratch = Scratch::new("installer");
    let planted = scratch.dir("app/node_modules/.bin");
    let project = scratch.dir("app");
    let good = scratch.dir("npm R&D ^ 100% größer");
    for dir in [&planted, &project] {
        std::fs::write(dir.join("npm.cmd"), "@echo bad> \"%~dp0ran.txt\"\r\n").unwrap();
        std::fs::write(dir.join("node.cmd"), "@echo bad> \"%~dp0ran-node.txt\"\r\n").unwrap();
    }
    // As npm's own shim: it goes on to look up node.
    std::fs::write(good.join("npm.cmd"), "@echo %*> \"%~dp0ran.txt\"\r\n@call node\r\n").unwrap();
    std::fs::write(good.join("node.cmd"), "@echo node> \"%~dp0ran-node.txt\"\r\n").unwrap();

    let system = resolve::cmd_exe().parent().unwrap().to_path_buf();
    // The user's PATH has the project's folders on it. No real npm is on either path.
    let inherited = std::env::join_paths([&planted, &project, &system]).unwrap();
    let search = Search::new([planted.clone(), good.clone(), system], None);
    let installer = installer(&search, &crate::setup::Plan::direct(&["npm", "probe", "-g", "typescript@6"], "test")).unwrap();
    assert!(!installer.argv.join(" ").contains("R&D"), "no path on cmd's line: {:?}", installer.argv);
    run_in_pty(&installer, &project, &inherited);

    for dir in [&planted, &project] {
        assert!(!dir.join("ran.txt").exists(), "the project's npm ran");
        assert!(!dir.join("ran-node.txt").exists(), "the project's node ran");
    }
    assert_eq!(std::fs::read_to_string(good.join("ran.txt")).unwrap().trim(), "probe -g typescript@6");
    assert!(good.join("ran-node.txt").exists());
}

#[test]
fn consent_holds_for_one_folder_only() {
    let scratch = Scratch::new("consent");
    let dir = scratch.dir("app");
    let project = dir.to_str().unwrap().to_string();
    let tree = scratch.dir("app.worktrees/fix");
    let root = tree.to_str().unwrap().to_string();
    let now = Allowed { project: project.clone(), folder: folder::id(&project).unwrap(), worktree: folder::id(&root) };
    let mut all = Sessions::default();
    assert!(check_consent(&project, all.allowed("main", &project).as_ref()).is_err(), "nobody was asked");
    let entry = dir.join(".git").join("worktrees").join("fix");
    scratch.write("app/.git/worktrees/fix/gitdir", &format!("{}\n", tree.join(".git").display()));
    scratch.write("app.worktrees/fix/.git", &format!("gitdir: {}\n", entry.display()));

    all.allow("main", &project, Some(now.clone()));
    all.allow("main", &root, Some(now.clone()));
    assert!(check_consent(&project, all.allowed("main", &project).as_ref()).is_ok());
    assert!(check_consent(&root, all.allowed("main", &root).as_ref()).is_ok(), "worktrees follow their project");
    assert_eq!(consent_folder(&root, &project, Some(&now)), Some(now.folder.clone()));
    assert!(check_consent(&project, all.allowed("w-1", &project).as_ref()).is_err(), "each window checks for itself");
    all.page_gone("w-1");
    assert!(check_consent(&project, all.allowed("main", &project).as_ref()).is_ok());

    // The worktree removed, and another repository cloned at its path.
    std::fs::remove_dir_all(&tree).unwrap();
    scratch.write("app.worktrees/fix/.git/HEAD", "ref: refs/heads/main");
    assert!(check_consent(&root, all.allowed("main", &root).as_ref()).is_err(), "another repository where a worktree was");
    assert_eq!(consent_folder(&root, &project, None), None);
    let own = Allowed { project: root.clone(), folder: folder::id(&root).unwrap(), worktree: None };
    all.allow("main", &root, Some(own));
    assert!(check_consent(&root, all.allowed("main", &root).as_ref()).is_ok(), "allowed for itself");

    std::thread::sleep(Duration::from_millis(30));
    std::fs::remove_dir_all(&dir).unwrap();
    std::fs::create_dir(&dir).unwrap();
    assert!(check_consent(&project, all.allowed("main", &project).as_ref()).is_err(), "cloned again at the same path");
    all.allow("main", &project, None);
    assert!(all.allowed("main", &project).is_none());
}

/// A repository with a worktree of it made by git: the project, the worktree.
fn with_worktree(scratch: &Scratch) -> (String, String) {
    let app = scratch.dir("app");
    git(&app, &["init", "-q"]);
    git(&app, &["commit", "-q", "--allow-empty", "-m", "first"]);
    git(&app, &["worktree", "add", "-q", "-b", "fix", "../app.worktrees/fix"]);
    let tree = scratch.path().join("app.worktrees").join("fix");
    (app.to_str().unwrap().to_string(), tree.to_str().unwrap().to_string())
}

fn git(dir: &Path, args: &[&str]) {
    let mut cmd = Command::new("git");
    crate::bin::hide_console(&mut cmd);
    cmd.current_dir(dir).args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]);
    cmd.args(["-c", "core.hooksPath=.no-hooks", "-c", "init.templateDir="]).args(args);
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_yes_reaches_only_the_worktree_bound_to_it() {
    let scratch = Scratch::new("consent-bound");
    let (project, root) = with_worktree(&scratch);
    let yes = |worktree| Allowed { project: project.clone(), folder: folder::id(&project).unwrap(), worktree };
    let bound = yes(folder::id(&root));
    let follows = |a: &Allowed| consent_folder(&root, &project, Some(a)).is_some();
    let starts = |a: &Allowed| check_consent(&root, Some(a)).is_ok();
    assert!(follows(&bound) && starts(&bound));

    let old = yes(None);
    assert!(!follows(&old) && !starts(&old), "from an older Mango: asked");
    assert!(consent_folder(&root, &project, None).is_some(), "a no, every worktree follows");
    let stale = Allowed { folder: "an older folder".into(), ..yes(None) };
    assert!(follows(&stale) && !starts(&stale), "an old yes: the project is asked again");

    // Ordinary work.
    let tree = Path::new(&root);
    git(tree, &["switch", "-q", "-c", "other"]);
    assert!(follows(&bound) && starts(&bound), "a branch switch");
    git(Path::new(&project), &["worktree", "repair", &root]);
    assert!(follows(&bound) && starts(&bound), "repair");
    git(Path::new(&project), &["worktree", "move", &root, "../app.worktrees/moved"]);
    let moved = scratch.path().join("app.worktrees").join("moved").to_str().unwrap().to_string();
    assert!(!follows(&bound) && !starts(&bound), "nothing is left at the old path");
    assert!(consent_folder(&moved, &project, Some(&old)).is_none(), "no binding at the new path: asked");
    git(Path::new(&project), &["worktree", "move", &moved, &root]);
    assert!(follows(&bound) && starts(&bound), "moved back");

    // Deleted, not pruned, and another folder there says it is that worktree.
    std::thread::sleep(Duration::from_millis(30));
    std::fs::remove_dir_all(&root).unwrap();
    scratch.write("app.worktrees/fix/.git", "gitdir: ../../app/.git/worktrees/fix\n");
    assert!(folder::is_worktree_of(&root, &project), "by git's files it is one");
    assert!(!follows(&bound) && !starts(&bound), "another folder at an unpruned worktree's path");
}

#[test]
fn what_is_checked_is_what_starts() {
    let scratch = Scratch::new("consent-resolved");
    let (project, tree) = with_worktree(&scratch);
    let evil = scratch.dir("evil");
    let link = scratch.path().join("link");
    let point_at = |to: &Path| {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("cmd");
            crate::bin::hide_console(&mut cmd);
            assert!(cmd.args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(to).output().unwrap().status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(to, &link).unwrap();
    };
    let unlink = || {
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
    };
    for (given, allowed_project, real) in [(&link, project.as_str(), &tree), (&link, link.to_str().unwrap(), &project)] {
        point_at(Path::new(real));
        let allowed = Allowed { project: allowed_project.into(), folder: folder::id(allowed_project).unwrap(), worktree: folder::id(&tree) };
        let checked = check_consent(given.to_str().unwrap(), Some(&allowed)).unwrap();
        unlink();
        point_at(&evil);
        assert_eq!(folder::id(checked.real.to_str().unwrap()), folder::id(real), "not where the link leads by now");
        assert!(check_consent(given.to_str().unwrap(), Some(&allowed)).is_err());
        unlink();
    }
}

fn run_in_pty(installer: &Installer, cwd: &std::path::Path, inherited: &std::ffi::OsStr) {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    let argv = &installer.argv;
    let program = crate::bin::find(&argv[0]).unwrap();
    let pty = native_pty_system().openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&argv[1..]);
    cmd.cwd(cwd);
    cmd.env("PATH", inherited);
    // After it, as the PTY does.
    for (key, value) in &installer.env {
        cmd.env(key, value);
    }
    let mut child = pty.slave.spawn_command(cmd).unwrap();
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().unwrap();
    let mut writer = pty.master.take_writer().unwrap();
    // ConPTY asks where the cursor is and waits for the answer.
    writer.write_all(b"\x1b[1;1R").unwrap();
    let output = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = reader.read_to_end(&mut out);
        String::from_utf8_lossy(&out).into_owned()
    });
    let status = child.wait().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    drop(writer);
    drop(pty.master);
    let output = output.join().unwrap();
    assert!(status.success(), "{argv:?}: {output}");
    eprintln!("{argv:?}: {output:?}");
}
