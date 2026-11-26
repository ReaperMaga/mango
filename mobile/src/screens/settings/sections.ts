import type { ComponentType } from 'react'
import type { Href } from 'expo-router'
import { Archive, Bell, Bot, Info, ListChecks, MessageSquare, Mic, Server, SunMoon, type LucideProps } from 'lucide-react-native'

/**
 * The settings categories, as the desktop groups them (General, Technical, then the rest): the
 * Settings screen lists them, each opens its own screen, and the tab strip on every one of those
 * screens jumps between them.
 */
export type SettingsId = 'chats' | 'confirmations' | 'appearance' | 'notifications' | 'voice' | 'environments' | 'agents' | 'archive' | 'about'

export interface SettingsSection {
  id: SettingsId
  label: string
  icon: ComponentType<LucideProps>
}

const S: Record<SettingsId, SettingsSection> = {
  chats: { id: 'chats', label: 'Chats', icon: MessageSquare },
  confirmations: { id: 'confirmations', label: 'Confirmations', icon: ListChecks },
  appearance: { id: 'appearance', label: 'Appearance', icon: SunMoon },
  notifications: { id: 'notifications', label: 'Notifications', icon: Bell },
  voice: { id: 'voice', label: 'Voice', icon: Mic },
  environments: { id: 'environments', label: 'Environments', icon: Server },
  agents: { id: 'agents', label: 'Agents', icon: Bot },
  archive: { id: 'archive', label: 'Archive', icon: Archive },
  about: { id: 'about', label: 'About', icon: Info },
}

export const SETTINGS_GROUPS: ReadonlyArray<{ title?: string; items: readonly SettingsSection[] }> = [
  { title: 'General', items: [S.chats, S.confirmations, S.appearance, S.notifications, S.voice] },
  { title: 'Technical', items: [S.environments, S.agents] },
  { items: [S.archive, S.about] },
]

/** Every category in the order of the list: the tab strip's order. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap(g => g.items)

/** Where a category lives (`src/app/settings/<id>.tsx`). */
export const settingsHref = (id: SettingsId): Href => `/settings/${id}` as Href
