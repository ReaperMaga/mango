/**
 * Dictation's pure parts: piling up what the recognizer hears, putting it into the draft, picking
 * the recognizer's locale, the saved preferences, and what each failure tells the person. No React,
 * no native modules: unit-tested in plain Node.
 */

/* ---------- what was heard ---------- */

/**
 * The recognizer reports a dictation in segments: interim guesses for the segment being spoken
 * (each replacing the last), then a final result for it, and the next segment starts fresh. This is
 * the same on iOS (continuous mode) and the Web Speech API.
 */
export interface Heard {
  /** Every finished segment, joined. */
  final: string
  /** The segment still being spoken: the latest guess. */
  interim: string
}

export const NOTHING_HEARD: Heard = { final: '', interim: '' }

export function hear(prev: Heard, isFinal: boolean, text: string): Heard {
  return isFinal
    ? { final: joinWords(prev.final, text), interim: '' }
    : { final: prev.final, interim: text.trim() }
}

/** All of it so far, finished segments and the guess at the current one. */
export function spoken(h: Heard): string {
  return joinWords(h.final, h.interim)
}

/** Scripts written without spaces between words: Chinese, Japanese, Korean full-width forms. */
const UNSPACED = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/

/** Two runs of text with one space between them (none for scripts that use none). */
export function joinWords(a: string, b: string): string {
  const left = a.trim()
  const right = b.trim()
  if (!left || !right) return left || right
  return left + (needsSpace(left, right) ? ' ' : '') + right
}

function needsSpace(before: string, after: string): boolean {
  return !(UNSPACED.test(before.slice(-1)) || UNSPACED.test(after.charAt(0)))
}

/* ---------- into the draft ---------- */

export interface Selection { start: number; end: number }

/**
 * The draft with `words` put where the caret was (replacing a selection), with a space on either
 * side where one is needed, as the desktop's composer does. No caret known: after the text.
 * Returns the new text and where the caret goes (just after the words).
 */
export function insertAt(draft: string, selection: Selection | null | undefined, words: string): { text: string; caret: number } {
  const at = clampSelection(draft, selection)
  const said = words.trim()
  if (!said) return { text: draft, caret: at.end }
  const before = draft.slice(0, at.start)
  const after = draft.slice(at.end)
  const lead = before && !/\s$/.test(before) && needsSpace(before, said) ? ' ' : ''
  const trail = after && !/^\s/.test(after) && needsSpace(said, after) ? ' ' : ''
  const head = before + lead + said + trail
  return { text: head + after, caret: head.length }
}

function clampSelection(draft: string, sel: Selection | null | undefined): Selection {
  if (!sel) return { start: draft.length, end: draft.length }
  const a = Math.max(0, Math.min(draft.length, Math.floor(sel.start)))
  const b = Math.max(0, Math.min(draft.length, Math.floor(sel.end)))
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/* ---------- languages ---------- */

/**
 * Languages offered in Settings: the desktop's list (`app/stores/voice.ts`). iOS recognizes one
 * language at a time and cannot detect it, so "Detect automatically" becomes the phone's own
 * language (null).
 */
export const VOICE_LANGUAGES: ReadonlyArray<{ code: string; label: string; region: string }> = [
  { code: 'en', label: 'English', region: 'en-US' },
  { code: 'de', label: 'German', region: 'de-DE' },
  { code: 'fr', label: 'French', region: 'fr-FR' },
  { code: 'es', label: 'Spanish', region: 'es-ES' },
  { code: 'it', label: 'Italian', region: 'it-IT' },
  { code: 'pt', label: 'Portuguese', region: 'pt-BR' },
  { code: 'nl', label: 'Dutch', region: 'nl-NL' },
  { code: 'pl', label: 'Polish', region: 'pl-PL' },
  { code: 'uk', label: 'Ukrainian', region: 'uk-UA' },
  { code: 'ru', label: 'Russian', region: 'ru-RU' },
  { code: 'tr', label: 'Turkish', region: 'tr-TR' },
  { code: 'sv', label: 'Swedish', region: 'sv-SE' },
  { code: 'ja', label: 'Japanese', region: 'ja-JP' },
  { code: 'zh', label: 'Chinese', region: 'zh-CN' },
  { code: 'ko', label: 'Korean', region: 'ko-KR' },
  { code: 'hi', label: 'Hindi', region: 'hi-IN' },
]

/** A language's name; null (the phone's own) is "Automatic". */
export function languageLabel(code: string | null): string {
  if (code === null) return 'Automatic'
  return VOICE_LANGUAGES.find(l => l.code === code)?.label ?? code
}

const norm = (tag: string) => tag.replace(/_/g, '-').toLowerCase()
const lang = (tag: string) => norm(tag).split('-')[0] ?? ''

/**
 * The locale to recognize in, as the recognizer spells it, or null when it has none for the
 * chosen language. `choice` is a language code from `VOICE_LANGUAGES` (null: the phone's own),
 * `device` the phone's preferred locales in order, `supported` what the recognizer lists (empty
 * when it does not say, as in a browser: then the best guess is returned unchecked).
 *
 * A chosen language keeps the phone's region when the recognizer has it (English on a British
 * phone is en-GB), else its usual one, else any of that language.
 */
export function pickLocale(choice: string | null, device: readonly string[], supported: readonly string[]): string | null {
  const known = (tag: string) => supported.find(s => norm(s) === norm(tag))
  const ofLang = (code: string) => supported.find(s => lang(s) === code)

  if (choice === null) {
    for (const d of device) {
      const hit = known(d) ?? ofLang(lang(d))
      if (hit) return hit
    }
    if (!supported.length) return device[0]?.replace(/_/g, '-') ?? 'en-US'
    return known('en-US') ?? supported[0] ?? null
  }

  const entry = VOICE_LANGUAGES.find(l => l.code === choice)
  const regional = device.filter(d => lang(d) === choice)
  if (!supported.length) return regional[0]?.replace(/_/g, '-') ?? entry?.region ?? choice
  for (const d of regional) {
    const hit = known(d)
    if (hit) return hit
  }
  return (entry && known(entry.region)) ?? ofLang(choice) ?? null
}

/* ---------- preferences ---------- */

export interface VoicePrefs {
  /** A code from `VOICE_LANGUAGES`; null follows the phone. */
  language: string | null
  /** Send the message as soon as the dictation ends, instead of leaving it to edit (the desktop's "send after"). */
  sendAfter: boolean
}

export const DEFAULT_PREFS: VoicePrefs = { language: null, sendAfter: false }

/** Saved preferences, tolerating anything an older build (or a broken write) left. */
export function normalizePrefs(raw: unknown): VoicePrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    language: typeof p.language === 'string' && VOICE_LANGUAGES.some(l => l.code === p.language) ? p.language : null,
    sendAfter: p.sendAfter === true,
  }
}

/* ---------- what went wrong ---------- */

/** Why dictation could not start or stopped early. */
export type VoiceProblem =
  | 'unavailable'
  | 'no-module'
  | 'denied'
  | 'restricted'
  | 'language'
  | 'no-speech'
  | 'network'
  | 'audio'
  | 'interrupted'
  | 'busy'
  | 'other'

export interface VoiceNotice {
  /** error: dictation failed. info: nothing went wrong, but nothing came of it either. */
  tone: 'error' | 'info'
  text: string
  /** The way out lives in a settings screen: the phone's (permissions) or Mango's own (language). */
  settings?: 'system' | 'app'
}

/** A recognizer's error code (iOS module or Web Speech API) as one of ours; null for a deliberate stop. */
export function problemOf(code: string): VoiceProblem | null {
  switch (code) {
    case 'aborted': return null
    case 'not-allowed': return 'denied'
    case 'language-not-supported': return 'language'
    case 'no-speech':
    case 'speech-timeout':
    case 'nomatch': return 'no-speech'
    case 'network': return 'network'
    case 'audio-capture': return 'audio'
    case 'interrupted': return 'interrupted'
    case 'busy':
    case 'too-many-requests': return 'busy'
    case 'service-not-allowed': return 'unavailable'
    default: return 'other'
  }
}

/** What to tell the person, naming the problem and the way out. */
export function noticeFor(problem: VoiceProblem, ctx: { language: string; device: string; detail?: string }): VoiceNotice {
  switch (problem) {
    case 'denied':
      return { tone: 'error', text: `Mango may not use the microphone or speech recognition. Allow both for Mango in the ${ctx.device}'s Settings.`, settings: 'system' }
    case 'restricted':
      return { tone: 'error', text: `Speech recognition is turned off on this ${ctx.device} by Screen Time. Allow it under Content & Privacy Restrictions.`, settings: 'system' }
    case 'language':
      return { tone: 'error', text: `This ${ctx.device} can't recognize ${ctx.language}. Pick another language in Settings > Voice.`, settings: 'app' }
    case 'unavailable':
      return { tone: 'error', text: `Speech recognition isn't available on this ${ctx.device} right now. Check that Dictation is on in Settings > General > Keyboard, then try again.` }
    case 'no-module':
      return { tone: 'error', text: 'This build of Mango has no speech recognition. Install the latest build to dictate.' }
    case 'no-speech':
      return { tone: 'info', text: 'Nothing was heard. Tap the microphone and speak.' }
    case 'network':
      return { tone: 'error', text: `Recognizing ${ctx.language} needs a connection here. Connect and try again, or pick a language this ${ctx.device} recognizes offline.`, settings: 'app' }
    case 'audio':
      return { tone: 'error', text: 'The microphone could not be opened. Close other apps that are recording, then try again.' }
    case 'interrupted':
      return { tone: 'info', text: 'Dictation stopped: something else took the microphone. What was heard is kept.' }
    case 'busy':
      return { tone: 'error', text: 'Speech recognition is busy. Try again in a moment.' }
    case 'other':
      return { tone: 'error', text: ctx.detail ? `Dictation stopped: ${ctx.detail}` : 'Dictation stopped with an error. Try again.' }
  }
}

/** m:ss for the recording clock. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
