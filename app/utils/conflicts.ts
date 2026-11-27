/**
 * Conflict blocks in a file git (or Lore) left mid-merge, for the merge editor. Plain Node: no Vue,
 * no Monaco. A block is
 *
 *     <<<<<<< ours-label
 *     ours lines
 *     ||||||| base-label      (diff3 / zdiff3 only)
 *     base lines
 *     =======
 *     theirs lines
 *     >>>>>>> theirs-label
 *
 * Markers are 7 characters long (git's `conflict-marker-size` default). A block is only one where
 * every marker has the length its opening one had, so text that merely looks like markers (longer
 * runs, nested markers of another size from a recursive merge, a lone `=======` under a Markdown
 * heading) stays text. A block that never closes is not a block.
 */

export interface ConflictBlock {
  /** Line index (0-based) of the `<<<<<<<` line. */
  start: number
  /** Line index (0-based) of the `>>>>>>>` line. */
  end: number
  /** Line index of `|||||||`, when there is a base section. */
  baseAt: number | null
  /** Line index of `=======`. */
  splitAt: number
  ours: string[]
  /** Null for a two-way block (no base section). */
  base: string[] | null
  theirs: string[]
  oursLabel: string
  baseLabel: string | null
  theirsLabel: string
}

export interface ParsedConflicts {
  blocks: ConflictBlock[]
  /** The line ending the file uses most: what replacements are written with. */
  eol: '\n' | '\r\n'
  /** The text as lines, without their endings. */
  lines: string[]
  /** The text ends with a line break. */
  trailingEol: boolean
}

export type ConflictChoice = 'ours' | 'theirs' | 'both'

/** Lines of `text`, without their endings (`\n` or `\r\n`). A final line ending makes no empty last line. */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function eolOf(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/** A marker line of `char` repeated exactly `size` times, then the end or a space and a label. */
function marker(line: string, char: string): { size: number; label: string } | null {
  if (line[0] !== char) return null
  let n = 0
  while (line[n] === char) n++
  const rest = line.slice(n)
  if (rest && rest[0] !== ' ' && rest[0] !== '\t') return null
  return { size: n, label: rest.trim() }
}

const SIZE = 7

export function parseConflicts(text: string): ParsedConflicts {
  const lines = splitLines(text)
  const blocks: ConflictBlock[] = []
  let i = 0
  while (i < lines.length) {
    const open = marker(lines[i]!, '<')
    if (!open || open.size !== SIZE) { i++; continue }
    const start = i
    let baseAt: number | null = null
    let splitAt: number | null = null
    let end: number | null = null
    let baseLabel: string | null = null
    let theirsLabel = ''
    let j = i + 1
    for (; j < lines.length; j++) {
      const line = lines[j]!
      if (splitAt === null && baseAt === null) {
        const pipe = marker(line, '|')
        if (pipe?.size === SIZE) { baseAt = j; baseLabel = pipe.label; continue }
      }
      if (splitAt === null) {
        const eq = marker(line, '=')
        if (eq?.size === SIZE && !eq.label) { splitAt = j; continue }
        // Another opening of the same size before this one split: this one was never a block.
        if (marker(line, '<')?.size === SIZE) break
        continue
      }
      const close = marker(line, '>')
      if (close?.size === SIZE) { end = j; theirsLabel = close.label; break }
      if (marker(line, '<')?.size === SIZE) break
    }
    if (splitAt === null || end === null) { i = j > i + 1 && j < lines.length && marker(lines[j]!, '<')?.size === SIZE ? j : i + 1; continue }
    blocks.push({
      start,
      end,
      baseAt,
      splitAt,
      ours: lines.slice(start + 1, baseAt ?? splitAt),
      base: baseAt === null ? null : lines.slice(baseAt + 1, splitAt),
      theirs: lines.slice(splitAt + 1, end),
      oursLabel: open.label,
      baseLabel,
      theirsLabel,
    })
    i = end + 1
  }
  return { blocks, eol: eolOf(text), lines, trailingEol: text.endsWith('\n') }
}

/** Whether `text` still has a conflict: a whole block, or a stray opening or closing marker. */
export function hasConflictMarkers(text: string): boolean {
  if (parseConflicts(text).blocks.length) return true
  return splitLines(text).some(l => marker(l, '<')?.size === SIZE || marker(l, '>')?.size === SIZE)
}

/** The lines a block becomes for `choice`: one side, or ours then theirs. */
export function chosenLines(block: ConflictBlock, choice: ConflictChoice): string[] {
  if (choice === 'ours') return block.ours
  if (choice === 'theirs') return block.theirs
  return [...block.ours, ...block.theirs]
}

/**
 * The edit that resolves `block` with `choice`, in 1-based lines and columns (Monaco's), and its
 * text. It replaces the whole block, markers included; the line ending after the block stays.
 */
export function resolutionEdit(parsed: ParsedConflicts, block: ConflictBlock, choice: ConflictChoice) {
  const lines = chosenLines(block, choice)
  // The block's last line has no line break after it (the file ends there without one).
  const endsFile = block.end >= parsed.lines.length - 1 && !parsed.trailingEol
  if (!lines.length) {
    // Nothing left: take the lines out with the line break that ends them (or, at the end of the
    // file, the one before them).
    if (!endsFile) return { startLine: block.start + 1, startColumn: 1, endLine: block.end + 2, endColumn: 1, text: '' }
    if (block.start > 0) {
      return { startLine: block.start, startColumn: parsed.lines[block.start - 1]!.length + 1, endLine: block.end + 1, endColumn: parsed.lines[block.end]!.length + 1, text: '' }
    }
    return { startLine: 1, startColumn: 1, endLine: block.end + 1, endColumn: parsed.lines[block.end]!.length + 1, text: '' }
  }
  return {
    startLine: block.start + 1,
    startColumn: 1,
    endLine: block.end + 1,
    endColumn: parsed.lines[block.end]!.length + 1,
    text: lines.join(parsed.eol),
  }
}

/** `text` with `block` resolved with `choice` (what `resolutionEdit` does, on a string). */
export function resolveText(text: string, block: ConflictBlock, choice: ConflictChoice): string {
  const parsed = parseConflicts(text)
  const edit = resolutionEdit(parsed, block, choice)
  const offset = (line: number, column: number) => {
    // Offsets from lines and their real endings.
    let at = 0
    let l = 1
    while (l < line) {
      const nl = text.indexOf('\n', at)
      if (nl < 0) return text.length
      at = nl + 1
      l++
    }
    return at + column - 1
  }
  return text.slice(0, offset(edit.startLine, edit.startColumn)) + edit.text + text.slice(offset(edit.endLine, edit.endColumn))
}

/** Which block the cursor line (1-based) is in or before; -1 when it is after them all. */
export function blockAtOrAfter(blocks: ConflictBlock[], line: number): number {
  return blocks.findIndex(b => b.end + 1 >= line)
}

/**
 * Where a block sits in one side's own file, for highlighting it there: the 1-based first line and
 * how many lines. `lines` is that side's text as lines, `wanted` the block's lines from that side,
 * `before` the line just above the block in the result (an anchor when the side has nothing there),
 * `near` the 0-based line it is expected around. Null when it can't be found.
 */
export function locateInSide(lines: string[], wanted: string[], before: string | null, near: number): { line: number; count: number } | null {
  const matchesAt = (at: number) => wanted.every((w, k) => lines[at + k] === w)
  const closest = (hits: number[]) => hits.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0]
  if (wanted.length) {
    const hits: number[] = []
    for (let at = 0; at + wanted.length <= lines.length; at++) if (matchesAt(at)) hits.push(at)
    const at = closest(hits)
    if (at !== undefined) return { line: at + 1, count: wanted.length }
  }
  // Nothing from this side here (it deleted those lines): just after the line above the block.
  if (before === null) return { line: 1, count: 0 }
  const hits: number[] = []
  lines.forEach((l, at) => { if (l === before) hits.push(at) })
  const at = closest(hits)
  return at === undefined ? null : { line: at + 2, count: 0 }
}
