//! Sign-in for a Lore server Mango set up: in an environment's instance (`envs::lore`) and on a
//! machine over SSH (`lore_machines`). Lore's server has no passwords of its own: it verifies JWTs
//! from an OpenID Connect provider (`[server.auth]`), and the CLI signs in with the device flow
//! (`lore login`, a link to open in a browser). So the sign-in is three pieces beside the server:
//!
//! - **Dex** (dexidp.io), the identity provider: its own users with passwords, and/or GitHub
//!   (members of the organisations the user names). It only listens on 127.0.0.1.
//! - **Caddy**, which gets a Let's Encrypt certificate for the user's domain (ports 80 and 443) and
//!   serves Dex's pages over HTTPS. The CLI only follows an `https` issuer, and only sends a token to
//!   a `lores://` server, whose certificate it checks.
//! - The **same certificate for the Lore server** (QUIC and gRPC), copied from Caddy's store by an
//!   hourly timer that restarts the server when it changed (a renewal, about every 60 days).
//! - A **watchdog** timer that restarts Dex when it runs but stops answering (see [`AUTH_PINS`]).
//!
//! Every token holder may read and write (Lore's Tier 1 with its default `implicit_actions`): who
//! gets a token is the whole policy, decided by Dex's user list and the GitHub organisations.
//!
//! Mango never sees a password or the GitHub client secret: both are typed in the terminal the
//! script runs in (a password goes to `caddy hash-password`, which asks twice and prints a bcrypt
//! hash; the secret to `read -s`). Values from the UI pass [`clean`] here and the same patterns in
//! the script, then reach it as positional arguments only.
//!
//! Pinned like the Lore release: Caddy's tarballs by the SHA-256 of the downloads, and Dex, which
//! publishes no binaries, by the digest of the layer of its official image that holds its static
//! `dex` binary (fetched from ghcr.io, which serves blobs by digest; `sha256sum` checks it too). To
//! move either, change the version and both sums together, then run the ignored
//! `lore_auth::tests::real_downloads`.

use serde::{Deserialize, Serialize};

/// The sign-in a Lore server should have (saved with a machine in `lore-servers.json`, and read back
/// from an instance). No secrets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoreSignIn {
    /// The DNS name that points at the server: Caddy's certificate, Dex's issuer and the `lores://`
    /// address are all for it.
    pub domain: String,
    /// People sign in with an email and a password kept by Dex.
    #[serde(default)]
    pub passwords: bool,
    /// People sign in with GitHub, when they belong to one of the organisations.
    #[serde(default)]
    pub github: Option<LoreSignInGithub>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoreSignInGithub {
    /// The GitHub OAuth app's client ID (not a secret; the secret is typed on the server).
    pub client_id: String,
    pub orgs: Vec<String>,
}

pub(crate) const MAX_ORGS: usize = 10;

/// A DNS name with at least one dot (lower case, no trailing dot): not an IP address, which Let's
/// Encrypt certificates and the CLI's audience check don't take here.
pub(crate) fn valid_domain(s: &str) -> Result<String, String> {
    let d = s.trim().trim_end_matches('.').to_ascii_lowercase();
    let label_ok = |l: &str| {
        !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    let labels: Vec<&str> = d.split('.').collect();
    let ok = d.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| label_ok(l))
        && !labels.last().is_some_and(|tld| tld.chars().all(|c| c.is_ascii_digit()));
    if ok {
        Ok(d)
    } else {
        Err(format!("\"{}\" is not a domain name. Use a name like lore.example.com that points at the server.", s.trim()))
    }
}

/// An email address for a password user (lower case).
pub(crate) fn valid_email(s: &str) -> Result<String, String> {
    let e = s.trim().to_ascii_lowercase();
    let ok = e.len() <= 254
        && e.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && local.len() <= 64
                && !local.starts_with('.')
                && !local.ends_with('.')
                && local.chars().all(|c| c.is_ascii_alphanumeric() || "._%+-".contains(c))
                && valid_domain(domain).is_ok()
        });
    if ok {
        Ok(e)
    } else {
        Err(format!("\"{}\" is not an email address Mango can use for a Lore sign-in.", s.trim()))
    }
}

/// A GitHub organisation's login: letters, digits and single dashes, up to 39.
pub(crate) fn valid_github_org(s: &str) -> Result<String, String> {
    let o = s.trim();
    let ok = !o.is_empty()
        && o.len() <= 39
        && !o.starts_with('-')
        && !o.ends_with('-')
        && !o.contains("--")
        && o.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(o.to_string())
    } else {
        Err(format!("\"{o}\" is not a GitHub organisation name."))
    }
}

/// A GitHub OAuth app's client ID (`Ov23li…`, `Iv1.…`).
pub(crate) fn valid_github_client_id(s: &str) -> Result<String, String> {
    let c = s.trim();
    let ok = (4..=100).contains(&c.len()) && c.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch));
    if ok {
        Ok(c.to_string())
    } else {
        Err(format!("\"{c}\" is not a GitHub OAuth app client ID. Copy it from the app's page on GitHub."))
    }
}

/// One sign-in checked and normalised.
pub(crate) fn clean(s: LoreSignIn) -> Result<LoreSignIn, String> {
    let domain = valid_domain(&s.domain)?;
    let github = match s.github {
        Some(g) => {
            let client_id = valid_github_client_id(&g.client_id)?;
            let mut orgs: Vec<String> = Vec::new();
            for o in &g.orgs {
                let o = valid_github_org(o)?;
                if !orgs.iter().any(|x| x.eq_ignore_ascii_case(&o)) {
                    orgs.push(o);
                }
            }
            if orgs.is_empty() {
                return Err("Name the GitHub organisation whose members may sign in. Without one, anyone with a GitHub account could.".into());
            }
            if orgs.len() > MAX_ORGS {
                return Err(format!("Mango takes up to {MAX_ORGS} GitHub organisations."));
            }
            Some(LoreSignInGithub { client_id, orgs })
        }
        None => None,
    };
    if !s.passwords && github.is_none() {
        return Err("Pick how people sign in: passwords, GitHub, or both.".into());
    }
    Ok(LoreSignIn { domain, passwords: s.passwords, github })
}

/// `lores://domain[:port]`: the address clients use once the sign-in is on. The port stays unless it
/// is 443, which the CLI assumes for `lores://` (Lore's own 41337 has to be written out).
pub(crate) fn secure_url(domain: &str, port: u16) -> String {
    if port == crate::lore_servers::SECURE_DEFAULT_PORT {
        format!("lores://{domain}")
    } else {
        format!("lores://{domain}:{port}")
    }
}

/// The arguments `auth_main setup` takes after the action, for `s` (already [`clean`]ed): DOMAIN
/// PASSWORDS GH_ID GH_ORGS (comma-separated), then the caller's LP, LA and first user.
pub(crate) fn setup_args(s: &LoreSignIn) -> [String; 4] {
    let (id, orgs) = match &s.github {
        Some(g) => (g.client_id.clone(), g.orgs.join(",")),
        None => (String::new(), String::new()),
    };
    [s.domain.clone(), if s.passwords { "yes".into() } else { "no".into() }, id, orgs]
}

/// The script's state as `auth_status` prints it (`key value` lines), as read back.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreSignInState {
    /// The sign-in is on: the server only takes signed-in callers.
    pub on: bool,
    pub domain: Option<String>,
    pub passwords: bool,
    pub github: Option<LoreSignInGithub>,
    /// The GitHub client secret has been typed in.
    pub github_secret: bool,
    /// Caddy has a certificate for the domain.
    pub certificate: bool,
    /// The password users' emails.
    pub users: Vec<String>,
}

/// `auth_status`'s lines (also inside other output: only its `auth…` keys are read).
pub(crate) fn parse_status(out: &str) -> LoreSignInState {
    let mut st = LoreSignInState::default();
    let (mut gh_id, mut gh_orgs) = (None, Vec::new());
    for line in out.lines() {
        let (k, v) = line.trim().split_once(' ').unwrap_or((line.trim(), ""));
        let v = v.trim();
        match k {
            "authOn" => st.on = v == "yes",
            "authDomain" => st.domain = valid_domain(v).ok(),
            "authPasswords" => st.passwords = v == "yes",
            "authGithubId" => gh_id = valid_github_client_id(v).ok(),
            "authGithubOrgs" => gh_orgs = v.split(',').filter_map(|o| valid_github_org(o).ok()).collect(),
            "authGithubSecret" => st.github_secret = v == "yes",
            "authCert" => st.certificate = v == "yes",
            "authUser" => {
                if let Ok(e) = valid_email(v) {
                    st.users.push(e);
                }
            }
            _ => {}
        }
    }
    st.github = gh_id.map(|client_id| LoreSignInGithub { client_id, orgs: gh_orgs });
    if st.domain.is_none() {
        st.on = false;
    }
    st
}

/// Pinned Caddy and Dex, and `auth_get`, which downloads one for this machine into `$auth_tmp/<name>`
/// and checks it against the sum pinned here.
///
/// Dex stays on 2.45: 2.46's refresh grant reads the offline session inside the transaction that
/// updates the refresh token (`RefreshStore.Rotate` → `refreshConnectorData`), and its SQLite storage
/// has one connection, so every refresh past the reuse window waits on itself and Dex answers nothing
/// again until restarted (its memory storage locks the same way). 2.45 reads it before the
/// transaction. Check that path before moving to a newer Dex. 2.45 opens a database 2.46 migrated
/// (2.46 only added tables and nullable or defaulted columns).
pub(crate) const AUTH_PINS: &str = r##"CADDY_V=2.11.9
DEX_V=2.45.1
auth_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) fail "Mango's Lore sign-in runs on x86_64 and aarch64 only, not $(uname -m)." ;;
  esac
}
auth_get() {
  local arch sum tok
  arch=$(auth_arch)
  auth_tmp=$(mktemp -d)
  case "$1-$arch" in
    caddy-amd64) sum=5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb ;;
    caddy-arm64) sum=5e377cff994fc9362a6fcf695c53f226cfca3a3ef85bd3a3687cf252d6310165 ;;
    # The layer of ghcr.io/dexidp/dex:v$DEX_V-distroless that holds /usr/local/bin/dex (static).
    dex-amd64) sum=50666f6432196aeeca92e6cc79c94168e136a0f96974f452af2156caa0307111 ;;
    dex-arm64) sum=ea7956bd373a0c038ab3bbdfa5a80faaeb716cea0e377e4e877bb9e1ab84aeaf ;;
    *) rm -rf "$auth_tmp"; fail "Mango has no checksum for $1 on $arch." ;;
  esac
  if [ "$1" = caddy ]; then
    echo "Downloading Caddy $CADDY_V"
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_V/caddy_${CADDY_V}_linux_$arch.tar.gz" -o "$auth_tmp/dl" \
      || { rm -rf "$auth_tmp"; fail "could not download Caddy $CADDY_V from GitHub."; }
  else
    echo "Downloading Dex $DEX_V"
    tok=$(curl -fsSL "https://ghcr.io/token?scope=repository:dexidp/dex:pull" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p') || tok=
    [ -n "$tok" ] || { rm -rf "$auth_tmp"; fail "could not reach ghcr.io to download Dex."; }
    curl -fsSL -H "Authorization: Bearer $tok" "https://ghcr.io/v2/dexidp/dex/blobs/sha256:$sum" -o "$auth_tmp/dl" \
      || { rm -rf "$auth_tmp"; fail "could not download Dex $DEX_V from ghcr.io."; }
  fi
  echo "$sum  $auth_tmp/dl" | sha256sum -c --quiet \
    || { rm -rf "$auth_tmp"; fail "the $1 download does not match the checksum Mango pins for it. Nothing was changed."; }
  if [ "$1" = caddy ]; then
    tar -xzf "$auth_tmp/dl" -C "$auth_tmp" --no-same-owner caddy || { rm -rf "$auth_tmp"; fail "could not unpack Caddy."; }
  else
    tar -xzf "$auth_tmp/dl" -C "$auth_tmp" --no-same-owner --strip-components=3 usr/local/bin/dex \
      || { rm -rf "$auth_tmp"; fail "could not unpack Dex."; }
  fi
  [ -f "$auth_tmp/$1" ] || { rm -rf "$auth_tmp"; fail "the $1 download has no $1 in it."; }
}
"##;

/// The sign-in itself (bash, as root, after `recipes::BASICS`, `recipes::LORE_COMMON` and
/// [`AUTH_PINS`]). `auth_main ACTION …` runs one action:
///
/// - `setup DOMAIN PASSWORDS GH_ID GH_ORGS LP LA EMAIL`: install or update Dex and Caddy, ask for
///   the GitHub client secret when there is none yet (or the app changed) and for EMAIL's password
///   when EMAIL is given and new, get the certificate, then write the Lore server's settings
///   (`/etc/lore-auth/lore.toml`). With `AUTH_APPLY=1` it also rewrites the service's mango.toml and
///   restarts it (an instance: a machine's own setup does that after it).
/// - `off`: stop Dex and Caddy and take the Lore settings away (users and certificates are kept).
/// - `user-add EMAIL` (asks for the password), `user-remove EMAIL`, `users`, `github-secret`.
/// - `cert-sync [--no-restart]`: the hourly timer's job. `dex-check`: the watchdog's, every minute.
///   `status`: the state, for Mango to read.
///
/// The installed `/usr/local/sbin/mango-lore-auth` is this same script (`auth_tool`), for the timer
/// and for the owner's own use.
pub(crate) const LORE_AUTH: &str = r##"AUTH_ETC=/etc/lore-auth
AUTH_VAR=/var/lib/lore-auth
AUTH_LIB=/usr/local/lib/mango-lore-auth
AUTH_TOOL=/usr/local/sbin/mango-lore-auth
AUTH_UNITS=/etc/systemd/system
AUTH_DEX_PORT=41381
AUTH_TLS=/etc/lore/tls

auth_valid_domain() {
  case $1 in ''|*[!a-z0-9.-]*|.*|*.|*..*) return 1 ;; esac
  case $1 in *.*) ;; *) return 1 ;; esac
  [ "${#1}" -le 253 ] || return 1
  local l IFS=.
  for l in $1; do
    case $l in ''|-*|*-) return 1 ;; esac
    [ "${#l}" -le 63 ] || return 1
  done
  case ${1##*.} in *[!0-9]*) return 0 ;; esac
  return 1
}
auth_valid_email() {
  case $1 in *@*@*|@*|*@) return 1 ;; *@*) ;; *) return 1 ;; esac
  case ${1%@*} in ''|*[!a-z0-9._%+-]*|.*|*.) return 1 ;; esac
  auth_valid_domain "${1#*@}"
}
auth_valid_list() { case $1 in *[!A-Za-z0-9,-]*) return 1 ;; esac; return 0; }
auth_valid_id() { case $1 in *[!A-Za-z0-9._-]*) return 1 ;; esac; return 0; }
auth_valid_port() { case $1 in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# One setting: auth_setting KEY (empty when unset).
# (No settings file yet is no setting: sed's exit 2 on a missing file would end the script silently.)
auth_setting() { [ -f "$AUTH_ETC/settings" ] || return 0; sed -n "s/^$1=//p" "$AUTH_ETC/settings" | head -n 1; }
auth_users() { [ -f "$AUTH_ETC/users" ] && cut -f1 "$AUTH_ETC/users" || true; }
auth_has_user() { auth_users | grep -Fqx -- "$1"; }
# The users file without EMAIL's line.
auth_users_without() { [ -f "$AUTH_ETC/users" ] && awk -F '\t' -v e="$1" '$1 != e' "$AUTH_ETC/users" || true; }
auth_group() { if getent group lore >/dev/null 2>&1; then echo lore; else echo root; fi; }
auth_url() {
  local d p
  d=$(auth_setting DOMAIN)
  p=$(auth_setting LP)
  # The CLI takes 443 for lores:// without a port, so Lore's port is written out.
  if [ "${p:-41337}" = 443 ]; then echo "lores://$d"; else echo "lores://$d:${p:-41337}"; fi
}

auth_tools() {
  for c in curl sha256sum tar systemctl useradd getent cmp install; do
    command -v "$c" >/dev/null 2>&1 || fail "$c is missing here, and the Lore sign-in needs it."
  done
  [ -d /run/systemd/system ] || fail "the Lore sign-in needs systemd, which is not running here."
}

auth_install() {
  install -d -m 0755 "$AUTH_LIB"
  local have
  have=$(cat "$AUTH_LIB/versions" 2>/dev/null || true)
  if [ -x "$AUTH_LIB/caddy" ] && printf '%s\n' "$have" | grep -qx "caddy $CADDY_V-$(auth_arch)"; then
    echo "Caddy $CADDY_V is up to date."
  else
    auth_get caddy
    install -m 0755 "$auth_tmp/caddy" "$AUTH_LIB/caddy"
    rm -rf "$auth_tmp"
    AUTH_RESTART_CADDY=1
  fi
  if [ -x "$AUTH_LIB/dex" ] && printf '%s\n' "$have" | grep -qx "dex $DEX_V-$(auth_arch)"; then
    echo "Dex $DEX_V is up to date."
  else
    auth_get dex
    install -m 0755 "$auth_tmp/dex" "$AUTH_LIB/dex"
    rm -rf "$auth_tmp"
    AUTH_RESTART_DEX=1
  fi
  printf 'caddy %s-%s\ndex %s-%s\n' "$CADDY_V" "$(auth_arch)" "$DEX_V" "$(auth_arch)" > "$AUTH_LIB/versions"
  if ! id -u lore-auth >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$AUTH_VAR" --no-create-home --shell /usr/sbin/nologin lore-auth
    echo "Created the system user lore-auth."
  fi
  install -d -o root -g lore-auth -m 0750 "$AUTH_ETC"
  install -d -o lore-auth -g lore-auth -m 0750 "$AUTH_VAR" "$AUTH_VAR/caddy" "$AUTH_VAR/config"
  [ -f "$AUTH_ETC/users" ] || install -m 0600 /dev/null "$AUTH_ETC/users"
  if declare -F auth_tool >/dev/null; then auth_tool | put "$AUTH_TOOL" 0755 || true; fi
}

# The GitHub client secret, typed here (never shown, never an argument).
auth_ask_secret() {
  local s
  echo
  echo "Paste the client secret of the GitHub OAuth app $1 (it is not shown; Enter when done)."
  echo "GitHub shows it once, under the app's Client secrets: generate a new one if you don't have it."
  for _ in 1 2 3; do
    IFS= read -rs -p "Client secret: " s || fail "no client secret was typed."
    echo
    case $s in
      ''|*[!A-Za-z0-9_.-]*) echo "That doesn't look like a GitHub client secret (letters and digits). Try again." ;;
      *) printf '%s\n' "$s" | put "$AUTH_ETC/github-secret" 0600 || true; return 0 ;;
    esac
  done
  fail "no usable client secret was typed."
}

# A password for EMAIL, typed here: Caddy asks twice and prints a bcrypt hash.
auth_ask_password() {
  local h
  echo
  echo "Choose the password $1 signs in to Lore with (it is not shown)."
  for _ in 1 2 3; do
    if h=$("$AUTH_LIB/caddy" hash-password --algorithm bcrypt 2>/dev/tty); then
      case $h in
        '$2'*) break ;;
      esac
    fi
    h=
    echo "That didn't work. Try again."
  done
  [ -n "$h" ] || fail "no password was set for $1."
  case $h in *[!A-Za-z0-9./\$]*) fail "Caddy printed a hash Mango doesn't understand." ;; esac
  { auth_users_without "$1"; printf '%s\t%s\n' "$1" "$h"; } > "$AUTH_ETC/users.new"
  install -m 0600 "$AUTH_ETC/users.new" "$AUTH_ETC/users"
  rm -f "$AUTH_ETC/users.new"
  echo "$1 can sign in with that password."
}

auth_dex_yaml() {
  local d pw id orgs secret o e h
  d=$(auth_setting DOMAIN)
  pw=$(auth_setting PASSWORDS)
  id=$(auth_setting GH_ID)
  orgs=$(auth_setting GH_ORGS)
  cat <<EOF
# Written by Mango from $AUTH_ETC/settings and users: change them from Mango (or
# mango-lore-auth), not here. Dex serves sign-in for the Lore server at lores://$d.
issuer: https://$d/dex
storage:
  type: sqlite3
  config:
    file: $AUTH_VAR/dex.db
web:
  http: 127.0.0.1:$AUTH_DEX_PORT
frontend:
  issuer: Lore on $d
oauth2:
  skipApprovalScreen: true
  grantTypes:
    - authorization_code
    - refresh_token
    - urn:ietf:params:oauth:grant-type:device_code
expiry:
  idTokens: 1h
  refreshTokens:
    validIfNotUsedFor: 720h
staticClients:
  - id: lore-cli
    name: Lore CLI
    public: true
    # Dex's own device callback: 2.45 asks for it as /device/callback, 2.46 with the issuer's path.
    # A public client with a list takes only what is on it.
    redirectURIs: ["/device/callback", "/dex/device/callback"]
  # Dex puts client IDs in a token's aud, and the Lore CLI only sends a token to the host its aud
  # names: the scope audience:server:client_id:https://$d adds this one.
  - id: https://$d
    name: Lore server
    public: true
    trustedPeers: ["lore-cli"]
EOF
  if [ "$pw" = yes ]; then
    echo "enablePasswordDB: true"
    echo "staticPasswords:"
    while IFS='	' read -r e h; do
      auth_valid_email "$e" || continue
      case $h in '$2'*) ;; *) continue ;; esac
      printf '  - email: "%s"\n    username: "%s"\n    userID: "%s"\n    hash: "%s"\n' "$e" "$e" "$e" "$h"
    done < "$AUTH_ETC/users"
  else
    echo "enablePasswordDB: false"
  fi
  if [ -n "$id" ]; then
    secret=$(cat "$AUTH_ETC/github-secret" 2>/dev/null || true)
    cat <<EOF
connectors:
  - type: github
    id: github
    name: GitHub
    config:
      clientID: "$id"
      clientSecret: "$secret"
      redirectURI: https://$d/dex/callback
      useLoginAsID: true
      orgs:
EOF
    local IFS=,
    for o in $orgs; do printf '        - name: "%s"\n' "$o"; done
  fi
}

auth_caddyfile() {
  local d la
  d=$(auth_setting DOMAIN)
  la=$(auth_setting LA)
  cat <<EOF
# Written by Mango: Let's Encrypt's certificate for $d, and Dex's sign-in pages over HTTPS.
{
	admin off
	storage file_system {
		root $AUTH_VAR/caddy
	}
	servers {
		protocols h1 h2
	}
}

$d {
EOF
  [ -z "$la" ] || printf '\tbind %s\n' "$la"
  cat <<EOF
	handle /dex/* {
		reverse_proxy 127.0.0.1:$AUTH_DEX_PORT
	}
	handle {
		respond "This server signs people in to Lore: lore login $(auth_url)" 200
	}
}
EOF
}

auth_lore_toml() {
  local d
  d=$(auth_setting DOMAIN)
  cat <<EOF
# Sign-in, written by Mango ($AUTH_ETC): only callers with a token from Dex at https://$d/dex
# get in, and they may read and write. Turn it off from Mango.
[server.auth]
jwt_issuer = "https://$d/dex"
jwt_audience = ["https://$d"]

[server.auth.jwk]
endpoint = "http://127.0.0.1:$AUTH_DEX_PORT/dex/keys"

[server.auth.oidc]
client_id = "lore-cli"
scopes = ["openid", "profile", "email", "offline_access", "audience:server:client_id:https://$d"]

[server.quic.certificate]
cert_file = "$AUTH_TLS/cert.pem"
pkey_file = "$AUTH_TLS/key.pem"

[server.grpc.certificate]
cert_file = "$AUTH_TLS/cert.pem"
pkey_file = "$AUTH_TLS/key.pem"
EOF
}

auth_units() {
  local c=0
  put "$AUTH_UNITS/lore-auth-dex.service" 0644 <<EOF && c=1
[Unit]
Description=Lore sign-in: Dex (set up by Mango)
After=network-online.target
Wants=network-online.target

[Service]
User=lore-auth
Group=lore-auth
WorkingDirectory=$AUTH_VAR
Environment=DEX_EXPAND_ENV=false
ExecStart=$AUTH_LIB/dex serve $AUTH_ETC/dex.yaml
NoNewPrivileges=true
Restart=always
RestartSec=2
# A hung Dex never finishes its own minute of graceful shutdown: don't wait for it.
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF
  put "$AUTH_UNITS/lore-auth-caddy.service" 0644 <<EOF && c=1
[Unit]
Description=Lore sign-in: Caddy, HTTPS for Dex and the certificate (set up by Mango)
After=network-online.target lore-auth-dex.service
Wants=network-online.target

[Service]
User=lore-auth
Group=lore-auth
WorkingDirectory=$AUTH_VAR
Environment=XDG_DATA_HOME=$AUTH_VAR XDG_CONFIG_HOME=$AUTH_VAR/config HOME=$AUTH_VAR
ExecStart=$AUTH_LIB/caddy run --config $AUTH_ETC/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  put "$AUTH_UNITS/lore-auth-cert.service" 0644 <<EOF && c=1
[Unit]
Description=Lore sign-in: give the Lore server Caddy's renewed certificate (set up by Mango)

[Service]
Type=oneshot
ExecStart=$AUTH_TOOL cert-sync
EOF
  put "$AUTH_UNITS/lore-auth-cert.timer" 0644 <<EOF && c=1
[Unit]
Description=Lore sign-in: look for a renewed certificate every hour (set up by Mango)

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF
  put "$AUTH_UNITS/lore-auth-dex-check.service" 0644 <<EOF && c=1
[Unit]
Description=Lore sign-in: restart Dex when it stops answering (set up by Mango)

[Service]
Type=oneshot
ExecStart=$AUTH_TOOL dex-check
EOF
  put "$AUTH_UNITS/lore-auth-dex-check.timer" 0644 <<EOF && c=1
[Unit]
Description=Lore sign-in: check every minute that Dex answers (set up by Mango)

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
  [ "$c" = 0 ] || systemctl daemon-reload
}

# The watchdog's job: Dex answers its keys page, or it is restarted. Dex can hang on its own database
# (one SQLite connection, asked for again inside a transaction: on 2.45 a refresh by a password user
# who was removed) and then answers nothing, though it still runs. Only a timeout counts: a Dex that
# is down or starting is systemd's to restart.
auth_dex_check() {
  systemctl is-active --quiet lore-auth-dex.service || return 0
  local rc=0
  curl -fsS -o /dev/null -m 20 "http://127.0.0.1:$AUTH_DEX_PORT/dex/keys" 2>/dev/null || rc=$?
  [ "$rc" = 28 ] || return 0
  echo "Dex did not answer within 20 seconds: restarting it."
  systemctl restart lore-auth-dex.service
}

# Caddy's newest certificate for the domain, and its key.
auth_cert_files() {
  local d crt
  d=$(auth_setting DOMAIN)
  crt=$(ls -t "$AUTH_VAR"/caddy/certificates/*/"$d"/"$d".crt 2>/dev/null | head -n 1 || true)
  [ -n "$crt" ] && [ -f "${crt%.crt}.key" ] || return 1
  printf '%s\n%s\n' "$crt" "${crt%.crt}.key"
}

auth_cert_sync() {
  local files crt key g
  files=$(auth_cert_files) || { echo "Caddy has no certificate for $(auth_setting DOMAIN) yet."; return 0; }
  crt=$(printf '%s\n' "$files" | sed -n 1p)
  key=$(printf '%s\n' "$files" | sed -n 2p)
  if cmp -s "$crt" "$AUTH_TLS/cert.pem" && cmp -s "$key" "$AUTH_TLS/key.pem"; then return 0; fi
  g=$(auth_group)
  install -d -m 0750 -o root -g "$g" "$AUTH_TLS"
  install -m 0644 -o root -g "$g" "$crt" "$AUTH_TLS/cert.pem"
  install -m 0640 -o root -g "$g" "$key" "$AUTH_TLS/key.pem"
  AUTH_CERT_CHANGED=1
  echo "The Lore server has the certificate for $(auth_setting DOMAIN)."
  [ "${1:-}" != --no-restart ] || return 0
  [ -f "$AUTH_ETC/lore.toml" ] || return 0
  if systemctl is-active --quiet lore.service 2>/dev/null; then
    systemctl restart lore.service
    echo "Restarted the Lore server with it."
  fi
  if command -v docker >/dev/null 2>&1 && docker container inspect mango-lore >/dev/null 2>&1; then
    docker restart mango-lore >/dev/null
    echo "Restarted the Lore server's container with it."
  fi
}

# Ports 80 and 443 are free (or Mango's Caddy holds them).
auth_port_check() {
  command -v ss >/dev/null 2>&1 || { echo "(ss is missing: Mango can't check that ports 80 and 443 are free.)"; return 0; }
  systemctl is-active --quiet lore-auth-caddy.service 2>/dev/null && return 0
  local p
  for p in 80 443; do
    if ss -ltnH 2>/dev/null | awk '{ print $4 }' | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | grep -qx "$p"; then
      fail "port $p is already in use here (another web server?). The sign-in needs ports 80 and 443 for Let's Encrypt and its pages: stop that server, or use another machine."
    fi
  done
}

auth_wait_cert() {
  local d
  d=$(auth_setting DOMAIN)
  echo "Waiting for Let's Encrypt's certificate for $d (up to 3 minutes)..."
  for _ in $(seq 90); do
    if auth_cert_files >/dev/null; then echo "Caddy has the certificate."; return 0; fi
    sleep 2
  done
  journalctl --no-pager -u lore-auth-caddy.service -n 25 2>/dev/null || true
  echo
  echo "What Let's Encrypt needs: $d resolves to this server's public address"
  if command -v getent >/dev/null 2>&1; then
    echo "(here it resolves to: $(getent ahosts "$d" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' '))"
  fi
  echo "and TCP ports 80 and 443 reach this server from the internet (firewall, cloud security group)."
  fail "there is no certificate for $d yet. Fix the above and run this again: Caddy keeps trying in the meantime."
}

# The service's mango.toml with (or without) the sign-in, and a restart when it or the certificate changed.
auth_apply_lore() {
  [ -f /etc/systemd/system/lore.service ] && grep -q 'set up by Mango' /etc/systemd/system/lore.service || return 0
  local c=${AUTH_CERT_CHANGED:-0}
  lore_toml | put /etc/lore/config/mango.toml 0644 && c=1
  if [ "$c" = 1 ]; then
    say "Restarting the Lore server"
    systemctl restart lore.service
    for _ in $(seq 60); do
      if systemctl is-active --quiet lore.service; then return 0; fi
      sleep 1
    done
    journalctl --no-pager -u lore.service -n 25 || true
    fail "the Lore server did not come back (see above)."
  fi
}

auth_setup() {
  local d=$1 pw=$2 id=$3 orgs=$4 lp=$5 la=$6 email=$7 old_id
  auth_valid_domain "$d" || fail "\"$d\" is not a domain name."
  case $pw in yes|no) ;; *) fail "bad value for passwords: $pw." ;; esac
  auth_valid_id "$id" && auth_valid_list "$orgs" || fail "bad GitHub settings."
  [ -z "$id" ] || [ -n "$orgs" ] || fail "name the GitHub organisation whose members may sign in."
  [ "$pw" = yes ] || [ -n "$id" ] || fail "pick passwords, GitHub, or both."
  auth_valid_port "$lp" || fail "bad port: $lp."
  case $la in ''|*[!0-9a-fA-F.:]*) [ -z "$la" ] || fail "bad address: $la." ;; esac
  [ -z "$email" ] || auth_valid_email "$email" || fail "\"$email\" is not an email address."
  say "Lore sign-in for $d (Dex $DEX_V and Caddy $CADDY_V)"
  auth_tools
  AUTH_RESTART_CADDY=0 AUTH_RESTART_DEX=0 AUTH_CERT_CHANGED=0
  auth_install
  old_id=$(auth_setting GH_ID)
  printf 'DOMAIN=%s\nPASSWORDS=%s\nGH_ID=%s\nGH_ORGS=%s\nLP=%s\nLA=%s\n' "$d" "$pw" "$id" "$orgs" "$lp" "$la" \
    | put "$AUTH_ETC/settings" 0640 && { AUTH_RESTART_CADDY=1; AUTH_RESTART_DEX=1; }
  chgrp lore-auth "$AUTH_ETC/settings"
  if [ -n "$id" ] && { [ ! -s "$AUTH_ETC/github-secret" ] || [ "$old_id" != "$id" ]; }; then
    auth_ask_secret "$id"
  fi
  if [ "$pw" = yes ] && [ -n "$email" ] && ! auth_has_user "$email"; then
    auth_ask_password "$email"
  fi
  auth_render
  auth_units
  systemctl enable lore-auth-dex.service lore-auth-caddy.service lore-auth-cert.timer lore-auth-dex-check.timer >/dev/null 2>&1
  auth_port_check
  systemctl restart lore-auth-dex.service
  if [ "$AUTH_RESTART_CADDY" = 1 ] || ! systemctl is-active --quiet lore-auth-caddy.service; then
    systemctl restart lore-auth-caddy.service
  fi
  systemctl start lore-auth-cert.timer lore-auth-dex-check.timer
  auth_wait_cert
  auth_cert_sync --no-restart
  auth_lore_toml | put "$AUTH_ETC/lore.toml" 0644 || true
  [ "${AUTH_APPLY:-0}" = 0 ] || auth_apply_lore
  if [ "$pw" = yes ] && [ -z "$(auth_users)" ]; then
    echo "Nobody can sign in with a password yet: add a user from Mango."
  fi
  echo "Sign-in is on. Clients use $(auth_url) and sign in with: lore login $(auth_url)"
}

# dex.yaml from the settings, users and secret; Dex restarted when it changed.
auth_render() {
  auth_dex_yaml | put "$AUTH_ETC/dex.yaml" 0640 && AUTH_RESTART_DEX=1
  chgrp lore-auth "$AUTH_ETC/dex.yaml"
  auth_caddyfile | put "$AUTH_ETC/Caddyfile" 0644 && AUTH_RESTART_CADDY=1
  return 0
}

auth_off() {
  say "Turning the Lore server's sign-in off"
  systemctl disable --now lore-auth-caddy.service lore-auth-dex.service lore-auth-cert.timer lore-auth-dex-check.timer >/dev/null 2>&1 || true
  rm -f "$AUTH_ETC/lore.toml"
  [ "${AUTH_APPLY:-0}" = 0 ] || auth_apply_lore
  echo "Sign-in is off: anyone who reaches the server can read and write again. Users, the GitHub secret"
  echo "and the certificate stay in $AUTH_ETC and $AUTH_VAR for when you turn it back on."
}

auth_main() {
  local action=${1:-}
  shift || true
  case $action in
    setup) auth_setup "$@" ;;
    off) auth_off ;;
    user-add)
      auth_valid_email "${1:-}" || fail "\"${1:-}\" is not an email address."
      [ -f "$AUTH_ETC/settings" ] || fail "the sign-in isn't set up here."
      [ "$(auth_setting PASSWORDS)" = yes ] || fail "this server's sign-in doesn't use passwords. Turn them on first."
      auth_ask_password "$1"
      AUTH_RESTART_DEX=0
      auth_render
      [ "$AUTH_RESTART_DEX" = 0 ] || ! systemctl is-active --quiet lore-auth-dex.service || systemctl restart lore-auth-dex.service
      ;;
    user-remove)
      auth_valid_email "${1:-}" || fail "\"${1:-}\" is not an email address."
      auth_has_user "$1" || fail "$1 is not a user here."
      auth_users_without "$1" > "$AUTH_ETC/users.new"
      install -m 0600 "$AUTH_ETC/users.new" "$AUTH_ETC/users"
      rm -f "$AUTH_ETC/users.new"
      AUTH_RESTART_DEX=0
      auth_render
      [ "$AUTH_RESTART_DEX" = 0 ] || ! systemctl is-active --quiet lore-auth-dex.service || systemctl restart lore-auth-dex.service
      echo "$1 can no longer sign in with a password (a sign-in they already have ends within an hour)."
      ;;
    users)
      if [ -z "$(auth_users)" ]; then echo "No password users."; else echo "Password users:"; auth_users | sed 's/^/  /'; fi
      ;;
    github-secret)
      [ -n "$(auth_setting GH_ID)" ] || fail "this server's sign-in doesn't use GitHub."
      auth_ask_secret "$(auth_setting GH_ID)"
      AUTH_RESTART_DEX=0
      auth_render
      systemctl restart lore-auth-dex.service
      echo "Dex uses the new secret."
      ;;
    cert-sync) auth_cert_sync "${1:-}" ;;
    dex-check) auth_dex_check ;;
    status)
      if [ -f "$AUTH_ETC/lore.toml" ]; then echo "authOn yes"; else echo "authOn no"; fi
      [ -f "$AUTH_ETC/settings" ] || return 0
      printf 'authDomain %s\nauthPasswords %s\nauthGithubId %s\nauthGithubOrgs %s\n' \
        "$(auth_setting DOMAIN)" "$(auth_setting PASSWORDS)" "$(auth_setting GH_ID)" "$(auth_setting GH_ORGS)"
      if [ -s "$AUTH_ETC/github-secret" ]; then echo "authGithubSecret yes"; fi
      if auth_cert_files >/dev/null; then echo "authCert yes"; fi
      auth_users | sed 's/^/authUser /'
      ;;
    *) fail "unknown sign-in action \"$action\"." ;;
  esac
}

# The installed tool, /usr/local/sbin/mango-lore-auth: these settings and functions, then auth_main.
auth_tool() {
  printf '%s\n' '#!/bin/bash' "# Mango's Lore sign-in beside the Lore server. Mango writes this file again on every setup." \
    '# Usage: mango-lore-auth users | user-add EMAIL | user-remove EMAIL | github-secret | status' 'set -Eeuo pipefail'
  declare -p LORE_V CADDY_V DEX_V AUTH_ETC AUTH_VAR AUTH_LIB AUTH_TOOL AUTH_UNITS AUTH_DEX_PORT AUTH_TLS | sed 's/^declare -[-a-zA-Z]* //'
  # shellcheck disable=SC2046
  declare -f $(declare -F | awk '{ print $3 }' | grep -E '^(say|fail|put|lore_[a-z_]+|auth_[a-z_]+)$')
  echo 'auth_main "$@"'
}
"##;

/// The functions (with `auth_tool`, which prints the installed tool from them), for a root script to
/// include after `recipes::BASICS` and `recipes::LORE_COMMON`.
pub(crate) fn functions() -> String {
    format!("{AUTH_PINS}{LORE_AUTH}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign_in() -> LoreSignIn {
        LoreSignIn {
            domain: " Lore.Example.com. ".into(),
            passwords: true,
            github: Some(LoreSignInGithub { client_id: "Ov23liAbc.1-x".into(), orgs: vec!["fruit-co".into(), "Fruit-Co".into(), "acme".into()] }),
        }
    }

    #[test]
    fn input_is_checked() {
        let s = clean(sign_in()).unwrap();
        assert_eq!(s.domain, "lore.example.com");
        assert_eq!(s.github.as_ref().unwrap().orgs, ["fruit-co", "acme"]);
        assert_eq!(setup_args(&s), ["lore.example.com", "yes", "Ov23liAbc.1-x", "fruit-co,acme"]);
        assert!(clean(LoreSignIn { github: None, ..sign_in() }).is_ok());
        for bad in [
            LoreSignIn { domain: "localhost".into(), ..sign_in() },
            LoreSignIn { domain: "203.0.113.7".into(), ..sign_in() },
            LoreSignIn { domain: "a..b".into(), ..sign_in() },
            LoreSignIn { domain: "x.example.com;id".into(), ..sign_in() },
            LoreSignIn { domain: "-x.example.com".into(), ..sign_in() },
            LoreSignIn { passwords: false, github: None, ..sign_in() },
            LoreSignIn { github: Some(LoreSignInGithub { client_id: "abc$(id)".into(), orgs: vec!["a".into()] }), ..sign_in() },
            LoreSignIn { github: Some(LoreSignInGithub { client_id: "Ov23li".into(), orgs: vec![] }), ..sign_in() },
            LoreSignIn { github: Some(LoreSignInGithub { client_id: "Ov23li".into(), orgs: vec!["a--b".into()] }), ..sign_in() },
            LoreSignIn { github: Some(LoreSignInGithub { client_id: "Ov23li".into(), orgs: vec!["a,b".into()] }), ..sign_in() },
        ] {
            assert!(clean(bad.clone()).is_err(), "{bad:?}");
        }
        assert_eq!(valid_email(" Ann.Lee+lore@Example.COM ").unwrap(), "ann.lee+lore@example.com");
        for bad in ["", "ann", "ann@", "@x.com", "a@b@c.com", "a b@x.com", "a@localhost", "a\t@x.com", ".a@x.com", "a\"@x.com"] {
            assert!(valid_email(bad).is_err(), "{bad}");
        }
        assert_eq!(secure_url("lore.example.com", 41337), "lores://lore.example.com:41337");
        assert_eq!(secure_url("lore.example.com", 443), "lores://lore.example.com");
        assert_eq!(secure_url("lore.example.com", 41400), "lores://lore.example.com:41400");
    }

    #[test]
    fn reads_the_status() {
        let out = "noise\nauthOn yes\nauthDomain lore.example.com\nauthPasswords yes\nauthGithubId Ov23li\nauthGithubOrgs fruit-co,acme\n\
                   authGithubSecret yes\nauthCert yes\nauthUser ann@example.com\nauthUser bad user\n";
        let st = parse_status(out);
        assert!(st.on && st.passwords && st.github_secret && st.certificate);
        assert_eq!(st.domain.as_deref(), Some("lore.example.com"));
        assert_eq!(st.github.unwrap().orgs, ["fruit-co", "acme"]);
        assert_eq!(st.users, ["ann@example.com"]);
        let off = parse_status("authOn no\nauthDomain lore.example.com\nauthPasswords no\nauthGithubId \n");
        assert!(!off.on && off.github.is_none() && off.domain.is_some());
        assert_eq!(parse_status(""), LoreSignInState::default());
    }

    /// Runs `script` in bash (on stdin: a long argument with quotes doesn't survive Windows' command
    /// line) with `args`; None when there is no bash.
    fn bash(script: &str, args: &[&str]) -> Option<std::process::Output> {
        use std::io::Write;
        let bash = crate::bin::test_shell("bash")?;
        let mut child = std::process::Command::new(bash)
            .arg("-s")
            .arg("--")
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        Some(child.wait_with_output().unwrap())
    }

    fn root() -> String {
        format!("set -Eeuo pipefail\n{}{}{}", crate::envs::recipes::BASICS, crate::envs::recipes::LORE_COMMON, functions())
    }

    /// The script parses, as sent and as installed (the tool `auth_tool` prints runs on its own).
    #[test]
    fn scripts_parse() {
        crate::bin::assert_parses("bash", &format!("{}auth_main \"$@\"\n", root()));
        let Some(out) = bash(&format!("{}auth_tool\n", root()), &[]) else { return eprintln!("no bash found; skipping") };
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let tool = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(tool.starts_with("#!/bin/bash\n") && tool.ends_with("auth_main \"$@\"\n"), "{tool}");
        assert!(tool.contains("AUTH_ETC=\"/etc/lore-auth\"") && tool.contains("auth_cert_sync ()") && tool.contains("lore_toml ()"));
        // The watchdog's timer runs the installed tool, so its check must be in it.
        assert!(tool.contains("auth_dex_check ()") && tool.contains("AUTH_DEX_PORT=\"41381\""), "{tool}");
        crate::bin::assert_parses("bash", &tool);
        // It runs on its own: the validators answer before anything is touched.
        let out = bash(&tool, &["user-add", "not an email"]).unwrap();
        assert!(!out.status.success() && String::from_utf8_lossy(&out.stderr).contains("is not an email address"));
    }

    /// A first setup has no settings file yet: reading one is empty, not the end of the script
    /// (`sed` exits 2 on a missing file, which errexit and pipefail turned into a silent exit 2).
    #[test]
    fn missing_settings_read_as_empty() {
        let script = format!("{}AUTH_ETC=$(mktemp -d)/none; x=$(auth_setting GH_ID); echo \"reached [$x]\"\n", root());
        let Some(out) = bash(&script, &[]) else { return eprintln!("no bash found; skipping") };
        assert!(out.status.success(), "exit {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "reached []");
    }

    /// The validators in the script agree with the ones here.
    #[test]
    fn script_validators_agree() {
        if crate::bin::test_shell("bash").is_none() {
            return eprintln!("no bash found; skipping");
        }
        let probe = |func: &str, value: &str| bash(&format!("{LORE_AUTH}{func} \"$1\"\n"), &[value]).unwrap().status.success();
        for (v, ok) in [("lore.example.com", true), ("a.b", true), ("localhost", false), ("1.2.3.4", false), ("a..b", false), ("x.com;id", false), ("-a.com", false), ("a-.com", false)] {
            assert_eq!(probe("auth_valid_domain", v), ok, "{v}");
            assert_eq!(valid_domain(v).is_ok(), ok, "{v}");
        }
        for (v, ok) in [("ann@example.com", true), ("a.b+c@x.co", true), ("a@b@c.com", false), ("@x.com", false), ("a$@x.com", false), ("a@x", false)] {
            assert_eq!(probe("auth_valid_email", v), ok, "{v}");
            assert_eq!(valid_email(v).is_ok(), ok, "{v}");
        }
    }

    /// The pinned downloads are what the pins say (network): `cargo test real_downloads -- --ignored`.
    #[test]
    #[ignore]
    fn real_downloads() {
        let script = format!(
            "set -Eeuo pipefail\n{}{AUTH_PINS}for a in amd64 arm64; do auth_arch() {{ echo $a; }}; for n in caddy dex; do auth_get $n; echo \"ok $n $a\"; rm -rf \"$auth_tmp\"; done; done\n",
            crate::envs::recipes::BASICS
        );
        use std::io::Write;
        let bash = crate::bin::test_shell("bash").expect("bash");
        let mut child = std::process::Command::new(bash)
            .arg("-s")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        println!("{text}");
        assert!(out.status.success(), "{text}");
        assert_eq!(text.matches("ok ").count(), 4);
    }
}
