import type { Thread } from '~/types/chat'
import { mostUrgent, projectName } from './names'

/** A project folder on Home: the chats in it, and what a glance at the folder should say. */
export interface ProjectGroup {
  /** The project's `env://` path. */
  path: string
  name: string
  chats: Thread[]
  /** When the folder last had activity (its newest chat's update), unix ms. */
  latest: number
  /** The chat that needs attention most: its dot is the folder's. */
  top: Thread | null
  /** Chats an agent is working on right now. */
  working: number
}

/**
 * Chats gathered by the folder they work in, the folders with the latest activity first. A chat in
 * a worktree counts for its project (a worktree is a folder of the same repository), so it does not
 * become a folder of its own.
 */
export function groupByProject(chats: readonly Thread[]): ProjectGroup[] {
  const byPath = new Map<string, Thread[]>()
  for (const c of chats) {
    const list = byPath.get(c.projectPath)
    if (list) list.push(c)
    else byPath.set(c.projectPath, [c])
  }
  const groups: ProjectGroup[] = []
  for (const [path, list] of byPath) {
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    groups.push({
      path,
      name: projectName(path),
      chats: list,
      latest: list[0]!.updatedAt,
      top: mostUrgent(list),
      working: list.filter(c => c.status === 'running' || c.status === 'queued').length,
    })
  }
  return groups.sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name))
}

/** "3 chats", "1 chat · 1 working": what a folder row says under its name. */
export function groupSummary(g: Pick<ProjectGroup, 'chats' | 'working'>): string {
  const n = g.chats.length
  const chats = n === 1 ? '1 chat' : `${n} chats`
  return g.working ? `${chats} · ${g.working} working` : chats
}
