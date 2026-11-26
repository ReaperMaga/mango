//! Lore (Epic Games' version control, `lore` CLI): the servers the user saved, checking one (is the CLI
//! here, does the server answer, over which ports, and does it want a sign-in), signing in and out, and
//! the shared pieces creating and cloning Lore projects use (`projects.rs`, `envs/remote.rs`).
//!
//! Like the other CLIs, `lore` owns its credentials: sign-in is its own browser flow in a terminal the
//! user watches, and Mango never passes a token (`--token` would show it in the process table).
//!
//! What the CLI does on the wire (lore 0.14, measured): the environment, repository listing and
//! creating go over gRPC on **TCP** port N (default 41337); file data (`repository info`, `clone`) goes
//! over QUIC on **UDP** port N. Every connection failure prints the same "Disconnected from server",
//! after 5 s for a host that does not answer and at once for a refused port or an unknown name, so
//! [`check`] tells them apart itself (name lookup, a TCP connect) and probes UDP with a data read.
//!
//! The pure parts (`parse_*`, `*_argv`, [`explain`]) take no `AppHandle`, so running the same checks
//! inside an environment (over `ssh`, as `gitlab::GlabAt` does for glab) only needs a different runner.

use std::fs;
use std::net::{IpAddr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::git::{blocking, run_process, Output};

pub const DEFAULT_PORT: u16 = 41337;
/// The CLI's port for a `lores://` address without one: 443, like `https://` (measured with lore
/// 0.14.0: `lores://host` sends gRPC to 443, `lores://host:41337` reaches the server).
pub const SECURE_DEFAULT_PORT: u16 = 443;

/// The port the CLI uses when the address names none.
pub fn default_port(secure: bool) -> u16 {
    if secure { SECURE_DEFAULT_PORT } else { DEFAULT_PORT }
}
const SERVERS_FILE: &str = "lore-servers.json";
const MAX_SERVERS: usize = 50;
const CAP: usize = 512 * 1024;
/// A host that does not answer makes the CLI give up after 5 s; this only catches one that hangs.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const CREATE_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) const MISSING: &str = "The Lore CLI (lore) is not installed on this computer. Install it in Settings > Lore.";
/// Where Epic documents installing the CLI by hand.
pub(crate) const HELP_URL: &str = "https://epicgames.github.io/lore/how-to/install-lore-cli/";

// Exit codes of the CLI: its error codes (lore-base/src/error.rs).
const E_NOT_SUPPORTED: i32 = 9;
const E_NOT_AUTHENTICATED: i32 = 16;
const E_NOT_AUTHORIZED: i32 = 17;
const E_DISCONNECTED: i32 = 28;
const E_NOT_CONNECTED: i32 = 29;
const E_MAINTENANCE: i32 = 30;
const E_UNAVAILABLE: i32 = 32;
const E_NOT_FOUND: i32 = 79;
const E_REPO_NOT_FOUND: i32 = 89;

// ---------------------------------------------------------------------------
// URLs and names
// ---------------------------------------------------------------------------

/// A Lore server: `lore://host[:port]`, or `lores://host[:port]` for one the CLI authenticates (its
/// certificate checked, gRPC over TLS: what a server with sign-in needs, or tokens travel in the clear).
/// The host is a DNS name (lower case), an IPv4 address or a bracketed IPv6 address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerUrl {
    pub host: String,
    pub port: Option<u16>,
    /// `lores://`.
    pub secure: bool,
}

impl ServerUrl {
    pub fn port_or_default(&self) -> u16 {
        self.port.unwrap_or(default_port(self.secure))
    }

    /// The host without IPv6 brackets, for name lookups.
    fn bare_host(&self) -> &str {
        self.host.trim_start_matches('[').trim_end_matches(']')
    }

    /// `lore://host[:port]/name` (the name already checked by [`valid_repo_name`]).
    pub fn repo(&self, name: &str) -> String {
        format!("{self}/{name}")
    }
}

impl std::fmt::Display for ServerUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let scheme = if self.secure { "lores" } else { "lore" };
        match self.port {
            Some(p) => write!(f, "{scheme}://{}:{p}", self.host),
            None => write!(f, "{scheme}://{}", self.host),
        }
    }
}

/// What follows `lore://` or `lores://` (either in any case), and whether it was `lores://`.
pub(crate) fn strip_scheme(s: &str) -> Option<(&str, bool)> {
    for (scheme, secure) in [("lores://", true), ("lore://", false)] {
        if s.get(..scheme.len()).is_some_and(|p| p.eq_ignore_ascii_case(scheme)) {
            return Some((&s[scheme.len()..], secure));
        }
    }
    None
}

fn is_dns_name(s: &str) -> bool {
    s.len() <= 253
        && s.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

/// `host[:port]` after `lore://`, before any path.
fn parse_authority(authority: &str, whole: &str, secure: bool) -> Result<ServerUrl, String> {
    let bad = |why: &str| Err(format!("\"{whole}\" is not a Lore server address: {why}"));
    if authority.is_empty() {
        return bad("the server name is missing. Use lore://host or lore://host:port.");
    }
    if authority.contains('@') {
        return bad("leave the user name out; sign in in Settings > Lore instead.");
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let Some((ip, after)) = rest.split_once(']') else { return bad("the IPv6 address has no closing ].") };
        if ip.parse::<Ipv6Addr>().is_err() {
            return bad("the IPv6 address is not valid.");
        }
        let port = match after {
            "" => None,
            p => match p.strip_prefix(':') {
                Some(p) => Some(p),
                None => return bad("only a port may follow the address."),
            },
        };
        (format!("[{}]", ip.to_ascii_lowercase()), port)
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        let host = host.to_ascii_lowercase();
        if !is_dns_name(&host) {
            return bad("use a server name (letters, digits, dots and dashes), an IPv4 address or [IPv6].");
        }
        (host, port)
    };
    let port = match port {
        None => None,
        Some(p) => {
            let n = (!p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
                .then(|| p.parse::<u32>().ok())
                .flatten()
                .filter(|n| (1..=65535).contains(n));
            match n {
                Some(n) => Some(n as u16),
                None => return bad("the port must be a number from 1 to 65535."),
            }
        }
    };
    Ok(ServerUrl { host, port, secure })
}

/// Splits `lore[s]://authority[/path]`, refusing anything a URL could smuggle in (query, fragment,
/// userinfo, whitespace, control characters). The flag is `lores://`.
fn split_url(s: &str) -> Result<(&str, &str, bool), String> {
    if s.chars().any(|c| c.is_whitespace() || c.is_control()) || s.len() > 600 {
        return Err(format!("\"{}\" is not a Lore address: it has spaces or other characters a URL can't hold.", s.trim()));
    }
    // The scheme is case-insensitive; anything else is not a Lore address.
    let Some((rest, secure)) = strip_scheme(s) else {
        return Err(format!("\"{s}\" is not a Lore address. It starts with lore:// or lores://, like lore://lore.example.com."));
    };
    if rest.contains(['?', '#', '\\']) {
        return Err(format!("\"{s}\" is not a Lore address: leave out ?, # and \\."));
    }
    Ok(match rest.split_once('/') {
        Some((a, p)) => (a, p, secure),
        None => (rest, "", secure),
    })
}

/// A server address as typed (`lore://host[:port]`, one trailing `/` allowed). The scheme's default port
/// is kept out of the result, so `lore://h:41337` and `lore://h` are the same server (and
/// `lores://h:443` and `lores://h`; `lores://h:41337` keeps its port).
pub fn parse_server_url(s: &str) -> Result<ServerUrl, String> {
    let s = s.trim();
    let (authority, path, secure) = split_url(s)?;
    if !path.is_empty() {
        return Err(format!(
            "\"{s}\" names a repository. A server is only lore://host or lore://host:port; the repository is picked when you create or clone."
        ));
    }
    let mut url = parse_authority(authority, s, secure)?;
    if url.port == Some(default_port(secure)) {
        url.port = None;
    }
    Ok(url)
}

/// A repository name on a server: letters, digits, `/`, `-`, `_`, `.`; no empty, `.` or `..` part,
/// not starting with `-` or `.`.
pub fn valid_repo_name(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 200
        && !s.starts_with(['-', '.', '/'])
        && !s.ends_with('/')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c))
        && s.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    ok.then_some(()).ok_or_else(|| {
        format!("\"{s}\" can't be a Lore repository name. Use letters, digits, -, _ and . (and / between parts).")
    })
}

/// A repository address, `lore://host[:port]/name`: the server and the name. The URL comes back with
/// the scheme's default port dropped.
pub fn parse_repo_url(s: &str) -> Result<(ServerUrl, String), String> {
    let s = s.trim();
    let (authority, path, secure) = split_url(s)?;
    let mut server = parse_authority(authority, s, secure)?;
    if server.port == Some(default_port(secure)) {
        server.port = None;
    }
    let name = path.trim_end_matches('/');
    if name.is_empty() {
        return Err(format!("\"{s}\" names a server but no repository. Add its name: lore://host/repository."));
    }
    valid_repo_name(name)?;
    Ok((server, name.to_string()))
}

// ---------------------------------------------------------------------------
// Saved servers
// ---------------------------------------------------------------------------

/// Where a server runs when Mango set it up: an Incus instance of a saved environment server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoreOrigin {
    pub host_id: String,
    pub instance: String,
}

/// One saved Lore server (`lore-servers.json`, no secrets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoreServer {
    pub id: String,
    /// What the user calls it.
    pub name: String,
    /// How this computer reaches it.
    pub url: String,
    /// How projects inside environments on the origin's server reach it (`lore://<instance>.incus`),
    /// when that differs from `url`.
    #[serde(default)]
    pub inside_url: Option<String>,
    /// null for a server Mango did not set up.
    #[serde(default)]
    pub origin: Option<LoreOrigin>,
    /// The machine it runs on, when Mango set it up there over SSH (`lore_machines`).
    #[serde(default)]
    pub machine: Option<crate::lore_machines::LoreMachine>,
}

/// A server to add or change: [`upsert`] fills in the id.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoreServerInput {
    /// The entry to change; none for a new one (or the one with the same `origin`).
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub inside_url: Option<String>,
    #[serde(default)]
    pub origin: Option<LoreOrigin>,
    #[serde(default)]
    pub machine: Option<crate::lore_machines::LoreMachine>,
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn servers_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(SERVERS_FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

/// The saved list; entries a hand edit broke are left out.
fn read_servers(file: &Path) -> Vec<LoreServer> {
    let Ok(text) = fs::read_to_string(file) else { return Vec::new() };
    let list: Vec<LoreServer> = serde_json::from_str(&text).unwrap_or_default();
    list.into_iter().map(with_lore_port).filter_map(|s| clean(s, false).ok()).take(MAX_SERVERS).collect()
}

/// Builds before 0.10.2 saved a server Mango set up with sign-in as `lores://domain`, meaning Lore's
/// port; the CLI reads that as 443, where Caddy answers. Such an entry gets 41337 back. Nothing Mango
/// sets up has Lore on 443 (Caddy holds it beside the server), so no entry saved since looks like that.
fn with_lore_port(mut s: LoreServer) -> LoreServer {
    if s.origin.is_some() || s.machine.is_some() {
        if let Ok(u) = parse_server_url(&s.url) {
            if u.secure && u.port.is_none() {
                s.url = format!("{u}:{DEFAULT_PORT}");
            }
        }
    }
    s
}

fn write_servers(file: &Path, list: &[LoreServer]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    crate::mcp::write_private(&tmp, json.as_bytes())
        .and_then(|_| fs::rename(&tmp, file))
        .map_err(|e| format!("Could not save {}: {e}", file.display()))
}

/// One entry checked and normalised (the URLs canonical, the name trimmed or the host). `strict`
/// also asks the disk (a machine's key file exists): on a change, not when loading the list.
fn clean(s: LoreServer, strict: bool) -> Result<LoreServer, String> {
    if !valid_id(&s.id) {
        return Err("The server's id is not valid.".into());
    }
    let url = parse_server_url(&s.url)?;
    let inside_url = match s.inside_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => Some(parse_server_url(u)?.to_string()),
        None => None,
    };
    if let Some(o) = &s.origin {
        if !valid_id(&o.host_id) {
            return Err("The server's environment id is not valid.".into());
        }
        crate::envs::valid_instance(&o.instance)?;
    }
    let machine = match s.machine {
        Some(m) => Some(crate::lore_machines::clean(m, strict)?),
        None => None,
    };
    let name: String = s.name.trim().chars().filter(|c| !c.is_control()).take(80).collect();
    let name = if name.is_empty() { url.host.clone() } else { name };
    Ok(LoreServer { id: s.id, name, url: url.to_string(), inside_url, origin: s.origin, machine })
}

/// Adds `input` to `list`, or replaces the entry with its id (or, with no id, the one with the same
/// origin, or set up on the same machine). Refuses a second entry for the same address.
fn upsert_in(list: &mut Vec<LoreServer>, input: LoreServerInput) -> Result<LoreServer, String> {
    let at = match input.id.as_deref() {
        Some(id) => Some(list.iter().position(|s| s.id == id).ok_or("That server is no longer in the list.")?),
        None => match (&input.origin, &input.machine) {
            (Some(o), _) => list.iter().position(|s| s.origin.as_ref() == Some(o)),
            // The same machine (SSH destination and port) set up again.
            (None, Some(m)) => list.iter().position(|s| s.machine.as_ref().is_some_and(|x| x.ssh == m.ssh && x.port == m.port)),
            (None, None) => None,
        },
    };
    let id = match at {
        Some(i) => list[i].id.clone(),
        None => uuid::Uuid::new_v4().simple().to_string(),
    };
    let entry = clean(LoreServer {
        id: id.clone(),
        name: input.name,
        url: input.url,
        inside_url: input.inside_url,
        origin: input.origin,
        machine: input.machine,
    }, true)?;
    if let Some(other) = list.iter().find(|s| s.id != id && s.url == entry.url) {
        return Err(format!("{} is already in the list as \"{}\".", entry.url, other.name));
    }
    match at {
        Some(i) => list[i] = entry.clone(),
        None if list.len() >= MAX_SERVERS => return Err(format!("Mango keeps up to {MAX_SERVERS} Lore servers. Remove one first.")),
        None => list.push(entry.clone()),
    }
    Ok(entry)
}

/// The saved Lore servers.
pub fn servers(app: &AppHandle) -> Vec<LoreServer> {
    servers_file(app).map(|f| read_servers(&f)).unwrap_or_default()
}

/// Add or change a saved server; returns the whole list. For other parts of Mango too: an Incus
/// recipe that sets up a Lore server registers it here with its `origin` (and `inside_url`), and
/// running it again updates that same entry.
pub fn upsert(app: &AppHandle, input: LoreServerInput) -> Result<Vec<LoreServer>, String> {
    let file = servers_file(app)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = read_servers(&file);
    upsert_in(&mut list, input)?;
    write_servers(&file, &list)?;
    Ok(list)
}

/// Remove the entries an environment instance set up (when it is deleted). Returns the list. For the
/// Incus recipe that sets up Lore servers, which calls it when its instance goes.
#[allow(dead_code)]
pub fn remove_origin(app: &AppHandle, host_id: &str, instance: &str) -> Result<Vec<LoreServer>, String> {
    let file = servers_file(app)?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = read_servers(&file);
    list.retain(|s| s.origin.as_ref().is_none_or(|o| o.host_id != host_id || o.instance != instance));
    write_servers(&file, &list)?;
    Ok(list)
}

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/// `lore` with no pager, no prompts, no colour, from the home folder (never a repository Mango was
/// started in).
pub(crate) fn command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    crate::bin::hide_console(&mut cmd);
    cmd.env("NO_COLOR", "1");
    if let Some(path) = crate::bin::augmented_path(bin.parent()) {
        cmd.env("PATH", path);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    cmd
}

/// The global flags every automated call gets: no pager, never a prompt nobody sees.
pub(crate) const QUIET: [&str; 2] = ["-P", "--non-interactive"];

fn argv(rest: &[&str]) -> Vec<String> {
    QUIET.iter().chain(rest).map(|s| s.to_string()).collect()
}

/// `lore repository list <server>`: answers over TCP, so it proves the gRPC port.
pub fn list_argv(server: &ServerUrl) -> Vec<String> {
    argv(&["repository", "list", &server.to_string()])
}

/// `lore repository info <server>/<name>`: reads repository data over QUIC, so it proves the UDP port.
pub fn info_argv(server: &ServerUrl, name: &str) -> Vec<String> {
    argv(&["repository", "info", &server.repo(name)])
}

/// `lore --repository <probe> auth info`: who the CLI signs in to the probe's server as. Connects for
/// the server's sign-in settings, so a server without sign-in says so.
pub fn auth_info_argv(probe: &str) -> Vec<String> {
    argv(&["--repository", probe, "auth", "info"])
}

pub fn logout_argv(probe: &str) -> Vec<String> {
    argv(&["--repository", probe, "auth", "logout"])
}

/// The CLI's own browser sign-in, in a terminal (no `--non-interactive`: it may ask).
pub fn login_argv(program: &str, server: &ServerUrl) -> Vec<String> {
    vec![program.into(), "login".into(), server.to_string()]
}

/// `lore repository create <server>/<name>` (run in the new folder), or `--offline <name>`.
pub fn create_argv(server: Option<&ServerUrl>, name: &str) -> Vec<String> {
    match server {
        Some(s) => argv(&["repository", "create", &s.repo(name)]),
        None => argv(&["repository", "create", "--offline", name]),
    }
}

pub fn clone_argv(url: &str, dir: &str) -> Vec<String> {
    argv(&["clone", "--", url, dir])
}

/// A repository folder holding nothing but the server's address: enough for `auth info` and
/// `auth logout` to find the server's sign-in settings. The contents of `.lore/config.toml`.
pub fn probe_config(server: &ServerUrl) -> String {
    // The address passed `parse_server_url`: no quotes or backslashes can reach the TOML string.
    format!("remote_url = \"{server}\"\n")
}

/// A probe folder under the temp folder, removed when dropped.
struct Probe(PathBuf);

impl Probe {
    fn new(server: &ServerUrl) -> Result<Probe, String> {
        let dir = std::env::temp_dir().join(format!("mango-lore-{}", uuid::Uuid::new_v4().simple()));
        let made = fs::create_dir_all(dir.join(".lore"))
            .and_then(|_| fs::write(dir.join(".lore").join("config.toml"), probe_config(server)));
        let probe = Probe(dir);
        made.map_err(|e| format!("Could not prepare a check of the Lore server: {e}"))?;
        Ok(probe)
    }
    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn find() -> Option<PathBuf> {
    crate::bin::find("lore")
}

fn run(bin: &Path, args: &[String], timeout: Duration) -> Result<Output, String> {
    let mut cmd = command(bin);
    cmd.args(args);
    run_process(cmd, None, CAP, timeout, "lore", MISSING)
}

// ---------------------------------------------------------------------------
// Reading what the CLI prints
// ---------------------------------------------------------------------------

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The CLI's error, as one line: `[Error] Disconnected from server` → "Disconnected from server"
/// (the `at …` trace lines dropped), tokens hidden.
pub fn error_line(text: &str) -> Option<String> {
    let text = strip_ansi(text);
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let line = lines
        .iter()
        .find_map(|l| l.strip_prefix("[Error]"))
        .or_else(|| lines.iter().copied().find(|l| l.to_ascii_lowercase().starts_with("error")))
        .or_else(|| lines.iter().copied().find(|l| !l.starts_with("at ") && !l.starts_with("[Warn]")))?;
    let line = line.trim().trim_start_matches(':').trim();
    (!line.is_empty()).then(|| crate::hosting::scrub(line))
}

/// `lore repository list` lines, `name (id)`: the names.
pub fn parse_list(text: &str) -> Vec<String> {
    strip_ansi(text)
        .lines()
        .map(str::trim)
        .filter_map(|l| {
            let name = match l.rsplit_once(" (") {
                Some((n, id)) if id.ends_with(')') && id[..id.len() - 1].bytes().all(|b| b.is_ascii_hexdigit()) => n,
                _ => l,
            };
            valid_repo_name(name).is_ok().then(|| name.to_string())
        })
        .collect()
}

/// Who `lore auth info` says the CLI is: `Username:` (else `Name:`, else `ID:`). None when it printed
/// no identity (no sign-in stored for the server).
pub fn parse_auth_info(text: &str) -> Option<String> {
    let text = strip_ansi(text);
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key).map(str::trim))
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().filter(|c| !c.is_control()).take(120).collect::<String>())
    };
    field("Username:").or_else(|| field("Name:")).or_else(|| field("ID:"))
}

/// The server's sign-in, as Settings shows it.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoreAuth {
    /// The server runs without sign-in.
    NotRequired,
    SignedIn,
    SignedOut,
    /// Not known: the server could not be asked.
    Unknown,
}

/// How a server answered.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoreReach {
    /// Both ports answer (or TCP does and there was no repository to read data from).
    Ok,
    /// The CLI is not installed: nothing was asked.
    NoCli,
    /// The name does not resolve.
    Dns,
    /// The host refuses TCP connections on the port: no server runs there.
    Refused,
    /// No answer at all: the host is off or a firewall drops the port.
    Timeout,
    /// TCP answers but the data connection (QUIC, UDP) does not: UDP is blocked.
    Udp,
    /// Something answers on the port, but not as a Lore server.
    NotLore,
    /// The server answered with an error (maintenance, refused the account, …): see `message`.
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoreServerCheck {
    /// The address checked, canonical.
    pub url: String,
    pub reach: LoreReach,
    pub auth: LoreAuth,
    /// Who the CLI is signed in as.
    pub user: Option<String>,
    /// The repositories on the server, when it listed them.
    pub repositories: Option<Vec<String>>,
    /// The UDP (data) port was proved too; false when there was no repository to read.
    pub data_checked: bool,
    /// What is wrong and what to do, in plain words (null when nothing is).
    pub message: Option<String>,
}

/// A failed `lore` run on `url` as something a person can act on: what happened and what to do. `what`
/// is the action ("create the repository", "clone …").
pub fn explain(code: Option<i32>, said: &str, server: &str, what: &str) -> String {
    let line = error_line(said).unwrap_or_default();
    let lower = said.to_ascii_lowercase();
    match code {
        Some(E_NOT_AUTHENTICATED) => format!("Could not {what}: you're not signed in to {server}. Sign in in Settings > Lore, then try again."),
        Some(E_NOT_AUTHORIZED) => format!("Could not {what}: your account on {server} isn't allowed to. Ask the server's admin for access."),
        Some(E_DISCONNECTED | E_NOT_CONNECTED | E_UNAVAILABLE) => format!(
            "Could not {what}: {server} did not answer. Check that the server is running and that its port is open (Lore uses TCP and UDP on the same port). Settings > Lore can check it."
        ),
        Some(E_MAINTENANCE) => format!("Could not {what}: {server} is down for maintenance. Try again later."),
        Some(E_NOT_FOUND | E_REPO_NOT_FOUND) if what.starts_with("clone") => {
            format!("Could not {what}: there is no such repository on {server}. Check the name (Settings > Lore lists them).")
        }
        Some(124) => format!("Could not {what}: {server} took too long and Mango stopped waiting."),
        // The server's refusal ("creating repository on server: … already exist with id …"), not a folder
        // that already holds a repository.
        _ if lower.contains("on server") && lower.contains("already exist") => format!(
            "Could not {what}: {server} already has a repository with that name. Clone it instead, or pick another name."
        ),
        _ if line.is_empty() => format!("Could not {what} (lore exited with {}).", code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into())),
        _ => format!("Could not {what}: {line}"),
    }
}

// ---------------------------------------------------------------------------
// Checking a server
// ---------------------------------------------------------------------------

/// The addresses `server` resolves to, or None when the name does not resolve (in time).
fn lookup(server: &ServerUrl) -> Option<Vec<SocketAddr>> {
    let port = server.port_or_default();
    if let Ok(ip) = server.bare_host().parse::<IpAddr>() {
        return Some(vec![SocketAddr::new(ip, port)]);
    }
    let host = server.bare_host().to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send((host.as_str(), port).to_socket_addrs().map(|a| a.collect::<Vec<_>>()));
    });
    match rx.recv_timeout(LOOKUP_TIMEOUT) {
        Ok(Ok(list)) if !list.is_empty() => Some(list),
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
enum Tcp {
    Open,
    Refused,
    Silent,
}

/// Whether anything takes TCP connections on the port (the first address that answers wins).
fn tcp_probe(addrs: &[SocketAddr]) -> Tcp {
    let mut refused = false;
    for a in addrs.iter().take(4) {
        match TcpStream::connect_timeout(a, CONNECT_TIMEOUT) {
            Ok(_) => return Tcp::Open,
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => refused = true,
            Err(_) => {}
        }
    }
    if refused {
        Tcp::Refused
    } else {
        Tcp::Silent
    }
}

fn unreachable_message(server: &ServerUrl, tcp: &Tcp) -> (LoreReach, String) {
    let host = server.bare_host();
    let port = server.port_or_default();
    match tcp {
        Tcp::Refused => (
            LoreReach::Refused,
            format!("{host} is there, but nothing answers on port {port}. The Lore server isn't running, or it uses another port."),
        ),
        Tcp::Silent => (
            LoreReach::Timeout,
            format!(
                "{host} doesn't answer on port {port}. The computer may be off or unreachable from here, or a firewall blocks the port: Lore needs TCP and UDP port {port} open."
            ),
        ),
        Tcp::Open => (
            LoreReach::NotLore,
            format!("Something answers on TCP port {port} of {host}, but not as a Lore server Mango can talk to. Check the port."),
        ),
    }
}

/// The whole check of one server: see [`LoreServerCheck`]. Never takes much longer than
/// [`PROBE_TIMEOUT`] per step, and only the steps that make sense run.
pub fn check(server: &ServerUrl) -> LoreServerCheck {
    let mut out = LoreServerCheck {
        url: server.to_string(),
        reach: LoreReach::Ok,
        auth: LoreAuth::Unknown,
        user: None,
        repositories: None,
        data_checked: false,
        message: None,
    };
    let Some(bin) = find() else {
        out.reach = LoreReach::NoCli;
        out.message = Some(MISSING.into());
        return out;
    };
    let Some(addrs) = lookup(server) else {
        out.reach = LoreReach::Dns;
        out.message = Some(format!(
            "Mango can't find a computer named {}. Check the name, or use the server's IP address.",
            server.bare_host()
        ));
        return out;
    };

    // TCP: the list.
    let listed = run(&bin, &list_argv(server), PROBE_TIMEOUT);
    match &listed {
        // The CLI itself hung (it gives up on a silent host after 5 s): ask the port directly.
        Err(_) => {
            let (reach, message) = unreachable_message(server, &tcp_probe(&addrs));
            out.reach = reach;
            out.message = Some(message);
            return out;
        }
        Ok(o) if o.ok() => out.repositories = Some(parse_list(&o.text())),
        Ok(o) => match o.code {
            Some(E_NOT_AUTHENTICATED) => {
                out.auth = LoreAuth::SignedOut;
                out.message = Some(format!("{server} wants you to sign in."));
                return out;
            }
            Some(E_DISCONNECTED | E_NOT_CONNECTED | E_UNAVAILABLE) => {
                let (reach, message) = unreachable_message(server, &tcp_probe(&addrs));
                out.reach = reach;
                out.message = Some(message);
                return out;
            }
            Some(E_MAINTENANCE) => {
                out.reach = LoreReach::Error;
                out.message = Some(format!("{server} is down for maintenance. Try again later."));
                return out;
            }
            // Not allowed to list (17) still proves the server answers; the sign-in says more.
            Some(E_NOT_AUTHORIZED) => {}
            _ => {
                out.reach = LoreReach::Error;
                out.message = Some(explain(o.code, &o.combined(), &server.to_string(), "list the repositories"));
                return out;
            }
        },
    }

    let first = out.repositories.as_ref().and_then(|l| l.first().cloned());
    std::thread::scope(|s| {
        // UDP: read one repository's data.
        let data = s.spawn(|| first.map(|name| run(&bin, &info_argv(server, &name), PROBE_TIMEOUT)));
        // The sign-in.
        let auth = s.spawn(|| -> Result<Output, String> {
            let probe = Probe::new(server)?;
            run(&bin, &auth_info_argv(&probe.path()), PROBE_TIMEOUT)
        });
        let (data, auth) = (data.join().ok().flatten(), auth.join());

        match auth {
            Ok(Ok(o)) if o.ok() => match parse_auth_info(&o.text()) {
                Some(user) => {
                    out.auth = LoreAuth::SignedIn;
                    out.user = Some(user);
                }
                None => out.auth = LoreAuth::SignedOut,
            },
            Ok(Ok(o)) if o.code == Some(E_NOT_SUPPORTED) && o.combined().to_ascii_lowercase().contains("no authentication") => {
                out.auth = LoreAuth::NotRequired
            }
            Ok(Ok(o)) if o.code == Some(E_NOT_AUTHENTICATED) => out.auth = LoreAuth::SignedOut,
            _ => {}
        }

        if let Some(result) = data {
            out.data_checked = true;
            let refused = |code: Option<i32>| matches!(code, Some(E_DISCONNECTED | E_NOT_CONNECTED));
            match result {
                Ok(o) if refused(o.code) => {
                    let port = server.port_or_default();
                    out.reach = LoreReach::Udp;
                    out.message = Some(format!(
                        "{} answers on TCP port {port}, but its data connection (QUIC on UDP port {port}) gets no answer. Open UDP port {port} too (firewall, port forward or published port), or files can't be sent.",
                        server.bare_host()
                    ));
                }
                Err(_) => {
                    out.reach = LoreReach::Udp;
                    out.message = Some(format!("{server} took too long to send data. UDP port {} may be blocked.", server.port_or_default()));
                }
                _ => {}
            }
        }
    });

    if out.reach == LoreReach::Ok && out.auth == LoreAuth::SignedOut && out.message.is_none() {
        out.message = Some(format!("{server} wants you to sign in."));
    }
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The Lore CLI on this computer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreCli {
    pub installed: bool,
    /// e.g. "0.14.0".
    pub version: Option<String>,
    pub path: Option<String>,
    /// How Mango would install it here (`setup_install` with `lore`); null when it can't.
    pub install: Option<crate::setup::InstallPlan>,
    pub help_url: String,
}

/// "lore 0.14.0+2389" → "0.14.0".
fn short_version(line: &str) -> String {
    line.split_whitespace()
        .map(|w| w.trim_start_matches('v'))
        .find(|w| w.split(['.', '+']).count() >= 2 && w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|w| w.split('+').next().unwrap_or(w).to_string())
        .unwrap_or_else(|| line.trim().to_string())
}

#[tauri::command]
pub async fn lore_cli() -> Result<LoreCli, String> {
    blocking(|| {
        let path = find();
        Ok(LoreCli {
            installed: path.is_some(),
            version: path.as_deref().and_then(crate::agents::version_of).map(|l| short_version(&l)),
            path: path.map(|p| p.to_string_lossy().into_owned()),
            install: crate::setup::install_plan("lore"),
            help_url: HELP_URL.into(),
        })
    })
    .await
}

#[tauri::command]
pub async fn lore_servers(app: AppHandle) -> Result<Vec<LoreServer>, String> {
    blocking(move || Ok(servers(&app))).await
}

/// Add a server, or change one (`server.id`). Returns the list.
#[tauri::command]
pub async fn lore_server_upsert(app: AppHandle, server: LoreServerInput) -> Result<Vec<LoreServer>, String> {
    blocking(move || upsert(&app, server)).await
}

#[tauri::command]
pub async fn lore_server_remove(app: AppHandle, id: String) -> Result<Vec<LoreServer>, String> {
    blocking(move || {
        let file = servers_file(&app)?;
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = read_servers(&file);
        list.retain(|s| s.id != id);
        write_servers(&file, &list)?;
        Ok(list)
    })
    .await
}

/// Check a server from this computer (saved or not): see [`check`].
#[tauri::command]
pub async fn lore_server_check(url: String) -> Result<LoreServerCheck, String> {
    let server = parse_server_url(&url)?;
    blocking(move || Ok(check(&server))).await
}

/// The CLI's own sign-in to `url`, in a terminal. Returns the pty id (`pty://data`, `pty://exit`).
#[tauri::command]
pub async fn lore_login(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    url: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let server = parse_server_url(&url)?;
    let bin = find().ok_or(MISSING)?;
    let argv = login_argv(&bin.to_string_lossy(), &server);
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[("NO_COLOR", "1")])
}

/// Forget the CLI's sign-in to `url`'s sign-in service.
#[tauri::command]
pub async fn lore_logout(url: String) -> Result<(), String> {
    let server = parse_server_url(&url)?;
    blocking(move || {
        let bin = find().ok_or(MISSING)?;
        let probe = Probe::new(&server)?;
        let out = run(&bin, &logout_argv(&probe.path()), PROBE_TIMEOUT)?;
        if out.ok() {
            Ok(())
        } else {
            Err(explain(out.code, &out.combined(), &server.to_string(), "sign out"))
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls() {
        let ok = [
            ("lore://lore.example.com", "lore://lore.example.com"),
            ("  LORE://Lore.Example.com/  ", "lore://lore.example.com"),
            ("lore://127.0.0.1", "lore://127.0.0.1"),
            ("lore://10.0.0.5:41337", "lore://10.0.0.5"),
            ("lore://h:1", "lore://h:1"),
            ("lore://h:65535", "lore://h:65535"),
            ("lore://[::1]", "lore://[::1]"),
            ("lore://[2001:DB8::1]:9000", "lore://[2001:db8::1]:9000"),
            ("lore://my-lore.incus", "lore://my-lore.incus"),
            ("lores://Lore.Example.com:41337", "lores://lore.example.com:41337"),
            ("lores://Lore.Example.com:443", "lores://lore.example.com"),
            ("LORES://h:9000/", "lores://h:9000"),
        ];
        for (input, want) in ok {
            assert_eq!(parse_server_url(input).map(|u| u.to_string()).as_deref(), Ok(want), "{input}");
        }
        let bad = [
            "",
            "lore.example.com",
            "https://lore.example.com",
            "lore://",
            "lore://:41337",
            "lore://h:0",
            "lore://h:65536",
            "lore://h:12a",
            "lore://h:",
            "lore://user@h",
            "lore://h/repo",
            "lore://h?x=1",
            "lore://h#x",
            "lore://h h",
            "lore://h\nx",
            "lore://-h",
            "lore://h_x",
            "lore://[::1",
            "lore://[nope]",
            "lore://[::1]x",
            "lore://h;rm",
            "lore://h$(x)",
            "lore://\"h\"",
            "loress://h",
            "lore:/h",
            "https://h",
        ];
        for input in bad {
            assert!(parse_server_url(input).is_err(), "{input:?} should be refused");
        }
        assert_eq!(parse_server_url("lore://h:9000").unwrap().port_or_default(), 9000);
        assert_eq!(parse_server_url("lore://h").unwrap().port_or_default(), DEFAULT_PORT);
        assert_eq!(parse_server_url("lores://h").unwrap().port_or_default(), 443);
        assert_eq!(parse_server_url("lores://h:41337").unwrap().port_or_default(), 41337);
    }

    #[test]
    fn repo_urls_and_names() {
        let (s, n) = parse_repo_url("lore://h:41337/game/main-art_v2.0").unwrap();
        assert_eq!((s.to_string().as_str(), n.as_str()), ("lore://h", "game/main-art_v2.0"));
        assert_eq!(s.repo(&n), "lore://h/game/main-art_v2.0");
        assert_eq!(parse_repo_url("lore://h:9/x/").unwrap().1, "x");
        for bad in ["lore://h", "lore://h/", "lore://h/../x", "lore://h/a//b", "lore://h/-x", "lore://h/a b", "lore://h/.x", "lore://h/a?b"] {
            assert!(parse_repo_url(bad).is_err(), "{bad}");
        }
        assert!(valid_repo_name("demo").is_ok());
        assert!(valid_repo_name("a/b.c").is_ok());
        for bad in ["", "-x", ".x", "/x", "x/", "a/./b", "a/../b", "a;b", "a b", "ü"] {
            assert!(valid_repo_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn argv_never_from_a_shell() {
        let s = parse_server_url("lore://h:9000").unwrap();
        assert_eq!(list_argv(&s), ["-P", "--non-interactive", "repository", "list", "lore://h:9000"]);
        assert_eq!(info_argv(&s, "demo").last().unwrap(), "lore://h:9000/demo");
        assert_eq!(create_argv(Some(&s), "x"), ["-P", "--non-interactive", "repository", "create", "lore://h:9000/x"]);
        assert_eq!(create_argv(None, "x"), ["-P", "--non-interactive", "repository", "create", "--offline", "x"]);
        assert_eq!(clone_argv("lore://h/x", "/p/x")[2..], ["clone", "--", "lore://h/x", "/p/x"]);
        assert_eq!(login_argv("/bin/lore", &s), ["/bin/lore", "login", "lore://h:9000"]);
        let secure = parse_server_url("lores://h:9000").unwrap();
        assert!(secure.secure);
        assert_eq!(info_argv(&secure, "demo").last().unwrap(), "lores://h:9000/demo");
        assert_eq!(probe_config(&secure), "remote_url = \"lores://h:9000\"
");
        let (rs, _) = parse_repo_url("lores://h/x").unwrap();
        assert_eq!(rs.to_string(), "lores://h");
        assert_eq!(auth_info_argv("/tmp/p")[2..], ["--repository", "/tmp/p", "auth", "info"]);
        assert_eq!(probe_config(&s), "remote_url = \"lore://h:9000\"\n");
    }

    #[test]
    fn reads_the_cli() {
        // lore 0.14: `repository list`.
        let list = "play-a-3609155 (01a217f5f9cc73be96ccbcb52284ca72)\ndemo (01a217f34c5976989976465380d6f0ca)\n\x1b[1mgame/art\x1b[0m (01ab)\n";
        assert_eq!(parse_list(list), ["play-a-3609155", "demo", "game/art"]);
        assert!(parse_list("").is_empty());

        // `auth info` signed in (as lore-client/src/cli/commands/auth.rs prints it), and signed out (nothing).
        let info = "ID: 3f2a\nName: Ada Lovelace\nUsername: ada\nExpires: Thu, 26 Nov 2026 13:00:00 +0000\nRefreshable\n";
        assert_eq!(parse_auth_info(info).as_deref(), Some("ada"));
        assert_eq!(parse_auth_info("ID: 3f2a\nName: Ada\n").as_deref(), Some("Ada"));
        assert_eq!(parse_auth_info(""), None);

        let err = "[Error] Operation not supported: No authentication configured on server\n  at lore-revision/src/auth/login.rs:117:10\n";
        assert_eq!(error_line(err).as_deref(), Some("Operation not supported: No authentication configured on server"));
        let warn = "[Warn] Connection to lore://h failed\n[Error] Disconnected from server\n  at x\n";
        assert_eq!(error_line(warn).as_deref(), Some("Disconnected from server"));
        assert_eq!(short_version("lore 0.14.0+2389"), "0.14.0");
        assert_eq!(short_version("lore 1.2.3"), "1.2.3");
    }

    #[test]
    fn explains_failures() {
        let s = "lore://h";
        assert!(explain(Some(16), "", s, "create the repository").contains("not signed in"));
        assert!(explain(Some(28), "[Error] Disconnected from server", s, "create the repository").contains("TCP and UDP"));
        let exists = "[Error] creating repository on server: code: 'Some entity that we attempted to create already exists', message: \"Repository x already exist with id 1 which does not match 2\"";
        assert!(explain(Some(255), exists, s, "create the repository").contains("already has a repository"));
        assert!(explain(Some(79), "[Error] Not found", s, "clone lore://h/x").contains("no such repository"));
        assert_eq!(explain(Some(3), "[Error] Boom\n  at x", s, "clone it"), "Could not clone it: Boom");
    }

    #[test]
    fn saved_servers() {
        let mut list = Vec::new();
        let a = upsert_in(&mut list, LoreServerInput { id: None, name: "  ".into(), url: "lore://A.example:41337".into(), inside_url: None, origin: None, machine: None }).unwrap();
        assert_eq!((a.name.as_str(), a.url.as_str()), ("a.example", "lore://a.example"));
        // The same address twice is refused.
        assert!(upsert_in(&mut list, LoreServerInput { id: None, name: "x".into(), url: "lore://a.example".into(), inside_url: None, origin: None, machine: None }).is_err());
        // An Incus recipe registers its server, then runs again: one entry, updated.
        let origin = LoreOrigin { host_id: "h1".into(), instance: "lore-srv".into() };
        let input = |url: &str| LoreServerInput {
            id: None,
            name: "Studio".into(),
            url: url.into(),
            inside_url: Some("lore://lore-srv.incus".into()),
            origin: Some(origin.clone()),
            machine: None,
        };
        let b = upsert_in(&mut list, input("lore://203.0.113.7:41400")).unwrap();
        let b2 = upsert_in(&mut list, input("lore://203.0.113.7:41401")).unwrap();
        assert_eq!(b.id, b2.id);
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].url, "lore://203.0.113.7:41401");
        assert_eq!(list[1].inside_url.as_deref(), Some("lore://lore-srv.incus"));
        // Edits by id.
        upsert_in(&mut list, LoreServerInput { id: Some(a.id.clone()), name: "Main".into(), url: "lore://a.example:9".into(), inside_url: None, origin: None, machine: None }).unwrap();
        assert_eq!((list[0].name.as_str(), list[0].url.as_str()), ("Main", "lore://a.example:9"));
        assert!(upsert_in(&mut list, LoreServerInput { id: Some("gone".into()), name: "".into(), url: "lore://z".into(), inside_url: None, origin: None, machine: None }).is_err());
        // Bad values never reach the file.
        assert!(upsert_in(&mut list, LoreServerInput { id: None, name: "".into(), url: "lore://z".into(), inside_url: None, origin: Some(LoreOrigin { host_id: "h;x".into(), instance: "i".into() }), machine: None }).is_err());
        assert!(upsert_in(&mut list, LoreServerInput { id: None, name: "".into(), url: "lore://z".into(), inside_url: Some("http://z".into()), origin: None, machine: None }).is_err());

        // The file round-trips, owner-only, and tolerates a broken entry.
        let dir = std::env::temp_dir().join(format!("mango-lore-test-{}", uuid::Uuid::new_v4().simple()));
        let file = dir.join(SERVERS_FILE);
        write_servers(&file, &list).unwrap();
        assert_eq!(read_servers(&file), list);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let json = r#"[{"id":"x1","name":"ok","url":"lore://ok"},{"id":"x2","name":"bad","url":"https://no"}]"#;
        fs::write(&file, json).unwrap();
        let read = read_servers(&file);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].origin, None);
        // A sign-in server saved by an older build without its port gets Lore's port back; one the
        // user added (no origin, no machine) means what it says.
        let json = r#"[{"id":"x1","name":"set up","url":"lores://lore.example.com","origin":{"hostId":"h1","instance":"lore"}},
                       {"id":"x2","name":"own","url":"lores://other.example.com"}]"#;
        fs::write(&file, json).unwrap();
        let read = read_servers(&file);
        assert_eq!(read[0].url, "lores://lore.example.com:41337");
        assert_eq!(read[1].url, "lores://other.example.com");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Against a real `lore` and server: `MANGO_LORE_URL=lore://… cargo test real_check -- --ignored --nocapture`
    /// (with a scratch HOME so no sign-in of yours is read or changed).
    #[test]
    #[ignore]
    fn real_check() {
        let url = std::env::var("MANGO_LORE_URL").unwrap_or_else(|_| "lore://127.0.0.1".into());
        for u in [url.as_str(), "lore://127.0.0.1:41999", "lore://nope.invalid", "lore://10.255.255.1"] {
            let started = std::time::Instant::now();
            let c = check(&parse_server_url(u).unwrap());
            println!("{u} ({:?}): {c:?}", started.elapsed());
        }
    }
}
