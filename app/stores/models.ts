import { defineStore } from 'pinia'
import { AGENTS, type AgentId, type AgentModel } from '~/types/chat'
import { listAgentModels } from '~/agents'
import { modelTitle } from '~/utils/modelNames'

/**
 * The models each agent CLI offers, as the CLI itself reports them (with the
 * effort levels each accepts). Read without running a turn, cached on disk so
 * the picker is complete at once on the next launch, and refreshed now and
 * then. Until a CLI has answered, the built-in list in AGENTS stands in.
 */

/** Versioned: a list cached by an older build lacks fields (default efforts) and is fetched again. */
const KEY = 'mango.models.v2'
/** How long a list is trusted before the next look (opening the picker refreshes a stale one). */
const FRESH_MS = 30 * 60 * 1000

interface Cached { lists: Partial<Record<AgentId, AgentModel[]>>; fetchedAt: Partial<Record<AgentId, number>> }

function load(): Cached {
  try {
    localStorage.removeItem('mango.models')
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
    const lists: Cached['lists'] = {}
    for (const id of Object.keys(AGENTS) as AgentId[]) {
      const list = raw.lists?.[id]
      if (Array.isArray(list) && list.every((m: AgentModel) => typeof m?.id === 'string' && typeof m?.label === 'string')) lists[id] = list.map(tidy)
    }
    return { lists, fetchedAt: raw.fetchedAt ?? {} }
  } catch {
    return { lists: {}, fetchedAt: {} }
  }
}

/** Codex reports some names in lower case ("gpt-5.4"), and a name may be a raw id: show them like the others. */
const tidy = (m: AgentModel): AgentModel => ({ ...m, label: modelTitle(m.label.replace(/^gpt(?=-)/, 'GPT')) })

const inflight = new Map<AgentId, Promise<void>>()

export const useModels = defineStore('models', {
  state: () => load(),

  getters: {
    /** Models to offer for `agent`, 'default' first. */
    list: s => (agent: AgentId): AgentModel[] => {
      const live = s.lists[agent]
      return live?.length ? live : AGENTS[agent].models
    },
    find(): (agent: AgentId, id: string) => AgentModel | null {
      return (agent, id) => this.list(agent).find(m => m.id === id) ?? AGENTS[agent].models.find(m => m.id === id) ?? null
    },
    label(): (agent: AgentId, id: string) => string {
      return (agent, id) => this.find(agent, id)?.label ?? modelTitle(id)
    },
    /** Effort levels `model` accepts; empty when there is nothing to choose. */
    efforts(): (agent: AgentId, id: string) => string[] {
      return (agent, id) => this.find(agent, id)?.efforts ?? []
    },
  },

  actions: {
    persist() {
      try { localStorage.setItem(KEY, JSON.stringify({ lists: this.lists, fetchedAt: this.fetchedAt })) } catch { /* not persisted */ }
    },

    /**
     * Ask the CLI for its models. `cwd` is any folder to start it in (the open project).
     * Quietly keeps the last list when the CLI is missing, signed out or slow.
     */
    refresh(agent: AgentId, cwd: string | null, force = false): Promise<void> {
      if (!cwd) return Promise.resolve()
      if (!force && Date.now() - (this.fetchedAt[agent] ?? 0) < FRESH_MS) return Promise.resolve()
      const running = inflight.get(agent)
      if (running) return running
      const job = listAgentModels(agent, cwd)
        .then((models) => {
          if (!models?.length) return
          this.lists[agent] = models.map(tidy)
          this.fetchedAt[agent] = Date.now()
          this.persist()
        })
        .catch(() => { /* keep what we have */ })
        .finally(() => inflight.delete(agent))
      inflight.set(agent, job)
      return job
    },
  },
})
