<script setup lang="ts">
import { usePlanner } from '../context.ts'
import { shell } from './strings.ts'

/** Whether a new collection belongs to the project or shows everywhere. Nothing to choose without a project. */
const model = defineModel<'project' | 'everywhere'>({ required: true })
const { store } = usePlanner()
const CHOICES = [['project', shell.thisProject], ['everywhere', shell.everywhere]] as const

function onKey(e: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
  e.preventDefault()
  model.value = model.value === 'project' ? 'everywhere' : 'project'
  const group = e.currentTarget as HTMLElement
  requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
}
</script>

<template>
  <div v-if="store.projectPath.value" class="pl-scope" role="radiogroup" :aria-label="shell.scope" :title="shell.scope" @keydown="onKey">
    <button
      v-for="[id, label] in CHOICES"
      :key="id"
      type="button"
      role="radio"
      class="pl-scope__one"
      :aria-checked="model === id"
      :tabindex="model === id ? 0 : -1"
      @click="model = id"
    >{{ label }}</button>
  </div>
</template>

<style scoped>
.pl-scope { display: inline-flex; padding: 2px; gap: 2px; background: var(--bg-inset); border: 1px solid var(--line-soft); border-radius: var(--radius-sm); }
.pl-scope__one { height: 24px; padding: 0 var(--space-3); border-radius: var(--radius-xs); font-size: var(--text-xs); font-weight: 550; color: var(--fg-subtle); }
.pl-scope__one:hover { color: var(--fg); }
.pl-scope__one[aria-checked='true'] { background: var(--bg-active); color: var(--fg); }
</style>
