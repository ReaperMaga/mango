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
import { WatchedFiles, FILE_CHANGED, FILE_CREATED, FILE_DELETED, globToRegExp } from '../app/lsp/watched.ts'
import { Session, crashReason, type SessionView } from '../app/lsp/session.ts'
import { Pool, type PoolKey } from '../app/lsp/pool.ts'
import { lspLanguage } from '../app/lsp/languages.ts'

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
  assert.ok(globToRegExp('**/*.{rs,toml}')!.test('Cargo.toml'))
  assert.ok(globToRegExp('**/*.{rs,toml}')!.test('a/b/c.rs'))
  assert.ok(!globToRegExp('*.rs')!.test('a/c.rs'))
  assert.equal(globToRegExp('{oops'), null)
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

function pretend(options: { caps?: object; backoff?: number[]; silent?: string[]; refuse?: string; slowStart?: Promise<void> } = {}) {
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
