<script setup lang="ts">
import { Check, Copy } from 'lucide-vue-next'
import type { PermissionMode } from '~/types/chat'
import { isTauri } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'
import SettingsUpdates from './SettingsUpdates.vue'

const ws = useWorkspace()

/** Least to most independent. */
const modes: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'plan', label: 'Plan', hint: 'Read-only. The agent explores and proposes a plan; it changes nothing.' },
  { value: 'ask', label: 'Ask first', hint: 'The agent asks before every edit and every command.' },
  { value: 'edits', label: 'Accept edits', hint: 'The agent edits files without asking, and still asks before commands.' },
  { value: 'auto', label: 'Full auto', hint: 'The agent never asks. It edits files and runs commands on its own.' },
]

function setMode(mode: PermissionMode) {
  ws.defaultMode = mode
  ws.persist()
}

const name = useId()
const labelId = useId()
const hintId = useId()

/* ---------- about ---------- */
const build = useBuildInfo()
const builtOn = build.dev ? '' : new Date(build.builtAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
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
  <SettingsSection title="General" description="Defaults for new chats, updates, and the version you are running.">
    <div class="group">
      <div class="group__head">
        <h3 :id="labelId" class="group__title">Permissions for new chats</h3>
        <p :id="hintId" class="group__hint">How much an agent may do before it checks with you. You can change this in any chat.</p>
      </div>

      <div class="modes" role="radiogroup" :aria-labelledby="labelId" :aria-describedby="hintId">
        <label v-for="m in modes" :key="m.value" class="mode">
          <input
            class="mode__input"
            type="radio"
            :name="name"
            :value="m.value"
            :checked="ws.defaultMode === m.value"
            :aria-describedby="`${name}-${m.value}`"
            @change="setMode(m.value)"
          >
          <span class="mode__face">
            <span class="mode__radio" aria-hidden="true" />
            <span class="mode__text">
              <span class="mode__label">{{ m.label }}</span>
              <span :id="`${name}-${m.value}`" class="mode__hint">{{ m.hint }}</span>
            </span>
          </span>
        </label>
      </div>
    </div>

    <SettingsUpdates />

    <div class="group about">
      <div class="about__head">
        <h3 class="group__title">About Mango</h3>
        <UiButton size="sm" variant="ghost" :aria-label="copied ? 'Version info copied' : 'Copy version info'" @click="copyInfo">
          <Check v-if="copied" /><Copy v-else />{{ copied ? 'Copied' : 'Copy version info' }}
        </UiButton>
      </div>
      <dl class="about__list">
        <dt>Version</dt>
        <dd>
          <span class="tabular selectable">{{ build.version }}</span>
          <span v-if="build.dev" class="about__tag" title="Running from source with pnpm dev or pnpm app">Development build</span>
        </dd>
        <template v-if="build.commit">
          <dt>Commit</dt>
          <dd class="about__mono selectable">{{ build.commit }}</dd>
        </template>
        <template v-if="builtOn">
          <dt>Built</dt>
          <dd class="tabular">{{ builtOn }}</dd>
        </template>
        <template v-if="tauri">
          <dt>Tauri</dt>
          <dd class="tabular selectable">{{ tauri }}</dd>
        </template>
      </dl>
    </div>
  </SettingsSection>
</template>

<style scoped>
.group { padding-top: var(--space-4); border-top: 1px solid var(--line-soft); }
.group__title { margin: 0; font-size: var(--text-sm); font-weight: 560; }
.group__hint {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  text-wrap: pretty;
}

.modes {
  display: grid;
  gap: 2px;
  /* Rows hang out by their own padding, so the radios line up with the heading. */
  margin: var(--space-3) calc(var(--space-2) * -1) 0;
}
.mode { position: relative; display: block; }
.mode__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.mode__face {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.mode__input:hover + .mode__face { background: var(--bg-hover); }
.mode__input:checked + .mode__face { background: var(--bg-active); }
.mode__input:focus-visible + .mode__face {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}
.mode__radio {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.mode__radio::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-fg);
  transform: scale(0);
  transition: transform var(--dur-fast) var(--ease-out);
}
.mode__input:checked + .mode__face .mode__radio {
  background: var(--accent);
  box-shadow: none;
}
.mode__input:checked + .mode__face .mode__radio::after { transform: scale(1); }
.mode__text { display: grid; gap: 1px; min-width: 0; }
.mode__label { font-size: var(--text-sm); font-weight: 560; color: var(--fg); }
.mode__hint { font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }

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
