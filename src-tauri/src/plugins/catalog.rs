//! The official plugin catalog: `plugins/catalog.json` in Mango's repository, cached for an hour,
//! with the copy built into this version as the last resort.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::store::{now_ms, write_atomic};
use super::validate::valid_id;

const CATALOG_URL: &str = "https://raw.githubusercontent.com/ReaperMaga/mango/main/plugins/catalog.json";
const CACHE_FILE: &str = "catalog-cache.json";
const CACHE_FOR_MS: u64 = 60 * 60 * 1000;
const CATALOG_MAX: usize = 2 * 1024 * 1024;
const BUNDLED: &str = include_str!("../../../plugins/catalog.json");

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CatalogSource {
    pub url: String,
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub subpath: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub official: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub source: CatalogSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PluginCatalog {
    pub schema: u32,
    pub plugins: Vec<PluginCatalogEntry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogResult {
    pub catalog: PluginCatalog,
    pub fetched_at: u64,
    pub stale: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    fetched_at: u64,
    catalog: PluginCatalog,
}

/// Reads a catalog: `schema` must be 1; entries this build can't read are left out.
pub fn parse_catalog(bytes: &[u8]) -> Result<PluginCatalog, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("The plugin catalog is not valid JSON: {e}"))?;
    match v.get("schema").and_then(Value::as_u64) {
        Some(1) => {}
        Some(n) => {
            return Err(format!(
                "The plugin catalog uses a newer format (schema {n}) than this version of Mango reads; update Mango"
            ))
        }
        None => return Err("The plugin catalog has no schema version".into()),
    }
    let plugins = v
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or("The plugin catalog has no plugin list")?
        .iter()
        .filter_map(|p| serde_json::from_value::<PluginCatalogEntry>(p.clone()).ok())
        .filter(|p| valid_id(&p.id) && !p.name.trim().is_empty() && !p.source.url.trim().is_empty())
        .collect();
    Ok(PluginCatalog { schema: 1, plugins })
}

fn read_cache(file: &Path) -> Option<Cache> {
    let bytes = fs::read(file).ok()?;
    let cache: Cache = serde_json::from_slice(&bytes).ok()?;
    (cache.catalog.schema == 1).then_some(cache)
}

fn bundled() -> PluginCatalog {
    parse_catalog(BUNDLED.as_bytes()).unwrap_or(PluginCatalog { schema: 1, plugins: Vec::new() })
}

async fn fetch() -> Result<PluginCatalog, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Mango/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Could not reach the plugin catalog: {e}"))?;
    let res = client
        .get(CATALOG_URL)
        .send()
        .await
        .map_err(|e| format!("Could not reach the plugin catalog (offline?): {e}"))?;
    if !res.status().is_success() {
        return Err(format!("The plugin catalog could not be loaded (HTTP {})", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("The plugin catalog download broke off: {e}"))?;
    if bytes.len() > CATALOG_MAX {
        return Err("The plugin catalog is unexpectedly large".into());
    }
    parse_catalog(&bytes)
}

/// The catalog: the cached copy while it is younger than an hour (unless `force`), else a fresh
/// one; when that fails, the cached copy or the built-in one, with the reason in `stale`.
pub async fn catalog(base: &Path, force: bool) -> Result<PluginCatalogResult, String> {
    let file = base.join(CACHE_FILE);
    let cached = {
        let file = file.clone();
        tauri::async_runtime::spawn_blocking(move || read_cache(&file)).await.ok().flatten()
    };
    let now = now_ms();
    if !force {
        if let Some(c) = &cached {
            if now.saturating_sub(c.fetched_at) < CACHE_FOR_MS {
                return Ok(PluginCatalogResult { catalog: c.catalog.clone(), fetched_at: c.fetched_at, stale: None });
            }
        }
    }
    match fetch().await {
        Ok(catalog) => {
            let cache = Cache { fetched_at: now, catalog };
            if let Ok(json) = serde_json::to_vec_pretty(&cache) {
                let _ = tauri::async_runtime::spawn_blocking(move || write_atomic(&file, &json)).await;
            }
            Ok(PluginCatalogResult { catalog: cache.catalog, fetched_at: now, stale: None })
        }
        Err(reason) => Ok(match cached {
            Some(c) => PluginCatalogResult { catalog: c.catalog, fetched_at: c.fetched_at, stale: Some(reason) },
            // Unix ms 0: the copy built into this version, never fetched.
            None => PluginCatalogResult {
                catalog: bundled(),
                fetched_at: 0,
                stale: Some(format!("{reason}. Showing the catalog built into this version of Mango")),
            },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_schema_and_entries() {
        assert!(parse_catalog(br#"{"schema":2,"plugins":[]}"#).unwrap_err().contains("newer format"));
        assert!(parse_catalog(br#"{"plugins":[]}"#).is_err());
        assert!(parse_catalog(b"nope").is_err());
        let c = parse_catalog(
            br#"{"schema":1,"plugins":[
                {"id":"ok","name":"Ok","description":"d","author":"a","version":"1.0.0","tags":["x"],"official":true,
                 "source":{"url":"https://github.com/a/b","ref":null,"subpath":"plugins/ok"},"future":1},
                {"id":"Bad Id","name":"x","source":{"url":"https://x/y"}},
                {"id":"nosource","name":"x"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(c.plugins.len(), 1);
        assert_eq!(c.plugins[0].source.subpath.as_deref(), Some("plugins/ok"));
        let json = serde_json::to_value(&c).unwrap();
        assert!(json["plugins"][0]["source"]["ref"].is_null());
        assert!(json["plugins"][0].get("homepage").is_none());
    }

    #[test]
    fn bundled_catalog_parses() {
        assert_eq!(bundled().schema, 1);
    }
}
