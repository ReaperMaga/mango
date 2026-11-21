import { parseDiffTab } from '~/utils/diffTabs'
import { parseBrowserTab } from '~/utils/browserTabs'
import { parseTerminalTab } from '~/utils/terminalTabs'
import { parsePluginTab } from '~/plugin-host/ids'

/**
 * Project files open in the main pane as tabs next to chats and diffs. The
 * id carries the project and the file's path inside it (forward slashes).
 */
const PREFIX = 'file\u0001'

export const fileTabId = (projectPath: string, file: string) => `${PREFIX}${projectPath}\u0001${file}`

export const isFileTab = (id: string | null | undefined): id is string => !!id && id.startsWith(PREFIX)

export function parseFileTab(id: string | null | undefined) {
  if (!isFileTab(id)) return null
  const [, projectPath = '', file = ''] = id.split('\u0001')
  const cut = file.lastIndexOf('/')
  return { projectPath, file, name: file.slice(cut + 1) || file, dir: cut > 0 ? file.slice(0, cut) : '' }
}

/** The project a diff, file, browser, terminal or plugin tab belongs to; null for chats (ask the threads store). */
export const tabProject = (id: string | null | undefined) =>
  parseFileTab(id)?.projectPath ?? parseDiffTab(id)?.projectPath ?? parseBrowserTab(id)?.projectPath
  ?? parseTerminalTab(id)?.projectPath ?? parsePluginTab(id)?.projectPath ?? null
