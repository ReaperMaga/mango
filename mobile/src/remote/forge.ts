import type { ForgeProvider } from '~/types/ipc'
import { providerOf } from '~/utils/forge'
import { ghWebUrl, validGhRef, type GhRef } from './github'
import { isHost, isNamespace, isSegment } from './gitlab'

/**
 * A linked item on either forge: GitHub (github.com only, `github.ts`) or a GitLab server
 * (`gitlab.ts`). Links come from chat files (untrusted): every part is checked here before
 * anything is read or opened. Which GitLab servers glab may be asked about is decided where glab
 * runs (`sshBackend.ts`: gitlab.com, `gitlab.*` names, and the servers glab is signed in to there).
 */

export { providerOf }

/** An item number GitLab's API and GraphQL hold. */
const validNumber = (n: number): boolean => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647

/** A GitLab item: a server name, a namespace and project path, a number. */
export function validGlRef(ref: GhRef): boolean {
  return providerOf(ref) === 'gitlab' && isHost(ref.host.toLowerCase()) && isNamespace(ref.owner) && isSegment(ref.repo) && validNumber(ref.number)
}

/** The item is well formed for its forge (on GitHub: on github.com). */
export function validRef(ref: GhRef): boolean {
  return providerOf(ref) === 'gitlab' ? validGlRef(ref) : validGhRef(ref)
}

/**
 * Where the item opens in the browser, built from its validated parts (never the stored `url`).
 * GitLab: `https://host/group/project/-/merge_requests/12` or `/-/issues/12`.
 */
export function webUrl(ref: GhRef): string | null {
  if (providerOf(ref) !== 'gitlab') return ghWebUrl(ref)
  if (!validGlRef(ref)) return null
  return `https://${ref.host.toLowerCase()}/${ref.owner}/${ref.repo}/-/${ref.kind === 'pr' ? 'merge_requests' : 'issues'}/${ref.number}`
}

/** A repository's page: `https://{host}/{owner}/{repo}` on both forges. */
export function repoWebUrl(r: { provider: ForgeProvider; host: string; owner: string; repo: string }): string | null {
  const host = r.host.toLowerCase()
  if (r.provider === 'gitlab') return isHost(host) && isNamespace(r.owner) && isSegment(r.repo) ? `https://${host}/${r.owner}/${r.repo}` : null
  return host === 'github.com' && isSegment(r.owner) && isSegment(r.repo) ? `https://github.com/${r.owner}/${r.repo}` : null
}

/** "only github.com" no longer says it: what the phone reads, for messages. */
export const READABLE = 'Only pull requests, merge requests and issues on github.com or a GitLab server can be read here.'
