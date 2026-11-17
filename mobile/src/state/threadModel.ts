import type { AgentId, Part, Thread } from '~/types/chat'
import { AGENTS } from '~/types/chat'

/**
 * Pure helpers about chats, ported 1:1 from the desktop's `app/stores/threads.ts` (where they are
 * private). Kept identical so a chat written by either app reads the same in the other.
 */

export const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A message that is a slash command (`/compact`, `/review …`): it runs as a turn of its own. */
export const isCommand = (text: string) => /^\/[\w.:-]+(\s|$)/.test(text.trim())
/** Mango's own `/clear`: handled here, never sent to the agent. */
export const isClear = (text: string) => /^\/clear\s*$/.test(text.trim())

/** Running, starting or waiting for an approval: its status belongs to the run. */
export const isBusy = (t: Thread) => t.status === 'running' || t.status === 'queued' || t.status === 'waiting'

/**
 * List order is the user's: chats placed by hand (on the desktop) keep their place; chats without
 * a place come first, newest created on top. Activity never moves a chat.
 */
export function byListOrder(a: Thread, b: Thread) {
  if (a.order === undefined && b.order === undefined) return b.createdAt - a.createdAt
  if (a.order === undefined) return -1
  if (b.order === undefined) return 1
  return a.order - b.order
}

/**
 * A chat id that is safe as a file name. Ids come from other computers too (through the
 * environment), so one that could name another path is refused rather than saved.
 */
export const isSafeId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(id)

/** Threads from disk: nothing is running after a restart, and older builds stored other model/mode values. */
export function normalizeLoaded(t: Thread): Thread {
  const agent: AgentId = t.agent in AGENTS ? t.agent : 'claude'
  // Any id the CLI offered is fine (the list comes from the CLI); only junk falls back.
  const model = typeof t.model === 'string' && t.model.trim() ? t.model : AGENTS[agent].models[0]!.id
  const effort = typeof t.effort === 'string' && t.effort ? t.effort : null
  const mode = (['plan', 'ask', 'edits', 'auto'] as const).includes(t.mode) ? t.mode : 'ask'
  // Older builds also had an 'idle' status; it is Working now.
  const interrupted = ['running', 'queued', 'waiting', 'idle'].includes(t.status)
  // A sub-agent cut off by closing the app did not finish.
  const after: Thread['status'] = t.parentId ? 'error' : 'working'
  const messages = t.messages.map(m => ({
    ...m,
    ...(Array.isArray(m.attachments) ? { attachments: m.attachments.filter(a => a && typeof a.path === 'string') } : { attachments: undefined }),
    parts: m.parts.map((p): Part => {
      if ((p.type === 'approval' || p.type === 'question') && p.state === 'pending') return { ...p, state: 'cancelled' }
      if (p.type === 'tool' && p.status === 'running') return { ...p, status: 'error', summary: 'did not finish' }
      return p
    }),
  }))
  const links = Array.isArray(t.links)
    ? t.links.filter(l => l && typeof l.key === 'string' && typeof l.url === 'string' && typeof l.number === 'number')
    : []
  const worktree = typeof t.worktree === 'string' && t.worktree && !t.parentId ? t.worktree : undefined
  // Still waiting for its worktree only while it has none (a top-level chat).
  const awaitingWorktree = t.awaitingWorktree === true && !worktree && !t.parentId ? true as const : undefined
  return { ...t, agent, model, mode, effort, messages, status: interrupted ? after : t.status, links: links.length ? links : undefined, worktree, awaitingWorktree }
}

/** The reason in a rejected call or a thrown error, without a trailing period. */
export function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)
  return text.trim().replace(/\.$/, '') || 'no reason given'
}

export function titleFrom(text: string) {
  const line = text.trim().split('\n')[0]!.replace(/[`*_#>]/g, '')
  return line.length > 48 ? `${line.slice(0, 46).trimEnd()}…` : line
}
