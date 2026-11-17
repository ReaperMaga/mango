//! Shelves, Unity VCS's stash: park pending changes on the server as a
//! shelveset (`sh:12`), bring them back into the workspace later, or throw
//! them away. Git folders are refused; git has its own stash.
//!
//! Commands, all run in the workspace root with no prompt:
//! - list: `cm find shelve "where owner='me'" --xml --encoding=utf-8 --nototal`,
//!   then the branch of each base changeset from one `cm find changeset`;
//! - shelve: `cm shelveset create <paths> --all --dependencies -c=<comment> --summaryformat`,
//!   and for "shelve and undo" the same undo as Discard on those paths;
//! - apply: `cm shelveset apply sh:<id>`;
//! - delete: `cm shelveset delete sh:<id>`.
//!
//! Which files a shelve takes follows checkin: the files picked ("staged")
//! for the next checkin, or every pending change when none are. Private files
//! are not under version control yet, so Unity VCS can't shelve them; they
//! stay in the workspace, and the result says so.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use super::{cm, discard, explain, key, parse_changesets, parse_date, path_arg, read_status, staged, xml_blocks, xml_text, Entry, MAX_ARGS_BYTES, XML};
use crate::git::blocking;
use crate::vcs::{detect, Backend};

const NO_GIT_SHELVES: &str = "Shelves are a Unity Version Control feature. In a git repository, use git stash in a terminal.";
/// The newest shelves shown; older ones are still on the server.
const LIST_LIMIT: usize = 100;

/// One shelveset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Shelve {
    /// The number in `sh:12`.
    pub id: u64,
    pub comment: String,
    pub owner: String,
    /// Unix ms.
    pub time: i64,
    /// The branch of the changeset it was shelved from, when that could be read.
    pub branch: Option<String>,
    /// That changeset's number, when `cm` gave one.
    #[serde(skip)]
    pub parent: Option<u64>,
}

/// Records of `cm find shelve --xml`, newest first.
pub(crate) fn parse_shelves(xml: &str) -> Vec<Shelve> {
    let mut out: Vec<Shelve> = xml_blocks(xml, "SHELVE")
        .into_iter()
        .filter_map(|b| {
            Some(Shelve {
                id: xml_text(b, "SHELVEID")?.trim().parse().ok()?,
                comment: xml_text(b, "COMMENT").unwrap_or_default(),
                owner: xml_text(b, "OWNER").unwrap_or_default(),
                time: xml_text(b, "DATE").as_deref().and_then(parse_date).unwrap_or(0),
                branch: None,
                parent: xml_text(b, "PARENT").and_then(|p| p.trim().parse().ok()),
            })
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time).then(b.id.cmp(&a.id)));
    out
}

/// The shelveset spec in `cm shelveset create` output, e.g. `sh:12` from `sh:12@game@local`.
pub(crate) fn shelve_of(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let word = word.trim_matches(|c: char| c == '\'' || c == '"' || c == '(' || c == ')' || c == '.' || c == ',');
        let rest = word.strip_prefix("sh:")?;
        let id: String = rest.chars().take_while(char::is_ascii_digit).collect();
        (!id.is_empty()).then(|| format!("sh:{id}"))
    })
}

pub(crate) fn list(root: &Path) -> Result<Vec<Shelve>, String> {
    let out = cm(root)?
        .args(["find", "shelve", "where owner='me'"])
        .args(XML)
        .arg("--nototal")
        .run_ok("cm find shelve")?;
    let mut shelves = parse_shelves(&out.text());
    shelves.truncate(LIST_LIMIT);
    // Which branch each was shelved from: one query for all the base changesets.
    let mut parents: Vec<u64> = shelves.iter().filter_map(|s| s.parent).collect();
    parents.sort_unstable();
    parents.dedup();
    if !parents.is_empty() {
        let filter = parents.iter().map(|p| format!("changesetid = {p}")).collect::<Vec<_>>().join(" or ");
        let branches: HashMap<u64, String> = cm(root)
            .and_then(|c| c.args(["find", "changeset"]).arg(format!("where {filter}")).args(XML).arg("--nototal").run_ok("cm find"))
            .map(|out| parse_changesets(&out.text()).into_iter().map(|c| (c.id, c.branch)).collect())
            // The list is worth more than the branch names.
            .unwrap_or_default();
        for s in &mut shelves {
            s.branch = s.parent.and_then(|p| branches.get(&p).cloned()).filter(|b| !b.is_empty());
        }
    }
    Ok(shelves)
}

/// What a shelve takes: the picked changes, or all of them, without private files.
fn targets(pending: &[Entry], picked: &std::collections::HashSet<String>) -> (Vec<Entry>, usize) {
    let chosen: Vec<&Entry> = if picked.is_empty() { pending.iter().collect() } else { pending.iter().filter(|e| picked.contains(&e.path)).collect() };
    let private = chosen.iter().filter(|e| e.letter == "?").count();
    (chosen.into_iter().filter(|e| e.letter != "?").cloned().collect(), private)
}

/// Shelve the picked changes (every change when none are picked) with
/// `comment`; with `undo`, the workspace drops them afterwards. Returns a
/// line for the result strip.
pub(crate) fn create(root: &Path, comment: &str, undo: bool) -> Result<String, String> {
    let comment = comment.trim();
    if comment.is_empty() {
        return Err("Write a comment for the shelve first".into());
    }
    let pending = read_status(root)?.entries;
    let picked = staged().lock().ok().and_then(|m| m.get(&key(root)).cloned()).unwrap_or_default();
    let (take, private) = targets(&pending, &picked);
    if take.is_empty() {
        return Err(if private > 0 {
            "Only new files are pending, and Unity VCS can't shelve a file until it is under version control. Check them in, or add them with cm add first.".into()
        } else {
            "There are no changes to shelve.".into()
        });
    }
    let paths: Vec<String> = take.iter().map(|e| path_arg(&e.path)).collect();
    let everything = take.len() + private == pending.len();
    let too_long = paths.iter().map(|p| p.len() + 3).sum::<usize>() > MAX_ARGS_BYTES;
    if too_long && !everything {
        return Err(format!(
            "{} files are too many to name on one shelve. Stage everything, or fewer files, and shelve again.",
            take.len()
        ));
    }
    let mut cmd = cm(root)?.slow().args(["shelveset", "create"]);
    if !too_long {
        cmd = cmd.args(&paths);
    }
    let out = cmd
        // Locally changed, moved and deleted items count too, as they do for checkin.
        .args(["--all", "--dependencies"])
        .arg(format!("-c={comment}"))
        .arg("--summaryformat")
        .run_ok("cm shelveset create")?;
    let spec = shelve_of(&out.text()).unwrap_or_else(|| "a new shelve".into());
    let n = take.len();
    let mut line = format!("Shelved {n} change{} as {spec}", if n == 1 { "" } else { "s" });
    if undo {
        let files: Vec<String> = take.iter().map(|e| e.path.clone()).collect();
        if let Err(e) = discard(root, &files) {
            return Err(format!("Shelved as {spec}, but undoing the changes in the workspace failed. They are safe in the shelve.\n\n{e}"));
        }
        line.push_str(" and undid them in the workspace");
    }
    line.push('.');
    if private > 0 {
        line.push_str(&format!(
            "\n{private} new file{} not under version control stay{} in the workspace.",
            if private == 1 { "" } else { "s" },
            if private == 1 { "s" } else { "" }
        ));
    }
    Ok(line)
}

/// Bring `sh:<id>` back into the workspace as pending changes.
pub(crate) fn apply(root: &Path, id: u64) -> Result<String, String> {
    let out = cm(root)?.slow().args(["shelveset", "apply"]).arg(format!("sh:{id}")).run()?;
    if !out.ok() {
        let detail = out.error("cm shelveset apply");
        if detail.to_lowercase().contains("conflict") {
            return Err(format!("Shelve sh:{id} conflicts with changes in the workspace. Check in or undo those files, then apply it again.\n\n{detail}"));
        }
        return Err(explain(detail));
    }
    Ok(format!("Applied sh:{id} to the workspace. Its changes are pending again; the shelve stays on the server."))
}

/// Delete `sh:<id>` from the server. Its changes are gone for good.
pub(crate) fn delete(root: &Path, id: u64) -> Result<(), String> {
    cm(root)?.args(["shelveset", "delete"]).arg(format!("sh:{id}")).run_ok("cm shelveset delete")?;
    Ok(())
}

/* ---------- commands ---------- */

/// Run `work` in the Unity VCS workspace at `path`, off the UI thread; git folders are refused.
async fn in_workspace<T, F>(app: AppHandle, path: String, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> Result<T, String> + Send + 'static,
{
    blocking(move || match detect(&app, &path)? {
        Backend::Plastic(root) => work(&root),
        Backend::Git(_) => Err(NO_GIT_SHELVES.into()),
    })
    .await
}

/// The signed-in user's shelves in the workspace's repository, newest first.
#[tauri::command]
pub async fn vcs_shelves(app: AppHandle, path: String) -> Result<Vec<Shelve>, String> {
    in_workspace(app, path, list).await
}

/// Shelve what the next checkin would take. With `undo`, the workspace drops those changes afterwards.
#[tauri::command]
pub async fn vcs_shelve(app: AppHandle, path: String, comment: String, undo: bool) -> Result<String, String> {
    in_workspace(app, path, move |root| create(root, &comment, undo)).await
}

#[tauri::command]
pub async fn vcs_shelve_apply(app: AppHandle, path: String, id: u64) -> Result<String, String> {
    in_workspace(app, path, move |root| apply(root, id)).await
}

#[tauri::command]
pub async fn vcs_shelve_delete(app: AppHandle, path: String, id: u64) -> Result<(), String> {
    in_workspace(app, path, move |root| delete(root, id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn parses_find_shelve_xml() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<PLASTICQUERY>
  <SHELVE><ID>3848</ID><SHELVEID>2</SHELVEID><COMMENT>Grün &lt;wip&gt;
second line</COMMENT><DATE>2026-11-15T18:52:55+03:00</DATE><OWNER>pablo</OWNER><REPOSITORY>doom3code</REPOSITORY><PARENT>41</PARENT><GUID>g</GUID></SHELVE>
  <SHELVE><ID>3900</ID><SHELVEID>3</SHELVEID><COMMENT /><DATE>2026-11-16T09:00:00Z</DATE><OWNER>pablo</OWNER><REPOSITORY>doom3code</REPOSITORY></SHELVE>
  <SHELVE><ID>1</ID><SHELVEID>nope</SHELVEID></SHELVE>
</PLASTICQUERY>"#;
        let s = parse_shelves(xml);
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].id, s[0].comment.as_str(), s[0].parent), (3, "", None));
        assert_eq!((s[1].id, s[1].owner.as_str(), s[1].parent), (2, "pablo", Some(41)));
        assert_eq!(s[1].comment, "Grün <wip>\nsecond line");
        assert_eq!(s[1].time, 1_794_757_975_000);
        assert!(parse_shelves("<PLASTICQUERY></PLASTICQUERY>").is_empty());
    }

    #[test]
    fn shelve_spec_from_output() {
        assert_eq!(shelve_of("sh:12@game@local\n").as_deref(), Some("sh:12"));
        assert_eq!(shelve_of("Created shelve sh:7@rep@server (mount:'/')").as_deref(), Some("sh:7"));
        assert_eq!(shelve_of("Shelve 'sh:3'.").as_deref(), Some("sh:3"));
        assert_eq!(shelve_of("sh:x nothing"), None);
    }

    #[test]
    fn shelve_takes_what_checkin_would() {
        let e = |letter, path: &str| Entry { letter, path: path.into(), orig: None, dir: false };
        let pending = vec![e("M", "a.cs"), e("?", "new.cs"), e("D", "old.cs"), e("R", "b.cs")];
        let (all, private) = targets(&pending, &HashSet::new());
        assert_eq!(all.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["a.cs", "old.cs", "b.cs"]);
        assert_eq!(private, 1);
        let picked: HashSet<String> = ["b.cs".to_string(), "new.cs".to_string()].into();
        let (some, private) = targets(&pending, &picked);
        assert_eq!(some.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["b.cs"]);
        assert_eq!(private, 1);
    }

    /// Drives a real `cm` against a scratch workspace, like `plastic::tests::real_cm`:
    /// `MANGO_CM_WORKSPACE=/path/to/throwaway cargo test --lib plastic::shelves::tests::real_shelves -- --ignored --nocapture`.
    /// It checks in a file, shelves an edit with undo, applies it back, and deletes the shelve.
    #[test]
    #[ignore]
    fn real_shelves() {
        use super::super::{checkin, stage, status};
        let Some(root) = std::env::var_os("MANGO_CM_WORKSPACE").map(std::path::PathBuf::from) else {
            eprintln!("MANGO_CM_WORKSPACE is not set; skipping");
            return;
        };
        assert!(status(&root).unwrap().files.is_empty(), "start from a clean workspace");
        let id = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        let file = format!("mango-shelve-{id}.txt");
        std::fs::write(root.join(&file), "one\n").unwrap();
        stage(&root, std::slice::from_ref(&file)).unwrap();
        println!("checked in {}", checkin(&root, &format!("Mango shelve test {id}")).unwrap());

        std::fs::write(root.join(&file), "two\n").unwrap();
        let line = create(&root, &format!("Mango shelve {id}"), true).unwrap();
        println!("{line}");
        assert!(status(&root).unwrap().files.is_empty(), "undo after shelve leaves the workspace clean");
        assert_eq!(std::fs::read_to_string(root.join(&file)).unwrap().replace('\r', ""), "one\n");

        let mine = list(&root).unwrap();
        let shelf = mine.iter().find(|s| s.comment == format!("Mango shelve {id}")).expect("new shelve is listed").clone();
        println!("{shelf:?}");
        assert!(line.contains(&format!("sh:{}", shelf.id)), "{line}");

        println!("{}", apply(&root, shelf.id).unwrap());
        assert_eq!(std::fs::read_to_string(root.join(&file)).unwrap().replace('\r', ""), "two\n");
        delete(&root, shelf.id).unwrap();
        assert!(!list(&root).unwrap().iter().any(|s| s.id == shelf.id));
        discard(&root, &[]).unwrap();
    }
}
