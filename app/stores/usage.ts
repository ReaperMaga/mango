import { defineStore } from 'pinia'
import { AGENTS, type AgentId } from '~/types/chat'
import type { AgentUsage } from '~/agents/types'
import { readAgentUsage } from '~/agents'
import { isTauri } from '~/composables/useBackend'

/**
 * The plan limits of each agent (5-hour, weekly, …), read from the CLI itself without
 * running a turn. Kept in memory only: usage moves with every turn, so what is shown is
 * always a fresh read, or the last one while the next is on its way.
 */
export interface UsageEntry {
  usage: AgentUsage | null
  error: string | null
  loading: boolean
  /** Unix ms of the last answer (or failure). */
  fetchedAt: number | null
  /** The browser preview has no CLI: the numbers are made up. */
  simulated: boolean
}

/** A read younger than this is shown as is when the dialog opens again. */
const FRESH_MS = 60_000

const blank = (): UsageEntry => ({ usage: null, error: null, loading: false, fetchedAt: null, simulated: false })

/** Plausible numbers for the browser preview, which has no CLI to ask. */
function sampleUsage(agent: AgentId): AgentUsage {
  const now = Date.now()
  const h = 60 * 60 * 1000
  return agent === 'claude'
    ? {
        plan: 'Max',
        windows: [
          { id: 'five-hour', label: '5-hour', percent: 38, resetsAt: now + 2.6 * h },
          { id: 'weekly', label: 'Weekly', percent: 84, resetsAt: now + 52 * h },
          { id: 'weekly:opus', label: 'Weekly · Opus', percent: 41, resetsAt: now + 52 * h },
        ],
      }
    : {
        plan: 'Plus',
        windows: [
          { id: 'five-hour', label: '5-hour', percent: 100, resetsAt: now + 0.7 * h },
          { id: 'weekly', label: 'Weekly', percent: 27, resetsAt: now + 121 * h },
        ],
      }
}

const inflight = new Map<AgentId, Promise<void>>()

export const useUsage = defineStore('usage', {
  state: () => ({
    entries: Object.fromEntries((Object.keys(AGENTS) as AgentId[]).map(id => [id, blank()])) as Record<AgentId, UsageEntry>,
  }),

  getters: {
    /** Something is being read right now. */
    loading: s => Object.values(s.entries).some(e => e.loading),
    /** When the oldest shown answer arrived; null before any. */
    oldest: (s): number | null => {
      const times = Object.values(s.entries).map(e => e.fetchedAt).filter((t): t is number => t !== null)
      return times.length ? Math.min(...times) : null
    },
  },

  actions: {
    /** Ask `agent`'s CLI for its limits; a fresh answer is kept unless `force`. */
    refresh(agent: AgentId, force = false): Promise<void> {
      const entry = this.entries[agent]
      if (!force && entry.fetchedAt && !entry.error && Date.now() - entry.fetchedAt < FRESH_MS) return Promise.resolve()
      const running = inflight.get(agent)
      if (running) return running
      entry.loading = true
      const read = isTauri()
        ? readAgentUsage(agent).then(usage => ({ usage, simulated: false }))
        : new Promise<{ usage: AgentUsage; simulated: boolean }>(r => setTimeout(() => r({ usage: sampleUsage(agent), simulated: true }), 450))
      const job = read
        .then(({ usage, simulated }) => Object.assign(entry, { usage, simulated, error: null }))
        .catch((e) => { entry.error = e instanceof Error ? e.message : String(e) })
        .finally(() => {
          entry.loading = false
          entry.fetchedAt = Date.now()
          inflight.delete(agent)
        })
        .then(() => {})
      inflight.set(agent, job)
      return job
    },

    /** Every agent in `agents` (the installed ones), all at once. */
    refreshAll(agents: AgentId[], force = false): Promise<void> {
      return Promise.all(agents.map(a => this.refresh(a, force))).then(() => {})
    },
  },
})
