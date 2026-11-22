import type * as Monaco from 'monaco-editor'
import { useFiles, type OpenFile } from '~/stores/files'
import { editorModel, setEditorModel, type EditorModel } from '~/utils/editorModels'
import { reloadModel } from '~/utils/reloadEdits'
import { fileTabId, parseFileTab } from '~/utils/fileTabs'
import { relativeTo } from '~/lsp/uri'
import { linkRoute } from '~/lsp/builtins'
import { decompiledInFolder, decompiledOfUri, openDecompiled } from '~/lsp/decompiled'
import { ModelUris } from '~/lsp/modelUris'
import { openExternal } from '~/composables/useBackend'
import { languageFor, type MonacoApi } from '~/composables/monaco'

/**
 * The editor's documents: each open file's model, under a URI that tells Monaco's workers its name
 * and extension, kept in step with the disk; and where a jump to another file (a definition, a
 * link) goes, which is a tab.
 *
 * A model's URI is `file:///~<n>/<file>`, `n` the model's own and never used again (`lsp/modelUris.ts`).
 * It is not the file's place on disk (`lsp/uri.ts` makes those).
 */

/** A file shown only as the preview of a definition (no tab of its own). */
export const PEEK_SCHEME = 'mango-peek'

const uris = new ModelUris()

/** A URI for a new model. */
export const documentUri = (monaco: MonacoApi, project: string, file: string, scheme = 'file') =>
  monaco.Uri.from({ scheme, path: uris.next(project, file) })

/** The project and file behind a model's URI (as it was named when the model was made). */
export function fileOfUri(uri: { scheme: string; path: string }): { project: string; file: string } | null {
  return uri.scheme === 'file' || uri.scheme === PEEK_SCHEME ? uris.locate(uri.path) : null
}

/** Monaco's label for a URI, in a peek's header and lists: a model's path inside its project. */
export function uriLabel(uri: { scheme: string; path: string; fsPath: string }): string {
  const library = decompiledOfUri(uri)
  if (library) return library.assembly ? `${library.symbol} (decompiled from ${library.assembly})` : `${library.symbol} (decompiled)`
  const folder = decompiledInFolder(uri)
  if (folder) return folder.assembly ? `decompiled from ${folder.assembly}` : 'decompiled'
  return fileOfUri(uri)?.file ?? (uri.scheme === 'file' ? uri.fsPath : uri.path)
}

/** The tab whose model this is, under the name it has now; null for any other model. */
export function tabOfModel(model: Monaco.editor.ITextModel): string | null {
  for (const id of Object.keys(useFiles().open)) if (editorModel(id)?.model === model) return id
  return null
}

/** The ending that decides how a script is parsed: a rename across it needs a new model. */
const scriptKind = (path: string) => /\.(tsx?|jsx?|[cm][jt]s)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
export const needsNewModel = (entry: EditorModel, file: string) =>
  !entry.model.isDisposed() && scriptKind(entry.model.uri.path) !== scriptKind(file)

export function createDocument(monaco: MonacoApi, project: string, file: string, text: string) {
  return monaco.editor.createModel(text, languageFor(monaco, file), documentUri(monaco, project, file))
}

/**
 * Let a hidden tab's saved caret, selection and scroll move with `change`, as a shown editor's do.
 * Returns once they moved.
 */
function carryViewState(monaco: MonacoApi, entry: EditorModel, change: () => void) {
  const { model, viewState } = entry
  if (!viewState) return change()
  const saved = [...viewState.cursorState.flatMap(c => [c.selectionStart, c.position]), viewState.viewState.firstPosition]
  const marks = model.deltaDecorations([], saved.map((at) => {
    const { lineNumber, column } = model.validatePosition(at)
    return {
      range: new monaco.Range(lineNumber, column, lineNumber, column),
      options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
    }
  }))
  change()
  const moved = marks.map((mark, i) => model.getDecorationRange(mark)?.getEndPosition() ?? saved[i]!)
  model.deltaDecorations(marks, [])
  entry.viewState = {
    ...viewState,
    cursorState: viewState.cursorState.map((c, i) => ({ ...c, selectionStart: moved[i * 2]!, position: moved[i * 2 + 1]! })),
    viewState: { ...viewState.viewState, firstPosition: moved.at(-1)! },
  }
}

/**
 * Keep what each editor showing the model has on screen where it is while `change` adds or removes
 * lines: the caret's line when it is in view, else the top one. At the very top it stays at the top.
 */
function holdScroll(monaco: MonacoApi, model: Monaco.editor.ITextModel, change: () => void) {
  const held = monaco.editor.getEditors().flatMap((editor) => {
    if (editor.getModel() !== model || !editor.getScrollTop()) return []
    const seen = editor.getVisibleRanges()
    const first = seen[0]?.startLineNumber
    if (!first) return []
    const caret = editor.getPosition()?.lineNumber ?? 0
    const line = seen.some(r => r.startLineNumber <= caret && caret <= r.endLineNumber) ? caret : first
    const [mark] = model.deltaDecorations([], [{
      range: new monaco.Range(line, 1, line, 1),
      options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
    }])
    return [{ editor, mark: mark!, offset: editor.getScrollTop() - editor.getTopForLineNumber(line) }]
  })
  change()
  for (const { editor, mark, offset } of held) {
    const now = model.getDecorationRange(mark)
    if (now) editor.setScrollTop(editor.getTopForLineNumber(now.endLineNumber) + offset, monaco.editor.ScrollType.Immediate)
    model.deltaDecorations([mark], [])
  }
}

/** Put what was read from disk in the model, keeping undo, carets and scrolling. */
export function reloadDocument(monaco: MonacoApi, entry: EditorModel, f: OpenFile) {
  const { model } = entry
  const text = f.disk
  if (text === null || model.isDisposed()) return
  // `loadedVersion` moves last: until then what changes here is no edit (`files.edited`).
  reloadModel(model, text, change => holdScroll(monaco, model, () => carryViewState(monaco, entry, change)))
  entry.savedVersion = model.getAlternativeVersionId()
  entry.loadedVersion = f.version
}

/**
 * The model for an open tab, made or brought up to date. A clean file renamed to another kind of
 * script (.ts to .tsx) gets a new one, as its parser goes by the name; the caller shows it, then
 * disposes `replaced`.
 */
export function documentFor(monaco: MonacoApi, tabId: string, f: OpenFile): { entry: EditorModel; replaced: Monaco.editor.ITextModel | null } | null {
  if (f.disk === null) return null
  let entry = editorModel(tabId)
  let replaced: Monaco.editor.ITextModel | null = null
  if (entry && !entry.model.isDisposed()) {
    if (entry.loadedVersion !== f.version) reloadDocument(monaco, entry, f)
    if (f.dirty || f.saving || !needsNewModel(entry, f.file)) {
      const language = languageFor(monaco, f.file)
      if (entry.model.getLanguageId() !== language) monaco.editor.setModelLanguage(entry.model, language)
      return { entry, replaced }
    }
    replaced = entry.model
  }
  const model = createDocument(monaco, f.projectPath, f.file, replaced?.getValue() ?? f.disk)
  entry = { model, savedVersion: model.getAlternativeVersionId(), loadedVersion: f.version, viewState: replaced ? entry!.viewState : null }
  setEditorModel(tabId, entry)
  return { entry, replaced }
}

/* ---------- going to another file */

const positions = new Map<string, { lineNumber: number; column: number }>()

/** Where exactly a tab was asked to show, if its `line` is still the one asked for. */
export function takePosition(tabId: string, line: number) {
  const at = positions.get(tabId)
  positions.delete(tabId)
  return at?.lineNumber === line ? at : null
}

/** Open a file in a tab at a position, keeping the tab it was asked from. */
export function openAt(project: string, file: string, at: { lineNumber: number; column: number }, from: string | null) {
  const files = useFiles()
  // Going somewhere is reading on: neither end takes the other's place as the preview tab.
  if (from) files.pin(from)
  // Windows and servers spell case freely: one file, one tab.
  const open = Object.values(files.open).find(f => f.projectPath === project && f.file.toLowerCase() === file.toLowerCase())
  const name = open && /^([a-z]:|\\\\)/i.test(project) ? open.file : file
  const id = fileTabId(project, name)
  void files.openFile(project, name, true)
  positions.set(id, at)
  files.revealLine(id, at.lineNumber)
}

/**
 * Jumps and links out of the editor: to a tab inside the project (or a library's decompiled source
 * the project's server gave), the browser for the web, nowhere else.
 */
export function routeEditorLinks(monaco: MonacoApi) {
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, where) {
      const model = source.getModel()
      if (!model || model.uri.toString() === resource.toString()) return false
      const from = tabOfModel(model)
      const project = parseFileTab(from)?.projectPath ?? fileOfUri(model.uri)?.project
      if (!project) return false
      const at = !where
        ? { lineNumber: 1, column: 1 }
        : 'startLineNumber' in where ? { lineNumber: where.startLineNumber, column: where.startColumn } : { lineNumber: where.lineNumber, column: where.column }
      // A library's decompiled source, for the folder that asked for it.
      const library = decompiledOfUri(resource)
      if (library) {
        if (library.project !== project) return false
        if (from) useFiles().pin(from)
        openDecompiled(library, at)
        return true
      }
      const target = monaco.editor.getModel(resource)
      const tab = parseFileTab(target ? tabOfModel(target) : null)
      let to = tab ? { project: tab.projectPath, file: tab.file } : fileOfUri(resource)
      if (!to && resource.scheme === 'file') {
        const file = relativeTo(project, resource.fsPath)
        if (file) to = { project, file }
      }
      // Out of the project of the file it was asked from, nothing leads.
      if (!to?.file || to.project !== project) return false
      openAt(to.project, to.file, at, from)
      return true
    },
  })
  monaco.editor.registerLinkOpener({
    open(uri) {
      const route = linkRoute(uri.scheme)
      if (route === 'browser') void openExternal(uri.toString(true)).catch(() => {})
      // Taken here, commands included, unless it is a file for the editor: Monaco's own openers would run them.
      return route !== 'editor'
    },
  })
}
