<script setup lang="ts">
import { ref } from 'vue'
import { usePlanner } from '../../context.ts'
import Popover from '../../ui/Popover.vue'
import { strings } from '../strings.ts'
import { linkTarget } from './links.ts'

/** Where a link points to. */
const props = defineProps<{ href: string; anchor: { x: number; y: number } }>()
const emit = defineEmits<{ close: []; save: [href: string]; remove: [] }>()
const { Button } = usePlanner().mango.ui.components

const text = ref(props.href)
const bad = ref(false)
function save() {
  if (!text.value.trim()) return emit('remove')
  // One that was there already may stay as it is.
  const href = text.value.trim() === props.href ? props.href : linkTarget(text.value)
  if (href === null) bad.value = true
  else emit('save', href)
}
</script>

<template>
  <Popover :anchor="anchor" :width="300" :label="strings.link" @close="emit('close')">
    <form class="pl-link" @submit.prevent="save">
      <input
        v-model="text"
        data-autofocus
        class="pl-input"
        type="text"
        inputmode="url"
        spellcheck="false"
        autocomplete="off"
        placeholder="https://"
        :aria-label="strings.linkAddress"
        :aria-invalid="bad || undefined"
        @input="bad = false"
        @focus="($event.target as HTMLInputElement).select()"
      >
      <p v-if="bad" class="pl-link__bad" role="alert">{{ strings.badLink }}</p>
      <div class="pl-link__row">
        <component :is="Button" v-if="href" variant="ghost" size="sm" type="button" @click="emit('remove')">{{ strings.removeLink }}</component>
        <span class="pl-link__gap" />
        <component :is="Button" size="sm" type="submit" variant="primary">{{ strings.saveLink }}</component>
      </div>
    </form>
  </Popover>
</template>

<style scoped>
.pl-link { display: grid; gap: var(--space-2); padding: var(--space-2); }
.pl-link__row { display: flex; align-items: center; gap: var(--space-2); }
.pl-link__gap { flex: 1; }
.pl-link__bad { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); }
</style>
