import { fileTabId } from '~/utils/fileTabs'

/**
 * The merge editor opens a conflicted file as a tab beside the chats. Its id carries the folder the
 * Changes view shows (the git store's key: the project, or a chat's worktree), the file relative to
 * the repository root (what the backend's conflict commands take) and the same file relative to that
 * folder, empty when it lies outside it (then it can only be taken whole, not edited here).
 * Like diff tabs, merge tabs are not saved with the layout.
 */
const PREFIX = 'merge\u0001'

export const mergeTabId = (folder: string, file: string, inFolder: string | null) => `${PREFIX}${folder}\u0001${file}\u0001${inFolder ?? ''}`

export const isMergeTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX)

export function parseMergeTab(id: string | null | undefined) {
  if (!isMergeTab(id)) return null
  const [, projectPath = '', file = '', inFolder = ''] = id.split('\u0001')
  return { projectPath, file, inFolder: inFolder || null, name: file.split('/').pop() || file }
}

/** The file tab id whose open file (and editor model) the merge tab's Result edits; null when it can't. */
export function mergeResultTab(id: string | null | undefined): string | null {
  const m = parseMergeTab(id)
  return m?.inFolder ? fileTabId(m.projectPath, m.inFolder) : null
}
