//! Readers of `lore`'s text output. Lore has no machine-readable mode, so these
//! read what a person would: every reader skips lines it doesn't know and never
//! panics, because the CLI is pre-1.0 and its wording may move. Proven against
//! lore 0.14.0+2389; the fixtures in the tests are its real output.

/// Which section of `lore status` an entry was listed under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Section {
    /// "Changes staged for commit:"
    Staged,
    /// "Changes not staged for commit:"
    Unstaged,
    /// "Untracked files:" (new files Lore doesn't track yet)
    Untracked,
    /// "Changes in conflict:" (a merge waiting for its conflicts to be resolved)
    Conflict,
}

/// One changed path, from `lore status` or `lore revision info --delta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub section: Section,
    /// Git-style letter: A, M, D, or R (Lore's `V`, a move).
    pub letter: &'static str,
    /// Relative to the repository root, forward slashes, no trailing slash.
    pub path: String,
    /// Where a move came from.
    pub orig: Option<String>,
    /// Lore printed it with a trailing `/`: a directory.
    pub dir: bool,
}

/// How the branch stands against the server's copy of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Remote {
    /// No word on the server: an offline repository, or a server that didn't answer.
    #[default]
    Unknown,
    InSync,
    Ahead,
    Behind,
    Diverged,
    /// The branch was never pushed.
    NoBranch,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Status {
    pub branch: Option<String>,
    /// The revision the working tree is at; 0 in an empty repository.
    pub revision: Option<u64>,
    pub signature: Option<String>,
    /// The server's latest revision of the branch.
    pub remote_revision: Option<u64>,
    pub remote_signature: Option<String>,
    pub remote: Remote,
    /// A merge is waiting to be committed ("Pending merge, incoming revision …").
    pub merging: bool,
    /// The signature of the revision being merged in ("… incoming revision <signature>").
    pub incoming: Option<String>,
    pub entries: Vec<Entry>,
}

const NO_SIGNATURE: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// `revision 5 -> e7247e95…` (after "On branch main " or "Remote ").
fn revision_arrow(text: &str) -> Option<(u64, String)> {
    let rest = text.trim().strip_prefix("revision ")?;
    let (n, sig) = rest.split_once("->")?;
    let sig = sig.trim();
    Some((n.trim().parse().ok()?, sig.to_string()))
}

/// The letter for a Lore change code.
fn letter(code: &str) -> &'static str {
    match code.chars().next() {
        Some('A') => "A",
        Some('D') => "D",
        Some('V') => "R",
        _ => "M",
    }
}

/// A path as Lore printed it, in our form; None for anything outside the repository
/// (Lore prints paths relative to the folder it runs in, and Mango runs it at the root).
fn rel_path(p: &str) -> Option<(String, bool)> {
    let p = p.replace('\\', "/");
    let dir = p.ends_with('/');
    let p = p.trim_start_matches("./").trim_end_matches('/');
    crate::git::clean_rel(p).ok().map(|p| (p.to_string(), dir))
}

/// One entry line: `M a.txt`, `A src/ `, `V a.txt -> b.txt`, `M  a.txt (M)!`.
/// None for anything else.
pub(crate) fn entry_line(line: &str, section: Section) -> Option<Entry> {
    let (code, rest) = line.split_once(' ')?;
    if code.is_empty() || code.len() > 2 || !code.chars().all(|c| c.is_ascii_uppercase()) {
        return None;
    }
    // Staged lines end in a space; a conflict ends in `!`; a merge's own code follows in brackets.
    let mut rest = rest.trim_start().trim_end_matches(' ');
    rest = rest.strip_suffix('!').unwrap_or(rest);
    if let Some(open) = rest.rfind(" (") {
        let inner = &rest[open + 2..];
        if inner.len() <= 3 && inner.ends_with(')') && inner[..inner.len() - 1].chars().all(|c| c.is_ascii_uppercase()) {
            rest = &rest[..open];
        }
    }
    if rest.is_empty() {
        return None;
    }
    let letter = letter(code);
    let (orig, path) = match rest.split_once(" -> ") {
        Some((from, to)) if letter == "R" => (rel_path(from).map(|p| p.0), to),
        _ => (None, rest),
    };
    let (path, dir) = rel_path(path)?;
    Some(Entry { section, letter, path, orig, dir })
}

/// Parse `lore status` (with or without `--scan`), run at the repository root.
pub(crate) fn parse_status(text: &str) -> Status {
    let mut out = Status::default();
    let mut section: Option<Section> = None;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if let Some(rest) = trimmed.strip_prefix("On branch ") {
            // `On branch main revision 1 -> e724…`; a branch name has no spaces.
            let (name, arrow) = rest.split_once(' ').unwrap_or((rest, ""));
            out.branch = Some(name.to_string()).filter(|n| !n.is_empty());
            if let Some((n, sig)) = revision_arrow(arrow) {
                out.revision = Some(n);
                out.signature = Some(sig).filter(|s| s != NO_SIGNATURE);
            }
            section = None;
            continue;
        }
        if let Some((n, sig)) = trimmed.strip_prefix("Remote ").and_then(revision_arrow) {
            out.remote_revision = Some(n);
            out.remote_signature = Some(sig).filter(|s| s != NO_SIGNATURE);
            if out.remote == Remote::Unknown {
                out.remote = Remote::InSync;
            }
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("local branch") {
            out.remote = if lower.contains("diverged") {
                Remote::Diverged
            } else if lower.contains("ahead") {
                Remote::Ahead
            } else if lower.contains("behind") {
                Remote::Behind
            } else {
                Remote::InSync
            };
            continue;
        }
        if lower.starts_with("remote branch does not exist") {
            out.remote = Remote::NoBranch;
            continue;
        }
        if lower.starts_with("pending merge") {
            out.merging = true;
            out.incoming = signature_after(trimmed, "incoming revision ");
            continue;
        }
        let header = match trimmed {
            "Changes staged for commit:" => Some(Section::Staged),
            "Changes not staged for commit:" => Some(Section::Unstaged),
            "Untracked files:" => Some(Section::Untracked),
            "Changes in conflict:" => Some(Section::Conflict),
            _ => None,
        };
        if header.is_some() {
            section = header;
            continue;
        }
        if let Some(s) = section {
            match entry_line(trimmed, s) {
                Some(e) => out.entries.push(e),
                // "Tracked changes: …" and the like end the list.
                None => section = None,
            }
        }
    }
    out
}

/// One revision from `lore history` or `lore revision info`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Revision {
    pub number: u64,
    pub signature: String,
    /// "Parent" lines (`revision info`); `history` prints none.
    pub parents: Vec<String>,
    /// The other side of a merge ("Merge" line, `history`).
    pub merge: Option<String>,
    /// Who made it (`Creator`), when Lore says: a repository with a server does, an offline one doesn't.
    pub author: String,
    /// Who committed it (`Committer`); the author when Lore names only one.
    pub committer: String,
    /// Unix ms.
    pub time: i64,
    pub message: String,
    /// `revision info --delta`: the paths it changed.
    pub changes: Vec<Entry>,
}

impl Revision {
    pub(crate) fn subject(&self) -> String {
        self.message.lines().next().unwrap_or_default().trim().to_string()
    }
    pub(crate) fn short(&self) -> String {
        format!("r{}", self.number)
    }
}

/// `Key       : value` lines.
fn field(line: &str) -> Option<(&str, &str)> {
    let (k, v) = line.split_once(':')?;
    let k = k.trim();
    (!k.is_empty() && !line.starts_with(' ') && k.chars().all(|c| c.is_ascii_alphabetic() || c == ' ')).then(|| (k, v.trim()))
}

/// Parse blocks of `Revision  : 1` / `Signature : …` / … / indented message lines, as
/// `lore history`, `lore revision info [--delta]`, `lore commit` and `lore revision amend` print them.
pub(crate) fn parse_revisions(text: &str) -> Vec<Revision> {
    let mut out: Vec<Revision> = Vec::new();
    let mut message: Vec<&str> = Vec::new();
    let mut in_message = false;
    let finish = |out: &mut Vec<Revision>, message: &mut Vec<&str>| {
        if let Some(last) = out.last_mut() {
            if last.message.is_empty() && !message.is_empty() {
                while message.last().is_some_and(|l| l.trim().is_empty()) {
                    message.pop();
                }
                last.message = message.join("\n");
            }
        }
        message.clear();
    };
    for line in text.lines() {
        if let Some(text) = line.strip_prefix("    ") {
            if !out.is_empty() && (in_message || out.last().is_some_and(|r| r.message.is_empty())) {
                in_message = true;
                message.push(text);
                continue;
            }
        }
        if in_message && line.trim().is_empty() {
            message.push("");
            continue;
        }
        if in_message {
            finish(&mut out, &mut message);
            in_message = false;
        }
        if let Some((key, value)) = field(line) {
            match key {
                "Revision" => {
                    if let Ok(n) = value.parse() {
                        out.push(Revision { number: n, ..Default::default() });
                    }
                }
                "Signature" => {
                    if let Some(r) = out.last_mut() {
                        r.signature = value.to_string();
                    }
                }
                "Parent" => {
                    if let Some(r) = out.last_mut() {
                        r.parents.push(value.to_string());
                    }
                }
                "Merge" => {
                    if let Some(r) = out.last_mut() {
                        r.merge = Some(value.to_string());
                    }
                }
                "Creator" | "Author" | "User" | "Owner" => {
                    if let Some(r) = out.last_mut() {
                        r.author = value.to_string();
                    }
                }
                "Committer" => {
                    if let Some(r) = out.last_mut() {
                        r.committer = value.to_string();
                    }
                }
                "Date" => {
                    if let Some(r) = out.last_mut() {
                        r.time = parse_date(value).unwrap_or(0);
                    }
                }
                _ => {}
            }
            continue;
        }
        // `revision info --delta`: the changed paths after the message.
        if let (Some(r), Some(e)) = (out.last_mut(), entry_line(line.trim_end(), Section::Staged)) {
            if !r.signature.is_empty() {
                r.changes.push(e);
            }
        }
    }
    finish(&mut out, &mut message);
    out.retain(|r| !r.signature.is_empty());
    for r in &mut out {
        if r.author.is_empty() {
            r.author = r.committer.clone();
        } else if r.committer.is_empty() {
            r.committer = r.author.clone();
        }
    }
    out
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Unix ms from Lore's dates: `Thu, 26 Nov 2026 13:02:34 +0000` (RFC 2822).
pub(crate) fn parse_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let s = s.split_once(", ").map_or(s, |(_, rest)| rest);
    let mut parts = s.split_whitespace();
    let day: i64 = parts.next()?.parse().ok()?;
    let month = parts.next()?;
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        .iter()
        .position(|m| month.eq_ignore_ascii_case(m))? as i64
        + 1;
    let year: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.split(':').map(|p| p.parse::<i64>().ok());
    let (h, mi, sec) = (hms.next()??, hms.next()??, hms.next().flatten().unwrap_or(0));
    let offset = match parts.next() {
        Some(z) if z.len() == 5 && (z.starts_with('+') || z.starts_with('-')) => {
            let hh: i64 = z[1..3].parse().ok()?;
            let mm: i64 = z[3..5].parse().ok()?;
            let total = hh * 60 + mm;
            if z.starts_with('-') { -total } else { total }
        }
        _ => 0,
    };
    Some((days_from_civil(year, month, day) * 86_400 + h * 3600 + mi * 60 + sec - offset * 60) * 1000)
}

/// What `lore branch list` says: the current branch, local and remote branch names.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Branches {
    pub current: Option<String>,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

pub(crate) fn parse_branches(text: &str) -> Branches {
    let mut out = Branches::default();
    // 0: none, 1: local, 2: remote, 3: archived (ignored).
    let mut section = 0;
    for line in text.lines() {
        let t = line.trim_end();
        match t {
            "Local branches:" => section = 1,
            "Remote branches:" => section = 2,
            _ if t.ends_with(':') && !t.starts_with(' ') && !t.starts_with('*') => section = 3,
            _ if t.starts_with("* ") || t.starts_with("  ") => {
                let current = t.starts_with('*');
                let name = t[2..].trim();
                if name.is_empty() || name.contains(char::is_whitespace) {
                    continue;
                }
                match section {
                    1 => {
                        if current {
                            out.current = Some(name.to_string());
                        }
                        out.local.push(name.to_string());
                    }
                    2 => out.remote.push(name.to_string()),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

/// The users `lore auth list` names (`  User: ann@x.io (<identity>)`), as (identity, name).
pub(crate) fn auth_users(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("User:")?.trim();
            let (name, id) = rest.rsplit_once(" (")?;
            let (name, id) = (name.trim(), id.strip_suffix(')')?.trim());
            (!name.is_empty() && !id.is_empty() && !id.contains(char::is_whitespace)).then(|| (id.to_string(), name.to_string()))
        })
        .collect()
}

/// The user inside an identity offline `lore` prints in place of a name (`Creator`): a Dex subject,
/// base64url of a small protobuf whose field 1 is the user's id in its connector and field 2 the
/// connector. Only an id that is an email (Dex's password users, as Mango sets them up) is a name.
pub(crate) fn dex_user(id: &str) -> Option<String> {
    use base64::Engine as _;
    let id = id.trim().trim_end_matches('=');
    if id.is_empty() || id.len() > 512 {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(id).ok()?;
    let rest = bytes.strip_prefix(&[0x0a])?;
    let (&len, rest) = rest.split_first()?;
    let len = len as usize;
    if len >= 0x80 || rest.len() <= len || rest[len] != 0x12 {
        return None;
    }
    let user = std::str::from_utf8(&rest[..len]).ok()?;
    let fine = user.contains('@') && !user.starts_with('@') && !user.chars().any(|c| c.is_whitespace() || c.is_control());
    fine.then(|| user.to_string())
}

/// One lock from `lore lock query`: path and owner.
pub(crate) fn parse_locks(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            // `a.txt by <unknown> on branch e726…`
            let (rest, _branch) = line.trim_end().rsplit_once(" on branch ")?;
            let (path, owner) = rest.rsplit_once(" by ")?;
            let (path, _) = rel_path(path)?;
            Some((path, owner.trim().to_string()))
        })
        .collect()
}

/// The paths listed under `heading` (e.g. "Lock acquired on files:") until the next line ending in `:`.
pub(crate) fn listed_under(text: &str, heading: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut on = false;
    for line in text.lines() {
        let t = line.trim_end();
        if t == heading {
            on = true;
        } else if t.ends_with(':') || t.is_empty() || t.starts_with('[') {
            on = false;
        } else if on {
            if let Some((p, _)) = rel_path(t) {
                out.push(p);
            }
        }
    }
    out
}

/// Turn `lore diff` output into a git-style unified diff, so the diff view needs no second
/// parser. Lore prints, per file, a blank line, the path, `--- a.txt@4` / `+++ a.txt`
/// (`/dev/null` for a side that doesn't exist) and the hunks, or "Binary files differ".
pub(crate) fn to_git_diff(text: &str) -> String {
    let mut out = String::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let path_line = lines[i].trim_end();
        i += 1;
        if path_line.is_empty() || path_line.starts_with('[') {
            continue;
        }
        let Some((path, _)) = rel_path(path_line) else { continue };
        let (mut old, mut new) = (Some(path.clone()), Some(path.clone()));
        let mut body = String::new();
        let mut binary = false;
        let mut in_hunks = false;
        while i < lines.len() {
            let l = lines[i];
            if !in_hunks && l.starts_with("--- ") {
                old = (l[4..].trim() != "/dev/null").then(|| path.clone());
            } else if !in_hunks && l.starts_with("+++ ") {
                new = (l[4..].trim() != "/dev/null").then(|| path.clone());
            } else if l.starts_with("@@") {
                in_hunks = true;
                body.push_str(l);
                body.push('\n');
            } else if in_hunks && (l.starts_with([' ', '+', '-', '\\'])) {
                body.push_str(l);
                body.push('\n');
            } else if l.trim() == "Binary files differ" {
                binary = true;
            } else if l.trim().is_empty() {
                i += 1;
                break;
            } else {
                break;
            }
            i += 1;
        }
        out.push_str(&format!("diff --git a/{path} b/{path}\n"));
        match (&old, &new) {
            (None, Some(_)) => out.push_str("new file mode 100644\n"),
            (Some(_), None) => out.push_str("deleted file mode 100644\n"),
            _ => {}
        }
        let side = |p: &Option<String>, pre: &str| p.as_ref().map_or("/dev/null".to_string(), |p| format!("{pre}/{p}"));
        if binary {
            out.push_str(&format!("Binary files {} and {} differ\n", side(&old, "a"), side(&new, "b")));
        } else if !body.is_empty() {
            out.push_str(&format!("--- {}\n+++ {}\n", side(&old, "a"), side(&new, "b")));
            out.push_str(&body);
        }
    }
    out
}

/// The revision number in `Committed merged repository state 7 -> ed05…` (a merge Lore committed itself).
pub(crate) fn committed_merge(text: &str) -> Option<u64> {
    text.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("Committed merged repository state ")?;
        rest.split_whitespace().next()?.parse().ok()
    })
}

/// The 64 hex digits after `marker` in `line`.
fn signature_after(line: &str, marker: &str) -> Option<String> {
    let rest = &line[line.find(marker)? + marker.len()..];
    let sig = rest.split_whitespace().next()?;
    (sig.len() == 64 && sig.bytes().all(|b| b.is_ascii_hexdigit())).then(|| sig.to_ascii_lowercase())
}

/// The revision a merge brings in: `Starting merge of branch <id> revision <signature>`.
pub(crate) fn merge_started(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.trim().strip_prefix("Starting merge of branch ").and_then(|rest| signature_after(rest, "revision ")))
}

/// The paths `branch merge resolve` left in conflict because their markers are still there:
/// `[Warn] Cannot resolve path with conflict markers still present: a.txt` (it exits 0 anyway).
pub(crate) fn markers_left(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.split_once("Cannot resolve path with conflict markers still present:"))
        .filter_map(|(_, p)| rel_path(p.trim()).map(|p| p.0))
        .collect()
}

/// `Pushed revision 6 -> c04c… to branch yb`: (revision, branch).
pub(crate) fn pushed(text: &str) -> Option<(u64, String)> {
    text.lines().rev().find_map(|l| {
        let rest = l.trim().strip_prefix("Pushed revision ")?;
        let (n, tail) = rest.split_once(' ')?;
        let branch = tail.rsplit_once(" to branch ")?.1.trim();
        Some((n.parse().ok()?, branch.to_string()))
    })
}

/// The revision a sync moved to: `Synchronizing to revision 4 -> …` (or `… to local revision …`).
pub(crate) fn synced_to(text: &str) -> Option<u64> {
    text.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("Synchronizing to ")?;
        let rest = rest.strip_prefix("local ").unwrap_or(rest);
        revision_arrow(rest).map(|(n, _)| n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `lore status --scan` in a repository with staged, unstaged and new files (lore 0.14.0).
    const STATUS: &str = "Repository 01a217f5f9cc73be96ccbcb52284ca72
On branch main revision 1 -> 1a3be306cc9425cdba6e8819a37dae64a06855284ebe371e8319cb1e36c76c60
Remote revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000
Local branch is ahead of remote
Changes staged for commit:
A src/
A src/main.rs
V a.txt -> moved.txt
Changes not staged for commit:
M k.txt
D d/
D d/x.txt
Untracked files:
A -x.txt
A src/deep/
A src/deep/d.txt
A ü b.txt
A ../outside.txt
Tracked changes: 5 added, 1 modified, 2 deleted
";

    #[test]
    fn reads_status() {
        let s = parse_status(STATUS);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.revision, Some(1));
        assert_eq!(s.signature.as_deref(), Some("1a3be306cc9425cdba6e8819a37dae64a06855284ebe371e8319cb1e36c76c60"));
        assert_eq!((s.remote_revision, s.remote_signature.as_deref()), (Some(0), None));
        assert_eq!(s.remote, Remote::Ahead);
        let rows: Vec<(Section, &str, &str, Option<&str>, bool)> =
            s.entries.iter().map(|e| (e.section, e.letter, e.path.as_str(), e.orig.as_deref(), e.dir)).collect();
        assert_eq!(
            rows,
            vec![
                (Section::Staged, "A", "src", None, true),
                (Section::Staged, "A", "src/main.rs", None, false),
                (Section::Staged, "R", "moved.txt", Some("a.txt"), false),
                (Section::Unstaged, "M", "k.txt", None, false),
                (Section::Unstaged, "D", "d", None, true),
                (Section::Unstaged, "D", "d/x.txt", None, false),
                (Section::Untracked, "A", "-x.txt", None, false),
                (Section::Untracked, "A", "src/deep", None, true),
                (Section::Untracked, "A", "src/deep/d.txt", None, false),
                (Section::Untracked, "A", "ü b.txt", None, false),
            ]
        );
    }

    /// `lore --offline status --scan` and `--revision-only` in a repository with a server (lore
    /// 0.14.0+2389): no "Remote revision" or "Local branch …" line, the rest as online.
    #[test]
    fn reads_offline_status() {
        let scan = parse_status(
            "Repository 01a21b48859576709452c18853f6a1a9
On branch main revision 2 -> 355b3a1071989b7f0e72d3408e1f2d1eb4ff9f08dad5c4cabb8d705eb0542111
No tracked changes
",
        );
        assert_eq!((scan.branch.as_deref(), scan.revision), (Some("main"), Some(2)));
        assert_eq!(scan.signature.as_deref(), Some("355b3a1071989b7f0e72d3408e1f2d1eb4ff9f08dad5c4cabb8d705eb0542111"));
        assert_eq!((scan.remote, scan.remote_revision, scan.remote_signature.as_deref()), (Remote::Unknown, None, None));
        assert!(scan.entries.is_empty() && !scan.merging);
        let rev_only = parse_status(
            "Repository 01a21b48859576709452c18853f6a1a9
On branch main revision 2 -> 355b3a1071989b7f0e72d3408e1f2d1eb4ff9f08dad5c4cabb8d705eb0542111
",
        );
        assert_eq!((rev_only.branch, rev_only.signature), (scan.branch.clone(), scan.signature.clone()));
        // With changes (an offline repository; the same lines).
        let changed = parse_status(
            "Repository 01a21d162c5676ffa7e8fddb2de102b6
On branch main revision 1 -> fb5dda652dd628bcb9455ac6101aefbcf3ca0806c68cd1d3b8a13294c359b0a1
Changes not staged for commit:
M a.txt
Untracked files:
A n.txt
Tracked changes: 1 added, 1 modified
",
        );
        let rows: Vec<(Section, &str, &str)> = changed.entries.iter().map(|e| (e.section, e.letter, e.path.as_str())).collect();
        assert_eq!(rows, vec![(Section::Unstaged, "M", "a.txt"), (Section::Untracked, "A", "n.txt")]);
        assert_eq!(changed.remote, Remote::Unknown);
    }

    /// `lore auth list` (lore 0.14.0+2389), and the identity offline `history` prints for that user.
    #[test]
    fn reads_identities() {
        let text = "Auth URL: oidc+https://lore.example.org/dex
  User: ann@example.org (Cg9hbm5AZXhhbXBsZS5vcmcSBWxvY2Fs)
  Domains: lore.example.org, lore.example.org
  Expires: Fri, 27 Nov 2026 13:08:39 +0000
Auth URL: oidc+https://lore.example.org/dex
  Resource: 01a21b48859576709452c18853f6a1a9
  User: ann@example.org (Cg9hbm5AZXhhbXBsZS5vcmcSBWxvY2Fs)
";
        let users = auth_users(text);
        assert_eq!(users.len(), 2);
        assert_eq!(users[0], ("Cg9hbm5AZXhhbXBsZS5vcmcSBWxvY2Fs".to_string(), "ann@example.org".to_string()));
        assert!(auth_users("User: nobody\nUser:  (x)\n").is_empty());
        // The real one from the server above: `\n\x14reapermaga@gmail.com\x12\x05local`.
        assert_eq!(dex_user("ChRyZWFwZXJtYWdhQGdtYWlsLmNvbRIFbG9jYWw").as_deref(), Some("reapermaga@gmail.com"));
        assert_eq!(dex_user("Cg9hbm5AZXhhbXBsZS5vcmcSBWxvY2Fs").as_deref(), Some("ann@example.org"));
        // A GitHub user's id is a number: not a name. Neither is anything else.
        assert_eq!(dex_user("CgcxMjM0NTY3EgZnaXRodWI"), None);
        for other in ["", "ann@example.org", "reapermaga@gmail.com", "@@@", "ChQ", &"A".repeat(600)] {
            assert_eq!(dex_user(other), None, "{other}");
        }
    }

    #[test]
    fn reads_remote_states_and_conflicts() {
        let s = parse_status(
            "Repository 01a2
On branch main revision 4 -> c12d69655c82f36beb197a6c4a227b06a72eb917d8b86a3bb42f59271486495a
Remote revision 4 -> 7185c4f8e8bd635a60c453b900ea88c6bf682d3ba674635569c50b1cb2a4c34b
Local branch has diverged, synchronize to merge
Pending merge, incoming revision c12d69655c82f36beb197a6c4a227b06a72eb917d8b86a3bb42f59271486495a
Changes in conflict:
M  a.txt (M)!
Changes staged for commit:
M b c.txt (M)
",
        );
        assert_eq!(s.remote, Remote::Diverged);
        assert!(s.merging);
        assert_eq!(s.incoming.as_deref(), Some("c12d69655c82f36beb197a6c4a227b06a72eb917d8b86a3bb42f59271486495a"));
        assert_eq!(s.entries[0], Entry { section: Section::Conflict, letter: "M", path: "a.txt".into(), orig: None, dir: false });
        assert_eq!(s.entries[1].path, "b c.txt");

        let behind = parse_status("On branch main revision 1 -> 1a3b\nRemote revision 2 -> 2d6a\nLocal branch is behind remote\n");
        assert_eq!((behind.remote, behind.revision, behind.remote_revision), (Remote::Behind, Some(1), Some(2)));
        let unpublished = parse_status("On branch yb revision 5 -> 2d83\nRemote branch does not exist\n");
        assert_eq!(unpublished.remote, Remote::NoBranch);
        // An offline repository (no remote) or a server that didn't answer: no remote lines at all.
        let offline = parse_status("Repository 01a2\nOn branch main revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000\nNo tracked changes\n");
        assert_eq!((offline.remote, offline.revision, offline.signature), (Remote::Unknown, Some(0), None));
        assert!(offline.entries.is_empty());
        assert_eq!(parse_status("[Error] Repository not found: /tmp\n  at lore/src/call.rs:375:19\n"), Status::default());
    }

    /// A merge of a branch with conflicts in an offline repository, lore 0.14.0+2389: the merge's
    /// own output, the status during it (a delete/modify conflict each way, a binary file) and a
    /// resolve refused while the markers are still in the file.
    #[test]
    fn reads_a_merge_in_progress() {
        let merged = "Starting merge of branch 01a21b6c06947382afbe02c8716cfd1e revision 15b818e4eadf9897f99e24e727ed7db2cdd2ef008fff891410d54806aba49331
Merged files, 0 updated, 0 deleted, 0 merged, 4 conflicted
Staged merged repository state d36368a095b20052f939df211e3d5f96472ef992f8da50a3bce2ef2bfb37e4f6
Files in conflict:
a.txt
b.bin
del.txt
mod.txt
";
        assert_eq!(merge_started(merged).as_deref(), Some("15b818e4eadf9897f99e24e727ed7db2cdd2ef008fff891410d54806aba49331"));
        assert_eq!(listed_under(merged, "Files in conflict:"), vec!["a.txt", "b.bin", "del.txt", "mod.txt"]);
        assert_eq!(merge_started("Merged files, 0 updated"), None);

        let s = parse_status(
            "Repository 01a21b6c05d171e0bf34e062437b217a
On branch main revision 2 -> f80fcf913a6e1c5f4f98d4fae5b99ce61ac25774dc669493c80b80613fde9af4
Pending merge, incoming revision 15b818e4eadf9897f99e24e727ed7db2cdd2ef008fff891410d54806aba49331
Changes staged for commit:
M b.bin (M)
Changes in conflict:
M  a.txt (M)!
D  del.txt (M)!
M  mod.txt (M)!
",
        );
        assert!(s.merging);
        assert_eq!(s.incoming.as_deref(), Some("15b818e4eadf9897f99e24e727ed7db2cdd2ef008fff891410d54806aba49331"));
        let listed: Vec<(Section, &str)> = s.entries.iter().map(|e| (e.section, e.path.as_str())).collect();
        assert_eq!(listed, vec![(Section::Staged, "b.bin"), (Section::Conflict, "a.txt"), (Section::Conflict, "del.txt"), (Section::Conflict, "mod.txt")]);

        let refused = "[Warn] Cannot resolve path with conflict markers still present: a.txt
No conflicts resolved
";
        assert_eq!(markers_left(refused), vec!["a.txt"]);
        assert!(markers_left("Resolved conflicts:
a.txt
").is_empty());
        // A wrong-looking signature is no signature.
        assert_eq!(parse_status("On branch main revision 2 -> f80f
Pending merge, incoming revision xyz
").incoming, None);
    }

    #[test]
    fn reads_history() {
        let text = "Revision  : 3
Signature : 9a0a985775317ee824c87d4120da0dec79d496bc7755eaa61a4f856c9db5dca5
Merge     : 009e1bdc9b054c8025c40ab4bec3cabb68df87ea506595257978b4f8b0a36b2f
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Thu, 26 Nov 2026 13:05:47 +0000
    Merge main into main

Revision  : 1
Signature : 1a3be306cc9425cdba6e8819a37dae64a06855284ebe371e8319cb1e36c76c60
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Thu, 26 Nov 2026 13:05:36 +0000
    first commit

    with a body: and a colon

";
        let revs = parse_revisions(text);
        assert_eq!(revs.len(), 2);
        assert_eq!((revs[0].number, revs[0].short(), revs[0].subject()), (3, "r3".to_string(), "Merge main into main".to_string()));
        assert_eq!(revs[0].merge.as_deref(), Some("009e1bdc9b054c8025c40ab4bec3cabb68df87ea506595257978b4f8b0a36b2f"));
        assert_eq!(revs[1].message, "first commit\n\nwith a body: and a colon");
        assert_eq!(revs[1].time, 1_795_698_336_000);
    }

    /// `lore history -- 5` in a repository with a server: `Creator` and `Committer` lines (lore 0.14.0+2389).
    #[test]
    fn reads_history_with_creator() {
        let text = "Revision  : 1
Signature : 5ed752ec8de0659c99bb5b6217352afaac9ed5651162f099e7cd86a833d736fd
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Fri, 27 Nov 2026 04:42:17 +0000
    feat: initialize lore project
Creator   : reapermaga@gmail.com
Committer : reapermaga@gmail.com
";
        let revs = parse_revisions(text);
        assert_eq!(revs.len(), 1);
        let r = &revs[0];
        assert_eq!((r.number, r.subject(), r.message.as_str()), (1, "feat: initialize lore project".to_string(), "feat: initialize lore project"));
        assert_eq!((r.author.as_str(), r.committer.as_str()), ("reapermaga@gmail.com", "reapermaga@gmail.com"));
        assert_eq!(r.signature, "5ed752ec8de0659c99bb5b6217352afaac9ed5651162f099e7cd86a833d736fd");

        // Only one of them named: it stands for both.
        let one = parse_revisions("Revision  : 2
Signature : ab
Date      : Fri, 27 Nov 2026 04:42:17 +0000
    x
Committer : ann@x.io
");
        assert_eq!((one[0].author.as_str(), one[0].committer.as_str()), ("ann@x.io", "ann@x.io"));

        // The status beside it.
        let s = parse_status("Repository 01a21b48859576709452c18853f6a1a9
On branch main revision 1 -> 5ed752ec8de0659c99bb5b6217352afaac9ed5651162f099e7cd86a833d736fd
Remote revision 1 -> 5ed752ec8de0659c99bb5b6217352afaac9ed5651162f099e7cd86a833d736fd
Local branch in sync with remote
");
        assert_eq!((s.branch.as_deref(), s.revision, s.remote), (Some("main"), Some(1), Remote::InSync));
        assert_eq!(s.signature, s.remote_signature);
    }

    /// `lore history` of an offline repository with a branch off main (lore 0.14.0+2389): no author lines.
    #[test]
    fn reads_offline_history() {
        let text = "Revision  : 4
Signature : ea38b0082d558ef8aedc681b718d703983021515e694113ef658da583b8c40b8
Branch    : 01a21b55b4da70b987dc56e967399053
Date      : Fri, 27 Nov 2026 04:48:05 +0000
    on feat

Revision  : 3
Signature : b64c935056af69ac51d0695f778f4fa48362a27efa9b28c5f6930f8d0fe79191
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Fri, 27 Nov 2026 04:48:04 +0000
    third
    body line

Revision  : 2
Signature : 2dbfa251d94f1cae67af62c969e0d6f8c0e230ff6548c6d51c90ee4636f2b60c
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Fri, 27 Nov 2026 04:48:04 +0000
    second change

";
        let revs = parse_revisions(text);
        let rows: Vec<(u64, String, &str)> = revs.iter().map(|r| (r.number, r.subject(), r.author.as_str())).collect();
        assert_eq!(rows, vec![(4, "on feat".into(), ""), (3, "third".into(), ""), (2, "second change".into(), "")]);
        assert_eq!(revs[1].message, "third
body line");
    }

    #[test]
    fn reads_revision_info_and_commit_output() {
        let info = "Revision  : 1
Signature : 2f138132c5bf449f90da686a2c6876945faf9c71e18b8a192b428944b097c6f4
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Thu, 26 Nov 2026 13:06:24 +0000
    base

A d
A d/y.txt
M k.txt
";
        let r = &parse_revisions(info)[0];
        assert_eq!(r.message, "base");
        let changes: Vec<(&str, &str)> = r.changes.iter().map(|e| (e.letter, e.path.as_str())).collect();
        assert_eq!(changes, vec![("A", "d"), ("A", "d/y.txt"), ("M", "k.txt")]);

        let commit = "Fragmenting files and updating tree hashes
Committing staged changes
Committed 1/1 directories, 1/1 files, 2 bytes/2 bytes (1 modified, 0 deleted)
Repository: 01a217f6d1b57653ba492d1ff70076cc
Revision  : 8
Signature : e8c4d1646b40fff555d3653b7e08020255cf2e6495b7008b7827000f7ca4d506
Parent    : ed05062e7534bdaa904a0b8d7d1ed0738981e0f35965092096814914c0a707bf
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Thu, 26 Nov 2026 13:14:05 +0000
    -msg with dash
Commit succeeded
";
        let r = &parse_revisions(commit)[0];
        assert_eq!((r.number, r.message.as_str()), (8, "-msg with dash"));
        assert_eq!(r.parents, vec!["ed05062e7534bdaa904a0b8d7d1ed0738981e0f35965092096814914c0a707bf".to_string()]);
        assert!(r.changes.is_empty(), "{:?}", r.changes);
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("Thu, 01 Jan 1970 00:00:00 +0000"), Some(0));
        assert_eq!(parse_date("Thu, 26 Nov 2026 13:05:36 +0000"), Some(1_795_698_336_000));
        assert_eq!(parse_date("Thu, 26 Nov 2026 15:05:36 +0200"), Some(1_795_698_336_000));
        assert_eq!(parse_date("26 Nov 2026 08:05:36 -0500"), Some(1_795_698_336_000));
        assert_eq!(parse_date("yesterday"), None);
    }

    #[test]
    fn reads_branches_and_locks() {
        let b = parse_branches("Local branches:\n  main\n* feat/x-1\nWarning: Could not query remote branch list\n");
        assert_eq!(b, Branches { current: Some("feat/x-1".into()), local: vec!["main".into(), "feat/x-1".into()], remote: vec![] });
        let b = parse_branches("Local branches:\n* yb\n  main\nRemote branches:\n  main\n  yb\nArchived local branches:\n  other\n");
        assert_eq!((b.current.as_deref(), b.local.len(), b.remote.clone()), (Some("yb"), 2, vec!["main".to_string(), "yb".to_string()]));

        let locks = parse_locks("Locks found:\na.txt by <unknown> on branch e726318bbc3fd75ac8733a7e030cc35b\nsrc/a by b.txt by ann@x.io on branch e726\n");
        assert_eq!(locks, vec![("a.txt".to_string(), "<unknown>".to_string()), ("src/a by b.txt".to_string(), "ann@x.io".to_string())]);
        assert!(parse_locks("Locks found:\n").is_empty());

        let out = "Lock acquired on files:\na.txt\nLock already owned on files:\nb.txt\n";
        assert_eq!(listed_under(out, "Lock acquired on files:"), vec!["a.txt".to_string()]);
        assert_eq!(listed_under(out, "Lock already owned on files:"), vec!["b.txt".to_string()]);
    }

    #[test]
    fn diffs_become_git_diffs() {
        let modified = "\na.txt\n--- a.txt@2\n+++ a.txt\n@@ -1,3 +1,4 @@\n 1\n 2\n 3\n+four\n\n";
        assert_eq!(to_git_diff(modified), "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n 1\n 2\n 3\n+four\n");
        let added = "\nnew.txt\n--- /dev/null\n+++ new.txt\n@@ -0,0 +1 @@\n+hi\n\n";
        assert_eq!(to_git_diff(added), "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n");
        let gone = "\nd/x.txt\n--- d/x.txt@2\n+++ /dev/null\n@@ -1 +0,0 @@\n--- a line that starts like a header\n\n";
        assert_eq!(
            to_git_diff(gone),
            "diff --git a/d/x.txt b/d/x.txt\ndeleted file mode 100644\n--- a/d/x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n--- a line that starts like a header\n"
        );
        assert_eq!(to_git_diff("\nbin.dat\nBinary files differ\n\n"), "diff --git a/bin.dat b/bin.dat\nBinary files a/bin.dat and b/bin.dat differ\n");
        let between = "k.txt\n--- k.txt@1\n+++ k.txt@2\n@@ -1 +1 @@\n-keep\n+zzz\n\n";
        assert!(to_git_diff(between).ends_with("--- a/k.txt\n+++ b/k.txt\n@@ -1 +1 @@\n-keep\n+zzz\n"));
        assert_eq!(to_git_diff(""), "");
    }

    #[test]
    fn reads_results() {
        assert_eq!(committed_merge("Merged files, 1 updated\nCommitted merged repository state 5 -> b5c2\n"), Some(5));
        assert_eq!(pushed("Pushing c04c to branch yb\nPushed revision 6 -> c04c7d6d to branch yb\n"), Some((6, "yb".into())));
        assert_eq!(pushed("Revision is already pushed and at remote latest\n"), None);
        assert_eq!(synced_to("Sync from remote lore://127.0.0.1\nSynchronizing to revision 4 -> 7185\n"), Some(4));
        assert_eq!(synced_to("Synchronizing to local revision 4 -> 7185\n"), Some(4));
    }
}
