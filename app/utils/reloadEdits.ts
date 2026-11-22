import { lineChanges } from './lineDiff.ts'

/**
 * The edits that turn the editor's lines into a file's new text (read again from disk), as small as
 * they can be told: carets, scrolling and undo live through them, unlike replacing the whole text.
 */

export interface LineEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  text: string
}

/** Past this many changed lines the differing middle is replaced as one. */
const MAX_EDITS = 1000

export const splitLines = (text: string) => text.split(/\r\n|\r|\n/)

/** What a reload needs of a Monaco model. */
export interface ReloadModel {
  getLinesContent(): string[]
  getEOL(): string
  getValue(): string
  getFullModelRange(): LineEdit['range']
  getOptions(): { trimAutoWhitespace: boolean }
  updateOptions(options: { trimAutoWhitespace: boolean }): void
  pushStackElement(): void
  pushEOL(eol: number): void
  pushEditOperations(before: null, edits: LineEdit[], cursor: () => null): unknown
}

/** Monaco's `EndOfLineSequence`. */
const LF = 0
const CRLF = 1

/**
 * Make a model's text the one read from disk, as one undo step and nothing more: while it runs the
 * model may not trim the indentation Enter left, which it otherwise adds to whatever edit comes next.
 * The history and the carets live through it. `around` is handed the edit to wrap.
 */
export function reloadModel(model: ReloadModel, text: string, around: (change: () => void) => void = change => change()) {
  // Monaco takes a byte order mark off the text it is given.
  const body = text.replace(/^\uFEFF/, '')
  const next = splitLines(body)
  const eol = eolOf(body) ?? model.getEOL()
  const edits = reloadEdits(model.getLinesContent(), next, eol)
  const eolChanged = eol !== model.getEOL()
  if (!edits.length && !eolChanged) return
  const trims = model.getOptions().trimAutoWhitespace
  if (trims) model.updateOptions({ trimAutoWhitespace: false })
  try {
    model.pushStackElement()
    if (eolChanged) model.pushEOL(eol === '\n' ? LF : CRLF)
    if (edits.length) {
      around(() => void model.pushEditOperations(null, edits, () => null))
      // Never clean with another text than the disk's: if need be as one edit, which undo survives.
      const whole = next.join(eol)
      if (model.getValue() !== whole) model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: whole }], () => null)
    }
    model.pushStackElement()
  } finally {
    if (trims) model.updateOptions({ trimAutoWhitespace: true })
  }
}

/** The end of line Monaco gives a text: the more common one. Null when it has none. */
export function eolOf(text: string): '\n' | '\r\n' | null {
  let all = 0
  let cr = 0
  for (const m of text.matchAll(/\r\n?|\n/g)) {
    all++
    if (m[0] !== '\n') cr++
  }
  return all ? (cr > all / 2 ? '\r\n' : '\n') : null
}

const isHighSurrogate = (code: number) => code >= 0xD800 && code <= 0xDBFF

export function reloadEdits(old: string[], next: string[], eol: string): LineEdit[] {
  const edit = (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number, text: string): LineEdit =>
    ({ range: { startLineNumber, startColumn, endLineNumber, endColumn }, text })
  const end = (line: number) => old[line - 1]!.length + 1

  const out: LineEdit[] = []
  let shift = 0
  for (const change of lineChanges(old, next, MAX_EDITS)) {
    const removed = change.old.length
    const first = change.start - shift
    const last = first + removed - 1
    const added = next.slice(change.start - 1, change.start - 1 + change.count)
    shift += change.count - removed

    if (!removed) {
      out.push(first <= old.length
        ? edit(first, 1, first, 1, added.map(l => l + eol).join(''))
        : edit(old.length, end(old.length), old.length, end(old.length), added.map(l => eol + l).join('')))
    } else if (!added.length) {
      if (last < old.length) out.push(edit(first, 1, last + 1, 1, ''))
      else if (first > 1) out.push(edit(first - 1, end(first - 1), last, end(last), ''))
      else out.push(edit(1, 1, last, end(last), ''))
    } else if (removed === added.length && removed <= MAX_EDITS) {
      // Line for line, and within each, so a caret on or beside the change stays where it is.
      added.forEach((now, i) => {
        const line = first + i
        const was = old[line - 1]!
        let pre = 0
        while (pre < was.length && pre < now.length && was[pre] === now[pre]) pre++
        if (pre && isHighSurrogate(was.charCodeAt(pre - 1))) pre--
        let suf = 0
        while (suf < was.length - pre && suf < now.length - pre && was[was.length - 1 - suf] === now[now.length - 1 - suf]) suf++
        if (suf && isHighSurrogate(was.charCodeAt(was.length - suf - 1))) suf--
        if (pre === was.length && pre === now.length) return
        out.push(edit(line, pre + 1, line, was.length - suf + 1, now.slice(pre, now.length - suf)))
      })
    } else {
      out.push(edit(first, 1, last, end(last), added.join(eol)))
    }
  }
  return out
}
