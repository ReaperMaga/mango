//! The Releases tool window for a project on a GitLab server: its releases and the CI/CD pipelines
//! that build them, read through the GitLab CLI (`glab api`, which owns the sign-in), in the same
//! shapes as GitHub's (`releases.rs`) so the window reads both alike.
//!
//! How GitLab maps onto those shapes:
//! - A release has no numeric id in the API: `id` is a hash of its tag (`stable_id`), the same on
//!   every read. It has no drafts; an upcoming release (`released_at` still ahead) has no
//!   `published_at` yet. Its files are the release's links (GitLab knows no size or download count,
//!   so both are 0); the source archives GitLab adds to every release are left out, like GitHub's.
//! - A run is a pipeline: `event` is its `source` (`push`, `web`, `api`, `schedule`, `trigger`,
//!   `merge_request_event`, …), `head_branch` its `ref` (the tag for a tag pipeline), `number` its
//!   `iid`. A project has one pipeline configuration, so `workflow_id` sorts pipelines by kind
//!   instead: every tag pipeline shares one id, other pipelines one per source.
//! - Jobs carry their page (`…/-/jobs/<id>`) as `url`, which is where `gh_job` reads a log from.

use std::process::Command;

use serde_json::Value;

use crate::github::{some_text, text, GhAuthor};
use crate::gitlab::{self, Forge};
use crate::releases::{GhAsset, GhRelease, GhReleases, GhRun, GhRunDetail, GhRunJob};

/// How many releases the window lists at most (the same limit as GitHub's).
const MAX_RELEASES: u32 = 100;
/// Recent pipelines read, and as many recent tag pipelines (a busy project's latest pipelines may
/// all be branch and merge request ones, and the release builds would be missed).
const RECENT_RUNS: u32 = 50;

/// A small, stable id for something GitLab names but does not number: FNV-1a of `key`, kept within
/// 53 bits so it survives as a JavaScript number, and never 0.
pub(crate) fn stable_id(key: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h & ((1u64 << 53) - 1)).max(1)
}

/// The `workflow_id` of a pipeline: tag pipelines (the ones that build releases) share one.
fn workflow_id(tag: bool, source: &str) -> u64 {
    if tag { stable_id("tag") } else { stable_id(&format!("source:{source}")) }
}

/// `glab api` on the project; `tail` is the path after `projects/<id>/`.
fn api(f: &Forge, tail: &str) -> Command {
    gitlab::api(&f.host, &format!("{}/{tail}", f.api_project()))
}

fn run_json(f: &Forge, cmd: Command) -> Result<Value, String> {
    gitlab::run_json(cmd, Some(&f.host))
}

/// A link GitLab returned, made absolute on the server and only ever http(s).
fn link(f: &Forge, v: &Value) -> Option<String> {
    v.as_str().and_then(|u| gitlab::absolute_url(&f.host, u))
}

/// A pipeline's or job's `status` in the words the window uses. A pipeline (or job) waiting for
/// someone to start a manual job is not building: it shows as neutral, not as running forever.
pub(crate) fn state(status: &str) -> &'static str {
    match status {
        "success" => "success",
        "failed" => "failure",
        "canceled" | "canceling" => "cancelled",
        "skipped" => "skipped",
        "manual" => "neutral",
        "running" => "pending",
        // created, waiting_for_resource, preparing, pending, scheduled, and anything newer.
        _ => "queued",
    }
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

fn asset_from_json(f: &Forge, a: &Value) -> Option<GhAsset> {
    let url = link(f, &a["direct_asset_url"]).or_else(|| link(f, &a["url"]))?;
    let name = some_text(&a["name"]).unwrap_or_else(|| url.rsplit('/').next().unwrap_or_default().to_string());
    // GitLab knows nothing of a link's size or downloads.
    Some(GhAsset { name, size: 0, downloads: 0, url, state: "uploaded".into() })
}

fn release_from_json(f: &Forge, v: &Value) -> Option<GhRelease> {
    let tag = text(&v["tag_name"]);
    if tag.is_empty() {
        return None;
    }
    let url = link(f, &v["_links"]["self"])
        .unwrap_or_else(|| format!("https://{}/{}/-/releases/{}", f.host, f.full_path(), gitlab::encode_path(&tag)));
    let name = some_text(&v["name"]).map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| tag.clone());
    let author = v["author"]["username"].as_str().filter(|s| !s.is_empty()).map(|login| GhAuthor {
        login: login.to_string(),
        avatar_url: link(f, &v["author"]["avatar_url"]),
    });
    let upcoming = v["upcoming_release"].as_bool().unwrap_or(false);
    let target = some_text(&v["commit"]["short_id"])
        .or_else(|| some_text(&v["commit"]["id"]).map(|id| id.chars().take(8).collect()))
        .unwrap_or_default();
    let assets = v["assets"]["links"].as_array().map(|a| a.iter().filter_map(|l| asset_from_json(f, l)).collect()).unwrap_or_default();
    Some(GhRelease {
        id: stable_id(&format!("release:{tag}")),
        tag,
        name,
        draft: false,
        // GitLab has no pre-releases.
        prerelease: false,
        url,
        author,
        created_at: text(&v["created_at"]),
        published_at: if upcoming { None } else { some_text(&v["released_at"]) },
        target,
        body_html: text(&v["description_html"]),
        assets,
    })
}

/// The commit titles a release list names, by full sha, for titling pipelines (GitLab's pipeline
/// list carries no commit).
fn commit_titles(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| Some((some_text(&r["commit"]["id"])?, some_text(&r["commit"]["title"])?)))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Pipelines and jobs
// ---------------------------------------------------------------------------

/// One pipeline, from the list or read alone. `tag`: whether it ran for a tag (the list does not
/// say; the caller knows from the scope it asked for, a single pipeline says so itself).
fn run_from_json(f: &Forge, v: &Value, tag: bool) -> Option<GhRun> {
    let id = v["id"].as_u64().filter(|n| *n > 0)?;
    let url = link(f, &v["web_url"])?;
    let tag = tag || v["tag"].as_bool().unwrap_or(false);
    let source = text(&v["source"]);
    let name = some_text(&v["name"]).map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    Some(GhRun {
        id,
        workflow_id: workflow_id(tag, &source),
        workflow: name.unwrap_or_else(|| "Pipeline".into()),
        title: String::new(),
        event: source,
        head_branch: some_text(&v["ref"]),
        head_sha: text(&v["sha"]),
        state: state(v["status"].as_str().unwrap_or_default()),
        url,
        number: v["iid"].as_u64().unwrap_or(0),
        attempt: 1,
        created_at: text(&v["created_at"]),
        started_at: some_text(&v["started_at"]),
        updated_at: some_text(&v["finished_at"]).unwrap_or_else(|| text(&v["updated_at"])),
    })
}

fn runs_from_json(f: &Forge, v: &Value, tag: bool) -> Vec<GhRun> {
    v.as_array().map(|a| a.iter().filter_map(|p| run_from_json(f, p, tag)).collect()).unwrap_or_default()
}

/// Recent pipelines and recent tag pipelines as one list, newest first, each once (a pipeline in
/// both counts as a tag pipeline), titled from the releases' commits where they match.
fn merge_runs(recent: Vec<GhRun>, tags: Vec<GhRun>, titles: &[(String, String)]) -> Vec<GhRun> {
    let mut runs = tags;
    for run in recent {
        if !runs.iter().any(|r| r.id == run.id) {
            runs.push(run);
        }
    }
    for run in &mut runs {
        if let Some((_, title)) = titles.iter().find(|(sha, _)| *sha == run.head_sha) {
            run.title = title.clone();
        }
    }
    runs.sort_by(|a, b| b.id.cmp(&a.id));
    runs
}

/// A job that may fail without failing its pipeline counts as neutral when it does, so the window
/// does not name it as what broke.
fn job_from_json(f: &Forge, j: &Value) -> Option<GhRunJob> {
    let status = j["status"].as_str().unwrap_or_default();
    let state = if status == "failed" && j["allow_failure"].as_bool() == Some(true) { "neutral" } else { state(status) };
    Some(GhRunJob {
        id: j["id"].as_u64().filter(|n| *n > 0)?,
        name: text(&j["name"]),
        state,
        url: link(f, &j["web_url"])?,
        started_at: some_text(&j["started_at"]),
        completed_at: some_text(&j["finished_at"]),
    })
}

fn jobs_from_json(f: &Forge, v: &Value) -> Vec<GhRunJob> {
    v.as_array().map(|a| a.iter().filter_map(|j| job_from_json(f, j)).collect()).unwrap_or_default()
}

/// The commit title the jobs carry (each job names its pipeline's commit).
fn title_from_jobs(v: &Value) -> Option<String> {
    v.as_array()?.iter().find_map(|j| some_text(&j["commit"]["title"]))
}

// ---------------------------------------------------------------------------
// What the commands do
// ---------------------------------------------------------------------------

pub(crate) fn releases(f: Forge, count: u32) -> Result<GhReleases, String> {
    let count = count.clamp(1, MAX_RELEASES);
    let list = api(&f, &format!("releases?per_page={count}&include_html_description=true"));
    let recent = api(&f, &format!("pipelines?per_page={RECENT_RUNS}"));
    let tags = api(&f, &format!("pipelines?scope=tags&per_page={RECENT_RUNS}"));
    // Three reads at once: each is a round trip to the server.
    let (list, recent, tags) = std::thread::scope(|s| {
        let recent = s.spawn(|| run_json(&f, recent));
        let tags = s.spawn(|| run_json(&f, tags));
        let failed = || Err::<Value, String>("Reading the pipelines failed.".into());
        (run_json(&f, list), recent.join().unwrap_or_else(|_| failed()), tags.join().unwrap_or_else(|_| failed()))
    });
    let list = list?;
    let releases = list.as_array().map(|a| a.iter().filter_map(|r| release_from_json(&f, r)).collect()).unwrap_or_default();
    // A project without CI/CD (or one the account may not see the pipelines of) still lists its releases.
    let recent = recent.map(|v| runs_from_json(&f, &v, false)).unwrap_or_default();
    let tags = tags.map(|v| runs_from_json(&f, &v, true)).unwrap_or_default();
    let runs = merge_runs(recent, tags, &commit_titles(&list));
    Ok(GhReleases { provider: f.provider.id(), host: f.host, owner: f.owner, repo: f.repo, releases, runs })
}

/// A pipeline by id, with its jobs (the ones that count: no retried ones).
pub(crate) fn run_detail(f: Forge, id: u64) -> Result<GhRunDetail, String> {
    let one = api(&f, &format!("pipelines/{id}"));
    let jobs = api(&f, &format!("pipelines/{id}/jobs?per_page=100&include_retried=false"));
    let (one, jobs) = std::thread::scope(|s| {
        let jobs = s.spawn(|| run_json(&f, jobs));
        (run_json(&f, one), jobs.join().unwrap_or_else(|_| Err("Reading the pipeline's jobs failed.".into())))
    });
    let mut run = run_from_json(&f, &one?, false).ok_or("GitLab answered with something unexpected for that pipeline.")?;
    let jobs = jobs?;
    if let Some(title) = title_from_jobs(&jobs) {
        run.title = title;
    }
    Ok(GhRunDetail { run, jobs: jobs_from_json(&f, &jobs) })
}

/// The newest pipeline that ran for a tag, with its jobs; None when none did.
pub(crate) fn tag_run(f: Forge, tag: &str) -> Result<Option<GhRunDetail>, String> {
    let tag = crate::git::safe_ref(tag)?;
    let v = run_json(&f, api(&f, &format!("pipelines?scope=tags&ref={}&per_page=1", gitlab::encode_path(tag))))?;
    let newest = runs_from_json(&f, &v, true).into_iter().filter(|r| r.head_branch.as_deref() == Some(tag)).max_by_key(|r| r.id);
    newest.map(|run| run_detail(f, run.id)).transpose()
}

/// A ref a new pipeline may run for: a branch or tag name, never a merge request's ref.
fn pipeline_ref(r: &str) -> Result<&str, String> {
    let r = crate::git::safe_ref(r)?;
    if r.starts_with("refs/") {
        return Err("GitLab can only start a new pipeline for a branch or a tag, not for this one. Run it again from its merge request.".into());
    }
    Ok(r)
}

/// `rerun-failed` retries the pipeline's failed and canceled jobs in place. `rerun` starts a new
/// pipeline for the same branch or tag (GitLab cannot run a whole pipeline again in place; its
/// own "Run pipeline" button does the same), without the variables the old one was started with.
/// `cancel` cancels its jobs that have not finished.
pub(crate) fn run_action(f: Forge, id: u64, action: &str) -> Result<(), String> {
    let mut cmd = match action {
        "rerun-failed" => api(&f, &format!("pipelines/{id}/retry")),
        "cancel" => api(&f, &format!("pipelines/{id}/cancel")),
        "rerun" => {
            let one = run_json(&f, api(&f, &format!("pipelines/{id}")))?;
            let r = one["ref"].as_str().unwrap_or_default();
            let r = pipeline_ref(r)?;
            let mut cmd = api(&f, "pipeline");
            // `-f` sends the value as a plain string, never a file.
            cmd.arg("-f").arg(format!("ref={r}"));
            cmd
        }
        _ => return Err(format!("Unknown action on a pipeline: {action}")),
    };
    cmd.args(["--method", "POST"]);
    gitlab::run_ok(cmd, Some(&f.host)).map_err(|e| {
        let lower = e.to_lowercase();
        if lower.contains("403") || lower.contains("forbidden") {
            "GitLab refused: the account glab is signed in with may not run pipelines in this project.".into()
        } else if lower.contains("409") {
            "GitLab is already retrying this pipeline.".into()
        } else if lower.contains("400") && action == "rerun" {
            format!("GitLab could not start a new pipeline: {e}")
        } else {
            e
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitlab::Provider;
    use serde_json::json;

    fn forge() -> Forge {
        Forge { provider: Provider::GitLab, host: "gitlab.example.com".into(), owner: "acme/apps".into(), repo: "mango".into() }
    }

    #[test]
    fn stable_ids_fit_javascript_and_do_not_change() {
        assert_eq!(stable_id("release:v1.0.0"), stable_id("release:v1.0.0"));
        assert_ne!(stable_id("release:v1.0.0"), stable_id("release:v1.0.1"));
        for k in ["", "tag", "release:v0.1.28", "source:push"] {
            let id = stable_id(k);
            assert!(id > 0 && id < (1u64 << 53), "{k}: {id}");
        }
        assert_ne!(workflow_id(true, "push"), workflow_id(false, "push"));
        assert_eq!(workflow_id(true, "push"), workflow_id(true, "api"), "every tag pipeline is the release workflow");
    }

    #[test]
    fn reads_a_release() {
        let v = json!({
            "tag_name": "v0.2", "name": "Awesome app v0.2 beta", "description": "## CHANGELOG",
            "description_html": "<h2 data-sourcepos=\"1:1-1:12\" dir=\"auto\">CHANGELOG</h2>",
            "created_at": "2019-01-03T01:56:19.539Z", "released_at": "2019-01-03T01:56:19.539Z",
            "upcoming_release": false,
            "author": { "id": 1, "name": "Administrator", "username": "root", "state": "active",
                "avatar_url": "https://www.gravatar.com/avatar/e64c7d89f26bd1972efa854d13d7dd61?s=80&d=identicon",
                "web_url": "https://gitlab.example.com/root" },
            "commit": { "id": "079e90101242458910cccd35eab0e211dfc359c0", "short_id": "079e9010",
                "title": "Update README.md", "created_at": "2019-01-03T01:55:38.000Z" },
            "commit_path": "/root/awesome-app/commit/079e90101242458910cccd35eab0e211dfc359c0",
            "tag_path": "/root/awesome-app/-/tags/v0.2",
            "assets": {
                "count": 6,
                "sources": [ { "format": "zip", "url": "https://gitlab.example.com/root/awesome-app/-/archive/v0.2/awesome-app-v0.2.zip" } ],
                "links": [
                    { "id": 2, "name": "awesome-v0.2.msi", "url": "http://192.168.10.15:3000/msi", "link_type": "other",
                      "direct_asset_url": "https://gitlab.example.com/root/awesome-app/-/releases/v0.2/downloads/awesome-v0.2.msi" },
                    { "id": 1, "name": "awesome-v0.2.dmg", "url": "http://192.168.10.15:3000", "link_type": "package" },
                    { "id": 3, "name": "evil", "url": "javascript:alert(1)" }
                ],
                "evidence_file_path": "https://gitlab.example.com/root/awesome-app/-/releases/v0.2/evidence.json"
            },
            "_links": { "self": "https://gitlab.example.com/root/awesome-app/-/releases/v0.2",
                "edit_url": "https://gitlab.example.com/root/awesome-app/-/releases/v0.2/edit" }
        });
        let r = release_from_json(&forge(), &v).unwrap();
        assert_eq!(r.tag, "v0.2");
        assert_eq!(r.name, "Awesome app v0.2 beta");
        assert_eq!(r.id, stable_id("release:v0.2"));
        assert!(!r.draft && !r.prerelease);
        assert_eq!(r.url, "https://gitlab.example.com/root/awesome-app/-/releases/v0.2");
        let a = r.author.unwrap();
        assert_eq!(a.login, "root");
        assert!(a.avatar_url.unwrap().starts_with("https://www.gravatar.com/"));
        assert_eq!(r.published_at.as_deref(), Some("2019-01-03T01:56:19.539Z"));
        assert_eq!(r.target, "079e9010");
        assert!(r.body_html.starts_with("<h2"));
        // Links only, the direct asset URL first, only http(s); the source archives are left out.
        assert_eq!(r.assets.len(), 2);
        assert_eq!(r.assets[0].url, "https://gitlab.example.com/root/awesome-app/-/releases/v0.2/downloads/awesome-v0.2.msi");
        assert_eq!(r.assets[1].url, "http://192.168.10.15:3000");
        assert_eq!((r.assets[0].size, r.assets[0].downloads, r.assets[0].state.as_str()), (0, 0, "uploaded"));
    }

    #[test]
    fn an_upcoming_release_is_not_published_and_a_bare_one_still_reads() {
        let v = json!({ "tag_name": "v3.0.0", "name": null, "upcoming_release": true,
            "created_at": "2026-11-20T10:00:00.000Z", "released_at": "2026-12-24T10:00:00.000Z",
            "author": { "username": "jane", "avatar_url": "/uploads/-/system/user/avatar/5/avatar.png" },
            "commit": { "id": "4b1d2c3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c" } });
        let r = release_from_json(&forge(), &v).unwrap();
        assert_eq!(r.name, "v3.0.0");
        assert_eq!(r.published_at, None);
        assert_eq!(r.target, "4b1d2c3e");
        assert_eq!(r.url, "https://gitlab.example.com/acme/apps/mango/-/releases/v3.0.0");
        assert_eq!(
            r.author.unwrap().avatar_url.as_deref(),
            Some("https://gitlab.example.com/uploads/-/system/user/avatar/5/avatar.png")
        );
        assert!(r.assets.is_empty());
        assert!(release_from_json(&forge(), &json!({ "name": "no tag" })).is_none());
    }

    #[test]
    fn maps_pipeline_and_job_states() {
        for (gl, ours) in [
            ("created", "queued"),
            ("waiting_for_resource", "queued"),
            ("preparing", "queued"),
            ("pending", "queued"),
            ("scheduled", "queued"),
            ("running", "pending"),
            ("success", "success"),
            ("failed", "failure"),
            ("canceled", "cancelled"),
            ("canceling", "cancelled"),
            ("skipped", "skipped"),
            ("manual", "neutral"),
        ] {
            assert_eq!(state(gl), ours, "{gl}");
        }
    }

    #[test]
    fn reads_pipelines_and_titles_them_from_releases() {
        let f = forge();
        let recent = json!([
            { "id": 47, "iid": 12, "project_id": 1, "status": "running", "source": "push", "ref": "main",
              "sha": "a91957a858320c0e17f3a0eca7cfacbff50ea29a", "name": null,
              "web_url": "https://gitlab.example.com/acme/apps/mango/-/pipelines/47",
              "created_at": "2026-11-21T00:12:41.123Z", "updated_at": "2026-11-21T00:14:00.456Z" },
            { "id": 46, "iid": 11, "status": "success", "source": "push", "ref": "v0.2",
              "sha": "079e90101242458910cccd35eab0e211dfc359c0", "name": "Release",
              "web_url": "https://gitlab.example.com/acme/apps/mango/-/pipelines/46",
              "created_at": "2026-11-20T00:12:41.123Z", "updated_at": "2026-11-20T00:20:00.000Z" },
            { "id": 45, "iid": 10, "status": "failed", "source": "merge_request_event", "ref": "refs/merge-requests/3/head",
              "sha": "b", "web_url": "javascript:alert(1)" },
            { "id": 0, "web_url": "https://gitlab.example.com/acme/apps/mango/-/pipelines/0" }
        ]);
        let tags = json!([
            { "id": 46, "iid": 11, "status": "success", "source": "push", "ref": "v0.2",
              "sha": "079e90101242458910cccd35eab0e211dfc359c0", "name": "Release",
              "web_url": "https://gitlab.example.com/acme/apps/mango/-/pipelines/46",
              "created_at": "2026-11-20T00:12:41.123Z", "updated_at": "2026-11-20T00:20:00.000Z" },
            { "id": 30, "iid": 5, "status": "manual", "source": "web", "ref": "v0.1",
              "sha": "c", "web_url": "https://gitlab.example.com/acme/apps/mango/-/pipelines/30",
              "created_at": "2026-10-01T00:00:00.000Z", "updated_at": "2026-10-01T00:10:00.000Z" }
        ]);
        let titles = commit_titles(&json!([
            { "tag_name": "v0.2", "commit": { "id": "079e90101242458910cccd35eab0e211dfc359c0", "title": "chore(release): v0.2" } }
        ]));
        let runs = merge_runs(runs_from_json(&f, &recent, false), runs_from_json(&f, &tags, true), &titles);
        assert_eq!(runs.iter().map(|r| r.id).collect::<Vec<_>>(), vec![47, 46, 30]);
        let (main, release, manual) = (&runs[0], &runs[1], &runs[2]);
        assert_eq!((main.state, main.event.as_str(), main.workflow.as_str()), ("pending", "push", "Pipeline"));
        assert_eq!(main.head_branch.as_deref(), Some("main"));
        assert_eq!((main.number, main.attempt), (12, 1));
        assert_eq!(main.title, "");
        assert_eq!(release.workflow, "Release");
        assert_eq!(release.title, "chore(release): v0.2");
        assert_eq!(release.head_branch.as_deref(), Some("v0.2"));
        // Tag pipelines share the release workflow, whatever started them; a branch pipeline does not.
        assert_eq!(release.workflow_id, manual.workflow_id);
        assert_ne!(release.workflow_id, main.workflow_id);
        assert_eq!((manual.state, manual.event.as_str()), ("neutral", "web"));
    }

    #[test]
    fn reads_one_pipeline_and_its_jobs() {
        let f = forge();
        let one = json!({ "id": 46, "iid": 11, "project_id": 1, "name": "Build pipeline", "status": "failed",
            "source": "push", "ref": "v0.2", "sha": "079e9010", "before_sha": "0000000000000000000000000000000000000000",
            "tag": true, "yaml_errors": null, "user": { "username": "root" },
            "created_at": "2026-11-20T00:12:41.123Z", "updated_at": "2026-11-20T00:30:00.000Z",
            "started_at": "2026-11-20T00:12:45.000Z", "finished_at": "2026-11-20T00:20:00.000Z",
            "duration": 435, "queued_duration": 4, "coverage": null,
            "web_url": "https://gitlab.example.com/acme/apps/mango/-/pipelines/46" });
        let run = run_from_json(&f, &one, false).unwrap();
        assert_eq!(run.workflow_id, workflow_id(true, "push"), "the pipeline says it is a tag pipeline");
        assert_eq!(run.started_at.as_deref(), Some("2026-11-20T00:12:45.000Z"));
        assert_eq!(run.updated_at, "2026-11-20T00:20:00.000Z", "a finished pipeline ends when it finished");
        assert_eq!(run.state, "failure");

        let jobs = json!([
            { "id": 7, "status": "failed", "stage": "test", "name": "lint", "ref": "v0.2", "tag": true,
              "allow_failure": true, "created_at": "2026-11-20T00:12:41.000Z",
              "started_at": "2026-11-20T00:12:45.000Z", "finished_at": "2026-11-20T00:13:45.000Z",
              "commit": { "id": "079e9010", "short_id": "079e9010", "title": "chore(release): v0.2" },
              "pipeline": { "id": 46, "ref": "v0.2", "sha": "079e9010", "status": "failed" },
              "web_url": "https://gitlab.example.com/acme/apps/mango/-/jobs/7" },
            { "id": 8, "status": "failed", "stage": "build", "name": "build:windows", "allow_failure": false,
              "started_at": "2026-11-20T00:13:50.000Z", "finished_at": "2026-11-20T00:20:00.000Z",
              "web_url": "https://gitlab.example.com/acme/apps/mango/-/jobs/8" },
            { "id": 9, "status": "manual", "stage": "deploy", "name": "publish", "allow_failure": true,
              "started_at": null, "finished_at": null,
              "web_url": "https://gitlab.example.com/acme/apps/mango/-/jobs/9" },
            { "id": 10, "status": "created", "name": "no page", "web_url": null }
        ]);
        assert_eq!(title_from_jobs(&jobs).as_deref(), Some("chore(release): v0.2"));
        let jobs = jobs_from_json(&f, &jobs);
        assert_eq!(jobs.len(), 3);
        assert_eq!(jobs.iter().map(|j| j.state).collect::<Vec<_>>(), vec!["neutral", "failure", "neutral"]);
        assert_eq!(jobs[1].url, "https://gitlab.example.com/acme/apps/mango/-/jobs/8");
        assert_eq!(jobs[1].completed_at.as_deref(), Some("2026-11-20T00:20:00.000Z"));
        assert_eq!(jobs[2].started_at, None);
    }

    #[test]
    fn refuses_unknown_actions_unsafe_tags_and_merge_request_refs() {
        assert!(run_action(forge(), 1, "delete").unwrap_err().contains("Unknown action"));
        assert!(tag_run(forge(), "--upload-pack=x").is_err());
        assert!(tag_run(forge(), "v1 x").is_err());
        assert!(pipeline_ref("refs/merge-requests/3/head").is_err());
        assert!(pipeline_ref("-x").is_err());
        assert_eq!(pipeline_ref("v1.2.3"), Ok("v1.2.3"));
    }
}
