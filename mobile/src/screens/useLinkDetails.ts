import { useEffect, useState } from 'react'
import type { LinkedItem } from '~/types/chat'
import { backend } from '@/remote'
import { validGhRef, type GhState } from '@/remote/github'
import { useThreads } from '@/state/threads'

/**
 * The latest title and state of a chat's linked pull requests and issues, read through gh in the
 * chat's environment each time the list opens (`open`). What comes back is also kept on the
 * chat's links, so the list reads well offline next time. A missing or signed-out gh is an
 * `error` to show, never a failure of the list itself.
 */
export function useLinkDetails(threadId: string, projectPath: string | null, links: LinkedItem[], open: boolean) {
  const [live, setLive] = useState<Record<string, GhState>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keys = links.map(l => l.key).join('\n')

  useEffect(() => {
    if (!open || !projectPath) return
    const readable = links.filter(validGhRef)
    if (!readable.length) return
    let alive = true
    setLoading(true)
    setError(null)
    void Promise.allSettled(readable.map(l => backend.ghItem(projectPath, l))).then((results) => {
      if (!alive) return
      const next: Record<string, GhState> = {}
      let failed: string | null = null
      results.forEach((r, i) => {
        const l = readable[i]!
        if (r.status === 'fulfilled') {
          next[l.key] = r.value
          if (r.value.title !== l.title || r.value.state !== l.state || r.value.kind !== l.kind) {
            useThreads.getState().link(threadId, { ...l, kind: r.value.kind, title: r.value.title, state: r.value.state })
          }
        } else if (!failed) {
          failed = r.reason instanceof Error ? r.reason.message : String(r.reason)
        }
      })
      setLive(prev => ({ ...prev, ...next }))
      setError(failed)
      setLoading(false)
    })
    return () => { alive = false; setLoading(false) }
    // `keys` stands for `links`: a chat's array changes on every edit, its items rarely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath, threadId, keys])

  return { live, loading, error }
}
