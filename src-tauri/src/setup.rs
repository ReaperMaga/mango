//! First-run setup: which of the tools Mango relies on are installed, and how
//! to install the missing ones on this computer.
//!
//! The install recipes live here, not in the frontend: the UI asks for a tool
//! by id and the backend picks the command, so nothing from the webview ever
//! becomes a shell line. Installers run in a PTY (see `pty::start`) so the
//! user sees their output and can answer their prompts (sudo, UAC, winget).

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Os {
    Windows,
    Mac,
    Linux,
}

pub(crate) fn this_os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Mac
    } else {
        Os::Linux
    }
}

/// One way to install a tool: the program to run and what to show for it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Plan {
    pub(crate) argv: Vec<String>,
    /// The command as the user would type it.
    pub(crate) display: String,
    /// Who does the installing, e.g. "WinGet", "Anthropic's installer".
    via: &'static str,
    pub(crate) env: &'static [(&'static str, &'static str)],
}

impl Plan {
    /// Run a program directly; the display is its argv.
    pub(crate) fn direct(argv: &[&str], via: &'static str) -> Plan {
        Plan {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            display: argv.join(" "),
            via,
            env: &[],
        }
    }

    /// Run a script line in a shell (`bash -c`, `powershell -Command`, …).
    fn script(shell: &[&str], line: &str, via: &'static str, env: &'static [(&'static str, &'static str)]) -> Plan {
        let mut argv: Vec<String> = shell.iter().map(|s| s.to_string()).collect();
        argv.push(line.to_string());
        Plan { argv, display: line.to_string(), via, env }
    }
}

const POWERSHELL: [&str; 5] = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"];
/// The Codex installers ask whether to start Codex when they finish; in the
/// setup terminal that would start an agent nobody asked for.
const CODEX_ENV: &[(&str, &str)] = &[("CODEX_NON_INTERACTIVE", "1")];

/// How to install `tool` on `os`, given which programs exist (`has`).
/// `None` when there is no installer Mango can run here.
fn plan_for(tool: &str, os: Os, has: &dyn Fn(&str) -> bool) -> Option<Plan> {
    match (tool, os) {
        ("git", Os::Windows) => has("winget")
            .then(|| Plan::direct(&["winget", "install", "--id", "Git.Git", "-e", "--source", "winget"], "WinGet")),
        ("git", Os::Mac) => Some(if has("brew") {
            Plan::direct(&["brew", "install", "git"], "Homebrew")
        } else {
            Plan::direct(&["xcode-select", "--install"], "Apple's Command Line Tools")
        }),
        ("git", Os::Linux) => {
            if !has("sudo") {
                return None;
            }
            const MANAGERS: [(&str, &[&str], &str); 4] = [
                ("apt-get", &["sudo", "apt-get", "install", "-y", "git"], "apt"),
                ("dnf", &["sudo", "dnf", "install", "-y", "git"], "dnf"),
                ("pacman", &["sudo", "pacman", "-S", "--needed", "--noconfirm", "git"], "pacman"),
                ("zypper", &["sudo", "zypper", "install", "-y", "git"], "zypper"),
            ];
            MANAGERS
                .iter()
                .find(|(bin, _, _)| has(bin))
                .map(|(_, argv, via)| Plan::direct(argv, via))
        }

        ("claude", Os::Windows) => has("powershell")
            .then(|| Plan::script(&POWERSHELL, "irm https://claude.ai/install.ps1 | iex", "Anthropic's installer", &[])),
        ("claude", _) => (has("curl") && has("bash")).then(|| {
            Plan::script(&["bash", "-c"], "curl -fsSL https://claude.ai/install.sh | bash", "Anthropic's installer", &[])
        }),

        ("codex", Os::Windows) => has("powershell").then(|| {
            Plan::script(&POWERSHELL, "irm https://chatgpt.com/codex/install.ps1 | iex", "OpenAI's installer", CODEX_ENV)
        }),
        ("codex", _) => (has("curl") && has("sh")).then(|| {
            Plan::script(&["sh", "-c"], "curl -fsSL https://chatgpt.com/codex/install.sh | sh", "OpenAI's installer", CODEX_ENV)
        }),

        _ => None,
    }
}

/// The tools the setup dialog offers: (id, name, binary, page to install by hand).
const TOOLS: [(&str, &str, &str, &str); 3] = [
    ("git", "Git", "git", "https://git-scm.com/downloads"),
    ("claude", "Claude Code", "claude", "https://code.claude.com/docs/en/setup"),
    ("codex", "Codex", "codex", "https://github.com/openai/codex"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    /// The command that runs, as the user would type it.
    pub command: String,
    pub via: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupTool {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// How Mango would install it here; `None` when it can't (see `help_url`).
    pub install: Option<InstallPlan>,
    /// The vendor's own install page.
    pub help_url: String,
}

/// On macOS `/usr/bin/git` exists even without the Command Line Tools, and
/// running it pops up Apple's install dialog. Only count it once they are there.
fn is_stub(id: &str, path: &Path) -> bool {
    if this_os() != Os::Mac || id != "git" || path != Path::new("/usr/bin/git") {
        return false;
    }
    let mut cmd = std::process::Command::new("xcode-select");
    crate::bin::hide_console(&mut cmd);
    !cmd.arg("-p")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn check(id: &str, name: &str, binary: &str, help_url: &str) -> SetupTool {
    let path = crate::bin::find(binary).filter(|p| !is_stub(id, p));
    let has = |b: &str| crate::bin::find(b).is_some();
    SetupTool {
        id: id.to_string(),
        name: name.to_string(),
        installed: path.is_some(),
        version: path.as_deref().and_then(crate::agents::version_of),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        install: plan_for(id, this_os(), &has).map(|p| InstallPlan { command: p.display, via: p.via.to_string() }),
        help_url: help_url.to_string(),
    }
}

#[tauri::command]
pub async fn setup_check() -> Result<Vec<SetupTool>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // In parallel, so the worst case is one `--version` timeout, not three.
        std::thread::scope(|s| {
            let handles: Vec<_> = TOOLS
                .iter()
                .map(|&(id, name, bin, url)| s.spawn(move || check(id, name, bin, url)))
                .collect();
            handles
                .into_iter()
                .zip(TOOLS)
                .map(|(h, (id, name, _, url))| {
                    h.join().unwrap_or_else(|_| SetupTool {
                        id: id.to_string(),
                        name: name.to_string(),
                        installed: false,
                        version: None,
                        path: None,
                        install: None,
                        help_url: url.to_string(),
                    })
                })
                .collect()
        })
    })
    .await
    .map_err(|e| format!("Couldn't check what is installed: {e}"))
}

/// Start the installer of `tool` in a terminal. Returns the pty id; output and
/// the exit code arrive as `pty://data` / `pty://exit`.
#[tauri::command]
pub async fn setup_install(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    tool: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let name = TOOLS
        .iter()
        .find(|t| t.0 == tool)
        .map(|t| t.1)
        .ok_or_else(|| format!("Mango doesn't know how to install \"{tool}\""))?;
    let has = |b: &str| crate::bin::find(b).is_some();
    let plan = plan_for(&tool, this_os(), &has)
        .ok_or_else(|| format!("Mango can't install {name} on this computer. Use the download page instead."))?;
    crate::pty::start(app, &state, None, cols, rows, Some(plan.argv), plan.env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(bins: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |b| bins.contains(&b)
    }

    #[test]
    fn git_on_each_os() {
        let p = plan_for("git", Os::Windows, &with(&["winget"])).unwrap();
        assert_eq!(p.argv[..2], ["winget", "install"]);
        assert!(plan_for("git", Os::Windows, &with(&[])).is_none());

        assert_eq!(plan_for("git", Os::Mac, &with(&["brew"])).unwrap().display, "brew install git");
        assert_eq!(plan_for("git", Os::Mac, &with(&[])).unwrap().display, "xcode-select --install");

        let p = plan_for("git", Os::Linux, &with(&["sudo", "dnf"])).unwrap();
        assert_eq!(p.display, "sudo dnf install -y git");
        assert_eq!(p.via, "dnf");
        // apt wins when several are present.
        assert_eq!(plan_for("git", Os::Linux, &with(&["sudo", "dnf", "apt-get"])).unwrap().via, "apt");
        assert!(plan_for("git", Os::Linux, &with(&["apt-get"])).is_none(), "no sudo, no plan");
    }

    #[test]
    fn agents_use_vendor_installers() {
        let p = plan_for("claude", Os::Windows, &with(&["powershell"])).unwrap();
        assert_eq!(p.argv[0], "powershell");
        assert_eq!(p.argv.last().unwrap(), "irm https://claude.ai/install.ps1 | iex");
        assert_eq!(p.display, "irm https://claude.ai/install.ps1 | iex");

        let p = plan_for("claude", Os::Linux, &with(&["curl", "bash"])).unwrap();
        assert_eq!(p.argv, ["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
        assert!(plan_for("claude", Os::Linux, &with(&["bash"])).is_none(), "needs curl");

        let p = plan_for("codex", Os::Mac, &with(&["curl", "sh"])).unwrap();
        assert_eq!(p.argv, ["sh", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"]);
        assert_eq!(p.env, CODEX_ENV);
        assert!(plan_for("codex", Os::Windows, &with(&["powershell"])).is_some());
    }

    #[test]
    fn unknown_tools_have_no_plan() {
        assert!(plan_for("rm -rf /", Os::Linux, &with(&["sudo", "apt-get", "curl", "bash", "sh"])).is_none());
    }
}
