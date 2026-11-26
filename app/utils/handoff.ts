/**
 * Mango's own `/handoff [notes]`: the chat shows the command as typed, and the agent gets the
 * instructions below instead. Its reply is the handoff: Mango starts a new chat in the same folder
 * whose first message carries it to the agent (`Thread.history`), so the work goes on without the
 * whole conversation being read again on every message. Plain TypeScript, no dependencies.
 */

import type { Message } from '~/types/chat'

const COMMAND = /^\/handoff(?:\s+([\s\S]*))?$/

/** How the instructions start: the browser preview's simulated agent knows them by it. */
export const HANDOFF_LEAD = 'Write a handoff so a fresh agent can continue this work in a new chat.'

/** Whether `text` is a `/handoff` message. */
export const isHandoff = (text: string) => COMMAND.test(text.trim())

/** The instructions for a `/handoff` message; null when `text` is not one. */
export function handoffPrompt(text: string): string | null {
  const m = COMMAND.exec(text.trim())
  if (!m) return null
  const notes = m[1]?.trim()
  return [
    `${HANDOFF_LEAD} That agent sees only what you write here, plus the project's files and its own instruction files (AGENTS.md, CLAUDE.md and the like), so do not repeat what those say.`,
    '',
    'Write it from what you already know. Do not run tools and do not change files.',
    '',
    'Reply with the handoff only, no preamble and no closing remarks, under these headings:',
    '',
    '## Goal',
    'What we are doing and why, in my terms.',
    '## State',
    'What is done (branch, commits), what is uncommitted, what was checked and how, what is broken.',
    '## Decisions',
    'Choices made and why, what was tried and dropped, and what I asked for or ruled out in this chat.',
    '## Next',
    'The next steps in order, and the open questions.',
    '## Files',
    'The files that matter, one line each, with paths relative to the project.',
    '',
    'Be concrete: exact names, paths, commands and numbers. Leave out what is finished and does not matter for what comes next. Keep it short: a few hundred words, more only when the work needs it.',
    ...(notes
      ? ['', 'My notes for this handoff (follow them; they can say what the next chat will do or what to stress):', '', notes]
      : []),
  ].join('\n')
}

/**
 * The handoff in a chat: the text of the agent's reply to its last `/handoff`. Null when there is
 * none, or the reply was stopped, failed or says nothing.
 */
export function handoffReply(messages: Message[]): string | null {
  let ask = messages.length - 1
  while (ask >= 0 && messages[ask]!.role !== 'user') ask--
  const asked = messages[ask]
  if (!asked || !isHandoff(asked.parts.map(p => (p.type === 'text' ? p.text : '')).join(''))) return null
  const replies = messages.slice(ask + 1).filter(m => m.role === 'agent')
  if (!replies.length || replies.some(m => m.outcome === 'stopped' || m.outcome === 'error')) return null
  const text = replies.flatMap(m => m.parts.map(p => (p.type === 'text' ? p.text.trim() : ''))).filter(Boolean).join('\n\n')
  return text || null
}

/** What the new chat's agent gets ahead of the first message written there. */
export function handoffHistory(title: string, handoff: string): string {
  return [
    `This chat continues an earlier one ("${title}"). Its agent wrote this handoff for you:`,
    '',
    '<handoff>',
    handoff,
    '</handoff>',
    '',
    'Continue from there. The message below is what I want now.',
  ].join('\n')
}

/** The new chat's title: the old one's, marked once however often it was handed on. */
export const continuedTitle = (title: string) => `${title.replace(/\s+\(continued\)$/, '')} (continued)`
