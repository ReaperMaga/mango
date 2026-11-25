import type { Commands, Events, PluginDataRow, PluginDataWriteOp } from '~/types/ipc'
import type { Disposable, PluginDataApi, PluginDataChange, PluginDataOp, PluginDoc } from './types'
import type { DisposableScope } from './scope'

/**
 * `mango.data`: a plugin's saved documents (src-tauri/src/plugin_data.rs). What a plugin hands in is checked and
 * turned into JSON text here, so Vue's proxies are fine and nothing is shared with the plugin. Plain Node (tests/):
 * the backend is handed in.
 */

const COLLECTION = /^[A-Za-z0-9_-]{1,64}$/
/** Control characters, as the backend has them, and halves of a character, which it could not read. */
const BAD_ID = /[\p{Cc}\p{Cs}]/u
const MAX_DOC_BYTES = 1024 * 1024
const MAX_OPS = 2000

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

/** A document's data as JSON text. */
export function docJson(data: unknown, name: string): string {
  let text: string | undefined
  try { text = JSON.stringify(data) } catch (e) {
    throw new TypeError(`data: ${name} cannot be saved as JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (text === undefined) throw new TypeError(`data: ${name} needs data that is JSON (not undefined or a function).`)
  if (new TextEncoder().encode(text).length > MAX_DOC_BYTES) throw new TypeError(`data: ${name} is larger than 1 MB.`)
  return text
}

export function toWriteOps(ops: unknown): PluginDataWriteOp[] {
  if (!Array.isArray(ops)) throw new TypeError('data.write: a list of operations is needed.')
  if (ops.length > MAX_OPS) throw new TypeError(`data.write: at most ${MAX_OPS} operations at once.`)
  return ops.map((op: Partial<Extract<PluginDataOp, { op: 'put' }>> | null): PluginDataWriteOp => {
    const kind: unknown = op?.op
    if (!op || (kind !== 'put' && kind !== 'delete')) throw new TypeError('data.write: "op" must be "put" or "delete".')
    const collection = checkCollection(op.collection)
    const id = checkDocId(op.id)
    const rev = op.expectedRev
    if (rev !== undefined && (!Number.isSafeInteger(rev) || rev < 0)) throw new TypeError(`data.write: expectedRev of ${collection}/${id} must be a whole number, 0 or more.`)
    const at = { collection, id, ...(rev === undefined ? {} : { expectedRev: rev }) }
    return kind === 'put' ? { op: kind, ...at, data: docJson(op.data, `${collection}/${id}`) } : { op: kind, ...at }
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

  function deliver(e: Events['plugins://data']) {
    if (e.pluginId !== pluginId) return
    for (const h of [...handlers]) {
      // Each its own copy.
      try {
        const out: unknown = h.fn({ seq: e.seq, docs: e.docs.map(d => toDoc(d)), local: e.origin === ORIGIN })
        if (out instanceof Promise) out.catch(err => host.report(err, 'data.onChange'))
      } catch (err) { host.report(err, 'data.onChange') }
    }
  }
  function follow() {
    following ??= host.on('plugins://data', deliver)
      .then((stop) => { scope.add(stop) })
      .catch((e) => { following = null; host.report(e, 'data.onChange') })
  }

  return {
    async list<T>(collection: string) {
      checkCollection(collection)
      await following
      return (await call('plugin_data_list', { pluginId, collection })).map(r => toDoc<T>(r))
    },
    async get<T>(collection: string, id: string) {
      checkCollection(collection)
      checkDocId(id)
      await following
      const row = await call('plugin_data_get', { pluginId, collection, id })
      return row ? toDoc<T>(row) : null
    },
    async write(ops) {
      // Before any await: what is saved is what the plugin holds now.
      const list = toWriteOps(ops)
      if (!list.length) return []
      await following
      const r = await call('plugin_data_write', { pluginId, ops: list, origin: ORIGIN })
      if (r.conflicts.length) throw conflictError(r.conflicts.map(d => toDoc(d)))
      return r.docs.map(d => toDoc(d))
    },
    async changes(since) {
      if (!Number.isSafeInteger(since) || since < 0) throw new TypeError('data.changes: a seq is needed (0: everything).')
      await following
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
