/**
 * Copy as Markdown: a message action that copies one reply, and a chat menu item (plus a palette command)
 * that copies the whole chat as a transcript: a title, then each message under a "You" / agent heading,
 * with tool calls as short lines (or with their output) per the settings.
 */

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' }
const TOOL_VERBS = { read: 'Read', edit: 'Edited', write: 'Wrote', bash: 'Ran', search: 'Searched', web: 'Fetched', other: 'Used' }

/** A fence longer than any run of backticks inside `text`, so the block cannot be closed early. */
export function fence(text, lang = '') {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${lang}\n${String(text).replace(/\n$/, '')}\n${ticks}`
}

/** Inline code that survives backticks in `text`. */
const code = (text) => {
  const s = String(text).replace(/\s+/g, ' ').trim()
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map(m => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  return longest ? `${ticks} ${s} ${ticks}` : `${ticks}${s}${ticks}`
}

const quote = text => String(text).split('\n').map(l => `> ${l}`.trimEnd()).join('\n')

/** One message's parts as Markdown blocks. */
export function messageMarkdown(message, { tools = 'list', thinking = false } = {}) {
  const blocks = []
  for (const part of message.parts ?? []) {
    switch (part.type) {
      case 'text':
        if (part.text?.trim()) blocks.push(part.text.trim())
        break
      case 'thinking':
        if (thinking && part.text?.trim()) blocks.push(quote(`Thinking: ${part.text.trim()}`))
        break
      case 'tool': {
        if (tools === 'none') break
        const verb = part.label || TOOL_VERBS[part.tool] || 'Used'
        const failed = part.status === 'error' ? ' (failed)' : ''
        let line = `- ${verb} ${part.target ? code(part.target) : ''}${failed}`.trimEnd()
        if (part.summary) line += `: ${part.summary.replace(/\s+/g, ' ').trim()}`
        blocks.push(line)
        if (tools === 'output' && part.output?.trim()) blocks.push(fence(part.output))
        break
      }
      case 'approval':
        blocks.push(`- Asked to run ${code(part.command)}: ${part.state}`)
        break
      case 'question':
        for (const q of part.questions ?? []) {
          if (q?.question) blocks.push(quote(`Question: ${q.question}`))
        }
        break
      case 'notice':
        if (part.text) blocks.push(quote(`${part.level === 'error' ? 'Error' : 'Note'}: ${part.text}`))
        break
    }
  }
  // Consecutive tool lines read as one list.
  return blocks.join('\n\n').replace(/^(- .*)\n\n(?=- )/gm, '$1\n')
}

/** The whole chat as a transcript. */
export function threadMarkdown(thread, opts = {}) {
  const agent = AGENT_NAMES[thread.agent] ?? thread.agent ?? 'Agent'
  const out = [`# ${thread.title || 'Chat'}`]
  const meta = [agent, thread.model && thread.model !== 'default' ? thread.model : null, new Date(thread.createdAt).toLocaleString()]
  out.push(meta.filter(Boolean).join(' · '))
  for (const m of thread.messages ?? []) {
    const body = messageMarkdown(m, opts)
    const files = (m.attachments ?? []).map(a => `- Attached ${code(a.name)}`).join('\n')
    if (!body && !files) continue
    const who = m.role === 'user' ? (m.fromAgent ? `Task from ${agent}` : 'You') : agent
    out.push(`## ${who}`)
    if (files) out.push(files)
    if (body) out.push(body)
  }
  return `${out.join('\n\n')}\n`
}

/** Clipboard API first; the textarea fallback covers webviews that refuse it without a fresh gesture. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch { /* fall back below */ }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.append(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('The clipboard is not available.')
}

export function activate(mango) {
  const opts = () => ({
    tools: mango.settings.get('tools') ?? 'list',
    thinking: mango.settings.get('thinking') === true,
  })

  const copy = async (text, what) => {
    try {
      await copyText(text)
      mango.ui.toast({ title: `Copied ${what}`, kind: 'success', timeout: 2500 })
    } catch (e) {
      mango.log.error('Copy failed:', e)
      mango.ui.toast({ title: 'Could not copy', body: e instanceof Error ? e.message : String(e), kind: 'error' })
    }
  }

  const copyThread = async (threadId) => {
    const thread = threadId ? mango.chat.get(threadId) : null
    if (!thread) {
      mango.ui.toast({ title: 'No chat to copy', kind: 'warning' })
      return
    }
    await copy(threadMarkdown(thread, opts()), 'the chat as Markdown')
  }

  mango.chat.messageActions.register({
    id: 'copy',
    label: 'Copy as Markdown',
    icon: 'clipboard-copy',
    when: ctx => ctx.role === 'assistant',
    run: async (ctx) => {
      // The stored message keeps tool calls and notices; the plain text is the fallback.
      const message = mango.chat.get(ctx.threadId)?.messages.find(m => m.id === ctx.messageId)
      const text = message ? messageMarkdown(message, { ...opts(), tools: 'none' }) : ''
      await copy(text || ctx.text, 'the reply as Markdown')
    },
  })

  mango.ui.menus.register('thread', {
    id: 'copy-chat',
    label: 'Copy chat as Markdown',
    icon: 'file-text',
    run: ({ threadId }) => copyThread(threadId),
  })

  mango.commands.register({
    id: 'copy-chat',
    title: 'Copy chat as Markdown',
    icon: 'file-text',
    keywords: 'transcript export',
    when: () => mango.chat.active() !== null,
    run: () => copyThread(mango.chat.active()?.id),
  })
}
