//! The MCP servers the user adds for agent chats (Settings > MCP servers, and a
//! project's own in Settings > Projects), kept in `mcp-servers.json` in the app
//! data folder.
//!
//! The file holds secrets (environment values of a command, request headers such
//! as `Authorization`), so it lives outside the webview's storage, is written
//! readable by its owner only (0600 on Unix), and nothing here logs a value.
//! Mango's own browser server (`browser_mcp`) is not in it; its name and every
//! other `mango-…` name are kept for Mango.
//!
//! The frontend hands each run the servers that apply (`utils/mcpServers.ts`),
//! and the adapters (`agents/mcp.ts`) pass them to the CLI for that run only.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "mcp-servers.json";
/// Tool names are `mcp__<name>__<tool>` and must stay short enough for the CLIs' limits.
const NAME_MAX: usize = 48;
const LIST_MAX: usize = 200;
const PAIRS_MAX: usize = 64;
const ARGS_MAX: usize = 128;
const VALUE_MAX: usize = 8 * 1024;

#[derive(Default)]
pub struct McpState {
    lock: Mutex<()>,
}

/// One name and value: an environment variable of a command, or an HTTP header.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpPair {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// None: every project on this computer. Some: that project only (an `env://` path for a remote one).
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Which agents get it: "claude", "codex".
    pub agents: Vec<String>,
    /// "stdio" (a command Mango's agent starts) or "http" (a streamable HTTP endpoint).
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpPair>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: Vec<McpPair>,
}

fn yes() -> bool {
    true
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

fn load(app: &AppHandle) -> Result<Vec<McpServer>, String> {
    let file = file(app)?;
    match fs::read_to_string(&file) {
        // One entry that no longer reads (hand-edited, from a newer build) must not take the others with it.
        Ok(text) => Ok(serde_json::from_str::<Vec<serde_json::Value>>(&text)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| serde_json::from_value::<McpServer>(v).ok())
            .collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Could not read {}: {e}", file.display())),
    }
}

fn save(app: &AppHandle, list: &[McpServer]) -> Result<(), String> {
    let file = file(app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    write_private(&tmp, json.as_bytes())
        .and_then(|_| fs::rename(&tmp, &file))
        .map_err(|e| format!("Could not save {}: {e}", file.display()))
}

/// Writes a file only its owner can read: it holds tokens.
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    // A file left by an older build may have been created with wider permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(bytes)?;
    f.sync_all()
}

/// Why `name` can't name a server, or None. Mirrors `mcpNameProblem` in app/agents/mcp.ts.
pub fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("Give the server a name.".into());
    }
    if name.len() > NAME_MAX {
        return Some(format!("Keep the name under {} characters.", NAME_MAX + 1));
    }
    let ok_chars = name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok_chars || !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return Some("Use letters, digits, - and _, starting with a letter or digit.".into());
    }
    if name.contains("__") {
        return Some("Two underscores in a row can't be used: tools are named mcp__<server>__<tool>.".into());
    }
    if name.to_ascii_lowercase().starts_with("mango-") || name.eq_ignore_ascii_case("mango") {
        return Some("Names starting with mango- are kept for Mango's own servers.".into());
    }
    None
}

fn no_control(what: &str, s: &str) -> Result<(), String> {
    if s.chars().any(char::is_control) {
        return Err(format!("{what} can't contain line breaks or control characters."));
    }
    if s.len() > VALUE_MAX {
        return Err(format!("{what} is too long."));
    }
    Ok(())
}

fn header_name_ok(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// Trims and checks one server; the id is kept or assigned by the caller.
pub(crate) fn clean(mut s: McpServer) -> Result<McpServer, String> {
    s.name = s.name.trim().to_string();
    if let Some(p) = name_problem(&s.name) {
        return Err(if s.name.is_empty() { p } else { format!("{}: {p}", s.name) });
    }
    let label = s.name.clone();
    s.project = s.project.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &s.project {
        no_control("A project path", p)?;
    }
    let mut agents: Vec<String> = Vec::new();
    for a in s.agents.iter().map(|a| a.trim()) {
        if a != "claude" && a != "codex" {
            return Err(format!("{label}: \"{a}\" is not an agent Mango knows."));
        }
        if !agents.iter().any(|x| x == a) {
            agents.push(a.to_string());
        }
    }
    if agents.is_empty() {
        return Err(format!("{label}: pick at least one agent to give it to."));
    }
    s.agents = agents;
    match s.transport.as_str() {
        "stdio" => {
            s.command = s.command.trim().to_string();
            if s.command.is_empty() {
                return Err(format!("{label}: give the command that starts the server."));
            }
            no_control("The command", &s.command)?;
            if s.args.len() > ARGS_MAX {
                return Err(format!("{label}: too many arguments."));
            }
            for a in &s.args {
                no_control("An argument", a)?;
            }
            s.env = clean_pairs(&label, std::mem::take(&mut s.env), "variable", |k| {
                k.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                    && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })?;
            s.url.clear();
            s.headers.clear();
        }
        "http" => {
            s.url = s.url.trim().to_string();
            let lower = s.url.to_ascii_lowercase();
            let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
            if !rest.is_some_and(|r| !r.is_empty() && !r.starts_with('/')) {
                return Err(format!("{label}: the address must start with http:// or https://."));
            }
            if s.url.chars().any(char::is_whitespace) {
                return Err(format!("{label}: the address can't contain spaces."));
            }
            no_control("The address", &s.url)?;
            s.headers = clean_pairs(&label, std::mem::take(&mut s.headers), "header", header_name_ok)?;
            s.command.clear();
            s.args.clear();
            s.env.clear();
        }
        other => return Err(format!("{label}: \"{other}\" is not a transport. Use stdio or http.")),
    }
    Ok(s)
}

/// Rows without a name are dropped (a row being typed); names must be valid and unique.
fn clean_pairs(label: &str, pairs: Vec<McpPair>, what: &str, valid: impl Fn(&str) -> bool) -> Result<Vec<McpPair>, String> {
    let pairs: Vec<McpPair> = pairs
        .into_iter()
        .map(|p| McpPair { name: p.name.trim().to_string(), value: p.value })
        .filter(|p| !p.name.is_empty())
        .collect();
    if pairs.len() > PAIRS_MAX {
        return Err(format!("{label}: too many {what}s."));
    }
    let mut seen = HashSet::new();
    for p in &pairs {
        if !valid(&p.name) {
            return Err(format!("{label}: \"{}\" can't be used as a {what} name.", p.name));
        }
        if !seen.insert(p.name.to_ascii_lowercase()) {
            return Err(format!("{label}: the {what} {} is set twice.", p.name));
        }
        // The value is a secret: the message names only the variable.
        if p.value.chars().any(|c| c == '\0' || c == '\r' || c == '\n') || p.value.len() > VALUE_MAX {
            return Err(format!("{label}: the value of {} can't contain line breaks, or is too long.", p.name));
        }
    }
    Ok(pairs)
}

/// Cleans the whole list: ids for new servers, and one name per scope.
pub(crate) fn clean_all(list: Vec<McpServer>) -> Result<Vec<McpServer>, String> {
    if list.len() > LIST_MAX {
        return Err("That is more MCP servers than Mango keeps.".into());
    }
    let mut out: Vec<McpServer> = Vec::with_capacity(list.len());
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for s in list {
        let mut s = clean(s)?;
        if s.id.trim().is_empty() || !ids.insert(s.id.clone()) {
            s.id = uuid::Uuid::new_v4().to_string();
            ids.insert(s.id.clone());
        }
        if !names.insert((s.project.clone(), s.name.to_ascii_lowercase())) {
            let scope = if s.project.is_some() { "this project" } else { "all projects" };
            return Err(format!("There is already a server named {} for {scope}.", s.name));
        }
        out.push(s);
    }
    Ok(out)
}

/// Every saved server, global and per project.
#[tauri::command]
pub async fn mcp_servers(app: AppHandle) -> Result<Vec<McpServer>, String> {
    tauri::async_runtime::spawn_blocking(move || load(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Replaces the saved list (after checking it) and returns it as saved, new servers with their ids.
#[tauri::command]
pub async fn mcp_servers_save(app: AppHandle, servers: Vec<McpServer>) -> Result<Vec<McpServer>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list = clean_all(servers)?;
        let state = app.state::<McpState>();
        let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
        save(&app, &list)?;
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str) -> McpServer {
        McpServer {
            id: String::new(),
            name: name.into(),
            project: None,
            enabled: true,
            agents: vec!["claude".into(), "codex".into()],
            transport: "stdio".into(),
            command: " npx ".into(),
            args: vec!["-y".into(), "@acme/mcp".into()],
            env: vec![McpPair { name: "API_KEY".into(), value: "s3cret".into() }, McpPair { name: " ".into(), value: String::new() }],
            url: "https://ignored".into(),
            headers: vec![McpPair { name: "X".into(), value: "y".into() }],
        }
    }

    fn http(name: &str) -> McpServer {
        McpServer {
            transport: "http".into(),
            command: String::new(),
            args: vec![],
            env: vec![],
            url: "https://mcp.example.com/mcp".into(),
            headers: vec![McpPair { name: "Authorization".into(), value: "Bearer t0ken".into() }],
            ..stdio(name)
        }
    }

    #[test]
    fn names() {
        for ok in ["github", "unity-editor", "a", "my_server2", "A-1"] {
            assert_eq!(name_problem(ok), None, "{ok}");
        }
        for bad in ["", "-x", "_x", "a b", "a.b", "a__b", "ünïcode", "mango-browser", "Mango-Unity", "mango", &"x".repeat(49)] {
            assert!(name_problem(bad).is_some(), "{bad}");
        }
    }

    #[test]
    fn cleans_stdio() {
        let s = clean(stdio(" acme ")).unwrap();
        assert_eq!(s.name, "acme");
        assert_eq!(s.command, "npx");
        assert_eq!(s.env, vec![McpPair { name: "API_KEY".into(), value: "s3cret".into() }]);
        assert!(s.url.is_empty() && s.headers.is_empty(), "the other transport's fields are dropped");
    }

    #[test]
    fn cleans_http() {
        let s = clean(http("remote")).unwrap();
        assert_eq!(s.url, "https://mcp.example.com/mcp");
        assert!(s.command.is_empty() && s.args.is_empty() && s.env.is_empty());
        assert_eq!(s.headers.len(), 1);
    }

    #[test]
    fn rejects_bad_servers() {
        let mut s = stdio("x");
        s.command = "  ".into();
        assert!(clean(s).is_err());
        let mut s = stdio("x");
        s.args.push("a\nb".into());
        assert!(clean(s).is_err());
        let mut s = stdio("x");
        s.env.push(McpPair { name: "1BAD".into(), value: String::new() });
        assert!(clean(s).is_err());
        let mut s = stdio("x");
        s.env.push(McpPair { name: "API_KEY".into(), value: "again".into() });
        assert!(clean(s).is_err(), "a variable set twice");
        let mut s = stdio("x");
        s.agents = vec![];
        assert!(clean(s).is_err());
        let mut s = stdio("x");
        s.agents = vec!["gemini".into()];
        assert!(clean(s).is_err());
        for url in ["ftp://x", "http://", "https:///x", "https://a b", "file:///etc/passwd", "javascript:alert(1)"] {
            let mut s = http("x");
            s.url = url.into();
            assert!(clean(s).is_err(), "{url}");
        }
        let mut s = http("x");
        s.headers.push(McpPair { name: "Bad Header".into(), value: String::new() });
        assert!(clean(s).is_err());
        let mut s = http("x");
        s.headers[0].value = "a\r\nInjected: 1".into();
        assert!(clean(s).is_err());
        let mut s = http("x");
        s.transport = "sse".into();
        assert!(clean(s).is_err());
    }

    #[test]
    fn error_messages_never_carry_values() {
        let mut s = http("x");
        s.headers[0].value = "Bearer t0ken\n".into();
        let e = clean(s).unwrap_err();
        assert!(!e.contains("t0ken"), "{e}");
    }

    #[test]
    fn one_name_per_scope() {
        let list = clean_all(vec![stdio("a"), http("b")]).unwrap();
        assert!(list.iter().all(|s| !s.id.is_empty()));
        assert_ne!(list[0].id, list[1].id);
        assert!(clean_all(vec![stdio("a"), http("A")]).is_err());
        // A project's own server may share a name with a global one: it takes its place there.
        let mut p = http("a");
        p.project = Some("/home/me/shop".into());
        assert!(clean_all(vec![stdio("a"), p.clone()]).is_ok());
        assert!(clean_all(vec![p.clone(), p]).is_err());
    }

    #[test]
    fn ids_are_kept_and_deduplicated() {
        let mut a = stdio("a");
        a.id = "one".into();
        let mut b = stdio("b");
        b.id = "one".into();
        let list = clean_all(vec![a, b]).unwrap();
        assert_eq!(list[0].id, "one");
        assert_ne!(list[1].id, "one");
    }

    #[test]
    fn wire_format() {
        let s = clean(http("b")).unwrap();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["transport"], "http");
        assert_eq!(v["headers"][0]["name"], "Authorization");
        assert!(v.get("project").is_some());
        // Older or hand-written entries without the optional fields still read.
        let read: McpServer = serde_json::from_str(r#"{"name":"x","agents":["claude"],"transport":"stdio","command":"x"}"#).unwrap();
        assert!(read.enabled && read.args.is_empty() && read.project.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mango-mcp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.json");
        fs::write(&f, "old").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&f, b"[]").unwrap();
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(&f).unwrap(), "[]");
        fs::remove_dir_all(&dir).unwrap();
    }
}
