import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { Pin, Search } from 'lucide-react-native'
import type { Message } from '~/types/chat'
import { makeStyles, space, useTheme } from '@/theme'
import { ListRow, ListSection, Sheet, Text, TextField } from '@/ui'
import { findMessages, pinnedMessages, type Found } from './find'

/** At most this many hits are listed; a longer list is a reason to type more. */
const MAX = 50

/**
 * Find in a chat (the desktop's find bar and message list): type to see the messages that say it, or
 * leave the field empty to see the pinned ones. A tap closes the sheet and jumps to that message.
 */
export function ChatFind({ visible, onClose, messages, onPick }: {
  visible: boolean
  onClose: () => void
  messages: readonly Message[]
  /** The message's position in the chat. */
  onPick: (index: number) => void
}) {
  const t = useTheme()
  const s = useStyles()
  const [query, setQuery] = useState('')
  useEffect(() => { if (visible) setQuery('') }, [visible])
  const pinned = useMemo(() => pinnedMessages(messages), [messages])
  const hits = useMemo(() => findMessages(messages, query), [messages, query])
  const searching = !!query.trim()
  const list: Found[] = searching ? hits.slice(0, MAX) : pinned

  return (
    <Sheet visible={visible} onClose={onClose} title="Find in chat">
      <View style={s.body}>
        <TextField label="Search" value={query} onChangeText={setQuery} autoFocus autoCorrect={false} returnKeyType="search" placeholder="Words in a message" />
        {list.length
          ? (
              <ListSection
                title={searching ? `${hits.length} message${hits.length === 1 ? '' : 's'}` : 'Pinned'}
                footer={searching && hits.length > MAX ? `Showing the first ${MAX}. Type more to narrow it down.` : undefined}
              >
                {list.map(h => (
                  <ListRow
                    key={h.message.id}
                    title={h.message.role === 'user' ? 'You' : 'Agent'}
                    subtitle={h.snippet}
                    subtitleLines={2}
                    leading={h.message.pinned ? <Pin size={18} strokeWidth={1.85} color={t.colors.accentInk} /> : <Search size={18} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                    accessory="none"
                    onPress={() => onPick(h.index)}
                  />
                ))}
              </ListSection>
            )
          : (
              <Text variant="bodySm" tone="subtle">
                {searching ? 'No message says that.' : 'Nothing is pinned yet. Pin a message from its ••• menu to find it here.'}
              </Text>
            )}
      </View>
    </Sheet>
  )
}

const useStyles = makeStyles(() => ({
  body: { gap: space[4] },
}))
