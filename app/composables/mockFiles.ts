import type { ChatImage, EnvFile, FileBytes, FileContent, FsAhead, FsEntry, FsListing, WriteResult } from '~/types/ipc'

/**
 * In-memory project files for the browser preview (no Tauri). Implements the
 * `fs_*` commands from types/ipc.ts, plus `env_files` and `env_gitignore_add`.
 * Every project gets its own copy of one small tree, so edits stick while the
 * page is open and saving really works. What is ignored follows the project's
 * root `.gitignore` (simple names and folders only), as if it were a git repository.
 */

interface MockFile { text: string | null; modifiedMs: number; size?: number }

const MIN = 60_000
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const SEED: Record<string, string | null> = {
  'README.md': '# Mango\n\nA desktop workbench for coding agents: pick a project, run several\nClaude Code and Codex chats side by side, review and commit changes.\n\n## Develop\n\n```bash\npnpm install\npnpm dev\n```\n',
  'package.json': '{\n  "name": "mango",\n  "private": true,\n  "type": "module",\n  "version": "0.1.1",\n  "scripts": {\n    "dev": "nuxt dev",\n    "build": "nuxt generate",\n    "app": "tauri dev"\n  }\n}\n',
  'nuxt.config.ts': "export default defineNuxtConfig({\n  ssr: false,\n  modules: ['@pinia/nuxt'],\n  devServer: { host: '127.0.0.1', port: 1420 },\n})\n",
  'tsconfig.json': '{\n  "extends": "./.nuxt/tsconfig.json"\n}\n',
  '.gitignore': 'node_modules\n.nuxt\n.output\nsrc-tauri/target\n/.env\n',
  '.env': '# Local settings for the dev server: never commit this file\nDATABASE_URL=postgres://mango:secret@localhost:5432/mango\nAPI_KEY=sk-test-4f9a2c71e0b3\nGREETING="Hello, Mango # not a comment"\nDEBUG=true\n',
  '.env.local': '# Overrides for this machine\nDEBUG=false\nPORT=1420\n',
  '.env.example': '# Copy to .env and fill in\nDATABASE_URL=\nAPI_KEY=\nGREETING="Hello"\nDEBUG=false\n',
  'app/app.vue': '<script setup lang="ts">\nimport { useWorkspace } from \'~/stores/workspace\'\n\nconst ws = useWorkspace()\nonMounted(() => ws.init())\n</script>\n\n<template>\n  <div class="app">\n    <AppTitlebar />\n    <AppWorkspace v-if="ws.hasProject" />\n  </div>\n</template>\n',
  'app/stores/workspace.ts': "import { defineStore } from 'pinia'\n\nexport const useWorkspace = defineStore('workspace', {\n  state: () => ({\n    openProjects: [] as string[],\n    activeProjectPath: null as string | null,\n    sidebarOpen: true,\n  }),\n  actions: {\n    toggleSidebar() {\n      this.sidebarOpen = !this.sidebarOpen\n    },\n  },\n})\n",
  'app/stores/git.ts': "import { defineStore } from 'pinia'\n\n/** All git state goes through here; it refreshes after every action. */\nexport const useGit = defineStore('git', {\n  state: () => ({ repos: {} as Record<string, unknown> }),\n})\n",
  'app/utils/time.ts': "/** Relative time for lists. */\nexport function relativeTime(ts: number, now = Date.now()): string {\n  const s = Math.max(0, Math.round((now - ts) / 1000))\n  if (s < 45) return 'now'\n  const m = Math.round(s / 60)\n  if (m < 60) return `${m}m`\n  const h = Math.round(m / 60)\n  if (h < 24) return `${h}h`\n  return `${Math.round(h / 24)}d`\n}\n",
  'app/utils/paths.ts': "/** Last segment of a path, either separator. */\nexport const baseName = (p: string) => p.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || p\n",
  'app/assets/css/tokens.css': ':root {\n  --font-ui: \'Inter Variable\', ui-sans-serif, system-ui, sans-serif;\n  --font-mono: \'JetBrains Mono Variable\', ui-monospace, monospace;\n  --radius-sm: 6px;\n}\n',
  'app/components/AppWorkspace.vue': '<template>\n  <div class="workspace">\n    <AppSidebar />\n    <ChatArea />\n  </div>\n</template>\n\n<style scoped>\n.workspace { display: flex; flex: 1; min-height: 0; }\n</style>\n',
  'public/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <rect width="64" height="64" rx="14" fill="#f5a524"/>\n  <path d="M18 46V20l14 16 14-16v26" fill="none" stroke="#1d1a14" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>\n  <circle cx="48" cy="16" r="5" fill="#7fb24a"/>\n</svg>\n',
  'public/changes-panel.png': null,
  'scripts/try-agent.ts': "// Drive an agent adapter against the real CLI, outside the app.\nconst [agent, cwd, prompt] = process.argv.slice(2)\nconsole.log({ agent, cwd, prompt })\n",
  'src-tauri/Cargo.toml': '[package]\nname = "mango"\nversion = "0.1.1"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2", features = [] }\nserde = { version = "1", features = ["derive"] }\n',
  'src-tauri/src/main.rs': 'fn main() {\n    mango_lib::run()\n}\n',
  'src-tauri/src/lib.rs': 'mod files;\nmod git;\n\n#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {\n    tauri::Builder::default()\n        .run(tauri::generate_context!())\n        .expect("error while running Mango");\n}\n',
  'src-tauri/target/.rustc_info.json': '{}\n',
  'node_modules/.modules.yaml': 'layoutVersion: 5\n',
  '.nuxt/nuxt.d.ts': '/// <reference types="nuxt" />\n',
}

const projects = new Map<string, Map<string, MockFile>>()

function filesOf(root: string) {
  let files = projects.get(root)
  if (!files) {
    files = new Map()
    let i = 0
    for (const [path, text] of Object.entries(SEED)) {
      files.set(path, { text, modifiedMs: Date.now() - (++i * 7 + 3) * MIN, size: text === null ? 184_320 : undefined })
    }
    projects.set(root, files)
  }
  return files
}

function clean(rel: string) {
  if (rel.startsWith('/') || rel.split('/').some(s => s === '..')) throw new Error(`"${rel}" is not a path inside the project`)
  return rel
}

/** The root `.gitignore`'s patterns, read the simple way: a name or folder, `/` anchors ignored, `\\` escapes undone. */
function ignorePatterns(root: string) {
  const text = filesOf(root).get('.gitignore')?.text ?? ''
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(l => l.replace(/^\//, '').replace(/\/$/, '').replace(/\\(.)/g, '$1'))
}

const isIgnored = (root: string, path: string) =>
  ignorePatterns(root).some(i => path === i || path.startsWith(`${i}/`))

function listDir(root: string, dir: string): FsListing {
  dir = clean(dir).replace(/\/+$/, '')
  const files = filesOf(root)
  const prefix = dir ? `${dir}/` : ''
  const seen = new Map<string, FsEntry>()
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const name = rest.split('/')[0]!
    const full = prefix + name
    if (!seen.has(name)) seen.set(name, { name, path: full, isDir: rest.includes('/'), ignored: isIgnored(root, full) })
  }
  if (dir && !seen.size) throw new Error(`${dir} no longer exists`)
  const entries = [...seen.values()].sort((a, b) =>
    a.isDir === b.isDir ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.isDir ? -1 : 1)
  return { entries, truncated: false }
}

/** `fs_list_dir` with `ahead`: whole listings of the first subfolders not ignored, within the backend's caps. */
function listAhead(root: string, listing: FsListing): FsListing {
  const ahead: FsAhead[] = []
  let left = 2000
  for (const e of listing.entries) {
    if (ahead.length === 24) break
    if (!e.isDir || e.ignored || e.name === 'node_modules') continue
    const sub = listDir(root, e.path).entries
    if (sub.length > left) continue
    left -= sub.length
    ahead.push({ dir: e.path, entries: sub })
  }
  return { ...listing, ahead }
}

function readFile(root: string, file: string, limit?: number): FileContent {
  const f = filesOf(root).get(clean(file))
  if (!f) throw new Error(`${file} no longer exists`)
  const size = f.size ?? new TextEncoder().encode(f.text ?? '').length
  if (limit !== undefined && size > limit) return { text: null, binary: false, tooLarge: true, size, bom: false, modifiedMs: f.modifiedMs }
  return { text: f.text, binary: f.text === null, tooLarge: false, size, bom: false, modifiedMs: f.modifiedMs }
}

/** A picture for a binary image in the seed tree, drawn once per file. */
const pictures = new Map<string, string>()
function picture(file: string): string {
  let data = pictures.get(file)
  if (!data) {
    const c = document.createElement('canvas')
    c.width = 640
    c.height = 400
    const g = c.getContext('2d')!
    const sky = g.createLinearGradient(0, 0, 0, 400)
    sky.addColorStop(0, '#2b3a2f')
    sky.addColorStop(1, '#f5a524')
    g.fillStyle = sky
    g.fillRect(0, 0, 640, 400)
    g.fillStyle = '#f7c948'
    g.beginPath(); g.arc(470, 150, 64, 0, Math.PI * 2); g.fill()
    g.fillStyle = '#1d2a21'
    g.beginPath(); g.moveTo(0, 400); g.lineTo(180, 230); g.lineTo(330, 330); g.lineTo(460, 250); g.lineTo(640, 400); g.fill()
    data = c.toDataURL('image/png').split(',')[1]!
    pictures.set(file, data)
  }
  return data
}

function readBytes(root: string, file: string): FileBytes {
  const f = filesOf(root).get(clean(file))
  if (!f) throw new Error(`${file} no longer exists`)
  if (f.text !== null) {
    const bytes = new TextEncoder().encode(f.text)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return { data: btoa(bin), size: bytes.length, modifiedMs: f.modifiedMs }
  }
  const data = picture(file)
  return { data, size: Math.floor(data.length * 3 / 4), modifiedMs: f.modifiedMs }
}

function writeFile(root: string, file: string, text: string, expected: number | null): WriteResult {
  const f = filesOf(root).get(clean(file))
  if (!f) throw new Error(`Could not save ${file}: it no longer exists`)
  if (expected !== null && f.modifiedMs !== expected) return { saved: false, modifiedMs: f.modifiedMs }
  f.text = text
  f.modifiedMs = Date.now()
  return { saved: true, modifiedMs: f.modifiedMs }
}

const isFolder = (files: Map<string, MockFile>, rel: string) => [...files.keys()].some(p => p.startsWith(`${rel}/`))

/** The file part of a project-relative path, refused when it is not a file name. */
function fileRel(file: string) {
  const rel = clean(file)
  const name = rel.split('/').pop() ?? ''
  if (!rel || rel.endsWith('/') || name === '.' || name === '..' || rel.split('/').some(s => !s)) {
    throw new Error(`"${file}" is not a path inside the project`)
  }
  return rel
}

function createFile(root: string, file: string, text: string): WriteResult {
  const rel = fileRel(file)
  const files = filesOf(root)
  if (files.has(rel) || isFolder(files, rel)) throw new Error(`${rel} already exists`)
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (dir && files.has(dir)) throw new Error(`${dir} is not a folder`)
  if (dir && !isFolder(files, dir)) throw new Error(`${dir} no longer exists`)
  const modifiedMs = Date.now()
  files.set(rel, { text, modifiedMs })
  return { saved: true, modifiedMs }
}

function deleteFile(root: string, file: string) {
  const rel = fileRel(file)
  const files = filesOf(root)
  if (!files.has(rel)) {
    throw new Error(isFolder(files, rel) ? `${rel} is a folder; only files can be deleted here` : `${rel} no longer exists`)
  }
  files.delete(rel)
}

function plainName(name: string) {
  if (!name || name === '.' || name === '..' || /[\\/\0\r\n]/.test(name)) throw new Error(`"${name}" is not a file name`)
  return name
}

const TEMPLATES = ['.env.example', '.env.sample', '.env.template', 'example.env', 'sample.env', 'template.env']
/** `.env`, `.env.*` or `*.env`, but not the example/template files projects commit for others to copy. */
const isEnvName = (name: string) =>
  (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) && !TEMPLATES.includes(name.toLowerCase())

function envFiles(root: string, extra: string[]): EnvFile[] {
  extra.forEach(plainName)
  const out: EnvFile[] = []
  for (const [path, f] of filesOf(root)) {
    if (path.includes('/') || !(isEnvName(path) || extra.includes(path))) continue
    const size = f.size ?? new TextEncoder().encode(f.text ?? '').length
    out.push({ name: path, size, modifiedMs: f.modifiedMs, ignored: isIgnored(root, path) })
  }
  const lower = (s: string) => s.toLowerCase()
  return out.sort((a, b) =>
    Number(a.name !== '.env') - Number(b.name !== '.env')
    || (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function gitignoreAdd(root: string, name: string) {
  const line = `/${plainName(name).replace(/[*?[]/g, c => `\\${c}`).replace(/ +$/, m => '\\ '.repeat(m.length))}`
  const files = filesOf(root)
  const f = files.get('.gitignore')
  if (!f) {
    files.set('.gitignore', { text: `${line}\n`, modifiedMs: Date.now() })
    return
  }
  const text = f.text ?? ''
  if (text.split('\n').some(l => l.replace(/\r$/, '') === line)) return
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  f.text = `${text}${text && !text.endsWith('\n') ? eol : ''}${line}${eol}`
  f.modifiedMs = Date.now()
}

export async function mockFiles(cmd: string, args: any): Promise<any> {
  // A remote project answers over SSH: slow enough here to see what a round trip costs.
  await wait(String(args.root ?? '').startsWith('env://') ? 350 : 40)
  switch (cmd) {
    case 'fs_list_dir': {
      const listing = listDir(args.root, args.dir)
      return args.ahead ? listAhead(args.root, listing) : listing
    }
    case 'fs_read_file': return readFile(args.root, args.file, args.limit)
    case 'fs_read_bytes': return readBytes(args.root, args.file)
    case 'fs_write_file': return writeFile(args.root, args.file, args.text, args.expectedModifiedMs)
    case 'fs_create_file': return createFile(args.root, args.file, args.text)
    case 'fs_delete_file': return deleteFile(args.root, args.file)
    case 'env_files': return envFiles(args.root, args.extra ?? [])
    case 'env_gitignore_add': return gitignoreAdd(args.root, args.name)
  }
  throw new Error(`mock: unknown command ${cmd}`)
}

/** `chat_image` in the browser preview: only the demo project's pictures, by relative or absolute path. */
export async function mockChatImage(path: string, base: string | null): Promise<ChatImage> {
  await wait(40)
  const root = base ?? ''
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  const f = root && !rel.startsWith('/') ? filesOf(root).get(clean(rel)) : undefined
  if (!f || f.text !== null) throw new Error(`The browser preview can only show pictures from the demo project, not ${path}`)
  const b = readBytes(root, rel)
  return { data: b.data, mime: 'image/png', size: b.size, modifiedMs: b.modifiedMs }
}

/** Browser preview only: change a file "on disk", the way an agent would, to try the editor's conflict handling. */
export function mockTouchFile(root: string, file: string, text: string) {
  const f = filesOf(root).get(file)
  if (f) { f.text = text; f.modifiedMs = Date.now() }
}

/**
 * Committed versions for the browser preview (`git_base`), so the editor's change markers show:
 * the files the mock repository lists as modified differ from the seed here; the rest match it.
 */
const BASE: Record<string, string> = {
  'app/stores/workspace.ts': "import { defineStore } from 'pinia'\n\n// Projects and layout.\nexport const useWorkspace = defineStore('workspace', {\n  state: () => ({\n    openProjects: [] as string[],\n    activeProject: null as string | null,\n  }),\n  actions: {\n    toggleSidebar() {\n      this.sidebarOpen = !this.sidebarOpen\n    },\n  },\n})\n",
  'README.md': '# Mango\n\nA desktop workbench for coding agents.\n\n## Develop\n\n```bash\npnpm install\npnpm dev\n```\n',
}

export async function mockBaseFile(file: string): Promise<string | null> {
  await wait(60)
  const seed = SEED[file]
  return BASE[file] ?? (typeof seed === 'string' ? seed : null)
}
