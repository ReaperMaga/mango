<script setup lang="ts">
import { ChevronDown, Laptop, Server } from 'lucide-vue-next'
import type { EnvRemote } from '~/types/ipc'
import { useEnvironments } from '~/stores/environments'
import { useWorkspace } from '~/stores/workspace'

/**
 * "Where": this computer or an environment, for Open folder, New project and Clone. A select
 * that lists the environments by server (the ones joined from a link last), refreshed when it opens.
 * `field` sits in a form like an input; `quiet` sits in running text (the welcome hub).
 */
const props = withDefaults(defineProps<{
  modelValue: EnvRemote | null
  variant?: 'field' | 'quiet'
  id?: string
  disabled?: boolean
  /** Names the choice for assistive tech when no <label> points at it, e.g. "Projects go to". */
  label?: string
  /** Shown instead of "This computer" while nothing is chosen (a picker that needs an environment). */
  placeholder?: string
}>(), { variant: 'field', id: undefined, disabled: false, label: undefined, placeholder: undefined })
const emit = defineEmits<{ 'update:modelValue': [where: EnvRemote | null] }>()

const ws = useWorkspace()
const envs = useEnvironments()

const shown = computed(() => (!props.modelValue && props.placeholder ? { label: props.placeholder, sub: null } : whereLabel(props.modelValue)))
const state = computed(() => (props.modelValue ? envState(props.modelValue.hostId, props.modelValue.instance) : null))
/** A mark only when something is wrong or changing: a running environment needs no badge. */
const mark = computed(() => (state.value && ['off', 'moving', 'bad'].includes(state.value.tone) ? state.value : null))

const items = computed(() => whereItems(
  props.modelValue,
  w => emit('update:modelValue', w),
  () => {
    ws.dialog = null
    envs.openView()
  },
))

function open(toggle: () => void) {
  toggle()
  void refreshEnvs()
}
onMounted(() => { if (!envs.loaded) envs.load().catch(() => {}) })
</script>

<template>
  <UiMenu :items="items" :width="300" label="Where">
    <template #default="{ toggle, open: isOpen }">
      <button
        :id="id"
        type="button"
        class="pw"
        :class="[`pw--${variant}`, { 'is-open': isOpen }]"
        aria-haspopup="menu"
        :aria-expanded="isOpen"
        :disabled="disabled"
        :aria-label="label ? `${label}: ${shown.label}${shown.sub ? ` ${shown.sub}` : ''}` : undefined"
        :title="mark ? `${shown.label} ${shown.sub ?? ''}: ${mark.label}` : undefined"
        @click="open(toggle)"
      >
        <component :is="modelValue || placeholder ? Server : Laptop" class="pw__icon" aria-hidden="true" />
        <span class="pw__label" :class="{ 'is-placeholder': !modelValue && placeholder }">{{ shown.label }}</span>
        <span v-if="shown.sub" class="pw__sub">{{ shown.sub }}</span>
        <EnvsEnvStatus v-if="mark" class="pw__mark" :status="mark.status" />
        <ChevronDown class="pw__chev" aria-hidden="true" />
      </button>
    </template>
  </UiMenu>
</template>

<style scoped>
.pw {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  color: var(--fg);
  font-size: var(--text-sm);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.pw:disabled { opacity: 0.55; }
.pw--field {
  width: 100%;
  height: 32px;
  padding: 0 var(--space-2) 0 10px;
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.pw--field:hover:not(:disabled), .pw--field.is-open { border-color: var(--line-strong); }
.pw--field:focus-visible { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.pw--quiet {
  height: 26px;
  padding: 0 4px 0 6px;
  border-radius: var(--radius-sm);
  font-weight: 560;
}
.pw--quiet:hover:not(:disabled), .pw--quiet.is-open { background: var(--bg-hover); }

.pw__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.pw__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pw__label.is-placeholder { color: var(--fg-faint); }
.pw__sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--fg-subtle); font-weight: 400; }
.pw__mark { flex: none; }
.pw__chev { flex: none; width: 14px; height: 14px; margin-left: auto; color: var(--fg-subtle); }
.pw--quiet .pw__chev { margin-left: 0; }
</style>
