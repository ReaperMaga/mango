import type * as Monaco from 'monaco-editor'
import type { CompletionItem, CompletionList, Hover, Location, LocationLink, ServerCapabilities, SignatureHelp } from '~/lsp/protocol'
import type { Session } from '~/lsp/session'
import { toCompletions, toHover, toPosition, toResolved, toSignatureHelp, toTargets } from '~/lsp/convert'
import { fileKey, uriToFile } from '~/lsp/uri'
import { WORKER_LANGUAGES, refusesFirst, withWords, workerGuards } from '~/lsp/builtins'
import { editorModel } from '~/utils/editorModels'
import { useFiles } from '~/stores/files'
import { call } from '~/composables/useBackend'
import { otherFilesWords } from '~/composables/editorCompletion'
import { PEEK_SCHEME, documentUri } from '~/composables/editorDocuments'
import { languageFor, type MonacoApi } from '~/composables/monaco'
import { decompile } from '~/lsp/decompiled'
import { isMetadataUri } from '~/utils/decompiledTabs'
import { LEGEND, kindMap, toSemanticTokens } from '~/lsp/semanticTokens'

/**
 * Monaco's side of the language servers: providers that ask the model's session, and Monaco's own
 * workers held to their own file and standing back where a server answers.
 */

export interface Served { session: Session; file: string; project: string }
export type Feature = 'completion' | 'hover' | 'signature' | 'definition' | 'semanticTokens'
/** The running server answering for a model, if one has this feature. */
export type ServedBy = (model: Monaco.editor.ITextModel, feature: Feature) => Served | null

export const PROVIDES: Record<Feature, (caps: ServerCapabilities) => boolean> = {
  completion: caps => !!caps.completionProvider,
  hover: caps => !!caps.hoverProvider,
  signature: caps => !!caps.signatureHelpProvider,
  definition: caps => !!caps.definitionProvider,
  semanticTokens: caps => !!caps.semanticTokensProvider?.full && Array.isArray(caps.semanticTokensProvider.legend?.tokenTypes),
}

/**
 * Wrap what Monaco's workers register (for a bare language id) before they do: each is held to its
 * own file and current text (`lsp/builtins.ts`), and stands back for a model a server answers for.
 */
export function gateBuiltIns(monaco: MonacoApi, served: (model: Monaco.editor.ITextModel, feature: Feature) => boolean) {
  const languages = monaco.languages as unknown as Record<string, (selector: unknown, provider: any) => Monaco.IDisposable>
  const gate = (register: string, method: string, wrap: (run: any) => any) => {
    const original = languages[register]!
    languages[register] = (selector, provider) => {
      if (typeof selector !== 'string' || !WORKER_LANGUAGES.has(selector) || !provider[method]) return original(selector, provider)
      const gated = Object.create(provider)
      gated[method] = wrap((...args: unknown[]) => provider[method](...args))
      return original(selector, gated)
    }
  }
  const standBack = (feature: Feature) => (run: any) =>
    (model: Monaco.editor.ITextModel, ...rest: unknown[]) => (served(model, feature) ? null : run(model, ...rest))
  const features: Record<string, Feature> = {
    registerCompletionItemProvider: 'completion',
    registerDefinitionProvider: 'definition',
  }
  for (const [register, method, guard] of workerGuards(showRefusal)) {
    const feature = features[register]
    const answer = feature === 'completion'
      ? (run: any) => guard(withWords(run, model => otherFilesWords(monaco, model), monaco.languages.CompletionItemKind.Text))
      : guard
    gate(register, method, run => (feature ? standBack(feature)(answer(run)) : answer(run)))
  }
  const rename = languages.registerRenameProvider!
  languages.registerRenameProvider = (selector, provider) => rename(selector, refusesFirst(selector, provider))
  // A word is all there is to it: only the worker's own items say where to look up more.
  gate('registerCompletionItemProvider', 'resolveCompletionItem', run =>
    (item: any, ...rest: unknown[]) => (item.uri ? run(item, ...rest) : item))
  gate('registerHoverProvider', 'provideHover', standBack('hover'))
  gate('registerSignatureHelpProvider', 'provideSignatureHelp', standBack('signature'))

  /** Monaco only logs why a rename was refused. */
  function showRefusal(model: Monaco.editor.ITextModel, position: Monaco.IPosition, reason: string) {
    const editor = monaco.editor.getEditors().find(e => e.getModel() === model)
    const messages: any = editor?.getContribution('editor.contrib.messageController')
    messages?.showMessage(reason, position)
  }
}

/** Monaco's `CompletionItem`, remembering who can resolve it. */
interface Suggestion extends Monaco.languages.CompletionItem {
  from?: { session: Session; item: CompletionItem; start: Monaco.IPosition }
}

/** The files definitions were previewed in: a few, and never one an editor shows. */
const PEEK_MAX = 12
/** More targets than this are listed without their text. */
const PREVIEWS = 6
/** Library definitions decompiled for one jump (a server may list every overload's assembly). */
const MAX_DECOMPILED_TARGETS = 3
/** A server still loading its project may take a while to classify a file. */
const TOKENS_TIMEOUT = 15_000
/** What Monaco takes for a cancellation (`isCancellationError`). */
const cancelled = () => Object.assign(new Error('Canceled'), { name: 'Canceled' })

export function languageProviders(monaco: MonacoApi, servedBy: ServedBy) {
  const { languages } = monaco
  const registered = new Map<string, { suggest: Set<string>; sign: Set<string>; resign: Set<string>; subs: Monaco.IDisposable[] }>()
  const peeks = new Map<string, Monaco.editor.ITextModel>()

  async function peek(project: string, root: string, file: string, read: boolean): Promise<Monaco.Uri> {
    const key = `${project}\0${fileKey(root, file)}`
    const text = read ? (await call('fs_read_file', { root: project, file }).catch(() => null))?.text : null
    let model = peeks.get(key)
    if (model?.isDisposed()) model = undefined
    if (typeof text !== 'string') return model?.uri ?? documentUri(monaco, project, file, PEEK_SCHEME)
    if (!model) model = monaco.editor.createModel(text, languageFor(monaco, file), documentUri(monaco, project, file, PEEK_SCHEME))
    else if (model.getValue() !== text) model.setValue(text)
    peeks.delete(key)
    peeks.set(key, model)
    for (const [k, m] of peeks) {
      if (peeks.size <= PEEK_MAX) break
      if (k === key || m.isAttachedToEditor()) continue
      m.dispose()
      peeks.delete(k)
    }
    return model.uri
  }

  const completion = (triggerCharacters: string[]): Monaco.languages.CompletionItemProvider => ({
    triggerCharacters,
    async provideCompletionItems(model, position, context, token) {
      const at = servedBy(model, 'completion')
      if (!at) return null
      const own = at.session.caps.completionProvider?.triggerCharacters ?? []
      const char = context.triggerCharacter
      // Another server's character.
      if (char && !own.includes(char)) return null
      const incomplete = context.triggerKind === languages.CompletionTriggerKind.TriggerForIncompleteCompletions
      const result = await at.session.request<CompletionList | CompletionItem[]>('textDocument/completion', at.file, {
        position: toPosition(position),
        context: char ? { triggerKind: 2, triggerCharacter: char } : { triggerKind: incomplete ? 3 : 1 },
      }, { token, timeout: 8000 })
      if (!result || token.isCancellationRequested || model.isDisposed()) return null
      const word = model.getWordUntilPosition(position)
      const whole = model.getWordAtPosition(position)
      const line = position.lineNumber
      const { items, incomplete: more } = toCompletions(result, {
        insert: { startLineNumber: line, startColumn: word.startColumn, endLineNumber: line, endColumn: position.column },
        replace: { startLineNumber: line, startColumn: word.startColumn, endLineNumber: line, endColumn: whole?.endColumn ?? position.column },
      })
      const Rule = languages.CompletionItemInsertTextRule
      const suggestions = items.map((c): Suggestion => ({
        label: c.label,
        kind: languages.CompletionItemKind[c.kind],
        insertText: c.insertText,
        insertTextRules: (c.snippet ? Rule.InsertAsSnippet : 0) | (c.keepIndentation ? Rule.KeepWhitespace : 0),
        range: c.range,
        sortText: c.sortText,
        filterText: c.filterText,
        preselect: c.preselect,
        tags: c.deprecated ? [languages.CompletionItemTag.Deprecated] : undefined,
        detail: c.detail,
        documentation: c.documentation,
        additionalTextEdits: c.additionalTextEdits,
        command: c.command,
        from: { session: at.session, item: c.item, start: { lineNumber: line, column: c.range.insert.startColumn } },
      }))
      return { suggestions, incomplete: more }
    },
    async resolveCompletionItem(suggestion: Suggestion) {
      const from = suggestion.from
      if (!from?.session.caps.completionProvider?.resolveProvider) return suggestion
      // Not cancelled with the row losing focus: Monaco hands this same promise to the accept, which
      // closes the list, and an import cancelled then would be lost. It ends by its timeout.
      const result = await from.session.send<CompletionItem>('completionItem/resolve', from.item, { timeout: 5000 })
      if (!result) return suggestion
      const resolved = toResolved(result)
      // Resolved from the text as typed so far: on the caret's line only what is left of the word is where it was.
      const { start } = from
      if (resolved.additionalTextEdits?.some(({ range }) => range.endLineNumber === start.lineNumber && range.endColumn > start.column)) {
        delete resolved.additionalTextEdits
      }
      return { ...suggestion, ...resolved }
    },
  })

  const hover: Monaco.languages.HoverProvider = {
    async provideHover(model, position, token) {
      const at = servedBy(model, 'hover')
      return at ? toHover(await at.session.request<Hover>('textDocument/hover', at.file, { position: toPosition(position) }, { token })) : null
    },
  }

  const signature = (trigger: string[], retrigger: string[]): Monaco.languages.SignatureHelpProvider => ({
    signatureHelpTriggerCharacters: trigger,
    signatureHelpRetriggerCharacters: retrigger,
    async provideSignatureHelp(model, position, token, context) {
      const at = servedBy(model, 'signature')
      if (!at) return null
      const value = toSignatureHelp(await at.session.request<SignatureHelp>('textDocument/signatureHelp', at.file, {
        position: toPosition(position),
        // Monaco's trigger kinds are the protocol's.
        context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger },
      }, { token }))
      return value ? { value, dispose() {} } : null
    },
  })

  const definition: Monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position, token) {
      const at = servedBy(model, 'definition')
      if (!at) return null
      const targets = toTargets(await at.session.request<Location | Array<Location | LocationLink>>(
        'textDocument/definition', at.file, { position: toPosition(position) }, { token },
      ))
      const root = at.session.root
      if (!root || !targets.length || token.isCancellationRequested) return null
      // Go to definition stays in the project: a library's files on disk are not opened. What a
      // server decompiled from a compiled library is asked of it and shown read-only.
      const inside = targets.flatMap((target) => {
        const file = uriToFile(root, target.uri)
        return file === null ? [] : [{ target, file }]
      })
      const compiled = at.session.metadataUris ? targets.filter(t => isMetadataUri(t.uri)).slice(0, MAX_DECOMPILED_TARGETS) : []
      const libraries = (await Promise.all(compiled.map(async (target) => {
        const source = await decompile(monaco, at.session, at.project, target.uri, token)
        return source ? [{ uri: source.model.uri, range: target.range, targetSelectionRange: target.selection, originSelectionRange: target.origin }] : []
      }))).flat()
      if (token.isCancellationRequested) return null
      const open = Object.entries(useFiles().open).filter(([, f]) => f.projectPath === at.project)
      const uris = new Map<string, Promise<Monaco.Uri>>()
      const uriOf = (file: string) => {
        const key = fileKey(root, file)
        let uri = uris.get(key)
        if (!uri) {
          const tab = open.find(([, f]) => fileKey(root, f.file) === key)
          const shown = tab ? editorModel(tab[0])?.model : null
          uri = shown && !shown.isDisposed() ? Promise.resolve(shown.uri) : peek(at.project, root, tab?.[1].file ?? file, uris.size < PREVIEWS)
          uris.set(key, uri)
        }
        return uri
      }
      const own = await Promise.all(inside.map(async ({ target, file }) => ({
        uri: await uriOf(file),
        range: target.range,
        targetSelectionRange: target.selection,
        originSelectionRange: target.origin,
      })))
      return [...own, ...libraries]
    },
  }

  /** Monaco asks again for every open file's colours when this fires. */
  const tokensChanged = new monaco.Emitter<void>()
  /** Each start's legend, mapped once. */
  const kindMaps = new WeakMap<ServerCapabilities, Int16Array | null>()
  const semanticTokens: Monaco.languages.DocumentSemanticTokensProvider = {
    onDidChange: tokensChanged.event,
    getLegend: () => LEGEND,
    async provideDocumentSemanticTokens(model, _lastResultId, token) {
      const at = servedBy(model, 'semanticTokens')
      if (!at) return null
      const caps = at.session.caps
      if (!kindMaps.has(caps)) kindMaps.set(caps, kindMap(caps.semanticTokensProvider?.legend))
      const map = kindMaps.get(caps)
      if (!map) return null
      const result = await at.session.ask('textDocument/semanticTokens/full', at.file, {}, { token, timeout: TOKENS_TIMEOUT })
      // No answer (a request overtaken by an edit, a slow reload): Monaco keeps the colours it has
      // for a cancellation, where null would clear them.
      if (result === undefined || token.isCancellationRequested || model.isDisposed()) throw cancelled()
      const data = toSemanticTokens(result, map)
      return data ? { data } : null
    },
    releaseDocumentSemanticTokens() {},
  }

  /** Register for a Monaco language once, and again when a server brings other trigger characters. */
  function ensure(language: string, caps: ServerCapabilities) {
    const had = registered.get(language)
    const suggest = new Set([...had?.suggest ?? [], ...caps.completionProvider?.triggerCharacters ?? []])
    const sign = new Set([...had?.sign ?? [], ...caps.signatureHelpProvider?.triggerCharacters ?? []])
    const resign = new Set([...had?.resign ?? [], ...caps.signatureHelpProvider?.retriggerCharacters ?? []])
    if (had && had.suggest.size === suggest.size && had.sign.size === sign.size && had.resign.size === resign.size) return
    had?.subs.forEach(sub => sub.dispose())
    // An object, not a bare id: what `gateBuiltIns` wraps is only the worker's.
    const selector = { language }
    const subs = [
      languages.registerCompletionItemProvider(selector, completion([...suggest])),
      languages.registerHoverProvider(selector, hover),
      languages.registerSignatureHelpProvider(selector, signature([...sign], [...resign])),
      languages.registerDefinitionProvider(selector, definition),
      languages.registerDocumentSemanticTokensProvider(selector, semanticTokens),
    ]
    registered.set(language, { suggest, sign, resign, subs })
  }

  return { ensure, refreshTokens: () => tokensChanged.fire() }
}
