/**
 * When an edit computed earlier still fits the text. A completion is asked for, then typed into and
 * accepted later, and its import may arrive later still: meanwhile an agent, another pane or an undo
 * can change the text under it. Plain Node.
 */

interface Position { lineNumber: number; column: number }
interface Range { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
export interface Changed { isFlush: boolean; isEolChange?: boolean; changes: ReadonlyArray<{ range: Range; text: string }> }

/** The text a completion was asked about, changed only by typing the word it completes. */
export class CompletionText {
  valid = true
  private from = new Map<number, number>()

  /** `words`: where the word at each caret starts. */
  constructor(words: Position[]) {
    for (const { lineNumber, column } of words) this.from.set(lineNumber, Math.min(column, this.from.get(lineNumber) ?? column))
  }

  changed(e: Changed) {
    if (!this.valid) return
    this.valid = !e.isFlush && !e.isEolChange && e.changes.every(({ range, text }) => {
      const from = this.from.get(range.startLineNumber)
      return from !== undefined && range.startColumn >= from && range.startLineNumber === range.endLineNumber && !/[\r\n]/.test(text)
    })
  }
}

/** The part of a text above and left of every change since: where later edits still fit. */
export class UntouchedText {
  private lost = false
  private first: Position | null = null

  changed(e: Changed) {
    if (e.isFlush || e.isEolChange) this.lost = true
    for (const { range } of e.changes) {
      const at = { lineNumber: range.startLineNumber, column: range.startColumn }
      if (!this.first || before(at, this.first)) this.first = at
    }
  }

  allows(edits: ReadonlyArray<{ range: Range }>): boolean {
    if (this.lost) return false
    const first = this.first
    return !first || edits.every(({ range }) => !before(first, { lineNumber: range.endLineNumber, column: range.endColumn }))
  }
}

const before = (a: Position, b: Position) => a.lineNumber < b.lineNumber || (a.lineNumber === b.lineNumber && a.column < b.column)
