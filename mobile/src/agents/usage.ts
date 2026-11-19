import type { AgentAdapter, AgentUsage } from '~/agents/types'
import { claudeAdapter } from '~/agents/claude'
import { codexAdapter } from '~/agents/codex'
import type { AgentId } from '~/types/chat'
import { envPath } from '~/utils/envPath'
import { backend } from '@/remote'
import { AGENT_HOME } from '@/remote/shell'

const adapters: Record<AgentId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter }

/** Plausible numbers for the web preview, which has no CLI to ask (labelled as simulated where shown). */
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
          { id: 'five-hour', label: '5-hour', percent: 12, resetsAt: now + 4.1 * h },
          { id: 'weekly', label: 'Weekly', percent: 100, resetsAt: now + 30 * h },
        ],
      }
}

/**
 * The plan limits `agent`'s CLI reports in an environment's instance, read without running a turn
 * (the desktop's `readAgentUsage`: the CLI starts in the agent's home). Rejects with a message a
 * person can act on.
 */
export function readUsage(agent: AgentId, hostId: string, instance: string): Promise<AgentUsage> {
  if (!backend.real) return new Promise(r => setTimeout(() => r(sampleUsage(agent)), 450))
  const read = adapters[agent].readUsage
  if (!read) return Promise.reject(new Error(`${agent} cannot report its usage.`))
  return read(backend.spawnFor(agent, envPath({ hostId, instance, dir: AGENT_HOME })))
}
