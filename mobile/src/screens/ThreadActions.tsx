import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { GitPullRequest, Trash2 } from 'lucide-react-native'
import { displayStatus, type Thread } from '~/types/chat'
import { isBusy } from '@/state/threadModel'
import { makeStyles, space, useTheme } from '@/theme'
import { Button, ListRow, ListSection, RipenessDot, Sheet, TextField, haptic } from '@/ui'
import { useThreads } from '@/state/threads'
import { usePrefs } from '@/state/prefs'
import { ConfirmBox } from './ConfirmBox'

/** The statuses a person can pick, as the desktop's chat menu offers them; the others belong to runs. */
type Pickable = 'working' | 'done' | 'archived'
const CHOICES: { status: Pickable; label: string; subtitle?: string }[] = [
  { status: 'working', label: 'Working' },
  { status: 'done', label: 'Settled' },
  { status: 'archived', label: 'Archived', subtitle: 'Leaves the list; nothing is deleted' },
]

/** Why the status rows are locked, or what the current one means when no row is it. */
function statusNote(th: Thread): string | undefined {
  if (th.status === 'waiting') return 'The agent needs you. Answer it or stop the run to change the status.'
  if (isBusy(th)) return 'The agent is working. Its run sets the status until it stops.'
  if (th.status === 'error' && !th.archived) return 'The last run failed. Pick a status to move on.'
  return undefined
}

/**
 * A chat's actions (the chat's "more" button, a long press on its row): rename, its status
 * (Working, Settled, Archived: picking Working or Settled brings an archived chat back), delete.
 * Deleting and archiving ask first unless Settings > Confirmations says otherwise; deleting also deletes it in the
 * environment, on every computer.
 */
export function ThreadActions({ threadId, visible, onClose, onDeleted, onLinks }: {
  threadId: string
  visible: boolean
  onClose: () => void
  onDeleted?: () => void
  /** Show the chat's pull requests and issues (where linking one by hand starts). */
  onLinks?: () => void
}) {
  const t = useTheme()
  const s = useStyles()
  const thread = useThreads(st => st.threads[threadId] ?? null)
  const [title, setTitle] = useState(thread?.title ?? '')
  // The question waiting for an answer, if any.
  const [armed, setArmed] = useState<'delete' | 'archive' | null>(null)

  useEffect(() => {
    if (!visible) return
    setTitle(useThreads.getState().byId(threadId)?.title ?? '')
    setArmed(null)
  }, [visible, threadId])

  if (!thread) return null
  const busy = isBusy(thread)
  const shown = displayStatus(thread)
  const changed = !!title.trim() && title.trim() !== thread.title

  const save = () => {
    if (!changed) return
    useThreads.getState().rename(threadId, title)
    haptic('success')
    onClose()
  }

  const archive = () => {
    useThreads.getState().archive(threadId)
    haptic('select')
    onClose()
  }

  const pick = (status: Pickable) => {
    if (status === shown) return onClose()
    if (status === 'archived') {
      if (usePrefs.getState().confirmArchive) { haptic('warning'); setArmed('archive'); return }
      return archive()
    }
    useThreads.getState().setStatus(threadId, status)
    haptic('select')
    onClose()
  }

  const remove = () => {
    onClose()
    onDeleted?.()
    useThreads.getState().remove(threadId)
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Chat">
      <View style={s.body}>
        <View style={s.rename}>
          <TextField
            label="Title"
            value={title}
            onChangeText={setTitle}
            onSubmitEditing={save}
            returnKeyType="done"
            style={s.flex}
          />
          <Button label="Save" size="sm" disabled={!changed} onPress={save} style={s.save} />
        </View>
        <ListSection title="Status" footer={statusNote(thread)}>
          {CHOICES.map(c => (
            <ListRow
              key={c.status}
              title={c.label}
              subtitle={c.subtitle}
              leading={<RipenessDot status={c.status} size={14} />}
              accessory={shown === c.status ? 'check' : 'none'}
              disabled={busy}
              onPress={() => pick(c.status)}
            />
          ))}
        </ListSection>
        {onLinks
          ? (
              <ListSection>
                <ListRow
                  title="Pull requests and issues"
                  detail={thread.links?.length ? String(thread.links.length) : undefined}
                  leading={<GitPullRequest size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                  onPress={onLinks}
                />
              </ListSection>
            )
          : null}
        <ListSection footer={busy ? 'A chat can be deleted once its agent has stopped.' : undefined}>
          <ListRow
            title="Delete"
            destructive
            leading={<Trash2 size={20} strokeWidth={1.75} color={t.colors.ripeErrorFg} />}
            accessory="none"
            disabled={busy}
            onPress={() => {
              if (!usePrefs.getState().confirmDelete) return remove()
              haptic('warning')
              setArmed('delete')
            }}
          />
        </ListSection>
        {armed === 'delete'
          ? (
              <ConfirmBox
                title={`Delete “${thread.title}”?`}
                message="It is deleted on this phone and in the environment, so every computer loses it. This can't be undone."
                actionLabel="Delete"
                onKeep={() => setArmed(null)}
                onConfirm={remove}
              />
            )
          : armed === 'archive'
            ? (
                <ConfirmBox
                  title={`Archive “${thread.title}”?`}
                  message="It leaves the list. Nothing is deleted: restore it from Settings > Archived chats."
                  keepLabel="Not now"
                  actionLabel="Archive"
                  danger={false}
                  onKeep={() => setArmed(null)}
                  onConfirm={archive}
                />
              )
            : null}
      </View>
    </Sheet>
  )
}

const useStyles = makeStyles(t => ({
  body: { gap: space[5] },
  flex: { flex: 1 },
  rename: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2] },
  save: { marginTop: 26, minHeight: 44 },
}))
