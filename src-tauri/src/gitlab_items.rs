//! GitLab merge requests, issues and CI job logs, read through the GitLab CLI (`glab`), as the
//! same `GhItem` / `GhOpenItems` / `GhJob` shapes the GitHub side gives the Pull requests tool
//! window. A merge request is a `kind: "pr"`; `number` is its iid; `owner` is the whole namespace.
//!
//! `glab` only ever talks to servers Mango knows as GitLab (`gitlab::is_gitlab_host`): a link to any
//! other host is refused before it reaches the CLI, so a token never goes to a server the user did not
//! name. Every part of a reference is validated first, and values reach `glab` as `-f` raw fields
//! (never `-F`, which reads `@file`).

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

use crate::git::{run_process, At, Output};
use crate::github::{
    is_sha, some_text, text, GhAuthor, GhCheck, GhItem, GhJob, GhJobStep, GhLabel, GhListItem, GhOpenItems, LOG_CAP,
    STDOUT_CAP, STEP_LINES, TIMEOUT,
};
use crate::gitlab::{self, absolute_url, is_namespace, is_segment, Forge, Provider};

const BAD_REFERENCE: &str = "Paste a merge request or issue link (https://gitlab.com/group/project/-/merge_requests/12), \
     or its reference (!12 for a merge request, #12 for an issue).";
const NOT_A_JOB: &str = "That check is not a GitLab CI job, so Mango cannot show its log. Open it on GitLab instead.";

fn unknown_server(host: &str) -> String {
    format!(
        "{host} is not one of the GitLab servers Mango knows. Add it in Settings > Git hosting (signing in to it there \
         does), then try again."
    )
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/// What a reference asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    MergeRequest,
    Issue,
    /// A bare number: a merge request if there is one, else the issue.
    Either,
}

/// A merge request or issue on a GitLab server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub forge: Forge,
    pub iid: u64,
    pub kind: Kind,
}

/// Where a reference sends `gh_item` / `gh_merge`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    /// The GitHub code path, unchanged.
    GitHub,
    GitLab(Target),
}

/// An iid GitLab's GraphQL and REST APIs take (they are `Int` / 32-bit).
fn parse_iid(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u64>().ok().filter(|n| *n > 0 && *n <= i32::MAX as u64)
}

fn forge(host: &str, namespace: &str, project: &str) -> Forge {
    Forge { provider: Provider::GitLab, host: host.into(), owner: namespace.into(), repo: project.into() }
}

/// `group/sub/project` split into a valid namespace and project.
fn split_project(path: &str) -> Option<(&str, &str)> {
    let (ns, proj) = path.rsplit_once('/')?;
    (is_namespace(ns) && is_segment(proj)).then_some((ns, proj))
}

/// A link to a merge request, issue or work item: `https://host/group/sub/proj/-/merge_requests/12`
/// (anything after the number), `/-/issues/12`, `/-/work_items/12`. The host is returned as given
/// (lower case, without `www.`): the caller decides whether it is a GitLab server.
fn parse_url(input: &str) -> Option<(String, String, String, u64, Kind)> {
    let s = input.trim();
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = rest.split('/').collect();
    let dash = parts.iter().position(|p| *p == "-")?;
    let host = parts[0].to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if dash < 3 || !gitlab::is_host(&host) {
        return None;
    }
    let (ns, proj) = split_project(&parts[1..dash].join("/")).map(|(n, p)| (n.to_string(), p.to_string()))?;
    let kind = match parts.get(dash + 1).copied()? {
        "merge_requests" => Kind::MergeRequest,
        "issues" | "work_items" => Kind::Issue,
        _ => return None,
    };
    let iid = parse_iid(parts.get(dash + 2).copied()?)?;
    Some((host, ns, proj, iid, kind))
}

/// Whether a link is shaped like a GitLab merge request, issue or work item.
fn gitlab_shaped(s: &str) -> bool {
    ["/-/merge_requests/", "/-/issues/", "/-/work_items/"].iter().any(|p| s.contains(p))
}

/// Decide who answers `reference` and, for GitLab, exactly what it names. `is_gitlab` says whether a
/// host is a GitLab server Mango knows; `project` is the project's forge, read only when needed.
///
/// - A link on a GitLab server, or shaped like one (`/-/merge_requests/12`, `/-/issues/12`,
///   `/-/work_items/12`): GitLab, and refused when its host is not a known GitLab server.
/// - `group/sub/proj!12` (merge request), `group/sub/proj#12` with a subgroup (issue), `!12`: GitLab.
/// - `owner/repo#12`, `#12` and `12`: GitLab when the project is on GitLab, else GitHub.
pub(crate) fn route(
    reference: &str,
    is_gitlab: impl Fn(&str) -> bool,
    project: impl FnOnce() -> Option<Forge>,
) -> Result<Route, String> {
    let s = reference.trim();
    if s.starts_with("https://") || s.starts_with("http://") {
        let host = s.split("://").nth(1).and_then(|r| r.split(['/', '?', '#']).next()).unwrap_or_default();
        let host = host.to_ascii_lowercase();
        let host = host.strip_prefix("www.").unwrap_or(&host);
        if !gitlab_shaped(s) && !is_gitlab(host) {
            return Ok(Route::GitHub);
        }
        let (host, ns, proj, iid, kind) = parse_url(s).ok_or(BAD_REFERENCE)?;
        if !is_gitlab(&host) {
            return Err(unknown_server(&host));
        }
        return Ok(Route::GitLab(Target { forge: forge(&host, &ns, &proj), iid, kind }));
    }
    let gitlab_project = || project().filter(|f| f.provider == Provider::GitLab);
    // `!12` or `path!12`: only GitLab writes merge requests this way.
    if let Some((path, number)) = s.split_once('!') {
        let iid = parse_iid(number).ok_or(BAD_REFERENCE)?;
        if path.is_empty() {
            let f = gitlab_project().ok_or_else(|| gitlab::NO_PROJECT.to_string())?;
            return Ok(Route::GitLab(Target { forge: f, iid, kind: Kind::MergeRequest }));
        }
        let (ns, proj) = split_project(path).ok_or(BAD_REFERENCE)?;
        let host = gitlab_project().map_or_else(|| gitlab::GITLAB_COM.to_string(), |f| f.host);
        return Ok(Route::GitLab(Target { forge: forge(&host, ns, proj), iid, kind: Kind::MergeRequest }));
    }
    if let Some((path, number)) = s.split_once('#') {
        // `group/sub/proj#12`: GitHub has no subgroups, so this is GitLab's.
        if path.matches('/').count() >= 2 {
            let (Some((ns, proj)), Some(iid)) = (split_project(path), parse_iid(number)) else {
                return Err(BAD_REFERENCE.into());
            };
            let host = gitlab_project().map_or_else(|| gitlab::GITLAB_COM.to_string(), |f| f.host);
            return Ok(Route::GitLab(Target { forge: forge(&host, ns, proj), iid, kind: Kind::Issue }));
        }
    }
    // `owner/repo#12`, `#12`, `12`: the project's forge decides.
    let Some(f) = gitlab_project() else { return Ok(Route::GitHub) };
    if let Some(iid) = parse_iid(s) {
        return Ok(Route::GitLab(Target { forge: f, iid, kind: Kind::Either }));
    }
    match s.split_once('#') {
        Some(("", number)) => {
            let iid = parse_iid(number).ok_or(BAD_REFERENCE)?;
            Ok(Route::GitLab(Target { forge: f, iid, kind: Kind::Issue }))
        }
        Some((path, number)) => {
            let (Some((ns, proj)), Some(iid)) = (split_project(path), parse_iid(number)) else {
                return Err(BAD_REFERENCE.into());
            };
            Ok(Route::GitLab(Target { forge: forge(&f.host, ns, proj), iid, kind: Kind::Issue }))
        }
        None => Err(BAD_REFERENCE.into()),
    }
}

// ---------------------------------------------------------------------------
// Reading one merge request or issue (GraphQL)
// ---------------------------------------------------------------------------

const MR_FIELDS: &str = "mergeRequest(iid: $iid) {
      iid title webUrl state draft descriptionHtml createdAt updatedAt
      author { username avatarUrl }
      labels(first: 20) { nodes { title color } }
      userNotesCount sourceBranch targetBranch diffHeadSha squashOnMerge squashReadOnly conflicts
      diffStatsSummary { additions deletions fileCount }
      detailedMergeStatus
      userPermissions { canMerge }
      approved approvedBy { nodes { username } }
      headPipeline { status jobs(first: 100) { nodes { id name status webPath allowFailure stage { name } } } }
      EXTRA
    }";

/// Fields only the Enterprise Edition's schema has (approval rules: gitlab.com and EE servers);
/// asked for first, dropped on a server whose schema lacks them.
const MR_EE_FIELDS: &str = "approvalsLeft approvalsRequired";

const ISSUE_FIELDS: &str = "issue(iid: $iid) {
      iid title webUrl state descriptionHtml createdAt updatedAt
      author { username avatarUrl }
      labels(first: 20) { nodes { title color } }
      userNotesCount
      EXTRA
    }";

/// Newer than the rest (GitLab 15.x): dropped with the EE fields on a server that lacks it.
const ISSUE_EXTRA_FIELDS: &str = "closedAsDuplicateOf { iid }";

/// The query for `kind`; `full` asks for the fields an older or free server may not have too.
fn query(kind: Kind, full: bool) -> String {
    let mr = || MR_FIELDS.replace("EXTRA", if full { MR_EE_FIELDS } else { "" });
    let issue = || ISSUE_FIELDS.replace("EXTRA", if full { ISSUE_EXTRA_FIELDS } else { "" });
    let body = match kind {
        Kind::MergeRequest => mr(),
        Kind::Issue => issue(),
        Kind::Either => format!("{}\n    {}", mr(), issue()),
    };
    format!("query($fullPath: ID!, $iid: String!) {{\n  project(fullPath: $fullPath) {{\n    {body}\n  }}\n}}")
}

/// A GraphQL error that means the server's schema lacks a field we asked for (an older or
/// free-tier server): worth asking again with less.
fn schema_lacks_field(v: &Value) -> bool {
    v["errors"].as_array().is_some_and(|errors| {
        errors.iter().any(|e| {
            let m = e["message"].as_str().unwrap_or_default();
            m.contains("doesn't exist on type") || m.contains("does not exist on type")
        })
    })
}

/// `glab api graphql`: the JSON answer even when GraphQL reported errors (`glab` then exits non-zero
/// but still prints the body), so the caller can see which.
fn graphql(host: &str, query: &str, vars: &[(&str, &str)]) -> Result<Value, String> {
    let mut cmd = gitlab::api(host, "graphql");
    for (name, value) in vars {
        cmd.arg("-f").arg(format!("{name}={value}"));
    }
    cmd.arg("-f").arg(format!("query={query}"));
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "glab", gitlab::MISSING)?;
    if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
        if out.ok() || v.get("errors").is_some() || v.get("data").is_some() {
            return Ok(v);
        }
    }
    if !out.ok() {
        return Err(gitlab::glab_error(&out, Some(host)));
    }
    Err("The GitLab CLI answered with something unexpected.".into())
}

fn fetch_json(target: &Target) -> Result<Value, String> {
    let vars = [("fullPath", target.forge.full_path()), ("iid", target.iid.to_string())];
    let vars: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let v = graphql(&target.forge.host, &query(target.kind, true), &vars)?;
    if schema_lacks_field(&v) {
        return graphql(&target.forge.host, &query(target.kind, false), &vars);
    }
    Ok(v)
}

pub(crate) fn fetch(target: &Target) -> Result<GhItem, String> {
    item_from_json(&fetch_json(target)?, target)
}

fn iid_of(v: &Value) -> Option<u64> {
    v.as_str().and_then(parse_iid).or_else(|| v.as_u64())
}

fn upper(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_ascii_uppercase()
}

/// GitLab's label colour (`#rrggbb`, sometimes a name on old servers) as GitHub's hex without `#`.
fn label_color(v: &Value) -> String {
    let c = v.as_str().unwrap_or_default().trim();
    let hex = c.strip_prefix('#').unwrap_or(c);
    if matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        if hex.len() == 3 {
            return hex.chars().flat_map(|ch| [ch, ch]).collect::<String>().to_ascii_lowercase();
        }
        return hex.to_ascii_lowercase();
    }
    String::new()
}

fn labels(node: &Value) -> Vec<GhLabel> {
    node["labels"]["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|l| Some(GhLabel { name: l["title"].as_str()?.to_string(), color: label_color(&l["color"]) }))
                .collect()
        })
        .unwrap_or_default()
}

fn author(host: &str, node: &Value) -> Option<GhAuthor> {
    node["author"]["username"].as_str().map(|login| GhAuthor {
        login: login.to_string(),
        avatar_url: node["author"]["avatarUrl"].as_str().and_then(|u| absolute_url(host, u)),
    })
}

/// A pipeline's or job's status (`CiJobStatus` / `PipelineStatusEnum`, any case) as a check's state.
pub(crate) fn check_state(status: &str) -> &'static str {
    match status.to_ascii_lowercase().as_str() {
        "success" => "success",
        "failed" => "failure",
        "canceled" | "canceling" => "cancelled",
        "skipped" => "skipped",
        "manual" => "neutral",
        _ => "pending",
    }
}

/// A job's status as a job's or step's state (`GhRunState`): like [`check_state`], plus "queued"
/// for one that has not started.
pub(crate) fn run_state(status: &str) -> &'static str {
    match status.to_ascii_lowercase().as_str() {
        "running" => "pending",
        "created" | "pending" | "preparing" | "waiting_for_resource" | "scheduled" | "waiting_for_callback" => "queued",
        other => check_state(other),
    }
}

/// The numeric id of a GraphQL global id (`gid://gitlab/Ci::Build/123`).
fn gid_number(v: &Value) -> Option<u64> {
    v.as_str()?.rsplit('/').next()?.parse::<u64>().ok().filter(|n| *n > 0)
}

fn job_check(forge: &Forge, j: &Value) -> Option<GhCheck> {
    let url = j["webPath"]
        .as_str()
        .and_then(|p| absolute_url(&forge.host, p))
        .or_else(|| gid_number(&j["id"]).map(|id| format!("https://{}/{}/-/jobs/{id}", forge.host, forge.full_path())));
    Some(GhCheck {
        name: j["name"].as_str()?.to_string(),
        workflow: some_text(&j["stage"]["name"]),
        state: check_state(j["status"].as_str().unwrap_or_default()),
        url,
        description: None,
        required: j["allowFailure"].as_bool() != Some(true),
    })
}

/// `detailedMergeStatus` as GitHub's (`mergeable`, `mergeStateStatus`) pair.
fn merge_status(detailed: &str, conflicts: bool) -> (&'static str, &'static str) {
    let state = match detailed {
        "MERGEABLE" => "clean",
        "CONFLICT" => "dirty",
        "NEED_REBASE" => "behind",
        "DRAFT_STATUS" => "draft",
        "CHECKING" | "UNCHECKED" | "PREPARING" | "APPROVALS_SYNCING" | "" => "unknown",
        // NOT_APPROVED, BLOCKED_STATUS, DISCUSSIONS_NOT_RESOLVED, NOT_OPEN, REQUESTED_CHANGES,
        // CI_MUST_PASS, CI_STILL_RUNNING, and whatever a newer server adds: GitLab will not merge it.
        _ => "blocked",
    };
    let state = if conflicts { "dirty" } else { state };
    let mergeable = match state {
        "dirty" => "conflicting",
        "unknown" => "unknown",
        _ => "mergeable",
    };
    (mergeable, state)
}

fn pr_review(node: &Value, detailed: &str) -> Option<String> {
    let approvals_left = node["approvalsLeft"].as_u64().unwrap_or(0);
    let required = node["approvalsRequired"].as_u64().unwrap_or(0);
    let approved_by = node["approvedBy"]["nodes"].as_array().map_or(0, Vec::len);
    let decision = if detailed == "REQUESTED_CHANGES" {
        "changes_requested"
    } else if approvals_left > 0 || detailed == "NOT_APPROVED" {
        "review_required"
    } else if (node["approved"].as_bool() == Some(true) && required > 0) || approved_by > 0 {
        "approved"
    } else {
        return None;
    };
    Some(decision.to_string())
}

/// GraphQL's answer as a [`GhItem`].
pub(crate) fn item_from_json(v: &Value, target: &Target) -> Result<GhItem, String> {
    let project = &v["data"]["project"];
    if project.is_null() {
        return Err(match v["errors"][0]["message"].as_str() {
            Some(msg) => format!("GitLab: {msg}"),
            None => format!(
                "GitLab has no project {}, or the account glab is signed in with cannot see it.",
                target.forge.full_path()
            ),
        });
    }
    let mr = &project["mergeRequest"];
    let is_pr = match target.kind {
        Kind::MergeRequest => true,
        Kind::Issue => false,
        Kind::Either => !mr.is_null(),
    };
    let node = if is_pr { mr } else { &project["issue"] };
    if node.is_null() {
        let what = match target.kind {
            Kind::MergeRequest => format!("merge request !{}", target.iid),
            Kind::Issue => format!("issue #{}", target.iid),
            Kind::Either => format!("merge request or issue {}", target.iid),
        };
        return Err(match v["errors"][0]["message"].as_str() {
            Some(msg) => format!("GitLab: {msg}"),
            None => format!("There is no {what} in {}.", target.forge.full_path()),
        });
    }
    let f = &target.forge;
    let state = match (upper(&node["state"]).as_str(), is_pr && node["draft"].as_bool() == Some(true)) {
        ("MERGED", _) => "merged",
        ("CLOSED" | "LOCKED", _) => "closed",
        (_, true) => "draft",
        _ => "open",
    };
    let state_reason = (!is_pr && state == "closed").then(|| {
        if node["closedAsDuplicateOf"].is_object() { "duplicate" } else { "completed" }.to_string()
    });
    let number = iid_of(&node["iid"]).unwrap_or(target.iid);
    let url = node["webUrl"].as_str().and_then(|u| absolute_url(&f.host, u)).unwrap_or_else(|| {
        let kind = if is_pr { "merge_requests" } else { "issues" };
        format!("https://{}/{}/-/{kind}/{number}", f.host, f.full_path())
    });
    let common = GhItem {
        provider: Provider::GitLab.id(),
        kind: if is_pr { "pr" } else { "issue" },
        url,
        host: f.host.clone(),
        owner: f.owner.clone(),
        repo: f.repo.clone(),
        number,
        title: text(&node["title"]),
        state,
        state_reason,
        author: author(&f.host, node),
        created_at: text(&node["createdAt"]),
        updated_at: text(&node["updatedAt"]),
        body_html: text(&node["descriptionHtml"]),
        labels: labels(node),
        comments: node["userNotesCount"].as_u64().unwrap_or(0),
        head_ref: None,
        base_ref: None,
        additions: None,
        deletions: None,
        changed_files: None,
        review_decision: None,
        checks: None,
        check_runs: Vec::new(),
        head_sha: None,
        mergeable: None,
        merge_state: None,
        merge_methods: Vec::new(),
        default_merge_method: None,
        can_merge: false,
    };
    if !is_pr {
        return Ok(common);
    }
    let pipeline = &node["headPipeline"];
    let checks = pipeline["status"].as_str().and_then(|s| match check_state(s) {
        "success" => Some("success"),
        "failure" | "cancelled" => Some("failure"),
        "pending" | "neutral" => Some("pending"),
        _ => None,
    });
    let check_runs: Vec<GhCheck> = pipeline["jobs"]["nodes"]
        .as_array()
        .map(|jobs| jobs.iter().filter_map(|j| job_check(f, j)).collect())
        .unwrap_or_default();
    let detailed = upper(&node["detailedMergeStatus"]);
    let (mergeable, merge_state) = merge_status(&detailed, node["conflicts"].as_bool() == Some(true));
    // The project's squash setting as the merge request sees it: read-only is "require" (squash on)
    // or "do not allow" (off); otherwise either may be picked, squash first when it is preselected.
    let squash_on = node["squashOnMerge"].as_bool() == Some(true);
    let merge_methods = match (node["squashReadOnly"].as_bool() == Some(true), squash_on) {
        (true, true) => vec!["squash"],
        (true, false) => vec!["merge"],
        _ => vec!["merge", "squash"],
    };
    let default_merge_method = Some(if squash_on { "squash" } else { merge_methods[0] });
    Ok(GhItem {
        head_ref: some_text(&node["sourceBranch"]),
        base_ref: some_text(&node["targetBranch"]),
        additions: node["diffStatsSummary"]["additions"].as_u64(),
        deletions: node["diffStatsSummary"]["deletions"].as_u64(),
        changed_files: node["diffStatsSummary"]["fileCount"].as_u64(),
        review_decision: pr_review(node, &detailed),
        checks: checks.map(str::to_string),
        check_runs,
        head_sha: some_text(&node["diffHeadSha"]),
        mergeable: Some(mergeable.to_string()),
        merge_state: Some(merge_state.to_string()),
        merge_methods,
        default_merge_method: default_merge_method.map(str::to_string),
        can_merge: matches!(state, "open" | "draft") && node["userPermissions"]["canMerge"].as_bool() == Some(true),
        ..common
    })
}

// ---------------------------------------------------------------------------
// The project's open merge requests and issues (REST)
// ---------------------------------------------------------------------------

fn list_item(n: &Value, kind: &'static str) -> Option<GhListItem> {
    let number = iid_of(&n["iid"])?;
    let url = n["web_url"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://"))?.to_string();
    let draft = n["draft"].as_bool() == Some(true) || n["work_in_progress"].as_bool() == Some(true);
    Some(GhListItem {
        kind,
        url,
        number,
        title: text(&n["title"]),
        state: if kind == "pr" && draft { "draft" } else { "open" },
        head_ref: if kind == "pr" { some_text(&n["source_branch"]) } else { None },
        author: some_text(&n["author"]["username"]),
        updated_at: text(&n["updated_at"]),
    })
}

/// The two REST lists as one, most recently updated first.
pub(crate) fn open_items_from_json(mrs: &Value, issues: &Value, f: &Forge) -> GhOpenItems {
    let list = |v: &Value, kind: &'static str| -> Vec<GhListItem> {
        v.as_array().map(|a| a.iter().filter_map(|n| list_item(n, kind)).collect()).unwrap_or_default()
    };
    let mut items = list(mrs, "pr");
    items.extend(list(issues, "issue"));
    // GitLab's ISO 8601 stamps (one server, one format) sort as text.
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    GhOpenItems { provider: Provider::GitLab.id(), host: f.host.clone(), owner: f.owner.clone(), repo: f.repo.clone(), items }
}

/// Up to this many of each kind, as on GitHub.
const OPEN_LIMIT: u32 = 30;

pub(crate) fn open_items(f: &Forge) -> Result<GhOpenItems, String> {
    let get = |what: &str| {
        let endpoint = format!(
            "{}/{what}?state=opened&per_page={OPEN_LIMIT}&order_by=updated_at&sort=desc",
            f.api_project()
        );
        gitlab::run_json(gitlab::api(&f.host, &endpoint), Some(&f.host))
    };
    let mrs = get("merge_requests")?;
    // A project with issues turned off answers 403/404 for them: its merge requests still list.
    let issues = get("issues").unwrap_or(Value::Array(Vec::new()));
    Ok(open_items_from_json(&mrs, &issues, f))
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/// The HTTP status `glab api` reported (`… (HTTP 405)` on stderr, or a `405 Method Not Allowed` style message).
fn http_status(out: &Output) -> Option<u16> {
    let err = String::from_utf8_lossy(&out.stderr);
    if let Some(i) = err.find("(HTTP ") {
        let code: String = err[i + 6..].chars().take_while(char::is_ascii_digit).collect();
        if let Ok(n) = code.parse() {
            return Some(n);
        }
    }
    [401u16, 403, 404, 405, 406, 409, 422].into_iter().find(|c| err.contains(&format!("{c} ")) || err.contains(&format!("HTTP {c}")))
}

/// GitLab's own words in a JSON error body (`{"message": "…"}`, sometimes a list or an object).
fn said(out: &Output) -> Option<String> {
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let m = &v["message"];
    if let Some(s) = some_text(m) {
        return Some(s);
    }
    if let Some(list) = m.as_array() {
        let parts: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
        return (!parts.is_empty()).then(|| parts.join(" "));
    }
    if let Some(map) = m.as_object() {
        let parts: Vec<String> = map
            .iter()
            .flat_map(|(k, v)| v.as_array().into_iter().flatten().filter_map(Value::as_str).map(move |s| format!("{k} {s}")))
            .collect();
        return (!parts.is_empty()).then(|| parts.join("; "));
    }
    some_text(&v["error"])
}

/// A refused merge as something a person can act on.
fn merge_error(out: &Output, target: &Target) -> String {
    let detail = said(out).map(|m| format!(" GitLab says: {m}")).unwrap_or_default();
    match http_status(out) {
        Some(409) => "The branch got new commits since this was read. Look at them, then merge again.".into(),
        Some(406) => format!("GitLab cannot merge it: the branch has conflicts or must be rebased first.{detail}"),
        Some(405) => format!(
            "GitLab will not merge it yet: it may be a draft, closed, blocked by its pipeline, approvals or open threads.{detail}"
        ),
        Some(422) => format!("GitLab refused the merge.{detail}"),
        Some(401) => format!(
            "The account glab is signed in with may not merge in {}, or its sign-in to {} expired.{detail}",
            target.forge.full_path(),
            target.forge.host
        ),
        Some(403) => format!(
            "The account glab is signed in with may not merge in {}.{detail}",
            target.forge.full_path()
        ),
        _ => gitlab::glab_error(out, Some(&target.forge.host)),
    }
}

/// Merge a merge request with "merge" or "squash", only while its branch still points at `head_sha`.
pub(crate) fn merge(target: &Target, method: &str, head_sha: &str) -> Result<(), String> {
    match method {
        "merge" | "squash" => {}
        "rebase" => return Err("GitLab merges with a merge commit or squashes; rebasing is set per project on GitLab.".into()),
        _ => return Err(format!("\"{method}\" is not a merge method.")),
    }
    if !is_sha(head_sha) {
        return Err("Read the merge request again before merging it.".into());
    }
    if target.kind == Kind::Issue {
        return Err("Only merge requests can be merged; that is an issue.".into());
    }
    let f = &target.forge;
    let mut cmd = gitlab::glab(None);
    cmd.args(["api", "--hostname", &f.host, "--method", "PUT"])
        .arg(format!("{}/merge_requests/{}/merge", f.api_project(), target.iid))
        // `sha`: GitLab refuses (409) when the branch moved since the user looked at it.
        .arg("-f")
        .arg(format!("sha={head_sha}"));
    if method == "squash" {
        cmd.arg("-f").arg("squash=true");
    }
    let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "glab", gitlab::MISSING)?;
    if !out.ok() {
        return Err(merge_error(&out, target));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Opening a merge request
// ---------------------------------------------------------------------------

/// The merge request a `glab mr create` (or the REST call) named: a link to it, or `!12` in an
/// "already exists" message (then in `f`).
fn created_target(text: &str, f: &Forge, is_gitlab: impl Fn(&str) -> bool) -> Option<Target> {
    let link = text
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '(' | ')' | ','))
        .filter(|w| (w.starts_with("https://") || w.starts_with("http://")) && w.contains("/-/merge_requests/"))
        .find_map(|w| {
            let (host, ns, proj, iid, kind) = parse_url(w)?;
            (kind == Kind::MergeRequest && is_gitlab(&host)).then(|| Target { forge: forge(&host, &ns, &proj), iid, kind })
        });
    if link.is_some() {
        return link;
    }
    if !text.to_lowercase().contains("already exists") {
        return None;
    }
    text.match_indices('!').find_map(|(i, _)| {
        let digits: String = text[i + 1..].chars().take_while(char::is_ascii_digit).collect();
        parse_iid(&digits).map(|iid| Target { forge: f.clone(), iid, kind: Kind::MergeRequest })
    })
}

/// Open a merge request from the branch checked out at `path` into `base` on the project's GitLab
/// project `f`, or find the one already open for it, and read it. On this computer `glab mr create`
/// runs in the folder (`--fill`: title and description from the commits); a remote project has no
/// folder here, so git reads the commits inside its environment and the REST API is told the rest.
pub(crate) fn mr_create(app: &tauri::AppHandle, path: &str, base: &str, f: &Forge) -> Result<GhItem, String> {
    let base = crate::git::safe_ref(base)?.to_string();
    let is_gitlab = |h: &str| gitlab::is_gitlab_host(app, h);
    let out = if let Some(env) = crate::vcs::env_at(app, path) {
        let at = At::Env(Box::new(env?));
        let mr = crate::git::pr_details(&at, &base, true)?;
        let mut cmd = gitlab::glab(None);
        cmd.args(["api", "--hostname", &f.host, "--method", "POST"])
            .arg(format!("{}/merge_requests", f.api_project()))
            .arg("-f")
            .arg(format!("source_branch={}", mr.branch))
            .arg("-f")
            .arg(format!("target_branch={base}"))
            .arg("-f")
            .arg(format!("title={}", mr.title))
            .arg("-f")
            .arg(format!("description={}", mr.body));
        let out = run_process(cmd, None, STDOUT_CAP, TIMEOUT, "glab", gitlab::MISSING)?;
        if out.ok() {
            let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
            if let Some(iid) = iid_of(&v["iid"]) {
                return read_created(&Target { forge: f.clone(), iid, kind: Kind::MergeRequest });
            }
        }
        out
    } else {
        let dir = PathBuf::from(path.trim());
        if path.trim().is_empty() || !dir.is_dir() {
            return Err(format!("{path} is not a folder"));
        }
        let mr = crate::git::pr_details(&At::local(&dir), &base, false)?;
        let mut cmd: Command = gitlab::glab(Some(&dir));
        cmd.args(["mr", "create", "--fill", "--yes"])
            .arg(format!("--source-branch={}", mr.branch))
            .arg(format!("--target-branch={base}"));
        run_process(cmd, None, STDOUT_CAP, TIMEOUT, "glab", gitlab::MISSING)?
    };
    let all = format!("{}\n{}", out.text(), out.combined());
    let target = if out.ok() || all.to_lowercase().contains("already exists") {
        created_target(&all, f, is_gitlab)
    } else {
        return Err(gitlab::glab_error(&out, Some(&f.host)));
    };
    let target = target.ok_or_else(|| format!("The GitLab CLI did not say where the merge request is.\n{}", out.combined()))?;
    read_created(&target)
}

fn read_created(target: &Target) -> Result<GhItem, String> {
    fetch(target).map_err(|e| {
        format!(
            "Opened https://{}/{}/-/merge_requests/{}, but could not read it back: {e}",
            target.forge.host,
            target.forge.full_path(),
            target.iid
        )
    })
}

// ---------------------------------------------------------------------------
// A CI job and its log
// ---------------------------------------------------------------------------

/// `https://host/group/sub/proj/-/jobs/123` (anything after the id): the job's project and id. The
/// host is returned as given; the caller checks that it is a GitLab server.
fn parse_job_url(url: &str) -> Result<(Forge, u64), String> {
    let s = url.trim();
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).ok_or(NOT_A_JOB)?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<&str> = rest.split('/').collect();
    let dash = parts.iter().position(|p| *p == "-").ok_or(NOT_A_JOB)?;
    let host = parts[0].to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if dash < 3 || !gitlab::is_host(&host) || parts.get(dash + 1) != Some(&"jobs") {
        return Err(NOT_A_JOB.into());
    }
    let id = parts.get(dash + 2).copied().unwrap_or_default();
    let id = if !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()) {
        id.parse::<u64>().ok().filter(|n| *n > 0)
    } else {
        None
    };
    let path = parts[1..dash].join("/");
    let (Some(id), Some((ns, proj))) = (id, split_project(&path)) else {
        return Err(NOT_A_JOB.into());
    };
    Ok((forge(&host, ns, proj), id))
}

/// Whether `gh_job` should hand a link to this module: a `/-/jobs/<id>` link.
pub(crate) fn is_job_url(url: &str) -> bool {
    url.contains("/-/jobs/")
}

/// Seconds since the epoch as an ISO 8601 UTC timestamp (`2026-11-16T20:29:33Z`).
fn iso_from_epoch(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// One piece of a trace line: text, or a section marker.
#[derive(Debug, PartialEq, Eq)]
enum Piece<'a> {
    Text(&'a str),
    Start { at: i64, name: &'a str },
    End { at: i64, name: &'a str },
}

const ERASE: &str = "\u{1b}[0K";

fn is_section_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// A marker at the start of `s` (`section_start:<epoch>:<name>[options]` or
/// `section_end:<epoch>:<name>`, then `\r\x1b[0K`), and the rest of `s` after it.
fn marker(s: &str) -> Option<(Piece<'_>, &str)> {
    let (start, rest) = if let Some(r) = s.strip_prefix("section_start:") {
        (true, r)
    } else {
        (false, s.strip_prefix("section_end:")?)
    };
    let (epoch, rest) = rest.split_once(':')?;
    if epoch.is_empty() || epoch.len() > 12 || !epoch.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let at = epoch.parse::<i64>().ok()?;
    let end = rest.find(['\r', '\u{1b}']).unwrap_or(rest.len());
    let (head, rest) = rest.split_at(end);
    // Options (`[collapsed=true]`) only ever follow a start's name.
    let name = if start { head.split_once('[').map_or(head, |(n, _)| n) } else { head };
    if !is_section_name(name) || (!start && name != head) {
        return None;
    }
    let rest = rest.strip_prefix('\r').unwrap_or(rest);
    let rest = rest.strip_prefix(ERASE).unwrap_or(rest);
    Some((if start { Piece::Start { at, name } } else { Piece::End { at, name } }, rest))
}

/// A trace line in pieces: the text around each section marker, and the markers.
fn pieces(line: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut rest = line;
    loop {
        let next = ["section_start:", "section_end:"]
            .iter()
            .filter_map(|m| rest.find(m))
            .filter(|&i| marker(&rest[i..]).is_some())
            .min();
        let Some(i) = next else {
            if !rest.is_empty() {
                out.push(Piece::Text(rest));
            }
            return out;
        };
        if i > 0 {
            out.push(Piece::Text(&rest[..i]));
        }
        let (piece, after) = marker(&rest[i..]).expect("checked above");
        out.push(piece);
        rest = after;
    }
}

/// What a line shows: a carriage return starts the line over (progress bars), and the erase-line
/// codes the runner sprinkles are noise. Colour codes stay.
fn visible(text: &str) -> String {
    let text = text.strip_suffix('\r').unwrap_or(text);
    let clean = |s: &str| s.replace(ERASE, "").replace("\u{1b}[K", "");
    text.rsplit('\r').map(clean).find(|s| !s.is_empty()).unwrap_or_default()
}

/// Lines of plain text, ANSI codes removed (a section's title).
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        if !c.is_control() {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// The runner's timestamp prefix (job log timestamps, on by default since Runner 18.7):
/// `<RFC 3339 UTC>Z <stream: 2 hex><O|E><'+' continues the previous line | ' '>`, then the text
/// directly. Returns the text and whether it continues the previous line; None without a prefix.
fn strip_timestamp(line: &str) -> Option<(&str, bool)> {
    let (stamp, rest) = line.split_once(' ')?;
    if !stamp.ends_with('Z') || crate::github::epoch_seconds(stamp).is_none() {
        return None;
    }
    let b = rest.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_hexdigit() || !b[1].is_ascii_hexdigit() || !matches!(b[2], b'O' | b'E') {
        return None;
    }
    match b.get(3) {
        None => Some(("", false)),
        Some(b'+') => Some((&rest[4..], true)),
        Some(b' ') => Some((&rest[4..], false)),
        _ => None,
    }
}

/// One step being built from the trace.
struct Draft {
    name: String,
    /// The section it is; None for lines outside every section.
    section: Option<String>,
    start: Option<i64>,
    end: Option<i64>,
    closed: bool,
    lines: Vec<String>,
}

/// A job's state after its log: each top-level section is a step (its title from the section's
/// header line, its times from the markers); a nested section becomes a `##[group]` … `##[endgroup]`
/// fold inside it; lines outside every section become steps of their own ("Runner" before the first
/// section, "Result" after). The marker noise goes, colour codes stay.
pub(crate) fn split_trace(trace: &str, job_state: &'static str) -> Vec<GhJobStep> {
    // Join lines the runner split (timestamped logs mark a continuation with `+`).
    let trace = trace.strip_prefix('\u{feff}').unwrap_or(trace);
    // As GitLab reads it: the log is timestamped when its first line is.
    let stamped = strip_timestamp(trace.split('\n').next().unwrap_or_default()).is_some();
    let mut lines: Vec<String> = Vec::new();
    for raw in trace.split('\n') {
        let (text, more) = if stamped { strip_timestamp(raw).unwrap_or((raw, false)) } else { (raw, false) };
        match lines.last_mut() {
            Some(last) if more => last.push_str(text),
            _ => lines.push(text.to_string()),
        }
    }
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }

    let mut drafts: Vec<Draft> = Vec::new();
    // The open sections, outermost first; the first is the current step's.
    let mut open: Vec<String> = Vec::new();
    let outside = |drafts: &mut Vec<Draft>| {
        if !drafts.last().is_some_and(|d| d.section.is_none()) {
            let name = if drafts.is_empty() { "Runner" } else { "Result" };
            drafts.push(Draft { name: name.into(), section: None, start: None, end: None, closed: true, lines: Vec::new() });
        }
    };
    for line in &lines {
        let mut parts = pieces(line);
        if parts.is_empty() {
            // A blank line is still a line.
            parts.push(Piece::Text(""));
        }
        let mut i = 0;
        while i < parts.len() {
            match &parts[i] {
                Piece::Text(t) => {
                    let shown = visible(t);
                    // A line that held only markers and their noise is no line.
                    if !shown.is_empty() || parts.len() == 1 {
                        if open.is_empty() {
                            outside(&mut drafts);
                        }
                        drafts.last_mut().expect("a step").lines.push(shown);
                    }
                }
                Piece::Start { at, name } => {
                    // The text after a start marker is its header.
                    let header = match parts.get(i + 1) {
                        Some(Piece::Text(t)) => {
                            i += 1;
                            visible(t)
                        }
                        _ => String::new(),
                    };
                    if open.is_empty() {
                        let title = plain(&header);
                        drafts.push(Draft {
                            name: if title.is_empty() { name.to_string() } else { title },
                            section: Some(name.to_string()),
                            start: Some(*at),
                            end: None,
                            closed: false,
                            lines: Vec::new(),
                        });
                    } else {
                        let header = if plain(&header).is_empty() { name.to_string() } else { header };
                        drafts.last_mut().expect("a step").lines.push(format!("##[group]{header}"));
                    }
                    open.push(name.to_string());
                }
                Piece::End { at, name } => {
                    if let Some(depth) = open.iter().rposition(|n| n == name) {
                        let step = drafts.last_mut().expect("a step");
                        for _ in depth.max(1)..open.len() {
                            step.lines.push("##[endgroup]".into());
                        }
                        if depth == 0 {
                            step.end = Some(*at);
                            step.closed = true;
                        }
                        open.truncate(depth);
                    }
                }
            }
            i += 1;
        }
    }

    // Which step failed: the one cut off, else the script's, else the last.
    let failed = matches!(job_state, "failure" | "cancelled");
    let culprit = failed
        .then(|| {
            drafts
                .iter()
                .rposition(|d| !d.closed)
                .or_else(|| {
                    drafts.iter().rposition(|d| matches!(d.section.as_deref(), Some("step_script" | "build_script" | "script")))
                })
                .or_else(|| drafts.len().checked_sub(1))
        })
        .flatten();
    let last = drafts.len().saturating_sub(1);
    drafts
        .into_iter()
        .enumerate()
        .map(|(i, d)| {
            let state = if Some(i) == culprit {
                job_state
            } else if !d.closed {
                if job_state == "pending" { "pending" } else { "success" }
            } else if d.section.is_none() && i == last && i > 0 {
                // The runner's last words ("Job succeeded", "ERROR: Job failed").
                if job_state == "pending" { "success" } else { job_state }
            } else {
                "success"
            };
            let omitted = d.lines.len().saturating_sub(STEP_LINES);
            GhJobStep {
                number: i as u64 + 1,
                name: d.name,
                state,
                started_at: d.start.map(iso_from_epoch),
                completed_at: d.end.map(iso_from_epoch),
                lines: d.lines[omitted..].to_vec(),
                omitted,
            }
        })
        .collect()
}

/// `GET projects/:id/jobs/:id` as a [`GhJob`] without its log.
fn job_from_json(v: &Value, url: &str) -> GhJob {
    GhJob {
        provider: Provider::GitLab.id(),
        id: v["id"].as_u64().unwrap_or(0),
        name: text(&v["name"]),
        workflow: some_text(&v["stage"]),
        url: v["web_url"]
            .as_str()
            .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
            .unwrap_or(url.trim())
            .to_string(),
        state: run_state(v["status"].as_str().unwrap_or_default()),
        started_at: some_text(&v["started_at"]),
        completed_at: some_text(&v["finished_at"]),
        steps: Vec::new(),
        log_ready: false,
        log_error: None,
        log_truncated: false,
    }
}

/// A GitLab CI job by its link: its details and, once it started, its log split into steps by the
/// sections in it. Unlike GitHub, GitLab has the log while the job runs.
pub(crate) fn job(url: &str, is_gitlab: impl Fn(&str) -> bool) -> Result<GhJob, String> {
    let (f, id) = parse_job_url(url)?;
    if !is_gitlab(&f.host) {
        return Err(unknown_server(&f.host));
    }
    let endpoint = format!("{}/jobs/{id}", f.api_project());
    let v = gitlab::run_json(gitlab::api(&f.host, &endpoint), Some(&f.host))?;
    let mut job = job_from_json(&v, url);
    // Not started (queued, or a manual job nobody ran): there is no log yet.
    if job.started_at.is_none() {
        return Ok(job);
    }
    let cmd = gitlab::api(&f.host, &format!("{endpoint}/trace"));
    match gitlab::run_raw(cmd, Some(&f.host), LOG_CAP) {
        Ok(out) => {
            job.steps = split_trace(&String::from_utf8_lossy(&out.stdout), job.state);
            job.log_ready = true;
            job.log_truncated = out.truncated;
        }
        Err(e) => job.log_error = Some(e),
    }
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gl(host: &str, path: &str, iid: u64, kind: Kind) -> Route {
        let (ns, proj) = path.rsplit_once('/').unwrap();
        Route::GitLab(Target { forge: forge(host, ns, proj), iid, kind })
    }

    fn known(h: &str) -> bool {
        gitlab::is_gitlab_host_in(h, &["git.corp.io".into()])
    }

    fn on_gitlab() -> Option<Forge> {
        Some(forge("gitlab.example.com", "team/sub", "app"))
    }

    fn on_github() -> Option<Forge> {
        Some(Forge { provider: Provider::GitHub, host: "github.com".into(), owner: "o".into(), repo: "r".into() })
    }

    #[test]
    fn routes_links() {
        let none = || -> Option<Forge> { panic!("a full link needs no project") };
        assert_eq!(
            route("https://gitlab.com/group/sub/proj/-/merge_requests/12/diffs?x=1#note_5", known, none),
            Ok(gl("gitlab.com", "group/sub/proj", 12, Kind::MergeRequest))
        );
        assert_eq!(
            route("https://www.GitLab.com/g/p/-/issues/4", known, none),
            Ok(gl("gitlab.com", "g/p", 4, Kind::Issue))
        );
        assert_eq!(
            route("https://git.corp.io/a/b/c/d/-/work_items/9", known, none),
            Ok(gl("git.corp.io", "a/b/c/d", 9, Kind::Issue))
        );
        assert_eq!(route("https://gitlab.example.com:8443/g/p/-/merge_requests/1", known, none), Ok(gl("gitlab.example.com:8443", "g/p", 1, Kind::MergeRequest)));
        // GitHub links keep the GitHub path.
        assert_eq!(route("https://github.com/o/r/pull/3", known, none), Ok(Route::GitHub));
        assert_eq!(route("https://ghe.example.com/o/r/issues/3", known, none), Ok(Route::GitHub));
        // GitLab-shaped, but on a server Mango does not know: refused, never handed to glab.
        assert!(route("https://evil.example.com/g/p/-/merge_requests/1", known, none).unwrap_err().contains("Settings > Git hosting"));
    }

    #[test]
    fn refuses_junk_links() {
        let none = || -> Option<Forge> { None };
        for bad in [
            "https://gitlab.com/g/p/-/merge_requests/x",
            "https://gitlab.com/g/p/-/merge_requests/0",
            "https://gitlab.com/g/p/-/merge_requests/99999999999",
            "https://gitlab.com/g/p/-/merge_requests/",
            "https://gitlab.com/p/-/merge_requests/1",
            "https://gitlab.com/-/merge_requests/1",
            "https://gitlab.com/../p/-/issues/1",
            "https://gitlab.com/g/-p/-/issues/1",
            "https://gitlab.com/g/p.git/-/issues/1",
            "https://gitlab.com/g/p/-/pipelines/1",
            "https://gitlab.com/g/p",
            "https://gitlab.com/g%2F/p/-/issues/1",
            "https://gitlab.com/g p/q/-/issues/1",
            "https://-bad.gitlab.com/g/p/-/issues/1",
        ] {
            assert!(route(bad, known, none).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn routes_short_references() {
        assert_eq!(route("!12", known, on_gitlab), Ok(gl("gitlab.example.com", "team/sub/app", 12, Kind::MergeRequest)));
        assert_eq!(route(" #7 ", known, on_gitlab), Ok(gl("gitlab.example.com", "team/sub/app", 7, Kind::Issue)));
        assert_eq!(route("7", known, on_gitlab), Ok(gl("gitlab.example.com", "team/sub/app", 7, Kind::Either)));
        assert_eq!(route("other/proj#3", known, on_gitlab), Ok(gl("gitlab.example.com", "other/proj", 3, Kind::Issue)));
        assert_eq!(route("g/sub/proj!3", known, on_gitlab), Ok(gl("gitlab.example.com", "g/sub/proj", 3, Kind::MergeRequest)));
        // With no GitLab project, a path reference with `!` or a subgroup is gitlab.com's.
        assert_eq!(route("g/proj!3", known, on_github), Ok(gl("gitlab.com", "g/proj", 3, Kind::MergeRequest)));
        assert_eq!(route("g/sub/proj#3", known, on_github), Ok(gl("gitlab.com", "g/sub/proj", 3, Kind::Issue)));
        // GitHub's references stay GitHub's.
        assert_eq!(route("#7", known, on_github), Ok(Route::GitHub));
        assert_eq!(route("7", known, || None), Ok(Route::GitHub));
        assert_eq!(route("o/r#7", known, on_github), Ok(Route::GitHub));
        // `!12` needs a GitLab project.
        assert!(route("!12", known, on_github).is_err());
        for bad in ["!", "!x", "!0", "a!1", "g/-x!1", "a/b/../c#1", "@file!1", "!99999999999"] {
            assert!(route(bad, known, on_gitlab).is_err(), "{bad:?} should be refused");
        }
        assert!(route("nonsense", known, on_gitlab).is_err());
    }

    fn target(kind: Kind) -> Target {
        Target { forge: forge("git.corp.io", "team/sub", "app"), iid: 12, kind }
    }

    #[test]
    fn queries_fit_the_kind() {
        let q = query(Kind::Either, true);
        assert!(q.contains("mergeRequest(iid: $iid)") && q.contains("issue(iid: $iid)") && q.contains("approvalsLeft"));
        assert!(!query(Kind::MergeRequest, false).contains("approvalsLeft"));
        assert!(!query(Kind::Issue, true).contains("mergeRequest"));
        assert!(!query(Kind::Issue, true).contains("EXTRA") && !query(Kind::Either, false).contains("EXTRA"));
        let lacking = json!({ "errors": [{ "message": "Field 'approvalsLeft' doesn't exist on type 'MergeRequest'" }] });
        assert!(schema_lacks_field(&lacking));
        assert!(!schema_lacks_field(&json!({ "data": {} })));
    }

    fn mr_json() -> Value {
        let jobs = json!([
            { "id": "gid://gitlab/Ci::Build/501", "name": "lint", "status": "SUCCESS",
              "webPath": "/team/sub/app/-/jobs/501", "allowFailure": false, "stage": { "name": "test" } },
            { "id": "gid://gitlab/Ci::Build/502", "name": "e2e", "status": "FAILED",
              "webPath": null, "allowFailure": true, "stage": { "name": "test" } },
            { "id": "gid://gitlab/Ci::Build/503", "name": "deploy", "status": "MANUAL",
              "allowFailure": false, "stage": { "name": "deploy" } },
            { "id": "gid://gitlab/Ci::Build/504", "name": "build", "status": "RUNNING",
              "webPath": "/team/sub/app/-/jobs/504", "allowFailure": false, "stage": null }
        ]);
        let labels = json!([{ "title": "bug", "color": "#D73A4A" }, { "title": "odd", "color": "red" }]);
        let mr = json!({
                "iid": "12", "title": "feat: x", "webUrl": "https://git.corp.io/team/sub/app/-/merge_requests/12",
                "state": "opened", "draft": false, "descriptionHtml": "<p>hi</p>",
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-02T00:00:00Z",
                "author": { "username": "ann", "avatarUrl": "/uploads/-/system/user/avatar/1/a.png" },
                "labels": { "nodes": labels },
                "userNotesCount": 4, "sourceBranch": "feat/x", "targetBranch": "main",
                "diffHeadSha": "d013dd471daf6f6672ea035294ab4f01282f9c38", "squashOnMerge": true, "squashReadOnly": false, "conflicts": false,
                "diffStatsSummary": { "additions": 10, "deletions": 2, "fileCount": 3 },
                "detailedMergeStatus": "CI_STILL_RUNNING",
                "userPermissions": { "canMerge": true },
                "approvedBy": { "nodes": [] },
                "approved": false, "approvalsLeft": 1, "approvalsRequired": 1,
                "headPipeline": { "status": "RUNNING", "jobs": { "nodes": jobs } }
        });
        json!({ "data": { "project": { "mergeRequest": mr } } })
    }

    #[test]
    fn reads_a_merge_request() {
        let item = item_from_json(&mr_json(), &target(Kind::Either)).unwrap();
        assert_eq!((item.provider, item.kind, item.state, item.number), ("gitlab", "pr", "open", 12));
        assert_eq!((item.host.as_str(), item.owner.as_str(), item.repo.as_str()), ("git.corp.io", "team/sub", "app"));
        assert_eq!(item.url, "https://git.corp.io/team/sub/app/-/merge_requests/12");
        let author = item.author.as_ref().unwrap();
        assert_eq!(author.login, "ann");
        assert_eq!(author.avatar_url.as_deref(), Some("https://git.corp.io/uploads/-/system/user/avatar/1/a.png"));
        assert_eq!(item.labels.iter().map(|l| (l.name.as_str(), l.color.as_str())).collect::<Vec<_>>(), [("bug", "d73a4a"), ("odd", "")]);
        assert_eq!(item.comments, 4);
        assert_eq!((item.head_ref.as_deref(), item.base_ref.as_deref()), (Some("feat/x"), Some("main")));
        assert_eq!((item.additions, item.deletions, item.changed_files), (Some(10), Some(2), Some(3)));
        assert_eq!(item.review_decision.as_deref(), Some("review_required"));
        assert_eq!(item.checks.as_deref(), Some("pending"));
        let runs: Vec<_> = item.check_runs.iter().map(|c| (c.name.as_str(), c.state, c.required, c.workflow.as_deref())).collect();
        assert_eq!(
            runs,
            [("lint", "success", true, Some("test")), ("e2e", "failure", false, Some("test")), ("deploy", "neutral", true, Some("deploy")), ("build", "pending", true, None)]
        );
        assert_eq!(item.check_runs[0].url.as_deref(), Some("https://git.corp.io/team/sub/app/-/jobs/501"));
        assert_eq!(item.check_runs[1].url.as_deref(), Some("https://git.corp.io/team/sub/app/-/jobs/502"), "built from the id");
        assert_eq!(item.head_sha.as_deref(), Some("d013dd471daf6f6672ea035294ab4f01282f9c38"));
        assert_eq!((item.mergeable.as_deref(), item.merge_state.as_deref()), (Some("mergeable"), Some("blocked")));
        assert_eq!(item.merge_methods, ["merge", "squash"]);
        assert_eq!(item.default_merge_method.as_deref(), Some("squash"));
        assert!(item.can_merge);
        // Every job link the item gives is one gh_job takes.
        assert!(parse_job_url(item.check_runs[0].url.as_ref().unwrap()).is_ok());
    }

    #[test]
    fn merge_request_variants() {
        let mut v = mr_json();
        let mr = &mut v["data"]["project"]["mergeRequest"];
        mr["draft"] = json!(true);
        mr["conflicts"] = json!(true);
        mr["detailedMergeStatus"] = json!("CONFLICT");
        mr["approved"] = json!(true);
        mr["approvalsLeft"] = json!(0);
        mr["userPermissions"]["canMerge"] = json!(false);
        mr["headPipeline"] = Value::Null;
        mr["squashOnMerge"] = json!(false);
        mr["squashReadOnly"] = json!(true);
        let item = item_from_json(&v, &target(Kind::MergeRequest)).unwrap();
        assert_eq!(item.state, "draft");
        assert_eq!((item.mergeable.as_deref(), item.merge_state.as_deref()), (Some("conflicting"), Some("dirty")));
        assert_eq!(item.review_decision.as_deref(), Some("approved"));
        assert_eq!(item.merge_methods, ["merge"]);
        assert_eq!(item.default_merge_method.as_deref(), Some("merge"));
        assert!(item.checks.is_none() && item.check_runs.is_empty() && !item.can_merge);

        let mut v = mr_json();
        v["data"]["project"]["mergeRequest"]["state"] = json!("merged");
        v["data"]["project"]["mergeRequest"]["squashReadOnly"] = json!(true);
        let item = item_from_json(&v, &target(Kind::MergeRequest)).unwrap();
        assert_eq!(item.state, "merged");
        assert_eq!(item.merge_methods, ["squash"]);
        assert!(!item.can_merge, "a merged one is not merged again");

        // A server without approvals or squash settings in its schema (asked with the smaller query).
        let mut v = mr_json();
        let mr = v["data"]["project"]["mergeRequest"].as_object_mut().unwrap();
        for k in ["approvalsLeft", "approvalsRequired", "squashOnMerge", "squashReadOnly"] {
            mr.remove(k);
        }
        mr.insert("detailedMergeStatus".into(), json!("MERGEABLE"));
        let item = item_from_json(&v, &target(Kind::MergeRequest)).unwrap();
        assert_eq!(item.review_decision, None);
        assert_eq!((item.mergeable.as_deref(), item.merge_state.as_deref()), (Some("mergeable"), Some("clean")));
        assert_eq!(item.merge_methods, ["merge", "squash"]);
        assert_eq!(item.default_merge_method.as_deref(), Some("merge"));
    }

    #[test]
    fn merge_statuses() {
        assert_eq!(merge_status("MERGEABLE", false), ("mergeable", "clean"));
        assert_eq!(merge_status("NEED_REBASE", false), ("mergeable", "behind"));
        assert_eq!(merge_status("DRAFT_STATUS", false), ("mergeable", "draft"));
        assert_eq!(merge_status("CHECKING", false), ("unknown", "unknown"));
        assert_eq!(merge_status("DISCUSSIONS_NOT_RESOLVED", false), ("mergeable", "blocked"));
        assert_eq!(merge_status("CI_MUST_PASS", false), ("mergeable", "blocked"));
        assert_eq!(merge_status("SOMETHING_NEW", true), ("conflicting", "dirty"));
    }

    #[test]
    fn reads_an_issue() {
        let v = json!({ "data": { "project": { "mergeRequest": null, "issue": {
            "iid": "5", "title": "Crash", "webUrl": "https://git.corp.io/team/sub/app/-/issues/5", "state": "closed",
            "descriptionHtml": "", "createdAt": "", "updatedAt": "", "author": null, "userNotesCount": 2,
            "labels": { "nodes": [] }, "closedAsDuplicateOf": null
        } } } });
        let item = item_from_json(&v, &target(Kind::Either)).unwrap();
        assert_eq!((item.kind, item.state, item.number, item.comments), ("issue", "closed", 5, 2));
        assert_eq!(item.state_reason.as_deref(), Some("completed"));
        assert!(item.head_ref.is_none() && item.checks.is_none() && item.merge_methods.is_empty() && !item.can_merge);

        let mut dup = v.clone();
        dup["data"]["project"]["issue"]["closedAsDuplicateOf"] = json!({ "iid": "3" });
        assert_eq!(item_from_json(&dup, &target(Kind::Issue)).unwrap().state_reason.as_deref(), Some("duplicate"));
        let mut open = v.clone();
        open["data"]["project"]["issue"]["state"] = json!("opened");
        let item = item_from_json(&open, &target(Kind::Issue)).unwrap();
        assert_eq!((item.state, item.state_reason), ("open", None));
    }

    #[test]
    fn names_what_is_missing() {
        let none = json!({ "data": { "project": { "mergeRequest": null, "issue": null } } });
        assert!(item_from_json(&none, &target(Kind::Either)).unwrap_err().contains("merge request or issue 12 in team/sub/app"));
        assert!(item_from_json(&none, &target(Kind::MergeRequest)).unwrap_err().contains("!12"));
        let gone = json!({ "data": { "project": null } });
        assert!(item_from_json(&gone, &target(Kind::Issue)).unwrap_err().contains("no project team/sub/app"));
        let err = json!({ "data": null, "errors": [{ "message": "boom" }] });
        assert_eq!(item_from_json(&err, &target(Kind::Issue)).unwrap_err(), "GitLab: boom");
    }

    #[test]
    fn lists_open_items_newest_first() {
        let mrs = json!([
            { "iid": 75, "title": "feat: a", "web_url": "https://gitlab.com/g/p/-/merge_requests/75", "draft": false,
              "source_branch": "feat/a", "updated_at": "2026-11-20T10:00:00.000Z", "author": { "username": "ann" } },
            { "iid": 76, "title": "fix: b", "web_url": "https://gitlab.com/g/p/-/merge_requests/76", "work_in_progress": true,
              "source_branch": "fix/b", "updated_at": "2026-11-21T09:00:00.000Z", "author": null },
            { "iid": 77, "title": "no link", "web_url": "javascript:alert(1)", "updated_at": "2026-11-21T11:00:00.000Z" }
        ]);
        let issues = json!([
            { "iid": 70, "title": "Crash", "web_url": "https://gitlab.com/g/p/-/issues/70",
              "updated_at": "2026-11-20T12:00:00.000Z", "author": { "username": "bo" } }
        ]);
        let f = forge("gitlab.com", "g", "p");
        let list = open_items_from_json(&mrs, &issues, &f);
        assert_eq!((list.provider, list.owner.as_str(), list.repo.as_str()), ("gitlab", "g", "p"));
        let got: Vec<_> = list.items.iter().map(|i| (i.number, i.kind, i.state)).collect();
        assert_eq!(got, [(76, "pr", "draft"), (70, "issue", "open"), (75, "pr", "open")]);
        assert_eq!(list.items[2].head_ref.as_deref(), Some("feat/a"));
        assert_eq!((list.items[0].author.as_deref(), list.items[1].author.as_deref()), (None, Some("bo")));
        assert!(open_items_from_json(&json!({ "message": "403 Forbidden" }), &Value::Null, &f).items.is_empty());
    }

    fn out(stderr: &str, stdout: &str) -> Output {
        Output { code: Some(1), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec(), truncated: false }
    }

    #[test]
    fn explains_refused_merges() {
        let t = target(Kind::MergeRequest);
        assert!(merge_error(&out("glab: 409 Conflict (HTTP 409)", "{}"), &t).contains("new commits"));
        assert!(merge_error(&out("glab: 406 Not Acceptable (HTTP 406)", r#"{"message":"Branch cannot be merged"}"#), &t)
            .ends_with("GitLab says: Branch cannot be merged"));
        assert!(merge_error(&out("glab: 405 Method Not Allowed (HTTP 405)", r#"{"message":"405 Method Not Allowed"}"#), &t)
            .contains("will not merge it yet"));
        assert!(merge_error(&out("422 Unprocessable Entity", r#"{"message":["SHA does not match HEAD"]}"#), &t)
            .ends_with("GitLab says: SHA does not match HEAD"));
        assert!(merge_error(&out("glab: 403 Forbidden (HTTP 403)", "{}"), &t).contains("may not merge in team/sub/app"));
        assert!(merge_error(&out("glab: 401 Unauthorized (HTTP 401)", ""), &t).contains("sign-in to git.corp.io"));
    }

    #[test]
    fn refuses_bad_merges_before_asking_gitlab() {
        let sha = "d013dd471daf6f6672ea035294ab4f01282f9c38";
        assert!(merge(&target(Kind::MergeRequest), "rebase", sha).unwrap_err().contains("rebasing"));
        assert!(merge(&target(Kind::MergeRequest), "ff", sha).unwrap_err().contains("not a merge method"));
        assert!(merge(&target(Kind::MergeRequest), "merge", "HEAD").unwrap_err().contains("again"));
        assert!(merge(&target(Kind::Issue), "merge", sha).unwrap_err().contains("issue"));
    }

    #[test]
    fn finds_the_merge_request_glab_created() {
        let f = forge("git.corp.io", "team/sub", "app");
        let printed = "\nCreating merge request for feat/x into main in team/sub/app\n\n!12 feat: x (feat/x)\n https://git.corp.io/team/sub/app/-/merge_requests/12\n";
        assert_eq!(created_target(printed, &f, known), Some(target(Kind::MergeRequest)));
        let exists = "failed to create merge request: 409 Conflict {message: [Another open merge request already exists for this source branch: !7]}";
        assert_eq!(created_target(exists, &f, known).map(|t| t.iid), Some(7));
        assert!(created_target("Creating merge request for feat/x into main\n", &f, known).is_none());
        assert!(created_target("https://evil.example.com/a/b/-/merge_requests/3", &f, known).is_none(), "unknown server");
        assert!(created_target("https://gitlab.com/a/b/-/issues/3", &f, known).is_none());
    }

    #[test]
    fn parses_job_links() {
        let (f, id) = parse_job_url("https://gitlab.com/group/sub/proj/-/jobs/8123456789?foo=1").unwrap();
        assert_eq!((f.host.as_str(), f.full_path().as_str(), id), ("gitlab.com", "group/sub/proj", 8123456789));
        assert!(is_job_url("https://gitlab.com/g/p/-/jobs/1"));
        for bad in [
            "",
            "https://gitlab.com/g/p/-/jobs/",
            "https://gitlab.com/g/p/-/jobs/x",
            "https://gitlab.com/g/p/-/jobs/0",
            "https://gitlab.com/g/p/-/pipelines/1",
            "https://gitlab.com/p/-/jobs/1",
            "https://gitlab.com/../p/-/jobs/1",
            "https://gitlab.com/g/.p/-/jobs/1",
            "ftp://gitlab.com/g/p/-/jobs/1",
        ] {
            assert!(parse_job_url(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(job("https://evil.example.com/g/p/-/jobs/1", known).unwrap_err().contains("Settings > Git hosting"));
    }

    #[test]
    fn job_states() {
        assert_eq!(run_state("running"), "pending");
        assert_eq!(run_state("created"), "queued");
        assert_eq!(run_state("waiting_for_resource"), "queued");
        assert_eq!(run_state("success"), "success");
        assert_eq!(run_state("failed"), "failure");
        assert_eq!(run_state("canceled"), "cancelled");
        assert_eq!(run_state("skipped"), "skipped");
        assert_eq!(run_state("manual"), "neutral");
        let v = json!({ "id": 9, "name": "test", "stage": "test", "status": "failed",
            "web_url": "https://gitlab.com/g/p/-/jobs/9", "started_at": "2026-11-16T20:29:33.000Z", "finished_at": null });
        let job = job_from_json(&v, "https://gitlab.com/g/p/-/jobs/9");
        assert_eq!((job.provider, job.id, job.state, job.workflow.as_deref()), ("gitlab", 9, "failure", Some("test")));
        assert_eq!(job.started_at.as_deref(), Some("2026-11-16T20:29:33.000Z"));
    }

    #[test]
    fn epoch_to_iso() {
        assert_eq!(iso_from_epoch(0), "1970-01-01T00:00:00Z");
        let t = crate::github::epoch_seconds("2026-11-16T20:29:33Z").unwrap();
        assert_eq!(iso_from_epoch(t), "2026-11-16T20:29:33Z");
        let leap = crate::github::epoch_seconds("2024-02-29T23:59:59Z").unwrap();
        assert_eq!(iso_from_epoch(leap), "2024-02-29T23:59:59Z");
    }

    const E: &str = "\u{1b}[0K";

    fn trace() -> String {
        [
            "\u{1b}[0KRunning with gitlab-runner 17.5.0 (abc)\u{1b}[0;m",
            "  on runner-1 xyz",
            &format!("section_start:1763324973:prepare_executor\r{E}{E}\u{1b}[36;1mPreparing the \"docker\" executor\u{1b}[0;m"),
            "Using Docker executor with image node:24 ...",
            &format!("section_end:1763324975:prepare_executor\r{E}section_start:1763324975:get_sources\r{E}{E}\u{1b}[36;1mGetting source from Git repository\u{1b}[0;m"),
            "Fetching changes with git depth set to 20...",
            &format!("section_end:1763324976:get_sources\r{E}"),
            &format!("section_start:1763324976:step_script\r{E}{E}\u{1b}[36;1mExecuting \"step_script\" stage of the job script\u{1b}[0;m"),
            "\u{1b}[32;1m$ pnpm install\u{1b}[0;m",
            &format!("section_start:1763324977:deps[collapsed=true]\r{E}Install dependencies"),
            "progress 10%\rprogress 50%\rprogress 100%",
            &format!("section_end:1763324979:deps\r{E}"),
            "",
            "\u{1b}[31mFAIL\u{1b}[0m one test",
            &format!("section_end:1763324980:step_script\r{E}"),
            &format!("section_start:1763324980:cleanup_file_variables\r{E}{E}\u{1b}[36;1mCleaning up project directory and file based variables\u{1b}[0;m"),
            &format!("section_end:1763324981:cleanup_file_variables\r{E}"),
            "\u{1b}[31;1mERROR: Job failed: exit code 1",
            "\u{1b}[0;m",
        ]
        .join("\n")
    }

    #[test]
    fn splits_a_trace_into_sections() {
        let steps = split_trace(&trace(), "failure");
        let names: Vec<_> = steps.iter().map(|s| (s.number, s.name.as_str(), s.state)).collect();
        assert_eq!(
            names,
            [
                (1, "Runner", "success"),
                (2, "Preparing the \"docker\" executor", "success"),
                (3, "Getting source from Git repository", "success"),
                (4, "Executing \"step_script\" stage of the job script", "failure"),
                (5, "Cleaning up project directory and file based variables", "success"),
                (6, "Result", "failure"),
            ]
        );
        assert_eq!(steps[0].lines, ["Running with gitlab-runner 17.5.0 (abc)\u{1b}[0;m", "  on runner-1 xyz"]);
        assert_eq!(steps[1].lines, ["Using Docker executor with image node:24 ..."]);
        assert_eq!(steps[1].started_at.as_deref(), Some(iso_from_epoch(1763324973).as_str()));
        assert_eq!(steps[1].completed_at.as_deref(), Some(iso_from_epoch(1763324975).as_str()));
        assert_eq!(
            steps[3].lines,
            [
                "\u{1b}[32;1m$ pnpm install\u{1b}[0;m",
                "##[group]Install dependencies",
                "progress 100%",
                "##[endgroup]",
                "",
                "\u{1b}[31mFAIL\u{1b}[0m one test",
            ]
        );
        assert!(steps[4].lines.is_empty());
        assert_eq!(steps[5].lines, ["\u{1b}[31;1mERROR: Job failed: exit code 1", "\u{1b}[0;m"]);
        assert!(steps.iter().all(|s| s.lines.iter().all(|l| !l.contains("section_") && !l.contains('\r'))));

        let ok = split_trace(&trace(), "success");
        assert!(ok.iter().all(|s| s.state == "success"));
    }

    #[test]
    fn a_running_trace_and_timestamps() {
        let log = format!(
            "2026-11-16T20:29:33.100000Z 00O Running with gitlab-runner 17.5.0\n\
             2026-11-16T20:29:33.200000Z 00O section_start:1763324973:step_script\r{E}Executing script\n\
             2026-11-16T20:29:34.000000Z 01E half a \n\
             2026-11-16T20:29:34.100000Z 01E+line\n\
             2026-11-16T20:29:35.000000Z 00O still going"
        );
        let steps = split_trace(&log, "pending");
        let names: Vec<_> = steps.iter().map(|s| (s.name.as_str(), s.state)).collect();
        assert_eq!(names, [("Runner", "success"), ("Executing script", "pending")]);
        assert_eq!(steps[1].lines, ["half a line", "still going"]);
        assert!(steps[1].completed_at.is_none());

        let cut = split_trace(&log, "cancelled");
        assert_eq!(cut[1].state, "cancelled");
        assert!(split_trace("", "success").is_empty());
    }

    #[test]
    fn ignores_what_only_looks_like_a_marker() {
        let steps = split_trace("echo section_start:abc:x\nsection_end:1:not ours\r\x1b[0K\n", "success");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].lines, ["echo section_start:abc:x", "section_end:1:not ours"]);
    }

    #[test]
    fn a_long_section_keeps_its_end() {
        let mut log = format!("section_start:1:s\r{E}S\n");
        for i in 0..STEP_LINES + 3 {
            log.push_str(&format!("line {i}\n"));
        }
        log.push_str(&format!("section_end:2:s\r{E}\n"));
        let steps = split_trace(&log, "success");
        assert_eq!((steps[0].omitted, steps[0].lines.len()), (3, STEP_LINES));
        assert_eq!(steps[0].lines[0], "line 3");
    }
}
