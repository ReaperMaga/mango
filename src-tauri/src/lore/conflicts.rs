//! A Lore merge waiting to be committed: what it merges (for the banner), aborting it, the sides
//! of a conflicted file and taking one whole. Proven against lore 0.14.0+2389 in offline scratch
//! repositories (`tests::real_lore_merge`):
//!
//! - `lore status` says `Pending merge, incoming revision <signature>` until the merge is committed
//!   (or aborted); conflicts are listed under "Changes in conflict:";
//! - a conflicted file holds diff3 markers (`<<<<<<< ours`, `||||||| original`, `=======`,
//!   `>>>>>>> theirs`), binary files too; beside it Lore writes `<file>~base`, `<file>~mine` and
//!   `<file>~theirs`, the sides that have it (a side that deleted the file has none; when theirs
//!   deleted it, the file itself is mine and there is no `~mine`);
//! - `branch merge resolve -- <file>` refuses (exit 0, a `[Warn]` line) while markers are left;
//!   `resolve mine|theirs -- <file>` writes that side (or deletes the file) and resolves it at once;
//! - `commit` refuses while a conflict is left, and commits the merge with two parents otherwise,
//!   removing the `~` files; `branch merge abort` puts everything back, `~` files gone too.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::{lore, parse, read_capped, sh_words, At, Output};
use crate::git::{clean_rel, GitConflict, GitConflictSide, GitOperation, BASE_CAP, LOCAL_TIMEOUT};

/// What each incoming revision (by signature) is called: the branch Mango merged, or `r<n>`.
fn names() -> &'static Mutex<HashMap<String, String>> {
    static NAMES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    NAMES.get_or_init(Default::default)
}

/// A merge Mango started: its incoming revision is that branch.
pub(crate) fn remember_merge(output: &str, branch: &str) {
    if let (Some(sig), Ok(mut map)) = (parse::merge_started(output), names().lock()) {
        map.insert(sig, branch.to_string());
    }
}

fn known_name(sig: &str) -> Option<String> {
    names().lock().ok()?.get(sig).cloned()
}

/// Name the incoming revision of a merge started elsewhere (a terminal, another app): its number,
/// read once per merge.
pub(crate) fn learn_name(root: &At, s: &parse::Status) {
    let Some(sig) = s.incoming.as_deref() else { return };
    if known_name(sig).is_some() || s.remote_signature.as_deref() == Some(sig) {
        return;
    }
    let number = lore(root)
        .args(["revision", "info", "--"])
        .arg(sig)
        .run()
        .ok()
        .filter(Output::ok)
        .and_then(|out| parse::parse_revisions(&out.text()).first().map(|r| r.number));
    if let (Some(n), Ok(mut map)) = (number, names().lock()) {
        map.insert(sig.to_string(), format!("r{n}"));
    }
}

/// The merge in progress, as the banner shows it.
pub(crate) fn operation(s: &parse::Status) -> Option<GitOperation> {
    if !s.merging {
        return None;
    }
    let incoming = s.incoming.as_deref().and_then(|sig| {
        if s.remote_signature.as_deref() == Some(sig) {
            s.branch.as_ref().map(|b| format!("{}/{b}", super::REMOTE))
        } else {
            known_name(sig)
        }
    });
    let message = match (&incoming, &s.branch) {
        (Some(from), Some(into)) => format!("Merge {from} into {into}"),
        (Some(from), None) => format!("Merge {from}"),
        (None, Some(into)) => format!("Merge into {into}"),
        (None, None) => "Merge".to_string(),
    };
    Some(GitOperation {
        kind: "merge",
        branch: s.branch.clone(),
        incoming,
        commit: None,
        subject: None,
        step: None,
        steps: None,
        message: Some(message),
        revs: None,
    })
}

/// `lore branch merge abort`: back to before the merge.
pub(crate) fn abort(root: &At) -> Result<String, String> {
    let (s, _) = super::read_status(root)?;
    if !s.merging {
        return Err("No merge is in progress here any more.".into());
    }
    lore(root).write().args(["branch", "merge", "abort"]).run_ok_offline_too()?;
    Ok("Merge aborted. Everything is as it was before it started.".into())
}

/// One of Lore's `~` files beside a conflicted file, or the file itself.
#[derive(Debug, PartialEq, Eq)]
enum Copy {
    None,
    TooLarge,
    Bytes(Vec<u8>),
}

/// `sh` script (in an environment's repository): for `$1~base`, `$1~mine`, `$1~theirs` and `$1`
/// itself, a header `MANGO-SIDE <name> none|big|some <bytes>` and, for `some`, the bytes. `$2` is
/// the most bytes read of one.
const SIDES: &str = r#"for s in base mine theirs work; do
  f="$1~$s"
  [ "$s" = work ] && f=$1
  if [ ! -f "$f" ]; then printf 'MANGO-SIDE %s none 0\n' "$s"; continue; fi
  n=$(wc -c <"$f" | tr -d ' ')
  if [ "$n" -gt "$2" ]; then printf 'MANGO-SIDE %s big 0\n' "$s"; continue; fi
  printf 'MANGO-SIDE %s some %s\n' "$s" "$n"
  cat -- "$f"
done"#;

/// What [`SIDES`] printed; None when it isn't all there.
fn parse_sides(out: &[u8]) -> Option<HashMap<String, Copy>> {
    let mut map = HashMap::new();
    let mut at = 0;
    while at < out.len() {
        let nl = at + out[at..].iter().position(|b| *b == b'\n')?;
        let head = std::str::from_utf8(&out[at..nl]).ok()?;
        let mut w = head.strip_prefix("MANGO-SIDE ")?.split(' ');
        let (name, kind, n) = (w.next()?, w.next()?, w.next()?.parse::<usize>().ok()?);
        at = nl + 1;
        let copy = match kind {
            "none" => Copy::None,
            "big" => Copy::TooLarge,
            "some" => {
                let bytes = out.get(at..at + n)?.to_vec();
                at += n;
                Copy::Bytes(bytes)
            }
            _ => return None,
        };
        map.insert(name.to_string(), copy);
    }
    Some(map)
}

fn read_local(path: &std::path::Path) -> Result<Copy, String> {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(read_capped(path, BASE_CAP)?.map_or(Copy::TooLarge, Copy::Bytes)),
        _ => Ok(Copy::None),
    }
}

/// The sides of a conflicted file: Lore's `~base`, `~mine` and `~theirs` beside it. Without a
/// `~mine`, the file itself is mine (theirs deleted it) when it is there.
pub(crate) fn conflict_of(root: &At, file: &str) -> Result<GitConflict, String> {
    let rel = clean_rel(file)?;
    let mut sides = match root {
        At::Local(dir) => {
            let mut map = HashMap::new();
            for s in ["base", "mine", "theirs"] {
                map.insert(s.to_string(), read_local(&dir.join(format!("{rel}~{s}")))?);
            }
            map.insert("work".to_string(), read_local(&dir.join(rel))?);
            map
        }
        At::Env(e) => {
            let cap = BASE_CAP.to_string();
            let out = e.run_plain(&[], &sh_words(SIDES, &[rel, &cap]), None, usize::MAX, LOCAL_TIMEOUT)?;
            parse_sides(&out.stdout).ok_or_else(|| format!("Could not read the sides of {rel} in {}.", e.instance))?
        }
    };
    let mut take = |name: &str| sides.remove(name).unwrap_or(Copy::None);
    let (base, mine, theirs, work) = (take("base"), take("mine"), take("theirs"), take("work"));
    if [&base, &mine, &theirs].iter().all(|c| **c == Copy::None) {
        return Err(format!("Lore keeps no sides of {rel}: it may not be in conflict any more."));
    }
    let mine = if mine == Copy::None { work } else { mine };
    let (mut binary, mut too_large) = (false, false);
    let mut side = |c: Copy| match c {
        Copy::None => GitConflictSide::default(),
        Copy::TooLarge => {
            too_large = true;
            GitConflictSide { present: true, text: None }
        }
        Copy::Bytes(b) => match String::from_utf8(b).ok().filter(|t| !t.contains('\0')) {
            Some(text) => GitConflictSide { present: true, text: Some(text) },
            None => {
                binary = true;
                GitConflictSide { present: true, text: None }
            }
        },
    };
    let (base, ours, theirs) = (side(base), side(mine), side(theirs));
    Ok(GitConflict { base, ours, theirs, binary, too_large })
}

/// `branch merge resolve mine|theirs -- <file>`: that side's file, resolved at once.
pub(crate) fn take(root: &At, file: &str, side: &str) -> Result<(), String> {
    let rel = clean_rel(file)?;
    let which = match side {
        "ours" => "mine",
        "theirs" => "theirs",
        _ => return Err(format!("\"{side}\" is not a side of a conflict")),
    };
    lore(root).write().args(["branch", "merge", "resolve", which, "--"]).arg(rel).run_ok()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sides_script_output() {
        let out = b"MANGO-SIDE base some 4\nab\ncMANGO-SIDE mine big 0\nMANGO-SIDE theirs none 0\nMANGO-SIDE work some 0\n";
        let m = parse_sides(out).unwrap();
        assert_eq!(m["base"], Copy::Bytes(b"ab\nc".to_vec()));
        assert_eq!(m["mine"], Copy::TooLarge);
        assert_eq!(m["theirs"], Copy::None);
        assert_eq!(m["work"], Copy::Bytes(Vec::new()));
        assert!(parse_sides(b"MANGO-SIDE base some 9\nab").is_none());
        assert!(parse_sides(b"junk\n").is_none());
    }

    #[test]
    fn operation_names() {
        let sig = "15b818e4eadf9897f99e24e727ed7db2cdd2ef008fff891410d54806aba49331";
        let mut s = parse::Status { branch: Some("main".into()), merging: true, incoming: Some(sig.into()), ..Default::default() };
        let op = operation(&s).unwrap();
        assert_eq!((op.kind, op.branch.as_deref(), op.incoming.as_deref()), ("merge", Some("main"), None));
        remember_merge(&format!("Starting merge of branch 01a2 revision {sig}\n"), "feat");
        let op = operation(&s).unwrap();
        assert_eq!((op.incoming.as_deref(), op.message.as_deref()), (Some("feat"), Some("Merge feat into main")));
        // A sync's merge brings in the server's side of the branch.
        s.remote_signature = Some(sig.into());
        assert_eq!(operation(&s).unwrap().incoming.as_deref(), Some("remote/main"));
        s.merging = false;
        assert_eq!(operation(&s), None);
    }

    /// A merge with conflicts against a real `lore` in offline scratch repositories (no server):
    /// `cargo test --lib lore::conflicts::tests::real_lore_merge -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_lore_merge() {
        use super::super::{branch_create, checkout, commit, merge, stage, status};
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let dir = std::env::temp_dir().join(format!("mango-lore-merge-{id}"));
        std::fs::create_dir_all(&dir).unwrap();
        let root = At::local(&dir);
        lore(&root).args(["repository", "create", "--offline", "--"]).arg(format!("merge-{id}")).run_ok().unwrap();
        let write = |p: &str, b: &[u8]| std::fs::write(dir.join(p), b).unwrap();
        let commit_all = |msg: &str| {
            lore(&root).args(["stage", "--scan", "--", "."]).run_ok().unwrap();
            commit(&root, msg, false).unwrap()
        };
        let setup = |n: &str| {
            write("a.txt", b"one\ntwo\nthree\n");
            write("b.bin", &[0, 1]);
            write("del.txt", b"gone\n");
            write("mod.txt", b"mod\n");
            commit_all("base");
            branch_create(&root, n, None, true).unwrap();
            write("a.txt", b"one\nTWO-feat\nthree\n");
            write("b.bin", &[0, 2]);
            write("del.txt", b"gone-feat\n");
            std::fs::remove_file(dir.join("mod.txt")).unwrap();
            commit_all("feat one");
            checkout(&root, "main", false).unwrap();
            write("a.txt", b"one\ntwo-main\nthree\n");
            write("b.bin", &[0, 3]);
            std::fs::remove_file(dir.join("del.txt")).unwrap();
            write("mod.txt", b"mod-main\n");
            commit_all("main change");
        };
        setup("feat");

        let said = merge(&root, "feat").unwrap();
        println!("merge: {said}");
        let s = status(&root).unwrap();
        let op = s.operation.clone().unwrap();
        assert_eq!((op.kind, op.branch.as_deref(), op.incoming.as_deref()), ("merge", Some("main"), Some("feat")));
        assert_eq!(op.message.as_deref(), Some("Merge feat into main"));
        let mut conflicted: Vec<&str> = s.files.iter().filter(|f| f.conflicted).map(|f| f.path.as_str()).collect();
        conflicted.sort();
        assert_eq!(conflicted, vec!["a.txt", "b.bin", "del.txt", "mod.txt"]);
        let text = std::fs::read_to_string(dir.join("a.txt")).unwrap();
        assert!(text.contains("<<<<<<< ours\ntwo-main\n||||||| original\ntwo\n=======\nTWO-feat\n>>>>>>> theirs\n"), "{text}");

        let a = conflict_of(&root, "a.txt").unwrap();
        assert_eq!((a.base.text.as_deref(), a.ours.text.as_deref(), a.theirs.text.as_deref()), (Some("one\ntwo\nthree\n"), Some("one\ntwo-main\nthree\n"), Some("one\nTWO-feat\nthree\n")));
        assert!(conflict_of(&root, "b.bin").unwrap().binary);
        let d = conflict_of(&root, "del.txt").unwrap();
        assert!(!d.ours.present && d.theirs.present, "{d:?}");
        let m = conflict_of(&root, "mod.txt").unwrap();
        assert!(m.ours.present && !m.theirs.present, "{m:?}");
        assert_eq!(m.ours.text.as_deref(), Some("mod-main\n"));

        // Marking resolved with markers left is refused; taking a side resolves at once.
        let refused = stage(&root, &["a.txt".into()]).unwrap_err();
        assert!(refused.contains("conflict markers"), "{refused}");
        take(&root, "b.bin", "ours").unwrap();
        take(&root, "mod.txt", "theirs").unwrap();
        assert!(!dir.join("mod.txt").exists());
        take(&root, "del.txt", "theirs").unwrap();
        write("a.txt", b"one\ntwo-main TWO-feat\nthree\n");
        status(&root).unwrap();
        stage(&root, &["a.txt".into()]).unwrap();
        let s = status(&root).unwrap();
        assert!(s.files.iter().all(|f| !f.conflicted), "{:?}", s.files);
        assert!(s.operation.is_some());
        let r = commit(&root, "Merge feat into main", false).unwrap();
        println!("merge committed as {r}");
        let s = status(&root).unwrap();
        assert!(s.operation.is_none() && s.files.is_empty(), "{:?}", s.files);
        assert!(!dir.join("a.txt~mine").exists());

        // Merge again from a second branch, then abort.
        branch_create(&root, "feat2", None, true).unwrap();
        write("a.txt", b"feat2\n");
        commit_all("feat2");
        checkout(&root, "main", false).unwrap();
        write("a.txt", b"main2\n");
        commit_all("main2");
        merge(&root, "feat2").unwrap();
        assert!(status(&root).unwrap().operation.is_some());
        assert!(abort(&root).unwrap().starts_with("Merge aborted"));
        let s = status(&root).unwrap();
        assert!(s.operation.is_none() && s.files.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "main2\n");
        assert!(!dir.join("a.txt~theirs").exists());
        assert!(abort(&root).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
