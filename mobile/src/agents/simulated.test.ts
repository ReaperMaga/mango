import { describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentEvent, PermissionMode } from '~/agents/types'
import type { AgentId } from '~/types/chat'
import { claudeAdapter } from '~/agents/claude'
import { codexAdapter } from '~/agents/codex'
import { simulatedSpawn } from '@/agents/simulated'

const PROJECT = 'env://h1/dev/home/agent/shop'

interface Drive { allow?: boolean; interruptAfter?: AgentEvent['type']; steer?: string }

/** Run one turn of the real adapter against the simulated CLI; resolves with every event, turn-end last. */
function drive(adapter: AgentAdapter, agent: AgentId, mode: PermissionMode, opts: Drive = {}): Promise<AgentEvent[]> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = []
    const guard = setTimeout(() => reject(new Error(`no turn-end; got ${events.map(e => e.type).join(', ')}`)), 8000)
    let interrupted = false
    let steered = false
    const run = adapter.run({
      cwd: '/home/agent/shop',
      remote: true,
      prompt: 'Fix the greeting',
      images: [],
      readDirs: [],
      model: 'default',
      mode,
      effort: null,
      sessionId: null,
      spawn: simulatedSpawn(agent, PROJECT, { pace: 0 }),
      emit(e) {
        events.push(e)
        if (e.type === 'approval' && !opts.interruptAfter) setTimeout(() => run.respondApproval(e.id, opts.allow ?? true), 0)
        if (opts.interruptAfter === e.type && !interrupted) { interrupted = true; setTimeout(() => run.interrupt(), 0) }
        if (opts.steer && !steered && e.type === 'tool-end') { steered = true; void run.steer?.({ prompt: opts.steer, images: [], readDirs: [] }) }
        if (e.type === 'turn-end') {
          clearTimeout(guard)
          // Anything after turn-end would be a bug: give it a moment to show up.
          setTimeout(() => resolve(events), 20)
        }
      },
    })
  })
}

const text = (events: AgentEvent[]) =>
  events.map(e => (e.type === 'text-delta' ? e.text : e.type === 'text' ? `|${e.text}|` : '')).join('')

for (const [agent, adapter] of [['claude', claudeAdapter], ['codex', codexAdapter]] as const) {
  describe(`simulated ${agent}`, () => {
    it('answers in ask mode: streamed text, a read, an approved edit with a diff, one turn-end', async () => {
      const events = await drive(adapter, agent, 'ask')
      const ends = events.filter(e => e.type === 'turn-end')
      expect(ends).toEqual([{ type: 'turn-end', status: 'done' }])
      expect(events[events.length - 1]!.type).toBe('turn-end')
      expect(events.some(e => e.type === 'session')).toBe(true)
      expect(text(events)).toContain('Simulated')
      expect(events.some(e => e.type === 'thinking-delta')).toBe(true)
      const starts = events.filter(e => e.type === 'tool-start')
      expect(starts.map(e => e.tool)).toEqual(['read', 'edit'])
      // Claude Code streams a tool's input, so its row may start without a target and get it in an update.
      const target = (id: string) => events.reduce((t, e) => ((e.type === 'tool-start' || e.type === 'tool-update') && e.id === id && e.target ? e.target : t), '')
      expect(target(starts[0]!.id)).toBe('README.md')
      expect(target(starts[1]!.id)).toBe('src/index.ts')
      expect(events.filter(e => e.type === 'approval')).toHaveLength(1)
      const editEnd = events.find(e => e.type === 'tool-end' && e.id === starts[1]!.id)
      expect(editEnd).toMatchObject({ status: 'ok' })
      const diff = events.flatMap(e => ((e.type === 'tool-update' || e.type === 'tool-end') && e.id === starts[1]!.id ? e.diff ?? [] : []))
      expect(diff).toContainEqual({ kind: 'add', text: 'const greeting = \'Hello from Mango\'' })
      expect(diff).toContainEqual({ kind: 'del', text: 'const greeting = \'Hello\'' })
    })

    it('asks nothing in auto mode', async () => {
      const events = await drive(adapter, agent, 'auto')
      expect(events.some(e => e.type === 'approval')).toBe(false)
      expect(events.filter(e => e.type === 'tool-start')).toHaveLength(2)
      expect(events[events.length - 1]).toEqual({ type: 'turn-end', status: 'done' })
    })

    it('edits nothing in plan mode', async () => {
      const events = await drive(adapter, agent, 'plan')
      expect(events.filter(e => e.type === 'tool-start').map(e => e.tool)).toEqual(['read'])
      expect(text(events)).toContain('Plan mode')
      expect(events[events.length - 1]).toEqual({ type: 'turn-end', status: 'done' })
    })

    it('reports a denied edit', async () => {
      const events = await drive(adapter, agent, 'ask', { allow: false })
      const edit = events.find(e => e.type === 'tool-start' && e.tool === 'edit')!
      expect(events.find(e => e.type === 'tool-end' && e.id === (edit as { id: string }).id)).toMatchObject({ status: 'error' })
      expect(text(events)).toContain('declined')
      expect(events[events.length - 1]).toEqual({ type: 'turn-end', status: 'done' })
    })

    it('stops when interrupted', async () => {
      const events = await drive(adapter, agent, 'ask', { interruptAfter: 'approval' })
      expect(events.filter(e => e.type === 'turn-end')).toEqual([{ type: 'turn-end', status: 'stopped' }])
      expect(events.some(e => e.type === 'approval-cancelled')).toBe(true)
    })

    it('takes a message steered in mid-turn', async () => {
      const events = await drive(adapter, agent, 'auto', { steer: 'and say hi' })
      expect(text(events)).toContain('and say hi')
      expect(events[events.length - 1]).toEqual({ type: 'turn-end', status: 'done' })
    })
  })
}
