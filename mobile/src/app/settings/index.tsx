import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { labelOf, lookSummary, useAppearance } from '@/theme'
import { ListRow, ListSection } from '@/ui'
import { useEnvs } from '@/state/envs'
import { usePrefs } from '@/state/prefs'
import { modeLabel } from '@/state/prefsModel'
import { useThreads } from '@/state/threads'
import { languageLabel, useVoicePrefs } from '@/voice'
import { ScreenScroll } from '@/screens/Screen'
import { SETTINGS_GROUPS, settingsHref, type SettingsId } from '@/screens/settings/sections'
import { useTheme } from '@/theme'

const MODE_NAMES = { system: 'System', dark: 'Dark', light: 'Light' } as const

/**
 * Settings: the categories, grouped as on the desktop. Each row opens its own screen and says in a
 * word what is set there, so most of what you want to know needs no tap.
 */
export default function SettingsScreen() {
  const t = useTheme()
  const router = useRouter()
  const { appearance, look } = useAppearance()
  const prefs = usePrefs()
  const envCount = useEnvs(st => st.envs.length)
  const archived = useThreads(st => Object.values(st.threads).filter(c => c.archived && !c.parentId).length)
  const language = useVoicePrefs(st => st.language)
  useEffect(() => { void useVoicePrefs.getState().load() }, [])

  const asks = [prefs.confirmArchive ? 'Archive' : null, prefs.confirmDelete ? 'Delete' : null].filter(Boolean).join(', ')
  const detail: Partial<Record<SettingsId, string | undefined>> = {
    chats: modeLabel(prefs.defaultMode),
    confirmations: asks || 'None',
    appearance: `${MODE_NAMES[appearance]} · ${lookSummary(look)}`,
    notifications: prefs.notify.enabled ? 'On' : 'Off',
    voice: languageLabel(language),
    environments: envCount ? String(envCount) : undefined,
    archive: archived ? String(archived) : undefined,
    about: Constants.expoConfig?.version ?? undefined,
  }

  return (
    <ScreenScroll>
      {SETTINGS_GROUPS.map((group, i) => (
        <ListSection key={group.title ?? i} title={group.title}>
          {group.items.map(({ id, label, icon: Icon }) => (
            <ListRow
              key={id}
              title={label}
              leading={<Icon size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
              detail={detail[id]}
              onPress={() => router.push(settingsHref(id))}
            />
          ))}
        </ListSection>
      ))}
    </ScreenScroll>
  )
}
