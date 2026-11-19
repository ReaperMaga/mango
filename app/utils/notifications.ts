import type { Message, Part } from '~/types/chat'
import type { NotifyPrefs } from '~/stores/workspace'

/**
 * What is worth a desktop notification, and what it says (pure: `composables/notify.ts` sends it).
 * Three things happen to a chat while you are somewhere else: it finishes, it needs you, it fails.
 */
export type NotifyKind = 'done' | 'needsYou' | 'failed'

export interface NotifyContext {
  /** Mango's window is in front and has the keyboard. */
  windowFocused: boolean
  /** The chat is on screen in a pane. */
  chatVisible: boolean
}

/** Markdown reduced to the plain words a notification can show. */
export function plainExcerpt(markdown: string, max = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>~|]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

const lastAgent = (messages: Message[]): Message | undefined => [...messages].reverse().find(m => m.role === 'agent')

/** The agent's last words in a turn: its final text part. */
function lastReply(messages: Message[]): string {
  const parts = lastAgent(messages)?.parts ?? []
  const text = [...parts].reverse().find((p): p is Extract<Part, { type: 'text' }> => p.type === 'text' && !!p.text.trim())
  return text ? plainExcerpt(text.text) : ''
}

/** What the agent asks of you: the approval waiting in the last message. */
function pendingAsk(messages: Message[]): string {
  const parts = lastAgent(messages)?.parts ?? []
  const ask = [...parts].reverse().find((p): p is Extract<Part, { type: 'approval' }> => p.type === 'approval' && p.state === 'pending')
  return ask ? plainExcerpt(ask.title || ask.command, 120) : ''
}

/** What went wrong: the last problem the run reported. */
function lastProblem(messages: Message[]): string {
  const parts = lastAgent(messages)?.parts ?? []
  const note = [...parts].reverse().find((p): p is Extract<Part, { type: 'notice' }> => p.type === 'notice' && p.level === 'error')
  return note ? plainExcerpt(note.text, 140) : ''
}

const PLAIN: Record<NotifyKind, string> = {
  done: 'A chat finished.',
  needsYou: 'A chat is waiting for you.',
  failed: 'A chat failed.',
}

/**
 * The notification for `kind`, or null when the preferences (or what is on screen) say to stay quiet.
 * You never hear about the chat you are looking at in a window you are using.
 */
export function notificationFor(
  kind: NotifyKind,
  thread: { title: string; messages: Message[] },
  prefs: NotifyPrefs,
  ctx: NotifyContext,
): { title: string; body: string } | null {
  if (!prefs.enabled || !prefs[kind]) return null
  if (ctx.windowFocused && (prefs.backgroundOnly || ctx.chatVisible)) return null
  if (!prefs.preview) return { title: 'Mango', body: PLAIN[kind] }
  const detail = kind === 'done' ? lastReply(thread.messages) : kind === 'needsYou' ? pendingAsk(thread.messages) : lastProblem(thread.messages)
  const lead = kind === 'done' ? 'Finished' : kind === 'needsYou' ? 'Needs your approval' : 'Failed'
  return { title: thread.title, body: detail ? `${lead}: ${detail}` : `${lead}.` }
}
