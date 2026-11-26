/**
 * The official plugins and their catalog (plugins/): the catalog parses and agrees with each plugin's
 * manifest, every manifest is valid, every entry module loads and activates against a stand-in API,
 * and the plugins' own helpers do what their READMEs say.
 *
 *   node --test tests/officialPlugins.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Vue from 'vue'

const ROOT = fileURLToPath(new URL('../plugins/', import.meta.url))
const REPO = 'https://github.com/ReaperMaga/mango'
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FIELD_TYPES = new Set(['boolean', 'string', 'text', 'number', 'select'])

type Field = { key: string; type: string; label: string; default?: unknown; options?: { value: string; label: string }[]; min?: number; max?: number }
type Manifest = { id: string; name: string; version: string; description?: string; author?: string; main?: string; styles?: string; minAppVersion?: string; settings?: Field[] }
type Entry = { id: string; name: string; description: string; author: string; version: string; tags: string[]; official: boolean; icon?: string; homepage?: string; minAppVersion?: string; source: { url: string; ref: string | null; subpath: string | null } }

const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8')) as { schema: number; plugins: Entry[] }
const manifestOf = (id: string) => JSON.parse(readFileSync(join(ROOT, id, 'mango-plugin.json'), 'utf8')) as Manifest
const folders = readdirSync(ROOT).filter(n => statSync(join(ROOT, n)).isDirectory())
const load = async (id: string) => import(pathToFileURL(join(ROOT, id, manifestOf(id).main ?? 'main.js')).href)

/* ---------------------------------------------------------------- catalog and manifests */

test('the catalog is schema 1 with unique, well-formed entries', () => {
  assert.equal(catalog.schema, 1)
  assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length > 0)
  const ids = catalog.plugins.map(p => p.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids')
  for (const e of catalog.plugins) {
    assert.match(e.id, ID, e.id)
    for (const k of ['name', 'description', 'author', 'version'] as const) assert.ok(typeof e[k] === 'string' && e[k].trim(), `${e.id}: ${k}`)
    assert.match(e.version, SEMVER, `${e.id}: version`)
    assert.ok(Array.isArray(e.tags) && e.tags.every(t => /^[a-z][a-z-]*$/.test(t)), `${e.id}: tags`)
    assert.equal(typeof e.official, 'boolean')
    assert.ok(typeof e.source?.url === 'string' && /^(https:\/\/|ssh:\/\/|git@)/.test(e.source.url), `${e.id}: source.url`)
    if (e.icon !== undefined) {
      assert.match(e.icon, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${e.id}: icon`)
      const lucide = fileURLToPath(new URL(`../node_modules/lucide-vue-next/dist/esm/icons/${e.icon}.js`, import.meta.url))
      if (existsSync(fileURLToPath(new URL('../node_modules/lucide-vue-next/', import.meta.url)))) assert.ok(existsSync(lucide), `${e.id}: no lucide icon "${e.icon}"`)
    }
  }
})

/**
 * Icon names Mango draws (PluginGlyph.vue keeps a set rather than all of lucide; anything else is a puzzle
 * piece). Null when the file cannot be read, and the check is skipped.
 */
function glyphNames(): Set<string> | null {
  try {
    const src = readFileSync(fileURLToPath(new URL('../app/components/plugins/PluginGlyph.vue', import.meta.url)), 'utf8')
    const block = /const NAMED[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1]
    if (!block) return null
    return new Set([...block.matchAll(/(?:'([a-z0-9-]+)'|\b([a-z0-9]+)):/g)].map(m => m[1] ?? m[2]!))
  } catch {
    return null
  }
}

test('the icons the official plugins name are ones Mango draws', () => {
  const names = glyphNames()
  if (!names) return
  const NOT_ICONS = new Set(['work', 'break'])
  const used = new Set<string>()
  for (const e of catalog.plugins) if (e.icon) used.add(e.icon)
  for (const id of folders) {
    const src = readFileSync(join(ROOT, id, manifestOf(id).main ?? 'main.js'), 'utf8')
    for (const m of src.matchAll(/\bicon:\s*(?:\(\)\s*=>[^,\n]*|'([a-z0-9-]+)')/g)) {
      if (m[1]) used.add(m[1])
      // An icon getter: its quoted names, minus the values it compares against.
      for (const q of m[0].matchAll(/'([a-z0-9-]+)'/g)) if (!NOT_ICONS.has(q[1]!)) used.add(q[1]!)
    }
  }
  for (const icon of used) assert.ok(names.has(icon), `icon "${icon}" is not in PluginGlyph.vue's set`)
})

test('every official entry matches the plugin folder beside the catalog', () => {
  for (const e of catalog.plugins.filter(p => p.official)) {
    assert.equal(e.source.url, REPO, `${e.id}: official plugins install from Mango's repository`)
    assert.equal(e.source.subpath, `plugins/${e.id}`, `${e.id}: subpath`)
    assert.equal(e.homepage, `${REPO}/tree/main/plugins/${e.id}`, `${e.id}: homepage`)
    assert.ok(existsSync(join(ROOT, e.id, 'mango-plugin.json')), `${e.id}: no manifest`)
    const m = manifestOf(e.id)
    assert.equal(m.id, e.id)
    assert.equal(m.name, e.name, `${e.id}: name`)
    assert.equal(m.version, e.version, `${e.id}: version`)
    assert.equal(m.minAppVersion, e.minAppVersion, `${e.id}: minAppVersion`)
    assert.equal(m.author, e.author, `${e.id}: author`)
  }
  // And no plugin folder is left out of the catalog.
  const listed = new Set(catalog.plugins.map(p => p.id))
  for (const f of folders) assert.ok(listed.has(f), `plugins/${f} is not in catalog.json`)
})

test('every manifest is valid: id, version, files, settings', () => {
  for (const id of folders) {
    const m = manifestOf(id)
    assert.equal(m.id, id, `${id}: the id is the folder name`)
    assert.match(m.id, ID)
    assert.ok(m.name?.trim(), `${id}: name`)
    assert.match(m.version, SEMVER, `${id}: version`)
    if (m.minAppVersion) assert.match(m.minAppVersion, SEMVER, `${id}: minAppVersion`)
    assert.ok(existsSync(join(ROOT, id, m.main ?? 'main.js')), `${id}: main file missing`)
    if (m.styles) assert.ok(existsSync(join(ROOT, id, m.styles)), `${id}: styles file missing`)
    assert.ok(existsSync(join(ROOT, id, 'README.md')), `${id}: README.md missing`)

    const keys = new Set<string>()
    for (const f of m.settings ?? []) {
      assert.ok(f.key && !keys.has(f.key), `${id}: setting key "${f.key}" missing or repeated`)
      keys.add(f.key)
      assert.ok(FIELD_TYPES.has(f.type), `${id}.${f.key}: unknown type ${f.type}`)
      assert.ok(f.label?.trim(), `${id}.${f.key}: label`)
      if (f.type === 'select') {
        assert.ok(Array.isArray(f.options) && f.options.length > 0, `${id}.${f.key}: select needs options`)
        if (f.default !== undefined) assert.ok(f.options!.some(o => o.value === f.default), `${id}.${f.key}: default is not an option`)
      }
      if (f.type === 'number' && f.default !== undefined) {
        assert.equal(typeof f.default, 'number', `${id}.${f.key}: default`)
        if (f.min !== undefined) assert.ok((f.default as number) >= f.min, `${id}.${f.key}: default under min`)
        if (f.max !== undefined) assert.ok((f.default as number) <= f.max, `${id}.${f.key}: default over max`)
      }
      if (f.type === 'boolean' && f.default !== undefined) assert.equal(typeof f.default, 'boolean')
      if ((f.type === 'string' || f.type === 'text') && f.default !== undefined) assert.equal(typeof f.default, 'string')
    }
  }
})

/* ---------------------------------------------------------------- entry modules */

test('no entry module imports anything (it loads from a blob URL)', () => {
  for (const id of folders) {
    const src = readFileSync(join(ROOT, id, manifestOf(id).main ?? 'main.js'), 'utf8')
    assert.doesNotMatch(src, /^\s*import\s[^(]/m, `${id}: static import`)
    assert.doesNotMatch(src, /\bimport\s*\(/, `${id}: dynamic import`)
    assert.doesNotMatch(src, /\brequire\s*\(/, `${id}: require`)
  }
})

/** A stand-in for the API object: records registrations and runs disposers like the runtime does. */
function fakeApi(id: string) {
  const registered: Record<string, unknown[]> = {}
  const disposers: Array<() => void> = []
  const settings: Record<string, unknown> = Object.fromEntries((manifestOf(id).settings ?? []).map(f => [f.key, f.default]))
  const store = new Map<string, unknown>()
  const reg = (kind: string) => (...args: unknown[]) => {
    ;(registered[kind] ??= []).push(args.length === 1 ? args[0] : args)
    return { dispose() {} }
  }
  const api = {
    plugin: { id, manifest: manifestOf(id), dir: join(ROOT, id), info: {} },
    version: '0.1.36',
    platform: 'browser',
    vue: Vue,
    commands: { register: reg('commands'), execute: async () => undefined, list: () => [] },
    shortcuts: { register: reg('shortcuts') },
    chat: {
      active: () => null, get: () => null, list: () => [], create: () => { throw new Error('not here') },
      send: async () => {}, stop() {}, show() {}, rename() {},
      onBeforeSend: reg('beforeSend'), onAgentEvent: reg('agentEvent'), onTurnEnd: reg('turnEnd'),
      onThreadCreated: reg('threadCreated'), onStatusChange: reg('statusChange'),
      slashCommands: { register: reg('slashCommands') },
      messageActions: { register: reg('messageActions') },
      codeBlocks: { register: reg('codeBlocks') },
    },
    ui: {
      files: {
        filters: { register: reg('fileFilters'), isShown: () => false, setShown() {} },
        companions: { register: reg('fileCompanions') },
        icons: { register: reg('fileIcons') },
        languages: { register: reg('fileLanguages') },
        reveal: async () => {},
      },
      toolWindows: { register: reg('toolWindows'), open() {}, close() {} },
      panelTabs: { register: reg('panelTabs'), open() {} },
      tabs: { register: reg('tabs'), open() {}, active: () => null, close() {} },
      navItems: { register: reg('navItems') },
      components: {},
      contextMenu: async () => {},
      holdOverlay: () => ({ dispose() {} }),
      statusItems: { register: reg('statusItems') },
      settingsPages: { register: reg('settingsPages') },
      menus: { register: reg('menus') },
      toast() {}, notify() {}, confirm: async () => false, prompt: async () => null, dialog: async () => {}, openSettings() {},
    },
    theme: { addStyles: reg('styles'), setTokens: reg('tokens'), registerScheme: reg('schemes'), current: () => 'dark', onChange: reg('themeChange') },
    workspace: {
      activeProject: () => '/home/me/project', openProjects: () => ['/home/me/project'], workdir: () => '/home/me/project',
      onProjectChange: reg('projectChange'), openFile() {}, openBrowser() {}, openTerminal() {},
    },
    files: { read: async () => '', write: async () => {}, list: async () => [], onChange: reg('filesChange') },
    git: { status: async () => null, refresh: async () => {} },
    agents: { registerMcpServer: reg('mcp'), appendSystemPrompt: reg('systemPrompt') },
    settings: { get: (k: string) => settings[k], set: (k: string, v: unknown) => { settings[k] = v }, all: () => ({ ...settings }), onChange: reg('settingsChange') },
    storage: { get: (k: string) => store.get(k), set: (k: string, v: unknown) => { store.set(k, v) }, delete: (k: string) => { store.delete(k) }, keys: () => [...store.keys()] },
    data: { list: async () => [], get: async () => null, write: async () => [], changes: async () => ({ seq: 0, docs: [] }), onChange: reg('dataChange') },
    events: { on: reg('events'), emit() {} },
    assets: { text: async () => '', url: async () => '' },
    log: { info() {}, warn() {}, error() {} },
    onDispose: (fn: () => void) => { disposers.push(fn) },
    onBeforeClose: reg('beforeClose'),
  }
  return { api, registered, dispose: () => disposers.forEach(fn => fn()) }
}

const expected: Record<string, string[]> = {
  'prompt-templates': ['slashCommands', 'settingsChange'],
  'secret-guard': ['beforeSend'],
  'focus-timer': ['statusItems', 'commands', 'settingsChange'],
  'scratchpad': ['toolWindows', 'commands'],
  'csv-preview': ['codeBlocks'],
  'turn-chime': ['turnEnd', 'commands'],
  'copy-as-markdown': ['messageActions', 'menus', 'commands'],
  'unity': ['fileFilters', 'fileCompanions', 'fileIcons', 'fileLanguages', 'toolWindows', 'statusItems', 'menus', 'commands', 'systemPrompt', 'turnEnd'],
  'planner': ['tabs', 'navItems', 'shortcuts', 'commands', 'menus', 'dataChange', 'projectChange'],
}

test('every entry module exports activate, which registers what the plugin is for', async () => {
  for (const id of folders) {
    const mod = await load(id)
    const activate = mod.activate ?? mod.default?.activate
    assert.equal(typeof activate, 'function', `${id}: no activate export`)
    const { api, registered, dispose } = fakeApi(id)
    await activate(api)
    for (const kind of expected[id] ?? []) assert.ok(registered[kind]?.length, `${id}: registered no ${kind}`)
    dispose()
  }
})

/* ---------------------------------------------------------------- the plugins' helpers */

test('prompt-templates: parses lines, fills placeholders', async () => {
  const { parseTemplates, fill } = await load('prompt-templates')
  const { templates, problems } = parseTemplates('# comment\n\nexplain: Explain {{args|this}}.\n/Fix: Fix it\nbad line\nexplain: again')
  assert.deepEqual(templates.map((t: { name: string }) => t.name), ['explain', 'fix'])
  assert.equal(problems.length, 2)
  assert.equal(fill('Explain {{args|this}}.', '', null), 'Explain this.')
  assert.equal(fill('Explain {{args|this}}.', 'the parser', null), 'Explain the parser.')
  assert.equal(fill('Review it. {{args}}', '', null), 'Review it.')
  assert.equal(fill('Fix it', 'in utils', null), 'Fix it\n\nin utils')
  assert.equal(fill('In {{project}}', '', 'C:\\code\\mango'), 'In mango')
  // Every default template parses.
  const defaults = manifestOf('prompt-templates').settings!.find(f => f.key === 'templates')!.default
  const parsed = parseTemplates(defaults)
  assert.equal(parsed.problems.length, 0)
  assert.deepEqual(parsed.templates.map((t: { name: string }) => t.name), ['explain', 'tests', 'review-diff', 'docs'])
})

test('secret-guard: finds common secrets, masks only them, leaves placeholders alone', async () => {
  const { findSecrets, mask, summarize } = await load('secret-guard')
  const kinds = (t: string, generic = true) => findSecrets(t, { generic }).map((s: { kind: string }) => s.kind)
  assert.deepEqual(kinds('key AKIAABCDEFGHIJKLMNOP here'), ['AWS access key'])
  assert.deepEqual(kinds(`token ghp_${'a'.repeat(36)}`), ['GitHub token'])
  assert.deepEqual(kinds(`github_pat_${'A1_'.repeat(25)}`), ['GitHub token'])
  assert.deepEqual(kinds('xoxb-1234567890-abcdef'), ['Slack token'])
  assert.deepEqual(kinds(`sk-ant-${'x1'.repeat(20)}`), ['API key'])
  assert.deepEqual(kinds('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), ['JWT'])
  assert.deepEqual(kinds('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'), ['private key'])
  assert.deepEqual(kinds('password = hunter22'), ['password'])
  assert.deepEqual(kinds('password = hunter22', false), [])
  assert.deepEqual(kinds('password=<your-password> token=${TOKEN} api_key: xxxxxxxx'), [])
  assert.deepEqual(kinds('Explain how tokens work in the lexer'), [])

  const text = 'DB password: "s3cretValue" and ghp_' + 'b'.repeat(36)
  const found = findSecrets(text)
  const masked = mask(text, found)
  assert.equal(masked, 'DB password: "[redacted password]" and [redacted GitHub token]')
  assert.doesNotMatch(masked, /s3cret|bbbb/)
  assert.equal(summarize(found), 'a password and a GitHub token')
  assert.equal(summarize([{ kind: 'API key' }, { kind: 'API key' }, { kind: 'AWS access key' }]), '2 API keys and an AWS access key')
})

test('csv-preview: parses quoted fields and spots number columns', async () => {
  const { parseDelimited, numericColumns } = await load('csv-preview')
  assert.deepEqual(parseDelimited('a,b\n1,"x, ""y"""\r\n2,"two\nlines"\n', ','), [['a', 'b'], ['1', 'x, "y"'], ['2', 'two\nlines']])
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(numericColumns([['1', 'x', '1,200.5'], ['-3', '4', '7%']], 3), [true, false, true])
})

test('copy-as-markdown: builds a transcript with safe fences', async () => {
  const { threadMarkdown, fence } = await load('copy-as-markdown')
  assert.equal(fence('a ``` b'), '````\na ``` b\n````')
  const md = threadMarkdown({
    title: 'Fix the parser', agent: 'claude', model: 'default', createdAt: 0,
    messages: [
      { id: '1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'Why does it fail?' }], attachments: [{ name: 'log.txt' }] },
      { id: '2', role: 'agent', createdAt: 0, parts: [
        { type: 'thinking', text: 'hmm', seconds: 1 },
        { type: 'tool', tool: 'read', target: 'src/parse.ts', status: 'ok' },
        { type: 'tool', tool: 'bash', target: 'pnpm test', status: 'error', output: 'boom' },
        { type: 'text', text: 'It reads past the end.' },
      ] },
    ],
  }, { tools: 'list', thinking: false })
  assert.match(md, /^# Fix the parser\n/)
  assert.match(md, /## You\n\n- Attached `log\.txt`\n\nWhy does it fail\?/)
  assert.match(md, /## Claude Code\n\n- Read `src\/parse\.ts`\n- Ran `pnpm test` \(failed\)\n\nIt reads past the end\./)
  assert.doesNotMatch(md, /hmm|boom/)
})

test('focus-timer: formats the clock', async () => {
  const { formatClock } = await load('focus-timer')
  assert.equal(formatClock(25 * 60_000), '25:00')
  assert.equal(formatClock(61_001), '01:02')
  assert.equal(formatClock(-5), '00:00')
})
