<script setup lang="ts">
import { RotateCcw } from 'lucide-vue-next'
import { useWorkspace } from '~/stores/workspace'
import { FIXED_SHORTCUTS, SHORTCUTS, SHORTCUT_GROUPS, comboLabel, comboParts, eventCombo, refuse } from '~/utils/shortcuts'
import SettingsSection from './SettingsSection.vue'
import SettingsRow from './SettingsRow.vue'
import { pluginShortcutDefs } from '~/plugin-host/registry'

/**
 * Settings > Shortcuts: every key Mango answers to. Pick one, press the new combination.
 * While one is being recorded `ws.recordingShortcut` holds the app's own shortcuts still.
 */
const ws = useWorkspace()
const mod = comboParts('Mod')[0]!

/** Every action a key may run: Mango's, then each running plugin's under the plugin's name. */
const allDefs = computed(() => [...SHORTCUTS, ...pluginShortcutDefs()])
const groups = computed(() => {
  const plugins = pluginShortcutDefs()
  const names = [...new Set(plugins.map(s => s.group))]
  return [
    ...SHORTCUT_GROUPS.map(g => ({ group: g as string, items: SHORTCUTS.filter(s => s.group === g) })),
    ...names.map(g => ({ group: g, items: plugins.filter(s => s.group === g) })),
  ]
})
const changed = computed(() => Object.keys(ws.shortcuts).length > 0)

/** The action being recorded, and why the last key was refused. */
const recording = ref<string | null>(null)
const problem = ref<string | null>(null)

function save(next: Record<string, string>) {
  ws.shortcuts = next
  ws.persist()
}

function assign(id: string, combo: string) {
  const def = allDefs.value.find(s => s.id === id)
  if (!def) return
  const next = { ...ws.shortcuts }
  if (combo === def.key) delete next[id]
  else next[id] = combo
  save(next)
}

function reset(id: string) {
  const next = { ...ws.shortcuts }
  delete next[id]
  save(next)
}

function stop() {
  recording.value = null
  problem.value = null
  ws.recordingShortcut = false
  window.removeEventListener('keydown', onKey, true)
}

function start(id: string) {
  if (recording.value === id) return stop()
  stop()
  recording.value = id
  ws.recordingShortcut = true
  window.addEventListener('keydown', onKey, true)
}

function onKey(e: KeyboardEvent) {
  const id = recording.value
  if (!id) return
  // Everything typed now is for the recorder, not for the app or the page.
  e.preventDefault()
  e.stopPropagation()
  if (e.repeat || /^(Shift|Control|Alt|Meta)$/.test(e.key)) return
  if (e.key === 'Escape') return stop()
  if (e.key === 'Backspace' || e.key === 'Delete') { assign(id, ''); return stop() }
  const combo = eventCombo(e)
  if (!combo) {
    problem.value = `Hold ${mod} and press the key.`
    return
  }
  const why = refuse(combo, id, ws.bindings, allDefs.value)
  if (why) {
    problem.value = why
    return
  }
  assign(id, combo)
  stop()
}

/** Leaving the button (a click elsewhere, Tab) ends the recording. */
function onBlur(id: string) {
  if (recording.value === id) stop()
}

onBeforeUnmount(stop)
</script>

<template>
  <SettingsSection title="Shortcuts" description="Every key Mango answers to. Select one, then press the new combination. Backspace clears it, Esc cancels.">
    <div class="bar">
      <button type="button" class="reset-all" :disabled="!changed" @click="save({})">
        <RotateCcw aria-hidden="true" />
        Reset all to defaults
      </button>
    </div>

    <template v-for="g in groups" :key="g.group">
      <h3 class="head">{{ g.group }}</h3>
      <div class="card">
        <SettingsRow
          v-for="s in g.items"
          :key="s.id"
          :label="s.label"
          :hint="recording === s.id ? (problem ?? `Press the new key. It must include ${mod}.`) : undefined"
        >
          <template #default="{ labelId }">
            <div class="ctl">
              <button
                v-if="ws.shortcuts[s.id] !== undefined"
                type="button"
                class="ctl__reset"
                :aria-label="`Reset ${s.label} to ${comboLabel(s.key)}`"
                :title="`Reset to ${comboLabel(s.key)}`"
                @click="reset(s.id)"
              >
                <RotateCcw aria-hidden="true" />
              </button>
              <button
                type="button"
                class="key"
                :class="{ 'is-recording': recording === s.id, 'is-bad': recording === s.id && problem }"
                :aria-labelledby="labelId"
                :aria-pressed="recording === s.id"
                @click="start(s.id)"
                @blur="onBlur(s.id)"
              >
                <span v-if="recording === s.id" class="key__hint">Press keys…</span>
                <template v-else-if="ws.bindings[s.id]">
                  <kbd v-for="k in ws.keyParts(s.id)" :key="k">{{ k }}</kbd>
                </template>
                <span v-else class="key__none">Not set</span>
              </button>
            </div>
          </template>
        </SettingsRow>
      </div>
    </template>

    <h3 class="head">Always on</h3>
    <div class="card">
      <SettingsRow v-for="f in FIXED_SHORTCUTS" :key="f.label" :label="f.label">
        <div class="ctl">
          <span class="key key--fixed">
            <kbd v-for="k in comboParts(f.key)" :key="k">{{ k }}</kbd>
          </span>
        </div>
      </SettingsRow>
    </div>
  </SettingsSection>
</template>

<style scoped>
.bar { display: flex; justify-content: flex-end; margin-bottom: calc(var(--space-2) * -1); }
.reset-all {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.reset-all svg { width: 13px; height: 13px; }
.reset-all:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.reset-all:disabled { opacity: 0.4; cursor: default; }
.reset-all:focus-visible, .key:focus-visible, .ctl__reset:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

.head { margin: var(--space-6) 0 var(--space-3); font-size: var(--text-md); font-weight: 600; }
.card {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.card :deep(.srow) { padding: var(--space-2) var(--space-4); min-height: 44px; }
.card :deep(.srow + .srow) { border-top: 1px solid var(--line-soft); }

.ctl { display: flex; align-items: center; gap: var(--space-1); }
.ctl__reset {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ctl__reset svg { width: 13px; height: 13px; }
.ctl__reset:hover { background: var(--bg-hover); color: var(--fg); }

.key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 96px;
  min-height: 28px;
  padding: 0 var(--space-2);
  justify-content: flex-end;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px transparent;
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
button.key:hover { background: var(--bg-hover); }
.key.is-recording { background: var(--bg-active); box-shadow: inset 0 0 0 1px var(--accent-ink); }
.key.is-bad { box-shadow: inset 0 0 0 1px var(--ripe-error); }
.key--fixed { cursor: default; }
.key__hint { font-size: var(--text-xs); color: var(--accent-ink); }
.key__none { font-size: var(--text-xs); color: var(--fg-subtle); }
</style>
