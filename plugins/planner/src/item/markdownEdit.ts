/** Editing Markdown as text: what Enter, Tab and the format keys do. Plain functions over a text and a selection. */

export interface Edit {
  /** This part of the text … */
  from: number
  to: number
  /** … becomes this. */
  insert: string
  /** The selection after it. */
  start: number
  end: number
}

const ITEM = /^((?:\s*>)*\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/
const QUOTE = /^((?:\s*>)+ ?)/
const TASK = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])(?=\s)/

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text: string, at: number) => {
  const i = text.indexOf('\n', at)
  return i < 0 ? text.length : i
}

/** Whether a position is inside a fenced code block. */
function inCode(text: string, at: number): boolean {
  let fence: string | null = null
  for (const line of text.slice(0, lineStart(text, at)).split('\n')) fence = nextFence(line, fence)
  return fence !== null
}
function nextFence(line: string, fence: string | null): string | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return fence
  if (fence === null) return m[1]![0] === '`' && m[2]!.includes('`') ? null : m[1]!
  return m[1]![0] === fence[0] && m[1]!.length >= fence.length && !m[2]!.trim() ? null : fence
}

/** Enter: a list goes on, an empty entry of it ends it. Null: an ordinary new line. */
export function onEnter(text: string, start: number, end: number): Edit | null {
  if (start !== end || inCode(text, start)) return null
  const from = lineStart(text, start)
  const line = text.slice(from, lineEnd(text, start))
  const m = ITEM.exec(line) ?? QUOTE.exec(line)
  if (!m || start - from < m[0].length) return null
  if (!line.slice(m[0].length).trim()) {
    // Out of the list: one level up when it is indented, else a plain line.
    const indent = /^\s+/.exec(line)?.[0] ?? ''
    if (m[2] && indent) return outdentLine(text, from, start)
    return { from, to: from + line.length, insert: '', start: from, end: from }
  }
  let prefix = m[0]
  if (m[2]) {
    const n = /^(\d+)([.)])$/.exec(m[2])
    prefix = `${m[1]}${n ? `${Number(n[1]) + 1}${n[2]}` : m[2]}${m[3]}${m[4] ? '[ ] ' : ''}`
  }
  const insert = `\n${prefix}`
  return { from: start, to: start, insert, start: start + insert.length, end: start + insert.length }
}

function outdentLine(text: string, from: number, caret: number): Edit {
  const spaces = /^(?:\t| {1,2})/.exec(text.slice(from))?.[0].length ?? 0
  return { from, to: from + spaces, insert: '', start: Math.max(from, caret - spaces), end: Math.max(from, caret - spaces) }
}

/** Tab and Shift+Tab: in a list or over several lines, its level; elsewhere Tab puts two spaces. Null: nothing to do. */
export function onTab(text: string, start: number, end: number, back: boolean): Edit | null {
  const from = lineStart(text, start)
  // A selection up to a line's start does not include that line.
  const to = lineEnd(text, end > start && text[end - 1] === '\n' ? end - 1 : end)
  const lines = text.slice(from, to).split('\n')
  if (!back && lines.length === 1 && !ITEM.test(lines[0]!)) {
    return { from: start, to: end, insert: '  ', start: start + 2, end: start + 2 }
  }
  let first = 0
  let total = 0
  const next = lines.map((l, i) => {
    const cut = back ? /^(?:\t| {1,2})/.exec(l)?.[0].length ?? 0 : 0
    const by = back ? -cut : l.trim() ? 2 : 0
    if (i === 0) first = by
    total += by
    return back ? l.slice(cut) : by ? `  ${l}` : l
  })
  if (!total) return null
  const at = (p: number, by: number) => Math.max(from, p + by)
  return { from, to, insert: next.join('\n'), start: at(start, first), end: at(end, total) }
}

/** Bold, italic, code: around the selection, or taken away again. */
export function wrap(text: string, start: number, end: number, mark: string): Edit {
  const n = mark.length
  const chosen = text.slice(start, end)
  // How many of the mark's character there are right at each side: three stars are bold and italic.
  const before = /(\**)$/.exec(text.slice(0, start))![1]!.length
  const after = /^(\**)/.exec(text.slice(end))![1]!.length
  const around = Math.min(before, after)
  const marked = mark === '*' ? around % 2 === 1 : mark === '**' ? around >= 2 : text.slice(Math.max(0, start - n), start) === mark && text.slice(end, end + n) === mark
  if (marked) {
    return { from: start - n, to: end + n, insert: chosen, start: start - n, end: end - n }
  }
  // Spaces at the edges stay outside: `** a**` is not bold.
  const lead = chosen.trim() ? chosen.length - chosen.trimStart().length : 0
  const trail = chosen.trim() ? chosen.length - chosen.trimEnd().length : 0
  const core = chosen.slice(lead, chosen.length - trail)
  const insert = `${chosen.slice(0, lead)}${mark}${core}${mark}${chosen.slice(chosen.length - trail)}`
  return { from: start, to: end, insert, start: start + lead + n, end: start + lead + n + core.length }
}

/** A link: the selection as its text, or as its address. */
export function link(text: string, start: number, end: number): Edit {
  const chosen = text.slice(start, end)
  if (/^https?:\/\/\S+$/.test(chosen)) return { from: start, to: end, insert: `[](${chosen})`, start: start + 1, end: start + 1 }
  const at = start + chosen.length + 3
  return { from: start, to: end, insert: `[${chosen}](url)`, ...(chosen ? { start: at, end: at + 3 } : { start: start + 1, end: start + 1 }) }
}

/** Every selected line becomes an entry (`- `, `- [ ] `, `1. `), or stops being one when all are. */
export function toggleList(text: string, start: number, end: number, kind: 'bullet' | 'task'): Edit {
  const from = lineStart(text, start)
  const to = lineEnd(text, end > start && text[end - 1] === '\n' ? end - 1 : end)
  const lines = text.slice(from, to).split('\n')
  const isOne = (l: string) => {
    const m = ITEM.exec(l)
    return !!m && (kind === 'task') === !!m[4]
  }
  const filled = lines.filter(l => l.trim())
  const off = filled.length > 0 && filled.every(isOne)
  const mark = kind === 'task' ? '- [ ] ' : '- '
  const next = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l
    const m = ITEM.exec(l)
    const indent = /^\s*/.exec(l)![0]
    const rest = m ? l.slice(m[0].length) : l.slice(indent.length)
    return off ? `${indent}${rest}` : `${indent}${mark}${rest}`
  })
  const insert = next.join('\n')
  const grown = insert.length - (to - from)
  const firstGrown = next[0]!.length - lines[0]!.length
  return start === end
    ? { from, to, insert, start: Math.max(from, start + firstGrown), end: Math.max(from, start + firstGrown) }
    : { from, to, insert, start: from, end: to + grown }
}

/** The task boxes of a text in order: where their mark is, and whether it is set. */
export function taskMarks(text: string): Array<{ at: number; done: boolean }> {
  const out: Array<{ at: number; done: boolean }> = []
  let fence: string | null = null
  let at = 0
  for (const line of text.split('\n')) {
    const was = fence
    fence = nextFence(line, fence)
    const m = was === null && fence === null ? TASK.exec(line) : null
    if (m) out.push({ at: at + m[1]!.length, done: m[2] !== ' ' })
    at += line.length + 1
  }
  return out
}

/** The text with that task box turned. */
export function toggleTask(text: string, index: number): string {
  const t = taskMarks(text)[index]
  return t ? `${text.slice(0, t.at)}${t.done ? ' ' : 'x'}${text.slice(t.at + 1)}` : text
}

export const applyEdit = (text: string, e: Edit): string => text.slice(0, e.from) + e.insert + text.slice(e.to)
