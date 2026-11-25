import type { Thread } from '~/types/chat'
import { sessionMovedOn } from '~/agents'
import { isTauri } from '~/composables/useBackend'
import { useThreads } from '~/stores/threads'
import { useUsage } from '~/stores/usage'
import { useWindows } from '~/stores/windows'
import { useWorkspace } from '~/stores/workspace'
import { attachmentDrafts, drafts } from '~/utils/drafts'
import { dueForCompaction } from '~/utils/idleCompaction'

const TICK_MS = 30_000
/** A plan limit used this far is left to the user's own messages. */
const PLAN_PERCENT = 80

/**
 * Compacts large Claude Code chats shortly before their cache expires (Settings > Behaviour, off unless the
 * user chose it: it spends quota by itself). One at a time, and only chats nothing is open about.
 */
export function useIdleCompaction() {
  const ws = useWorkspace()
  const threads = useThreads()
  const usage = useUsage()
  const win = useWindows()
  let working = false

  const due = (t: Thread) => dueForCompaction(t, ws.idleCompaction, Date.now(), !!drafts.get(t.id)?.trim()
    || !!attachmentDrafts.get(t.id)?.length || !!threads.queue[t.id]?.length || !!threads.live[t.id]
    || !win.owns({ projectPath: t.projectPath, rootId: t.id }))

  /** Whether the plan has room for it. Not when it does not say. */
  async function roomInPlan() {
    await usage.refresh('claude', false, 'local')
    const { usage: read, error } = usage._at('local').claude
    return !!read && !error && read.windows.every(w => w.percent < PLAN_PERCENT)
  }

  async function tick() {
    if (working || ws.idleCompaction !== 'auto') return
    working = true
    try {
      const tried = new Set<string>()
      for (;;) {
        const next = threads.threads.find(t => !tried.has(t.id) && due(t))
        if (!next) return
        tried.add(next.id)
        if (!(await roomInPlan())) return
        // What was read may have taken a while: look again.
        if (!(await sessionMovedOn(next)) && due(next)) await threads.compact(next.id, 'idle')
      }
    } finally {
      working = false
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => { if (isTauri()) timer = setInterval(() => void tick().catch(() => {}), TICK_MS) })
  onBeforeUnmount(() => clearInterval(timer))
}
