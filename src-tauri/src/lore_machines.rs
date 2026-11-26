//! A Lore server on a machine reached over SSH, without Incus (Settings > Lore > Set up a server).
//!
//! It runs in Docker (Epic's own image, pinned by digest: `recipes::LORE_IMAGE`) when the machine
//! has Docker on x86_64, otherwise as a systemd service (the `lore-server` recipe's own script,
//! `recipes::LORE_SERVER`, the same pinned and checksummed release). Either way it listens on the
//! address and port the user picks, and keeps its data across updates and a removal.
//!
//! Mango never handles credentials here either. A password is typed into ssh's own prompt in a
//! terminal the user watches (`lore_machine_run`), and so is sudo's: every action that changes the
//! machine runs there, once each time. Only the look before setting up (`lore_machine_probe`) runs
//! without a terminal, and only with keys. How the server is doing is checked from this computer
//! over Lore's own port (`lore_servers::lore_server_check`), which needs no SSH at all.
//!
//! Values reach the scripts as positional arguments only (`ssh::line` quotes them), after
//! [`clean`]; the scripts are constants here and in `recipes`.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::envs::lore::{parse_host_addresses, EnvHostAddress};
use crate::envs::{blocking, hosts, recipes, ssh, valid_listen_address, valid_publish_port, EnvHost};

/// Where and how a Lore server runs on a machine (saved with its entry in `lore-servers.json`;
/// no secrets: a password is never stored, only that the machine wants one).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoreMachine {
    /// `user@host`, or an alias from `~/.ssh/config`.
    pub ssh: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// A private key on this computer; none uses the user's SSH defaults (or a password).
    #[serde(default)]
    pub identity_file: Option<String>,
    /// Sign in with a password, which ssh asks for in the terminal.
    #[serde(default)]
    pub password: bool,
    /// "auto" (Docker when it can, else a service) | "docker" | "service".
    pub runtime: String,
    /// The address on the machine it listens at: an IP, or `0.0.0.0` / `[::]` for all of them.
    pub address: String,
    /// The TCP and UDP port it listens on there.
    pub listen_port: u16,
}

/// How to reach a machine, for a look at it before setting up.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoreMachineAccess {
    pub ssh: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
}

/// What a machine has, for picking how the server runs there (`lore_machine_probe`).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreMachineProbe {
    /// e.g. "Ubuntu 24.04.1 LTS".
    pub os: Option<String>,
    /// `uname -m`.
    pub arch: String,
    /// "root" (signed in as root) | "nopass" | "password" (sudo will ask) | "none" (no sudo).
    pub sudo: String,
    pub systemd: bool,
    /// An `incus` command is there: the machine could be an Environments server instead.
    pub incus: bool,
    pub docker: bool,
    /// Mango could ask Docker without a password (as this user, or through sudo without one).
    pub docker_ready: bool,
    /// Epic's image runs here (x86_64).
    pub docker_image: bool,
    /// How Mango's Lore server already runs here: "docker" | "service".
    pub installed: Option<String>,
    /// The machine's addresses, to listen at.
    pub addresses: Vec<EnvHostAddress>,
}

const RUNTIMES: [&str; 3] = ["auto", "docker", "service"];
const ACTIONS: [&str; 3] = ["setup", "restart", "remove"];

/* ---------- checking input ---------- */

/// The `EnvHost` the SSH helpers take, for a machine (never an Environments server: no id there).
fn host_of(ssh: &str, port: Option<u16>, identity_file: Option<String>) -> EnvHost {
    EnvHost {
        id: String::new(),
        name: String::new(),
        ssh: ssh.to_string(),
        port,
        identity_file,
        incus_remote: None,
        tailscale: None,
        public_address: None,
        direct: None,
    }
}

/// Check and normalise the SSH part the way a saved Environments server is (`hosts::clean`):
/// destination, port, and a key file that exists (when `strict`; a saved entry whose key went
/// missing still loads, and ssh says so when it is used).
fn clean_access(ssh: &str, port: Option<u16>, identity_file: Option<String>, strict: bool) -> Result<EnvHost, String> {
    let mut h = host_of(ssh, port, identity_file);
    if strict {
        return hosts::clean(h);
    }
    // Checked like the rest, without asking the disk.
    let key = h.identity_file.take().map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    if let Some(k) = &key {
        if k.starts_with('-') || k.chars().any(char::is_control) {
            return Err(format!("\"{k}\" is not a key file path."));
        }
    }
    let mut h = hosts::clean(h)?;
    h.identity_file = key;
    Ok(h)
}

/// One machine checked and normalised: the address as `valid_listen_address` writes it.
pub(crate) fn clean(m: LoreMachine, strict: bool) -> Result<LoreMachine, String> {
    let h = clean_access(&m.ssh, m.port, m.identity_file, strict)?;
    if m.password && h.identity_file.is_some() {
        return Err("Pick a key file or a password, not both.".into());
    }
    if !RUNTIMES.contains(&m.runtime.as_str()) {
        return Err(format!("\"{}\" is not a way to run a Lore server. Pick Docker or a service.", m.runtime));
    }
    let address = valid_listen_address(&m.address)?;
    valid_publish_port(m.listen_port)?;
    Ok(LoreMachine {
        ssh: h.ssh,
        port: h.port,
        identity_file: h.identity_file,
        password: m.password,
        runtime: m.runtime,
        address,
        listen_port: m.listen_port,
    })
}

/// The name a machine goes by in messages: its SSH host, without the user.
fn display_name(ssh: &str) -> String {
    ssh.rsplit('@').next().unwrap_or(ssh).to_string()
}

/* ---------- command lines ---------- */

/// `ssh …` for `m` in `mode`, running `remote`. A password machine never tries keys, so ssh goes
/// straight to asking for the password (in the terminal; `Mode::Batch` would only fail).
fn ssh_argv(m: &LoreMachine, mode: ssh::Mode, remote: &[String]) -> Result<Vec<String>, String> {
    let mut host = host_of(&m.ssh, m.port, m.identity_file.clone());
    host.name = display_name(&m.ssh);
    let mut args = ssh::ssh_args(&host, mode);
    if m.password {
        let dest = args.pop().unwrap_or_default();
        for o in ["PreferredAuthentications=keyboard-interactive,password", "PubkeyAuthentication=no"] {
            args.extend(["-o".into(), o.into()]);
        }
        args.push(dest);
    }
    let mut a = vec![ssh::ssh_bin()?.to_string_lossy().into_owned()];
    a.extend(args);
    a.push(ssh::line(remote));
    Ok(a)
}

/// As the SSH user (POSIX sh): hands the root script (`$1`) to bash, as root, with the rest of
/// the arguments. sudo asks for its password in the terminal when it needs one. It gets the script
/// as a private file, not as an argument: sudo logs its whole command line.
const RUN_AS_ROOT: &str = r##"set -eu
S=$1
shift
command -v bash >/dev/null 2>&1 || { printf '\nMango: this machine has no bash, which the Lore server setup needs.\n' >&2; exit 1; }
if [ "$(id -u)" = 0 ]; then exec bash -c "$S" mango-lore "$@"; fi
if ! command -v sudo >/dev/null 2>&1; then
  printf '\nMango: this needs root on %s, and this account has no sudo. Sign in as root, or install sudo.\n' "$(hostname)" >&2
  exit 1
fi
f=$(mktemp "${TMPDIR:-/tmp}/mango-lore.XXXXXX")
trap 'rm -f "$f"' EXIT
printf '%s' "$S" > "$f"
sudo -n true 2>/dev/null || printf '\nThis needs root on %s: sudo asks for your password below.\n' "$(hostname)"
sudo -- bash "$f" "$@"
"##;

/// As root (bash), after `recipes::BASICS` and `recipes::LORE_COMMON`. Arguments: ACTION RUNTIME LA LP.
const MACHINE: &str = r##"ACTION=$1 RUNTIME=$2 LA=$3 LP=$4
trap 'printf "\n\033[1;31mMango: the step above failed. Running it again is safe.\033[0m\n" >&2' ERR
C=mango-lore
VOL=mango-lore-data
UNIT=/etc/systemd/system/lore.service
DROPIN=/etc/systemd/system/lore.service.d/10-mango-listen.conf
BARE=${LA#[}
BARE=${BARE%]}
case $BARE in
  0.0.0.0) UP=127.0.0.1 ;;
  ::) UP=::1 ;;
  *) UP=$BARE ;;
esac

docker_ok() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
image_ok() { case "$(uname -m)" in x86_64|amd64) return 0 ;; esac; return 1; }
# How Mango's Lore server runs here already: docker, service, or nothing.
have() {
  if command -v docker >/dev/null 2>&1 && docker container inspect "$C" >/dev/null 2>&1; then echo docker; return 0; fi
  if [ -f "$UNIT" ]; then
    grep -q 'set up by Mango' "$UNIT" || fail "$UNIT is not one Mango set up. Mango leaves it alone: stop it and move it away first, or use another machine."
    echo service
  fi
  return 0
}
said() { [ "$1" = docker ] && echo "a Docker container ($C)" || echo "a systemd service (lore.service)"; }
# The port the server here listens on now (to tell it from another program's).
own_port() {
  case $1 in
    docker) docker container inspect -f '{{index .Config.Labels "dev.mango.lore.spec"}}' "$C" 2>/dev/null | awk '{ print $3 }' ;;
    service)
      if [ -f "$DROPIN" ]; then sed -n 's/.*(mango-listen [^ ]* \([0-9]*\)).*/\1/p' "$DROPIN"
      elif [ -f "$UNIT" ]; then echo 41337
      fi ;;
  esac
}
port_check() {
  [ "$(own_port "$1")" != "$LP" ] || return 0
  command -v ss >/dev/null 2>&1 || { echo "(ss is missing: Mango can't check that port $LP is free.)"; return 0; }
  if { ss -lunH; ss -ltnH; } 2>/dev/null | awk '{ print $4 }' | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | grep -qx "$LP"; then
    fail "port $LP is already in use on this machine (UDP or TCP). Pick another port."
  fi
}
# The server answers on its port. Accepting is not enough: Docker's proxy accepts on the host port
# before the server inside is up. Any byte back to an HTTP/2 preface (gRPC's SETTINGS, or a TLS
# alert) is the server itself; the proxy with nothing behind it closes without one.
answers() {
  ( exec 3<>"/dev/tcp/$UP/$LP"; printf 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n' >&3; IFS= read -r -t 3 -n 1 _ <&3 ) 2>/dev/null
}
wait_up() {
  for _ in $(seq 120); do
    if answers; then return 0; fi
    sleep 1
  done
  return 1
}
done_say() {
  echo "The Lore server listens on $LA port $LP (UDP and TCP). It has no sign-in: anyone who reaches that port can read and write."
}

setup_docker() {
  say "Lore server in Docker (Epic's image for $LORE_V, pinned)"
  docker_ok || fail "Docker isn't running on this machine (docker info failed). Start it, or set the server up as a service."
  image_ok || fail "Epic's Lore server image is built for x86_64, and this machine is $(uname -m). Set it up as a service instead."
  if ! docker image inspect "$LORE_IMAGE" >/dev/null 2>&1; then
    docker pull "$LORE_IMAGE" || fail "could not download Epic's Lore server image."
  fi
  install -d -m 0755 /etc/mango-lore
  if [ ! -e /etc/mango-lore/local.toml ]; then
    cat > /etc/mango-lore/local.toml <<'EOF'
# Your own settings for this Lore server: they load after the image's and win over them.
# Mango writes this file once and never changes it. Restart after a change:
#   docker restart mango-lore
EOF
    chmod 0644 /etc/mango-lore/local.toml
  fi
  docker volume create "$VOL" >/dev/null
  spec="$LORE_IMAGE $LA $LP"
  cur=$(docker container inspect -f '{{index .Config.Labels "dev.mango.lore.spec"}}' "$C" 2>/dev/null || true)
  if [ -n "$cur" ] && [ "$cur" = "$spec" ]; then
    echo "The container is up to date."
    docker start "$C" >/dev/null
  else
    if docker container inspect "$C" >/dev/null 2>&1; then
      echo "Replacing the container (its data stays in the $VOL volume)."
      docker rm -f "$C" >/dev/null
    fi
    # No capabilities, no HTTP endpoint (it serves more than the health check), data in a volume.
    docker run -d --name "$C" --restart unless-stopped \
      --cap-drop ALL --security-opt no-new-privileges \
      --label "dev.mango.lore.spec=$spec" \
      -e LORE__SERVER__HTTP__ENABLED=false \
      -v "$VOL:/data" -v /etc/mango-lore/local.toml:/etc/lore/config/local.toml:ro \
      -p "$LA:$LP:41337/udp" -p "$LA:$LP:41337/tcp" \
      "$LORE_IMAGE" >/dev/null || fail "Docker could not start the Lore server (see above)."
  fi
  if ! wait_up; then
    docker logs --tail 30 "$C" 2>&1 || true
    fail "the Lore server did not start (see above)."
  fi
  done_say
  echo "Docker publishes the port itself, past ufw's rules. A cloud provider's firewall has to allow UDP and TCP port $LP too."
}

setup_service() {
  for c in curl sha256sum tar useradd systemctl; do
    command -v "$c" >/dev/null 2>&1 || fail "$c is missing on this machine, and the Lore server service needs it."
  done
  install -d -m 0755 /etc/systemd/system/lore.service.d
  LORE_CHANGED=0
  # Where it listens; no HTTP endpoint (it serves more than the health check).
  put "$DROPIN" 0644 <<EOF && LORE_CHANGED=1
# Written by Mango: where this Lore server listens (mango-listen $LA $LP).
[Service]
Environment=LORE__SERVER__QUIC__HOST=$BARE
Environment=LORE__SERVER__QUIC__PORT=$LP
Environment=LORE__SERVER__GRPC__HOST=$BARE
Environment=LORE__SERVER__GRPC__PORT=$LP
Environment=LORE__SERVER__HTTP__ENABLED=false
EOF
  LORE_UP_HOST=$UP
  LORE_UP_PORT=$LP
  LORE_DONE=$(done_say)
  service_script
}

case $ACTION in
  setup)
    now=$(have)
    want=$RUNTIME
    if [ "$want" = auto ]; then
      if [ -n "$now" ]; then want=$now
      elif docker_ok && image_ok; then want=docker
      elif [ -d /run/systemd/system ]; then want=service
      else fail "this machine has neither Docker (running, on x86_64) nor systemd, so Mango can't run a Lore server here."
      fi
    fi
    if [ -n "$now" ] && [ "$now" != "$want" ]; then
      fail "Mango's Lore server already runs here as $(said "$now"). Remove it from Mango first (its data stays), then set it up again."
    fi
    port_check "$want"
    "setup_$want"
    ;;
  restart)
    now=$(have)
    [ -n "$now" ] || fail "Mango's Lore server isn't on this machine. Set it up again."
    say "Restarting the Lore server"
    if [ "$now" = docker ]; then docker restart "$C" >/dev/null; else systemctl restart lore.service; fi
    wait_up || fail "the Lore server did not come back on port $LP."
    done_say
    ;;
  remove)
    now=$(have)
    say "Removing the Lore server"
    case $now in
      docker)
        docker rm -f "$C" >/dev/null
        echo "Removed the container. Its data stays in the Docker volume $VOL and your settings in /etc/mango-lore."
        echo "To delete them for good:  docker volume rm $VOL && rm -r /etc/mango-lore"
        ;;
      service)
        systemctl disable --now lore.service >/dev/null 2>&1 || true
        rm -f "$UNIT" "$DROPIN" /usr/local/bin/loreserver
        rmdir /etc/systemd/system/lore.service.d 2>/dev/null || true
        systemctl daemon-reload
        echo "Removed the service. Its data stays in /var/lib/lore, your settings in /etc/lore, and the system user lore."
        echo "To delete them for good:  rm -r /var/lib/lore /etc/lore && userdel lore"
        ;;
      *) echo "Mango's Lore server isn't on this machine: nothing to remove." ;;
    esac
    ;;
  *) fail "unknown action $ACTION." ;;
esac
say "Done."
"##;

/// The root script: the basics, the pinned release, the service as a function, then [`MACHINE`].
fn root_script() -> String {
    format!(
        "set -Eeuo pipefail\nLORE_IMAGE={}\n{}{}service_script() {{\n{}}}\n{MACHINE}",
        ssh::quote(recipes::LORE_IMAGE),
        recipes::BASICS,
        recipes::LORE_COMMON,
        recipes::LORE_SERVER,
    )
}

/// The remote argv for `action` on `m` (already [`clean`]ed).
fn run_remote(m: &LoreMachine, action: &str) -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        RUN_AS_ROOT.into(),
        "mango-lore".into(),
        root_script(),
        action.into(),
        m.runtime.clone(),
        m.address.clone(),
        m.listen_port.to_string(),
    ]
}

/// A look at the machine as the SSH user, never asking for anything (POSIX sh).
const PROBE: &str = r##"set +e
os=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}")
printf 'os %s\n' "$os"
printf 'arch %s\n' "$(uname -m)"
if [ "$(id -u)" = 0 ]; then s=root
elif command -v sudo >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then s=nopass; else s=password; fi
else s=none
fi
printf 'sudo %s\n' "$s"
[ -d /run/systemd/system ] && echo 'systemd yes'
command -v incus >/dev/null 2>&1 && echo 'incus yes'
if command -v docker >/dev/null 2>&1; then
  echo 'docker yes'
  d=
  if docker info >/dev/null 2>&1; then d=docker
  elif [ "$s" = nopass ] && sudo -n docker info >/dev/null 2>&1; then d='sudo -n docker'
  fi
  if [ -n "$d" ]; then
    echo 'dockerReady yes'
    $d container inspect mango-lore >/dev/null 2>&1 && echo 'installed docker'
  fi
fi
grep -qs 'set up by Mango' /etc/systemd/system/lore.service && echo 'installed service'
echo '@@host'
ip -o addr show scope global 2>/dev/null
exit 0
"##;

pub(crate) fn parse_probe(out: &str) -> LoreMachineProbe {
    let (head, host) = out.split_once("@@host").unwrap_or((out, ""));
    let mut p = LoreMachineProbe { sudo: "none".into(), ..Default::default() };
    for line in head.lines() {
        let (k, v) = line.split_once(' ').unwrap_or((line, ""));
        let v = v.trim();
        match k {
            "os" => p.os = Some(v.to_string()).filter(|s| !s.is_empty()),
            "arch" => p.arch = v.to_string(),
            "sudo" if ["root", "nopass", "password", "none"].contains(&v) => p.sudo = v.to_string(),
            "systemd" => p.systemd = v == "yes",
            "incus" => p.incus = v == "yes",
            "docker" => p.docker = v == "yes",
            "dockerReady" => p.docker_ready = v == "yes",
            // Docker first: it is what `have` in the setup script finds first too.
            "installed" if matches!(v, "docker" | "service") && p.installed.is_none() => p.installed = Some(v.to_string()),
            _ => {}
        }
    }
    p.docker_image = matches!(p.arch.as_str(), "x86_64" | "amd64");
    p.addresses = parse_host_addresses(host.trim_start_matches('\n'), None);
    p
}

/* ---------- commands ---------- */

/// What the machine has (Docker, Incus, systemd, sudo, its addresses), as the SSH user and
/// without prompting: keys only, a password machine is looked at by the setup itself.
#[tauri::command]
pub async fn lore_machine_probe(machine: LoreMachineAccess) -> Result<LoreMachineProbe, String> {
    blocking(move || {
        let h = clean_access(&machine.ssh, machine.port, machine.identity_file, true)?;
        let m = LoreMachine {
            ssh: h.ssh.clone(),
            port: h.port,
            identity_file: h.identity_file.clone(),
            password: false,
            runtime: "auto".into(),
            address: "0.0.0.0".into(),
            listen_port: 41337,
        };
        let mut host = h;
        host.name = display_name(&m.ssh);
        let remote = ["sh".to_string(), "-c".into(), PROBE.into()];
        let argv = ssh_argv(&m, ssh::Mode::Batch, &remote)?;
        let out = run_captured(&host, &argv, Duration::from_secs(30))?;
        Ok(parse_probe(&out))
    })
    .await
}

/// Run a captured `argv` (from [`ssh_argv`]) with `ssh::explain`'s messages on failure.
fn run_captured(host: &EnvHost, argv: &[String], timeout: Duration) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Instant;
    let mut cmd = ssh::command(argv);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start ssh: {e}"))?;
    let mut so = child.stdout.take().ok_or("No output from ssh")?;
    let mut se = child.stderr.take().ok_or("No output from ssh")?;
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = so.read_to_string(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = se.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    match status {
        None => Err(format!("{} did not answer within {} s.", host.name, timeout.as_secs())),
        Some(s) if s.success() => Ok(stdout),
        Some(s) => Err(ssh::explain(host, s.code(), &stderr, &stdout)),
    }
}

/// Set up (or update, or move) the Lore server on `machine`, restart it, or remove it (its data
/// stays), in a terminal: ssh asks for a password there when the machine wants one, and so does
/// sudo. Answers the pty id.
#[tauri::command]
pub async fn lore_machine_run(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    machine: LoreMachine,
    action: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    if !ACTIONS.contains(&action.as_str()) {
        return Err(format!("\"{action}\" is not something Mango does to a Lore server."));
    }
    let m = clean(machine, true)?;
    let argv = ssh_argv(&m, ssh::Mode::Tty, &run_remote(&m, &action))?;
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine() -> LoreMachine {
        LoreMachine {
            ssh: "me@build.example.com".into(),
            port: Some(2222),
            identity_file: None,
            password: false,
            runtime: "auto".into(),
            address: "0.0.0.0".into(),
            listen_port: 41337,
        }
    }

    #[test]
    fn input_is_checked() {
        let m = clean(machine(), false).unwrap();
        assert_eq!((m.ssh.as_str(), m.port, m.address.as_str()), ("me@build.example.com", Some(2222), "0.0.0.0"));
        let v6 = clean(LoreMachine { address: "::".into(), ..machine() }, false).unwrap();
        assert_eq!(v6.address, "[::]");
        for bad in [
            LoreMachine { ssh: "-oProxyCommand=x".into(), ..machine() },
            LoreMachine { ssh: "me@host;id".into(), ..machine() },
            LoreMachine { runtime: "podman".into(), ..machine() },
            LoreMachine { address: "1.2.3.4;id".into(), ..machine() },
            LoreMachine { listen_port: 80, ..machine() },
            LoreMachine { identity_file: Some("-x".into()), ..machine() },
            LoreMachine { identity_file: Some("C:\\keys\\id".into()), password: true, ..machine() },
        ] {
            assert!(clean(bad.clone(), false).is_err(), "{bad:?}");
        }
        // A key file that isn't there: refused when setting up, kept when loading the list.
        let gone = LoreMachine { identity_file: Some("/nowhere/id_mango".into()), ..machine() };
        assert!(clean(gone.clone(), true).is_err());
        assert_eq!(clean(gone, false).unwrap().identity_file.as_deref(), Some("/nowhere/id_mango"));
    }

    #[test]
    fn command_lines() {
        let m = clean(LoreMachine { address: "100.64.0.7".into(), listen_port: 41400, ..machine() }, false).unwrap();
        let r = run_remote(&m, "setup");
        assert_eq!(&r[..2], ["sh", "-c"]);
        assert_eq!(r[2], RUN_AS_ROOT);
        assert_eq!(&r[5..], ["setup", "auto", "100.64.0.7", "41400"]);
        // The scripts never name a value from the user.
        assert!(!r[4].contains("100.64.0.7") && !r[4].contains("41400") && !r[4].contains("build.example"));
        assert!(r[4].contains(recipes::LORE_IMAGE) && r[4].contains("service_script() {"));

        let a = ssh_argv(&m, ssh::Mode::Tty, &r).unwrap();
        assert_eq!(a[a.len() - 2], "me@build.example.com");
        assert!(a.contains(&"-tt".to_string()) && a.contains(&"2222".to_string()));
        assert!(!a.iter().any(|x| x.contains("PubkeyAuthentication")));
        assert!(a.last().unwrap().ends_with(" setup auto 100.64.0.7 41400"));

        // A password: keys are never tried, and the options come before the destination.
        let p = LoreMachine { password: true, ..m };
        let a = ssh_argv(&p, ssh::Mode::Tty, &r).unwrap();
        let dest = a.iter().position(|x| x == "me@build.example.com").unwrap();
        let opt = a.iter().position(|x| x == "PubkeyAuthentication=no").unwrap();
        assert!(opt < dest && dest == a.len() - 2);
    }

    #[test]
    fn reads_the_probe() {
        let out = "os Ubuntu 24.04.1 LTS\narch x86_64\nsudo password\nsystemd yes\ndocker yes\ndockerReady yes\ninstalled docker\n\
                   @@host\n2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever\n\
                   3: docker0    inet 172.17.0.1/16 scope global docker0\\       valid_lft forever preferred_lft forever\n";
        let p = parse_probe(out);
        assert_eq!(p.os.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(p.sudo, "password");
        assert!(p.systemd && p.docker && p.docker_ready && p.docker_image && !p.incus);
        assert_eq!(p.installed.as_deref(), Some("docker"));
        assert_eq!(p.addresses.iter().map(|a| a.address.as_str()).collect::<Vec<_>>(), ["192.168.1.20"]);

        let p = parse_probe("os \narch aarch64\nsudo root\nincus yes\ninstalled service\n@@host\n");
        assert!(p.os.is_none() && !p.docker_image && p.incus && !p.docker);
        assert_eq!((p.sudo.as_str(), p.installed.as_deref()), ("root", Some("service")));
        assert_eq!(parse_probe("garbage").sudo, "none");
    }

    /// Every script parses: a broken quote would only show on a real machine.
    #[test]
    fn scripts_parse() {
        let check = crate::bin::assert_parses;
        check("sh", RUN_AS_ROOT);
        check("sh", PROBE);
        check("bash", &root_script());
    }
}
