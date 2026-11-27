import { useFiles } from '~/stores/files'
import { useGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { isDiffTab } from '~/utils/diffTabs'
import { parseEnvPath } from '~/utils/envPath'
import { fileInFolder } from '~/utils/gitLog'
import { isMergeTab, mergeResultTab, mergeTabId } from '~/utils/mergeTabs'

/** The merge tab for a conflicted `file` (relative to the repository root) of the working copy at `folder`. */
export function mergeTabFor(folder: string, file: string): string {
  const root = useGit().status(folder)?.root
  const dir = parseEnvPath(folder)?.dir ?? folder
  return mergeTabId(folder, file, root ? fileInFolder(dir, root, file) : file)
}

/**
 * Show a conflicted file in the merge editor. Browsing from the Changes view reuses the diff or merge
 * tab in front (one that holds no unsaved resolution) instead of piling up tabs.
 */
export function openMergeEditor(folder: string, file: string) {
  const threads = useThreads()
  const id = mergeTabFor(folder, file)
  const current = threads.activePane.threadId
  const reusable = isDiffTab(current) || (isMergeTab(current) && !useFiles().isUnsaved(mergeResultTab(current)))
  if (current && current !== id && reusable && !threads.tabs.includes(id)) threads.replaceTab(current, id)
  else threads.show(id)
}
