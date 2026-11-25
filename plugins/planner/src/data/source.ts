/**
 * Where the planner's documents live. The store and the UI only know this interface; `LocalSource` keeps them on
 * this computer (`mango.data`).
 *
 * How a remote source would plug in: implement `PlannerSource` over a server, and hand it to `createStore`.
 * - Reads answer whole documents; `seq` is the server's position of the write, and a document with a higher one
 *   replaces a lower one, whatever order they arrive in. Deleted documents are sent as tombstones (`data` null).
 * - `write` takes field-level patches, so a server can apply them to what it has (or keep a compare-and-swap like
 *   `LocalSource`): two people who change different fields both win, the last writer wins one field.
 * - `subscribe` delivers other people's writes as they happen; after a lost connection, everything since the last
 *   `seq` seen (`mango.data.changes(since)` is the local counterpart, for a source that keeps a copy on this
 *   computer, works offline and sends what is missing later).
 * - `status` says whether it is online and may be written to; the store shows it and refuses edits when read-only.
 *   Ids are random UUIDs, so documents made offline on two computers never collide.
 * - Several sources at once (local and a team's): one store per source is enough, or a source that routes by
 *   collection id. Documents never refer to their source.
 */

import type { JsonObject, Patch } from '../patch.ts'

/** A stored document. `data` is null when it was deleted. */
export interface SourceDoc {
  readonly kind: 'collection' | 'item'
  readonly id: string
  /** Of an item: the collection it is in. Of a collection: its own id. */
  readonly collectionId: string
  /** Where this write stands among all writes of the source: a higher one is newer. */
  readonly seq: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly data: JsonObject | null
}

interface Target { readonly kind: 'collection' | 'item'; readonly id: string; readonly collectionId: string }
export type SourceOp = Target & (
  | { readonly op: 'create'; readonly data: JsonObject }
  | { readonly op: 'patch'; readonly patch: Patch }
  | { readonly op: 'delete' }
)

export interface SourceStatus {
  readonly online: boolean
  readonly readonly: boolean
  /** What to tell the user, e.g. why it is offline. */
  readonly message?: string
}

export interface PlannerSource {
  /** Names the source in the UI once there are several. */
  readonly label: string
  loadCollections(): Promise<SourceDoc[]>
  loadItems(collectionId: string): Promise<SourceDoc[]>
  /**
   * All of it, or nothing. Answers every document named, as it is now; one that was patched but is gone comes
   * back as a tombstone (that is not an error).
   */
  write(ops: readonly SourceOp[]): Promise<SourceDoc[]>
  /** Every write, the source's own too; applying one twice must do no harm. */
  subscribe(handler: (docs: SourceDoc[]) => void): () => void
  status(): SourceStatus
  onStatus(handler: (status: SourceStatus) => void): () => void
  dispose(): void
}
