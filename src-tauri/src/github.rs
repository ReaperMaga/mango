//! Pull requests and issues linked to a chat, read through the GitHub CLI
//! (`gh`). `gh` owns the sign-in: Mango never sees a token, and a missing or
//! signed-out `gh` comes back as an error that says what to run.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::git::{blocking, run_process, Output};

const TIMEOUT: Duration = Duration::from_secs(45);
/// A pull request with a long description and many images is still far below this.
const STDOUT_CAP: usize = 8 * 1024 * 1024;

const MISSING: &str = "The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, \
     then sign in with `gh auth login` in the terminal.";
const SIGNED_OUT: &str = "The GitHub CLI is not signed in. Run `gh auth login` in the terminal, then try again.";
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

/// One pull request or issue, as the Pull requests tool window shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhItem {
    /// "pr" or "issue".
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
fn gh(dir: Option<&Path>) -> Command {
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

/// The GitHub repository the project folder belongs to (its git remote, as `gh` picks it).
fn project_repo(path: &str) -> Result<(String, String, String), String> {
    let dir = PathBuf::from(path.trim());
    if path.trim().is_empty() || !dir.is_dir() {
        return Err("Open a project first, or paste the full link.".into());
    }
    let mut cmd = gh(Some(&dir));
    cmd.args(["repo", "view", "--json", "owner,name,url"]);
    let v = run(cmd, None).map_err(|e| {
        if e == SIGNED_OUT || e == MISSING {
            e
        } else {
            format!("Could not tell which GitHub repository this project belongs to; paste the full link instead. ({e})")
        }
    })?;
    let owner = v["owner"]["login"].as_str().unwrap_or_default().to_string();
    let name = v["name"].as_str().unwrap_or_default().to_string();
    let host = v["url"]
        .as_str()
        .and_then(|u| u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")))
        .and_then(|u| u.split('/').next())
        .unwrap_or("github.com")
        .to_ascii_lowercase();
    if !is_name(&owner) || !is_name(&name) || !is_host(&host) {
        return Err("Could not tell which GitHub repository this project belongs to; paste the full link instead.".into());
    }
    Ok((host, owner, name))
}

const QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest {
        title url number state isDraft bodyHTML createdAt updatedAt
        author { login avatarUrl }
        headRefName baseRefName additions deletions changedFiles reviewDecision
        comments { totalCount }
        labels(first: 20) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
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

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn lower(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_ascii_lowercase)
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
    let url = node["url"].as_str().map(str::to_string).unwrap_or_else(|| {
        let kind = if is_pr { "pull" } else { "issues" };
        format!("https://{}/{}/{}/{kind}/{}", target.host, target.owner, target.repo, target.number)
    });
    Ok(GhItem {
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
    })
}

fn item(path: &str, reference: &str) -> Result<GhItem, String> {
    let target = match parse_reference(reference)? {
        Reference::Full(t) => t,
        Reference::Number(number) => {
            let (host, owner, repo) = project_repo(path)?;
            Target { host, owner, repo, number }
        }
    };
    fetch(&target)
}

/// A pull request or issue by link, `owner/repo#12`, or number (`#12`, in the repository of the
/// project at `path`).
#[tauri::command]
pub async fn gh_item(path: String, reference: String) -> Result<GhItem, String> {
    blocking(move || item(&path, &reference)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn full(host: &str, owner: &str, repo: &str, number: u64) -> Reference {
        Reference::Full(Target { host: host.into(), owner: owner.into(), repo: repo.into(), number })
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
        let v = json!({ "data": { "repository": { "issueOrPullRequest": {
            "__typename": "PullRequest", "title": "feat: x", "url": "https://github.com/o/r/pull/5", "number": 5,
            "state": "OPEN", "isDraft": true, "bodyHTML": "<p>hi</p>", "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-02T00:00:00Z", "author": { "login": "me", "avatarUrl": "https://a/x.png" },
            "headRefName": "feat/x", "baseRefName": "main", "additions": 10, "deletions": 2, "changedFiles": 3,
            "reviewDecision": "CHANGES_REQUESTED", "comments": { "totalCount": 4 },
            "labels": { "nodes": [{ "name": "bug", "color": "d73a4a" }] },
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] }
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

    /// Against the real GitHub CLI, signed in: `cargo test real_gh -- --ignored`, run from a
    /// clone of Mango (it reads pull request #19 of the repository the folder belongs to).
    #[test]
    #[ignore]
    fn real_gh() {
        let here = env!("CARGO_MANIFEST_DIR");
        let by_number = item(here, "#19").expect("gh reads #19");
        assert_eq!(by_number.kind, "pr");
        assert!(!by_number.title.is_empty() && !by_number.body_html.is_empty());
        let by_url = item("", &by_number.url).expect("gh reads the same pull request by its link");
        assert_eq!(by_url.number, 19);
    }
}
