import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Trash2 } from 'lucide-react-native'
import { displayStatus, type Thread } from '~/types/chat'
import { isBusy } from '@/state/threadModel'
import { makeStyles, radius, space, useTheme } from '@/theme'
import { Button, ButtonRow, ListRow, ListSection, RipenessDot, Sheet, Text, TextField, haptic } from '@/ui'
import { useThreads } from '@/state/threads'

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
 * Deleting asks twice, and also deletes it in the environment, on every computer.
 */
export function ThreadActions({ threadId, visible, onClose, onDeleted }: {
  threadId: string
  visible: boolean
  onClose: () => void
  onDeleted?: () => void
}) {
  const t = useTheme()
  const s = useStyles()
  const thread = useThreads(st => st.threads[threadId] ?? null)
  const [title, setTitle] = useState(thread?.title ?? '')
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!visible) return
    setTitle(useThreads.getState().byId(threadId)?.title ?? '')
    setArmed(false)
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

  const pick = (status: Pickable) => {
    if (status !== shown) {
      const store = useThreads.getState()
      if (status === 'archived') store.archive(threadId)
      else store.setStatus(threadId, status)
      haptic('select')
    }
    onClose()
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
        <ListSection footer={busy ? 'A chat can be deleted once its agent has stopped.' : undefined}>
          <ListRow
            title="Delete"
            destructive
            leading={<Trash2 size={20} strokeWidth={1.75} color={t.colors.ripeErrorFg} />}
            accessory="none"
            disabled={busy}
            onPress={() => { haptic('warning'); setArmed(true) }}
          />
        </ListSection>
        {armed
          ? (
              <View style={s.confirm} accessibilityLiveRegion="polite">
                <Text variant="label" tone="error">Delete “{thread.title}”?</Text>
                <Text variant="bodySm" tone="muted">It is deleted on this phone and in the environment, so every computer loses it. This can't be undone.</Text>
                <ButtonRow>
                  <Button label="Keep it" variant="ghost" size="sm" onPress={() => setArmed(false)} />
                  <Button
                    label="Delete"
                    variant="danger"
                    size="sm"
                    onPress={() => {
                      onClose()
                      onDeleted?.()
                      useThreads.getState().remove(threadId)
                    }}
                  />
                </ButtonRow>
              </View>
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
  confirm: { gap: space[2], padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: t.colors.errorLine, backgroundColor: t.colors.errorWash },
}))
