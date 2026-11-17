import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment } from '~/types/chat'
import { MAX_ATTACHMENTS, pickFiles, pickPhotos, prepare, takePhoto, type Pending, type Picked } from '@/attachments'
import { envOf } from '@/remote/chatSync'
import { uid } from '@/state/threadModel'
import { haptic } from '@/ui'
import { messageOf } from './names'

export type AttachSource = 'photos' | 'camera' | 'files'

/**
 * The files a chat's composer holds for the next message. Each one is put into the chat's
 * environment as soon as it is picked; `take()` hands over the ready ones when the message goes.
 * They are kept per screen, not saved: leaving the chat drops what wasn't sent.
 */
export function useAttachments(projectPath: string | null) {
  const [files, setFiles] = useState<Pending[]>([])
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const update = (key: string, patch: Partial<Pending>) => {
    if (alive.current) setFiles(list => list.map(f => (f.key === key ? { ...f, ...patch } : f)))
  }

  const add = useCallback(async (source: AttachSource) => {
    const at = envOf(projectPath)
    if (!at) return
    setError(null)
    const room = MAX_ATTACHMENTS - files.filter(f => f.state !== 'error').length
    if (room <= 0) { setError(`A message can carry up to ${MAX_ATTACHMENTS} files.`); return }
    let picked: Picked[]
    try {
      picked = source === 'photos' ? await pickPhotos(room) : source === 'camera' ? await takePhoto() : await pickFiles()
    } catch (e) {
      setError(messageOf(e))
      return
    }
    if (picked.length > room) {
      setError(`Only the first ${room} went along: a message can carry up to ${MAX_ATTACHMENTS} files.`)
      picked = picked.slice(0, room)
    }
    const added = picked.map(p => ({ p, pending: { key: uid('att'), name: p.name, mime: p.mime, state: 'uploading' as const } }))
    setFiles(list => [...list, ...added.map(a => a.pending)])
    // One after another over the environment's connection: big files don't all sit in memory at once.
    for (const { p, pending } of added) {
      try {
        const attachment = await prepare(p, at, pending.key, thumb => update(pending.key, { thumb }))
        update(pending.key, { state: 'ready', attachment, name: attachment.name })
      } catch (e) {
        update(pending.key, { state: 'error', error: messageOf(e) })
        haptic('warning')
      }
    }
  }, [projectPath, files])

  const remove = useCallback((key: string) => setFiles(list => list.filter(f => f.key !== key)), [])

  /** The ready attachments for the message being sent; the composer starts over. */
  const take = useCallback((): Attachment[] => {
    const ready = files.flatMap(f => (f.state === 'ready' && f.attachment ? [f.attachment] : []))
    setFiles([])
    setError(null)
    return ready
  }, [files])

  return { files, error, clearError: () => setError(null), add, remove, take }
}
