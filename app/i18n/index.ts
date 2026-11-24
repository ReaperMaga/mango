import { createI18n } from 'vue-i18n'
import { formatLocaleOf, russianPlural, type Locale } from './locales.ts'
import { de } from './messages/de/index.ts'
import { en } from './messages/en/index.ts'
import { ru } from './messages/ru/index.ts'

/** Mango's one i18n instance. Plain Node testable; `plugins/i18n.ts` keeps its language on the `locale` pref. */
export const i18n = createI18n({
  legacy: false,
  locale: 'en' as Locale,
  fallbackLocale: 'en',
  messages: { en, de, ru },
  pluralRules: { ru: russianPlural },
})

/** For stores and composables; components use `useI18n()`. Call it when the text is needed, never at module level. */
export const { t } = i18n.global

/** For `toLocale…` and `Intl`. */
export const formatLocale = (): string => formatLocaleOf(i18n.global.locale.value, globalThis.navigator?.languages ?? [])
