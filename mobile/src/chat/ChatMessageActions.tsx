import { useEffect, useState } from 'react'
import { View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Copy, GitBranch, Pencil, Pin, PinOff, RefreshCw } from 'lucide-react-native'
import { makeStyles, space, useTheme } from '@/theme'
import { Button, ButtonRow, ListRow, ListSection, Sheet, Text, TextField, haptic } from '@/ui'
import { ConfirmBox } from '@/screens/ConfirmBox'
import { isBusy, useThreads } from '@/state/threads'
import { plainText } from './find'

/**
 * What can be done with one message (the desktop's buttons under it): copy it, pin it, edit one of
 * yours and send it again, ask again for an answer, branch a new chat from it. Edit, ask again and
 * branch hand the earlier messages to a fresh agent session as text, as on the desktop.
 */
export function ChatMessageActions({ threadId, messageId, onClose, onBranched }: {
  threadId: string
  /** The message in question; null keeps the sheet away. */
  messageId: string | null
  onClose: () => void
  /** A branch was made: the new chat's id. */
  onBranched: (id: string) => void
}) {
  const t = useTheme()
  const s = useStyles()
  const thread = useThreads(st => st.threads[threadId] ?? null)
  const message = thread?.messages.find(m => m.id === messageId) ?? null
  const [mode, setMode] = useState<'menu' | 'edit' | 'again'>('menu')
  const [draft, setDraft] = useState('')

  useEffect(() => { setMode('menu'); setDraft(message ? plainText(message) : '') }, [messageId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!thread || !message) return <Sheet visible={false} onClose={onClose}>{null}</Sheet>
  const store = useThreads.getState()
  const busy = isBusy(thread)
  /** A sub-agent's chat is written by its parent's run only: nothing to edit or ask again there. */
  const writable = !thread.parentId && !message.fromAgent
  const cuts = store.cutCount(threadId, message.id)
  const text = plainText(message)
  const user = message.role === 'user'
  const icon = (Icon: typeof Copy) => <Icon size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />

  const saveEdit = () => {
    if (!draft.trim() && !message.attachments?.length) return
    haptic('success')
    onClose()
    void store.editMessage(threadId, message.id, draft)
  }
  const again = () => {
    haptic('select')
    onClose()
    void store.regenerate(threadId, message.id)
  }

  return (
    <Sheet visible onClose={onClose} title={mode === 'edit' ? 'Edit message' : 'Message'}>
      {mode === 'edit'
        ? (
            <View style={s.body}>
              <TextField label="Message" value={draft} onChangeText={setDraft} multiline autoFocus style={s.field} />
              <Text variant="caption" tone="subtle">
                {cuts > 1 ? `Sending replaces this message and the ${cuts - 1} after it.` : 'Sending runs it again.'}
              </Text>
              <ButtonRow>
                <Button label="Cancel" variant="ghost" onPress={() => setMode('menu')} />
                <Button label="Send again" disabled={!draft.trim() && !message.attachments?.length} onPress={saveEdit} />
              </ButtonRow>
            </View>
          )
        : (
            <View style={s.body}>
              <ListSection>
                {text
                  ? (
                      <ListRow
                        title="Copy"
                        leading={icon(Copy)}
                        accessory="none"
                        onPress={() => { void Clipboard.setStringAsync(text).then(() => haptic('success')); onClose() }}
                      />
                    )
                  : null}
                {writable
                  ? (
                      <ListRow
                        title={message.pinned ? 'Unpin' : 'Pin'}
                        subtitle="Pinned messages are listed first when you search the chat"
                        leading={icon(message.pinned ? PinOff : Pin)}
                        accessory="none"
                        onPress={() => { haptic('select'); store.togglePin(threadId, message.id); onClose() }}
                      />
                    )
                  : null}
                {writable && user
                  ? <ListRow title="Edit and send again" leading={icon(Pencil)} accessory="none" disabled={busy} onPress={() => setMode('edit')} />
                  : null}
                {writable && !user
                  ? (
                      <ListRow
                        title="Ask again"
                        subtitle={cuts > 1 ? `Removes ${cuts - 1} later message${cuts - 1 === 1 ? '' : 's'}` : undefined}
                        leading={icon(RefreshCw)}
                        accessory="none"
                        disabled={busy}
                        onPress={() => { if (cuts > 2) { haptic('warning'); setMode('again') } else again() }}
                      />
                    )
                  : null}
                {writable
                  ? (
                      <ListRow
                        title="Branch into a new chat from here"
                        leading={icon(GitBranch)}
                        accessory="none"
                        onPress={() => {
                          const made = store.branchFrom(threadId, message.id)
                          if (!made) return
                          haptic('success')
                          onClose()
                          onBranched(made.id)
                        }}
                      />
                    )
                  : null}
              </ListSection>
              {busy && writable ? <Text variant="caption" tone="subtle">Editing and asking again wait until the agent has stopped.</Text> : null}
              {mode === 'again'
                ? (
                    <ConfirmBox
                      title="Ask again?"
                      message={`The answer and the ${cuts - 1} message${cuts - 1 === 1 ? '' : 's'} after it are removed, and the question before it runs once more.`}
                      keepLabel="Not now"
                      actionLabel="Ask again"
                      onKeep={() => setMode('menu')}
                      onConfirm={again}
                    />
                  )
                : null}
            </View>
          )}
    </Sheet>
  )
}

const useStyles = makeStyles(() => ({
  body: { gap: space[4] },
  field: { minHeight: 96 },
}))
