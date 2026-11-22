import type * as Monaco from 'monaco-editor'
import { holdOverlay } from '~/composables/useOverlay'
import { CompletionText, UntouchedText } from '~/lsp/editGuard'
import { tabOfModel } from '~/composables/editorDocuments'
import type { MonacoApi } from '~/composables/monaco'

/** How the editor behaves while typing: completion as an IDE has it, the caret, its floating widgets. */

export const COMPLETION_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  quickSuggestionsDelay: 50,
  suggestOnTriggerCharacters: true,
  // Enter takes a suggestion that changes something; where it would not, it is a new line.
  acceptSuggestionOnEnter: 'smart',
  acceptSuggestionOnCommitCharacter: false,
  suggestSelection: 'recentlyUsedByPrefix',
  wordBasedSuggestions: 'matchingDocuments',
  snippetSuggestions: 'inline',
  suggest: {
    insertMode: 'insert',
    selectionMode: 'always',
    localityBonus: true,
    filterGraceful: true,
    snippetsPreventQuickSuggestions: false,
    showWords: true,
    showStatusBar: false,
  },
  parameterHints: { enabled: true, cycle: true },
  hover: { delay: 350, sticky: true },
  gotoLocation: { multipleDefinitions: 'peek' },
  // These write what was computed a moment before, with nobody looking.
  formatOnType: false,
  formatOnPaste: false,
  linkedEditing: false,
  definitionLinkOpensInPeek: false,
}

/** Prose does not pop up words at every space; Ctrl+Space still offers them. */
export const quickSuggestions = (language: string): Monaco.editor.IQuickSuggestionsOptions | boolean =>
  language === 'plaintext' || language === 'markdown' ? false : { other: 'on', comments: 'off', strings: 'off' }

/* ---------- edits computed earlier */

/**
 * No completion or picked colour lands in another file, or in text that changed after it was
 * computed; every editor gets this, a peek's too. Reaches into Monaco's suggest controller, which
 * has no hook for it (check when upgrading Monaco).
 */
export function guardEdits(editor: Monaco.editor.ICodeEditor) {
  // The colour picker writes a moment after the click, at the range it was opened on.
  let picked: { model: Monaco.editor.ITextModel; version: number } | null = null
  const pick = (e: Event) => {
    const inPicker = e.type === 'keydown' ? (e as KeyboardEvent).key === 'Enter' : !!(e.target as Element).closest?.('.colorpicker-widget')
    const model = editor.getModel()
    if (inPicker && model) picked = { model, version: model.getVersionId() }
  }
  const dom = editor.getContainerDomNode()
  for (const type of ['pointerdown', 'pointerup', 'keydown']) dom.addEventListener(type, pick, true)
  const execute = editor.executeEdits.bind(editor)
  editor.executeEdits = (source, edits, cursor) => {
    if (source === 'colorpicker') {
      const model = editor.getModel()
      if (!model || picked?.model !== model || picked.version !== model.getVersionId()) return false
      const done = execute(source, edits, cursor)
      picked.version = model.getVersionId()
      return done
    }
    return execute(source, edits, cursor)
  }

  const suggest: any = editor.getContribution('editor.contrib.suggestController')
  let text: CompletionText | null = null
  const subs: Monaco.IDisposable[] = []
  if (suggest) {
    subs.push(
      suggest.model.onDidTrigger(() => {
        const model = editor.getModel()
        // Asked again for more of the same list, it keeps what the first answers were computed from.
        if (text || !model) return
        text = new CompletionText((editor.getSelections() ?? []).map((selection) => {
          const at = selection.getPosition()
          return { lineNumber: at.lineNumber, column: model.getWordUntilPosition(at).startColumn }
        }))
      }),
      suggest.model.onDidCancel((e: { retrigger: boolean }) => { if (!e.retrigger) text = null }),
      editor.onDidChangeModel(() => { text = null }),
      editor.onDidChangeModelContent((e) => {
        const asked = text
        if (!asked?.valid) return
        asked.changed(e)
        // After the change: Monaco is still in the middle of telling about it.
        if (!asked.valid) queueMicrotask(() => { if (text === asked) suggest.cancelSuggestWidget() })
      }),
    )
    const insert = suggest._insertSuggestion
    suggest._insertSuggestion = function (event: any, flags: number) {
      const model = editor.getModel()
      const item = event?.item
      if (!item || !model) return insert.call(this, event, flags)
      const fits = !!text?.valid
      text = null
      if (!fits) return this.cancelSuggestWidget()
      if (Array.isArray(item.completion.additionalTextEdits) || item.isResolved) return insert.call(this, event, flags)
      // Its import is still to come, and is written into whatever the editor shows by then.
      const untouched = new UntouchedText()
      const watching = model.onDidChangeContent(e => untouched.changed(e))
      const resolve = item.resolve
      item.resolve = async (token: unknown) => {
        try {
          await resolve.call(item, token)
        } finally {
          watching.dispose()
          const edits = item.completion.additionalTextEdits
          if (edits && (editor.getModel() !== model || !untouched.allows(edits))) item.completion.additionalTextEdits = undefined
        }
      }
      try {
        return insert.call(this, event, flags)
      } finally {
        delete item.resolve
      }
    }
  }

  editor.onDidDispose(() => {
    subs.forEach(sub => sub.dispose())
    for (const type of ['pointerdown', 'pointerup', 'keydown']) dom.removeEventListener(type, pick, true)
  })
}

/** A peek shows a file that may have no tab: nothing typed there would ever be saved. */
export function previewReadOnly(editor: Monaco.editor.ICodeEditor) {
  if (!('getParentEditor' in editor)) return
  const apply = () => {
    const model = editor.getModel()
    if (model) editor.updateOptions({ readOnly: !tabOfModel(model) })
  }
  editor.onDidChangeModel(apply)
  apply()
}

/* ---------- caret */

/** A little longer than `--dur-med`, the glide: taken off sooner, the caret would snap to its end. */
const GLIDE_MS = 280

/**
 * The caret glides only where it is sent (typing, arrows, a click). What moves it along with the
 * page (scrolling, a tab switch, a resize, folding, text arriving from disk) moves it at once.
 */
export function caretGlide(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor, on: () => boolean) {
  let held = false
  let frame = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const dom = editor.getContainerDomNode()

  function settle() {
    clearTimeout(timer)
    dom.classList.remove('is-caret-gliding')
  }
  const sub = editor.onDidChangeCursorPosition((e) => {
    const { ContentFlush, RecoverFromMarkers } = monaco.editor.CursorChangeReason
    if (held || !on() || e.reason === ContentFlush || e.reason === RecoverFromMarkers) return settle()
    // On before Monaco moves it, which is in the next frame.
    dom.classList.add('is-caret-gliding')
    clearTimeout(timer)
    timer = setTimeout(settle, GLIDE_MS)
  })

  return {
    /** The next moves are no glide: another file, or this one shown afresh. */
    still() {
      held = true
      settle()
      cancelAnimationFrame(frame)
      // Monaco draws the new place in the next frame; only after it may the caret glide again.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { held = false }) })
    },
    dispose() {
      sub.dispose()
      settle()
      cancelAnimationFrame(frame)
    },
  }
}

/* ---------- floating widgets and the browsers */

/** Suggestions come and go while typing: the browser must not blink with them. */
const RELEASE_MS = 300

/**
 * A browser's page is a native view above all HTML, so it hides while one of the editor's floating
 * widgets reaches over it, and only then: one beside the editor stays while typing.
 */
export function widgetsOverBrowsers(editor: Monaco.editor.IStandaloneCodeEditor) {
  let layers: Element[] = []
  let release: (() => void) | null = null
  let releasing: ReturnType<typeof setTimeout> | undefined
  let frame = 0

  function check() {
    frame = 0
    const pages = [...document.querySelectorAll('.bw__page')].map(el => el.getBoundingClientRect())
    const over = pages.length > 0 && layers.some(layer => [...layer.children].some((widget) => {
      if (!widget.checkVisibility?.({ visibilityProperty: true })) return false
      const r = widget.getBoundingClientRect()
      return r.width > 4 && r.height > 4 && pages.some(p => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top)
    }))
    if (over) {
      clearTimeout(releasing)
      releasing = undefined
      release ??= holdOverlay()
    } else if (release && !releasing) {
      releasing = setTimeout(() => {
        releasing = undefined
        release?.()
        release = null
      }, RELEASE_MS)
    }
  }
  const observer = new MutationObserver(() => { frame ||= requestAnimationFrame(check) })
  // The editor builds these anew with each model it shows.
  function watchLayers() {
    observer.disconnect()
    layers = [...editor.getContainerDomNode().querySelectorAll('.overflowingContentWidgets, .overflowingOverlayWidgets')]
    for (const layer of layers) observer.observe(layer, { attributes: true, attributeFilter: ['style', 'class'], childList: true, subtree: true })
    frame ||= requestAnimationFrame(check)
  }
  watchLayers()
  const sub = editor.onDidChangeModel(watchLayers)

  return {
    dispose() {
      sub.dispose()
      observer.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(releasing)
      release?.()
    },
  }
}
