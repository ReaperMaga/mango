import { defineStore } from 'pinia'
import { AGENTS, type AgentId } from '~/types/chat'
import type { AgentUsage, UsageWindow } from '~/agents/types'
import { detectEarlyResets, type UsageReset } from '~/utils/usageReset'
import { readAgentUsage } from '~/agents'
import { isTauri } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { shortAgo, useNow } from '~/utils/time'

/**
 * The plan limits of each agent (5-hour, weekly, …), read from the CLI itself without
 * running a turn. The numbers are kept in memory only: usage moves with every turn, so what is
 * shown is always a fresh read, or the last one while the next is on its way. What is remembered
 * between runs is the last read's windows and any early reset noticed, so a reset that happened
 * while Mango was closed still shows up.
 */
export interface UsageEntry {
  usage: AgentUsage | null
  error: string | null
  loading: boolean
  /** Unix ms of the last answer (or failure). */
  fetchedAt: number | null
  /** The browser preview has no CLI: the numbers are made up. */
  simulated: boolean
  /** Early resets noticed and not dismissed yet, newest first. */
  resets: UsageReset[]
}

const SEEN_KEY = 'mango.usage.seen.v1'
interface Seen { windows: UsageWindow[]; resets: UsageReset[] }
/** Resets older than this are no longer news. */
const RESET_TTL_MS = 48 * 60 * 60 * 1000

function loadSeen(): Partial<Record<AgentId, Seen>> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
const seen = loadSeen()

function remember(agent: AgentId, windows: UsageWindow[], resets: UsageReset[]) {
  seen[agent] = { windows, resets }
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)) } catch { /* not remembered */ }
}

/** A read younger than this is shown as is when the dialog opens again. */
const FRESH_MS = 60_000

const blank = (agent?: AgentId): UsageEntry => ({
  usage: null, error: null, loading: false, fetchedAt: null, simulated: false,
  resets: ((agent && seen[agent]?.resets) || []).filter(r => Date.now() - r.at < RESET_TTL_MS),
})

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
    entries: Object.fromEntries((Object.keys(AGENTS) as AgentId[]).map(id => [id, blank(id)])) as Record<AgentId, UsageEntry>,
  }),

  getters: {
    /** An early reset was noticed and not dismissed yet, for any agent. */
    hasReset: s => Object.values(s.entries).some(e => e.resets.length > 0),
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
        .then(({ usage, simulated }) => {
          const before = entry.usage?.windows ?? seen[agent]?.windows
          const found = detectEarlyResets(before, usage.windows, Date.now())
          Object.assign(entry, { usage, simulated, error: null })
          if (found.length) entry.resets = [...found, ...entry.resets].slice(0, 6)
          if (!simulated) remember(agent, usage.windows, entry.resets)
        })
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

    /** Hide the early-reset notices of `agent`. */
    dismissResets(agent: AgentId) {
      const entry = this.entries[agent]
      entry.resets = []
      const kept = seen[agent]
      if (kept) remember(agent, kept.windows, [])
    },

    /** Every agent that is, or may be, installed: unknown until detection ran, then the CLI says what is wrong. */
    refreshReadable(force = false): Promise<void> {
      const ws = useWorkspace()
      const ids = (Object.keys(AGENTS) as AgentId[]).filter(id => ws.agents.find(a => a.id === id)?.installed ?? true)
      return this.refreshAll(ids, force)
    },

    /** Every agent in `agents` (the installed ones), all at once. */
    refreshAll(agents: AgentId[], force = false): Promise<void> {
      return Promise.all(agents.map(a => this.refresh(a, force))).then(() => {})
    },
  },
})

/** "Updated 2 min ago", or "Reading usage…" while a read is on its way. */
export function useUsageUpdated() {
  const usage = useUsage()
  const now = useNow(15_000)
  return computed(() => {
    if (usage.loading) return 'Reading usage…'
    if (!usage.oldest) return ''
    const ago = shortAgo(usage.oldest, now.value)
    return ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`
  })
}
