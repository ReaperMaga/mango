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
//! - `recipes`: one-click components (agents, gh, desktop, Tailscale) and their
//!              install/update scripts, run in a PTY the user watches
//! - `remote`:  a shell or sign-in terminal inside an instance, and the
//!              desktop (noVNC) tunnel
//! - `server`:  installing, updating and initialising Incus itself on the master

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
    }
}
