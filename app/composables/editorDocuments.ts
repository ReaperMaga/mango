import type * as Monaco from 'monaco-editor'
import { useFiles, type OpenFile } from '~/stores/files'
import { editorModel, setEditorModel, type EditorModel } from '~/utils/editorModels'
import { eolOf, reloadEdits, splitLines } from '~/utils/reloadEdits'
import { fileTabId, parseFileTab } from '~/utils/fileTabs'
import { relativeTo } from '~/lsp/uri'
import { openExternal } from '~/composables/useBackend'
import { languageFor, type MonacoApi } from '~/composables/monaco'

/**
 * The editor's documents: each open file's model, under a URI that tells Monaco's workers its name
 * and extension, kept in step with the disk; and where a jump to another file (a definition, a
 * link) goes, which is a tab.
 *
 * A model's URI is `file:///~<n>/<file>`, `n` standing for its project: two worktrees' files, a
 * Windows path and a remote project's are all alike to the workers, and imports between open files
 * of one project resolve. It is not the file's place on disk (`lsp/uri.ts` makes those).
 */

/** A file shown only as the preview of a definition (no tab of its own). */
export const PEEK_SCHEME = 'mango-peek'

const projects: string[] = []
function projectNumber(project: string) {
  const at = projects.indexOf(project)
  return at >= 0 ? at : projects.push(project) - 1
}

export function documentUri(monaco: MonacoApi, project: string, file: string, scheme = 'file', copy = 0) {
  return monaco.Uri.from({ scheme, path: `/~${projectNumber(project)}${copy ? `.${copy}` : ''}/${file}` })
}

/** The project and file behind a model's URI (as it was named when the model was made). */
export function fileOfUri(uri: Monaco.Uri): { project: string; file: string } | null {
  if (uri.scheme !== 'file' && uri.scheme !== PEEK_SCHEME) return null
  const m = /^\/~(\d+)(?:\.\d+)?\/(.+)$/.exec(uri.path)
  const project = m ? projects[Number(m[1])] : undefined
  return project === undefined ? null : { project, file: m![2]! }
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
  let copy = 0
  let uri = documentUri(monaco, project, file)
  // A renamed file's model still holds the name a new file may have now.
  while (monaco.editor.getModel(uri)) uri = documentUri(monaco, project, file, 'file', ++copy)
  return monaco.editor.createModel(text, languageFor(monaco, file), uri)
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
  const next = splitLines(text)
  const eol = eolOf(text) ?? model.getEOL()
  const edits = reloadEdits(model.getLinesContent(), next, eol)
  if (edits.length || eol !== model.getEOL()) {
    model.pushStackElement()
    if (eol !== model.getEOL()) {
      model.pushEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
    }
    if (edits.length) holdScroll(monaco, model, () => carryViewState(monaco, entry, () => void model.pushEditOperations(null, edits, () => null)))
    model.pushStackElement()
    // What is on disk matters more than the undo history.
    if (model.getValue() !== next.join(eol)) model.setValue(text)
  }
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

/** Jumps and links out of the editor: to a tab inside the project, the browser for the web, nowhere else. */
export function routeEditorLinks(monaco: MonacoApi) {
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, where) {
      const model = source.getModel()
      if (model?.uri.toString() === resource.toString()) return false
      const from = model ? tabOfModel(model) : null
      const at = !where
        ? { lineNumber: 1, column: 1 }
        : 'startLineNumber' in where ? { lineNumber: where.startLineNumber, column: where.startColumn } : { lineNumber: where.lineNumber, column: where.column }
      const target = monaco.editor.getModel(resource)
      const tab = parseFileTab(target ? tabOfModel(target) : null)
      let to = tab ? { project: tab.projectPath, file: tab.file } : fileOfUri(resource)
      if (!to && resource.scheme === 'file') {
        const project = parseFileTab(from)?.projectPath
        const file = project ? relativeTo(project, resource.fsPath) : null
        if (project && file) to = { project, file }
      }
      if (!to) return false
      openAt(to.project, to.file, at, from)
      return true
    },
  })
  monaco.editor.registerLinkOpener({
    open(uri) {
      if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
        void openExternal(uri.toString(true)).catch(() => {})
        return true
      }
      // Monaco's own openers: the editor's for files, and commands only from its own trusted text.
      if (uri.scheme === 'file' || uri.scheme === PEEK_SCHEME || uri.scheme === 'command') return false
      // Anything else could start a program on this computer.
      return true
    },
  })
}
