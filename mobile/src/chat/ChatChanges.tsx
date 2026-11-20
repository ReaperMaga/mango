import { useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, Folder, FolderOpen, GitCompareArrows } from 'lucide-react-native'
import type { Message, Thread } from '~/types/chat'
import { baseName } from '~/utils/paths'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { Banner, Button, IconButton, Sheet, Spinner, Text } from '@/ui'
import { backend } from '@/remote'
import { useThreads } from '@/state/threads'
import { messageOf } from '@/screens/names'
import { ChatDiff } from './ChatDiff'
import {
  changedFilesLabel, changeTree, editsOf, folderPaths, gitChangeFor, initiallyClosed, totals, turnChanges,
  visibleRows, type ChangedFile,
} from './changes'

export interface ChatChangesProps {
  message: Message
  thread: Thread
}

/** A file git has no change left for: what the reply's own edits recorded instead, and why. */
interface Recorded { file: ChangedFile; why: 'committed' | 'untracked-folder' | 'error'; error?: string }

/** Each folder level steps in by this much. */
const INDENT = 14

/**
 * The files an agent reply changed, under the reply, as the desktop's `ChatChanges.vue`: a small
 * tree with +/− per file and folder. A tap opens the file's diff on the Diff screen while git still
 * has a change for it; once it is committed (or changed back) a sheet shows what the reply's own
 * edits recorded, where the desktop opens the file. "Review" opens Changes for the chat's folder.
 */
export function ChatChanges({ message, thread }: ChatChangesProps) {
  const t = useTheme()
  const s = useStyles()
  const router = useRouter()

  // Sub-agents' replies count too. Read once per message: a finished turn does not change.
  const childMessages = (id: string) => useThreads.getState().byId(id)?.messages ?? []
  const files = useMemo(() => turnChanges(message.parts, childMessages), [message])
  const tree = useMemo(() => changeTree(files), [files])
  const folders = useMemo(() => folderPaths(tree), [tree])
  const total = useMemo(() => totals(files), [files])

  const [closed, setClosed] = useState(() => initiallyClosed(files, tree))
  const [opening, setOpening] = useState<string | null>(null)
  const [recorded, setRecorded] = useState<Recorded | null>(null)

  if (!files.length) return null

  const workdir = useThreads.getState().workdirFor(thread.id) ?? thread.worktree ?? thread.projectPath
  const rows = visibleRows(tree, closed)
  const allOpen = closed.size === 0

  const toggle = (path: string) => setClosed((now) => {
    const next = new Set(now)
    if (!next.delete(path)) next.add(path)
    return next
  })

  const open = async (f: ChangedFile) => {
    if (opening) return
    setOpening(f.path)
    try {
      const git = await backend.gitState(workdir)
      const change = git.repo ? gitChangeFor(git.changes, f.path) : null
      if (change) router.push({ pathname: '/diff', params: { path: workdir, file: change.path } })
      else setRecorded({ file: f, why: git.repo ? 'committed' : 'untracked-folder' })
    } catch (e) {
      setRecorded({ file: f, why: 'error', error: messageOf(e) })
    } finally {
      setOpening(null)
    }
  }

  return (
    <View style={s.box} accessibilityLabel={changedFilesLabel(files.length)}>
      <View style={s.head}>
        <View style={s.headText}>
          <Text variant="captionStrong" numberOfLines={1} style={s.title}>{changedFilesLabel(files.length)}</Text>
          <Counts add={total.add} del={total.del} />
        </View>
        {folders.length
          ? (
              <IconButton
                icon={allOpen ? ChevronsDownUp : ChevronsUpDown}
                label={allOpen ? 'Collapse all folders' : 'Expand all folders'}
                size="sm"
                onPress={() => setClosed(allOpen ? new Set(folders) : new Set())}
              />
            )
          : null}
        <Button
          label="Review"
          icon={GitCompareArrows}
          variant="ghost"
          size="sm"
          accessibilityHint="Opens Changes for this chat's folder"
          onPress={() => router.push({ pathname: '/changes', params: { path: workdir, chat: thread.id } })}
          style={s.review}
        />
      </View>

      <View style={s.list}>
        {rows.map(({ node, depth, open: isOpen }) => {
          const f = node.file
          const outside = !!f && !f.inside
          const busy = !!f && opening === f.path
          const Icon = f ? FileText : isOpen ? FolderOpen : Folder
          return (
            <Pressable
              key={node.path}
              onPress={() => (f ? void open(f) : toggle(node.path))}
              disabled={outside}
              accessibilityRole="button"
              accessibilityLabel={`${node.path}, ${node.add} added, ${node.del} removed${outside ? ", outside the chat's folder" : ''}`}
              accessibilityHint={f ? (outside ? undefined : 'Opens the diff') : isOpen ? 'Collapses the folder' : 'Expands the folder'}
              accessibilityState={{ disabled: outside, busy, expanded: f ? undefined : isOpen }}
              style={({ pressed }) => [s.row, { paddingLeft: space[2] + depth * INDENT }, pressed && s.pressed]}
            >
              <View style={s.caret}>
                {f ? null : <ChevronRight size={14} strokeWidth={2} color={t.colors.fgFaint} style={isOpen ? s.turned : undefined} />}
              </View>
              <Icon size={16} strokeWidth={1.75} color={outside ? t.colors.fgFaint : t.colors.fgSubtle} />
              <Text
                variant="mono"
                numberOfLines={1}
                ellipsizeMode={outside ? 'head' : 'middle'}
                style={[s.name, f ? s.fileName : s.folderName, outside && s.outside]}
              >
                {node.name}
              </Text>
              {busy ? <Spinner size={14} label="Reading git" /> : <Counts add={node.add} del={node.del} />}
            </Pressable>
          )
        })}
      </View>

      <Sheet
        visible={!!recorded}
        onClose={() => setRecorded(null)}
        title={recorded ? baseName(recorded.file.path) : ''}
      >
        {recorded ? <RecordedEdits recorded={recorded} parts={message.parts} childMessages={childMessages} /> : null}
      </Sheet>
    </View>
  )
}

function RecordedEdits({ recorded, parts, childMessages }: { recorded: Recorded; parts: Message['parts']; childMessages: (id: string) => Message[] }) {
  const s = useStyles()
  const lines = useMemo(() => editsOf(parts, recorded.file.path, childMessages), [parts, recorded.file.path])
  const why = recorded.why === 'committed'
    ? 'Git has no change left for this file: it was committed since, or changed back.'
    : recorded.why === 'untracked-folder'
      ? "This folder isn't a git repository, so there is no diff to read."
      : ''
  const then = lines.length ? 'Here is what this reply changed.' : "The agent's tools recorded no lines for this file, only that it changed."
  return (
    <View style={s.sheet}>
      {recorded.error ? <Banner tone="error" title="Could not read git" message={recorded.error} /> : null}
      <Text variant="monoSm" tone="subtle" selectable>{recorded.file.path}</Text>
      <Text variant="bodySm" tone="muted">{why ? `${why} ${then}` : then}</Text>
      {lines.length ? <ChatDiff lines={lines} /> : null}
    </View>
  )
}

/** As the Changes list: a side with nothing in it is left out. */
function Counts({ add, del }: { add: number; del: number }) {
  const s = useStyles()
  return (
    <View style={s.counts}>
      {add || !del ? <Text variant="caption" tabular style={s.add}>+{add}</Text> : null}
      {del ? <Text variant="caption" tabular style={s.del}>−{del}</Text> : null}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  box: {
    marginTop: space[3],
    marginBottom: space[1],
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    borderRadius: t.radius.md,
    borderCurve: 'continuous',
    backgroundColor: t.colors.bgPanel,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    minHeight: touch.min,
    paddingLeft: space[3],
    paddingRight: space[1],
    borderBottomWidth: 1,
    borderBottomColor: t.colors.lineSoft,
  },
  headText: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  title: { flexShrink: 1, color: t.colors.fg },
  list: { paddingVertical: space[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: touch.min,
    paddingRight: space[3],
  },
  pressed: { backgroundColor: t.colors.bgActive },
  caret: { width: 14, alignItems: 'center' },
  turned: { transform: [{ rotate: '90deg' }] },
  name: { flex: 1, minWidth: 0 },
  fileName: { color: t.colors.fgMuted },
  folderName: { color: t.colors.fgSubtle },
  outside: { color: t.colors.fgFaint },
  counts: { flexDirection: 'row', gap: 6 },
  add: { color: t.colors.diffAddFg },
  del: { color: t.colors.diffDelFg },
  review: { alignSelf: 'center' },
  sheet: { gap: space[3] },
}))
