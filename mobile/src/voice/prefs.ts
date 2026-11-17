import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { DEFAULT_PREFS, normalizePrefs, type VoicePrefs } from './transcript'

/** Voice preferences (Settings > Voice), kept in AsyncStorage like the appearance choice. */
const STORAGE_KEY = 'mango.voice'

interface VoicePrefsState extends VoicePrefs {
  loaded: boolean
  load: () => Promise<void>
  setLanguage: (code: string | null) => void
  setSendAfter: (on: boolean) => void
}

let loading: Promise<void> | null = null

export const useVoicePrefs = create<VoicePrefsState>()((set, get) => {
  const save = () => {
    const { language, sendAfter } = get()
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ language, sendAfter })).catch(() => { /* kept for this session only */ })
  }
  return {
    ...DEFAULT_PREFS,
    loaded: false,
    load() {
      loading ??= AsyncStorage.getItem(STORAGE_KEY)
        .then(raw => set({ ...normalizePrefs(raw ? JSON.parse(raw) : null), loaded: true }))
        .catch(() => set({ loaded: true }))
      return loading
    },
    setLanguage(code) {
      set({ language: code })
      save()
    },
    setSendAfter(on) {
      set({ sendAfter: on })
      save()
    },
  }
})
