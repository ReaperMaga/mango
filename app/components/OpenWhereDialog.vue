<script setup lang="ts">
import { useWorkspace } from '~/stores/workspace'

/**
 * "Open project: this window or a new one?" (`ws.chooseWhere`), asked when the user opens a project
 * in a window that already holds others. Enter opens it here, Escape cancels. "Remember my choice"
 * stops the question; Settings > Preferences brings it back.
 */
const ws = useWorkspace()
const remember = ref(false)
const here = ref<{ $el: HTMLElement } | null>(null)

watch(() => ws.openWhere, async (ask) => {
  if (!ask) return
  remember.value = false
  // After UiDialog's own focus (which would land on the checkbox): the default answer.
  await nextTick()
  await nextTick()
  here.value?.$el.focus()
})

function answer(choice: 'this' | 'new' | null) {
  ws.answerWhere(choice, remember.value)
}

/** Enter anywhere but on another button opens it here. */
function onEnter(e: KeyboardEvent) {
  if ((e.target as HTMLElement | null)?.closest('button')) return
  e.preventDefault()
  answer('this')
}
</script>

<template>
  <UiDialog :open="!!ws.openWhere" title="Open project" :width="440" @close="answer(null)">
    <div class="ow" @keydown.enter="onEnter">
      <p class="ow__body">
        Where would you like to open <strong class="ow__name">{{ ws.openWhere?.name }}</strong>?
        This window keeps it beside the projects already open here.
      </p>
      <label class="ow__remember">
        <input v-model="remember" type="checkbox" class="ow__check">
        <span>Remember my choice</span>
      </label>
      <p v-if="remember" class="ow__hint">Change it later in Settings &gt; Preferences.</p>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="answer(null)">Cancel</UiButton>
      <UiButton @click="answer('new')">New window</UiButton>
      <UiButton ref="here" variant="primary" @click="answer('this')">This window</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.ow__body {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.ow__name {
  font-weight: 560;
  color: var(--fg);
  overflow-wrap: anywhere;
}
.ow__remember {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
  font-size: var(--text-sm);
  color: var(--fg);
  cursor: pointer;
}
.ow__check {
  appearance: none;
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin: 0;
  background: var(--bg-inset);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.ow__check::after {
  content: '';
  width: 7px;
  height: 4px;
  margin-top: -2px;
  border: solid var(--accent-fg);
  border-width: 0 0 1.75px 1.75px;
  rotate: -45deg;
  opacity: 0;
}
.ow__check:checked { background: var(--accent); border-color: var(--accent); }
.ow__check:checked::after { opacity: 1; }
.ow__check:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.ow__hint {
  margin: var(--space-1) 0 0 calc(14px + var(--space-2));
  font-size: var(--text-xs);
  color: var(--fg-subtle);
}
</style>
