<script setup lang="ts">
/** An on/off switch for a SettingsRow: `labelledby` is the row's label id. */
defineProps<{ modelValue: boolean; labelledby?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    class="switch"
    role="switch"
    :aria-checked="modelValue"
    :aria-labelledby="labelledby"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="switch__knob" aria-hidden="true" />
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  flex: none;
  width: 32px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--line-strong);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.switch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.switch__knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-muted);
  transition: transform var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.switch[aria-checked='true'] { background: var(--accent); box-shadow: none; }
.switch[aria-checked='true'] .switch__knob { transform: translateX(14px); background: var(--accent-fg); }
</style>
