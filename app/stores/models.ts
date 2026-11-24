import { defineStore } from 'pinia'
import { AGENTS, type AgentId, type AgentModel } from '~/types/chat'
import { listAgentModels } from '~/agents'
import { modelTitle } from '~/utils/modelNames'
import { placeKey } from '~/utils/envPath'
import { t } from '~/i18n'

/**
 * The models each agent CLI offers, as the CLI itself reports them (with the
 * effort levels each accepts). Read without running a turn, cached on disk so
 * the picker is complete at once on the next launch, and refreshed now and
 * then. Until a CLI has answered, the built-in list in AGENTS stands in.
 *
 * Lists are kept per place (`placeKey`): this computer, or each remote environment.
 * A remote project's CLI runs in its instance, signed in on its own, so it may offer
 * other models than the one here. Every getter takes `where`, a project path (or
 * null for this computer).
 */

/** Versioned: v2 kept one list per agent (this computer's); it is read as `local`. */
const KEY = 'mango.models.v3'
const OLD_KEY = 'mango.models.v2'
/** How long a list is trusted before the next look (opening the picker refreshes a stale one). */
const FRESH_MS = 30 * 60 * 1000

type Lists = Partial<Record<AgentId, AgentModel[]>>
type Times = Partial<Record<AgentId, number>>
interface Cached { lists: Record<string, Lists>; fetchedAt: Record<string, Times> }

const isList = (list: unknown): list is AgentModel[] =>
  Array.isArray(list) && list.every((m: AgentModel) => typeof m?.id === 'string' && typeof m?.label === 'string')

function readLists(raw: any): Lists {
  const lists: Lists = {}
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    const list = raw?.[id]
    if (isList(list)) lists[id] = list.map(tidy)
  }
  return lists
}

function load(): Cached {
  try {
    localStorage.removeItem('mango.models')
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (raw && typeof raw === 'object') {
      const lists: Cached['lists'] = {}
      for (const [place, l] of Object.entries(raw.lists ?? {})) lists[place] = readLists(l)
      const fetchedAt = raw.fetchedAt && typeof raw.fetchedAt === 'object' ? raw.fetchedAt : {}
      return { lists, fetchedAt }
    }
    // An older build's lists were all asked of this computer's CLIs.
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? '{}') ?? {}
    return { lists: { local: readLists(old.lists) }, fetchedAt: { local: old.fetchedAt ?? {} } }
  } catch {
    return { lists: {}, fetchedAt: {} }
  }
}

/** Codex reports some names in lower case ("gpt-5.4"), and a name may be a raw id: show them like the others. */
const tidy = (m: AgentModel): AgentModel => ({ ...m, label: modelTitle(m.label.replace(/^gpt(?=-)/, 'GPT')) })

/** Hints of the built-in models (AGENTS); a list from the CLI carries its own. */
const HINTS: Record<string, string> = { 'fable': 'fable', 'opus': 'opus', 'sonnet': 'sonnet', 'haiku': 'haiku', 'gpt-5.5': 'gpt55', 'gpt-5.4': 'gpt54', 'gpt-5.4-mini': 'gpt54mini' }

/** A model in the interface language: Mango's own words ("Default", the built-in hints); the CLI's stay as they are. */
function shown(agent: AgentId, m: AgentModel, builtIn: boolean): AgentModel {
  if (m.id !== 'default') return builtIn && HINTS[m.id] ? { ...m, hint: t(`chat.models.${HINTS[m.id]}`) } : m
  const name = AGENTS[agent].name
  const choice = `${name}'s choice: `
  const hint = m.hint === `Whatever ${name} is configured to use`
    ? t('chat.models.configured', { agent: name })
    : m.hint?.startsWith(choice) ? t('chat.models.choice', { agent: name, model: m.hint.slice(choice.length) }) : m.hint
  return { ...m, label: m.label === 'Default' ? t('chat.models.default') : m.label, hint }
}

/** Lookups running, by place and agent. */
const inflight = new Map<string, Promise<void>>()

export const useModels = defineStore('models', {
  state: () => load(),

  getters: {
    /** Models to offer for `agent` in the project at `where`, 'default' first. */
    list: s => (agent: AgentId, where: string | null): AgentModel[] => {
      const live = s.lists[placeKey(where)]?.[agent]
      const builtIn = !live?.length
      return (builtIn ? AGENTS[agent].models : live).map(m => shown(agent, m, builtIn))
    },
    find(): (agent: AgentId, id: string, where: string | null) => AgentModel | null {
      return (agent, id, where) => {
        const listed = this.list(agent, where).find(m => m.id === id)
        if (listed) return listed
        const own = AGENTS[agent].models.find(m => m.id === id)
        return own ? shown(agent, own, true) : null
      }
    },
    label(): (agent: AgentId, id: string, where: string | null) => string {
      return (agent, id, where) => this.find(agent, id, where)?.label ?? modelTitle(id)
    },
    /** Effort levels `model` accepts; empty when there is nothing to choose. */
    efforts(): (agent: AgentId, id: string, where: string | null) => string[] {
      return (agent, id, where) => this.find(agent, id, where)?.efforts ?? []
    },
  },

  actions: {
    persist() {
      try {
        localStorage.setItem(KEY, JSON.stringify({ lists: this.lists, fetchedAt: this.fetchedAt }))
        localStorage.removeItem(OLD_KEY)
      } catch { /* not persisted */ }
    },

    /**
     * Ask the CLI for its models, where the project at `cwd` runs it (the open project; a remote
     * one asks inside its environment). Quietly keeps the last list when the CLI is missing,
     * signed out or slow.
     */
    refresh(agent: AgentId, cwd: string | null, force = false): Promise<void> {
      if (!cwd) return Promise.resolve()
      const place = placeKey(cwd)
      if (!force && Date.now() - (this.fetchedAt[place]?.[agent] ?? 0) < FRESH_MS) return Promise.resolve()
      const key = `${place}\n${agent}`
      const running = inflight.get(key)
      if (running) return running
      const job = listAgentModels(agent, cwd)
        .then((models) => {
          if (!models?.length) return
          ;(this.lists[place] ??= {})[agent] = models.map(tidy)
          ;(this.fetchedAt[place] ??= {})[agent] = Date.now()
          this.persist()
        })
        .catch(() => { /* keep what we have */ })
        .finally(() => inflight.delete(key))
      inflight.set(key, job)
      return job
    },
  },
})
