<script setup lang="ts">
import type { PermissionMode } from '~/types/chat'
import { isTauri } from '~/composables/useBackend'
import { useWorkspace } from '~/stores/workspace'
import SettingsSection from './SettingsSection.vue'

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

const version = ref<string | null>(null)
onMounted(async () => {
  if (!isTauri()) return
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    version.value = await getVersion()
  } catch { /* the line is simply left out */ }
})
</script>

<template>
  <SettingsSection title="General" description="Defaults for new chats.">
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

    <dl v-if="version" class="about">
      <dt>Mango</dt>
      <dd class="tabular selectable">Version {{ version }}</dd>
    </dl>
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

.about {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: var(--space-6) 0 0;
  padding-top: var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
}
.about dt { font-weight: 560; color: var(--fg-muted); }
.about dd { margin: 0; color: var(--fg-subtle); }
</style>
