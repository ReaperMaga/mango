import type { InstalledPlugin, PluginAsset, PluginCandidate, PluginCatalog, PluginCatalogEntry, PluginCatalogResult, PluginManifest, PluginProbe, PluginSource, PluginUpdateInfo } from '~/types/ipc'
import { repoLabel } from '~/utils/pluginSource'

/**
 * The browser preview's plugins (`plugins_*`): the catalog and the official plugins come from this
 * repository's own `plugins/` folder (read through Vite, so `pnpm dev` shows what ships), any other
 * repository is a made-up one holding a few small plugins. Installs, switches and removals are kept
 * in localStorage, so a reload keeps them. Probing, update checks and updates print a few
 * git-like progress lines first, as the real clone does.
 *
 * Try in the preview: a link with "missing" in it fails like a repository that does not exist.
 */

type Emit = (event: string, payload: unknown) => void

const home = '/home/you'
const PLUGINS_DIR = `${home}/.local/share/mango/plugins`
const MANGO_REPO = 'github.com/reapermaga/mango'
const STORE = 'mango.preview.plugins'

/* ---------- this repository's plugins/ folder ---------- */

const ROOT = '../../plugins/'
const texts = import.meta.glob('../../plugins/**/*', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>
const urls = import.meta.glob('../../plugins/**/*.{png,jpg,jpeg,gif,webp,ico,woff,woff2,ttf,otf}', { query: '?url', import: 'default' }) as Record<string, () => Promise<string>>

async function repoText(path: string): Promise<string | null> {
  const load = texts[ROOT + path]
  return load ? load() : null
}

/** The official plugins: every `plugins/<folder>/mango-plugin.json` that reads. */
async function repoManifests(): Promise<Array<{ subpath: string; manifest: PluginManifest }>> {
  const out: Array<{ subpath: string; manifest: PluginManifest }> = []
  for (const key of Object.keys(texts)) {
    const m = /^\.\.\/\.\.\/plugins\/(.+)\/mango-plugin\.json$/.exec(key)
    if (!m) continue
    try {
      const manifest = JSON.parse(await texts[key]!()) as PluginManifest
      if (manifest?.id && manifest.name) out.push({ subpath: `plugins/${m[1]}`, manifest })
    } catch { /* being written */ }
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

/* ---------- a made-up repository with a few plugins, inline ---------- */

interface InlinePlugin { subpath: string; manifest: PluginManifest; files: Record<string, string> }

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>'

const DEMO: InlinePlugin[] = [
  {
    subpath: 'plugins/hello',
    manifest: {
      id: 'hello-mango', name: 'Hello Mango', version: '1.2.0', author: 'Demo Plugins', main: 'main.js',
      description: 'Adds a "Say hello" command to the palette. A small example of commands and settings.',
      homepage: 'https://example.com/hello-mango',
      settings: [
        { key: 'greeting', type: 'string', label: 'Greeting', description: 'What the command says.', default: 'Hello from a plugin', placeholder: 'Hello' },
        { key: 'excited', type: 'boolean', label: 'Excited', description: 'End the greeting with an exclamation mark.', default: true },
      ],
    },
    files: {
      'main.js': `export function activate(mango) {
  mango.commands.register({
    id: 'hello',
    title: 'Say hello',
    run: () => {
      const text = mango.settings.get('greeting') + (mango.settings.get('excited') ? '!' : '.')
      mango.ui.toast({ title: text })
      mango.log.info('Said hello')
    },
  })
  mango.log.info('Ready')
}
`,
      'icon.svg': ICON,
    },
  },
  {
    subpath: 'plugins/word-count',
    manifest: {
      id: 'word-count', name: 'Word count', version: '0.3.1', author: 'Demo Plugins', main: 'main.js',
      description: 'Counts the words in the chat on screen, and adds a settings page that shows the total.',
      settings: [
        { key: 'unit', type: 'select', label: 'Count', default: 'words', options: [{ value: 'words', label: 'Words' }, { value: 'chars', label: 'Characters' }] },
        { key: 'goal', type: 'number', label: 'Daily goal', description: 'Shown beside the count.', default: 500, min: 0, max: 100000 },
        { key: 'note', type: 'text', label: 'Note', description: 'Free text shown on the settings page.', placeholder: 'Anything you like' },
      ],
    },
    files: {
      'main.js': `export function activate(mango) {
  mango.ui.settingsPages.register({
    id: 'overview',
    title: 'Word count',
    view: {
      mount(el) {
        const p = document.createElement('p')
        p.textContent = 'Word count keeps its numbers here. Goal: ' + mango.settings.get('goal') + ' ' + mango.settings.get('unit') + '.'
        el.append(p)
      },
    },
  })
  mango.log.info('Settings page registered')
}
`,
    },
  },
  {
    subpath: 'plugins/broken',
    manifest: {
      id: 'broken-example', name: 'Broken example', version: '0.0.1', author: 'Demo Plugins', main: 'main.js',
      description: 'Fails to start on purpose, to show what a failing plugin looks like.',
    },
    files: {
      'main.js': `export function activate(mango) {
  mango.log.warn('About to fail')
  throw new Error('This example fails on purpose.')
}
`,
    },
  },
]

/** A folder added with "Add local folder": a tiny plugin named after it. */
function localPlugin(path: string): InlinePlugin {
  const leaf = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'my-plugin'
  const id = leaf.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'my-plugin'
  return {
    subpath: '',
    manifest: { id, name: leaf, version: '0.1.0', description: 'A plugin from a folder on this computer.', main: 'main.js' },
    files: { 'main.js': `export function activate(mango) {\n  mango.log.info('Loaded from ${path.replace(/[\\'`$]/g, '')}')\n}\n` },
  }
}

/* ---------- what is installed (kept across reloads) ---------- */

type Origin = { kind: 'repo'; base: string } | { kind: 'inline'; files: Record<string, string> }
interface Rec { info: InstalledPlugin; origin: Origin; /** Already moved to the "latest" commit once. */ updated?: boolean }

let records: Rec[] = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
})()
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(records)) } catch { /* not kept */ } }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const find = (id: string) => {
  const r = records.find(x => x.info.manifest.id === id)
  if (!r) throw new Error(`No plugin with the id ${id} is installed.`)
  return r
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

async function progress(emit: Emit, jobId: string, url: string) {
  const lines = [
    `Cloning into '${repoLabel(url).split('/').pop()}'...`,
    'remote: Enumerating objects: 64, done.',
    'remote: Counting objects: 100% (64/64), done.',
    'Receiving objects:  47% (30/64)',
    'Receiving objects: 100% (64/64), 21.4 KiB | 2.1 MiB/s, done.',
    'Resolving deltas: 100% (9/9), done.',
  ]
  for (const line of lines) {
    emit('plugins://progress', { jobId, line })
    await sleep(180)
  }
}

const isMangoRepo = (url: string) => repoLabel(url).toLowerCase() === MANGO_REPO

/* ---------- probes ---------- */

interface Probe { source: Extract<PluginSource, { kind: 'git' }>; commit: string; found: Array<{ subpath: string; manifest: PluginManifest; origin: Origin }> }
const probes = new Map<string, Probe>()

async function probe(source: Extract<PluginSource, { kind: 'git' }>, jobId: string, emit: Emit): Promise<PluginProbe> {
  if (/missing|nope|404/i.test(source.url)) {
    await sleep(500)
    throw new Error(`git could not clone ${source.url}: the repository does not exist, or it is private and git has no access to it.`)
  }
  await progress(emit, jobId, source.url)
  let found: Probe['found']
  if (isMangoRepo(source.url)) {
    const official = await repoManifests()
    found = official.map(o => ({ ...o, origin: { kind: 'repo', base: o.subpath.slice('plugins/'.length) } as Origin }))
    if (!found.length) found = DEMO.map(d => ({ subpath: d.subpath, manifest: d.manifest, origin: { kind: 'inline', files: d.files } as Origin }))
  } else {
    found = DEMO.map(d => ({ subpath: d.subpath, manifest: d.manifest, origin: { kind: 'inline', files: d.files } as Origin }))
  }
  if (source.subpath) {
    found = found.filter(f => f.subpath === source.subpath)
    if (!found.length) throw new Error(`There is no mango-plugin.json in ${source.subpath} of ${repoLabel(source.url)}. Check the folder, or leave it empty to list every plugin in the repository.`)
  }
  if (source.ref && /^bad/i.test(source.ref)) throw new Error(`git could not find the branch or tag ${source.ref} in ${repoLabel(source.url)}.`)
  const probeId = `probe-${hex(8)}`
  const commit = hex(40)
  // Like the backend: the newest few probes stay installable (a catalog install must not drop the Add dialog's).
  probes.set(probeId, { source, commit, found })
  for (const k of [...probes.keys()].slice(0, -3)) probes.delete(k)
  const candidates: PluginCandidate[] = found.map(f => ({
    subpath: f.subpath,
    manifest: clone(f.manifest),
    installed: records.some(r => r.info.manifest.id === f.manifest.id),
  }))
  return { probeId, url: source.url, ref: source.ref, commit, candidates }
}

function put(rec: Rec) {
  const at = records.findIndex(r => r.info.manifest.id === rec.info.manifest.id)
  if (at >= 0) records[at] = rec
  else records.push(rec)
  save()
}

async function install(probeId: string, subpaths: string[]): Promise<InstalledPlugin[]> {
  const p = probes.get(probeId)
  if (!p) throw new Error('That check of the repository has expired. Check it again, then install.')
  if (!subpaths.length) throw new Error('Pick at least one plugin to install.')
  await sleep(400)
  const now = Date.now()
  const out: InstalledPlugin[] = []
  for (const sub of subpaths) {
    const f = p.found.find(x => x.subpath === sub)
    if (!f) throw new Error(`No plugin at ${sub || 'the repository root'} in that repository.`)
    const before = records.find(r => r.info.manifest.id === f.manifest.id)
    const info: InstalledPlugin = {
      manifest: clone(f.manifest),
      source: { kind: 'git', url: p.source.url, ref: p.source.ref, subpath: f.subpath || null },
      dir: `${PLUGINS_DIR}/${f.manifest.id}`,
      enabled: before?.info.enabled ?? true,
      commit: p.commit,
      installedAt: before?.info.installedAt ?? now,
      updatedAt: now,
    }
    put({ info, origin: f.origin })
    out.push(clone(info))
  }
  probes.delete(probeId)
  return out
}

async function addLocal(path: string): Promise<InstalledPlugin> {
  await sleep(250)
  if (/nothing|empty/i.test(path)) throw new Error(`There is no mango-plugin.json in ${path}. Pick the folder that holds it.`)
  const l = localPlugin(path)
  const now = Date.now()
  const info: InstalledPlugin = {
    manifest: l.manifest, source: { kind: 'local', path }, dir: path, enabled: true, commit: null, installedAt: now, updatedAt: now,
  }
  put({ info, origin: { kind: 'inline', files: l.files } })
  return clone(info)
}

async function checkUpdates(ids: string[] | null, jobId: string, emit: Emit): Promise<PluginUpdateInfo[]> {
  const list = records.filter(r => !ids || ids.includes(r.info.manifest.id))
  const git = list.filter(r => r.info.source.kind === 'git')
  if (git[0]) await progress(emit, jobId, (git[0].info.source as { url: string }).url)
  // One plugin that has not been updated yet has a newer commit: the first git one.
  const outdated = git.find(r => !r.updated)
  return list.map((r): PluginUpdateInfo => {
    if (r.info.source.kind === 'local') {
      return { id: r.info.manifest.id, current: null, latest: null, latestVersion: null, hasUpdate: false, error: null }
    }
    const has = r === outdated
    return {
      id: r.info.manifest.id,
      current: r.info.commit,
      latest: has ? hex(40) : r.info.commit,
      latestVersion: has ? bump(r.info.manifest.version) : r.info.manifest.version,
      hasUpdate: has,
      error: null,
    }
  })
}

function bump(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : `${v}.1`
}

async function update(id: string, jobId: string, emit: Emit): Promise<InstalledPlugin> {
  const r = find(id)
  if (r.info.source.kind === 'git') {
    await progress(emit, jobId, r.info.source.url)
    if (!r.updated) r.info.manifest.version = bump(r.info.manifest.version)
    r.info.commit = hex(40)
    r.updated = true
  } else {
    await sleep(200)
  }
  r.info.updatedAt = Date.now()
  save()
  return clone(r.info)
}

async function read(id: string, path: string): Promise<string> {
  const r = find(id)
  const rel = path.replace(/^\.?\//, '')
  if (rel.split('/').includes('..')) throw new Error(`${path} is outside the plugin's folder.`)
  const text = r.origin.kind === 'repo' ? await repoText(`${r.origin.base}/${rel}`) : r.origin.files[rel] ?? null
  if (text === null) throw new Error(`There is no file ${rel} in ${id}.`)
  return text
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
}

async function asset(id: string, path: string): Promise<PluginAsset> {
  const r = find(id)
  const rel = path.replace(/^\.?\//, '')
  const mime = MIME[rel.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
  if (r.origin.kind === 'repo') {
    const url = urls[`${ROOT}${r.origin.base}/${rel}`]
    if (url) {
      const bytes = new Uint8Array(await (await fetch(await url())).arrayBuffer())
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return { mime, data: btoa(bin) }
    }
  }
  const text = await read(id, rel)
  return { mime, data: btoa(unescape(encodeURIComponent(text))) }
}

/* ---------- the catalog ---------- */

async function catalog(): Promise<PluginCatalogResult> {
  await sleep(350)
  let parsed: PluginCatalog | null = null
  try {
    const raw = await repoText('catalog.json')
    const c = raw ? JSON.parse(raw) : null
    if (c && Array.isArray(c.plugins)) parsed = c
  } catch { /* being written */ }
  if (!parsed?.plugins.length) {
    // No catalog yet: list the official plugins found, and the made-up community ones.
    const official = await repoManifests()
    const entries: PluginCatalogEntry[] = official.map(o => ({
      id: o.manifest.id, name: o.manifest.name, description: o.manifest.description ?? '', author: o.manifest.author ?? 'Mango',
      version: o.manifest.version, tags: [], official: true,
      source: { url: 'https://github.com/ReaperMaga/mango', ref: null, subpath: o.subpath },
    }))
    entries.push(...DEMO.slice(0, 2).map((d, i): PluginCatalogEntry => ({
      id: d.manifest.id, name: d.manifest.name, description: d.manifest.description ?? '', author: d.manifest.author ?? '',
      version: d.manifest.version, tags: i ? ['chat', 'productivity'] : ['example'], official: false, icon: i ? 'text-cursor-input' : 'hand',
      source: { url: 'https://github.com/mango-community/demo-plugins', ref: null, subpath: d.subpath },
    })))
    parsed = { schema: 1, plugins: entries }
  }
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return {
    catalog: parsed,
    fetchedAt: offline ? Date.now() - 3 * 3600_000 : Date.now(),
    stale: offline ? 'You are offline.' : null,
  }
}

/* ---------- commands ---------- */

export async function mockPlugins(cmd: string, args: any, emit: Emit): Promise<unknown> {
  switch (cmd) {
    case 'plugins_list': return records.map(r => clone(r.info))
    case 'plugins_probe': return probe(args.source, args.jobId, emit)
    case 'plugins_install': return install(args.probeId, args.subpaths)
    case 'plugins_add_local': return addLocal(args.path)
    case 'plugins_set_enabled': {
      const r = find(args.id)
      r.info.enabled = !!args.enabled
      save()
      return clone(r.info)
    }
    case 'plugins_remove': {
      find(args.id)
      records = records.filter(r => r.info.manifest.id !== args.id)
      save()
      return
    }
    case 'plugins_check_updates': return checkUpdates(args.ids, args.jobId, emit)
    case 'plugins_update': return update(args.id, args.jobId, emit)
    case 'plugins_read': return read(args.id, args.path)
    case 'plugins_asset': return asset(args.id, args.path)
    case 'plugins_catalog': return catalog()
    case 'plugins_dir': return PLUGINS_DIR
    case 'plugins_reveal': return
  }
  throw new Error(`mock: unknown command ${cmd}`)
}
