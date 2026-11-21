/**
 * The plugin runtime's plain parts: undoing what a plugin registered, `minAppVersion`, the ids it puts
 * into Mango's state, the CSS made from its tokens, and the `onBeforeSend` chain. Plain Node:
 *
 *   node --test tests/pluginHost.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DisposableScope, once } from '../app/plugin-host/scope.ts'
import { compareVersions, incompatibility, parseVersion } from '../app/plugin-host/semver.ts'
import {
  effectiveScheme, fullId, isPanelEditorTab, isPanelTabRef, isPluginRef, isPluginTab, normalizePanelOrder, normalizePanelPlaces,
  panelEditorTabId, panelStrip, parsePanelEditorTab, parsePluginTab, pluginRef, pluginTabId, schemeCss, tokenDeclarations,
} from '../app/plugin-host/ids.ts'
import { capped, emitAll, logText, parseSlash, runBeforeSend } from '../app/plugin-host/hooks.ts'

/* ---------- disposal */

test('a scope undoes everything, newest first, once', () => {
  const order: string[] = []
  const scope = new DisposableScope()
  scope.add(() => order.push('a'))
  scope.add(() => order.push('b'))
  scope.add(() => order.push('c'))
  assert.equal(scope.size, 3)
  scope.dispose()
  scope.dispose()
  assert.deepEqual(order, ['c', 'b', 'a'])
  assert.equal(scope.disposed, true)
})

test('disposing one registration runs it now and only once', () => {
  let n = 0
  const scope = new DisposableScope()
  const d = scope.add(() => n++)
  d.dispose()
  d.dispose()
  scope.dispose()
  assert.equal(n, 1)
  assert.equal(scope.size, 0)
})

test('an undo that throws is reported and the rest still run', () => {
  const errors: unknown[] = []
  const ran: string[] = []
  const scope = new DisposableScope(e => errors.push(e))
  scope.add(() => ran.push('first'))
  scope.add(() => { throw new Error('boom') })
  scope.add(() => ran.push('last'))
  scope.dispose()
  assert.deepEqual(ran, ['last', 'first'])
  assert.equal(errors.length, 1)
})

test('something registered after the scope is gone is undone at once', () => {
  let n = 0
  const scope = new DisposableScope()
  scope.dispose()
  scope.add(() => n++)
  assert.equal(n, 1)
})

test('once() runs its function a single time', () => {
  let n = 0
  const d = once(() => n++)
  d.dispose()
  d.dispose()
  assert.equal(n, 1)
})

/* ---------- versions */

test('versions parse and compare', () => {
  assert.deepEqual(parseVersion('v1.2'), { major: 1, minor: 2, patch: 0, pre: [] })
  assert.equal(parseVersion('one'), null)
  assert.equal(compareVersions('0.1.36', '0.1.36'), 0)
  assert.equal(compareVersions('0.1.36', '0.2.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1)
  assert.equal(compareVersions('x', '1.0.0'), null)
})

test('minAppVersion: older apps refuse, newer and equal accept', () => {
  assert.equal(incompatibility('0.1.36', undefined), null)
  assert.equal(incompatibility('0.1.36', '0.1.36'), null)
  assert.equal(incompatibility('0.1.36', '0.1.0'), null)
  assert.match(incompatibility('0.1.36', '0.2.0') ?? '', /Needs Mango 0\.2\.0 or newer/)
  assert.match(incompatibility('0.1.36', 'latest') ?? '', /not a version number/)
  // A dev build of the version a plugin names counts as that version.
  assert.equal(incompatibility('0.2.0-dev', '0.2.0'), null)
})

/* ---------- ids */

test('tool windows and schemes are plugin refs, kept whole', () => {
  const ref = pluginRef('acme.tools', 'todo')
  assert.equal(ref, 'plugin:acme.tools.todo')
  assert.ok(isPluginRef(ref))
  assert.ok(!isPluginRef('files'))
  assert.ok(!isPluginRef('plugin:'))
  assert.ok(!isPluginRef('plugin:Bad Id'))
  assert.ok(!isPluginRef(42))
})

test('panel tabs are `<pluginId>.<id>`; a saved one must be well formed', () => {
  const ref = fullId('acme.tools', 'output')
  assert.equal(ref, 'acme.tools.output')
  assert.ok(isPanelTabRef(ref))
  assert.ok(isPanelTabRef('git-log.log'))
  assert.ok(!isPanelTabRef('plugin:acme.output'))
  assert.ok(!isPanelTabRef('noid'))
  assert.ok(!isPanelTabRef('Acme.output'))
  assert.ok(!isPanelTabRef(`a.${'x'.repeat(300)}`))
  assert.ok(!isPanelTabRef(null))
})

test('the panel strip keeps the hand-made order; new panel tabs go first, new terminals last', () => {
  // Nothing moved yet: the panel tabs, then the terminals in their own order.
  assert.deepEqual(panelStrip([], ['term-1', 'term-2'], ['x.log']), ['x.log', 'term-1', 'term-2'])
  // A tab dragged between two terminals stays there; a terminal opened since joins the end.
  assert.deepEqual(panelStrip(['term-1', 'x.log', 'term-2'], ['term-1', 'term-2', 'term-3'], ['x.log']), ['term-1', 'x.log', 'term-2', 'term-3'])
  // What is gone (a closed shell, a tab moved out) leaves no gap; one never placed opens at the start.
  assert.deepEqual(panelStrip(['term-1', 'x.log', 'term-2', 'y.out'], ['term-2'], ['y.out', 'z.new']), ['z.new', 'term-2', 'y.out'])
  // A key listed twice counts once.
  assert.deepEqual(panelStrip(['x.log', 'x.log'], [], ['x.log']), ['x.log'])
})

test('saved panel tab state is read leniently: refs only, places that make sense', () => {
  assert.deepEqual(normalizePanelOrder(['x.log', 'term-1', 'x.log', 3, 'Bad Ref', 'y.out']), ['x.log', 'y.out'])
  assert.deepEqual(normalizePanelOrder('x.log'), [])
  assert.deepEqual(normalizePanelPlaces({
    'x.log': { at: 'editor', projectPath: 'C:\work\app', paneId: 'pane-b' },
    'y.out': { at: 'closed' },
    'z.a': { at: 'editor' },
    'w.b': { at: 'editor', projectPath: '/p' },
    'v.c': { at: 'panel' },
    'nodot': { at: 'closed' },
    'u.d': 'closed',
  }), {
    'x.log': { at: 'editor', projectPath: 'C:\work\app', paneId: 'pane-b' },
    'y.out': { at: 'closed' },
    'w.b': { at: 'editor', projectPath: '/p', paneId: 'pane-a' },
  })
  assert.deepEqual(normalizePanelPlaces(null), {})
  assert.deepEqual(normalizePanelPlaces(['x.log']), {})
})

test('a panel tab in the main area has its own tab id, round-tripping project and ref', () => {
  const id = panelEditorTabId('env://h/dev/home/agent/app', 'acme.tools.output')
  assert.ok(isPanelEditorTab(id))
  assert.ok(!isPluginTab(id))
  assert.deepEqual(parsePanelEditorTab(id), { projectPath: 'env://h/dev/home/agent/app', ref: 'acme.tools.output' })
  assert.equal(parsePanelEditorTab('term/xterm-1'), null)
})

test('a plugin scheme applies while registered, else Mango', () => {
  const registered = new Set(['plugin:x.dusk'])
  const has = (id: string) => registered.has(id)
  assert.equal(effectiveScheme('blue', has), 'blue')
  assert.equal(effectiveScheme('plugin:x.dusk', has), 'plugin:x.dusk')
  assert.equal(effectiveScheme('plugin:gone.dusk', has), 'mango')
})

test('plugin tab ids round-trip, keys may hold anything', () => {
  const r = { projectPath: 'C:\\work\\app', pluginId: 'acme.notes', viewId: 'note', key: 'a\u0001b' }
  const id = pluginTabId(r)
  assert.ok(isPluginTab(id))
  assert.deepEqual(parsePluginTab(id), r)
  assert.equal(parsePluginTab('file\u0001/x\u0001y'), null)
  assert.ok(!isPluginTab(null))
})

test('tokens become declarations; anything that could leave the rule is dropped', () => {
  const css = tokenDeclarations({ '--accent': '#f60', 'color': 'red', '--x': 'red; } body { display: none', '--y': 'a<b', '--z': '' })
  assert.equal(css, '  --accent: #f60;')
  const scheme = schemeCss('plugin:x.dusk', { '--accent': 'oklch(0.7 0.1 30)' }, { '--accent': 'oklch(0.5 0.1 30)' })
  assert.match(scheme, /:root\[data-scheme="plugin:x\.dusk"\]/)
  assert.match(scheme, /\[data-theme='light'\] \[data-scheme="plugin:x\.dusk"\]/)
})

/* ---------- hooks */

interface Ctx { threadId: string; text: string; attachments: string[] }
const base: Ctx = { threadId: 't1', text: 'hello', attachments: [] }

test('onBeforeSend hooks chain in order, each seeing the last result', async () => {
  const seen: string[] = []
  const out = await runBeforeSend<string, Ctx>([
    { pluginId: 'a', fn: (c) => { seen.push(c.text); return { text: `${c.text} world` } } },
    { pluginId: 'b', fn: (c) => { seen.push(c.text); return undefined } },
    { pluginId: 'c', fn: async (c) => { seen.push(c.text); return { attachments: ['f.txt'] } } },
  ], base, () => {})
  assert.deepEqual(seen, ['hello', 'hello world', 'hello world'])
  assert.deepEqual(out, { text: 'hello world', attachments: ['f.txt'] })
})

test('a hook returning false cancels; one that throws is skipped and reported', async () => {
  const errors: string[] = []
  const cancelled = await runBeforeSend<string, Ctx>([{ pluginId: 'a', fn: () => false }], base, () => {})
  assert.equal(cancelled, null)
  const out = await runBeforeSend<string, Ctx>([
    { pluginId: 'bad', fn: () => { throw new Error('x') } },
    { pluginId: 'good', fn: c => ({ text: c.text.toUpperCase() }) },
  ], base, id => errors.push(id))
  assert.deepEqual(out, { text: 'HELLO', attachments: [] })
  assert.deepEqual(errors, ['bad'])
})

test('emitAll isolates handlers, sync and async', async () => {
  const errors: string[] = []
  const got: number[] = []
  emitAll<[number]>([
    { pluginId: 'a', fn: (n) => { got.push(n) } },
    { pluginId: 'b', fn: () => { throw new Error('sync') } },
    { pluginId: 'c', fn: async () => { throw new Error('async') } },
    { pluginId: 'd', fn: (n) => { got.push(n * 2) } },
  ], [2], id => errors.push(id))
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(got, [2, 4])
  assert.deepEqual(errors.sort(), ['b', 'c'])
})

test('slash commands parse with their arguments', () => {
  assert.deepEqual(parseSlash('/todo buy milk\nand eggs'), { name: 'todo', args: 'buy milk\nand eggs' })
  assert.deepEqual(parseSlash('  /ns:cmd  '), { name: 'ns:cmd', args: '' })
  assert.equal(parseSlash('not /a command'), null)
  assert.equal(parseSlash('/'), null)
})

test('logs keep their last lines; arguments become one line', () => {
  const list: number[] = []
  for (let i = 0; i < 305; i++) capped(list, i, 300)
  assert.equal(list.length, 300)
  assert.equal(list[0], 5)
  assert.equal(logText(['a', 1, { b: 2 }]), 'a 1 {"b":2}')
  assert.match(logText([new Error('nope')]), /nope/)
})
