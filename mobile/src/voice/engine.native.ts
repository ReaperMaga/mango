import { requireOptionalNativeModule, type EventSubscription } from 'expo'
import type { ExpoSpeechRecognitionModuleType } from 'expo-speech-recognition/build/ExpoSpeechRecognitionModule.types'
import { CONTEXT_WORDS, type VoiceEngine, type VoiceHandlers, type VoicePermission } from './types'

/**
 * Apple's speech recognizer (SFSpeechRecognizer) through expo-speech-recognition. On-device
 * recognition is required wherever the recognizer offers it for the language; audio never goes to
 * a third party. Loaded optionally, so a build made before the module was added still runs (and
 * says why it cannot dictate) instead of crashing on import.
 */
const mod = requireOptionalNativeModule<ExpoSpeechRecognitionModuleType>('ExpoSpeechRecognition')

function deviceLocales(): string[] {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale
    return tag ? [tag] : []
  } catch {
    return []
  }
}

export const engine: VoiceEngine = {
  kind: mod ? 'device' : 'none',
  levels: true,

  available: () => {
    try { return !!mod?.isRecognitionAvailable() } catch { return false }
  },

  onDevice: () => {
    try { return !!mod?.supportsOnDeviceRecognition() } catch { return false }
  },

  async permission(): Promise<VoicePermission> {
    if (!mod) return 'denied'
    const r = await mod.requestPermissionsAsync()
    if (r.granted) return 'granted'
    return r.restricted ? 'restricted' : 'denied'
  },

  async locales() {
    if (!mod) return []
    try { return (await mod.getSupportedLocales({})).locales } catch { return [] }
  },

  deviceLocales,

  start(locale: string, h: VoiceHandlers) {
    if (!mod) throw new Error('No speech recognition module in this build.')
    const subs: EventSubscription[] = []
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      subs.forEach(s => s.remove())
      h.onEnd()
    }
    subs.push(
      mod.addListener('result', (e) => {
        const text = e.results[0]?.transcript ?? ''
        if (!ended) h.onResult(e.isFinal, text)
      }),
      mod.addListener('error', e => { if (!ended) h.onError(e.error, e.message) }),
      mod.addListener('volumechange', (e) => {
        // -2 to 10, below 0 is silence.
        if (!ended) h.onLevel?.(Math.max(0, Math.min(1, e.value / 10)))
      }),
      mod.addListener('end', end),
    )
    try {
      mod.start({
        lang: locale,
        interimResults: true,
        continuous: true,
        requiresOnDeviceRecognition: true,
        addsPunctuation: true,
        maxAlternatives: 1,
        iosTaskHint: 'dictation',
        contextualStrings: CONTEXT_WORDS,
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
      })
    } catch (e) {
      h.onError('other', e instanceof Error ? e.message : String(e))
      end()
    }
    return {
      stop: () => { try { mod.stop() } catch { end() } },
      abort: () => { try { mod.abort() } catch { /* ends below */ } end() },
    }
  },
}
