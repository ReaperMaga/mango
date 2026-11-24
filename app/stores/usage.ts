import { defineStore } from 'pinia'
import { AGENTS, type AgentId } from '~/types/chat'
import type { AgentUsage, UsageWindow } from '~/agents/types'
import { detectEarlyResets, type UsageReset } from '~/utils/usageReset'
import { readAgentUsage } from '~/agents'
import { isTauri } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import { parseEnvPath, placeKey } from '~/utils/envPath'
import { shortAgo, useNow } from '~/utils/time'

/**
 * The plan limits of each agent (5-hour, weekly, …), read from the CLI itself without
 * running a turn. The numbers are kept in memory only: usage moves with every turn, so what is
 * shown is always a fresh read, or the last one while the next is on its way. What is remembered
 * between runs is the last read's windows and any early reset noticed, so a reset that happened
 * while Mango was closed still shows up.
 *
 * Readings are kept per place (`placeKey`): this computer, or a remote environment, whose CLIs may
 * be signed in to other accounts and plans. What is shown is the active project's place, so a remote
 * project shows its environment's agents, never this computer's.
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

type Entries = Record<AgentId, UsageEntry>

const LOCAL = 'local'
const SEEN_KEY = 'mango.usage.seen.v1'
interface Seen { windows: UsageWindow[]; resets: UsageReset[] }
/** Resets older than this are no longer news. */
const RESET_TTL_MS = 48 * 60 * 60 * 1000

/** This computer's agents keep the key older builds wrote; an environment's are `env://host/instance#agent`. */
const seenKey = (place: string, agent: AgentId) => (place === LOCAL ? agent : `${place}#${agent}`)

function loadSeen(): Record<string, Seen> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
const seen = loadSeen()

function remember(place: string, agent: AgentId, windows: UsageWindow[], resets: UsageReset[]) {
  seen[seenKey(place, agent)] = { windows, resets }
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)) } catch { /* not remembered */ }
}

/** A read younger than this is shown as is when the dialog opens again. */
const FRESH_MS = 60_000

const blank = (place: string, agent: AgentId): UsageEntry => ({
  usage: null, error: null, loading: false, fetchedAt: null, simulated: false,
  resets: (seen[seenKey(place, agent)]?.resets ?? []).filter(r => Date.now() - r.at < RESET_TTL_MS),
})
const blanks = (place: string) => Object.fromEntries((Object.keys(AGENTS) as AgentId[]).map(id => [id, blank(place, id)])) as Entries

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

/** Reads on their way, by `place|agent`. */
const inflight = new Map<string, Promise<void>>()

export const useUsage = defineStore('usage', {
  state: () => ({
    places: { [LOCAL]: blanks(LOCAL) } as Record<string, Entries>,
  }),

  getters: {
    /** Where the agents on screen run: the active project's place (`local`, or `env://host/instance`). */
    place(): string {
      return placeKey(useWorkspace().activeProjectPath)
    },
    /** The readings of the place on screen (blank ones until its first read). */
    entries(): Entries {
      return this.places[this.place] ?? blanks(this.place)
    },
    /** An early reset was noticed and not dismissed yet, for any agent of the place on screen. */
    hasReset(): boolean {
      return Object.values(this.entries).some(e => e.resets.length > 0)
    },
    /** Something of the place on screen is being read right now. */
    loading(): boolean {
      return Object.values(this.entries).some(e => e.loading)
    },
    /** When the oldest shown answer arrived; null before any. */
    oldest(): number | null {
      const times = Object.values(this.entries).map(e => e.fetchedAt).filter((t): t is number => t !== null)
      return times.length ? Math.min(...times) : null
    },
  },

  actions: {
    /** The readings of `place`, made when first needed. */
    _at(place: string): Entries {
      return (this.places[place] ??= blanks(place))
    },

    /** Ask `agent`'s CLI in `place` (the one on screen by default) for its limits; a fresh answer is kept unless `force`. */
    refresh(agent: AgentId, force = false, at?: string): Promise<void> {
      const place = at ?? this.place
      const entry = this._at(place)[agent]
      if (!force && entry.fetchedAt && !entry.error && Date.now() - entry.fetchedAt < FRESH_MS) return Promise.resolve()
      const key = `${place}|${agent}`
      const running = inflight.get(key)
      if (running) return running
      entry.loading = true
      const loc = parseEnvPath(place)
      const remote = loc ? { hostId: loc.hostId, instance: loc.instance } : null
      const read = isTauri()
        ? readAgentUsage(agent, remote).then(usage => ({ usage, simulated: false }))
        : new Promise<{ usage: AgentUsage; simulated: boolean }>(r => setTimeout(() => r({ usage: sampleUsage(agent), simulated: true }), 450))
      const job = read
        .then(({ usage, simulated }) => {
          const before = entry.usage?.windows ?? seen[seenKey(place, agent)]?.windows
          const found = detectEarlyResets(before, usage.windows, Date.now())
          Object.assign(entry, { usage, simulated, error: null })
          if (found.length) entry.resets = [...found, ...entry.resets].slice(0, 6)
          if (!simulated) remember(place, agent, usage.windows, entry.resets)
        })
        .catch((e) => { entry.error = e instanceof Error ? e.message : String(e) })
        .finally(() => {
          entry.loading = false
          entry.fetchedAt = Date.now()
          inflight.delete(key)
        })
        .then(() => {})
      inflight.set(key, job)
      return job
    },

    /** Hide the early-reset notices of `agent` in the place on screen. */
    dismissResets(agent: AgentId) {
      const place = this.place
      this._at(place)[agent].resets = []
      const kept = seen[seenKey(place, agent)]
      if (kept) remember(place, agent, kept.windows, [])
    },

    /**
     * Every agent of the place on screen that is, or may be, installed: on this computer, unknown until
     * detection ran (then the CLI says what is wrong); in an environment, every agent (its CLI says).
     */
    refreshReadable(force = false): Promise<void> {
      const place = this.place
      const ws = useWorkspace()
      const ids = (Object.keys(AGENTS) as AgentId[])
        .filter(id => place !== LOCAL || (ws.agents.find(a => a.id === id)?.installed ?? true))
      return Promise.all(ids.map(a => this.refresh(a, force, place))).then(() => {})
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
