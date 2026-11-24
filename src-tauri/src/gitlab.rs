//! GitLab: which projects live on a GitLab server (gitlab.com or the user's own), and running the
//! GitLab CLI (`glab`). Like `gh`, `glab` owns the sign-in: Mango never sees a token, and a missing
//! or signed-out `glab` comes back as an error that says what to run.
//!
//! Self-managed servers are recognised by name: a host whose first label is `gitlab`
//! (`gitlab.example.com`), or one the user listed in Settings (`gitlab-hosts.json`, no secrets).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::git::{blocking, run_process, At, Output};
use crate::github::{STDOUT_CAP, TIMEOUT};

pub(crate) const GITLAB_COM: &str = "gitlab.com";
const HOSTS_FILE: &str = "gitlab-hosts.json";
/// At most this many self-managed servers in the list.
const MAX_HOSTS: usize = 50;

pub(crate) const MISSING: &str = "The GitLab CLI (glab) is not installed. Install it from Settings > Git hosting \
     (or https://gitlab.com/gitlab-org/cli), then sign in there.";
pub(crate) const SIGNED_OUT: &str =
    "The GitLab CLI is not signed in to this server. Sign in from Settings > Git hosting, then try again.";
pub(crate) const NO_PROJECT: &str =
    "Could not tell which GitLab project this project belongs to; paste the full link instead.";

/// Which forge a repository lives on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    GitHub,
    GitLab,
}

impl Provider {
    /// As the frontend names it (`provider` in `app/types/ipc.ts`).
    pub(crate) fn id(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
        }
    }
}

/// A repository on a forge. For GitLab `owner` is the whole namespace (`group/subgroup`) and
/// `repo` the project's own path, so `https://{host}/{owner}/{repo}` is its page on both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Forge {
    pub provider: Provider,
    pub host: String,
    pub owner: String,
    pub repo: String,
}

impl Forge {
    /// `group/subgroup/project`.
    pub(crate) fn full_path(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// The project in a REST path: `projects/group%2Fsubgroup%2Fproject`.
    pub(crate) fn api_project(&self) -> String {
        format!("projects/{}", encode_path(&self.full_path()))
    }
}

/// A full project path for a REST URL segment: every `/` (and anything else outside the name
/// characters, which `is_segment` already keeps out) percent-encoded.
pub(crate) fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// One segment of a GitLab path (a group or project): letters, digits, `-`, `_`, `.`; no leading
/// `-` or `.`, and none of GitLab's reserved `.git` / `.atom` endings.
pub(crate) fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with(['-', '.'])
        && !s.ends_with(".git")
        && !s.ends_with(".atom")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A namespace: one to twenty segments joined by `/` (GitLab nests groups up to 20 deep).
pub(crate) fn is_namespace(s: &str) -> bool {
    let parts: Vec<&str> = s.split('/').collect();
    !parts.is_empty() && parts.len() <= 20 && parts.iter().all(|p| is_segment(p))
}

/// A host name, optionally with a port: what a person types for a self-managed server.
pub(crate) fn is_host(s: &str) -> bool {
    let (name, port) = match s.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (s, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) || p.parse::<u32>().map_or(true, |n| n == 0 || n > 65535) {
            return false;
        }
    }
    !name.is_empty()
        && name.len() <= 253
        && name.contains('.')
        && name.split('.').all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

/// A host the user typed, as stored and compared: trimmed, lower case, without a scheme, a path
/// or `www.`. None when it is no host name.
pub(crate) fn normalize_host(input: &str) -> Option<String> {
    let s = input.trim().to_ascii_lowercase();
    let s = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(&s);
    let s = s.split('/').next().unwrap_or("");
    let s = s.strip_prefix("www.").unwrap_or(s);
    is_host(s).then(|| s.to_string())
}

// ---------------------------------------------------------------------------
// Which hosts are GitLab
// ---------------------------------------------------------------------------

fn hosts_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(HOSTS_FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

/// The self-managed GitLab servers the user listed (gitlab.com is never in it: it is always known).
pub(crate) fn custom_hosts(app: &AppHandle) -> Vec<String> {
    let Ok(file) = hosts_file(app) else { return Vec::new() };
    let Ok(text) = fs::read_to_string(file) else { return Vec::new() };
    let list: Vec<String> = serde_json::from_str(&text).unwrap_or_default();
    clean_hosts(list.iter().map(String::as_str))
}

/// Valid, normalised, without duplicates or gitlab.com, at most `MAX_HOSTS`.
fn clean_hosts<'a>(list: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in list {
        if let Some(h) = normalize_host(h) {
            if h != GITLAB_COM && !out.contains(&h) && out.len() < MAX_HOSTS {
                out.push(h);
            }
        }
    }
    out
}

fn save_hosts(app: &AppHandle, list: &[String]) -> Result<(), String> {
    let file = hosts_file(app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json)
        .and_then(|_| fs::rename(&tmp, &file))
        .map_err(|e| format!("Could not save {}: {e}", file.display()))
}

/// Add one server to the list (signing in to it from Mango does); a no-op for known ones.
pub(crate) fn remember_host(app: &AppHandle, host: &str) -> Result<(), String> {
    let Some(host) = normalize_host(host) else { return Err(format!("\"{host}\" is not a server name.")) };
    if host == GITLAB_COM {
        return Ok(());
    }
    let mut list = custom_hosts(app);
    if list.contains(&host) {
        return Ok(());
    }
    list.push(host);
    save_hosts(app, &clean_hosts(list.iter().map(String::as_str)))
}

/// Whether `host` (lower case, no port) is a GitLab server: gitlab.com, a `gitlab.*` name, or one
/// in `custom` (which may carry ports: a match on the name alone counts).
pub(crate) fn is_gitlab_host_in(host: &str, custom: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    let bare = host.split(':').next().unwrap_or(&host);
    bare == GITLAB_COM
        || bare.ends_with(".gitlab.com")
        || (bare.starts_with("gitlab.") && bare.matches('.').count() >= 2)
        || custom.iter().any(|c| c == &host || c.split(':').next() == Some(bare))
}

pub(crate) fn is_gitlab_host(app: &AppHandle, host: &str) -> bool {
    is_gitlab_host_in(host, &custom_hosts(app))
}

fn is_github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".ghe.com")
}

// ---------------------------------------------------------------------------
// The project's forge, from its git remotes
// ---------------------------------------------------------------------------

/// The (host, path) a git remote URL names: `https://host/a/b/c(.git)`, `ssh://[user@]host[:port]/a/b`,
/// `git://…` or scp-like `[user@]host:a/b`. The host is lower case without port or `www.`; the path
/// has no leading or trailing `/` and no `.git`. None for local paths and other schemes.
pub(crate) fn split_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let (authority, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            if !matches!(scheme.to_ascii_lowercase().as_str(), "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
                return None;
            }
            rest.split_once('/')?
        }
        None => {
            let (authority, path) = url.split_once(':')?;
            if authority.contains('/') || authority.contains('\\') {
                return None;
            }
            (authority, path)
        }
    };
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if url.contains("://") { host.split(':').next()? } else { host };
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).to_string();
    // A host without a dot is an SSH alias (`Host work` in ~/.ssh/config) only that computer knows.
    if !host.contains('.') || path.is_empty() {
        return None;
    }
    Some((host, path))
}

/// The GitLab project a remote URL names, when its host is a GitLab server.
pub(crate) fn gitlab_project_from_url(url: &str, custom: &[String]) -> Option<Forge> {
    let (host, path) = split_remote(url)?;
    if !is_gitlab_host_in(&host, custom) {
        return None;
    }
    // `altssh.gitlab.com` is gitlab.com's SSH over port 443.
    let host = if host == "altssh.gitlab.com" { GITLAB_COM.to_string() } else { host };
    let (owner, repo) = path.rsplit_once('/')?;
    (is_namespace(owner) && is_segment(repo)).then(|| Forge {
        provider: Provider::GitLab,
        host,
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// The remote's forge: GitHub (github.com, GHE.com) or a GitLab server. Other hosts: None.
fn forge_of(url: &str, custom: &[String]) -> Option<Forge> {
    if let Some(f) = gitlab_project_from_url(url, custom) {
        return Some(f);
    }
    let (host, path) = split_remote(url)?;
    let host = if host == "ssh.github.com" { "github.com".to_string() } else { host };
    if !is_github_host(&host) {
        return None;
    }
    let (owner, repo) = path.split_once('/')?;
    (is_segment(owner) && is_segment(repo) && !repo.contains('/')).then(|| Forge {
        provider: Provider::GitHub,
        host,
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// The forge the project belongs to, from `git remote -v`: among remotes on GitHub or a GitLab
/// server, `upstream`, then `github` / `gitlab`, then `origin`, then the first; GitHub first on a tie.
pub(crate) fn choose_forge(remote_list: &str, custom: &[String]) -> Option<Forge> {
    let remotes = crate::github::parse_remotes(remote_list);
    let rank = |name: &str| match name {
        "upstream" => 0,
        "github" | "gitlab" => 1,
        "origin" => 2,
        _ => 3,
    };
    remotes
        .iter()
        .enumerate()
        .filter_map(|(i, (name, url))| Some((rank(name), i, forge_of(url, custom)?)))
        .min_by_key(|(rank, i, f)| (*rank, f.provider != Provider::GitHub, *i))
        .map(|(_, _, f)| f)
}

fn project_at(app: &AppHandle, path: &str) -> Result<At, String> {
    Ok(match crate::vcs::env_at(app, path) {
        Some(env) => At::Env(Box::new(env?)),
        None => At::local(path.trim()),
    })
}

/// The forge the project at `path` (which may be a remote project) belongs to, read from its git
/// remotes only: no CLI, no network. None when it is no git repository or no remote is on a known forge.
pub(crate) fn project_forge(app: &AppHandle, path: &str) -> Result<Option<Forge>, String> {
    let at = project_at(app, path)?;
    let custom = custom_hosts(app);
    Ok(crate::git::remote_list(&at)?.as_deref().and_then(|l| choose_forge(l, &custom)))
}

// ---------------------------------------------------------------------------
// Running glab
// ---------------------------------------------------------------------------

fn glab_bin() -> PathBuf {
    crate::bin::find("glab").unwrap_or_else(|| PathBuf::from("glab"))
}

/// A `glab` invocation that never prompts and never prints colour, update notices or telemetry.
pub(crate) fn glab(dir: Option<&Path>) -> Command {
    let bin = glab_bin();
    let mut cmd = Command::new(&bin);
    crate::bin::hide_console(&mut cmd);
    cmd.env("NO_PROMPT", "1")
        .env("GLAB_NO_PROMPT", "1")
        .env("GLAB_CHECK_UPDATE", "false")
        .env("GLAB_SEND_TELEMETRY", "false")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("FORCE_HYPERLINKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(path) = crate::bin::augmented_path(bin.parent().filter(|p| !p.as_os_str().is_empty())) {
        cmd.env("PATH", path);
    }
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    cmd
}

/// `glab api --hostname {host} {endpoint}`: the start of every API call (the caller adds fields).
pub(crate) fn api(host: &str, endpoint: &str) -> Command {
    let mut cmd = glab(None);
    cmd.args(["api", "--hostname", host, endpoint]);
    cmd
}

/// A failed `glab` call as something a person can act on.
pub(crate) fn glab_error(out: &Output, host: Option<&str>) -> String {
    let detail = out.combined();
    let lower = detail.to_lowercase();
    if lower.contains("glab auth login")
        || lower.contains("401 unauthorized")
        || lower.contains("not logged in")
        || lower.contains("no token")
        || lower.contains("has not been authenticated")
    {
        return match host {
            Some(h) if h != GITLAB_COM => format!("The GitLab CLI is not signed in to {h}. Sign in from Settings > Git hosting, then try again."),
            _ => SIGNED_OUT.into(),
        };
    }
    if lower.contains("404 not found") || lower.contains("404 project not found") {
        return "GitLab has no such project or item, or the account glab is signed in with cannot see it.".into();
    }
    if detail.is_empty() {
        return "The GitLab CLI failed without saying why.".into();
    }
    detail
}

/// Run `glab` and read its JSON answer.
pub(crate) fn run_json(cmd: Command, host: Option<&str>) -> Result<Value, String> {
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "glab", MISSING)?;
    if !out.ok() {
        return Err(glab_error(&out, host));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("The GitLab CLI answered with something unexpected: {e}"))
}

/// Run `glab` for its effect only.
pub(crate) fn run_ok(cmd: Command, host: Option<&str>) -> Result<(), String> {
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "glab", MISSING)?;
    if out.ok() { Ok(()) } else { Err(glab_error(&out, host)) }
}

/// Run `glab` and keep its whole output (a job log), up to `cap` bytes.
pub(crate) fn run_raw(cmd: Command, host: Option<&str>, cap: usize) -> Result<Output, String> {
    let out = run_process(cmd, None, cap, TIMEOUT, "glab", MISSING)?;
    if out.ok() { Ok(out) } else { Err(glab_error(&out, host)) }
}

/// A link GitLab returned that may be relative (avatars on self-managed servers): made absolute
/// on `host`, and only ever http(s).
pub(crate) fn absolute_url(host: &str, url: &str) -> Option<String> {
    let url = url.trim();
    if url.starts_with("https://") || url.starts_with("http://") {
        return Some(url.to_string());
    }
    url.starts_with('/').then(|| format!("https://{host}{url}"))
}

// ---------------------------------------------------------------------------
// Commands: the list of self-managed servers
// ---------------------------------------------------------------------------

/// The self-managed GitLab servers the user listed (Settings > Git hosting).
#[tauri::command]
pub async fn gitlab_hosts(app: AppHandle) -> Result<Vec<String>, String> {
    blocking(move || Ok(custom_hosts(&app))).await
}

/// Replace the list; every entry must be a server name. Returns it as stored.
#[tauri::command]
pub async fn gitlab_hosts_save(app: AppHandle, hosts: Vec<String>) -> Result<Vec<String>, String> {
    blocking(move || {
        if hosts.len() > MAX_HOSTS {
            return Err(format!("Mango keeps at most {MAX_HOSTS} GitLab servers."));
        }
        for h in &hosts {
            if normalize_host(h).is_none() {
                return Err(format!("\"{h}\" is not a server name. Type it like gitlab.example.com."));
            }
        }
        let list = clean_hosts(hosts.iter().map(String::as_str));
        save_hosts(&app, &list)?;
        Ok(list)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert!(is_gitlab_host_in("gitlab.com", &[]));
        assert!(is_gitlab_host_in("gitlab.example.com", &[]));
        assert!(!is_gitlab_host_in("gitlab.io", &[]), "a bare gitlab.<tld> is no self-managed server name");
        assert!(!is_gitlab_host_in("git.example.com", &[]));
        assert!(is_gitlab_host_in("git.example.com", &["git.example.com".into()]));
        assert!(is_gitlab_host_in("git.example.com", &["git.example.com:8443".into()]));
        assert!(!is_gitlab_host_in("github.com", &[]));
    }

    #[test]
    fn normalizes_typed_hosts() {
        assert_eq!(normalize_host(" https://GitLab.Example.com/foo "), Some("gitlab.example.com".into()));
        assert_eq!(normalize_host("git.corp.io:8443"), Some("git.corp.io:8443".into()));
        assert_eq!(normalize_host("localhost"), None);
        assert_eq!(normalize_host("evil.com:99999"), None);
        assert_eq!(normalize_host("-x.com"), None);
        assert_eq!(normalize_host("a b.com"), None);
        assert_eq!(clean_hosts(["gitlab.com", "a.io", "A.io", "bad"]), vec!["a.io".to_string()]);
    }

    #[test]
    fn projects_from_remotes() {
        let f = gitlab_project_from_url("git@gitlab.com:group/sub/proj.git", &[]).unwrap();
        assert_eq!((f.host.as_str(), f.owner.as_str(), f.repo.as_str()), ("gitlab.com", "group/sub", "proj"));
        assert_eq!(f.api_project(), "projects/group%2Fsub%2Fproj");
        let f = gitlab_project_from_url("ssh://git@git.corp.io:2222/team/app.git", &["git.corp.io".into()]).unwrap();
        assert_eq!((f.host.as_str(), f.full_path().as_str()), ("git.corp.io", "team/app"));
        let f = gitlab_project_from_url("https://oauth2@gitlab.example.com/a/b/", &[]).unwrap();
        assert_eq!(f.full_path(), "a/b");
        assert!(gitlab_project_from_url("https://git.corp.io/team/app", &[]).is_none(), "unknown server");
        assert!(gitlab_project_from_url("git@gitlab.com:proj.git", &[]).is_none(), "no namespace");
        assert!(gitlab_project_from_url("git@gitlab.com:g/-x", &[]).is_none());
        assert!(gitlab_project_from_url("/home/me/repo", &[]).is_none());
    }

    #[test]
    fn chooses_a_forge() {
        let gl = "origin\tgit@gitlab.com:g/p.git (fetch)\norigin\tgit@gitlab.com:g/p.git (push)\n";
        let f = choose_forge(gl, &[]).unwrap();
        assert_eq!(f.provider, Provider::GitLab);
        let both = "origin\tgit@gitlab.com:g/p.git (fetch)\nmirror\thttps://github.com/o/r (fetch)\n";
        assert_eq!(choose_forge(both, &[]).unwrap().provider, Provider::GitLab, "origin outranks a mirror");
        let tie = "a\tgit@gitlab.com:g/p.git (fetch)\nb\thttps://github.com/o/r (fetch)\n";
        assert_eq!(choose_forge(tie, &[]).unwrap().provider, Provider::GitHub, "GitHub first on a tie");
        assert!(choose_forge("origin\thttps://bitbucket.org/o/r (fetch)\n", &[]).is_none());
        let gh = choose_forge("origin\tgit@github.com:o/r.git (fetch)\n", &[]).unwrap();
        assert_eq!((gh.provider, gh.owner.as_str(), gh.repo.as_str()), (Provider::GitHub, "o", "r"));
    }

    #[test]
    fn absolute_links() {
        assert_eq!(absolute_url("git.corp.io", "/uploads/a.png").as_deref(), Some("https://git.corp.io/uploads/a.png"));
        assert_eq!(absolute_url("x", "https://a/b").as_deref(), Some("https://a/b"));
        assert_eq!(absolute_url("x", "javascript:alert(1)"), None);
    }
}
