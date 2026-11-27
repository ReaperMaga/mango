import type { Thread } from '~/types/chat'
import { call } from '~/composables/useBackend'
import { useGit } from '~/stores/git'
import { useThreads } from '~/stores/threads'
import { buildConflictPrompt } from '~/utils/conflictPrompt'
import { fileInFolder } from '~/utils/gitLog'
import { parseEnvPath } from '~/utils/envPath'

/**
 * "Solve conflicts with agent": a request, worded as the user would write it, sent to the chat they
 * are in for this folder. Only ever on the user's click: it spends their quota.
 */

/**
 * The chat the request goes to: the one in front when it works in `folder`; when the front pane
 * shows something else (the merge editor, a diff), the chat in the other pane, else the most recent
 * open chat there. Null: none works in `folder`, a new chat will.
 */
export function chatForConflicts(folder: string): Thread | null {
  const threads = useThreads()
  const fits = (id: string | null | undefined) => {
    const t = threads.byId(id)
    return t && !t.parentId && !t.archived && !t.awaitingWorktree && threads.workdirFor(t.id) === folder ? t : null
  }
  const front = threads.activePane.threadId
  if (threads.byId(front)) return fits(front)
  for (const p of threads.panes) {
    const t = fits(p.threadId)
    if (t) return t
  }
  return threads.visibleTabs.map(fits).filter((t): t is Thread => !!t).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

/**
 * Ask the agent to resolve the conflicts in `folder` (or only the files in `only`, relative to the
 * repository root). Shows the chat beside `beside` (a merge tab) or in front; resolves to it.
 */
export async function solveConflicts(folder: string, only: string[] = [], beside: string | null = null): Promise<Thread | null> {
  const git = useGit()
  const threads = useThreads()
  const status = git.status(folder)
  if (!status?.isRepo) return null
  const conflicted = status.files.filter(f => f.conflicted).map(f => f.path)
  if (!conflicted.length && !only.length) return null
  // Paths the way the agent sees them from where it runs.
  const dir = parseEnvPath(folder)?.dir ?? folder
  const shown = (f: string) => (status.root ? fileInFolder(dir, status.root, f) ?? f : f)
  const history = await call('git_conflict_history', { path: folder }).catch(() => ({ ours: [], theirs: [] }))
  const text = buildConflictPrompt({
    vcs: status.vcs,
    operation: status.operation,
    files: conflicted.map(shown),
    only: only.map(shown),
    ours: history.ours,
    theirs: history.theirs,
  })
  let chat = chatForConflicts(folder)
  if (chat) {
    if (beside) threads.showBeside(chat.id, beside, true)
    else threads.show(chat.id)
  } else {
    const project = threads.ownerOf(folder)
    chat = threads.create(project, undefined, status.branch, project === folder ? null : folder)
    // The new chat took the front pane: the merge editor comes back there, the chat beside it.
    if (beside && threads.tabs.includes(beside)) {
      threads.show(beside)
      threads.showBeside(chat.id, beside, true)
    }
  }
  // Like the composer: a chat that is working gets it as a follow-up.
  void threads.send(chat.id, text)
  return chat
}
