import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { haptic } from '@/ui/haptics'
import { engine } from './engine'
import { useVoicePrefs } from './prefs'
import { hear, insertAt, languageLabel, noticeFor, NOTHING_HEARD, pickLocale, problemOf, spoken, type Heard, type Selection, type VoiceNotice, type VoiceProblem } from './transcript'
import type { VoiceSession } from './types'

/**
 * Dictation into a draft: tap to start, the words appear in the draft as they are heard (at the
 * caret, else after the text), tap to stop. With "Send after dictation" on, the message goes as
 * soon as the recognizer has finished. One dictation runs at a time, app-wide.
 */

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'stopping'

/** The dictation running anywhere in the app, so the lifecycle can end it. */
let active: { end: () => void } | null = null

/**
 * End any dictation at once, keeping what is already in the draft and never sending: the app is
 * going to the background, where iOS takes the microphone away (and the chats are saved next).
 */
export function stopDictation(): void {
  active?.end()
}

const DEVICE = Platform.OS === 'web' ? 'browser' : 'iPhone'

/** One dictation, from tap to end. */
interface Run {
  session: VoiceSession | null
  base: string
  sel: Selection | null
  heard: Heard
  text: string
  problem: VoiceProblem | null
  discard: boolean
  send: boolean
  /** Clears the clock and the stop timeout. */
  cleanups: Array<() => void>
}

export interface DictationOptions {
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => void
  /** Where the caret is in the draft (from the input's `onSelectionChange`). */
  selection: () => Selection | null
}

export function useDictation(opts: DictationOptions) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [notice, setNotice] = useState<VoiceNotice | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const run = useRef<Run | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    void useVoicePrefs.getState().load()
    mounted.current = true
    return () => {
      mounted.current = false
      const r = run.current
      if (r) {
        r.send = false
        r.session?.abort()
      }
    }
  }, [])

  /** The language as the person would name it: the chosen one, else "your language". */
  const language = () => {
    const code = useVoicePrefs.getState().language
    return code === null ? `this ${DEVICE}'s language` : languageLabel(code)
  }
  const tell = (p: VoiceProblem, detail?: string) => {
    if (mounted.current) setNotice(noticeFor(p, { language: language(), device: DEVICE, detail }))
  }

  const finish = useCallback(() => {
    const r = run.current
    if (!r) return
    run.current = null
    active = null
    r.cleanups.forEach(c => c())
    if (!mounted.current) return
    setPhase('idle')
    setLevel(0)
    if (r.discard) return
    const said = spoken(r.heard)
    const failed = r.problem && r.problem !== 'no-speech'
    // 'other' was told with the recognizer's own message when it came.
    if (failed && r.problem !== 'other') tell(r.problem!)
    else if (!failed && !said) tell('no-speech')
    if (said && r.send && !failed) {
      haptic('light')
      latest.current.onSend(r.text)
    }
  }, [])

  const stop = useCallback(() => {
    const r = run.current
    if (!r?.session) return
    haptic('light')
    setPhase('stopping')
    r.session.stop()
    // The recognizer ends on its own after a stop; if it does not, end it.
    const late = setTimeout(() => {
      if (run.current === r) {
        r.session?.abort()
        finish()
      }
    }, 4000)
    r.cleanups.push(() => clearTimeout(late))
  }, [finish])

  const start = useCallback(async () => {
    if (run.current) return
    setNotice(null)
    haptic('light')
    setPhase('starting')
    const r: Run = {
      session: null,
      base: latest.current.value,
      sel: latest.current.selection(),
      heard: NOTHING_HEARD,
      text: latest.current.value,
      problem: null,
      discard: false,
      send: false,
      cleanups: [],
    }
    run.current = r
    const bail = (p: VoiceProblem) => {
      run.current = null
      if (!mounted.current) return
      setPhase('idle')
      tell(p)
      haptic('warning')
    }
    try {
      const prefs = useVoicePrefs.getState()
      await prefs.load()
      if (engine.kind === 'none') return bail('no-module')
      if (!engine.available()) return bail('unavailable')
      const allowed = await engine.permission()
      if (allowed !== 'granted') return bail(allowed === 'restricted' ? 'restricted' : 'denied')
      const { language, sendAfter } = useVoicePrefs.getState()
      const locale = pickLocale(language, engine.deviceLocales(), await engine.locales())
      if (!locale) return bail('language')
      // Discarded or unmounted while asking.
      if (run.current !== r || !mounted.current) return
      r.send = sendAfter
      r.session = engine.start(locale, {
        onResult(isFinal, text) {
          if (run.current !== r || r.discard) return
          r.heard = hear(r.heard, isFinal, text)
          r.text = insertAt(r.base, r.sel, spoken(r.heard)).text
          latest.current.onChangeText(r.text)
        },
        onLevel(l) {
          if (run.current === r && mounted.current) setLevel(l)
        },
        onError(code, message) {
          const p = problemOf(code)
          if (p && !r.problem) r.problem = p
          if (p === 'other' && mounted.current) tell('other', message)
        },
        onEnd: () => finish(),
      })
      if (run.current !== r) return
      active = { end: () => settleRef.current() }
      setSeconds(0)
      const began = Date.now()
      const clockTimer = setInterval(() => { if (mounted.current) setSeconds(Math.floor((Date.now() - began) / 1000)) }, 500)
      r.cleanups.push(() => clearInterval(clockTimer))
      setPhase(p => (p === 'starting' ? 'listening' : p))
    } catch (e) {
      if (run.current === r) {
        run.current = null
        if (mounted.current) {
          setPhase('idle')
          tell('other', e instanceof Error ? e.message : String(e))
        }
      }
    }
  }, [finish, stop])

  /** Throw away this dictation: the draft goes back to what it was before. */
  const discard = useCallback(() => {
    const r = run.current
    if (!r) return
    r.discard = true
    haptic('select')
    latest.current.onChangeText(r.base)
    if (r.session) r.session.abort()
    else {
      run.current = null
      setPhase('idle')
    }
    finish()
  }, [finish])

  /** End the dictation now, keeping what is in the draft, without sending (the caller sends). */
  const settle = useCallback(() => {
    const r = run.current
    if (!r) return
    r.send = false
    r.discard = true // nothing more to report
    r.session?.abort()
    if (!r.session) {
      run.current = null
      setPhase('idle')
    }
    finish()
  }, [finish])

  const settleRef = useRef(settle)
  settleRef.current = settle

  const toggle = useCallback(() => {
    if (phase === 'idle') void start()
    else if (phase === 'listening') stop()
  }, [phase, start, stop])

  return {
    phase,
    /** Listening or about to: the draft belongs to the dictation. */
    busy: phase !== 'idle',
    seconds,
    level,
    notice,
    clearNotice: () => setNotice(null),
    /** What kind of recognizer: the composer labels a simulated one. */
    kind: engine.kind,
    levels: engine.levels,
    toggle,
    discard,
    settle,
  }
}
