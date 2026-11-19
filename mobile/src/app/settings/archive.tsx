import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { Archive, ArchiveRestore, MessageSquare, Trash2 } from 'lucide-react-native'
import type { Thread } from '~/types/chat'
import { space, useTheme } from '@/theme'
import { EmptyState, ListRow, ListSection, Sheet, haptic } from '@/ui'
import { useEnvs } from '@/state/envs'
import { usePrefs } from '@/state/prefs'
import { useThreads } from '@/state/threads'
import { ConfirmBox } from '@/screens/ConfirmBox'
import { SettingsPage } from '@/screens/settings/SettingsPage'
import { placeOf, projectName } from '@/screens/names'
import { shortAgo } from '@/chat/time'

/**
 * Archive: the chats put away, newest first. A chat leaves the list when archived and nothing is
 * deleted; here it can be restored (back to Working), opened, or deleted for good.
 */
export default function ArchiveScreen() {
  const t = useTheme()
  const router = useRouter()
  const threads = useThreads(st => st.threads)
  const envs = useEnvs(st => st.envs)
  const [picked, setPicked] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)

  const archived = useMemo(
    () => Object.values(threads).filter(c => c.archived && !c.parentId).sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  )
  const chat = picked ? threads[picked] ?? null : null
  const envFor = (c: Thread) => envs.find(e => c.projectPath.startsWith(`env://${e.id}/`)) ?? null

  const close = () => { setPicked(null); setArmed(false) }
  const restore = (c: Thread) => {
    useThreads.getState().unarchive(c.id)
    haptic('success')
    close()
  }
  const remove = (c: Thread) => {
    close()
    useThreads.getState().remove(c.id)
  }

  return (
    <SettingsPage id="archive">
      {archived.length
        ? (
            <ListSection footer="Tap a chat to restore, open or delete it. A restored chat goes back in the list.">
              {archived.map(c => (
                <ListRow
                  key={c.id}
                  title={c.title}
                  subtitle={`${projectName(c.projectPath)} · ${placeOf(c.projectPath, envFor(c))}`}
                  detail={shortAgo(c.updatedAt)}
                  leading={<MessageSquare size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                  onPress={() => setPicked(c.id)}
                />
              ))}
            </ListSection>
          )
        : (
            <EmptyState
              icon={Archive}
              title="Nothing archived"
              body="Archive a chat from its menu to clear it from the list without deleting it. It waits here until you want it back."
            />
          )}

      <Sheet visible={!!chat} onClose={close} title="Archived chat">
        {chat
          ? (
              <View style={{ gap: space[4] }}>
                <ListSection footer={chat.title}>
                  <ListRow
                    title="Restore"
                    subtitle="Back in the list"
                    leading={<ArchiveRestore size={20} strokeWidth={1.75} color={t.colors.accentInk} />}
                    accessory="none"
                    onPress={() => restore(chat)}
                  />
                  <ListRow
                    title="Open"
                    subtitle="Read it without restoring"
                    leading={<MessageSquare size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
                    onPress={() => { const id = chat.id; close(); router.push({ pathname: '/chat/[id]', params: { id } }) }}
                  />
                  <ListRow
                    title="Delete"
                    destructive
                    leading={<Trash2 size={20} strokeWidth={1.75} color={t.colors.ripeErrorFg} />}
                    accessory="none"
                    onPress={() => {
                      if (!usePrefs.getState().confirmDelete) return remove(chat)
                      haptic('warning')
                      setArmed(true)
                    }}
                  />
                </ListSection>
                {armed
                  ? (
                      <ConfirmBox
                        title={`Delete “${chat.title}”?`}
                        message="It is deleted on this phone and in the environment, so every computer loses it. This can't be undone."
                        actionLabel="Delete"
                        onKeep={() => setArmed(false)}
                        onConfirm={() => remove(chat)}
                      />
                    )
                  : null}
              </View>
            )
          : null}
      </Sheet>
    </SettingsPage>
  )
}
