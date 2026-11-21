//! The Releases tool window: a project's GitHub releases and the GitHub Actions runs that build
//! them, read through the GitHub CLI (`gh`) like the pull requests in `github.rs`. `gh` owns the
//! sign-in; Mango never sees a token. Which run belongs to which release is worked out by the
//! frontend (`app/utils/releaseRuns.ts`) from what is read here.

use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::git::blocking;
use crate::github::{gh, project_repo, run_json, run_ok, run_state, some_text, text, GhAuthor, NO_REPO};

/// How many releases the window lists at most ("Show older" asks for more, up to this).
const MAX_RELEASES: u32 = 100;
/// Recent workflow runs read to find the ones building releases.
const RECENT_RUNS: u32 = 50;

const NO_GITHUB: &str = "This project has no GitHub remote, so it has no releases to show.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAsset {
    pub name: String,
    pub size: u64,
    pub downloads: u64,
    /// Where it downloads from.
    pub url: String,
    /// "uploaded", or "starter" while an upload is still under way.
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRelease {
    pub id: u64,
    pub tag: String,
    /// Its title; GitHub shows the tag when it has none.
    pub name: String,
    pub draft: bool,
    pub prerelease: bool,
    /// The release's page on GitHub.
    pub url: String,
    pub author: Option<GhAuthor>,
    pub created_at: String,
    pub published_at: Option<String>,
    /// The branch or commit the tag was made from.
    pub target: String,
    /// The notes as GitHub renders them. Untrusted: the webview sanitises them before showing them.
    pub body_html: String,
    pub assets: Vec<GhAsset>,
}

/// One GitHub Actions workflow run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRun {
    pub id: u64,
    pub workflow_id: u64,
    /// The workflow's name.
    pub workflow: String,
    /// What GitHub titles the run: the head commit's subject for a push.
    pub title: String,
    /// "push", "release", "workflow_dispatch", …
    pub event: String,
    /// The branch, or for a tag push the tag.
    pub head_branch: Option<String>,
    pub head_sha: String,
    /// "success", "failure", "pending" (running), "queued", "cancelled", "skipped" or "neutral".
    pub state: &'static str,
    pub url: String,
    pub number: u64,
    pub attempt: u64,
    pub created_at: String,
    pub started_at: Option<String>,
    /// For a finished run, about when it finished.
    pub updated_at: String,
}

/// One job of a run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRunJob {
    pub id: u64,
    pub name: String,
    pub state: &'static str,
    /// Its page, `…/actions/runs/<run>/job/<job>`: `gh_job` reads its log from there.
    pub url: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRunDetail {
    pub run: GhRun,
    pub jobs: Vec<GhRunJob>,
}

/// A repository's releases, newest first, and its recent workflow runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhReleases {
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub releases: Vec<GhRelease>,
    pub runs: Vec<GhRun>,
}

struct Repo {
    host: String,
    owner: String,
    repo: String,
}

fn repo_of(app: &AppHandle, path: &str) -> Result<Repo, String> {
    let (host, owner, repo) = project_repo(app, path).map_err(|e| if e.starts_with(NO_REPO) { NO_GITHUB.to_string() } else { e })?;
    Ok(Repo { host, owner, repo })
}

/// `gh api` against the repository; `tail` is the path after `repos/<owner>/<repo>/`.
fn api(r: &Repo, tail: &str) -> Command {
    let mut cmd = gh(None);
    cmd.arg("api");
    if r.host != "github.com" {
        cmd.args(["--hostname", &r.host]);
    }
    cmd.arg(format!("repos/{}/{}/{tail}", r.owner, r.repo));
    cmd
}

fn not_found(e: String, what: &str) -> String {
    if e.contains("(HTTP 404)") || e.contains("Not Found") {
        format!("GitHub has no {what}, or the account gh is signed in with cannot see it.")
    } else {
        e
    }
}

fn asset_from_json(a: &Value) -> Option<GhAsset> {
    let url = a["browser_download_url"].as_str().filter(|u| u.starts_with("https://"))?.to_string();
    Some(GhAsset {
        name: text(&a["name"]),
        size: a["size"].as_u64().unwrap_or(0),
        downloads: a["download_count"].as_u64().unwrap_or(0),
        url,
        state: a["state"].as_str().unwrap_or("uploaded").to_string(),
    })
}

fn release_from_json(v: &Value) -> Option<GhRelease> {
    let tag = text(&v["tag_name"]);
    let url = v["html_url"].as_str().filter(|u| u.starts_with("https://"))?.to_string();
    if tag.is_empty() {
        return None;
    }
    let name = some_text(&v["name"]).map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| tag.clone());
    let author = v["author"]["login"].as_str().map(|login| GhAuthor {
        login: login.to_string(),
        avatar_url: some_text(&v["author"]["avatar_url"]),
    });
    let assets = v["assets"].as_array().map(|a| a.iter().filter_map(asset_from_json).collect()).unwrap_or_default();
    Some(GhRelease {
        id: v["id"].as_u64().unwrap_or(0),
        tag,
        name,
        draft: v["draft"].as_bool().unwrap_or(false),
        prerelease: v["prerelease"].as_bool().unwrap_or(false),
        url,
        author,
        created_at: text(&v["created_at"]),
        published_at: some_text(&v["published_at"]),
        target: text(&v["target_commitish"]),
        body_html: text(&v["body_html"]),
        assets,
    })
}

fn run_from_json(v: &Value) -> Option<GhRun> {
    let id = v["id"].as_u64().filter(|n| *n > 0)?;
    let url = v["html_url"].as_str().filter(|u| u.starts_with("https://"))?.to_string();
    Some(GhRun {
        id,
        workflow_id: v["workflow_id"].as_u64().unwrap_or(0),
        workflow: text(&v["name"]),
        title: text(&v["display_title"]),
        event: text(&v["event"]),
        head_branch: some_text(&v["head_branch"]),
        head_sha: text(&v["head_sha"]),
        state: run_state(v["status"].as_str(), v["conclusion"].as_str()),
        url,
        number: v["run_number"].as_u64().unwrap_or(0),
        attempt: v["run_attempt"].as_u64().unwrap_or(1),
        created_at: text(&v["created_at"]),
        started_at: some_text(&v["run_started_at"]),
        updated_at: text(&v["updated_at"]),
    })
}

fn runs_from_json(v: &Value) -> Vec<GhRun> {
    v["workflow_runs"].as_array().map(|a| a.iter().filter_map(run_from_json).collect()).unwrap_or_default()
}

fn jobs_from_json(v: &Value) -> Vec<GhRunJob> {
    v["jobs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|j| {
                    Some(GhRunJob {
                        id: j["id"].as_u64().filter(|n| *n > 0)?,
                        name: text(&j["name"]),
                        state: run_state(j["status"].as_str(), j["conclusion"].as_str()),
                        url: j["html_url"].as_str().filter(|u| u.starts_with("https://"))?.to_string(),
                        started_at: some_text(&j["started_at"]),
                        completed_at: some_text(&j["completed_at"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn releases(r: Repo, count: u32) -> Result<GhReleases, String> {
    let count = count.clamp(1, MAX_RELEASES);
    let mut list = api(&r, &format!("releases?per_page={count}"));
    // Notes rendered by GitHub, like a pull request's description.
    list.args(["-H", "Accept: application/vnd.github.html+json"]);
    let runs = api(&r, &format!("actions/runs?per_page={RECENT_RUNS}"));
    // Two reads at once: each is a round trip to GitHub.
    let (list, runs) = std::thread::scope(|s| {
        let runs = s.spawn(move || run_json(runs));
        (run_json(list), runs.join().unwrap_or_else(|_| Err("Reading the workflow runs failed.".into())))
    });
    let list = list.map_err(|e| not_found(e, &format!("repository {}/{}", r.owner, r.repo)))?;
    let releases = list.as_array().map(|a| a.iter().filter_map(release_from_json).collect()).unwrap_or_default();
    // A repository without Actions (or one gh may not read them in) still lists its releases.
    let runs = runs.map(|v| runs_from_json(&v)).unwrap_or_default();
    Ok(GhReleases { host: r.host, owner: r.owner, repo: r.repo, releases, runs })
}

fn jobs_of(r: &Repo, run: GhRun) -> Result<GhRunDetail, String> {
    let v = run_json(api(r, &format!("actions/runs/{}/jobs?per_page=100", run.id)))
        .map_err(|e| not_found(e, &format!("workflow run {}", run.id)))?;
    Ok(GhRunDetail { run, jobs: jobs_from_json(&v) })
}

/// The newest run for a tag (its push, or its release being published), with its jobs.
fn tag_run(r: Repo, tag: &str) -> Result<Option<GhRunDetail>, String> {
    let tag = crate::git::safe_ref(tag)?;
    let mut cmd = api(&r, "actions/runs");
    // `-f` sends the value as a plain string (never a file), as a query parameter with GET.
    cmd.args(["-X", "GET", "-F", "per_page=10", "-f"]).arg(format!("branch={tag}"));
    let runs = runs_from_json(&run_json(cmd)?);
    let newest = runs
        .into_iter()
        .filter(|run| run.head_branch.as_deref() == Some(tag) && matches!(run.event.as_str(), "push" | "release" | "workflow_dispatch"))
        .max_by(|a, b| a.created_at.cmp(&b.created_at));
    newest.map(|run| jobs_of(&r, run)).transpose()
}

fn run_detail(r: Repo, id: u64) -> Result<GhRunDetail, String> {
    let v = run_json(api(&r, &format!("actions/runs/{id}"))).map_err(|e| not_found(e, &format!("workflow run {id}")))?;
    let run = run_from_json(&v).ok_or("GitHub answered with something unexpected for that run.")?;
    jobs_of(&r, run)
}

fn run_action(r: Repo, id: u64, action: &str) -> Result<(), String> {
    let tail = match action {
        "rerun-failed" => "rerun-failed-jobs",
        "rerun" => "rerun",
        "cancel" => "cancel",
        _ => return Err(format!("Unknown action on a workflow run: {action}")),
    };
    let mut cmd = api(&r, &format!("actions/runs/{id}/{tail}"));
    cmd.args(["-X", "POST"]);
    run_ok(cmd).map_err(|e| {
        if e.contains("(HTTP 403)") || e.contains("Resource not accessible") {
            "GitHub refused: the account gh is signed in with may not run workflows in this repository.".into()
        } else if e.contains("(HTTP 409)") {
            match action {
                "cancel" => "The run has already finished.".into(),
                _ => "GitHub can't re-run it yet: the run is still going, or it is too old to re-run.".into(),
            }
        } else {
            not_found(e, &format!("workflow run {id}"))
        }
    })
}

fn check_id(id: u64) -> Result<u64, String> {
    if id == 0 { Err("That is not a workflow run.".into()) } else { Ok(id) }
}

/// The GitHub releases of the project at `path` (which may be a remote project), newest first, up
/// to `count`, with the repository's recent workflow runs.
#[tauri::command]
pub async fn gh_releases(app: AppHandle, path: String, count: u32) -> Result<GhReleases, String> {
    blocking(move || releases(repo_of(&app, &path)?, count)).await
}

/// The newest workflow run for a release's tag, with its jobs; none when no workflow ran for it.
#[tauri::command]
pub async fn gh_tag_run(app: AppHandle, path: String, tag: String) -> Result<Option<GhRunDetail>, String> {
    blocking(move || tag_run(repo_of(&app, &path)?, &tag)).await
}

/// A workflow run by id, with its jobs.
#[tauri::command]
pub async fn gh_run(app: AppHandle, path: String, id: u64) -> Result<GhRunDetail, String> {
    blocking(move || run_detail(repo_of(&app, &path)?, check_id(id)?)).await
}

/// Re-run a run's failed jobs (`rerun-failed`), the whole run (`rerun`), or cancel it (`cancel`).
#[tauri::command]
pub async fn gh_run_action(app: AppHandle, path: String, id: u64, action: String) -> Result<(), String> {
    blocking(move || run_action(repo_of(&app, &path)?, check_id(id)?, &action)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_release() {
        let v = json!({
            "id": 7, "tag_name": "v0.1.28", "name": "Mango 0.1.28", "draft": false, "prerelease": false,
            "html_url": "https://github.com/acme/mango/releases/tag/v0.1.28",
            "author": { "login": "github-actions[bot]", "avatar_url": "https://avatars.githubusercontent.com/in/15368" },
            "created_at": "2026-11-21T00:12:30Z", "published_at": "2026-11-21T00:23:45Z", "target_commitish": "main",
            "body_html": "<p>Installers</p>",
            "assets": [
                { "name": "Mango_0.1.28_x64-setup.exe", "size": 11026279, "download_count": 2, "state": "uploaded",
                  "browser_download_url": "https://github.com/acme/mango/releases/download/v0.1.28/Mango_0.1.28_x64-setup.exe" },
                { "name": "bad", "size": 1, "download_count": 0, "browser_download_url": "javascript:alert(1)" }
            ]
        });
        let r = release_from_json(&v).unwrap();
        assert_eq!(r.tag, "v0.1.28");
        assert_eq!(r.name, "Mango 0.1.28");
        assert_eq!(r.author.unwrap().login, "github-actions[bot]");
        assert_eq!(r.published_at.as_deref(), Some("2026-11-21T00:23:45Z"));
        // Only https downloads.
        assert_eq!(r.assets.len(), 1);
        assert_eq!(r.assets[0].size, 11026279);
        assert_eq!(r.assets[0].downloads, 2);
    }

    #[test]
    fn a_release_without_a_title_shows_its_tag_and_drafts_have_no_date() {
        let v = json!({ "id": 8, "tag_name": "v2.0.0", "name": "  ", "draft": true, "published_at": null,
            "html_url": "https://github.com/acme/app/releases/tag/untagged-1", "assets": [] });
        let r = release_from_json(&v).unwrap();
        assert_eq!(r.name, "v2.0.0");
        assert!(r.draft);
        assert_eq!(r.published_at, None);
        assert!(release_from_json(&json!({ "tag_name": "v1", "html_url": "file:///x" })).is_none());
    }

    #[test]
    fn reads_runs_and_their_jobs() {
        let v = json!({ "workflow_runs": [
            { "id": 44842277315u64, "workflow_id": 201, "name": "Release", "display_title": "chore(release): v0.1.28",
              "event": "push", "head_branch": "v0.1.28", "head_sha": "cbcc50f", "status": "in_progress", "conclusion": null,
              "html_url": "https://github.com/acme/mango/actions/runs/44842277315", "run_number": 40, "run_attempt": 1,
              "created_at": "2026-11-21T00:12:41Z", "run_started_at": "2026-11-21T00:12:41Z", "updated_at": "2026-11-21T00:14:00Z" },
            { "id": 2, "workflow_id": 3, "name": "CI", "event": "pull_request", "status": "completed", "conclusion": "failure",
              "html_url": "https://github.com/acme/mango/actions/runs/2" },
            { "id": 0, "html_url": "https://github.com/acme/mango/actions/runs/0" }
        ]});
        let runs = runs_from_json(&v);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].state, "pending");
        assert_eq!(runs[0].head_branch.as_deref(), Some("v0.1.28"));
        assert_eq!(runs[1].state, "failure");
        assert_eq!(runs[1].attempt, 1);

        let jobs = jobs_from_json(&json!({ "jobs": [
            { "id": 9, "name": "Build (Windows x64)", "status": "completed", "conclusion": "success",
              "html_url": "https://github.com/acme/mango/actions/runs/44842277315/job/9",
              "started_at": "2026-11-21T00:13:07Z", "completed_at": "2026-11-21T00:17:45Z" },
            { "id": 10, "name": "Publish release", "status": "queued", "conclusion": null,
              "html_url": "https://github.com/acme/mango/actions/runs/44842277315/job/10" }
        ]}));
        assert_eq!(jobs.len(), 2);
        assert_eq!((jobs[0].state, jobs[1].state), ("success", "queued"));
        assert_eq!(jobs[1].started_at, None);
    }

    #[test]
    fn refuses_unknown_run_actions_and_ids() {
        let r = Repo { host: "github.com".into(), owner: "acme".into(), repo: "app".into() };
        assert!(run_action(r, 1, "delete").unwrap_err().contains("Unknown action"));
        assert!(check_id(0).is_err());
    }

    #[test]
    fn refuses_unsafe_tags_before_asking_github() {
        let r = Repo { host: "github.com".into(), owner: "acme".into(), repo: "app".into() };
        assert!(tag_run(r, "--upload-pack=x").is_err());
    }
}
