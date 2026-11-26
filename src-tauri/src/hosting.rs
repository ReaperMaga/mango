//! Settings > Git hosting: the GitHub CLI (`gh`) and the GitLab CLI (`glab`) on this computer.
//! Which hosts each is signed in to, signing in (the CLI's own flow, in a terminal the user
//! watches) and signing out.
//!
//! Like the agent CLIs, both own their credentials: Mango never sees a token. Status is read with
//! the token masked (no `--show-token`), only the host, user and state are kept from what the CLI
//! prints, and an error line passes `scrub` before it is shown.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::git::{blocking, lossy, run_process, Output};
use crate::gitlab::{normalize_host, GITLAB_COM};

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(20);
const CAP: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    Gh,
    Glab,
}

impl Tool {
    fn parse(id: &str) -> Result<Tool, String> {
        match id {
            "gh" => Ok(Tool::Gh),
            "glab" => Ok(Tool::Glab),
            _ => Err(format!("Mango doesn't know the \"{id}\" command.")),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Tool::Gh => "gh",
            Tool::Glab => "glab",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Tool::Gh => "GitHub CLI",
            Tool::Glab => "GitLab CLI",
        }
    }

    fn missing(self) -> &'static str {
        match self {
            Tool::Gh => crate::github::MISSING,
            Tool::Glab => crate::gitlab::MISSING,
        }
    }

    /// The CLI with its no-prompt, no-colour environment, run from the home folder so it does not
    /// pick a host from whatever repository Mango was started in.
    fn command(self) -> Command {
        let mut cmd = match self {
            Tool::Gh => crate::github::gh(None),
            Tool::Glab => crate::gitlab::command_here(),
        };
        if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }
        cmd
    }
}

/// One account a CLI holds for one host.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostingAccount {
    pub host: String,
    /// The user name, when the CLI reports one.
    pub user: Option<String>,
    /// The CLI could use it just now.
    pub ok: bool,
    /// The account the CLI uses on this host (gh keeps several per host; one is active).
    pub active: bool,
    /// The token comes from an environment variable (`GH_TOKEN`, `GITLAB_TOKEN`): signing out cannot remove it.
    pub from_env: bool,
    /// What went wrong, as the CLI says it (tokens removed).
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostingCli {
    /// "gh" | "glab"
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// The version number, e.g. "2.101.0".
    pub version: Option<String>,
    pub path: Option<String>,
    pub accounts: Vec<HostingAccount>,
    /// The status could not be read (the accounts are then empty).
    pub error: Option<String>,
    /// How Mango would install it here (`setup_install`); null when it can't.
    pub install: Option<crate::setup::InstallPlan>,
    /// The vendor's own install page.
    pub help_url: String,
}

// ---------------------------------------------------------------------------
// Reading what the CLIs print
// ---------------------------------------------------------------------------

/// Token prefixes GitHub and GitLab use.
const TOKEN_PREFIXES: [&str; 16] = [
    "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "gloas-", "glsoat-", "glrt-", "glptt-", "gldt-",
    "glft-", "glimt-", "glagent-", "glcbt-",
];

fn looks_secret(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    let lower = w.to_ascii_lowercase();
    if TOKEN_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    // Any long run of token characters with both letters and digits: better hidden than shown.
    w.len() >= 32
        && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
}

/// A line from a CLI as something safe to show: anything that looks like a token hidden, one line,
/// at most 240 characters.
pub(crate) fn scrub(text: &str) -> String {
    let joined = text
        .split_whitespace()
        .map(|w| if looks_secret(w) { "[hidden]" } else { w })
        .collect::<Vec<_>>()
        .join(" ");
    if joined.chars().count() > 240 {
        format!("{}…", joined.chars().take(239).collect::<String>())
    } else {
        joined
    }
}

/// A user name as the forges allow them (GitHub: letters, digits, `-`; GitLab adds `_` and `.`).
fn is_user(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with(['-', '.'])
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn user_of(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|u| is_user(u)).map(str::to_string)
}

fn error_of(s: Option<&str>) -> Option<String> {
    s.map(scrub).filter(|e| !e.is_empty())
}

/// `gh auth status --json hosts`: `{"hosts":{"github.com":[{"state","active","host","login","tokenSource","error"?}]}}`.
fn parse_gh_json(text: &str) -> Option<Vec<HostingAccount>> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let hosts = v.get("hosts")?.as_object()?;
    let mut out = Vec::new();
    for (key, list) in hosts {
        for a in list.as_array().into_iter().flatten() {
            let Some(host) = normalize_host(a.get("host").and_then(Value::as_str).unwrap_or(key)) else { continue };
            let ok = a.get("state").and_then(Value::as_str) == Some("success");
            let source = a.get("tokenSource").and_then(Value::as_str).unwrap_or("");
            out.push(HostingAccount {
                host,
                user: user_of(a.get("login").and_then(Value::as_str)),
                ok,
                active: a.get("active").and_then(Value::as_bool).unwrap_or(true),
                from_env: source.ends_with("_TOKEN"),
                error: if ok {
                    None
                } else {
                    error_of(a.get("error").and_then(Value::as_str)).or_else(|| Some("The saved sign-in no longer works.".into()))
                },
            });
        }
    }
    Some(out)
}

/// `glab auth status --all --output json`: `{"hosts":[{"host","state","user","error","token_source"}]}`.
fn parse_glab_json(text: &str) -> Option<Vec<HostingAccount>> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let hosts = v.get("hosts")?.as_array()?;
    let mut out = Vec::new();
    for a in hosts {
        let Some(host) = a.get("host").and_then(Value::as_str).and_then(normalize_host) else { continue };
        let ok = a.get("state").and_then(Value::as_str) == Some("success");
        let source = a.get("token_source").and_then(Value::as_str).unwrap_or("");
        out.push(HostingAccount {
            host,
            user: user_of(a.get("user").and_then(Value::as_str)),
            ok,
            active: true,
            from_env: source == "environment",
            error: if ok {
                None
            } else if source == "none" {
                Some("Not signed in.".into())
            } else {
                error_of(a.get("error").and_then(Value::as_str)).or_else(|| Some("The saved sign-in no longer works.".into()))
            },
        });
    }
    Some(out)
}

/// The status icon a line starts with, and the rest.
fn split_icon(line: &str) -> (Option<char>, &str) {
    let mut chars = line.chars();
    match chars.next() {
        Some(c @ ('✓' | '✔' | 'X' | 'x' | '✗' | '✘' | '×' | '!' | '-')) if line[c.len_utf8()..].starts_with(' ') => {
            (Some(c), line[c.len_utf8()..].trim_start())
        }
        _ => (None, line),
    }
}

fn is_fail_icon(c: Option<char>) -> bool {
    matches!(c, Some('X' | 'x' | '✗' | '✘' | '×'))
}

/// The word after `marker` (`account foo`, `as foo`), without the `(keyring)` after it.
fn word_after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let i = text.find(marker)?;
    text[i + marker.len()..].split_whitespace().next()
}

/// The text form of `gh auth status` and `glab auth status` (older versions without JSON). Both
/// print a host on its own line, then indented lines about it:
///
/// ```text
/// github.com
///   ✓ Logged in to github.com account octocat (keyring)       gh ≥ 2.40 (older: "as octocat")
///   - Active account: true
///   X Failed to log in to github.com account other (keyring)
///   - The token in keyring is invalid.
/// gitlab.example.com
///   x gitlab.example.com: API call failed: GET https://…/user: 401 {message: 401 Unauthorized}
///   ! No token found (checked config file, keyring, and environment variables).
/// ```
fn parse_status_text(text: &str) -> Vec<HostingAccount> {
    let mut out: Vec<HostingAccount> = Vec::new();
    let mut host: Option<String> = None;
    // The account a following "- …" line explains.
    let mut explain: Option<usize> = None;
    for raw in text.lines() {
        let indented = raw.starts_with([' ', '\t']);
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if !indented {
            host = normalize_host(line).filter(|h| h == &line.to_ascii_lowercase());
            explain = None;
            continue;
        }
        let Some(h) = host.clone() else { continue };
        let (icon, rest) = split_icon(line);
        let lower = rest.to_ascii_lowercase();
        if lower.starts_with("logged in to ") {
            let user = word_after(rest, " account ").or_else(|| word_after(rest, " as "));
            out.push(HostingAccount {
                host: h,
                user: user_of(user),
                ok: true,
                active: true,
                from_env: lower.contains("_token)") || lower.contains("environment variable"),
                error: None,
            });
            explain = None;
        } else if is_fail_icon(icon) {
            let user = word_after(rest, " account ");
            // glab: "gitlab.example.com: API call failed: …"; gh: "Failed to log in to … (keyring)".
            let detail = rest.strip_prefix(&format!("{h}: ")).unwrap_or(rest);
            let error = if lower.starts_with("failed to log in") { None } else { error_of(Some(detail)) };
            out.push(HostingAccount {
                host: h,
                user: user_of(user),
                ok: false,
                active: true,
                from_env: lower.contains("_token)"),
                error,
            });
            explain = Some(out.len() - 1);
        } else if icon == Some('!') && lower.starts_with("no token") {
            if !out.iter().any(|a| a.host == h) {
                out.push(HostingAccount { host: h, user: None, ok: false, active: true, from_env: false, error: Some("Not signed in.".into()) });
            }
        } else if icon == Some('-') && lower.starts_with("active account:") {
            if let Some(last) = out.last_mut().filter(|a| a.host == h) {
                last.active = lower.trim_end().ends_with("true");
            }
        } else if icon == Some('-') {
            if let Some(a) = explain.and_then(|i| out.get_mut(i)) {
                if a.error.is_none() && !lower.starts_with("to ") {
                    a.error = error_of(Some(rest));
                }
            }
        }
    }
    for a in out.iter_mut().filter(|a| !a.ok && a.error.is_none()) {
        a.error = Some("The saved sign-in no longer works.".into());
    }
    out
}

/// "gh version 2.101.0 (2026-09-15)" / "glab 1.131.0 (abc123)" → "2.101.0".
fn short_version(line: &str) -> String {
    line.split_whitespace()
        .map(|w| w.trim_start_matches('v'))
        .find(|w| w.split('.').count() >= 2 && w.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        .map(str::to_string)
        .unwrap_or_else(|| line.to_string())
}

fn run(tool: Tool, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut cmd = tool.command();
    cmd.args(args);
    run_process(cmd, None, CAP, timeout, tool.id(), tool.missing())
}

fn accounts_of(tool: Tool) -> Result<Vec<HostingAccount>, String> {
    let (json_args, parse_json): (&[&str], fn(&str) -> Option<Vec<HostingAccount>>) = match tool {
        Tool::Gh => (&["auth", "status", "--json", "hosts"], parse_gh_json),
        Tool::Glab => (&["auth", "status", "--all", "--output", "json"], parse_glab_json),
    };
    // Exit codes say little here: both exit 1 when any host fails, after printing it.
    let out = run(tool, json_args, STATUS_TIMEOUT)?;
    if let Some(list) = parse_json(&lossy(&out.stdout)).or_else(|| parse_json(&lossy(&out.stderr))) {
        return Ok(list);
    }
    // An older CLI without the JSON form: read the text (on stderr in some versions, stdout in others).
    let out = run(tool, &["auth", "status"], STATUS_TIMEOUT)?;
    Ok(parse_status_text(&format!("{}\n{}", lossy(&out.stderr), lossy(&out.stdout))))
}

fn status_of(app: &AppHandle, tool: Tool) -> HostingCli {
    let path = crate::bin::find(tool.id());
    let mut cli = HostingCli {
        id: tool.id().into(),
        name: tool.name().into(),
        installed: path.is_some(),
        version: None,
        path: path.as_ref().map(|p| p.to_string_lossy().into_owned()),
        accounts: Vec::new(),
        error: None,
        install: crate::setup::install_plan(tool.id()),
        help_url: crate::setup::HOSTING_TOOLS
            .iter()
            .find(|t| t.0 == tool.id())
            .map(|t| t.3.to_string())
            .unwrap_or_default(),
    };
    let Some(path) = path else { return cli };
    let (version, accounts) = std::thread::scope(|s| {
        let v = s.spawn(|| crate::agents::version_of(Path::new(&path)).map(|l| short_version(&l)));
        let a = accounts_of(tool);
        (v.join().ok().flatten(), a)
    });
    cli.version = version;
    match accounts {
        Ok(list) => cli.accounts = list,
        Err(e) => cli.error = Some(scrub(&e)),
    }
    if tool == Tool::Glab {
        // Servers glab knows are GitLab servers, whatever their name: recognise their projects.
        for a in &cli.accounts {
            if a.host != GITLAB_COM {
                let _ = crate::gitlab::remember_host(app, &a.host);
            }
        }
    }
    cli
}

/// The argv of the CLI's own sign-in for `host` (already normalised): built here, never taken from
/// the webview. Git over HTTPS, so the CLI offers to set itself up as git's credential helper.
fn login_argv(tool: Tool, host: &str) -> Vec<String> {
    let mut argv: Vec<&str> = vec![tool.id(), "auth", "login", "--hostname", host, "--git-protocol", "https"];
    match tool {
        Tool::Gh => argv.push("--web"),
        // gitlab.com signs in in the browser; a self-managed server may have no OAuth app for glab,
        // so there glab asks: a token or the browser.
        Tool::Glab if host == GITLAB_COM => argv.push("--web"),
        Tool::Glab => {}
    }
    argv.into_iter().map(str::to_string).collect()
}

fn logout_argv(tool: Tool, host: &str, user: Option<&str>) -> Vec<String> {
    let mut argv: Vec<&str> = vec!["auth", "logout", "--hostname", host];
    if let (Tool::Gh, Some(u)) = (tool, user) {
        // With several accounts on a host gh would ask which one.
        argv.extend(["--user", u]);
    }
    argv.into_iter().map(str::to_string).collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Both CLIs: installed or not, version, and the hosts each is signed in to. Signed-in glab servers
/// other than gitlab.com join the list of GitLab servers.
#[tauri::command]
pub async fn hosting_status(app: AppHandle) -> Result<Vec<HostingCli>, String> {
    blocking(move || {
        Ok(std::thread::scope(|s| {
            let gh = s.spawn(|| status_of(&app, Tool::Gh));
            let glab = s.spawn(|| status_of(&app, Tool::Glab));
            [(gh, Tool::Gh), (glab, Tool::Glab)]
                .into_iter()
                .map(|(h, tool)| {
                    h.join().unwrap_or_else(|_| HostingCli {
                        id: tool.id().into(),
                        name: tool.name().into(),
                        installed: false,
                        version: None,
                        path: None,
                        accounts: Vec::new(),
                        error: Some(format!("Mango couldn't check the {}.", tool.name())),
                        install: None,
                        help_url: String::new(),
                    })
                })
                .collect()
        }))
    })
    .await
}

/// Run `tool`'s own sign-in for `host` in a terminal. Returns the pty id (`pty://data`, `pty://exit`).
#[tauri::command]
pub async fn hosting_login(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    tool: String,
    host: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let tool = Tool::parse(&tool)?;
    let host = normalize_host(&host).ok_or_else(|| format!("\"{}\" is not a server name.", host.trim()))?;
    if crate::bin::find(tool.id()).is_none() {
        return Err(tool.missing().into());
    }
    let env: &[(&str, &str)] = match tool {
        Tool::Gh => &[("GH_NO_UPDATE_NOTIFIER", "1")],
        Tool::Glab => &[("GLAB_CHECK_UPDATE", "false"), ("GLAB_SEND_TELEMETRY", "false")],
    };
    crate::pty::start(app, &state, None, cols, rows, Some(login_argv(tool, &host)), env)
}

/// Sign `tool` out of `host` (for gh, of `user` there when given).
#[tauri::command]
pub async fn hosting_logout(tool: String, host: String, user: Option<String>) -> Result<(), String> {
    let tool = Tool::parse(&tool)?;
    let host = normalize_host(&host).ok_or_else(|| format!("\"{}\" is not a server name.", host.trim()))?;
    let user = user.filter(|u| !u.trim().is_empty());
    if let Some(u) = &user {
        if !is_user(u) {
            return Err(format!("\"{u}\" is not a user name."));
        }
    }
    blocking(move || {
        let argv = logout_argv(tool, &host, user.as_deref());
        let args: Vec<&str> = argv.iter().map(String::as_str).collect();
        let out = run(tool, &args, LOGOUT_TIMEOUT)?;
        if out.ok() {
            return Ok(());
        }
        let said = out.combined();
        let line = said.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        Err(if line.is_empty() { format!("The {} could not sign out of {host}.", tool.name()) } else { scrub(line) })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const GH_JSON: &str = r#"{"hosts":{"github.com":[
        {"state":"success","active":true,"host":"github.com","login":"octocat","tokenSource":"keyring","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"},
        {"state":"error","active":false,"host":"github.com","login":"other","tokenSource":"keyring","error":"The token in keyring is invalid."}],
      "ghe.example.com":[{"state":"success","active":true,"host":"ghe.example.com","login":"me","tokenSource":"GH_ENTERPRISE_TOKEN"}]}}"#;

    #[test]
    fn reads_gh_json() {
        let list = parse_gh_json(GH_JSON).unwrap();
        assert_eq!(list.len(), 3);
        let a = list.iter().find(|a| a.user.as_deref() == Some("octocat")).unwrap();
        assert!(a.ok && a.active && !a.from_env && a.error.is_none());
        let b = list.iter().find(|a| a.user.as_deref() == Some("other")).unwrap();
        assert!(!b.ok && !b.active);
        assert_eq!(b.error.as_deref(), Some("The token in keyring is invalid."));
        let c = list.iter().find(|a| a.host == "ghe.example.com").unwrap();
        assert!(c.from_env);
        assert_eq!(parse_gh_json(r#"{"hosts":{}}"#).unwrap(), vec![]);
        assert!(parse_gh_json("unknown flag: --json").is_none());
    }

    #[test]
    fn reads_gh_text() {
        // gh 2.40+ (stdout), and the older form (stderr) with "as".
        let text = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n\n  X Failed to log in to github.com account other (keyring)\n  - Active account: false\n  - The token in keyring is invalid.\n  - To re-authenticate, run: gh auth login -h github.com\n";
        let list = parse_status_text(text);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], HostingAccount { host: "github.com".into(), user: Some("octocat".into()), ok: true, active: true, from_env: false, error: None });
        assert_eq!(list[1].user.as_deref(), Some("other"));
        assert!(!list[1].ok && !list[1].active);
        assert_eq!(list[1].error.as_deref(), Some("The token in keyring is invalid."));

        let old = "github.com\n  ✓ Logged in to github.com as octocat (/home/me/.config/gh/hosts.yml)\n  ✓ Git operations for github.com configured to use https protocol.\n  ✓ Token: *******************\n";
        assert_eq!(parse_status_text(old)[0].user.as_deref(), Some("octocat"));
        let env = "github.com\n  ✓ Logged in to github.com account octocat (GH_TOKEN)\n";
        assert!(parse_status_text(env)[0].from_env);
        assert!(parse_status_text("You are not logged into any GitHub hosts. To log in, run: gh auth login\n").is_empty());
    }

    #[test]
    fn reads_glab_json() {
        let json = r#"{"hosts":[
            {"host":"gitlab.com","state":"success","user":"tanuki","token_source":"keyring","git_protocol":"https","api_protocol":"https","api_endpoint":"https://gitlab.com/api/v4/","graphql_endpoint":"https://gitlab.com/api/graphql/"},
            {"host":"git.corp.io","state":"error","error":"GET https://git.corp.io/api/v4/user: 401 {message: 401 Unauthorized}","token_source":"config_file","api_endpoint":"https://git.corp.io/api/v4/","graphql_endpoint":"https://git.corp.io/api/graphql/"},
            {"host":"gitlab.example.com","state":"error","error":"no token","token_source":"none","api_endpoint":"","graphql_endpoint":""}]}"#;
        let list = parse_glab_json(json).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!((list[0].host.as_str(), list[0].user.as_deref(), list[0].ok), ("gitlab.com", Some("tanuki"), true));
        assert!(!list[1].ok);
        assert!(list[1].error.as_deref().unwrap().contains("401"));
        assert_eq!(list[2].error.as_deref(), Some("Not signed in."));
    }

    #[test]
    fn reads_glab_text() {
        let text = "gitlab.com\n  ✓ Logged in to gitlab.com as tanuki (/home/me/.config/glab-cli/config.yml)\n  ✓ Git operations for gitlab.com configured to use https protocol.\n  ✓ API calls for gitlab.com are made over https protocol.\n  ✓ REST API Endpoint: https://gitlab.com/api/v4/\n  ✓ GraphQL Endpoint: https://gitlab.com/api/graphql/\n  ✓ Token found in operating system keyring: **************************\ngit.corp.io\n  x git.corp.io: API call failed: GET https://git.corp.io/api/v4/user: 401 {message: 401 Unauthorized}\n  ✓ Git operations for git.corp.io configured to use ssh protocol.\n  ✓ Token found in configuration file (plaintext): **************************\ngitlab.example.com\n  ! No token found (checked config file, keyring, and environment variables).\n\nx could not authenticate to one or more of the configured GitLab instances\n";
        let list = parse_status_text(text);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].user.as_deref(), Some("tanuki"));
        assert!(list[0].ok);
        assert_eq!(list[1].host, "git.corp.io");
        assert!(!list[1].ok);
        assert!(list[1].error.as_deref().unwrap().starts_with("API call failed: GET https://git.corp.io/api/v4/user: 401"));
        assert_eq!(list[2].error.as_deref(), Some("Not signed in."));
    }

    #[test]
    fn never_shows_tokens() {
        assert_eq!(scrub("bad token glpat-abcDEF1234567890xyz here"), "bad token [hidden] here");
        assert_eq!(scrub("Token: gho_16C7e42F292c6912E7710c838347Ae178B4a"), "Token: [hidden]");
        assert_eq!(scrub("x 0123456789abcdef0123456789abcdef0123"), "x [hidden]");
        assert_eq!(scrub("GET https://git.corp.io/api/v4/user: 401"), "GET https://git.corp.io/api/v4/user: 401");
        let list = parse_status_text("github.com\n  X Failed to log in to github.com account a (keyring)\n  - Token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is invalid\n");
        assert!(!list[0].error.as_deref().unwrap().contains("ghp_"));
    }

    /// Reads (never changes) this computer's real sign-ins: `cargo test real_status -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_status() {
        for tool in [Tool::Gh, Tool::Glab] {
            println!("{}: {:?}", tool.id(), accounts_of(tool));
        }
    }

    #[test]
    fn versions_and_argv() {
        assert_eq!(short_version("gh version 2.101.0 (2026-09-15)"), "2.101.0");
        assert_eq!(short_version("glab 1.131.0 (a1b2c3d)"), "1.131.0");
        assert_eq!(short_version("glab version v1.50.0"), "1.50.0");
        assert_eq!(login_argv(Tool::Gh, "github.com"), ["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]);
        assert_eq!(login_argv(Tool::Glab, "gitlab.com").last().unwrap(), "--web");
        assert_eq!(login_argv(Tool::Glab, "git.corp.io").last().unwrap(), "https", "a self-managed server lets glab ask");
        assert_eq!(logout_argv(Tool::Gh, "github.com", Some("octocat")), ["auth", "logout", "--hostname", "github.com", "--user", "octocat"]);
        assert_eq!(logout_argv(Tool::Glab, "gitlab.com", Some("x")), ["auth", "logout", "--hostname", "gitlab.com"]);
        assert!(Tool::parse("rm").is_err());
        assert!(!is_user("-x") && is_user("a.b_c-d"));
    }
}
