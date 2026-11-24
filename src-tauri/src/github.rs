//! Pull requests and issues linked to a chat, read through the GitHub CLI
//! (`gh`). `gh` owns the sign-in: Mango never sees a token, and a missing or
//! signed-out `gh` comes back as an error that says what to run.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::git::{blocking, run_process, At, Output};
use crate::gitlab::{self, Forge, Provider};
use crate::gitlab_items::{self, Route};

pub(crate) const TIMEOUT: Duration = Duration::from_secs(45);
/// A pull request with a long description and many images is still far below this.
pub(crate) const STDOUT_CAP: usize = 8 * 1024 * 1024;

pub(crate) const MISSING: &str = "The GitHub CLI (gh) is not installed. Install it from Settings > Git hosting \
     (or https://cli.github.com), then sign in there.";
const SIGNED_OUT: &str = "The GitHub CLI is not signed in. Sign in from Settings > Git hosting, then try again.";
const BAD_REFERENCE: &str =
    "Paste a pull request or issue link (https://github.com/owner/repo/pull/12) or its number (#12).";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhLabel {
    pub name: String,
    /// Hex without `#`, as GitHub stores it.
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAuthor {
    pub login: String,
    pub avatar_url: Option<String>,
}

/// One check on a pull request's latest commit: a GitHub Actions job (or another app's check run)
/// or a commit status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCheck {
    pub name: String,
    /// The workflow a GitHub Actions job belongs to.
    pub workflow: Option<String>,
    /// "success", "failure", "pending", "cancelled", "skipped" or "neutral".
    pub state: &'static str,
    /// Where its log or details are.
    pub url: Option<String>,
    /// A commit status's one-line description.
    pub description: Option<String>,
    /// Branch protection requires it to pass before merging.
    pub required: bool,
}

/// One pull request or issue, as the Pull requests tool window shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhItem {
    /// "github" or "gitlab" (`Provider::id`).
    pub provider: &'static str,
    /// "pr" or "issue" (a GitLab merge request is a "pr").
    pub kind: &'static str,
    pub url: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    /// "open", "draft", "merged" or "closed".
    pub state: &'static str,
    /// Issues closed as "completed", "not_planned" or "duplicate".
    pub state_reason: Option<String>,
    pub author: Option<GhAuthor>,
    pub created_at: String,
    pub updated_at: String,
    /// The description as GitHub renders it. Untrusted: the webview sanitises it before showing it.
    pub body_html: String,
    pub labels: Vec<GhLabel>,
    pub comments: u64,
    // Pull requests only.
    pub head_ref: Option<String>,
    pub base_ref: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
    /// "approved", "changes_requested" or "review_required".
    pub review_decision: Option<String>,
    /// The latest commit's checks: "success", "failure" or "pending".
    pub checks: Option<String>,
    /// Each check on the latest commit (empty for issues).
    pub check_runs: Vec<GhCheck>,
    /// The commit the pull request's branch points at; a merge only goes through while it still does.
    pub head_sha: Option<String>,
    /// "mergeable", "conflicting" or "unknown" (GitHub is still working it out).
    pub mergeable: Option<String>,
    /// GitHub's `mergeStateStatus`, lower case: "clean", "blocked", "behind", "dirty", "unstable",
    /// "has_hooks", "draft" or "unknown".
    pub merge_state: Option<String>,
    /// The merge methods the repository allows: "merge", "squash", "rebase".
    pub merge_methods: Vec<&'static str>,
    /// The method GitHub preselects for this user.
    pub default_merge_method: Option<String>,
    /// The signed-in account may merge (write access or more).
    pub can_merge: bool,
}

/// Where a pull request or issue lives.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    host: String,
    owner: String,
    repo: String,
    number: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Reference {
    Full(Target),
    /// Just a number: in the project's own repository.
    Number(u64),
}

fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn is_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with(['.', '-', ':'])
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':'))
}

/// A number GitHub's GraphQL `Int` can hold.
fn parse_number(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u64>().ok().filter(|n| *n > 0 && *n <= i32::MAX as u64)
}

/// `https://host/owner/repo/pull/12` (also `/pulls/`, `/issues/`, anything after the number),
/// `owner/repo#12`, `#12` or `12`.
fn parse_reference(input: &str) -> Result<Reference, String> {
    let s = input.trim();
    if let Some(n) = parse_number(s.strip_prefix('#').unwrap_or(s)) {
        return Ok(Reference::Number(n));
    }
    if let Some((repo, number)) = s.split_once('#') {
        if let (Some((owner, name)), Some(n)) = (repo.split_once('/'), parse_number(number)) {
            if is_name(owner) && is_name(name) {
                let target = Target { host: "github.com".into(), owner: owner.into(), repo: name.into(), number: n };
                return Ok(Reference::Full(target));
            }
        }
    }
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .ok_or(BAD_REFERENCE)?;
    let mut parts = rest.split('/');
    let (host, owner, repo, kind, tail) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next());
    let (Some(host), Some(owner), Some(repo), Some(kind), Some(tail)) = (host, owner, repo, kind, tail) else {
        return Err(BAD_REFERENCE.into());
    };
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    let number = parse_number(&digits).ok_or(BAD_REFERENCE)?;
    let host = host.to_ascii_lowercase();
    if !matches!(kind, "pull" | "pulls" | "issues") || !is_host(&host) || !is_name(owner) || !is_name(repo) {
        return Err(BAD_REFERENCE.into());
    }
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    Ok(Reference::Full(Target { host, owner: owner.into(), repo: repo.into(), number }))
}

// ---------------------------------------------------------------------------
// Running gh
// ---------------------------------------------------------------------------

fn gh_bin() -> PathBuf {
    crate::bin::find("gh").unwrap_or_else(|| PathBuf::from("gh"))
}

/// A `gh` invocation that never prompts and never prints colour or update notices.
pub(crate) fn gh(dir: Option<&Path>) -> Command {
    let bin = gh_bin();
    let mut cmd = Command::new(&bin);
    crate::bin::hide_console(&mut cmd);
    cmd.env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_SPINNER_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
    if let Some(path) = crate::bin::augmented_path(bin.parent().filter(|p| !p.as_os_str().is_empty())) {
        cmd.env("PATH", path);
    }
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    cmd
}

/// A failed `gh` call as something a person can act on.
fn gh_error(out: &Output, target: Option<&Target>) -> String {
    let detail = out.combined();
    let lower = detail.to_lowercase();
    if lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("authentication required") {
        return SIGNED_OUT.into();
    }
    if let Some(t) = target {
        if lower.contains("could not resolve to a repository") {
            return format!(
                "GitHub has no repository {}/{}, or the account gh is signed in with cannot see it.",
                t.owner, t.repo
            );
        }
    }
    if detail.is_empty() {
        return "The GitHub CLI failed without saying why.".into();
    }
    detail
}

fn run(cmd: Command, target: Option<&Target>) -> Result<Value, String> {
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "gh", MISSING)?;
    if !out.ok() {
        return Err(gh_error(&out, target));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("The GitHub CLI answered with something unexpected: {e}"))
}

/// A `gh api` call whose answer is JSON, for the other GitHub modules (releases).
pub(crate) fn run_json(cmd: Command) -> Result<Value, String> {
    run(cmd, None)
}

/// A `gh api` call that answers with nothing worth reading (a POST that starts something).
pub(crate) fn run_ok(cmd: Command) -> Result<(), String> {
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "gh", MISSING)?;
    if out.ok() { Ok(()) } else { Err(gh_error(&out, None)) }
}

pub(crate) const NO_REPO: &str = "Could not tell which GitHub repository this project belongs to; paste the full link instead.";

/// The GitHub repository the project belongs to: for a folder on this computer as `gh` picks it,
/// for a remote project from the git remotes inside its environment.
pub(crate) fn project_repo(app: &AppHandle, path: &str) -> Result<(String, String, String), String> {
    if let Some(env) = crate::vcs::env_at(app, path) {
        return env_repo(&At::Env(Box::new(env?)));
    }
    local_repo(path)
}

/// `gh repo view` in the folder: it knows `gh repo set-default` and SSH host aliases.
fn local_repo(path: &str) -> Result<(String, String, String), String> {
    let dir = PathBuf::from(path.trim());
    if path.trim().is_empty() || !dir.is_dir() {
        return Err("Open a project first, or paste the full link.".into());
    }
    let mut cmd = gh(Some(&dir));
    cmd.args(["repo", "view", "--json", "owner,name,url"]);
    let v = run(cmd, None).map_err(|e| if e == SIGNED_OUT || e == MISSING { e } else { format!("{NO_REPO} ({e})") })?;
    let owner = v["owner"]["login"].as_str().unwrap_or_default().to_string();
    let name = v["name"].as_str().unwrap_or_default().to_string();
    let host = v["url"]
        .as_str()
        .and_then(|u| u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")))
        .and_then(|u| u.split('/').next())
        .unwrap_or("github.com")
        .to_ascii_lowercase();
    if !is_name(&owner) || !is_name(&name) || !is_host(&host) {
        return Err(NO_REPO.into());
    }
    Ok((host, owner, name))
}

/// A remote project: `gh` runs on this computer (the user's own sign-in) and has no folder to
/// look in, so the repository comes from the git remotes inside the environment.
fn env_repo(at: &At) -> Result<(String, String, String), String> {
    let Some(list) = crate::git::remote_list(at)? else {
        return Err(format!("{NO_REPO} (The project folder is not a git repository.)"));
    };
    choose_remote(&parse_remotes(&list)).ok_or_else(|| {
        format!("{NO_REPO} (None of the project's git remotes points at a GitHub repository.)")
    })
}

/// `git remote -v` as (name, url) pairs, fetch URLs only.
pub(crate) fn parse_remotes(list: &str) -> Vec<(String, String)> {
    list.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let (name, url, kind) = (parts.next()?, parts.next()?, parts.next());
            (kind.is_none() || kind == Some("(fetch)")).then(|| (name.to_string(), url.to_string()))
        })
        .collect()
}

/// The (host, owner, repo) a git remote URL names: `https://host/owner/repo(.git)`,
/// `ssh://[user@]host[:port]/owner/repo`, `git://…` or scp-like `[user@]host:owner/repo`.
fn repo_from_url(url: &str) -> Option<(String, String, String)> {
    let url = url.trim();
    let (authority, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            if !matches!(scheme.to_ascii_lowercase().as_str(), "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
                return None;
            }
            rest.split_once('/')?
        }
        None => {
            // scp-like: a colon before any slash (otherwise it is a local path).
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
    let host = host.strip_prefix("www.").unwrap_or(&host);
    // GitHub's SSH over port 443.
    let host = if host == "ssh.github.com" { "github.com" } else { host };
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    // A host without a dot is an SSH alias (`Host work` in ~/.ssh/config) only the environment knows.
    if !host.contains('.') || !is_host(host) || !is_name(owner) || !is_name(repo) {
        return None;
    }
    Some((host.to_string(), owner.to_string(), repo.to_string()))
}

/// The remote whose repository the project belongs to, chosen as `gh` does: `upstream`, then
/// `github`, then `origin`, then the first. Remotes on GitHub itself come before any others.
fn choose_remote(remotes: &[(String, String)]) -> Option<(String, String, String)> {
    let parsed: Vec<(&str, (String, String, String))> =
        remotes.iter().filter_map(|(name, url)| Some((name.as_str(), repo_from_url(url)?))).collect();
    let on_github = |h: &str| h == "github.com" || h.ends_with(".ghe.com");
    let rank = |name: &str| ["upstream", "github", "origin"].iter().position(|n| *n == name).unwrap_or(3);
    parsed
        .iter()
        .enumerate()
        .min_by_key(|(i, (name, (host, _, _)))| (!on_github(host), rank(name), *i))
        .map(|(_, (_, repo))| repo.clone())
}

const QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest {
        title url number state isDraft bodyHTML createdAt updatedAt
        author { login avatarUrl }
        headRefName headRefOid baseRefName additions deletions changedFiles reviewDecision
        mergeable mergeStateStatus
        comments { totalCount }
        labels(first: 20) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
          __typename
          ... on CheckRun {
            name status conclusion detailsUrl isRequired(pullRequestNumber: $number)
            checkSuite { workflowRun { workflow { name } } }
          }
          ... on StatusContext { context state targetUrl description isRequired(pullRequestNumber: $number) }
        } } } } } }
      }
      ... on Issue {
        title url number state stateReason bodyHTML createdAt updatedAt
        author { login avatarUrl }
        comments { totalCount }
        labels(first: 20) { nodes { name color } }
      }
    }
  }
}"#;

fn fetch(target: &Target) -> Result<GhItem, String> {
    let mut cmd = gh(None);
    cmd.args(["api", "graphql"]);
    if target.host != "github.com" {
        cmd.args(["--hostname", &target.host]);
    }
    // `-f` sends the value as a plain string; `-F` would read a value starting with `@` from a file.
    cmd.arg("-f")
        .arg(format!("owner={}", target.owner))
        .arg("-f")
        .arg(format!("name={}", target.repo))
        .arg("-F")
        .arg(format!("number={}", target.number))
        .arg("-f")
        .arg(format!("query={QUERY}"));
    let v = run(cmd, Some(target))?;
    item_from_json(&v, target)
}

pub(crate) fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn lower(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_ascii_lowercase)
}

pub(crate) fn some_text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// One node of `statusCheckRollup.contexts`: a check run or a commit status.
fn check_from_json(c: &Value) -> Option<GhCheck> {
    let required = c["isRequired"].as_bool().unwrap_or(false);
    if c["__typename"].as_str() == Some("StatusContext") {
        let state = match c["state"].as_str()? {
            "SUCCESS" => "success",
            "FAILURE" | "ERROR" => "failure",
            _ => "pending",
        };
        return Some(GhCheck {
            name: c["context"].as_str()?.to_string(),
            workflow: None,
            state,
            url: some_text(&c["targetUrl"]),
            description: some_text(&c["description"]),
            required,
        });
    }
    let state = if c["status"].as_str() != Some("COMPLETED") {
        "pending"
    } else {
        match c["conclusion"].as_str().unwrap_or_default() {
            "SUCCESS" => "success",
            "CANCELLED" => "cancelled",
            "SKIPPED" => "skipped",
            "NEUTRAL" | "STALE" => "neutral",
            _ => "failure",
        }
    };
    Some(GhCheck {
        name: c["name"].as_str()?.to_string(),
        workflow: some_text(&c["checkSuite"]["workflowRun"]["workflow"]["name"]),
        state,
        url: some_text(&c["detailsUrl"]),
        description: None,
        required,
    })
}

/// GraphQL's answer as a [`GhItem`].
fn item_from_json(v: &Value, target: &Target) -> Result<GhItem, String> {
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        if v["data"]["repository"].is_null() {
            return Err(format!("GitHub: {msg}"));
        }
    }
    let node = &v["data"]["repository"]["issueOrPullRequest"];
    if node.is_null() {
        return Err(format!(
            "There is no pull request or issue #{} in {}/{}.",
            target.number, target.owner, target.repo
        ));
    }
    let is_pr = node["__typename"].as_str() == Some("PullRequest");
    let state = match (node["state"].as_str().unwrap_or_default(), is_pr && node["isDraft"].as_bool() == Some(true)) {
        ("MERGED", _) => "merged",
        ("CLOSED", _) => "closed",
        (_, true) => "draft",
        _ => "open",
    };
    let author = node["author"]["login"].as_str().map(|login| GhAuthor {
        login: login.to_string(),
        avatar_url: node["author"]["avatarUrl"].as_str().map(str::to_string),
    });
    let labels = node["labels"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|l| Some(GhLabel { name: l["name"].as_str()?.to_string(), color: text(&l["color"]) }))
                .collect()
        })
        .unwrap_or_default();
    let checks = node["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"]
        .as_str()
        .map(|s| match s {
            "SUCCESS" => "success",
            "FAILURE" | "ERROR" => "failure",
            _ => "pending",
        })
        .map(str::to_string);
    let check_runs: Vec<GhCheck> = node["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"]
        .as_array()
        .map(|nodes| nodes.iter().filter_map(check_from_json).collect())
        .unwrap_or_default();
    let repo = &v["data"]["repository"];
    let merge_methods = [("mergeCommitAllowed", "merge"), ("squashMergeAllowed", "squash"), ("rebaseMergeAllowed", "rebase")]
        .into_iter()
        .filter(|(field, _)| repo[*field].as_bool() == Some(true))
        .map(|(_, method)| method)
        .collect();
    let can_merge = matches!(repo["viewerPermission"].as_str(), Some("ADMIN" | "MAINTAIN" | "WRITE"));
    let url = node["url"].as_str().map(str::to_string).unwrap_or_else(|| {
        let kind = if is_pr { "pull" } else { "issues" };
        format!("https://{}/{}/{}/{kind}/{}", target.host, target.owner, target.repo, target.number)
    });
    Ok(GhItem {
        provider: "github",
        kind: if is_pr { "pr" } else { "issue" },
        url,
        host: target.host.clone(),
        owner: target.owner.clone(),
        repo: target.repo.clone(),
        number: node["number"].as_u64().unwrap_or(target.number),
        title: text(&node["title"]),
        state,
        state_reason: if is_pr { None } else { lower(&node["stateReason"]) },
        author,
        created_at: text(&node["createdAt"]),
        updated_at: text(&node["updatedAt"]),
        body_html: text(&node["bodyHTML"]),
        labels,
        comments: node["comments"]["totalCount"].as_u64().unwrap_or(0),
        head_ref: if is_pr { node["headRefName"].as_str().map(str::to_string) } else { None },
        base_ref: if is_pr { node["baseRefName"].as_str().map(str::to_string) } else { None },
        additions: if is_pr { node["additions"].as_u64() } else { None },
        deletions: if is_pr { node["deletions"].as_u64() } else { None },
        changed_files: if is_pr { node["changedFiles"].as_u64() } else { None },
        review_decision: if is_pr { lower(&node["reviewDecision"]) } else { None },
        checks: if is_pr { checks } else { None },
        check_runs: if is_pr { check_runs } else { Vec::new() },
        head_sha: if is_pr { some_text(&node["headRefOid"]) } else { None },
        mergeable: if is_pr { lower(&node["mergeable"]) } else { None },
        merge_state: if is_pr { lower(&node["mergeStateStatus"]) } else { None },
        merge_methods: if is_pr { merge_methods } else { Vec::new() },
        default_merge_method: if is_pr { lower(&repo["viewerDefaultMergeMethod"]) } else { None },
        can_merge: is_pr && can_merge,
    })
}

/// The pull request or issue `reference` names; a bare number is in the project's repository (`repo`).
fn target_of(reference: &str, repo: impl FnOnce() -> Result<(String, String, String), String>) -> Result<Target, String> {
    Ok(match parse_reference(reference)? {
        Reference::Full(t) => t,
        Reference::Number(number) => {
            let (host, owner, repo) = repo()?;
            Target { host, owner, repo, number }
        }
    })
}

fn item(reference: &str, repo: impl FnOnce() -> Result<(String, String, String), String>) -> Result<GhItem, String> {
    fetch(&target_of(reference, repo)?)
}

pub(crate) fn is_sha(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A refused merge as something a person can act on. `gh api` puts GitHub's JSON answer on
/// stdout and `gh: <message> (HTTP <code>)` on stderr.
fn merge_error(out: &Output, target: &Target) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let said = serde_json::from_slice::<Value>(&out.stdout).ok().and_then(|v| some_text(&v["message"]));
    if stderr.contains("(HTTP 409)") {
        return "The branch got new commits since this was read. Look at them, then merge again.".into();
    }
    if stderr.contains("(HTTP 403)") || stderr.contains("(HTTP 404)") {
        let detail = said.map(|m| format!(" GitHub says: {m}")).unwrap_or_default();
        return format!(
            "The account gh is signed in with may not merge pull requests in {}/{}.{detail}",
            target.owner, target.repo
        );
    }
    if stderr.contains("(HTTP 405)") || stderr.contains("(HTTP 422)") {
        return format!("GitHub refused the merge: {}", said.unwrap_or_else(|| "it cannot be merged right now.".into()));
    }
    gh_error(out, Some(target))
}

fn merge(reference: &str, method: &str, head_sha: &str, repo: impl FnOnce() -> Result<(String, String, String), String>) -> Result<(), String> {
    if !matches!(method, "merge" | "squash" | "rebase") {
        return Err(format!("\"{method}\" is not a merge method."));
    }
    if !is_sha(head_sha) {
        return Err("Read the pull request again before merging it.".into());
    }
    let target = target_of(reference, repo)?;
    let mut cmd = gh(None);
    cmd.args(["api", "--method", "PUT"]);
    if target.host != "github.com" {
        cmd.args(["--hostname", &target.host]);
    }
    // `sha`: GitHub refuses (409) when the branch moved since the user looked at it.
    cmd.arg(format!("repos/{}/{}/pulls/{}/merge", target.owner, target.repo, target.number))
        .arg("-f")
        .arg(format!("merge_method={method}"))
        .arg("-f")
        .arg(format!("sha={head_sha}"));
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "gh", MISSING)?;
    if !out.ok() {
        return Err(merge_error(&out, &target));
    }
    Ok(())
}

/// Merge a pull request on GitHub with `method` ("merge", "squash" or "rebase"), only while its
/// branch still points at `head_sha`. The local checkout is not touched.
#[tauri::command]
pub async fn gh_merge(
    app: AppHandle,
    path: String,
    reference: String,
    method: String,
    head_sha: String,
) -> Result<(), String> {
    blocking(move || match routed(&app, &path, &reference)? {
        (Route::GitLab(target), _) => gitlab_items::merge(&target, &method, &head_sha),
        (Route::GitHub, forge) => merge(&reference, &method, &head_sha, || repo_of(&app, &path, forge.as_ref())),
    })
    .await
}

/// A pull request or issue by link, `owner/repo#12`, or number (`#12`, in the repository of the
/// project at `path`, which may be a remote project). On GitLab also a merge request (`!12`,
/// `group/project!12`) and `group/sub/project#12`; see `gitlab_items::route`.
#[tauri::command]
pub async fn gh_item(app: AppHandle, path: String, reference: String) -> Result<GhItem, String> {
    blocking(move || match routed(&app, &path, &reference)? {
        (Route::GitLab(target), _) => gitlab_items::fetch(&target),
        (Route::GitHub, forge) => item(&reference, || repo_of(&app, &path, forge.as_ref())),
    })
    .await
}

/// The forge the project at `path` belongs to, from its git remotes; None when they name none or
/// cannot be read (the GitHub path then says why, as before).
fn forge_of(app: &AppHandle, path: &str) -> Option<Forge> {
    if path.trim().is_empty() {
        return None;
    }
    gitlab::project_forge(app, path).ok().flatten()
}

/// The GitHub repository for a project, as `project_repo` finds it; a remote project's GitHub forge
/// already read from its remotes is the same answer without another round trip.
fn repo_of(app: &AppHandle, path: &str, forge: Option<&Forge>) -> Result<(String, String, String), String> {
    if let Some(f) = forge.filter(|f| f.provider == Provider::GitHub) {
        if crate::vcs::env_at(app, path).is_some() {
            return Ok((f.host.clone(), f.owner.clone(), f.repo.clone()));
        }
    }
    project_repo(app, path)
}

/// Who answers `reference` (GitHub or a GitLab server), and the project's forge if it was read.
fn routed(app: &AppHandle, path: &str, reference: &str) -> Result<(Route, Option<Forge>), String> {
    let mut read = None;
    let route = gitlab_items::route(reference, |h| gitlab::is_gitlab_host(app, h), || {
        let f = forge_of(app, path);
        read = Some(f.clone());
        f
    })?;
    Ok((route, read.flatten()))
}

// ---------------------------------------------------------------------------
// The project's open pull requests and issues, to pick one to link
// ---------------------------------------------------------------------------

/// How many of each kind are read, most recently updated first; the picker filters them as the user types.
const OPEN_LIMIT: u32 = 30;

const OPEN_QUERY: &str = r#"query($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title url isDraft headRefName updatedAt author { login } }
    }
    issues(states: OPEN, first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title url updatedAt author { login } }
    }
  }
}"#;

/// One open pull request or issue, as the picker lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhListItem {
    /// "pr" or "issue".
    pub kind: &'static str,
    pub url: String,
    pub number: u64,
    pub title: String,
    /// "open" or "draft".
    pub state: &'static str,
    /// A pull request's branch.
    pub head_ref: Option<String>,
    pub author: Option<String>,
    pub updated_at: String,
}

/// The open pull requests and issues of the project's GitHub repository.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhOpenItems {
    pub provider: &'static str,
    pub host: String,
    pub owner: String,
    pub repo: String,
    /// Pull requests and issues together, most recently updated first.
    pub items: Vec<GhListItem>,
}

fn list_item(n: &Value, kind: &'static str) -> Option<GhListItem> {
    let number = n["number"].as_u64().filter(|n| *n > 0)?;
    let url = n["url"].as_str().filter(|u| u.starts_with("https://"))?.to_string();
    let state = if kind == "pr" && n["isDraft"].as_bool() == Some(true) { "draft" } else { "open" };
    Some(GhListItem {
        kind,
        url,
        number,
        title: text(&n["title"]),
        state,
        head_ref: some_text(&n["headRefName"]),
        author: some_text(&n["author"]["login"]),
        updated_at: text(&n["updatedAt"]),
    })
}

fn open_items_from_json(v: &Value, host: String, owner: String, repo: String) -> Result<GhOpenItems, String> {
    let node = &v["data"]["repository"];
    if node.is_null() {
        return Err(match v["errors"][0]["message"].as_str() {
            Some(msg) => format!("GitHub: {msg}"),
            None => format!("GitHub has no repository {owner}/{repo}, or the account gh is signed in with cannot see it."),
        });
    }
    let nodes = |field: &str, kind: &'static str| -> Vec<GhListItem> {
        node[field]["nodes"].as_array().map(|a| a.iter().filter_map(|n| list_item(n, kind)).collect()).unwrap_or_default()
    };
    let mut items = nodes("pullRequests", "pr");
    items.extend(nodes("issues", "issue"));
    // ISO 8601 stamps from one source sort as text.
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(GhOpenItems { provider: "github", host, owner, repo, items })
}

fn open_items((host, owner, repo): (String, String, String)) -> Result<GhOpenItems, String> {
    let target = Target { host: host.clone(), owner: owner.clone(), repo: repo.clone(), number: 0 };
    let mut cmd = gh(None);
    cmd.args(["api", "graphql"]);
    if host != "github.com" {
        cmd.args(["--hostname", &host]);
    }
    cmd.arg("-f")
        .arg(format!("owner={owner}"))
        .arg("-f")
        .arg(format!("name={repo}"))
        .arg("-F")
        .arg(format!("first={OPEN_LIMIT}"))
        .arg("-f")
        .arg(format!("query={OPEN_QUERY}"));
    let v = run(cmd, Some(&target))?;
    open_items_from_json(&v, host, owner, repo)
}

/// The open pull requests and issues of the GitHub repository of the project at `path` (which may
/// be a remote project), most recently updated first, up to 30 of each.
#[tauri::command]
pub async fn gh_open_items(app: AppHandle, path: String) -> Result<GhOpenItems, String> {
    blocking(move || match forge_of(&app, &path) {
        Some(f) if f.provider == Provider::GitLab => gitlab_items::open_items(&f),
        forge => open_items(repo_of(&app, &path, forge.as_ref())?),
    })
    .await
}

/// The repository a project's git remotes name, for the link to it on GitHub or GitLab:
/// `https://{host}/{owner}/{repo}` (on GitLab `owner` is the whole namespace).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepoLink {
    /// "github" or "gitlab".
    pub provider: &'static str,
    pub host: String,
    pub owner: String,
    pub repo: String,
}

fn repo_link(f: Forge) -> GhRepoLink {
    GhRepoLink { provider: f.provider.id(), host: f.host, owner: f.owner, repo: f.repo }
}

/// The repository of the project at `path` (which may be a remote project) on GitHub (github.com
/// or GHE.com) or a GitLab server, read from its git remotes only: no CLI, no network. None when it
/// is no git repository or none of its remotes is on either (`gitlab::choose_forge` picks).
#[tauri::command]
pub async fn gh_repo_link(app: AppHandle, path: String) -> Result<Option<GhRepoLink>, String> {
    blocking(move || Ok(gitlab::project_forge(&app, &path)?.map(repo_link))).await
}

/// The pull request a `gh pr create` printed: its link on success, or the one that already
/// exists for the branch ("a pull request for branch … already exists: <link>").
fn created_target(text: &str) -> Option<Target> {
    text.split_whitespace()
        .filter(|w| w.starts_with("https://") && w.contains("/pull/"))
        .find_map(|w| match parse_reference(w) {
            Ok(Reference::Full(t)) => Some(t),
            _ => None,
        })
}

/// `gh pr create` from the branch checked out at `path` into `base`. On this computer gh runs in
/// the folder and fills the title and body from the commits (`--fill`); for a remote project gh
/// has no folder, so git reads the commits inside the environment and gh is told the repository.
fn pr_create(app: &AppHandle, path: &str, base: &str) -> Result<GhItem, String> {
    let base = crate::git::safe_ref(base)?.to_string();
    let mut cmd = if let Some(env) = crate::vcs::env_at(app, path) {
        let at = At::Env(Box::new(env?));
        let pr = crate::git::pr_details(&at, &base, true)?;
        let (host, owner, repo) = env_repo(&at)?;
        let mut cmd = gh(None);
        let repo = if host == "github.com" { format!("{owner}/{repo}") } else { format!("{host}/{owner}/{repo}") };
        cmd.args(["pr", "create"])
            .arg(format!("--repo={repo}"))
            .arg(format!("--head={}", pr.branch))
            .arg(format!("--title={}", pr.title))
            .arg(format!("--body={}", pr.body));
        cmd
    } else {
        let dir = PathBuf::from(path.trim());
        if path.trim().is_empty() || !dir.is_dir() {
            return Err(format!("{path} is not a folder"));
        }
        let pr = crate::git::pr_details(&At::local(&dir), &base, false)?;
        let mut cmd = gh(Some(&dir));
        cmd.args(["pr", "create", "--fill"]).arg(format!("--head={}", pr.branch));
        cmd
    };
    cmd.arg(format!("--base={base}"));
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "gh", MISSING)?;
    let target = if out.ok() {
        created_target(&out.text())
    } else if out.combined().contains("already exists") {
        created_target(&out.combined())
    } else {
        return Err(gh_error(&out, None));
    };
    let target = target.ok_or_else(|| format!("The GitHub CLI did not say where the pull request is.\n{}", out.combined()))?;
    fetch(&target).map_err(|e| {
        format!("Opened https://{}/{}/{}/pull/{}, but could not read it back: {e}", target.host, target.owner, target.repo, target.number)
    })
}

/// Open a pull request from the branch checked out at `path` (pushed already) into `base`, or find
/// the one that is already open for it, and read it. `path` may be a remote project.
#[tauri::command]
pub async fn gh_pr_create(app: AppHandle, path: String, base: String) -> Result<GhItem, String> {
    blocking(move || match forge_of(&app, &path) {
        Some(f) if f.provider == Provider::GitLab => gitlab_items::mr_create(&app, &path, &base, &f),
        _ => pr_create(&app, &path, &base),
    })
    .await
}

// ---------------------------------------------------------------------------
// A GitHub Actions job and its log
// ---------------------------------------------------------------------------

/// A whole job log is rarely more than a few megabytes; past this the rest is dropped.
pub(crate) const LOG_CAP: usize = 24 * 1024 * 1024;
/// Lines kept per step: a step that printed more keeps its end, where a failure is.
pub(crate) const STEP_LINES: usize = 5_000;

/// One step of a job, with its share of the log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhJobStep {
    pub number: u64,
    pub name: String,
    /// "success", "failure", "pending" (running), "queued" (not started), "cancelled", "skipped" or "neutral".
    pub state: &'static str,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// The step's log lines, without their timestamps. Untrusted text, ANSI colour codes included.
    pub lines: Vec<String>,
    /// Earlier lines left out (see STEP_LINES).
    pub omitted: usize,
}

/// A GitHub Actions job: its steps, and once it has finished, its log split into them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhJob {
    pub provider: &'static str,
    pub id: u64,
    pub name: String,
    pub workflow: Option<String>,
    /// The job's page on GitHub.
    pub url: String,
    /// The same words as a step's state.
    pub state: &'static str,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub steps: Vec<GhJobStep>,
    /// The log was read (GitHub has it only once the job finished).
    pub log_ready: bool,
    /// Why the log could not be read, when the job finished but its log did not come.
    pub log_error: Option<String>,
    /// The log was longer than LOG_CAP and its end is missing.
    pub log_truncated: bool,
}

/// Where a job lives: `https://host/owner/repo/actions/runs/<run>/job/<job>`, the details link of
/// a GitHub Actions check.
#[derive(Debug, Clone, PartialEq, Eq)]
struct JobTarget {
    host: String,
    owner: String,
    repo: String,
    job: u64,
}

const NOT_A_JOB: &str = "That check is not a GitHub Actions job, so Mango cannot show its log. Open it on GitHub instead.";

/// A job id is a 64-bit number on GitHub, unlike pull request numbers.
fn parse_id(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 20 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u64>().ok().filter(|n| *n > 0)
}

fn parse_job_url(url: &str) -> Result<JobTarget, String> {
    let s = url.trim();
    let rest = s.strip_prefix("https://").ok_or(NOT_A_JOB)?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = rest.split('/').collect();
    let [host, owner, repo, "actions", "runs", run, "job", job, ..] = parts.as_slice() else {
        return Err(NOT_A_JOB.into());
    };
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let (Some(_), Some(job)) = (parse_id(run), parse_id(job)) else {
        return Err(NOT_A_JOB.into());
    };
    if !is_host(&host) || !is_name(owner) || !is_name(repo) {
        return Err(NOT_A_JOB.into());
    }
    Ok(JobTarget { host, owner: owner.to_string(), repo: repo.to_string(), job })
}

/// A job's or step's `status` and `conclusion` in the words the window uses.
pub(crate) fn run_state(status: Option<&str>, conclusion: Option<&str>) -> &'static str {
    match status {
        Some("completed") => match conclusion.unwrap_or_default() {
            "success" => "success",
            "cancelled" => "cancelled",
            "skipped" => "skipped",
            "neutral" | "stale" => "neutral",
            _ => "failure",
        },
        Some("in_progress") => "pending",
        _ => "queued",
    }
}

/// Seconds since the epoch of an ISO 8601 UTC timestamp (`2026-11-16T20:29:33Z`, fractions
/// allowed); only ever compared with others, so any consistent count does.
pub(crate) fn epoch_seconds(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// A log line split into its timestamp (whole seconds) and its text.
fn split_stamp(line: &str) -> (Option<i64>, &str) {
    match line.split_once(' ') {
        Some((stamp, text)) if stamp.ends_with('Z') => match epoch_seconds(stamp) {
            Some(t) => (Some(t), text),
            None => (None, line),
        },
        _ => (None, line),
    }
}

/// The first line the runner prints for a step of its own (not one inside a composite action).
fn starts_step(text: &str) -> bool {
    text.starts_with("##[group]Run ") || text == "Post job cleanup." || text == "Cleaning up orphan processes"
}

/// Hand the job's log out to its steps. The log is one stream with a timestamp on each line;
/// steps have start and end times to the second. A line belongs to the step running at its time,
/// and where several steps share a second, the line a step opens with moves the log on to it.
/// Lines the job printed before any step (none, normally) go to the first.
fn split_log(log: &str, steps: &mut [GhJobStep]) {
    let log = log.strip_prefix('\u{feff}').unwrap_or(log);
    // Steps that ran, in order; skipped and not started ones printed nothing.
    let ran: Vec<usize> = (0..steps.len())
        .filter(|&i| !matches!(steps[i].state, "skipped" | "queued") && steps[i].started_at.is_some())
        .collect();
    if ran.is_empty() {
        return;
    }
    let time = |i: usize, end: bool| {
        let s = &steps[ran[i]];
        (if end { &s.completed_at } else { &s.started_at }).as_deref().and_then(epoch_seconds)
    };
    let mut cur = 0;
    let mut nested = 0usize;
    let mut out: Vec<Vec<&str>> = vec![Vec::new(); ran.len()];
    for raw in log.lines() {
        let (t, text) = split_stamp(raw.strip_suffix('\r').unwrap_or(raw));
        // A composite action's own steps are bracketed by these; the window does not show them.
        if text.starts_with("##[start-action") {
            nested += 1;
            continue;
        }
        if text.starts_with("##[end-action") {
            nested = nested.saturating_sub(1);
            continue;
        }
        if let Some(t) = t {
            // Past the end of this step: on to the step running now.
            while cur + 1 < ran.len()
                && time(cur, true).is_some_and(|end| end < t)
                && time(cur + 1, false).is_some_and(|start| start <= t)
            {
                cur += 1;
            }
            if nested == 0
                && cur + 1 < ran.len()
                && !out[cur].is_empty()
                && starts_step(text)
                && time(cur + 1, false).is_some_and(|start| start <= t)
            {
                cur += 1;
            }
        }
        out[cur].push(text);
    }
    for (i, lines) in out.into_iter().enumerate() {
        let step = &mut steps[ran[i]];
        step.omitted = lines.len().saturating_sub(STEP_LINES);
        step.lines = lines[step.omitted..].iter().map(|l| l.to_string()).collect();
    }
}

fn job_from_json(v: &Value) -> GhJob {
    let steps = v["steps"]
        .as_array()
        .map(|steps| {
            steps
                .iter()
                .map(|s| GhJobStep {
                    number: s["number"].as_u64().unwrap_or(0),
                    name: text(&s["name"]),
                    state: run_state(s["status"].as_str(), s["conclusion"].as_str()),
                    started_at: some_text(&s["started_at"]),
                    completed_at: some_text(&s["completed_at"]),
                    lines: Vec::new(),
                    omitted: 0,
                })
                .collect()
        })
        .unwrap_or_default();
    GhJob {
        provider: "github",
        id: v["id"].as_u64().unwrap_or(0),
        name: text(&v["name"]),
        workflow: some_text(&v["workflow_name"]),
        url: text(&v["html_url"]),
        state: run_state(v["status"].as_str(), v["conclusion"].as_str()),
        started_at: some_text(&v["started_at"]),
        completed_at: some_text(&v["completed_at"]),
        steps,
        log_ready: false,
        log_error: None,
        log_truncated: false,
    }
}

fn job_api(target: &JobTarget, path: &str) -> Command {
    let mut cmd = gh(None);
    cmd.arg("api");
    if target.host != "github.com" {
        cmd.args(["--hostname", &target.host]);
    }
    cmd.arg(format!("repos/{}/{}/actions/jobs/{}{path}", target.owner, target.repo, target.job));
    cmd
}

/// The job's whole log as text. Logs carry colour codes, which `gh api` only passes on when told
/// to; a `gh` too old to know the flag passes them anyway.
fn job_log(target: &JobTarget) -> Result<(String, bool), String> {
    let mut cmd = job_api(target, "/logs");
    cmd.arg("--allow-escape-sequences");
    let mut out = run_process(cmd, None, LOG_CAP, TIMEOUT, "gh", MISSING)?;
    if !out.ok() && out.combined().contains("unknown flag") {
        out = run_process(job_api(target, "/logs"), None, LOG_CAP, TIMEOUT, "gh", MISSING)?;
    }
    if !out.ok() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("(HTTP 410)") {
            return Err("GitHub no longer keeps this log: it expired.".into());
        }
        if stderr.contains("(HTTP 404)") {
            return Err("GitHub has no log for this job.".into());
        }
        return Err(gh_error(&out, None));
    }
    Ok((String::from_utf8_lossy(&out.stdout).into_owned(), out.truncated))
}

fn job(url: &str) -> Result<GhJob, String> {
    let target = parse_job_url(url)?;
    let v = run(job_api(&target, ""), None).map_err(|e| {
        if e.contains("(HTTP 404)") || e.contains("Not Found") {
            format!(
                "GitHub has no job {} in {}/{}, or the account gh is signed in with cannot see it.",
                target.job, target.owner, target.repo
            )
        } else {
            e
        }
    })?;
    let mut job = job_from_json(&v);
    if job.url.is_empty() {
        job.url = url.trim().to_string();
    }
    if v["status"].as_str() == Some("completed") {
        match job_log(&target) {
            Ok((log, truncated)) => {
                split_log(&log, &mut job.steps);
                job.log_ready = true;
                job.log_truncated = truncated;
            }
            Err(e) => job.log_error = Some(e),
        }
    }
    Ok(job)
}

/// A GitHub Actions job by its link (a check's details link): its steps, and once it finished,
/// its log split into them. A GitLab CI job link (`…/-/jobs/<id>`) on a GitLab server Mango knows
/// comes back the same way, its log split by its sections.
#[tauri::command]
pub async fn gh_job(app: AppHandle, url: String) -> Result<GhJob, String> {
    blocking(move || {
        if gitlab_items::is_job_url(&url) {
            gitlab_items::job(&url, |h| gitlab::is_gitlab_host(&app, h))
        } else {
            job(&url)
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_open_items_newest_first() {
        let v = json!({ "data": { "repository": {
            "pullRequests": { "nodes": [
                { "number": 75, "title": "feat: a", "url": "https://github.com/acme/app/pull/75", "isDraft": false,
                  "headRefName": "feat/a", "updatedAt": "2026-11-20T10:00:00Z", "author": { "login": "ann" } },
                { "number": 76, "title": "fix: b", "url": "https://github.com/acme/app/pull/76", "isDraft": true,
                  "headRefName": "fix/b", "updatedAt": "2026-11-21T09:00:00Z", "author": null },
                { "number": 77, "title": "no link", "url": "javascript:alert(1)", "updatedAt": "2026-11-21T11:00:00Z" }
            ] },
            "issues": { "nodes": [
                { "number": 70, "title": "Crash", "url": "https://github.com/acme/app/issues/70",
                  "updatedAt": "2026-11-20T12:00:00Z", "author": { "login": "bo" } }
            ] }
        } } });
        let list = open_items_from_json(&v, "github.com".into(), "acme".into(), "app".into()).unwrap();
        let got: Vec<_> = list.items.iter().map(|i| (i.number, i.kind, i.state)).collect();
        assert_eq!(got, [(76, "pr", "draft"), (70, "issue", "open"), (75, "pr", "open")]);
        assert_eq!(list.items[2].head_ref.as_deref(), Some("feat/a"));
        assert_eq!(list.items[0].author, None);

        let missing = json!({ "data": { "repository": null }, "errors": [{ "message": "Could not resolve to a Repository" }] });
        assert!(open_items_from_json(&missing, "github.com".into(), "acme".into(), "gone".into()).unwrap_err().starts_with("GitHub: "));
    }

    #[test]
    fn finds_the_pull_request_gh_created() {
        let t = created_target("https://github.com/acme/app/pull/12\n").unwrap();
        assert_eq!((t.owner.as_str(), t.repo.as_str(), t.number), ("acme", "app", 12));
        let exists = "a pull request for branch \"feat/x\" into branch \"main\" already exists:\nhttps://github.com/acme/app/pull/7";
        assert_eq!(created_target(exists).unwrap().number, 7);
        assert!(created_target("Creating pull request for feat/x into main\n").is_none());
        assert!(created_target("https://github.com/acme/app/issues/3").is_none());
    }

    fn full(host: &str, owner: &str, repo: &str, number: u64) -> Reference {
        Reference::Full(Target { host: host.into(), owner: owner.into(), repo: repo.into(), number })
    }

    fn repo(host: &str, owner: &str, name: &str) -> Option<(String, String, String)> {
        Some((host.into(), owner.into(), name.into()))
    }

    #[test]
    fn links_remotes_on_github_and_gitlab() {
        let link_of = |list: &str| gitlab::choose_forge(list, &[]).map(repo_link);
        let link = |provider: &'static str, host: &str, owner: &str, repo: &str| GhRepoLink {
            provider,
            host: host.into(),
            owner: owner.into(),
            repo: repo.into(),
        };
        assert_eq!(
            link_of("origin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\n"),
            Some(link("github", "github.com", "acme", "app"))
        );
        assert_eq!(
            link_of("mirror\thttps://gitlab.com/acme/app.git (fetch)\nupstream\thttps://acme.ghe.com/team/app (fetch)\n"),
            Some(link("github", "acme.ghe.com", "team", "app"))
        );
        assert_eq!(
            link_of("origin\thttps://gitlab.com/acme/sub/app.git (fetch)\n"),
            Some(link("gitlab", "gitlab.com", "acme/sub", "app"))
        );
        assert_eq!(link_of("origin\thttps://bitbucket.org/acme/app.git (fetch)\n"), None);
        assert_eq!(link_of(""), None);
    }

    #[test]
    fn reads_repositories_from_remote_urls() {
        let mango = repo("github.com", "acme", "mango");
        for url in [
            "https://github.com/acme/mango.git",
            "https://github.com/acme/mango",
            "https://github.com/acme/mango/",
            "http://www.github.com/acme/mango",
            "https://user:token@github.com/acme/mango.git",
            "git@github.com:acme/mango.git",
            "git@github.com:acme/mango",
            "github.com:acme/mango.git",
            "ssh://git@github.com/acme/mango.git",
            "ssh://git@ssh.github.com:443/acme/mango.git",
            "git+ssh://git@github.com/acme/mango",
            "git://github.com/acme/mango.git",
            "  HTTPS://GitHub.com/acme/mango.git\n",
        ] {
            assert_eq!(repo_from_url(url), mango, "{url}");
        }
        assert_eq!(repo_from_url("git@git.corp.example:team/app.git"), repo("git.corp.example", "team", "app"));
        assert_eq!(repo_from_url("https://ghe.example.com:8443/team/app"), repo("ghe.example.com", "team", "app"));
        assert_eq!(repo_from_url("https://acme.ghe.com/team/app.js.git"), repo("acme.ghe.com", "team", "app.js"));
        for url in [
            "",
            "/srv/git/mango.git",
            "../mango",
            "C:\\repos\\mango",
            "C:/repos/mango",
            "file:///srv/git/acme/mango.git",
            "work:acme/mango.git", // an SSH alias only the environment knows
            "https://github.com/acme",
            "https://github.com/acme/mango/extra",
            "https://github.com/acme/../mango",
            "git@github.com:acme/mango;rm -rf.git",
            "https://-evil.com/acme/mango",
            "git@github.com:/",
        ] {
            assert_eq!(repo_from_url(url), None, "{url}");
        }
    }

    #[test]
    fn parses_git_remote_v() {
        let list = "origin\tgit@github.com:me/mango.git (fetch)\norigin\tgit@github.com:me/mango.git (push)\n\
                    upstream\thttps://github.com/acme/mango (fetch)\nupstream\tno_push (push)\n\n";
        assert_eq!(
            parse_remotes(list),
            vec![
                ("origin".to_string(), "git@github.com:me/mango.git".to_string()),
                ("upstream".to_string(), "https://github.com/acme/mango".to_string()),
            ]
        );
        assert!(parse_remotes("").is_empty());
    }

    #[test]
    fn chooses_the_remote_gh_would() {
        let r = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs.iter().map(|(n, u)| (n.to_string(), u.to_string())).collect()
        };
        let fork = "git@github.com:me/mango.git";
        let main = "https://github.com/acme/mango.git";
        assert_eq!(choose_remote(&r(&[("origin", fork), ("upstream", main)])), repo("github.com", "acme", "mango"));
        assert_eq!(choose_remote(&r(&[("origin", fork), ("github", main)])), repo("github.com", "acme", "mango"));
        assert_eq!(choose_remote(&r(&[("mine", main), ("origin", fork)])), repo("github.com", "me", "mango"));
        assert_eq!(choose_remote(&r(&[("b", fork), ("a", main)])), repo("github.com", "me", "mango"));
        assert_eq!(choose_remote(&r(&[("only", main)])), repo("github.com", "acme", "mango"));
        // GitHub itself before another host, even under a lower-ranked name.
        let gitlab = "git@gitlab.com:acme/mango.git";
        assert_eq!(choose_remote(&r(&[("origin", gitlab), ("mirror", fork)])), repo("github.com", "me", "mango"));
        // A remote that names no repository is passed over.
        assert_eq!(choose_remote(&r(&[("upstream", "/srv/git/mango.git"), ("origin", fork)])), repo("github.com", "me", "mango"));
        // Only a GitHub Enterprise server: it is used.
        let ghe = "git@git.corp.example:team/app.git";
        assert_eq!(choose_remote(&r(&[("origin", ghe)])), repo("git.corp.example", "team", "app"));
        assert_eq!(choose_remote(&r(&[("origin", "../elsewhere")])), None);
        assert_eq!(choose_remote(&[]), None);
    }

    #[test]
    fn parses_references() {
        assert_eq!(parse_reference("12"), Ok(Reference::Number(12)));
        assert_eq!(parse_reference(" #7 "), Ok(Reference::Number(7)));
        assert_eq!(parse_reference("octo/hello.world#3"), Ok(full("github.com", "octo", "hello.world", 3)));
        assert_eq!(
            parse_reference("https://github.com/ReaperMaga/mango/pull/19"),
            Ok(full("github.com", "ReaperMaga", "mango", 19))
        );
        assert_eq!(
            parse_reference("https://www.GitHub.com/a/b/pull/19/files#diff-1"),
            Ok(full("github.com", "a", "b", 19))
        );
        assert_eq!(
            parse_reference("https://github.com/a/b/issues/4#issuecomment-99"),
            Ok(full("github.com", "a", "b", 4))
        );
        assert_eq!(
            parse_reference("https://git.example.com:8443/team/app/pulls/5"),
            Ok(full("git.example.com:8443", "team", "app", 5))
        );
    }

    #[test]
    fn refuses_what_is_not_a_reference() {
        for bad in [
            "",
            "#",
            "0",
            "abc",
            "99999999999",
            "https://github.com/a/b",
            "https://github.com/a/b/tree/main",
            "https://github.com/a/b/pull/x",
            "https://github.com/../b/pull/1",
            "https://github.com/a b/c/pull/1",
            "ftp://github.com/a/b/pull/1",
            "@file#1",
            "a/@b#1",
        ] {
            assert!(parse_reference(bad).is_err(), "{bad:?} should be refused");
        }
    }

    fn target() -> Target {
        Target { host: "github.com".into(), owner: "o".into(), repo: "r".into(), number: 5 }
    }

    #[test]
    fn reads_a_pull_request() {
        let contexts = json!([
            { "__typename": "CheckRun", "name": "Frontend", "status": "COMPLETED", "conclusion": "SUCCESS",
              "detailsUrl": "https://github.com/o/r/actions/runs/1/job/2", "isRequired": true,
              "checkSuite": { "workflowRun": { "workflow": { "name": "CI" } } } },
            { "__typename": "CheckRun", "name": "Backend", "status": "COMPLETED", "conclusion": "TIMED_OUT",
              "detailsUrl": null, "isRequired": false, "checkSuite": { "workflowRun": null } },
            { "__typename": "CheckRun", "name": "Windows", "status": "IN_PROGRESS", "conclusion": null,
              "isRequired": false, "checkSuite": null },
            { "__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR",
              "targetUrl": "https://ci.example.com/9", "description": "Build errored", "isRequired": false }
        ]);
        let rollup = json!({ "state": "FAILURE", "contexts": { "nodes": contexts } });
        let v = json!({ "data": { "repository": {
            "viewerPermission": "WRITE", "mergeCommitAllowed": false, "squashMergeAllowed": true,
            "rebaseMergeAllowed": true, "viewerDefaultMergeMethod": "SQUASH",
            "issueOrPullRequest": {
            "__typename": "PullRequest", "title": "feat: x", "url": "https://github.com/o/r/pull/5", "number": 5,
            "state": "OPEN", "isDraft": true, "bodyHTML": "<p>hi</p>", "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-02T00:00:00Z", "author": { "login": "me", "avatarUrl": "https://a/x.png" },
            "headRefName": "feat/x", "headRefOid": "d013dd471daf6f6672ea035294ab4f01282f9c38", "baseRefName": "main",
            "additions": 10, "deletions": 2, "changedFiles": 3,
            "reviewDecision": "CHANGES_REQUESTED", "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY",
            "comments": { "totalCount": 4 },
            "labels": { "nodes": [{ "name": "bug", "color": "d73a4a" }] },
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": rollup } }] }
        } } } });
        let item = item_from_json(&v, &target()).unwrap();
        assert_eq!(item.kind, "pr");
        assert_eq!(item.state, "draft");
        assert_eq!(item.head_ref.as_deref(), Some("feat/x"));
        assert_eq!(item.review_decision.as_deref(), Some("changes_requested"));
        assert_eq!(item.checks.as_deref(), Some("failure"));
        assert_eq!(item.comments, 4);
        assert_eq!(item.labels[0].name, "bug");
        assert_eq!(item.author.unwrap().login, "me");

        let states: Vec<_> = item.check_runs.iter().map(|c| (c.name.as_str(), c.state)).collect();
        assert_eq!(states, [("Frontend", "success"), ("Backend", "failure"), ("Windows", "pending"), ("ci/legacy", "failure")]);
        assert_eq!(item.check_runs[0].workflow.as_deref(), Some("CI"));
        assert!(item.check_runs[0].required && !item.check_runs[1].required);
        assert_eq!(item.check_runs[3].description.as_deref(), Some("Build errored"));
        assert_eq!(item.head_sha.as_deref(), Some("d013dd471daf6f6672ea035294ab4f01282f9c38"));
        assert_eq!(item.mergeable.as_deref(), Some("conflicting"));
        assert_eq!(item.merge_state.as_deref(), Some("dirty"));
        assert_eq!(item.merge_methods, ["squash", "rebase"]);
        assert_eq!(item.default_merge_method.as_deref(), Some("squash"));
        assert!(item.can_merge);
    }

    #[test]
    fn read_access_may_not_merge() {
        let v = json!({ "data": { "repository": { "viewerPermission": "READ", "squashMergeAllowed": true,
            "issueOrPullRequest": { "__typename": "PullRequest", "state": "OPEN", "number": 5 } } } });
        let item = item_from_json(&v, &target()).unwrap();
        assert!(!item.can_merge && item.check_runs.is_empty());
    }

    #[test]
    fn refuses_bad_merge_requests_before_asking_github() {
        let sha = "d013dd471daf6f6672ea035294ab4f01282f9c38";
        assert!(merge("https://github.com/o/r/pull/5", "fast-forward", sha, || local_repo("")).unwrap_err().contains("not a merge method"));
        assert!(merge("https://github.com/o/r/pull/5", "squash", "HEAD", || local_repo("")).unwrap_err().contains("again"));
        assert!(merge("nonsense", "squash", sha, || local_repo("")).is_err());
    }

    #[test]
    fn explains_refused_merges() {
        let out = |code: &str, body: &str| Output {
            code: Some(1),
            stdout: body.as_bytes().to_vec(),
            stderr: format!("gh: something (HTTP {code})").into_bytes(),
            truncated: false,
        };
        let t = target();
        assert!(merge_error(&out("409", "{}"), &t).contains("new commits"));
        assert_eq!(
            merge_error(&out("405", r#"{"message":"Required status check \"CI\" is failing."}"#), &t),
            r#"GitHub refused the merge: Required status check "CI" is failing."#
        );
        assert!(merge_error(&out("403", "{}"), &t).contains("may not merge pull requests in o/r"));
    }

    #[test]
    fn reads_an_issue() {
        let v = json!({ "data": { "repository": { "issueOrPullRequest": {
            "__typename": "Issue", "title": "Crash", "url": "https://github.com/o/r/issues/5", "number": 5,
            "state": "CLOSED", "stateReason": "NOT_PLANNED", "bodyHTML": "", "createdAt": "", "updatedAt": "",
            "author": null, "comments": { "totalCount": 0 }, "labels": { "nodes": [] }
        } } } });
        let item = item_from_json(&v, &target()).unwrap();
        assert_eq!(item.kind, "issue");
        assert_eq!(item.state, "closed");
        assert_eq!(item.state_reason.as_deref(), Some("not_planned"));
        assert!(item.author.is_none());
        assert!(item.head_ref.is_none() && item.checks.is_none());
    }

    #[test]
    fn merged_wins_over_draft_and_missing_items_are_named() {
        let v = json!({ "data": { "repository": { "issueOrPullRequest": {
            "__typename": "PullRequest", "state": "MERGED", "isDraft": true, "number": 5
        } } } });
        assert_eq!(item_from_json(&v, &target()).unwrap().state, "merged");
        let none = json!({ "data": { "repository": { "issueOrPullRequest": null } } });
        assert!(item_from_json(&none, &target()).unwrap_err().contains("#5 in o/r"));
    }

    #[test]
    fn parses_job_links() {
        assert_eq!(
            parse_job_url("https://github.com/o/r/actions/runs/43950306942/job/133590732587?pr=4"),
            Ok(JobTarget { host: "github.com".into(), owner: "o".into(), repo: "r".into(), job: 133590732587 })
        );
        for bad in [
            "",
            "http://github.com/o/r/actions/runs/1/job/2",
            "https://github.com/o/r/actions/runs/1",
            "https://github.com/o/r/pull/1",
            "https://github.com/../r/actions/runs/1/job/2",
            "https://github.com/o/r/actions/runs/x/job/2",
            "https://github.com/o/r/actions/runs/1/job/-2",
            "https://ci.example.com/build/9",
        ] {
            assert!(parse_job_url(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn reads_iso_times() {
        let t = epoch_seconds("2026-11-16T20:29:33Z").unwrap();
        assert_eq!(epoch_seconds("2026-11-16T20:29:33.9418942Z"), Some(t));
        assert_eq!(epoch_seconds("2026-11-16T20:29:34Z"), Some(t + 1));
        assert_eq!(epoch_seconds("2026-11-17T00:00:00Z").unwrap() - epoch_seconds("2026-11-16T00:00:00Z").unwrap(), 86_400);
        assert_eq!(epoch_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_seconds("2024-03-01T00:00:00Z").unwrap() - epoch_seconds("2024-02-28T00:00:00Z").unwrap(), 2 * 86_400);
        assert_eq!(epoch_seconds("not a time"), None);
    }

    fn step(number: u64, name: &str, conclusion: &str, start: &str, end: &str) -> Value {
        json!({ "number": number, "name": name, "status": "completed", "conclusion": conclusion,
                "started_at": format!("2026-11-16T20:29:{start}Z"), "completed_at": format!("2026-11-16T20:29:{end}Z") })
    }

    #[test]
    fn splits_a_log_into_its_steps() {
        let v = json!({ "id": 2, "name": "build", "workflow_name": "CI", "status": "completed", "conclusion": "failure",
            "html_url": "https://github.com/o/r/actions/runs/1/job/2", "steps": [
                step(1, "Set up job", "success", "33", "35"),
                step(2, "Run actions/checkout@v7", "success", "35", "36"),
                step(3, "Lint", "skipped", "36", "36"),
                step(4, "Build", "success", "36", "36"),
                step(5, "Test", "failure", "36", "40"),
                step(14, "Post Run actions/checkout@v7", "success", "40", "40"),
                step(15, "Complete job", "success", "40", "40"),
        ] });
        let log = "\u{feff}2026-11-16T20:29:33.94Z Current runner version: '2.338.2'\n\
            2026-11-16T20:29:35.18Z Complete job name: build\n\
            2026-11-16T20:29:35.27Z ##[group]Run actions/checkout@v7\n\
            2026-11-16T20:29:35.28Z ##[endgroup]\n\
            2026-11-16T20:29:36.01Z ##[group]Run pnpm build\n\
            2026-11-16T20:29:36.02Z ##[start-action display=Inner;id=x]\n\
            2026-11-16T20:29:36.03Z ##[group]Run echo inner\n\
            2026-11-16T20:29:36.04Z ##[end-action id=x;outcome=success]\n\
            2026-11-16T20:29:36.05Z built\r\n\
            2026-11-16T20:29:36.50Z ##[group]Run pnpm test\n\
            2026-11-16T20:29:39.00Z \u{1b}[31mFAIL\u{1b}[0m one test\n\
            2026-11-16T20:29:39.10Z ##[error]Process completed with exit code 1.\n\
            2026-11-16T20:29:40.10Z Post job cleanup.\n\
            2026-11-16T20:29:40.20Z Cleaning up orphan processes\n";
        let mut job = job_from_json(&v);
        assert_eq!((job.state, job.workflow.as_deref()), ("failure", Some("CI")));
        split_log(log, &mut job.steps);
        let lines: Vec<Vec<&str>> = job.steps.iter().map(|s| s.lines.iter().map(String::as_str).collect()).collect();
        assert_eq!(lines[0], ["Current runner version: '2.338.2'", "Complete job name: build"]);
        assert_eq!(lines[1], ["##[group]Run actions/checkout@v7", "##[endgroup]"]);
        assert!(lines[2].is_empty(), "a skipped step printed nothing");
        assert_eq!(lines[3], ["##[group]Run pnpm build", "##[group]Run echo inner", "built"]);
        assert_eq!(lines[4], ["##[group]Run pnpm test", "\u{1b}[31mFAIL\u{1b}[0m one test", "##[error]Process completed with exit code 1."]);
        assert_eq!(lines[5], ["Post job cleanup."]);
        assert_eq!(lines[6], ["Cleaning up orphan processes"]);
    }

    #[test]
    fn a_long_step_keeps_its_end() {
        let v = json!({ "status": "completed", "conclusion": "success", "steps": [step(1, "Spam", "success", "00", "59")] });
        let mut job = job_from_json(&v);
        let log: String = (0..STEP_LINES + 7).map(|i| format!("2026-11-16T20:29:10.0Z line {i}\n")).collect();
        split_log(&log, &mut job.steps);
        assert_eq!(job.steps[0].omitted, 7);
        assert_eq!(job.steps[0].lines.len(), STEP_LINES);
        assert_eq!(job.steps[0].lines[0], "line 7");
    }

    #[test]
    fn job_states() {
        assert_eq!(run_state(Some("in_progress"), None), "pending");
        assert_eq!(run_state(Some("queued"), None), "queued");
        assert_eq!(run_state(None, None), "queued");
        assert_eq!(run_state(Some("completed"), Some("timed_out")), "failure");
        assert_eq!(run_state(Some("completed"), Some("skipped")), "skipped");
    }

    /// A real job's log, split: `MANGO_GH_JOB=<job link> cargo test real_gh_job -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_gh_job() {
        let url = std::env::var("MANGO_GH_JOB").expect("MANGO_GH_JOB names a finished job's link");
        let job = job(&url).expect("gh reads the job");
        assert!(job.log_ready, "{:?}", job.log_error);
        for s in &job.steps {
            println!("{:>3} {:<9} {:>5} lines  {}", s.number, s.state, s.lines.len(), s.name);
            if let Some(first) = s.lines.first() {
                println!("              first: {first}");
            }
        }
        assert!(job.steps.iter().filter(|s| s.state != "skipped").all(|s| !s.lines.is_empty()));
    }

    /// Against the real GitHub CLI, signed in: `cargo test real_gh -- --ignored`, run from a
    /// clone of Mango (it reads pull request #19 of the repository the folder belongs to).
    #[test]
    #[ignore]
    fn real_gh() {
        let here = env!("CARGO_MANIFEST_DIR");
        let by_number = item("#19", || local_repo(here)).expect("gh reads #19");
        assert_eq!(by_number.kind, "pr");
        assert!(!by_number.title.is_empty() && !by_number.body_html.is_empty());
        let by_url = item(&by_number.url, || local_repo("")).expect("gh reads the same pull request by its link");
        assert_eq!(by_url.number, 19);
    }
}
