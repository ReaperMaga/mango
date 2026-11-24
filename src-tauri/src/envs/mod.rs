//! Remote environments: Incus instances (containers and VMs) on a "master"
//! server Mango reaches over SSH.
//!
//! Mango runs nothing of its own on the master: every action is one `ssh`
//! invocation that runs the master's `incus` CLI (which may in turn talk to
//! IncusOS hosts through an Incus remote). Sign-in is the user's own SSH
//! setup (keys, agent, `~/.ssh/config`); Mango never sees a password.
//!
//! - `ssh`:     building and running `ssh … incus …` command lines, quoting
//! - `hosts`:   the saved masters (`environments.json`), validation, probing
//! - `incus`:   listing, creating, starting/stopping/deleting instances
//! - `recipes`: one-click components (agents, gh, Node.js, Java, desktop, Tailscale)
//!              and their install/update scripts, run in a PTY the user watches;
//!              the versions Node.js and Java offer
//! - `remote`:  a shell or sign-in terminal inside an instance, and the
//!              desktop (noVNC) tunnel
//! - `server`:  installing, updating and initialising Incus itself on the master
//! - `token`:   share links (`mango://join/…`)
//! - `shares`:  sharing an environment (the owner's side)
//! - `join`:    joining one from a link (a "direct" host: SSH straight into the
//!              environment as its agent user, no master, no Incus), and the
//!              `mango://` deep link

pub mod hosts;
pub mod incus;
pub mod join;
pub mod recipes;
pub mod remote;
pub mod server;
pub mod shares;
pub mod ssh;
pub mod token;

use serde::{Deserialize, Serialize};

/// The account the agents run as inside every instance (created by the `base` component).
pub const AGENT_USER: &str = "agent";
pub const AGENT_HOME: &str = "/home/agent";

/// A master server: where Mango SSHes to run `incus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvHost {
    pub id: String,
    pub name: String,
    /// `user@host`, or an alias from `~/.ssh/config`.
    pub ssh: String,
    pub port: Option<u16>,
    /// A private key on this computer; `None` uses the user's SSH defaults.
    pub identity_file: Option<String>,
    /// The Incus remote (on the master) holding the instances; `None` is the master's default.
    pub incus_remote: Option<String>,
    /// Join new instances to a tailnet; `None` keeps Tailscale out of it.
    pub tailscale: Option<EnvTailscale>,
    /// The address other people reach this server at, for share links over a public port;
    /// `None` uses the host name of `ssh`.
    #[serde(default)]
    pub public_address: Option<String>,
    /// Set for an environment joined from a share link: SSH goes straight into that
    /// environment (as its agent user), there is no master and no Incus.
    #[serde(default)]
    pub direct: Option<EnvDirect>,
}

/// A joined environment (see `token`): reached directly, with the key from the link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvDirect {
    /// The environment's name, shown as the host's only instance.
    pub instance: String,
    /// Its pinned SSH host key: the base64 blob of an `ssh-ed25519` key.
    pub host_key: String,
    /// Where it was shared from, as the link says (e.g. "forge/dev").
    pub shared_from: String,
    /// The share's id.
    pub share_id: String,
    /// When access ends (unix ms); `None` = no end.
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvTailscale {
    /// Tags to advertise, e.g. `tag:mango` (the tailnet's ACLs decide what they may reach).
    #[serde(default)]
    pub tags: Vec<String>,
    /// A file *on the master* holding a Tailscale auth key. `None`: interactive sign-in
    /// (the installer prints a login link). Mango never reads the key itself.
    pub auth_key_file: Option<String>,
}

/// Which instance of which master: what the frontend sends to address one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvRemote {
    pub host_id: String,
    pub instance: String,
}

/// A folder inside an instance, from a remote project's path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvFolder {
    pub host_id: String,
    pub instance: String,
    /// Absolute, checked by [`valid_instance_dir`].
    pub dir: String,
}

/// Where remote projects live in the frontend: `env://<hostId>/<instance>/<absolute folder>`
/// (`app/utils/envPath.ts`). `None` for any other path (a folder on this computer);
/// an error when it is a remote path whose parts don't pass validation.
pub fn parse_env_path(path: &str) -> Option<Result<EnvFolder, String>> {
    let rest = path.trim().strip_prefix("env://")?;
    Some((|| {
        let bad = || format!("\"{path}\" is not a remote project path.");
        let (host_id, rest) = rest.split_once('/').ok_or_else(bad)?;
        let (instance, dir) = match rest.find('/') {
            Some(at) => (&rest[..at], &rest[at..]),
            None => (rest, "/"),
        };
        if host_id.is_empty() || host_id.len() > 64 || !all_chars(host_id, |c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(bad());
        }
        valid_instance(instance)?;
        valid_instance_dir(dir)?;
        Ok(EnvFolder { host_id: host_id.into(), instance: instance.into(), dir: dir.into() })
    })())
}

/// Refuse an owner-only action on a joined environment.
pub fn owner_only(host: &EnvHost, what: &str) -> Result<(), String> {
    match &host.direct {
        Some(_) => Err(format!("Only the owner can {what}.")),
        None => Ok(()),
    }
}

/// Now, in unix ms.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Unix ms as `2026-11-20 14:05 UTC`, for messages.
pub fn utc_text(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", rem / 3600, rem % 3600 / 60)
}

/// Run blocking work (ssh calls) off the async runtime.
pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Background task failed: {e}"))?
}

/* ---------- validation: everything from the webview passes one of these ---------- */

fn all_chars(s: &str, ok: impl Fn(char) -> bool) -> bool {
    s.chars().all(ok)
}

/// An SSH destination: `host`, `user@host`, or a config alias. Never an option.
pub fn valid_ssh_dest(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && all_chars(s, |c| c.is_ascii_alphanumeric() || "._@%+-:".contains(c));
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not an SSH destination. Use user@host or a name from ~/.ssh/config."))
}

/// An Incus remote name (as in `incus remote list`).
pub fn valid_remote(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 63
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && all_chars(s, |c| c.is_ascii_alphanumeric() || "._-".contains(c));
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not an Incus remote name."))
}

/// An Incus instance name: a letter, then letters, digits and dashes (max 63), no trailing dash.
pub fn valid_instance(s: &str) -> Result<(), String> {
    let ok = s.len() <= 63
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && !s.ends_with('-')
        && all_chars(s, |c| c.is_ascii_alphanumeric() || c == '-');
    ok.then_some(()).ok_or_else(|| {
        format!("\"{s}\" can't be an instance name. Use a letter, then letters, digits and dashes (up to 63).")
    })
}

/// An image reference such as `images:ubuntu/24.04` or `images:debian/12/cloud`.
pub fn valid_image(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 200
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && all_chars(s, |c| c.is_ascii_alphanumeric() || "._:/-".contains(c));
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not an image name."))
}

/// A Tailscale ACL tag, `tag:name`.
pub fn valid_tag(s: &str) -> Result<(), String> {
    let name = s.strip_prefix("tag:").unwrap_or("");
    let ok = !name.is_empty()
        && name.len() <= 60
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && all_chars(name, |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not a Tailscale tag. Tags look like tag:mango."))
}

/// A path on the master: absolute or `~/…`, plain characters only.
pub fn valid_master_path(s: &str) -> Result<(), String> {
    let ok = (s.starts_with('/') || s.starts_with("~/"))
        && s.len() <= 400
        && !s.split('/').any(|p| p == "..")
        && all_chars(s, |c| c.is_ascii_alphanumeric() || "._/~-".contains(c));
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not a usable path on the server. Use /abs/path or ~/path."))
}

/// A folder inside an instance: absolute, no `..`, no control characters.
pub fn valid_instance_dir(s: &str) -> Result<(), String> {
    let ok = s.starts_with('/')
        && s.len() <= 1000
        && !s.split('/').any(|p| p == "..")
        && !s.chars().any(|c| c.is_control());
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not an absolute folder path inside the environment."))
}

/// A Node.js version to install: `22`, `22.11` or `22.11.0` (no `v`, no pre-releases).
pub fn valid_node_version(s: &str) -> Result<(), String> {
    let parts: Vec<&str> = s.split('.').collect();
    let ok = (1..=3).contains(&parts.len())
        && parts.iter().all(|p| (1..=4).contains(&p.len()) && all_chars(p, |c| c.is_ascii_digit()));
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not a Node.js version. Use one such as 22.11.0, or 22 for the newest 22.x."))
}

/// An SDKMAN Java identifier such as `21.0.5-tem` or `25.0.5.0-fx+3.1-zulu`.
pub fn valid_java_version(s: &str) -> Result<(), String> {
    let ok = s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_digit())
        && s.contains('-')
        && !s.ends_with('-')
        && all_chars(s, |c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    ok.then_some(()).ok_or_else(|| format!("\"{s}\" is not an SDKMAN Java identifier. They look like 21.0.5-tem."))
}

/// The GitLab server a `glab` sign-in is for: gitlab.com when none is given, else a host name
/// (optionally with a port), normalised the way Settings > Git hosting stores it.
pub fn valid_gitlab_host(s: Option<&str>) -> Result<String, String> {
    match s.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(crate::gitlab::GITLAB_COM.to_string()),
        Some(h) => crate::gitlab::normalize_host(h)
            .ok_or_else(|| format!("\"{h}\" is not a GitLab server name. Type it like gitlab.example.com.")),
    }
}

/// An environment variable name for an agent run.
pub fn valid_env_key(s: &str) -> bool {
    !s.is_empty()
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && all_chars(s, |c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_destinations() {
        for ok in ["master", "me@10.0.0.4", "ops@incus.example.com", "box_1"] {
            assert!(valid_ssh_dest(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-oProxyCommand=x", "a b", "me@host;rm", "x$(id)", "a\nb"] {
            assert!(valid_ssh_dest(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn instance_names() {
        for ok in ["dev", "mango-1", "a"] {
            assert!(valid_instance(ok).is_ok(), "{ok}");
        }
        for bad in ["", "1abc", "dev-", "a_b", "a.b", "-x", &"a".repeat(64)] {
            assert!(valid_instance(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn other_values() {
        assert!(valid_image("images:ubuntu/24.04").is_ok());
        assert!(valid_image("images:ubuntu 24").is_err());
        assert!(valid_tag("tag:mango").is_ok());
        assert!(valid_tag("mango").is_err());
        assert!(valid_tag("tag:Mango").is_err());
        assert!(valid_master_path("~/.config/ts-key").is_ok());
        assert!(valid_master_path("/etc/../root/key").is_err());
        assert!(valid_master_path("key").is_err());
        assert!(valid_instance_dir("/home/agent/work/my app").is_ok());
        assert!(valid_instance_dir("work").is_err());
        assert!(valid_instance_dir("/home/../etc").is_err());
        assert!(valid_remote("incusos-1").is_ok());
        assert!(valid_remote("a:b").is_err());
        assert!(valid_env_key("CLAUDE_CODE_X"));
        assert!(!valid_env_key("A=B"));
        assert_eq!(valid_gitlab_host(None).unwrap(), "gitlab.com");
        assert_eq!(valid_gitlab_host(Some("  ")).unwrap(), "gitlab.com");
        assert_eq!(valid_gitlab_host(Some("https://GitLab.Corp.io/x")).unwrap(), "gitlab.corp.io");
        assert_eq!(valid_gitlab_host(Some("git.corp.io:8443")).unwrap(), "git.corp.io:8443");
        for bad in ["localhost", "a.io;id", "$(id).io", "-x.io", "a.io:0", "a b.io", "'a.io"] {
            assert!(valid_gitlab_host(Some(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn component_versions() {
        for ok in ["22", "22.11", "22.11.0", "8.17.0"] {
            assert!(valid_node_version(ok).is_ok(), "{ok}");
        }
        for bad in ["", "v22", "22.", "22.11.0.1", "27.0.0-alpha.1", "22;id", "lts", "12345"] {
            assert!(valid_node_version(bad).is_err(), "{bad:?}");
        }
        for ok in ["21.0.5-tem", "25.0.5.0-fx+3.1-zulu", "26.0.2.0+11.1-amzn", "22.1.0.r21-grl"] {
            assert!(valid_java_version(ok).is_ok(), "{ok}");
        }
        for bad in ["", "tem", "21", "21-", "21.0.5-tem;id", "21.0.5-tem/../x", "21 -tem", "-21-tem", &format!("1-{}", "a".repeat(64))] {
            assert!(valid_java_version(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn env_paths() {
        assert_eq!(parse_env_path("/home/me/shop"), None);
        assert_eq!(parse_env_path(r"C:\Users\me\shop"), None);
        let f = parse_env_path("env://6f1c-22/dev/home/agent/work/my shop").unwrap().unwrap();
        assert_eq!(f, EnvFolder { host_id: "6f1c-22".into(), instance: "dev".into(), dir: "/home/agent/work/my shop".into() });
        assert_eq!(parse_env_path("env://h/dev").unwrap().unwrap().dir, "/");
        for bad in ["env://", "env://h", "env:///dev/x", "env://h/1dev/x", "env://h/dev/a/../b", "env://h;x/dev/a", "env://h/dev/a\nb"] {
            assert!(parse_env_path(bad).unwrap().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn utc_dates() {
        assert_eq!(utc_text(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc_text(951_868_800_500), "2000-03-01 00:00 UTC");
        assert_eq!(utc_text(1_793_518_930_123), "2026-11-01 07:42 UTC");
    }
}
