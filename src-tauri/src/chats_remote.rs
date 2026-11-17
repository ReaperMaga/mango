//! Chats of remote projects, kept inside their environment too, so every computer that
//! opens the environment sees them (`app/utils/remoteChats.ts` decides what to send).
//!
//! The local chat history (`chats.rs`) stays the working copy; this is the shared one. It
//! lives in the agent user's home inside the instance, one folder per environment:
//!
//! ```text
//! ~/.local/share/mango/chats/<id>.json   the chat, as the frontend's JSON
//! ~/.local/share/mango/chats/<id>.at     its revision (when it was last saved there, ms): listing reads only these
//! ~/.local/share/mango/chats/<id>.gone   deleted: empty, kept so other computers drop it too
//! ```
//!
//! Each command is one fixed `sh` script run as the agent user over the environment's
//! shared SSH connection; chat ids are checked here and reach the scripts only as arguments.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::envs::{hosts, valid_instance, AGENT_HOME};
use crate::git::{blocking, lossy, EnvAt, Output, LOCAL_TIMEOUT};

/// A larger answer than this is refused rather than half read.
const FETCH_CAP: usize = 512 * 1024 * 1024;
const MAX_IDS: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteChatEntry {
    pub id: String,
    /// The saved copy's revision (when it was saved, ms); `None`: the chat was deleted.
    pub rev: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemotePut {
    /// Saved.
    Ok,
    /// Not saved: the copy there changed since `base` (another computer saved it).
    Stale,
    /// Not saved: the chat was deleted elsewhere.
    Gone,
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("{id:?} is not a chat id."));
    }
    Ok(())
}

fn env_at(app: &AppHandle, host_id: &str, instance: &str) -> Result<EnvAt, String> {
    valid_instance(instance)?;
    Ok(EnvAt { host: hosts::get(app, host_id)?, instance: instance.to_string(), dir: AGENT_HOME.to_string() })
}

/// Run `script` with `args` as `$1…` (and `stdin`) in the instance; a failure is an error.
fn sh(env: &EnvAt, script: &str, args: &[String], stdin: Option<Vec<u8>>, cap: usize, timeout: Duration) -> Result<Output, String> {
    let mut argv: Vec<String> = ["sh", "-c", script, "sh"].map(String::from).to_vec();
    argv.extend(args.iter().cloned());
    let out = env.run_plain(&[], &argv, stdin, cap, timeout)?;
    if out.truncated {
        return Err(format!("The chats saved in {} are too large to read.", env.instance));
    }
    if !out.ok() {
        return Err(format!("Could not reach the chats saved in {}: {}", env.instance, out.error("The command")));
    }
    Ok(out)
}

const LIST: &str = r#"
d="$HOME/.local/share/mango/chats"
[ -d "$d" ] || exit 0
cd "$d" || exit 1
for f in *.at; do [ -f "$f" ] && { printf '%s ' "${f%.at}"; head -n 1 -- "$f"; }; done
for f in *.gone; do [ -f "$f" ] && printf '%s -\n' "${f%.gone}"; done
exit 0
"#;

fn parse_list(text: &str) -> Vec<RemoteChatEntry> {
    let mut out: Vec<RemoteChatEntry> = Vec::new();
    for line in text.lines() {
        let Some((id, at)) = line.split_once(' ') else { continue };
        if valid_id(id).is_err() {
            continue;
        }
        let rev = match at.trim() {
            "-" => None,
            n => match n.parse::<i64>() {
                Ok(n) => Some(n),
                Err(_) => continue,
            },
        };
        // A tombstone wins over a copy left behind (a delete cut off half way).
        match out.iter_mut().find(|e| e.id == id) {
            Some(e) => {
                if rev.is_none() {
                    e.rev = None
                }
            }
            None => out.push(RemoteChatEntry { id: id.to_string(), rev }),
        }
    }
    out
}

const FETCH: &str = r#"
d="$HOME/.local/share/mango/chats"
cd "$d" 2>/dev/null || exit 0
for id; do [ -f "$id.json" ] && { cat -- "$id.json"; printf '\0'; }; done
exit 0
"#;

/// The NUL-separated chats `FETCH` printed (JSON never holds a raw NUL), only valid JSON.
fn parse_fetch(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|&b| b == 0)
        .filter(|c| !c.is_empty())
        .map(lossy)
        .filter(|s| serde_json::from_str::<serde::de::IgnoredAny>(s).is_ok())
        .collect()
}

const PUT: &str = r#"
d="$HOME/.local/share/mango/chats"
mkdir -p "$d" && chmod 700 "$d" && cd "$d" || exit 1
if [ -f "$1.gone" ]; then cat >/dev/null; echo gone; exit 0; fi
if [ -f "$1.at" ]; then
  have=$(head -n 1 -- "$1.at")
  case "$have" in ''|*[!0-9]*) ;; *) if [ "$have" -gt "$2" ]; then cat >/dev/null; echo stale; exit 0; fi ;; esac
fi
cat > ".$1.tmp" && mv -f ".$1.tmp" "$1.json" && printf '%s\n' "$3" > ".$1.at.tmp" && mv -f ".$1.at.tmp" "$1.at" || exit 1
echo ok
"#;

const REMOVE: &str = r#"
d="$HOME/.local/share/mango/chats"
mkdir -p "$d" && chmod 700 "$d" && cd "$d" || exit 1
for id; do : > "$id.gone" && rm -f -- "$id.json" "$id.at" || exit 1; done
"#;

fn ids_checked(ids: &[String]) -> Result<(), String> {
    if ids.len() > MAX_IDS {
        return Err(format!("At most {MAX_IDS} chats at a time."));
    }
    ids.iter().try_for_each(|id| valid_id(id))
}

/// Every chat saved in the environment, with when it last changed (no contents).
#[tauri::command]
pub async fn chats_remote_list(app: AppHandle, host_id: String, instance: String) -> Result<Vec<RemoteChatEntry>, String> {
    blocking(move || {
        let env = env_at(&app, &host_id, &instance)?;
        let out = sh(&env, LIST, &[], None, 16 * 1024 * 1024, LOCAL_TIMEOUT)?;
        Ok(parse_list(&out.text()))
    })
    .await
}

/// These chats' saved JSON (missing ones are left out).
#[tauri::command]
pub async fn chats_remote_fetch(app: AppHandle, host_id: String, instance: String, ids: Vec<String>) -> Result<Vec<String>, String> {
    ids_checked(&ids)?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    blocking(move || {
        let env = env_at(&app, &host_id, &instance)?;
        let out = sh(&env, FETCH, &ids, None, FETCH_CAP, LOCAL_TIMEOUT)?;
        Ok(parse_fetch(&out.stdout))
    })
    .await
}

/// Save one chat in the environment as revision `rev`, unless the copy there is newer than
/// `base` (the revision this computer last saw) or the chat was deleted there.
#[tauri::command]
pub async fn chats_remote_put(
    app: AppHandle,
    host_id: String,
    instance: String,
    id: String,
    base: i64,
    rev: i64,
    data: String,
) -> Result<RemotePut, String> {
    valid_id(&id)?;
    if base < 0 || rev <= base {
        return Err("A chat's revision must be newer than the one it replaces.".into());
    }
    serde_json::from_str::<serde::de::IgnoredAny>(&data).map_err(|_| format!("Chat {id:?} was not saved: its data is not valid JSON."))?;
    blocking(move || {
        let env = env_at(&app, &host_id, &instance)?;
        let out = sh(&env, PUT, &[id, base.to_string(), rev.to_string()], Some(data.into_bytes()), 4096, LOCAL_TIMEOUT)?;
        match out.line().as_str() {
            "ok" => Ok(RemotePut::Ok),
            "stale" => Ok(RemotePut::Stale),
            "gone" => Ok(RemotePut::Gone),
            other => Err(format!("Saving the chat in {} gave an unexpected answer: {other}", env.instance)),
        }
    })
    .await
}

/// Delete chats from the environment, leaving a mark so other computers drop them too.
#[tauri::command]
pub async fn chats_remote_remove(app: AppHandle, host_id: String, instance: String, ids: Vec<String>) -> Result<(), String> {
    ids_checked(&ids)?;
    if ids.is_empty() {
        return Ok(());
    }
    blocking(move || {
        let env = env_at(&app, &host_id, &instance)?;
        sh(&env, REMOVE, &ids, None, 4096, LOCAL_TIMEOUT).map(|_| ())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn checks_ids() {
        assert!(valid_id("t-lq3k9x2a_1").is_ok());
        for bad in ["", "../x", "a b", "a;b", "a/b", &"x".repeat(65)] {
            assert!(valid_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn parses_listing_with_tombstones_first() {
        let got = parse_list("a 12\nb 7\nbad id 3\nc x\nb -\nd -\n");
        assert_eq!(
            got,
            vec![
                RemoteChatEntry { id: "a".into(), rev: Some(12) },
                RemoteChatEntry { id: "b".into(), rev: None },
                RemoteChatEntry { id: "d".into(), rev: None },
            ]
        );
    }

    #[test]
    fn parses_fetched_chats() {
        assert_eq!(parse_fetch(b"{\"id\":\"a\"}\0{bad\0{\"id\":\"b\"}\0"), vec![r#"{"id":"a"}"#, r#"{"id":"b"}"#]);
    }

    /// The scripts themselves, run by the local `sh` against a scratch HOME.
    #[cfg(unix)]
    #[test]
    fn scripts_round_trip() {
        let home = std::env::temp_dir().join(format!("mango-remote-chats-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let run = |script: &str, args: &[&str], stdin: &str| -> String {
            use std::io::Write;
            let mut child = Command::new("sh")
                .arg("-c")
                .arg(script)
                .arg("sh")
                .args(args)
                .env("HOME", &home)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{script}");
            String::from_utf8(out.stdout).unwrap()
        };
        assert_eq!(run(LIST, &[], ""), "");
        assert_eq!(run(PUT, &["a", "0", "10"], r#"{"id":"a","v":1}"#).trim(), "ok");
        // Another computer that last saw nothing (or an older revision) is refused.
        assert_eq!(run(PUT, &["a", "5", "11"], r#"{"id":"a","v":0}"#).trim(), "stale");
        assert_eq!(run(PUT, &["a", "10", "12"], r#"{"id":"a","v":2}"#).trim(), "ok");
        assert_eq!(run(PUT, &["b", "0", "3"], r#"{"id":"b"}"#).trim(), "ok");
        let list = parse_list(&run(LIST, &[], ""));
        assert_eq!(list.len(), 2);
        assert!(list.contains(&RemoteChatEntry { id: "a".into(), rev: Some(12) }));
        let fetched = parse_fetch(run(FETCH, &["a", "missing"], "").as_bytes());
        assert_eq!(fetched, vec![r#"{"id":"a","v":2}"#]);
        run(REMOVE, &["b"], "");
        assert_eq!(run(PUT, &["b", "3", "99"], "{}").trim(), "gone");
        let list = parse_list(&run(LIST, &[], ""));
        assert!(list.contains(&RemoteChatEntry { id: "b".into(), rev: None }));
        assert!(parse_fetch(run(FETCH, &["b"], "").as_bytes()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
