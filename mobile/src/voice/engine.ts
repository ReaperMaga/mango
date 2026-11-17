import { simulatedEngine } from './simulated'
import type { VoiceEngine, VoiceHandlers } from './types'

/**
 * The web preview's recognizer: the browser's Web Speech API where it has one, otherwise a
 * simulated dictation (labelled so), like the preview's simulated agents. The phone uses
 * `engine.native.ts`.
 *
 * Note: browsers' recognizers (Chrome's, Safari's) may send the audio to their maker's servers.
 * That is the preview only; the iPhone requires on-device recognition.
 */

/** The parts of the Web Speech API this uses (not in TypeScript's DOM lib everywhere). */
interface WebRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string; message?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type WebRecognitionClass = new () => WebRecognition

function webClass(): WebRecognitionClass | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: WebRecognitionClass; webkitSpeechRecognition?: WebRecognitionClass }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function browserLocales(): string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? [...navigator.languages] : navigator.language ? [navigator.language] : []
}

const browserEngine: VoiceEngine = {
  kind: 'browser',
  levels: false,
  available: () => !!webClass(),
  onDevice: () => false,
  // The browser asks for the microphone itself when recognition starts.
  permission: async () => 'granted',
  locales: async () => [],
  deviceLocales: browserLocales,
  start(locale: string, h: VoiceHandlers) {
    const Rec = webClass()
    if (!Rec) throw new Error('This browser has no speech recognition.')
    const r = new Rec()
    r.lang = locale
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    let ended = false
    r.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        const text = res?.[0]?.transcript ?? ''
        if (res?.isFinal) h.onResult(true, text)
        else interim += text
      }
      if (interim) h.onResult(false, interim)
    }
    r.onerror = e => h.onError(e.error, e.message ?? '')
    r.onend = () => {
      if (ended) return
      ended = true
      h.onEnd()
    }
    try {
      r.start()
    } catch (e) {
      h.onError('other', e instanceof Error ? e.message : String(e))
      ended = true
      h.onEnd()
    }
    return { stop: () => r.stop(), abort: () => r.abort() }
  },
}

/** Decided when dictation starts, so a browser without the API (or a test that removes it) falls back. */
export const engine: VoiceEngine = new Proxy(browserEngine, {
  get(target, key: keyof VoiceEngine) {
    return (webClass() ? target : simulatedEngine)[key]
  },
})
