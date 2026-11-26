/** The interface languages, each named in itself. Plain Node testable. */
export const LOCALES = { en: 'English', de: 'Deutsch', ru: 'Русский' } as const

export type Locale = keyof typeof LOCALES
/** What the user picked: a language, or whichever one the computer uses. */
export type LocalePref = Locale | 'system'

const isLocale = (v: unknown): v is Locale => typeof v === 'string' && Object.hasOwn(LOCALES, v)

/** A stored pref, or "system" for anything else. */
export const localePrefOf = (v: unknown): LocalePref => (isLocale(v) ? v : 'system')

/** The language to show: the picked one, else the first of the computer's languages Mango has, else English. */
export function resolveLocale(pref: LocalePref, languages: readonly string[]): Locale {
  if (pref !== 'system') return pref
  return languages.map(l => l.toLowerCase().split('-')[0]).find(isLocale) ?? 'en'
}

/** The tag dates and numbers are formatted with: the computer's own region of that language, where it has one. */
export const formatLocaleOf = (locale: Locale, languages: readonly string[]): string =>
  languages.find(l => l.toLowerCase().split('-')[0] === locale) ?? locale

/** Which of a Russian message's three forms ("1 файл | 2 файла | 5 файлов") a count takes. */
export function russianPlural(n: number): 0 | 1 | 2 {
  const tens = Math.abs(n) % 100
  const ones = tens % 10
  if (ones === 1 && tens !== 11) return 0
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 1 : 2
}
