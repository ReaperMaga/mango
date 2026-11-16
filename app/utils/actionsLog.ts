/**
 * A GitHub Actions step log, read the way GitHub's own log view reads it: `##[group]` … `##[endgroup]`
 * fold into one line, `##[error]`, `##[warning]`, `##[notice]`, `##[debug]` and `[command]` lines are
 * marked, and ANSI colour codes become classes. The text is untrusted: it only ever becomes text nodes.
 */

export type LogLevel = 'error' | 'warning' | 'notice' | 'debug' | 'command' | null

/** A run of text in one style. `fg` is an ANSI colour name (see ANSI_FG). */
export interface LogSpan {
  text: string
  fg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

export interface LogLine {
  /** 1-based within the step, counting lines inside groups, as GitHub numbers them. */
  n: number
  spans: LogSpan[]
  level: LogLevel
}

export type LogEntry =
  | { kind: 'line'; line: LogLine }
  | { kind: 'group'; head: LogLine; lines: LogLine[] }

const ANSI_FG = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

interface Style { fg: string | null; bold: boolean; dim: boolean; italic: boolean; underline: boolean }
const PLAIN: Style = { fg: null, bold: false, dim: false, italic: false, underline: false }

/** Apply one SGR sequence's parameters to a style. Backgrounds and true colour are left out on purpose. */
function sgr(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(';').map(p => (p === '' ? 0 : Number(p)))
  let s = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!
    if (c === 0) s = { ...PLAIN }
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 22) { s.bold = false; s.dim = false }
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c >= 30 && c <= 37) s.fg = ANSI_FG[c - 30]!
    else if (c >= 90 && c <= 97) s.fg = c === 90 ? 'gray' : ANSI_FG[c - 90]!
    else if (c === 39) s.fg = null
    else if (c === 38 || c === 48) {
      // 38;5;n picks from the 256 colours (only the first 16 are kept); 38;2;r;g;b is true colour (dropped).
      const mode = codes[i + 1]
      if (mode === 5) {
        const n = codes[i + 2] ?? -1
        if (c === 38 && n >= 0 && n < 16) s.fg = n === 8 ? 'gray' : ANSI_FG[n % 8]!
        i += 2
      } else if (mode === 2) {
        i += 4
      }
    }
  }
  return s
}

/* eslint-disable no-control-regex -- terminal escape sequences are what this reads */
/** CSI sequences (colours among them), OSC sequences (titles, links), and lone escapes. */
const ESCAPES = /\x1b\[([0-9;?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]?/g
/** Other control characters a log can carry (tabs stay). */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
/* eslint-enable no-control-regex */

/** One line's text as styled runs; every escape sequence that is not a colour is dropped. */
export function ansiSpans(text: string): LogSpan[] {
  const spans: LogSpan[] = []
  let style = { ...PLAIN }
  let last = 0
  const push = (t: string) => {
    const clean = t.replace(CONTROL, '')
    if (!clean) return
    const prev = spans[spans.length - 1]
    if (prev && prev.fg === style.fg && prev.bold === style.bold && prev.dim === style.dim
      && prev.italic === style.italic && prev.underline === style.underline) prev.text += clean
    else spans.push({ text: clean, ...style })
  }
  for (const m of text.matchAll(ESCAPES)) {
    push(text.slice(last, m.index))
    last = m.index! + m[0].length
    if (m[2] === 'm') style = sgr(style, m[1] ?? '')
  }
  push(text.slice(last))
  return spans
}

const MARKER = /^##\[(group|endgroup|error|warning|notice|debug|command|section)\]/

/** A step's lines as GitHub shows them: groups folded under their first line, levels marked. */
export function parseStepLog(lines: string[], firstNumber = 1): LogEntry[] {
  const entries: LogEntry[] = []
  let group: Extract<LogEntry, { kind: 'group' }> | null = null
  let n = firstNumber - 1
  for (const raw of lines) {
    n++
    const marker = MARKER.exec(raw)
    let text = marker ? raw.slice(marker[0].length) : raw
    let level: LogLevel = null
    switch (marker?.[1]) {
      case 'group': {
        const head = { n, spans: ansiSpans(text), level: null }
        group = { kind: 'group', head, lines: [] }
        entries.push(group)
        continue
      }
      case 'endgroup':
        // The closing marker is not shown, nor numbered.
        n--
        group = null
        continue
      case 'error': case 'warning': case 'notice': case 'debug': case 'command':
        level = marker[1]
        break
      default:
        if (text.startsWith('[command]')) {
          text = text.slice('[command]'.length)
          level = 'command'
        }
    }
    const line: LogLine = { n, spans: ansiSpans(text), level }
    if (group) group.lines.push(line)
    else entries.push({ kind: 'line', line })
  }
  return entries
}

/** The plain text of a line, for copying and searching. */
export const lineText = (line: LogLine) => line.spans.map(s => s.text).join('')
