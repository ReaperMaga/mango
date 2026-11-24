import type { ForgeProvider, GhRepoLink } from '~/types/ipc'
import { backend } from '@/remote'

/**
 * Where each project lives (`backend.ghRepo`: its GitHub repository or GitLab project, from its git
 * remotes inside the environment), kept for the session: the words a screen or a chat uses ("Merge
 * request" on GitLab), and the instructions `/create-pr` and `/create-release` hand the agent.
 */
const known = new Map<string, GhRepoLink | null>()

/** What is known now, without asking: undefined while it was never read. */
export const knownForge = (projectPath: string): GhRepoLink | null | undefined => known.get(projectPath)

/** The project's forge, read once; null when it has no remote on either or it could not be read. */
export async function forgeOfProject(projectPath: string): Promise<GhRepoLink | null> {
  if (known.has(projectPath)) return known.get(projectPath) ?? null
  try {
    const r = await backend.ghRepo(projectPath)
    known.set(projectPath, r)
    return r
  } catch {
    // Not kept: a failed connection is asked again next time.
    return null
  }
}

/** GitHub unless the project is known to be on GitLab. */
export const knownProvider = (projectPath: string): ForgeProvider => known.get(projectPath)?.provider ?? 'github'
