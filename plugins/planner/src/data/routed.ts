/**
 * The planner's sources together: this computer's, and a planner server's space when one is connected. Every
 * collection lives in one of them with all its items; the store sees one source.
 *
 * A collection's place is learned from where it was read or heard of; a new one goes where `place` said, or here.
 * Collections are never in two places at once: moving one copies it under new ids (`store.moveCollection`), so each
 * document's `seq` only ever comes from one source.
 */

import { SourceError, type PlannerSource, type SourceDoc, type SourceOp, type SourcePlace, type SourceStatus } from './source.ts'

export const HERE = 'local'
export const SERVER = 'server'
export type PlaceId = typeof HERE | typeof SERVER

export interface Place extends SourcePlace { readonly id: PlaceId }

const ONLINE: SourceStatus = { online: true, readonly: false }

export class RoutedSource implements PlannerSource {
  readonly label = 'Planner'
  private readonly local: PlannerSource
  private server: PlannerSource | null = null
  private readonly placeOf = new Map<string, PlaceId>()
  private readonly handlers = new Set<(docs: SourceDoc[]) => void>()
  private readonly resyncs = new Set<() => void>()
  private readonly statusHandlers = new Set<(status: SourceStatus) => void>()
  private readonly unlisten: Array<() => void> = []
  private serverUnlisten: Array<() => void> = []
  /** The server's collections, read since it was connected: what says where a collection is. */
  private serverRead: Promise<void> | null = null
  /** The server's collections as last read: shown while it cannot be reached, rather than taken from view. */
  private serverCollections: SourceDoc[] = []
  /** Whether they were read at all: if not (it was offline from the start), they are once it is back. */
  private serverLoaded = false

  constructor(local: PlannerSource) {
    this.local = local
    this.unlisten.push(
      local.subscribe(docs => this.heard(HERE, docs), () => this.resyncAll()),
      local.onStatus(() => this.statusChanged()),
    )
  }

  /* ---- places */

  places(): Place[] {
    const out: Place[] = [{ id: HERE, label: this.local.label, status: this.local.status() }]
    if (this.server) out.push({ id: SERVER, label: this.server.label, status: this.server.status() })
    return out
  }

  /** Where a collection lives: here unless the server said it has it. */
  placeOfCollection(collectionId: string): PlaceId {
    return this.placeOf.get(collectionId) ?? HERE
  }

  /** The next create of this collection goes there. */
  place(collectionId: string, place: string) {
    if (place === HERE || place === SERVER) this.placeOf.set(collectionId, place)
  }

  statusOf(collectionId: string): SourceStatus {
    return this.sourceOf(this.placeOfCollection(collectionId))?.status() ?? { online: false, readonly: true, message: 'Its planner server is not connected.' }
  }

  /**
   * Connects a server's space, or none. What was read from the one before goes from view; the store reads everything
   * again, the new server's collections with it.
   */
  setServer(server: PlannerSource | null) {
    const old = this.server
    if (old === server) return
    if (old) {
      this.serverUnlisten.forEach(u => u())
      this.serverUnlisten = []
      const gone = [...this.placeOf].filter(([, p]) => p === SERVER).map(([id]) => id)
      gone.forEach(id => this.placeOf.delete(id))
      old.dispose()
    }
    this.server = server
    this.serverRead = null
    this.serverCollections = []
    this.serverLoaded = false
    if (server) {
      this.serverUnlisten.push(
        server.subscribe(docs => this.heard(SERVER, docs), () => this.resyncAll()),
        server.onStatus((s) => {
          this.statusChanged()
          // What was written while it was away comes on its stream; what was never read is read now.
          if (s.online && !this.serverLoaded) this.resyncAll()
        }),
      )
    }
    this.statusChanged()
    this.resyncAll()
  }

  /* ---- PlannerSource */

  async loadCollections(): Promise<SourceDoc[]> {
    const server = this.server
    const fromServer = server ? this.readServer(server) : Promise.resolve([])
    const [here, there] = await Promise.all([this.local.loadCollections(), fromServer.catch(() => this.serverCollections)])
    for (const d of here) if (!this.placeOf.has(d.id)) this.placeOf.set(d.id, HERE)
    return [...here, ...there]
  }

  async loadItems(collectionId: string): Promise<SourceDoc[]> {
    if (!this.placeOf.has(collectionId) && this.server) {
      // Not heard of yet: perhaps the server has it.
      await (this.serverRead ?? this.readServer(this.server).catch(() => []))
    }
    return this.need(this.placeOfCollection(collectionId)).loadItems(collectionId)
  }

  /** In order, one write per place. Not all or nothing across places: a change rarely spans two. */
  async write(ops: readonly SourceOp[], mutationId: string): Promise<SourceDoc[]> {
    const groups = new Map<PlaceId, SourceOp[]>()
    for (const op of ops) {
      const place = this.placeOfCollection(op.collectionId)
      let list = groups.get(place)
      if (!list) groups.set(place, (list = []))
      list.push(op)
    }
    const out: SourceDoc[] = []
    for (const [place, list] of groups) {
      const docs = await this.need(place).write(list, groups.size > 1 ? `${mutationId}-${place}` : mutationId)
      this.learn(place, docs)
      out.push(...docs)
    }
    return out
  }

  subscribe(handler: (docs: SourceDoc[]) => void, resync?: () => void): () => void {
    this.handlers.add(handler)
    if (resync) this.resyncs.add(resync)
    return () => {
      this.handlers.delete(handler)
      if (resync) this.resyncs.delete(resync)
    }
  }

  /** Online while every place is; read only when every place is. */
  status(): SourceStatus {
    const all = this.places().map(p => p.status)
    const off = all.find(s => !s.online)
    const writable = all.some(s => !s.readonly)
    if (!off && writable) return ONLINE
    return { online: !off, readonly: !writable, ...(off?.message ? { message: off.message } : {}) }
  }

  onStatus(handler: (status: SourceStatus) => void): () => void {
    this.statusHandlers.add(handler)
    return () => { this.statusHandlers.delete(handler) }
  }

  dispose(): void {
    this.unlisten.forEach(u => u())
    this.serverUnlisten.forEach(u => u())
    this.server?.dispose()
    this.local.dispose()
    this.handlers.clear()
    this.resyncs.clear()
    this.statusHandlers.clear()
  }

  /* ---- internals */

  private sourceOf(place: PlaceId): PlannerSource | null {
    return place === HERE ? this.local : this.server
  }

  private need(place: PlaceId): PlannerSource {
    const source = this.sourceOf(place)
    if (!source) throw new SourceError('offline', 'Its planner server is not connected.')
    return source
  }

  private async readServer(server: PlannerSource): Promise<SourceDoc[]> {
    const job = server.loadCollections().then((docs) => {
      if (this.server === server) {
        this.learn(SERVER, docs)
        this.serverCollections = docs
        this.serverLoaded = true
      }
      return docs
    })
    this.serverRead = job.then(() => {}, () => {})
    return job
  }

  /** Collections the server has are there. */
  private learn(place: PlaceId, docs: readonly SourceDoc[]) {
    for (const d of docs) if (d.kind === 'collection' && d.data) this.placeOf.set(d.id, place)
  }

  private heard(place: PlaceId, docs: SourceDoc[]) {
    if (place === SERVER && !this.server) return
    this.learn(place, docs)
    // A copy left behind in the other place (a move half done elsewhere) is not this collection.
    const mine = docs.filter(d => this.placeOfCollection(d.collectionId) === place || (d.kind === 'collection' && !this.placeOf.has(d.id)))
    if (mine.length) for (const h of [...this.handlers]) h(mine)
  }

  private resyncAll() {
    for (const r of [...this.resyncs]) r()
  }

  private statusChanged() {
    const s = this.status()
    for (const h of [...this.statusHandlers]) h(s)
  }
}
