//! Share links: `mango://join/<payload>`, one line (also shown as a QR code)
//! that gives someone full access to one environment and nothing else.
//!
//! The owner's Mango makes a fresh Ed25519 key pair per share. Only the public
//! half goes into the environment (the agent user's `authorized_keys`); the
//! private half exists in the link alone. The link also pins the environment's
//! SSH host key, so the person joining connects to exactly that environment.
//!
//! Payload: base64url (no padding) of compact JSON, see [`ShareToken`].

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const SCHEME_PREFIX: &str = "mango://join/";
const MAX_LINK: usize = 2048;

/// Everything a share link carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShareToken {
    /// Format version (1).
    pub v: u8,
    /// The share's id (also in the key's comment, so it can be revoked).
    pub id: String,
    /// The environment's name (the instance).
    pub n: String,
    /// Where it was shared from, for display, e.g. "forge/dev".
    pub f: String,
    /// Address to connect to (an IP or DNS name).
    pub h: String,
    /// SSH port.
    pub p: u16,
    /// User inside the environment.
    pub u: String,
    /// The Ed25519 private key seed, base64url.
    pub k: String,
    /// The environment's SSH host key: the base64 blob of its `ssh-ed25519` public key.
    pub hk: String,
    /// When the access ends (unix seconds); 0 = never.
    #[serde(default)]
    pub e: u64,
}

/// A fresh key seed.
pub fn new_seed() -> Result<[u8; 32], String> {
    use ring::rand::SecureRandom;
    let mut seed = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut seed)
        .map_err(|_| "Could not get random bytes for a share key.".to_string())?;
    Ok(seed)
}

/// The 32-byte public key for a seed.
pub fn public_key(seed: &[u8; 32]) -> Result<[u8; 32], String> {
    use ring::signature::KeyPair;
    let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(seed)
        .map_err(|_| "Invalid share key.".to_string())?;
    let mut out = [0u8; 32];
    out.copy_from_slice(pair.public_key().as_ref());
    Ok(out)
}

fn put_str(buf: &mut Vec<u8>, s: &[u8]) {
    buf.extend_from_slice(&(s.len() as u32).to_be_bytes());
    buf.extend_from_slice(s);
}

/// The SSH wire blob of an `ssh-ed25519` public key.
fn public_blob(public: &[u8; 32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(51);
    put_str(&mut b, b"ssh-ed25519");
    put_str(&mut b, public);
    b
}

/// `ssh-ed25519 AAAA… comment`, for `authorized_keys`.
pub fn public_line(seed: &[u8; 32], comment: &str) -> Result<String, String> {
    let blob = public_blob(&public_key(seed)?);
    Ok(format!("ssh-ed25519 {} {comment}", STANDARD.encode(blob)).trim_end().to_string())
}

/// The private key as an unencrypted OpenSSH key file (what `ssh -i` reads).
pub fn openssh_private_key(seed: &[u8; 32], comment: &str) -> Result<String, String> {
    let public = public_key(seed)?;
    let blob = public_blob(&public);

    let check = u32::from_be_bytes([seed[0], seed[1], seed[2], seed[3]]);
    let mut private = Vec::new();
    private.extend_from_slice(&check.to_be_bytes());
    private.extend_from_slice(&check.to_be_bytes());
    put_str(&mut private, b"ssh-ed25519");
    put_str(&mut private, &public);
    let mut both = Vec::with_capacity(64);
    both.extend_from_slice(seed);
    both.extend_from_slice(&public);
    put_str(&mut private, &both);
    put_str(&mut private, comment.as_bytes());
    let mut pad = 1u8;
    while private.len() % 8 != 0 {
        private.push(pad);
        pad += 1;
    }

    let mut out = b"openssh-key-v1\0".to_vec();
    put_str(&mut out, b"none");
    put_str(&mut out, b"none");
    put_str(&mut out, b"");
    out.extend_from_slice(&1u32.to_be_bytes());
    put_str(&mut out, &blob);
    put_str(&mut out, &private);

    let b64 = STANDARD.encode(out);
    let mut pem = String::from("-----BEGIN OPENSSH PRIVATE KEY-----\n");
    for chunk in b64.as_bytes().chunks(70) {
        pem.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END OPENSSH PRIVATE KEY-----\n");
    Ok(pem)
}

/// A `known_hosts` line pinning `host_key` (a base64 `ssh-ed25519` blob) for host:port.
pub fn known_hosts_line(host: &str, port: u16, host_key: &str) -> String {
    let name = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
    format!("{name} ssh-ed25519 {host_key}")
}

pub fn encode_seed(seed: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(seed)
}

pub fn decode_seed(s: &str) -> Result<[u8; 32], String> {
    let bytes = URL_SAFE_NO_PAD.decode(s.trim()).map_err(|_| "The link's key is damaged.".to_string())?;
    bytes.try_into().map_err(|_| "The link's key is damaged.".to_string())
}

/// The `mango://join/…` link for a token.
pub fn encode(token: &ShareToken) -> Result<String, String> {
    let json = serde_json::to_vec(token).map_err(|e| e.to_string())?;
    Ok(format!("{SCHEME_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
}

fn valid_address(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
}

fn valid_user(u: &str) -> bool {
    !u.is_empty()
        && u.len() <= 32
        && u.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && u.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_-".contains(c))
}

fn valid_host_key(hk: &str) -> bool {
    let Ok(blob) = STANDARD.decode(hk) else { return false };
    blob.len() == 51 && blob[..15] == [0, 0, 0, 11, b's', b's', b'h', b'-', b'e', b'd', b'2', b'5', b'5', b'1', b'9']
}

/// Read a pasted link (or bare payload) and check every field.
pub fn decode(link: &str) -> Result<ShareToken, String> {
    let link: String = link.chars().filter(|c| !c.is_whitespace()).collect();
    if link.len() > MAX_LINK {
        return Err("That is not a Mango share link (it is far too long).".into());
    }
    let payload = link.strip_prefix(SCHEME_PREFIX).unwrap_or(&link);
    let bad = || "That is not a Mango share link. Paste the whole line that starts with mango://join/.".to_string();
    let json = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).map_err(|_| bad())?;
    let t: ShareToken = serde_json::from_slice(&json).map_err(|_| bad())?;
    if t.v != 1 {
        return Err("This share link is from a newer Mango. Update Mango to join it.".into());
    }
    super::valid_instance(&t.n)?;
    let ok = !t.id.is_empty()
        && t.id.len() <= 64
        && t.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && t.f.chars().count() <= 200
        && !t.f.chars().any(|c| c.is_control())
        && valid_address(&t.h)
        && t.p != 0
        && valid_user(&t.u)
        && valid_host_key(&t.hk);
    if !ok {
        return Err(bad());
    }
    decode_seed(&t.k)?;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn rfc8032_public_key() {
        let seed: [u8; 32] = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60").try_into().unwrap();
        assert_eq!(public_key(&seed).unwrap().to_vec(), hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"));
        let line = public_line(&seed, "mango-share:x").unwrap();
        assert!(line.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI"), "{line}");
        assert!(line.ends_with(" mango-share:x"));
    }

    #[test]
    fn private_key_file_shape() {
        let seed = [7u8; 32];
        let pem = openssh_private_key(&seed, "c").unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(pem.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));
        let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        let raw = STANDARD.decode(body).unwrap();
        assert!(raw.starts_with(b"openssh-key-v1\0"));
        assert!(pem.lines().all(|l| l.len() <= 70 || l.starts_with("-----")));
    }

    fn token() -> ShareToken {
        let seed = [9u8; 32];
        let hk = STANDARD.encode(public_blob(&public_key(&[1u8; 32]).unwrap()));
        ShareToken {
            v: 1,
            id: "a1b2c3".into(),
            n: "dev".into(),
            f: "forge/dev".into(),
            h: "203.0.113.24".into(),
            p: 22001,
            u: "agent".into(),
            k: encode_seed(&seed),
            hk,
            e: 0,
        }
    }

    #[test]
    fn link_round_trip() {
        let t = token();
        let link = encode(&t).unwrap();
        assert!(link.starts_with(SCHEME_PREFIX));
        assert!(link.len() < 400, "{} chars", link.len());
        assert_eq!(decode(&link).unwrap(), t);
        // Pasted with line breaks or without the scheme.
        let wrapped = format!("  {}\n{}  ", &link[..40], &link[40..]);
        assert_eq!(decode(&wrapped).unwrap(), t);
        assert_eq!(decode(link.strip_prefix(SCHEME_PREFIX).unwrap()).unwrap(), t);
    }

    #[test]
    fn rejects_bad_links() {
        assert!(decode("https://example.com").is_err());
        assert!(decode("mango://join/!!!").is_err());
        let mut t = token();
        t.h = "-oProxyCommand=sh".into();
        assert!(decode(&encode(&t).unwrap()).is_err());
        let mut t = token();
        t.u = "root;id".into();
        assert!(decode(&encode(&t).unwrap()).is_err());
        let mut t = token();
        t.hk = STANDARD.encode(b"not a key");
        assert!(decode(&encode(&t).unwrap()).is_err());
        let mut t = token();
        t.v = 2;
        assert!(decode(&encode(&t).unwrap()).unwrap_err().contains("newer Mango"));
    }

    #[test]
    fn known_hosts_lines() {
        assert_eq!(known_hosts_line("10.0.0.2", 22, "AAAA"), "10.0.0.2 ssh-ed25519 AAAA");
        assert_eq!(known_hosts_line("host", 22001, "AAAA"), "[host]:22001 ssh-ed25519 AAAA");
    }
}
