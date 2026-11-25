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
 * - `Scope.path` and the chats of an item mean something on this computer only. A scope's portable form is its
 *   `repo` (`host/owner/name`): elsewhere a collection is matched by it where its path does not exist. Chat links
 *   have no portable form: a remote source strips `chats` (data, and patches to `['chats', …]`) before sending, and
 *   keeps them on this computer.
 * - Errors are `SourceError`s: what the store does with a change depends on their kind.
 * - Several sources at once: `RoutedSource` (`routed.ts`) routes by collection id between this computer's and a
 *   planner server's (`remote.ts`), and says so through the optional `places` methods. Documents never refer to
 *   their source.
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

/**
 * Why a write failed.
 * - `offline`: it may work later. The change stays, and is written again when the source is online.
 * - `refused`: not allowed. `invalid`: it can never be written as it is (too large, say). Neither is tried again.
 * - `unknown`: anything else. A change is taken back; typed text stays and is written again with the next change.
 * Text the user typed stays on screen whatever the kind.
 */
export type SourceErrorKind = 'offline' | 'refused' | 'invalid' | 'unknown'

export class SourceError extends Error {
  readonly kind: SourceErrorKind

  constructor(kind: SourceErrorKind, message: string) {
    super(message)
    this.name = 'SourceError'
    this.kind = kind
  }
}

/** Where collections can live, for a source that holds several (`RoutedSource`). */
export interface SourcePlace {
  readonly id: string
  readonly label: string
  readonly status: SourceStatus
}

export interface PlannerSource {
  /** Names the source in the UI once there are several. */
  readonly label: string
  loadCollections(): Promise<SourceDoc[]>
  loadItems(collectionId: string): Promise<SourceDoc[]>
  /**
   * All of it, or nothing. Answers every document named, as it is now; one that was patched but is gone comes
   * back as a tombstone (that is not an error), and so does one nobody ever heard of (`seq` 0).
   *
   * `mutationId` is the same when a write is tried again, as its answer may have been lost: a source that made it
   * answers as it did, and does not make it twice. A `create` of a document that is there is that document.
   */
  write(ops: readonly SourceOp[], mutationId: string): Promise<SourceDoc[]>
  /**
   * Every write, the source's own too; applying one twice must do no harm. `resync`: writes may have been missed and
   * cannot be named one by one (after a long time offline), so everything loaded is read again.
   */
  subscribe(handler: (docs: SourceDoc[]) => void, resync?: () => void): () => void
  status(): SourceStatus
  onStatus(handler: (status: SourceStatus) => void): () => void
  dispose(): void

  /* ---- only a source of several places has these */
  places?(): SourcePlace[]
  placeOfCollection?(collectionId: string): string
  /** The next create of this collection goes there. */
  place?(collectionId: string, place: string): void
  /** Of the place the collection is in. */
  statusOf?(collectionId: string): SourceStatus
}
