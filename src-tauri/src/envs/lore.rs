//! A Lore server in an instance (the `lore-server` component, see `recipes`): how it is doing,
//! where to reach it, and publishing it outside the Incus server.
//!
//! Inside the server, other instances reach it over the Incus bridge: `lore://<instance>.<domain>`
//! when the instance's network is a managed bridge with DNS (`incus` unless `dns.domain` says
//! otherwise), and by its IPv4 address in any case. Outside, it is published by two Incus proxy
//! devices on the instance, both listening on an address and port of the Incus host the user picks:
//! `lore-quic` (UDP, the QUIC the CLI speaks) and `lore-grpc` (TCP, gRPC on the same port number),
//! each forwarded to the server's port 41337 inside (a VM's proxy works in NAT mode, as in `shares`).
//! An SSH tunnel can't carry QUIC, so this is the only way in from outside. Without its sign-in
//! (`lore_auth`) the server takes anyone: the address is the user's choice, and the interface warns
//! about public ones. With it, two more proxy devices publish TCP ports 80 and 443 at the same
//! address (`lore-http`, `lore-https`: Let's Encrypt and the sign-in pages, served by Caddy inside),
//! and clients use `lores://<domain>[:port]`. The sign-in runs in a terminal (`env_lore_auth`): the
//! GitHub secret and passwords are typed there, inside the instance.
//!
//! Each command is one `ssh master sh -c SCRIPT …` run that also reads the state back (`INFO`), so
//! a publish answers with the new URLs and the host firewall in the same call. Values reach the
//! scripts as positional arguments only, after `valid_listen_address` / `valid_publish_port`.
//! Firewalls are only looked at (ufw, firewalld, an nftables input chain that drops), never changed:
//! the page shows the rule to add. A joined environment (`EnvHost::direct`) has no master, so it can
//! show its server's state but not publish it.

use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::{blocking, hosts, incus, recipes, shares, ssh, valid_instance, valid_listen_address, valid_publish_port, EnvHost};
use crate::lore_auth::{self, LoreSignIn, LoreSignInState};
use tauri::State;

/// The port the Lore server listens on inside the instance (QUIC over UDP and gRPC over TCP).
pub const LORE_PORT: u16 = 41337;
/// The proxy devices that publish it.
const QUIC_DEVICE: &str = "lore-quic";
const GRPC_DEVICE: &str = "lore-grpc";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvLoreServer {
    /// The `lore-server` component is installed.
    pub installed: bool,
    pub version: Option<String>,
    pub running: bool,
    /// For the other instances on this server: `lore://<instance>.<domain>`, when its network has DNS.
    pub inside_url: Option<String>,
    /// The same by the instance's IPv4 address.
    pub inside_ip_url: Option<String>,
    /// Where it is published outside the server, when it is.
    pub published: Option<EnvLorePublished>,
    /// The host firewall that may stand in the way of a published port (looked at only while published).
    pub firewall: Option<EnvLoreFirewall>,
    /// Addresses of the Incus host it can be published at (none when the instances run on an Incus remote).
    pub addresses: Vec<EnvHostAddress>,
    /// Why it can't be published from here, when it can't (a joined environment).
    pub publish_note: Option<String>,
    /// Its sign-in, once it has been set up (on or off); none before.
    pub auth: Option<LoreSignInState>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvLorePublished {
    /// The listen address on the Incus host: an IP, or `0.0.0.0` / `[::]` for all of them.
    pub address: String,
    pub port: u16,
    /// What this computer (and anyone outside) uses: `lore://<host>[:port]`.
    pub url: Option<String>,
    /// Why there is no URL, or what to know about it.
    pub url_note: Option<String>,
    /// This computer could open a TCP connection to the published port just now (a hint: UDP
    /// can't be checked this way, and a firewall may treat them differently).
    pub reachable: Option<bool>,
    /// Both devices are there (UDP and TCP); `false` when one went missing.
    pub complete: bool,
    /// Ports 80 and 443 are published at the same address too (for the sign-in).
    pub web: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvLoreFirewall {
    /// "ufw" | "firewalld" | "nftables"
    pub kind: String,
    /// The commands that open the port (run on the server, with sudo), when Mango can say them exactly.
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvHostAddress {
    pub address: String,
    /// "tailscale" | "private" | "public"
    pub kind: String,
    pub interface: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvHostAddresses {
    pub addresses: Vec<EnvHostAddress>,
    /// Why there are none to offer (an Incus remote, a joined environment).
    pub note: Option<String>,
}

/// Publish the Lore server of a new instance (`EnvCreateInput::lore_publish`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvLorePublishInput {
    pub address: String,
    pub port: u16,
}

/* ---------- scripts ---------- */

/// Master-side functions (POSIX sh) over `$T` (the instance target), `$LR` (`remote:` or empty),
/// `$LA` (listen address, validated) and `$LP` (port, validated). The caller defines `fail`.
/// Shared by the commands here and `incus::create_remote`.
pub(crate) const MASTER_LORE: &str = r##"lore_port_check() {
  own=$(incus config device get "$T" lore-quic listen 2>/dev/null || true)
  [ "${own##*:}" != "$LP" ] || return 0
  set --
  [ -z "$LR" ] || set -- "$LR"
  used=$( {
    [ -n "$LR" ] || { ss -lunH 2>/dev/null; ss -ltnH 2>/dev/null; } | awk '{ print $4 }' || true
    { incus list "$@" --all-projects -f json 2>/dev/null || incus list "$@" -f json 2>/dev/null; } | grep -o '"listen":"[^"]*"' || true
  } | sed -n 's/.*:\([0-9][0-9]*\)"*$/\1/p')
  if printf '%s\n' "$used" | grep -qx "$LP"; then
    fail "port $LP is already in use on the server (by another program, or another environment's published port). Pick another port."
  fi
}
lore_unpublish() {
  for d in lore-quic lore-grpc lore-http lore-https; do
    if incus config device list "$T" 2>/dev/null | grep -qx "$d"; then
      incus config device remove "$T" "$d" >/dev/null || fail "could not remove the $d device from $T."
    fi
  done
}
lore_vm() {
  case $(incus info "$T" | sed -n 's/^Type: *//p') in
    virtual-machine*) return 0 ;;
  esac
  return 1
}
# Ports 80 and 443 at $LA for the sign-in (Caddy inside: Let's Encrypt and Dex's pages).
lore_web_unpublish() {
  for d in lore-http lore-https; do
    if incus config device list "$T" 2>/dev/null | grep -qx "$d"; then
      incus config device remove "$T" "$d" >/dev/null || fail "could not remove the $d device from $T."
    fi
  done
}
lore_web_publish() {
  if [ -z "$(incus config device get "$T" lore-https listen 2>/dev/null || true)" ]; then
    set --
    [ -z "$LR" ] || set -- "$LR"
    used=$( {
      [ -n "$LR" ] || ss -ltnH 2>/dev/null | awk '{ print $4 }' || true
      { incus list "$@" --all-projects -f json 2>/dev/null || incus list "$@" -f json 2>/dev/null; } | grep -o '"listen":"tcp:[^"]*"' || true
    } | sed -n 's/.*:\([0-9][0-9]*\)"*$/\1/p')
    for p in 80 443; do
      if printf '%s\n' "$used" | grep -qx "$p"; then
        fail "port $p is already in use on the server (a web server, or another environment). The sign-in needs ports 80 and 443 for Let's Encrypt and its pages."
      fi
    done
  fi
  lore_web_unpublish
  for p in 80 443; do
    d=lore-http
    [ "$p" = 80 ] || d=lore-https
    if lore_vm; then set -- nat=true "connect=tcp:0.0.0.0:$p"; else set -- "connect=tcp:127.0.0.1:$p"; fi
    if ! err=$(incus config device add "$T" "$d" proxy "listen=tcp:$LA:$p" "$@" 2>&1); then
      lore_web_unpublish
      fail "could not publish port $p for $T (Incus proxy device): $err"
    fi
  done
}
# The sign-in is on inside the instance.
lore_signin_on() { incus exec "$T" -T -- test -s /etc/lore-auth/lore.toml 2>/dev/null; }
lore_publish() {
  lore_port_check
  lore_unpublish
  case $(incus info "$T" | sed -n 's/^Type: *//p') in
    virtual-machine*) nat=1 ;;
    *) nat= ;;
  esac
  for p in udp tcp; do
    d=lore-quic
    [ "$p" = udp ] || d=lore-grpc
    # Containers: forkproxy into the container's own 127.0.0.1. VMs only support NAT mode.
    if [ -n "$nat" ]; then set -- nat=true "connect=$p:0.0.0.0:41337"; else set -- "connect=$p:127.0.0.1:41337"; fi
    if ! err=$(incus config device add "$T" "$d" proxy "listen=$p:$LA:$LP" "$@" 2>&1); then
      lore_unpublish
      fail "could not publish $p port $LP for $T (Incus proxy device): $err"
    fi
  done
  # With the sign-in on, its ports move along.
  if lore_signin_on; then lore_web_publish; fi
}
lore_firewall() {
  [ -z "$LR" ] || return 0
  if command -v ufw >/dev/null 2>&1; then
    case $(ufw status 2>/dev/null || sudo -n ufw status 2>/dev/null || true) in
      "Status: active"*) echo ufw; return 0 ;;
    esac
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && { firewall-cmd --state >/dev/null 2>&1 || systemctl is-active --quiet firewalld 2>/dev/null; }; then
    echo firewalld
    return 0
  fi
  if command -v nft >/dev/null 2>&1; then
    rs=$(nft list ruleset 2>/dev/null || sudo -n nft list ruleset 2>/dev/null || true)
    if printf '%s\n' "$rs" | grep -q 'hook input .*policy drop'; then echo nftables; fi
  fi
  return 0
}
lore_firewall_say() {
  case $(lore_firewall) in
    ufw) echo "ufw is active on this server: open the port with  sudo ufw allow $LP/udp && sudo ufw allow $LP/tcp" ;;
    firewalld) echo "firewalld is running on this server: open the port with  sudo firewall-cmd --permanent --add-port=$LP/udp --add-port=$LP/tcp && sudo firewall-cmd --reload" ;;
    nftables) echo "An nftables input chain on this server drops what it doesn't allow: accept udp dport $LP and tcp dport $LP in it." ;;
  esac
  echo "A cloud provider's firewall or security group (which Mango can't see) has to allow UDP and TCP port $LP too."
}
"##;

/// What the commands here read back (master side, after `MASTER_LORE`): the instance and its
/// network as Incus describes them, the server's state from inside, the host's addresses and its
/// firewall, in `@@` sections. Args: T N LR INNER (+ LA LP for a publish).
const INFO: &str = r##"lore_info() {
  inst=$(incus query "$LR/1.0/instances/$N" 2>/dev/null || true)
  echo "@@instance"
  printf '%s\n' "$inst"
  net=$(printf '%s\n' "$inst" | grep -o '"network": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
  case $net in ''|*[!A-Za-z0-9_.-]*) net= ;; esac
  echo "@@network"
  [ -z "$net" ] || incus query "$LR/1.0/networks/$net" 2>/dev/null || true
  echo "@@inside"
  incus exec "$T" -T -- sh -c "$INNER" 2>/dev/null || true
  echo "@@host"
  [ -n "$LR" ] || ip -o addr show scope global 2>/dev/null || true
  echo "@@firewall"
  if printf '%s\n' "$inst" | grep -q '"listen": *"udp:'; then lore_firewall; fi
}
"##;

/// Inside the instance (sh, as root): the server's version, whether it runs, the instance's addresses.
/// The sign-in's lines are what `auth_main status` prints (`lore_auth::parse_status` reads them).
const INNER: &str = r##"v=
[ -x /usr/local/bin/loreserver ] && [ -f /etc/systemd/system/lore.service ] && v=$(/usr/local/bin/loreserver --version 2>/dev/null | head -n 1)
printf 'version %s\n' "$v"
printf 'active %s\n' "$(systemctl is-active lore.service 2>/dev/null | head -n 1)"
printf 'ips %s\n' "$(hostname -I 2>/dev/null)"
a=/etc/lore-auth
if [ -f $a/settings ]; then
  if [ -s $a/lore.toml ]; then echo 'authOn yes'; else echo 'authOn no'; fi
  sed -n 's/^DOMAIN=/authDomain /p; s/^PASSWORDS=/authPasswords /p; s/^GH_ID=/authGithubId /p; s/^GH_ORGS=/authGithubOrgs /p' $a/settings
  [ ! -s $a/github-secret ] || echo 'authGithubSecret yes'
  d=$(sed -n 's/^DOMAIN=//p' $a/settings | head -n 1)
  ! ls /var/lib/lore-auth/caddy/certificates/*/"$d"/"$d".crt >/dev/null 2>&1 || echo 'authCert yes'
  cut -f1 $a/users 2>/dev/null | sed 's/^/authUser /'
fi
exit 0
"##;

/// `set -eu` and a `fail` whose message the backend picks out (`script_error`), for captured runs.
const CAPTURED: &str = "set -eu\nfail() { printf 'mango-error: %s\\n' \"$*\" >&2; exit 1; }\n";

/// What a command does before reading the state back.
#[derive(Debug, Clone, PartialEq)]
enum Step {
    Read,
    /// Listen address (as `valid_listen_address` returns it) and port.
    Publish(String, u16),
    Unpublish,
}

/// The remote argv for one command on `instance`.
fn remote(host: &EnvHost, instance: &str, step: &Step) -> Vec<String> {
    let action = match step {
        Step::Read => "",
        Step::Publish(..) => "incus info \"$T\" >/dev/null 2>&1 || fail \"$N no longer exists on this server.\"\nlore_publish\n",
        Step::Unpublish => "lore_unpublish\n",
    };
    let script = format!("{CAPTURED}{MASTER_LORE}{INFO}T=$1 N=$2 LR=$3 INNER=$4 LA=$5 LP=$6\n{action}lore_info\n");
    let (la, lp) = match step {
        Step::Publish(a, p) => (a.clone(), p.to_string()),
        _ => (String::new(), String::new()),
    };
    vec![
        "sh".into(),
        "-c".into(),
        script,
        "mango-lore".into(),
        ssh::target(host, instance),
        instance.to_string(),
        ssh::remote_prefix(host).unwrap_or_default(),
        INNER.to_string(),
        la,
        lp,
    ]
}

/* ---------- reading the answer ---------- */

/// The `@@name` sections of the info output.
fn sections(out: &str) -> std::collections::HashMap<&str, String> {
    let mut map = std::collections::HashMap::new();
    let mut cur: Option<&str> = None;
    for line in out.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            cur = Some(name.trim());
            map.entry(name.trim()).or_insert_with(String::new);
        } else if let Some(c) = cur {
            let s = map.get_mut(c).expect("section");
            s.push_str(line);
            s.push('\n');
        }
    }
    map
}

/// `udp:100.101.7.1:41337` / `tcp:[::]:4000` into (address, port).
pub(crate) fn split_listen(listen: &str) -> Option<(String, u16)> {
    let rest = listen.split_once(':')?.1;
    let (a, p) = rest.rsplit_once(':')?;
    let port: u16 = p.parse().ok()?;
    (!a.is_empty()).then(|| (a.to_string(), port))
}

/// The listen address of a proxy device on the instance itself (not from a profile).
fn device_listen(inst: &Value, name: &str) -> Option<String> {
    let d = inst.get("devices")?.get(name)?;
    (d.get("type")?.as_str()? == "proxy").then_some(())?;
    d.get("listen")?.as_str().map(String::from)
}

/// The DNS domain instances on `network` share, when it is a managed bridge that serves names.
fn dns_domain(network: &Value) -> Option<String> {
    if network.get("type")?.as_str()? != "bridge" || network.get("managed").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let cfg = network.get("config");
    let get = |k: &str| cfg.and_then(|c| c.get(k)).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    if get("dns.mode") == Some("none") {
        return None;
    }
    let d = get("dns.domain").unwrap_or("incus");
    d.chars().all(|c| c.is_ascii_alphanumeric() || ".-".contains(c)).then(|| d.to_string())
}

/// `lore://host[:port]`: IPv6 in brackets, the port left out when it is Lore's own.
pub(crate) fn lore_url(host: &str, port: u16) -> String {
    let h = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    if port == LORE_PORT { format!("lore://{h}") } else { format!("lore://{h}:{port}") }
}

/// What kind of address an IP is, for offering it.
fn address_kind(ip: &IpAddr, interface: &str) -> &'static str {
    match ip {
        IpAddr::V4(v4) => {
            if interface.starts_with("tailscale") || incus::is_tailnet(&v4.to_string()) {
                "tailscale"
            } else if v4.is_private() || v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]) {
                "private"
            } else {
                "public"
            }
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            if interface.starts_with("tailscale") || (s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0) {
                "tailscale"
            } else if s[0] & 0xfe00 == 0xfc00 {
                "private"
            } else {
                "public"
            }
        }
    }
}

/// Interfaces whose addresses are not a way in from outside: bridges and veths of Incus, LXD,
/// Docker and libvirt, plus the instance's own network.
fn internal_interface(name: &str, network: Option<&str>) -> bool {
    Some(name) == network
        || ["incusbr", "lxdbr", "docker", "br-", "veth", "virbr", "cni", "flannel", "cali", "lo"].iter().any(|p| name.starts_with(p))
}

/// `ip -o addr show scope global` as addresses to offer: Tailscale first, then private, then public.
pub(crate) fn parse_host_addresses(out: &str, network: Option<&str>) -> Vec<EnvHostAddress> {
    let mut v: Vec<EnvHostAddress> = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 || !matches!(f[2], "inet" | "inet6") || line.contains(" temporary") || line.contains(" deprecated") {
            continue;
        }
        let interface = f[1].trim_end_matches(':').split('@').next().unwrap_or_default();
        if internal_interface(interface, network) {
            continue;
        }
        let Ok(ip) = f[3].split('/').next().unwrap_or_default().parse::<IpAddr>() else { continue };
        if ip.is_loopback() || valid_listen_address(&ip.to_string()).is_err() {
            continue;
        }
        let address = ip.to_string();
        if v.iter().any(|a| a.address == address) {
            continue;
        }
        v.push(EnvHostAddress { kind: address_kind(&ip, interface).into(), address, interface: interface.into() });
    }
    let rank = |a: &EnvHostAddress| (["tailscale", "private", "public"].iter().position(|k| *k == a.kind), a.address.contains(':'));
    v.sort_by_key(rank);
    v
}

/// The commands that open `port` in a host firewall, when they are certain.
pub(crate) fn firewall_rules(kind: &str, port: u16) -> Vec<String> {
    match kind {
        "ufw" => vec![format!("sudo ufw allow {port}/udp && sudo ufw allow {port}/tcp")],
        "firewalld" => vec![format!(
            "sudo firewall-cmd --permanent --add-port={port}/udp --add-port={port}/tcp && sudo firewall-cmd --reload"
        )],
        // Table and chain names differ per setup: the page says what to accept instead.
        _ => vec![],
    }
}

/// Where outside clients point: the host name the user reaches the server by, when it names the
/// published address (or all of them); otherwise the address itself. `names` are the server's
/// public address and its SSH host (as `ssh -G` resolves it), in that order; `resolve` looks a name up.
fn outside_host(
    host: &EnvHost,
    listen: &str,
    names: &[String],
    addresses: &[EnvHostAddress],
    resolve: &dyn Fn(&str) -> Vec<IpAddr>,
) -> Result<String, String> {
    let bare = listen.trim_start_matches('[').trim_end_matches(']');
    let usable: Vec<&String> =
        names.iter().filter(|n| shares::plain_address(n) && !shares::is_loopback(n)).collect();
    let Ok(ip) = bare.parse::<IpAddr>() else { return Err(format!("\"{listen}\" is not an address.")) };
    if ip.is_unspecified() {
        if let Some(n) = usable.first() {
            return Ok(n.to_string());
        }
        if let Some(a) = addresses.iter().find(|a| a.kind == "public").or(addresses.first()) {
            return Ok(a.address.clone());
        }
        return Err(format!(
            "It listens on every address of {}'s Incus host, and Mango doesn't know which one you reach it at. Set the server's public address in its settings.",
            host.name
        ));
    }
    for n in usable {
        if n.parse::<IpAddr>().ok() == Some(ip) || (n.parse::<IpAddr>().is_err() && resolve(n).contains(&ip)) {
            return Ok(n.to_string());
        }
    }
    Ok(ip.to_string())
}

/// Look a host name up on this computer.
fn resolve_here(name: &str) -> Vec<IpAddr> {
    (name, 0).to_socket_addrs().map(|a| a.map(|s| s.ip()).collect()).unwrap_or_default()
}

/// Whether this computer can open a TCP connection to `host:port` (the gRPC side of the published port).
fn reachable_here(host: &str, port: u16) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<SocketAddr> = match bare.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => (bare, port).to_socket_addrs().map(Iterator::collect).unwrap_or_default(),
    };
    addrs.iter().take(3).any(|a| TcpStream::connect_timeout(a, Duration::from_secs(3)).is_ok())
}

/// Everything but the network checks done on this computer (`outside_host`'s name lookups and
/// the reachability), which `env_lore_server` adds.
pub(crate) fn parse_info(instance: &str, out: &str) -> EnvLoreServer {
    let s = sections(out);
    let json = |k: &str| s.get(k).and_then(|t| serde_json::from_str::<Value>(t.trim()).ok());
    let inst = json("instance");
    // `incus query` answers with the object itself; tolerate the API's envelope too.
    let inst = inst.map(|v| v.get("metadata").cloned().filter(Value::is_object).unwrap_or(v));
    let network = json("network").map(|v| v.get("metadata").cloned().filter(Value::is_object).unwrap_or(v));
    let inside: std::collections::HashMap<&str, &str> = s
        .get("inside")
        .map(|t| t.lines().filter_map(|l| l.split_once(' ')).map(|(k, v)| (k, v.trim())).collect())
        .unwrap_or_default();
    let version = inside.get("version").filter(|v| !v.is_empty()).map(|v| {
        v.split_whitespace().find(|t| t.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(v).split('+').next().unwrap_or(v).to_string()
    });
    let installed = version.is_some();
    let running = installed && inside.get("active") == Some(&"active");
    let ipv4 = inside
        .get("ips")
        .and_then(|ips| ips.split_whitespace().find(|ip| ip.contains('.') && !ip.starts_with("127.") && !incus::is_tailnet(ip)))
        .map(String::from);
    let net_name = network.as_ref().and_then(|n| n.get("name")).and_then(Value::as_str);
    let inside_url = network.as_ref().and_then(dns_domain).map(|d| lore_url(&format!("{instance}.{d}"), LORE_PORT));

    let quic = inst.as_ref().and_then(|i| device_listen(i, QUIC_DEVICE));
    let grpc = inst.as_ref().and_then(|i| device_listen(i, GRPC_DEVICE));
    let web = inst.as_ref().is_some_and(|i| device_listen(i, "lore-http").is_some() && device_listen(i, "lore-https").is_some());
    let published = quic.as_deref().or(grpc.as_deref()).and_then(split_listen).map(|(address, port)| EnvLorePublished {
        address,
        port,
        url: None,
        url_note: None,
        reachable: None,
        complete: quic.is_some() && grpc.is_some(),
        web,
    });
    let auth = s.get("inside").map(|t| lore_auth::parse_status(t)).filter(|a| a.domain.is_some());
    let firewall = s
        .get("firewall")
        .and_then(|t| t.lines().map(str::trim).find(|l| matches!(*l, "ufw" | "firewalld" | "nftables")))
        .zip(published.as_ref())
        .map(|(kind, p)| EnvLoreFirewall { kind: kind.into(), commands: firewall_rules(kind, p.port) });
    EnvLoreServer {
        installed,
        version,
        running,
        inside_url,
        inside_ip_url: ipv4.map(|ip| lore_url(&ip, LORE_PORT)),
        published,
        firewall,
        addresses: s.get("host").map(|t| parse_host_addresses(t, net_name)).unwrap_or_default(),
        publish_note: None,
        auth,
    }
}

/// A readable message from a failed script: its own `mango-error:` line when it printed one.
fn script_error(instance: &str, e: String) -> String {
    match e.lines().rev().find_map(|l| l.trim().strip_prefix("mango-error: ")) {
        Some(m) => {
            let m = m.trim();
            let mut c = m.chars();
            c.next().map_or_else(String::new, |f| f.to_uppercase().collect::<String>() + c.as_str())
        }
        None => recipes::exec_error(instance, e),
    }
}

/// The names the user reaches the server by: its public address, then its SSH host.
fn server_names(host: &EnvHost) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(a) = host.public_address.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        names.push(a.to_string());
    }
    if host.incus_remote.as_deref().is_none_or(str::is_empty) {
        names.push(shares::resolve_with_ssh_g(host).unwrap_or_else(|| shares::host_part(&host.ssh).to_string()));
    }
    names
}

/// Run one command and finish the answer with what only this computer can tell.
fn run(host: &EnvHost, instance: &str, step: &Step) -> Result<EnvLoreServer, String> {
    if host.direct.is_some() {
        let inner = ["sh".to_string(), "-c".into(), INNER.into()];
        let r = ssh::in_instance(host, instance, ssh::Mode::Batch, &inner)?;
        let out = ssh::run(host, &r, Duration::from_secs(30)).map_err(|e| recipes::exec_error(instance, e))?;
        let mut info = parse_info(instance, &format!("@@inside\n{out}"));
        info.publish_note = Some("This environment was shared with you: only its owner can publish its Lore server.".into());
        return Ok(info);
    }
    let timeout = Duration::from_secs(if matches!(step, Step::Read) { 45 } else { 90 });
    let out = ssh::run(host, &remote(host, instance, step), timeout).map_err(|e| script_error(instance, e))?;
    let mut info = parse_info(instance, &out);
    let signed_in = info.auth.as_ref().filter(|a| a.on).and_then(|a| a.domain.clone());
    if let Some(p) = info.published.as_mut() {
        let names = server_names(host);
        match (&signed_in, outside_host(host, &p.address, &names, &info.addresses, &resolve_here)) {
            // With the sign-in on, clients use the domain (its certificate's name) over lores://.
            (Some(d), _) => {
                p.reachable = Some(reachable_here(d, p.port));
                p.url = Some(lore_auth::secure_url(d, p.port));
            }
            (None, Ok(h)) => {
                p.reachable = Some(reachable_here(&h, p.port));
                p.url = Some(lore_url(&h, p.port));
            }
            (None, Err(e)) => p.url_note = Some(e),
        }
        if p.url.is_some() && host.incus_remote.as_deref().is_some_and(|r| !r.is_empty()) && host.public_address.is_none() {
            p.url_note = Some(format!(
                "{}'s environments run on an Incus remote, so the port is open on that host, at the address shown.",
                host.name
            ));
        }
    }
    Ok(info)
}

/* ---------- commands ---------- */

/// The Lore server in `instance`: whether it runs, the URLs to use from inside and outside the
/// server, and where it can be published. One SSH call (plus, when published, a TCP connection
/// attempt from this computer to the published port).
#[tauri::command]
pub async fn env_lore_server(app: AppHandle, host_id: String, instance: String) -> Result<EnvLoreServer, String> {
    blocking(move || {
        valid_instance(&instance)?;
        let host = hosts::get(&app, &host_id)?;
        run(&host, &instance, &Step::Read)
    })
    .await
}

/// Publish the Lore server outside the Incus server at `address:port` (UDP and TCP), replacing an
/// earlier publish; answers with the new state, firewall included.
#[tauri::command]
pub async fn env_lore_publish(app: AppHandle, host_id: String, instance: String, address: String, port: u16) -> Result<EnvLoreServer, String> {
    blocking(move || {
        valid_instance(&instance)?;
        let listen = valid_listen_address(&address)?;
        valid_publish_port(port)?;
        let host = hosts::get(&app, &host_id)?;
        super::owner_only(&host, "publish this environment's Lore server")?;
        run(&host, &instance, &Step::Publish(listen, port))
    })
    .await
}

/// Stop publishing it (remove both proxy devices); answers with the new state.
#[tauri::command]
pub async fn env_lore_unpublish(app: AppHandle, host_id: String, instance: String) -> Result<EnvLoreServer, String> {
    blocking(move || {
        valid_instance(&instance)?;
        let host = hosts::get(&app, &host_id)?;
        super::owner_only(&host, "change this environment's Lore server")?;
        run(&host, &instance, &Step::Unpublish)
    })
    .await
}

/// The addresses of a server's Incus host something can be published at (before an instance exists).
#[tauri::command]
pub async fn env_host_addresses(app: AppHandle, host_id: String) -> Result<EnvHostAddresses, String> {
    blocking(move || {
        let host = hosts::get(&app, &host_id)?;
        super::owner_only(&host, "publish ports on this server")?;
        if let Some(r) = host.incus_remote.as_deref().filter(|r| !r.is_empty()) {
            return Ok(EnvHostAddresses {
                addresses: vec![],
                note: Some(format!("{}'s environments run on the Incus remote {r}: type an address of that host.", host.name)),
            });
        }
        let remote = ["sh".to_string(), "-c".into(), "ip -o addr show scope global 2>/dev/null || true".into()];
        let out = ssh::run(&host, &remote, Duration::from_secs(30))?;
        Ok(EnvHostAddresses { addresses: parse_host_addresses(&out, None), note: None })
    })
    .await
}

/* ---------- sign-in ---------- */

/// Master side (POSIX sh, after `MASTER_LORE`), in a terminal: the sign-in's ports and `auth_main`
/// inside the instance. Args: T N LR ACTION S (the instance-side script, `ssh::packed`), then the
/// action's own.
const MASTER_AUTH: &str = r##"T=$1 N=$2 LR=$3 ACTION=$4 S=$5
shift 5
command -v base64 >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1 \
  || fail "this server has no base64 or gzip, which Mango sends the sign-in script with."
S=$(printf '%s' "$S" | base64 -d | gzip -dc) || fail "the sign-in script did not arrive whole. Run it again."
incus info "$T" >/dev/null 2>&1 || fail "$N no longer exists on this server."
case $ACTION in
  setup)
    q=$(incus config device get "$T" lore-quic listen 2>/dev/null || true)
    [ -n "$q" ] || fail "publish the Lore server first: the sign-in is for the address it is published at."
    LA=${q#*:}
    LA=${LA%:*}
    LP=${q##*:}
    printf '\n\033[1m==> %s\033[0m\n' "Publishing TCP ports 80 and 443 at $LA (Let's Encrypt and the sign-in pages)"
    lore_web_publish
    incus exec "$T" -t --env AUTH_APPLY=1 -- bash -c "$S" mango-lore-auth setup "$1" "$2" "$3" "$4" "$LP" "" "$5"
    echo
    lore_firewall_say || true
    echo "The sign-in needs TCP ports 80 and 443 at $LA too: whatever allows port $LP has to allow them."
    ;;
  off)
    incus exec "$T" -t --env AUTH_APPLY=1 -- bash -c "$S" mango-lore-auth off
    lore_web_unpublish
    echo "Ports 80 and 443 are no longer published for $N."
    ;;
  *)
    incus exec "$T" -t -- bash -c "$S" mango-lore-auth "$ACTION" "$@"
    ;;
esac
"##;

const AUTH_ACTIONS: [&str; 5] = ["setup", "off", "user-add", "user-remove", "github-secret"];

/// The remote argv for a sign-in action (values already checked): `args` follow the action.
fn auth_remote(host: &EnvHost, instance: &str, action: &str, args: &[String]) -> Vec<String> {
    let fail = r#"fail() { printf '\n\033[1;31mMango: %s\033[0m\n' "$*" >&2; exit 1; }
"#;
    let script = format!("set -eu\n{fail}{MASTER_LORE}{MASTER_AUTH}");
    let inside = format!(
        "set -Eeuo pipefail\n{}{}{}auth_main \"$@\"\n",
        recipes::BASICS,
        recipes::LORE_COMMON,
        lore_auth::functions()
    );
    let mut v: Vec<String> = vec![
        "sh".into(),
        "-c".into(),
        script,
        "mango-lore-auth".into(),
        ssh::target(host, instance),
        instance.to_string(),
        ssh::remote_prefix(host).unwrap_or_default(),
        action.to_string(),
        // Packed: as it is, it no longer fits a Windows command line.
        ssh::packed(&inside),
    ];
    v.extend(args.iter().cloned());
    v
}

/// The arguments of one sign-in action, checked: `setup` takes the sign-in and an optional first
/// user, `user-add` / `user-remove` an email, `off` and `github-secret` nothing.
pub(crate) fn auth_args(action: &str, sign_in: Option<LoreSignIn>, email: Option<&str>) -> Result<Vec<String>, String> {
    if !AUTH_ACTIONS.contains(&action) {
        return Err(format!("\"{action}\" is not something Mango does to a Lore server's sign-in."));
    }
    let email = email.map(str::trim).filter(|e| !e.is_empty()).map(lore_auth::valid_email).transpose()?;
    Ok(match action {
        "setup" => {
            let s = lore_auth::clean(sign_in.ok_or("Pick how people sign in first.")?)?;
            let mut v = lore_auth::setup_args(&s).to_vec();
            v.push(if s.passwords { email.unwrap_or_default() } else { String::new() });
            v
        }
        "user-add" | "user-remove" => vec![email.ok_or("Type the email address of the user.")?],
        _ => vec![],
    })
}

/// Set up (or change) the Lore server's sign-in in `instance`, turn it off, add or remove a password
/// user, or type the GitHub secret again, in a terminal: passwords and the secret are typed there.
/// Answers the pty id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn env_lore_auth(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    instance: String,
    action: String,
    sign_in: Option<LoreSignIn>,
    email: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    valid_instance(&instance)?;
    let args = auth_args(&action, sign_in, email.as_deref())?;
    let host = hosts::get(&app, &host_id)?;
    super::owner_only(&host, "change this environment's Lore server")?;
    let argv = ssh::argv(&host, ssh::Mode::Tty, &auth_remote(&host, &instance, &action, &args))?;
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[])
}

/// Validated create-time publish values: (listen address, port).
pub(crate) fn publish_args(input: &EnvLorePublishInput) -> Result<(String, u16), String> {
    let listen = valid_listen_address(&input.address)?;
    valid_publish_port(input.port)?;
    Ok((listen, input.port))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    const IP_ADDR: &str = "\
2: enp1s0    inet 203.0.113.24/26 brd 203.0.113.63 scope global enp1s0\\       valid_lft forever preferred_lft forever
2: enp1s0    inet6 2a01:4f8::24/64 scope global \\       valid_lft forever preferred_lft forever
2: enp1s0    inet6 2a01:4f8::abcd/64 scope global temporary dynamic \\       valid_lft 1 preferred_lft 1
3: wg0    inet 10.8.0.1/24 scope global wg0\\       valid_lft forever preferred_lft forever
4: incusbr0    inet 10.88.0.1/24 scope global incusbr0\\       valid_lft forever preferred_lft forever
5: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever
6: tailscale0    inet 100.101.7.1/32 scope global tailscale0\\       valid_lft forever preferred_lft forever
6: tailscale0    inet6 fd7a:115c:a1e0::1/128 scope global \\       valid_lft forever preferred_lft forever
";

    #[test]
    fn host_addresses_in_order() {
        let a = parse_host_addresses(IP_ADDR, Some("incusbr0"));
        let got: Vec<(&str, &str)> = a.iter().map(|a| (a.address.as_str(), a.kind.as_str())).collect();
        assert_eq!(
            got,
            [
                ("100.101.7.1", "tailscale"),
                ("fd7a:115c:a1e0::1", "tailscale"),
                ("10.8.0.1", "private"),
                ("203.0.113.24", "public"),
                ("2a01:4f8::24", "public"),
            ]
        );
        assert_eq!(a[2].interface, "wg0");
        assert!(parse_host_addresses("garbage\n\n", None).is_empty());
    }

    #[test]
    fn urls_and_listen_values() {
        assert_eq!(lore_url("lore.incus", 41337), "lore://lore.incus");
        assert_eq!(lore_url("100.101.7.1", 4000), "lore://100.101.7.1:4000");
        assert_eq!(lore_url("2a01:4f8::24", 41337), "lore://[2a01:4f8::24]");
        assert_eq!(lore_url("[::1]", 5000), "lore://[::1]:5000");
        assert_eq!(split_listen("udp:100.101.7.1:41337"), Some(("100.101.7.1".into(), 41337)));
        assert_eq!(split_listen("tcp:[2a01:4f8::24]:4000"), Some(("[2a01:4f8::24]".into(), 4000)));
        assert_eq!(split_listen("udp:0.0.0.0:x"), None);
        assert_eq!(split_listen("garbage"), None);
    }

    #[test]
    fn outside_names() {
        let h = host();
        let addrs = parse_host_addresses(IP_ADDR, None);
        let names = vec!["forge.example.com".to_string()];
        let dns = |n: &str| if n == "forge.example.com" { vec!["203.0.113.24".parse().unwrap()] } else { vec![] };
        // The name the user connects with, when it is the published address or all of them.
        assert_eq!(outside_host(&h, "203.0.113.24", &names, &addrs, &dns).unwrap(), "forge.example.com");
        assert_eq!(outside_host(&h, "0.0.0.0", &names, &addrs, &dns).unwrap(), "forge.example.com");
        // Another address (the tailnet one): that address.
        assert_eq!(outside_host(&h, "100.101.7.1", &names, &addrs, &dns).unwrap(), "100.101.7.1");
        assert_eq!(outside_host(&h, "[2a01:4f8::24]", &names, &addrs, &dns).unwrap(), "2a01:4f8::24");
        // No usable name: all addresses falls back to a public one.
        let local = vec!["localhost".to_string()];
        assert_eq!(outside_host(&h, "0.0.0.0", &local, &addrs, &dns).unwrap(), "203.0.113.24");
        assert!(outside_host(&h, "0.0.0.0", &local, &[], &dns).is_err());
    }

    #[test]
    fn firewall_commands() {
        assert_eq!(firewall_rules("ufw", 41337), ["sudo ufw allow 41337/udp && sudo ufw allow 41337/tcp"]);
        assert!(firewall_rules("firewalld", 4000)[0].contains("--add-port=4000/udp --add-port=4000/tcp"));
        assert!(firewall_rules("nftables", 4000).is_empty());
    }

    const INSTANCE: &str = r#"{
      "name": "lore",
      "type": "container",
      "devices": {
        "lore-quic": {"type": "proxy", "listen": "udp:100.101.7.1:41337", "connect": "udp:127.0.0.1:41337"},
        "lore-grpc": {"type": "proxy", "listen": "tcp:100.101.7.1:41337", "connect": "tcp:127.0.0.1:41337"}
      },
      "expanded_devices": {
        "eth0": {"name": "eth0", "network": "incusbr0", "type": "nic"},
        "root": {"path": "/", "pool": "default", "type": "disk"}
      }
    }"#;

    #[test]
    fn reads_the_state() {
        let out = format!(
            "@@instance\n{INSTANCE}\n@@network\n{{\"name\": \"incusbr0\", \"type\": \"bridge\", \"managed\": true, \"config\": {{\"ipv4.address\": \"10.88.0.1/24\"}}}}\n\
             @@inside\nversion loreserver 0.14.0\nactive active\nips 10.88.0.44 fd42::44 \n@@host\n{IP_ADDR}@@firewall\nufw\n"
        );
        let i = parse_info("lore", &out);
        assert!(i.installed && i.running);
        assert_eq!(i.version.as_deref(), Some("0.14.0"));
        assert_eq!(i.inside_url.as_deref(), Some("lore://lore.incus"));
        assert_eq!(i.inside_ip_url.as_deref(), Some("lore://10.88.0.44"));
        let p = i.published.as_ref().unwrap();
        assert_eq!((p.address.as_str(), p.port, p.complete), ("100.101.7.1", 41337, true));
        assert_eq!(i.firewall.as_ref().unwrap().kind, "ufw");
        assert_eq!(i.firewall.unwrap().commands, firewall_rules("ufw", 41337));
        assert_eq!(i.addresses[0].address, "100.101.7.1");
        assert!(!i.addresses.iter().any(|a| a.interface == "incusbr0"));

        // Stopped, not published, a network with its own domain, an older device set.
        let out = "@@instance\n{\"devices\": {\"lore-quic\": {\"type\": \"proxy\", \"listen\": \"udp:0.0.0.0:4000\"}}}\n\
                   @@network\n{\"name\": \"lan\", \"type\": \"bridge\", \"config\": {\"dns.domain\": \"lab.internal\"}}\n\
                   @@inside\nversion loreserver 0.14.0\nactive inactive\nips \n@@host\n@@firewall\n";
        let i = parse_info("lore", out);
        assert!(i.installed && !i.running);
        assert_eq!(i.inside_url.as_deref(), Some("lore://lore.lab.internal"));
        assert!(i.inside_ip_url.is_none());
        let p = i.published.unwrap();
        assert_eq!((p.port, p.complete), (4000, false));
        assert!(i.firewall.is_none());

        // Not installed, no DNS (a macvlan network), a firewall that only matters once published.
        let out = "@@instance\n{}\n@@network\n{\"name\": \"mv\", \"type\": \"macvlan\"}\n@@inside\nversion \nactive inactive\n@@firewall\nufw\n";
        let i = parse_info("dev", out);
        assert!(!i.installed && !i.running && i.inside_url.is_none() && i.published.is_none() && i.firewall.is_none());
        let i = parse_info("dev", "");
        assert!(!i.installed && i.addresses.is_empty());
    }

    #[test]
    fn command_lines_pass_values_as_arguments() {
        let mut h = host();
        h.incus_remote = Some("os1".into());
        let r = remote(&h, "lore", &Step::Publish("[2a01:4f8::24]".into(), 4000));
        assert_eq!(&r[..2], ["sh", "-c"]);
        assert_eq!(&r[3..7], ["mango-lore", "os1:lore", "lore", "os1:"]);
        assert_eq!(r[7], INNER);
        assert_eq!(&r[8..], ["[2a01:4f8::24]", "4000"]);
        assert!(r[2].contains("\nlore_publish\nlore_info\n"));
        // The script never names a value itself.
        assert!(!r[2].contains("2a01") && !r[2].contains("4000") && !r[2].contains("os1"));
        let r = remote(&host(), "lore", &Step::Read);
        assert_eq!(&r[6..], ["", INNER, "", ""]);
        assert!(r[2].ends_with("LP=$6\nlore_info\n"));
        let r = remote(&host(), "lore", &Step::Unpublish);
        assert!(r[2].ends_with("\nlore_unpublish\nlore_info\n"));
        let l = ssh::line(&remote(&h, "lore", &Step::Publish("0.0.0.0".into(), 41337)));
        assert!(l.ends_with(" 0.0.0.0 41337"), "{}", &l[l.len() - 40..]);
        assert!(l.is_ascii());
    }

    #[test]
    fn publish_input_is_checked() {
        assert_eq!(publish_args(&EnvLorePublishInput { address: "::".into(), port: 41337 }).unwrap(), ("[::]".into(), 41337));
        assert!(publish_args(&EnvLorePublishInput { address: "1.2.3.4;id".into(), port: 41337 }).is_err());
        assert!(publish_args(&EnvLorePublishInput { address: "1.2.3.4".into(), port: 80 }).is_err());
    }

    #[test]
    fn errors_read_well() {
        let e = "Error: x\nmango-error: port 4000 is already in use on the server.".to_string();
        assert_eq!(script_error("lore", e), "Port 4000 is already in use on the server.");
        assert_eq!(script_error("lore", "boom".into()), "boom");
    }

    /// Every shell piece parses (`bash -n`, and `sh -n` for the master side): a broken quote
    /// would only show on a real server.
    #[test]
    fn scripts_parse() {
        let check = crate::bin::assert_parses;
        let master = format!("{CAPTURED}{MASTER_LORE}{INFO}lore_info\n");
        check("sh", &master);
        check("bash", &master);
        check("sh", INNER);
        let auth = auth_remote(&host(), "lore", "setup", &[]);
        check("sh", &auth[2]);
        check("bash", &ssh::unpacked(&auth[8]));
    }

    #[test]
    fn sign_in_actions() {
        use crate::lore_auth::LoreSignInGithub;
        let s = LoreSignIn {
            domain: "Lore.Example.com".into(),
            passwords: true,
            github: Some(LoreSignInGithub { client_id: "Ov23li".into(), orgs: vec!["fruit".into()] }),
        };
        assert_eq!(
            auth_args("setup", Some(s.clone()), Some(" Ann@Example.com ")).unwrap(),
            ["lore.example.com", "yes", "Ov23li", "fruit", "ann@example.com"]
        );
        // No passwords: no first user, whatever was typed.
        let gh = LoreSignIn { passwords: false, ..s.clone() };
        assert_eq!(auth_args("setup", Some(gh), Some("ann@example.com")).unwrap()[4], "");
        assert_eq!(auth_args("user-add", None, Some("ann@example.com")).unwrap(), ["ann@example.com"]);
        assert!(auth_args("off", None, None).unwrap().is_empty());
        assert!(auth_args("setup", None, None).is_err());
        assert!(auth_args("user-add", None, None).is_err());
        assert!(auth_args("user-add", None, Some("x;id")).is_err());
        assert!(auth_args("rm", None, None).is_err());

        let r = auth_remote(&host(), "lore", "setup", &auth_args("setup", Some(s), Some("ann@example.com")).unwrap());
        assert_eq!(&r[..2], ["sh", "-c"]);
        assert_eq!(&r[3..8], ["mango-lore-auth", "lore", "lore", "", "setup"]);
        assert_eq!(&r[9..], ["lore.example.com", "yes", "Ov23li", "fruit", "ann@example.com"]);
        // Neither script names a value itself.
        let inside = ssh::unpacked(&r[8]);
        assert!(!r[2].contains("example.com") && !inside.contains("example.com"));
        assert!(inside.contains("auth_main \"$@\"") && inside.contains("auth_dex_check()"));
    }

    /// Every sign-in action fits a Windows command line (CreateProcess takes 32767 characters):
    /// 0.12.0's instance-side script, sent as it was, did not ("The filename or extension is too long").
    #[test]
    fn sign_in_fits_a_windows_command_line() {
        let long = "a".repeat(60);
        let s = LoreSignIn {
            domain: format!("{long}.example.com"),
            passwords: true,
            github: Some(crate::lore_auth::LoreSignInGithub {
                client_id: long.clone(),
                orgs: (0..crate::lore_auth::MAX_ORGS).map(|i| format!("{}{i}", "o".repeat(38))).collect(),
            }),
        };
        let email = format!("{long}@{long}.example.com");
        for action in AUTH_ACTIONS {
            let sign_in = (action == "setup").then(|| s.clone());
            let args = auth_args(action, sign_in, Some(&email)).unwrap();
            let r = auth_remote(&host(), "lore", action, &args);
            let n = ssh::windows_length(&r);
            assert!(n < 30_000, "{action}: {n}");
        }
    }

    #[test]
    fn reads_the_sign_in() {
        let out = format!(
            "@@instance\n{INSTANCE}\n@@inside\nversion loreserver 0.14.0\nactive active\nips 10.88.0.44\n\
             authOn yes\nauthDomain lore.example.com\nauthPasswords yes\nauthGithubId \nauthGithubOrgs \nauthCert yes\n\
             authUser ann@example.com\nauthUser bo@example.com\n"
        );
        let i = parse_info("lore", &out);
        let a = i.auth.unwrap();
        assert!(a.on && a.passwords && a.certificate && a.github.is_none());
        assert_eq!(a.users, ["ann@example.com", "bo@example.com"]);
        assert!(!i.published.unwrap().web);
        // Never set up: no sign-in at all.
        let i = parse_info("lore", "@@inside\nversion loreserver 0.14.0\n");
        assert!(i.auth.is_none());
    }
}
