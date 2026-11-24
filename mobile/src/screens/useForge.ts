import { useEffect, useState } from 'react'
import type { ForgeProvider, GhRepoLink } from '~/types/ipc'
import { forgeOfProject, knownForge } from '@/state/forges'

/**
 * Where a project lives (`state/forges.ts`), for the words a screen uses ("Merge request" on GitLab)
 * and the link to it. Null while unknown, when it has no remote on either, or when it could not be read.
 */
export function useForge(projectPath: string | null | undefined): GhRepoLink | null {
  const [repo, setRepo] = useState<GhRepoLink | null>(() => (projectPath ? knownForge(projectPath) ?? null : null))
  useEffect(() => {
    if (!projectPath) { setRepo(null); return }
    setRepo(knownForge(projectPath) ?? null)
    let alive = true
    void forgeOfProject(projectPath).then((r) => { if (alive) setRepo(r) })
    return () => { alive = false }
  }, [projectPath])
  return repo
}

/** The project's forge: GitHub unless its remotes say GitLab. */
export const useForgeProvider = (projectPath: string | null | undefined): ForgeProvider => useForge(projectPath)?.provider ?? 'github'
