import type {
  CompletionItem, CompletionList, Diagnostic, Hover, Location, LocationLink, MarkedString, MarkupContent, Position, Range, SignatureHelp, TextEdit,
} from './protocol.ts'

/**
 * What a server sends, as Monaco takes it. Servers are untrusted: anything malformed is dropped,
 * markdown is never trusted (no commands, no HTML), and a completion edits only its own document.
 * Types only from Monaco, so this runs in plain Node.
 */

export interface EditorPosition { lineNumber: number; column: number }
export interface EditorRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
/** Monaco's `IMarkdownString`, never with `isTrusted` or `supportHtml`. */
export interface Markdown { value: string }

export const toPosition = (p: EditorPosition): Position => ({ line: p.lineNumber - 1, character: p.column - 1 })

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function toRange(r: Range | null | undefined): EditorRange | null {
  const { start, end } = r ?? {}
  if (!start || !end || !num(start.line) || !num(start.character) || !num(end.line) || !num(end.character)) return null
  return { startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1 }
}

/* ---------- text */

/** Plain text as markdown that reads the same. */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_{}[\]()#+\-.!~<>|=:@]/g, '\\$&')
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]+/gm, lead => '&nbsp;'.repeat(lead.length))
    .replace(/\n/g, '\n\n')
}

function codeBlock(language: unknown, code: string): string {
  const longest = (code.match(/`{3,}/g) ?? []).reduce((n, run) => Math.max(n, run.length), 2)
  const fence = '`'.repeat(longest + 1)
  const id = typeof language === 'string' && /^[\w+#.-]+$/.test(language) ? language : ''
  return `${fence}${id}\n${code}\n${fence}`
}

function markup(content: MarkupContent | MarkedString | null | undefined): Markdown | null {
  let value = ''
  if (typeof content === 'string') value = content
  else if (content && typeof content === 'object' && typeof content.value === 'string') {
    if ('language' in content) value = content.value ? codeBlock(content.language, content.value) : ''
    else value = content.kind === 'markdown' ? content.value : escapeMarkdown(content.value)
  }
  return value.trim() ? { value } : null
}

/** Documentation: a bare string is plain text, which Monaco shows as it is. */
function documentation(doc: unknown): string | Markdown | undefined {
  if (typeof doc === 'string') return doc || undefined
  return markup(doc as MarkupContent) ?? undefined
}

export function toHover(hover: Hover | null): { contents: Markdown[]; range?: EditorRange } | null {
  if (!hover?.contents) return null
  const parts = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  const contents = parts.map(markup).filter((m): m is Markdown => !!m)
  if (!contents.length) return null
  return { contents, range: toRange(hover.range) ?? undefined }
}

/* ---------- completion */

/** LSP's kinds (from 1) by the names Monaco's enum uses. */
const KINDS = [
  'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum',
  'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter',
] as const
export type KindName = typeof KINDS[number]
export const kindName = (kind: unknown): KindName => (num(kind) && KINDS[kind - 1]) || 'Text'

/** A completion's detail is one line beside its name. */
const oneLine = (detail: unknown) => text(detail)?.replace(/\s*[\r\n]+\s*/g, ' ').trim() || undefined

const INSERT_SNIPPET = 2
const KEEP_INDENTATION = 1
const DEPRECATED = 1

/** The commands a completion may run: only these, and without the server's arguments. */
const COMMANDS: Record<string, string> = {
  'editor.action.triggerSuggest': 'editor.action.triggerSuggest',
  'editor.action.triggerParameterHints': 'editor.action.triggerParameterHints',
  'rust-analyzer.triggerParameterHints': 'editor.action.triggerParameterHints',
}

/**
 * A snippet with its variables made literal, tab stops and choices kept: Monaco would fill in
 * `$CLIPBOARD` and the like, and the server would read it back from the document.
 */
export function inertSnippet(snippet: string): string {
  return snippet.replace(/(\\*)\$(?=\{?[A-Za-z_])/g, (all, slashes: string) => (slashes.length % 2 ? all : `${slashes}\\$`))
}

export interface Completion {
  label: string | { label: string; detail?: string; description?: string }
  kind: KindName
  insertText: string
  snippet: boolean
  keepIndentation: boolean
  range: { insert: EditorRange; replace: EditorRange }
  sortText?: string
  filterText?: string
  preselect?: boolean
  deprecated: boolean
  detail?: string
  documentation?: string | Markdown
  additionalTextEdits?: Array<{ range: EditorRange; text: string }>
  command?: { id: string; title: string }
  /** What `completionItem/resolve` gets back: the server's item, with the list's defaults in it. */
  item: CompletionItem
}

function extraEdits(edits: TextEdit[] | undefined): Completion['additionalTextEdits'] | null {
  if (!edits) return undefined
  if (!Array.isArray(edits)) return null
  const out: Array<{ range: EditorRange; text: string }> = []
  for (const edit of edits) {
    const range = toRange(edit?.range)
    // Half of an import is worse than no suggestion.
    if (!range || typeof edit.newText !== 'string') return null
    out.push({ range, text: edit.newText })
  }
  return out.length ? out : undefined
}

/** `fallback`: the word at the caret, for items that name no range. */
export function toCompletions(
  result: CompletionList | CompletionItem[] | null,
  fallback: { insert: EditorRange; replace: EditorRange },
): { items: Completion[]; incomplete: boolean } {
  const list = Array.isArray(result) ? null : result
  const raw = Array.isArray(result) ? result : Array.isArray(list?.items) ? list.items : []
  const defaults = list?.itemDefaults
  const items: Completion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry.label !== 'string') continue
    const edit = entry.textEdit
    let range = fallback
    let insert = text(entry.insertText) ?? entry.label
    if (edit && typeof edit === 'object') {
      const replace = toRange('range' in edit ? edit.range : edit.replace)
      const before = toRange('range' in edit ? edit.range : edit.insert)
      if (!replace || !before || typeof edit.newText !== 'string') continue
      range = { insert: before, replace }
      insert = edit.newText
    } else if (defaults?.editRange) {
      const r = defaults.editRange
      const replace = toRange('start' in r ? r : r.replace)
      const before = toRange('start' in r ? r : r.insert)
      if (!replace || !before) continue
      range = { insert: before, replace }
      insert = text(entry.textEditText) ?? entry.label
    }
    const additionalTextEdits = extraEdits(entry.additionalTextEdits)
    if (additionalTextEdits === null) continue
    const snippet = (entry.insertTextFormat ?? defaults?.insertTextFormat) === INSERT_SNIPPET
    const detail = text(entry.labelDetails?.detail)
    const description = text(entry.labelDetails?.description)
    const command = typeof entry.command?.command === 'string' && Object.hasOwn(COMMANDS, entry.command.command) ? COMMANDS[entry.command.command] : undefined
    items.push({
      label: detail || description ? { label: entry.label, detail, description } : entry.label,
      kind: kindName(entry.kind),
      insertText: snippet ? inertSnippet(insert) : insert,
      snippet,
      keepIndentation: (entry.insertTextMode ?? defaults?.insertTextMode) === KEEP_INDENTATION,
      range,
      sortText: text(entry.sortText),
      filterText: text(entry.filterText),
      preselect: entry.preselect === true || undefined,
      deprecated: entry.deprecated === true || (Array.isArray(entry.tags) && entry.tags.includes(DEPRECATED)),
      detail: oneLine(entry.detail),
      documentation: documentation(entry.documentation),
      additionalTextEdits,
      command: command ? { id: command, title: '' } : undefined,
      item: entry.data === undefined && defaults?.data !== undefined ? { ...entry, data: defaults.data } : entry,
    })
  }
  return { items, incomplete: list?.isIncomplete === true }
}

/** The parts of an item that come later: what it says, and its imports. Never what it inserts. */
export function toResolved(item: CompletionItem | null): Pick<Completion, 'detail' | 'documentation' | 'additionalTextEdits'> {
  const out: Pick<Completion, 'detail' | 'documentation' | 'additionalTextEdits'> = {}
  const detail = oneLine(item?.detail)
  const doc = documentation(item?.documentation)
  const edits = extraEdits(item?.additionalTextEdits)
  if (detail) out.detail = detail
  if (doc) out.documentation = doc
  if (edits) out.additionalTextEdits = edits
  return out
}

/* ---------- parameter hints */

export function toSignatureHelp(help: SignatureHelp | null) {
  if (!help || !Array.isArray(help.signatures)) return null
  const all = help.signatures.filter(s => typeof s?.label === 'string')
  if (!all.length) return null
  const signatures = all.map(s => ({
    label: s.label,
    documentation: documentation(s.documentation),
    activeParameter: num(s.activeParameter) ? s.activeParameter : undefined,
    parameters: (Array.isArray(s.parameters) ? s.parameters : []).flatMap((p) => {
      const label = p?.label
      const span = Array.isArray(label) && num(label[0]) && num(label[1])
      if (!span && typeof label !== 'string') return []
      return [{ label: span ? [label[0], label[1]] as [number, number] : label as string, documentation: documentation(p.documentation) }]
    }),
  }))
  return {
    signatures,
    activeSignature: num(help.activeSignature) && help.activeSignature < signatures.length ? help.activeSignature : 0,
    activeParameter: num(help.activeParameter) ? help.activeParameter : 0,
  }
}

/* ---------- definitions */

export interface Target {
  uri: string
  /** The whole definition, for previews. */
  range: EditorRange
  /** Its name: where the caret goes. */
  selection: EditorRange
  origin?: EditorRange
}

export function toTargets(result: Location | Array<Location | LocationLink> | null): Target[] {
  if (!result) return []
  return (Array.isArray(result) ? result : [result]).flatMap((loc) => {
    if (!loc || typeof loc !== 'object') return []
    const link = 'targetUri' in loc
    const uri = text(link ? loc.targetUri : loc.uri)
    const range = toRange(link ? loc.targetRange : loc.range)
    if (!uri || !range) return []
    return [{
      uri,
      range,
      selection: (link && toRange(loc.targetSelectionRange)) || range,
      origin: (link && toRange(loc.originSelectionRange)) || undefined,
    }]
  })
}

/* ---------- diagnostics */

/** Monaco's `MarkerSeverity` by LSP's severity. */
const SEVERITY: Record<number, 8 | 4 | 2 | 1> = { 1: 8, 2: 4, 3: 2, 4: 1 }
const MAX_MARKERS = 1000
const MAX_MESSAGE = 8000

export interface Marker extends EditorRange {
  severity: 8 | 4 | 2 | 1
  message: string
  source?: string
  code?: string
  tags?: Array<1 | 2>
}

export function toMarkers(list: Diagnostic[] | unknown): Marker[] {
  if (!Array.isArray(list)) return []
  const out: Marker[] = []
  for (const d of list as Diagnostic[]) {
    if (out.length >= MAX_MARKERS) break
    const range = toRange(d?.range)
    const message = typeof d?.message === 'string' ? d.message : text(d?.message?.value)
    if (!range || message === undefined) continue
    out.push({
      ...range,
      severity: SEVERITY[d.severity ?? 1] ?? 8,
      message: message.slice(0, MAX_MESSAGE),
      source: text(d.source),
      code: typeof d.code === 'string' || typeof d.code === 'number' ? String(d.code) : undefined,
      tags: Array.isArray(d.tags) ? d.tags.filter((t): t is 1 | 2 => t === 1 || t === 2) : undefined,
    })
  }
  return out
}
