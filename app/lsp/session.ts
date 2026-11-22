import type { ContentChange, InitializeResult, ServerCapabilities } from './protocol.ts'
import { Rpc, RpcError, isBenign, type RequestOptions } from './rpc.ts'
import { PendingChanges, syncOptions, type EditorChange } from './sync.ts'
import { toMarkers, type Marker } from './convert.ts'
import { clientCapabilities, type ServerProfile } from './languages.ts'
import { fileKey, joinRoot, pathToUri, uriToFile } from './uri.ts'
import { FILE_CHANGED, WatchedFiles, type FileChange } from './watched.ts'

/**
 * One language server in one project folder: its handshake, its open documents, its requests, and
 * starting it again when it dies. Runs in plain Node: the host starts processes and hears about changes.
 */

export interface Connection {
  /** The folder the server runs in, as the backend resolved it. */
  root: string
  /** Mango's process id. */
  pid: number
  send(message: string): void
  kill(): void
}

export type Connect = (handlers: {
  message(text: string): void
  exit(code: number | null, stderr: string): void
}) => Promise<Connection>

export type SessionState = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

export interface SessionView {
  state: SessionState
  /** The work it reports (indexing, loading), while there is some. */
  busy: string | null
  /** Why it failed, or is starting again. */
  error: string | null
}

/** An open file, as the editor has it. */
export interface Document {
  /** Relative to the project folder, forward slashes. */
  file: string
  language: string
  text(): string
}

export interface SessionOptions {
  name: string
  connect: Connect
  profile: ServerProfile
  changed(view: SessionView): void
  diagnostics(file: string, markers: Marker[]): void
  /** The waits before each restart after a crash. */
  backoff?: number[]
}

interface Doc extends Document {
  uri: string
  version: number
  opened: boolean
  pending: PendingChanges
  timer?: ReturnType<typeof setTimeout>
}

const INITIALIZE_TIMEOUT = 60_000
/** A server slower than this to answer `shutdown` or to leave after `exit` is killed. */
const SHUTDOWN_TIMEOUT = 1000
/** Edits go out this long after the last one, or with the next request, whichever is first. */
const CHANGE_DELAY = 250
const BACKOFF = [1000, 5000, 15_000]
/** Running this long, a crash is a new problem and gets all the retries again. */
const STABLE = 180_000
/** Diagnostics kept for files that are not open (a server may not send them again on opening). */
const MAX_REPORTED = 2000
const MAX_REASON = 300

/** A failed server's stderr in one line: the line that says what went wrong, else the last one. */
export function crashReason(name: string, code: number | null, stderr: string): string {
  const lines = stderr.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-30)
  const said = lines.find(l => /\b(error|panicked|fatal|exception|not found|cannot|failed)\b/i.test(l)) ?? lines.at(-1)
  const ended = code === null ? `${name} stopped.` : `${name} stopped with code ${code}.`
  return said ? `${ended} ${said.slice(0, MAX_REASON)}` : ended
}

export class Session {
  view: SessionView = { state: 'stopped', busy: null, error: null }
  caps: ServerCapabilities = {}
  /** The folder the server runs in; null until it started. */
  root: string | null = null

  private options: SessionOptions
  private connection: Connection | null = null
  private rpc: Rpc | null = null
  private sync = syncOptions({})
  private docs = new Map<string, Doc>()
  private reported = new Map<string, Marker[]>()
  private progress = new Map<string | number, { title: string; message: string; percentage: number | null }>()
  private watched: WatchedFiles | null = null
  /** A connection belongs to the attempt that made it: one of an attempt given up on is killed. */
  private attempt = 0
  private crashes = 0
  private readyAt = 0
  private restartTimer?: ReturnType<typeof setTimeout>
  private exited?: () => void
  /** Each file's last version, so one opened again never repeats one. */
  private versions = new Map<string, number>()

  constructor(options: SessionOptions) {
    this.options = options
  }

  get ready() { return this.view.state === 'ready' }

  private set(view: Partial<SessionView>) {
    this.view = { ...this.view, ...view }
    this.options.changed(this.view)
  }

  private key(file: string) {
    return fileKey(this.root ?? '', file)
  }

  private doc(file: string): Doc | undefined {
    // Keyed by the editor's spelling; a server may spell it in another case.
    const exact = this.docs.get(file)
    if (exact) return exact
    const key = this.key(file)
    for (const doc of this.docs.values()) if (this.key(doc.file) === key) return doc
  }

  /* ---------- life */

  async start() {
    if (this.view.state === 'starting' || this.view.state === 'ready') return
    clearTimeout(this.restartTimer)
    const attempt = ++this.attempt
    const current = () => attempt === this.attempt
    this.set({ state: 'starting', busy: null, error: null })
    try {
      const connection = await this.options.connect({
        message: (text) => { if (current()) this.rpc?.receive(text) },
        exit: (code, stderr) => {
          if (!current()) return
          if (this.exited) return this.exited()
          this.crashed(crashReason(this.options.name, code, stderr))
        },
      })
      // Stopped, or already gone, while it started.
      if (!current()) return connection.kill()
      this.connection = connection
      this.root = connection.root
      this.watched = new WatchedFiles(connection.root)
      this.rpc = new Rpc(message => connection.send(message), {
        request: (method, params) => this.answer(method, params),
        notification: (method, params) => this.hear(method, params),
      })
    } catch (e) {
      // It could not be started at all (not installed, refused): trying again would not help.
      if (current()) this.fail(String(e instanceof Error ? e.message : e))
      return
    }
    await this.initialize(attempt)
  }

  private async initialize(attempt: number) {
    const { pid, root } = this.connection!
    const uri = pathToUri(root)
    try {
      const result = await this.rpc!.request<InitializeResult>('initialize', {
        processId: pid,
        clientInfo: { name: 'Mango' },
        locale: 'en',
        rootPath: root,
        rootUri: uri,
        workspaceFolders: [{ uri, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root }],
        capabilities: clientCapabilities(this.options.profile),
        initializationOptions: this.options.profile.initializationOptions,
        trace: 'off',
      }, { timeout: INITIALIZE_TIMEOUT })
      if (attempt !== this.attempt) return
      const caps = result?.capabilities ?? {}
      if (caps.positionEncoding && caps.positionEncoding !== 'utf-16') {
        return this.fail(`${this.options.name} counts columns in ${caps.positionEncoding}, which Mango does not support.`)
      }
      this.caps = caps
      this.sync = syncOptions(caps)
      this.rpc!.notify('initialized', {})
      if (this.options.profile.settings) this.rpc!.notify('workspace/didChangeConfiguration', { settings: this.options.profile.settings })
      for (const doc of this.docs.values()) this.didOpen(doc)
      this.readyAt = Date.now()
      this.set({ state: 'ready', error: null })
    } catch (e) {
      if (attempt !== this.attempt) return
      this.crashed(`${this.options.name} could not start: ${e instanceof RpcError ? e.message.slice(0, MAX_REASON) : String(e)}`)
    }
  }

  /** Let go of the process and everything learned from it; the open documents stay. */
  private drop() {
    this.attempt++
    clearTimeout(this.restartTimer)
    this.rpc?.close()
    this.rpc = null
    this.connection?.kill()
    this.connection = null
    this.caps = {}
    this.sync = syncOptions({})
    this.watched = null
    this.exited = undefined
    this.progress.clear()
    for (const doc of this.docs.values()) {
      clearTimeout(doc.timer)
      doc.timer = undefined
      doc.opened = false
      this.options.diagnostics(doc.file, [])
    }
    this.reported.clear()
  }

  private fail(error: string) {
    this.drop()
    this.set({ state: 'failed', busy: null, error })
  }

  private crashed(error: string) {
    if (this.readyAt && Date.now() - this.readyAt > STABLE) this.crashes = 0
    this.readyAt = 0
    const delay = (this.options.backoff ?? BACKOFF)[this.crashes++]
    if (delay === undefined) return this.fail(error)
    this.drop()
    this.set({ state: 'restarting', busy: null, error })
    this.restartTimer = setTimeout(() => void this.start(), delay)
  }

  /** The user's "try again". */
  retry() {
    if (this.view.state !== 'failed') return
    this.crashes = 0
    void this.start()
  }

  /** Ask it to leave, then make sure. `now`: it may not run any more, so it is killed unasked. */
  async stop(now = false) {
    const { rpc, connection, ready } = this
    clearTimeout(this.restartTimer)
    // Providers see it gone at once, however long leaving takes.
    this.set({ state: 'stopped', busy: null, error: null })
    if (!now && ready && rpc && connection) {
      const gone = new Promise<void>((resolve) => {
        this.exited = () => {
          resolve()
          rpc.close()
        }
      })
      try {
        await rpc.request('shutdown', undefined, { timeout: SHUTDOWN_TIMEOUT })
        rpc.notify('exit')
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([gone, new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT) })])
        clearTimeout(timer)
      } catch { /* killed below */ }
    }
    this.drop()
  }

  /* ---------- documents */

  open(document: Document) {
    if (this.docs.has(document.file)) return
    const doc: Doc = { ...document, uri: '', version: this.versions.get(document.file) ?? 0, opened: false, pending: new PendingChanges() }
    this.docs.set(document.file, doc)
    if (!this.ready) return
    this.didOpen(doc)
    const known = this.reported.get(this.key(doc.file))
    if (known) this.options.diagnostics(doc.file, known)
  }

  private didOpen(doc: Doc) {
    doc.uri = pathToUri(joinRoot(this.root!, doc.file))
    doc.pending = new PendingChanges()
    doc.version++
    doc.opened = true
    if (this.sync.openClose) {
      this.rpc!.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.language, version: doc.version, text: doc.text() } })
    }
  }

  /** `changes` null: the whole text was replaced. Costs nothing but the note until it is flushed. */
  change(file: string, changes: readonly EditorChange[] | null) {
    const doc = this.docs.get(file)
    // Not sent yet: didOpen will carry the text as it is then.
    if (!doc?.opened) return
    doc.pending.add(changes)
    clearTimeout(doc.timer)
    doc.timer = setTimeout(() => this.flush(doc), CHANGE_DELAY)
  }

  private flush(doc: Doc) {
    clearTimeout(doc.timer)
    doc.timer = undefined
    if (!doc.opened || doc.pending.empty) return
    const contentChanges: ContentChange[] = doc.pending.take(this.sync.change, doc.text)
    if (!contentChanges.length) return
    doc.version++
    this.rpc?.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges })
  }

  flushAll() {
    for (const doc of this.docs.values()) this.flush(doc)
  }

  save(file: string) {
    const doc = this.docs.get(file)
    if (!this.ready || !doc) return
    this.flush(doc)
    if (!this.sync.save) return
    this.rpc!.notify('textDocument/didSave', { textDocument: { uri: doc.uri }, ...(this.sync.save.includeText ? { text: doc.text() } : {}) })
  }

  close(file: string) {
    const doc = this.docs.get(file)
    if (!doc) return
    this.flush(doc)
    this.docs.delete(file)
    this.versions.set(file, doc.version)
    if (doc.opened && this.sync.openClose) this.rpc?.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    this.options.diagnostics(file, [])
  }

  /** Files that changed on disk, for a server that asked Mango to tell it. */
  filesChanged(changes: Array<{ file: string; type: FileChange }>) {
    const { root, watched } = this
    if (!this.ready || !root || !watched || watched.empty) return
    const wanted = changes.filter(c => watched.wants(c.file, c.type) || (c.type !== FILE_CHANGED && watched.wants(c.file, FILE_CHANGED)))
    if (!wanted.length) return
    this.rpc!.notify('workspace/didChangeWatchedFiles', { changes: wanted.map(c => ({ uri: pathToUri(joinRoot(root, c.file)), type: c.type })) })
  }

  /* ---------- requests */

  /**
   * Ask about an open file. The edits so far go first, every file's: an answer about one can hang
   * on another's. Null when there is nothing to say (not ready, cancelled, out of time).
   */
  async request<T>(method: string, file: string, params: object = {}, options: RequestOptions = {}): Promise<T | null> {
    // Monaco can ask from inside the very change it asks about, before that change was noted here.
    await null
    const doc = this.docs.get(file)
    if (!this.ready || !doc?.opened) return null
    return this.send<T>(method, { textDocument: { uri: doc.uri }, ...params }, options)
  }

  /** A request that names no document itself (`completionItem/resolve`). */
  async send<T>(method: string, params: unknown, options: RequestOptions = {}): Promise<T | null> {
    if (!this.ready || options.token?.isCancellationRequested) return null
    this.flushAll()
    try {
      return await this.rpc!.request<T>(method, params, options)
    } catch (e) {
      if (!isBenign(e)) console.warn(`${this.options.name} ${method}:`, e instanceof Error ? e.message : e)
      return null
    }
  }

  /* ---------- what the server says */

  private answer(method: string, params: any): unknown {
    switch (method) {
      case 'workspace/configuration': {
        const items: unknown[] = Array.isArray(params?.items) ? params.items : []
        const settings = this.options.profile.settings ?? {}
        return items.map((item: any) => (typeof item?.section === 'string' && Object.hasOwn(settings, item.section) ? settings[item.section] : null))
      }
      case 'workspace/workspaceFolders': {
        const root = this.root!
        return [{ uri: pathToUri(root), name: root.split(/[\\/]/).filter(Boolean).pop() ?? root }]
      }
      case 'client/registerCapability': {
        for (const r of Array.isArray(params?.registrations) ? params.registrations : []) {
          if (r?.method === 'workspace/didChangeWatchedFiles') this.watched?.register(String(r.id), r.registerOptions?.watchers)
        }
        return null
      }
      case 'client/unregisterCapability': {
        // The misspelling is the protocol's.
        for (const r of Array.isArray(params?.unregisterations) ? params.unregisterations : []) this.watched?.unregister(String(r?.id))
        return null
      }
      case 'window/workDoneProgress/create':
      case 'workspace/diagnostic/refresh':
      case 'window/showMessageRequest':
        return null
      case 'window/showDocument':
        return { success: false }
      case 'workspace/applyEdit':
        return { applied: false, failureReason: 'Mango lets a language server edit only through the completion the user picks.' }
    }
  }

  private hear(method: string, params: any) {
    if (method === 'textDocument/publishDiagnostics') return this.publish(params)
    if (method === '$/progress') return this.progressed(params)
  }

  private publish(params: any) {
    const root = this.root
    if (!root) return
    const file = uriToFile(root, params?.uri)
    if (file === null) return
    const doc = this.doc(file)
    if (doc && typeof params.version === 'number' && params.version < doc.version) return
    const markers = toMarkers(params.diagnostics)
    const key = this.key(file)
    this.reported.delete(key)
    if (markers.length) this.reported.set(key, markers)
    if (this.reported.size > MAX_REPORTED) this.reported.delete(this.reported.keys().next().value!)
    if (doc) this.options.diagnostics(doc.file, markers)
  }

  private progressed(params: any) {
    const { token, value } = params ?? {}
    if ((typeof token !== 'string' && typeof token !== 'number') || !value) return
    if (value.kind === 'end') {
      this.progress.delete(token)
    } else {
      const had = this.progress.get(token)
      if (value.kind !== 'begin' && !had) return
      this.progress.set(token, {
        title: value.kind === 'begin' ? String(value.title ?? '') : had!.title,
        message: typeof value.message === 'string' ? value.message : had?.message ?? '',
        percentage: typeof value.percentage === 'number' ? Math.round(value.percentage) : had?.percentage ?? null,
      })
    }
    const first = this.progress.values().next().value
    const busy = first
      ? `${[first.title, first.message].filter(Boolean).join(': ') || 'Working'}`.slice(0, 120) + (first.percentage === null ? '' : ` (${first.percentage}%)`)
      : null
    if (busy !== this.view.busy) this.set({ busy })
  }
}
