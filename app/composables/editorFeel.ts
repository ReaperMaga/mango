import type * as Monaco from 'monaco-editor'
import { holdOverlay } from '~/composables/useOverlay'
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
  definitionLinkOpensInPeek: false,
}

/** Prose does not pop up words at every space; Ctrl+Space still offers them. */
export const quickSuggestions = (language: string): Monaco.editor.IQuickSuggestionsOptions | boolean =>
  language === 'plaintext' || language === 'markdown' ? false : { other: 'on', comments: 'off', strings: 'off' }

/* ---------- caret */

/** A little longer than `--dur-fast`, the glide: taken off sooner, the caret would snap to its end. */
const GLIDE_MS = 170

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
