<script setup lang="ts">
import { Check, Copy } from 'lucide-vue-next'
import { isTauri } from '~/composables/useBackend'
import { formatLocale } from '~/i18n'

const { t } = useI18n()

/** Settings > Maintenance: the version running, the commit and build it came from. */
/* ---------- about ---------- */
const build = useBuildInfo()
const builtOn = computed(() => (build.dev ? '' : new Date(build.builtAt).toLocaleDateString(formatLocale(), { year: 'numeric', month: 'short', day: 'numeric' })))
/** The desktop shell's runtime; the browser preview has none. */
const tauri = ref<string | null>(null)
onMounted(async () => {
  if (!isTauri()) return
  try {
    const { getTauriVersion } = await import('@tauri-apps/api/app')
    tauri.value = await getTauriVersion()
  } catch { /* the line is simply left out */ }
})

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
/** The async clipboard can be refused (no permission, unfocused webview); the old copy command still works then. */
function copyFallback(text: string) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  return ok
}
async function copyInfo() {
  const text = build.summary(tauri.value ? [`Tauri ${tauri.value}`] : [])
  let ok = false
  try { await navigator.clipboard.writeText(text); ok = true } catch { ok = copyFallback(text) }
  if (!ok) return // nothing took it; the values stay selectable
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1600)
}
onBeforeUnmount(() => clearTimeout(copiedTimer))
</script>

<template>
    <div class="group about">
      <div class="about__head">
        <h3 class="group__title">{{ t('settings.about.title') }}</h3>
        <UiButton size="sm" variant="ghost" :aria-label="copied ? t('settings.about.infoCopied') : t('settings.about.copyInfo')" @click="copyInfo">
          <Check v-if="copied" /><Copy v-else />{{ copied ? t('common.actions.copied') : t('settings.about.copyInfo') }}
        </UiButton>
      </div>
      <dl class="about__list">
        <dt>{{ t('settings.about.version') }}</dt>
        <dd>
          <span class="tabular selectable">{{ build.version }}</span>
          <span v-if="build.dev" class="about__tag" :title="t('settings.about.devHint')">{{ t('settings.about.dev') }}</span>
        </dd>
        <template v-if="build.commit">
          <dt>{{ t('settings.about.commit') }}</dt>
          <dd class="about__mono selectable">{{ build.commit }}</dd>
        </template>
        <template v-if="builtOn">
          <dt>{{ t('settings.about.built') }}</dt>
          <dd class="tabular">{{ builtOn }}</dd>
        </template>
        <template v-if="tauri">
          <dt>Tauri</dt>
          <dd class="tabular selectable">{{ tauri }}</dd>
        </template>
      </dl>
    </div>
</template>

<style scoped>
.group { padding-top: var(--space-4); border-top: 1px solid var(--line-soft); }
.group__title { margin: 0; font-size: var(--text-sm); font-weight: 560; }
.about { margin-top: var(--space-6); }
.about__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 28px; }
.about__head :deep(svg) { width: 14px; height: 14px; }
.about__list {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: var(--space-2) var(--space-3);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
}
.about__list dt { color: var(--fg-subtle); }
.about__list dd { margin: 0; display: flex; align-items: center; gap: var(--space-2); min-width: 0; color: var(--fg); }
.about__mono { font-family: var(--font-mono); font-size: var(--text-xs); }
.about__tag {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  font-size: var(--text-2xs);
  font-weight: 560;
  color: var(--fg-subtle);
  white-space: nowrap;
}
</style>
