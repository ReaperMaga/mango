//! Lore's file locks (`lore lock`), behind the same lock UI as Unity VCS: binary assets can't be
//! merged, so a lock says "I'm editing this" to everyone on the server.
//!
//! - list: `lore lock query` (every branch), one `<path> by <owner> on branch <id>` line each;
//! - lock: `lore lock acquire`; Lore locks only files it already tracks;
//! - release: `lore lock release`, which releases the user's own locks.
//!
//! Which locks are the user's: a server without sign-in names no owner (`<unknown>`), so every
//! lock there is the user's own; otherwise the owner is compared with the identities the CLI
//! has stored (`lore auth list`). Proven against lore 0.14.0 with sign-in off only.

use crate::git::{chunks, clean_rel, env_batch, At, Output, LOCAL_TIMEOUT};
use crate::vcs::VcsLock;

use super::{explain, lore, missing_in_env, parse};

/// The owner Lore prints when the server identifies nobody.
const NOBODY: &str = "<unknown>";

pub(crate) fn locks(root: &At) -> Result<Vec<VcsLock>, String> {
    let query = lore(root).args(["lock", "query"]);
    let who = lore(root).args(["auth", "list"]);
    // One round trip in an environment.
    let (list, me): (Output, Option<Output>) = match root {
        At::Env(e) => {
            let mut outs = env_batch(e, false, &[(query.words(), 1 << 20), (who.words(), 64 * 1024)], LOCAL_TIMEOUT)?;
            if let Some(missing) = outs.iter().find_map(|o| missing_in_env(e, o)) {
                return Err(missing);
            }
            let me = outs.pop();
            (outs.pop().ok_or("lore gave no answer")?, me)
        }
        At::Local(_) => (query.run()?, who.run().ok()),
    };
    if !list.ok() {
        return Err(explain(&list));
    }
    let me = me.filter(Output::ok).map(|o| o.text()).unwrap_or_default();
    Ok(parse::parse_locks(&list.text())
        .into_iter()
        .map(|(path, owner)| VcsLock {
            mine: owner == NOBODY || (owner.len() > 2 && me.split_whitespace().any(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.') == owner)),
            owner: if owner == NOBODY { String::new() } else { owner },
            path,
            workspace: String::new(),
            branch: String::new(),
            status: "locked",
            time: None,
            item_id: 0,
        })
        .collect())
}

/// Lock files. Returns a note naming the ones Lore didn't lock; empty when all are.
pub(crate) fn lock(root: &At, files: &[String]) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    files.iter().try_for_each(|f| clean_rel(f).map(|_| ()))?;
    let mut locked: Vec<String> = Vec::new();
    for chunk in chunks(files) {
        let out = lore(root).write().args(["lock", "acquire", "--"]).args(chunk).run()?;
        if !out.ok() {
            let e = explain(&out);
            return Err(if e.contains("Node not found") {
                format!("Lore locks only files it already tracks; commit new files before locking them.\n\n{e}")
            } else {
                e
            });
        }
        let text = out.text();
        locked.extend(parse::listed_under(&text, "Lock acquired on files:"));
        locked.extend(parse::listed_under(&text, "Lock already owned on files:"));
    }
    let left: Vec<&String> = files.iter().filter(|f| !locked.contains(f)).collect();
    Ok(match left.as_slice() {
        [] => String::new(),
        [one] => format!("Lore didn't lock {one}."),
        many => format!("Lore didn't lock {} of the files.", many.len()),
    })
}

/// Release the user's own locks on files.
pub(crate) fn unlock(root: &At, files: &[String]) -> Result<(), String> {
    files.iter().try_for_each(|f| clean_rel(f).map(|_| ()))?;
    for chunk in chunks(files) {
        lore(root).write().args(["lock", "release", "--"]).args(chunk).run_ok()?;
    }
    Ok(())
}
