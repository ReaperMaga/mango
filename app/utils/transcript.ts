import type { Message } from '~/types/chat'

/**
 * The earlier part of a conversation as plain text, for an agent that cannot continue its own
 * session from that point (a chat cut back by edit or regenerate, or branched). Only what people
 * read goes in: the words of both sides and the names of attached files, not tool calls.
 * Plain TypeScript, no Vue: it runs in Node tests.
 */

const PER_MESSAGE = 6000
const TOTAL = 40000

function words(m: Message): string {
  const text = m.parts.map(p => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n\n').trim()
  const files = (m.attachments ?? []).map(a => `[attached: ${a.path}]`).join('\n')
  const body = [text, files].filter(Boolean).join('\n')
  return body.length > PER_MESSAGE ? `${body.slice(0, PER_MESSAGE)} …` : body
}

/** Null when nothing before the cut was said. The newest messages win when the whole is too long. */
export function transcript(messages: Message[]): string | null {
  const lines = messages
    .filter(m => !m.fromAgent)
    .map(m => ({ who: m.role === 'user' ? 'User' : 'Assistant', text: words(m) }))
    .filter(l => l.text)
    .map(l => `${l.who}: ${l.text}`)
  if (!lines.length) return null
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i]!.length > TOTAL && kept.length) { kept.unshift('(Older messages left out.)'); break }
    kept.unshift(lines[i]!)
    size += lines[i]!.length
  }
  return [
    '[The conversation so far, as text: your own session could not be continued from this point.]',
    '',
    kept.join('\n\n'),
    '',
    '[End of the earlier conversation. The user\'s next message follows.]',
  ].join('\n')
}
