/**
 * Reading and editing .env files without losing what the user wrote.
 *
 * Parsing follows common dotenv / docker-compose behaviour: an optional `export ` prefix, spaces around the key
 * and `=`, unquoted values that end at ` #` (an inline comment), literal '…' and `…`, and "…" with \n \r \t \" \\
 * escapes. Quoted values may span lines. Anything else (comments, blanks, lines that are not KEY=VALUE) is kept
 * as it is by `applyEntries`.
 *
 * Plain TypeScript with no imports, so it runs in Node as well as the app.
 */

export interface EnvEntry {
  key: string
  /** The decoded value (quotes removed, escapes in double quotes decoded). */
  value: string
  /** Index of the first source line of this entry in the parsed text; null for an entry the user added. */
  line: number | null
}

type Quote = '"' | "'" | '`' | ''

/** One line of the text: content is `start..end`, its line terminator `end..next`. */
interface Line {
  start: number
  end: number
  next: number
}

/** An entry as found in the text, with the pieces needed to rewrite it in place. */
interface Found {
  key: string
  value: string
  /** First and last line of the entry (they differ for a multi-line quoted value). */
  line: number
  last: number
  /** Leading whitespace and `export `. */
  prefix: string
  /** Whitespace before `=`, and `=`. */
  eq: string
  /** Whitespace between `=` and the value. */
  lead: string
  quote: Quote
  /** The inline comment after the value, with the whitespace before it. */
  suffix: string
}

interface Scanned {
  body: string
  lines: Line[]
  found: Found[]
  /** Lines that are not part of an entry: blanks, comments and anything unparseable. */
  others: number[]
}

/** `KEY=` at the start of a line: indent and `export `, the key, and the `=` with any spaces before it. */
const HEAD = /^([ \t]*(?:export[ \t]+)?)([^\s=]+)([ \t]*=)/

/** Unquoted values that need no quoting for any common loader. */
const BARE = /^[\w./:@%+,=~-]+$/

const BOM = '﻿'

/** A key a dotenv loader accepts. */
export function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)
}

/** End of the content of the line that holds `from` (before its `\n` or `\r\n`). */
function lineEndAt(text: string, from: number): number {
  const n = text.indexOf('\n', from)
  if (n < 0) return text.length
  return n > from && text[n - 1] === '\r' ? n - 1 : n
}

function splitLines(body: string): Line[] {
  const lines: Line[] = []
  for (let s = 0; s < body.length;) {
    const n = body.indexOf('\n', s)
    const next = n < 0 ? body.length : n + 1
    const end = n < 0 ? body.length : n > s && body[n - 1] === '\r' ? n - 1 : n
    lines.push({ start: s, end, next })
    s = next
  }
  return lines
}

/** Decode the escapes dotenv loaders honour in a double-quoted value; other backslashes stay as written. */
function unescapeDouble(raw: string): string {
  return raw.replace(/\\([\s\S])/g, (all, c: string) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === '"' || c === '\\' ? c : all)
}

/** Read the value that starts at `p` (just after `=`). `end` is the end of the content of its last line. */
function scanValue(text: string, p: number): { value: string, quote: Quote, lead: string, suffix: string, close: number, end: number } {
  const eol = lineEndAt(text, p)
  let q = p
  while (q < eol && (text[q] === ' ' || text[q] === '\t')) q++
  const ch = text[q]
  if (ch === '"' || ch === "'" || ch === '`') {
    let c = q + 1
    for (; c < text.length; c++) {
      if (ch === '"' && text[c] === '\\') c++
      else if (text[c] === ch) break
    }
    if (c < text.length) {
      const raw = text.slice(q + 1, c)
      const end = lineEndAt(text, c + 1)
      // After the closing quote only a comment counts; stray text there is dropped if the entry is rewritten.
      const after = text.slice(c + 1, end)
      const hash = after.search(/\s*#/)
      return {
        value: ch === '"' ? unescapeDouble(raw) : raw,
        quote: ch,
        lead: text.slice(p, q),
        suffix: hash < 0 ? '' : after.slice(hash),
        close: c,
        end,
      }
    }
    // No closing quote: read it as an unquoted value, quote character included.
  }
  const full = text.slice(p, eol)
  const hash = full.search(/\s+#/)
  const part = hash < 0 ? full : full.slice(0, hash)
  const value = part.trim()
  return {
    value,
    quote: '',
    lead: value ? /^\s*/.exec(part)![0] : '',
    suffix: hash < 0 ? '' : full.slice(hash),
    close: eol,
    end: eol,
  }
}

function scan(text: string): Scanned {
  const body = text.startsWith(BOM) ? text.slice(1) : text
  const lines = splitLines(body)
  const found: Found[] = []
  const others: number[] = []
  for (let i = 0; i < lines.length;) {
    const ln = lines[i]!
    const m = HEAD.exec(body.slice(ln.start, ln.end))
    if (!m || !isValidKey(m[2]!)) {
      others.push(i++)
      continue
    }
    const v = scanValue(body, ln.start + m[0].length)
    let last = i
    while (last + 1 < lines.length && lines[last + 1]!.start <= v.close) last++
    found.push({
      key: m[2]!, value: v.value, line: i, last,
      prefix: m[1]!, eq: m[3]!, lead: v.lead, quote: v.quote, suffix: v.suffix,
    })
    i = last + 1
  }
  return { body, lines, found, others }
}

/** All KEY=VALUE entries in source order (duplicates included). Comments, blanks and unparseable lines are skipped. */
export function parseEnv(text: string): EnvEntry[] {
  return scan(text).found.map(f => ({ key: f.key, value: f.value, line: f.line }))
}

function doubleQuote(value: string): string {
  return '"' + value.replace(/[\\"\n\r]/g, c => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\' + c)) + '"'
}

/**
 * Value as it should be written after `KEY=`: bare when safe, otherwise '...' when that is lossless (one line, no
 * `'`; it also keeps `$` literal for loaders that expand variables), otherwise "..." with \n, \r, \", \\ escaped.
 */
export function formatValue(value: string): string {
  if (value === '' || BARE.test(value)) return value
  if (!/['\r\n]/.test(value)) return `'${value}'`
  return doubleQuote(value)
}

/** Whether `written`, read back after `KEY=`, is exactly `value` with nothing left over. */
function readsAs(written: string, value: string): boolean {
  const v = scanValue(written, 0)
  return v.value === value && v.suffix === '' && v.end === written.length && !/[\r\n]/.test(written)
}

/** Write `value` in the entry's original quote style when that still reads back the same, else `formatValue`. */
function formatLike(value: string, quote: Quote): string {
  const written = quote === '"' ? doubleQuote(value) : quote + value + quote
  return readsAs(written, value) ? written : formatValue(value)
}

/**
 * Rewrite `text` so its entries are `entries`, keeping everything else:
 * - lines of entries whose key and value are unchanged stay byte-identical (`export `, quoting, inline comment, spacing);
 * - a changed entry is rewritten in place, keeping its `export ` prefix and inline comment, quoted only as needed
 *   (in its original quote style when that still works);
 * - an original entry missing from `entries` (by `line`) is removed, all of its lines; comments and blanks stay;
 * - entries with line === null are appended at the end (as is an entry whose `line` no longer starts one);
 * - the line ending (\n vs \r\n), a leading BOM and the presence of a trailing newline are kept
 *   (an empty text gets one).
 * Order of `entries` matters only for the new ones. Keys are written as given: check them with `isValidKey`.
 */
export function applyEntries(text: string, entries: EnvEntry[]): string {
  const { body, lines, found } = scan(text)
  const eol = /\r?\n/.exec(body)?.[0] ?? '\n'
  const byLine = new Map<number, Found>(found.map(f => [f.line, f]))
  const wanted = new Map<number, EnvEntry>()
  const added: EnvEntry[] = []
  for (const e of entries) {
    if (e.line !== null && byLine.has(e.line) && !wanted.has(e.line)) wanted.set(e.line, e)
    else if (e.line === null || !byLine.has(e.line)) added.push(e)
  }

  let out = ''
  for (let i = 0; i < lines.length;) {
    const f = byLine.get(i)
    if (!f) {
      out += body.slice(lines[i]!.start, lines[i]!.next)
      i++
      continue
    }
    const want = wanted.get(i)
    const last = lines[f.last]!
    if (want && want.key === f.key && want.value === f.value) {
      out += body.slice(lines[i]!.start, last.next)
    }
    else if (want) {
      const value = formatLike(want.value, f.quote)
      // A comment must follow whitespace, or a bare value would swallow it.
      const suffix = f.suffix.startsWith('#') ? ' ' + f.suffix : f.suffix
      out += f.prefix + want.key + f.eq + (value ? f.lead : '') + value + suffix + body.slice(last.end, last.next)
    }
    i = f.last + 1
  }

  if (added.length) {
    if (out && !out.endsWith('\n')) out += eol
    for (const e of added) out += e.key + '=' + formatValue(e.value) + eol
  }

  const trailing = body === '' || body.endsWith('\n')
  if (trailing && out && !out.endsWith('\n')) out += eol
  if (!trailing) out = out.replace(/\r?\n$/, '')
  return (text.startsWith(BOM) ? BOM : '') + out
}

/** Parse pasted text like "A=1\nB=2" (or a single "A=1") into new entries (line: null); [] when it isn't env text. */
export function entriesFromPaste(text: string): EnvEntry[] {
  const { body, lines, found, others } = scan(text)
  // Every line that is not an entry must be blank or a comment, or this is some other text.
  const stray = others.some(i => !/^\s*(#.*)?$/.test(body.slice(lines[i]!.start, lines[i]!.end)))
  if (stray) return []
  return found.map(f => ({ key: f.key, value: f.value, line: null }))
}
