import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import type { NotifyPrefs } from '~/utils/notifications'
import { DEFAULT_PREFS, normalizePrefs, type AppPrefs } from './prefsModel'

/** Settings that shape chats and notifications, kept in AsyncStorage like the appearance choice. */
const STORAGE_KEY = 'mango.prefs'

interface PrefsState extends AppPrefs {
  loaded: boolean
  load: () => Promise<void>
  set: <K extends keyof AppPrefs>(key: K, value: AppPrefs[K]) => void
  setNotify: <K extends keyof NotifyPrefs>(key: K, value: NotifyPrefs[K]) => void
}

let loading: Promise<void> | null = null

export const usePrefs = create<PrefsState>()((set, get) => {
  const save = () => {
    const { loaded: _l, load: _a, set: _b, setNotify: _c, ...prefs } = get()
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)).catch(() => { /* kept for this session only */ })
  }
  return {
    ...DEFAULT_PREFS,
    loaded: false,
    load() {
      loading ??= AsyncStorage.getItem(STORAGE_KEY)
        .then((raw) => {
          let saved: unknown = null
          try { saved = raw ? JSON.parse(raw) : null } catch { /* unreadable: start from the defaults */ }
          const p = normalizePrefs(saved)
          set({ ...p, loaded: true })
        })
        .catch(() => set({ loaded: true }))
      return loading
    },
    set(key, value) {
      set({ [key]: value } as Partial<PrefsState>)
      save()
    },
    setNotify(key, value) {
      set({ notify: { ...get().notify, [key]: value } })
      save()
    },
  }
})
