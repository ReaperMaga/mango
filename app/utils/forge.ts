import type { ForgeProvider } from '~/types/ipc'

/**
 * How Mango names things on the forge a repository lives on: GitHub has pull requests numbered `#12`
 * and workflow runs, GitLab merge requests numbered `!12` (issues keep `#12`) and pipelines. Plain
 * functions, so they run in Node tests and in the phone app.
 */

/** The provider something names; anything older than GitLab support (no `provider`) is on GitHub. */
export const providerOf = (x: { provider?: ForgeProvider | null } | null | undefined): ForgeProvider =>
  x?.provider === 'gitlab' ? 'gitlab' : 'github'

/** "GitHub" or "GitLab", for sentences about the service ("Reading from GitLab"). */
export const forgeName = (provider: ForgeProvider | null | undefined) => (provider === 'gitlab' ? 'GitLab' : 'GitHub')

/** Where a button takes the user: the service's name on its public host, otherwise the host itself. */
export function siteName(provider: ForgeProvider | null | undefined, host: string | null | undefined): string {
  const h = (host ?? '').toLowerCase()
  if (provider === 'gitlab') return !h || h === 'gitlab.com' ? 'GitLab' : h
  return !h || h === 'github.com' ? 'GitHub' : h
}

/** "pull request", "merge request" or "issue", lower case. */
export function itemNoun(kind: 'pr' | 'issue', provider: ForgeProvider | null | undefined): string {
  if (kind === 'issue') return 'issue'
  return provider === 'gitlab' ? 'merge request' : 'pull request'
}

/** "pull requests" or "merge requests". */
export const requestsNoun = (provider: ForgeProvider | null | undefined) =>
  (provider === 'gitlab' ? 'merge requests' : 'pull requests')

/** The mark before an item's number: `!` for a GitLab merge request, `#` for everything else. */
export const itemSigil = (kind: 'pr' | 'issue', provider: ForgeProvider | null | undefined) =>
  (provider === 'gitlab' && kind === 'pr' ? '!' : '#')

/** `#12`, or `!12` for a GitLab merge request. */
export const itemNumber = (item: { kind: 'pr' | 'issue'; number: number; provider?: ForgeProvider | null }) =>
  `${itemSigil(item.kind, item.provider)}${item.number}`

/** First letter up: "Merge request". */
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** What builds a release: "workflow run(s)" on GitHub, "pipeline(s)" on GitLab. */
export const runNoun = (provider: ForgeProvider | null | undefined, plural = false) =>
  (provider === 'gitlab' ? (plural ? 'pipelines' : 'pipeline') : (plural ? 'workflow runs' : 'workflow run'))
