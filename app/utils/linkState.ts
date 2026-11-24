import { CircleCheck, CircleDot, CircleSlash, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import type { ForgeProvider } from '~/types/ipc'

/**
 * How a pull request's (a GitLab merge request's) or issue's state reads, in the ripening scale: an open one is ripening,
 * a draft not ripe yet, merged or completed is ripe, closed without merging is bruised, and an
 * issue closed as not planned (or a duplicate) simply stops, in grey.
 */
export type LinkTone = 'running' | 'queued' | 'done' | 'error' | 'idle'

export function stateOf(kind: LinkedItem['kind'], state: LinkedItem['state'] | undefined, reason?: string | null, provider?: ForgeProvider | null) {
  const noun = kind === 'pr' ? (provider === 'gitlab' ? 'Merge request' : 'Pull request') : 'Issue'
  if (kind === 'pr') {
    switch (state) {
      case 'draft': return { noun, word: 'Draft', tone: 'queued' as LinkTone, icon: GitPullRequestDraft }
      case 'merged': return { noun, word: 'Merged', tone: 'done' as LinkTone, icon: GitMerge }
      case 'closed': return { noun, word: 'Closed', tone: 'error' as LinkTone, icon: GitPullRequestClosed }
      case 'open': return { noun, word: 'Open', tone: 'running' as LinkTone, icon: GitPullRequest }
      default: return { noun, word: noun, tone: 'idle' as LinkTone, icon: GitPullRequest }
    }
  }
  switch (state) {
    case 'closed':
      return reason === 'not_planned' || reason === 'duplicate'
        ? { noun, word: reason === 'duplicate' ? 'Duplicate' : 'Not planned', tone: 'idle' as LinkTone, icon: CircleSlash }
        : { noun, word: 'Closed', tone: 'done' as LinkTone, icon: CircleCheck }
    case 'open': return { noun, word: 'Open', tone: 'running' as LinkTone, icon: CircleDot }
    default: return { noun, word: 'Issue', tone: 'idle' as LinkTone, icon: CircleDot }
  }
}
