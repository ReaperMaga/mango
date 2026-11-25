/** The kinds of block the slash menu offers. */
import type { Editor } from '@tiptap/core'
import { strings } from '../strings.ts'
import { setBoxes, toDoActive } from './extensions.ts'

export type BlockId = 'text' | 'h1' | 'h2' | 'h3' | 'bullets' | 'numbers' | 'todos' | 'quote' | 'code' | 'divider' | 'table'
/** `hint`: what can be typed instead. `words`: other names it is found by. */
export interface BlockKind { id: BlockId; icon: string; hint: string; words: string }

export const BLOCKS: readonly BlockKind[] = [
  { id: 'text', icon: 'type', hint: '', words: 'plain paragraph' },
  { id: 'h1', icon: 'heading-1', hint: '#', words: 'h1 title' },
  { id: 'h2', icon: 'heading-2', hint: '##', words: 'h2' },
  { id: 'h3', icon: 'heading-3', hint: '###', words: 'h3' },
  { id: 'bullets', icon: 'list', hint: '-', words: 'unordered ul' },
  { id: 'numbers', icon: 'list-ordered', hint: '1.', words: 'ordered ol' },
  { id: 'todos', icon: 'list-checks', hint: '[ ]', words: 'todo task checkbox check' },
  { id: 'quote', icon: 'text-quote', hint: '>', words: 'blockquote' },
  { id: 'code', icon: 'code', hint: '```', words: 'pre snippet' },
  { id: 'divider', icon: 'minus', hint: '---', words: 'hr rule line separator' },
  { id: 'table', icon: 'table', hint: '', words: 'grid rows columns' },
]

export function findBlocks(query: string): BlockKind[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...BLOCKS]
  const name = (b: BlockKind) => strings.blocks[b.id].toLowerCase()
  // By its name first: "ta" is the table, then the to-do list that is also found as "task".
  const ways: Array<(b: BlockKind) => boolean> = [
    b => [name(b), ...name(b).split(' ')].some(w => w.startsWith(q)),
    b => b.words.split(' ').some(w => w.startsWith(q)),
    b => name(b).includes(q),
  ]
  return [...new Set(ways.flatMap(way => BLOCKS.filter(way)))]
}

/** Turns the block at the caret into another kind, or adds one there. */
export function setBlock(editor: Editor, id: BlockId): boolean {
  const chain = editor.chain().focus()
  const list = listAt(editor)
  switch (id) {
    case 'text': return chain.clearNodes().run()
    case 'h1':
    case 'h2':
    case 'h3': return chain.clearNodes().setHeading({ level: Number(id[1]) as 1 | 2 | 3 }).run()
    case 'bullets':
    case 'numbers': {
      if (toDoActive(editor)) setBoxes(editor, null)
      const name = id === 'bullets' ? 'bulletList' : 'orderedList'
      return list === name || editor.chain().focus().toggleList(name, 'listItem').run()
    }
    case 'todos': return (list !== null || chain.toggleBulletList().run()) && setBoxes(editor, false)
    case 'quote': return (list ? chain.clearNodes() : chain).setBlockquote().run()
    case 'code': return chain.clearNodes().setCodeBlock().run()
    case 'divider': return chain.clearNodes().setHorizontalRule().run()
    case 'table': return chain.clearNodes().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  }
}

/** The kind of list the caret is in. */
function listAt(editor: Editor): string | null {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) if (/List$/.test($from.node(d).type.name)) return $from.node(d).type.name
  return null
}
