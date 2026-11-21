import type { Message } from '~/types/chat'

/** What a message says in words (text parts only), for copying and finding. */
export function plainText(m: Message): string {
  return m.parts.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('\n\n')
}

export interface Found {
  /** Position in the chat's messages. */
  index: number
  message: Message
  /** A line around the match (or the start of the message when there was no query). */
  snippet: string
}

const SNIPPET = 90

/** A short stretch of the one-line `flat` text around `at`. */
function around(flat: string, at: number): string {
  const start = Math.max(0, at - 24)
  const cut = flat.slice(start, start + SNIPPET).trim()
  return `${start > 0 ? '…' : ''}${cut}${start + SNIPPET < flat.length ? '…' : ''}`
}

/** Messages whose words contain `query` (case-insensitive), in chat order. An empty query finds nothing. */
export function findMessages(messages: readonly Message[], query: string): Found[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: Found[] = []
  messages.forEach((message, index) => {
    const text = plainText(message)
    const flat = text.replace(/\s+/g, ' ')
    const at = flat.toLowerCase().indexOf(q)
    if (at >= 0) out.push({ index, message, snippet: around(flat, at) })
  })
  return out
}

/** The pinned messages, in chat order, with the start of what they say. */
export function pinnedMessages(messages: readonly Message[]): Found[] {
  const out: Found[] = []
  messages.forEach((message, index) => {
    if (message.pinned) out.push({ index, message, snippet: plainText(message).replace(/\s+/g, ' ').slice(0, SNIPPET) || '(no words)' })
  })
  return out
}
