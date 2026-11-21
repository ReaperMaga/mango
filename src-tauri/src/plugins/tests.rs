use std::fs;
use std::path::{Path, PathBuf};

use super::store::{confined, discover, mime_for, remove_tree, Ctx};
use super::validate::*;
use super::PluginSource;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("mango-plugins-{tag}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = remove_tree(&self.0);
    }
}

fn manifest_json(id: &str, version: &str) -> String {
    format!(r#"{{"id":"{id}","name":"Plugin {id}","version":"{version}","future":{{"x":1}}}}"#)
}

fn write_plugin(dir: &Path, id: &str, version: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(MANIFEST_FILE), manifest_json(id, version)).unwrap();
    fs::write(dir.join("main.js"), format!("export function activate() {{ /* {id} {version} */ }}")).unwrap();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[test]
fn urls_accepted() {
    for url in [
        "https://github.com/owner/repo",
        "https://github.com/owner/repo.git",
        "http://git.local/owner/repo",
        "ssh://git@github.com/owner/repo.git",
        "ssh://git@host:2222/owner/repo",
        "git@github.com:owner/repo.git",
        "github.com:owner/repo",
        "  https://github.com/owner/repo  ",
    ] {
        assert!(validate_url(url, false).is_ok(), "{url} should be accepted");
    }
}

#[test]
fn urls_rejected() {
    for url in [
        "",
        "-oProxyCommand=calc",
        "--upload-pack=touch /tmp/x",
        "ext::sh -c touch% /tmp/pwned",
        "ext::sh",
        "fd::17",
        "file:///etc",
        "FILE:///etc",
        "file:/x",
        "/home/me/plugin",
        "./plugin",
        "../plugin",
        "plugin",
        r"C:\Users\me\plugin",
        "C:/Users/me/plugin",
        r"\\server\share\repo",
        "https://github.com/owner/repo with space",
        "https://github.com/a\nb",
        "https://",
        "https://github.com",
        "https://-oProxyCommand=x/repo",
        "ftp://example.com/repo",
        "git@-oProxyCommand=x:repo",
        "-o@host:repo",
        "host:",
        "transport::address",
    ] {
        assert!(validate_url(url, false).is_err(), "{url:?} should be rejected");
    }
    // Local folders only where tests allow them, and the dangerous forms never.
    assert!(validate_url("/tmp/repo", true).is_ok());
    assert!(validate_url("-oProxyCommand=calc", true).is_err());
    assert!(validate_url("ext::sh", true).is_err());
    assert!(validate_url("file:///tmp/repo", true).is_err());
}

#[test]
fn refs() {
    assert_eq!(normalize_ref(None).unwrap(), None);
    assert_eq!(normalize_ref(Some("  ")).unwrap(), None);
    assert_eq!(normalize_ref(Some("v1.2.0")).unwrap().as_deref(), Some("v1.2.0"));
    assert_eq!(normalize_ref(Some("feature/x")).unwrap().as_deref(), Some("feature/x"));
    for bad in ["-x", "a b", "a..b", "a:b", "+main", "main^", "x*"] {
        assert!(normalize_ref(Some(bad)).is_err(), "{bad} should be rejected");
    }
    assert!(is_sha_like("abc1234"));
    assert!(is_sha_like("0123456789abcdef0123456789abcdef01234567"));
    assert!(!is_sha_like("main"));
    assert!(!is_sha_like("abc12"));
}

#[test]
fn subpaths() {
    assert_eq!(normalize_subpath("").unwrap(), "");
    assert_eq!(normalize_subpath("/").unwrap_err().contains("absolute"), true);
    assert_eq!(normalize_subpath("plugins/foo/").unwrap(), "plugins/foo");
    assert_eq!(normalize_subpath("./plugins//foo/.").unwrap(), "plugins/foo");
    assert_eq!(normalize_subpath(".").unwrap(), "");
    for bad in ["../x", "plugins/../../x", "/etc", r"plugins\foo", r"..\x", "C:/x", "C:x", "a/\u{0}b"] {
        assert!(normalize_subpath(bad).is_err(), "{bad:?} should be rejected");
    }
    assert!(safe_rel_file("", "The file").is_err());
    assert_eq!(safe_rel_file("assets/a.png", "The file").unwrap(), "assets/a.png");
}

#[test]
fn manifests() {
    let m = parse_manifest(manifest_json("my.plugin-1", "1.0.0").as_bytes(), "x/mango-plugin.json").unwrap();
    assert_eq!(m.main.as_deref(), Some("main.js"));
    assert!(m.extra.contains_key("future"), "unknown fields are kept");
    // BOM tolerated.
    assert!(parse_manifest(format!("\u{feff}{}", manifest_json("a", "1")).as_bytes(), "f").is_ok());

    let bad = |json: &str| parse_manifest(json.as_bytes(), "plugins/x/mango-plugin.json").unwrap_err();
    assert!(bad(r#"{"id":"Bad","name":"x","version":"1"}"#).contains("id \"Bad\""));
    assert!(bad(r#"{"id":"-x","name":"x","version":"1"}"#).contains("not valid"));
    assert!(bad(&format!(r#"{{"id":"{}","name":"x","version":"1"}}"#, "a".repeat(65))).contains("not valid"));
    assert!(bad(r#"{"id":"a","name":" ","version":"1"}"#).contains("no name"));
    assert!(bad(&format!(r#"{{"id":"a","name":"{}","version":"1"}}"#, "n".repeat(81))).contains("80"));
    assert!(bad(r#"{"id":"a","name":"x","version":""}"#).contains("no version"));
    assert!(bad(r#"{"id":"a","name":"x"}"#).contains("plugins/x/mango-plugin.json"));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","main":"../evil.js"}"#).contains(".."));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","main":"/abs.js"}"#).contains("relative"));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","styles":"C:\\x.css"}"#).contains("relative"));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","settings":[{"key":"1x","type":"string","label":"l"}]}"#)
        .contains("invalid key"));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","settings":[{"key":"k","type":"color","label":"l"}]}"#)
        .contains("unknown type"));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","settings":[{"key":"k","type":"select","label":"l"}]}"#)
        .contains("without options"));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","settings":[{"key":"k","type":"boolean","label":"l","default":"yes"}]}"#)
        .contains("default"));
    assert!(bad(r#"{"id":"a","name":"x","version":"1","settings":[{"key":"k","type":"string"},{"key":"k","type":"string"}]}"#)
        .contains("twice"));
    let ok = parse_manifest(
        br#"{"id":"a","name":"x","version":"1","styles":"./s.css","settings":[
            {"key":"on","type":"boolean","label":"On","default":true},
            {"key":"mode","type":"select","options":[{"value":"a","label":"A"}],"default":"a"},
            {"key":"n","type":"number","min":0,"max":5,"default":2}]}"#,
        "f",
    )
    .unwrap();
    assert_eq!(ok.styles.as_deref(), Some("s.css"));
    assert_eq!(ok.settings.as_ref().unwrap()[1].label, "mode", "a missing label falls back to the key");
    let big = format!(r#"{{"id":"a","name":"x","version":"1","pad":"{}"}}"#, " ".repeat(300 * 1024));
    assert!(bad(&big).contains("256 KB"));
}

#[test]
fn repo_keys() {
    let a = repo_key("https://github.com/Owner/Repo.git", None);
    assert!(a.starts_with("github-com-owner-repo-"), "{a}");
    assert_eq!(a, repo_key("https://github.com/Owner/Repo.git", None), "stable");
    assert_ne!(a, repo_key("https://github.com/Owner/Repo.git", Some("v1")), "ref matters");
    assert!(repo_key("git@github.com:o/r.git", None).starts_with("github-com-o-r-"));
    let k = repo_key(&format!("https://h/{}", "x".repeat(200)), None);
    assert!(k.len() <= 48 + 13, "{k}");
    assert!(k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
}

#[test]
fn mimes() {
    assert_eq!(mime_for("a/b.PNG"), "image/png");
    assert_eq!(mime_for("f.woff2"), "font/woff2");
    assert_eq!(mime_for("x.svg"), "image/svg+xml");
    assert_eq!(mime_for("noext"), "application/octet-stream");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

#[test]
fn confinement() {
    let t = TempDir::new("confine");
    let dir = t.0.join("plugin");
    write_plugin(&dir, "p", "1");
    fs::create_dir_all(dir.join("assets")).unwrap();
    fs::write(dir.join("assets/a.txt"), "hi").unwrap();
    fs::write(t.0.join("secret.txt"), "secret").unwrap();

    assert!(confined(&dir, "main.js").is_ok());
    assert!(confined(&dir, "assets/a.txt").is_ok());
    assert!(confined(&dir, "./assets//a.txt").is_ok());
    assert!(confined(&dir, "../secret.txt").is_err());
    assert!(confined(&dir, "assets/../../secret.txt").is_err());
    assert!(confined(&dir, &t.0.join("secret.txt").to_string_lossy()).is_err());
    assert!(confined(&dir, r"assets\a.txt").is_err());
    assert!(confined(&dir, "assets").is_err(), "a folder is not a file");
    assert!(confined(&dir, "missing.js").is_err());

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(t.0.join("secret.txt"), dir.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&t.0, dir.join("up")).unwrap();
        assert!(confined(&dir, "link.txt").unwrap_err().contains("outside"));
        assert!(confined(&dir, "up/secret.txt").unwrap_err().contains("outside"));
    }
}

#[test]
fn discovery() {
    let t = TempDir::new("discover");
    let r = &t.0;
    write_plugin(r, "root", "1");
    write_plugin(&r.join("plugins/a"), "a", "1");
    write_plugin(&r.join("plugins/b"), "b", "1");
    write_plugin(&r.join("x/y/z"), "deep3", "1");
    write_plugin(&r.join("x/y/z/w"), "deep4", "1");
    write_plugin(&r.join("node_modules/n"), "n", "1");
    write_plugin(&r.join(".hidden/h"), "h", "1");
    fs::create_dir_all(r.join(".git")).unwrap();
    fs::write(r.join(".git").join(MANIFEST_FILE), "{}").unwrap();
    // A folder named like the manifest is not one.
    fs::create_dir_all(r.join("odd").join(MANIFEST_FILE)).unwrap();
    assert_eq!(discover(r), vec!["", "plugins/a", "plugins/b", "x/y/z"]);
}

#[test]
fn registry_tolerates_bad_data() {
    let t = TempDir::new("registry");
    let ctx = Ctx::new(t.0.clone());
    assert!(ctx.list().is_empty(), "missing registry");
    fs::write(t.0.join("plugins.json"), "{ not json").unwrap();
    assert!(ctx.list().is_empty(), "corrupt registry");
    assert!(t.0.join("plugins.json.corrupt").exists(), "the corrupt file is kept aside");

    let local = t.0.join("local");
    write_plugin(&local, "loc", "1");
    let good = format!(
        r#"[{{"manifest":{},"source":{{"kind":"local","path":"x"}},"dir":{},"enabled":false,"commit":null,
             "installedAt":1,"updatedAt":2,"fromTheFuture":true}},
            {{"manifest":{{"id":"broken"}}}}]"#,
        manifest_json("loc", "1"),
        serde_json::to_string(&local.to_string_lossy()).unwrap()
    );
    fs::write(t.0.join("plugins.json"), good).unwrap();
    let list = ctx.list();
    assert_eq!(list.len(), 1);
    assert!(!list[0].enabled);
    // A change keeps fields this build doesn't know.
    ctx.set_enabled("loc", true).unwrap();
    let saved = fs::read_to_string(t.0.join("plugins.json")).unwrap();
    assert!(saved.contains("fromTheFuture"));
    assert!(ctx.list()[0].enabled);
    assert!(ctx.set_enabled("nope", true).is_err());
}

#[test]
fn local_plugins() {
    let t = TempDir::new("local");
    let ctx = Ctx::new(t.0.join("store"));
    let dir = t.0.join("my-plugin");
    write_plugin(&dir, "mine", "1.0.0");

    let p = ctx.add_local(&dir.to_string_lossy()).unwrap();
    assert_eq!(p.manifest.id, "mine");
    assert!(matches!(p.source, PluginSource::Local { .. }));
    assert!(p.commit.is_none());
    assert!(!p.dir.starts_with(r"\\?\"));
    let json = serde_json::to_value(&p).unwrap();
    assert!(json.get("repo").is_none(), "internal fields stay out");
    assert_eq!(json["source"]["kind"], "local");

    assert_eq!(String::from_utf8(ctx.read_file("mine", "main.js").unwrap()).unwrap().contains("activate"), true);
    assert!(ctx.read_file("mine", "../my-plugin/main.js").is_err());

    // Edit, then update re-reads the manifest.
    fs::write(dir.join(MANIFEST_FILE), manifest_json("mine", "1.1.0")).unwrap();
    assert_eq!(ctx.update("mine", &|_| {}).unwrap().manifest.version, "1.1.0");

    // A missing entry module or manifest is refused.
    let empty = t.0.join("empty");
    fs::create_dir_all(&empty).unwrap();
    assert!(ctx.add_local(&empty.to_string_lossy()).unwrap_err().contains(MANIFEST_FILE));
    let no_main = t.0.join("nomain");
    fs::create_dir_all(&no_main).unwrap();
    fs::write(no_main.join(MANIFEST_FILE), manifest_json("nomain", "1")).unwrap();
    assert!(ctx.add_local(&no_main.to_string_lossy()).unwrap_err().contains("main.js"));

    ctx.remove("mine").unwrap();
    assert!(dir.join("main.js").exists(), "a local plugin's folder is never deleted");
    assert!(ctx.list().is_empty());
}

// ---------------------------------------------------------------------------
// The whole flow against a local repository
// ---------------------------------------------------------------------------

fn git(dir: &Path, args: &[&str]) -> String {
    let mut cmd = std::process::Command::new(crate::bin::git());
    crate::bin::hide_console(&mut cmd);
    let out = cmd
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn probe_install_update_remove() {
    let t = TempDir::new("flow");
    let origin = t.0.join("origin");
    fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "--quiet", "--initial-branch=main"]);
    write_plugin(&origin.join("plugins/alpha"), "alpha", "1.0.0");
    write_plugin(&origin.join("plugins/beta"), "beta", "1.0.0");
    fs::write(origin.join("README.md"), "two plugins").unwrap();
    git(&origin, &["add", "-A"]);
    git(&origin, &["commit", "--quiet", "-m", "first"]);
    let first = git(&origin, &["rev-parse", "HEAD"]);
    let url = origin.to_string_lossy().into_owned();

    let ctx = Ctx::new(t.0.join("store"));
    let lines = std::cell::RefCell::new(0usize);
    let progress = |_: &str| *lines.borrow_mut() += 1;

    // Probe the whole repository: both plugins.
    let probe = ctx.probe(&url, None, None, &progress).unwrap();
    assert_eq!(probe.commit, first);
    let subs: Vec<&str> = probe.candidates.iter().map(|c| c.subpath.as_str()).collect();
    assert_eq!(subs, vec!["plugins/alpha", "plugins/beta"]);
    assert!(probe.candidates.iter().all(|c| !c.installed));

    // A subpath without a manifest is a clear error; one with it finds just that plugin.
    assert!(ctx.probe(&url, None, Some("plugins"), &progress).unwrap_err().contains("no mango-plugin.json"));
    let single = ctx.probe(&url, Some("main"), Some("plugins/beta/"), &progress).unwrap();
    assert_eq!(single.candidates.len(), 1);
    assert_eq!(single.candidates[0].manifest.id, "beta");

    // Install both from the first probe.
    assert!(ctx.install(&probe.probe_id, &[]).is_err());
    assert!(ctx.install("../../etc", &["plugins/alpha".into()]).is_err());
    let installed = ctx.install(&probe.probe_id, &["plugins/alpha".into(), "plugins/beta/".into()]).unwrap();
    assert_eq!(installed.len(), 2);
    let alpha = &installed[0];
    assert_eq!(alpha.commit.as_deref(), Some(first.as_str()));
    assert!(alpha.enabled);
    assert_eq!(
        alpha.source,
        PluginSource::Git { url: url.clone(), reference: None, subpath: Some("plugins/alpha".into()) }
    );
    assert!(Path::new(&alpha.dir).join("main.js").exists());
    assert!(!Path::new(&alpha.dir).join(".git").exists());
    assert_eq!(ctx.list().len(), 2);
    assert_eq!(fs::read_dir(t.0.join("store/repos")).unwrap().count(), 1, "one clone for the repository");
    // A later probe marks them installed.
    let again = ctx.probe(&url, None, None, &progress).unwrap();
    assert!(again.candidates.iter().all(|c| c.installed));

    // A git plugin's id can't be taken over by a local folder.
    let local = t.0.join("local-alpha");
    write_plugin(&local, "alpha", "9.9.9");
    assert!(ctx.add_local(&local.to_string_lossy()).unwrap_err().contains("already installed from"));

    // Files are served from the copy.
    assert!(String::from_utf8(ctx.read_file("alpha", "main.js").unwrap()).unwrap().contains("alpha 1.0.0"));
    assert!(ctx.read_file("alpha", "../beta/main.js").is_err());

    // No news yet.
    let infos = ctx.check_updates(None, &progress);
    assert_eq!(infos.len(), 2);
    assert!(infos.iter().all(|i| !i.has_update && i.error.is_none()), "{infos:?}");

    // A new commit changes alpha.
    write_plugin(&origin.join("plugins/alpha"), "alpha", "1.1.0");
    git(&origin, &["commit", "--quiet", "-am", "alpha 1.1.0"]);
    let second = git(&origin, &["rev-parse", "HEAD"]);
    let infos = ctx.check_updates(Some(&["alpha".to_string(), "ghost".to_string()]), &progress);
    let a = infos.iter().find(|i| i.id == "alpha").unwrap();
    assert!(a.has_update);
    assert_eq!(a.latest.as_deref(), Some(second.as_str()));
    assert_eq!(a.latest_version.as_deref(), Some("1.1.0"));
    assert!(infos.iter().find(|i| i.id == "ghost").unwrap().error.is_some());

    let updated = ctx.update("alpha", &progress).unwrap();
    assert_eq!(updated.manifest.version, "1.1.0");
    assert_eq!(updated.commit.as_deref(), Some(second.as_str()));
    assert!(String::from_utf8(ctx.read_file("alpha", "main.js").unwrap()).unwrap().contains("alpha 1.1.0"));
    let infos = ctx.check_updates(Some(&["alpha".to_string()]), &progress);
    assert!(!infos[0].has_update);

    // A missing clone is cloned again.
    remove_tree(&t.0.join("store/repos")).unwrap();
    let infos = ctx.check_updates(Some(&["beta".to_string()]), &progress);
    assert!(infos[0].has_update && infos[0].error.is_none(), "{infos:?}");

    // An id change upstream is refused.
    write_plugin(&origin.join("plugins/beta"), "beta-renamed", "2.0.0");
    git(&origin, &["commit", "--quiet", "-am", "rename beta"]);
    assert!(ctx.update("beta", &progress).unwrap_err().contains("beta-renamed"));

    // Pinned to the first commit: the shallow --branch clone fails, the full clone takes over.
    let pinned = ctx.probe(&url, Some(&first[..10]), Some("plugins/alpha"), &progress).unwrap();
    assert_eq!(pinned.commit, first);
    assert_eq!(pinned.candidates[0].manifest.version, "1.0.0");

    // Remove: copies and the unused clone go.
    ctx.remove("alpha").unwrap();
    assert!(!t.0.join("store/installed/alpha").exists());
    assert_eq!(fs::read_dir(t.0.join("store/repos")).unwrap().count(), 1, "beta still uses the clone");
    ctx.remove("beta").unwrap();
    assert_eq!(fs::read_dir(t.0.join("store/repos")).unwrap().count(), 0);
    assert!(ctx.list().is_empty());
    assert!(ctx.remove("beta").is_err());
    assert!(*lines.borrow() > 0, "progress was reported");

    // Only the newest probe checkouts are kept.
    assert!(fs::read_dir(t.0.join("store/.staging")).unwrap().count() <= 4);
}
