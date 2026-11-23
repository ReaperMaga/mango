/**
 * The language server client (app/lsp): URIs, conversion, document sync, cancellation and the
 * sessions' life, against a pretend server. Plain Node:
 *
 *   node --test tests/lsp.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileKey, joinRoot, pathToUri, relativeTo, uriToFile, uriToPath } from '../app/lsp/uri.ts'
import { Rpc, RpcError, isBenign, type CancelToken } from '../app/lsp/rpc.ts'
import { PendingChanges, SYNC_FULL, SYNC_INCREMENTAL, syncOptions } from '../app/lsp/sync.ts'
import { escapeMarkdown, inertSnippet, toCompletions, toHover, toMarkers, toResolved, toSignatureHelp, toTargets } from '../app/lsp/convert.ts'
import { WatchedFiles, FILE_CHANGED, FILE_CREATED, FILE_DELETED, compileGlob } from '../app/lsp/watched.ts'
import { Session, crashReason, type SessionView } from '../app/lsp/session.ts'
import { Pool, type PoolKey } from '../app/lsp/pool.ts'
import { PROFILES, clientCapabilities, lspLanguage } from '../app/lsp/languages.ts'
import { MAX_DECOMPILED, decompiledTabId, fileNameOf, isDecompiledTab, isMetadataUri, parseDecompiledTab, shortSymbol, toDecompiled } from '../app/utils/decompiledTabs.ts'
import { FILE_METHODS, linkRoute, oneFileWorker, refusesFirst, untrusted, withWords, workerGuards } from '../app/lsp/builtins.ts'
import { ModelUris } from '../app/lsp/modelUris.ts'
import { CompletionText, UntouchedText } from '../app/lsp/editGuard.ts'
import { KNOWN_TOKEN_TYPES, LEGEND, MAX_TOKENS, TOKEN_KINDS, kindMap, toSemanticTokens } from '../app/lsp/semanticTokens.ts'

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
const range = (a: number, b: number, c: number, d: number) => ({ start: { line: a, character: b }, end: { line: c, character: d } })
const editorRange = (a: number, b: number, c: number, d: number) => ({ startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d })

function cancellable() {
  const listeners: Array<() => void> = []
  let cancelled = false
  const token: CancelToken = {
    get isCancellationRequested() { return cancelled },
    onCancellationRequested(fn) { listeners.push(fn); return { dispose() {} } },
  }
  return { token, cancel() { cancelled = true; listeners.forEach(fn => fn()) } }
}

/* ---------- URIs */

test('paths become URIs and come back', () => {
  const cases: Array<[string, string, string]> = [
    ['C:\\Users\\me\\my app\\a#b%.ts', 'file:///c%3A/Users/me/my%20app/a%23b%25.ts', 'c:/Users/me/my app/a#b%.ts'],
    ['\\\\?\\C:\\work\\größe(1).rs', 'file:///c%3A/work/gr%C3%B6%C3%9Fe%281%29.rs', 'c:/work/größe(1).rs'],
    ['\\\\server\\share\\x y.go', 'file://server/share/x%20y.go', '//server/share/x y.go'],
    ['\\\\?\\UNC\\server\\share\\a', 'file://server/share/a', '//server/share/a'],
    ['/home/me/odd\\name?.py', 'file:///home/me/odd%5Cname%3F.py', '/home/me/odd\\name?.py'],
  ]
  for (const [path, uri, back] of cases) {
    assert.equal(pathToUri(path), uri)
    assert.equal(uriToPath(uri), back)
  }
})

test('servers spell one Windows file in several ways', () => {
  const root = 'C:\\Users\\me\\Shop'
  for (const uri of ['file:///c%3A/Users/me/Shop/src/main.rs', 'file:///C:/Users/me/Shop/src/main.rs', 'file:///c:/users/me/shop/src/main.rs', 'file://localhost/C:/Users/me/Shop/src/main.rs']) {
    assert.equal(uriToFile(root, uri), 'src/main.rs', uri)
  }
  assert.equal(fileKey(root, 'Src/Main.rs'), fileKey(root, 'src/main.rs'))
  assert.notEqual(fileKey('/home/me', 'A.rs'), fileKey('/home/me', 'a.rs'))
})

test('nothing outside the project is a file of it', () => {
  assert.equal(uriToFile('/home/me/app', 'file:///home/me/app2/a.ts'), null)
  assert.equal(uriToFile('/home/me/app', 'file:///home/me/app/../secret'), null)
  assert.equal(uriToFile('/home/me/app', 'file:///home/me/app/%2e%2e/secret'), null)
  assert.equal(uriToFile('C:\\app', 'file:///C:/app/..%5Csecret'), null)
  assert.equal(uriToFile('/home/me/app', 'file:///home/me/App/a.ts'), null, 'case matters off Windows')
  assert.equal(uriToFile('/home/me/app', 'https://example.com/a.ts'), null)
  assert.equal(uriToFile('/home/me/app', 'untitled:a.ts'), null)
  assert.equal(uriToFile('/home/me/app', 42), null)
  assert.equal(uriToFile('/home/me/app', 'file:///home/me/app/a%00.ts'), null)
  assert.equal(relativeTo('C:\\app\\', 'C:/app/src/x.ts'), 'src/x.ts')
  assert.equal(joinRoot('C:\\app\\', 'src/x.ts'), 'C:/app/src/x.ts')
})

test('language ids tell JSX apart', () => {
  assert.equal(lspLanguage('src/App.TSX', 'typescript'), 'typescriptreact')
  assert.equal(lspLanguage('src/a.mts', 'typescript'), 'typescript')
  assert.equal(lspLanguage('a.jsx', 'javascript'), 'javascriptreact')
  assert.equal(lspLanguage('main.rs', 'rust'), 'rust')
})

/* ---------- JSON-RPC */

function wire() {
  const sent: any[] = []
  const heard: any[] = []
  const rpc = new Rpc(m => sent.push(JSON.parse(m)), {
    request: (method) => (method === 'known' ? null : undefined),
    notification: (method, params) => heard.push([method, params]),
  })
  return { rpc, sent, heard, receive: (m: object) => rpc.receive(JSON.stringify(m)) }
}

test('a request resolves with its own answer', async () => {
  const { rpc, sent, receive } = wire()
  const first = rpc.request('a')
  const second = rpc.request('b')
  receive({ id: sent[1].id, result: 'B' })
  receive({ id: sent[0].id })
  assert.equal(await second, 'B')
  assert.equal(await first, null)
})

test('cancelling tells the server and settles at once; a late answer is ignored', async () => {
  const { rpc, sent, receive } = wire()
  const { token, cancel } = cancellable()
  const asked = rpc.request('slow', {}, { token })
  cancel()
  await assert.rejects(asked, (e: unknown) => isBenign(e))
  assert.deepEqual(sent[1], { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: sent[0].id } })
  receive({ id: sent[0].id, result: 'late' })
  await assert.rejects(rpc.request('never sent', {}, { token }))
  assert.equal(sent.length, 2)
})

test('a request times out, and closing settles the rest', async () => {
  const { rpc, sent } = wire()
  await assert.rejects(rpc.request('slow', {}, { timeout: 5 }), (e: unknown) => isBenign(e))
  assert.equal(sent.at(-1).method, '$/cancelRequest')
  const open = rpc.request('open')
  rpc.close()
  await assert.rejects(open, (e: unknown) => isBenign(e))
  await assert.rejects(rpc.request('after'), (e: unknown) => isBenign(e))
})

test('the server is always answered', () => {
  const { sent, receive, rpc } = wire()
  receive({ id: 7, method: 'known' })
  receive({ id: 'x', method: 'strange' })
  rpc.receive('not json')
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 7, result: null })
  assert.equal(sent[1].error.code, -32601)
  assert.equal(sent.length, 2)
  assert.equal(isBenign(new RpcError(-32801, 'content modified')), true)
  assert.equal(isBenign(new RpcError(-32603, 'broke')), false)
})

/* ---------- sync */

/** A server's copy, as it applies `didChange`. */
function apply(text: string, changes: Array<{ range?: any; text: string }>): string {
  for (const change of changes) {
    if (!change.range) { text = change.text; continue }
    const offset = ({ line, character }: { line: number; character: number }) => {
      let at = 0
      for (let i = 0; i < line; i++) at = text.indexOf('\n', at) + 1
      return at + character
    }
    text = text.slice(0, offset(change.range.start)) + change.text + text.slice(offset(change.range.end))
  }
  return text
}

test('edits apply in order, several at once included', () => {
  const pending = new PendingChanges()
  pending.add([
    { range: editorRange(3, 1, 3, 4), text: 'THREE\n' },
    { range: editorRange(1, 1, 1, 4), text: '1' },
  ])
  pending.add([{ range: editorRange(2, 4, 2, 4), text: ' 🥭' }])
  const changes = pending.take(SYNC_INCREMENTAL, () => assert.fail('the document was read'))
  assert.equal(apply('one\ntwo\nthree', changes), '1\ntwo 🥭\nTHREE\nee')
  assert.equal(pending.empty, true)
  assert.deepEqual(pending.take(SYNC_INCREMENTAL, () => 'x'), [])
})

test('the whole text goes when asked, replaced, or too much changed', () => {
  const one = { range: editorRange(1, 1, 1, 1), text: 'x' }
  const full = new PendingChanges()
  full.add([one])
  assert.deepEqual(full.take(SYNC_FULL, () => 'all'), [{ text: 'all' }])
  const reset = new PendingChanges()
  reset.add([one])
  reset.add(null)
  reset.add([one])
  assert.deepEqual(reset.take(SYNC_INCREMENTAL, () => 'all'), [{ text: 'all' }])
  const many = new PendingChanges()
  many.add(Array.from({ length: 501 }, () => one))
  assert.deepEqual(many.take(SYNC_INCREMENTAL, () => 'all'), [{ text: 'all' }])
})

test('sync options in both of their forms', () => {
  assert.deepEqual(syncOptions({ textDocumentSync: 2 }), { openClose: true, change: 2, save: { includeText: false } })
  assert.deepEqual(syncOptions({ textDocumentSync: { openClose: true, change: 1, save: { includeText: true } } }), { openClose: true, change: 1, save: { includeText: true } })
  assert.deepEqual(syncOptions({}), { openClose: false, change: 0, save: null })
})

/* ---------- conversion */

const word = { insert: editorRange(2, 3, 2, 5), replace: editorRange(2, 3, 2, 9) }

test('completions keep the ranges they name', () => {
  const { items, incomplete } = toCompletions({
    isIncomplete: true,
    items: [
      { label: 'plain' },
      { label: 'edit', textEdit: { range: range(1, 1, 1, 4), newText: '?.edit' } },
      { label: 'both', textEdit: { insert: range(1, 2, 1, 4), replace: range(1, 2, 1, 8), newText: 'both' } },
    ],
  }, word)
  assert.equal(incomplete, true)
  assert.deepEqual(items[0]!.range, word)
  assert.equal(items[0]!.insertText, 'plain')
  assert.deepEqual(items[1]!.range, { insert: editorRange(2, 2, 2, 5), replace: editorRange(2, 2, 2, 5) })
  assert.equal(items[1]!.insertText, '?.edit')
  assert.deepEqual(items[2]!.range, { insert: editorRange(2, 3, 2, 5), replace: editorRange(2, 3, 2, 9) })
})

test('a list\'s defaults reach its items and what resolve gets back', () => {
  const { items } = toCompletions({
    itemDefaults: { editRange: { insert: range(0, 0, 0, 1), replace: range(0, 0, 0, 3) }, insertTextFormat: 2, data: { file: 1 } },
    items: [{ label: 'f', textEditText: 'f(${1:x})' }, { label: 'g', data: 'own' }],
  }, word)
  assert.equal(items[0]!.snippet, true)
  assert.equal(items[0]!.insertText, 'f(${1:x})')
  assert.deepEqual(items[0]!.range.replace, editorRange(1, 1, 1, 4))
  assert.deepEqual(items[0]!.item.data, { file: 1 })
  assert.equal(items[1]!.item.data, 'own')
})

test('a broken import takes its suggestion with it; a good one comes along', () => {
  const good = { range: range(0, 0, 0, 0), newText: 'use a::B;\n' }
  const { items } = toCompletions([
    { label: 'B', additionalTextEdits: [good] },
    { label: 'C', additionalTextEdits: [good, { newText: 'x' } as any] },
    { label: 'D', textEdit: { newText: 'D' } as any },
    null as any,
    { kind: 3 } as any,
  ], word)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0]!.additionalTextEdits, [{ range: editorRange(1, 1, 1, 1), text: 'use a::B;\n' }])
})

test('resolving adds words and imports, never another text to insert', () => {
  const resolved = toResolved({ label: 'B', insertText: 'evil', documentation: { kind: 'markdown', value: '**B**' }, additionalTextEdits: [{ range: range(0, 0, 0, 0), newText: 'i' }] })
  assert.deepEqual(Object.keys(resolved).sort(), ['additionalTextEdits', 'documentation'])
  assert.deepEqual(toResolved(null), {})
})

test('a completion runs no command of the server\'s choosing', () => {
  const { items } = toCompletions([
    { label: 'a', command: { command: 'rust-analyzer.triggerParameterHints' } },
    { label: 'b', command: { command: 'editor.action.formatDocument' } },
    { label: 'c', command: { command: 'constructor' } },
  ], word)
  assert.equal(items[0]!.command?.id, 'editor.action.triggerParameterHints')
  assert.equal(items[1]!.command, undefined)
  assert.equal(items[2]!.command, undefined)
})

test('snippets keep their stops and lose their variables', () => {
  assert.equal(inertSnippet('f(${1:a}, $2)$0 ${3|x,y|}'), 'f(${1:a}, $2)$0 ${3|x,y|}')
  assert.equal(inertSnippet('$CLIPBOARD ${TM_FILENAME} ${1:${CLIPBOARD}}'), '\\$CLIPBOARD \\${TM_FILENAME} ${1:\\${CLIPBOARD}}')
  assert.equal(inertSnippet('\\$already'), '\\$already')
  assert.equal(inertSnippet('\\\\$VAR'), '\\\\\\$VAR', 'an escaped backslash escapes nothing')
})

test('hover in each of its forms, never trusted', () => {
  assert.deepEqual(toHover({ contents: { language: 'rust', value: 'fn a()' } }), { contents: [{ value: '```rust\nfn a()\n```' }], range: undefined })
  const fenced = toHover({ contents: { language: 'md', value: '```\nx\n```' } })!.contents[0]!.value
  assert.ok(fenced.startsWith('````md\n') && fenced.endsWith('\n````'))
  const plain = toHover({ contents: { kind: 'plaintext', value: '![p](https://x/y.png) <b>' } })!
  assert.equal(plain.contents[0]!.value, escapeMarkdown('![p](https://x/y.png) <b>'))
  assert.ok(plain.contents[0]!.value.startsWith('\\!\\['))
  const marked = toHover({ contents: { kind: 'markdown', value: '[run](command:evil)', isTrusted: true, supportHtml: true } as any })!
  assert.deepEqual(marked.contents, [{ value: '[run](command:evil)' }])
  assert.equal(toHover({ contents: [] }), null)
  assert.equal(toHover(null), null)
})

test('parameter hints', () => {
  const help = toSignatureHelp({ signatures: [{ label: 'f(a, b)', activeParameter: null, parameters: [{ label: [2, 3] }, { label: 'b' }] }], activeParameter: 1, activeSignature: 9 })!
  assert.equal(help.activeSignature, 0)
  assert.equal(help.activeParameter, 1)
  assert.deepEqual(help.signatures[0]!.parameters.map(p => p.label), [[2, 3], 'b'])
  assert.equal(toSignatureHelp({ signatures: [] }), null)
})

test('definitions as a location, several, or links', () => {
  assert.deepEqual(toTargets({ uri: 'file:///a', range: range(1, 2, 1, 5) }), [{ uri: 'file:///a', range: editorRange(2, 3, 2, 6), selection: editorRange(2, 3, 2, 6), origin: undefined }])
  const [link] = toTargets([{ targetUri: 'file:///b', targetRange: range(0, 0, 5, 1), targetSelectionRange: range(0, 3, 0, 4) }])
  assert.deepEqual(link!.selection, editorRange(1, 4, 1, 5))
  assert.deepEqual(toTargets([{ uri: 'file:///c' } as any, null as any]), [])
})

test('diagnostics become markers', () => {
  const markers = toMarkers([
    { range: range(0, 1, 0, 2), message: 'no', severity: 2, code: 2304, tags: [1, 9] },
    { range: range(0, 0, 0, 0), message: { kind: 'markdown', value: 'md' } },
    { message: 'nowhere' },
  ])
  assert.equal(markers.length, 2)
  assert.deepEqual([markers[0]!.severity, markers[0]!.code, markers[0]!.tags], [4, '2304', [1]])
  assert.deepEqual([markers[1]!.severity, markers[1]!.message], [8, 'md'])
  assert.deepEqual(toMarkers('junk'), [])
})

test('watched files match globs, absolute and relative', () => {
  assert.ok(compileGlob('**/*.{rs,toml}')!.test('Cargo.toml'))
  assert.ok(compileGlob('**/*.{rs,toml}')!.test('a/b/c.rs'))
  assert.ok(!compileGlob('*.rs')!.test('a/c.rs'))
  assert.ok(compileGlob('src/**')!.test('src/a/b.rs'))
  assert.ok(compileGlob('{go.{mod,sum},*.[!o]o}')!.test('go.sum'))
  assert.ok(compileGlob('{go.{mod,sum},*.[!o]o}')!.test('main.go'))
  assert.ok(!compileGlob('{go.{mod,sum},*.[!o]o}')!.test('main.oo'))
  assert.ok(compileGlob('*.RS', true)!.test('Main.rs'))
  assert.equal(compileGlob('{oops'), null)
  assert.equal(compileGlob('[oops'), null)
  const watched = new WatchedFiles('C:\\work\\app')
  watched.register('1', [{ globPattern: 'C:\\work\\app/**/*.go' }, { globPattern: { baseUri: 'file:///c%3A/work/app/sub', pattern: '*.mod' }, kind: 4 }])
  watched.register('2', [{ globPattern: { baseUri: { uri: 'file:///C:/work/app' }, pattern: '*.sum' } }])
  assert.ok(watched.wants('cmd/main.go', FILE_CHANGED))
  assert.ok(watched.wants('sub/go.mod', FILE_DELETED))
  assert.ok(!watched.wants('sub/go.mod', FILE_CREATED))
  assert.ok(watched.wants('go.sum', FILE_CREATED))
  watched.unregister('2')
  assert.ok(!watched.wants('go.sum', FILE_CREATED))
})

/* ---------- sessions */

const CAPS = {
  textDocumentSync: { openClose: true, change: 2, save: {} },
  completionProvider: {},
}

function pretend(options: { caps?: object; backoff?: number[]; silent?: string[]; refuse?: string; slowStart?: Promise<void>; tokensChanged?: () => void } = {}) {
  const sent: any[] = []
  const views: SessionView[] = []
  const markers: Array<[string, any[]]> = []
  const runs: Array<{ receive(m: object): void; exit(code: number | null, stderr: string): void; killed: boolean }> = []
  const session = new Session({
    name: 'pretend',
    profile: { settings: { pretend: { on: true } }, clientWatches: true },
    backoff: options.backoff ?? [1, 1],
    changed: v => views.push(v),
    diagnostics: (file, m) => markers.push([file, m]),
    tokensChanged: options.tokensChanged,
    async connect(handlers) {
      if (options.refuse) throw new Error(options.refuse)
      await options.slowStart
      const run = {
        killed: false,
        receive: (m: object) => handlers.message(JSON.stringify({ jsonrpc: '2.0', ...m })),
        exit: handlers.exit,
      }
      runs.push(run)
      return {
        root: 'C:\\work\\app',
        pid: 42,
        kill() { run.killed = true },
        send(text) {
          const m = JSON.parse(text)
          sent.push(m)
          if (options.silent?.includes(m.method)) return
          queueMicrotask(() => {
            if (m.method === 'initialize') run.receive({ id: m.id, result: { capabilities: options.caps ?? CAPS } })
            else if (m.method === 'exit') run.exit(0, '')
            else if (m.method && m.id !== undefined) run.receive({ id: m.id, result: [] })
          })
        },
      }
    },
  })
  return { session, sent, views, markers, runs, methods: () => sent.filter(m => m.method).map(m => m.method) }
}

test('the handshake, then the documents as they are by then', async () => {
  let release!: () => void
  const slowStart = new Promise<void>(resolve => (release = resolve))
  const { session, sent, methods } = pretend({ slowStart })
  let text = 'a'
  session.open({ file: 'src/my file.rs', language: 'rust', text: () => text })
  const started = session.start()
  text = 'ab'
  session.change('src/my file.rs', [{ range: editorRange(1, 2, 1, 2), text: 'b' }])
  release()
  await started
  assert.deepEqual(methods(), ['initialize', 'initialized', 'workspace/didChangeConfiguration', 'textDocument/didOpen'])
  assert.equal(sent[0].params.processId, 42)
  assert.equal(sent[0].params.rootUri, 'file:///c%3A/work/app')
  assert.deepEqual(sent[0].params.capabilities.general.positionEncodings, ['utf-16'])
  assert.equal(sent[3].params.textDocument.text, 'ab')
  assert.equal(sent[3].params.textDocument.uri, 'file:///c%3A/work/app/src/my%20file.rs')
  await session.stop()
})

test('edits go out before any request, and versions only climb', async () => {
  const { session, sent } = pretend()
  await session.start()
  session.open({ file: 'a.rs', language: 'rust', text: () => 'x' })
  session.open({ file: 'b.rs', language: 'rust', text: () => 'y' })
  session.change('a.rs', [{ range: editorRange(1, 1, 1, 1), text: '1' }])
  session.change('a.rs', [{ range: editorRange(1, 2, 1, 2), text: '2' }])
  session.change('b.rs', [{ range: editorRange(1, 1, 1, 1), text: '3' }])
  await session.request('textDocument/completion', 'a.rs', { position: { line: 0, character: 2 } })
  const tail = sent.slice(-3)
  assert.deepEqual(tail.map(m => m.method), ['textDocument/didChange', 'textDocument/didChange', 'textDocument/completion'])
  assert.equal(tail[0].params.contentChanges.length, 2)
  assert.equal(tail[0].params.textDocument.version, 2)
  session.change('a.rs', null)
  session.save('a.rs')
  assert.deepEqual(sent.at(-2).params.contentChanges, [{ text: 'x' }])
  assert.equal(sent.at(-2).params.textDocument.version, 3)
  assert.equal(sent.at(-1).method, 'textDocument/didSave')
  session.close('a.rs')
  assert.equal(sent.at(-1).method, 'textDocument/didClose')
  await session.stop()
})

test('a cancelled request is an empty answer', async () => {
  const { session, sent } = pretend({ silent: ['textDocument/completion'] })
  await session.start()
  session.open({ file: 'a.rs', language: 'rust', text: () => '' })
  const { token, cancel } = cancellable()
  const asked = session.request('textDocument/completion', 'a.rs', {}, { token })
  // A request leaves a microtask later, with the change it was asked from inside.
  await tick()
  cancel()
  assert.equal(await asked, null)
  assert.equal(sent.at(-1).method, '$/cancelRequest')
  await session.stop()
})

test('server requests: configuration, watching, and no edits of its own', async () => {
  const { session, sent, runs } = pretend()
  await session.start()
  const run = runs[0]!
  run.receive({ id: 'c', method: 'workspace/configuration', params: { items: [{ section: 'pretend' }, { section: 'constructor' }, {}] } })
  assert.deepEqual(sent.at(-1).result, [{ on: true }, null, null])
  run.receive({ id: 'e', method: 'workspace/applyEdit', params: {} })
  assert.equal(sent.at(-1).result.applied, false)
  run.receive({ id: 'r', method: 'client/registerCapability', params: { registrations: [{ id: 'w', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*.rs' }] } }] } })
  assert.equal(sent.at(-1).result, null)
  session.filesChanged([{ file: 'src/lib.rs', type: FILE_CHANGED }, { file: 'notes.md', type: FILE_CHANGED }])
  assert.deepEqual(sent.at(-1).params.changes, [{ uri: 'file:///c%3A/work/app/src/lib.rs', type: FILE_CHANGED }])
  await session.stop()
})

test('diagnostics find their file whatever its spelling; stale ones are dropped', async () => {
  const { session, markers, runs } = pretend()
  await session.start()
  session.open({ file: 'Src/A.rs', language: 'rust', text: () => '' })
  const publish = (version?: number) => runs[0]!.receive({
    method: 'textDocument/publishDiagnostics',
    params: { uri: 'file:///C:/work/app/src/a.rs', version, diagnostics: [{ range: range(0, 0, 0, 1), message: 'no' }] },
  })
  publish()
  assert.equal(markers.at(-1)![0], 'Src/A.rs')
  const count = markers.length
  publish(0)
  assert.equal(markers.length, count)
  runs[0]!.receive({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///C:/elsewhere/a.rs', diagnostics: [] } })
  assert.equal(markers.length, count)
  await session.stop()
})

test('work it reports shows until it ends', async () => {
  const { session, runs } = pretend()
  await session.start()
  const progress = (value: object) => runs[0]!.receive({ method: '$/progress', params: { token: 1, value } })
  progress({ kind: 'begin', title: 'Indexing', percentage: 0 })
  progress({ kind: 'report', message: 'std', percentage: 40.4 })
  assert.equal(session.view.busy, 'Indexing: std (40%)')
  progress({ kind: 'end' })
  assert.equal(session.view.busy, null)
  await session.stop()
})

test('a crash restarts with the documents, only so many times', async () => {
  const { session, views, runs, sent, markers } = pretend({ backoff: [1, 1] })
  await session.start()
  session.open({ file: 'a.rs', language: 'rust', text: () => 'now' })
  for (let i = 0; i < 2; i++) {
    runs.at(-1)!.exit(101, 'thread main panicked: boom\nnote: run with a backtrace')
    assert.equal(session.view.state, 'restarting')
    await tick(20)
    assert.equal(session.view.state, 'ready')
  }
  assert.equal(sent.filter(m => m.method === 'textDocument/didOpen').length, 3)
  runs.at(-1)!.exit(101, 'thread main panicked: boom')
  assert.equal(session.view.state, 'failed')
  assert.match(session.view.error!, /code 101.*panicked: boom/)
  assert.deepEqual(markers.at(-1), ['a.rs', []])
  session.retry()
  await tick(5)
  assert.equal(session.view.state, 'ready')
  assert.ok(views.some(v => v.state === 'starting'))
  await session.stop()
})

test('shutdown, then exit', async () => {
  const { session, runs, methods } = pretend()
  await session.start()
  await session.stop()
  assert.deepEqual(methods().slice(-2), ['shutdown', 'exit'])
  assert.equal(session.view.state, 'stopped')
  assert.equal(runs[0]!.killed, true)
})

test('withdrawn consent kills at once, also while it starts', async () => {
  const running = pretend()
  await running.session.start()
  const stopping = running.session.stop(true)
  assert.equal(running.runs[0]!.killed, true)
  assert.ok(!running.methods().includes('shutdown'))
  await stopping

  let release!: () => void
  const late = pretend({ slowStart: new Promise<void>(resolve => (release = resolve)) })
  const starting = late.session.start()
  await late.session.stop(true)
  release()
  await starting
  assert.equal(late.runs[0]!.killed, true)
  assert.equal(late.session.view.state, 'stopped')
  assert.deepEqual(late.methods(), [])
})

test('a server that cannot run fails without trying again', async () => {
  const missing = pretend({ refuse: 'pretend was not found.' })
  await missing.session.start()
  assert.deepEqual([missing.session.view.state, missing.session.view.error], ['failed', 'pretend was not found.'])
  const utf8 = pretend({ caps: { ...CAPS, positionEncoding: 'utf-8' } })
  await utf8.session.start()
  assert.equal(utf8.session.view.state, 'failed')
  assert.equal(utf8.runs[0]!.killed, true)
})

test('what a crash says in one line', () => {
  assert.equal(crashReason('ra', 1, 'info\n\x1b[31merror: Unknown binary\x1b[0m\nbye\n'), 'ra stopped with code 1. error: Unknown binary')
  assert.equal(crashReason('ra', null, ''), 'ra stopped.')
})

test('one session per server and folder, idle for a while, gone at once when disallowed', async () => {
  const log: string[] = []
  let allowed = true
  const pool = new Pool({
    idleMs: 25,
    allowed: () => allowed,
    live: () => false,
    create: (key: PoolKey) => ({
      async start() { log.push(`start ${key.server} ${key.root}`) },
      async stop(now?: boolean) { log.push(`stop ${key.server} ${key.root}${now ? ' now' : ''}`) },
    }),
  })
  const rust = { server: 'rust', root: '/app' }
  const worktree = { server: 'rust', root: '/app-wt' }
  pool.update([rust, { ...rust }, worktree])
  assert.deepEqual(log, ['start rust /app', 'start rust /app-wt'])
  pool.update([worktree])
  await tick(5)
  pool.update([rust, worktree])
  await tick(40)
  assert.equal(log.length, 2, 'it was needed again before the wait was over')
  pool.update([worktree])
  await tick(45)
  assert.equal(log.at(-1), 'stop rust /app')
  allowed = false
  pool.update([worktree])
  assert.equal(log.at(-1), 'stop rust /app-wt now')
  assert.equal(pool.get(worktree), null)
})

test('a request carries the change it was asked from inside', async () => {
  const { session, sent } = pretend()
  await session.start()
  session.open({ file: 'a.rs', language: 'rust', text: () => 'ab' })
  // Monaco asks first and tells of the change after, in the same turn.
  const asked = session.request('textDocument/completion', 'a.rs', {})
  session.change('a.rs', [{ range: editorRange(1, 2, 1, 2), text: 'b' }])
  await asked
  assert.deepEqual(sent.slice(-2).map(m => m.method), ['textDocument/didChange', 'textDocument/completion'])
  await session.stop()
})

test('a document opened again never repeats a version', async () => {
  const { session, sent, markers, runs } = pretend()
  await session.start()
  session.open({ file: 'a.rs', language: 'rust', text: () => 'old' })
  session.change('a.rs', null)
  session.save('a.rs')
  session.close('a.rs')
  session.open({ file: 'a.rs', language: 'rust', text: () => 'new' })
  const versions = sent.filter(m => m.method === 'textDocument/didOpen').map(m => m.params.textDocument.version)
  assert.ok(versions[1] > 2, String(versions))
  const count = markers.length
  runs[0]!.receive({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///c%3A/work/app/a.rs', version: 2, diagnostics: [] } })
  assert.equal(markers.length, count, 'what was found in the old text is not shown on the new')
  await session.stop()
})

test('a server\'s glob cannot hang a match', () => {
  const started = Date.now()
  assert.equal(compileGlob(`${'{a,aa}'.repeat(40)}b`)!.test('a'.repeat(60)), false)
  assert.equal(compileGlob('**a**a**a**a**a**a**a**a**a**a**a**a**b')!.test('a'.repeat(300)), false)
  const watched = new WatchedFiles('/app')
  watched.register('many', Array.from({ length: 5000 }, () => ({ globPattern: `${'{a,aa}'.repeat(100)}b` })))
  watched.wants('a'.repeat(120), FILE_CHANGED)
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`)
})

/* ---------- Monaco's own workers, the real ones */

const monacoFile = (path: string) => import(new URL(`../node_modules/monaco-editor/esm/vs/${path}.js`, import.meta.url).href)
const { TypeScriptWorker } = await monacoFile('languages/features/typescript/tsWorker')
const { URI } = await monacoFile('base/common/uri')
const { typescript } = await monacoFile('languages/features/typescript/lib/typescriptServices')

const TS_OPTIONS = { allowNonTsExtensions: true, allowJs: true, target: 99, module: 99, moduleResolution: 2, jsx: 1, esModuleInterop: true }
const FORMAT = {
  ConvertTabsToSpaces: true, TabSize: 2, IndentSize: 2, IndentStyle: 2, NewLineCharacter: '\n',
  InsertSpaceAfterCommaDelimiter: true, InsertSpaceBeforeAndAfterBinaryOperators: true,
}

/** Open files as Mango makes their models, and the worker that mirrors them. */
function editorWith(files: Array<[project: string, file: string, text: string]>) {
  const uris = new ModelUris()
  const mirrored: any[] = []
  const open = (project: string, file: string, text: string): string => {
    const uri = URI.from({ scheme: 'file', path: uris.next(project, file) })
    mirrored.push({ uri, version: 1, getValue: () => text })
    return uri.toString()
  }
  const names = files.map(f => open(...f))
  const Worker = oneFileWorker(TypeScriptWorker, typescript)
  const worker = new Worker({ getMirrorModels: () => mirrored }, { compilerOptions: TS_OPTIONS, extraLibs: {} })
  return { worker, names, open, close: () => { mirrored.length = 0 } }
}

test('every method of Monaco\'s TypeScript worker is one file\'s, or the host\'s', () => {
  const host = [
    'constructor', 'getCompilationSettings', 'getLanguageService', 'getExtraLibs', 'getScriptFileNames', '_getModel', 'getScriptVersion',
    '_getScriptText', 'getScriptSnapshot', 'getScriptKind', 'getCurrentDirectory', 'getDefaultLibFileName', 'isDefaultLibFileName',
    'readFile', 'fileExists', 'getLibFiles', 'updateExtraLibs',
  ]
  assert.deepEqual(Object.getOwnPropertyNames(TypeScriptWorker.prototype).sort(), [...host, ...FILE_METHODS].sort())
})

test('.mts and .cts are TypeScript', async () => {
  const { worker, names } = editorWith([['/app', 'a.mts', 'const n: number = 1\n'], ['/app', 'b.cts', 'const n: number = 1\n']])
  for (const name of names) assert.deepEqual(await worker.getSyntacticDiagnostics(name), [])
})

test('no quick fix holds another file\'s edit', async () => {
  const main = 'import { Store } from \'./store\'\n\nconst store = new Store()\nstore.reset()\ndocument.madeUp()\nconst counter = 1\nconsole.log(countr)\n'
  const { worker, names } = editorWith([['/app', 'src/store.ts', 'export class Store {\n  size = 0\n}\n'], ['/app', 'src/main.ts', main]])
  for (const [word, code] of [['reset', 2339], ['madeUp', 2339], ['Store', 2304]] as const) {
    const at = main.indexOf(word, word === 'Store' ? 20 : 0)
    for (const fix of await worker.getCodeFixesAtPosition(names[1], at, at + word.length, [code], FORMAT)) {
      for (const change of fix.changes) assert.equal(change.fileName, names[1], fix.description)
    }
  }
  const at = main.indexOf('countr)')
  const spelling = await worker.getCodeFixesAtPosition(names[1], at, at + 6, [2552], FORMAT)
  assert.ok(spelling.length, 'a fix of the file itself is still there')
})

test('a file opened again is read afresh by every worker', async () => {
  const old = 'const a = {x:1}\nfunction f(){return a}\n'
  const now = '// changed by git checkout while the tab was closed\nconst a = {x:10000}\nfunction f(){return a}\n'
  const { worker, names, open, close } = editorWith([['/app', 'fmt.ts', old]])
  await worker.getFormattingEditsForRange(names[0], 0, old.length, FORMAT)
  await worker.getSyntacticDiagnostics(names[0])
  await worker.getNavigationTree(names[0])
  await worker.findRenameLocations(names[0], old.indexOf('f()'))
  close()
  const again = open('/app', 'fmt.ts', now)
  assert.notEqual(again, names[0], 'the same URI and version 1 would be taken for the old text')
  const fresh = editorWith([['/app', 'fmt.ts', now]])
  assert.deepEqual(
    await worker.getFormattingEditsForRange(again, 0, now.length, FORMAT),
    await fresh.worker.getFormattingEditsForRange(fresh.names[0], 0, now.length, FORMAT),
  )
  for (const loc of await worker.findRenameLocations(again, now.indexOf('f()'))) {
    assert.equal(now.slice(loc.textSpan.start, loc.textSpan.start + loc.textSpan.length), 'f')
  }
})

test('no URI is used twice: reopened, renamed, previewed', () => {
  const uris = new ModelUris()
  const paths = ['/app', '/app', '/app-wt', '/app'].map(project => uris.next(project, 'src/a.css'))
  assert.equal(new Set(paths).size, 4)
  assert.deepEqual(uris.locate(paths[2]!), { project: '/app-wt', file: 'src/a.css' })
  assert.deepEqual(uris.locate('/~2'), { project: '/app-wt', file: '' })
  for (const bad of ['/~2/../../secret', '/~2/..\\secret', '/~99/a.ts', '/src/a.ts']) assert.equal(uris.locate(bad), null, bad)
})

test('rename, references, highlights, jumps and completion stay in their file', async () => {
  const text = 'var sharedCounter = 1\nsharedCounter = sharedCounter + 1\n'
  const { worker, names } = editorWith([
    ['/app', 'global.ts', text],
    ['/app', 'sibling.ts', `${text}var siblingSecret = 1\n`],
    ['/app-wt', 'global.ts', `${text}var worktreeSecret = 1\n`],
    ['/app', 'uses.ts', '/// <reference path="../~2/global.ts" />\nsiblingSecret\nworktreeSecret\n'],
  ])
  const [own, , , uses] = names
  const at = text.indexOf('sharedCounter')
  const renamed = await worker.findRenameLocations(own, at)
  assert.equal(renamed.length, 3)
  for (const loc of renamed) assert.equal(loc.fileName, own)
  for (const ref of await worker.getReferencesAtPosition(own, at)) assert.equal(ref.fileName, own)
  for (const hit of await worker.getDocumentHighlights(own, at, [own])) assert.equal(hit.fileName, own)
  for (const def of await worker.getDefinitionAtPosition(own, at) ?? []) assert.equal(def.fileName, own)
  const line = '/// <reference path="../~2/global.ts" />\n'
  assert.deepEqual(await worker.getDefinitionAtPosition(uses, line.length + 1) ?? [], [])
  const offered = (await worker.getCompletionsAtPosition(own, text.length)).entries.map((e: any) => e.name)
  assert.ok(offered.includes('Math'), 'the standard library is still known')
  assert.ok(!offered.includes('siblingSecret') && !offered.includes('worktreeSecret'))
  const through = (await worker.getCompletionsAtPosition(uses, line.length)).entries.map((e: any) => e.name)
  assert.ok(!through.includes('worktreeSecret'), 'not by naming its path either')
})

test('a rename that would need more than plain edits of one file is refused', async () => {
  const cases: Array<[text: string, word: string, ok: boolean]> = [
    ['import { f } from \'./lib\'\nf()\n', 'f()', false],
    ['export function shared() {}\n', 'shared', false],
    ['const size = 1\nconst box = { size }\n', 'size', false],
    ['function run() {\n  const step = 1\n  return step\n}\n', 'step', true],
  ]
  for (const [text, word, ok] of cases) {
    const { worker, names } = editorWith([['/app', 'a.ts', text]])
    assert.equal((await worker.getRenameInfo(names[0], text.indexOf(word), {})).canRename, ok, text)
  }
})

test('members other files reach are not renamed; what stays in the file is', async () => {
  const cases: Array<[file: string, text: string, word: string, ok: boolean]> = [
    ['a.ts', 'export class S { run() {} }', 'run', false],
    ['a.ts', 'class S { size = 1 }\nexport const s = new S()', 'size', false],
    ['a.ts', 'export class S { protected run() {} }', 'run', false],
    ['a.ts', 'export class S { static make() {} }', 'make', false],
    ['a.ts', 'export class S { get total() { return 1 } }', 'total', false],
    ['a.ts', 'export class S { constructor(readonly part: number) {} }', 'part', false],
    ['a.ts', 'export class S { constructor(public part: number) {} }', 'part', false],
    ['a.ts', 'export const api = { load() {} }', 'load', false],
    ['a.ts', 'const api = { load: 1 }\nexport default api', 'load', false],
    ['a.ts', 'export interface P { label: string }', 'label', false],
    ['a.ts', 'export type P = { label: string }', 'label', false],
    ['a.ts', 'export enum E { First }', 'First', false],
    ['a.ts', 'declare global { var shared: number }\nexport {}', 'shared', false],
    ['a.ts', 'function go() {}\nexport { go }', 'go', false],
    ['a.js', 'exports.go = function () {}', 'go', false],
    ['a.ts', 'export function f(count: number) { return count }', 'count', true],
    ['a.ts', 'export class S { private run() { this.run() } }', 'run', true],
    ['a.ts', 'export class S { constructor(private part: number) {} }', 'part', true],
    ['a.ts', 'export class S { #size = 1; read() { return this.#size } }', '#size', true],
    ['a.ts', 'const top = 1\nexport default top', 'top', true],
    ['a.ts', 'import * as lib from \'./other\'\nlib.run()', 'lib', true],
  ]
  for (const [file, text, word, ok] of cases) {
    const { worker, names } = editorWith([['/app', file, text]])
    const info = await worker.getRenameInfo(names[0], text.indexOf(word), {})
    assert.equal(info.canRename, ok, text)
    if (!ok) assert.equal(info.localizedErrorMessage, 'Can\'t rename this safely: other files may use this name', text)
  }
})

test('a name a file exports is not renamed, whatever form exports it; its own names still are', async () => {
  // ^ is the caret. One case per place a caret can be in each form.
  const refused: Record<string, string[]> = {
    'a.ts': [
      // declarations
      'export const ^a = 1', 'export let a = 1, ^b = 2', 'export var ^a = 1', 'export function ^f() {}', 'export function* ^g() {}', 'export async function ^f() {}',
      'export class ^K {}', 'export abstract class ^K {}', 'export interface ^I {}', 'export type ^T = 1', 'export enum ^E { A }', 'export const enum ^E { A }',
      'export declare const ^d: 1', 'export namespace ^N {}', 'export namespace P.^Q {}', "export import ^fs = require('fs')",
      'export const { ^v } = { v: 1 }', 'export const { v: ^w } = { v: 1 }', 'export const [^first] = [1]', 'export const { v, ...^rest } = { v: 1 }',
      // default exports whose declaration is the export
      'export default function ^main() {}', 'export default class ^Main {}', 'export default interface ^Main {}',
      // lists, before and after what they export
      'const ^a = 1\nexport { a }', 'const a = 1\nexport { ^a }', 'export { ^a }\nconst a = 1', 'export { a }\nconst ^a = 1', 'type T = 1\nexport type { ^T }',
      'const a = 1\nexport { a as ^b }', 'const a = 1\nexport { a ^as b }', "const a = 1\nexport { a as '^q' }", 'const a = 1\nexport { a as ^a }',
      'const a = 1\nexport { a as ^default }', 'const a = 1\nexport { a, a as ^b }', 'type T = 1\nexport { type T as ^U }', 'const C = 1\nexport type { C as ^D }',
      'namespace N { const a = 1\n export { a as ^b } }', "declare module 'p' {\n const a: 1\n export { a as ^b }\n}",
      // from another module
      "export { ^x } from './m'", "export { x as ^y } from './m'", "export { ^x as y } from './m'", "export { default as ^X } from './m'", "export { ^default } from './m'",
      "export { X as ^default } from './m'", "export * as ^ns from './m'", "export * ^as ns from './m'", "export type * as ^ns from './m'", "export type { A as ^B } from './m'",
      // what was imported
      "import { ^a } from './m'\nexport { a }", "import { a as ^b } from './m'\nexport { b }", "import { a as b } from './m'\nexport { b as ^c }",
      "import ^D from './m'\nexport { D }", "import * as ^ns from './m'\nexport { ns }",
      // not this file's to rename
      "import { ^a as b } from './m'", "import { ^a } from './m'\na()",
    ],
    'a.d.ts': ['export function f(): void\nexport as namespace ^MyLib', 'declare class ^Lib {}\nexport = Lib', 'type ^Id = string\nexport declare function f(): Id'],
    'c.js': [
      'function f() {}\nexports.^f = f', 'function f() {}\n^exports.f = f', 'exports.^run = 1', 'exports.^K = class {}', 'module.exports.^q = 1', 'module.^exports = 1',
      'function f() {}\nmodule.exports.^f = f', 'function ^f() {}\nmodule.exports = { f }', 'exports.^deep.er = 1', 'export const ^a = 1', 'const a = 1\nexport { a as ^b }',
      '/** @typedef {{ a: number }} ^Options */\nexport const o = 1', '/** @typedef {number} T */\n/** @type {^T} */\nexport const o = 1',
      '/**\n * @typedef ^Opts\n * @property {number} size\n */\nexport {}', '/** @callback ^Done\n * @param {number} n\n */\nexport {}',
      '/** @typedef {number} ^NS.Num */\nexport {}', '/** @typedef {number} ^Loose */\nconst z = 1',
    ],
  }
  const renamed: Record<string, string[]> = {
    'a.ts': [
      "import { a as ^b } from './m'\nb()", "import { a as b } from './m'\n^b()", "import ^D from './m'\nD()", "import * as ^ns from './m'\nns.f()",
      "import type { A as ^B } from './m'", "import { default as ^D } from './m'", "import ^fs = require('fs')\nfs", "import type ^X = require('x')",
      "import { a as ^b } from './m'\nexport { b as c }", "import ^D from './m'\nexport default D",
      'const ^a = 1\nexport { a as b }', 'const a = 1\nexport { ^a as b }', 'function ^main() {}\nexport default main', 'export default ^main\nfunction main() {}',
      'function ^main() {}\nexport = main', 'class ^M {}\nexport default M', '^label: for (;;) break label', 'export class C<^T> { v?: T }',
      'export const f = function ^named() { return named }', 'const ^Comp = 1\nexport { Comp as View }', 'type ^T = 1\nexport { type T as U }',
      'export class C { private ^run() {} }', 'class ^C {}\ninterface C {}\nexport {}',
    ],
    'c.js': [
      'function ^f() {}\nexports.f = f', 'function ^f() {}\nmodule.exports = f', "const ^m = require('./m')\nm", "const { a: ^b } = require('./m')\nb()",
      'class ^M {}\nM.sub = 1\nmodule.exports = M', 'const ^x = {}\nx.part = 1', 'function ^g() {}\ng.part = 1', '/** @param {number} ^v */\nexport function id(v) { return v }',
      "/** @import { A as ^Z } from './m' */\nexport {}", '/** @enum {number} */\nconst ^E = { A: 1 }\nexport {}',
    ],
  }
  const wrong: string[] = []
  for (const [table, want] of [[refused, false], [renamed, true]] as const) {
    for (const [file, texts] of Object.entries(table)) {
      for (const marked of texts) {
        const { worker, names } = editorWith([['/app', file, marked.replace('^', '')]])
        const info = await worker.getRenameInfo(names[0], marked.indexOf('^'), {})
        if (!!info.canRename !== want) wrong.push(`${want ? 'refused' : 'renamed'} ${file}: ${JSON.stringify(marked)}`)
      }
    }
  }
  assert.deepEqual(wrong, [])
})

test('F2 says a refusal before the name box opens, for the script worker alone', async () => {
  let version = 1
  const askedAt = async (marked: string, during = () => {}) => {
    const text = marked.replace('^', '')
    const { worker, names } = editorWith([['/app', 'a.ts', text]])
    const at = marked.indexOf('^')
    const provider = {
      // As Monaco's adapter asks the worker.
      async provideRenameEdits() {
        const info = await worker.getRenameInfo(names[0], at, {})
        during()
        return info.canRename ? { edits: await worker.findRenameLocations(names[0], at) } : { edits: [], rejectReason: info.localizedErrorMessage }
      },
    }
    const model = { uri: { toString: () => names[0]! }, getVersionId: () => version, isDisposed: () => false, getWordAtPosition: () => ({ word: 'name' }) }
    const first = refusesFirst('typescript', provider)
    assert.equal(first.provideRenameEdits, provider.provideRenameEdits, 'Enter is checked as before')
    return first.resolveRenameLocation(model, { lineNumber: 1, column: 1 })
  }
  const refused = { rejectReason: 'Can\'t rename this safely: other files may use this name' }
  for (const marked of ['export const ^a = 1', 'export class K { ^run() {} }', "export { default as ^X } from './m'"]) {
    assert.deepEqual(await askedAt(marked), refused, marked)
  }
  for (const marked of ['const ^a = 1\nexport {}', "import { a as ^b } from './m'\nb()"]) assert.equal(await askedAt(marked), null, `${marked}: the box opens`)
  assert.equal(await askedAt('export const ^a = 1', () => { version++ }), null, 'not about a text that changed since')

  const failing = { provideRenameEdits: async () => { throw new Error('the worker went') } }
  const model = { getVersionId: () => 1, isDisposed: () => false, getWordAtPosition: () => null }
  assert.equal(await refusesFirst('javascript', failing).resolveRenameLocation(model, {}), null, 'a failure is left to Enter')
  for (const selector of ['css', 'html', 'handlebars', 'python', { language: 'typescript' }]) {
    assert.equal(refusesFirst(selector, failing), failing, `${JSON.stringify(selector)} is left as it is`)
  }
})

test('the TypeScript worker\'s suggestions come with other files\' words, once and as plain text', async () => {
  const others = ['sharedPlainName', 'ownName', 'Math', '$scope', 'sharedPlainName']
  const complete = async (text: string) => {
    const { worker, names } = editorWith([['/app', 'b.ts', text]])
    const lines = text.split('\n')
    const word = /[\w$]*$/.exec(text)![0]
    const column = lines.at(-1)!.length + 1
    const model = {
      getLineContent: (n: number) => lines[n - 1],
      // Monaco's tokens, as far as they matter here: what is comment.
      tokenization: {
        forceTokenization: () => {},
        getLineTokens: (n: number) => ({
          findTokenIndexAtOffset: (at: number) => at,
          getStandardTokenType: (at: number) => (/\/\/|^\s*(\/\*|\*)/.test(lines[n - 1]!.slice(0, at + 1)) ? 1 : 0),
        }),
      },
      getWordUntilPosition: () => ({ word, startColumn: column - word.length }),
      getWordAtPosition: () => null,
      isDisposed: () => false,
    }
    const own = async () => {
      const info = await worker.getCompletionsAtPosition(names[0], text.length)
      return info && { suggestions: info.entries.map((e: any) => ({ label: e.name })) }
    }
    const result: any = await withWords(own, () => others, 18)(model, { lineNumber: lines.length, column })
    return result?.suggestions ?? []
  }
  const found = await complete('const ownName = 1\nsharedPl')
  const named = (name: string) => found.filter((s: any) => s.label === name)
  assert.deepEqual(named('sharedPlainName'), [{
    label: 'sharedPlainName', kind: 18, insertText: 'sharedPlainName', sortText: '~',
    range: { insert: editorRange(2, 1, 2, 9), replace: editorRange(2, 1, 2, 9) },
  }])
  for (const name of ['ownName', 'Math']) {
    assert.equal(named(name).length, 1, name)
    assert.equal(named(name)[0].kind, undefined, `${name} is the worker's own`)
  }
  assert.ok(named('$scope').length)
  const offered = async (text: string) => (await complete(text)).some((s: any) => s.label === 'sharedPlainName')
  assert.ok(await offered('const list = [...sha'), 'a spread is no member')
  for (const text of ['// Adds the numbers.\nsha', 'const a = 1 // Done.\n\n  sha', '/**\n * Adds them.\n */\nsha', '/* One.\n * Two.\n */ sha']) {
    assert.ok(await offered(text), `a comment's period is no dot: ${text}`)
  }
  for (const text of ['Math.sha', 'const o = { size: 1 }\no?.sha', 'Math\n  .sha', 'Math.\n  sha']) {
    assert.ok(!await offered(text), text)
  }
  assert.ok(!await offered('sharedPlainName'), 'not what is typed')
})

test('the other workers\' answers are held to the asking file\'s current text', async () => {
  let version = 4
  const model = { uri: { toString: () => 'file:///~1/a.css' }, getVersionId: () => version, isDisposed: () => false, getWordAtPosition: () => null }
  const refusals: string[] = []
  const guards = new Map<string, any>(workerGuards((_, __, reason) => refusals.push(reason)).map(([register, , guard]) => [register, guard]))
  const edit = (uri: string) => ({ resource: { toString: () => uri }, versionId: undefined, textEdit: { text: 'x' } })
  const rename = (edits: unknown[], during = () => {}) =>
    guards.get('registerRenameProvider')(async () => { during(); return { edits } })(model, { lineNumber: 1, column: 1 }, 'x')

  assert.equal((await rename([edit('file:///~1/a.css')])).edits[0].versionId, 4, 'applies to that version only')
  assert.equal(await rename([edit('file:///~1/a.css'), edit('file:///~2/a.css')]), null)
  assert.equal(await rename([edit('file:///~1/a.css')], () => { version++ }), null)
  await guards.get('registerRenameProvider')(async () => ({ edits: [], rejectReason: 'no' }))(model, {}, 'x')
  assert.deepEqual(refusals, ['no'])

  for (const register of ['registerDocumentFormattingEditProvider', 'registerDocumentRangeFormattingEditProvider', 'registerOnTypeFormattingEditProvider', 'registerColorProvider']) {
    assert.deepEqual(await guards.get(register)(async () => ['edit'])(model), ['edit'])
    assert.equal(await guards.get(register)(async () => { version++; return ['edit'] })(model), null, register)
  }
  for (const register of ['registerReferenceProvider', 'registerDefinitionProvider']) {
    const found = await guards.get(register)(async () => [{ uri: 'file:///~1/a.css' }, { uri: 'file:///~2/a.css' }])(model)
    assert.deepEqual(found, [{ uri: 'file:///~1/a.css' }])
  }
  const late = await guards.get('registerCompletionItemProvider')(async () => {
    version++
    return { suggestions: [{ range: editorRange(1, 1, 1, 9), additionalTextEdits: [{}] }] }
  })(model, { lineNumber: 1, column: 4 })
  assert.equal(late.suggestions[0].range.endColumn, 4)
  assert.equal(late.suggestions[0].additionalTextEdits, undefined)
})

test('no command from a file\'s text runs', async () => {
  const { computeLinks } = await monacoFile('editor/common/languages/linkComputer')
  const { MarkdownString } = await monacoFile('base/common/htmlContent')
  const bs = String.fromCharCode(92)
  const line = `// docs: http://x.dev/${bs}(${bs}${bs})[Open-docs](command:editor.action.insertSnippet?%7B%7D#)`
  const links = computeLinks({ getLineCount: () => 1, getLineContent: () => line })
  assert.ok(links.length)
  for (const link of links) {
    const hover = new MarkdownString('', true).appendLink(String(link.url), 'Follow link')
    assert.equal(hover.isTrusted, true, 'as Monaco builds it')
    const shown = untrusted(hover as object) as { value: string; isTrusted: unknown; supportHtml: unknown }
    assert.deepEqual([shown.value, shown.isTrusted, shown.supportHtml], [hover.value, false, false])
  }
  for (const scheme of ['command', 'COMMAND', 'javascript', 'data', 'vscode', 'ms-windows-store', '']) assert.equal(linkRoute(scheme), 'nowhere', scheme)
  assert.equal(linkRoute('https'), 'browser')
  assert.equal(linkRoute('file'), 'editor')
})

test('a completion fits only the text it was computed from, typed into', () => {
  const asked = () => new CompletionText([{ lineNumber: 5, column: 3 }, { lineNumber: 9, column: 1 }])
  const change = (a: number, b: number, c: number, d: number, text: string, isFlush = false) => ({ isFlush, changes: [{ range: editorRange(a, b, c, d), text }] })
  const fits = (...events: any[]) => {
    const text = asked()
    for (const e of events) text.changed(e)
    return text.valid
  }
  assert.ok(fits(change(5, 6, 5, 6, 'a'), change(5, 6, 5, 7, ''), change(9, 1, 9, 1, 'a')))
  assert.ok(!fits(change(1, 20, 1, 30, '// taken out')), 'the import\'s line changed')
  assert.ok(!fits(change(7, 1, 8, 1, '')), 'lines below')
  assert.ok(!fits(change(5, 1, 5, 2, 'x')), 'left of the word')
  assert.ok(!fits(change(5, 6, 5, 6, '\n')))
  assert.ok(!fits(change(5, 6, 5, 6, 'a', true)))
})

test('an import that arrives late lands only above what changed since', () => {
  const late = new UntouchedText()
  late.changed({ isFlush: false, changes: [{ range: editorRange(5, 3, 5, 8), text: 'farawayValue' }] })
  assert.ok(late.allows([{ range: editorRange(1, 20, 1, 20) }]))
  assert.ok(late.allows([{ range: editorRange(5, 1, 5, 3) }]))
  assert.ok(!late.allows([{ range: editorRange(5, 9, 5, 9) }]))
  late.changed({ isFlush: false, changes: [{ range: editorRange(1, 1, 1, 2), text: '' }] })
  assert.ok(!late.allows([{ range: editorRange(1, 20, 1, 20) }]))
})

/* ---------- decompiled library source (C#) */

const CONSOLE = 'csharp:/C:/work/game/Assembly-CSharp.csproj/decompiled/System.Console.cs'

test('only the C# server is told Mango opens decompiled sources', () => {
  assert.deepEqual((clientCapabilities(PROFILES.csharp) as any).experimental, { csharp: { metadataUris: true } })
  for (const id of ['typescript', 'rust', 'python', 'go', 'clangd'] as const) {
    assert.equal((clientCapabilities(PROFILES[id]) as any).experimental, undefined, id)
  }
  const csharp = new Session({ name: 'c', profile: PROFILES.csharp, connect: async () => { throw new Error('no') }, changed() {}, diagnostics() {} })
  const rust = new Session({ name: 'r', profile: PROFILES.rust, connect: async () => { throw new Error('no') }, changed() {}, diagnostics() {} })
  assert.equal(csharp.metadataUris, true)
  assert.equal(rust.metadataUris, false)
})

test('a decompiled source\'s address is no file of the project, and its tab says where it came from', () => {
  assert.equal(uriToFile('C:\work\game', CONSOLE), null)
  assert.ok(isMetadataUri(CONSOLE))
  assert.ok(!isMetadataUri('file:///c%3A/work/game/A.cs'))
  const id = decompiledTabId('C:\work\game', CONSOLE)
  assert.ok(isDecompiledTab(id))
  assert.ok(!isDecompiledTab('file\u0001C:\work\game\u0001A.cs'))
  assert.deepEqual(parseDecompiledTab(id), { projectPath: 'C:\work\game', uri: CONSOLE, name: 'System.Console.cs' })
  assert.equal(parseDecompiledTab('decompiled\u0001nothing'), null)
  assert.equal(fileNameOf('csharp:/x/decompiled/System.Collections.Generic.List%601.cs'), 'System.Collections.Generic.List`1.cs')
  assert.equal(fileNameOf('csharp:/x/decompiled/bad%E0.cs'), 'bad%E0.cs')
  assert.equal(shortSymbol('UnityEngine.MonoBehaviour'), 'MonoBehaviour')
  assert.equal(shortSymbol('Global'), 'Global')
})

test('the server\'s decompiled source is checked before it is shown', () => {
  assert.deepEqual(
    toDecompiled({ projectName: 'game', assemblyName: 'UnityEngine.CoreModule', symbolName: 'UnityEngine.MonoBehaviour', source: 'class MonoBehaviour {}' }),
    { assembly: 'UnityEngine.CoreModule', symbol: 'UnityEngine.MonoBehaviour', source: 'class MonoBehaviour {}' },
  )
  // Names are one line of text, whatever the server put in them.
  assert.deepEqual(toDecompiled({ assemblyName: 'A\u0000\nB', symbolName: 42, source: 'x' }), { assembly: 'AB', symbol: '', source: 'x' })
  assert.equal(toDecompiled(null), null)
  assert.equal(toDecompiled('class A {}'), null)
  assert.equal(toDecompiled({ assemblyName: 'A', symbolName: 'B', source: '' }), null)
  assert.equal(toDecompiled({ assemblyName: 'A', symbolName: 'B', source: 'x'.repeat(MAX_DECOMPILED + 1) }), null)
})

/* ---------- semantic colouring */

// Part of csharp-ls's legend, in its order.
const CSHARP_LEGEND = { tokenTypes: ['class', 'comment', 'keyword', 'method', 'field', 'namespace', 'jsonText', 'struct', 'interface', 'typeParameter'], tokenModifiers: ['static'] }

test('a server\'s legend maps onto the kinds the theme colours', () => {
  const map = kindMap(CSHARP_LEGEND)!
  const kind = (i: number) => (map[i]! < 0 ? null : TOKEN_KINDS[map[i]!])
  assert.deepEqual([...map.keys()].map(kind), ['type', null, null, 'function', 'property', 'namespace', null, 'type', 'type', 'type'])
  assert.equal(kindMap(null), null)
  assert.equal(kindMap({ tokenTypes: 'class' } as any), null)
  assert.deepEqual([...kindMap({ tokenTypes: [7, 'constructor', 'enumMember'], tokenModifiers: [] } as any)!].map(i => (i < 0 ? null : TOKEN_KINDS[i])), [null, null, 'constant'])
  assert.deepEqual(LEGEND.tokenTypes, [...TOKEN_KINDS])
  assert.ok(KNOWN_TOKEN_TYPES.includes('class') && !KNOWN_TOKEN_TYPES.includes('keyword'))
})

test('tokens the theme leaves to the tokenizer are dropped, and the rest placed again', () => {
  const map = kindMap(CSHARP_LEGEND)!
  // using UnityEngine;  /  (blank)  /  public sealed AudioBus : ScriptableObject {  /  float volume;
  const data = [
    0, 0, 5, 2, 0, // using: keyword
    0, 6, 11, 5, 0, // UnityEngine: namespace
    2, 4, 6, 2, 0, // public: keyword
    0, 7, 16, 0, 1, // AudioBus: class, static
    0, 19, 8, 0, 0, // ScriptableObject: class
    1, 2, 3, 4, 0, // volume: field
  ]
  assert.deepEqual([...toSemanticTokens({ data }, map)!], [
    0, 6, 11, 5, 0,
    2, 11, 16, 0, 0,
    0, 19, 8, 0, 0,
    1, 2, 3, 3, 0,
  ])
  // A type the legend does not have, and an empty token, colour nothing.
  assert.deepEqual([...toSemanticTokens({ data: [0, 0, 3, 99, 0, 0, 4, 0, 0, 0, 1, 0, 2, 0, 0] }, map)!], [1, 0, 2, 0, 0])
  assert.deepEqual([...toSemanticTokens({ data: [] }, map)!], [])
})

test('a malformed answer colours nothing', () => {
  const map = kindMap(CSHARP_LEGEND)!
  for (const result of [null, 'x', {}, { data: 'x' }, { data: [0, 0, 1, 0] }, { data: [0, -1, 1, 0, 0] }, { data: [0, 0.5, 1, 0, 0] },
    { data: [0, 0, '1', 0, 0] }, { data: [2 ** 31, 0, 1, 0, 0] }, { data: [2 ** 30, 0, 1, 0, 0, 2 ** 30, 0, 1, 0, 0] }]) {
    assert.equal(toSemanticTokens(result, map), null, JSON.stringify(result))
  }
  assert.equal(toSemanticTokens({ data: { length: MAX_TOKENS * 5 + 5 } }, map), null)
  assert.equal(toSemanticTokens({ data: new Array(MAX_TOKENS * 5 + 5).fill(0) }, map), null)
})

test('Mango asks for semantic tokens, and hears when they changed', async () => {
  const caps: any = clientCapabilities(PROFILES.csharp)
  assert.deepEqual(caps.textDocument.semanticTokens.requests, { full: true })
  assert.deepEqual(caps.textDocument.semanticTokens.formats, ['relative'])
  assert.equal(caps.workspace.semanticTokens.refreshSupport, true)
  let told = 0
  const { session, sent, runs } = pretend({ tokensChanged: () => told++ })
  await session.start()
  runs[0]!.receive({ id: 's', method: 'workspace/semanticTokens/refresh' })
  assert.equal(told, 1)
  assert.equal(sent.at(-1).id, 's')
  assert.equal(sent.at(-1).result, null)
  await session.stop()
})

test('no answer is told apart from an answer, so colours that still hold are kept', async () => {
  const { session } = pretend({ silent: ['textDocument/semanticTokens/full'] })
  await session.start()
  session.open({ file: 'a.rs', language: 'rust', text: () => '' })
  assert.equal(await session.ask('textDocument/semanticTokens/full', 'a.rs', {}, { timeout: 5 }), undefined)
  assert.equal(await session.request('textDocument/semanticTokens/full', 'a.rs', {}, { timeout: 5 }), null)
  assert.deepEqual(await session.ask('textDocument/hover', 'a.rs'), [])
  assert.equal(await session.ask('textDocument/hover', 'closed.rs'), undefined)
  await session.stop()
})

test('a session runs on without files while its folder is open', async () => {
  const log: string[] = []
  const open = new Set(['/game'])
  let allowed = true
  const pool = new Pool({
    idleMs: 25,
    allowed: () => allowed,
    live: (key: PoolKey) => open.has(key.root),
    create: (key: PoolKey) => ({
      async start() { log.push(`start ${key.root}`) },
      async stop(now?: boolean) { log.push(`stop ${key.root}${now ? ' now' : ''}`) },
    }),
  })
  const game = { server: 'csharp', root: '/game' }
  pool.update([game])
  pool.update([])
  await tick(45)
  assert.deepEqual(log, ['start /game'], 'its last file closed: the index stays')
  pool.update([game])
  assert.equal(log.length, 1, 'a file opened again finds it running')
  pool.update([])
  open.delete('/game')
  pool.update([])
  await tick(45)
  assert.deepEqual(log, ['start /game', 'stop /game'], 'the project closed: it goes after the wait')
  open.add('/game')
  pool.update([game])
  allowed = false
  pool.update([])
  assert.equal(log.at(-1), 'stop /game now', 'disallowed: at once, open or not')
})
