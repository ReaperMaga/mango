import { defineStore } from 'pinia'
import type { Transcript, VoiceModel, VoiceModelId, VoiceProgress } from '~/types/ipc'
import { call, on } from '~/composables/useBackend'
import { t } from '~/i18n'

/**
 * Voice input: which Whisper model to use, its download, and transcription.
 * Speech is turned into text on this computer (src-tauri/src/voice.rs); the
 * model is fetched once from Hugging Face. Recording lives in `useDictation`.
 */

const KEY = 'mango.voice'

/** Languages offered in Settings. Whisper knows ~100; these are the common ones, null detects it. Named in `agents.voice.languages`. */
export const VOICE_LANGUAGES: Array<string | null> = [
  null, 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'uk', 'ru', 'tr', 'sv', 'ja', 'zh', 'ko', 'hi',
]

const MODEL_IDS: VoiceModelId[] = ['tiny', 'base', 'small']

interface Prefs { model?: VoiceModelId; language?: string | null; micId?: string | null; sendAfter?: boolean }
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
    return {
      model: MODEL_IDS.includes(p.model) ? p.model : undefined,
      language: VOICE_LANGUAGES.includes(p.language) ? p.language : null,
      micId: typeof p.micId === 'string' ? p.micId : null,
      sendAfter: p.sendAfter === true,
    }
  } catch { return {} }
}

/** Tauri rejects with the backend's message; a thrown Error stringifies as "Error: …". */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

let unlisten: (() => void) | undefined

export const useVoice = defineStore('voice', {
  state: () => {
    const prefs = loadPrefs()
    return {
      models: [] as VoiceModel[],
      loaded: false,
      /** The model dictation uses. */
      model: (prefs.model ?? 'base') as VoiceModelId,
      language: (prefs.language ?? null) as string | null,
      /** Chosen input device (`MediaDeviceInfo.deviceId`); null follows the system default. */
      micId: (prefs.micId ?? null) as string | null,
      /** Send the message as soon as the transcript is in, instead of leaving it to edit. */
      sendAfter: prefs.sendAfter ?? false,
      mics: [] as Array<{ id: string; label: string }>,
      progress: {} as Partial<Record<VoiceModelId, VoiceProgress>>,
      /** Last download or delete error, per model. */
      errors: {} as Partial<Record<VoiceModelId, string>>,
    }
  },

  getters: {
    current: (s): VoiceModel | null => s.models.find(m => m.id === s.model) ?? null,
    /** The chosen model is on disk, so dictation can start right away. */
    ready(): boolean { return !!this.current?.downloaded },
    fraction: s => (id: VoiceModelId): number | null => {
      const p = s.progress[id]
      return p && p.total ? Math.min(1, p.downloaded / p.total) : null
    },
  },

  actions: {
    persist() {
      try {
        localStorage.setItem(KEY, JSON.stringify({ model: this.model, language: this.language, micId: this.micId, sendAfter: this.sendAfter }))
      } catch { /* not persisted */ }
    },

    /** Microphones the system offers. Names appear once Mango has been allowed to record. */
    async loadMics() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        this.mics = devices
          .filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => ({ id: d.deviceId, label: d.label || t('agents.voice.micNumber', { n: i + 1 }) }))
      } catch {
        this.mics = []
      }
    },

    setMic(id: string | null) {
      this.micId = id
      this.persist()
    },

    setSendAfter(on: boolean) {
      this.sendAfter = on
      this.persist()
    },

    async refresh() {
      try {
        this.models = await call('voice_models')
        this.loaded = true
      } catch { /* keeps the last list */ }
    },

    /** Loads the list once; cheap to call from anything that needs `ready`. */
    async ensureLoaded() {
      if (!this.loaded) await this.refresh()
    },

    setModel(id: VoiceModelId) {
      this.model = id
      this.persist()
    },

    setLanguage(code: string | null) {
      this.language = code
      this.persist()
    },

    async download(id: VoiceModelId) {
      const m = this.models.find(x => x.id === id)
      if (!m || m.downloading) return
      m.downloading = true
      delete this.errors[id]
      this.progress[id] = { model: id, downloaded: 0, total: m.sizeBytes }
      unlisten ??= await on('voice://progress', p => { this.progress[p.model] = p })
      try {
        await call('voice_download', { model: id })
      } catch (e) {
        const text = message(e)
        if (!/cancelled/i.test(text)) this.errors[id] = text
      } finally {
        delete this.progress[id]
        await this.refresh()
      }
    },

    async cancel(id: VoiceModelId) {
      await call('voice_download_cancel', { model: id }).catch(() => {})
    },

    async remove(id: VoiceModelId) {
      delete this.errors[id]
      try {
        await call('voice_delete', { model: id })
      } catch (e) {
        this.errors[id] = message(e)
      }
      await this.refresh()
    },

    /** `pcm` is 16 kHz mono 16-bit audio. Rejects with a message a person can act on. */
    async transcribe(pcm: Int16Array): Promise<Transcript> {
      return call('voice_transcribe', { model: this.model, audio: toBase64(pcm), language: this.language })
    },
  },
})

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let bin = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(bin)
}
