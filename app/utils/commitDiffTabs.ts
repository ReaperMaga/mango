/**
 * A file's diff in one commit (from the Git log) opens in the main pane as a tab. Its id carries the
 * folder the log read (the project, or a chat's worktree), the commit's hash and the file.
 */
const PREFIX = 'cdiff\u0001'

export const commitDiffTabId = (projectPath: string, hash: string, file: string) => `${PREFIX}${projectPath}\u0001${hash}\u0001${file}`

export const isCommitDiffTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX)

export function parseCommitDiffTab(id: string | null | undefined) {
  if (!isCommitDiffTab(id)) return null
  const [, projectPath = '', hash = '', file = ''] = id.split('\u0001')
  return { projectPath, hash, short: hash.slice(0, 7), file, name: file.slice(file.lastIndexOf('/') + 1) }
}
