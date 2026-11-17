import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react-native'
import { isBusy } from '@/state/threadModel'
import { makeStyles, radius, space, useTheme } from '@/theme'
import { Button, ButtonRow, ListRow, ListSection, Sheet, Text, TextField, haptic } from '@/ui'
import { useThreads } from '@/state/threads'

/**
 * A chat's actions (the chat's "more" button, a long press on its row): rename, archive or bring
 * back, delete. Deleting asks twice, and also deletes it in the environment, on every computer.
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
  const changed = !!title.trim() && title.trim() !== thread.title

  const save = () => {
    if (!changed) return
    useThreads.getState().rename(threadId, title)
    haptic('success')
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
        <ListSection footer={busy ? 'A chat can be put away once its agent has stopped.' : undefined}>
          {thread.archived
            ? (
                <ListRow
                  title="Bring back"
                  leading={<ArchiveRestore size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                  accessory="none"
                  onPress={() => { useThreads.getState().unarchive(threadId); onClose() }}
                />
              )
            : (
                <ListRow
                  title="Archive"
                  subtitle="Leaves the list; nothing is deleted"
                  leading={<Archive size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                  accessory="none"
                  disabled={busy}
                  onPress={() => { useThreads.getState().archive(threadId); haptic('light'); onClose() }}
                />
              )}
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
