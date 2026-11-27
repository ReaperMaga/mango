//! A merge, rebase, cherry-pick or revert that stopped half way (on conflicts, or a rebase's
//! `edit`): what it is, from the files git keeps in its folder while one runs, and the ways out
//! (abort, continue, skip). Also the three sides of a conflicted file, for the merge editor, and
//! taking one side whole.
//!
//! The state is read with every status: on this computer straight from the git folder, in an
//! environment by a fixed script in the same SSH call as the status itself ([`STATE`]), so a
//! remote project pays no extra round trip.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::{
    clean_rel, entry, git, lossy, remove_untracked_at, require_root, run_all, safe_hash, status_of, At, Entry, Output, BASE_CAP,
};

/// What is in progress, as the banner over the Changes view shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperation {
    /// "merge", "rebase", "cherry-pick" or "revert".
    pub kind: &'static str,
    /// The branch the result lands on: merged into, or being rebased. None when detached.
    pub branch: Option<String>,
    /// What comes in: the merged branch (or a short hash), the rebase's new base, the picked or
    /// reverted commit.
    pub incoming: Option<String>,
    /// The commit being applied now (rebase, cherry-pick, revert), short hash.
    pub commit: Option<String>,
    /// Its subject.
    pub subject: Option<String>,
    /// Rebase: which of its commits is being applied, counted from 1, and how many there are.
    pub step: Option<u32>,
    pub steps: Option<u32>,
    /// The message the commit that finishes it gets (git: `MERGE_MSG` without its comments).
    pub message: Option<String>,
    /// The two tips whose histories meet (full hashes), for the subjects on each side.
    #[serde(skip)]
    pub(crate) revs: Option<(String, String)>,
}

/// One side of a conflicted file.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictSide {
    /// The side has the file at all (it may have deleted it).
    pub present: bool,
    /// Its text; None when absent, binary or too large.
    pub text: Option<String>,
}

/// The sides of a conflicted file: base, ours (stage 2: the current branch, or for a rebase the
/// branch being rebased onto) and theirs (stage 3: what is merged in, or the commit being applied).
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflict {
    pub base: GitConflictSide,
    pub ours: GitConflictSide,
    pub theirs: GitConflictSide,
    /// A side holds bytes that aren't text: only taking one side whole works.
    pub binary: bool,
    /// A side is larger than the editor opens.
    pub too_large: bool,
}

/// The commit subjects on each side since the two met, newest first.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictHistory {
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
}

/// The files of the git folder the state is read from.
const FILES: &[&str] = &[
    "MERGE_HEAD",
    "MERGE_MSG",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-merge/head-name",
    "rebase-merge/onto",
    "rebase-merge/orig-head",
    "rebase-merge/msgnum",
    "rebase-merge/end",
    "rebase-merge/stopped-sha",
    "rebase-merge/message",
    "rebase-apply/head-name",
    "rebase-apply/onto",
    "rebase-apply/orig-head",
    "rebase-apply/next",
    "rebase-apply/last",
    "rebase-apply/rebasing",
    "rebase-apply/applying",
    "rebase-apply/original-commit",
];

/// Pseudo file: the refs pointing at a rebase's `onto`, one per line.
const ONTO_REFS: &str = "onto-refs";
/// The most of a state file that is read.
const STATE_CAP: usize = 64 * 1024;

/// `sh` script (in an environment's folder) printing each state file there is as its name, NUL,
/// its first bytes, NUL; then the refs at a rebase's `onto` as [`ONTO_REFS`]. Prints nothing
/// outside a repository, and never fails.
const STATE: &str = r#"g=$(git rev-parse --git-dir 2>/dev/null) || exit 0
for f in "$@"; do
  [ -f "$g/$f" ] && { printf '%s\0' "$f"; head -c 65536 "$g/$f"; printf '\0'; }
done
o=
[ -f "$g/rebase-merge/onto" ] && o=$(head -c 100 "$g/rebase-merge/onto")
[ -z "$o" ] && [ -f "$g/rebase-apply/onto" ] && o=$(head -c 100 "$g/rebase-apply/onto")
if [ -n "$o" ]; then
  printf '%s\0' onto-refs
  git for-each-ref --points-at="$o" --format='%(refname)' 2>/dev/null
  printf '\0'
fi
exit 0"#;

/// The words of [`STATE`], for a batch with the status read.
pub(crate) fn state_words() -> Vec<String> {
    let mut w: Vec<String> = ["sh", "-c", STATE, "sh"].map(String::from).to_vec();
    w.extend(FILES.iter().map(|f| f.to_string()));
    w
}

/// What [`STATE`] printed, as file name to content.
pub(crate) fn parse_state(stdout: &[u8]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut parts = stdout.split(|b| *b == 0);
    while let (Some(name), Some(body)) = (parts.next(), parts.next()) {
        let name = lossy(name);
        if !name.is_empty() {
            out.insert(name, lossy(body));
        }
    }
    out
}

/// The state files in the git folder `git_dir` on this computer, and the refs at a rebase's base.
pub(crate) fn read_local(root: &At, git_dir: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for f in FILES {
        let p = git_dir.join(f);
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&p) {
            let cut = bytes.len().min(STATE_CAP);
            out.insert(f.to_string(), lossy(&bytes[..cut]));
        }
    }
    let onto = out.get("rebase-merge/onto").or_else(|| out.get("rebase-apply/onto")).map(|s| s.trim().to_string());
    if let Some(onto) = onto.filter(|o| safe_hash(o).is_ok()) {
        if let Ok(refs) = git(root).read_only().arg("for-each-ref").arg(format!("--points-at={onto}")).arg("--format=%(refname)").run() {
            if refs.ok() {
                out.insert(ONTO_REFS.to_string(), refs.text());
            }
        }
    }
    out
}

fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).map(str::to_string)
}

/// A commit message as `git commit` would keep it: comment lines and trailing space gone.
pub(crate) fn clean_message(text: &str) -> Option<String> {
    let kept: Vec<&str> = text.lines().filter(|l| !l.starts_with('#')).map(str::trim_end).collect();
    let joined = kept.join("\n");
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn short(oid: &str) -> Option<String> {
    let oid = oid.trim();
    safe_hash(oid).ok().map(|h| h.chars().take(7).collect())
}

fn full(oid: Option<&String>) -> Option<String> {
    oid.map(|o| o.trim()).filter(|o| safe_hash(o).is_ok() && o.len() >= 40).map(str::to_string)
}

/// The name in a merge message: `Merge branch 'x'`, `Merge remote-tracking branch 'origin/x'`,
/// `Merge tag 'v1'`, `Merge commit 'abc'`; a pull's `Merge branch 'main' of <url>` is the upstream.
fn merged_name(msg: &str, upstream: Option<&str>) -> Option<String> {
    let line = first_line(msg)?;
    let rest = line.strip_prefix("Merge ")?;
    let open = rest.find('\'')?;
    let close = open + 1 + rest[open + 1..].find('\'')?;
    let name = &rest[open + 1..close];
    if name.is_empty() {
        return None;
    }
    if rest[close + 1..].trim_start().starts_with("of ") {
        if let Some(up) = upstream {
            return Some(up.to_string());
        }
    }
    Some(name.to_string())
}

/// The best name for a rebase's base among the refs pointing at it: a branch other than the one
/// being rebased, then a remote branch, then a tag.
fn onto_name(refs: &str, rebasing: Option<&str>) -> Option<String> {
    let names: Vec<&str> = refs.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let pick = |prefix: &str| {
        names
            .iter()
            .filter_map(|n| n.strip_prefix(prefix))
            .find(|n| Some(*n) != rebasing && !n.ends_with("/HEAD"))
            .map(str::to_string)
    };
    pick("refs/heads/").or_else(|| pick("refs/remotes/")).or_else(|| pick("refs/tags/"))
}

/// What is in progress, from the state files (see [`FILES`]). `branch` and `upstream` are the
/// status's own.
pub(crate) fn parse_operation(files: &HashMap<String, String>, branch: Option<&str>, upstream: Option<&str>) -> Option<GitOperation> {
    let get = |name: &str| files.get(name);
    let num = |name: &str| get(name).and_then(|s| s.trim().parse::<u32>().ok());
    let none = GitOperation {
        kind: "merge",
        branch: branch.map(str::to_string),
        incoming: None,
        commit: None,
        subject: None,
        step: None,
        steps: None,
        message: None,
        revs: None,
    };

    // A rebase: `rebase-merge/` (the default), or `rebase-apply/` unless that is `git am`.
    let apply = get("rebase-apply/head-name").is_some() || get("rebase-apply/rebasing").is_some();
    let apply = apply && get("rebase-apply/applying").is_none();
    if get("rebase-merge/head-name").is_some() || get("rebase-merge/onto").is_some() || apply {
        let dir = if apply && get("rebase-merge/onto").is_none() { "rebase-apply" } else { "rebase-merge" };
        let at = |f: &str| format!("{dir}/{f}");
        let rebasing = get(&at("head-name"))
            .map(|s| s.trim())
            .and_then(|s| s.strip_prefix("refs/heads/"))
            .map(str::to_string);
        let onto = get(&at("onto")).map(|s| s.trim().to_string());
        let incoming = get(ONTO_REFS)
            .and_then(|refs| onto_name(refs, rebasing.as_deref()))
            .or_else(|| onto.as_deref().and_then(short));
        let stopped = if dir == "rebase-merge" { get("rebase-merge/stopped-sha") } else { get("rebase-apply/original-commit") };
        let commit = stopped.or(get("REBASE_HEAD")).and_then(|s| short(s));
        let message = get("rebase-merge/message").filter(|_| dir == "rebase-merge").and_then(|m| clean_message(m));
        let (step, steps) = if dir == "rebase-merge" { (num("rebase-merge/msgnum"), num("rebase-merge/end")) } else { (num("rebase-apply/next"), num("rebase-apply/last")) };
        let revs = full(onto.as_ref()).zip(full(get(&at("orig-head"))));
        return Some(GitOperation {
            kind: "rebase",
            branch: rebasing,
            incoming,
            commit,
            subject: message.as_deref().and_then(first_line),
            step,
            steps,
            message,
            revs,
        });
    }

    let message = get("MERGE_MSG").and_then(|m| clean_message(m));
    if let Some(head) = get("MERGE_HEAD") {
        let first = head.lines().next().unwrap_or("").trim().to_string();
        let incoming = get("MERGE_MSG").and_then(|m| merged_name(m, upstream)).or_else(|| short(&first));
        return Some(GitOperation {
            incoming,
            revs: full(Some(&first)).map(|t| ("HEAD".to_string(), t)),
            message,
            ..none
        });
    }
    for (file, kind) in [("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")] {
        if let Some(oid) = get(file) {
            let oid = oid.trim().to_string();
            return Some(GitOperation {
                kind,
                incoming: short(&oid),
                commit: short(&oid),
                subject: message.as_deref().and_then(first_line),
                revs: full(Some(&oid)).map(|t| ("HEAD".to_string(), t)),
                message,
                ..none
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Abort, continue, skip
// ---------------------------------------------------------------------------

fn in_progress(root: &At) -> Result<GitOperation, String> {
    status_of(root)?.operation.ok_or_else(|| "Nothing is in progress here any more: no merge, rebase, cherry-pick or revert.".to_string())
}

/// The paths still in conflict, for messages.
fn conflicted(root: &At) -> Vec<String> {
    super::read_status(root, false).map(|s| s.files.into_iter().filter(|f| f.conflicted).map(|f| f.path).collect()).unwrap_or_default()
}

/// What to say when an operation stopped (again) on conflicts; None when there are none.
pub(crate) fn stopped_on_conflicts(root: &At, what: &str) -> Option<String> {
    let list = conflicted(root);
    if list.is_empty() {
        return None;
    }
    let shown: Vec<String> = list.iter().take(12).map(|p| format!("  {p}")).collect();
    let more = list.len().saturating_sub(shown.len());
    Some(format!(
        "{what} stopped: conflicts in {} file{}.\n{}{}\nResolve them in the Changes view, or abort from the bar at its top.",
        list.len(),
        if list.len() == 1 { "" } else { "s" },
        shown.join("\n"),
        if more > 0 { format!("\n  …and {more} more") } else { String::new() },
    ))
}

fn word(kind: &str) -> &'static str {
    match kind {
        "rebase" => "Rebase",
        "cherry-pick" => "Cherry-pick",
        "revert" => "Revert",
        _ => "Merge",
    }
}

/// Go back to before the operation started (`git <kind> --abort`). Destroys its resolutions: the
/// UI asks first.
pub(crate) fn abort(at: &At) -> Result<String, String> {
    let root = require_root(at)?;
    let op = in_progress(&root)?;
    git(&root).slow().arg(op.kind).arg("--abort").run_ok(&format!("git {} --abort", op.kind))?;
    Ok(format!("{} aborted. Everything is as it was before it started.", word(op.kind)))
}

/// Carry on once the conflicts are resolved (`git <kind> --continue`), without an editor: the
/// message is the one git prepared.
pub(crate) fn proceed(at: &At) -> Result<String, String> {
    let root = require_root(at)?;
    let op = in_progress(&root)?;
    let left = conflicted(&root).len();
    if left > 0 {
        return Err(format!(
            "{left} file{} still {} conflicts. Resolve {}, then continue.",
            if left == 1 { "" } else { "s" },
            if left == 1 { "has" } else { "have" },
            if left == 1 { "it" } else { "them" }
        ));
    }
    let out = no_editor(git(&root).slow()).args(["-c", "core.editor=true"]).arg(op.kind).arg("--continue").run()?;
    after_step(&root, &op, out, "continue")
}

/// Rebase (or cherry-pick): leave out the commit being applied and go on with the next.
pub(crate) fn skip(at: &At) -> Result<String, String> {
    let root = require_root(at)?;
    let op = in_progress(&root)?;
    if !matches!(op.kind, "rebase" | "cherry-pick") {
        return Err(format!("A {} has no commit to skip. Abort it, or resolve and finish it.", op.kind));
    }
    let out = no_editor(git(&root).slow()).arg(op.kind).arg("--skip").run()?;
    after_step(&root, &op, out, "skip")
}

fn no_editor(g: super::Git<'_>) -> super::Git<'_> {
    let mut g = g;
    g.env.push(("GIT_EDITOR", "true"));
    g.env.push(("GIT_SEQUENCE_EDITOR", "true"));
    g
}

fn after_step(root: &At, op: &GitOperation, out: Output, how: &str) -> Result<String, String> {
    let now = status_of(root).ok().and_then(|s| s.operation);
    if out.ok() {
        return Ok(match (now, op.kind) {
            (Some(next), "rebase") => match (next.step, next.steps) {
                (Some(n), Some(m)) => format!("Rebase stopped at step {n} of {m}."),
                _ => "Rebase stopped again.".into(),
            },
            (Some(_), _) => format!("{} is still in progress.", word(op.kind)),
            (None, "rebase") => match &op.branch {
                Some(b) => format!("Rebase finished: {b} is up to date with {}.", op.incoming.as_deref().unwrap_or("its new base")),
                None => "Rebase finished.".into(),
            },
            (None, kind) => format!("{} finished.", word(kind)),
        });
    }
    if let Some(report) = stopped_on_conflicts(root, word(op.kind)) {
        return Err(report);
    }
    Err(out.error(&format!("git {} --{how}", op.kind)))
}

// ---------------------------------------------------------------------------
// The sides of a conflicted file
// ---------------------------------------------------------------------------

fn side_of(out: &Output, binary: &mut bool, too_large: &mut bool) -> GitConflictSide {
    if !out.ok() && !out.truncated {
        return GitConflictSide::default();
    }
    if out.truncated || out.stdout.len() > BASE_CAP {
        *too_large = true;
        return GitConflictSide { present: true, text: None };
    }
    if out.stdout.contains(&0) {
        *binary = true;
        return GitConflictSide { present: true, text: None };
    }
    match String::from_utf8(out.stdout.clone()) {
        Ok(text) => GitConflictSide { present: true, text: Some(text) },
        Err(_) => {
            *binary = true;
            GitConflictSide { present: true, text: None }
        }
    }
}

/// The base, ours and theirs of a conflicted `file` (relative to the repository root), from the
/// index's stages 1, 2 and 3, read in one go.
pub(crate) fn conflict_of(at: &At, file: &str) -> Result<GitConflict, String> {
    let root = require_root(at)?;
    let file = clean_rel(file)?.replace('\\', "/");
    let stage = |n: u8| git(&root).read_only().cap(BASE_CAP + 1).args(["cat-file", "blob"]).arg(format!(":{n}:{file}"));
    let [b, o, t]: [Output; 3] = run_all(vec![stage(1), stage(2), stage(3)])?.try_into().map_err(|_| "git gave no answer")?;
    let (mut binary, mut too_large) = (false, false);
    let base = side_of(&b, &mut binary, &mut too_large);
    let ours = side_of(&o, &mut binary, &mut too_large);
    let theirs = side_of(&t, &mut binary, &mut too_large);
    if !base.present && !ours.present && !theirs.present {
        return Err(format!("{file} is not in conflict any more."));
    }
    Ok(GitConflict { base, ours, theirs, binary, too_large })
}

/// Which stages the index holds for `file` (1 base, 2 ours, 3 theirs).
fn stages(root: &At, file: &str) -> Result<Vec<u8>, String> {
    let out = git(root).read_only().args(["ls-files", "-u", "-z", "--"]).arg(file).run_ok("git ls-files")?;
    Ok(out
        .stdout
        .split(|b| *b == 0)
        .filter_map(|rec| {
            let meta = rec.split(|b| *b == b'\t').next()?;
            let n = meta.split(|b| *b == b' ').nth(2)?;
            (n.len() == 1).then(|| n[0].wrapping_sub(b'0'))
        })
        .collect())
}

/// Put one side's whole `file` in the working tree (`git checkout --ours|--theirs`); a side that
/// deleted the file deletes it. The file stays in conflict until the user marks it resolved.
pub(crate) fn take(at: &At, file: &str, side: &str) -> Result<(), String> {
    let root = require_root(at)?;
    let file = clean_rel(file)?;
    let (flag, stage) = match side {
        "ours" => ("--ours", 2u8),
        "theirs" => ("--theirs", 3u8),
        _ => return Err(format!("\"{side}\" is not a side of a conflict")),
    };
    let have = stages(&root, file)?;
    if have.is_empty() {
        return Err(format!("{file} is not in conflict any more."));
    }
    if have.contains(&stage) {
        git(&root).args(["checkout", flag, "--"]).arg(file).run_ok("git checkout")?;
        return Ok(());
    }
    // That side deleted it.
    if entry(&root, file)? == Entry::Dir {
        return Err(format!("{file} is a folder here; resolve it in a terminal."));
    }
    remove_untracked_at(&root, file)
}

/// The commit subjects on each side of the operation in progress since they met, at most `cap`
/// each, both read in one go. A cherry-pick or revert has only its own commit.
pub(crate) fn history(at: &At, cap: u32) -> Result<GitConflictHistory, String> {
    let root = require_root(at)?;
    let op = in_progress(&root)?;
    let Some((ours, theirs)) = op.revs.clone() else { return Ok(GitConflictHistory::default()) };
    let log = |range: Vec<String>| {
        git(&root)
            .read_only()
            .args(["log", "--no-show-signature", "--no-color", "--format=%s"])
            .arg(format!("--max-count={}", cap.clamp(1, 200)))
            .args(range)
            .arg("--")
    };
    let picked = matches!(op.kind, "cherry-pick" | "revert");
    let (a, b) = if picked {
        (Vec::new(), vec!["-1".to_string(), theirs.clone()])
    } else {
        (vec![format!("{theirs}..{ours}")], vec![format!("{ours}..{theirs}")])
    };
    let mut cmds = vec![log(b)];
    if !picked {
        cmds.insert(0, log(a));
    }
    let outs = run_all(cmds)?;
    let lines = |o: &Output| if o.ok() { o.text().lines().map(str::to_string).filter(|l| !l.is_empty()).collect() } else { Vec::new() };
    Ok(match outs.as_slice() {
        [t] => GitConflictHistory { ours: Vec::new(), theirs: lines(t) },
        [o, t] => GitConflictHistory { ours: lines(o), theirs: lines(t) },
        _ => GitConflictHistory::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }
    const A: &str = "9d4788ea0403fe49e59fe4996912e89cb3715e2f";
    const B: &str = "a303afd3ca3f4bff44632632b6e963dfbb8b1079";

    #[test]
    fn merge_names() {
        assert_eq!(merged_name("Merge branch 'feature/x'\n\n# Conflicts:\n#\ta.txt\n", None).as_deref(), Some("feature/x"));
        assert_eq!(merged_name("Merge branch 'x' into dev\n", None).as_deref(), Some("x"));
        assert_eq!(merged_name("Merge remote-tracking branch 'origin/main'", None).as_deref(), Some("origin/main"));
        assert_eq!(merged_name("Merge branch 'main' of github.com:o/r", Some("origin/main")).as_deref(), Some("origin/main"));
        assert_eq!(merged_name("Merge tag 'v1.2'", None).as_deref(), Some("v1.2"));
        assert_eq!(merged_name("Merge ''", None), None);
        assert_eq!(merged_name("Squashed commit", None), None);
        assert_eq!(merged_name("", None), None);
    }

    #[test]
    fn messages_lose_comments() {
        assert_eq!(clean_message("Merge branch 'x'\n\n# Conflicts:\n#\ta.txt\n").as_deref(), Some("Merge branch 'x'"));
        assert_eq!(clean_message("# only\n\n").as_deref(), None);
    }

    #[test]
    fn state_from_files() {
        assert_eq!(parse_operation(&files(&[]), Some("main"), None), None);

        let m = parse_operation(&files(&[("MERGE_HEAD", &format!("{A}\n")), ("MERGE_MSG", "Merge branch 'feature/x'\n\n# Conflicts:\n")]), Some("main"), None).unwrap();
        assert_eq!((m.kind, m.branch.as_deref(), m.incoming.as_deref(), m.message.as_deref()), ("merge", Some("main"), Some("feature/x"), Some("Merge branch 'feature/x'")));
        assert_eq!(m.revs, Some(("HEAD".into(), A.into())));
        // Without a message, the hash names it.
        let m = parse_operation(&files(&[("MERGE_HEAD", A)]), Some("main"), None).unwrap();
        assert_eq!(m.incoming.as_deref(), Some("9d4788e"));

        let r = parse_operation(
            &files(&[
                ("rebase-merge/head-name", "refs/heads/feature/x\n"),
                ("rebase-merge/onto", &format!("{A}\n")),
                ("rebase-merge/orig-head", &format!("{B}\n")),
                ("rebase-merge/msgnum", "2\n"),
                ("rebase-merge/end", "5\n"),
                ("rebase-merge/stopped-sha", &format!("{B}\n")),
                ("rebase-merge/message", "feat one\n\nbody\n# Conflicts:\n"),
                (ONTO_REFS, "refs/heads/feature/x\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/heads/main\n"),
            ]),
            None,
            None,
        )
        .unwrap();
        assert_eq!((r.kind, r.branch.as_deref(), r.incoming.as_deref()), ("rebase", Some("feature/x"), Some("main")));
        assert_eq!((r.step, r.steps, r.commit.as_deref(), r.subject.as_deref()), (Some(2), Some(5), Some("a303afd"), Some("feat one")));
        assert_eq!(r.revs, Some((A.into(), B.into())));
        // Only the hash when no ref points there; the remote branch over a tag.
        let r = parse_operation(&files(&[("rebase-merge/head-name", "detached HEAD"), ("rebase-merge/onto", A)]), None, None).unwrap();
        assert_eq!((r.branch, r.incoming.as_deref()), (None, Some("9d4788e")));
        assert_eq!(onto_name("refs/tags/v1\nrefs/remotes/origin/main\n", None).as_deref(), Some("origin/main"));

        // The apply backend, and `git am` (not a rebase).
        let r = parse_operation(&files(&[("rebase-apply/rebasing", ""), ("rebase-apply/head-name", "refs/heads/x"), ("rebase-apply/onto", A), ("rebase-apply/next", "1"), ("rebase-apply/last", "3")]), None, None).unwrap();
        assert_eq!((r.kind, r.step, r.steps), ("rebase", Some(1), Some(3)));
        assert_eq!(parse_operation(&files(&[("rebase-apply/applying", ""), ("rebase-apply/next", "1")]), Some("x"), None), None);

        let c = parse_operation(&files(&[("CHERRY_PICK_HEAD", B), ("MERGE_MSG", "feat one\n\n# Conflicts:\n")]), Some("main"), None).unwrap();
        assert_eq!((c.kind, c.commit.as_deref(), c.subject.as_deref()), ("cherry-pick", Some("a303afd"), Some("feat one")));
        let v = parse_operation(&files(&[("REVERT_HEAD", B), ("MERGE_MSG", "Revert \"feat one\"\n\nThis reverts commit x.\n")]), Some("main"), None).unwrap();
        assert_eq!((v.kind, v.subject.as_deref()), ("revert", Some("Revert \"feat one\"")));
        // Junk in a state file is never a hash passed on.
        let j = parse_operation(&files(&[("MERGE_HEAD", "--upload-pack=x")]), Some("main"), None).unwrap();
        assert_eq!((j.incoming, j.revs), (None, None));
    }

    #[test]
    fn state_script_output() {
        let out = b"MERGE_HEAD\0abc\n\0MERGE_MSG\0Merge branch 'x'\n\0onto-refs\0refs/heads/main\n\0";
        let m = parse_state(out);
        assert_eq!(m.get("MERGE_HEAD").map(String::as_str), Some("abc\n"));
        assert_eq!(m.get(ONTO_REFS).map(String::as_str), Some("refs/heads/main\n"));
        assert!(parse_state(b"").is_empty());
        // Cut short: what is whole is kept.
        assert_eq!(parse_state(b"MERGE_HEAD\0abc\0MERGE_MSG").len(), 1);
    }
}
