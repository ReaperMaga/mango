import type { Attachment } from '~/types/chat'
import type { AgentImage } from '~/agents/types'
import { attachmentNote } from '~/utils/attachments'

/**
 * Picture copies fitted for the model, by attachment id, kept from picking to sending (this
 * session only: queued messages live no longer). Here, not in `./index`, so the runner can read
 * them without the pickers.
 */
export const inlineCopies = new Map<string, { mime: string; data: string }>()
export const inlineFor = (a: Attachment) => inlineCopies.get(a.id)

/**
 * What a run gets for a message and its attachments. Every attachment from the phone is already
 * inside the environment (`backend.attachmentPut`), so unlike the desktop's remote runs nothing
 * stays behind: pictures go inline (when a copy fitted for the model is at hand), and every other
 * file, or a picture without one, is named by its path there for the agent to read.
 */
export function agentInput(
  text: string,
  files: readonly Attachment[],
  inline: (a: Attachment) => { mime: string; data: string } | undefined,
): { prompt: string; images: AgentImage[] } {
  const images: AgentImage[] = []
  const byPath: Attachment[] = []
  for (const a of files) {
    const fitted = a.kind === 'image' ? inline(a) : undefined
    if (fitted) images.push({ name: a.name, path: a.path, mime: fitted.mime, data: fitted.data })
    else byPath.push(a)
  }
  return { prompt: [text.trim(), attachmentNote(byPath)].filter(Boolean).join('\n\n'), images }
}

/**
 * A picked file's name as the environment can keep it (`validAttachmentName`): one path segment,
 * no control characters, not hidden, not an option, at most 200 characters with its extension kept.
 */
export function safeName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_').trim().replace(/^[.\-\s]+/, '')
  if (!n) n = fallback
  if (n.length > 200) {
    const ext = /\.[^.]{1,16}$/.exec(n)?.[0] ?? ''
    n = n.slice(0, 200 - ext.length) + ext
  }
  return n
}
