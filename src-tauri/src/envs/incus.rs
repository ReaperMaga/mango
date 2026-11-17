//! Instances on a master: list, create, start/stop/restart/delete.
//!
//! Each action is one `ssh master incus …` call. Creating runs in a terminal
//! the user watches: one master-side script launches the instance, waits for
//! it (a VM's agent can take minutes), waits for its network, then installs
//! the chosen components with the same script as `env_install` (`recipes`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use super::{hosts, recipes, ssh, valid_image, valid_instance, EnvHost};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInstance {
    pub name: String,
    /// "container" or "vm"
    pub kind: String,
    /// "running" | "stopped" | "starting" | "stopping" | "frozen" | "error" | "unknown"
    pub status: String,
    /// The image's description, e.g. "Ubuntu noble amd64 (20261101_07:42)".
    pub image: Option<String>,
    pub ipv4: Vec<String>,
    /// The instance's address on the tailnet (100.64.0.0/10), when it has joined one.
    pub tailscale_ip: Option<String>,
    pub cpus: Option<u32>,
    /// e.g. "8GiB", as `limits.memory` says
    pub memory: Option<String>,
    /// The root disk's size, e.g. "40GiB", as its `root` device says; `None` is the pool's default.
    pub disk: Option<String>,
    /// Unix ms
    pub created_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvCreateInput {
    pub host_id: String,
    pub name: String,
    pub image: String,
    /// "container" or "vm"
    pub kind: String,
    pub cpus: Option<u32>,
    pub memory_gib: Option<u32>,
    pub disk_gib: Option<u32>,
    /// Component ids to install once it is up (see `recipes`).
    pub components: Vec<String>,
}

/* ---------- listing ---------- */

fn status_of(s: &str) -> &'static str {
    match s.to_ascii_lowercase().as_str() {
        "running" | "ready" | "thawed" => "running",
        "stopped" => "stopped",
        "starting" => "starting",
        "stopping" | "aborting" => "stopping",
        "frozen" | "freezing" => "frozen",
        "error" | "broken" => "error",
        _ => "unknown",
    }
}

/// `true` for 100.64.0.0/10, the range Tailscale hands out.
pub(crate) fn is_tailnet(ip: &str) -> bool {
    let mut it = ip.split('.').map(|p| p.parse::<u8>());
    matches!((it.next(), it.next()), (Some(Ok(100)), Some(Ok(b))) if (64..=127).contains(&b))
}

/// `limits.cpu`: a count ("4") or a pinned set ("0-3,6").
fn cpu_count(s: &str) -> Option<u32> {
    let s = s.trim();
    if let Ok(n) = s.parse::<u32>() {
        return Some(n);
    }
    let mut n = 0u32;
    for part in s.split(',') {
        match part.split_once('-') {
            Some((a, b)) => {
                let (a, b) = (a.trim().parse::<u32>().ok()?, b.trim().parse::<u32>().ok()?);
                n += b.checked_sub(a)? + 1;
            }
            None => {
                part.trim().parse::<u32>().ok()?;
                n += 1;
            }
        }
    }
    (n > 0).then_some(n)
}

/// RFC 3339 (`2026-11-01T07:42:10.123456789Z`, or with a `+02:00` offset) to Unix ms.
fn rfc3339_ms(s: &str) -> Option<u64> {
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut rest = s.get(19..)?;
    let mut ms = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        ms = format!("{digits:0<3}")[..3].parse().ok()?;
        rest = &frac[digits.len()..];
    }
    let offset_min = match rest {
        "Z" | "z" | "" => 0,
        o if o.len() == 6 => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            sign * (o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    u64::try_from(secs * 1000 + ms).ok()
}

fn config_str<'a>(inst: &'a Value, key: &str) -> Option<&'a str> {
    ["expanded_config", "config"]
        .iter()
        .find_map(|c| inst.get(c)?.get(key)?.as_str())
        .filter(|s| !s.is_empty())
}

/// The `size` of the instance's `root` disk device (its own, or the one its profiles give it).
fn root_size(inst: &Value) -> Option<String> {
    ["expanded_devices", "devices"]
        .iter()
        .find_map(|d| inst.get(d)?.get("root")?.get("size")?.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// One instance from `incus list --format json` (which includes its state).
fn parse_instance(inst: &Value) -> Option<EnvInstance> {
    let name = inst.get("name")?.as_str()?.to_string();
    let kind = match inst.get("type").and_then(Value::as_str) {
        Some("virtual-machine") => "vm",
        _ => "container",
    };
    let state = inst.get("state").filter(|s| s.is_object());
    let status = state
        .and_then(|s| s.get("status"))
        .or_else(|| inst.get("status"))
        .and_then(Value::as_str)
        .map_or("unknown", status_of);

    let mut ipv4 = Vec::new();
    let mut tailscale_ip = None;
    if let Some(nets) = state.and_then(|s| s.get("network")).and_then(Value::as_object) {
        let mut names: Vec<&String> = nets.keys().collect();
        names.sort();
        for dev in names {
            let net = &nets[dev];
            if dev == "lo" || net.get("type").and_then(Value::as_str) == Some("loopback") {
                continue;
            }
            let addrs = net.get("addresses").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            for a in addrs {
                let (Some("inet"), Some(ip)) =
                    (a.get("family").and_then(Value::as_str), a.get("address").and_then(Value::as_str))
                else {
                    continue;
                };
                if is_tailnet(ip) && tailscale_ip.is_none() {
                    tailscale_ip = Some(ip.to_string());
                }
                let global = a.get("scope").and_then(Value::as_str).is_none_or(|s| s == "global");
                if dev != "tailscale0" && global {
                    ipv4.push(ip.to_string());
                }
            }
        }
    }

    let created_at = inst
        .get("created_at")
        .and_then(Value::as_str)
        .and_then(rfc3339_ms)
        .filter(|ms| *ms > 0)
        .or_else(|| config_str(inst, "user.mango.created")?.parse().ok())
        .unwrap_or(0);

    Some(EnvInstance {
        name,
        kind: kind.into(),
        status: status.into(),
        image: config_str(inst, "image.description").map(String::from),
        ipv4,
        tailscale_ip,
        cpus: config_str(inst, "limits.cpu").and_then(cpu_count),
        memory: config_str(inst, "limits.memory").map(String::from),
        disk: root_size(inst),
        created_at,
    })
}

/// `incus list --format json` to instances. Pure, for tests.
pub(crate) fn parse_instances(json: &str) -> Result<Vec<EnvInstance>, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("The server's instance list was not readable: {e}"))?;
    let list = v.as_array().ok_or("The server's instance list was not readable.")?;
    Ok(list.iter().filter_map(parse_instance).collect())
}

/* ---------- a joined environment: its one instance, described from inside ---------- */

/// What a joined environment says about itself (POSIX sh, as its agent user).
const DIRECT_FACTS: &str = r#"kv() { printf '%s=%s
' "$1" "$(printf '%s' "$2" | tr '

	' '   ')"; }
PRETTY_NAME= NAME=
[ -r /etc/os-release ] && . /etc/os-release
kv image "${PRETTY_NAME:-$NAME}"
kv container "$(systemd-detect-virt --container 2>/dev/null)"
kv vm "$(systemd-detect-virt --vm 2>/dev/null)"
kv ips "$(hostname -I 2>/dev/null)"
kv ts "$(tailscale ip -4 2>/dev/null | head -n 1)"
kv cpus "$(nproc 2>/dev/null)"
kv mem "$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)"
exit 0
"#;

/// `8GiB`-style text for a memory size in KiB (as /proc/meminfo has it).
fn memory_text(kib: u64) -> String {
    let gib = kib as f64 / (1024.0 * 1024.0);
    if gib >= 1.0 {
        format!("{}GiB", gib.round() as u64)
    } else {
        format!("{}MiB", (kib / 1024).max(1))
    }
}

/// The joined environment as an instance: from [`DIRECT_FACTS`]' output, or `unknown` when
/// it did not answer (the probe says why).
pub(crate) fn direct_instance(name: &str, out: Option<&str>) -> EnvInstance {
    let facts: std::collections::HashMap<&str, &str> = out
        .unwrap_or("")
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim(), v.trim()))
        .filter(|(_, v)| !v.is_empty())
        .collect();
    let detected = |k: &str| facts.get(k).is_some_and(|v| *v != "none");
    let kind = if !detected("container") && detected("vm") { "vm" } else { "container" };
    let tailscale_ip = facts.get("ts").filter(|ip| is_tailnet(ip)).map(|s| s.to_string());
    let ipv4 = facts
        .get("ips")
        .map(|ips| {
            ips.split_whitespace()
                .filter(|ip| ip.contains('.') && !ip.starts_with("127.") && !is_tailnet(ip))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    EnvInstance {
        name: name.to_string(),
        kind: kind.into(),
        status: if out.is_some() { "running" } else { "unknown" }.into(),
        image: facts.get("image").map(|s| s.to_string()),
        ipv4,
        tailscale_ip,
        cpus: facts.get("cpus").and_then(|n| n.parse().ok()),
        memory: facts.get("mem").and_then(|n| n.parse().ok()).map(memory_text),
        disk: None,
        created_at: 0,
    }
}

#[tauri::command]
pub async fn env_instances(app: AppHandle, host_id: String) -> Result<Vec<EnvInstance>, String> {
    super::blocking(move || {
        let host = hosts::get(&app, &host_id)?;
        if let Some(d) = &host.direct {
            let remote = ["sh".to_string(), "-c".into(), DIRECT_FACTS.into()];
            let out = ssh::run(&host, &remote, Duration::from_secs(20)).ok();
            return Ok(vec![direct_instance(&d.instance, out.as_deref())]);
        }
        let mut remote = vec!["incus".to_string(), "list".into()];
        remote.extend(ssh::remote_prefix(&host));
        remote.extend(["--format".into(), "json".into()]);
        let out = ssh::run(&host, &remote, Duration::from_secs(30))?;
        parse_instances(&out)
    })
    .await
}

/* ---------- start / stop / restart / delete ---------- */

fn incus(host: &EnvHost, args: &[&str], secs: u64) -> Result<String, String> {
    let mut remote = vec!["incus".to_string()];
    remote.extend(args.iter().map(|s| s.to_string()));
    ssh::run(host, &remote, Duration::from_secs(secs))
}

/// Errors after which forcing would not help (or the goal is already met).
fn final_error(e: &str) -> bool {
    let l = e.to_lowercase();
    ["already", "not found", "not running", "isn't running", "ssh", "could not connect", "has no `incus`"]
        .iter()
        .any(|k| l.contains(k))
}

/// A message for a failed action, or `None` when the instance is already where it should be.
fn action_error(host: &EnvHost, instance: &str, action: &str, e: String) -> Option<String> {
    let l = e.to_lowercase();
    let done = match action {
        "start" => l.contains("already running"),
        "stop" => l.contains("already stopped") || l.contains("not running") || l.contains("isn't running"),
        "delete" => l.contains("not found"),
        _ => false,
    };
    if done {
        return None;
    }
    if l.contains("not found") {
        return Some(format!("{instance} no longer exists on {}.", host.name));
    }
    match e.strip_prefix("Error: ") {
        Some(msg) => Some(format!("Could not {action} {instance}: {msg}")),
        None => Some(e),
    }
}

fn act(host: &EnvHost, instance: &str, action: &str) -> Result<(), String> {
    let t = ssh::target(host, instance);
    let t = t.as_str();
    let r = match action {
        "start" => incus(host, &["start", t], 120),
        "stop" => incus(host, &["stop", t, "--timeout", "30"], 75).or_else(|e| {
            if final_error(&e) {
                Err(e)
            } else {
                incus(host, &["stop", t, "--force"], 60)
            }
        }),
        "restart" => incus(host, &["restart", t, "--timeout", "30"], 75).or_else(|e| {
            let l = e.to_lowercase();
            if l.contains("not running") || l.contains("isn't running") || l.contains("already stopped") {
                incus(host, &["start", t], 120)
            } else if final_error(&e) {
                Err(e)
            } else {
                incus(host, &["restart", t, "--force"], 90)
            }
        }),
        "delete" => incus(host, &["delete", "--force", t], 180),
        other => return Err(format!("\"{other}\" is not something Mango can do to an instance.")),
    };
    match r {
        Ok(_) => Ok(()),
        Err(e) => action_error(host, instance, action, e).map_or(Ok(()), Err),
    }
}

#[tauri::command]
pub async fn env_instance_action(app: AppHandle, host_id: String, instance: String, action: String) -> Result<(), String> {
    super::blocking(move || {
        valid_instance(&instance)?;
        if !["start", "stop", "restart", "delete"].contains(&action.as_str()) {
            return Err(format!("\"{action}\" is not something Mango can do to an instance."));
        }
        let host = hosts::get(&app, &host_id)?;
        super::owner_only(&host, "start, stop or delete this environment")?;
        act(&host, &instance, &action)
    })
    .await
}

/* ---------- rename ---------- */

/// `Status: RUNNING` from `incus info`, as an instance status.
fn info_status(info: &str) -> &'static str {
    info.lines()
        .find_map(|l| l.trim().strip_prefix("Status:"))
        .map_or("unknown", |s| status_of(s.trim()))
}

/// Renames `instance` to `new_name`. Incus only renames a stopped instance, so a running
/// one is stopped first and started again under its new name. `Some(note)` when the
/// rename worked but something after it did not (it did not start again).
fn rename(host: &EnvHost, instance: &str, new_name: &str) -> Result<Option<String>, String> {
    let (from, to) = (ssh::target(host, instance), ssh::target(host, new_name));
    if incus(host, &["info", &to], 30).is_ok() {
        return Err(format!("{} already has an instance called {new_name}.", host.name));
    }
    let info = incus(host, &["info", &from], 30)
        .map_err(|e| action_error(host, instance, "rename", e).unwrap_or_else(|| format!("Could not rename {instance}.")))?;
    let was_running = matches!(info_status(&info), "running" | "starting");
    if was_running {
        act(host, instance, "stop")?;
    }
    // `move` with the remote on both sides renames in place (no remote on the target would move it to the master).
    if let Err(e) = incus(host, &["move", &from, &to], 120) {
        if was_running {
            let _ = act(host, instance, "start");
        }
        return Err(action_error(host, instance, "rename", e).unwrap_or_else(|| format!("Could not rename {instance}.")));
    }
    if was_running {
        if let Err(e) = act(host, new_name, "start") {
            return Ok(Some(format!("It is renamed, but didn't start again. {e}")));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn env_rename(app: AppHandle, host_id: String, instance: String, new_name: String) -> Result<Option<String>, String> {
    super::blocking(move || {
        valid_instance(&instance)?;
        let new_name = new_name.trim().to_string();
        valid_instance(&new_name)?;
        let host = hosts::get(&app, &host_id)?;
        super::owner_only(&host, "rename this environment")?;
        if new_name == instance {
            return Ok(None);
        }
        rename(&host, &instance, &new_name)
    })
    .await
}

/* ---------- resize ---------- */

/// New limits for an instance; `None` leaves that one as it is.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvResizeInput {
    pub cpus: Option<u32>,
    pub memory_gib: Option<u32>,
    pub disk_gib: Option<u32>,
}

/// `Pick 1 to 64 CPUs.` for a value outside its range. Shared by create and resize.
fn check_size(v: Option<u32>, lo: u32, hi: u32, what: &str) -> Result<(), String> {
    match v {
        Some(n) if !(lo..=hi).contains(&n) => Err(format!("Pick {lo} to {hi} {what}.")),
        _ => Ok(()),
    }
}

fn check_sizes(cpus: Option<u32>, memory_gib: Option<u32>, disk_gib: Option<u32>) -> Result<(), String> {
    check_size(cpus, 1, 64, "CPUs")?;
    check_size(memory_gib, 1, 512, "GiB of memory")?;
    check_size(disk_gib, 4, 2048, "GiB of disk")
}

/// The `incus` argument lists a resize runs: the limits in one `config set`, then the
/// root disk. A disk that comes from a profile can't be `set` on the instance; it is
/// overridden instead (see [`resize`]).
#[derive(Debug, Clone, PartialEq)]
struct ResizePlan {
    limits: Option<Vec<String>>,
    disk: Option<String>,
}

fn resize_plan(host: &EnvHost, instance: &str, input: &EnvResizeInput) -> Result<ResizePlan, String> {
    valid_instance(instance)?;
    check_sizes(input.cpus, input.memory_gib, input.disk_gib)?;
    let mut keys = Vec::new();
    if let Some(n) = input.cpus {
        keys.push(format!("limits.cpu={n}"));
    }
    if let Some(n) = input.memory_gib {
        keys.push(format!("limits.memory={n}GiB"));
    }
    let limits = (!keys.is_empty()).then(|| {
        let mut a = vec!["config".to_string(), "set".into(), ssh::target(host, instance)];
        a.extend(keys);
        a
    });
    let disk = input.disk_gib.map(|n| format!("size={n}GiB"));
    if limits.is_none() && disk.is_none() {
        return Err("Nothing to change.".into());
    }
    Ok(ResizePlan { limits, disk })
}

/// The failure of a resize step, readable.
fn resize_error(host: &EnvHost, instance: &str, what: &str, e: String) -> String {
    let l = e.to_lowercase();
    if l.contains("not found") {
        return format!("{instance} no longer exists on {}.", host.name);
    }
    let msg = e.strip_prefix("Error: ").unwrap_or(&e);
    if l.contains("shrink") || l.contains("smaller") {
        return format!("Could not change the {what} of {instance}: a disk can only grow. ({msg})");
    }
    format!("Could not change the {what} of {instance}: {msg}")
}

fn resize(host: &EnvHost, instance: &str, kind: Option<&str>, plan: &ResizePlan) -> Result<Option<String>, String> {
    if let Some(args) = &plan.limits {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        incus(host, &args, 60).map_err(|e| resize_error(host, instance, "CPUs and memory", e))?;
    }
    if let Some(size) = &plan.disk {
        let t = ssh::target(host, instance);
        incus(host, &["config", "device", "set", &t, "root", size], 120)
            .or_else(|e| {
                let l = e.to_lowercase();
                if l.contains("profile") || l.contains("doesn't exist") || l.contains("does not exist") {
                    incus(host, &["config", "device", "override", &t, "root", size], 120)
                } else {
                    Err(e)
                }
            })
            .map_err(|e| resize_error(host, instance, "disk size", e))?;
        if kind == Some("vm") {
            return Ok(Some("The VM's file system grows to the new disk size when it next starts.".into()));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn env_resize(app: AppHandle, host_id: String, instance: String, input: EnvResizeInput) -> Result<Option<String>, String> {
    super::blocking(move || {
        let host = hosts::get(&app, &host_id)?;
        super::owner_only(&host, "resize this environment")?;
        let plan = resize_plan(&host, &instance, &input)?;
        let info = incus(&host, &["info", &ssh::target(&host, &instance)], 30).unwrap_or_default();
        let kind = info.lines().find_map(|l| l.trim().strip_prefix("Type:")).map(|t| {
            if t.trim().starts_with("virtual-machine") { "vm" } else { "container" }
        });
        resize(&host, &instance, kind, &plan)
    })
    .await
}

/* ---------- create ---------- */

/// Launches `$T` (`incus launch "$@"`), waits for it to answer and reach the network,
/// then installs (`recipes::MASTER_INSTALL`). Arguments: T SCRIPT KEY TUN, launch args.
const CREATE: &str = r##"T=$1 SCRIPT=$2 KEY=$3 TUN=$4
shift 4
command -v incus >/dev/null 2>&1 || fail "this server has no incus command."
if incus info "$T" >/dev/null 2>&1; then
  fail "an instance called $T already exists. Pick another name."
fi
say "Launching $T from $1"
incus launch "$@" || fail "incus could not launch $T (see above). If a half-made $T is left over, delete it in Mango."
say "Waiting for $T to boot"
start=$(date +%s)
until incus exec "$T" -- true >/dev/null 2>&1; do
  el=$(( $(date +%s) - start ))
  [ "$el" -lt 300 ] || fail "$T did not answer within 5 minutes. A VM needs the incus agent, which images: images include; check it with incus console $T, then install the components from Mango."
  echo "    still starting (${el} s)"
  sleep 5
done
say "Waiting for the network in $T"
start=$(date +%s)
until incus exec "$T" -- sh -c 'getent hosts github.com >/dev/null 2>&1'; do
  el=$(( $(date +%s) - start ))
  [ "$el" -lt 120 ] || fail "$T has no working network or DNS after 2 minutes. Check its network on the server, then install the components from Mango."
  echo "    no network yet (${el} s)"
  sleep 3
done
incus exec "$T" -- sh -c 'command -v cloud-init >/dev/null 2>&1 || exit 0; echo "    letting cloud-init finish"; timeout 600 cloud-init status --wait >/dev/null 2>&1 || true'
"##;

/// Validated create input, ready to become command lines.
#[derive(Debug, Clone, PartialEq)]
struct CreatePlan {
    /// `incus launch` arguments: image, target, flags.
    launch: Vec<String>,
    install: Option<recipes::InstallPlan>,
}

/// `images:ubuntu/24.04` -> `images:ubuntu/24.04/cloud` for VMs: the cloud variant runs
/// cloud-init, which grows the root filesystem to the requested disk size.
fn vm_image(image: &str) -> String {
    match image.strip_prefix("images:") {
        Some(alias) if alias.split('/').count() == 2 => format!("{image}/cloud"),
        _ => image.to_string(),
    }
}

fn create_plan(host: &EnvHost, input: &EnvCreateInput, now_ms: u64) -> Result<CreatePlan, String> {
    let name = input.name.trim();
    valid_instance(name)?;
    let image = input.image.trim();
    valid_image(image)?;
    let vm = match input.kind.as_str() {
        "container" => false,
        "vm" => true,
        other => return Err(format!("\"{other}\" is not an instance type. Pick a container or a VM.")),
    };
    check_sizes(input.cpus, input.memory_gib, input.disk_gib)?;

    let install = if input.components.is_empty() {
        None
    } else {
        Some(recipes::install_plan(host, name, &input.components)?)
    };

    let mut launch = vec![if vm { vm_image(image) } else { image.to_string() }, ssh::target(host, name)];
    if vm {
        launch.push("--vm".into());
    }
    if let Some(n) = input.cpus {
        launch.extend(["-c".into(), format!("limits.cpu={n}")]);
    }
    if let Some(n) = input.memory_gib {
        launch.extend(["-c".into(), format!("limits.memory={n}GiB")]);
    }
    if let Some(n) = input.disk_gib {
        launch.extend(["-d".into(), format!("root,size={n}GiB")]);
    }
    launch.extend(["-c".into(), format!("user.mango.created={now_ms}")]);
    Ok(CreatePlan { launch, install })
}

/// The remote argv (for `ssh::argv`) creating the instance.
fn create_remote(host: &EnvHost, name: &str, plan: &CreatePlan) -> Vec<String> {
    let script = format!(
        "{}{CREATE}if [ -n \"$SCRIPT\" ]; then\n{}fi\nsay \"$T is ready.\"\n",
        recipes::MASTER_PRELUDE,
        recipes::MASTER_INSTALL
    );
    let mut a = vec!["sh".to_string(), "-c".into(), script, "mango-create".into()];
    match &plan.install {
        Some(p) => a.extend(recipes::master_install_args(&ssh::target(host, name), p)),
        None => a.extend([ssh::target(host, name), String::new(), String::new(), String::new()]),
    }
    a.extend(plan.launch.iter().cloned());
    a
}

#[tauri::command]
pub async fn env_create(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    input: EnvCreateInput,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let host = hosts::get(&app, &input.host_id)?;
    super::owner_only(&host, "create environments there: this one was shared with you")?;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let plan = create_plan(&host, &input, now_ms)?;
    let argv = ssh::argv(&host, ssh::Mode::Tty, &create_remote(&host, input.name.trim(), &plan))?;
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like `incus list --format json` from Incus 6.x (trimmed).
    const LIST: &str = r#"[
      {
        "architecture": "x86_64",
        "config": {
          "image.architecture": "amd64",
          "image.description": "Ubuntu noble amd64 (20261101_07:42)",
          "image.os": "Ubuntu",
          "limits.cpu": "4",
          "limits.memory": "8GiB",
          "user.mango.created": "1762000000000",
          "volatile.base_image": "abc"
        },
        "devices": {},
        "ephemeral": false,
        "profiles": ["default"],
        "stateful": false,
        "description": "",
        "created_at": "2026-11-01T07:42:10.123456789Z",
        "expanded_config": {
          "image.description": "Ubuntu noble amd64 (20261101_07:42)",
          "limits.cpu": "4",
          "limits.memory": "8GiB"
        },
        "expanded_devices": {"root": {"path": "/", "pool": "default", "type": "disk", "size": "40GiB"}},
        "name": "dev",
        "status": "Running",
        "status_code": 103,
        "last_used_at": "2026-11-16T09:00:00Z",
        "location": "none",
        "type": "container",
        "project": "default",
        "backups": null,
        "state": {
          "status": "Running",
          "status_code": 103,
          "disk": {},
          "memory": {"usage": 123},
          "network": {
            "eth0": {
              "addresses": [
                {"family": "inet", "address": "10.42.0.15", "netmask": "24", "scope": "global"},
                {"family": "inet6", "address": "fd42::15", "netmask": "64", "scope": "global"},
                {"family": "inet6", "address": "fe80::1", "netmask": "64", "scope": "link"}
              ],
              "counters": {}, "hwaddr": "00:16:3e:00:00:01", "host_name": "veth1", "mtu": 1500,
              "state": "up", "type": "broadcast"
            },
            "lo": {
              "addresses": [{"family": "inet", "address": "127.0.0.1", "netmask": "8", "scope": "local"}],
              "type": "loopback", "state": "up"
            },
            "tailscale0": {
              "addresses": [
                {"family": "inet", "address": "100.101.7.8", "netmask": "32", "scope": "global"},
                {"family": "inet6", "address": "fd7a:115c:a1e0::1", "netmask": "128", "scope": "global"}
              ],
              "type": "point-to-point", "state": "up"
            }
          },
          "pid": 4242,
          "processes": 31
        },
        "snapshots": null
      },
      {
        "config": {"image.description": "Debian bookworm amd64 (20261101_05:24)", "limits.cpu": "0-1,4"},
        "created_at": "2026-11-02T10:00:00+01:00",
        "expanded_config": {"image.description": "Debian bookworm amd64 (20261101_05:24)", "limits.cpu": "0-1,4"},
        "name": "build-vm",
        "status": "Stopped",
        "type": "virtual-machine",
        "state": {"status": "Stopped", "network": null}
      },
      {
        "name": "odd",
        "status": "Freezing",
        "type": "container",
        "created_at": "0001-01-01T00:00:00Z",
        "config": {"user.mango.created": "1700000000000"},
        "state": null
      }
    ]"#;

    #[test]
    fn parses_instances() {
        let v = parse_instances(LIST).unwrap();
        assert_eq!(v.len(), 3);
        let dev = &v[0];
        assert_eq!(dev.name, "dev");
        assert_eq!(dev.kind, "container");
        assert_eq!(dev.status, "running");
        assert_eq!(dev.image.as_deref(), Some("Ubuntu noble amd64 (20261101_07:42)"));
        assert_eq!(dev.ipv4, ["10.42.0.15"]);
        assert_eq!(dev.tailscale_ip.as_deref(), Some("100.101.7.8"));
        assert_eq!(dev.cpus, Some(4));
        assert_eq!(dev.memory.as_deref(), Some("8GiB"));
        assert_eq!(dev.disk.as_deref(), Some("40GiB"));
        assert_eq!(dev.created_at, 1_793_518_930_123);

        let vm = &v[1];
        assert_eq!((vm.kind.as_str(), vm.status.as_str()), ("vm", "stopped"));
        assert!(vm.ipv4.is_empty() && vm.tailscale_ip.is_none());
        assert_eq!(vm.cpus, Some(3));
        assert_eq!(vm.memory, None);
        assert_eq!(vm.disk, None);
        assert_eq!(vm.created_at, 1_793_610_000_000);

        let odd = &v[2];
        assert_eq!(odd.status, "frozen");
        assert_eq!(odd.created_at, 1_700_000_000_000);
        assert_eq!(odd.image, None);

        assert!(parse_instances("Error: nope").is_err());
        assert!(parse_instances("[]").unwrap().is_empty());
    }

    #[test]
    fn small_parsers() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_ms("2000-03-01T00:00:00.5Z"), Some(951_868_800_500));
        assert_eq!(rfc3339_ms("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(rfc3339_ms("garbage"), None);
        assert!(is_tailnet("100.64.0.1") && is_tailnet("100.127.255.255"));
        assert!(!is_tailnet("100.128.0.1") && !is_tailnet("10.0.0.1") && !is_tailnet("fd7a::1"));
        assert_eq!(cpu_count("2"), Some(2));
        assert_eq!(cpu_count("0-3"), Some(4));
        assert_eq!(cpu_count("x"), None);
        assert_eq!(status_of("Running"), "running");
        assert_eq!(status_of("Whatever"), "unknown");
    }

    fn host() -> EnvHost {
        EnvHost {
            id: "h".into(),
            name: "Lab".into(),
            ssh: "me@lab".into(),
            port: None,
            identity_file: None,
            incus_remote: Some("os1".into()),
            tailscale: None,
            public_address: None,
            direct: None,
        }
    }

    fn input() -> EnvCreateInput {
        EnvCreateInput {
            host_id: "h".into(),
            name: "dev".into(),
            image: "images:ubuntu/24.04".into(),
            kind: "vm".into(),
            cpus: Some(4),
            memory_gib: Some(8),
            disk_gib: Some(40),
            components: vec!["claude".into(), "tailscale".into()],
        }
    }

    #[test]
    fn create_plan_and_line() {
        let p = create_plan(&host(), &input(), 42).unwrap();
        assert_eq!(
            p.launch,
            [
                "images:ubuntu/24.04/cloud", "os1:dev", "--vm", "-c", "limits.cpu=4", "-c", "limits.memory=8GiB", "-d",
                "root,size=40GiB", "-c", "user.mango.created=42"
            ]
        );
        assert!(p.install.as_ref().unwrap().tailscale);
        let remote = create_remote(&host(), "dev", &p);
        assert_eq!(&remote[..2], ["sh", "-c"]);
        assert!(remote[2].contains("incus launch \"$@\"") && remote[2].contains("incus exec \"$T\" -t -- bash -c"));
        assert_eq!(&remote[3..5], ["mango-create", "os1:dev"]);
        assert_eq!(remote[7], "1");
        assert_eq!(remote[8], "images:ubuntu/24.04/cloud");
        let l = ssh::line(&remote);
        assert!(l.ends_with(" 1 images:ubuntu/24.04/cloud os1:dev --vm -c limits.cpu=4 -c limits.memory=8GiB -d root,size=40GiB -c user.mango.created=42"), "{l}");

        // A container with nothing to install: no flags it didn't ask for, empty install args.
        let mut i = input();
        i.kind = "container".into();
        i.cpus = None;
        i.memory_gib = None;
        i.disk_gib = None;
        i.components.clear();
        let p = create_plan(&host(), &i, 1).unwrap();
        assert_eq!(p.launch, ["images:ubuntu/24.04", "os1:dev", "-c", "user.mango.created=1"]);
        assert!(p.install.is_none());
        let remote = create_remote(&host(), "dev", &p);
        assert_eq!(&remote[4..8], ["os1:dev", "", "", ""]);
    }

    #[test]
    fn create_refuses_bad_input() {
        let bad: Vec<Box<dyn Fn(&mut EnvCreateInput)>> = vec![
            Box::new(|i| i.name = "1dev".into()),
            Box::new(|i| i.image = "images:ubuntu 24".into()),
            Box::new(|i| i.kind = "pod".into()),
            Box::new(|i| i.cpus = Some(0)),
            Box::new(|i| i.cpus = Some(65)),
            Box::new(|i| i.memory_gib = Some(513)),
            Box::new(|i| i.disk_gib = Some(3)),
            Box::new(|i| i.components = vec!["docker".into()]),
        ];
        for f in bad {
            let mut i = input();
            f(&mut i);
            assert!(create_plan(&host(), &i, 0).is_err(), "{i:?}");
        }
    }

    #[test]
    fn vm_images() {
        assert_eq!(vm_image("images:debian/12"), "images:debian/12/cloud");
        assert_eq!(vm_image("images:ubuntu/24.04/cloud"), "images:ubuntu/24.04/cloud");
        assert_eq!(vm_image("images:ubuntu/24.04/amd64"), "images:ubuntu/24.04/amd64");
        assert_eq!(vm_image("ubuntu:24.04"), "ubuntu:24.04");
    }

    #[test]
    fn joined_environment_instance() {
        let out = "image=Ubuntu 24.04.1 LTS
container=lxc
vm=none
ips=10.42.0.15 100.101.7.8 fd42::15 
ts=100.101.7.8
cpus=4
mem=8131452
";
        let i = direct_instance("dev", Some(out));
        assert_eq!((i.name.as_str(), i.kind.as_str(), i.status.as_str()), ("dev", "container", "running"));
        assert_eq!(i.ipv4, ["10.42.0.15"]);
        assert_eq!(i.tailscale_ip.as_deref(), Some("100.101.7.8"));
        assert_eq!(i.cpus, Some(4));
        assert_eq!(i.memory.as_deref(), Some("8GiB"));
        assert_eq!(i.image.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        let vm = direct_instance("dev", Some("container=none
vm=kvm
mem=524288
"));
        assert_eq!(vm.kind, "vm");
        assert_eq!(vm.memory.as_deref(), Some("512MiB"));
        let gone = direct_instance("dev", None);
        assert_eq!(gone.status, "unknown");
        assert!(gone.ipv4.is_empty() && gone.cpus.is_none());
    }

    #[test]
    fn owner_only_actions() {
        let mut h = host();
        assert!(crate::envs::owner_only(&h, "start, stop or delete this environment").is_ok());
        h.direct = Some(crate::envs::EnvDirect {
            instance: "dev".into(),
            host_key: String::new(),
            shared_from: "forge/dev".into(),
            share_id: "s".into(),
            expires_at: None,
        });
        let e = crate::envs::owner_only(&h, "start, stop or delete this environment").unwrap_err();
        assert_eq!(e, "Only the owner can start, stop or delete this environment.");
    }

    #[test]
    fn action_errors() {
        let h = host();
        assert_eq!(action_error(&h, "dev", "start", "Error: The instance is already running".into()), None);
        assert_eq!(action_error(&h, "dev", "stop", "Error: The instance is already stopped".into()), None);
        assert_eq!(action_error(&h, "dev", "delete", "Error: Failed checking instance exists \"os1:dev\": Instance not found".into()), None);
        assert_eq!(
            action_error(&h, "dev", "start", "Error: Instance not found".into()).as_deref(),
            Some("dev no longer exists on Lab.")
        );
        assert_eq!(
            action_error(&h, "dev", "start", "Error: Failed to start device \"eth0\"".into()).as_deref(),
            Some("Could not start dev: Failed to start device \"eth0\"")
        );
        assert!(final_error("Could not connect to Lab over SSH."));
        assert!(!final_error("Error: Failed shutting down instance: context deadline exceeded"));
    }

    #[test]
    fn rename_reads_status() {
        assert_eq!(info_status("Name: dev\nStatus: RUNNING\nType: container\n"), "running");
        assert_eq!(info_status("Name: dev\nStatus: STOPPED\n"), "stopped");
        assert_eq!(info_status("garbage"), "unknown");
        assert_eq!(
            action_error(&host(), "dev", "rename", "Error: Name \"web\" already in use".into()).as_deref(),
            Some("Could not rename dev: Name \"web\" already in use")
        );
    }

    #[test]
    fn resize_plans() {
        let h = host();
        let p = resize_plan(&h, "dev", &EnvResizeInput { cpus: Some(6), memory_gib: Some(16), disk_gib: Some(80) }).unwrap();
        assert_eq!(p.limits.unwrap(), ["config", "set", "os1:dev", "limits.cpu=6", "limits.memory=16GiB"]);
        assert_eq!(p.disk.as_deref(), Some("size=80GiB"));

        let p = resize_plan(&h, "dev", &EnvResizeInput { cpus: Some(2), ..Default::default() }).unwrap();
        assert_eq!(p.limits.unwrap(), ["config", "set", "os1:dev", "limits.cpu=2"]);
        assert_eq!(p.disk, None);

        let p = resize_plan(&h, "dev", &EnvResizeInput { disk_gib: Some(20), ..Default::default() }).unwrap();
        assert_eq!((p.limits, p.disk.as_deref()), (None, Some("size=20GiB")));

        assert!(resize_plan(&h, "dev", &EnvResizeInput::default()).is_err());
        assert!(resize_plan(&h, "dev", &EnvResizeInput { cpus: Some(0), ..Default::default() }).is_err());
        assert!(resize_plan(&h, "dev", &EnvResizeInput { memory_gib: Some(513), ..Default::default() }).is_err());
        assert!(resize_plan(&h, "dev", &EnvResizeInput { disk_gib: Some(3), ..Default::default() }).is_err());
        assert!(resize_plan(&h, "dev; rm", &EnvResizeInput { cpus: Some(2), ..Default::default() }).is_err());
        assert_eq!(
            resize_error(&h, "dev", "disk size", "Error: Volume cannot shrink".into()),
            "Could not change the disk size of dev: a disk can only grow. (Volume cannot shrink)"
        );
    }
}
