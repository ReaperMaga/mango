//! One-click components for an instance and their install/update scripts.
//!
//! Every script is a constant here; the webview only names component ids. The
//! only values interpolated into a script are validated ones (instance name,
//! Tailscale tags), and they go through `ssh::quote`. All scripts are
//! idempotent, so "install" doubles as "update". Debian/Ubuntu (apt) only.
//!
//! An install runs as one terminal session: `ssh -tt master sh -c MASTER …`,
//! where the master-side script (POSIX sh) prepares what only the master can
//! (the `/dev/net/tun` device, the Tailscale auth key) and then runs
//! `incus exec T -t -- bash -c SCRIPT` with the instance-side script below.
//!
//! A joined environment (`EnvHost::direct`) has no master: the instance-side
//! script runs through `sudo -n` there (`ssh::in_instance`), with no master-side
//! preparation (no `/dev/net/tun` device, no auth key file).
//!
//! The desktop is a contract with `remote.rs`: `mango-vnc.service` (Xvnc :1 on
//! 127.0.0.1:5901, no VNC password, XFCE session) and `mango-novnc.service`
//! (websockify serving /usr/share/novnc on 127.0.0.1:6080 -> 5901).
//!
//! Docker in an Incus container needs nesting: before installing it, the master turns on
//! `security.nesting` and the mknod/setxattr syscall interception for a container that lacks
//! them and restarts it once (`MASTER_INSTALL`; a new container gets them at launch, see
//! `incus::create_plan`). A VM needs nothing. A joined environment has no master to ask, so the
//! script says what the server's owner has to change when Docker does not start.
//!
//! Chromium is for the agents, not for people: Playwright's headless Chromium in
//! `/opt/mango/ms-playwright` (installed by the Playwright that `@playwright/mcp` brings, so the
//! two always match) and `/usr/local/bin/mango-chromium-mcp`, which starts that MCP server. It is
//! registered as `chromium` in the agent user's Claude Code and Codex configs, so every chat in
//! the environment can open pages, read them and take screenshots without anyone watching. The
//! Claude Code and Codex recipes register it too, for when they come after it.
//!
//! Node.js and Java take a version the user picks (`install_plan`'s `versions`, checked by
//! `valid_node_version` / `valid_java_version` and handed over quoted as `MANGO_NODE_VERSION` /
//! `MANGO_JAVA_VERSION`); without one they install the current LTS, or keep what is there on an
//! update. Node.js is the official build from nodejs.org (checked against its SHASUMS256.txt) in
//! /usr/local, replacing an earlier NodeSource package unless something still runs on it. Java is
//! SDKMAN for the agent user, with its current JDK on every login shell's PATH
//! (`/etc/profile.d/mango-java.sh`). `env_versions` lists what can be picked, read on this computer
//! from nodejs.org's index and SDKMAN's API (Linux x64 builds).

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{hosts, ssh, valid_instance, valid_java_version, valid_master_path, valid_node_version, valid_tag, EnvHost};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvComponent {
    /// "base" | "claude" | "codex" | "gh" | "node" | "java" | "chromium" | "desktop" | "docker" | "tailscale"
    pub id: String,
    pub name: String,
    pub description: String,
    pub installed: bool,
    pub version: Option<String>,
    /// Components this one needs first (installed along with it).
    pub requires: Vec<String>,
    /// A version can be picked for it (`env_versions` lists them).
    pub versioned: bool,
}

pub(crate) struct Recipe {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub requires: &'static [&'static str],
    script: &'static str,
    /// The script variable that carries a picked version, for components that take one.
    version_var: Option<&'static str>,
}

/// In install order: a recipe only requires recipes listed before it.
pub(crate) const RECIPES: &[Recipe] = &[
    Recipe {
        id: "base",
        name: "Base system",
        description: "The agent user with passwordless sudo, git, curl, build tools and a work folder.",
        requires: &[],
        script: BASE,
        version_var: None,
    },
    Recipe {
        id: "node",
        name: "Node.js",
        description: "Node.js and npm, official builds from nodejs.org: the current LTS, or the version you pick.",
        requires: &["base"],
        script: NODE,
        version_var: Some("MANGO_NODE_VERSION"),
    },
    Recipe {
        id: "java",
        name: "Java",
        description: "A JDK through SDKMAN, for the agent user: the current Temurin LTS, or any vendor and version you pick.",
        requires: &["base"],
        script: JAVA,
        version_var: Some("MANGO_JAVA_VERSION"),
    },
    Recipe {
        id: "gh",
        name: "GitHub CLI",
        description: "gh, from GitHub's apt repository.",
        requires: &["base"],
        script: GH,
        version_var: None,
    },
    Recipe {
        id: "claude",
        name: "Claude Code",
        description: "Anthropic's coding agent, installed for the agent user.",
        requires: &["base"],
        script: CLAUDE,
        version_var: None,
    },
    Recipe {
        id: "codex",
        name: "Codex",
        description: "OpenAI's coding agent, installed for the agent user.",
        requires: &["base"],
        script: CODEX,
        version_var: None,
    },
    Recipe {
        id: "chromium",
        name: "Chromium for agents",
        description: "A headless Chromium the agents drive through Playwright's MCP server: they open pages, read them and take screenshots.",
        requires: &["base", "node"],
        script: CHROMIUM,
        version_var: None,
    },
    Recipe {
        id: "desktop",
        name: "Desktop",
        description: "An XFCE desktop you can open from Mango (VNC and noVNC, reachable only through Mango).",
        requires: &["base"],
        script: DESKTOP,
        version_var: None,
    },
    Recipe {
        id: "docker",
        name: "Docker",
        description: "Docker Engine with Compose and Buildx, from Docker's apt repository; the agent user can run it. A container gets nesting turned on first, which restarts it once.",
        requires: &["base"],
        script: DOCKER,
        version_var: None,
    },
    Recipe {
        id: "tailscale",
        name: "Tailscale",
        description: "Joins the environment to your tailnet, with Tailscale SSH.",
        requires: &["base"],
        script: TAILSCALE,
        version_var: None,
    },
];

/* ---------- instance-side scripts (bash, run as root) ---------- */

const HEADER: &str = r##"export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a LANG=C.UTF-8
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mMango: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'rm -f /run/mango-tailscale-authkey' EXIT
trap 'printf "\n\033[1;31mMango: the step above failed. Running the install again is safe.\033[0m\n" >&2' ERR
[ "$(id -u)" = 0 ] || fail "the install script has to run as root."
command -v apt-get >/dev/null 2>&1 || fail "this environment has no apt-get. Mango's components install on Debian and Ubuntu images only."
apt_get() { apt-get -y -q -o DPkg::Lock::Timeout=300 "$@"; }
APT_FRESH=
apt_update() {
  [ -z "$APT_FRESH" ] || return 0
  local i
  for i in 1 2 3 4 5; do
    if apt_get update; then APT_FRESH=1; return 0; fi
    echo "apt-get update failed (another apt run may hold the lock). Retrying in 10 s..."
    sleep 10
  done
  fail "apt-get update kept failing. Check the network inside the environment."
}
apt_install() { apt_update; apt_get install --no-install-recommends "$@"; }
as_agent() {
  id -u agent >/dev/null 2>&1 || fail "the agent user is missing. Install the base component first."
  runuser -u agent -- env HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash bash -lc "set -o pipefail; cd ~; $1"
}
# put PATH MODE < content: write when different; succeeds only when the file changed.
# (Called as `put ... && changed=1`, where errexit is off: failures go through fail.)
put() {
  local tmp; tmp=$(mktemp) || fail "could not create a temporary file."
  cat > "$tmp" || fail "could not write a temporary file."
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 1; fi
  install -m "$2" "$tmp" "$1" || { rm -f "$tmp"; fail "could not write $1."; }
  rm -f "$tmp"
}
need_systemd() { [ -d /run/systemd/system ] || fail "$1 needs systemd running in the environment."; }
# Tell the agent, in a CLI's global instructions file ($1), how to show a picture in Mango's chat. Once.
picture_note() {
  grep -qs 'mango-pictures' "$1" && return 0
  local dir; dir=$(dirname "$1")
  [ -d "$dir" ] || install -d -o agent -g "$(id -gn agent)" -m 0700 "$dir"
  cat >> "$1" <<'EOF'

<!-- mango-pictures: added by Mango -->
## Showing pictures
When the user asks to see a screenshot or picture, save it as a file outside the project (for example under /tmp) and put it in your reply as markdown with its absolute path: `![what it shows](/tmp/shot.png)`. Mango shows the picture in the chat.
EOF
  chown agent:"$(id -gn agent)" "$1"
}
# Register the Chromium MCP server (when it is installed) with the agent user's Claude Code and Codex.
register_chromium() {
  [ -x /usr/local/bin/mango-chromium-mcp ] || return 0
  if as_agent 'command -v claude' >/dev/null 2>&1; then
    as_agent 'claude mcp remove --scope user chromium >/dev/null 2>&1; claude mcp add --scope user chromium -- /usr/local/bin/mango-chromium-mcp' \
      || fail "could not add the Chromium MCP server to Claude Code."
    picture_note /home/agent/.claude/CLAUDE.md
    echo "Claude Code has the chromium MCP server."
  fi
  if as_agent 'command -v codex' >/dev/null 2>&1; then
    local cfg=/home/agent/.codex/config.toml
    if ! grep -qs '^\[mcp_servers\.chromium\]' "$cfg"; then
      [ -d /home/agent/.codex ] || install -d -o agent -g "$(id -gn agent)" -m 0700 /home/agent/.codex
      printf '\n# Added by Mango: a headless Chromium for the agent (pages, screenshots).\n[mcp_servers.chromium]\ncommand = "/usr/local/bin/mango-chromium-mcp"\nstartup_timeout_sec = 30\n' >> "$cfg"
      chown agent:"$(id -gn agent)" "$cfg"
    fi
    picture_note /home/agent/.codex/AGENTS.md
    echo "Codex has the chromium MCP server."
  fi
}
"##;

const BASE: &str = r##"say "Base system: the agent user, git, curl and build tools"
apt_install sudo git curl ca-certificates gnupg build-essential unzip xz-utils jq socat locales less procps openssh-client tar
if ! grep -qs '^en_US.UTF-8 UTF-8' /etc/locale.gen; then
  if grep -qs '^# *en_US.UTF-8 UTF-8' /etc/locale.gen; then
    sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
  else
    echo 'en_US.UTF-8 UTF-8' >> /etc/locale.gen
  fi
fi
locale -a 2>/dev/null | grep -qiE '^en_US\.utf-?8$' || locale-gen en_US.UTF-8
update-locale LANG=en_US.UTF-8 >/dev/null 2>&1 || true
if ! id -u agent >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/agent --shell /bin/bash agent
  echo "Created the user agent."
fi
grp=$(id -gn agent)
[ -d /home/agent ] || install -d -o agent -g "$grp" -m 0750 /home/agent
install -d -o agent -g "$grp" -m 0755 /home/agent/.local /home/agent/.local/bin /home/agent/work
echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-mango-agent
chmod 0440 /etc/sudoers.d/90-mango-agent
cat > /etc/profile.d/mango-path.sh <<'EOF'
# Added by Mango: per-user tools (Claude Code, Codex) live in ~/.local/bin.
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
export PATH
EOF
echo "The agent user works in /home/agent/work."
"##;

const NODE: &str = r##"say "Node.js (official build from nodejs.org)"
case "$(uname -m)" in
  x86_64|amd64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail "nodejs.org has no Linux build of Node.js for $(uname -m)." ;;
esac
node_want=${MANGO_NODE_VERSION:-}
node_had=
[ -x /usr/local/bin/node ] && node_had=$(/usr/local/bin/node --version 2>/dev/null || true)
# An update without a picked version keeps the release line that is installed (the newest of its major).
if [ -z "$node_want" ] && [ -n "$node_had" ]; then node_want=${node_had#v}; node_want=${node_want%%.*}; fi
node_tmp=$(mktemp -d)
curl -fsSL https://nodejs.org/dist/index.json -o "$node_tmp/index.json"
if [ -z "$node_want" ]; then
  node_v=$(jq -r --arg a "linux-$node_arch" '[.[] | select(.lts != false and (.version | test("-") | not) and (.files | any(. == $a)))][0].version // empty' "$node_tmp/index.json")
  [ -n "$node_v" ] || fail "could not find the current Node.js LTS in nodejs.org's index."
else
  node_v=$(jq -r --arg w "v$node_want" --arg a "linux-$node_arch" '[.[] | select((.version == $w or (.version | startswith($w + "."))) and (.version | test("-") | not) and (.files | any(. == $a)))][0].version // empty' "$node_tmp/index.json")
  [ -n "$node_v" ] || fail "nodejs.org has no Linux $node_arch build of Node.js $node_want."
fi
if [ "$node_had" = "$node_v" ]; then
  echo "Node.js $node_v is installed and up to date."
else
  node_file="node-$node_v-linux-$node_arch.tar.xz"
  echo "Downloading $node_file"
  curl -fsSL "https://nodejs.org/dist/$node_v/$node_file" -o "$node_tmp/$node_file"
  curl -fsSL "https://nodejs.org/dist/$node_v/SHASUMS256.txt" -o "$node_tmp/SHASUMS256.txt"
  grep "  $node_file\$" "$node_tmp/SHASUMS256.txt" > "$node_tmp/sum" || fail "nodejs.org lists no checksum for $node_file."
  (cd "$node_tmp" && sha256sum -c --quiet sum) || fail "$node_file does not match nodejs.org's checksum. Nothing was changed."
  # npm and corepack come with Node.js: replace them whole rather than unpack over an older copy.
  rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
  tar -xJf "$node_tmp/$node_file" -C /usr/local --strip-components=1 --no-same-owner
  hash -r
fi
rm -rf "$node_tmp"
# Mango used NodeSource's package before: remove it, unless Chromium for agents still runs on it
# or another package needs it (dpkg refuses then).
if dpkg-query -W -f='${Version}' nodejs 2>/dev/null | grep -q nodesource; then
  if grep -qs '/usr/bin/node' /usr/local/bin/mango-chromium-mcp; then
    echo "Kept the earlier Node.js package from NodeSource: Chromium for agents runs on it. Updating Chromium for agents moves it to this Node.js."
  elif dpkg --purge nodejs; then
    rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources /etc/apt/keyrings/nodesource.gpg /usr/share/keyrings/nodesource.gpg
    echo "Removed the earlier Node.js package from NodeSource."
  else
    echo "Kept the earlier Node.js package from NodeSource: other packages need it. /usr/local/bin/node comes first on the PATH."
  fi
fi
echo "Node.js $(/usr/local/bin/node --version), npm $(/usr/local/bin/npm --version)"
"##;

const JAVA: &str = r##"say "Java (SDKMAN, for the agent user)"
apt_install zip unzip curl ca-certificates
sdk_init='source ~/.sdkman/bin/sdkman-init.sh'
if [ -s /home/agent/.sdkman/bin/sdkman-init.sh ]; then
  as_agent "$sdk_init && sdk selfupdate" || echo "SDKMAN could not update itself; carrying on with this copy."
else
  as_agent 'curl -fsSL "https://get.sdkman.io?ci=true&rcupdate=true" | bash'
  [ -s /home/agent/.sdkman/bin/sdkman-init.sh ] || fail "SDKMAN did not install into /home/agent/.sdkman."
fi
# Never stop to ask (yes to "make it the default?"), and let Mango's Update be what updates SDKMAN.
sdk_cfg=/home/agent/.sdkman/etc/config
touch "$sdk_cfg"
for kv in sdkman_auto_answer=true sdkman_selfupdate_feature=false; do
  if grep -q "^${kv%%=*}=" "$sdk_cfg"; then sed -i "s/^${kv%%=*}=.*/$kv/" "$sdk_cfg"; else echo "$kv" >> "$sdk_cfg"; fi
done
chown agent:"$(id -gn agent)" "$sdk_cfg"
java_dir=/home/agent/.sdkman/candidates/java
java_had=$(readlink "$java_dir/current" 2>/dev/null || true)
java_had=${java_had%/}
java_had=${java_had##*/}
java_want=${MANGO_JAVA_VERSION:-}
if [ -n "$java_want" ]; then
  java_q=$(printf %q "$java_want")
  if [ -d "$java_dir/$java_want" ]; then
    echo "Java $java_want is installed already."
  else
    as_agent "$sdk_init && sdk install java $java_q"
  fi
  [ -d "$java_dir/$java_want" ] || fail "SDKMAN did not install Java $java_want (see above). Pick another version, or try again."
  as_agent "$sdk_init && sdk default java $java_q"
elif [ -n "$java_had" ]; then
  echo "Keeping Java $java_had. Pick a version in Mango to install another one or switch to it."
else
  echo "Installing SDKMAN's default Java (the current Temurin LTS)."
  as_agent "$sdk_init && sdk install java"
fi
put /etc/profile.d/mango-java.sh 0644 <<'EOF' || true
# Added by Mango: SDKMAN's current Java for every login shell (the sdk command itself comes with ~/.bashrc).
if [ -d "$HOME/.sdkman/candidates/java/current" ]; then
  JAVA_HOME="$HOME/.sdkman/candidates/java/current"
  case ":$PATH:" in *":$JAVA_HOME/bin:"*) ;; *) PATH="$JAVA_HOME/bin:$PATH" ;; esac
  export JAVA_HOME PATH
fi
EOF
as_agent 'java -version 2>&1 | head -n 1'
"##;

const GH: &str = r##"say "GitHub CLI (from GitHub's apt repository)"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /tmp/mango-gh.gpg
install -m 0644 /tmp/mango-gh.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg
rm -f /tmp/mango-gh.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt_get update
APT_FRESH=1
apt_get install gh
gh --version | head -n 1
"##;

const CLAUDE: &str = r##"say "Claude Code (install or update)"
as_agent 'curl -fsSL https://claude.ai/install.sh | bash'
as_agent 'claude --version'
register_chromium
"##;

const CODEX: &str = r##"say "Codex (install or update)"
as_agent 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'
as_agent 'codex --version'
register_chromium
"##;

const CHROMIUM: &str = r##"say "Chromium for agents: headless Chromium and Playwright's MCP server"
command -v npm >/dev/null 2>&1 || fail "npm is missing. Install the Node.js component first."
npm install -g --no-fund --no-audit --loglevel=error @playwright/mcp@latest
mcp=$(npm root -g)/@playwright/mcp
[ -f "$mcp/cli.js" ] || fail "the Playwright MCP server did not install into $mcp."
pw=$(node -p 'require("path").dirname(require.resolve("playwright/package.json", { paths: [process.argv[1]] }))' "$mcp")/cli.js
export PLAYWRIGHT_BROWSERS_PATH=/opt/mango/ms-playwright
install -d -m 0755 /opt/mango "$PLAYWRIGHT_BROWSERS_PATH"
say "Chromium and the libraries it needs (Playwright's own build)"
node "$pw" install --with-deps chromium
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
chrome=$(find "$PLAYWRIGHT_BROWSERS_PATH" -path '*/chromium-*/chrome-linux*/chrome' -type f 2>/dev/null | sort -V | tail -n 1 || true)
[ -n "$chrome" ] || fail "Playwright did not leave a Chromium in $PLAYWRIGHT_BROWSERS_PATH."
install -d -m 0755 /usr/local/lib/mango
ln -sfn "$chrome" /usr/local/lib/mango/chromium
# A plain `chromium` for scripts (`chromium --headless --screenshot`), unless one of someone else's is there.
if [ ! -e /usr/local/bin/chromium ] || [ "$(readlink /usr/local/bin/chromium)" = /usr/local/lib/mango/chromium ]; then
  ln -sfn /usr/local/lib/mango/chromium /usr/local/bin/chromium
fi
node_bin=$(command -v node)
put /usr/local/bin/mango-chromium-mcp 0755 <<EOF || true
#!/bin/sh
# Added by Mango: Playwright's MCP server with a headless Chromium, for the agents.
# Isolated profile, so several chats can use it at once; files it names itself go to /tmp.
export PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH
exec $node_bin $mcp/cli.js --browser chromium --headless --isolated --no-sandbox \\
  --viewport-size 1440x900 --output-dir "\${TMPDIR:-/tmp}/mango-chromium-\$(id -u)" "\$@"
EOF
as_agent '/usr/local/lib/mango/chromium --version'
register_chromium
echo "Agents in this environment can use the chromium MCP tools (open a page, snapshot, screenshot)."
"##;

const DESKTOP: &str = r##"say "Desktop: XFCE, TigerVNC and noVNC (localhost only)"
need_systemd "The desktop"
apt_install xfce4 xfce4-terminal dbus-x11 x11-xserver-utils xfonts-base fonts-dejavu-core adwaita-icon-theme tigervnc-standalone-server novnc websockify
grp=$(id -gn agent)
# Skip XFCE's "which panel layout?" question on the first start.
cfg=/home/agent/.config/xfce4/xfconf/xfce-perchannel-xml
if [ ! -f "$cfg/xfce4-panel.xml" ] && [ -f /etc/xdg/xfce4/panel/default.xml ]; then
  install -d -o agent -g "$grp" -m 0755 /home/agent/.config /home/agent/.config/xfce4 /home/agent/.config/xfce4/xfconf "$cfg"
  install -o agent -g "$grp" -m 0644 /etc/xdg/xfce4/panel/default.xml "$cfg/xfce4-panel.xml"
fi
install -d -m 0755 /usr/local/lib/mango
changed=0
put /usr/local/lib/mango/desktop-session 0755 <<'EOF' && changed=1
#!/bin/bash
# Mango desktop: Xvnc on display :1 (127.0.0.1:5901 only, no VNC password) running XFCE.
set -u
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvnc :1 -localhost -interface 127.0.0.1 -rfbport 5901 -SecurityTypes None -geometry 1600x900 -depth 24 -AlwaysShared -nolisten tcp -desktop "Mango ($(hostname))" &
xvnc=$!
trap 'kill "$xvnc" 2>/dev/null' EXIT
for _ in $(seq 100); do
  [ -S /tmp/.X11-unix/X1 ] && break
  kill -0 "$xvnc" 2>/dev/null || exit 1
  sleep 0.1
done
export DISPLAY=:1 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=XFCE
cd "$HOME"
dbus-launch --exit-with-session startxfce4 &
session=$!
wait -n "$xvnc" "$session"
EOF
put /etc/systemd/system/mango-vnc.service 0644 <<'EOF' && changed=1
[Unit]
Description=Mango desktop (Xvnc :1 with XFCE, localhost only)
After=network.target

[Service]
User=agent
WorkingDirectory=/home/agent
Environment=HOME=/home/agent USER=agent LOGNAME=agent SHELL=/bin/bash
ExecStart=/usr/local/lib/mango/desktop-session
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
put /etc/systemd/system/mango-novnc.service 0644 <<'EOF' && changed=1
[Unit]
Description=Mango desktop in the browser (noVNC on 127.0.0.1:6080)
After=network.target mango-vnc.service
Wants=mango-vnc.service

[Service]
User=agent
ExecStart=/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable mango-vnc.service mango-novnc.service
if [ "$changed" = 1 ]; then
  systemctl restart mango-vnc.service mango-novnc.service
else
  systemctl start mango-vnc.service mango-novnc.service
fi
up=
for _ in $(seq 40); do
  if (exec 3<>/dev/tcp/127.0.0.1/6080) 2>/dev/null; then up=1; break; fi
  sleep 0.5
done
if [ -z "$up" ]; then
  systemctl --no-pager status mango-vnc.service mango-novnc.service || true
  fail "the desktop did not start (see the service status above)."
fi
echo "The desktop is running. Open it from Mango."
"##;

const DOCKER: &str = r##"say "Docker Engine (from Docker's apt repository)"
need_systemd "Docker"
os=$(. /etc/os-release && echo "${ID:-}")
codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
case "$os" in debian|ubuntu) ;; *) fail "Docker's packages are for Debian and Ubuntu; this environment runs ${os:-an unknown system}." ;; esac
[ -n "$codename" ] || fail "could not tell which $os release this is (no VERSION_CODENAME in /etc/os-release)."
install -d -m 0755 /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$os/gpg" -o /tmp/mango-docker.asc
install -m 0644 /tmp/mango-docker.asc /etc/apt/keyrings/docker.asc
rm -f /tmp/mango-docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$os $codename stable" > /etc/apt/sources.list.d/docker.list
apt_get update
APT_FRESH=1
apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker agent
systemctl enable --now docker.service || true
for _ in $(seq 40); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
if ! docker info >/dev/null 2>&1; then
  systemctl --no-pager status docker.service || true
  if systemd-detect-virt --container --quiet 2>/dev/null; then
    fail "Docker did not start. In an Incus container it needs nesting: on the server, run incus config set <this environment> security.nesting=true security.syscalls.intercept.mknod=true security.syscalls.intercept.setxattr=true, restart it, and install again."
  fi
  fail "Docker did not start (see the service status above)."
fi
docker --version
docker compose version
echo "The agent user can run docker (in new shells and chats)."
"##;

const TAILSCALE: &str = r##"say "Tailscale"
need_systemd "Tailscale"
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
[ -c /dev/net/tun ] || echo "Warning: /dev/net/tun is missing in this environment, so tailscaled may not start." >&2
for _ in $(seq 40); do tailscale status --json >/dev/null 2>&1 && break; sleep 0.5; done
state=$(tailscale status --json 2>/dev/null | jq -r '.BackendState // empty' || true)
if [ "$state" = Running ]; then
  echo "Already on the tailnet as $(tailscale ip -4 2>/dev/null | head -n 1). Tailscale is up to date."
else
  args=(up --reset --ssh "--hostname=$MANGO_TS_HOSTNAME")
  [ -z "$MANGO_TS_TAGS" ] || args+=("--advertise-tags=$MANGO_TS_TAGS")
  if [ -s /run/mango-tailscale-authkey ]; then
    args+=("--auth-key=file:/run/mango-tailscale-authkey")
  else
    echo "No auth key is set up for this server: sign in with the link Tailscale prints below."
  fi
  tailscale "${args[@]}"
  rm -f /run/mango-tailscale-authkey
  echo "On the tailnet as $(tailscale ip -4 2>/dev/null | head -n 1)."
fi
"##;

const FOOTER: &str = r##"say "Done: everything asked for is installed and up to date."
"##;

/* ---------- master-side script pieces (POSIX sh) ---------- */

/// `say`/`fail` for master-side scripts.
pub(crate) const MASTER_PRELUDE: &str = r##"set -eu
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mMango: %s\033[0m\n' "$*" >&2; exit 1; }
"##;

/// Runs the instance script `$SCRIPT` in `$T`. With `$NEST` = 1 (Docker) a container
/// gets nesting and syscall interception, and restarts once if it lacked them. With
/// `$TUN` = 1 (Tailscale) it makes sure the instance has `/dev/net/tun`; with `$KEY`
/// (a path on the master) it hands the Tailscale auth key to the instance as a
/// root-only file in /run.
pub(crate) const MASTER_INSTALL: &str = r##"if [ "$NEST" = 1 ] \
  && incus info "$T" 2>/dev/null | grep -q '^[[:space:]]*Type:[[:space:]]*container' \
  && [ "$(incus config get "$T" security.nesting 2>/dev/null)" != true ]; then
  say "Letting $T run Docker: turning on nesting, which restarts it once"
  incus config set "$T" security.nesting=true security.syscalls.intercept.mknod=true security.syscalls.intercept.setxattr=true \
    || fail "could not turn on nesting for $T (see above)."
  incus restart "$T" || fail "could not restart $T (see above)."
  start=$(date +%s)
  until incus exec "$T" -- sh -c 'getent hosts download.docker.com >/dev/null 2>&1'; do
    el=$(( $(date +%s) - start ))
    [ "$el" -lt 180 ] || fail "$T did not come back with a working network within 3 minutes of its restart."
    echo "    waiting for $T (${el} s)"
    sleep 3
  done
fi
if [ "$TUN" = 1 ] && ! incus exec "$T" -- test -c /dev/net/tun; then
  say "Adding /dev/net/tun to $T for Tailscale"
  incus config device add "$T" mango-tun unix-char source=/dev/net/tun path=/dev/net/tun \
    || echo "Could not add /dev/net/tun; Tailscale may not start in $T." >&2
fi
if [ -n "$KEY" ]; then
  case "$KEY" in "~/"*) KEY="$HOME/${KEY#??}" ;; esac
  [ -r "$KEY" ] || fail "the Tailscale auth key file $KEY is not readable on this server. Fix the path in the server's settings, or clear it to sign in with a link."
  incus file push --quiet --mode=0600 --uid=0 --gid=0 "$KEY" "$T/run/mango-tailscale-authkey" \
    || fail "could not hand the Tailscale auth key to $T."
fi
incus exec "$T" -t -- bash -c "$SCRIPT"
"##;

/* ---------- planning ---------- */

fn recipe(id: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|r| r.id == id)
}

/// The recipes for `ids` plus everything they require, de-duplicated, in install order.
pub(crate) fn resolve(ids: &[String]) -> Result<Vec<&'static Recipe>, String> {
    let mut want: Vec<&'static str> = Vec::new();
    let mut stack: Vec<&str> = ids.iter().map(String::as_str).collect();
    while let Some(id) = stack.pop() {
        let r = recipe(id).ok_or_else(|| format!("Mango doesn't know a component called \"{id}\"."))?;
        if !want.contains(&r.id) {
            want.push(r.id);
            stack.extend(r.requires.iter().copied());
        }
    }
    Ok(RECIPES.iter().filter(|r| want.contains(&r.id)).collect())
}

/// What an install needs: the instance-side script and what the master must prepare.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct InstallPlan {
    /// The bash script to run as root inside the instance.
    pub script: String,
    /// Tailscale is part of it (the master checks `/dev/net/tun`).
    pub tailscale: bool,
    /// The auth key file on the master, when Tailscale is part of it and one is set up.
    pub key_file: Option<String>,
    /// Docker is part of it (a container needs nesting, which the master turns on).
    pub nesting: bool,
}

/// Versions picked for components that take one (`Recipe::version_var`), by component id.
pub(crate) type Versions = BTreeMap<String, String>;

/// Check a picked version for a component; only versioned components take one.
fn valid_version(id: &str, v: &str) -> Result<(), String> {
    match id {
        "node" => valid_node_version(v),
        "java" => valid_java_version(v),
        _ => match recipe(id) {
            Some(r) => Err(format!("{} has no versions to pick from.", r.name)),
            None => Err(format!("Mango doesn't know a component called \"{id}\".")),
        },
    }
}

/// Build the install script for `ids` (with their requirements) in `instance`, with the
/// `versions` picked for some of them (none: the default, or what is installed on an update).
pub(crate) fn install_plan(host: &EnvHost, instance: &str, ids: &[String], versions: &Versions) -> Result<InstallPlan, String> {
    valid_instance(instance)?;
    for (id, v) in versions {
        valid_version(id, v)?;
    }
    let recipes = resolve(ids)?;
    let tailscale = recipes.iter().any(|r| r.id == "tailscale");
    let nesting = recipes.iter().any(|r| r.id == "docker");
    let mut s = String::from("set -Eeuo pipefail\n");
    let mut key_file = None;
    if tailscale {
        let ts = host.tailscale.as_ref();
        let tags = ts.map(|t| t.tags.clone()).unwrap_or_default();
        for t in &tags {
            valid_tag(t)?;
        }
        // The key file lives on a master; a joined environment has none.
        key_file = ts
            .and_then(|t| t.auth_key_file.clone())
            .filter(|k| !k.trim().is_empty() && host.direct.is_none());
        if let Some(k) = &key_file {
            valid_master_path(k)?;
        }
        s.push_str(&format!("MANGO_TS_HOSTNAME={}\n", ssh::quote(instance)));
        s.push_str(&format!("MANGO_TS_TAGS={}\n", ssh::quote(&tags.join(","))));
    }
    for r in &recipes {
        if let Some(var) = r.version_var {
            let v = versions.get(r.id).map(String::as_str).unwrap_or("");
            s.push_str(&format!("{var}={}\n", ssh::quote(v)));
        }
    }
    s.push_str(HEADER);
    for r in &recipes {
        s.push_str(r.script);
    }
    s.push_str(FOOTER);
    Ok(InstallPlan { script: s, tailscale, key_file, nesting })
}

/// The values `MASTER_INSTALL` reads, as positional arguments: T SCRIPT KEY TUN NEST.
pub(crate) fn master_install_args(target: &str, plan: &InstallPlan) -> Vec<String> {
    vec![
        target.to_string(),
        plan.script.clone(),
        plan.key_file.clone().unwrap_or_default(),
        if plan.tailscale { "1".into() } else { String::new() },
        if plan.nesting { "1".into() } else { String::new() },
    ]
}

/// The remote argv (for `ssh::argv`) installing `plan` into `instance`.
pub(crate) fn install_remote(host: &EnvHost, instance: &str, plan: &InstallPlan) -> Result<Vec<String>, String> {
    if host.direct.is_some() {
        let inner = ["bash".to_string(), "-c".into(), plan.script.clone()];
        return ssh::in_instance(host, instance, ssh::Mode::Tty, &inner);
    }
    let script = format!("{MASTER_PRELUDE}T=$1 SCRIPT=$2 KEY=$3 TUN=$4 NEST=$5\n{MASTER_INSTALL}");
    let mut a = vec!["sh".to_string(), "-c".into(), script, "mango-install".into()];
    a.extend(master_install_args(&ssh::target(host, instance), plan));
    Ok(a)
}

/* ---------- probing what is installed ---------- */

/// Prints `id<TAB>raw version` for each installed component (POSIX sh, as root).
const PROBE: &str = r##"row() { [ -n "$2" ] && printf '%s\t%s\n' "$1" "$2"; return 0; }
first() { head -n 1 | tr -d '\r'; }
ag() { runuser -u agent -- env HOME=/home/agent USER=agent LOGNAME=agent bash -lc "cd ~ 2>/dev/null; $1" 2>/dev/null | first; }
PRETTY_NAME=
[ -r /etc/os-release ] && . /etc/os-release
if id -u agent >/dev/null 2>&1 && [ -d /home/agent/work ] && command -v git >/dev/null 2>&1; then
  row base "${PRETTY_NAME:-installed}"
  row claude "$(ag 'command -v claude >/dev/null && claude --version')"
  row codex "$(ag 'command -v codex >/dev/null && codex --version')"
fi
command -v node >/dev/null 2>&1 && row node "$(node --version 2>/dev/null | first)"
if [ -d /home/agent/.sdkman/candidates/java/current ]; then
  j=$(readlink /home/agent/.sdkman/candidates/java/current 2>/dev/null || true)
  j=${j%/}
  row java "${j##*/}"
  [ -n "$j" ] || row java installed
fi
command -v gh >/dev/null 2>&1 && row gh "$(gh --version 2>/dev/null | first)"
if [ -x /usr/local/bin/mango-chromium-mcp ]; then
  v=$(/usr/local/lib/mango/chromium --version 2>/dev/null | first)
  row chromium "${v:-installed}"
fi
if [ -f /etc/systemd/system/mango-vnc.service ] && [ -f /etc/systemd/system/mango-novnc.service ] && command -v Xvnc >/dev/null 2>&1; then
  row desktop "$(dpkg-query -W -f='${Version}' xfce4-session 2>/dev/null || echo installed)"
fi
command -v docker >/dev/null 2>&1 && row docker "$(docker --version 2>/dev/null | first)"
command -v tailscale >/dev/null 2>&1 && row tailscale "$(tailscale version 2>/dev/null | first)"
exit 0
"##;

/// The version number in a CLI's `--version` line (`v22.1.0`, `gh version 2.62.0 (…)`).
fn version_token(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .map(|t| t.trim_start_matches('v').trim_end_matches(','))
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(String::from)
}

/// A Debian package version without epoch and revision: `1:4.18.3-1ubuntu1` -> `4.18.3`.
fn upstream_version(v: &str) -> String {
    let v = v.split_once(':').map_or(v, |(_, rest)| rest);
    v.rsplit_once('-').map_or(v, |(up, _)| up).to_string()
}

/// Turn the probe's output into the full component list.
pub(crate) fn parse_probe(out: &str) -> Vec<EnvComponent> {
    let found: Vec<(&str, &str)> =
        out.lines().filter_map(|l| l.split_once('\t')).map(|(k, v)| (k.trim(), v.trim())).collect();
    RECIPES
        .iter()
        .map(|r| {
            let raw = found.iter().find(|(k, _)| *k == r.id).map(|(_, v)| *v);
            let version = raw.and_then(|v| match r.id {
                "base" | "java" => Some(v.to_string()).filter(|v| v != "installed"),
                "desktop" => Some(upstream_version(v)).filter(|v| v != "installed"),
                _ => version_token(v),
            });
            EnvComponent {
                id: r.id.into(),
                name: r.name.into(),
                description: r.description.into(),
                installed: raw.is_some(),
                version,
                requires: r.requires.iter().map(|s| s.to_string()).collect(),
                versioned: r.version_var.is_some(),
            }
        })
        .collect()
}

/// A readable message for `incus exec` failing on an instance that is not up.
pub(crate) fn exec_error(instance: &str, e: String) -> String {
    let lower = e.to_lowercase();
    if lower.contains("vm agent") {
        format!("{instance} is still starting (its VM agent is not up yet). Try again in a moment.")
    } else if lower.contains("instance is not running") || lower.contains("isn't running") {
        format!("{instance} is not running. Start it first.")
    } else if lower.contains("not found") {
        format!("{instance} no longer exists on this server.")
    } else {
        e
    }
}

#[tauri::command]
pub async fn env_components(app: AppHandle, host_id: String, instance: String) -> Result<Vec<EnvComponent>, String> {
    super::blocking(move || {
        valid_instance(&instance)?;
        let host = hosts::get(&app, &host_id)?;
        let inner = ["sh".to_string(), "-c".into(), PROBE.into()];
        let remote = ssh::in_instance(&host, &instance, ssh::Mode::Batch, &inner)?;
        let out = ssh::run(&host, &remote, Duration::from_secs(60)).map_err(|e| exec_error(&instance, e))?;
        Ok(parse_probe(&out))
    })
    .await
}

#[tauri::command]
pub async fn env_install(
    app: AppHandle,
    state: State<'_, crate::pty::PtyState>,
    host_id: String,
    instance: String,
    components: Vec<String>,
    versions: Option<Versions>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    if components.is_empty() {
        return Err("Pick at least one component to install.".into());
    }
    let host = hosts::get(&app, &host_id)?;
    let plan = install_plan(&host, &instance, &components, &versions.unwrap_or_default())?;
    let argv = ssh::argv(&host, ssh::Mode::Tty, &install_remote(&host, &instance, &plan)?)?;
    crate::pty::start(app, &state, None, cols, rows, Some(argv), &[])
}

/* ---------- the versions Node.js and Java offer ---------- */

/// One version a component can install.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVersion {
    /// What the install takes (`versions` in `env_install`): `22.11.0`, or an SDKMAN identifier.
    pub id: String,
    /// The version as people read it: `22.11.0`, `21.0.5`.
    pub version: String,
    /// What it belongs to: the release line (`Node.js 22`) or Java's vendor (`Temurin`).
    pub group: String,
    /// A short note: Node.js's LTS name, or a Java build's flavour (`JavaFX`, `CRaC`).
    pub note: Option<String>,
    /// The day it came out (`2024-10-28`), when known.
    pub date: Option<String>,
    /// What the install takes when no version is picked.
    pub default: bool,
}

const NODE_INDEX: &str = "https://nodejs.org/dist/index.json";
const SDKMAN_JAVA_LIST: &str = "https://api.sdkman.io/2/candidates/java/linuxx64/versions/list?installed=";
const SDKMAN_JAVA_DEFAULT: &str = "https://api.sdkman.io/2/candidates/default/java";

#[derive(Deserialize)]
struct NodeRelease {
    version: String,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    /// `false`, or the LTS line's name.
    #[serde(default)]
    lts: serde_json::Value,
}

/// nodejs.org's `index.json` (newest first) as versions: stable releases with a Linux x64 build.
/// The newest LTS is the default, as in the install script.
pub(crate) fn parse_node_index(json: &str) -> Result<Vec<EnvVersion>, String> {
    let releases: Vec<NodeRelease> =
        serde_json::from_str(json).map_err(|e| format!("nodejs.org sent a version list Mango can't read ({e})."))?;
    let mut out: Vec<EnvVersion> = releases
        .into_iter()
        .filter_map(|r| {
            let v = r.version.strip_prefix('v')?.to_string();
            if valid_node_version(&v).is_err() || v.split('.').count() != 3 || !r.files.iter().any(|f| f == "linux-x64") {
                return None;
            }
            let major = v.split('.').next().unwrap_or_default().to_string();
            let lts = r.lts.as_str().map(|n| format!("LTS {n}"));
            Some(EnvVersion { id: v.clone(), version: v, group: format!("Node.js {major}"), note: lts, date: r.date, default: false })
        })
        .collect();
    if let Some(first_lts) = out.iter_mut().find(|v| v.note.is_some()) {
        first_lts.default = true;
    }
    Ok(out)
}

/// SDKMAN's Java list (the table `sdk list java` prints) as versions, in its order (by vendor,
/// newest first). The vendor column is only filled on each vendor's first row.
pub(crate) fn parse_sdkman_java(text: &str, default: &str) -> Vec<EnvVersion> {
    let mut vendor = String::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split('|').map(str::trim).collect();
        if cols.len() < 4 {
            continue;
        }
        let (first, version, id) = (cols[0], cols[2], cols[cols.len() - 1]);
        if first == "Vendor" {
            continue;
        }
        if !first.is_empty() {
            vendor = first.to_string();
        }
        if vendor.is_empty() || version.is_empty() || valid_java_version(id).is_err() {
            continue;
        }
        let lower = version.to_ascii_lowercase();
        let note = if lower.contains("-fx") || lower.contains(".fx") {
            Some("JavaFX")
        } else if lower.contains("crac") {
            Some("CRaC")
        } else if lower.contains("ea") {
            Some("Early access")
        } else {
            None
        };
        out.push(EnvVersion {
            id: id.to_string(),
            version: version.to_string(),
            group: vendor.clone(),
            note: note.map(String::from),
            date: None,
            default: id == default,
        });
    }
    out
}

async fn fetch_text(client: &reqwest::Client, url: &str, what: &str) -> Result<String, String> {
    let unreachable = |e: reqwest::Error| format!("Could not reach {what} to list its versions. Check this computer's connection. ({e})");
    let res = client.get(url).send().await.map_err(unreachable)?;
    if !res.status().is_success() {
        return Err(format!("{what} answered {} when asked for its versions. Try again later.", res.status()));
    }
    res.text().await.map_err(unreachable)
}

/// The versions `component` can install (Node.js or Java), newest first, read from the source
/// the install script uses. Nothing here touches an environment.
#[tauri::command]
pub async fn env_versions(component: String) -> Result<Vec<EnvVersion>, String> {
    if !matches!(component.as_str(), "node" | "java") {
        return Err(match recipe(&component) {
            Some(r) => format!("{} has no versions to pick from.", r.name),
            None => format!("Mango doesn't know a component called \"{component}\"."),
        });
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Mango/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Could not list the versions: {e}"))?;
    if component == "node" {
        let json = fetch_text(&client, NODE_INDEX, "nodejs.org").await?;
        return parse_node_index(&json);
    }
    let list = fetch_text(&client, SDKMAN_JAVA_LIST, "SDKMAN").await?;
    // Only marks a row: without it the list is still whole.
    let default = fetch_text(&client, SDKMAN_JAVA_DEFAULT, "SDKMAN").await.unwrap_or_default();
    let out = parse_sdkman_java(&list, default.trim());
    if out.is_empty() {
        return Err("SDKMAN sent a Java list Mango can't read. Try again later.".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envs::EnvTailscale;

    fn host(ts: Option<EnvTailscale>) -> EnvHost {
        EnvHost {
            id: "h".into(),
            name: "Lab".into(),
            ssh: "me@lab".into(),
            port: None,
            identity_file: None,
            incus_remote: Some("os1".into()),
            tailscale: ts,
            public_address: None,
            direct: None,
        }
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn order(v: &[&str]) -> Vec<&'static str> {
        resolve(&ids(v)).unwrap().iter().map(|r| r.id).collect()
    }

    #[test]
    fn table_is_in_dependency_order() {
        for (i, r) in RECIPES.iter().enumerate() {
            for req in r.requires {
                let at = RECIPES.iter().position(|x| x.id == *req).expect(req);
                assert!(at < i, "{} requires {req}, listed later", r.id);
            }
        }
    }

    #[test]
    fn resolves_requirements() {
        assert_eq!(order(&["claude"]), ["base", "claude"]);
        assert_eq!(order(&["tailscale", "claude", "base", "claude"]), ["base", "claude", "tailscale"]);
        assert_eq!(order(&["desktop", "gh", "node", "codex"]), ["base", "node", "gh", "codex", "desktop"]);
        assert!(order(&[]).is_empty());
        let e = resolve(&ids(&["claude", "rm -rf"])).err().unwrap();
        assert!(e.contains("rm -rf"), "{e}");
    }

    #[test]
    fn script_holds_what_was_asked() {
        let p = install_plan(&host(None), "dev", &ids(&["desktop"]), &Versions::new()).unwrap();
        assert!(p.script.starts_with("set -Eeuo pipefail\n"));
        assert!(p.script.contains("useradd --create-home --home-dir /home/agent"));
        assert!(p.script.contains("mango-vnc.service") && p.script.contains("mango-novnc.service"));
        assert!(p.script.contains("-rfbport 5901") && p.script.contains("127.0.0.1:6080 127.0.0.1:5901"));
        assert!(!p.script.contains("claude.ai/install.sh"));
        assert!(!p.tailscale && p.key_file.is_none());
        assert!(!p.script.contains("MANGO_TS_"));
        // The base script must come before the desktop's.
        assert!(p.script.find("useradd").unwrap() < p.script.find("mango-vnc.service").unwrap());
    }

    #[test]
    fn chromium_installs_with_node_and_registers_the_mcp_server() {
        assert_eq!(order(&["chromium"]), ["base", "node", "chromium"]);
        // Asked together, the agents come first, so the Chromium step registers with both.
        assert_eq!(order(&["chromium", "codex", "claude"]), ["base", "node", "claude", "codex", "chromium"]);
        let p = install_plan(&host(None), "dev", &ids(&["chromium"]), &Versions::new()).unwrap();
        assert!(p.script.contains("@playwright/mcp@latest"));
        assert!(p.script.contains("install --with-deps chromium"));
        assert!(p.script.contains("--browser chromium --headless --isolated"));
        assert!(p.script.contains("claude mcp add --scope user chromium -- /usr/local/bin/mango-chromium-mcp"));
        assert!(p.script.contains("[mcp_servers.chromium]"));
        assert!(p.script.contains("picture_note /home/agent/.claude/CLAUDE.md"));
        assert!(p.script.contains("picture_note /home/agent/.codex/AGENTS.md"));
        // Node's script runs before Chromium's, and the register helper is defined before both.
        assert!(p.script.find("nodejs.org/dist/index.json").unwrap() < p.script.find("@playwright/mcp").unwrap());
        assert!(p.script.find("register_chromium() {").unwrap() < p.script.find("nodejs.org/dist/index.json").unwrap());
        // Claude Code and Codex installed later still pick it up.
        let p = install_plan(&host(None), "dev", &ids(&["claude"]), &Versions::new()).unwrap();
        assert!(p.script.contains("claude --version'\nregister_chromium\n"));
        assert!(!p.script.contains("@playwright/mcp"));
    }

    #[test]
    fn docker_installs_from_its_repository_and_asks_for_nesting() {
        assert_eq!(order(&["docker"]), ["base", "docker"]);
        let p = install_plan(&host(None), "dev", &ids(&["docker"]), &Versions::new()).unwrap();
        assert!(p.nesting && !p.tailscale);
        assert!(p.script.contains("https://download.docker.com/linux/$os $codename stable"));
        assert!(p.script.contains("docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"));
        assert!(p.script.contains("usermod -aG docker agent"));
        assert!(p.script.find("useradd").unwrap() < p.script.find("download.docker.com").unwrap());
        let remote = install_remote(&host(None), "dev", &p).unwrap();
        assert_eq!(remote[8], "1");
        assert!(remote[2].contains("security.nesting=true security.syscalls.intercept.mknod=true"));
        assert!(!install_plan(&host(None), "dev", &ids(&["node"]), &Versions::new()).unwrap().nesting);
    }

    fn picked(v: &[(&str, &str)]) -> Versions {
        v.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn node_and_java_take_a_picked_version() {
        assert_eq!(order(&["java"]), ["base", "java"]);
        let both = picked(&[("node", "22.11.0"), ("java", "25.0.5.0-fx+3.1-zulu")]);
        let p = install_plan(&host(None), "dev", &ids(&["node", "java"]), &both).unwrap();
        assert!(p.script.contains("MANGO_NODE_VERSION=22.11.0\n"), "{}", &p.script[..200]);
        assert!(p.script.contains(&format!("MANGO_JAVA_VERSION={}\n", ssh::quote("25.0.5.0-fx+3.1-zulu"))));
        // The values come before the scripts that read them; Node.js before Java (table order).
        assert!(p.script.find("MANGO_NODE_VERSION=").unwrap() < p.script.find("say() {").unwrap());
        assert!(p.script.find("nodejs.org/dist/index.json").unwrap() < p.script.find("get.sdkman.io").unwrap());
        assert!(p.script.contains("sha256sum -c --quiet sum"));
        assert!(p.script.contains("/etc/profile.d/mango-java.sh"));

        // No pick: the variables are there, empty (the scripts take the default or keep what is installed).
        let p = install_plan(&host(None), "dev", &ids(&["java"]), &Versions::new()).unwrap();
        assert!(p.script.contains("MANGO_JAVA_VERSION=''\n"));
        assert!(!p.script.contains("MANGO_NODE_VERSION"));
        // A pick for something not being installed is checked, then left out.
        let p = install_plan(&host(None), "dev", &ids(&["claude"]), &picked(&[("node", "22")])).unwrap();
        assert!(!p.script.contains("MANGO_NODE_VERSION"));

        // Bad values and components without versions are refused, not interpolated.
        for bad in [("node", "22; reboot"), ("node", "v22"), ("java", "21.0.5-tem$(id)"), ("java", "x"), ("docker", "29"), ("rm -rf", "1")] {
            assert!(install_plan(&host(None), "dev", &ids(&["node", "java"]), &picked(&[bad])).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn node_versions_from_the_index() {
        let json = r#"[
          {"version":"v27.0.0-alpha.0.1.1","date":"2026-11-16","files":["linux-x64"],"lts":false},
          {"version":"v26.3.0","date":"2026-11-10","files":["linux-arm64","linux-x64"],"lts":false},
          {"version":"v24.11.1","date":"2026-11-02","files":["linux-x64","win-x64-zip"],"lts":"Krypton"},
          {"version":"v22.11.0","date":"2024-10-29","files":["linux-x64"],"lts":"Jod"},
          {"version":"v0.1.14","date":"2011-08-26","files":["src"],"lts":false}
        ]"#;
        let v = parse_node_index(json).unwrap();
        assert_eq!(v.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["26.3.0", "24.11.1", "22.11.0"]);
        assert_eq!(v[1].group, "Node.js 24");
        assert_eq!(v[1].note.as_deref(), Some("LTS Krypton"));
        assert_eq!(v[1].date.as_deref(), Some("2026-11-02"));
        assert!(v[1].default && !v[0].default && !v[2].default);
        assert!(v[0].note.is_none());
        assert!(parse_node_index("<html>").is_err());
    }

    #[test]
    fn java_versions_from_sdkman() {
        let text = "================================================================================
Available Java Versions for Linux 64bit
================================================================================
 Vendor         | Use | Version            | Identifier
--------------------------------------------------------------------------------
 Corretto       |     | 27.0.1.1.4         | 27.0.1.1.4-amzn
                |     | 21.0.13.1.2        | 21.0.13.1.2-amzn
 Temurin        | >>> | 25.0.5.1+2         | 25.0.5.1+2-tem
                |  *  | 21.0.9             | 21.0.9-tem
 Zulu           |     | 25.0.5.0-fx+3.1    | 25.0.5.0-fx+3.1-zulu
                |     | 21.0.13.0-crac+3.1 | 21.0.13.0-crac+3.1-zulu
 Java.net       |     | 28.0.0.0+ea.24     | 28.0.0.0+ea.24-open
 Odd            |     | 1.0                | ; rm -rf ~
================================================================================
 > in use   * installed   + local only
--------------------------------------------------------------------------------
 $ sdk install java <Identifier>    install a specific version
================================================================================
";
        let v = parse_sdkman_java(text, "25.0.5.1+2-tem");
        let ids: Vec<&str> = v.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(
            ids,
            ["27.0.1.1.4-amzn", "21.0.13.1.2-amzn", "25.0.5.1+2-tem", "21.0.9-tem", "25.0.5.0-fx+3.1-zulu", "21.0.13.0-crac+3.1-zulu", "28.0.0.0+ea.24-open"]
        );
        assert_eq!(v[1].group, "Corretto");
        assert_eq!(v[3].group, "Temurin");
        assert_eq!(v[3].version, "21.0.9");
        assert!(v[2].default && !v[3].default);
        assert_eq!(v[4].note.as_deref(), Some("JavaFX"));
        assert_eq!(v[5].note.as_deref(), Some("CRaC"));
        assert_eq!(v[6].note.as_deref(), Some("Early access"));
        // The older six-column layout reads the same.
        let old = " Temurin       |     | 21.0.5       | tem     |            | 21.0.5-tem\n";
        assert_eq!(parse_sdkman_java(old, "")[0].id, "21.0.5-tem");
    }

    /// Reads the real lists (network): `cargo test live_version_lists -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_version_lists() {
        let node = tauri::async_runtime::block_on(env_versions("node".into())).unwrap();
        let java = tauri::async_runtime::block_on(env_versions("java".into())).unwrap();
        let def = |v: &[EnvVersion]| v.iter().find(|x| x.default).map(|x| x.id.clone());
        println!("node: {} versions, default {:?}, newest {}", node.len(), def(&node), node[0].id);
        println!("java: {} versions, default {:?}, vendors {}", java.len(), def(&java), {
            let mut g: Vec<&str> = java.iter().map(|v| v.group.as_str()).collect();
            g.dedup();
            g.join(", ")
        });
        assert!(node.len() > 100 && def(&node).is_some());
        assert!(java.len() > 50 && def(&java).is_some());
        assert!(tauri::async_runtime::block_on(env_versions("docker".into())).is_err());
    }

    #[test]
    fn tailscale_tags_and_key() {
        let ts = EnvTailscale { tags: vec!["tag:mango".into(), "tag:dev".into()], auth_key_file: Some("~/.ts-key".into()) };
        let p = install_plan(&host(Some(ts)), "dev-1", &ids(&["tailscale"]), &Versions::new()).unwrap();
        assert!(p.tailscale);
        assert_eq!(p.key_file.as_deref(), Some("~/.ts-key"));
        assert!(p.script.contains("MANGO_TS_HOSTNAME=dev-1\n"));
        assert!(p.script.contains("MANGO_TS_TAGS=tag:mango,tag:dev\n"));
        assert!(p.script.contains("--auth-key=file:/run/mango-tailscale-authkey"));
        assert!(!p.script.contains(".ts-key"), "the key path stays on the master");

        // No Tailscale settings: interactive sign-in, no tags.
        let p = install_plan(&host(None), "dev", &ids(&["tailscale"]), &Versions::new()).unwrap();
        assert!(p.key_file.is_none());
        assert!(p.script.contains("MANGO_TS_TAGS=''\n"));

        // Bad saved values are refused, not interpolated.
        let bad = EnvTailscale { tags: vec!["tag:x;reboot".into()], auth_key_file: None };
        assert!(install_plan(&host(Some(bad)), "dev", &ids(&["tailscale"]), &Versions::new()).is_err());
        let bad = EnvTailscale { tags: vec![], auth_key_file: Some("$(id)".into()) };
        assert!(install_plan(&host(Some(bad)), "dev", &ids(&["tailscale"]), &Versions::new()).is_err());
        assert!(install_plan(&host(None), "dev;x", &ids(&["base"]), &Versions::new()).is_err());
    }

    #[test]
    fn master_line_quotes_everything() {
        let ts = EnvTailscale { tags: vec!["tag:mango".into()], auth_key_file: Some("~/keys/ts".into()) };
        let h = host(Some(ts));
        let p = install_plan(&h, "dev", &ids(&["tailscale"]), &Versions::new()).unwrap();
        let remote = install_remote(&h, "dev", &p).unwrap();
        assert_eq!(&remote[..2], ["sh", "-c"]);
        assert_eq!(&remote[3..5], ["mango-install", "os1:dev"]);
        assert_eq!(remote[6], "~/keys/ts");
        assert_eq!(remote[7], "1");
        let l = ssh::line(&remote);
        assert!(l.starts_with("sh -c 'set -eu\n"), "{l}");
        assert!(l.contains(" mango-install os1:dev 'set -Eeuo pipefail\n"), "{l}");
        assert_eq!(remote[8], "");
        assert!(l.ends_with(" '~/keys/ts' 1 ''"), "{}", &l[l.len() - 60..]);
        // Single quotes inside the scripts are closed and escaped.
        assert!(l.contains(r"'\''"));

        // Without Tailscale or Docker the key, tun and nest arguments are empty strings.
        let p = install_plan(&h, "dev", &ids(&["claude"]), &Versions::new()).unwrap();
        let l = ssh::line(&install_remote(&h, "dev", &p).unwrap());
        assert!(l.ends_with(" '' '' ''"), "{}", &l[l.len() - 40..]);
        assert!(l.contains("NEST=$5"), "{l}");
    }

    #[test]
    fn joined_environment_installs_through_sudo() {
        let mut h = host(Some(EnvTailscale { tags: vec![], auth_key_file: Some("~/k".into()) }));
        h.direct = Some(crate::envs::EnvDirect {
            instance: "dev".into(),
            host_key: String::new(),
            shared_from: "forge/dev".into(),
            share_id: "s".into(),
            expires_at: None,
        });
        let p = install_plan(&h, "dev", &ids(&["tailscale"]), &Versions::new()).unwrap();
        assert!(p.key_file.is_none(), "no master to hold a key file");
        let remote = install_remote(&h, "dev", &p).unwrap();
        assert_eq!(&remote[..5], ["sudo", "-n", "--", "bash", "-c"]);
        assert_eq!(remote[5], p.script);
        assert_eq!(remote.len(), 6);
        assert!(install_remote(&h, "other", &p).is_err());
    }

    #[test]
    fn everything_fits_a_windows_command_line() {
        let ts = EnvTailscale { tags: vec!["tag:mango".into()], auth_key_file: Some("~/k".into()) };
        let h = host(Some(ts));
        let all: Vec<String> = RECIPES.iter().map(|r| r.id.to_string()).collect();
        let p = install_plan(&h, "dev", &all, &Versions::new()).unwrap();
        let l = ssh::line(&install_remote(&h, "dev", &p).unwrap());
        assert!(l.is_ascii(), "keep scripts ASCII: they cross Windows argv conversion");
        // CreateProcess allows 32767 characters; Windows quoting escapes '"' and '\'.
        let windows = l.len() + l.matches(['"', '\\']).count() + 300;
        assert!(windows < 30_000, "{windows}");
    }

    #[test]
    fn probe_output() {
        let out = "base\tUbuntu 24.04.1 LTS\nclaude\t2.0.31 (Claude Code)\ncodex\tcodex-cli 0.46.0\nnode\tv22.11.0\n\
                   gh\tgh version 2.62.0 (2024-11-14)\nchromium\tChromium 143.0.7499.4 \ndesktop\t4.18.3-1ubuntu1\nnoise line\n";
        let c = parse_probe(out);
        let get = |id: &str| c.iter().find(|x| x.id == id).unwrap();
        assert_eq!(c.len(), RECIPES.len());
        assert_eq!(get("base").version.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(get("claude").version.as_deref(), Some("2.0.31"));
        assert_eq!(get("codex").version.as_deref(), Some("0.46.0"));
        assert_eq!(get("node").version.as_deref(), Some("22.11.0"));
        assert_eq!(get("gh").version.as_deref(), Some("2.62.0"));
        assert_eq!(get("desktop").version.as_deref(), Some("4.18.3"));
        assert_eq!(get("chromium").version.as_deref(), Some("143.0.7499.4"));
        assert_eq!(get("chromium").requires, ["base", "node"]);
        let c = parse_probe("chromium\tinstalled\n");
        let chromium = c.iter().find(|x| x.id == "chromium").unwrap();
        assert!(chromium.installed && chromium.version.is_none());
        assert!(!get("tailscale").installed && get("tailscale").version.is_none());
        assert_eq!(get("claude").requires, ["base"]);
        assert_eq!(upstream_version("1:2.3-4"), "2.3");
        let c = parse_probe("tailscale\t1.76.6\n");
        assert_eq!(c.iter().find(|x| x.id == "tailscale").unwrap().version.as_deref(), Some("1.76.6"));
        assert!(get("node").versioned && !get("claude").versioned);
        let c = parse_probe("java\t21.0.9-tem\n");
        let java = c.iter().find(|x| x.id == "java").unwrap();
        assert_eq!(java.version.as_deref(), Some("21.0.9-tem"));
        assert!(java.versioned);
        let c = parse_probe("java\tinstalled\n");
        assert!(c.iter().find(|x| x.id == "java").unwrap().version.is_none());
        let c = parse_probe("docker\tDocker version 29.0.2, build 8108357\n");
        assert_eq!(c.iter().find(|x| x.id == "docker").unwrap().version.as_deref(), Some("29.0.2"));
        assert!(!c.iter().find(|x| x.id == "base").unwrap().installed);
    }

    #[test]
    fn exec_errors() {
        assert!(exec_error("dev", "Error: Instance is not running".into()).contains("Start it"));
        assert!(exec_error("vm1", "Error: VM agent isn't currently running".into()).contains("still starting"));
        assert_eq!(exec_error("dev", "boom".into()), "boom");
    }
}
