/**
 * Diffs open in the main pane as tabs next to chats. A diff tab's id carries
 * everything needed to find it again: the project and the git store key
 * ("staged:<file>" or "changes:<file>", see gitFileKey).
 */
const PREFIX = 'diff\u0001'

export const diffTabId = (projectPath: string, key: string) => `${PREFIX}${projectPath}\u0001${key}`

export const isDiffTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX)

export function parseDiffTab(id: string | null | undefined) {
  if (!isDiffTab(id)) return null
  const [, projectPath = '', key = ''] = id.split('\u0001')
  const staged = key.startsWith('staged:')
  const file = key.slice(key.indexOf(':') + 1)
  return { projectPath, key, staged, file, name: file.split('/').pop() || file }
}
