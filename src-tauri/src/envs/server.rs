//! Incus itself on the master: install it, keep it updated, initialise it, and
//! let the SSH user use it.
//!
//! Plain Incus on Debian or Ubuntu, from the Zabbly packages the Incus project
//! recommends (<https://github.com/zabbly/incus>, the `stable` repository).
//! The setup runs as one terminal session the user watches, because `sudo` may
//! ask for a password: `ssh -tt master sh -c USER_SCRIPT mango-server-setup ROOT_SCRIPT`.
//! The user-side script picks `sudo` (or nothing, as root) and runs the
//! root-side script, which is idempotent: run again, it updates Incus and
//! leaves an initialised server alone. Both scripts are constants; the only
//! value they take (the user to grant access to) is computed on the server.
//!
//! `env_probe` (in `hosts.rs`) reports what this setup would do, using the same
//! shell helpers (`SH_COMMON`) so both agree on what is supported.

use tauri::{AppHandle, State};

use super::recipes::MASTER_PRELUDE;
use super::{hosts, ssh, EnvHost};

/// The Zabbly signing key (`https://pkgs.zabbly.com/key.asc`), as documented in
/// the zabbly/incus README: `4EFC 5906 96CB 15B8 7C73  A3AD 82CC 8797 C838 DCFD`.
pub(crate) const ZABBLY_KEY_FINGERPRINT: &str = "4EFC590696CB15B87C73A3AD82CC8797C838DCFD";

/// POSIX sh helpers shared by the probe and the setup.
pub(crate) const SH_COMMON: &str = r##"# The local daemon, whatever the user's default remote is.
ic() { incus --force-local "$@"; }
# The Zabbly suite for this release (Zabbly builds Incus for these), from /etc/os-release
# (already sourced). Derivatives qualify through UBUNTU_CODENAME / DEBIAN_CODENAME.
zabbly_suite() {
  for c in "${VERSION_CODENAME:-}" "${UBUNTU_CODENAME:-}" "${DEBIAN_CODENAME:-}"; do
    case "$c" in jammy|noble|resolute|bookworm|trixie) echo "$c"; return 0 ;; esac
  done
  return 1
}
# The default profile's devices: DEVS (names), HAS_ROOT (a disk at /), HAS_NIC (a nic). 1 or empty.
default_devices() {
  HAS_ROOT= HAS_NIC= DEVS=$(ic profile device list default 2>/dev/null || true)
  for d in $DEVS; do
    case "$(ic profile device get default "$d" type 2>/dev/null || true)" in
      disk) [ "$(ic profile device get default "$d" path 2>/dev/null || true)" = / ] && HAS_ROOT=1 ;;
      nic) HAS_NIC=1 ;;
    esac
  done
  return 0
}
# Whether a daemon is installed here (not just the client).
has_daemon() {
  [ -S /run/incus/unix.socket ] || [ -S /var/lib/incus/unix.socket ] \
    || systemctl cat incus.socket >/dev/null 2>&1 || systemctl cat incus.service >/dev/null 2>&1
}
"##;

/// Run by the SSH user: become root (sudo unless already root) and run `$1`, the root-side script.
const USER_SIDE: &str = r##"ROOT_SCRIPT=$1
ME=$(id -un)
if [ "$(id -u)" = 0 ]; then
  set -- sh
else
  command -v sudo >/dev/null 2>&1 \
    || fail "sudo is not installed on this server, and $ME is not root. Install sudo and give $ME sudo rights (as root: apt-get install sudo; usermod -aG sudo $ME), or connect as root."
  say "Setting up Incus needs root: sudo may ask for $ME's password"
  set -- sudo sh
fi
"$@" -c "$ROOT_SCRIPT" mango-server-setup "$ME" || {
  rc=$?
  printf '\n\033[1;31mMango: setting up Incus did not finish (exit %s). See the output above; running the setup again is safe.\033[0m\n' "$rc" >&2
  exit "$rc"
}
"##;

/// Run as root with `$1` = the SSH user. Installs or updates, starts, initialises, grants access.
const ROOT_SIDE: &str = r##"TARGET=$1
ZABBLY_KEY_FPR=@FPR@
ZABBLY_KEYRING=/etc/apt/keyrings/zabbly.asc
ZABBLY_SOURCES=/etc/apt/sources.list.d/zabbly-incus-stable.sources
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a LANG=C.UTF-8
[ "$(id -u)" = 0 ] || fail "the setup has to run as root."
[ -d /run/systemd/system ] || fail "Incus needs systemd, and this server does not run it."
command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1 \
  || fail "this server has no apt-get. Mango sets up Incus on Debian and Ubuntu only."
PRETTY_NAME= NAME= VERSION_CODENAME= UBUNTU_CODENAME= DEBIAN_CODENAME=
[ -r /etc/os-release ] && . /etc/os-release
OS=${PRETTY_NAME:-${NAME:-this system}}

apt_get() { apt-get -y -q -o DPkg::Lock::Timeout=300 "$@"; }
APT_FRESH=
apt_update() {
  [ -z "$APT_FRESH" ] || return 0
  for _ in 1 2 3 4 5; do
    if apt_get update; then APT_FRESH=1; return 0; fi
    echo "apt-get update failed (another apt run may hold the lock). Retrying in 10 s..."
    sleep 10
  done
  fail "apt-get update kept failing. Check the server's network and its apt sources."
}
pkg_installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" = "install ok installed" ]; }
TMPD=$(mktemp -d) || fail "could not create a temporary folder."
trap 'rm -rf "$TMPD"' EXIT

add_zabbly() {
  SUITE=$(zabbly_suite) || fail "$OS is not supported: Incus packages from Zabbly exist for Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04 LTS."
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in amd64|arm64) ;; *) fail "Incus packages from Zabbly are built for amd64 and arm64; this server is $ARCH." ;; esac
  say "Adding the Incus package repository (Zabbly, stable, $SUITE)"
  apt_update
  apt_get install --no-install-recommends ca-certificates curl gnupg
  curl -fsSL https://pkgs.zabbly.com/key.asc -o "$TMPD/key.asc" || fail "could not download Zabbly's signing key."
  mkdir -m 0700 "$TMPD/gnupg"
  # The primary key fingerprint of every key in the file: exactly the one we expect.
  FPR=$(GNUPGHOME="$TMPD/gnupg" gpg --batch --with-colons --show-keys "$TMPD/key.asc" 2>/dev/null \
    | awk -F: '$1 == "pub" { p = 1; next } p && $1 == "fpr" { print $10; p = 0 }') || FPR=
  [ "$FPR" = "$ZABBLY_KEY_FPR" ] \
    || fail "Zabbly's signing key does not have the documented fingerprint ($ZABBLY_KEY_FPR; got: ${FPR:-none}), so Mango did not trust it. See https://github.com/zabbly/incus."
  echo "Signing key verified: $ZABBLY_KEY_FPR"
  install -d -m 0755 /etc/apt/keyrings
  install -m 0644 "$TMPD/key.asc" "$ZABBLY_KEYRING"
  cat > "$ZABBLY_SOURCES" <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: $SUITE
Components: main
Architectures: $ARCH
Signed-By: $ZABBLY_KEYRING
EOF
  APT_FRESH=
}

# 1. Install or update.
if pkg_installed incus; then
  say "Updating Incus (installed: $(incus --version 2>/dev/null || echo unknown))"
  apt_update
  apt_get install --only-upgrade incus
elif command -v incus >/dev/null 2>&1 && has_daemon; then
  say "Incus $(incus --version 2>/dev/null) was installed outside apt: Mango leaves the installation alone"
else
  add_zabbly
  say "Installing Incus"
  apt_update
  apt_get install incus
fi
command -v incus >/dev/null 2>&1 || fail "the incus command is missing after the install."

# 2. Run the daemon (socket-activated; also started at boot by the package's units).
say "Starting the Incus daemon"
systemctl enable --now incus.socket || fail "could not start incus.socket. See: systemctl status incus.socket"
ic admin waitready --timeout=120 || fail "the Incus daemon did not come up. See: journalctl -u incus"

# 3. Initialise: only what is missing. Existing pools, networks and devices are never changed.
POOL=$(ic storage list --format csv 2>/dev/null | head -n 1 | cut -d, -f1) || POOL=
default_devices
if [ -n "$POOL" ] && [ -n "$HAS_ROOT" ]; then
  say "Incus is already initialised (storage pool $POOL)"
  echo "Mango leaves its storage, networks and profiles as they are."
else
  say "Initialising Incus"
  PRESEED=
  if [ -z "$POOL" ]; then
    POOL=default
    DRIVER=dir
    # A loop-backed btrfs pool: 30% of the free space, 10 to 200 GiB (a sparse file, it grows as used).
    install -d /var/lib/incus
    avail=$(df -Pk /var/lib/incus 2>/dev/null | awk 'NR == 2 { print $4 }') || avail=
    case "$avail" in ''|*[!0-9]*) avail=0 ;; esac
    gib=$((avail * 3 / 10 / 1048576))
    [ "$gib" -le 200 ] || gib=200
    if [ "$gib" -ge 10 ]; then
      command -v mkfs.btrfs >/dev/null 2>&1 || { apt_update; apt_get install --no-install-recommends btrfs-progs || true; }
      if command -v mkfs.btrfs >/dev/null 2>&1 && { grep -qw btrfs /proc/filesystems || modprobe btrfs 2>/dev/null; }; then
        DRIVER=btrfs
      fi
    fi
    if [ "$DRIVER" = btrfs ]; then
      echo "Storage: pool default, btrfs, up to $gib GiB (a sparse file in /var/lib/incus/disks)."
      PRESEED="storage_pools:
- name: default
  driver: btrfs
  config:
    size: ${gib}GiB
"
    else
      echo "Storage: pool default, a plain folder in /var/lib/incus/storage-pools/default (btrfs is not available or the disk is small)."
      PRESEED="storage_pools:
- name: default
  driver: dir
"
    fi
  fi
  DEVICES=
  if [ -z "$HAS_ROOT" ]; then
    case " $(echo $DEVS) " in *" root "*) dev=mango-root ;; *) dev=root ;; esac
    echo "Default profile: root disk on pool $POOL."
    DEVICES="$DEVICES    $dev:
      type: disk
      path: /
      pool: $POOL
"
  fi
  if [ -z "$HAS_NIC" ]; then
    if ic network show incusbr0 >/dev/null 2>&1; then
      echo "Network: using the existing bridge incusbr0."
    else
      echo "Network: bridge incusbr0 with NAT (IPv4, automatic subnet)."
      PRESEED="${PRESEED}networks:
- name: incusbr0
  type: bridge
  config:
    ipv4.address: auto
    ipv4.nat: 'true'
    ipv6.address: none
"
    fi
    case " $(echo $DEVS) " in *" eth0 "*) dev=mango-eth0 ;; *) dev=eth0 ;; esac
    echo "Default profile: network card eth0 on incusbr0."
    DEVICES="$DEVICES    $dev:
      type: nic
      name: eth0
      network: incusbr0
"
  fi
  PRESEED="${PRESEED}profiles:
- name: default
  devices:
$DEVICES"
  printf '%s' "$PRESEED" | ic admin init --preseed || fail "incus admin init failed (see above)."
  default_devices
  [ -n "$HAS_ROOT" ] || fail "the default profile still has no root disk after initialising."
fi

# 4. Let the SSH user talk to the daemon.
if [ "$TARGET" != root ]; then
  id -u "$TARGET" >/dev/null 2>&1 || fail "there is no user $TARGET on this server."
  getent group incus-admin >/dev/null 2>&1 || fail "the incus-admin group is missing; the Incus package should have created it."
  if id -nG "$TARGET" | tr ' ' '\n' | grep -qx incus-admin; then
    echo "$TARGET is in incus-admin."
  else
    say "Letting $TARGET use Incus"
    usermod -aG incus-admin "$TARGET" || fail "could not add $TARGET to the incus-admin group."
    echo "Added $TARGET to incus-admin. It applies to new SSH sessions, which is every later Mango action."
  fi
fi

# 5. Things that commonly break instance networking.
if command -v docker >/dev/null 2>&1; then
  echo "Note: Docker is installed. Its firewall rules can cut Incus instances off the network; if that happens see https://linuxcontainers.org/incus/docs/main/howto/network_bridge_firewalld/"
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  echo "Note: ufw is active. If instances get no address, allow the bridge: ufw allow in on incusbr0; ufw route allow in on incusbr0; ufw route allow out on incusbr0"
fi

V=$(ic version 2>/dev/null | sed -n 's/^Server version: *//p') || V=
say "Incus ${V:-} is ready"
"##;

/// The root-side script, complete.
pub(crate) fn root_script() -> String {
    format!("{MASTER_PRELUDE}{SH_COMMON}{}", ROOT_SIDE.replace("@FPR@", ZABBLY_KEY_FINGERPRINT))
}

/// The user-side script, complete.
pub(crate) fn user_script() -> String {
    format!("{MASTER_PRELUDE}{USER_SIDE}")
}

/// The remote argv (for `ssh::argv`) running the setup.
pub(crate) fn setup_remote() -> Vec<String> {
    vec!["sh".into(), "-c".into(), user_script(), "mango-server-setup".into(), root_script()]
}

/// The full `ssh` argv for `host`.
pub(crate) fn setup_argv(host: &EnvHost) -> Result<Vec<String>, String> {
    ssh::argv(host, ssh::Mode::Tty, &setup_remote())
}

#[tauri::command]
pub async fn env_server_setup(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let host = hosts::get(&app, &host_id)?;
    super::owner_only(&host, "set up the server of this environment")?;
    let argv = setup_argv(&host)?;
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_script_has_the_steps() {
        let s = root_script();
        assert!(s.starts_with("set -eu\n"));
        assert!(!s.contains("@FPR@"));
        assert!(s.contains("ZABBLY_KEY_FPR=4EFC590696CB15B87C73A3AD82CC8797C838DCFD\n"));
        assert!(s.contains("https://pkgs.zabbly.com/key.asc"));
        assert!(s.contains("URIs: https://pkgs.zabbly.com/incus/stable"));
        assert!(s.contains("/etc/apt/sources.list.d/zabbly-incus-stable.sources"));
        assert!(s.contains("Signed-By: $ZABBLY_KEYRING"));
        assert!(s.contains("apt_get install --only-upgrade incus"));
        assert!(s.contains("DPkg::Lock::Timeout=300"));
        assert!(s.contains("DEBIAN_FRONTEND=noninteractive"));
        // Preseed: pool, bridge with NAT, default profile devices.
        assert!(s.contains("ic admin init --preseed"));
        assert!(s.contains("storage_pools:\n- name: default\n  driver: btrfs\n  config:\n    size: ${gib}GiB\n"));
        assert!(s.contains("  driver: dir\n"));
        assert!(s.contains("- name: incusbr0\n  type: bridge\n  config:\n    ipv4.address: auto\n    ipv4.nat: 'true'\n"));
        assert!(s.contains("      type: disk\n      path: /\n      pool: $POOL\n"));
        assert!(s.contains("      type: nic\n      name: eth0\n      network: incusbr0\n"));
        // Steps in order: install, daemon, init, access.
        let at = |needle: &str| s.find(needle).unwrap_or_else(|| panic!("{needle}"));
        assert!(at("# 1. Install") < at("# 2. Run") && at("# 2. Run") < at("# 3. Init") && at("# 3. Init") < at("# 4. Let"));
        assert!(s.contains("usermod -aG incus-admin \"$TARGET\""));
        assert!(s.contains("systemctl enable --now incus.socket"));
        assert!(s.contains("say \"Incus ${V:-} is ready\""));
    }

    #[test]
    fn user_script_uses_sudo_unless_root() {
        let s = user_script();
        assert!(s.starts_with("set -eu\n"));
        assert!(s.contains("if [ \"$(id -u)\" = 0 ]; then\n  set -- sh\n"));
        assert!(s.contains("set -- sudo sh\n"));
        assert!(s.contains("command -v sudo"));
        assert!(s.contains("\"$@\" -c \"$ROOT_SCRIPT\" mango-server-setup \"$ME\""));
    }

    #[test]
    fn setup_line_is_quoted_and_fits_windows() {
        let remote = setup_remote();
        assert_eq!(&remote[..2], ["sh", "-c"]);
        assert_eq!(remote[3], "mango-server-setup");
        assert_eq!(remote.len(), 5, "nothing from the webview goes into the setup");
        let l = ssh::line(&remote);
        assert!(l.starts_with("sh -c 'set -eu\n"), "{l}");
        assert!(l.is_ascii(), "keep scripts ASCII: they cross Windows argv conversion");
        let windows = l.len() + l.matches(['"', '\\']).count() + 300;
        assert!(windows < 30_000, "{windows}");
    }

    /// `sh -n` the scripts when a POSIX shell is around (dash on Debian/Ubuntu CI, Git's sh on Windows).
    #[test]
    fn scripts_parse() {
        use std::io::Write;
        let Some(sh) = ["dash", "sh"].iter().find_map(|s| crate::bin::find(s)) else {
            eprintln!("no sh found; skipping");
            return;
        };
        for (name, script) in [
            ("user", user_script()),
            ("root", root_script()),
            ("probe", format!("{SH_COMMON}{}", hosts::PROBE)),
        ] {
            // Through stdin: MSYS/Cygwin shells re-parse a Windows command line with their own quoting rules.
            let mut child = std::process::Command::new(&sh)
                .arg("-n")
                .stdin(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("run sh");
            child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stderr));
        }
    }
}
