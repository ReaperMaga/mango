//! Which program runs for a language server.
//!
//! The project is untrusted. A server may run its code once the user allowed that, but the project
//! never chooses the program: it comes from the search folders only, as an absolute path, and the
//! child gets a PATH without the project's folders. On Windows the child also gets
//! `NoDefaultCurrentDirectoryInExePath`, or cmd.exe (in an npm shim looking for `node`) and
//! CreateProcess (in the server starting its tools) would try the project folder before PATH.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use super::servers::{Program, Server};

/// The variable that stops Windows from looking for programs in the current directory.
pub const NO_CWD_SEARCH: &str = "NoDefaultCurrentDirectoryInExePath";
/// Carries a .cmd shim's path to cmd.exe (see [`Launch::command`]).
#[cfg(windows)]
pub(super) const SHIM_VAR: &str = "MANGO_LSP_SHIM";

/// The folder a server may be started in: the path as given and where it really is.
#[derive(Debug)]
pub struct Root {
    pub given: PathBuf,
    /// Canonical, without `\\?\`: usable as a working directory and in file URIs.
    pub real: PathBuf,
}

impl Root {
    pub fn open(path: &str) -> Result<Root, String> {
        if path.trim_start().starts_with("env://") {
            return Err("Language servers are not available in remote environments yet.".into());
        }
        if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) || !Path::new(path).is_absolute() {
            return Err("A language server needs a project folder on this computer.".into());
        }
        let given = crate::git::existing_dir(path)?;
        let real = given.canonicalize().map_err(|e| format!("Could not open the project folder: {e}"))?;
        let real = real.to_str().and_then(plain).ok_or("Language servers can't run in a folder with this kind of path.")?;
        Ok(Root { given, real: PathBuf::from(real) })
    }
}

/// A canonical path as programs accept it: `\\?\C:\x` is `C:\x`, `\\?\UNC\server\share` is
/// `\\server\share`. `None` for the verbatim paths that have no such form (a volume GUID).
pub fn plain(path: &str) -> Option<String> {
    let Some(rest) = path.strip_prefix(r"\\?\") else { return Some(path.to_string()) };
    if let Some(share) = rest.strip_prefix(r"UNC\") {
        return Some(format!(r"\\{share}"));
    }
    let b = rest.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\').then(|| rest.to_string())
}

fn real_path(path: &Path) -> Option<PathBuf> {
    let real = path.canonicalize().ok()?;
    Some(real.to_str().and_then(plain).map(PathBuf::from).unwrap_or(real))
}

fn within(path: &Path, folder: &Path) -> bool {
    if cfg!(windows) {
        let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
        lower(path).starts_with(lower(folder))
    } else {
        path.starts_with(folder)
    }
}

/// Some project's `node_modules/.bin`, also that of a folder above this project.
fn is_package_bin(dir: &Path) -> bool {
    let parts: Vec<_> = dir.components().map(Component::as_os_str).collect();
    parts.windows(2).any(|w| w[0].eq_ignore_ascii_case("node_modules") && w[1].eq_ignore_ascii_case(".bin"))
}

/// A folder of version manager shims (mise, asdf, Volta, pyenv, proto). They pick the program from
/// files in the current directory, and Volta even runs the project's own copy of a package.
fn is_shim_dir(dir: &Path) -> bool {
    let named = |p: Option<&Path>, name: &str| p.and_then(Path::file_name).is_some_and(|n| n.eq_ignore_ascii_case(name));
    named(Some(dir), "shims")
        || named(Some(dir), "volta")
        || (named(Some(dir), "bin") && (named(dir.parent(), "volta") || named(dir.parent(), ".volta")))
}

/// Where programs may come from, for one project (or none, to say what is installed).
pub struct Search {
    dirs: Vec<PathBuf>,
    project: Vec<PathBuf>,
}

impl Search {
    pub fn system(project: Option<&Root>) -> Search {
        Search::new(system_dirs(), project)
    }

    /// Outside all of these open projects: to say what is installed, and to install.
    pub fn system_outside(roots: &[String]) -> Search {
        Search::build(system_dirs(), open_projects(roots, dirs::home_dir().as_deref()))
    }

    /// Of `dirs`, in order, the absolute ones that exist outside the project.
    pub fn new(dirs: impl IntoIterator<Item = PathBuf>, project: Option<&Root>) -> Search {
        Search::build(dirs, project.map(|r| vec![r.given.clone(), r.real.clone()]).unwrap_or_default())
    }

    fn build(dirs: impl IntoIterator<Item = PathBuf>, project: Vec<PathBuf>) -> Search {
        let mut search = Search { dirs: Vec::new(), project };
        for dir in dirs {
            // Relative and empty entries mean "under the current directory", which is the project's.
            if !dir.is_absolute() || search.dirs.contains(&dir) || is_package_bin(&dir) || search.in_project(&dir) {
                continue;
            }
            // One that does not exist yet could become a link into the project later.
            let Some(real) = real_path(&dir) else { continue };
            if real.is_dir() && !is_package_bin(&real) && !search.in_project(&real) {
                search.dirs.push(dir);
            }
        }
        search
    }

    fn in_project(&self, path: &Path) -> bool {
        self.project.iter().any(|root| within(path, root))
    }

    /// A file that may run: there, and neither it nor what it links to is in the project.
    fn allowed(&self, file: &Path) -> bool {
        crate::bin::is_executable(file) && self.outside(file)
    }

    fn outside(&self, file: &Path) -> bool {
        // Windows' app execution aliases (winget.exe) can't be canonicalised, and link nowhere.
        !self.in_project(file) && real_path(file).is_none_or(|real| !self.in_project(&real))
    }

    /// Every `name` on the search path, first one first. `name` is a constant, never a path.
    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = PathBuf> + 'a {
        // npm puts a sh script without an extension next to each .cmd shim, so never bare names on Windows.
        let extensions: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
        self.dirs
            .iter()
            .filter_map(move |dir| extensions.iter().map(|ext| dir.join(format!("{name}{ext}"))).find(|file| self.allowed(file)))
    }

    pub fn first(&self, name: &str) -> Option<PathBuf> {
        self.all(name).next()
    }

    pub(super) fn path_var(&self) -> Result<OsString, String> {
        // An empty PATH means the current directory to some systems.
        if self.dirs.is_empty() {
            return Err("There is no folder outside the project to run programs from.".into());
        }
        // Left out: the few names PATH can't hold.
        let dirs = self.dirs.iter().filter(|d| std::env::join_paths([d]).is_ok());
        std::env::join_paths(dirs).map_err(|e| format!("Could not build the search path: {e}"))
    }

    /// The server's program here, the first of its programs that is installed.
    pub fn find(&self, server: &Server) -> Option<(&'static Program, PathBuf)> {
        server.programs.iter().find_map(|program| {
            let path = self.all(program.bin).find_map(|path| match program.bin {
                "rust-analyzer" => self.real_rust_analyzer(path),
                "clangd" => (!is_apple_stub(&path)).then_some(path),
                _ => Some(path),
            })?;
            Some((program, path))
        })
    }

    /// rustup's proxy is there whether or not the component is, and follows the project's
    /// rust-toolchain.toml, which can name a program inside the project. So a proxy stands for the
    /// default toolchain's own rust-analyzer. Read from disk: asking rustup is slow and may download.
    fn real_rust_analyzer(&self, path: PathBuf) -> Option<PathBuf> {
        if !is_rustup_proxy(&path) {
            return Some(path);
        }
        let home = std::env::var_os("RUSTUP_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| dirs::home_dir().map(|h| h.join(".rustup")))?;
        let component = toolchain_component(&home, std::env::var("RUSTUP_TOOLCHAIN").ok())?;
        self.allowed(&component).then_some(component)
    }

    /// How to start `program` (found at `path`) in `root`.
    pub fn launch(&self, program: &Program, path: PathBuf, root: &Root) -> Launch {
        let node = program.module.and_then(|_| self.first("node"));
        #[cfg(windows)]
        if let Some(direct) = self.without_shim(program, &path, node.as_deref(), root) {
            return direct;
        }
        // A script (npm's, or a shim) looks up `node` on PATH.
        let cwd = cwd_for(&[Some(path.as_path()), node.as_deref()], root);
        Launch { program: path, script: None, args: program.args, cwd }
    }

    /// npm's .cmd shim only runs node on a script. Doing that directly avoids cmd.exe, which can't
    /// start in a UNC folder, and the shim's unquoted `SET dp0=%~dp0`, which breaks on `&`.
    #[cfg(windows)]
    fn without_shim(&self, program: &Program, shim: &Path, node: Option<&Path>, root: &Root) -> Option<Launch> {
        if !is_batch(shim) {
            return None;
        }
        let dir = shim.parent()?;
        let script = dir.join(program.module?);
        if !script.is_file() || !self.outside(&script) {
            return None;
        }
        // As the shim does: the node beside it, else the one on PATH.
        let beside = dir.join("node.exe");
        let node = if self.allowed(&beside) { beside } else { node.filter(|n| !is_batch(n))?.to_path_buf() };
        let cwd = cwd_for(&[Some(node.as_path())], root);
        Some(Launch { program: node, script: Some(script), args: program.args, cwd })
    }
}

/// The project, unless a version manager's shim would read it to choose what runs: then home. The
/// project reaches the server through `initialize` either way.
fn cwd_for(programs: &[Option<&Path>], root: &Root) -> PathBuf {
    let shimmed = programs.iter().flatten().filter_map(|p| p.parent()).any(is_shim_dir);
    match dirs::home_dir() {
        Some(home) if shimmed => home,
        _ => root.real.clone(),
    }
}

#[cfg(windows)]
pub fn is_batch(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// cmd.exe from the system folder: COMSPEC and PATH have no say.
#[cfg(windows)]
pub fn cmd_exe() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join(r"System32\cmd.exe")
}

#[derive(Debug)]
pub struct Launch {
    pub program: PathBuf,
    pub script: Option<PathBuf>,
    pub args: &'static [&'static str],
    pub cwd: PathBuf,
}

impl Launch {
    pub fn command(&self, search: &Search) -> Result<Command, String> {
        let mut cmd = self.base();
        crate::bin::hide_console(&mut cmd);
        cmd.current_dir(&self.cwd).env("PATH", search.path_var()?);
        #[cfg(windows)]
        cmd.env(NO_CWD_SEARCH, "1");
        Ok(cmd)
    }

    #[cfg(windows)]
    fn base(&self) -> Command {
        use std::os::windows::process::CommandExt;
        if !is_batch(&self.program) {
            return self.plain();
        }
        // No path is part of the command line, where cmd would read `&`, `^` and `%`: cmd expands
        // the variable inside the quotes, and only once. `/d` skips the AutoRun commands.
        let mut line = format!("/d /e:on /v:off /s /c \"\"%{SHIM_VAR}%\"");
        for arg in self.args {
            line.push(' ');
            line.push_str(arg); // Constants of `servers.rs`, plain words.
        }
        line.push('"');
        let mut cmd = Command::new(cmd_exe());
        cmd.raw_arg(line).env(SHIM_VAR, &self.program);
        cmd
    }

    #[cfg(not(windows))]
    fn base(&self) -> Command {
        self.plain()
    }

    fn plain(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.script).args(self.args);
        cmd
    }
}

/// On macOS `/usr/bin/clangd` is there without the Command Line Tools, and running it opens
/// Apple's install dialog.
fn is_apple_stub(path: &Path) -> bool {
    cfg!(target_os = "macos")
        && path == Path::new("/usr/bin/clangd")
        && ![
            "/Library/Developer/CommandLineTools/usr/bin/clangd",
            "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd",
        ]
        .iter()
        .any(|real| Path::new(real).is_file())
}

/// A link to rustup, or a copy of the one beside it (Windows).
fn is_rustup_proxy(path: &Path) -> bool {
    let is_rustup = |p: &Path| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("rustup"));
    if real_path(path).is_some_and(|real| is_rustup(&real)) {
        return true;
    }
    let len = |p: &Path| std::fs::metadata(p).map(|m| m.len()).ok();
    let rustup = path.with_file_name(format!("rustup{}", std::env::consts::EXE_SUFFIX));
    len(&rustup).is_some_and(|rustup| len(path) == Some(rustup))
}

/// rust-analyzer in rustup's default toolchain (or the one `RUSTUP_TOOLCHAIN` names).
fn toolchain_component(home: &Path, wanted: Option<String>) -> Option<PathBuf> {
    let name = wanted.filter(|n| !n.is_empty()).or_else(|| {
        let settings = std::fs::read_to_string(home.join("settings.toml")).ok()?;
        settings.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "default_toolchain").then(|| value.trim().trim_matches(['"', '\'']).to_string())
        })
    })?;
    let toolchains = home.join("toolchains");
    let dir = if Path::new(&name).is_absolute() {
        PathBuf::from(&name)
    } else if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return None;
    } else if toolchains.join(&name).is_dir() {
        toolchains.join(&name)
    } else {
        // A bare channel ("stable") stands for this computer's triple.
        let prefix = format!("{name}-{}-", std::env::consts::ARCH);
        let found = std::fs::read_dir(&toolchains).ok()?.flatten().find(|e| e.file_name().to_string_lossy().starts_with(&prefix));
        found?.path()
    };
    let file = dir.join("bin").join(format!("rust-analyzer{}", std::env::consts::EXE_SUFFIX));
    file.is_file().then_some(file)
}

fn system_dirs() -> Vec<PathBuf> {
    crate::bin::search_dirs().into_iter().chain(install_dirs()).collect()
}

/// Where the open projects are. Not one that holds the home folder: everything installed for the
/// user is below it, and would count as the project's.
fn open_projects(roots: &[String], home: Option<&Path>) -> Vec<PathBuf> {
    roots
        .iter()
        .filter_map(|root| Root::open(root).ok())
        .filter(|root| !home.is_some_and(|home| within(home, &root.given) || within(home, &root.real)))
        .flat_map(|root| [root.given, root.real])
        .collect()
}

/// Where these servers' installers put things that [`crate::bin::search_dirs`] doesn't cover.
fn install_dirs() -> Vec<PathBuf> {
    let var = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty());
    // `go env -w` writes its settings to a file instead of the environment.
    let go_env = dirs::config_dir().and_then(|d| std::fs::read_to_string(d.join("go").join("env")).ok()).unwrap_or_default();
    let go = |key: &str| -> Option<OsString> {
        var(key).or_else(|| {
            let value = go_env.lines().find_map(|line| line.strip_prefix(key)?.strip_prefix('='))?.trim();
            (!value.is_empty()).then(|| value.into())
        })
    };
    let mut out: Vec<PathBuf> = go("GOBIN").map(PathBuf::from).into_iter().collect();
    if let Some(paths) = go("GOPATH") {
        out.extend(std::env::split_paths(&paths).filter(|p| !p.as_os_str().is_empty()).map(|p| p.join("bin")));
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("go").join("bin"));
        out.push(home.join(".dotnet").join("tools"));
    }
    #[cfg(windows)]
    {
        let programs = var("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        out.extend([programs.join(r"Go\bin"), programs.join("dotnet"), programs.join(r"LLVM\bin")]);
        // WinGet unpacks clangd and puts it on the PATH of programs started afterwards.
        if let Some(packages) = dirs::data_local_dir().map(|d| d.join(r"Microsoft\WinGet\Packages")) {
            out.extend(winget_clangd(&packages));
        }
    }
    #[cfg(not(windows))]
    out.extend(
        ["/usr/local/go/bin", "/usr/local/share/dotnet", "/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"].map(PathBuf::from),
    );
    out
}

/// `<packages>\LLVM.clangd_<source>\clangd_<version>\bin`, the newest first.
#[cfg(windows)]
fn winget_clangd(packages: &Path) -> Vec<PathBuf> {
    let children = |dir: &Path, prefix: &str| -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
            .map(|e| e.path())
            .collect()
    };
    let mut found: Vec<PathBuf> =
        children(packages, "LLVM.clangd_").iter().flat_map(|package| children(package, "clangd_")).map(|v| v.join("bin")).collect();
    found.sort_by(|a, b| b.cmp(a));
    found
}

#[cfg(test)]
mod tests {
    use super::super::servers;
    use super::super::test_support::{program_file, Scratch};
    use super::*;

    #[test]
    fn plain_paths() {
        assert_eq!(plain(r"\\?\C:\work\a b").as_deref(), Some(r"C:\work\a b"));
        assert_eq!(plain(r"\\?\C:\").as_deref(), Some(r"C:\"));
        assert_eq!(plain(r"\\?\UNC\server\share\app").as_deref(), Some(r"\\server\share\app"));
        assert_eq!(plain(r"\\server\share").as_deref(), Some(r"\\server\share"));
        assert_eq!(plain("/home/me/app").as_deref(), Some("/home/me/app"));
        assert_eq!(plain(r"\\?\Volume{1b3b1146-4076-11e1-84aa-806e6f6e6963}\x"), None);
    }

    #[test]
    fn roots() {
        for bad in ["", " ", "env://host/dev/srv", " env://host/dev/srv", "relative", ".", "..", "C:relative", "/no\nline"] {
            assert!(Root::open(bad).is_err(), "{bad:?}");
        }
        let scratch = Scratch::new("roots");
        assert!(Root::open(scratch.path().join("missing").to_str().unwrap()).is_err());
        assert!(Root::open(scratch.write("file.txt", "").to_str().unwrap()).is_err());

        let name = "pro ject & 100% ^ größer";
        let dir = scratch.dir(name);
        let root = Root::open(dir.join("..").join(name).to_str().unwrap()).unwrap();
        let real = root.real.to_str().unwrap();
        assert!(!real.starts_with(r"\\?\") && !real.contains(".."), "{real}");
        assert!(root.real.is_absolute() && real.ends_with(name));
        assert_eq!(root.real.canonicalize().unwrap(), dir.canonicalize().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn unc_root() {
        let scratch = Scratch::new("unc");
        let local = scratch.path().to_str().unwrap();
        let share = format!(r"\\localhost\{}${}", &local[..1], &local[2..]);
        // The administrative share is not there on every computer.
        if Path::new(&share).is_dir() {
            let root = Root::open(&share).unwrap();
            let real = root.real.to_str().unwrap();
            assert!(real.starts_with(r"\\localhost\") && !real.starts_with(r"\\?\"), "{real}");
        }
    }

    #[test]
    fn never_from_the_project() {
        let scratch = Scratch::new("search");
        let project = scratch.dir("mono/app");
        let mut unsafe_dirs = vec![PathBuf::new(), PathBuf::from("."), PathBuf::from("bin")];
        for rel in ["mono/app", "mono/app/bin", "mono/app/node_modules/.bin", "mono/node_modules/.bin", "other/node_modules/.BIN"] {
            let dir = scratch.dir(rel);
            program_file(&dir, "gopls");
            unsafe_dirs.push(dir);
        }
        unsafe_dirs.push(project.join("not-there-yet"));
        unsafe_dirs.push(scratch.path().join("gone"));
        let root = Root::open(project.to_str().unwrap()).unwrap();
        let search = Search::new(unsafe_dirs.clone(), Some(&root));
        assert!(search.dirs.is_empty(), "{:?}", search.dirs);
        assert!(search.first("gopls").is_none());
        assert!(search.path_var().is_err(), "never an empty PATH");

        // Spelled another way, still the project's.
        let around = scratch.path().join("mono").join("..").join("mono").join("app").join("bin");
        assert!(Search::new([around], Some(&root)).dirs.is_empty());
        #[cfg(windows)]
        {
            let shouting = PathBuf::from(project.join("bin").to_string_lossy().to_uppercase());
            assert!(Search::new([shouting], Some(&root)).dirs.is_empty());
        }

        // The real one wins although the project's come first on PATH.
        let good = scratch.dir("tools & 100% ^ größer");
        let real = program_file(&good, "gopls");
        unsafe_dirs.push(good.clone());
        let search = Search::new(unsafe_dirs, Some(&root));
        assert_eq!(search.first("gopls"), Some(real));
        assert_eq!(std::env::split_paths(&search.path_var().unwrap()).collect::<Vec<_>>(), [good]);
    }

    #[test]
    fn what_is_installed_skips_open_projects() {
        let scratch = Scratch::new("planted");
        let project = scratch.dir("home/work/app");
        let planted = scratch.dir("home/work/app/tools");
        program_file(&planted, "gopls");
        let good = scratch.dir("home/bin");
        let real = program_file(&good, "gopls");
        let path = || [planted.clone(), good.clone()];
        let home = scratch.path().join("home");
        let roots = |dir: &Path| open_projects(&[dir.to_str().unwrap().to_string()], Some(&home));

        assert_eq!(Search::build(path(), roots(&project)).first("gopls"), Some(real));
        // The home folder opened as a project doesn't hide what is installed in it.
        assert!(roots(&home).is_empty() && roots(scratch.path()).is_empty());
        assert!(open_projects(&["env://h/dev/srv".into(), "relative".into()], Some(&home)).is_empty());
    }

    #[test]
    fn what_is_installed_skips_relative_and_package_bins() {
        let scratch = Scratch::new("installed");
        let bin = scratch.dir("p/node_modules/.bin");
        program_file(&bin, "gopls");
        assert!(Search::new([bin, PathBuf::from(".")], None).first("gopls").is_none());
        for dir in &Search::system(None).dirs {
            assert!(dir.is_absolute() && !is_package_bin(dir), "{dir:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn links_into_the_project() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new("links");
        let project = scratch.dir("app");
        let evil = program_file(&project, "gopls");
        let tools = scratch.dir("tools");
        symlink(&evil, tools.join("gopls")).unwrap();
        symlink(&project, scratch.path().join("alias")).unwrap();
        let root = Root::open(project.to_str().unwrap()).unwrap();
        let search = Search::new([tools.clone(), scratch.path().join("alias")], Some(&root));
        assert_eq!(search.dirs, [tools]);
        assert!(search.first("gopls").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn links_into_the_project() {
        let scratch = Scratch::new("links");
        let project = scratch.dir("app");
        program_file(&project, "gopls");
        let alias = scratch.path().join("alias");
        // A junction needs no privilege, unlike a symlink.
        let mut cmd = Command::new(cmd_exe());
        crate::bin::hide_console(&mut cmd);
        assert!(cmd.args(["/d", "/c", "mklink", "/J"]).arg(&alias).arg(&project).output().unwrap().status.success());
        let root = Root::open(project.to_str().unwrap()).unwrap();
        let found = Search::new([alias.clone()], Some(&root)).dirs;
        std::fs::remove_dir(alias).unwrap(); // The link only.
        assert!(found.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn npm_shims() {
        const DIR: &str = "npm R&D ^ 100% größer";
        let scratch = Scratch::new("shims");
        let dir = scratch.dir(DIR);
        // The extensionless sh script beside it is no program here.
        scratch.write(&format!("{DIR}/typescript-language-server"), "#!/bin/sh");
        let search = Search::new([dir.clone()], None);
        let server = servers::by_id("typescript").unwrap();
        assert!(search.find(server).is_none());

        let shim = scratch.write(&format!("{DIR}/typescript-language-server.cmd"), "@exit /b 0");
        let root = Root::open(scratch.dir("app").to_str().unwrap()).unwrap();
        let (program, found) = search.find(server).unwrap();
        assert_eq!(found, shim);
        // No package beside it (pnpm, Yarn): through cmd.exe, whose command line holds no path.
        let launch = search.launch(program, found.clone(), &root);
        assert!(launch.script.is_none());
        let cmd = launch.command(&search).unwrap();
        assert_eq!(Path::new(cmd.get_program()), cmd_exe());
        assert!(cmd.get_args().all(|a| !a.to_string_lossy().contains("R&D")), "{cmd:?}");
        assert!(cmd.get_envs().any(|(k, v)| k == NO_CWD_SEARCH && v.is_some_and(|v| v == "1")));

        // npm's layout: node runs the script itself, the node beside the shim first.
        let script = scratch.write(&format!("{DIR}/node_modules/typescript-language-server/lib/cli.mjs"), "");
        assert!(search.launch(program, found.clone(), &root).script.is_none(), "no node, no shortcut");
        let node = scratch.write(&format!("{DIR}/node.exe"), "");
        let launch = search.launch(program, found, &root);
        assert_eq!(launch.program, node);
        assert_eq!(launch.script.unwrap().canonicalize().unwrap(), script.canonicalize().unwrap());
        assert_eq!(launch.cwd, root.real);
    }

    #[test]
    fn version_manager_shims_never_start_in_the_project() {
        for dir in ["/h/.local/share/mise/shims", "/h/.asdf/shims", "/h/.pyenv/shims", "/h/.volta/bin", "/opt/Volta"] {
            assert!(is_shim_dir(Path::new(dir)), "{dir}");
        }
        for dir in ["/usr/bin", "/h/.volta/tools/image/node/22.0.0/bin", "/h/go/bin"] {
            assert!(!is_shim_dir(Path::new(dir)), "{dir}");
        }
        let scratch = Scratch::new("managers");
        let shims = scratch.dir("mise/shims");
        program_file(&shims, "gopls");
        let root = Root::open(scratch.dir("app").to_str().unwrap()).unwrap();
        let search = Search::new([shims], Some(&root));
        let (program, path) = search.find(servers::by_id("go").unwrap()).unwrap();
        assert_eq!(Some(search.launch(program, path, &root).cwd), dirs::home_dir());
    }

    #[test]
    fn rustup_proxy_is_not_rust_analyzer() {
        let exe = std::env::consts::EXE_SUFFIX;
        let scratch = Scratch::new("rustup");
        let proxy = scratch.write(&format!("bin/rust-analyzer{exe}"), "the proxy");
        assert!(!is_rustup_proxy(&proxy), "no rustup around: a real one");
        scratch.write(&format!("bin/rustup{exe}"), "the proxy");
        assert!(is_rustup_proxy(&proxy));

        let home = scratch.dir("home");
        assert_eq!(toolchain_component(&home, None), None);
        scratch.write("home/settings.toml", "version = \"12\"\ndefault_toolchain = \"stable\"\nprofile = \"default\"\n");
        let toolchain = format!("home/toolchains/stable-{}-some-os", std::env::consts::ARCH);
        scratch.dir(&toolchain);
        assert_eq!(toolchain_component(&home, None), None, "the component is missing");
        let real = scratch.write(&format!("{toolchain}/bin/rust-analyzer{exe}"), "the server");
        let found = toolchain_component(&home, None).unwrap();
        assert_eq!(found.canonicalize().unwrap(), real.canonicalize().unwrap());
        assert_eq!(toolchain_component(&home, Some("nightly".into())), None);
        assert_eq!(toolchain_component(&home, Some("../home".into())), None);
    }

    #[cfg(windows)]
    #[test]
    fn clangd_from_winget() {
        let scratch = Scratch::new("winget");
        scratch.dir("LLVM.clangd_src/clangd_21.1.0/bin");
        scratch.dir("LLVM.clangd_src/clangd_23.1.0/bin");
        scratch.dir("Other.Package/clangd_99/bin");
        let found = winget_clangd(scratch.path());
        assert_eq!(found.len(), 2);
        assert!(found[0].to_string_lossy().contains("23.1.0"));
    }
}
