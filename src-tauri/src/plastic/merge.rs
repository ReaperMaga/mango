//! Merging a branch into the workspace (`cm merge`), the Unity VCS side of
//! "Merge into current" in the branch popup.
//!
//! Unity VCS merges into the workspace: the result is pending changes that
//! the user then checks in, the way the Unity VCS app does it. Mango only
//! runs merges `cm` can finish on its own:
//! 1. `cm merge br:/x --machinereadable` (no `--merge`) lists what would
//!    merge and what conflicts, changing nothing;
//! 2. with no conflicts, `cm merge br:/x --merge --nointeractiveresolution`
//!    performs it; with conflicts, nothing runs and the user is pointed to
//!    the Unity VCS app, which can resolve them.
//!
//! The workspace has to be clean (private files aside) and up to date first,
//! so the merge result is exactly the pending changes it leaves, and a failed
//! merge can be undone without touching anyone's work.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

use crate::git::remove_untracked;

use super::{behind, cm, explain, key, read_status, safe_branch, staged, Entry};

/// Record markers for `--machinereadable`. The defaults (no line markers,
/// whitespace between fields) can't carry paths with spaces.
const START: &str = "@@MANGO>";
const END: &str = "<MANGO@@";
const FIELD: &str = "@@|@@";

/// What merging a branch would do, read before anything changes.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// The branch merged from, e.g. `/main/task`.
    pub branch: String,
    /// The branch the workspace is on, which the merge goes into.
    pub into: Option<String>,
    /// Files and folders the merge changes, relative to the workspace root.
    pub files: Vec<String>,
    /// Items changed on both branches. Mango doesn't merge these; the Unity VCS app resolves them.
    pub conflicts: Vec<String>,
    /// Why the merge can't run from Mango right now (pending changes, workspace not up to date).
    pub blocker: Option<String>,
}

/// The parsed records of `cm merge --machinereadable`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct MergeRecords {
    pub files: Vec<String>,
    pub conflicts: Vec<String>,
    /// Records were found at all; without any, the output was not what was asked for.
    pub any: bool,
}

/// The options that make `cm merge` print one record per item between our markers.
fn machine_args() -> [String; 4] {
    [
        "--machinereadable".into(),
        format!("--startlineseparator={START}"),
        format!("--endlineseparator={END}"),
        format!("--fieldseparator={FIELD}"),
    ]
}

/// A repository path from a record (`/Assets/x.cs`) as the Changes list shows it.
fn item_path(field: &str) -> Option<String> {
    let p = field.trim().replace('\\', "/");
    let p = p.trim_matches('/');
    (!p.is_empty()).then(|| p.to_string())
}

/// Parse `cm merge … --machinereadable` output. Records look like
/// `FILE_SRC|/a.cs|…`, `APPLY|ADD|/b.cs`, `FILE_CONFLICT|/c.cs|…`,
/// `DIR_CONFLICT|…`, `STATUS|ALREADY_CONNECTED|No merges detected`.
/// Anything outside the markers (progress text) is ignored.
pub(crate) fn parse_merge(output: &str) -> MergeRecords {
    let mut files = BTreeSet::new();
    let mut conflicts = BTreeSet::new();
    let mut any = false;
    let mut rest = output;
    while let Some(i) = rest.find(START) {
        let after = &rest[i + START.len()..];
        let Some(j) = after.find(END) else { break };
        rest = &after[j + END.len()..];
        let fields: Vec<&str> = after[..j].split(FIELD).collect();
        let Some(op) = fields.first().map(|f| f.trim()) else { continue };
        any = true;
        // The item is the first field that is a repository path.
        let path = fields[1..].iter().find(|f| f.trim_start().starts_with('/')).and_then(|f| item_path(f));
        if op.contains("CONFLICT") {
            // A directory conflict may name no path; say what it is instead.
            conflicts.insert(path.unwrap_or_else(|| fields[1..].iter().map(|f| f.trim()).collect::<Vec<_>>().join(" ")));
        } else if matches!(op, "STATUS" | "CHANGESET" | "DIS_OP_WARN") || op.ends_with("_WARN") {
            // The outcome, the changeset a merge-to made, a discarded operation.
        } else if let Some(p) = path {
            files.insert(p);
        }
    }
    files.retain(|f| !conflicts.contains(f));
    MergeRecords { files: files.into_iter().collect(), conflicts: conflicts.into_iter().collect(), any }
}

/// Controlled pending changes: private files don't take part in a merge.
fn controlled(entries: &[Entry]) -> Vec<&Entry> {
    entries.iter().filter(|e| e.letter != "?").collect()
}

fn files(n: usize) -> String {
    format!("{n} file{}", if n == 1 { "" } else { "s" })
}

/// A short list of names for a message, the rest counted.
fn listed(names: &[String]) -> String {
    const SHOWN: usize = 12;
    let mut out = names.iter().take(SHOWN).cloned().collect::<Vec<_>>().join("\n");
    if names.len() > SHOWN {
        out.push_str(&format!("\nand {} more", names.len() - SHOWN));
    }
    out
}

/// What would stop the merge before it starts, read from the workspace.
fn blocker(root: &Path, source: &str) -> Result<(Option<String>, Option<String>), String> {
    let status = read_status(root)?;
    let Some(into) = status.info.branch.clone() else {
        return Ok((None, Some("The workspace isn't on a branch. Switch to the branch to merge into first.".into())));
    };
    if into == source {
        return Ok((Some(into), Some(format!("The workspace is already on {source}. Switch to the branch to merge into first."))));
    }
    let pending = controlled(&status.entries).len();
    if pending > 0 {
        return Ok((
            Some(into),
            Some(format!(
                "The workspace has {} pending. Check in or undo them first, so the merge result is all that's left to check in.",
                files(pending)
            )),
        ));
    }
    if let Some(cs) = status.info.changeset {
        let newer = behind(root, &into, cs);
        if newer > 0 {
            return Ok((
                Some(into.clone()),
                Some(format!(
                    "{into} has {newer} changeset{} your workspace doesn't have yet. Update first, then merge.",
                    if newer == 1 { "" } else { "s" }
                )),
            ));
        }
    }
    Ok((Some(into), None))
}

/// Run the read-only `cm merge` that lists what merging `source` does.
fn read_merge(root: &Path, source: &str) -> Result<MergeRecords, String> {
    let out = cm(root)?.slow().arg("merge").arg(format!("br:{source}")).args(machine_args()).run()?;
    let records = parse_merge(&out.text());
    // A preview with conflicts can end non-zero; only fail when it said nothing we understand.
    if !out.ok() && !records.any {
        return Err(explain(out.error("cm merge")));
    }
    // Output without a single record isn't the format asked for: don't call that "nothing to merge".
    let said = out.combined();
    if !records.any && !said.is_empty() {
        return Err(format!("Mango couldn't read what merging {source} would do, so it didn't merge.\n\n{said}"));
    }
    Ok(records)
}

/// What merging `branch` into the workspace would change, and whether Mango can do it.
pub(crate) fn preview(root: &Path, branch: &str) -> Result<MergePreview, String> {
    let source = safe_branch(branch)?;
    let (into, blocker) = blocker(root, &source)?;
    let mut preview = MergePreview { branch: source.clone(), into, blocker, ..Default::default() };
    // On the source branch itself there is nothing to read.
    if preview.into.as_deref() == Some(source.as_str()) || preview.into.is_none() {
        return Ok(preview);
    }
    let records = read_merge(root, &source)?;
    preview.files = records.files;
    preview.conflicts = records.conflicts;
    Ok(preview)
}

/// The refusal for a merge with conflicts.
fn conflict_message(source: &str, conflicts: &[String]) -> String {
    format!(
        "{} changed on both branches need resolving by hand, so Mango didn't merge {source}. \
         Merge it in the Unity Version Control app, which resolves conflicts, then check in from here.\n\n{}",
        files(conflicts.len()),
        listed(conflicts)
    )
}

/// Merge `branch` into the workspace. The result is pending changes, picked
/// for the next checkin, that finish the merge when checked in.
pub(crate) fn merge(root: &Path, branch: &str) -> Result<String, String> {
    let preview = preview(root, branch)?;
    if let Some(why) = preview.blocker {
        return Err(why);
    }
    let source = preview.branch;
    let into = preview.into.unwrap_or_default();
    if !preview.conflicts.is_empty() {
        return Err(conflict_message(&source, &preview.conflicts));
    }
    if preview.files.is_empty() {
        return Ok(format!("Nothing to merge: {into} already has everything from {source}."));
    }

    let out = cm(root)?
        .slow()
        .arg("merge")
        .arg(format!("br:{source}"))
        // Never stop for a conflict nobody can answer: anything that needs a person fails instead.
        .args(["--merge", "--nointeractiveresolution", "--mergetype=try"])
        .args(machine_args())
        .run()?;
    let records = parse_merge(&out.text());
    if !out.ok() || !records.conflicts.is_empty() {
        let undone = undo_merge(root);
        let lead = if !records.conflicts.is_empty() {
            conflict_message(&source, &records.conflicts)
        } else {
            explain(format!("Unity VCS couldn't merge {source}.\n\n{}", out.error("cm merge")))
        };
        let after = if undone {
            "Mango undid the partial merge; the workspace is as it was."
        } else {
            "The workspace may hold part of the merge. Undo it in the Changes view or the Unity VCS app."
        };
        return Err(format!("{lead}\n\n{after}"));
    }

    // Pick every merged change for the checkin: a merge is checked in whole.
    let entries = read_status(root)?.entries;
    let merged: Vec<&Entry> = controlled(&entries);
    if let Ok(mut map) = staged().lock() {
        let picked = map.entry(key(root)).or_default();
        picked.extend(merged.iter().map(|e| e.path.clone()));
    }
    let changed = if merged.is_empty() { preview.files.len() } else { merged.len() };
    Ok(format!("Merged {source}: {} changed, check in to finish.\nThe merge into {into} is pending changes until you check it in.", files(changed)))
}

/// Throw away what a failed merge left. The workspace was clean (private
/// files aside) before it, so every controlled change is the merge's: undo
/// them all, and delete the files it added, which `cm undo` leaves as private.
fn undo_merge(root: &Path) -> bool {
    let added: Vec<String> = read_status(root)
        .map(|s| s.entries.into_iter().filter(|e| e.letter == "A" && !e.dir).map(|e| e.path).collect())
        .unwrap_or_default();
    if cm(root).and_then(|c| c.args(["undo", ".", "-r"]).run_ok("cm undo")).is_err() {
        return false;
    }
    added.iter().all(|p| remove_untracked(root, p).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(fields: &[&str]) -> String {
        format!("{START}{}{END}", fields.join(FIELD))
    }

    #[test]
    fn parses_machine_readable_merge() {
        let out = [
            "Merging from br:/main/task@game@local\r\n".to_string(),
            rec(&["FILE_SRC", "/Assets/Scripts/Player.cs", "56", "59", "60"]),
            "\r\n".into(),
            rec(&["APPLY", "ADD", "/Assets/New Folder/ü b.png"]),
            rec(&["APPLY", "RM", "/Old.txt"]),
            rec(&["FILE_CONFLICT", "/Assets/Scenes/Farm.unity", "1", "2", "3", "4"]),
            rec(&["FILE_SRC", "/Assets/Scenes/Farm.unity", "1", "2", "3"]),
            rec(&["DIR_CONFLICT", "EVIL_TWIN", "Added on both sides"]),
            rec(&["DIS_OP_WARN", "CHG", "/Ignored.cs"]),
        ]
        .concat();
        let r = parse_merge(&out);
        assert!(r.any);
        assert_eq!(r.files, vec!["Assets/New Folder/ü b.png", "Assets/Scripts/Player.cs", "Old.txt"]);
        assert_eq!(r.conflicts, vec!["Assets/Scenes/Farm.unity", "EVIL_TWIN Added on both sides"]);
    }

    #[test]
    fn merge_with_nothing_to_do() {
        let r = parse_merge(&rec(&["STATUS", "ALREADY_CONNECTED", "No merges detected"]));
        assert!(r.any && r.files.is_empty() && r.conflicts.is_empty());
        assert_eq!(parse_merge("The source and destination are already connected."), MergeRecords::default());
        // A record cut off by the output cap is dropped.
        assert_eq!(parse_merge(&format!("{START}FILE_SRC{FIELD}/a.cs")), MergeRecords::default());
    }

    #[test]
    fn messages() {
        let many: Vec<String> = (0..14).map(|i| format!("f{i}.cs")).collect();
        let m = conflict_message("/main/x", &many);
        assert!(m.starts_with("14 files changed on both branches need resolving by hand, so Mango didn't merge /main/x."), "{m}");
        assert!(m.ends_with("f11.cs\nand 2 more"), "{m}");
        assert_eq!(files(1), "1 file");
    }

    /// Merges against a real `cm`: set `MANGO_CM_WORKSPACE` to the root of a
    /// throwaway workspace (on a clean, up-to-date branch, e.g. on the `local`
    /// server) and run `cargo test --lib plastic::merge::tests::real_merge -- --ignored --nocapture`.
    /// It makes two child branches with a changeset each (one clashing with a
    /// change on the home branch), merges, and leaves the merges unchecked-in
    /// only long enough to look at them: everything is undone at the end.
    #[test]
    #[ignore]
    fn real_merge() {
        use super::super::{branch_create, checkin, discard, stage, status, switch, unstage, workspace_info};
        let on_branch = |root: &Path| workspace_info(root).ok().and_then(|i| i.branch);
        let Some(root) = std::env::var_os("MANGO_CM_WORKSPACE").map(std::path::PathBuf::from) else {
            eprintln!("MANGO_CM_WORKSPACE is not set; skipping");
            return;
        };
        let id = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        let home = on_branch(&root).expect("workspace should be on a branch");
        assert!(status(&root).unwrap().files.is_empty(), "start from a clean workspace");
        let file = format!("mango-merge-{id}.txt");
        let write = |text: &str| std::fs::write(root.join(&file), text).unwrap();
        let commit = |msg: &str| {
            stage(&root, &[]).unwrap();
            checkin(&root, msg).unwrap()
        };

        // Base on home, then a clean child and a clashing child.
        write("one\ntwo\nthree\n");
        commit(&format!("Mango merge base {id}"));
        branch_create(&root, &format!("mango-clean-{id}"), None, true).unwrap();
        let clean = on_branch(&root).unwrap();
        write("one\ntwo\nthree\nfour\n");
        commit("clean change");
        switch(&root, &home).unwrap();
        branch_create(&root, &format!("mango-clash-{id}"), None, true).unwrap();
        let clash = on_branch(&root).unwrap();
        write("one\nTWO (branch)\nthree\n");
        commit("clashing change");
        switch(&root, &home).unwrap();
        write("one\nTWO (home)\nthree\n");
        commit("home change");

        // Pending changes block it.
        write("dirty\n");
        let p = preview(&root, &clean).unwrap();
        println!("dirty preview: {p:?}");
        assert!(p.blocker.is_some());
        discard(&root, &[]).unwrap();

        let p = preview(&root, &clash).unwrap();
        println!("clash preview: {p:?}");
        assert_eq!(p.conflicts, vec![file.clone()]);
        let err = merge(&root, &clash).unwrap_err();
        println!("clash merge: {err}");
        assert!(status(&root).unwrap().files.is_empty(), "a refused merge changes nothing");

        let p = preview(&root, &clean).unwrap();
        println!("clean preview: {p:?}");
        assert_eq!((p.files.clone(), p.conflicts.len(), p.blocker.clone()), (vec![file.clone()], 0, None));
        let done = merge(&root, &clean).unwrap();
        println!("clean merge: {done}");
        assert!(done.starts_with(&format!("Merged {clean}: 1 file changed")), "{done}");
        let s = status(&root).unwrap();
        assert!(s.files.iter().any(|f| f.path == file && f.index.is_some()), "{:?}", s.files);

        // Undo the merge; the test branches stay (they have changesets).
        unstage(&root, &[]).unwrap();
        discard(&root, &[]).unwrap();
        assert!(status(&root).unwrap().files.is_empty());
    }
}
