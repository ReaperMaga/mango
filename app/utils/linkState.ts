import { CircleCheck, CircleDot, CircleSlash, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import type { ForgeProvider } from '~/types/ipc'
import { t } from '~/i18n'

/**
 * How a pull request's (a GitLab merge request's) or issue's state reads, in the ripening scale: an open one is ripening,
 * a draft not ripe yet, merged or completed is ripe, closed without merging is bruised, and an
 * issue closed as not planned (or a duplicate) simply stops, in grey.
 */
export type LinkTone = 'running' | 'queued' | 'done' | 'error' | 'idle'

export function stateOf(kind: LinkedItem['kind'], state: LinkedItem['state'] | undefined, reason?: string | null, provider?: ForgeProvider | null) {
  const noun = kind === 'pr' ? (provider === 'gitlab' ? t('links.noun.mergeRequest') : t('links.noun.pullRequest')) : t('links.noun.issue')
  if (kind === 'pr') {
    switch (state) {
      case 'draft': return { noun, word: t('links.state.draft'), tone: 'queued' as LinkTone, icon: GitPullRequestDraft }
      case 'merged': return { noun, word: t('links.state.merged'), tone: 'done' as LinkTone, icon: GitMerge }
      case 'closed': return { noun, word: t('links.state.closed'), tone: 'error' as LinkTone, icon: GitPullRequestClosed }
      case 'open': return { noun, word: t('links.state.open'), tone: 'running' as LinkTone, icon: GitPullRequest }
      default: return { noun, word: noun, tone: 'idle' as LinkTone, icon: GitPullRequest }
    }
  }
  switch (state) {
    case 'closed':
      return reason === 'not_planned' || reason === 'duplicate'
        ? { noun, word: reason === 'duplicate' ? t('links.state.duplicate') : t('links.state.notPlanned'), tone: 'idle' as LinkTone, icon: CircleSlash }
        : { noun, word: t('links.state.closed'), tone: 'done' as LinkTone, icon: CircleCheck }
    case 'open': return { noun, word: t('links.state.open'), tone: 'running' as LinkTone, icon: CircleDot }
    default: return { noun, word: noun, tone: 'idle' as LinkTone, icon: CircleDot }
  }
}
