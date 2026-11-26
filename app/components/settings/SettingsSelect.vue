<script setup lang="ts" generic="T extends string">
import { ChevronDown } from 'lucide-vue-next'
import type { MenuItem } from '~/types/ui'

/**
 * A short list of choices as a button that opens a menu, the same as the Language choice in Voice.
 * For a SettingsRow: `labelledby` is the row's label id.
 */
const props = defineProps<{
  modelValue: T
  options: Array<{ value: T; label: string }>
  labelledby?: string
  /** Names the menu for assistive tech. */
  label?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const { t } = useI18n()
const items = computed<MenuItem[]>(() => props.options.map(o => ({
  label: o.label,
  checked: o.value === props.modelValue,
  onSelect: () => emit('update:modelValue', o.value),
})))
const current = computed(() => props.options.find(o => o.value === props.modelValue)?.label ?? '')
</script>

<template>
  <UiMenu :items="items" placement="bottom-end" :width="220" :label="label ?? t('common.actions.choose')">
    <template #default="{ toggle, open }">
      <UiButton size="sm" :class="{ 'is-open': open }" :aria-labelledby="labelledby" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
        {{ current }}<ChevronDown />
      </UiButton>
    </template>
  </UiMenu>
</template>
