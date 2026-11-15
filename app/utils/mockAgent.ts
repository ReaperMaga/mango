import type { Part } from '~/types/chat'
import { approvalWaiters, stopFlags, type useThreads } from '~/stores/threads'

/**
 * Stand-in for a real Claude Code / Codex run. Streams a plausible sequence of
 * thinking, tool calls, an approval request (in "ask" mode) and a reply, so
 * the UI's states can be exercised before the CLIs are wired up.
 */
type Store = ReturnType<typeof useThreads>

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runMockAgent(store: Store, threadId: string, prompt: string) {
  stopFlags.delete(threadId)
  const stopped = () => stopFlags.has(threadId)
  const thread = () => store.byId(threadId)

  await sleep(450)
  if (stopped() || !thread()) return
  store._setStatus(threadId, 'running')
  const msg = store._pushAgentMessage(threadId)
  if (!msg) return

  const think = store._pushPart(threadId, msg, { type: 'thinking', text: '', seconds: 0 }) as Extract<Part, { type: 'thinking' }>
  const thoughts = `The request is “${prompt.trim().slice(0, 80)}”. I'll look at how the project is laid out first, find the code this touches, then make the smallest change that does it and run the checks.`
  for (const word of thoughts.split(' ')) {
    if (stopped()) return
    think.text += (think.text ? ' ' : '') + word
    await sleep(28)
  }
  think.seconds = 3

  const tools: Array<Extract<Part, { type: 'tool' }>> = [
    { type: 'tool', tool: 'search', target: 'useThreads|defineStore', status: 'running', summary: '6 matches in 3 files' },
    { type: 'tool', tool: 'read', target: 'app/stores/threads.ts', status: 'running', summary: '214 lines' },
  ]
  for (const t of tools) {
    if (stopped()) return
    const part = store._pushPart(threadId, msg, { ...t }) as typeof t
    await sleep(650)
    part.status = 'ok'
  }

  if (thread()?.mode === 'ask') {
    const index = msg.parts.length
    store._pushPart(threadId, msg, {
      type: 'approval',
      command: 'pnpm vitest run app/stores',
      reason: 'Run the store tests before changing them',
      state: 'pending',
    })
    store._setStatus(threadId, 'waiting')
    const allowed = await new Promise<boolean>(resolve => approvalWaiters.set(`${threadId}:${msg.id}:${index}`, resolve))
    approvalWaiters.delete(`${threadId}:${msg.id}:${index}`)
    if (stopped()) return
    store._setStatus(threadId, 'running')
    if (allowed) {
      const run = store._pushPart(threadId, msg, { type: 'tool', tool: 'bash', target: 'pnpm vitest run app/stores', status: 'running' }) as Extract<Part, { type: 'tool' }>
      await sleep(1100)
      run.status = 'ok'
      run.summary = '12 passed'
      run.output = ' ✓ app/stores/threads.test.ts (9 tests) 41ms\n ✓ app/stores/workspace.test.ts (3 tests) 12ms\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)\n   Duration  612ms'
    }
  }

  if (stopped()) return
  const edit = store._pushPart(threadId, msg, { type: 'tool', tool: 'edit', target: 'app/stores/threads.ts', status: 'running' }) as Extract<Part, { type: 'tool' }>
  await sleep(800)
  edit.status = 'ok'
  edit.summary = '+4 −1'
  edit.diff = [
    { kind: 'ctx', text: '    closeTab(id: string) {' },
    { kind: 'ctx', text: '      const i = this.tabs.indexOf(id)' },
    { kind: 'del', text: '      this.tabs.splice(i, 1)' },
    { kind: 'add', text: '      if (i === -1) return' },
    { kind: 'add', text: '      this.tabs.splice(i, 1)' },
    { kind: 'add', text: '      const fallback = this.tabs[Math.min(i, this.tabs.length - 1)] ?? null' },
    { kind: 'add', text: '      for (const p of this.panes) if (p.threadId === id) p.threadId = fallback' },
    { kind: 'ctx', text: '      this.persist()' },
  ]

  const reply = store._pushPart(threadId, msg, { type: 'text', text: '' }) as Extract<Part, { type: 'text' }>
  const answer = [
    'Done. Closing a tab now hands its pane to the neighbouring tab instead of leaving the pane blank.',
    '',
    '- `closeTab` returns early for unknown ids',
    '- panes that showed the closed thread fall back to the next tab, or the previous one at the end of the strip',
    '',
    'This is a **mock reply** from Mango’s preview agent. Real Claude Code and Codex runs plug in here next.',
  ].join('\n')
  for (const chunk of answer.match(/\S+\s*/g) ?? []) {
    if (stopped()) return
    reply.text += chunk
    await sleep(22)
  }
  store._setStatus(threadId, 'working', 'done')
}
