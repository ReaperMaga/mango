//! What the bridge's tests share.

use std::path::{Path, PathBuf};

/// A folder in the temp folder, gone with the value.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new(name: &str) -> Scratch {
        let base = std::env::temp_dir().canonicalize().unwrap();
        let base = PathBuf::from(super::resolve::plain(base.to_str().unwrap()).unwrap());
        let dir = base.join(format!("mango-lsp-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn dir(&self, rel: &str) -> PathBuf {
        let dir: PathBuf = self.0.join(rel.split('/').collect::<PathBuf>());
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn write(&self, rel: &str, text: &str) -> PathBuf {
        let file = self.0.join(rel.split('/').collect::<PathBuf>());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, text).unwrap();
        file
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // A process killed a moment ago can still hold its working folder.
        for _ in 0..20 {
            if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

/// An empty file that counts as the program `name` in `dir`.
pub fn program_file(dir: &Path, name: &str) -> PathBuf {
    let file = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    std::fs::write(&file, "").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    file
}
