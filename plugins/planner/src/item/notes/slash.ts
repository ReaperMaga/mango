/** Where a `/` was typed for the menu of blocks, and what follows it. */
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'

export interface Slash { from: number; to: number; query: string }

const key = new PluginKey<{ from: number } | null>('plannerSlash')

export function slashOf(state: EditorState): Slash | null {
  const open = key.getState(state)
  if (!open) return null
  const { from } = state.selection
  return { from: open.from, to: from, query: state.doc.textBetween(open.from + 1, from) }
}
export const closeSlash = (tr: Transaction) => tr.setMeta(key, 'close')

export function slashPlugin(onKey: (e: KeyboardEvent) => boolean): Plugin {
  let typed = false
  return new Plugin<{ from: number } | null>({
    key,
    state: {
      init: () => null,
      apply(tr, open, _old, state) {
        if (tr.getMeta(key) === 'close') return null
        const { $from, empty } = state.selection
        if (!empty) return null
        const at = open ? tr.mapping.map(open.from, -1) : typed && tr.docChanged ? $from.pos - 1 : -1
        if (tr.docChanged) typed = false
        if (at < $from.start() || at >= $from.pos) return null
        const text = $from.parent.textBetween(at - $from.start(), $from.parentOffset, '\n', '\n')
        return /^\/(?!\s)[^\n]{0,40}$/.test(text) ? { from: at } : null
      },
    },
    props: {
      handleTextInput(view, _from, _to, text) {
        const { $from, empty } = view.state.selection
        typed = text === '/' && empty && $from.parent.type.name === 'paragraph'
          && !($from.depth > 1 && /^table/.test($from.node(-1).type.name))
          && !$from.marks().some(m => m.type.name === 'code')
          && /(^|\s)$/.test($from.parent.textBetween(0, $from.parentOffset, '\n', '\n'))
        return false
      },
      handleKeyDown: (view, e) => key.getState(view.state) !== null && !view.composing && !e.isComposing && onKey(e),
    },
  })
}
