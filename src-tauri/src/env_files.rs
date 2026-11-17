//! Project settings > Environment variables: the `.env`-style files at a project's root.
//! Listing them (with whether git ignores each) and adding one to the root `.gitignore`.
//! Reading, writing, creating and deleting them go through the `fs_*` commands (`files.rs`),
//! which confine every path to the project. Remote projects (`env://…`) get the same answers
//! from one fixed script per command, run inside the instance (see `remote` below).

use std::fs;
use std::io::Write as _;

use serde::Serialize;
use tauri::AppHandle;

use crate::files::{modified_ms, on_root, plain_name, resolve};
use crate::git::{self, existing_dir, EnvAt, Vcs};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    /// File name at the project root, e.g. ".env", ".env.vault", "prod.env".
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    /// Whether git ignores it; None when the folder is not in a git repository or git is unavailable.
    pub ignored: Option<bool>,
}

/// `.env`, `.env.<anything>` or `<anything>.env`, except the example and template files
/// projects commit for others to copy ([`is_template`]).
pub(crate) fn is_env_name(name: &str) -> bool {
    (name == ".env" || name.starts_with(".env.") || name.ends_with(".env")) && !is_template(name)
}

/// `.env.example`, `.env.sample`, `.env.template` and the `example.env` forms, in any case.
fn is_template(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        ".env.example" | ".env.sample" | ".env.template" | "example.env" | "sample.env" | "template.env"
    )
}

fn wanted(name: &str, extra: &[String]) -> bool {
    is_env_name(name) || extra.iter().any(|e| e == name)
}

fn check_extra(extra: &[String]) -> Result<(), String> {
    extra.iter().try_for_each(|e| plain_name(e).map(|_| ()))
}

/// `.env` first, then by name ignoring case.
fn sort_files(files: &mut [EnvFile]) {
    files.sort_by(|a, b| {
        (a.name != ".env")
            .cmp(&(b.name != ".env"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// The env files at the root of a project on this computer. A name that is a folder, a
/// broken link or a link out of the project is left out.
pub(crate) fn list(root: &str, extra: &[String]) -> Result<Vec<EnvFile>, String> {
    check_extra(extra)?;
    let (top, _) = resolve(root, "")?;
    let read = fs::read_dir(&top).map_err(|e| format!("Could not list {}: {e}", top.display()))?;
    let mut files = Vec::new();
    for item in read.flatten() {
        let Some(name) = item.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !wanted(&name, extra) {
            continue;
        }
        let Ok((_, target)) = resolve(root, &name) else {
            continue;
        };
        match fs::metadata(&target) {
            Ok(meta) if meta.is_file() => {
                files.push(EnvFile { name, size: meta.len(), modified_ms: modified_ms(&meta), ignored: None })
            }
            _ => {}
        }
    }
    sort_files(&mut files);

    // Git runs in the folder as given (see `files::list_dir`).
    let project = existing_dir(root)?;
    if matches!(crate::vcs::detect_on_disk(&project), Some((Vcs::Git, _))) {
        let names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        if let Some(ignored) = git::ignored_paths_known(&project, &names) {
            for f in &mut files {
                f.ignored = Some(ignored.iter().any(|p| *p == f.name));
            }
        }
    }
    Ok(files)
}

/// The `.gitignore` line for one root file: `/<name>`, with glob characters and trailing
/// spaces escaped so git matches the name literally.
pub(crate) fn gitignore_line(name: &str) -> Result<String, String> {
    plain_name(name)?;
    let mut line = String::from("/");
    for c in name.chars() {
        if matches!(c, '*' | '?' | '[') {
            line.push('\\');
        }
        line.push(c);
    }
    let kept = line.trim_end_matches(' ').len();
    let spaces = line.len() - kept;
    line.truncate(kept);
    line.push_str(&"\\ ".repeat(spaces));
    Ok(line)
}

/// Add `/<name>` to the project's root `.gitignore`, creating the file. Nothing happens when
/// that exact line is already there. Keeps the file's line endings and adds the missing final
/// line break first.
pub(crate) fn gitignore_add(root: &str, name: &str) -> Result<(), String> {
    let line = gitignore_line(name)?;
    let (top, _) = resolve(root, "")?;
    let path = top.join(".gitignore");
    let exists = match fs::symlink_metadata(&path) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("Could not open .gitignore: {e}")),
    };
    if !exists {
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("Could not create .gitignore: {e}"))?;
        return out.write_all(format!("{line}\n").as_bytes()).map_err(|e| format!("Could not write .gitignore: {e}"));
    }
    // A link is followed only when it stays inside the project.
    let (_, target) = resolve(root, ".gitignore")?;
    if !target.is_file() {
        return Err(".gitignore is not a file".into());
    }
    let bytes = fs::read(&target).map_err(|e| format!("Could not read .gitignore: {e}"))?;
    let Some(add) = gitignore_append(&bytes, &line) else {
        return Ok(());
    };
    let mut out = fs::OpenOptions::new()
        .append(true)
        .open(&target)
        .map_err(|e| format!("Could not open .gitignore: {e}"))?;
    out.write_all(add.as_bytes()).map_err(|e| format!("Could not write .gitignore: {e}"))
}

/// What to append to a `.gitignore` holding `bytes` so it gets `line`, or None when it has it.
fn gitignore_append(bytes: &[u8], line: &str) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    if text.lines().any(|l| l.trim_end_matches('\r') == line) {
        return None;
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lead = if bytes.is_empty() || bytes.ends_with(b"\n") { "" } else { eol };
    Some(format!("{lead}{line}{eol}"))
}

// ---------------------------------------------------------------------------
// Remote projects
// ---------------------------------------------------------------------------

/// Remote projects: one fixed `sh` script per command, run in the project folder inside the
/// instance (`files::remote::run`). Names and the `.gitignore` line arrive only as positional
/// arguments (quoted by `ssh`'s command line builder); links are resolved inside the instance
/// and anything that leaves the project folder's real path is skipped or refused.
pub(crate) mod remote {
    use super::*;
    use crate::files::remote::{body, prelude, run, MISSING, NOT_FILE, OUTSIDE, READ_ONLY};

    /// Room for the listing: a root folder's env files, a few hundred bytes each.
    const LIST_CAP: usize = 1024 * 1024;
    const SMALL: usize = 256;

    /// `$2…`: the extra names (listed even when they are templates). Prints `f<size> <mtime> <name>\0` per env file at the root,
    /// then `i\0`; inside a git work tree, `g\0` and the names git ignores. All in one call.
    pub(crate) const LIST: &str = concat!(
        prelude!(),
        r#"shift
inside() {
  case $root in /) return 0 ;; esac
  case $1 in "$root"/*) return 0 ;; esac
  return 1
}
pick() {
  for f in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    n=${f##*/}
    hit=
    case $n in .env|.env.*|*.env) hit=1 ;; esac
    case $n in
      .[eE][nN][vV].[eE][xX][aA][mM][pP][lL][eE]|.[eE][nN][vV].[sS][aA][mM][pP][lL][eE]|.[eE][nN][vV].[tT][eE][mM][pP][lL][aA][tT][eE]) hit= ;;
      [eE][xX][aA][mM][pP][lL][eE].env|[sS][aA][mM][pP][lL][eE].env|[tT][eE][mM][pP][lL][aA][tT][eE].env) hit= ;;
    esac
    if [ -z "$hit" ]; then
      for x in "$@"; do if [ "$x" = "$n" ]; then hit=1; break; fi; done
    fi
    [ -n "$hit" ] || continue
    r=$(readlink -f "$f" 2>/dev/null) || continue
    inside "$r" || continue
    [ -f "$r" ] || continue
    if [ "$mode" = names ]; then printf '%s\000' "$n"; continue; fi
    size=$(stat -c %s "$r") || continue
    mtime "$r"
    printf 'f%s %s %s\000' "$size" "$m" "$n"
  done
}
mode=list
pick "$@"
printf 'i\000'
if command -v git >/dev/null 2>&1 && [ "$(GIT_OPTIONAL_LOCKS=0 git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
  printf 'g\000'
  mode=names
  pick "$@" | GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git check-ignore -z --stdin 2>/dev/null
fi
exit 0
"#
    );

    /// `$2`: the line to add. Prints `present` when the root `.gitignore` already has it,
    /// otherwise appends it (creating the file, completing a last line without a break,
    /// keeping CRLF endings) and prints `added`.
    pub(crate) const GITIGNORE: &str = concat!(
        prelude!(),
        r#"g=$root/.gitignore
cr=
if [ -e "$g" ] || [ -L "$g" ]; then
  g=$(readlink -f "$g" 2>/dev/null) || exit 10
  case $root in /) ;; *) case $g in "$root"/*) ;; *) exit 11 ;; esac ;; esac
  [ -f "$g" ] || exit 13
  [ -w "$g" ] || exit 14
  if tr -d '\r' < "$g" | grep -qxF -e "$2"; then printf 'present\n'; exit 0; fi
  if grep -q "$(printf '\r')\$" "$g"; then cr=$(printf '\r'); fi
else
  [ -w "$root" ] || exit 14
fi
{
  if [ -s "$g" ] && [ -n "$(tail -c 1 "$g")" ]; then printf '%s\n' "$cr"; fi
  printf '%s%s\n' "$2" "$cr"
} >> "$g" || exit 1
printf 'added\n'
"#
    );

    /// Parse [`LIST`]'s records.
    pub(crate) fn parse_list(body: &[u8]) -> Vec<EnvFile> {
        let mut files = Vec::new();
        let mut ignored: Vec<String> = Vec::new();
        // 0: files, 1: after `i`, 2: after `g` (git answered).
        let mut stage = 0;
        for rec in body.split(|b| *b == 0) {
            if rec.is_empty() {
                continue;
            }
            match stage {
                0 if rec == b"i" => stage = 1,
                0 if rec[0] == b'f' => {
                    let text = git::lossy(&rec[1..]);
                    let mut parts = text.splitn(3, ' ');
                    let (Some(size), Some(mtime), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
                        continue;
                    };
                    let (Ok(size), Ok(modified_ms)) = (size.parse(), mtime.parse()) else {
                        continue;
                    };
                    files.push(EnvFile { name: name.to_string(), size, modified_ms, ignored: None });
                }
                1 if rec == b"g" => stage = 2,
                2 => ignored.push(git::lossy(rec)),
                _ => {}
            }
        }
        if stage == 2 {
            for f in &mut files {
                f.ignored = Some(ignored.iter().any(|p| *p == f.name));
            }
        }
        sort_files(&mut files);
        files
    }

    fn unexpected() -> String {
        "Could not read the project's env files: the environment gave an answer Mango does not understand".into()
    }

    pub(crate) fn list(env: &EnvAt, extra: &[String]) -> Result<Vec<EnvFile>, String> {
        check_extra(extra)?;
        let mut args: Vec<&str> = vec![""];
        args.extend(extra.iter().map(String::as_str));
        let out = run(env, LIST, &args, None, LIST_CAP)?;
        if !out.ok() || out.truncated {
            return Err(match out.code {
                Some(MISSING) => "The project folder no longer exists".into(),
                _ => out.error("Could not list the project's env files"),
            });
        }
        Ok(parse_list(body(&out.stdout).ok_or_else(unexpected)?))
    }

    pub(crate) fn gitignore_add(env: &EnvAt, name: &str) -> Result<(), String> {
        let line = gitignore_line(name)?;
        let out = run(env, GITIGNORE, &["", &line], None, SMALL)?;
        if !out.ok() {
            return Err(match out.code {
                Some(MISSING) => ".gitignore links to a file that does not exist".into(),
                Some(OUTSIDE) => ".gitignore links to a place outside the project".into(),
                Some(NOT_FILE) => ".gitignore is not a file".into(),
                Some(READ_ONLY) => ".gitignore is read-only".into(),
                _ => out.error("Could not update .gitignore"),
            });
        }
        match body(&out.stdout).map(|b| String::from_utf8_lossy(b).trim().to_string()) {
            Some(word) if word == "added" || word == "present" => Ok(()),
            _ => Err("Updated .gitignore, but the environment's answer was not understood. Open it to check.".into()),
        }
    }
}

#[tauri::command]
pub async fn env_files(app: AppHandle, root: String, extra: Vec<String>) -> Result<Vec<EnvFile>, String> {
    let x = extra.clone();
    on_root(app, root, move |r| list(r, &extra), move |e| remote::list(e, &x)).await
}

#[tauri::command]
pub async fn env_gitignore_add(app: AppHandle, root: String, name: String) -> Result<(), String> {
    let n = name.clone();
    on_root(app, root, move |r| gitignore_add(r, &name), move |e| remote::gitignore_add(e, &n)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn path_of(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mango-envfiles-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_init(dir: &Path) -> bool {
        let mut cmd = Command::new("git");
        crate::bin::hide_console(&mut cmd);
        matches!(cmd.current_dir(dir).args(["init", "-q"]).status(), Ok(s) if s.success())
    }

    fn names(files: &[EnvFile]) -> Vec<&str> {
        files.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn matches_env_names() {
        for yes in [".env", ".env.local", ".env.vault", "prod.env", ".prod.env", ".env.example.local", "my-example.env"] {
            assert!(is_env_name(yes), "{yes}");
        }
        let templates = [".env.example", ".env.sample", ".env.template", ".ENV.Example", "example.env", "Sample.env", "template.env"];
        for no in ["env", ".envrc", "env.txt", ".env-local", "my.env.bak", "README.md"].into_iter().chain(templates) {
            assert!(!is_env_name(no), "{no}");
        }
    }

    #[test]
    fn lists_env_files_and_extras_at_the_root_only() {
        let dir = scratch();
        let root = dir.join("proj");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(root.join("folder.env")).unwrap();
        for f in [".env", ".env.local", "prod.env", ".envrc", "README.md", "secrets.txt", "sub/.env"] {
            fs::write(root.join(f), "A=1\n").unwrap();
        }
        for f in [".env.example", ".env.SAMPLE", ".env.template", "example.env", "sample.env", "template.env", "Zeta.env"] {
            fs::write(root.join(f), "").unwrap();
        }
        let got = list(&path_of(&root), &["secrets.txt".into(), "missing.txt".into(), "sub".into()]).unwrap();
        assert_eq!(names(&got), [".env", ".env.local", "prod.env", "secrets.txt", "Zeta.env"]);
        // A template is listed when asked for by name.
        let got = list(&path_of(&root), &[".env.example".into(), "sample.env".into()]).unwrap();
        assert_eq!(names(&got), [".env", ".env.example", ".env.local", "prod.env", "sample.env", "Zeta.env"]);
        assert_eq!(got[0].size, 4);
        assert!(got[0].modified_ms > 0);
        // Not a repository: git cannot say.
        assert!(got.iter().all(|f| f.ignored.is_none()));
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn skips_links_out_of_the_project() {
        let dir = scratch();
        let root = dir.join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.join("outside.env"), "SECRET=1").unwrap();
        fs::write(root.join(".env"), "").unwrap();
        std::os::unix::fs::symlink(dir.join("outside.env"), root.join("leak.env")).unwrap();
        std::os::unix::fs::symlink(root.join(".env"), root.join("alias.env")).unwrap();
        std::os::unix::fs::symlink(root.join("nowhere"), root.join("broken.env")).unwrap();
        let got = list(&path_of(&root), &[]).unwrap();
        assert_eq!(names(&got), [".env", "alias.env"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_extra_names_that_are_not_names() {
        let dir = scratch();
        let root = path_of(&dir);
        for bad in ["", ".", "..", "a/b", "a\\b", "../x", "a\0b", "a\nb"] {
            assert!(list(&root, &[bad.into()]).is_err(), "{bad:?}");
            assert!(gitignore_add(&root, bad).is_err(), "{bad:?}");
        }
        assert!(!dir.join(".gitignore").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn marks_ignored_files_in_a_git_repo() {
        let dir = scratch();
        if !git_init(&dir) {
            return; // no git on this machine
        }
        fs::write(dir.join(".gitignore"), ".env\n*.local\n").unwrap();
        for f in [".env", ".env.prod", ".env.local"] {
            fs::write(dir.join(f), "").unwrap();
        }
        let got = list(&path_of(&dir), &[]).unwrap();
        let marks: Vec<_> = got.iter().map(|f| (f.name.as_str(), f.ignored)).collect();
        assert_eq!(marks, [(".env", Some(true)), (".env.local", Some(true)), (".env.prod", Some(false))]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn escapes_gitignore_lines() {
        assert_eq!(gitignore_line(".env").unwrap(), "/.env");
        assert_eq!(gitignore_line("#x.env").unwrap(), "/#x.env");
        assert_eq!(gitignore_line("a*[b]?.env").unwrap(), "/a\\*\\[b]\\?.env");
        assert_eq!(gitignore_line("x.env  ").unwrap(), "/x.env\\ \\ ");
    }

    #[test]
    fn appends_to_gitignore_once() {
        let dir = scratch();
        let root = path_of(&dir);
        let read = || fs::read_to_string(dir.join(".gitignore")).unwrap();

        gitignore_add(&root, ".env").unwrap();
        assert_eq!(read(), "/.env\n");
        gitignore_add(&root, ".env").unwrap();
        assert_eq!(read(), "/.env\n");

        // A last line without a break gets one first.
        fs::write(dir.join(".gitignore"), "node_modules").unwrap();
        gitignore_add(&root, ".env.local").unwrap();
        assert_eq!(read(), "node_modules\n/.env.local\n");

        // CRLF files stay CRLF; a CRLF line counts as present.
        fs::write(dir.join(".gitignore"), "target\r\n/.env\r\n").unwrap();
        gitignore_add(&root, ".env").unwrap();
        assert_eq!(read(), "target\r\n/.env\r\n");
        gitignore_add(&root, "prod.env").unwrap();
        assert_eq!(read(), "target\r\n/.env\r\n/prod.env\r\n");

        // `.env` (unanchored) is a different line: the anchored one is still added.
        fs::write(dir.join(".gitignore"), ".env\n").unwrap();
        gitignore_add(&root, ".env").unwrap();
        assert_eq!(read(), ".env\n/.env\n");

        fs::remove_file(dir.join(".gitignore")).unwrap();
        fs::create_dir(dir.join(".gitignore")).unwrap();
        assert!(gitignore_add(&root, ".env").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn never_appends_outside_the_project() {
        let dir = scratch();
        let root = dir.join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.join("elsewhere"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("elsewhere"), root.join(".gitignore")).unwrap();
        assert!(gitignore_add(&path_of(&root), ".env").is_err());
        assert_eq!(fs::read_to_string(dir.join("elsewhere")).unwrap(), "x");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parses_remote_listings() {
        let mut out = b"motd\n\0mango-fs\0".to_vec();
        out.extend_from_slice(b"fprod.env\0f4 1700000000123 .env.example\0f9 5 .env\0f1 2 my file.env\0fbad\0i\0g\0.env\0");
        let got = remote::parse_list(crate::files::remote::body(&out).unwrap());
        let marks: Vec<_> = got.iter().map(|f| (f.name.as_str(), f.size, f.ignored)).collect();
        assert_eq!(marks, [(".env", 9, Some(true)), (".env.example", 4, Some(false)), ("my file.env", 1, Some(false))]);
        assert_eq!(got[1].modified_ms, 1_700_000_000_123);
        // No `g`: not a work tree, or no git there.
        let got = remote::parse_list(b"f1 2 .env\0i\0");
        assert_eq!(got[0].ignored, None);
    }

    /// The remote scripts, run by this computer's `sh` in a scratch project (see `files::tests`).
    #[cfg(unix)]
    mod remote_scripts {
        use super::*;
        use std::process::Stdio;

        fn sh(root: &Path, script: &str, args: &[&str]) -> (Option<i32>, Vec<u8>) {
            let mut child = Command::new("sh")
                .current_dir(root)
                .args(["-c", script, "sh"])
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(b"").unwrap();
            let out = child.wait_with_output().unwrap();
            (out.status.code(), out.stdout)
        }

        fn listed(root: &Path, extra: &[&str]) -> Vec<EnvFile> {
            let mut args = vec![""];
            args.extend_from_slice(extra);
            let (code, out) = sh(root, remote::LIST, &args);
            assert_eq!(code, Some(0));
            remote::parse_list(crate::files::remote::body(&out).unwrap())
        }

        #[test]
        fn lists_like_a_local_project() {
            let dir = scratch();
            let root = dir.join("proj");
            fs::create_dir_all(root.join("folder.env")).unwrap();
            for f in [".env", ".env.local", "prod.env", ".envrc", "secrets.txt", "we ird $(x).env"] {
                fs::write(root.join(f), "A=1\n").unwrap();
            }
            for f in [".env.example", ".ENV.Sample", ".env.template", "example.env", "SAMPLE.env", "template.env"] {
                fs::write(root.join(f), "").unwrap();
            }
            fs::write(dir.join("outside.env"), "S=1").unwrap();
            std::os::unix::fs::symlink(dir.join("outside.env"), root.join("leak.env")).unwrap();
            std::os::unix::fs::symlink(root.join("nowhere"), root.join("broken.env")).unwrap();
            let extra = ["secrets.txt", "missing"];
            let remote = listed(&root, &extra);
            let local = list(&path_of(&root), &extra.map(String::from)).unwrap();
            assert_eq!(remote, local);
            assert_eq!(names(&remote), [".env", ".env.local", "prod.env", "secrets.txt", "we ird $(x).env"]);
            // Templates only by name.
            let extra = [".env.example", "SAMPLE.env"];
            let remote = listed(&root, &extra);
            assert_eq!(remote, list(&path_of(&root), &extra.map(String::from)).unwrap());
            assert_eq!(names(&remote), [".env", ".env.example", ".env.local", "prod.env", "SAMPLE.env", "we ird $(x).env"]);
            assert!(remote.iter().all(|f| f.ignored.is_none()));
            fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn marks_ignored_files() {
            let dir = scratch();
            if !git_init(&dir) {
                return;
            }
            fs::write(dir.join(".gitignore"), "/.env\n").unwrap();
            fs::write(dir.join(".env"), "").unwrap();
            fs::write(dir.join(".env.local"), "").unwrap();
            let got = listed(&dir, &[]);
            let marks: Vec<_> = got.iter().map(|f| (f.name.as_str(), f.ignored)).collect();
            assert_eq!(marks, [(".env", Some(true)), (".env.local", Some(false))]);
            fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn appends_to_gitignore_like_a_local_project() {
            let dir = scratch();
            let read = || fs::read_to_string(dir.join(".gitignore")).unwrap();
            let add = |line: &str| sh(&dir, remote::GITIGNORE, &["", line]);

            assert_eq!(add("/.env"), (Some(0), b"\0mango-fs\0added\n".to_vec()));
            assert_eq!(read(), "/.env\n");
            assert_eq!(add("/.env").1, b"\0mango-fs\0present\n".to_vec());
            assert_eq!(read(), "/.env\n");

            fs::write(dir.join(".gitignore"), "node_modules").unwrap();
            add("/.env.local");
            assert_eq!(read(), "node_modules\n/.env.local\n");

            fs::write(dir.join(".gitignore"), "target\r\n/.env\r\n").unwrap();
            assert!(add("/.env").1.ends_with(b"present\n"));
            add("/a\\*.env");
            assert_eq!(read(), "target\r\n/.env\r\n/a\\*.env\r\n");

            fs::remove_file(dir.join(".gitignore")).unwrap();
            let outside = scratch();
            fs::write(outside.join("theirs"), "x").unwrap();
            std::os::unix::fs::symlink(outside.join("theirs"), dir.join(".gitignore")).unwrap();
            assert_eq!(add("/.env").0, Some(11));
            assert_eq!(fs::read_to_string(outside.join("theirs")).unwrap(), "x");
            fs::remove_dir_all(&dir).ok();
            fs::remove_dir_all(&outside).ok();
        }
    }
}
