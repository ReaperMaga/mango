/** Items and the chats that work on them. */

import type { Planner } from '../context.ts'
import { projectKey, type Collection, type Item } from '../model.ts'
import { toastOnce } from '../ui/toastOnce.ts'
import { strings } from './strings.ts'

/** The project a chat about this collection belongs to: its own when that is open, else the active one. */
function projectFor(planner: Planner, collection: Collection): string | null {
  const { workspace } = planner.mango
  const scope = collection.scope
  if (scope.kind === 'project') {
    const own = workspace.openProjects().find(p => projectKey(p) === projectKey(scope.path))
    if (own) return own
  }
  return workspace.activeProject()
}

/** A new chat with the item in its composer, linked to it. Nothing is sent. */
export function startChat(planner: Planner, collection: Collection, item: Item): boolean {
  const { mango, store } = planner
  const projectPath = projectFor(planner, collection)
  if (!projectPath) {
    toastOnce(mango, strings.noProject)
    return false
  }
  // As it is now, with what was typed a moment ago.
  const now = store.item(collection.id, item.id) ?? item
  const title = now.title.trim()
  try {
    // Linked before it shows: creating a chat may take the planner's tab out of view.
    const thread = mango.chat.create({ projectPath })
    store.linkChat(collection.id, item.id, thread.id)
    if (title) mango.chat.rename(thread.id, title)
    const text = [title, now.body.trim()].filter(Boolean).join('\n\n')
    // It may be the empty chat that was there already: what was being written in it stays.
    const draft = mango.chat.draft(thread.id).trim()
    if (text) mango.chat.setDraft(thread.id, draft ? `${draft}\n\n${text}` : text)
    mango.chat.show(thread.id)
    return true
  } catch (e) {
    mango.log.error('Starting a chat:', e)
    mango.ui.toast({ title: strings.startFailed, body: e instanceof Error ? e.message : String(e), kind: 'error' })
    return false
  }
}
