//! Unity VCS code reviews, for the Pull requests tool window: the reviews of
//! the branch the workspace is on, the open ones in its repository, and
//! asking for a review of the branch. Everything goes through the user's own
//! `cm` (`cm find review`, `cm codereview`), like the rest of `plastic/`.
//!
//! `cm find review --xml` is documented by its fields, not by its markup; the
//! parsing here reads the upper-case element per field, the way `cm find`
//! writes every other object, and tolerates fields older clients leave out
//! (reviewers, comment counts, last activity).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use super::{cm, parse_date, safe_branch, workspace_info, xml_blocks, xml_text, XML};
use crate::git::blocking;
use crate::vcs::{self, Backend};

/// Reviews of the current branch shown at most.
const BRANCH_CAP: usize = 20;
/// Open reviews of the repository shown at most.
const OPEN_CAP: usize = 50;
const FIND_TIMEOUT: Duration = Duration::from_secs(30);
const NOT_PLASTIC: &str = "Code reviews are a Unity Version Control feature, and this folder isn't in a Unity VCS workspace.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReviewStatus {
    UnderReview,
    Reviewed,
    ReworkRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReviewTarget {
    Branch,
    Changeset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlasticReviewer {
    pub name: String,
    pub status: ReviewStatus,
}

/// One code review as `cm find review` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlasticReview {
    pub id: u64,
    pub guid: Option<String>,
    pub title: String,
    pub status: ReviewStatus,
    pub owner: String,
    /// The single assignee of older reviews; newer ones have reviewers.
    pub assignee: Option<String>,
    pub reviewers: Vec<PlasticReviewer>,
    pub target_type: ReviewTarget,
    /// The branch (`/main/task-1`) or changeset (`cs:12`); empty when `cm` named it only by id.
    pub target: String,
    /// Unix ms; 0 when unknown.
    pub created: i64,
    /// Last activity, Unix ms, when the client reports it.
    pub modified: Option<i64>,
    pub comments: Option<u32>,
    /// Change requests not applied plus questions not answered, when the client reports it.
    pub unresolved: Option<u32>,
    /// The id the target is known by in the repository, for naming branches afterwards.
    #[serde(skip)]
    target_id: Option<u64>,
}

/// What the tool window shows for a Unity VCS workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlasticReviews {
    pub repository: Option<String>,
    /// The branch the workspace is on; None when it is pinned to a changeset or label.
    pub branch: Option<String>,
    /// Reviews of that branch, newest first, whatever their status.
    pub branch_reviews: Vec<PlasticReview>,
    /// Reviews in the repository still under review or waiting for rework, newest first, not counting the branch's own.
    pub open: Vec<PlasticReview>,
    /// More open reviews exist than `open` holds.
    pub more: bool,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// A status as `cm` prints it: the number (`1`), the English or `{status}`
/// form (`Reviewed`, `Status Under review`, `Status1`). Anything unknown,
/// such as a name in another client language, reads as under review.
pub(crate) fn parse_status(s: &str) -> ReviewStatus {
    let lower = s.trim().to_lowercase();
    let bare = lower.strip_prefix("status").unwrap_or(&lower).trim();
    match bare {
        "1" => ReviewStatus::Reviewed,
        "2" => ReviewStatus::ReworkRequired,
        b if b.contains("rework") => ReviewStatus::ReworkRequired,
        b if b.contains("reviewed") && !b.contains("under") => ReviewStatus::Reviewed,
        _ => ReviewStatus::UnderReview,
    }
}

/// `{reviewers}`: `maria:Reviewed, leads:Under review`.
fn parse_reviewer_list(s: &str) -> Vec<PlasticReviewer> {
    s.split([',', ';', '\n'])
        .filter_map(|part| {
            let part = part.trim();
            let (name, status) = part.rsplit_once(':').unwrap_or((part, ""));
            let name = name.trim();
            (!name.is_empty()).then(|| PlasticReviewer { name: name.to_string(), status: parse_status(status) })
        })
        .collect()
}

fn reviewers_of(block: &str) -> Vec<PlasticReviewer> {
    let nested: Vec<PlasticReviewer> = xml_blocks(block, "REVIEWER")
        .into_iter()
        .filter_map(|r| {
            let name = xml_text(r, "NAME").or_else(|| xml_text(r, "USER"))?.trim().to_string();
            (!name.is_empty()).then(|| PlasticReviewer { name, status: parse_status(&xml_text(r, "STATUS").unwrap_or_default()) })
        })
        .collect();
    if !nested.is_empty() {
        return nested;
    }
    xml_text(block, "REVIEWERS").map(|s| parse_reviewer_list(&s)).unwrap_or_default()
}

/// The repository's id of a target written `id:42` or `42`.
fn id_in(s: &str) -> Option<u64> {
    s.trim().strip_prefix("id:").unwrap_or(s.trim()).trim().parse().ok()
}

/// A readable target: `br:/main/x@repo@server` is `/main/x`, `cs:12@repo` is `cs:12`; ids are not names.
fn target_name(kind: ReviewTarget, raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix("br:").unwrap_or(t);
    let spec = t.split('@').next().unwrap_or_default().trim();
    match kind {
        ReviewTarget::Branch if spec.starts_with('/') => spec.to_string(),
        ReviewTarget::Changeset if spec.starts_with("cs:") && spec[3..].parse::<u64>().is_ok() => spec.to_string(),
        _ => String::new(),
    }
}

fn count(block: &str, tag: &str) -> Option<u32> {
    xml_text(block, tag)?.trim().parse().ok()
}

/// Records of `cm find review --xml`.
pub(crate) fn parse_reviews(xml: &str) -> Vec<PlasticReview> {
    xml_blocks(xml, "REVIEW")
        .into_iter()
        .filter_map(|b| {
            let kind = match xml_text(b, "TARGETTYPE").unwrap_or_default().to_lowercase() {
                k if k.contains("changeset") => ReviewTarget::Changeset,
                _ => ReviewTarget::Branch,
            };
            let raw_target = xml_text(b, "TARGET").unwrap_or_default();
            let status = xml_text(b, "CODEREVIEWSTATUSNAME")
                .filter(|s| !s.trim().is_empty())
                .or_else(|| xml_text(b, "STATUS"))
                .unwrap_or_default();
            Some(PlasticReview {
                id: xml_text(b, "ID")?.trim().parse().ok()?,
                guid: xml_text(b, "GUID").map(|g| g.trim().to_string()).filter(|g| !g.is_empty()),
                title: xml_text(b, "TITLE").unwrap_or_default().trim().to_string(),
                status: parse_status(&status),
                owner: xml_text(b, "OWNER").unwrap_or_default().trim().to_string(),
                assignee: xml_text(b, "ASSIGNEE").map(|a| a.trim().to_string()).filter(|a| !a.is_empty()),
                reviewers: reviewers_of(b),
                target_type: kind,
                target: target_name(kind, &raw_target),
                target_id: xml_text(b, "TARGETID").as_deref().and_then(id_in).or_else(|| raw_target.trim().starts_with("id:").then(|| id_in(&raw_target)).flatten()),
                created: xml_text(b, "DATE").as_deref().and_then(parse_date).unwrap_or(0),
                modified: xml_text(b, "MODIFIEDDATE").as_deref().and_then(parse_date),
                comments: count(b, "COMMENTS"),
                unresolved: count(b, "UNRESOLVEDISSUES"),
            })
        })
        .collect()
}

/// `cm find branch --xml` records as id → name.
fn parse_branch_ids(xml: &str) -> HashMap<u64, String> {
    xml_blocks(xml, "BRANCH")
        .into_iter()
        .filter_map(|b| {
            let id = xml_text(b, "ID")?.trim().parse().ok()?;
            let name = xml_text(b, "NAME")?.trim().to_string();
            name.starts_with('/').then_some((id, name))
        })
        .collect()
}

/// The id `cm codereview … --format={id}` prints.
pub(crate) fn created_id(output: &str) -> Option<u64> {
    output.split(|c: char| !c.is_ascii_digit()).find(|w| !w.is_empty())?.parse().ok()
}

// ---------------------------------------------------------------------------
// Checking what the webview sends
// ---------------------------------------------------------------------------

pub(crate) fn clean_title(title: &str) -> Result<String, String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("Give the review a title.".into());
    }
    if title.starts_with('-') {
        return Err("Start the title with a word, not a dash.".into());
    }
    if title.chars().count() > 200 {
        return Err("Keep the title under 200 characters.".into());
    }
    Ok(title)
}

/// Reviewers as `cm` takes them: user names (or emails, on Unity Cloud) separated by commas.
pub(crate) fn clean_reviewers(list: Option<&str>) -> Result<Option<String>, String> {
    let names: Vec<&str> = list.unwrap_or_default().split([',', ' ', ';']).map(str::trim).filter(|n| !n.is_empty()).collect();
    if names.is_empty() {
        return Ok(None);
    }
    if names.len() > 20 {
        return Err("Name at most 20 reviewers.".into());
    }
    for n in &names {
        let ok = !n.starts_with('-')
            && n.len() <= 120
            && n.chars().all(|c| c.is_alphanumeric() || "._@+-".contains(c));
        if !ok {
            return Err(format!("\"{n}\" is not a user name Unity VCS knows. Separate several with commas."));
        }
    }
    Ok(Some(names.join(",")))
}

// ---------------------------------------------------------------------------
// Running cm
// ---------------------------------------------------------------------------

fn find(root: &Path, filter: &str, limit: usize) -> Result<Vec<PlasticReview>, String> {
    let out = cm(root)?
        .args(["find", "review"])
        .arg(filter)
        .arg("order by date desc")
        .arg(format!("limit {limit}"))
        .args(XML)
        .arg("--nototal")
        .timeout(FIND_TIMEOUT)
        .run_ok("cm find review")?;
    Ok(parse_reviews(&out.text()))
}

/// Name the branches `cm` gave only by id, with one more query. Not knowing is not worth failing for.
fn name_branches(root: &Path, reviews: &mut [PlasticReview]) {
    let ids: HashSet<u64> = reviews
        .iter()
        .filter(|r| r.target_type == ReviewTarget::Branch && r.target.is_empty())
        .filter_map(|r| r.target_id)
        .collect();
    if ids.is_empty() {
        return;
    }
    let filter = format!("where {}", ids.iter().map(|id| format!("id = {id}")).collect::<Vec<_>>().join(" or "));
    let Ok(out) = cm(root).and_then(|c| c.args(["find", "branch"]).arg(filter).args(XML).arg("--nototal").timeout(FIND_TIMEOUT).run_ok("cm find branch")) else {
        return;
    };
    let names = parse_branch_ids(&out.text());
    for r in reviews.iter_mut().filter(|r| r.target_type == ReviewTarget::Branch && r.target.is_empty()) {
        if let Some(name) = r.target_id.and_then(|id| names.get(&id)) {
            r.target = name.clone();
        }
    }
}

pub(crate) fn list(root: &Path) -> Result<PlasticReviews, String> {
    let info = workspace_info(root)?;
    let branch = info.branch.as_deref().map(safe_branch).transpose()?;
    let branch_reviews = match &branch {
        Some(b) => {
            let mut found = find(root, &format!("where target = 'br:{b}'"), BRANCH_CAP)?;
            for r in found.iter_mut().filter(|r| r.target_type == ReviewTarget::Branch) {
                r.target = b.clone();
            }
            found
        }
        None => Vec::new(),
    };
    // Still under review (0) or waiting for rework (2).
    let mut open = find(root, "where status = 0 or status = 2", OPEN_CAP + branch_reviews.len() + 1)?;
    let shown: HashSet<u64> = branch_reviews.iter().map(|r| r.id).collect();
    open.retain(|r| !shown.contains(&r.id));
    let more = open.len() > OPEN_CAP;
    open.truncate(OPEN_CAP);
    name_branches(root, &mut open);
    Ok(PlasticReviews { repository: info.repository, branch, branch_reviews, open, more })
}

/// Ask for a review of the branch the workspace is on. Returns the new review's id.
pub(crate) fn create(root: &Path, title: &str, reviewers: Option<&str>) -> Result<u64, String> {
    let title = clean_title(title)?;
    let users = clean_reviewers(reviewers)?;
    let branch = workspace_info(root)?
        .branch
        .ok_or("The workspace isn't on a branch. Switch to the branch you want reviewed first.")?;
    let branch = safe_branch(&branch)?;
    let mut c = cm(root)?.arg("codereview").arg(format!("br:{branch}")).arg(&title);
    if let Some(users) = users {
        c = c.arg(format!("--users={users}"));
    }
    let out = c.arg("--format={id}").timeout(Duration::from_secs(60)).run_ok("cm codereview")?;
    created_id(&out.text()).ok_or_else(|| {
        let detail = out.combined();
        format!("Unity VCS didn't say which review it created. Refresh to look for it.{}", if detail.is_empty() { String::new() } else { format!("\n\n{detail}") })
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Code reviews for the Unity VCS workspace holding `path`: the current branch's, and the open ones.
#[tauri::command]
pub async fn plastic_reviews(app: AppHandle, path: String) -> Result<PlasticReviews, String> {
    blocking(move || match vcs::detect(&app, &path)? {
        Backend::Plastic(root) => list(&root),
        Backend::Git(_) | Backend::Lore(_) => Err(NOT_PLASTIC.into()),
    })
    .await
}

/// Ask for a review of the workspace's branch, optionally naming reviewers. Returns the review's id.
#[tauri::command]
pub async fn plastic_review_create(app: AppHandle, path: String, title: String, reviewers: Option<String>) -> Result<u64, String> {
    blocking(move || match vcs::detect(&app, &path)? {
        Backend::Plastic(root) => create(&root, &title, reviewers.as_deref()),
        Backend::Git(_) | Backend::Lore(_) => Err(NOT_PLASTIC.into()),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<PLASTICQUERY>
  <REVIEW>
    <ID>1367</ID>
    <GUID>27658884-5dcc-49b7-b0ef-a5760ae740a3</GUID>
    <OWNER>pablo</OWNER>
    <DATE>2026-11-15T18:52:55.0000000+00:00</DATE>
    <TITLE>Login fixes &amp; crate physics</TITLE>
    <STATUS>Status Rework required</STATUS>
    <CODEREVIEWSTATUSNAME>Rework required</CODEREVIEWSTATUSNAME>
    <ASSIGNEE />
    <TARGETTYPE>Branch</TARGETTYPE>
    <TARGET>br:/main/task001@game@org@cloud</TARGET>
    <TARGETID>424073</TARGETID>
    <REVIEWERS>maria:Reviewed, leads:Under review</REVIEWERS>
    <MODIFIEDDATE>2026-11-16T09:00:00Z</MODIFIEDDATE>
    <COMMENTS>4</COMMENTS>
    <UNRESOLVEDISSUES>1</UNRESOLVEDISSUES>
  </REVIEW>
  <REVIEW>
    <ID>1368</ID>
    <OWNER>borja</OWNER>
    <DATE>2026-11-14T10:00:00Z</DATE>
    <TITLE>Review scm12816</TITLE>
    <STATUS>1</STATUS>
    <ASSIGNEE>roberto</ASSIGNEE>
    <TARGETTYPE>Branch</TARGETTYPE>
    <TARGET>id:426648</TARGET>
  </REVIEW>
  <REVIEW>
    <ID>1369</ID>
    <OWNER>ana</OWNER>
    <DATE>2026-11-13T10:00:00Z</DATE>
    <TITLE>One changeset</TITLE>
    <STATUS>Under review</STATUS>
    <TARGETTYPE>Changeset</TARGETTYPE>
    <TARGET>cs:1856@game@org@cloud</TARGET>
  </REVIEW>
  <REVIEW><TITLE>no id, skipped</TITLE></REVIEW>
</PLASTICQUERY>"#;

    #[test]
    fn parses_reviews() {
        let r = parse_reviews(SAMPLE);
        assert_eq!(r.len(), 3);
        let a = &r[0];
        assert_eq!(a.id, 1367);
        assert_eq!(a.guid.as_deref(), Some("27658884-5dcc-49b7-b0ef-a5760ae740a3"));
        assert_eq!(a.title, "Login fixes & crate physics");
        assert_eq!(a.status, ReviewStatus::ReworkRequired);
        assert_eq!(a.assignee, None);
        assert_eq!(a.target_type, ReviewTarget::Branch);
        assert_eq!(a.target, "/main/task001");
        assert_eq!(a.target_id, Some(424073));
        assert_eq!(a.created, parse_date("2026-11-15T18:52:55Z").unwrap());
        assert_eq!(
            a.reviewers,
            vec![
                PlasticReviewer { name: "maria".into(), status: ReviewStatus::Reviewed },
                PlasticReviewer { name: "leads".into(), status: ReviewStatus::UnderReview },
            ]
        );
        assert_eq!((a.comments, a.unresolved), (Some(4), Some(1)));
        assert!(a.modified.is_some());

        let b = &r[1];
        assert_eq!(b.status, ReviewStatus::Reviewed);
        assert_eq!(b.assignee.as_deref(), Some("roberto"));
        assert_eq!((b.target.as_str(), b.target_id), ("", Some(426648)));
        assert!(b.reviewers.is_empty() && b.comments.is_none() && b.modified.is_none());

        let c = &r[2];
        assert_eq!((c.target_type, c.target.as_str()), (ReviewTarget::Changeset, "cs:1856"));
        assert_eq!(c.status, ReviewStatus::UnderReview);
    }

    #[test]
    fn statuses() {
        for (s, want) in [
            ("0", ReviewStatus::UnderReview),
            ("1", ReviewStatus::Reviewed),
            ("2", ReviewStatus::ReworkRequired),
            ("Status1", ReviewStatus::Reviewed),
            ("Status Under review", ReviewStatus::UnderReview),
            ("Reviewed", ReviewStatus::Reviewed),
            ("Rework required", ReviewStatus::ReworkRequired),
            ("", ReviewStatus::UnderReview),
        ] {
            assert_eq!(parse_status(s), want, "{s}");
        }
    }

    #[test]
    fn nested_reviewers_and_branch_ids() {
        let block = "<REVIEWERS><REVIEWER><NAME>maria@studio.com</NAME><STATUS>Rework required</STATUS></REVIEWER></REVIEWERS>";
        assert_eq!(reviewers_of(block), vec![PlasticReviewer { name: "maria@studio.com".into(), status: ReviewStatus::ReworkRequired }]);
        let ids = parse_branch_ids("<BRANCH><ID>7</ID><NAME>/main/a</NAME></BRANCH><BRANCH><ID>x</ID><NAME>/main/b</NAME></BRANCH>");
        assert_eq!(ids.get(&7).map(String::as_str), Some("/main/a"));
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn checks_input() {
        assert_eq!(clean_title("  Inventory\n tooltips ").unwrap(), "Inventory tooltips");
        assert!(clean_title("   ").is_err());
        assert!(clean_title("--status=Reviewed").is_err());
        assert!(clean_title(&"x".repeat(201)).is_err());
        assert_eq!(clean_reviewers(None).unwrap(), None);
        assert_eq!(clean_reviewers(Some(" ")).unwrap(), None);
        assert_eq!(clean_reviewers(Some("maria, me ana@studio.com")).unwrap().as_deref(), Some("maria,me,ana@studio.com"));
        assert!(clean_reviewers(Some("--groups=all")).is_err());
        assert!(clean_reviewers(Some("a\"b")).is_err());
        assert!(clean_reviewers(Some("$(rm)")).is_err());
        assert_eq!(created_id("1367\n"), Some(1367));
        assert_eq!(created_id("Code review 42 created"), Some(42));
        assert_eq!(created_id("done"), None);
    }

    /// Lists the reviews of a real workspace (read only): set `MANGO_CM_WORKSPACE`
    /// and run `cargo test --lib plastic::reviews::tests::real_cm_reviews -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_cm_reviews() {
        let Some(root) = std::env::var_os("MANGO_CM_WORKSPACE").map(std::path::PathBuf::from) else {
            eprintln!("MANGO_CM_WORKSPACE is not set; skipping");
            return;
        };
        let found = list(&root).unwrap();
        println!("{found:#?}");
        assert!(found.open.len() <= OPEN_CAP && found.branch_reviews.len() <= BRANCH_CAP);
    }
}
