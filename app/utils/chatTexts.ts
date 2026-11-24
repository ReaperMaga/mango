import { t } from '../i18n/index.ts'

/**
 * Texts Mango keeps in a chat in English (the chat file is shared with other computers and the
 * phone): tool rows, approvals and notices. These show the ones it knows in the interface
 * language; anything else (an agent's own words, older wordings) reads as it was written.
 */

/** A chat's title: the one a chat has until its first message, in the interface language. */
export const chatTitle = (title: string) => (title === 'New chat' ? t('shell.shortcuts.labels.new-chat') : title)

const LABELS = new Map([
  ['Checked', 'checked'], ['Stopped', 'stopped'], ['Listed', 'listed'], ['Searched the web for', 'searchedWeb'], ['Delegated', 'delegated'],
  ['Updated plan', 'updatedPlan'], ['Asked', 'asked'], ['Proposed', 'proposed'], ['Used skill', 'usedSkill'], ['Browser', 'browser'],
  ['Generated', 'generated'], ['Reviewed', 'reviewed'], ['Compacted', 'compacted'],
])
/** The verb an adapter gave a tool row. */
export function toolLabel(label: string): string {
  if (label === 'Used') return t('chat.tool.done.other')
  const id = LABELS.get(label)
  return id ? t(`chat.tool.labels.${id}`) : label
}

const SUMMARIES = new Map([
  ['failed', 'failed'], ['stopped', 'stopped'], ['finished', 'finished'], ['declined', 'declined'],
  ['did not finish', 'unfinished'], ['in background', 'background'], ['image', 'image'],
])
/** What a tool row says at its end. */
export function toolSummary(summary: string): string {
  const id = SUMMARIES.get(summary)
  if (id) return t(`chat.tool.summary.${id}`)
  const counted = /^(\d+) (lines|images)$/.exec(summary)
  if (counted) return t(`chat.tool.summary.${counted[2]}`, Number(counted[1]))
  const took = /^finished in ([\d.]+)s$/.exec(summary)
  return took ? t('chat.tool.summary.finishedIn', { n: took[1] }) : summary
}

const WANTS = new Map([
  ['wants to run a command', 'run'], ['wants to create a file', 'create'], ['wants to edit a file', 'edit'], ['wants to edit files', 'editFiles'],
  ['wants to read a file outside the project', 'readOutside'], ['wants to search outside the project', 'searchOutside'],
  ['wants to fetch a page', 'fetch'], ['wants to search the web', 'searchWeb'], ['has a plan and wants to start', 'plan'],
  ['wants to use the browser', 'browser'], ['wants network access', 'network'],
  ['wants to send input to a running command', 'input'], ['wants more permissions', 'permissions'],
])
/** Who asks for what, over an approval or a question. */
export function askTitle(title: string): string {
  const [, agent, what] = /^(Claude Code|Codex) (.+)$/s.exec(title) ?? []
  if (agent && what) {
    const id = WANTS.get(what)
    if (id) return t(`chat.approval.wants.${id}`, { agent })
    const tools = /^wants to use the (.+) tools$/s.exec(what)
    if (tools) return t('chat.approval.wants.useTools', { agent, tool: tools[1] })
    const tool = /^wants to use (.+)$/s.exec(what)
    if (tool) return t('chat.approval.wants.use', { agent, tool: tool[1] })
  }
  const server = /^(.+) asks$/s.exec(title)
  return server ? t('chat.asks', { name: server[1] }) : title
}

export const approvalReason = (reason: string) =>
  (reason === 'Allow to let it carry out the plan.' ? t('chat.approval.planReason') : reason)

/** A run-level notice (`runAgentTurn`, `threads._runTurn`). */
export function noticeText(text: string): string {
  if (text === 'Stopped.') return t('chat.notice.stopped')
  if (text === 'The agent stopped unexpectedly.') return t('chat.notice.unexpected')
  const cleared = /^New conversation\. (.+) no longer sees the messages above\.$/.exec(text)
  if (cleared) return t('chat.notice.cleared', { agent: cleared[1] })
  const left = /^Not sent: (.+?)\. (.*)$/s.exec(text)
  if (left) return t('chat.notice.notSent', { names: left[1], error: left[2] })
  const nothing = /^Nothing to send: the attached files could not be put into the remote environment\.(?: (.*))?$/s.exec(text)
  if (nothing) return t('chat.notice.nothingToSend', { error: nothing[1] ?? '' }).trim()
  const folder = /^Could not make a (worktree|workspace) for this chat: (.*)\. Nothing ran yet; send a message to try again \(what you wrote goes along\)\.$/s.exec(text)
  if (folder) return t('chat.notice.noWorktree', { term: t(`chat.terms.${folder[1]}`), error: folder[2] })
  return text
}

const CONTEXT = new Map([
  ['System prompt', 'systemPrompt'], ['System tools', 'systemTools'], ['MCP tools', 'mcpTools'], ['Custom agents', 'customAgents'],
  ['Memory files', 'memoryFiles'], ['Skills', 'skills'], ['Messages', 'messages'], ['Autocompact buffer', 'buffer'],
])
/** A part of the context window, as Claude Code names it. */
export function contextPart(label: string): string {
  if (label === 'Free space') return t('chat.context.freeSpace')
  const id = CONTEXT.get(label)
  return id ? t(`chat.context.parts.${id}`) : label
}
