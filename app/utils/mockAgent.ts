import type { Part } from '~/types/chat'
import { approvalWaiters, stopFlags, type useThreads } from '~/stores/threads'
import { simulatedTasks } from '~/agents'

/**
 * Stand-in for a real Claude Code / Codex run. Streams a plausible sequence of
 * thinking, tool calls, a sub-agent with a chat of its own, an approval request
 * (in "ask" mode) and a reply, so the UI's states can be exercised without a CLI.
 * A prompt that mentions tests, a build or the background also starts a background
 * command, which the agent answers once it finishes.
 */
type Store = ReturnType<typeof useThreads>
type ToolPart = Extract<Part, { type: 'tool' }>

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

  // A sub-agent maps the code in a chat of its own, listed under this one.
  if (stopped()) return
  const delegate = store._pushPart(threadId, msg, { type: 'tool', id: `mock-agent-${Date.now().toString(36)}`, tool: 'other', label: 'Delegated', target: 'Map the thread store', status: 'running' }) as ToolPart
  const child = store._createSubagent(threadId, {
    toolId: delegate.id!,
    title: 'Map the thread store',
    agentType: 'Explore',
    prompt: 'Find where chat threads are created, saved and shown in the sidebar. Report the files and functions that matter, briefly.',
  })
  const childMsg = child && store._pushAgentMessage(child.id)
  if (child && childMsg) {
    delegate.childId = child.id
    const steps: Array<Pick<ToolPart, 'tool' | 'label' | 'target' | 'summary'>> = [
      { tool: 'search', label: 'Listed', target: 'app/stores/*.ts', summary: '6 files' },
      { tool: 'read', target: 'app/stores/threads.ts', summary: '488 lines' },
      { tool: 'search', target: 'forProject in app/components', summary: '2 matches' },
    ]
    for (const step of steps) {
      const row = store._pushPart(child.id, childMsg, { type: 'tool', status: 'running', ...step }) as ToolPart
      await sleep(550)
      row.status = 'ok'
    }
    const report = 'Threads live in `app/stores/threads.ts`: `create` makes one, `persist` saves every chat to localStorage, and `forProject` feeds the sidebar list in `AppSidebar.vue`.'
    store._pushPart(child.id, childMsg, { type: 'text', text: report })
    store._setStatus(child.id, stopped() ? 'error' : 'done', stopped() ? 'stopped' : 'done')
    delegate.output = report
  }
  delegate.status = 'ok'
  if (stopped()) return

  // A long command goes to the background; the agent carries on and answers it when it is done.
  let background: Promise<'done' | 'stopped'> | null = null
  if (/test|build|background/i.test(prompt)) {
    const taskId = `mock-task-${Date.now().toString(36)}`
    const row = store._pushPart(threadId, msg, {
      type: 'tool', id: `mock-bg-${taskId}`, tool: 'bash', target: 'pnpm build', status: 'ok', summary: 'in background',
      output: `Command running in background with ID: ${taskId}.`,
    }) as ToolPart
    store._taskStart(threadId, { id: taskId, kind: 'command', title: 'Build the app', toolId: row.id })
    const lines: string[] = []
    let halted = false
    simulatedTasks.set(threadId, { stop: (id) => { if (id === taskId) halted = true }, output: async () => lines.join('\n') })
    background = (async () => {
      const steps = ['> mango@0.1.5 build', '> nuxt build', 'ℹ Building client…', '✓ 1834 modules transformed.', 'ℹ Building server…', '✓ Server built in 2.1s', '✓ Preview it with node .output/server/index.mjs']
      for (const [i, l] of steps.entries()) {
        if (halted || stopped()) break
        lines.push(l)
        store._taskUpdate(threadId, taskId, { activity: l.replace(/^[>ℹ✓]\s*/, '') })
        await sleep(i === 0 ? 400 : 1300)
      }
      const how = halted || stopped() ? 'stopped' : 'done'
      store._taskEnd(threadId, taskId, how)
      row.summary = how === 'done' ? 'finished' : 'stopped'
      return how
    })()
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
    'This is a **mock reply** from Mango’s preview agent: nothing ran.',
  ].join('\n')
  for (const chunk of answer.match(/\S+\s*/g) ?? []) {
    if (stopped()) return
    reply.text += chunk
    await sleep(22)
  }

  if (background) {
    // Answered, but the build still runs: wait for it, then pick up again by itself.
    store._setIdle(threadId, true)
    const how = await background
    simulatedTasks.delete(threadId)
    if (stopped()) return
    if (how === 'done') {
      store._setIdle(threadId, false)
      const next = store._pushAgentMessage(threadId)
      if (next) {
        store._pushPart(threadId, next, { type: 'notice', level: 'info', text: 'Background command finished: Build the app' })
        const followUp = store._pushPart(threadId, next, { type: 'text', text: '' }) as Extract<Part, { type: 'text' }>
        for (const chunk of 'The build finished cleanly: client and server bundles are in `.output/`.'.match(/\S+\s*/g) ?? []) {
          if (stopped()) return
          followUp.text += chunk
          await sleep(22)
        }
      }
    }
  }
  store._clearLive(threadId)
  store._setStatus(threadId, 'working', 'done')
}
