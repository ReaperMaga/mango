//! The saved master servers (`environments.json` in the app data folder).
//!
//! Commands that act on a server take its id and look it up here, so the SSH
//! destination and options always come from validated, saved settings.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::{ssh, valid_master_path, valid_remote, valid_ssh_dest, valid_tag, EnvHost};

const FILE: &str = "environments.json";

#[derive(Default)]
pub struct EnvsState {
    lock: Mutex<()>,
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(FILE))
        .map_err(|e| format!("Could not locate the app data folder: {e}"))
}

fn load(app: &AppHandle) -> Result<Vec<EnvHost>, String> {
    let file = file(app)?;
    match fs::read_to_string(&file) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Could not read {}: {e}", file.display())),
    }
}

fn save(app: &AppHandle, list: &[EnvHost]) -> Result<(), String> {
    let file = file(app)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json)
        .and_then(|_| fs::rename(&tmp, &file))
        .map_err(|e| format!("Could not save {}: {e}", file.display()))
}

/// The saved server `id`, or an error for one that was removed.
pub fn get(app: &AppHandle, id: &str) -> Result<EnvHost, String> {
    load(app)?
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| "That server is no longer in Mango's list. Add it again under Environments.".to_string())
}

/// Trim and check user input; the id is kept or assigned by the caller.
pub(crate) fn clean(mut h: EnvHost) -> Result<EnvHost, String> {
    h.name = h.name.trim().to_string();
    h.ssh = h.ssh.trim().to_string();
    valid_ssh_dest(&h.ssh)?;
    if h.name.is_empty() {
        h.name = h.ssh.rsplit('@').next().unwrap_or(&h.ssh).to_string();
    }
    if h.name.chars().count() > 60 {
        return Err("Keep the name under 60 characters.".into());
    }
    if h.port == Some(0) {
        h.port = None;
    }
    h.identity_file = h.identity_file.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(key) = &h.identity_file {
        if key.starts_with('-') || key.chars().any(|c| c.is_control()) {
            return Err(format!("\"{key}\" is not a key file path."));
        }
        if !std::path::Path::new(key).is_file() {
            return Err(format!("The key file {key} does not exist on this computer."));
        }
    }
    h.incus_remote = h.incus_remote.map(|s| s.trim().trim_end_matches(':').to_string()).filter(|s| !s.is_empty());
    if let Some(r) = &h.incus_remote {
        valid_remote(r)?;
    }
    h.public_address = h.public_address.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(a) = &h.public_address {
        let ok = a.len() <= 253
            && !a.starts_with('-')
            && a.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c));
        if !ok {
            return Err(format!("\"{a}\" is not an address. Use a host name or an IP address."));
        }
    }
    if let Some(ts) = &mut h.tailscale {
        ts.tags = ts.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        for t in &ts.tags {
            valid_tag(t)?;
        }
        ts.auth_key_file = ts.auth_key_file.take().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(p) = &ts.auth_key_file {
            valid_master_path(p)?;
        }
    }
    Ok(h)
}

#[tauri::command]
pub async fn env_hosts(app: AppHandle) -> Result<Vec<EnvHost>, String> {
    super::blocking(move || load(&app)).await
}

/// Add (`host.id` empty) or update a server.
#[tauri::command]
pub async fn env_host_save(app: AppHandle, host: EnvHost) -> Result<EnvHost, String> {
    super::blocking(move || {
        let mut h = clean(host)?;
        let state = app.state::<EnvsState>();
        let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = load(&app)?;
        if h.id.trim().is_empty() {
            if h.direct.is_some() {
                return Err("Join a shared environment with its link instead.".into());
            }
            h.id = uuid::Uuid::new_v4().to_string();
            list.push(h.clone());
        } else if let Some(slot) = list.iter_mut().find(|x| x.id == h.id) {
            if slot.direct.is_some() {
                // A joined environment: only its name is the user's to change; the rest came from the link.
                slot.name = h.name.clone();
                h = slot.clone();
            } else {
                h.direct = None;
                *slot = h.clone();
            }
        } else {
            return Err("That server is no longer in Mango's list.".into());
        }
        save(&app, &list)?;
        Ok(h)
    })
    .await
}

/// Forget a server. Its instances are untouched.
#[tauri::command]
pub async fn env_host_remove(app: AppHandle, state: State<'_, EnvsState>, id: String) -> Result<(), String> {
    let _guard = state.lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load(&app)?;
    list.retain(|h| h.id != id);
    save(&app, &list)
}

/// Incus on a server, as the probe finds it (`EnvIncusState` in ipc.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IncusState {
    /// Installed, initialised, usable by the SSH user (or the Incus remote answers).
    Ready,
    /// Not installed (or only the client, without a daemon).
    Missing,
    /// Installed, but no storage pool / root disk yet, or the daemon did not answer.
    Uninitialised,
    /// Installed, but the SSH user may not use it (not in `incus-admin`), or the remote refused.
    NoAccess,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProbe {
    /// SSH worked and Incus is ready to use.
    pub ok: bool,
    /// SSH worked, whatever the state of Incus.
    pub reachable: bool,
    /// `None` when the server could not be reached.
    pub incus: Option<IncusState>,
    pub incus_version: Option<String>,
    /// The server's OS, e.g. "Ubuntu 24.04.1 LTS".
    pub os: Option<String>,
    /// `env_server_setup` can install, initialise or update Incus here.
    pub can_setup: bool,
    /// Why it can't, when `can_setup` is false and Incus isn't ready.
    pub setup_note: Option<String>,
    /// Instance remotes the server's `incus` knows (`incus remote list`).
    pub remotes: Vec<String>,
    pub error: Option<String>,
}

fn parse_remotes(json: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let mut names: Vec<String> = v
        .as_object()
        .map(|m| {
            m.iter()
                // Image servers (simplestreams) hold no instances.
                .filter(|(_, r)| r.get("Protocol").and_then(|p| p.as_str()) != Some("simplestreams"))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// The probe (POSIX sh, as the SSH user; `$1` = the Incus remote or empty), after
/// `server::SH_COMMON`. Prints `key=value` lines, one fact each; flags are `1` or absent.
pub(crate) const PROBE: &str = r##"R=${1:-}
kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\r\n\t' '   ')"; }
t() { if command -v timeout >/dev/null 2>&1; then timeout 20 "$@"; else "$@"; fi; }
INFO_OK=
info() {
  if err=$(t incus "$@" 2>&1 >/dev/null); then INFO_OK=1; kv info ok
  else kv info fail; kv info_err "$(printf '%s\n' "$err" | grep . | tail -n 3)"; fi
}
PRETTY_NAME= NAME= ID= ID_LIKE= VERSION_ID= VERSION_CODENAME= UBUNTU_CODENAME= DEBIAN_CODENAME=
[ -r /etc/os-release ] && . /etc/os-release
kv os "${PRETTY_NAME:-$NAME}"
kv id "$ID"
kv version_id "$VERSION_ID"
kv id_like "$ID_LIKE"
kv suite "$(zabbly_suite)"
kv arch "$(dpkg --print-architecture 2>/dev/null || uname -m)"
[ -d /run/systemd/system ] && kv systemd 1
command -v apt-get >/dev/null 2>&1 && kv apt 1
[ "$(id -u)" = 0 ] && kv root 1
command -v sudo >/dev/null 2>&1 && kv sudo 1
if command -v incus >/dev/null 2>&1; then
  kv incus 1
  kv client_version "$(incus --version 2>/dev/null)"
  [ "$(dpkg-query -W -f='${Status}' incus 2>/dev/null)" = "install ok installed" ] && kv pkg 1
  kv remotes "$(incus remote list --format json 2>/dev/null)"
  if [ -n "$R" ]; then
    info info "$R:"
    kv server_version "$(t incus version "$R:" 2>/dev/null | sed -n 's/^Server version: *//p')"
  elif has_daemon; then
    kv daemon 1
    if [ "$(id -u)" = 0 ] || id -nG 2>/dev/null | tr ' ' '\n' | grep -qx incus-admin \
      || [ -w /run/incus/unix.socket ] || [ -w /var/lib/incus/unix.socket ]; then
      kv admin 1
      info --force-local info
      if [ -n "$INFO_OK" ]; then
        kv server_version "$(t incus --force-local version 2>/dev/null | sed -n 's/^Server version: *//p')"
        kv pools "$(t incus --force-local storage list --format csv 2>/dev/null | grep -c .)"
        default_devices
        kv root_disk "$HAS_ROOT"
        kv nic "$HAS_NIC"
      fi
    fi
  fi
fi
exit 0
"##;

/// The probe's facts, by key.
struct Facts(std::collections::HashMap<String, String>);

impl Facts {
    fn parse(out: &str) -> Self {
        Facts(
            out.lines()
                .filter_map(|l| l.split_once('='))
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                .collect(),
        )
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).map(String::as_str).filter(|v| !v.is_empty())
    }
    fn flag(&self, k: &str) -> bool {
        self.get(k) == Some("1")
    }
}

const SUPPORTED: &str = "Mango sets up Incus on Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04 LTS (and distributions based on them).";

/// Can `env_server_setup` do its job here? `Err` says why not.
fn setup_capability(f: &Facts) -> Result<(), String> {
    let os = f.get("os").unwrap_or("This server's system");
    if !f.flag("apt") {
        return Err(format!("{os} is not supported. {SUPPORTED}"));
    }
    if !f.flag("systemd") {
        return Err(format!("Incus needs systemd, and {os} on this server is not running it."));
    }
    if !f.flag("root") && !f.flag("sudo") {
        return Err("Setting up Incus needs root, and this server has no sudo. Install sudo there, or connect as root.".into());
    }
    // Updating or initialising an existing Incus works on any apt + systemd system;
    // installing needs a release Zabbly builds for.
    let installed = f.flag("pkg") || (f.flag("incus") && f.flag("daemon"));
    if !installed {
        if f.get("suite").is_none() {
            return Err(format!("{os} is not supported yet. {SUPPORTED}"));
        }
        let arch = f.get("arch").unwrap_or("unknown");
        if !matches!(arch, "amd64" | "arm64") {
            return Err(format!("Incus packages are built for amd64 and arm64; this server is {arch}."));
        }
    }
    Ok(())
}

/// Turn the probe's output into what the frontend shows. `remote` is the host's Incus remote.
pub(crate) fn evaluate(out: &str, remote: Option<&str>) -> EnvProbe {
    let f = Facts::parse(out);
    let remotes = f.get("remotes").map(parse_remotes).unwrap_or_default();
    let version = f
        .get("server_version")
        .filter(|v| *v != "unreachable")
        .or_else(|| f.get("client_version"))
        .map(String::from);
    let info_err = f.get("info_err").unwrap_or("no details").to_string();
    let info_ok = f.get("info") == Some("ok");
    let mut error = None;
    let mut capability = setup_capability(&f);

    let state = if !f.flag("incus") {
        IncusState::Missing
    } else if let Some(r) = remote {
        // Instances live on another Incus: setting up this server would not change that.
        if info_ok {
            IncusState::Ready
        } else {
            error = Some(format!("The Incus remote \"{r}\" did not answer: {info_err}"));
            capability = Err(format!(
                "Instances live on the Incus remote \"{r}\", which the server could not reach. Check it with `incus remote list` on the server, or clear the remote in this server's settings."
            ));
            IncusState::NoAccess
        }
    } else if !f.flag("daemon") {
        IncusState::Missing
    } else if !f.flag("admin") {
        IncusState::NoAccess
    } else if !info_ok {
        if info_err.to_lowercase().contains("permission") {
            error = Some(info_err);
            IncusState::NoAccess
        } else {
            error = Some(format!("Incus is installed, but its daemon did not answer: {info_err}"));
            IncusState::Uninitialised
        }
    } else if f.get("pools").is_none_or(|n| n == "0") || !f.flag("root_disk") {
        IncusState::Uninitialised
    } else {
        IncusState::Ready
    };

    let ready = state == IncusState::Ready;
    let can_setup = capability.is_ok() && !(remote.is_some() && f.flag("incus"));
    EnvProbe {
        ok: ready,
        reachable: true,
        incus: Some(state),
        incus_version: version.filter(|_| state != IncusState::Missing),
        os: f.get("os").map(String::from),
        can_setup,
        setup_note: if ready { None } else { capability.err() },
        remotes,
        error,
    }
}

/// The remote argv (for `ssh::run`) of the probe.
pub(crate) fn probe_remote(host: &EnvHost) -> Vec<String> {
    let script = format!("{}{PROBE}", super::server::SH_COMMON);
    let remote = host.incus_remote.clone().unwrap_or_default();
    vec!["sh".into(), "-c".into(), script, "mango-probe".into(), remote]
}

/// Can Mango reach the server, and what state is its Incus in? One SSH call.
#[tauri::command]
pub async fn env_probe(app: AppHandle, host_id: String) -> Result<EnvProbe, String> {
    super::blocking(move || {
        let host = get(&app, &host_id)?;
        if let Some(r) = &host.incus_remote {
            valid_remote(r)?;
        }
        match ssh::run(&host, &probe_remote(&host), Duration::from_secs(60)) {
            Ok(out) => Ok(evaluate(&out, host.incus_remote.as_deref().filter(|r| !r.is_empty()))),
            Err(e) => Ok(EnvProbe {
                ok: false,
                reachable: false,
                incus: None,
                incus_version: None,
                os: None,
                can_setup: false,
                setup_note: None,
                remotes: vec![],
                error: Some(e),
            }),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envs::EnvTailscale;

    fn base() -> EnvHost {
        EnvHost {
            id: String::new(),
            name: "  ".into(),
            ssh: " ops@lab ".into(),
            port: Some(0),
            identity_file: Some("".into()),
            incus_remote: Some("os1:".into()),
            tailscale: Some(EnvTailscale { tags: vec![" tag:mango ".into(), "".into()], auth_key_file: Some(" ".into()) }),
            public_address: None,
            direct: None,
        }
    }

    #[test]
    fn cleans_input() {
        let h = clean(base()).unwrap();
        assert_eq!(h.ssh, "ops@lab");
        assert_eq!(h.name, "lab");
        assert_eq!(h.port, None);
        assert_eq!(h.identity_file, None);
        assert_eq!(h.incus_remote.as_deref(), Some("os1"));
        let ts = h.tailscale.unwrap();
        assert_eq!(ts.tags, ["tag:mango"]);
        assert_eq!(ts.auth_key_file, None);
    }

    #[test]
    fn rejects_bad_input() {
        let mut h = base();
        h.ssh = "-oProxyCommand=sh".into();
        assert!(clean(h).is_err());
        let mut h = base();
        h.tailscale = Some(EnvTailscale { tags: vec!["admins".into()], auth_key_file: None });
        assert!(clean(h).is_err());
        let mut h = base();
        h.identity_file = Some("/definitely/not/here/id".into());
        assert!(clean(h).is_err());
    }

    #[test]
    fn remotes_skip_image_servers() {
        let j = r#"{"images":{"Protocol":"simplestreams"},"local":{"Protocol":"incus"},"os1":{"Protocol":"incus"}}"#;
        assert_eq!(parse_remotes(j), ["local", "os1"]);
    }

    const UBUNTU: &str = "os=Ubuntu 24.04.1 LTS\nid=ubuntu\nversion_id=24.04\nid_like=debian\nsuite=noble\narch=amd64\nsystemd=1\napt=1\nsudo=1\n";
    const REMOTES: &str = r#"remotes={"images":{"Protocol":"simplestreams"},"local":{"Protocol":"incus"}}"#;

    fn probe(extra: &str) -> EnvProbe {
        evaluate(&format!("{UBUNTU}{extra}"), None)
    }

    #[test]
    fn probe_missing() {
        let p = probe("");
        assert_eq!(p.incus, Some(IncusState::Missing));
        assert!(p.reachable && !p.ok && p.can_setup);
        assert_eq!(p.os.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(p.setup_note, None);
        assert_eq!(p.incus_version, None);
        // The client alone (no daemon) is still "missing".
        let p = probe(&format!("incus=1\nclient_version=6.18\n{REMOTES}\n"));
        assert_eq!(p.incus, Some(IncusState::Missing));
        assert!(p.can_setup);
    }

    #[test]
    fn probe_no_access() {
        let p = probe(&format!("incus=1\npkg=1\nclient_version=6.18\ndaemon=1\n{REMOTES}\n"));
        assert_eq!(p.incus, Some(IncusState::NoAccess));
        assert!(!p.ok && p.can_setup);
        assert_eq!(p.incus_version.as_deref(), Some("6.18"));
        assert_eq!(p.remotes, ["local"]);
        // The daemon refusing the socket also counts.
        let p = probe("incus=1\npkg=1\ndaemon=1\nadmin=1\ninfo=fail\ninfo_err=Error: dial unix /var/lib/incus/unix.socket: connect: permission denied\n");
        assert_eq!(p.incus, Some(IncusState::NoAccess));
        assert!(p.error.unwrap().contains("permission denied"));
    }

    #[test]
    fn probe_uninitialised() {
        let base = "incus=1\npkg=1\nclient_version=6.18\ndaemon=1\nadmin=1\ninfo=ok\nserver_version=6.18\n";
        for extra in ["pools=0\nroot_disk=\nnic=\n", "pools=1\nroot_disk=\nnic=1\n", "pools=0\nroot_disk=1\n"] {
            let p = probe(&format!("{base}{extra}"));
            assert_eq!(p.incus, Some(IncusState::Uninitialised), "{extra}");
            assert!(p.can_setup && !p.ok && p.error.is_none());
        }
        // A daemon that does not answer: setup (re)starts it.
        let p = probe("incus=1\npkg=1\ndaemon=1\nadmin=1\ninfo=fail\ninfo_err=Error: Get \"http://unix.socket/1.0\": EOF\n");
        assert_eq!(p.incus, Some(IncusState::Uninitialised));
        assert!(p.error.unwrap().contains("did not answer"));
    }

    #[test]
    fn probe_ready() {
        let p = probe(&format!(
            "incus=1\npkg=1\nclient_version=6.18\ndaemon=1\nadmin=1\ninfo=ok\nserver_version=6.19\npools=1\nroot_disk=1\nnic=1\n{REMOTES}\n"
        ));
        assert_eq!(p.incus, Some(IncusState::Ready));
        assert!(p.ok && p.can_setup && p.error.is_none() && p.setup_note.is_none());
        assert_eq!(p.incus_version.as_deref(), Some("6.19"));
        // Ready on a release Zabbly doesn't build for (installed some other way): still updatable.
        let p = evaluate(
            "os=Debian GNU/Linux forky/sid\nid=debian\nsuite=\narch=amd64\nsystemd=1\napt=1\nroot=1\nincus=1\npkg=1\ndaemon=1\nadmin=1\ninfo=ok\npools=2\nroot_disk=1\n",
            None,
        );
        assert!(p.ok && p.can_setup);
    }

    #[test]
    fn probe_unsupported() {
        let p = evaluate("os=Fedora Linux 41\nid=fedora\nsuite=\narch=x86_64\nsystemd=1\nsudo=1\n", None);
        assert_eq!(p.incus, Some(IncusState::Missing));
        assert!(!p.can_setup);
        assert!(p.setup_note.unwrap().starts_with("Fedora Linux 41 is not supported"));

        let p = evaluate("os=Ubuntu 25.10\nid=ubuntu\nsuite=\narch=amd64\nsystemd=1\napt=1\nsudo=1\n", None);
        assert!(!p.can_setup);
        assert!(p.setup_note.unwrap().contains("not supported yet"));

        let p = evaluate("os=Debian GNU/Linux 12 (bookworm)\nsuite=bookworm\narch=armhf\nsystemd=1\napt=1\nroot=1\n", None);
        assert!(p.setup_note.unwrap().contains("armhf"));

        let p = evaluate("os=Debian GNU/Linux 12 (bookworm)\nsuite=bookworm\narch=amd64\nsystemd=1\napt=1\n", None);
        assert!(p.setup_note.unwrap().contains("no sudo"));

        // Derivatives come in through their Ubuntu/Debian base (the script resolves `suite`).
        let p = evaluate("os=Linux Mint 22\nid=linuxmint\nid_like=ubuntu debian\nsuite=noble\narch=amd64\nsystemd=1\napt=1\nsudo=1\n", None);
        assert!(p.can_setup);
    }

    #[test]
    fn probe_without_systemd() {
        let p = evaluate("os=Debian GNU/Linux 12 (bookworm)\nsuite=bookworm\narch=amd64\napt=1\nroot=1\n", None);
        assert!(!p.can_setup);
        assert!(p.setup_note.unwrap().contains("systemd"));
    }

    #[test]
    fn probe_with_a_remote() {
        let p = evaluate(&format!("{UBUNTU}incus=1\nclient_version=6.18\ninfo=ok\nserver_version=6.0.4\n{REMOTES}\n"), Some("os1"));
        assert_eq!(p.incus, Some(IncusState::Ready));
        assert!(p.ok && p.error.is_none());
        assert_eq!(p.incus_version.as_deref(), Some("6.0.4"));
        assert!(!p.can_setup, "setting up this server would not change the remote");

        let p = evaluate(
            &format!("{UBUNTU}incus=1\ninfo=fail\ninfo_err=Error: The remote \"os1\" doesn't exist\nserver_version=unreachable\n"),
            Some("os1"),
        );
        assert_eq!(p.incus, Some(IncusState::NoAccess));
        assert!(!p.ok && !p.can_setup);
        assert!(p.error.unwrap().contains("doesn't exist"));
        assert!(p.setup_note.unwrap().contains("incus remote list"));

        // No incus at all: installing it here is still the first step.
        let p = evaluate(UBUNTU, Some("os1"));
        assert_eq!(p.incus, Some(IncusState::Missing));
        assert!(p.can_setup);
    }

    #[test]
    fn probe_wire_format() {
        let p = probe("incus=1\npkg=1\ndaemon=1\n");
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["incus"], "no-access");
        assert_eq!(v["canSetup"], true);
        assert!(v.get("incusVersion").is_some() && v.get("setupNote").is_some());
        let v = serde_json::to_value(probe("incus=1\npkg=1\ndaemon=1\nadmin=1\ninfo=ok\npools=0\n")).unwrap();
        assert_eq!(v["incus"], "uninitialised");
    }

    #[test]
    fn probe_line_passes_the_remote_positionally() {
        let mut h = base();
        h.incus_remote = Some("os1".into());
        let r = probe_remote(&h);
        assert_eq!(&r[..2], ["sh", "-c"]);
        assert_eq!(&r[3..], ["mango-probe", "os1"]);
        h.incus_remote = None;
        assert_eq!(probe_remote(&h)[4], "");
    }
}
