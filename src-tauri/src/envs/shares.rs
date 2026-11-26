//! Sharing an environment with a one-line link (see `token`), on the owner's side.
//!
//! A share is one line in the environment's `/home/agent/.ssh/authorized_keys`:
//!
//! ```text
//! expiry-time="202612011200Z" ssh-ed25519 AAAA… mango-share id=k3j9x2m4pq via=public created=<ms> expires=<ms|0> endpoint=203.0.113.24:22107 label=<base64url>
//! ```
//!
//! Mango keeps no list of its own: listing reads those comments back, revoking
//! deletes the line. The key pair is made here per share; only the public half
//! reaches the environment and the private seed exists only in the returned link.
//!
//! The environment's own OpenSSH server (installed and set up on the first share:
//! keys only, no root login) is what people connect to, as the `agent` user:
//! - `public`: an Incus proxy device `mango-ssh` on the instance forwards a port in
//!   22100–22999 on the Incus host to the instance's port 22.
//! - `tailscale`: the instance's tailnet address, port [`TAILNET_PORT`]. Not 22:
//!   Mango's Tailscale component turns on Tailscale SSH, which answers port 22 on the
//!   tailnet address itself (tailnet ACLs, not these keys), so OpenSSH also listens
//!   on 22022.
//!
//! Each command is one `ssh master sh -c SCRIPT …` run; the scripts are constants
//! and every value reaches them as a positional argument.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use tauri::AppHandle;

use super::token::{self, ShareToken};
use super::{blocking, hosts, recipes, ssh, valid_instance, EnvHost, AGENT_USER};

/// The port OpenSSH also listens on inside a shared environment, for tailnet shares.
pub const TAILNET_PORT: u16 = 22022;
/// The ports a public share may take on the Incus host.
const PORT_LO: u16 = 22100;
const PORT_HI: u16 = 22999;
const MAX_LABEL: usize = 60;
const MAX_DAYS: u32 = 365;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvShare {
    pub id: String,
    pub label: String,
    /// "public" | "tailscale"
    pub via: String,
    pub endpoint: String,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvShareLink {
    pub share: EnvShare,
    pub url: String,
    /// What the owner may still have to do (open a firewall port, tailnet access).
    /// Not in `ipc.ts` yet: extra, optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/* ---------- validation ---------- */

fn refuse_direct(host: &EnvHost) -> Result<(), String> {
    match host.direct {
        Some(_) => Err("Only the environment's owner can share it.".into()),
        None => Ok(()),
    }
}

fn clean_label(label: &str) -> Result<String, String> {
    let l = label.trim();
    if l.is_empty() {
        return Err("Say who the link is for (a name or a few words).".into());
    }
    if l.chars().count() > MAX_LABEL {
        return Err(format!("Keep the name under {MAX_LABEL} characters."));
    }
    if l.chars().any(char::is_control) {
        return Err("The name can't contain line breaks or control characters.".into());
    }
    Ok(l.to_string())
}

fn clean_via(via: &str) -> Result<&'static str, String> {
    match via {
        "public" => Ok("public"),
        "tailscale" => Ok("tailscale"),
        _ => Err(format!("\"{via}\" is not a way to share. Use public or tailscale.")),
    }
}

fn valid_share_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then_some(()).ok_or_else(|| format!("\"{id}\" is not a share id."))
}

fn clean_days(days: Option<u32>) -> Result<Option<u32>, String> {
    match days {
        Some(d) if !(1..=MAX_DAYS).contains(&d) => Err(format!("Access can last 1 to {MAX_DAYS} days, or have no end.")),
        d => Ok(d),
    }
}

/// A fresh share id: 10 characters of [0-9a-v].
fn new_id() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 10];
    ring::rand::SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| "Could not get random bytes for a share id.".to_string())?;
    const ALPHABET: &[u8; 32] = b"0123456789abcdefghijklmnopqrstuv";
    Ok(b.iter().map(|x| ALPHABET[(x & 31) as usize] as char).collect())
}

/* ---------- time ---------- */

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// When access ends (unix seconds, on a whole minute), `days` from `now_s`.
fn expiry_secs(now_s: u64, days: u32) -> u64 {
    (now_s + u64::from(days) * 86_400) / 60 * 60
}

/// (year, month, day) for days since 1970-01-01 (Howard Hinnant's civil_from_days).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m as u32, d as u32)
}

/// OpenSSH's `expiry-time` timespec in UTC: `YYYYMMDDHHMMZ` (sshd 9.1+ reads the `Z`;
/// the instance script rewrites it to local time for older servers).
fn expiry_timespec(secs: u64) -> String {
    let (y, m, d) = civil((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!("{y:04}{m:02}{d:02}{:02}{:02}Z", rem / 3600, rem % 3600 / 60)
}

/* ---------- authorized_keys lines ---------- */

/// The comment fields before and after the endpoint (which the script fills in, as only
/// the server knows the port or tailnet address): `mango-share id=… via=… created=… expires=…`
/// and `label=…`.
fn comment_parts(id: &str, via: &str, created_ms: u64, expires_ms: Option<u64>, label: &str) -> (String, String) {
    (
        format!("mango-share id={id} via={via} created={created_ms} expires={}", expires_ms.unwrap_or(0)),
        format!("label={}", URL_SAFE_NO_PAD.encode(label.as_bytes())),
    )
}

/// Read a share back from an `authorized_keys` line; `None` for other keys.
fn parse_share(line: &str) -> Option<EnvShare> {
    let mut words = line.split_whitespace().skip_while(|w| *w != "mango-share");
    words.next()?;
    let (mut id, mut via, mut endpoint, mut label) = (None, None, String::new(), String::new());
    let (mut created, mut expires) = (0u64, 0u64);
    for w in words {
        let Some((k, v)) = w.split_once('=') else { continue };
        match k {
            "id" => id = Some(v.to_string()),
            "via" => via = clean_via(v).ok(),
            "created" => created = v.parse().unwrap_or(0),
            "expires" => expires = v.parse().unwrap_or(0),
            "endpoint" => endpoint = v.to_string(),
            "label" => {
                label = URL_SAFE_NO_PAD.decode(v).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
            }
            _ => {}
        }
    }
    let id = id.filter(|i| valid_share_id(i).is_ok())?;
    Some(EnvShare {
        id,
        label,
        via: via?.to_string(),
        endpoint,
        created_at: created,
        expires_at: (expires > 0).then_some(expires),
    })
}

fn parse_shares(out: &str) -> Vec<EnvShare> {
    let mut v: Vec<EnvShare> = out.lines().filter_map(parse_share).collect();
    v.sort_by_key(|s| s.created_at);
    v
}

/* ---------- where people connect ---------- */

/// The `hostname` line of `ssh -G` output.
fn ssh_g_hostname(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.strip_prefix("hostname "))
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
}

/// `host` from `user@host`.
pub(super) fn host_part(dest: &str) -> &str {
    dest.rsplit_once('@').map_or(dest, |(_, h)| h)
}

pub(super) fn plain_address(a: &str) -> bool {
    !a.is_empty() && a.len() <= 253 && !a.starts_with('-') && a.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
}

pub(super) fn is_loopback(a: &str) -> bool {
    let a = a.to_ascii_lowercase();
    a == "localhost" || a.ends_with(".localhost") || a.starts_with("127.") || a == "::1" || a == "0.0.0.0" || a == "::"
}

/// The address a public share's link points at. `ssh_g` is the HostName `ssh -G` resolves
/// the server's destination to (aliases in ~/.ssh/config), when it could be read.
fn share_address(host: &EnvHost, ssh_g: Option<String>) -> Result<String, String> {
    let set_it = "Set the server's public address in its settings (Settings > Environments) and share again.";
    if let Some(a) = host.public_address.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        return Ok(a.to_string());
    }
    if let Some(r) = host.incus_remote.as_deref().filter(|r| !r.is_empty()) {
        return Err(format!(
            "The environments of {} run on the Incus remote {r}, so a shared port opens there, not on {}. {set_it}",
            host.name, host.name
        ));
    }
    let a = ssh_g.unwrap_or_else(|| host_part(&host.ssh).to_string());
    if !plain_address(&a) || is_loopback(&a) {
        return Err(format!("{} is reached as \"{a}\", which other people can't use. {set_it}", host.name));
    }
    Ok(a)
}

/// Run `ssh -G <dest>` here (no connection) for the HostName it resolves to.
pub(super) fn resolve_with_ssh_g(host: &EnvHost) -> Option<String> {
    let bin = ssh::ssh_bin().ok()?;
    let argv = vec![bin.to_string_lossy().into_owned(), "-G".into(), host.ssh.clone()];
    let out = ssh::command(&argv).stdin(std::process::Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    ssh_g_hostname(&String::from_utf8_lossy(&out.stdout))
}

/// `host` for an endpoint: IPv6 addresses go in brackets.
fn endpoint_host(a: &str) -> String {
    if a.contains(':') { format!("[{a}]") } else { a.to_string() }
}

/// `host:port` / `[v6]:port` back into its parts.
fn split_endpoint(ep: &str) -> Option<(String, u16)> {
    let (h, p) = ep.rsplit_once(':')?;
    let h = h.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(h);
    let p: u16 = p.parse().ok().filter(|p| *p != 0)?;
    plain_address(h).then(|| (h.to_string(), p))
}

/// Where the free-port search starts for `instance`: the same instance tends to get the same port.
fn preferred_port(instance: &str) -> u16 {
    let mut h: u32 = 0x811c_9dc5;
    for b in instance.bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    PORT_LO + (h % u32::from(PORT_HI - PORT_LO + 1)) as u16
}

/* ---------- scripts ---------- */

/// Instance side of a new share (bash, as root). Args: N VIA EP PRE POST E EXPZ.
/// Chatter goes to stderr; results are `mango-endpoint …` and `mango-hostkey …` on stdout.
const INSTANCE_CREATE: &str = r##"set -euo pipefail
exec 3>&1 1>&2
N=$1 VIA=$2 EP=$3 PRE=$4 POST=$5 E=$6 EXPZ=$7
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a LANG=C.UTF-8
fail() { printf 'mango-error: %s\n' "$*" >&2; exit 1; }
LOG=/tmp/mango-share.log
quiet() { "$@" >"$LOG" 2>&1 || { tail -n 15 "$LOG" >&2; return 1; }; }
id -u agent >/dev/null 2>&1 || fail "$N has no agent user yet. Install the Base system component first."
[ -d /run/systemd/system ] || fail "Sharing needs systemd running in $N."
if [ ! -x /usr/sbin/sshd ]; then
  command -v apt-get >/dev/null 2>&1 || fail "$N has no SSH server, and no apt-get to install one."
  ok=
  for _ in 1 2 3 4 5; do
    if quiet apt-get -y -q -o DPkg::Lock::Timeout=300 update; then ok=1; break; fi
    sleep 10
  done
  [ -n "$ok" ] || fail "apt-get update kept failing in $N. Check the network inside it."
  quiet apt-get -y -q -o DPkg::Lock::Timeout=300 install --no-install-recommends openssh-server \
    || fail "Could not install the SSH server (openssh-server) in $N."
fi
[ -s /etc/ssh/ssh_host_ed25519_key.pub ] || quiet ssh-keygen -A || fail "Could not create SSH host keys in $N."
kt= hk=
read -r kt hk _ < /etc/ssh/ssh_host_ed25519_key.pub || true
[ "$kt" = ssh-ed25519 ] && [ -n "$hk" ] || fail "$N has no Ed25519 SSH host key."

# Keys only, no root; ExposeAuthInfo lets a revoke find the sessions of a key.
install -d -m 0755 /etc/ssh/sshd_config.d
conf=/etc/ssh/sshd_config.d/10-mango.conf
want='# Written by Mango for shared access: keys only, no root login.
Port 22
Port 22022
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
ExposeAuthInfo yes'
changed=
if [ "$(cat "$conf" 2>/dev/null || true)" != "$want" ]; then
  printf '%s\n' "$want" > "$conf"
  chmod 0644 "$conf"
  changed=1
fi
install -d -m 0755 /run/sshd
if ! t=$(/usr/sbin/sshd -T 2>&1); then
  printf '%s\n' "$t" | tail -n 5 >&2
  fail "The SSH server's settings in $N do not check out (sshd -T)."
fi
if ! grep -qx 'passwordauthentication no' <<< "$t" || ! grep -qx 'port 22022' <<< "$t"; then
  fail "The SSH server in $N ignores /etc/ssh/sshd_config.d/10-mango.conf: put 'Include /etc/ssh/sshd_config.d/*.conf' at the top of /etc/ssh/sshd_config (and nothing that allows passwords before it)."
fi
if systemctl is-enabled --quiet ssh.socket 2>/dev/null || systemctl is-active --quiet ssh.socket 2>/dev/null; then
  # Socket activation (Ubuntu 24.04+): the ports live in ssh.socket, made from the config at daemon-reload.
  if [ -n "$changed" ]; then
    systemctl daemon-reload
    systemctl stop ssh.service >/dev/null 2>&1 || true
    systemctl restart ssh.socket
  fi
  systemctl start ssh.socket
else
  systemctl enable ssh.service >/dev/null 2>&1 || true
  if [ -n "$changed" ]; then systemctl restart ssh.service; else systemctl start ssh.service; fi
fi
up=
for _ in $(seq 40); do
  if (exec 5<>/dev/tcp/127.0.0.1/22) 2>/dev/null && (exec 5<>/dev/tcp/127.0.0.1/22022) 2>/dev/null; then up=1; break; fi
  sleep 0.5
done
if [ -z "$up" ]; then
  systemctl --no-pager status ssh.service 2>&1 | tail -n 8 >&2 || true
  fail "The SSH server in $N did not start."
fi

if [ "$VIA" = tailscale ]; then
  command -v tailscale >/dev/null 2>&1 || fail "Install Tailscale on $N and sign it in first."
  ip=$(tailscale ip -4 2>/dev/null | head -n 1 || true)
  [ -n "$ip" ] || fail "Install Tailscale on $N and sign it in first (it is installed but not on a tailnet)."
  EP="$ip:22022"
fi
[ -n "$EP" ] || fail "No address to share $N at."

opts=
if [ "$E" != 0 ]; then
  v=$(dpkg-query -W -f='${Version}' openssh-server 2>/dev/null || true)
  [ -n "$v" ] || v=$(ssh -V 2>&1 | sed -n 's/^OpenSSH_\([0-9.]*\).*/\1/p')
  v=${v#*:}
  maj=0 min=0
  if [[ $v =~ ^([0-9]+)\.([0-9]+) ]]; then maj=${BASH_REMATCH[1]} min=${BASH_REMATCH[2]}; fi
  if [ "$maj" -gt 9 ] || { [ "$maj" -eq 9 ] && [ "$min" -ge 1 ]; }; then
    opts="expiry-time=\"$EXPZ\" "
  elif [ "$maj" -gt 7 ] || { [ "$maj" -eq 7 ] && [ "$min" -ge 7 ]; }; then
    # Before OpenSSH 9.1 the time is read in the system time zone, with no Z.
    opts="expiry-time=\"$(unset TZ; date -d "@$E" +%Y%m%d%H%M)\" "
  else
    fail "The SSH server in $N (OpenSSH ${v:-of unknown version}) is too old for access that ends. Share without an end date, or update the environment."
  fi
fi

grp=$(id -gn agent)
install -d -o agent -g "$grp" -m 0700 /home/agent/.ssh
f=/home/agent/.ssh/authorized_keys
touch "$f"
if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\n' >> "$f"; fi
printf '%s%s endpoint=%s %s\n' "$opts" "$PRE" "$EP" "$POST" >> "$f"
chown agent:"$grp" "$f"
chmod 0600 "$f"
echo "mango-endpoint $EP" >&3
echo "mango-hostkey $hk" >&3
"##;

/// Master side of a new share (POSIX sh). Args: T N VIA EPH START R PRE POST E EXPZ SCRIPT.
/// For `public` it makes (or reuses) the `mango-ssh` proxy device first, so the instance
/// script knows the endpoint; a device it made is removed again if the instance part fails.
const MASTER_CREATE: &str = r##"set -eu
fail() { printf 'mango-error: %s\n' "$*" >&2; exit 1; }
T=$1 N=$2 VIA=$3 EPH=$4 START=$5 R=$6 PRE=$7 POST=$8 E=$9 EXPZ=${10} SCRIPT=${11}
incus exec "$T" -T -- true
EP= ADDED= PORT=
if [ "$VIA" = public ]; then
  if incus config device list "$T" | grep -qx mango-ssh; then
    PORT=$(incus config device get "$T" mango-ssh listen)
    PORT=${PORT##*:}
  else
    set --
    [ -z "$R" ] || set -- "$R"
    used=$( {
      [ -n "$R" ] || ss -ltnH 2>/dev/null | awk '{ print $4 }' || true
      { incus list "$@" --all-projects -f json 2>/dev/null || incus list "$@" -f json; } | grep -o '"listen":"[^"]*"' || true
    } | sed -n 's/.*:\([0-9][0-9]*\)"*$/\1/p')
    p=$START i=0
    while [ "$i" -lt 900 ]; do
      if ! printf '%s\n' "$used" | grep -qx "$p"; then PORT=$p; break; fi
      p=$((p + 1))
      [ "$p" -le 22999 ] || p=22100
      i=$((i + 1))
    done
    [ -n "$PORT" ] || fail "No port between 22100 and 22999 is free on the server. Revoke an old public share first."
    # Containers: forkproxy into the container's own 127.0.0.1:22. VMs only support NAT mode.
    case $(incus info "$T" | sed -n 's/^Type: *//p') in
      virtual-machine*) set -- nat=true connect=tcp:0.0.0.0:22 ;;
      *) set -- connect=tcp:127.0.0.1:22 ;;
    esac
    if ! err=$(incus config device add "$T" mango-ssh proxy "listen=tcp:0.0.0.0:$PORT" "$@" 2>&1); then
      fail "Could not open port $PORT for $N (Incus proxy device): $err"
    fi
    ADDED=1
  fi
  case $PORT in
    ''|*[!0-9]*) fail "The mango-ssh device on $N has no port Mango can use. Remove it (incus config device remove $T mango-ssh) and share again." ;;
  esac
  EP="$EPH:$PORT"
fi
if ! incus exec "$T" -T -- bash -c "$SCRIPT" mango-share "$N" "$VIA" "$EP" "$PRE" "$POST" "$E" "$EXPZ"; then
  [ -z "$ADDED" ] || incus config device remove "$T" mango-ssh >/dev/null 2>&1 || true
  exit 1
fi
if [ "$VIA" = public ] && [ -z "$R" ] && command -v ufw >/dev/null 2>&1; then
  st=$(ufw status 2>/dev/null || sudo -n ufw status 2>/dev/null || true)
  case $st in "Status: active"*) echo "mango-ufw active" ;; esac
fi
"##;

/// Lists the share lines (master side, POSIX sh). Args: T.
const MASTER_LIST: &str = r##"set -eu
incus exec "$1" -T -- sh -c 'grep -sF " mango-share " /home/agent/.ssh/authorized_keys || true'
"##;

/// Instance side of a revoke (bash, as root). Args: ID. Removes the share's line(s) with an
/// atomic rewrite, ends the sessions that signed in with that key (found through the
/// `SSH_USER_AUTH` file sshd writes with `ExposeAuthInfo`), and prints `mango-removed N`,
/// `mango-ended N` and `mango-public N` (public shares left).
const INSTANCE_REVOKE: &str = r##"set -euo pipefail
exec 3>&1 1>&2
ID=$1
f=/home/agent/.ssh/authorized_keys
if [ ! -f "$f" ]; then
  printf 'mango-removed 0\nmango-ended 0\nmango-public 0\n' >&3
  exit 0
fi
mine='{ s = 0; m = 0; for (i = 1; i <= NF; i++) { if ($i == "mango-share") s = 1; else if (s && $i == id) m = 1 } }'
blobs=$(awk -v id="id=$ID" "$mine"' m { for (i = 1; i < NF; i++) if ($i == "ssh-ed25519") { print $(i + 1); break } }' "$f")
removed=0
if [ -n "$blobs" ]; then
  removed=$(printf '%s\n' "$blobs" | wc -l)
  tmp=$(mktemp "$f.mango.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  awk -v id="id=$ID" "$mine"' !m' "$f" > "$tmp"
  chown --reference="$f" "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$f"
fi
ended=0 seen=' '
if [ -n "$blobs" ]; then
  for env in /proc/[0-9]*/environ; do
    pid=${env#/proc/}
    pid=${pid%/environ}
    a=$(tr '\0' '\n' < "$env" 2>/dev/null | sed -n 's/^SSH_USER_AUTH=//p' | head -n 1 || true)
    [ -n "$a" ] && [ -f "$a" ] || continue
    hit=
    while IFS= read -r b; do
      if [ -n "$b" ] && grep -qF "ssh-ed25519 $b" "$a"; then hit=1; fi
    done <<< "$blobs"
    [ -n "$hit" ] || continue
    pp=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [ -n "$pp" ] || continue
    case $seen in *" $pp "*) continue ;; esac
    # The session's own sshd process (running as the agent user): ending it closes that connection only.
    case $(ps -o comm= -p "$pp" 2>/dev/null || true) in
      sshd|sshd-session)
        if kill -TERM "$pp" 2>/dev/null; then ended=$((ended + 1)); seen="$seen$pp "; fi ;;
    esac
  done
fi
public=$(awk '{ s = 0; for (i = 1; i <= NF; i++) { if ($i == "mango-share") s = 1; else if (s && $i == "via=public") { c++; break } } } END { print c + 0 }' "$f")
printf 'mango-removed %s\nmango-ended %s\nmango-public %s\n' "$removed" "$ended" "$public" >&3
"##;

/// Master side of a revoke (POSIX sh). Args: T ID SCRIPT. Drops the `mango-ssh` proxy
/// device once no public share is left.
const MASTER_REVOKE: &str = r##"set -eu
T=$1 ID=$2 SCRIPT=$3
out=$(incus exec "$T" -T -- bash -c "$SCRIPT" mango-share-revoke "$ID")
printf '%s\n' "$out"
case "$out" in
  *"mango-public 0"*)
    if incus config device list "$T" | grep -qx mango-ssh; then
      incus config device remove "$T" mango-ssh >/dev/null
      echo "mango-port-closed"
    fi ;;
esac
"##;

fn master(script: &str, name: &str, args: Vec<String>) -> Vec<String> {
    let mut a = vec!["sh".to_string(), "-c".into(), script.to_string(), name.to_string()];
    a.extend(args);
    a
}

/// Everything a new share's script needs.
struct CreatePlan<'a> {
    instance: &'a str,
    via: &'a str,
    /// The endpoint host for `public` (bracketed IPv6), empty for `tailscale`.
    endpoint_host: String,
    /// `ssh-ed25519 AAAA… mango-share id=… … expires=…`
    pre: String,
    /// `label=…`
    post: String,
    expires_s: u64,
}

fn create_remote(host: &EnvHost, p: &CreatePlan) -> Vec<String> {
    let remote = ssh::remote_prefix(host).unwrap_or_default();
    master(
        MASTER_CREATE,
        "mango-share",
        vec![
            ssh::target(host, p.instance),
            p.instance.to_string(),
            p.via.to_string(),
            p.endpoint_host.clone(),
            preferred_port(p.instance).to_string(),
            remote,
            p.pre.clone(),
            p.post.clone(),
            p.expires_s.to_string(),
            if p.expires_s > 0 { expiry_timespec(p.expires_s) } else { String::new() },
            INSTANCE_CREATE.to_string(),
        ],
    )
}

/// What the create script printed.
#[derive(Debug, PartialEq)]
struct Created {
    host: String,
    port: u16,
    endpoint: String,
    host_key: String,
    ufw: bool,
}

fn parse_created(out: &str) -> Result<Created, String> {
    let field = |k: &str| out.lines().find_map(|l| l.trim().strip_prefix(k)).map(str::trim);
    let bad = || "The environment did not report where it can be reached. Try sharing again.".to_string();
    let endpoint = field("mango-endpoint ").ok_or_else(bad)?;
    let (host, port) = split_endpoint(endpoint).ok_or_else(bad)?;
    let host_key = field("mango-hostkey ").ok_or_else(bad)?.to_string();
    Ok(Created { host, port, endpoint: endpoint.to_string(), host_key, ufw: field("mango-ufw ").is_some() })
}

/// A readable message from a failed share script: its own `mango-error:` line when it
/// printed one, else what `incus exec` said.
fn script_error(instance: &str, e: String) -> String {
    match e.lines().rev().find_map(|l| l.trim().strip_prefix("mango-error: ")) {
        Some(m) => m.trim().to_string(),
        None => recipes::exec_error(instance, e),
    }
}

/// The note shown with a new link.
fn create_note(host: &EnvHost, instance: &str, via: &str, c: &Created) -> String {
    if via == "tailscale" {
        return format!(
            "The link works for people on your tailnet (or with {instance} shared to them in Tailscale) whose ACLs let them reach {} on port {TAILNET_PORT}.",
            c.host
        );
    }
    let mut n = format!(
        "People connect to {} port {}. If {} has a firewall (ufw, or a cloud provider's security group), allow TCP port {} there.",
        c.host, c.port, host.name, c.port
    );
    if c.ufw {
        n.push_str(&format!(" ufw is active on {}: run `sudo ufw allow {}/tcp` there.", host.name, c.port));
    }
    n
}

fn owner_host(app: &AppHandle, host_id: &str) -> Result<EnvHost, String> {
    let host = hosts::get(app, host_id)?;
    refuse_direct(&host)?;
    Ok(host)
}

/* ---------- commands ---------- */

#[tauri::command]
pub async fn env_shares(app: AppHandle, host_id: String, instance: String) -> Result<Vec<EnvShare>, String> {
    blocking(move || {
        valid_instance(&instance)?;
        let host = owner_host(&app, &host_id)?;
        let remote = master(MASTER_LIST, "mango-shares", vec![ssh::target(&host, &instance)]);
        let out = ssh::run(&host, &remote, Duration::from_secs(60)).map_err(|e| script_error(&instance, e))?;
        Ok(parse_shares(&out))
    })
    .await
}

#[tauri::command]
pub async fn env_share_create(
    app: AppHandle,
    host_id: String,
    instance: String,
    label: String,
    via: String,
    expires_in_days: Option<u32>,
) -> Result<EnvShareLink, String> {
    blocking(move || {
        valid_instance(&instance)?;
        let label = clean_label(&label)?;
        let via = clean_via(&via)?;
        let days = clean_days(expires_in_days)?;
        let host = owner_host(&app, &host_id)?;
        let endpoint_host = match via {
            "public" => {
                let ssh_g = if host.public_address.is_none() && host.incus_remote.is_none() {
                    resolve_with_ssh_g(&host)
                } else {
                    None
                };
                endpoint_host(&share_address(&host, ssh_g)?)
            }
            _ => String::new(),
        };

        let id = new_id()?;
        let created_ms = now_ms();
        let expires_s = days.map_or(0, |d| expiry_secs(created_ms / 1000, d));
        let expires_ms = (expires_s > 0).then_some(expires_s * 1000);
        let (comment, post) = comment_parts(&id, via, created_ms, expires_ms, &label);
        // The seed lives only in this function and the returned link.
        let seed = token::new_seed()?;
        let pre = token::public_line(&seed, &comment)?;
        let plan = CreatePlan { instance: &instance, via, endpoint_host, pre, post, expires_s };

        let out = ssh::run(&host, &create_remote(&host, &plan), Duration::from_secs(600))
            .map_err(|e| script_error(&instance, e))?;
        let c = parse_created(&out)?;
        let t = ShareToken {
            v: 1,
            id: id.clone(),
            n: instance.clone(),
            f: format!("{}/{}", host.name, instance),
            h: c.host.clone(),
            p: c.port,
            u: AGENT_USER.into(),
            k: token::encode_seed(&seed),
            hk: c.host_key.clone(),
            e: expires_s,
        };
        let url = token::encode(&t)?;
        // The person joining checks every field the same way: make sure they can.
        token::decode(&url).map_err(|_| {
            "The environment's reply could not be turned into a working link (its address or host key looks wrong). Revoke the new share and try again."
                .to_string()
        })?;
        Ok(EnvShareLink {
            share: EnvShare {
                id,
                label,
                via: via.into(),
                endpoint: c.endpoint.clone(),
                created_at: created_ms,
                expires_at: expires_ms,
            },
            url,
            note: Some(create_note(&host, &instance, via, &c)),
        })
    })
    .await
}

#[tauri::command]
pub async fn env_share_revoke(app: AppHandle, host_id: String, instance: String, share_id: String) -> Result<(), String> {
    blocking(move || {
        valid_instance(&instance)?;
        valid_share_id(&share_id)?;
        let host = owner_host(&app, &host_id)?;
        let remote = master(
            MASTER_REVOKE,
            "mango-share-revoke",
            vec![ssh::target(&host, &instance), share_id, INSTANCE_REVOKE.to_string()],
        );
        ssh::run(&host, &remote, Duration::from_secs(120)).map_err(|e| script_error(&instance, e))?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envs::EnvDirect;

    fn host() -> EnvHost {
        EnvHost {
            id: "h".into(),
            name: "forge".into(),
            ssh: "me@forge.example.com".into(),
            port: None,
            identity_file: None,
            incus_remote: None,
            tailscale: None,
            public_address: None,
            direct: None,
        }
    }

    #[test]
    fn refuses_joined_environments() {
        assert!(refuse_direct(&host()).is_ok());
        let mut h = host();
        h.direct = Some(EnvDirect {
            instance: "dev".into(),
            host_key: "AAAA".into(),
            shared_from: "forge/dev".into(),
            share_id: "x".into(),
            expires_at: None,
        });
        assert_eq!(refuse_direct(&h).unwrap_err(), "Only the environment's owner can share it.");
    }

    #[test]
    fn input_checks() {
        assert_eq!(clean_label("  Sam  ").unwrap(), "Sam");
        assert!(clean_label("   ").is_err());
        assert!(clean_label("a\nb").is_err());
        assert!(clean_label(&"é".repeat(60)).is_ok());
        assert!(clean_label(&"é".repeat(61)).is_err());
        assert_eq!(clean_via("public").unwrap(), "public");
        assert!(clean_via("ssh").is_err());
        assert!(clean_days(Some(0)).is_err());
        assert!(clean_days(Some(366)).is_err());
        assert_eq!(clean_days(Some(365)).unwrap(), Some(365));
        assert_eq!(clean_days(None).unwrap(), None);
        assert!(valid_share_id("k3j9-x2").is_ok());
        assert!(valid_share_id("a b").is_err() && valid_share_id("").is_err() && valid_share_id("x;y").is_err());
        let id = new_id().unwrap();
        assert_eq!(id.len(), 10);
        assert!(valid_share_id(&id).is_ok());
        assert_ne!(id, new_id().unwrap());
    }

    #[test]
    fn expiry_in_utc() {
        assert_eq!(expiry_timespec(0), "197001010000Z");
        assert_eq!(expiry_timespec(1_700_000_000), "202311142213Z");
        assert_eq!(expiry_timespec(951_782_400), "200002290000Z");
        assert_eq!(expiry_timespec(951_868_799), "200002292359Z");
        assert_eq!(expiry_timespec(4_102_444_800), "210001010000Z");
        // On a whole minute, `days` later.
        assert_eq!(expiry_secs(1_700_000_000, 1), 1_700_086_380);
        assert_eq!(expiry_secs(1_700_000_000, 1) % 60, 0);
    }

    #[test]
    fn key_line_round_trip() {
        let label = "Sam's laptop / Сэм 🍋";
        let (pre, post) = comment_parts("k3j9x2m4pq", "public", 1_700_000_000_123, Some(1_700_086_380_000), label);
        let key = token::public_line(&[5u8; 32], &pre).unwrap();
        assert!(!post.contains(' ') && post.is_ascii());
        // What the script writes: options, key and first fields, endpoint, label.
        let line = format!("expiry-time=\"202311152213Z\" {key} endpoint=203.0.113.24:22107 {post}");
        let s = parse_share(&line).unwrap();
        assert_eq!(
            s,
            EnvShare {
                id: "k3j9x2m4pq".into(),
                label: label.into(),
                via: "public".into(),
                endpoint: "203.0.113.24:22107".into(),
                created_at: 1_700_000_000_123,
                expires_at: Some(1_700_086_380_000),
            }
        );
        // No end, tailnet, no options.
        let (pre, post) = comment_parts("abc", "tailscale", 5, None, "x");
        let line = format!("{} endpoint=100.101.7.8:22022 {post}", token::public_line(&[6u8; 32], &pre).unwrap());
        let s = parse_share(&line).unwrap();
        assert_eq!((s.expires_at, s.via.as_str(), s.label.as_str()), (None, "tailscale", "x"));

        let out = format!(
            "ssh-ed25519 AAAAother me@laptop\n\n{line}\nssh-rsa AAAA mango-share id=bad;id via=public\nssh-ed25519 AAAA mango-share id=q via=carrier\n"
        );
        let all = parse_shares(&out);
        assert_eq!(all.len(), 1, "{all:?}");
        assert_eq!(all[0].id, "abc");
    }

    #[test]
    fn where_people_connect() {
        let g = "user me\nhostname 203.0.113.24\nport 22\n";
        assert_eq!(ssh_g_hostname(g).as_deref(), Some("203.0.113.24"));
        assert_eq!(ssh_g_hostname("port 22\n"), None);

        let h = host();
        assert_eq!(share_address(&h, Some("203.0.113.24".into())).unwrap(), "203.0.113.24");
        assert_eq!(share_address(&h, None).unwrap(), "forge.example.com");
        assert!(share_address(&h, Some("127.0.0.1".into())).unwrap_err().contains("public address"));
        assert!(share_address(&h, Some("localhost".into())).is_err());
        assert!(share_address(&h, Some("-oProxyCommand=x".into())).is_err());
        let mut p = h.clone();
        p.public_address = Some("shared.example.com".into());
        assert_eq!(share_address(&p, Some("10.0.0.2".into())).unwrap(), "shared.example.com");
        let mut r = h.clone();
        r.incus_remote = Some("os1".into());
        assert!(share_address(&r, None).unwrap_err().contains("os1"));
        r.public_address = Some("198.51.100.7".into());
        assert_eq!(share_address(&r, None).unwrap(), "198.51.100.7");

        assert_eq!(endpoint_host("2001:db8::7"), "[2001:db8::7]");
        assert_eq!(split_endpoint("[2001:db8::7]:22100"), Some(("2001:db8::7".into(), 22100)));
        assert_eq!(split_endpoint("100.101.7.8:22022"), Some(("100.101.7.8".into(), 22022)));
        assert_eq!(split_endpoint("host:0"), None);
        assert_eq!(split_endpoint("a b:22"), None);
        assert_eq!(split_endpoint("host"), None);
    }

    #[test]
    fn port_picking() {
        for name in ["dev", "a", "mango-1", &"z".repeat(63)] {
            let p = preferred_port(name);
            assert!((PORT_LO..=PORT_HI).contains(&p), "{name}: {p}");
            assert_eq!(p, preferred_port(name));
        }
        assert_ne!(preferred_port("dev"), preferred_port("dev2"));
    }

    #[test]
    fn create_reply() {
        let out = "noise\nmango-endpoint 203.0.113.24:22107\nmango-hostkey AAAAC3Nza\nmango-ufw active\n";
        let c = parse_created(out).unwrap();
        assert_eq!((c.host.as_str(), c.port, c.host_key.as_str(), c.ufw), ("203.0.113.24", 22107, "AAAAC3Nza", true));
        assert!(parse_created("mango-hostkey X\n").is_err());
        assert!(parse_created("mango-endpoint x:y\nmango-hostkey X\n").is_err());

        let e = "Get:1 http://archive...\nmango-error: Install Tailscale on dev and sign it in first.".to_string();
        assert_eq!(script_error("dev", e), "Install Tailscale on dev and sign it in first.");
        assert!(script_error("dev", "Error: Instance is not running".into()).contains("Start it"));
    }

    #[test]
    fn lines_are_quoted_and_fit_windows() {
        let mut h = host();
        h.incus_remote = Some("os1".into());
        let (pre, post) = comment_parts("k3j9x2m4pq", "public", 1, Some(2_000), "it's $(reboot)");
        let plan = CreatePlan {
            instance: "dev",
            via: "public",
            endpoint_host: "[2001:db8::7]".into(),
            pre: token::public_line(&[1u8; 32], &pre).unwrap(),
            post,
            expires_s: 1_700_086_380,
        };
        let remote = create_remote(&h, &plan);
        assert_eq!(&remote[..2], ["sh", "-c"]);
        assert_eq!(remote.len(), 4 + 11, "MASTER_CREATE reads 11 arguments");
        assert_eq!(&remote[3..7], ["mango-share", "os1:dev", "dev", "public"]);
        assert_eq!(remote[9], "os1:");
        assert_eq!(remote[13], "202311152213Z");
        let l = ssh::line(&remote);
        assert!(l.is_ascii(), "keep scripts ASCII: they cross Windows argv conversion");
        assert!(!l.contains("$(reboot)"), "the label only travels base64url-encoded");
        let windows = l.len() + l.matches(['"', '\\']).count() + 300;
        assert!(windows < 30_000, "{windows}");

        let r = master(MASTER_REVOKE, "mango-share-revoke", vec!["os1:dev".into(), "abc".into(), INSTANCE_REVOKE.into()]);
        assert!(ssh::line(&r).is_ascii());
    }

    fn check_syntax(shell: &std::path::Path, name: &str, script: &str) {
        use std::io::Write;
        // Through stdin: MSYS/Cygwin shells re-parse a Windows command line with their own quoting rules.
        let mut child = std::process::Command::new(shell)
            .arg("-n")
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("run shell");
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// `sh -n` / `bash -n` the scripts when the shells are around (not WSL's bash.exe launcher).
    #[test]
    fn scripts_parse() {
        let real = |p: &std::path::PathBuf| {
            let s = p.to_string_lossy().to_lowercase();
            !s.contains("system32") && !s.contains("windowsapps")
        };
        if let Some(sh) = ["dash", "sh"].iter().find_map(|s| crate::bin::find(s)).filter(real) {
            for (name, s) in [("master create", MASTER_CREATE), ("master list", MASTER_LIST), ("master revoke", MASTER_REVOKE)] {
                check_syntax(&sh, name, s);
            }
        } else {
            eprintln!("no sh found; skipping");
        }
        if let Some(bash) = crate::bin::find("bash").filter(real) {
            for (name, s) in [("instance create", INSTANCE_CREATE), ("instance revoke", INSTANCE_REVOKE)] {
                check_syntax(&bash, name, s);
            }
        } else {
            eprintln!("no bash found; skipping");
        }
    }
}
