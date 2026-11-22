import type * as Monaco from 'monaco-editor'
import { effectScope, watch } from 'vue'
import type { LspServerId } from '~/types/ipc'
import { Session, type Connect } from '~/lsp/session'
import { Pool, poolKey, type PoolKey } from '~/lsp/pool'
import { PROFILES, lspLanguage } from '~/lsp/languages'
import { FILE_CHANGED, FILE_CREATED, FILE_DELETED, type FileChange } from '~/lsp/watched'
import { joinRoot, relativeTo } from '~/lsp/uri'
import { PROVIDES, languageProviders, type Feature, type Served } from '~/lsp/providers'
import { useLanguageServers } from '~/lsp/store'
import { call, on } from '~/composables/useBackend'
import { useFiles } from '~/stores/files'
import { useGit } from '~/stores/git'
import { isBusy, useThreads } from '~/stores/threads'
import { useWorkspace } from '~/stores/workspace'
import { editorModel } from '~/utils/editorModels'
import { isEnvPath } from '~/utils/envPath'
import { reloadDocument } from '~/composables/editorDocuments'
import type { MonacoApi } from '~/composables/monaco'

/**
 * Runs the language servers for the open files: one per server and project folder, only where the
 * user allowed them, started when a file needs one. Loaded with the editor and lives as long as the window.
 */

const MARKERS = 'mango-lsp'
/** The markers Monaco's TypeScript worker sets, by their owner. */
const WORKER_MARKERS = ['typescript', 'javascript']
/** After focus or an agent's turn, git's list catches up before servers are told. */
const CATCH_UP_MS = 1500
/** More changed files than this are not listed to a server one by one. */
const MAX_FILE_EVENTS = 500

interface Binding extends PoolKey<LspServerId> {
  tabId: string
  /** The file's name when it was bound: a rename binds it again. */
  file: string
  language: string
  model: Monaco.editor.ITextModel
  session: Session
  modifiedMs: number
  disk: string | null
  subs: Monaco.IDisposable[]
}

interface LanguageService {
  /** A tab's model was made or replaced. */
  track(): void
  served(model: Monaco.editor.ITextModel, feature: Feature): Served | null
  retry(key: PoolKey<LspServerId>): void
}

let service: LanguageService | null = null

export const languageService = () => service

export function startLanguageService(monaco: MonacoApi): LanguageService {
  return (service ??= effectScope(true).run(() => create(monaco))!)
}

/* ---------- the backend's processes */

const processes = new Map<string, Parameters<Connect>[0]>()
let listening: Promise<unknown> | null = null

function listen() {
  return (listening ??= Promise.all([
    on('lsp://message', e => processes.get(e.id)?.message(e.message)),
    on('lsp://exit', (e) => {
      const process = processes.get(e.id)
      processes.delete(e.id)
      process?.exit(e.code, e.stderr)
    }),
  ]).catch((e) => {
    listening = null
    throw e
  }))
}

function connector(key: PoolKey<LspServerId>): Connect {
  return async (handlers) => {
    await listen()
    // The last word before a process starts: the answer may have changed meanwhile.
    if (!useLanguageServers().allowed(key.root)) throw new Error('Language servers are off for this project.')
    const id = crypto.randomUUID()
    processes.set(id, handlers)
    try {
      const { root, pid } = await call('lsp_start', { id, root: key.root, server: key.server })
      let queue: Promise<unknown> = Promise.resolve()
      let killed = false
      return {
        root,
        pid,
        // One after another: a change that overtook the one before would corrupt the server's copy.
        send(message) {
          queue = queue.then(() => (killed ? undefined : call('lsp_send', { id, message }))).catch(() => {})
        },
        kill() {
          if (killed) return
          killed = true
          processes.delete(id)
          void call('lsp_stop', { id }).catch(() => {})
        },
      }
    } catch (e) {
      processes.delete(id)
      throw e
    }
  }
}

/* ---------- */

function create(monaco: MonacoApi): LanguageService {
  const store = useLanguageServers()
  const files = useFiles()
  const threads = useThreads()
  const ws = useWorkspace()
  const git = useGit()

  const bindings = new Map<string, Binding>()
  const byModel = new Map<Monaco.editor.ITextModel, Binding>()

  function served(model: Monaco.editor.ITextModel, feature: Feature): Served | null {
    const b = byModel.get(model)
    return b?.session.ready && PROVIDES[feature](b.session.caps) ? { session: b.session, file: b.file, project: b.root } : null
  }
  const ensureProviders = languageProviders(monaco, served)

  /** Monaco's worker checks files a server checks too: the server's word is enough. */
  function hushWorker(model: Monaco.editor.ITextModel) {
    if (!byModel.get(model)?.session.ready) return
    for (const owner of WORKER_MARKERS) {
      if (monaco.editor.getModelMarkers({ resource: model.uri, owner }).length) monaco.editor.setModelMarkers(model, owner, [])
    }
  }

  let wake: ReturnType<typeof setTimeout> | undefined
  /** A server went: the worker looks at its files again. */
  function wakeWorker() {
    clearTimeout(wake)
    wake = setTimeout(() => {
      const defaults = [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]
      for (const d of defaults) d.setDiagnosticsOptions({ ...d.getDiagnosticsOptions() })
    }, 300)
  }

  const pool = new Pool<LspServerId, Session>({
    allowed: key => store.allowed(key.root),
    create(key) {
      const id = poolKey(key)
      const name = store.servers?.find(s => s.id === key.server)?.name ?? key.server
      let ready = false
      const session: Session = new Session({
        name,
        profile: PROFILES[key.server],
        connect: connector(key),
        changed(view) {
          if (view.state === 'stopped') delete store.sessions[id]
          else store.sessions[id] = view
          if (ready === (view.state === 'ready')) return
          ready = view.state === 'ready'
          for (const b of byModel.values()) {
            if (b.session !== session) continue
            if (ready) {
              ensureProviders(b.model.getLanguageId(), session.caps)
              hushWorker(b.model)
            }
          }
          if (!ready && key.server === 'typescript') wakeWorker()
        },
        diagnostics(file, markers) {
          for (const b of byModel.values()) {
            if (b.session === session && b.file === file && !b.model.isDisposed()) monaco.editor.setModelMarkers(b.model, MARKERS, markers)
          }
        },
      })
      return session
    },
  })

  function unbind(b: Binding, disposing = false) {
    if (bindings.get(b.tabId) === b) bindings.delete(b.tabId)
    if (byModel.get(b.model) === b) byModel.delete(b.model)
    b.subs.forEach(sub => sub.dispose())
    b.session.close(b.file)
    if (disposing || b.model.isDisposed()) return
    monaco.editor.setModelMarkers(b.model, MARKERS, [])
    if (b.server === 'typescript' && b.session.ready) wakeWorker()
  }

  function bind(want: Omit<Binding, 'session' | 'subs' | 'modifiedMs' | 'disk'>, session: Session) {
    const f = files.open[want.tabId]!
    const b: Binding = { ...want, session, modifiedMs: f.modifiedMs, disk: f.disk, subs: [] }
    bindings.set(b.tabId, b)
    byModel.set(b.model, b)
    b.subs.push(
      b.model.onDidChangeContent(e => session.change(b.file, e.isFlush || e.isEolChange ? null : e.changes)),
      // While its text can still be read.
      b.model.onWillDispose(() => unbind(b, true)),
    )
    session.open({ file: b.file, language: b.language, text: () => b.model.getValue() })
    if (!session.ready) return
    ensureProviders(b.model.getLanguageId(), session.caps)
    hushWorker(b.model)
  }

  /** Bring sessions and documents in step with the open tabs. */
  function update() {
    const wanted = new Map<string, Omit<Binding, 'session' | 'subs' | 'modifiedMs' | 'disk'>>()
    for (const [tabId, f] of Object.entries(files.open)) {
      const model = editorModel(tabId)?.model
      if (!model || model.isDisposed() || !store.allowed(f.projectPath)) continue
      const language = lspLanguage(f.file, model.getLanguageId())
      const server = store.serverFor(language)
      if (server) wanted.set(tabId, { tabId, file: f.file, language, model, server: server.id, root: f.projectPath })
    }
    const renamed: Array<{ root: string; from: string; to: string }> = []
    for (const b of [...bindings.values()]) {
      const w = wanted.get(b.tabId)
      if (w && w.model === b.model && w.server === b.server && w.language === b.language) continue
      for (const next of wanted.values()) {
        if (next.model === b.model && next.file !== b.file) renamed.push({ root: b.root, from: b.file, to: next.file })
      }
      unbind(b)
    }
    // Every time: this also starts and ends the idle waits.
    pool.update(wanted.values())
    for (const want of wanted.values()) {
      if (bindings.has(want.tabId)) continue
      const session = pool.get(want)
      if (session) bind(want, session)
    }
    for (const r of renamed) {
      tellFiles(r.root, [{ file: r.from, type: FILE_DELETED }, { file: r.to, type: FILE_CREATED }])
    }
  }

  /* ---------- following the app */

  watch(() => ws.editorLanguageServers, (on) => { if (on) void store.load() }, { immediate: true })
  watch(() => [
    ws.editorLanguageServers,
    store.servers?.map(s => `${s.id}${s.installed}`).join(),
    // A tab, or a worktree changing whose project it is.
    ...Object.entries(files.open).map(([id, f]) => `${id}\n${store.allowed(f.projectPath)}`),
    // A project's answer, also while only an idle server is left of it.
    ...Object.entries(ws.projectPrefs).map(([path, p]) => (p.languageServers ? path : '')),
  ].join('\0'), update)
  monaco.editor.onDidChangeModelLanguage(update)

  // Installed or updated in Settings: what could not run may now.
  watch(() => store.servers, () => {
    for (const { key, session } of pool.all()) if (store.servers?.some(s => s.id === key.server && s.installed)) session.retry()
  })

  monaco.editor.onDidChangeMarkers((uris) => {
    for (const uri of uris) {
      const model = monaco.editor.getModel(uri)
      if (model) hushWorker(model)
    }
  })

  // Files read again from disk reach their models also while no pane shows them, and saves reach the servers.
  watch(() => Object.entries(files.open).map(([id, f]) => [id, f.version, f.modifiedMs, f.disk] as const), (open) => {
    for (const [id, version, modifiedMs, disk] of open) {
      const f = files.open[id]
      const entry = editorModel(id)
      if (!f || !entry || entry.model.isDisposed()) continue
      if (entry.loadedVersion !== version) reloadDocument(monaco, entry, f)
      const b = bindings.get(id)
      if (!b || (b.modifiedMs === modifiedMs && b.disk === disk)) continue
      b.modifiedMs = modifiedMs
      b.disk = disk
      b.session.save(b.file)
    }
  })

  /* ---------- changes outside the editor, for the servers that leave watching to Mango */

  function watchingRoots() {
    return pool.all().filter(({ key }) => PROFILES[key.server].clientWatches).map(({ key }) => key.root)
  }
  function tellFiles(root: string, changes: Array<{ file: string; type: FileChange }>) {
    for (const { key, session } of pool.all()) if (key.root === root) session.filesChanged(changes.slice(0, MAX_FILE_EVENTS))
  }

  /** What git lists as changed in a folder, as a way to see files change without watching the disk. */
  const listed = new Map<string, { head: string | null; files: Map<string, FileChange> }>()
  function fromGit(root: string, again = false) {
    const status = git.status(root)
    if (!status) return
    const now = new Map<string, FileChange>()
    const add = (path: string | null, type: FileChange) => {
      const file = path ? relativeTo(root, joinRoot(status.root ?? root, path)) : null
      if (file) now.set(file, type)
    }
    for (const f of status.files) {
      add(f.origPath, FILE_DELETED)
      add(f.path, f.worktree === 'D' || (f.index === 'D' && !f.worktree) ? FILE_DELETED : f.worktree === '?' || f.index === 'A' ? FILE_CREATED : FILE_CHANGED)
    }
    const before = listed.get(root)
    listed.set(root, { head: status.head, files: now })
    const changes: Array<{ file: string; type: FileChange }> = []
    // Again: git says no more about a file that changed once more.
    for (const [file, type] of now) if (again || before?.files.get(file) !== type) changes.push({ file, type })
    for (const [file, type] of before?.files ?? []) {
      if (now.has(file)) continue
      // Gone from the list: put back, committed, or a new file that was deleted.
      const back = type === FILE_DELETED ? FILE_CREATED : type === FILE_CREATED && before!.head === status.head ? FILE_DELETED : FILE_CHANGED
      changes.push({ file, type: back })
    }
    if (changes.length) tellFiles(root, changes)
  }
  watch(() => Object.keys(store.sessions).map(id => git.status(id.slice(id.indexOf('\0') + 1))), () => {
    for (const root of watchingRoots()) fromGit(root)
  })

  let catchUp: ReturnType<typeof setTimeout> | undefined
  function catchUpSoon() {
    clearTimeout(catchUp)
    if (!watchingRoots().length) return
    catchUp = setTimeout(() => {
      for (const root of watchingRoots()) if (!isEnvPath(root)) fromGit(root, true)
    }, CATCH_UP_MS)
  }
  window.addEventListener('focus', catchUpSoon)
  window.addEventListener('mango:files-changed', catchUpSoon)
  watch(() => threads.threads.filter(isBusy).length, (now, before) => { if (now < before) catchUpSoon() })
  window.addEventListener('pagehide', () => pool.stopAll())

  return {
    track: update,
    served,
    retry: key => pool.get(key)?.retry(),
  }
}
