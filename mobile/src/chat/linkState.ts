import type { LinkedItem } from '~/types/chat'
import type { ForgeProvider } from '~/types/ipc'

/**
 * How a pull request's (a GitLab merge request's) or issue's state reads, in the ripening scale: the desktop's
 * `app/utils/linkState.ts` without its icons (those are Vue components; `ChatLinks` picks the
 * React ones by `icon`). Open is ripening, a draft not ripe yet, merged or completed is ripe,
 * closed without merging is bruised, an issue closed as not planned (or a duplicate) stops in grey.
 */
export type LinkTone = 'running' | 'queued' | 'done' | 'error' | 'idle'
export type LinkIcon = 'pr' | 'pr-draft' | 'pr-merged' | 'pr-closed' | 'issue' | 'issue-done' | 'issue-skipped'

export interface LinkLook { noun: string; word: string; tone: LinkTone; icon: LinkIcon }

export function linkState(kind: LinkedItem['kind'], state: LinkedItem['state'] | undefined, reason?: string | null, provider?: ForgeProvider | null): LinkLook {
  const noun = kind === 'pr' ? (provider === 'gitlab' ? 'Merge request' : 'Pull request') : 'Issue'
  if (kind === 'pr') {
    switch (state) {
      case 'draft': return { noun, word: 'Draft', tone: 'queued', icon: 'pr-draft' }
      case 'merged': return { noun, word: 'Merged', tone: 'done', icon: 'pr-merged' }
      case 'closed': return { noun, word: 'Closed', tone: 'error', icon: 'pr-closed' }
      case 'open': return { noun, word: 'Open', tone: 'running', icon: 'pr' }
      default: return { noun, word: noun, tone: 'idle', icon: 'pr' }

    }
  }
  switch (state) {
    case 'closed':
      return reason === 'not_planned' || reason === 'duplicate'
        ? { noun, word: reason === 'duplicate' ? 'Duplicate' : 'Not planned', tone: 'idle', icon: 'issue-skipped' }
        : { noun, word: 'Closed', tone: 'done', icon: 'issue-done' }
    case 'open': return { noun, word: 'Open', tone: 'running', icon: 'issue' }
    default: return { noun, word: 'Issue', tone: 'idle', icon: 'issue' }
  }
}
