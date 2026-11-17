import { useEffect, useSyncExternalStore } from 'react'
import type { AgentCommand, AgentId } from '~/types/chat'
import type { AgentAdapter } from '~/agents/types'
import { claudeAdapter } from '~/agents/claude'
import { codexAdapter } from '~/agents/codex'
import { backend } from '@/remote'
import { placeOf } from '@/agents/turn'

/**
 * The slash commands an agent's CLI offers in a folder (its built-ins, the user's and the
 * project's commands, skills), read without running a turn: the desktop's `stores/commands.ts`
 * `refresh`. Each look starts the CLI in the environment, so it is asked only when the command
 * list opens, and a list is trusted for ten minutes. Kept in memory: until a CLI has answered,
 * the composer shows the fallback list (`@/chat/commands`).
 */

const FRESH_MS = 10 * 60 * 1000

const adapters: Record<AgentId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter }

const lists = new Map<string, readonly AgentCommand[]>()
const fetchedAt = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

const keyOf = (agent: AgentId, workdir: string) => `${agent}\n${workdir}`

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Ask the CLI for its commands in `workdir`, unless the last answer is fresh. Quietly keeps the last list on failure. */
export function refreshAgentCommands(agent: AgentId, workdir: string): Promise<void> {
  const adapter = adapters[agent]
  if (!adapter?.listCommands) return Promise.resolve()
  const key = keyOf(agent, workdir)
  if (Date.now() - (fetchedAt.get(key) ?? 0) < FRESH_MS) return Promise.resolve()
  const running = inflight.get(key)
  if (running) return running
  const job = adapter.listCommands(backend.spawnFor(agent, workdir), placeOf(workdir).cwd)
    .then((commands) => {
      // Asked again on the next look either way; an empty answer leaves the fallback in place.
      fetchedAt.set(key, Date.now())
      if (!commands.length) return
      lists.set(key, commands)
      for (const fn of listeners) fn()
    })
    .catch(() => { /* keep what we have */ })
    .finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

/**
 * The commands `agent`'s CLI reported for `workdir` (null until it has, or without a folder).
 * While `open`, a stale list is looked up again.
 */
export function useAgentCommands(agent: AgentId, workdir: string | null | undefined, open: boolean): readonly AgentCommand[] | null {
  const key = workdir ? keyOf(agent, workdir) : null
  const list = useSyncExternalStore(subscribe, () => (key ? lists.get(key) ?? null : null))
  useEffect(() => {
    if (open && workdir) void refreshAgentCommands(agent, workdir)
  }, [open, agent, workdir])
  return list
}
