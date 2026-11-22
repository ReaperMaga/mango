/**
 * Unity: notices Unity projects and fits Mango to them.
 *
 * - a mark after the project in the titlebar, and a Unity tool window (editor, packages, build scenes);
 * - .meta files and what Unity generates are hidden in the Files view until asked for;
 * - renaming or deleting an asset there takes its .meta along, so references keep working;
 * - icons and editor languages for Unity's file types;
 * - a check of the .meta files, and a search for what references an asset;
 * - one line for agents on how to treat a Unity project.
 *
 * It only reads: the one thing that changes files is the Files view's own rename and delete.
 * Pure helpers come first and are exported for tests/unityPlugin.test.ts.
 */

/* ---------------------------------------------------------------- paths */

const slashes = p => p.replace(/\\/g, '/')
const trimEnd = p => p.replace(/[\\/]+$/, '')
const nameOf = rel => rel.slice(rel.lastIndexOf('/') + 1)
const parentOf = rel => rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
const under = (dir, name) => (dir ? `${dir}/${name}` : name)
const isMeta = name => name.length > 5 && name.endsWith('.meta')
const isRemote = path => path.startsWith('env://')
const extOf = (name) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** An absolute path for Mango's API, which takes forward slashes after a project's folder on every system. */
export const absolute = (project, rel) => (rel ? `${trimEnd(project)}/${rel}` : project)

/** An absolute path, relative to a project; null when it is outside. */
export function relativeTo(project, path) {
  const base = slashes(trimEnd(project))
  const at = slashes(path)
  if (at === base) return ''
  return at.startsWith(`${base}/`) ? at.slice(base.length + 1) : null
}

/** The Unity project a path (relative to the open folder) is in, and the path relative to that project. */
export function placeIn(projects, rel) {
  let best = null
  for (const project of projects) {
    const { root } = project
    const inside = !root || rel === root || rel.startsWith(`${root}/`)
    if (inside && (!best || root.length > best.project.root.length)) {
      best = { project, inner: root ? rel.slice(root.length + 1) : rel }
    }
  }
  return best
}

/* ---------------------------------------------------------------- Unity's rules */

/** What is below `Assets` or below a package in `Packages`; null elsewhere. */
function assetParts(inner) {
  const parts = inner.split('/')
  const from = parts[0] === 'Assets' ? 1 : parts[0] === 'Packages' ? 2 : 0
  return from && parts.length > from ? parts.slice(from) : null
}

/** Whether a .meta beside this entry belongs to it: anything inside Assets or a package that is no .meta itself. */
export const takesMeta = inner => !!assetParts(inner) && !isMeta(nameOf(inner))

/** Whether a path could be an asset's, were its folder, or the one right in it, a Unity project. */
export const mayBeAsset = rel => takesMeta(rel) || (rel.includes('/') && takesMeta(rel.slice(rel.indexOf('/') + 1)))

/** Names Unity does not import. */
export function isIgnoredByUnity(name) {
  const lower = name.toLowerCase()
  return name.startsWith('.') || name.endsWith('~') || lower === 'cvs' || lower.endsWith('.tmp')
}

/** Folders Unity imports as one asset: what is inside needs no .meta. */
export const isOneAsset = name => /\.(bundle|framework|xcframework|androidlib|androidpack|plugin|dsym)$/i.test(name)

/** Whether Unity expects a .meta for this entry. */
export function needsMeta(inner) {
  const parts = assetParts(inner)
  return !!parts && !isMeta(nameOf(inner)) && !parts.some(isIgnoredByUnity) && !parts.slice(0, -1).some(isOneAsset)
}

/** Folders and files at a project's top that Unity writes itself and rebuilds. */
export function isGenerated(inner, isDir) {
  if (!inner || inner.includes('/')) return false
  return isDir ? /^(library|temp|obj)$/i.test(inner) : /\.(csproj|sln|slnx)$/i.test(inner)
}

/* ---------------------------------------------------------------- Unity's files */

/**
 * The editor version of ProjectVersion.txt. It goes into agents' system prompts, so only what looks
 * exactly like a version is taken: the file comes with the repository.
 */
export function parseEditorVersion(text) {
  return /^m_EditorVersion:[ \t]*(\d{1,4}\.\d{1,3}\.\d{1,3}[a-z]\d{1,3}(?:c\d{1,2})?)[ \t\r]*$/m.exec(text)?.[1] ?? null
}

/** `Unity 6.5` for 6000.5.8f1, `Unity 2022.3` for 2022.3.12f1. */
export function shortName(version) {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '')
  if (!m) return 'Unity'
  return `Unity ${m[1] === '6000' ? '6' : m[1]}.${m[2]}`
}

/** A folded value takes this many lines at most. */
const FOLDS_MAX = 32
const ESCAPED = { n: '\n', t: '\t', r: '\r', 0: '\0' }

/**
 * The YAML scalar that starts at `from`, under a key indented by `indent`. Unity folds long ones onto
 * deeper lines and escapes what is not ASCII. No regex runs over the value: it is the repository's.
 */
function scalarAt(text, from, indent) {
  const lineEnd = (at) => {
    const end = text.indexOf('\n', at)
    return end < 0 ? text.length : end
  }
  let end = lineEnd(from)
  let value = text.slice(from, end).trim()
  if (!value) return null
  for (let i = 0; i < FOLDS_MAX && end < text.length; i++) {
    const start = end + 1
    let body = start
    while (text[body] === ' ') body++
    const next = lineEnd(start)
    const part = text.slice(body, next).trim()
    if (body - start <= indent || !part) break
    value = value.startsWith('"') && value.endsWith('\\') ? value.slice(0, -1) + part : `${value} ${part}`
    end = next
  }
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  return value.slice(1, -1).replace(/\\(x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/g, (whole, code) => {
    if (code.length === 1) return ESCAPED[code] ?? code
    const point = Number.parseInt(code.slice(1), 16)
    return point <= 0x10FFFF ? String.fromCodePoint(point) : whole
  })
}

function yamlValue(text, key) {
  const found = new RegExp(`^ {2}${key}:`, 'm').exec(text)
  return found ? scalarAt(text, found.index + found[0].length, 2) : null
}

const INPUT = { 0: 'Input Manager', 1: 'Input System', 2: 'Both' }

export function parsePlayerSettings(text) {
  return {
    product: yamlValue(text, 'productName'),
    company: yamlValue(text, 'companyName'),
    bundleVersion: yamlValue(text, 'bundleVersion'),
    input: INPUT[yamlValue(text, 'activeInputHandler')] ?? null,
  }
}

export function parseBuildScenes(text) {
  return [...text.matchAll(/^[ \t]*- enabled: ([01])\r?\n([ \t]+)path:/gm)]
    .map(m => ({ enabled: m[1] === '1', path: scalarAt(text, m.index + m[0].length, m[2].length) ?? '' }))
    .filter(s => s.path.startsWith('Assets/') || s.path.startsWith('Packages/'))
}

/** The manifest's packages, without Unity's built-in modules. */
export function parsePackages(text) {
  let deps
  try {
    deps = JSON.parse(text.replace(/^﻿/, '')).dependencies
  } catch {
    return null
  }
  if (!deps || typeof deps !== 'object') return null
  return Object.entries(deps)
    .filter(([id, v]) => typeof v === 'string' && !id.startsWith('com.unity.modules.'))
    .map(([id, v]) => ({ id, version: v.startsWith('file:') ? 'local' : /^(https?:|git|ssh:)|\.git(?:[?#]|$)/.test(v) ? 'git' : v }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The render pipeline in use: Built-in unless Graphics or a Quality level names an asset of another.
 * Which one that is, the packages say. Null when the settings could not be read.
 */
export function renderPipeline(packages, graphics, quality) {
  if (graphics === null) return null
  const set = text => /^[ \t]*(?:m_CustomRenderPipeline|customRenderPipeline): \{fileID: (?!0[,}])/m.test(text ?? '')
  if (!set(graphics) && !set(quality)) return 'Built-in'
  const named = [['com.unity.render-pipelines.high-definition', 'HDRP'], ['com.unity.render-pipelines.universal', 'URP']]
  const found = named.flatMap(([id, label]) => {
    const p = packages?.find(x => x.id === id)
    return p ? [`${label} ${p.version}`] : []
  })
  return found.join(', ') || 'Scriptable (custom)'
}

/** A .meta's GUID; null when it is no valid .meta: a merge conflict, two GUIDs, an empty one. */
export function parseGuid(text) {
  if (/^(<{7}|>{7})/m.test(text)) return null
  const lines = text.match(/^guid:.*$/gm)
  if (lines?.length !== 1) return null
  const guid = /^guid: *([0-9a-f]{32})$/i.exec(lines[0].trimEnd())?.[1].toLowerCase()
  return guid && /[^0]/.test(guid) ? guid : null
}

/** The line agents get. One line: Windows CLIs installed as batch files refuse arguments with line breaks. */
export function agentNote(projects) {
  if (!projects.length) return ''
  // Only counts and checked versions: a folder's name is the repository's text and could read as an instruction.
  const versions = [...new Set(projects.map(p => (p.version ? `Unity ${p.version}` : 'Unity')))].slice(0, 8).join(', ')
  const what = projects.length === 1 ? `a Unity project (${versions})` : `a folder of ${projects.length} Unity projects (${versions})`
  return [
    `You are working in ${what}.`,
    'Every file and folder under Assets and in embedded packages has a .meta file with the GUID that references use:',
    'move, rename or delete it together with its asset, never copy one to another asset and never change a guid.',
    'Let Unity create the .meta files of new assets.',
    'Do not edit what Unity generates (Library, Temp, obj, .csproj and .sln files).',
    'Scenes, prefabs and .asset files are YAML linked by fileID and guid: edit them narrowly.',
  ].join(' ')
}

/* ---------------------------------------------------------------- finding projects */

const looksLikeProject = entries =>
  ['Assets', 'ProjectSettings'].every(name => entries.some(e => e.isDir && e.name === name))

/** The backend's words for what is not there, unlike a read that failed for now. */
const isGone = e => /no longer exists|is not a file|is not a folder|not a text file/.test(errorText(e))
/** Folders a deep look lists one by one, at most. */
const DEEP_MAX = 64

/**
 * The Unity projects of an open folder: itself, or the folders right inside it. Those that come along
 * with the one listing cost nothing more; `deep` lists the rest too (the listing brings only some).
 * `failed`: something could not be read for now, so `projects` keeps what was known of it.
 */
export async function findProjects(io, previous = [], { deep = false } = {}) {
  let top
  try {
    top = await io.list('')
  } catch {
    return { projects: previous, failed: true }
  }
  let failed = false
  const roots = new Set()
  if (looksLikeProject(top)) {
    roots.add('')
  } else {
    const folders = top.filter(e => e.isDir)
    for (const e of folders) {
      if ((e.children && looksLikeProject(e.children)) || previous.some(p => p.root === e.name)) roots.add(e.name)
    }
    if (deep) {
      const rest = folders.filter(e => !e.children && !roots.has(e.name) && !e.name.startsWith('.') && e.name !== 'node_modules')
      await eachAtOnce(rest.slice(0, DEEP_MAX), async (e) => {
        try {
          if (looksLikeProject(await io.list(e.name, false))) roots.add(e.name)
        } catch { /* a folder that cannot be listed is no project to show */ }
      })
    }
  }
  const found = await Promise.all([...roots].sort().map(async (root) => {
    try {
      return { root, version: parseEditorVersion(await io.read(under(root, 'ProjectSettings/ProjectVersion.txt'))) }
    } catch (e) {
      if (isGone(e)) return null
      failed = true
      return previous.find(p => p.root === root) ?? null
    }
  }))
  return { projects: found.filter(Boolean), failed }
}

/* ---------------------------------------------------------------- reading a project */

const AT_ONCE = 8
/** A folder listing stops here: one this long may be missing entries. */
const LISTING_MAX = 5000
/** Deeper is a link going round, and so is more folders than this. */
const DEPTH_MAX = 64
const FOLDERS_MAX = 30000

export class Stopped extends Error {}

async function eachAtOnce(items, job, stopped = () => false) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
    while (next < items.length) {
      if (stopped()) throw new Stopped()
      await job(items[next++])
    }
  }))
}

/**
 * Every folder Unity imports (Assets and each embedded package) and those in `also`. `cut` holds the
 * folders too long to list whole: what is in their listing counts, what is not is never judged.
 */
async function readTree(io, stopped, also = []) {
  const dirs = new Map()
  const cut = new Set()
  const unread = []
  let level = ['Assets', ...also].map(dir => ({ dir, entries: null }))
  try {
    const packages = await io.list('Packages')
    for (const e of packages) {
      if (e.isDir && !isIgnoredByUnity(e.name)) level.push({ dir: `Packages/${e.name}`, entries: e.children ?? null, isPackage: true })
    }
  } catch {
    unread.push('Packages')
  }
  for (let depth = 0; level.length && depth < DEPTH_MAX; depth++) {
    const next = []
    await eachAtOnce(level, async ({ dir, entries, isPackage }) => {
      if (dirs.size >= FOLDERS_MAX) {
        unread.push(dir)
        return
      }
      let here = entries
      try {
        here ??= await io.list(dir)
      } catch {
        unread.push(dir)
        return
      }
      // Without a package.json Unity imports nothing of a folder in Packages.
      if (isPackage && !here.some(e => e.name === 'package.json')) return
      if (here.length >= LISTING_MAX) cut.add(dir)
      dirs.set(dir, here)
      for (const e of here) {
        if (e.isDir && !isIgnoredByUnity(e.name) && !isOneAsset(e.name)) next.push({ dir: under(dir, e.name), entries: e.children ?? null })
      }
    }, stopped)
    level = next
  }
  for (const { dir } of level) unread.push(dir)
  return { dirs, cut, unread }
}

/**
 * What is wrong with a project's .meta files: without their asset, missing, named in another case,
 * sharing a GUID, or no valid .meta. What could not be read whole is never judged.
 */
export async function checkMetas(io, { stopped = () => false, progress = () => {} } = {}) {
  const { dirs, cut, unread } = await readTree(io, stopped)
  const orphans = []
  const missing = []
  const miscased = []
  const metas = []
  for (const [dir, entries] of dirs) {
    const names = new Set(entries.map(e => e.name))
    const anyCase = new Set(entries.map(e => e.name.toLowerCase()))
    for (const e of entries) {
      const path = under(dir, e.name)
      if (!e.isDir && isMeta(e.name)) {
        const asset = e.name.slice(0, -5)
        if (names.has(asset)) {
          metas.push(path)
        } else if (anyCase.has(asset.toLowerCase())) {
          // Its GUID is still the asset's: never to be taken for an orphan.
          metas.push(path)
          miscased.push(path)
        } else if (!cut.has(dir) && needsMeta(under(dir, asset))) {
          orphans.push(path)
        }
      } else if (!cut.has(dir) && needsMeta(path) && !anyCase.has(`${e.name}.meta`.toLowerCase())) {
        missing.push(path)
      }
    }
  }
  const byGuid = new Map()
  const broken = []
  let done = 0
  await eachAtOnce(metas, async (path) => {
    try {
      const guid = parseGuid(await io.read(path))
      if (!guid) broken.push(path)
      else if (byGuid.has(guid)) byGuid.get(guid).push(path)
      else byGuid.set(guid, [path])
    } catch {
      unread.push(path)
    }
    progress(++done, metas.length)
  }, stopped)
  return {
    checked: metas.length,
    orphans: orphans.sort(),
    missing: missing.sort(),
    miscased: miscased.sort(),
    tooBig: [...cut].sort(),
    duplicates: [...byGuid].filter(([, paths]) => paths.length > 1).map(([guid, paths]) => ({ guid, paths: paths.sort() })),
    broken: broken.sort(),
    unread: unread.sort(),
  }
}

const YAML = [
  'meta', 'unity', 'prefab', 'asset', 'mat', 'anim', 'controller', 'overridecontroller', 'mask', 'preset', 'playable', 'signal',
  'lighting', 'mixer', 'spriteatlas', 'spriteatlasv2', 'terrainlayer', 'physicmaterial', 'physicsmaterial', 'physicsmaterial2d',
  'rendertexture', 'cubemap', 'flare', 'guiskin', 'brush', 'fontsettings', 'shadervariants', 'scenetemplate',
]
/** Files that can name an asset by its GUID (C# does in literals). */
const REFERRING = new Set([
  ...YAML, 'cs', 'json', 'asmdef', 'asmref', 'inputactions', 'shadergraph', 'shadersubgraph', 'vfx', 'vfxoperator', 'vfxblock', 'uxml', 'uss', 'tss',
])

/** The files that name `asset`'s GUID, each with the first line that does. */
export async function findReferences(io, asset, { stopped = () => false, progress = () => {} } = {}) {
  let guid
  try {
    guid = parseGuid(await io.read(`${asset}.meta`))
  } catch {
    throw new Error(`Could not read ${nameOf(asset)}.meta. Unity makes it when it imports the asset.`)
  }
  if (!guid) throw new Error(`${nameOf(asset)}.meta has no GUID.`)
  const { dirs, cut, unread } = await readTree(io, stopped, ['ProjectSettings'])
  unread.push(...cut)
  const files = []
  for (const [dir, entries] of dirs) {
    for (const e of entries) {
      const path = under(dir, e.name)
      if (!e.isDir && REFERRING.has(extOf(e.name)) && path !== `${asset}.meta`) files.push(path)
    }
  }
  const found = []
  let done = 0
  await eachAtOnce(files, async (path) => {
    try {
      const text = await io.read(path)
      const at = text.toLowerCase().indexOf(guid)
      if (at >= 0) found.push({ path, line: text.slice(0, at).split('\n').length })
    } catch {
      // Binary or too large to read: it may refer to the asset, which cannot be told.
      unread.push(path)
    }
    progress(++done, files.length)
  }, stopped)
  return { asset, guid, found: found.sort((a, b) => a.path.localeCompare(b.path)), unread: unread.sort() }
}

/* ---------------------------------------------------------------- icons */

/*
 * Drawn here on lucide's 24 unit grid and stroke, so they sit with Mango's icons and show at once
 * (no look-up by name). They are not Unity's artwork or logo.
 */
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const dot = (x, y, r = 1.7) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`
const FOLDER = '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
const FOLDER_OPEN = '<path d="M3 18V6a2 2 0 0 1 2-2h4l2 3h7a2 2 0 0 1 2 2v1"/><path d="M3 18l2.5-8H22l-2.5 8a3 3 0 0 1-2.5 2H5a2 2 0 0 1-2-2z"/>'
/** An open folder's flap starts lower: a glyph that reaches up gets a smaller one there. */
const folder = (inner, inOpen = inner) => ({ shut: svg(FOLDER + inner), open: svg(FOLDER_OPEN + inOpen) })

export const ICONS = {
  project: svg('<path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z"/><path d="M3.5 7.25L12 12l8.5-4.75M12 12v9.5"/>'),
  scene: svg('<path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10L2.5 6 19 2.5 20 6.5zM8 5l2.5 3.5M13.5 3.8L16 7.3"/>'),
  prefab: svg('<path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z" fill="currentColor" fill-opacity=".3"/><path d="M3.5 7.25L12 12l8.5-4.75M12 12v9.5"/>'),
  model: svg('<path d="M12 3l9 16H3z"/><path d="M12 3v11M3 19l9-5 9 5"/>'),
  material: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18c3-5 3-13 0-18z" fill="currentColor"/>'),
  asset: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h4"/>'),
  script: svg('<path d="M9.5 4L7.5 20M16.5 4l-2 16M4 9h17M3 15h17"/>'),
  assembly: svg('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M11 7h6v6M7 11v6h6"/>'),
  library: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>'),
  shader: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h9v9H5a2 2 0 0 1-2-2zM12 3h7a2 2 0 0 1 2 2v7h-9z" fill="currentColor"/>'),
  graph: svg('<rect x="2.5" y="3" width="7" height="6" rx="1"/><rect x="2.5" y="15" width="7" height="6" rx="1"/><rect x="15" y="9" width="7" height="6" rx="1"/><path d="M9.5 6c4 0 2 6 5.5 6M9.5 18c4 0 2-6 5.5-6"/>'),
  effect: svg('<path d="M10 3l2.2 5.8L18 11l-5.8 2.2L10 19l-2.2-5.8L2 11l5.8-2.2zM19 16v5M16.5 18.5h5"/>'),
  animation: svg(`<path d="M3 19C10 19 14 5 21 5"/>${dot(4, 19, 2.6)}${dot(20, 5, 2.6)}`),
  controller: svg('<rect x="8" y="2.5" width="8" height="6" rx="1.5"/><rect x="2.5" y="15.5" width="8" height="6" rx="1.5"/><rect x="13.5" y="15.5" width="8" height="6" rx="1.5"/><path d="M10 8.5l-3.5 7M14 8.5l3.5 7"/>'),
  audio: svg('<path d="M3 10v4M7.5 6v12M12 3v18M16.5 7v10M21 10v4"/>'),
  mixer: svg('<path d="M5 3v18M12 3v18M19 3v18M2.5 15h5M9.5 8h5M16.5 13h5"/>'),
  video: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>'),
  texture: svg(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 18l6-6 4 4 3-3 5 5"/>${dot(16, 8, 2)}`),
  font: svg('<path d="M4 7V4h16v3M12 4v16M8.5 20h7"/>'),
  layout: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M10 9v12"/>'),
  style: svg('<path d="M12 3s7 7.5 7 12a7 7 0 0 1-14 0c0-4.5 7-12 7-12z"/><path d="M9 15a3 3 0 0 0 3 3"/>'),
  input: svg('<rect x="2.5" y="6" width="19" height="13" rx="5"/><path d="M6.5 12.5h5M9 10v5"/>' + dot(16.5, 12.5)),
  terrain: svg('<path d="M2.5 20l7-14 5 10 2.5-4 4.5 8z"/>'),
  light: svg('<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.7 1.7M17.3 17.3L19 19M5 19l1.7-1.7M17.3 6.7L19 5"/>'),
  physics: svg('<circle cx="12" cy="9" r="6"/><path d="M4 21h16M9 18h6"/>'),
  preset: svg('<path d="M3 7h10M19 7h2M3 17h2M11 17h10"/><circle cx="16" cy="7" r="3"/><circle cx="8" cy="17" r="3"/>'),
  package: svg('<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8M7.5 5.5l9 5v4"/>'),
  meta: svg(`<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/>${dot(8, 8, 1.9)}`),
  orphan: svg('<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><path d="M10 7v5"/>' + dot(10, 16, 1.4)),
}

export const FOLDERS = {
  assets: folder(
    '<path d="M12 10.5l3.5 3.5-3.5 3.5L8.5 14z" fill="currentColor"/>',
    '<path d="M12.5 12.5l2.5 2.5-2.5 2.5-2.5-2.5z" fill="currentColor" stroke="none"/>',
  ),
  packages: folder(
    '<rect x="9" y="11" width="6" height="6" fill="currentColor"/>',
    '<rect x="10" y="12.5" width="5" height="5" fill="currentColor" stroke="none"/>',
  ),
  settings: folder(dot(8, 14) + dot(12, 14) + dot(16, 14)),
  editor: folder('<path d="M10 11l-3 3 3 3M14 11l3 3-3 3"/>'),
  resources: folder(dot(12, 14, 3.4)),
  plugins: folder('<path d="M12 10.5v7M8.5 14h7"/>'),
  streaming: folder('<path d="M12 10.5v6M9 14l3 3 3-3"/>'),
}

const TYPES = [
  ['scene', 'orange', 'unity scenetemplate'],
  ['prefab', 'blue', 'prefab'],
  ['model', 'blue', 'fbx obj blend gltf glb dae 3ds max ma mb stl ply'],
  ['material', 'red', 'mat'],
  ['asset', 'yellow', 'asset'],
  ['script', 'green', 'cs'],
  ['assembly', 'green', 'asmdef asmref rsp'],
  ['library', 'neutral', 'dll so dylib a lib aar jar winmd pdb'],
  ['shader', 'purple', 'shader compute hlsl cginc glslinc raytrace shadervariants'],
  ['graph', 'purple', 'shadergraph shadersubgraph playable signal'],
  ['effect', 'orange', 'vfx vfxoperator vfxblock flare'],
  ['animation', 'red', 'anim'],
  ['controller', 'red', 'controller overridecontroller mask'],
  ['audio', 'yellow', 'wav mp3 ogg flac aif aiff'],
  ['mixer', 'yellow', 'mixer'],
  ['video', 'purple', 'mp4 mov webm avi m4v'],
  ['texture', 'purple', 'png jpg jpeg tga psd psb tif tiff exr hdr bmp rendertexture cubemap spriteatlas spriteatlasv2'],
  ['font', 'neutral', 'ttf otf fontsettings'],
  ['layout', 'orange', 'uxml'],
  ['style', 'blue', 'uss tss guiskin'],
  ['input', 'green', 'inputactions'],
  ['terrain', 'green', 'terrainlayer brush'],
  ['light', 'yellow', 'lighting'],
  ['physics', 'orange', 'physicmaterial physicsmaterial physicsmaterial2d'],
  ['preset', 'neutral', 'preset'],
  ['package', 'neutral', 'unitypackage'],
]
// Made once: Mango keeps one component per icon value, and rows compare them.
const BY_EXT = new Map(TYPES.flatMap(([key, tint, exts]) => exts.split(' ').map(ext => [ext, { icon: ICONS[key], tint }])))
const META = { icon: ICONS.meta, tint: 'neutral' }
const ORPHAN = { icon: ICONS.orphan, tint: 'red', note: 'No asset has this .meta file any more' }
const MISCASED = { icon: ICONS.orphan, tint: 'orange', note: 'Its asset\'s name differs in upper and lower case' }
const ROOT = { icon: ICONS.project, note: 'Unity project' }
const PACKAGE = { icon: ICONS.package }

/** An entry's icon; `inner` is its path in the Unity project, null means Mango's own icon. */
export function iconFor(inner, isDir, open, hasSibling) {
  if (isDir) {
    if (!inner) return ROOT
    const parts = inner.split('/')
    let key = null
    if (parts.length === 1) key = { Assets: 'assets', Packages: 'packages', ProjectSettings: 'settings' }[inner]
    else if (parts[0] === 'Packages' && parts.length === 2) return PACKAGE
    else if (parts[0] === 'Assets' || parts[0] === 'Packages') {
      const name = parts[parts.length - 1]
      if (inner === 'Assets/StreamingAssets') key = 'streaming'
      else if (name === 'Editor') key = 'editor'
      else if (name === 'Resources') key = 'resources'
      else if (name === 'Plugins') key = 'plugins'
    }
    return key ? { icon: open ? FOLDERS[key].open : FOLDERS[key].shut } : null
  }
  const name = nameOf(inner)
  if (isMeta(name)) {
    const asset = inner.slice(0, -5)
    if (!takesMeta(asset)) return null
    if (!hasSibling || !needsMeta(asset) || hasSibling(name.slice(0, -5))) return META
    return hasSibling(name.slice(0, -5), true) ? MISCASED : ORPHAN
  }
  return BY_EXT.get(extOf(name)) ?? null
}

/* ---------------------------------------------------------------- the plugin */

const SCENES_SHOWN = 8
const ROWS_SHOWN = 20
/** "Show all" stops here: more rows than anyone reads, and a slow window. */
const LIST_SHOWN = 500
/** Waits before looking again after a look that failed; the last one repeats. */
const RETRY_MS = [2000, 5000, 15000, 60000]
const errorText = e => (e instanceof Error ? e.message : String(e))
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

export function activate(mango) {
  const { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } = mango.vue

  const ioFor = (project, root) => ({
    list: (rel, children = true) => mango.files.list(absolute(project, under(root, rel).replace(/\/$/, '')), { children }),
    read: rel => mango.files.read(absolute(project, under(root, rel))),
  })
  const toastError = (title, e) => mango.ui.toast({ title, body: errorText(e), kind: 'error' })

  /* ---- which open folders hold Unity projects */

  const known = shallowRef(new Map()) // open folder -> [{ root, version }]
  const scans = new Map()
  let alive = true

  const projectsIn = path => (path && known.value.get(path)) || []
  const inView = () => projectsIn(mango.workspace.workdir())
  const placeOf = (project, rel) => placeIn(projectsIn(project), rel)

  const again = new Set()
  const retries = new Map() // open folder -> { tries, timer }

  function retry(path) {
    const last = retries.get(path)
    clearTimeout(last?.timer)
    const tries = last ? last.tries + 1 : 0
    const timer = setTimeout(() => {
      if (path === mango.workspace.workdir() || (!isRemote(path) && mango.workspace.openProjects().includes(path))) void scan(path)
      else retries.delete(path)
    }, RETRY_MS[Math.min(tries, RETRY_MS.length - 1)])
    retries.set(path, { tries, timer })
  }

  /** A local folder's first look is a deep one (and "Look again"); later ones keep what that found. */
  function scan(path, deep = false) {
    if (!path || !alive) return Promise.resolve()
    if (scans.has(path)) {
      // Asked again meanwhile: what is being read may be older than the question.
      again.add(path)
      return scans.get(path)
    }
    const before = known.value.get(path)
    const job = findProjects(ioFor(path, ''), before, { deep: deep || (!before && !isRemote(path)) }).then(({ projects, failed }) => {
      if (!alive) return
      if (failed) retry(path)
      else if (retries.has(path)) {
        clearTimeout(retries.get(path).timer)
        retries.delete(path)
      }
      // A failure is no answer: only what was found is kept.
      if (failed && !projects.length) return
      if (JSON.stringify(projects) === JSON.stringify(known.value.get(path))) return
      known.value = new Map(known.value).set(path, projects)
    }).catch(e => mango.log.error('Could not look for a Unity project:', e)).finally(() => {
      scans.delete(path)
      if (again.delete(path)) void scan(path)
    })
    scans.set(path, job)
    return job
  }
  mango.onDispose(() => {
    for (const { timer } of retries.values()) clearTimeout(timer)
  })

  // A remote project is looked at only while it is in view: each look is a round trip to its server.
  const stopWatching = watch(
    () => [mango.workspace.workdir(), ...mango.workspace.openProjects().filter(p => !isRemote(p))].filter(Boolean).join('\n'),
    (now, before) => {
      const had = new Set((before ?? '').split('\n'))
      const here = mango.workspace.workdir()
      for (const path of new Set(now.split('\n'))) if (path && (path === here || !had.has(path))) void scan(path)
    },
    { immediate: true },
  )
  mango.onDispose(stopWatching)

  // An agent or Unity Hub may have made, upgraded or removed a project.
  mango.chat.onTurnEnd((threadId) => {
    const chat = mango.chat.get(threadId)
    if (chat) void scan(chat.worktree || chat.projectPath)
  })
  mango.files.onChange((path) => {
    if (path === mango.workspace.workdir() || mango.workspace.openProjects().includes(path)) void scan(path)
  })
  const onFocus = () => {
    const here = mango.workspace.workdir()
    if (here && !isRemote(here)) void scan(here)
  }
  globalThis.addEventListener?.('focus', onFocus)
  mango.onDispose(() => globalThis.removeEventListener?.('focus', onFocus))

  /* ---- the Files view */

  mango.ui.files.companions.register({
    id: 'meta',
    suffix: '.meta',
    when({ projectPath, path }) {
      const at = placeOf(projectPath, path)
      if (at) return takesMeta(at.inner)
      // Not looked at yet (or it could not be read): no telling, for what would be an asset in a Unity project.
      const looking = !known.value.has(projectPath) && (scans.has(projectPath) || retries.has(projectPath))
      return looking && mayBeAsset(path) ? null : false
    },
  })

  const hasUnity = ({ projectPath }) => projectsIn(projectPath).length > 0
  // Only a .meta that goes along with its asset is hidden, so nothing hidden can be left behind.
  mango.ui.files.filters.register({
    id: 'meta',
    label: 'Unity .meta files',
    hint: 'Kept with their assets',
    when: hasUnity,
    hide({ projectPath, path, name, isDir, hasSibling }) {
      if (isDir || !isMeta(name)) return false
      const at = placeOf(projectPath, path)
      return !!at && takesMeta(at.inner.slice(0, -5)) && hasSibling(name.slice(0, -5))
    },
  })
  mango.ui.files.filters.register({
    id: 'generated',
    label: 'Unity generated files',
    hint: 'Library, Temp, obj, C# project files',
    when: hasUnity,
    hide({ projectPath, path, isDir }) {
      const at = placeOf(projectPath, path)
      return !!at && isGenerated(at.inner, isDir)
    },
  })

  mango.ui.files.icons.register({
    id: 'types',
    icon({ projectPath, path, isDir, open, hasSibling }) {
      const at = placeOf(projectPath, path)
      if (!at) return null
      const look = iconFor(at.inner, isDir, open, hasSibling)
      // A broken pair is a warning, not a file type: it shows with the icons off too.
      if (mango.settings.get('icons') === false && look !== ORPHAN && look !== MISCASED) return null
      return look
    },
  })

  for (const [id, language, extensions] of [
    ['yaml', 'yaml', YAML.map(ext => `.${ext}`)],
    ['hlsl', 'hlsl', ['.shader', '.compute', '.cginc', '.hlsl', '.glslinc', '.raytrace']],
    ['uxml', 'xml', ['.uxml']],
    ['uss', 'css', ['.uss', '.tss']],
    ['json', 'json', ['.asmdef', '.asmref', '.inputactions']],
  ]) mango.ui.files.languages.register({ id, language, extensions })

  /* ---- agents */

  mango.agents.appendSystemPrompt((run) => {
    if (!run || mango.settings.get('agentNote') === false) return ''
    // A worktree that was only just made is not looked at yet: it is the same project.
    return agentNote(known.value.get(run.workdir) ?? projectsIn(run.projectPath))
  })

  /* ---- long reads: the .meta check and the reference search, one of each per project */

  const jobs = shallowRef(new Map())
  const running = new Map()
  const keyOf = (project, root) => `${project}\n${root}`
  const jobOf = (kind, project, root) => jobs.value.get(`${kind}\n${keyOf(project, root)}`) ?? null

  function setJob(key, state) {
    if (alive) jobs.value = new Map(jobs.value).set(key, state)
  }
  async function runJob(kind, project, root, about, work) {
    const key = `${kind}\n${keyOf(project, root)}`
    const token = { stop: false }
    if (running.has(key)) running.get(key).stop = true
    running.set(key, token)
    const current = () => alive && running.get(key) === token
    setJob(key, { state: 'running', about, done: 0, total: 0 })
    let shownAt = 0
    const progress = (done, total) => {
      if (!current() || (Date.now() - shownAt < 120 && done !== total)) return
      shownAt = Date.now()
      setJob(key, { state: 'running', about, done, total })
    }
    try {
      const result = await work(ioFor(project, root), { stopped: () => token.stop || !alive, progress })
      if (current()) setJob(key, { state: 'done', about, result })
    } catch (e) {
      if (!current()) return
      setJob(key, e instanceof Stopped ? { state: 'stopped', about } : { state: 'failed', about, error: errorText(e) })
    } finally {
      if (running.get(key) === token) running.delete(key)
    }
  }
  function stopJob(kind, project, root) {
    const token = running.get(`${kind}\n${keyOf(project, root)}`)
    if (token) token.stop = true
  }
  mango.onDispose(() => {
    alive = false
    for (const token of running.values()) token.stop = true
  })

  /** Which Unity project the tool window shows, by open folder. */
  const picked = shallowRef(new Map())
  const pick = (project, root) => { picked.value = new Map(picked.value).set(project, root) }
  const pickedIn = (project) => {
    const list = projectsIn(project)
    return list.find(p => p.root === picked.value.get(project)) ?? list[0] ?? null
  }

  function startCheck(project, root) {
    pick(project, root)
    mango.ui.toolWindows.open('unity')
    void runJob('check', project, root, null, checkMetas)
  }
  /** Counts searches, so an open window brings the newest into view. */
  const searches = ref(0)
  function startSearch(project, root, asset) {
    pick(project, root)
    searches.value++
    mango.ui.toolWindows.open('unity')
    void runJob('search', project, root, asset, (io, opts) => findReferences(io, asset, opts))
  }

  /* ---- the Files view's menu */

  /** The asset a row stands for (its own, or a .meta's). */
  function assetAt({ path, projectPath }) {
    const rel = relativeTo(projectPath, path)
    if (rel === null) return null
    const at = placeOf(projectPath, rel)
    if (!at) return null
    const inner = isMeta(nameOf(at.inner)) ? at.inner.slice(0, -5) : at.inner
    if (!takesMeta(inner)) return null
    return { project: projectPath, root: at.project.root, inner, rel: under(at.project.root, inner), fromMeta: inner !== at.inner }
  }

  mango.ui.menus.register('file', {
    id: 'open-meta',
    label: 'Open .meta file',
    icon: ICONS.meta,
    when: (ctx) => {
      const a = assetAt(ctx)
      return !!a && !a.fromMeta
    },
    async run(ctx) {
      const a = assetAt(ctx)
      if (!a) return
      const meta = absolute(a.project, `${a.rel}.meta`)
      try {
        await mango.files.read(meta)
        mango.workspace.openFile(meta)
      } catch (e) {
        toastError(`Could not open ${nameOf(a.rel)}.meta`, e)
      }
    },
  })
  mango.ui.menus.register('file', {
    id: 'copy-guid',
    label: 'Copy GUID',
    icon: 'fingerprint',
    when: ctx => !!assetAt(ctx),
    async run(ctx) {
      const a = assetAt(ctx)
      if (!a) return
      try {
        const guid = parseGuid(await mango.files.read(absolute(a.project, `${a.rel}.meta`)))
        if (!guid) throw new Error('Its .meta file has no GUID.')
        await navigator.clipboard.writeText(guid)
        mango.ui.toast({ title: 'GUID copied', body: guid, kind: 'success' })
      } catch (e) {
        toastError('Could not copy the GUID', e)
      }
    },
  })
  mango.ui.menus.register('file', {
    id: 'find-references',
    label: 'Find references',
    icon: 'scan-search',
    when: ctx => !isRemote(ctx.projectPath) && !!assetAt(ctx),
    run(ctx) {
      const a = assetAt(ctx)
      if (a) startSearch(a.project, a.root, a.inner)
    },
  })

  /* ---- the tool window */

  async function readInfo(project, root) {
    const io = ioFor(project, root)
    const text = rel => io.read(rel).catch(() => null)
    const local = !isRemote(project)
    const [settings, graphics, quality, manifest, build, instance, temp] = await Promise.all([
      text('ProjectSettings/ProjectSettings.asset'),
      text('ProjectSettings/GraphicsSettings.asset'),
      text('ProjectSettings/QualitySettings.asset'),
      text('Packages/manifest.json'),
      text('ProjectSettings/EditorBuildSettings.asset'),
      local ? text('Library/EditorInstance.json') : null,
      local ? io.list('Temp').catch(() => []) : [],
    ])
    const packages = manifest === null ? null : parsePackages(manifest)
    return {
      ...parsePlayerSettings(settings ?? ''),
      packages,
      pipeline: renderPipeline(packages, graphics, quality),
      scenes: build === null ? null : parseBuildScenes(build),
      // Both are there only while an editor has the project open.
      editorOpen: instance !== null && temp.some(e => e.name === 'UnityLockfile'),
    }
  }

  const button = (label, onClick) => h('button', { type: 'button', class: 'mango-unity__button', onClick }, label)
  const note = (text, kind) => h('p', { class: ['mango-unity__note', kind && `is-${kind}`, kind === 'error' && 'selectable'], role: kind === 'error' ? 'alert' : undefined }, text)
  const section = (title, children, count) => h('section', { class: 'mango-unity__section' }, [
    h('h3', { class: 'mango-unity__title' }, [title, count === undefined ? null : h('span', { class: 'mango-unity__count' }, count)]),
    ...children,
  ])

  function openAt(project, root, inner, line) {
    try {
      mango.workspace.openFile(absolute(project, under(root, inner)), line ? { line } : undefined)
    } catch (e) {
      toastError('Could not open the file', e)
    }
  }
  function showInFiles(project, root, inner) {
    mango.ui.files.reveal(absolute(project, under(root, inner))).catch(e => toastError('Could not show it in Files', e))
  }

  /** A list of paths; the whole of one is in its tooltip. */
  function pathList(paths, open, key = '') {
    return shortList(key, paths, ROWS_SHOWN, (path, i) => h('li', { key: `${i}:${path}` }, [
      h('button', { type: 'button', class: 'mango-unity__row', title: path, onClick: () => open(path, i) }, [
        h('span', { class: 'mango-unity__name' }, nameOf(path)),
        h('span', { class: 'mango-unity__dir' }, parentOf(path)),
      ]),
    ]))
  }

  /** Lists the user opened up with "Show all". */
  const unfolded = shallowRef(new Set())

  /** The first few of a list, and a row for the rest. */
  function shortList(key, items, few, row) {
    const all = unfolded.value.has(key)
    const rows = items.slice(0, all ? LIST_SHOWN : few).map(row)
    if (!all && items.length > few) {
      rows.push(h('li', { key: 'all' }, [h('button', {
        type: 'button',
        class: 'mango-unity__row mango-unity__more',
        onClick: () => { unfolded.value = new Set(unfolded.value).add(key) },
      }, `Show all ${items.length.toLocaleString()}`)]))
    }
    return [
      h('ul', { class: 'mango-unity__list' }, rows),
      all && items.length > LIST_SHOWN ? note(`And ${plural(items.length - LIST_SHOWN, 'more file')}.`) : null,
    ]
  }

  function problem(title, hint, paths, open) {
    if (!paths.length) return null
    return h('div', { class: 'mango-unity__problem' }, [
      h('h4', { class: 'mango-unity__subtitle' }, [title, h('span', { class: 'mango-unity__count' }, paths.length)]),
      note(hint),
      ...pathList(paths, open, title),
    ])
  }

  /** Same GUID: the files that clash, together. */
  function clashes(groups, open) {
    if (!groups.length) return null
    return h('div', { class: 'mango-unity__problem' }, [
      h('h4', { class: 'mango-unity__subtitle' }, ['Same GUID', h('span', { class: 'mango-unity__count' }, groups.length)]),
      note('References cannot tell these assets apart. In each group keep one, and let Unity make new .meta files for the others.'),
      ...groups.slice(0, LIST_SHOWN).map(({ guid, paths }) => h('div', { key: guid, class: 'mango-unity__group' }, pathList(paths, open, guid))),
    ])
  }

  function runningLine(job, verb, stop) {
    // Not a live region: the count changes several times a second.
    return h('div', { class: 'mango-unity__line' }, [
      note(job.total ? `${verb} ${job.done.toLocaleString()} of ${plural(job.total, 'file')}…` : 'Reading folders…'),
      button('Stop', stop),
    ])
  }

  function checkSection(project, root) {
    if (isRemote(project)) return section('Meta files', [note('The check reads every .meta file, so it runs only for projects on this computer.')])
    const job = jobOf('check', project, root)
    let text = 'Finds .meta files without an asset, assets without one, broken ones, and GUIDs used twice.'
    let tone = null
    if (job?.state === 'running') text = 'Checking…'
    else if (job?.state === 'stopped') text = 'The check was stopped.'
    else if (job?.state === 'failed') {
      text = `The check failed: ${job.error}`
      tone = 'error'
    } else if (job?.state === 'done') {
      const { checked, orphans, missing, miscased, duplicates, broken, unread, tooBig } = job.result
      const count = [orphans, missing, miscased, duplicates, broken].reduce((n, list) => n + list.length, 0)
      const whole = !unread.length && !tooBig.length
      text = `${count ? plural(count, 'problem') : 'No problems'} in ${plural(checked, '.meta file')}${whole ? '' : ' that could be read'}.`
      tone = count ? 'error' : whole ? 'good' : null
    }
    // One live line through every state, so the result is said.
    const body = [
      h('p', { key: 'status', role: 'status', class: ['mango-unity__note selectable', tone && `is-${tone}`] }, text),
      job?.state === 'running'
        ? runningLine(job, 'Checked', () => stopJob('check', project, root))
        : h('div', { class: 'mango-unity__actions' }, [button(job ? 'Check again' : 'Check meta files', () => startCheck(project, root))]),
    ]
    if (job?.state === 'done') {
      const { orphans, missing, miscased, duplicates, broken, unread, tooBig } = job.result
      const show = path => showInFiles(project, root, path)
      const open = path => openAt(project, root, path)
      body.push(
        clashes(duplicates, open),
        problem('Not valid', 'A merge conflict, a second GUID or none at all. Resolve these before Unity replaces them.', broken, open),
        problem('Name differs in case', 'The GUID is still the asset\'s: rename the .meta to match, do not delete it. Systems that mind case lose the link.', miscased, open),
        problem('Meta without asset', 'The asset was moved or deleted without it, or it was an empty folder that version control did not keep.', orphans, open),
        problem('Asset without meta', 'Open the project in Unity to create them, then commit them with the assets.', missing, show),
        problem('Checked in part', `Folders with more entries than Mango lists (${LISTING_MAX.toLocaleString()}): missing pairs in them cannot be told.`, tooBig, show),
        problem('Not checked', 'These could not be read.', unread, show),
      )
    }
    return section('Meta files', body)
  }

  function searchSection(project, root) {
    const job = jobOf('search', project, root)
    if (!job) return null
    const body = [h('p', { class: 'mango-unity__subject selectable', title: job.about }, nameOf(job.about))]
    if (job.state === 'running') body.push(runningLine(job, 'Searched', () => stopJob('search', project, root)))
    else if (job.state === 'stopped') body.push(note('The search was stopped.'))
    else if (job.state === 'failed') body.push(note(job.error, 'error'))
    else {
      const { found, unread } = job.result
      if (found.length) body.push(...pathList(found.map(f => f.path), (path, i) => openAt(project, root, path, found[i].line), `search:${job.about}`))
      else body.push(note('No text asset, setting or script names its GUID. Loading by name or path does not count.'))
      if (unread.length) body.push(note(`${plural(unread.length, 'file or folder')} could not be searched whole (binary, too large or unreadable), so may reference it too.`))
    }
    return h('section', { class: 'mango-unity__section mango-unity__search' }, [
      h('div', { class: 'mango-unity__head' }, [
        h('h3', { class: 'mango-unity__title' }, ['References', job.state === 'done' ? h('span', { class: 'mango-unity__count' }, job.result.found.length) : null]),
        h('button', { type: 'button', class: 'mango-unity__ghost', 'aria-label': 'Clear references', onClick: () => clearJob('search', project, root) }, 'Clear'),
      ]),
      ...body,
    ])
  }

  function clearJob(kind, project, root) {
    const key = `${kind}\n${keyOf(project, root)}`
    const token = running.get(key)
    if (token) token.stop = true
    // No longer current: what it still finds is not written back.
    running.delete(key)
    const next = new Map(jobs.value)
    next.delete(key)
    jobs.value = next
  }

  const UnityView = defineComponent({
    name: 'UnityView',
    props: ['ctx'],
    setup(props) {
      const project = computed(() => props.ctx?.projectPath ?? null)
      const unity = computed(() => pickedIn(project.value))
      const info = shallowRef(null)
      const looking = ref(false)

      let asked = 0
      async function load() {
        const at = project.value
        const current = unity.value
        const turn = ++asked
        if (!at || !current) return
        const got = await readInfo(at, current.root)
        if (turn === asked) info.value = got
      }
      watch(() => `${project.value}\n${unity.value?.root}\n${unity.value?.version}`, () => {
        info.value = null
        void load()
      }, { immediate: true })
      const refocus = () => {
        if (project.value && !isRemote(project.value)) void load()
      }
      let following = null
      onMounted(() => {
        globalThis.addEventListener?.('focus', refocus)
        following = mango.files.onChange((path) => { if (path === project.value) void load() })
      })
      onBeforeUnmount(() => {
        globalThis.removeEventListener?.('focus', refocus)
        following?.dispose()
      })

      const view = ref(null)
      watch(searches, async () => {
        await nextTick()
        view.value?.querySelector('.mango-unity__search')?.scrollIntoView({ block: 'nearest' })
      })

      async function lookAgain() {
        looking.value = true
        await scan(project.value, true)
        looking.value = false
      }

      const toggle = (id, label) => h('label', { class: 'mango-unity__check' }, [
        h('input', {
          type: 'checkbox',
          checked: mango.ui.files.filters.isShown(id),
          onChange: e => mango.ui.files.filters.setShown(id, e.target.checked),
        }),
        label,
      ])

      return () => {
        const at = project.value
        const current = unity.value
        if (!at || !current) {
          return h('div', { class: 'mango-unity mango-unity--empty' }, [
            note('No Unity project here. Open a folder that has Assets and ProjectSettings, or the folder right above it.'),
            at ? h('button', { type: 'button', class: 'mango-unity__button', disabled: looking.value, onClick: lookAgain }, looking.value ? 'Looking…' : 'Look again') : null,
          ])
        }
        const { root, version } = current
        const all = projectsIn(at)
        const i = info.value
        const facts = [
          ['Editor', version ?? 'Unknown version'],
          i?.editorOpen ? ['Status', 'Open in Unity'] : null,
          i?.pipeline ? ['Render pipeline', i.pipeline] : null,
          i?.input ? ['Input', i.input] : null,
          i?.company ? ['Company', i.company] : null,
          i?.bundleVersion ? ['Game version', i.bundleVersion] : null,
        ].filter(Boolean)

        return h('div', { ref: view, class: 'mango-unity' }, [
          all.length > 1
            ? h('select', { class: 'mango-unity__pick', 'aria-label': 'Unity project', value: root, onChange: e => pick(at, e.target.value) },
                all.map(p => h('option', { key: p.root, value: p.root }, p.root || 'This folder')))
            : null,
          h('section', { class: 'mango-unity__section', 'aria-busy': !i }, [
            h('h3', { class: 'mango-unity__product' }, i?.product ?? (root || nameOf(slashes(trimEnd(at))))),
            h('dl', { class: 'mango-unity__facts selectable' }, facts.flatMap(([term, value]) => [h('dt', term), h('dd', { title: value }, value)])),
            i ? null : note('Reading project…'),
          ]),
          section('Show in Files', [h('div', { class: 'mango-unity__checks' }, [toggle('meta', '.meta files'), toggle('generated', 'Generated files')])]),
          searchSection(at, root),
          i && !i.scenes ? section('Build scenes', [note('Could not read ProjectSettings/EditorBuildSettings.asset.', 'error')]) : null,
          i?.scenes
            ? section('Build scenes', i.scenes.length
                ? shortList(`scenes:${keyOf(at, root)}`, i.scenes, SCENES_SHOWN, (scene, n) => h('li', { key: `${n}:${scene.path}` }, [
                    h('button', {
                      type: 'button',
                      class: ['mango-unity__row', !scene.enabled && 'is-off'],
                      title: scene.path,
                      onClick: () => showInFiles(at, root, scene.path),
                    }, [
                      h('span', { class: 'mango-unity__name' }, nameOf(scene.path).replace(/\.unity$/, '')),
                      h('span', { class: 'mango-unity__dir' }, scene.enabled ? parentOf(scene.path) : 'Switched off'),
                    ]),
                  ]))
                : [note('No scenes are in the build.')], i.scenes.length || undefined)
            : null,
          checkSection(at, root),
          i && !i.packages ? section('Packages', [note('Could not read Packages/manifest.json.', 'error')]) : null,
          i?.packages?.length
            ? section('Packages', [h('dl', { class: 'mango-unity__packages selectable' }, i.packages.flatMap(p => [
                h('dt', { title: p.id }, p.id),
                h('dd', { title: p.version }, p.version),
              ]))], i.packages.length)
            : null,
        ])
      }
    },
  })

  mango.ui.toolWindows.register({
    id: 'unity',
    title: 'Unity',
    icon: ICONS.project,
    when: () => inView().length > 0,
    view: { component: UnityView },
  })

  mango.ui.statusItems.register({
    id: 'project',
    location: 'project',
    icon: ICONS.project,
    when: () => inView().length > 0,
    text: () => {
      const list = inView()
      return list.length > 1 ? `${list.length} Unity projects` : shortName(list[0]?.version)
    },
    tooltip: () => {
      const list = inView()
      const what = list.length > 1 ? `${list.length} Unity projects` : `Unity project${list[0]?.version ? `, editor ${list[0].version}` : ''}`
      return `${what}. Click for details.`
    },
    onClick: () => mango.ui.toolWindows.open('unity'),
  })

  /* ---- commands */

  mango.commands.register({
    id: 'open',
    title: 'Unity: show project',
    icon: ICONS.project,
    when: () => inView().length > 0,
    run: () => mango.ui.toolWindows.open('unity'),
  })
  mango.commands.register({
    id: 'toggle-meta',
    title: 'Unity: show or hide .meta files',
    icon: ICONS.meta,
    keywords: 'files hidden',
    when: () => inView().length > 0,
    run: () => mango.ui.files.filters.setShown('meta', !mango.ui.files.filters.isShown('meta')),
  })
  mango.commands.register({
    id: 'check-meta',
    title: 'Unity: check .meta files',
    icon: ICONS.meta,
    keywords: 'guid orphan missing duplicate',
    when: () => {
      const here = mango.workspace.workdir()
      return !!here && !isRemote(here) && inView().length > 0
    },
    run() {
      const here = mango.workspace.workdir()
      const unity = pickedIn(here)
      if (unity) startCheck(here, unity.root)
    },
  })
}
