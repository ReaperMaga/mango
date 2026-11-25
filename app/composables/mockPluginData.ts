import type { Events, PluginDataRow, PluginDataWriteOp, PluginDataWritten } from '~/types/ipc'

/**
 * The browser preview's `plugin_data_*` (src-tauri/src/plugin_data.rs): plugins' documents in localStorage, shared
 * by the preview's browser tabs as the app's windows share the database.
 */

type Emit = (event: string, payload: unknown) => void
type Store = Record<string, { seq: number; docs: PluginDataRow[] }>

const STORE = 'mango.preview.plugin-data'
const EVENT = 'plugins://data'

function load(): Store {
  const raw = localStorage.getItem(STORE)
  return raw ? JSON.parse(raw) : {}
}
const save = (s: Store) => localStorage.setItem(STORE, JSON.stringify(s))

let channel: BroadcastChannel | null = null
/** Hears the writes of the preview's other tabs. */
export function followMockPluginData(emit: Emit) {
  if (channel || typeof BroadcastChannel === 'undefined') return
  channel = new BroadcastChannel(STORE)
  channel.onmessage = e => emit(EVENT, e.data)
}

function write(pluginId: string, ops: PluginDataWriteOp[], origin: string, emit: Emit): PluginDataWritten {
  const store = load()
  const mine = store[pluginId] ?? { seq: 0, docs: [] }
  const now = Date.now()
  const stored = new Map(mine.docs.map(d => [`${d.collection}/${d.id}`, d]))
  const next = new Map(stored)
  const changed = new Map<string, PluginDataRow>()
  const conflicts = new Map<string, PluginDataRow>()
  const docs: PluginDataRow[] = []
  let seq = mine.seq
  for (const op of ops) {
    const key = `${op.collection}/${op.id}`
    const absent: PluginDataRow = { collection: op.collection, id: op.id, rev: 0, seq: 0, createdAt: 0, updatedAt: 0, deleted: true, data: null }
    const current = next.get(key) ?? absent
    if (op.expectedRev !== undefined && op.expectedRev !== current.rev && !(op.expectedRev === 0 && current.deleted)) {
      conflicts.set(key, stored.get(key) ?? absent)
      continue
    }
    if (op.op === 'delete' && current.deleted) {
      docs.push(current)
      continue
    }
    const doc: PluginDataRow = {
      collection: op.collection, id: op.id, rev: current.rev + 1, seq: ++seq,
      createdAt: current.deleted ? now : current.createdAt, updatedAt: now,
      deleted: op.op === 'delete', data: op.op === 'put' ? op.data : null,
    }
    next.set(key, doc)
    changed.set(key, doc)
    docs.push(doc)
  }
  if (conflicts.size) return { docs: [], conflicts: [...conflicts.values()], seq: mine.seq }
  if (changed.size) {
    save({ ...store, [pluginId]: { seq, docs: [...next.values()] } })
    const event: Events['plugins://data'] = { pluginId, seq, docs: [...changed.values()].sort((a, b) => a.seq - b.seq), origin }
    emit(EVENT, event)
    channel?.postMessage(event)
  }
  return { docs, conflicts: [], seq }
}

export async function mockPluginData(cmd: string, args: any, emit: Emit): Promise<unknown> {
  followMockPluginData(emit)
  const mine = load()[args.pluginId] ?? { seq: 0, docs: [] }
  switch (cmd) {
    case 'plugin_data_list': return mine.docs.filter(d => !d.deleted && d.collection === args.collection).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    case 'plugin_data_get': return mine.docs.find(d => !d.deleted && d.collection === args.collection && d.id === args.id) ?? null
    case 'plugin_data_count': return mine.docs.filter(d => !d.deleted).length
    case 'plugin_data_changes': return { seq: mine.seq, docs: mine.docs.filter(d => d.seq > args.since).sort((a, b) => a.seq - b.seq) }
    case 'plugin_data_write': return write(args.pluginId, args.ops, args.origin, emit)
    case 'plugin_data_clear': {
      save({ ...load(), [args.pluginId]: { seq: mine.seq, docs: [] } })
      return
    }
  }
  throw new Error(`mock: unknown command ${cmd}`)
}
