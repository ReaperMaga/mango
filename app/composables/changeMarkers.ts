import type * as Monaco from 'monaco-editor'
import { h, render } from 'vue'
import FilesChangePeek from '~/components/files/FilesChangePeek.vue'
import { lineChanges, type LineChange } from '~/utils/lineDiff'
import { tokenHex } from '~/utils/cssColor'
import type { MonacoApi } from '~/composables/monaco'

/**
 * Change markers in the editor's gutter, the way JetBrains IDEs show them: a bar beside lines
 * added (green) or changed (the Files view's modified colour) since the last commit, a wedge
 * where lines were removed, the same marks on the scrollbar. They compare the text being edited,
 * unsaved edits included, with the committed version the caller hands to `setBase`.
 * A click on a marker opens the committed lines under the change, with Revert.
 */

const MAX_EDITS = 1000
const PEEK_LINES = 12
/** Header of the peek, its border and the gap around it. */
const PEEK_CHROME = 30 + 2 + 8

export interface ChangeMarkers {
  /** The committed text to compare with; null shows no markers (nothing committed, not versioned). */
  setBase(text: string | null): void
  dispose(): void
}

export function changeMarkers(monaco: MonacoApi, editor: Monaco.editor.IStandaloneCodeEditor): ChangeMarkers {
  const decorations = editor.createDecorationsCollection()
  let base: string[] | null = null
  let changes: LineChange[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const colour = (kind: LineChange['kind']) =>
    tokenHex(kind === 'add' ? '--diff-add-fg' : kind === 'mod' ? '--accent-ink' : '--diff-del-fg', '#888888')
  const label = (c: LineChange) =>
    c.kind === 'add' ? 'Added since the last commit' : c.kind === 'mod' ? 'Changed since the last commit' : 'Lines removed here'

  function compute() {
    clearTimeout(timer)
    const model = editor.getModel()
    if (!model || !base) {
      changes = []
      decorations.clear()
      return
    }
    changes = lineChanges(base, model.getLinesContent(), MAX_EDITS)
    const last = model.getLineCount()
    decorations.set(changes.map((c) => {
      const atEnd = c.kind === 'del' && c.start > last
      const line = atEnd ? last : c.start
      const end = c.kind === 'del' ? line : c.start + c.count - 1
      return {
        range: new monaco.Range(line, 1, end, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `mango-change mango-change--${c.kind}${atEnd ? ' is-end' : ''}`,
          linesDecorationsTooltip: `${label(c)}. Click to see what was there.`,
          overviewRuler: { color: colour(c.kind), position: monaco.editor.OverviewRulerLane.Left },
        },
      }
    }))
  }
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(compute, 150)
  }

  /* ---------- the peek: committed lines under a change ---------- */

  let peek: { zoneId: string; widget: Monaco.editor.IOverlayWidget; dom: HTMLElement; change: LineChange } | null = null

  function closePeek() {
    if (!peek) return
    const { zoneId, widget, dom } = peek
    peek = null
    editor.changeViewZones(acc => acc.removeZone(zoneId))
    editor.removeOverlayWidget(widget)
    render(null, dom)
  }

  function place(dom: HTMLElement) {
    const info = editor.getLayoutInfo()
    dom.style.left = `${info.contentLeft}px`
    dom.style.width = `${Math.max(0, info.width - info.contentLeft - info.verticalScrollbarWidth)}px`
  }

  function openPeek(c: LineChange) {
    closePeek()
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
    const rows = Math.min(c.old.length, PEEK_LINES)
    const height = PEEK_CHROME + (rows ? rows * lineHeight + 1 : 0)
    // The view zone makes room between the lines; the content lives in an overlay widget over that
    // room, as Monaco's own peek views do, so it gets the mouse and keyboard.
    const dom = document.createElement('div')
    dom.className = 'mango-change-peek'
    dom.style.position = 'absolute'
    dom.style.height = `${height}px`
    place(dom)
    const widget: Monaco.editor.IOverlayWidget = { getId: () => 'mango.changePeek', getDomNode: () => dom, getPosition: () => null }
    editor.addOverlayWidget(widget)
    let zoneId = ''
    editor.changeViewZones((acc) => {
      zoneId = acc.addZone({
        afterLineNumber: c.kind === 'del' ? c.start - 1 : c.start + c.count - 1,
        heightInPx: height,
        domNode: document.createElement('div'),
        onDomNodeTop: (top) => { dom.style.top = `${top}px` },
      })
    })
    render(h(FilesChangePeek, {
      change: c,
      lineHeight,
      maxLines: PEEK_LINES,
      onRevert: () => revert(c),
      onClose: () => { closePeek(); editor.focus() },
    }), dom)
    peek = { zoneId, widget, dom, change: c }
  }

  /** Put the committed lines back in place of the change, as one undo step. */
  function revert(c: LineChange) {
    const model = editor.getModel()
    if (!model) return
    const eol = model.getEOL()
    const last = model.getLineCount()
    const max = (line: number) => model.getLineMaxColumn(line)
    let range: Monaco.Range
    let text = ''
    if (c.kind === 'del') {
      if (c.start <= last) { range = new monaco.Range(c.start, 1, c.start, 1); text = c.old.join(eol) + eol }
      else { range = new monaco.Range(last, max(last), last, max(last)); text = eol + c.old.join(eol) }
    } else {
      const end = c.start + c.count - 1
      if (c.kind === 'mod') { range = new monaco.Range(c.start, 1, end, max(end)); text = c.old.join(eol) }
      else if (end < last) range = new monaco.Range(c.start, 1, end + 1, 1)
      else if (c.start > 1) range = new monaco.Range(c.start - 1, max(c.start - 1), end, max(end))
      else range = new monaco.Range(1, 1, end, max(end))
    }
    closePeek()
    editor.pushUndoStop()
    editor.executeEdits('mango.revertChange', [{ range, text, forceMoveMarkers: true }])
    editor.pushUndoStop()
    compute()
    editor.focus()
  }

  const subs: Monaco.IDisposable[] = [
    editor.onDidChangeModelContent(() => { closePeek(); later() }),
    editor.onDidChangeModel(() => { closePeek(); base = null; compute() }),
    editor.onDidLayoutChange(() => { if (peek) place(peek.dom) }),
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return
      const line = e.target.position?.lineNumber
      const model = editor.getModel()
      if (!line || !model) return
      const last = model.getLineCount()
      const hit = changes.find(c => c.kind === 'del'
        ? Math.min(c.start, last) === line
        : line >= c.start && line < c.start + c.count)
      if (!hit) return
      if (peek && peek.change === hit) closePeek()
      else openPeek(hit)
    }),
    editor.onKeyDown((e) => {
      if (peek && e.keyCode === monaco.KeyCode.Escape) { closePeek(); e.preventDefault(); e.stopPropagation() }
    }),
  ]
  // The scrollbar marks take their colours once; a theme or scheme change paints them again.
  const themeWatch = new MutationObserver(() => { if (base) compute() })
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] })

  return {
    setBase(text) {
      const next = text === null ? null : text.split(/\r?\n/)
      if (next === base || (next && base && next.length === base.length && next.every((l, i) => l === base![i]))) return
      closePeek()
      base = next
      compute()
    },
    dispose() {
      clearTimeout(timer)
      closePeek()
      themeWatch.disconnect()
      for (const s of subs) s.dispose()
      decorations.clear()
    },
  }
}
