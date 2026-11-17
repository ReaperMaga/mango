import type { VoiceEngine, VoiceHandlers } from './types'

/**
 * A stand-in recognizer for the web preview when the browser has none: it "hears" a short
 * request word by word, with a moving level, until stopped. The composer labels it "Simulated".
 */
const PHRASE = 'Add a short section to the README about running the tests'.split(' ')

export const simulatedEngine: VoiceEngine = {
  kind: 'simulated',
  levels: true,
  available: () => true,
  onDevice: () => false,
  permission: async () => 'granted',
  locales: async () => [],
  deviceLocales: () => ['en-US'],
  start(_locale: string, h: VoiceHandlers) {
    let words = 0
    let ended = false
    const level = setInterval(() => h.onLevel?.(words < PHRASE.length ? 0.25 + Math.random() * 0.6 : Math.random() * 0.1), 100)
    const tick = setInterval(() => {
      if (words < PHRASE.length) {
        words++
        h.onResult(false, PHRASE.slice(0, words).join(' '))
      }
    }, 260)
    const finish = (final: boolean) => {
      if (ended) return
      ended = true
      clearInterval(level)
      clearInterval(tick)
      setTimeout(() => {
        if (final && words) h.onResult(true, `${PHRASE.slice(0, words).join(' ')}.`)
        h.onEnd()
      }, final ? 350 : 0)
    }
    return { stop: () => finish(true), abort: () => finish(false) }
  },
}
