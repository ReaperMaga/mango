/**
 * What Monaco's own workers may do: answer about one file, and edit only that file from the text it
 * has now. Anything across files is a language server's job. Plain Node: types only from Monaco.
 */

/* ---------- the TypeScript worker */

/** The worker's methods that answer about the file named first. */
export const FILE_METHODS = [
  'getScriptText', 'getSyntacticDiagnostics', 'getSemanticDiagnostics', 'getSuggestionDiagnostics', 'getCompilerOptionsDiagnostics',
  'getCompletionsAtPosition', 'getCompletionEntryDetails', 'getSignatureHelpItems', 'getQuickInfoAtPosition', 'getDocumentHighlights',
  'getDefinitionAtPosition', 'getReferencesAtPosition', 'getNavigationTree', 'getFormattingEditsForDocument', 'getFormattingEditsForRange',
  'getFormattingEditsAfterKeystroke', 'findRenameLocations', 'getRenameInfo', 'getEmitOutput', 'getCodeFixesAtPosition', 'provideInlayHints',
] as const

const RENAME_REFUSED = 'Can\'t rename this safely: other files may use this name'

/** The kinds of bindings. A member (a parameter property too) is none: other files reach it through a value. */
const BINDINGS = new Set([
  'var', 'local var', 'let', 'const', 'using', 'await using', 'function', 'local function', 'class', 'local class',
  'interface', 'type', 'enum', 'module', 'alias', 'parameter', 'type parameter', 'label',
])

/** No importer can name it: a binding that is neither exported nor declared for others, or a private member. */
function unreachable(info: { kind: string; kindModifiers?: string; displayName: string }) {
  const modifiers = info.kindModifiers ?? ''
  if (/\b(export|declare)\b/.test(modifiers)) return false
  return BINDINGS.has(info.kind) || /\bprivate\b/.test(modifiers) || info.displayName.startsWith('#')
}

/** What each answer keeps of it. */
const OWN: Record<string, (answer: any, file: string) => unknown> = {
  getDefinitionAtPosition: (found, file) => found?.filter((d: any) => d.fileName === file),
  getReferencesAtPosition: (found, file) => found?.filter((d: any) => d.fileName === file),
  getDocumentHighlights: (found, file) => found?.filter((d: any) => d.fileName === file),
  // Monaco's adapter puts every change of a fix into the current file, whichever file it names.
  getCodeFixesAtPosition: (fixes, file) =>
    fixes?.filter((fix: any) => !fix.commands?.length && fix.changes.every((c: any) => c.fileName === file && !c.isNewFile)),
}

/**
 * Monaco's TypeScript worker with each request seeing only its own file and the standard library:
 * imports do not resolve, scripts share no globals, and no fix, rename or jump has another file to
 * name. One language service still, so the library is parsed once.
 */
export function oneFileWorker(Base: new (...args: any[]) => any): any {
  class OneFile extends Base {
    current?: string

    _getModel(name: string) {
      const model = super._getModel(name)
      return model && model.uri.toString() === this.current ? model : null
    }

    getScriptKind(name: string) {
      // Monaco's knows no .mts or .cts and reads them as JavaScript, types and all as errors. 3: TypeScript.
      return /\.[cm]ts$/i.test(name) ? 3 : super.getScriptKind(name)
    }

    getScriptFileNames() {
      return this.current !== undefined && this._getModel(this.current) ? [this.current] : []
    }

    /** A rename Monaco's adapter can carry out: plain replacements, all in this file. */
    renamable(file: string, position: number): any[] | null {
      const all = this._languageService.findRenameLocations(file, position, false, false, true)
      return all?.length && all.every((l: any) => l.fileName === file && !l.prefixText && !l.suffixText) ? all : null
    }

    async getRenameInfo(file: string, position: number, options: unknown) {
      this.current = file
      const info = this._languageService.getRenameInfo(file, position, options)
      if (!info.canRename) return info
      return unreachable(info) && this.renamable(file, position) ? info : { canRename: false, localizedErrorMessage: RENAME_REFUSED }
    }

    async findRenameLocations(file: string, position: number) {
      this.current = file
      return this.renamable(file, position) ?? undefined
    }
  }

  for (const method of FILE_METHODS) {
    if (Object.hasOwn(OneFile.prototype, method)) continue
    const original = Base.prototype[method]
    const own = OWN[method]
    Object.defineProperty(OneFile.prototype, method, {
      configurable: true,
      writable: true,
      value(this: any, file: string, ...rest: unknown[]) {
        // The worker's methods are async in name only: each is through before another can begin.
        this.current = file
        const answer = original.call(this, file, ...rest)
        return own ? answer.then((found: unknown) => own(found, file)) : answer
      },
    })
  }
  return OneFile
}

/* ---------- the providers around every worker */

interface Document {
  uri: { toString(): string }
  getVersionId(): number
  isDisposed(): boolean
  getWordAtPosition(position: { lineNumber: number; column: number }): { endColumn: number } | null
}

/** The languages Monaco registers worker features for, by a bare id. */
export const WORKER_LANGUAGES = new Set(['typescript', 'javascript', 'json', 'css', 'scss', 'less', 'html', 'handlebars', 'razor'])

const unchanged = (model: Document, version: number) => !model.isDisposed() && model.getVersionId() === version
const isOwn = (model: Document, uri: unknown) => !!uri && String(uri) === model.uri.toString()

/** An answer computed from a text that has changed since is no answer. */
function current(method: (model: Document, ...args: any[]) => unknown) {
  return async (model: Document, ...args: any[]) => {
    const version = model.getVersionId()
    const answer = await method(model, ...args)
    return unchanged(model, version) ? answer : null
  }
}

/** Locations in the file that asked, from its text as it is. */
function ownLocations(method: (model: Document, ...args: any[]) => unknown) {
  const fresh = current(method)
  return async (model: Document, ...args: any[]) => {
    const found: any = await fresh(model, ...args)
    if (!found) return null
    return (Array.isArray(found) ? found : [found]).filter((l: any) => isOwn(model, l.uri))
  }
}

/** A rename of the file that asked and no other, good only for the version it was computed from. */
function ownRename(method: (model: Document, ...args: any[]) => unknown, refused: (model: Document, position: any, reason: string) => void) {
  return async (model: Document, ...args: any[]) => {
    const version = model.getVersionId()
    const result: any = await method(model, ...args)
    if (!result) return null
    if (result.rejectReason) {
      refused(model, args[0], result.rejectReason)
      return result
    }
    if (!unchanged(model, version) || !result.edits.every((e: any) => e.textEdit && isOwn(model, e.resource))) return null
    return { edits: result.edits.map((e: any) => ({ ...e, versionId: version })) }
  }
}

/** Suggestions that replace no more than was there when they were asked for, if more was typed meanwhile. */
function boundedCompletion(method: (model: Document, ...args: any[]) => unknown) {
  return async (model: Document, position: any, ...args: any[]) => {
    const version = model.getVersionId()
    const end = Math.max(position.column, model.getWordAtPosition(position)?.endColumn ?? 0)
    const result: any = await method(model, position, ...args)
    if (!result || model.isDisposed()) return null
    if (unchanged(model, version)) return result
    const bound = (range: any) => ({
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: Math.min(range.endColumn, end),
    })
    for (const item of result.suggestions) {
      if (item.range) item.range = 'insert' in item.range ? { insert: bound(item.range.insert), replace: bound(item.range.replace) } : bound(item.range)
      delete item.additionalTextEdits
    }
    return result
  }
}

/* ---------- words beside the TypeScript worker's */

const WORDS_MAX = 10_000

/** After a dot only members go. A spread's dots are none. */
function afterDot(model: any, line: number, column: number) {
  let before: string = model.getLineContent(line).slice(0, column - 1).trimEnd()
  while (!before && line > 1) before = model.getLineContent(--line).trimEnd()
  return before.endsWith('.') && !before.endsWith('...')
}

/**
 * The worker sees one file and outranks word completion, so words of the project's other open files
 * come with its answer: as plain text, after its own, none it already has. Where it has no answer,
 * Monaco asks word completion anyway.
 */
export function withWords(method: (model: any, ...args: any[]) => unknown, otherWords: (model: any) => Iterable<string>, kind: number) {
  return async (model: any, position: any, ...args: any[]) => {
    const { lineNumber: line, column } = position
    const typed = model.getWordUntilPosition(position)
    const endColumn = model.getWordAtPosition(position)?.endColumn ?? column
    const member = afterDot(model, line, typed.startColumn)
    const result: any = await method(model, position, ...args)
    if (member || !result?.suggestions.length || model.isDisposed()) return result
    const listed = new Set<string>([typed.word, ...result.suggestions.map((s: any) => s.label)])
    const span = (end: number) => ({ startLineNumber: line, startColumn: typed.startColumn, endLineNumber: line, endColumn: end })
    const range = { insert: span(column), replace: span(endColumn) }
    let added = 0
    for (const word of otherWords(model)) {
      if (listed.has(word)) continue
      listed.add(word)
      result.suggestions.push({ label: word, kind, insertText: word, sortText: '~', range })
      if (++added === WORDS_MAX) break
    }
    return result
  }
}

/** Monaco's `register…` functions whose providers return edits or places, and what each is held to. */
export function workerGuards(refused: (model: any, position: any, reason: string) => void) {
  return [
    ['registerCompletionItemProvider', 'provideCompletionItems', boundedCompletion],
    ['registerDefinitionProvider', 'provideDefinition', ownLocations],
    ['registerReferenceProvider', 'provideReferences', ownLocations],
    ['registerRenameProvider', 'provideRenameEdits', (method: any) => ownRename(method, refused)],
    ['registerDocumentFormattingEditProvider', 'provideDocumentFormattingEdits', current],
    ['registerDocumentRangeFormattingEditProvider', 'provideDocumentRangeFormattingEdits', current],
    ['registerOnTypeFormattingEditProvider', 'provideOnTypeFormattingEdits', current],
    ['registerColorProvider', 'provideColorPresentations', current],
  ] as const
}

/* ---------- markdown and links */

/** Markdown as Monaco takes it, trusting nothing: a link's text can come from the file being shown. */
export function untrusted<T extends object>(markdown: T): T {
  return { ...markdown, isTrusted: false, supportHtml: false }
}

/** Where a link clicked in the editor may lead. A command never runs, whoever wrote it. */
export function linkRoute(scheme: string): 'browser' | 'editor' | 'nowhere' {
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return 'browser'
  return scheme === 'file' || scheme === 'mango-peek' ? 'editor' : 'nowhere'
}
