//! A language server's whole process tree. On Windows the process Mango starts may be cmd.exe,
//! with node and then tsserver below it: killing that one process would leave the others running.
//!
//! Windows: a job object. Everything the server starts is in it, and Windows ends the job when
//! Mango's handle closes, so also when Mango crashes. Elsewhere: the process group, plus the
//! descendants that made groups of their own.

use std::io;
use std::process::{Child, Command, ExitStatus};

pub use imp::Tree;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME};

    pub struct Tree {
        job: OwnedHandle,
    }

    impl Tree {
        pub fn spawn(cmd: &mut Command) -> io::Result<(Child, Tree)> {
            // SAFETY: no attributes (so the handle is not inherited) and no name; the new handle
            // is owned from here on.
            let job = unsafe { OwnedHandle::from_raw_handle(CreateJobObjectW(None, PCWSTR::null())?.0) };
            let tree = Tree { job };
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: the pointer and size are those of `limits`, which outlives the call.
            unsafe {
                SetInformationJobObject(
                    tree.handle(),
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast(),
                    size_of_val(&limits) as u32,
                )?;
            }
            crate::bin::hide_console(cmd);
            // Suspended until it is in the job, so nothing it starts can be outside. (Setting flags
            // replaces the ones `hide_console` set, hence both.)
            cmd.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
            let mut child = cmd.spawn()?;
            if let Err(e) = tree.adopt(&child) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
            Ok((child, tree))
        }

        fn handle(&self) -> HANDLE {
            HANDLE(self.job.as_raw_handle())
        }

        fn adopt(&self, child: &Child) -> io::Result<()> {
            // SAFETY: both handles are open for as long as `self` and `child` are borrowed.
            unsafe { AssignProcessToJobObject(self.handle(), HANDLE(child.as_raw_handle()))? };
            resume(child.id())
        }

        /// End everything in the tree. Harmless when it already ended.
        pub fn kill(&self) {
            // SAFETY: the job handle is open for as long as `self` is.
            let _ = unsafe { TerminateJobObject(self.handle(), 1) };
        }

        /// Wait for the server to end, then end whatever it left running.
        pub fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
            let status = child.wait();
            self.kill();
            status
        }
    }

    /// Start a process created suspended: std keeps its main thread's handle to itself.
    fn resume(pid: u32) -> io::Result<()> {
        // SAFETY: each handle is owned as soon as it is made, and `entry` is a THREADENTRY32 that
        // says its own size.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)?;
            let _snapshot = OwnedHandle::from_raw_handle(snapshot.0);
            let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
            let mut next = Thread32First(snapshot, &mut entry);
            while next.is_ok() {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)?;
                    let _thread = OwnedHandle::from_raw_handle(thread.0);
                    if ResumeThread(thread) == u32::MAX {
                        return Err(io::Error::last_os_error());
                    }
                    return Ok(());
                }
                next = Thread32Next(snapshot, &mut entry);
            }
        }
        Err(io::Error::other("the new process has no thread to start"))
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use std::sync::{Mutex, MutexGuard};

    pub struct Tree {
        pid: libc::pid_t,
        /// False once the server is reaped: its pid may be someone else's from then on.
        live: Mutex<bool>,
    }

    impl Tree {
        pub fn spawn(cmd: &mut Command) -> io::Result<(Child, Tree)> {
            cmd.process_group(0);
            let child = cmd.spawn()?;
            let pid = child.id() as libc::pid_t;
            Ok((child, Tree { pid, live: Mutex::new(true) }))
        }

        fn live(&self) -> MutexGuard<'_, bool> {
            self.live.lock().unwrap_or_else(|e| e.into_inner())
        }

        /// End everything in the tree. Harmless when it already ended.
        pub fn kill(&self) {
            // Held throughout, so the server is not reaped (and its pid reused) meanwhile.
            let live = self.live();
            if !*live {
                return;
            }
            // Found while the parent links still lead to them (rust-analyzer gives cargo a group of its own).
            let below = descendants(self.pid);
            self.signal_group();
            for pid in below {
                // SAFETY: plain syscall; `descendants` returns only pids above 1.
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }

        fn signal_group(&self) {
            if self.pid > 1 {
                // SAFETY: plain syscall on the group the server leads, whose id is above 1.
                unsafe { libc::killpg(self.pid, libc::SIGKILL) };
            }
        }

        /// Wait for the server to end, then end whatever it left running.
        pub fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
            loop {
                // SAFETY: all zeroes is a valid siginfo_t for the kernel to fill in. WNOWAIT leaves
                // the zombie, which keeps the pid, and so the group's id, from being reused.
                let ended = unsafe {
                    let mut info: libc::siginfo_t = std::mem::zeroed();
                    libc::waitid(libc::P_PID, self.pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT)
                };
                if ended == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    break;
                }
            }
            let mut live = self.live();
            self.signal_group();
            *live = false;
            drop(live);
            child.wait()
        }
    }

    /// Every process below `root`.
    fn descendants(root: libc::pid_t) -> Vec<libc::pid_t> {
        // Absolute, like everything the language server bridge starts.
        let mut cmd = Command::new("/bin/ps");
        crate::bin::hide_console(&mut cmd);
        let Ok(out) = cmd.args(["-A", "-o", "pid=,ppid="]).stdin(Stdio::null()).stderr(Stdio::null()).output() else {
            return Vec::new();
        };
        below(root, &String::from_utf8_lossy(&out.stdout))
    }

    fn below(root: libc::pid_t, table: &str) -> Vec<libc::pid_t> {
        let pairs: Vec<(libc::pid_t, libc::pid_t)> = table
            .lines()
            .filter_map(|line| {
                let mut words = line.split_whitespace();
                Some((words.next()?.parse().ok()?, words.next()?.parse().ok()?))
            })
            .collect();
        let mut found = vec![root];
        let mut at = 0;
        while let Some(&parent) = found.get(at) {
            for &(pid, ppid) in &pairs {
                if ppid == parent && pid > 1 && !found.contains(&pid) {
                    found.push(pid);
                }
            }
            at += 1;
        }
        found.remove(0);
        found
    }

    #[test]
    fn finds_descendants() {
        let table = "  10 1\n  20 10\n  30 20\n  40 1\n  50 10\n  nonsense\n";
        assert_eq!(below(10, table), [20, 50, 30]);
    }
}
