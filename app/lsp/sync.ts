import type { ContentChange, ServerCapabilities } from './protocol.ts'

/** One of Monaco's content changes: the range is in the text as it was before it. */
export interface EditorChange {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  text: string
}

export const SYNC_NONE = 0
export const SYNC_FULL = 1
export const SYNC_INCREMENTAL = 2

/** How a server wants to hear about a document. */
export function syncOptions(caps: ServerCapabilities): { openClose: boolean; change: number; save: { includeText: boolean } | null } {
  const sync = caps.textDocumentSync
  // Just a number is the older form: it implies open, close and save.
  if (typeof sync === 'number') return { openClose: sync !== SYNC_NONE, change: sync, save: sync === SYNC_NONE ? null : { includeText: false } }
  if (!sync) return { openClose: false, change: SYNC_NONE, save: null }
  return {
    openClose: !!sync.openClose,
    change: sync.change ?? SYNC_NONE,
    save: sync.save ? { includeText: typeof sync.save === 'object' && !!sync.save.includeText } : null,
  }
}

/** Past this many edits, or this much typed text, at once, the whole text is sent instead. */
const MAX_CHANGES = 500
const MAX_TEXT = 1_000_000

/** A document's edits since the server last heard of it. Adding one never reads the document. */
export class PendingChanges {
  private changes: ContentChange[] = []
  private chars = 0
  private whole = false

  get empty() { return !this.whole && !this.changes.length }

  /** `null`: the whole text was replaced (a new end of line, a reset). */
  add(changes: readonly EditorChange[] | null) {
    if (this.whole) return
    if (!changes || this.changes.length + changes.length > MAX_CHANGES) return this.replaceAll()
    // Monaco lists one event's changes bottom to top, so each still applies after the one before it.
    for (const { range, text } of changes) {
      this.chars += text.length
      this.changes.push({
        range: {
          start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
          end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
        },
        text,
      })
    }
    if (this.chars > MAX_TEXT) this.replaceAll()
  }

  private replaceAll() {
    this.whole = true
    this.changes = []
  }

  /** What `didChange` carries, and start over. `text` is only called when the whole text is needed. */
  take(kind: number, text: () => string): ContentChange[] {
    const out = this.empty || kind === SYNC_NONE ? [] : this.whole || kind === SYNC_FULL ? [{ text: text() }] : this.changes
    this.whole = false
    this.changes = []
    this.chars = 0
    return out
  }
}
