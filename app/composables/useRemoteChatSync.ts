import type { Ref } from 'vue'
import { useWorkspace } from '~/stores/workspace'
import { envOf, syncEnv } from '~/utils/remoteChats'
import type { EnvRemote } from '~/types/ipc'

/** Look again at most this often per environment (each look is one SSH round trip). */
const MIN_GAP_MS = 20_000
/** While the window is in front, look this often anyway: another computer may be working. */
const EVERY_MS = 60_000

/**
 * Keep the open remote projects' chats in step with the copies their environments keep
 * (`utils/remoteChats.ts`): when a project opens, when the window comes back to the front,
 * and once a minute while it is in front. Call once, from setup; nothing happens before `ready`
 * (chats and projects loaded).
 */
export function useRemoteChatSync(ready: Ref<boolean>) {
  const ws = useWorkspace()
  const last = new Map<string, number>()

  const envs = (): EnvRemote[] => {
    if (!ready.value) return []
    const seen = new Map<string, EnvRemote>()
    for (const p of ws.openProjects) {
      const e = envOf(p.path)
      if (e) seen.set(`${e.hostId}/${e.instance}`, e)
    }
    return [...seen.values()]
  }

  const look = (force = false) => {
    const now = Date.now()
    for (const e of envs()) {
      const key = `${e.hostId}/${e.instance}`
      if (!force && now - (last.get(key) ?? 0) < MIN_GAP_MS) continue
      last.set(key, now)
      void syncEnv(e)
    }
  }

  // A newly opened remote project: its environment is looked at right away.
  watch(() => envs().map(e => `${e.hostId}/${e.instance}`).join('\n'), (now, before) => {
    const had = new Set((before ?? '').split('\n'))
    for (const key of now.split('\n')) if (key && !had.has(key)) last.delete(key)
    look()
  }, { immediate: true })

  const onFocus = () => look()
  const onVisible = () => { if (!document.hidden) look() }
  const timer = setInterval(() => { if (!document.hidden && document.hasFocus()) look() }, EVERY_MS)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisible)
  onBeforeUnmount(() => {
    clearInterval(timer)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisible)
  })
}
