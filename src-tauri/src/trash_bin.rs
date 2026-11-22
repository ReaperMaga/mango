//! Moving a file or folder to the system's trash, and never deleting it for good instead.
//!
//! Windows has its own code here. `IFileOperation` run without UI deletes permanently, and
//! reports success, whatever does not fit the Recycle Bin (paths over 260 characters, drives
//! without a bin, items too large), and the shell reads a name ending in a dot or space as the
//! name without it, which is another file. The `trash` crate does both, so it is used on macOS
//! and Linux only.

use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Trashed {
    Done,
    /// The trash cannot take it; nothing was deleted. Says why, as a whole sentence.
    Unavailable(String),
}

/// Put `path` in the trash. The item itself: a link goes, never what it points at.
pub(crate) fn move_to_trash(path: &Path) -> Result<Trashed, String> {
    imp::move_to_trash(path)
}

#[cfg(windows)]
pub(crate) use imp::{says_itself, shell_path};

#[cfg(target_os = "macos")]
mod imp {
    use super::Trashed;
    use std::path::Path;
    use trash::macos::{DeleteMethod, TrashContextExtMacos};

    pub(super) fn move_to_trash(path: &Path) -> Result<Trashed, String> {
        let mut ctx = trash::TrashContext::default();
        // Not through Finder: that is an AppleScript built from the file's name, and asks for a permission.
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        Ok(match ctx.delete(path) {
            Ok(()) => Trashed::Done,
            Err(e) => Trashed::Unavailable(format!("The Trash did not take it ({e}).")),
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::Trashed;
    use std::path::Path;

    pub(super) fn move_to_trash(path: &Path) -> Result<Trashed, String> {
        Ok(match trash::delete(path) {
            Ok(()) => Trashed::Done,
            Err(e) => Trashed::Unavailable(format!("The trash did not take it ({e}).")),
        })
    }
}

#[cfg(windows)]
mod imp {
    use super::Trashed;
    use std::cell::Cell;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Path, Prefix};
    use std::rc::Rc;
    use windows::core::{implement, Ref, HRESULT, PCWSTR};
    use windows::Win32::Foundation::E_ABORT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
        SHCreateItemFromParsingName, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_ALLOWUNDO, FOF_NO_UI,
        TSF_DELETE_RECYCLE_IF_POSSIBLE,
    };

    /// The path as the shell takes it, or why it would read it as a different one.
    pub(crate) fn shell_path(path: &Path) -> Result<String, String> {
        let mut out = String::new();
        for part in path.components() {
            match part {
                Component::Prefix(p) => match p.kind() {
                    Prefix::VerbatimDisk(d) | Prefix::Disk(d) => out = format!("{}:", d as char),
                    Prefix::VerbatimUNC(host, share) | Prefix::UNC(host, share) => {
                        out = format!(r"\\{}\{}", host.to_string_lossy(), share.to_string_lossy());
                    }
                    _ => return Err("The Recycle Bin cannot take a path of this kind.".into()),
                },
                Component::RootDir => {}
                Component::CurDir | Component::ParentDir => return Err("The Recycle Bin needs a full path.".into()),
                Component::Normal(name) => {
                    let name = name.to_str().ok_or("The Recycle Bin cannot take this name.")?;
                    if !says_itself(name) {
                        return Err(format!("Windows would read \"{name}\" as another name, so it cannot go to the Recycle Bin."));
                    }
                    out.push('\\');
                    out.push_str(name);
                }
            }
        }
        // A drive on its own (`C:`) would mean the folder Mango happens to be in there.
        if out.ends_with(':') {
            out.push('\\');
        }
        Ok(out)
    }

    /// False for a name Win32 turns into another: a dot or space at the end, or a device's name.
    pub(crate) fn says_itself(name: &str) -> bool {
        if name.ends_with(['.', ' ']) {
            return false;
        }
        let stem = name.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.chars().count() == 4
                && stem.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³']));
        !device
    }

    /// What the shell said while it worked.
    #[derive(Default)]
    struct Seen {
        /// It wanted to delete something for good, and was stopped.
        refused: Cell<bool>,
        failed: Cell<Option<HRESULT>>,
    }

    #[implement(IFileOperationProgressSink)]
    struct OnlyRecycle(Rc<Seen>);

    #[allow(non_snake_case)] // the method names are COM's
    impl IFileOperationProgressSink_Impl for OnlyRecycle_Impl {
        fn PreDeleteItem(&self, flags: u32, _: Ref<'_, IShellItem>) -> windows::core::Result<()> {
            // Not set when the item would be deleted for good. An error here stops the operation.
            if flags & (TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32) == 0 {
                self.0.refused.set(true);
                return Err(E_ABORT.into());
            }
            Ok(())
        }
        fn PostDeleteItem(&self, _: u32, _: Ref<'_, IShellItem>, result: HRESULT, _: Ref<'_, IShellItem>) -> windows::core::Result<()> {
            if result.is_err() {
                self.0.failed.set(Some(result));
            }
            Ok(())
        }
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, _: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreRenameItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostRenameItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<'_, IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreMoveItem(&self, _: u32, _: Ref<'_, IShellItem>, _: Ref<'_, IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostMoveItem(&self, _: u32, _: Ref<'_, IShellItem>, _: Ref<'_, IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<'_, IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreCopyItem(&self, _: u32, _: Ref<'_, IShellItem>, _: Ref<'_, IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostCopyItem(&self, _: u32, _: Ref<'_, IShellItem>, _: Ref<'_, IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<'_, IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR, _: &PCWSTR, _: u32, _: HRESULT, _: Ref<'_, IShellItem>) -> windows::core::Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    pub(super) fn move_to_trash(path: &Path) -> Result<Trashed, String> {
        let shell = match shell_path(path) {
            Ok(shell) => shell,
            Err(why) => return Ok(Trashed::Unavailable(why)),
        };
        // A thread of its own: the shell wants a single-threaded apartment, and the pool's threads are shared.
        std::thread::spawn(move || recycle(&shell))
            .join()
            .map_err(|_| "The Recycle Bin stopped unexpectedly.".to_string())?
    }

    fn recycle(path: &str) -> Result<Trashed, String> {
        // SAFETY: COM is initialised on this thread first and shut down after everything made with it is dropped.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| format!("Could not reach the Recycle Bin: {}", e.message()))?;
            let result = recycle_here(path);
            CoUninitialize();
            result
        }
    }

    /// SAFETY: call with COM initialised on this thread.
    unsafe fn recycle_here(path: &str) -> Result<Trashed, String> {
        let said = |e: windows::core::Error| format!("Could not move it to the Recycle Bin: {}", e.message());
        let wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain([0]).collect();
        let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(said)?;
        op.SetOperationFlags(FOF_NO_UI | FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE).map_err(said)?;
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).map_err(said)?;
        let seen = Rc::new(Seen::default());
        let sink: IFileOperationProgressSink = OnlyRecycle(seen.clone()).into();
        op.DeleteItem(&item, &sink).map_err(said)?;
        let done = op.PerformOperations();
        if seen.refused.get() {
            return Ok(Trashed::Unavailable(
                "The Recycle Bin cannot take it: the drive has none, or it is too large or its path too long.".into(),
            ));
        }
        if let Some(code) = seen.failed.get() {
            return Err(failure(code));
        }
        done.map_err(said)?;
        if op.GetAnyOperationsAborted().map_err(said)?.as_bool() {
            return Err("Windows stopped before it was in the Recycle Bin.".into());
        }
        Ok(Trashed::Done)
    }

    /// The copy engine's codes have no system message (`sherrors.h`): the common ones in words.
    fn failure(code: HRESULT) -> String {
        match code.0 as u32 {
            0x8027_0027 | 0x8027_0028 | 0x8007_0020 => "It is in use by another program. Close that and try again.".into(),
            0x8027_0021 | 0x8027_0022 | 0x8007_0005 => "Windows denied access to it.".into(),
            n => format!("Windows could not move it to the Recycle Bin (0x{n:08x})."),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn names_the_shell_reads_as_they_are() {
            assert_eq!(shell_path(Path::new(r"\\?\C:\a b\c.txt")).unwrap(), r"C:\a b\c.txt");
            assert_eq!(shell_path(Path::new(r"\\?\C:\")).unwrap(), "C:\\");
            assert_eq!(shell_path(Path::new(r"\\?\UNC\host\share\d\f")).unwrap(), r"\\host\share\d\f");
            for ok in [".env", "console.ts", "com0", "com10", "nul_", "notes", "grüße [1]%20&.txt"] {
                assert!(says_itself(ok), "{ok}");
            }
        }

        #[test]
        fn names_the_shell_would_read_as_another_are_refused() {
            for bad in ["notes.", "notes ", "x. .", "nul", "NUL.txt", "com1", "lpt9.log", "con .txt", "COM¹"] {
                assert!(!says_itself(bad), "{bad}");
            }
            assert!(shell_path(Path::new(r"\\?\C:\dir.\file")).is_err(), "also in a folder above");
        }
    }
}
