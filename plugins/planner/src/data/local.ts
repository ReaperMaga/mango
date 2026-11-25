/**
 * The source on this computer: `mango.data` documents, shared by every window. Collections are in `collections`,
 * a collection's items in `items_<collectionId>`, so they load when it is opened.
 *
 * Patches become whole documents written at the revision they were read (`expectedRev`). When another window was
 * faster, the patch is applied again on what is there now.
 */

import type { Disposable, PluginDataApi, PluginDataOp, PluginDoc } from '../host.ts'
import { applyPatch, isObject, type JsonObject } from '../patch.ts'
import type { PlannerSource, SourceDoc, SourceOp, SourceStatus } from './source.ts'

const COLLECTIONS = 'collections'
const ITEMS = 'items_'
const ATTEMPTS = 10
/** Documents in one write of the host's, which takes 2000. A larger write (a big import) is made in several. */
const BATCH = 1500
const STATUS: SourceStatus = { online: true, readonly: false }

type Address = Pick<SourceOp, 'kind' | 'id' | 'collectionId'>
const nameOf = (a: Address) => (a.kind === 'collection' ? COLLECTIONS : ITEMS + a.collectionId)
const keyOf = (collection: string, id: string) => `${collection}/${id}`

function toSourceDoc(doc: PluginDoc): SourceDoc | null {
  const isCollection = doc.collection === COLLECTIONS
  if (!isCollection && !doc.collection.startsWith(ITEMS)) return null
  const data = doc.deleted || doc.data === null ? null : isObject(doc.data) ? doc.data : {}
  return {
    kind: isCollection ? 'collection' : 'item',
    id: doc.id,
    collectionId: isCollection ? doc.id : doc.collection.slice(ITEMS.length),
    seq: doc.seq,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    data,
  }
}

/** Split so that all changes to one document stay together. */
function batches(ops: readonly SourceOp[]): SourceOp[][] {
  if (ops.length <= BATCH) return [[...ops]]
  const byDoc = new Map<string, SourceOp[]>()
  for (const op of ops) {
    const key = keyOf(nameOf(op), op.id)
    byDoc.get(key)?.push(op) ?? byDoc.set(key, [op])
  }
  const docs = [...byDoc.values()]
  return Array.from({ length: Math.ceil(docs.length / BATCH) }, (_, i) => docs.slice(i * BATCH, (i + 1) * BATCH).flat())
}

const isDoc = (d: SourceDoc | null): d is SourceDoc => d !== null

/** The documents a refused write lists, however the error reached us. */
function conflictsOf(error: unknown): PluginDoc[] | null {
  const list = (error as { conflicts?: unknown } | null)?.conflicts
  return Array.isArray(list) ? (list as PluginDoc[]) : null
}

export class LocalSource implements PlannerSource {
  readonly label = 'This computer'
  private readonly data: PluginDataApi
  /** The newest of every document seen, tombstones too: its revision is what a patch is written against. */
  private readonly known = new Map<string, PluginDoc>()
  private readonly handlers = new Set<(docs: SourceDoc[]) => void>()
  private readonly listening: Disposable

  constructor(data: PluginDataApi) {
    this.data = data
    this.listening = data.onChange((change) => {
      change.docs.forEach(d => this.see(d))
      const docs = change.docs.map(toSourceDoc).filter(isDoc)
      if (docs.length) for (const h of [...this.handlers]) h(docs)
    })
  }

  async loadCollections(): Promise<SourceDoc[]> {
    return this.list(COLLECTIONS)
  }

  async loadItems(collectionId: string): Promise<SourceDoc[]> {
    return this.list(ITEMS + collectionId)
  }

  async write(ops: readonly SourceOp[]): Promise<SourceDoc[]> {
    const out: SourceDoc[] = []
    for (const batch of batches(ops)) out.push(...await this.writeBatch(batch))
    return out
  }

  private async writeBatch(ops: readonly SourceOp[]): Promise<SourceDoc[]> {
    for (let attempt = 1; ; attempt++) {
      const { writes, keys } = await this.prepare(ops)
      try {
        const written = writes.length ? await this.data.write(writes) : []
        written.forEach(d => this.see(d))
        return keys.map(k => this.known.get(k)).map(d => (d ? toSourceDoc(d) : null)).filter(isDoc)
      } catch (e) {
        const conflicts = conflictsOf(e)
        if (!conflicts || attempt >= ATTEMPTS) throw e
        // As they are now, even where that is an older revision than we saw (data restored from a backup).
        for (const d of conflicts) this.known.set(keyOf(d.collection, d.id), d)
      }
    }
  }

  subscribe(handler: (docs: SourceDoc[]) => void): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  status(): SourceStatus {
    return STATUS
  }

  onStatus(): () => void {
    return () => {}
  }

  dispose(): void {
    this.listening.dispose()
    this.handlers.clear()
  }

  private see(doc: PluginDoc) {
    const key = keyOf(doc.collection, doc.id)
    const old = this.known.get(key)
    if (!old || old.seq <= doc.seq) this.known.set(key, doc)
  }

  private async list(collection: string): Promise<SourceDoc[]> {
    const docs = await this.data.list(collection)
    docs.forEach(d => this.see(d))
    return docs.map(toSourceDoc).filter(isDoc)
  }

  /** One host write per document, from the newest copy of it. */
  private async prepare(ops: readonly SourceOp[]): Promise<{ writes: PluginDataOp[]; keys: string[] }> {
    type Work = { address: Address; before: PluginDoc | null; data: JsonObject | null; touched: boolean; expect: boolean }
    const work = new Map<string, Work>()
    for (const op of ops) {
      const collection = nameOf(op)
      const key = keyOf(collection, op.id)
      let w = work.get(key)
      if (!w) {
        let before = this.known.get(key) ?? null
        if (!before && op.op !== 'create') {
          before = await this.data.get(collection, op.id)
          if (before) this.see(before)
        }
        const alive = before && !before.deleted && before.data !== null
        w = { address: op, before, data: alive ? (isObject(before!.data) ? before!.data : {}) : null, touched: false, expect: true }
        work.set(key, w)
      }
      if (op.op === 'create') {
        if (w.data !== null) throw new Error(`A document with the id ${op.id} exists already.`)
        w.data = op.data
        w.touched = true
      } else if (op.op === 'delete') {
        // Whatever it is now: the user asked for it to go.
        w.expect = false
        w.touched ||= w.data !== null
        w.data = null
      } else if (w.data !== null) {
        w.data = applyPatch(w.data, op.patch)
        w.touched = true
      }
    }

    const writes: PluginDataOp[] = []
    for (const { address, before, data, touched, expect } of work.values()) {
      if (!touched) continue
      const at = { collection: nameOf(address), id: address.id }
      if (data === null) {
        if (before && !before.deleted) writes.push({ op: 'delete', ...at })
      } else {
        writes.push({ op: 'put', ...at, data, ...(expect ? { expectedRev: before && !before.deleted ? before.rev : 0 } : {}) })
      }
    }
    return { writes, keys: [...work.keys()] }
  }
}
