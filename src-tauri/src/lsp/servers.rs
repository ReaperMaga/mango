//! The language servers Mango knows: their programs, arguments and installers. All constants: the
//! webview only ever names an id.

use std::path::{Path, PathBuf};

use crate::setup::{Os, Plan};

pub struct Program {
    pub bin: &'static str,
    pub args: &'static [&'static str],
    /// For an npm package: the script its shim runs, relative to the shim (Windows).
    pub module: Option<&'static str>,
}

pub struct Server {
    pub id: &'static str,
    pub name: &'static str,
    pub languages: &'static [&'static str],
    /// The first one installed runs.
    pub programs: &'static [Program],
    pub help_url: &'static str,
}

pub const SERVERS: [Server; 6] = [
    Server {
        id: "typescript",
        name: "typescript-language-server",
        languages: &["typescript", "typescriptreact", "javascript", "javascriptreact"],
        programs: &[Program {
            bin: "typescript-language-server",
            args: &["--stdio"],
            module: Some("node_modules/typescript-language-server/lib/cli.mjs"),
        }],
        help_url: "https://github.com/typescript-language-server/typescript-language-server#installing",
    },
    Server {
        id: "rust",
        name: "rust-analyzer",
        languages: &["rust"],
        programs: &[Program { bin: "rust-analyzer", args: &[], module: None }],
        help_url: "https://rust-analyzer.github.io/book/installation.html",
    },
    Server {
        id: "python",
        name: "pyright",
        languages: &["python"],
        programs: &[
            Program { bin: "pyright-langserver", args: &["--stdio"], module: Some("node_modules/pyright/langserver.index.js") },
            Program {
                bin: "basedpyright-langserver",
                args: &["--stdio"],
                module: Some("node_modules/basedpyright/langserver.index.js"),
            },
            Program { bin: "pylsp", args: &[], module: None },
        ],
        help_url: "https://microsoft.github.io/pyright/#/installation",
    },
    Server {
        id: "go",
        name: "gopls",
        languages: &["go"],
        programs: &[Program { bin: "gopls", args: &[], module: None }],
        help_url: "https://go.dev/gopls/#installation",
    },
    Server {
        id: "clangd",
        name: "clangd",
        languages: &["c", "cpp"],
        programs: &[Program { bin: "clangd", args: &[], module: None }],
        help_url: "https://clangd.llvm.org/installation",
    },
    Server {
        id: "csharp",
        name: "csharp-ls",
        languages: &["csharp"],
        programs: &[Program { bin: "csharp-ls", args: &[], module: None }],
        help_url: "https://github.com/razzmatazz/csharp-language-server",
    },
];

pub fn by_id(id: &str) -> Result<&'static Server, String> {
    SERVERS.iter().find(|s| s.id == id).ok_or_else(|| format!("Unknown language server \"{id}\"."))
}

impl Server {
    /// The program's own name, of the one that is installed when there are several.
    pub fn name_of(&self, installed: Option<&Program>) -> &'static str {
        installed.map_or(self.name, |p| p.bin.trim_end_matches("-langserver"))
    }
}

/// How to install `server` on `os`, given which programs are here (`find`). `None` when what the
/// installer needs is missing.
pub fn plan_for(server: &Server, os: Os, find: &dyn Fn(&str) -> Option<PathBuf>) -> Option<Plan> {
    let has = |bin: &str| find(bin).is_some();
    match server.id {
        // TypeScript 7 has no tsserver, which the server drives; 6 is what its README installs.
        "typescript" => npm(os, &find("npm")?, &["typescript-language-server", "typescript@6"]),
        "python" => npm(os, &find("npm")?, &["pyright"]),
        "rust" => has("rustup").then(|| Plan::direct(&["rustup", "component", "add", "rust-analyzer"], "rustup")),
        "go" => has("go").then(|| Plan::direct(&["go", "install", "golang.org/x/tools/gopls@latest"], "Go")),
        "csharp" => csharp_ls(dotnet_sdk(&find("dotnet")?)?),
        "clangd" => match os {
            Os::Windows => has("winget")
                .then(|| Plan::direct(&["winget", "install", "--id", "LLVM.clangd", "-e", "--source", "winget"], "WinGet")),
            Os::Mac => has("brew").then(|| Plan::direct(&["brew", "install", "llvm"], "Homebrew")),
            Os::Linux => {
                if !has("sudo") {
                    return None;
                }
                const MANAGERS: [(&str, &[&str], &str); 4] = [
                    ("apt-get", &["sudo", "apt-get", "install", "-y", "clangd"], "apt"),
                    ("dnf", &["sudo", "dnf", "install", "-y", "clang-tools-extra"], "dnf"),
                    ("pacman", &["sudo", "pacman", "-S", "--needed", "--noconfirm", "clang"], "pacman"),
                    ("zypper", &["sudo", "zypper", "install", "-y", "clang-tools"], "zypper"),
                ];
                MANAGERS.iter().find(|(bin, _, _)| has(bin)).map(|(_, argv, via)| Plan::direct(argv, via))
            }
        },
        _ => None,
    }
}

fn npm(os: Os, npm: &Path, packages: &[&str]) -> Option<Plan> {
    let local = dirs::home_dir()?.join(".local").to_string_lossy().into_owned();
    // The system's npm would write to /usr, which needs root: ~/.local is the user's and searched.
    let system = os == Os::Linux && npm.starts_with("/usr");
    let mut argv = vec!["npm", "install", "-g"];
    if system {
        argv.extend(["--prefix", local.as_str()]);
    }
    argv.extend_from_slice(packages);
    let mut plan = Plan::direct(&argv, "npm");
    if system {
        // As the user would type it.
        plan.display = plan.display.replace(&local, "~/.local");
    }
    Some(plan)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sdk {
    /// The newest one's major version.
    Major(u32),
    /// A package manager's wrapper, which is taken at its word.
    Unknown,
}

/// The .NET SDK behind a dotnet command. `None` for the runtime alone, which can't install tools.
fn dotnet_sdk(dotnet: &Path) -> Option<Sdk> {
    let real = dotnet.canonicalize().unwrap_or_else(|_| dotnet.to_path_buf());
    let Some(dir) = real.parent() else { return Some(Sdk::Unknown) };
    // A .NET root, or Homebrew's script with the root in libexec beside it.
    let roots = [dir.to_path_buf(), dir.join("..").join("libexec")];
    let Some(root) = roots.iter().find(|root| root.join("host").is_dir()) else { return Some(Sdk::Unknown) };
    let sdks = std::fs::read_dir(root.join("sdk")).ok()?.flatten();
    let newest = sdks.filter_map(|e| e.file_name().to_str()?.split('.').next()?.parse().ok()).max()?;
    Some(Sdk::Major(newest))
}

/// Each csharp-ls release runs on one .NET, and `dotnet tool install` always takes the newest
/// release, which an older SDK can't install: those get the last one made for them.
fn csharp_ls(sdk: Sdk) -> Option<Plan> {
    let version = match sdk {
        Sdk::Major(0..=7) => return None,
        Sdk::Major(8) => Some("0.16.0"),
        Sdk::Major(9) => Some("0.20.0"),
        Sdk::Major(10) => Some("0.28.0"),
        Sdk::Major(_) | Sdk::Unknown => None,
    };
    let mut argv = vec!["dotnet", "tool", "install", "--global", "csharp-ls"];
    if let Some(version) = version {
        argv.extend(["--version", version]);
    }
    Some(Plan::direct(&argv, ".NET"))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;

    fn with(bins: &'static [&'static str]) -> impl Fn(&str) -> Option<PathBuf> {
        move |bin| bins.contains(&bin).then(|| PathBuf::from("/opt/tools").join(bin))
    }

    fn shown(id: &str, os: Os, bins: &'static [&'static str]) -> Option<String> {
        plan_for(by_id(id).unwrap(), os, &with(bins)).map(|p| p.display)
    }

    #[test]
    fn only_known_ids() {
        let ids: Vec<&str> = SERVERS.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["typescript", "rust", "python", "go", "clangd", "csharp"]);
        for bad in ["", "sh", "gopls", "../go", "go ", "GO", "go\0", "rust-analyzer; calc"] {
            assert!(by_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn constants_are_plain_words() {
        // They land on cmd.exe's command line for a shim.
        for program in SERVERS.iter().flat_map(|s| s.programs) {
            for word in program.args.iter().chain([&program.bin]) {
                assert!(word.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "{word}");
            }
        }
    }

    #[test]
    fn names() {
        let python = by_id("python").unwrap();
        assert_eq!(python.name_of(None), "pyright");
        let names: Vec<&str> = python.programs.iter().map(|p| python.name_of(Some(p))).collect();
        assert_eq!(names, ["pyright", "basedpyright", "pylsp"]);
    }

    #[test]
    fn recipes() {
        for os in [Os::Windows, Os::Mac, Os::Linux] {
            assert_eq!(
                shown("typescript", os, &["npm"]).as_deref(),
                Some("npm install -g typescript-language-server typescript@6")
            );
            assert_eq!(shown("python", os, &["npm"]).as_deref(), Some("npm install -g pyright"));
            assert_eq!(shown("rust", os, &["rustup"]).as_deref(), Some("rustup component add rust-analyzer"));
            assert_eq!(shown("go", os, &["go"]).as_deref(), Some("go install golang.org/x/tools/gopls@latest"));
            assert_eq!(shown("csharp", os, &["dotnet"]).as_deref(), Some("dotnet tool install --global csharp-ls"));
            for server in &SERVERS {
                assert!(plan_for(server, os, &with(&[])).is_none(), "{}: nothing to install it with", server.id);
            }
        }
    }

    #[test]
    fn clangd_per_os() {
        assert_eq!(
            shown("clangd", Os::Windows, &["winget"]).as_deref(),
            Some("winget install --id LLVM.clangd -e --source winget")
        );
        assert_eq!(shown("clangd", Os::Mac, &["brew"]).as_deref(), Some("brew install llvm"));
        assert_eq!(shown("clangd", Os::Linux, &["sudo", "dnf"]).as_deref(), Some("sudo dnf install -y clang-tools-extra"));
        assert_eq!(shown("clangd", Os::Linux, &["sudo", "dnf", "apt-get"]).as_deref(), Some("sudo apt-get install -y clangd"));
        assert_eq!(shown("clangd", Os::Linux, &["apt-get"]), None);
    }

    #[test]
    fn system_npm_installs_for_the_user() {
        let find = |bin: &str| (bin == "npm").then(|| PathBuf::from("/usr/bin/npm"));
        let plan = plan_for(by_id("python").unwrap(), Os::Linux, &find).unwrap();
        assert_eq!(plan.display, "npm install -g --prefix ~/.local pyright");
        assert!(Path::new(&plan.argv[4]).is_absolute() && plan.argv[4].ends_with(".local"));
        assert_eq!(plan_for(by_id("python").unwrap(), Os::Mac, &find).unwrap().display, "npm install -g pyright");
    }

    #[test]
    fn csharp_ls_fits_the_sdk() {
        let scratch = Scratch::new("dotnet");
        let dotnet = scratch.write("root/dotnet", "");
        scratch.dir("root/host");
        assert_eq!(dotnet_sdk(&dotnet), None, "the runtime alone");
        scratch.dir("root/sdk/NuGetFallbackFolder");
        assert_eq!(dotnet_sdk(&dotnet), None);
        scratch.dir("root/sdk/8.0.404");
        scratch.dir("root/sdk/10.0.201");
        assert_eq!(dotnet_sdk(&dotnet), Some(Sdk::Major(10)));
        assert_eq!(dotnet_sdk(&scratch.write("bin/dotnet", "")), Some(Sdk::Unknown), "a wrapper");
        let brew = scratch.write("brew/bin/dotnet", "");
        scratch.dir("brew/libexec/host");
        scratch.dir("brew/libexec/sdk/9.0.100");
        assert_eq!(dotnet_sdk(&brew), Some(Sdk::Major(9)));

        let shown = |major| csharp_ls(Sdk::Major(major)).map(|p| p.display);
        let base = "dotnet tool install --global csharp-ls";
        assert_eq!(shown(7), None);
        assert_eq!(shown(8), Some(format!("{base} --version 0.16.0")));
        assert_eq!(shown(10), Some(format!("{base} --version 0.28.0")));
        assert_eq!(shown(11).as_deref(), Some(base));
    }
}
