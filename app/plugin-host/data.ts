import type { Commands, Events, PluginDataRow, PluginDataWriteOp } from '~/types/ipc'
import type { Disposable, PluginDataApi, PluginDataChange, PluginDataOp, PluginDoc } from './types'
import type { DisposableScope } from './scope'

/**
 * `mango.data`: a plugin's saved documents (src-tauri/src/plugin_data.rs). What a plugin hands in is checked and
 * turned into JSON text here, so Vue's proxies are fine and nothing is shared with the plugin. Plain Node (tests/):
 * the backend is handed in.
 */

const encoder = new TextEncoder()
const COLLECTION = /^[A-Za-z0-9_-]{1,64}$/
/** Control characters, as the backend has them, and halves of a character, which it could not read. */
const BAD_ID = /[\p{Cc}\p{Cs}]/u
const MAX_DOC_BYTES = 1024 * 1024
const MAX_WRITE_BYTES = 64 * MAX_DOC_BYTES
const MAX_OPS = 20_000

function checkCollection(v: unknown): string {
  if (typeof v !== 'string' || !COLLECTION.test(v)) throw new TypeError(`data: collection "${String(v)}" must be letters, digits, "_" or "-" (up to 64).`)
  return v
}

function checkDocId(v: unknown): string {
  if (typeof v !== 'string' || !v || [...v].length > 128 || BAD_ID.test(v)) {
    throw new TypeError(`data: document id "${String(v)}" must be a text of 1 to 128 characters, without control characters.`)
  }
  return v
}

/** A document's data as JSON text, and its size. */
export function docJson(data: unknown, name: string): { text: string; bytes: number } {
  let text: string | undefined
  try { text = JSON.stringify(data) } catch (e) {
    throw new TypeError(`data: ${name} cannot be saved as JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (text === undefined) throw new TypeError(`data: ${name} needs data that is JSON (not undefined or a function).`)
  const bytes = encoder.encode(text).length
  if (bytes > MAX_DOC_BYTES) throw new TypeError(`data: ${name} is larger than 1 MB.`)
  return { text, bytes }
}

export function toWriteOps(ops: unknown): PluginDataWriteOp[] {
  if (!Array.isArray(ops)) throw new TypeError('data.write: a list of operations is needed.')
  if (ops.length > MAX_OPS) throw new TypeError(`data.write: at most ${MAX_OPS} operations at once.`)
  let total = 0
  return ops.map((op: Partial<Extract<PluginDataOp, { op: 'put' }>> | null): PluginDataWriteOp => {
    const kind: unknown = op?.op
    if (!op || (kind !== 'put' && kind !== 'delete')) throw new TypeError('data.write: "op" must be "put" or "delete".')
    const collection = checkCollection(op.collection)
    const id = checkDocId(op.id)
    const rev = op.expectedRev
    if (rev !== undefined && (!Number.isSafeInteger(rev) || rev < 0)) throw new TypeError(`data.write: expectedRev of ${collection}/${id} must be a whole number, 0 or more.`)
    const at = { collection, id, ...(rev === undefined ? {} : { expectedRev: rev }) }
    if (kind === 'delete') return { op: kind, ...at }
    const { text, bytes } = docJson(op.data, `${collection}/${id}`)
    total += bytes
    if (total > MAX_WRITE_BYTES) throw new TypeError('data.write: more than 64 MB in one write.')
    return { op: kind, ...at, data: text }
  })
}

const toDoc = <T>(row: PluginDataRow): PluginDoc<T> =>
  ({ ...row, data: row.data === null ? null : JSON.parse(row.data) as T })

function conflictError(conflicts: PluginDoc[]): Error & { conflicts: PluginDoc[] } {
  const names = conflicts.slice(0, 3).map(d => `${d.collection}/${d.id}`).join(', ') + (conflicts.length > 3 ? '…' : '')
  return Object.assign(new Error(`Not saved: changed meanwhile (${names}).`), { conflicts })
}

/** Names this window in the writes it makes, so it knows its own again. */
const ORIGIN = Math.random().toString(36).slice(2) + Date.now().toString(36)

export interface PluginDataHost {
  pluginId: string
  scope: DisposableScope
  call<K extends keyof Commands>(cmd: K, args: Commands[K][0]): Promise<Commands[K][1]>
  on<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void): Promise<() => void>
  report(error: unknown, where: string): void
}

export function createPluginData(host: PluginDataHost): PluginDataApi {
  const { pluginId, scope, call } = host
  const handlers = new Set<{ fn: (change: PluginDataChange) => void }>()
  /** Following begins; reads and writes wait for it, so nothing falls between an `onChange` and a `list` after it. */
  let following: Promise<void> | null = null

  /** A change whose documents have to be read first: later ones wait for it, so handlers see them in order. */
  let reading: Promise<void> | null = null
  /** Changes after this `seq` could not be read: they go out with the next one. */
  let missed: number | null = null

  function heard(e: Events['plugins://data']) {
    if (e.pluginId !== pluginId || !handlers.size) return
    const local = e.origin === ORIGIN
    if (e.docs && !reading && missed === null) return deliver(e.seq, e.docs, local)
    const next = (reading ?? Promise.resolve()).then(() => read(e, local)).finally(() => { if (reading === next) reading = null })
    reading = next
  }
  async function read(e: Events['plugins://data'], local: boolean) {
    if (e.docs && missed === null) return deliver(e.seq, e.docs, local)
    const since = missed ?? e.since
    try {
      const { docs } = await call('plugin_data_changes', { pluginId, since })
      // What was written later has an event of its own.
      deliver(e.seq, docs.filter(d => d.seq <= e.seq), local && missed === null)
      missed = null
    } catch (err) {
      missed = since
      host.report(err, 'data.onChange')
    }
  }
  function deliver(seq: number, docs: PluginDataRow[], local: boolean) {
    for (const h of [...handlers]) {
      // Each its own copy.
      try {
        const out: unknown = h.fn({ seq, docs: docs.map(d => toDoc(d)), local })
        if (out instanceof Promise) out.catch(err => host.report(err, 'data.onChange'))
      } catch (err) { host.report(err, 'data.onChange') }
    }
  }
  function follow() {
    following ??= host.on('plugins://data', heard)
      .then((stop) => { scope.add(stop) })
      .catch((e) => { following = null; host.report(e, 'data.onChange') })
  }
  /** Before a read or write. Following that failed is tried again. */
  async function ready() {
    if (handlers.size) follow()
    await following
  }

  return {
    async list<T>(collection: string) {
      checkCollection(collection)
      await ready()
      return (await call('plugin_data_list', { pluginId, collection })).map(r => toDoc<T>(r))
    },
    async get<T>(collection: string, id: string) {
      checkCollection(collection)
      checkDocId(id)
      await ready()
      const row = await call('plugin_data_get', { pluginId, collection, id })
      return row ? toDoc<T>(row) : null
    },
    async write(ops) {
      // Before any await: what is saved is what the plugin holds now.
      const list = toWriteOps(ops)
      if (!list.length) return []
      await ready()
      const r = await call('plugin_data_write', { pluginId, ops: list, origin: ORIGIN })
      if (r.conflicts.length) throw conflictError(r.conflicts.map(d => toDoc(d)))
      // The backend does not send back what it was just given.
      return r.docs.map((d, i) => { const op = list[i]!; return toDoc({ ...d, data: op.op === 'put' ? op.data : null }) })
    },
    async changes(since) {
      if (!Number.isSafeInteger(since) || since < 0) throw new TypeError('data.changes: a seq is needed (0: everything).')
      await ready()
      const r = await call('plugin_data_changes', { pluginId, since })
      return { seq: r.seq, docs: r.docs.map(d => toDoc(d)) }
    },
    onChange(fn): Disposable {
      if (typeof fn !== 'function') throw new TypeError('data.onChange must be a function.')
      if (scope.disposed) return { dispose() {} }
      const entry = { fn }
      handlers.add(entry)
      follow()
      return scope.add(() => { handlers.delete(entry) })
    },
  }
}
