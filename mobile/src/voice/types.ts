/**
 * The speech recognizer as dictation sees it. `engine.native.ts` is Apple's (through
 * expo-speech-recognition), `engine.ts` the browser's for the web preview, with a simulated one
 * where the browser has none.
 */

export interface VoiceHandlers {
  /** A guess at the segment being spoken (`isFinal` false) or its finished text (true). */
  onResult: (isFinal: boolean, text: string) => void
  /** Input level, 0 to 1, about ten times a second. Only engines with `levels`. */
  onLevel?: (level: number) => void
  /** The recognizer's error code ('aborted', 'no-speech', 'not-allowed', …) and its message. */
  onError: (code: string, message: string) => void
  /** Always last, once per session, after a stop, an abort or an error. */
  onEnd: () => void
}

export interface VoiceSession {
  /** Stop listening and deliver the last final result, then end. */
  stop: () => void
  /** Stop at once; no further results. */
  abort: () => void
}

export type VoicePermission = 'granted' | 'denied' | 'restricted'

export interface VoiceEngine {
  /**
   * device: Apple's recognizer on the phone. browser: the Web Speech API in the preview. simulated:
   * a canned phrase where the browser has none. none: a native build without the module.
   */
  kind: 'device' | 'browser' | 'simulated' | 'none'
  /** Reports `onLevel`. */
  levels: boolean
  /** The recognizer can be used right now. */
  available: () => boolean
  /** Speech is turned into text on the device itself (for the phone's language at least). */
  onDevice: () => boolean
  /** Asks for the microphone and speech recognition the first time; afterwards reads the answer. */
  permission: () => Promise<VoicePermission>
  /** Locales the recognizer knows, as it spells them; empty when it does not say. */
  locales: () => Promise<string[]>
  /** The phone's (or browser's) preferred locales, in order. */
  deviceLocales: () => string[]
  start: (locale: string, handlers: VoiceHandlers) => VoiceSession
}

/**
 * Words agents and their users say that a general recognizer may not expect. iOS takes them as
 * hints (`contextualStrings`); they never force a word.
 */
export const CONTEXT_WORDS = ['Claude', 'Codex', 'Mango', 'commit', 'rebase', 'pull request', 'TypeScript', 'README', 'refactor', 'lint']
