//! The plugin store: registry, probe, install, update, remove, and reading plugin files.
//! Everything takes a plain base folder so tests can run it without Tauri.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::gitops;
use super::validate::{
    is_sha_like, normalize_ref, normalize_subpath, parse_manifest, repo_key, safe_rel_file, validate_url,
    valid_id, MANIFEST_FILE, MANIFEST_MAX,
};
use super::{InstalledPlugin, PluginCandidate, PluginManifest, PluginProbe, PluginSource, PluginUpdateInfo};

const REGISTRY: &str = "plugins.json";
/// Largest file `plugins_read` / `plugins_asset` hand out.
const READ_MAX: u64 = 10 * 1024 * 1024;
/// How deep `plugins_probe` looks for manifests when no folder is given (root = 0).
const DISCOVER_DEPTH: usize = 3;
const DISCOVER_MAX: usize = 100;
/// A plugin folder bigger than this is not a plugin (or the wrong folder).
const COPY_MAX_BYTES: u64 = 200 * 1024 * 1024;
const COPY_MAX_FILES: usize = 20_000;
/// Probe checkouts kept around: the newest few, none older than a day.
const STAGING_KEEP: usize = 3;
const STAGING_MAX_AGE: Duration = Duration::from_secs(24 * 3600);

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn lock(m: &Mutex<()>) -> MutexGuard<'_, ()> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A path as the frontend should see it (no `\\?\` prefix from `canonicalize` on Windows).
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// One installed plugin as stored in `plugins.json`. `repo` (the clone folder under `repos/`) is
/// internal; fields written by other builds are kept as they are.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub manifest: PluginManifest,
    pub source: PluginSource,
    pub dir: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub installed_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn yes() -> bool {
    true
}

impl Record {
    pub fn public(&self) -> InstalledPlugin {
        InstalledPlugin {
            manifest: self.manifest.clone(),
            source: self.source.clone(),
            dir: self.dir.clone(),
            enabled: self.enabled,
            commit: self.commit.clone(),
            installed_at: self.installed_at,
            updated_at: self.updated_at,
        }
    }

    fn git(&self) -> Option<(&str, Option<&str>, &str)> {
        match &self.source {
            PluginSource::Git { url, reference, subpath } => {
                Some((url.as_str(), reference.as_deref(), subpath.as_deref().unwrap_or("")))
            }
            PluginSource::Local { .. } => None,
        }
    }

    fn repo_key(&self) -> Option<String> {
        let (url, reference, _) = self.git()?;
        Some(self.repo.clone().unwrap_or_else(|| repo_key(url, reference)))
    }
}

/// What a probe left in its staging folder for `plugins_install`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ProbeMeta {
    url: String,
    reference: Option<String>,
    commit: String,
}

pub struct Ctx {
    pub base: PathBuf,
    /// Held while `plugins.json` is read, changed and written.
    registry: Mutex<()>,
    /// Held while anything changes `repos/` or `installed/` (taken before `registry`).
    repos: Mutex<()>,
}

impl Ctx {
    pub fn new(base: PathBuf) -> Self {
        Ctx { base, registry: Mutex::new(()), repos: Mutex::new(()) }
    }

    fn registry_file(&self) -> PathBuf {
        self.base.join(REGISTRY)
    }
    fn installed_root(&self) -> PathBuf {
        self.base.join("installed")
    }
    fn repos_root(&self) -> PathBuf {
        self.base.join("repos")
    }
    fn staging_root(&self) -> PathBuf {
        self.base.join(".staging")
    }

    /// The registry; a missing file is empty, a corrupt one is set aside (once) and read as empty,
    /// unreadable records are skipped.
    fn load(&self) -> Vec<Record> {
        let file = self.registry_file();
        let Ok(bytes) = fs::read(&file) else {
            return Vec::new();
        };
        match serde_json::from_slice::<Vec<Value>>(&bytes) {
            Ok(items) => items.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect(),
            Err(_) => {
                let backup = self.base.join(format!("{REGISTRY}.corrupt"));
                if !backup.exists() {
                    let _ = fs::copy(&file, &backup);
                }
                Vec::new()
            }
        }
    }

    fn save(&self, records: &[Record]) -> Result<(), String> {
        fs::create_dir_all(&self.base)
            .map_err(|e| format!("Could not create the plugins folder {}: {e}", self.base.display()))?;
        let json = serde_json::to_vec_pretty(records).map_err(|e| format!("Could not save the plugin list: {e}"))?;
        write_atomic(&self.registry_file(), &json)
    }

    /// Reads, changes and writes the registry under its lock. Nothing is written when `f` fails.
    fn with_registry<T>(&self, f: impl FnOnce(&mut Vec<Record>) -> Result<T, String>) -> Result<T, String> {
        let _g = lock(&self.registry);
        let mut records = self.load();
        let out = f(&mut records)?;
        self.save(&records)?;
        Ok(out)
    }

    fn find(&self, id: &str) -> Result<Record, String> {
        let _g = lock(&self.registry);
        self.load()
            .into_iter()
            .find(|r| r.manifest.id == id)
            .ok_or_else(|| format!("No plugin with the id \"{id}\" is installed"))
    }

    /// The folder an installed plugin runs from.
    pub fn dir_of(&self, id: &str) -> Result<PathBuf, String> {
        Ok(PathBuf::from(self.find(id)?.dir))
    }

    pub fn list(&self) -> Vec<InstalledPlugin> {
        let _g = lock(&self.registry);
        self.load().iter().map(Record::public).collect()
    }

    // -----------------------------------------------------------------------
    // Probe and install
    // -----------------------------------------------------------------------

    pub fn probe(
        &self,
        url: &str,
        reference: Option<&str>,
        subpath: Option<&str>,
        progress: &dyn Fn(&str),
    ) -> Result<PluginProbe, String> {
        let url = validate_url(url, cfg!(test))?;
        let reference = normalize_ref(reference)?;
        let subpath = match subpath.map(normalize_subpath).transpose()? {
            Some(s) if !s.is_empty() => Some(s),
            _ => None,
        };
        self.prune_staging();

        let probe_id = uuid::Uuid::new_v4().simple().to_string();
        let stage = self.staging_root().join(&probe_id);
        fs::create_dir_all(&stage).map_err(|e| format!("Could not create {}: {e}", stage.display()))?;
        let result = self.probe_into(&stage, &probe_id, &url, reference, subpath.as_deref(), progress);
        if result.is_err() {
            let _ = remove_tree(&stage);
        }
        result
    }

    fn probe_into(
        &self,
        stage: &Path,
        probe_id: &str,
        url: &str,
        reference: Option<String>,
        subpath: Option<&str>,
        progress: &dyn Fn(&str),
    ) -> Result<PluginProbe, String> {
        let repo = stage.join("repo");
        gitops::clone(url, reference.as_deref(), &repo, progress)?;
        let commit = gitops::head(&repo)?;

        let installed: HashSet<String> = {
            let _g = lock(&self.registry);
            self.load().into_iter().map(|r| r.manifest.id).collect()
        };
        let mut candidates = Vec::new();
        match subpath {
            Some(sub) => {
                let dir = repo.join(sub);
                if !is_regular_file(&dir.join(MANIFEST_FILE)) {
                    return Err(format!("There is no {MANIFEST_FILE} in the folder \"{sub}\" of {url}"));
                }
                let manifest = read_manifest(&dir, &format!("{sub}/{MANIFEST_FILE}"))?;
                candidates.push((sub.to_string(), manifest));
            }
            None => {
                let found = discover(&repo);
                if found.is_empty() {
                    return Err(format!("{url} holds no {MANIFEST_FILE}, so it has no Mango plugin"));
                }
                let mut problems = Vec::new();
                for sub in found {
                    let dir = if sub.is_empty() { repo.clone() } else { repo.join(&sub) };
                    let file = if sub.is_empty() { MANIFEST_FILE.to_string() } else { format!("{sub}/{MANIFEST_FILE}") };
                    match read_manifest(&dir, &file) {
                        Ok(m) => candidates.push((sub, m)),
                        Err(e) => problems.push(e),
                    }
                }
                if candidates.is_empty() {
                    return Err(format!("No valid plugin found in {url}:\n{}", problems.join("\n")));
                }
            }
        }

        let meta = ProbeMeta { url: url.to_string(), reference: reference.clone(), commit: commit.clone() };
        let json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
        write_atomic(&stage.join("probe.json"), &json)?;

        Ok(PluginProbe {
            probe_id: probe_id.to_string(),
            url: url.to_string(),
            reference,
            commit,
            candidates: candidates
                .into_iter()
                .map(|(subpath, manifest)| PluginCandidate {
                    installed: installed.contains(&manifest.id),
                    subpath,
                    manifest,
                })
                .collect(),
        })
    }

    /// Keeps the newest few probe checkouts and nothing older than a day.
    fn prune_staging(&self) {
        let Ok(entries) = fs::read_dir(self.staging_root()) else {
            return;
        };
        let mut dirs: Vec<(SystemTime, PathBuf)> = entries
            .flatten()
            .map(|e| {
                let t = e.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH);
                (t, e.path())
            })
            .collect();
        dirs.sort_by(|a, b| b.0.cmp(&a.0));
        let now = SystemTime::now();
        for (i, (t, path)) in dirs.into_iter().enumerate() {
            let old = now.duration_since(t).map(|d| d > STAGING_MAX_AGE).unwrap_or(false);
            if i >= STAGING_KEEP || old {
                let _ = remove_tree(&path);
            }
        }
    }

    pub fn install(&self, probe_id: &str, subpaths: &[String]) -> Result<Vec<InstalledPlugin>, String> {
        if probe_id.is_empty() || probe_id.len() > 64 || !probe_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("That plugin lookup is not valid; look the repository up again".into());
        }
        let mut subs: Vec<String> = Vec::new();
        for s in subpaths {
            let s = normalize_subpath(s)?;
            if !subs.contains(&s) {
                subs.push(s);
            }
        }
        if subs.is_empty() {
            return Err("Choose at least one plugin to install".into());
        }

        let stage = self.staging_root().join(probe_id);
        let meta: ProbeMeta = fs::read(stage.join("probe.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or("That plugin lookup has expired; look the repository up again")?;

        let _repos = lock(&self.repos);
        let result = self.install_locked(&stage, &meta, &subs);
        // Drops the clone when nothing ended up using it, and clones replaced plugins used.
        self.gc_repos();
        result
    }

    /// `install` with `repos` held.
    fn install_locked(&self, stage: &Path, meta: &ProbeMeta, subs: &[String]) -> Result<Vec<InstalledPlugin>, String> {
        let key = repo_key(&meta.url, meta.reference.as_deref());
        let repo = self.repos_root().join(&key);
        let staged = stage.join("repo");
        if staged.is_dir() {
            fs::create_dir_all(self.repos_root()).map_err(|e| format!("Could not create the repository folder: {e}"))?;
            if repo.exists() {
                remove_tree(&repo).map_err(|e| format!("Could not replace {}: {e}", repo.display()))?;
            }
            move_dir(&staged, &repo)?;
        } else if gitops::head(&repo).ok().as_deref() != Some(meta.commit.as_str()) {
            return Err("That plugin lookup has expired; look the repository up again".into());
        }

        // Read and check everything before changing anything.
        let mut chosen: Vec<(String, PluginManifest)> = Vec::new();
        for sub in subs {
            let dir = if sub.is_empty() { repo.clone() } else { repo.join(sub) };
            let file = if sub.is_empty() { MANIFEST_FILE.to_string() } else { format!("{sub}/{MANIFEST_FILE}") };
            if !is_regular_file(&dir.join(MANIFEST_FILE)) {
                return Err(format!("There is no {MANIFEST_FILE} in the folder \"{sub}\" of {}", meta.url));
            }
            let m = read_manifest(&dir, &file)?;
            if let Some((other, _)) = chosen.iter().find(|(_, o)| o.id == m.id) {
                return Err(format!(
                    "The plugins in \"{other}\" and \"{sub}\" share the id \"{}\"; install one of them",
                    m.id
                ));
            }
            chosen.push((sub.clone(), m));
        }

        let mut placed: Vec<(String, PluginManifest, PathBuf)> = Vec::new();
        for (sub, m) in chosen {
            let src = if sub.is_empty() { repo.clone() } else { repo.join(&sub) };
            let dest = self.place_copy(&src, &m.id)?;
            placed.push((sub, m, dest));
        }

        let now = now_ms();
        self.with_registry(|records| {
            let mut out = Vec::new();
            for (sub, manifest, dest) in placed {
                let previous = records.iter().position(|r| r.manifest.id == manifest.id).map(|i| records.remove(i));
                let record = Record {
                    source: PluginSource::Git {
                        url: meta.url.clone(),
                        reference: meta.reference.clone(),
                        subpath: (!sub.is_empty()).then_some(sub),
                    },
                    dir: display_path(&dest),
                    enabled: true,
                    commit: Some(meta.commit.clone()),
                    installed_at: previous.as_ref().map_or(now, |p| p.installed_at),
                    updated_at: now,
                    repo: Some(key.clone()),
                    extra: Map::new(),
                    manifest,
                };
                out.push(record.public());
                records.push(record);
            }
            Ok(out)
        })
    }

    /// Copies a plugin folder to `installed/<id>`, replacing what is there only once the copy is
    /// complete. Call with `repos` held.
    fn place_copy(&self, src: &Path, id: &str) -> Result<PathBuf, String> {
        debug_assert!(valid_id(id));
        let root = self.installed_root();
        fs::create_dir_all(&root).map_err(|e| format!("Could not create {}: {e}", root.display()))?;
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let tmp = root.join(format!(".tmp-{id}-{tag}"));
        let mut budget = CopyBudget::default();
        if let Err(e) = copy_tree(src, &tmp, &mut budget) {
            let _ = remove_tree(&tmp);
            return Err(format!("Could not copy plugin \"{id}\": {e}"));
        }
        let dest = root.join(id);
        let old = root.join(format!(".old-{id}-{tag}"));
        let had_old = dest.exists();
        if had_old {
            if let Err(e) = fs::rename(&dest, &old) {
                let _ = remove_tree(&tmp);
                return Err(format!("Could not replace plugin \"{id}\" (is a file in {} open?): {e}", dest.display()));
            }
        }
        if let Err(e) = fs::rename(&tmp, &dest) {
            if had_old {
                let _ = fs::rename(&old, &dest);
            }
            let _ = remove_tree(&tmp);
            return Err(format!("Could not install plugin \"{id}\": {e}"));
        }
        if had_old {
            let _ = remove_tree(&old);
        }
        Ok(dest)
    }

    /// Deletes repository clones no installed plugin uses, and leftovers of interrupted copies.
    /// Call with `repos` held.
    fn gc_repos(&self) {
        let used: HashSet<String> = {
            let _g = lock(&self.registry);
            self.load().iter().filter_map(Record::repo_key).collect()
        };
        if let Ok(entries) = fs::read_dir(self.repos_root()) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !used.contains(&name) {
                    let _ = remove_tree(&e.path());
                }
            }
        }
        if let Ok(entries) = fs::read_dir(self.installed_root()) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with(".tmp-") || name.starts_with(".old-") {
                    let _ = remove_tree(&e.path());
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Local plugins, enable, remove
    // -----------------------------------------------------------------------

    pub fn add_local(&self, path: &str) -> Result<InstalledPlugin, String> {
        let path = path.trim();
        if path.is_empty() {
            return Err("Choose a folder".into());
        }
        let dir = fs::canonicalize(path).map_err(|e| format!("Could not open the folder {path}: {e}"))?;
        if !dir.is_dir() {
            return Err(format!("{path} is not a folder"));
        }
        let shown = display_path(&dir);
        if !is_regular_file(&dir.join(MANIFEST_FILE)) {
            return Err(format!("{shown} holds no {MANIFEST_FILE}"));
        }
        let manifest = read_manifest(&dir, &format!("{MANIFEST_FILE} in {shown}"))?;
        let now = now_ms();
        self.with_registry(|records| {
            let previous = match records.iter().position(|r| r.manifest.id == manifest.id) {
                Some(i) => {
                    if let PluginSource::Git { url, .. } = &records[i].source {
                        return Err(format!(
                            "{} (\"{}\") is already installed from {url}. Remove it first to use this folder instead",
                            records[i].manifest.name, manifest.id
                        ));
                    }
                    Some(records.remove(i))
                }
                None => None,
            };
            let record = Record {
                source: PluginSource::Local { path: shown.clone() },
                dir: shown.clone(),
                enabled: previous.as_ref().is_none_or(|p| p.enabled),
                commit: None,
                installed_at: previous.as_ref().map_or(now, |p| p.installed_at),
                updated_at: now,
                repo: None,
                extra: previous.map(|p| p.extra).unwrap_or_default(),
                manifest: manifest.clone(),
            };
            let out = record.public();
            records.push(record);
            Ok(out)
        })
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<InstalledPlugin, String> {
        self.with_registry(|records| {
            let r = records
                .iter_mut()
                .find(|r| r.manifest.id == id)
                .ok_or_else(|| format!("No plugin with the id \"{id}\" is installed"))?;
            r.enabled = enabled;
            Ok(r.public())
        })
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _repos = lock(&self.repos);
        let removed = self.with_registry(|records| {
            let i = records
                .iter()
                .position(|r| r.manifest.id == id)
                .ok_or_else(|| format!("No plugin with the id \"{id}\" is installed"))?;
            Ok(records.remove(i))
        })?;
        // Only ever our own copy: a local plugin's folder belongs to its author.
        if removed.git().is_some() && valid_id(id) {
            let copy = self.installed_root().join(id);
            if copy.exists() {
                remove_tree(&copy).map_err(|e| {
                    format!("Removed the plugin, but could not delete its files in {}: {e}", copy.display())
                })?;
            }
        }
        self.gc_repos();
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Updates
    // -----------------------------------------------------------------------

    /// The repository clone for a source, cloned again when it is missing. Call with `repos` held.
    fn ensure_repo(&self, key: &str, url: &str, reference: Option<&str>, progress: &dyn Fn(&str)) -> Result<PathBuf, String> {
        let repo = self.repos_root().join(key);
        if repo.join(".git").exists() {
            return Ok(repo);
        }
        // Stored sources passed these checks when installed; check again anyway.
        let url = validate_url(url, cfg!(test))?;
        let reference = normalize_ref(reference)?;
        fs::create_dir_all(self.repos_root()).map_err(|e| format!("Could not create the repository folder: {e}"))?;
        if repo.exists() {
            remove_tree(&repo).map_err(|e| format!("Could not clear {}: {e}", repo.display()))?;
        }
        let tmp = self.repos_root().join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
        if let Err(e) = gitops::clone(&url, reference.as_deref(), &tmp, progress) {
            let _ = remove_tree(&tmp);
            return Err(e);
        }
        move_dir(&tmp, &repo)?;
        Ok(repo)
    }

    /// The newest commit of a source: fetched, or the pinned commit itself.
    fn latest(&self, repo: &Path, reference: Option<&str>, progress: &dyn Fn(&str)) -> Result<String, String> {
        match reference {
            Some(r) if is_sha_like(r) => gitops::resolve(repo, r),
            _ => gitops::fetch(repo, reference, progress),
        }
    }

    pub fn check_updates(&self, ids: Option<&[String]>, progress: &dyn Fn(&str)) -> Vec<PluginUpdateInfo> {
        let records = {
            let _g = lock(&self.registry);
            self.load()
        };
        let mut out = Vec::new();
        let mut groups: BTreeMap<String, Vec<&Record>> = BTreeMap::new();
        let wanted: Vec<&Record> = match ids {
            None => records.iter().collect(),
            Some(ids) => {
                let mut v = Vec::new();
                for id in ids {
                    match records.iter().find(|r| &r.manifest.id == id) {
                        Some(r) => v.push(r),
                        None => out.push(info(id, None, Err(format!("No plugin with the id \"{id}\" is installed")))),
                    }
                }
                v
            }
        };
        for r in wanted {
            match r.repo_key() {
                Some(key) => groups.entry(key).or_default().push(r),
                None => out.push(PluginUpdateInfo {
                    id: r.manifest.id.clone(),
                    current: None,
                    latest: None,
                    latest_version: None,
                    has_update: false,
                    error: None,
                }),
            }
        }

        let _repos = lock(&self.repos);
        for (key, members) in groups {
            let (url, reference, _) = members[0].git().expect("grouped records are git plugins");
            let latest = self
                .ensure_repo(&key, url, reference, progress)
                .and_then(|repo| self.latest(&repo, reference, progress).map(|c| (repo, c)));
            for r in members {
                let (_, _, sub) = r.git().expect("grouped records are git plugins");
                let result = latest.as_ref().map(|(repo, commit)| (commit.clone(), gitops::version_at(repo, commit, sub)));
                out.push(info(&r.manifest.id, r.commit.clone(), result.map_err(|e| e.clone())));
            }
        }
        out
    }

    pub fn update(&self, id: &str, progress: &dyn Fn(&str)) -> Result<InstalledPlugin, String> {
        let record = self.find(id)?;
        let Some((url, reference, sub)) = record.git() else {
            // A local plugin: read its manifest again.
            let dir = PathBuf::from(&record.dir);
            let manifest = read_manifest(&dir, &format!("{MANIFEST_FILE} in {}", record.dir))?;
            if manifest.id != id {
                return Err(format!(
                    "{MANIFEST_FILE} in {} now says its id is \"{}\" instead of \"{id}\"; remove the plugin and add the folder again",
                    record.dir, manifest.id
                ));
            }
            return self.with_registry(|records| {
                let r = records
                    .iter_mut()
                    .find(|r| r.manifest.id == id)
                    .ok_or_else(|| format!("No plugin with the id \"{id}\" is installed"))?;
                r.manifest = manifest;
                r.updated_at = now_ms();
                Ok(r.public())
            });
        };

        let _repos = lock(&self.repos);
        let key = record.repo_key().expect("git plugin");
        let repo = self.ensure_repo(&key, url, reference, progress)?;
        let commit = self.latest(&repo, reference, progress)?;
        gitops::reset_to(&repo, &commit)?;
        let dir = if sub.is_empty() { repo.clone() } else { repo.join(sub) };
        let file = if sub.is_empty() { MANIFEST_FILE.to_string() } else { format!("{sub}/{MANIFEST_FILE}") };
        if !is_regular_file(&dir.join(MANIFEST_FILE)) {
            return Err(format!("{url} no longer has {file}"));
        }
        let manifest = read_manifest(&dir, &file)?;
        if manifest.id != id {
            return Err(format!(
                "The plugin in {url} now has the id \"{}\" instead of \"{id}\"; remove it and install it again",
                manifest.id
            ));
        }
        let dest = self.place_copy(&dir, id)?;
        self.with_registry(|records| {
            let r = records
                .iter_mut()
                .find(|r| r.manifest.id == id)
                .ok_or_else(|| format!("No plugin with the id \"{id}\" is installed"))?;
            r.manifest = manifest;
            r.commit = Some(commit.clone());
            r.dir = display_path(&dest);
            r.repo = Some(key.clone());
            r.updated_at = now_ms();
            Ok(r.public())
        })
    }

    // -----------------------------------------------------------------------
    // Files
    // -----------------------------------------------------------------------

    /// The bytes of a file inside an installed plugin's folder.
    pub fn read_file(&self, id: &str, path: &str) -> Result<Vec<u8>, String> {
        let record = self.find(id)?;
        let file = confined(Path::new(&record.dir), path)?;
        read_capped(&file, READ_MAX).map_err(|e| format!("Could not read {path} of plugin \"{id}\": {e}"))
    }
}

fn info(id: &str, current: Option<String>, latest: Result<(String, Option<String>), String>) -> PluginUpdateInfo {
    match latest {
        Ok((commit, version)) => PluginUpdateInfo {
            id: id.to_string(),
            has_update: current.as_deref() != Some(commit.as_str()),
            current,
            latest: Some(commit),
            latest_version: version,
            error: None,
        },
        Err(e) => PluginUpdateInfo {
            id: id.to_string(),
            current,
            latest: None,
            latest_version: None,
            has_update: false,
            error: Some(e),
        },
    }
}

// ---------------------------------------------------------------------------
// Files and folders
// ---------------------------------------------------------------------------

fn is_regular_file(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

fn read_capped(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > max {
        return Err(format!("it is larger than {} MB", max / (1024 * 1024)));
    }
    let mut out = Vec::with_capacity(len as usize);
    f.take(max + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
    if out.len() as u64 > max {
        return Err(format!("it is larger than {} MB", max / (1024 * 1024)));
    }
    Ok(out)
}

/// Reads and checks `<dir>/mango-plugin.json`, and that its entry module and stylesheet exist.
pub fn read_manifest(dir: &Path, file: &str) -> Result<PluginManifest, String> {
    let path = dir.join(MANIFEST_FILE);
    if !is_regular_file(&path) {
        return Err(format!("{file} is missing"));
    }
    let bytes = read_capped(&path, MANIFEST_MAX).map_err(|e| format!("{file} could not be read: {e}"))?;
    let m = parse_manifest(&bytes, file)?;
    for (what, rel) in [("entry module", m.main.as_deref()), ("stylesheet", m.styles.as_deref())] {
        if let Some(rel) = rel {
            if confined(dir, rel).is_err() {
                return Err(format!("{file}: the {what} {rel} of plugin \"{}\" is missing", m.id));
            }
        }
    }
    Ok(m)
}

/// `rel` resolved inside `dir`: relative, no `..`, an existing file, and still inside `dir` once
/// symlinks are followed.
pub fn confined(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = safe_rel_file(rel, "The file")?;
    let root = fs::canonicalize(dir).map_err(|e| format!("The plugin folder {} is gone: {e}", dir.display()))?;
    let target = fs::canonicalize(root.join(&rel)).map_err(|_| format!("The plugin has no file {rel}"))?;
    if !target.starts_with(&root) {
        return Err(format!("{rel} is outside the plugin's folder"));
    }
    if !target.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    Ok(target)
}

/// Every folder (relative, `/`-separated, `''` = root) holding a manifest, a few levels deep.
/// Skips `.git`, hidden folders, `node_modules` and symlinks.
pub fn discover(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>) {
        if out.len() >= DISCOVER_MAX {
            return;
        }
        if is_regular_file(&dir.join(MANIFEST_FILE)) {
            out.push(rel.to_string());
        }
        if depth >= DISCOVER_DEPTH {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut children: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                (!name.starts_with('.') && name != "node_modules").then(|| (name, e.path()))
            })
            .collect();
        children.sort();
        for (name, path) in children {
            let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            walk(&path, &child, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(root, "", 0, &mut out);
    out
}

#[derive(Default)]
struct CopyBudget {
    bytes: u64,
    files: usize,
}

/// Copies a folder, leaving out `.git` folders and symlinks.
fn copy_tree(src: &Path, dst: &Path, budget: &mut CopyBudget) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("could not create {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("could not read {}: {e}", src.display()))?;
    for e in entries {
        let e = e.map_err(|e| format!("could not read {}: {e}", src.display()))?;
        let ty = e.file_type().map_err(|e| e.to_string())?;
        let name = e.file_name();
        if ty.is_symlink() {
            continue;
        }
        if ty.is_dir() {
            if name == ".git" {
                continue;
            }
            copy_tree(&e.path(), &dst.join(&name), budget)?;
        } else if ty.is_file() {
            budget.files += 1;
            budget.bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            if budget.files > COPY_MAX_FILES || budget.bytes > COPY_MAX_BYTES {
                return Err("the folder is too large for a plugin (over 200 MB or 20,000 files)".into());
            }
            fs::copy(e.path(), dst.join(&name)).map_err(|err| format!("could not copy {}: {err}", e.path().display()))?;
        }
    }
    Ok(())
}

/// Moves a folder; copies it when a rename is not possible (another drive, a locked file).
fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_all(src, dst).map_err(|e| {
        let _ = remove_tree(dst);
        format!("Could not move {} to {}: {e}", src.display(), dst.display())
    })?;
    let _ = remove_tree(src);
    Ok(())
}

/// Copies everything (`.git` included), skipping symlinks.
fn copy_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let ty = e.file_type()?;
        if ty.is_dir() {
            copy_all(&e.path(), &dst.join(e.file_name()))?;
        } else if ty.is_file() {
            fs::copy(e.path(), dst.join(e.file_name()))?;
        }
    }
    Ok(())
}

/// Deletes a folder tree. git marks its object files read-only, which Windows refuses to delete:
/// clear that and try again.
pub fn remove_tree(path: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => {
            make_writable(path);
            fs::remove_dir_all(path)
        }
    }
}

fn make_writable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    let mut perms = meta.permissions();
    if perms.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = fs::set_permissions(path, perms);
    }
    if meta.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            for e in entries.flatten() {
                make_writable(&e.path());
            }
        }
    }
}

/// Writes a file through a temporary file and a rename, so a crash never leaves half of it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not write {}: {e}", path.display())
    })
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "json" => "application/json",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}
