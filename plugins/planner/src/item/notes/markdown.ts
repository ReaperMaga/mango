/**
 * Markdown to the notes' document and back, and what of a text survives that. No DOM, so it runs anywhere.
 *
 * What is written back keeps every block that was not touched as it was typed (`NotesText`); only the rest is
 * written anew.
 */
import { Marked, type Token, type Tokens } from 'marked'

export interface MarkJson { type: string; attrs?: Record<string, unknown> }
export interface NodeJson {
  type: string
  attrs?: Record<string, unknown>
  content?: NodeJson[]
  marks?: MarkJson[]
  text?: string
}
/** A block's own text, and the blank space between it and the next one. */
export interface Source { text: string; gap: string }
export interface Parsed {
  doc: NodeJson
  /** One per block of the document; null when its text does not stand on its own. */
  sources: Array<Source | null>
  before: string
  after: string
  /** Something in it has no place in the document and is there as plain text only. */
  unknown: boolean
}

const markdown = new Marked({ gfm: true, breaks: false })

/* ---------------------------------------------------------------- reading */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0' }
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code']

class Reader {
  unknown = false

  blocks(tokens: readonly Token[]): NodeJson[] {
    return tokens.flatMap(t => this.block(t) ?? [])
  }

  block(t: Token): NodeJson | null {
    switch (t.type) {
      case 'space':
      case 'checkbox':
        return null
      case 'paragraph':
      case 'text':
        return { type: 'paragraph', content: this.inline((t as Tokens.Paragraph).tokens ?? [], t.raw) }
      case 'heading':
        return { type: 'heading', attrs: { level: (t as Tokens.Heading).depth }, content: this.inline((t as Tokens.Heading).tokens, t.raw) }
      case 'code': {
        const { text, lang } = t as Tokens.Code
        return { type: 'codeBlock', attrs: { language: lang || null }, content: text ? [{ type: 'text', text }] : [] }
      }
      case 'hr':
        return { type: 'horizontalRule' }
      case 'blockquote': {
        const inner = this.blocks((t as Tokens.Blockquote).tokens)
        return { type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph', content: [] }] }
      }
      case 'list':
        return this.list(t as Tokens.List)
      case 'table':
        return this.table(t as Tokens.Table)
      default:
        // Raw HTML, link definitions, and whatever else there may be.
        this.unknown = true
        return { type: 'paragraph', content: plain(t.raw.trim()) }
    }
  }

  list(t: Tokens.List): NodeJson {
    const items = t.items.map((item): NodeJson => {
      let checked: boolean | null = item.task ? !!item.checked : null
      let tokens = item.tokens as Token[]
      // An empty to-do is only its box.
      const empty = /^\[([ xX])\]\s*$/.exec(item.text)
      if (!item.task && empty) {
        checked = empty[1] !== ' '
        tokens = []
      }
      const content = this.blocks(tokens)
      // An item starts with its text.
      if (content[0]?.type !== 'paragraph') {
        if (content.length) this.unknown = true
        content.unshift({ type: 'paragraph', content: [] })
      }
      return { type: 'listItem', attrs: { checked }, content }
    })
    return t.ordered
      ? { type: 'orderedList', attrs: { start: t.start === '' ? 1 : Number(t.start), loose: t.loose }, content: items }
      : { type: 'bulletList', attrs: { loose: t.loose }, content: items }
  }

  table(t: Tokens.Table): NodeJson {
    const cell = (type: string) => (c: Tokens.TableCell, i: number): NodeJson => ({
      type,
      attrs: { align: t.align[i] ?? null },
      content: [{ type: 'paragraph', content: this.inline(c.tokens, c.text) }],
    })
    return {
      type: 'table',
      content: [
        { type: 'tableRow', content: t.header.map(cell('tableHeader')) },
        ...t.rows.map(r => ({ type: 'tableRow', content: r.map(cell('tableCell')) })),
      ],
    }
  }

  inline(tokens: readonly Token[], raw: string): NodeJson[] {
    // Footnotes.
    if (/(?<!\\)\[\^[^\]\s]+\]/.test(raw)) this.unknown = true
    return trimEnds(joinText(this.spans(tokens, [])))
  }

  spans(tokens: readonly Token[], marks: readonly MarkJson[]): NodeJson[] {
    const inner = (t: Token, mark: MarkJson) => this.spans((t as Tokens.Strong).tokens ?? [], [...marks.filter(m => m.type !== mark.type), mark])
    const node = (n: NodeJson, more: readonly MarkJson[] = marks): NodeJson => (more.length ? { ...n, marks: sortMarks(more) } : n)
    const text = (s: string) => (s ? [node({ type: 'text', text: s })] : [])
    return tokens.flatMap((t): NodeJson[] => {
      switch (t.type) {
        case 'text': {
          const nested = (t as Tokens.Text).tokens
          return nested ? this.spans(nested, marks) : text(this.decode(t.raw).replace(/ *\n */g, ' '))
        }
        case 'escape': return text((t as Tokens.Escape).text)
        case 'strong': return inner(t, { type: 'bold' })
        case 'em': return inner(t, { type: 'italic' })
        case 'del': return inner(t, { type: 'strike' })
        case 'codespan': return [node({ type: 'text', text: (t as Tokens.Codespan).text }, [...marks, { type: 'code' }])]
        case 'br': return [node({ type: 'hardBreak' })]
        case 'link': return inner(t, { type: 'link', attrs: { href: (t as Tokens.Link).href, title: (t as Tokens.Link).title || null } })
        case 'image': {
          const { href, text: alt, title } = t as Tokens.Image
          return [node({ type: 'image', attrs: { src: href, alt, title: title || null } })]
        }
        case 'checkbox': return []
        default:
          this.unknown = true
          return text(t.raw)
      }
    })
  }

  decode(text: string): string {
    return text.replace(/&(#[xX][\da-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z\d]{1,31});/g, (all, name: string) => {
      if (name[0] !== '#') {
        if (!(name in ENTITIES)) this.unknown = true
        return ENTITIES[name] ?? all
      }
      const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code < 0xe000) ? String.fromCodePoint(code) : all
    })
  }
}

const plain = (text: string): NodeJson[] => (text ? [{ type: 'text', text: text.replace(/\s*\n\s*/g, ' ') }] : [])
const sortMarks = (marks: readonly MarkJson[]) => [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))
const markKey = (m: MarkJson) => (m.type === 'link' ? `link ${JSON.stringify([m.attrs?.href, m.attrs?.title ?? null])}` : m.type)
const marksKey = (n: NodeJson) => (n.marks ?? []).map(markKey).join(' ')
const has = (n: NodeJson | undefined, type: string) => !!n?.marks?.some(m => m.type === type)

function joinText(nodes: readonly NodeJson[]): NodeJson[] {
  const out: NodeJson[] = []
  for (const n of nodes) {
    const last = out.at(-1)
    if (n.type === 'text' && last?.type === 'text' && marksKey(n) === marksKey(last)) out[out.length - 1] = { ...last, text: last.text! + n.text! }
    else out.push(n)
  }
  return out
}

/** Markdown has no spaces at the ends of a line. */
function trimEnds(nodes: readonly NodeJson[]): NodeJson[] {
  const out = [...nodes]
  for (let i = 0; i < out.length;) {
    const n = out[i]!
    if (n.type === 'text' && !has(n, 'code')) {
      let text = n.text!
      if (i === 0 || out[i - 1]!.type === 'hardBreak') text = text.replace(/^[ \t\n]+/, '')
      if (i === out.length - 1 || out[i + 1]!.type === 'hardBreak') text = text.replace(/[ \t\n]+$/, '')
      if (!text) {
        out.splice(i, 1)
        // What was before it now ends the line.
        i = Math.max(0, i - 1)
        if (!out.length) break
        continue
      }
      out[i] = { ...n, text }
    }
    i++
  }
  while (out.at(-1)?.type === 'hardBreak') out.pop()
  while (out[0]?.type === 'hardBreak') out.shift()
  return out
}

export function parse(text: string): Parsed {
  const reader = new Reader()
  // Front matter would read as a rule and a heading.
  if (/^---\r?\n(?:[\w-]+:.*\r?\n)+---(?:\r?\n|$)/.test(text)) reader.unknown = true
  const content: NodeJson[] = []
  const sources: Array<Source | null> = []
  let before = ''
  let gap = ''
  for (const t of markdown.lexer(text)) {
    const node = reader.block(t)
    if (!node) {
      gap += t.raw
      continue
    }
    const own = t.raw.replace(/\n+$/, '')
    // Blank lines in front are the gap's; indentation is the block's.
    const lead = /^(?:[ \t]*\n)*/.exec(own)![0]
    gap += lead
    const last = sources.at(-1)
    if (last) last.gap = gap
    else if (!content.length) before = gap
    content.push(node)
    const body = own.slice(lead.length)
    sources.push(standsAlone(t, body) ? { text: body, gap: '' } : null)
    gap = t.raw.slice(own.length)
  }
  return {
    doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph', content: [] }] },
    sources, before, after: gap, unknown: reader.unknown,
  }
}

/** Whether a block reads the same wherever it is put. */
function standsAlone(t: Token, text: string): boolean {
  // A fence has to be closed. Indented, it would be part of a list above it.
  if (t.type === 'code') return /^(`{3,}|~{3,})[^\n]*\n(?:[\s\S]*\n)?\1[`~]*[ \t]*$/.test(text)
  return !/^[ \t]/.test(text)
}

/* ---------------------------------------------------------------- writing blocks */

/** The source that followed a source in the text. */
const following = new WeakMap<Source, Source>()

/** Blocks as Markdown. `source` answers the text a block had. */
export function writeBlocks(blocks: readonly NodeJson[], source: (i: number) => Source | null = () => null): string {
  let out = ''
  let prev: { text: string; source: Source | null } | null = null
  blocks.forEach((b, i) => {
    const known = source(i)
    const text = known?.text ?? writeBlock(b, prev?.text ?? '', source(i + 1)?.text ?? '')
    if (text === '') return
    // Two blocks that stood one after the other keep what was between them.
    if (prev) out += (prev.source && known && following.get(prev.source) === known && prev.source.gap) || '\n\n'
    out += text
    prev = { text, source: known }
  })
  return out
}

function writeBlock(b: NodeJson, prev = '', next = ''): string {
  const inner = b.content ?? []
  switch (b.type) {
    case 'paragraph': return writeInline(inner, 'paragraph')
    case 'heading': return `${'#'.repeat(Number(b.attrs?.level ?? 1))} ${writeInline(inner, 'heading')}`.trimEnd()
    case 'horizontalRule': return '---'
    case 'codeBlock': {
      const code = inner.map(n => n.text ?? '').join('')
      const lang = String(b.attrs?.language ?? '').replace(/[\r\n]/g, ' ')
      const mark = lang.includes('`') ? '~' : '`'
      const longest = Math.max(2, ...[...code.matchAll(/`+|~+/g)].filter(m => m[0][0] === mark).map(m => m[0].length))
      const fence = mark.repeat(longest + 1)
      return `${fence}${lang}\n${code ? `${code}\n` : ''}${fence}`
    }
    case 'blockquote': return writeBlocks(inner).split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')
    case 'bulletList':
    case 'orderedList': return writeList(b, prev, next)
    case 'table': return writeTable(b)
    default: return ''
  }
}

const isList = (b: NodeJson) => b.type === 'bulletList' || b.type === 'orderedList'

function writeList(list: NodeJson, prev: string, next: string): string {
  const ordered = list.type === 'orderedList'
  // Beside another list of its kind it takes another marker, or the two would be one.
  const marker = ordered ? /^\d{1,9}([.)])(?=\s|$)/ : /^([-*+])(?=\s|$)/
  const taken = [marker.exec(prev)?.[1], marker.exec(next)?.[1]]
  const mark = (ordered ? ['.', ')'] : ['-', '*', '+']).find(m => !taken.includes(m)) ?? (ordered ? '.' : '-')
  const items = list.content ?? []
  const loose = !!list.attrs?.loose || items.some(i => (i.content ?? []).slice(1).some(b => !isList(b)))
  let n = Number(list.attrs?.start ?? 1)
  return items.map((item) => {
    const bullet = ordered ? `${n++}${mark} ` : `${mark} `
    const { checked } = item.attrs ?? {}
    const inner = item.content ?? []
    // A piece of a list, as it is copied, may start with the list under it.
    const first = inner[0]?.type === 'paragraph' ? inner[0] : undefined
    const rest = first ? inner.slice(1) : inner
    const isTask = typeof checked === 'boolean'
    let body = `${isTask ? (checked ? '[x] ' : '[ ] ') : ''}${writeInline(first?.content ?? [], isTask ? 'task' : 'item')}`
    let before = ''
    for (const b of rest) {
      const text = writeBlock(b, before)
      if (!text) continue
      body = body.replace(/ +$/, '') + (isList(b) && !loose ? '\n' : '\n\n') + text
      before = text
    }
    const pad = ' '.repeat(bullet.length)
    return (bullet + body.split('\n').map((l, i) => (i && l ? pad + l : l)).join('\n')).trimEnd()
  }).join(loose ? '\n\n' : '\n')
}

function writeTable(table: NodeJson): string {
  const rows = (table.content ?? []).map(r => r.content ?? [])
  const width = Math.max(0, ...rows.map(r => r.length))
  if (!width) return ''
  const columns = Array.from({ length: width }, (_, i) => i)
  const line = (cells: readonly string[]) => `| ${columns.map(i => cells[i] ?? '').join(' | ')} |`
  const text = (c: NodeJson) => (c.content ?? []).map(p => writeInline(p.content ?? [], 'cell')).filter(Boolean).join(' ')
  const align = columns.map((i) => {
    const a = rows[0]![i]?.attrs?.align
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
  })
  return [line(rows[0]!.map(text)), line(align), ...rows.slice(1).map(r => line(r.map(text)))].join('\n')
}

/* ---------------------------------------------------------------- writing text */

type Where = 'paragraph' | 'heading' | 'item' | 'task' | 'cell'

/** Marks that overlap can need the other way to write them: the first is the usual one. */
const USUAL: Record<string, string> = { bold: '**', italic: '*', strike: '~~' }
const OTHER: Record<string, string> = { ...USUAL, italic: '_' }

export function writeInline(content: readonly NodeJson[], where: Where = 'paragraph'): string {
  const text = writeSpans(content, where, false)
  if (content.filter(n => n.marks?.some(m => m.type in USUAL)).length < 2 || readsBack(text, content)) return text
  const other = writeSpans(content, where, true)
  return readsBack(other, content) ? other : text
}
function readsBack(text: string, content: readonly NodeJson[]): boolean {
  const token = markdown.lexer(text.replace(/^[[ x]] /, '').replace(/\|/g, '|'))[0] as Tokens.Paragraph | undefined
  const said = (nodes: readonly NodeJson[]) => JSON.stringify(outerSpaces(trimEnds(joinText(nodes.map(n => ({ ...n, marks: sortMarks(n.marks ?? []) })))), true)
    .map(n => [n.type, n.text ?? '', marksKey(n)]))
  return said(new Reader().inline(token?.tokens ?? [], '')) === said(content)
}

function writeSpans(content: readonly NodeJson[], where: Where, strict: boolean): string {
  const DELIMITERS = strict ? OTHER : USUAL
  const oneLine = where === 'heading' || where === 'cell'
  const nodes = outerSpaces(trimEnds(joinText(content.map(n => ({
    ...(oneLine && n.type === 'hardBreak' ? { type: 'text', text: ' ' } : n),
    marks: sortMarks(n.marks ?? []),
  })))), strict)
  const all = nodes.map(n => n.text ?? '').join('')
  const tildes = (all.match(/~/g)?.length ?? 0) > 1 || nodes.some(n => has(n, 'strike'))
  const brackets = all.includes('](') || nodes.some(n => has(n, 'link'))
  let out = ''
  let open: MarkJson[] = []
  const closeTo = (keep: number) => {
    for (const m of open.slice(keep).reverse()) out += m.type === 'link' ? `](${destination(m.attrs?.href, m.attrs?.title)})` : DELIMITERS[m.type] ?? ''
    open = open.slice(0, keep)
  }
  nodes.forEach((n, i) => {
    const next = nodes[i + 1]
    const wanted = nest(n, nodes, i)
    closeTo(commonWith(open, wanted))
    const alone = !open.length && wanted.length === 1 && wanted[0]!.type === 'link' && n.type === 'text' && !has(n, 'code')
      && !has(next, 'link') ? bareLink(n.text!, wanted[0]!, out, next) : null
    if (alone !== null) {
      out += alone
      return
    }
    for (const m of wanted.slice(open.length)) out += m.type === 'link' ? '[' : DELIMITERS[m.type] ?? ''
    open = wanted
    if (n.type === 'hardBreak') out += '\\\n'
    else if (n.type === 'image') out += `![${escapeBrackets(String(n.attrs?.alt ?? ''))}](${destination(n.attrs?.src, n.attrs?.title)})`
    else if (has(n, 'code')) out += codeSpan(n.text!, where)
    else if (n.type === 'text') {
      out += escapeText(n.text!, out, next?.text ?? '', { tildes, brackets, cell: where === 'cell', opens: has(next, 'link') && !has(n, 'link') })
    }
  })
  closeTo(0)
  out = out.trimEnd()
  if (where === 'heading') return out.replace(/(^|\s)(#+)$/, '$1\\$2')
  if (where === 'cell') return out
  return out.split('\n').map((l, i) => {
    const line = i ? l.trimStart() : l
    return i === 0 && where === 'item' && /^\[[ xX]\](\s|$)/.test(line) ? `\\${line}` : escapeStart(line, i > 0)
  }).join('\n')
}

/** Delimiters stand against their text: the spaces at the ends of what is marked go outside (`strict`: wherever marks change). */
function outerSpaces(nodes: readonly NodeJson[], strict: boolean): NodeJson[] {
  const out: NodeJson[] = []
  nodes.forEach((n, i) => {
    if (n.type !== 'text' || has(n, 'code') || !n.marks?.length) return out.push(n)
    const shared = (other: NodeJson | undefined) => n.marks!.filter(m => other?.marks?.some(o => markKey(o) === markKey(m)))
    const only = (other: NodeJson | undefined) => (strict && other && marksKey(other) !== marksKey(n) ? shared(other).filter(m => m.type === 'link') : shared(other))
    const text = n.text!
    const lead = only(nodes[i - 1]).length < n.marks.length ? /^[ \t\n]*/.exec(text)![0] : ''
    const trail = lead.length < text.length && only(nodes[i + 1]).length < n.marks.length ? /[ \t\n]*$/.exec(text)![0] : ''
    if (lead) out.push({ type: 'text', text: lead, marks: only(nodes[i - 1]) })
    if (lead.length + trail.length < text.length) out.push({ ...n, text: text.slice(lead.length, text.length - trail.length) })
    if (trail) out.push({ type: 'text', text: trail, marks: only(nodes[i + 1]) })
  })
  return joinText(out)
}

/** The marks of a node, outermost first: a link, then whichever goes on for longest. */
function nest(n: NodeJson, nodes: readonly NodeJson[], at: number): MarkJson[] {
  const reach = (m: MarkJson) => {
    let from = at
    let to = at
    while (nodes[from - 1]?.marks?.some(o => markKey(o) === markKey(m))) from--
    while (nodes[to + 1]?.marks?.some(o => markKey(o) === markKey(m))) to++
    return to - from
  }
  return (n.marks ?? []).filter(m => m.type !== 'code').sort((a, b) =>
    Number(b.type === 'link') - Number(a.type === 'link') || reach(b) - reach(a) || MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))
}

function commonWith(open: readonly MarkJson[], wanted: readonly MarkJson[]): number {
  let n = 0
  while (n < open.length && n < wanted.length && markKey(open[n]!) === markKey(wanted[n]!)) n++
  return n
}

function escapeText(text: string, before: string, after: string, o: { tildes: boolean; brackets: boolean; cell: boolean; opens: boolean }): string {
  let s = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const prev = i ? text[i - 1]! : before.at(-1) ?? ' '
    const next = text[i + 1] ?? after[0] ?? ' '
    s += mustEscape(c, prev, next, text.slice(i, i + 40) + after.slice(0, 40), i === text.length - 1, o) ? `\\${c}` : c
  }
  return s
}
function mustEscape(c: string, prev: string, next: string, rest: string, last: boolean, o: { tildes: boolean; brackets: boolean; cell: boolean; opens: boolean }): boolean {
  const apart = /\s/.test(prev) && /\s/.test(next)
  switch (c) {
    case '\\': return last || /[!-/:-@[-`{-~\s]/.test(next)
    case '*': return !apart
    case '_': return !apart && !(/[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next))
    case '`': return true
    case '~': return o.tildes
    case '[': return o.brackets || next === '^'
    case ']': return o.brackets
    case '<': return /[a-zA-Z/!?]/.test(next)
    case '&': return /^&(?:#\w+|\w+);/.test(rest)
    case '|': return o.cell
    case '!': return next === '[' || (o.opens && last)
    default: return false
  }
}

/** What would start a block at the start of a line; `inside`: the line goes on a paragraph. */
function escapeStart(line: string, inside: boolean): string {
  if (/^\d{1,9}[.)](\s|$)/.test(line)) return line.replace(/[.)]/, '\\$&')
  const block = /^(#{1,6}(\s|$)|>|[-+*](\s|$)|~{3}|`{3}|\[[^\]]*\]:)/.test(line)
    || /^([-_])\s*(\1\s*){2,}$/.test(line)
    // An underline of a heading, or the second row of a table.
    || (inside && /^(=+\s*|[\s|:-]*-[\s|:-]*)$/.test(line))
  return block ? `\\${line}` : line
}

function codeSpan(text: string, where: Where): string {
  const code = text.replace(/\n/g, ' ')
  const runs = new Set([...code.matchAll(/`+/g)].map(m => m[0].length))
  let n = 1
  while (runs.has(n)) n++
  const fence = '`'.repeat(n)
  const pad = /^`|`$/.test(code) || (/^ .* $/.test(code) && /\S/.test(code)) ? ' ' : ''
  const out = fence + pad + code + pad + fence
  return where === 'cell' ? out.replaceAll('|', '\\|') : out
}

const escapeBrackets = (s: string) => s.replace(/[[\]\\]/g, '\\$&').replace(/\s*\n\s*/g, ' ')

function destination(to: unknown, title: unknown): string {
  const href = String(to ?? '').replace(/[\r\n]/g, '')
  const name = title ? ` "${String(title).replace(/\s*\n\s*/g, ' ').replace(/["\\]/g, '\\$&')}"` : ''
  return (href === '' || /[\s()<>\\]/.test(href) ? `<${href.replace(/[<>\\]/g, '\\$&')}>` : href) + name
}

/** A link whose text is its address, written without a text of its own; null when it is not one. */
function bareLink(text: string, m: MarkJson, before: string, next: NodeJson | undefined): string | null {
  const href = String(m.attrs?.href ?? '')
  if (m.attrs?.title || /[\s<>\\`]/.test(text) || (text !== href && href !== `http://${text}` && href !== `mailto:${text}`)) return null
  const free = /(^|\s)$/.test(before) && (!next || next.type === 'hardBreak' || /^\s/.test(next.text ?? ''))
  if (free && readsAs(text, text, href)) return text
  return readsAs(`<${text}>`, text, href) ? `<${text}>` : null
}
function readsAs(source: string, text: string, href: string): boolean {
  const tokens = (markdown.lexer(source)[0] as Tokens.Paragraph | undefined)?.tokens
  const only = tokens?.length === 1 ? tokens[0] as Tokens.Link : null
  return only?.type === 'link' && only.href === href && only.text === text
}

/* ---------------------------------------------------------------- what survives */

/** A document without what does not change what it says. */
function canonical(n: NodeJson): unknown {
  const attrs = Object.entries(n.attrs ?? {}).filter(([k, v]) => k !== 'loose' && v !== null && v !== undefined).sort()
  const inline = n.type === 'paragraph' || n.type === 'heading'
  const content = inline ? trimEnds(joinText(n.content ?? [])) : n.content ?? []
  return [n.type, attrs, n.text ?? null, n.marks?.map(markKey) ?? [], content.map(canonical)]
}
export const sameDoc = (a: NodeJson, b: NodeJson) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** Whether all of a text can be edited as rich text: read and written anew, it says the same. */
export function fitsRichText(text: string, parsed: Parsed = parse(text)): boolean {
  if (parsed.unknown) return false
  const again = parse(writeBlocks(parsed.doc.content ?? []))
  return !again.unknown && sameDoc(parsed.doc, again.doc)
}

/** Whether pasted plain text is Markdown rather than just words. */
export function looksLikeMarkdown(text: string): boolean {
  return /^ {0,3}(#{1,6} |> |[-*+] |\d{1,9}[.)] |`{3}|~{3}|\|.*\|\s*$|(?:-{3,}|\*{3,})\s*$)/m.test(text)
    || /\*\*\S|__\S|(^|\s)[*_][^\s*_][^*_\n]*[*_](?=\W|$)|`[^`\n]+`|~~\S|\[[^\]\n]+\]\([^)\s]+/.test(text)
}

/** The text a document came from, for writing it back. `N`: the editor's nodes. */
export class NotesText<N extends object> {
  private known = new WeakMap<N, Source>()
  private blocks: Array<{ node: N; source: Source }> = []
  private first: Source | null = null
  private last: Source | null = null
  /** The whole of it, for a document that is (again) as it was. */
  private text = ''
  private nodes: readonly N[] = []
  private before = ''
  private after = ''
  private readonly json: (n: N) => NodeJson
  private readonly same: (a: N, b: N) => boolean

  constructor(json: (n: N) => NodeJson, same: (a: N, b: N) => boolean) {
    this.json = json
    this.same = same
  }

  /** `nodes`: the document's blocks, as made from what was parsed. */
  set(text: string, parsed: Parsed, nodes: readonly N[]) {
    const { sources } = parsed
    const fits = nodes.length === sources.length
    this.known = new WeakMap()
    this.blocks = []
    if (fits) {
      sources.forEach((source, i) => {
        if (!source) return
        this.known.set(nodes[i]!, source)
        this.blocks.push({ node: nodes[i]!, source })
        const next = sources[i + 1]
        if (next) following.set(source, next)
      })
    }
    this.first = fits ? sources[0] ?? null : null
    this.last = fits ? sources.at(-1) ?? null : null
    this.text = text
    this.nodes = nodes
    this.before = parsed.before
    this.after = parsed.after
  }

  private source(n: N | undefined): Source | null {
    if (!n) return null
    const s = this.known.get(n)
    if (s) return s
    // Taken back with undo it is another node of the same content.
    const found = this.blocks.find(b => this.same(b.node, n))
    if (found) this.known.set(n, found.source)
    return found?.source ?? null
  }

  write(nodes: readonly N[]): string {
    const same = this.nodes.every((n, i) => nodes[i] === n || (nodes[i] && this.same(nodes[i], n)))
    if (same && nodes.slice(this.nodes.length).every(n => writeBlock(this.json(n)) === '')) return this.text
    // Empty paragraphs are not in the text.
    const full = nodes.map(n => ({ source: this.source(n), json: this.json(n) })).filter(b => b.source || writeBlock(b.json) !== '')
    const text = writeBlocks(full.map(b => b.json), i => full[i]?.source ?? null)
    const head = this.first && full[0]?.source === this.first ? this.before : ''
    const tail = this.last && full.at(-1)?.source === this.last ? this.after : ''
    return head + text + tail
  }
}
