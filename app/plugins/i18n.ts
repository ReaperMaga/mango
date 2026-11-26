import { i18n } from '~/i18n'
import { resolveLocale } from '~/i18n/locales'
import { useWorkspace } from '~/stores/workspace'

/** The interface language follows the `locale` pref. */
export default defineNuxtPlugin(({ vueApp }) => {
  vueApp.use(i18n)

  const ws = useWorkspace()
  watch(() => resolveLocale(ws.locale, navigator.languages), (locale) => {
    i18n.global.locale.value = locale
    document.documentElement.lang = locale
  }, { immediate: true })
})
