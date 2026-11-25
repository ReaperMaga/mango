/**
 * A planner server's space (`planner-server/`, `planner-server/PROTOCOL.md`): documents read and written over HTTP, and
 * everyone's writes heard as they happen on an event stream, which comes back by itself after a lost connection.
 *
 * Chat links mean something on this computer only: they are taken out of what is sent, kept here (`storage`), and put
 * back into what is read. Other people's links never show.
 *
 * Nothing is kept here while offline: the store holds changes that wait (`offline`), and the collections of a server
 * that cannot be reached do not show until it can.
 */

import type { PluginStorageApi } from '../host.ts'
import { isPersonId, isPersonName, type People, type Person } from '../model.ts'
import { applyPatch, isObject, isSafeKey, type JsonObject, type PatchOp } from '../patch.ts'
import { SourceError, type PlannerSource, type SourceDoc, type SourceErrorKind, type SourceOp, type SourceStatus } from './source.ts'

export const PROTOCOL = 1

export interface RemoteConfig {
  /** `https://planner.example.com`, without a trailing slash. */
  readonly url: string
  readonly token: string
}

export interface RemoteHello {
  readonly protocol: number
  readonly server: string
  readonly space: { readonly id: string; readonly name: string }
  readonly role: 'read' | 'write'
  /** The person this token is for. Null from a server older than people. */
  readonly me: { readonly id: string; readonly name: string } | null
  readonly seq: number
}

export interface RemoteHost {
  readonly storage: Pick<PluginStorageApi, 'get' | 'set'>
  readonly log: { warn(...args: unknown[]): void }
  /** Left out: the global one. */
  readonly fetch?: typeof fetch
}

export interface RemoteOptions {
  /** How long a request may take. */
  readonly timeoutMs?: number
  /** The first wait before connecting again; it doubles up to `maxRetryMs`. */
  readonly retryMs?: number
  readonly maxRetryMs?: number
  /** Without a byte from the server (it pings every 25 s), the stream counts as lost. */
  readonly silenceMs?: number
}

/** `https://host:port/path` as the server is addressed, or null when it is not an address. */
export function serverUrl(input: string): string | null {
  let text = input.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const SECOND = 1000
const STATUS_CONNECTING: SourceStatus = { online: false, readonly: false, message: 'Connecting to the planner server…' }

type Chats = Record<string, number>
type ChatsBook = Record<string, Chats>

interface ErrorAnswer { error?: { code?: unknown; message?: unknown } }

/** By the protocol's table of errors. */
function kindOfStatus(status: number, code: string): SourceErrorKind {
  if (status === 401 || status === 403) return 'refused'
  if (status === 429 || status === 502 || status === 503 || status === 504) return 'offline'
  if (status >= 500) return 'unknown'
  if (status >= 400) return code === 'unauthorized' || code === 'forbidden' ? 'refused' : 'invalid'
  return 'unknown'
}

function isDocShape(v: unknown): v is SourceDoc {
  if (!isObject(v)) return false
  return (v.kind === 'collection' || v.kind === 'item') && typeof v.id === 'string' && typeof v.collectionId === 'string'
    && typeof v.seq === 'number' && (v.data === null || isObject(v.data))
}

function docsOf(answer: unknown): SourceDoc[] {
  const list = isObject(answer) && Array.isArray(answer.docs) ? answer.docs : null
  if (!list) throw new SourceError('unknown', 'The planner server answered something this version of the planner does not read.')
  return (list as unknown[]).filter(isDocShape).map(d => ({
    kind: d.kind,
    id: d.id,
    collectionId: d.collectionId,
    seq: d.seq,
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : 0,
    data: d.data,
  }))
}

function chatsOf(v: unknown): Chats {
  const out: Chats = {}
  if (Array.isArray(v)) v.forEach((id, i) => { if (typeof id === 'string' && isSafeKey(id)) out[id] = i })
  else if (isObject(v)) for (const [id, at] of Object.entries(v)) if (isSafeKey(id)) out[id] = typeof at === 'number' ? at : 0
  return out
}

/** Reads `event:` / `data:` blocks out of a byte stream as it comes. */
export class EventReader {
  private buffer = ''
  private event = ''
  private data: string[] = []
  private readonly emit: (event: string, data: string) => void

  constructor(emit: (event: string, data: string) => void) {
    this.emit = emit
  }

  push(text: string) {
    this.buffer += text
    for (;;) {
      const at = this.buffer.search(/\r\n|\r|\n/)
      if (at < 0) return
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + (this.buffer.startsWith('\r\n', at) ? 2 : 1))
      this.line(line)
    }
  }

  private line(line: string) {
    if (line === '') {
      if (this.data.length) this.emit(this.event || 'message', this.data.join('\n'))
      this.event = ''
      this.data = []
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
  }
}

/** A person as the server sends them, checked; null when it is not one. */
export function personOf(v: unknown): Person | null {
  if (!isObject(v) || !isPersonId(v.id) || !isPersonName(v.name)) return null
  return { id: v.id, name: v.name, active: v.active !== false }
}

/** The answer of `GET /v1/people` (and `POST /v1/me`), checked. */
function peopleOf(answer: unknown, me: string | null): People {
  const a = isObject(answer) ? answer : {}
  const seen = new Set<string>()
  const all = (Array.isArray(a.people) ? a.people : []).flatMap((v) => {
    const p = personOf(v)
    if (!p || seen.has(p.id)) return []
    seen.add(p.id)
    return [p]
  })
  return { me: personOf(a.me)?.id ?? me, all }
}

/** Asks the server who it is and what this token may do. Throws a `SourceError` otherwise. */
export async function hello(config: RemoteConfig, fetcher: typeof fetch = globalThis.fetch, timeoutMs = 15 * SECOND): Promise<RemoteHello> {
  const answer = await request(config, fetcher, timeoutMs, 'GET', '/v1/hello')
  return checkHello(answer)
}

function checkHello(answer: unknown): RemoteHello {
  const a = isObject(answer) ? answer : {}
  const space = isObject(a.space) ? a.space : {}
  if (typeof a.protocol !== 'number' || typeof space.id !== 'string') {
    throw new SourceError('invalid', 'That address does not answer like a planner server.')
  }
  if (a.protocol !== PROTOCOL) {
    throw new SourceError('invalid', `The planner server speaks version ${a.protocol} of the protocol, this planner ${PROTOCOL}. Update the older one.`)
  }
  return {
    protocol: a.protocol,
    server: typeof a.server === 'string' ? a.server : '',
    space: { id: space.id, name: typeof space.name === 'string' && space.name ? space.name : space.id },
    role: a.role === 'write' ? 'write' : 'read',
    me: personOf(a.me),
    seq: typeof a.seq === 'number' ? a.seq : 0,
  }
}

async function request(config: RemoteConfig, fetcher: typeof fetch, timeoutMs: number, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const stop = () => abort.abort()
  signal?.addEventListener('abort', stop)
  let response: Response
  try {
    response = await fetcher(config.url + path, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch {
    throw new SourceError('offline', abort.signal.aborted && !signal?.aborted
      ? 'The planner server did not answer in time.'
      : 'The planner server cannot be reached.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
  let answer: unknown = null
  try {
    answer = await response.json()
  } catch {
    if (response.ok) throw new SourceError('unknown', 'The planner server answered something that is not JSON.')
  }
  if (response.ok) return answer
  const error = (answer as ErrorAnswer | null)?.error
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' && error.message ? error.message : `The planner server answered ${response.status}.`
  throw new SourceError(kindOfStatus(response.status, code), message)
}

export class RemoteSource implements PlannerSource {
  label: string
  readonly config: RemoteConfig
  private readonly host: RemoteHost
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly retryMs: number
  private readonly maxRetryMs: number
  private readonly silenceMs: number
  private readonly chatsKey: string

  private current: SourceStatus = STATUS_CONNECTING
  private readonly handlers = new Set<(docs: SourceDoc[]) => void>()
  private readonly resyncs = new Set<() => void>()
  private readonly statusHandlers = new Set<(status: SourceStatus) => void>()
  private readonly peopleHandlers = new Set<() => void>()
  /** Who may be assigned, as last heard; null until the stream said who this token is. */
  private people: People | null = null
  private peopleAsked: Promise<void> | null = null

  /** The last `seq` heard on the stream: where it goes on after a lost connection. */
  private seq = 0
  /** Read before the stream said where the space stands: what it missed in between is asked for then. */
  private readBefore = 0
  private heard = false
  private stream: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private silence: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private disposed = false
  private readonly onBrowserOnline = () => { if (!this.current.online) this.reconnectSoon(0) }

  constructor(config: RemoteConfig, host: RemoteHost, options: RemoteOptions = {}) {
    this.config = config
    this.host = host
    this.fetcher = host.fetch ?? ((...args) => globalThis.fetch(...args))
    this.timeoutMs = options.timeoutMs ?? 30 * SECOND
    this.retryMs = options.retryMs ?? SECOND
    this.maxRetryMs = options.maxRetryMs ?? 30 * SECOND
    this.silenceMs = options.silenceMs ?? 60 * SECOND
    this.label = new URL(config.url).host
    this.chatsKey = `remoteChats:${config.url}`
    if (typeof window !== 'undefined') window.addEventListener('online', this.onBrowserOnline)
    void this.connect()
  }

  /* ---- reading */

  async loadCollections(): Promise<SourceDoc[]> {
    return this.read('/v1/collections')
  }

  async loadItems(collectionId: string): Promise<SourceDoc[]> {
    return this.read(`/v1/collections/${encodeURIComponent(collectionId)}/items`)
  }

  private async read(path: string): Promise<SourceDoc[]> {
    const answer = await this.call('GET', path)
    if (!this.heard && isObject(answer) && typeof answer.seq === 'number') this.readBefore = Math.max(this.readBefore, answer.seq)
    return this.withChats(docsOf(answer))
  }

  /* ---- writing */

  async write(ops: readonly SourceOp[], mutationId: string): Promise<SourceDoc[]> {
    if (this.current.readonly) throw new SourceError('refused', this.current.message ?? 'The planner server only lets this token read.')
    const book = this.chats()
    let changed = false
    const sent = ops.map((op): SourceOp => {
      if (op.kind !== 'item') return op
      if (op.op === 'create') {
        if (op.data.chats === undefined) return op
        const { chats: _chats, ...data } = op.data
        return { ...op, data }
      }
      if (op.op === 'patch') return { ...op, patch: op.patch.filter(p => p.path[0] !== 'chats') }
      return op
    })
    const answer = await this.call('POST', '/v1/write', { mutationId, ops: sent })
    // Written: the links change here too.
    for (const op of ops) {
      if (op.kind !== 'item') continue
      if (op.op === 'create' && op.data.chats !== undefined) {
        // A create that found the document there changes nothing, links included.
        if (book[op.id] === undefined) {
          const chats = chatsOf(op.data.chats)
          if (Object.keys(chats).length) book[op.id] = chats
          changed = true
        }
      } else if (op.op === 'patch') {
        const local: PatchOp[] = op.patch.filter(p => p.path[0] === 'chats')
        if (!local.length) continue
        const next = chatsOf(applyPatch({ chats: book[op.id] ?? {} }, local).chats)
        if (Object.keys(next).length) book[op.id] = next
        else delete book[op.id]
        changed = true
      } else if (op.op === 'delete' && book[op.id]) {
        delete book[op.id]
        changed = true
      }
    }
    if (changed) this.host.storage.set(this.chatsKey, book)
    return this.withChats(docsOf(answer), book)
  }

  /* ---- hearing */

  subscribe(handler: (docs: SourceDoc[]) => void, resync?: () => void): () => void {
    this.handlers.add(handler)
    if (resync) this.resyncs.add(resync)
    return () => {
      this.handlers.delete(handler)
      if (resync) this.resyncs.delete(resync)
    }
  }

  status(): SourceStatus {
    return this.current
  }

  /* ---- people */

  peopleOf(_collectionId?: string): People | null {
    return this.people
  }

  /** Who this token was when last connected, until the stream says again. Only the id: a name may have changed since. */
  knownAs(me: string | null) {
    if (!this.people && me) this.people = { me, all: [] }
  }

  refreshPeople(_collectionId?: string): void {
    if (!this.peopleAsked && !this.disposed && this.people) this.peopleAsked = this.askPeople().finally(() => { this.peopleAsked = null })
  }

  /** Gives this token's person a new name. Throws a `SourceError` with what to tell the user. */
  async rename(name: string): Promise<void> {
    const answer = await this.call('POST', '/v1/me', { name })
    this.setPeople(peopleOf(answer, this.people?.me ?? null))
  }

  onPeople(handler: () => void): () => void {
    this.peopleHandlers.add(handler)
    return () => { this.peopleHandlers.delete(handler) }
  }

  private setPeople(people: People | null) {
    const p = this.people
    if (p === people || (p && people && JSON.stringify(p) === JSON.stringify(people))) return
    this.people = people
    for (const h of [...this.peopleHandlers]) h()
  }

  private async askPeople() {
    try {
      const answer = await request(this.config, this.fetcher, this.timeoutMs, 'GET', '/v1/people')
      this.setPeople(peopleOf(answer, this.people?.me ?? null))
    } catch (e) {
      this.host.log.warn('Reading the people of the planner server:', e)
    }
  }

  onStatus(handler: (status: SourceStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => { this.statusHandlers.delete(handler) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.silence)
    this.stream?.abort()
    this.handlers.clear()
    this.resyncs.clear()
    this.statusHandlers.clear()
    this.peopleHandlers.clear()
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onBrowserOnline)
  }

  /* ---- internals */

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    try {
      return await request(this.config, this.fetcher, this.timeoutMs, method, path, body)
    } catch (e) {
      if (e instanceof SourceError && e.kind === 'offline') this.reconnectSoon(0)
      throw e
    }
  }

  private setStatus(status: SourceStatus) {
    const c = this.current
    if (c.online === status.online && c.readonly === status.readonly && c.message === status.message) return
    this.current = status
    for (const h of [...this.statusHandlers]) h(status)
  }

  private chats(): ChatsBook {
    const v = this.host.storage.get<unknown>(this.chatsKey)
    if (!isObject(v)) return {}
    const out: ChatsBook = {}
    for (const [id, chats] of Object.entries(v)) if (isSafeKey(id)) out[id] = chatsOf(chats)
    return out
  }

  /** Items with this computer's links, and nobody else's. */
  private withChats(docs: SourceDoc[], book = this.chats()): SourceDoc[] {
    return docs.map((d) => {
      if (d.kind !== 'item' || !d.data) return d
      const { chats: _theirs, ...data } = d.data
      // As the store makes items: with their links, none is an empty object.
      return { ...d, data: { ...data, chats: book[d.id] ?? {} } as JsonObject }
    })
  }

  private deliver(docs: SourceDoc[]) {
    if (!docs.length) return
    const withChats = this.withChats(docs)
    for (const h of [...this.handlers]) h(withChats)
  }

  private resync() {
    for (const r of [...this.resyncs]) r()
  }

  private reconnectSoon(delay?: number) {
    if (this.disposed) return
    clearTimeout(this.retryTimer)
    const wait = delay ?? Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.max(0, this.failures - 1))
    if (delay === 0 && this.stream) return
    this.retryTimer = setTimeout(() => { void this.connect() }, wait)
  }

  private keepAlive() {
    clearTimeout(this.silence)
    this.silence = setTimeout(() => this.stream?.abort(), this.silenceMs)
  }

  private async connect() {
    if (this.disposed || this.stream) return
    clearTimeout(this.retryTimer)
    const abort = new AbortController()
    this.stream = abort
    const since = this.seq
    let helloSeen = false
    let refused = false
    try {
      const response = await this.fetcher(`${this.config.url}/v1/events${since ? `?since=${since}` : ''}`, {
        headers: { Authorization: `Bearer ${this.config.token}`, Accept: 'text/event-stream' },
        signal: abort.signal,
        cache: 'no-store',
        credentials: 'omit',
      })
      if (!response.ok || !response.body) {
        let message = `The planner server answered ${response.status}.`
        try {
          const error = ((await response.json()) as ErrorAnswer | null)?.error
          if (typeof error?.message === 'string' && error.message) message = error.message
        } catch { /* not JSON */ }
        if (response.status === 401 || response.status === 403) {
          refused = true
          this.setStatus({ online: false, readonly: true, message })
        } else this.setStatus({ online: false, readonly: false, message })
        return
      }
      this.keepAlive()
      const reader = new EventReader((event, data) => {
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          return
        }
        if (event === 'hello') {
          helloSeen = true
          this.greeted(checkHello(payload), since)
        } else if (event === 'docs' && isObject(payload)) {
          const docs = docsOf(payload)
          if (typeof payload.seq === 'number') this.seq = Math.max(this.seq, payload.seq)
          this.deliver(docs)
        } else if (event === 'people') {
          // Someone was renamed, or given a token: who there is is asked again.
          this.refreshPeople()
        } else if (event === 'resync' && isObject(payload)) {
          if (typeof payload.seq === 'number') this.seq = payload.seq
          this.resync()
        }
      })
      const decoder = new TextDecoder()
      const body = response.body.getReader()
      for (;;) {
        const { done, value } = await body.read()
        if (done) break
        this.keepAlive()
        reader.push(decoder.decode(value, { stream: true }))
      }
      this.setStatus({ online: false, readonly: this.current.readonly, message: 'The connection to the planner server was lost.' })
    } catch (e) {
      if (!this.disposed) {
        const message = e instanceof SourceError ? e.message : 'The planner server cannot be reached.'
        if (e instanceof SourceError && e.kind === 'invalid') refused = true
        this.setStatus({ online: false, readonly: this.current.readonly, message })
      }
    } finally {
      clearTimeout(this.silence)
      if (this.stream === abort) this.stream = null
      abort.abort()
      if (!this.disposed && !refused) {
        this.failures = helloSeen ? 1 : this.failures + 1
        this.reconnectSoon()
      }
    }
  }

  /** The stream is up: where the space stands, and what this token may do. */
  private greeted(h: RemoteHello, since: number) {
    this.label = h.space.name
    const behind = h.seq < this.seq
    const missed = !since && this.readBefore > 0 && this.readBefore < h.seq ? this.readBefore : 0
    // With `since`, what was missed comes next on the stream and moves `seq` on.
    if (!since || behind) this.seq = h.seq
    this.heard = true
    this.failures = 0
    // Who this token is may have changed with it; who else there is, too. A server older than people has none.
    const me = h.me
    if (!me) this.setPeople(null)
    else {
      const all = this.people?.all ?? []
      this.setPeople({
        me: me.id,
        all: all.some(p => p.id === me.id) ? all.map(p => (p.id === me.id ? { ...p, name: me.name } : p)) : [...all, { ...me, active: h.role === 'write' }],
      })
      this.refreshPeople()
    }
    this.setStatus({ online: true, readonly: h.role !== 'write', ...(h.role !== 'write' ? { message: `Your access to ${h.space.name} is read only.` } : {}) })
    // The server was reset, or lost what it had: everything again.
    if (behind) this.resync()
    else if (missed) void this.catchUp(missed)
  }

  /** What was written between a read and the stream. */
  private async catchUp(since: number) {
    try {
      for (let from = since, more = true; more && !this.disposed;) {
        const answer = await this.call('GET', `/v1/changes?since=${from}`)
        if (!isObject(answer) || answer.resync === true) return this.resync()
        this.deliver(docsOf(answer))
        more = answer.more === true && typeof answer.seq === 'number' && answer.seq > from
        if (typeof answer.seq === 'number') from = answer.seq
      }
    } catch (e) {
      this.host.log.warn('Catching up with the planner server:', e)
      this.resync()
    }
  }
}
