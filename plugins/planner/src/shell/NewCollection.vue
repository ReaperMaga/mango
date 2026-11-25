<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlanner } from '../context.ts'
import type { Collection } from '../model.ts'
import { TEMPLATES, type TemplateId } from '../templates.ts'
import Icon from '../ui/Icon.vue'
import { importAsCollection } from './collectionMenu.ts'
import ScopeChoice from './ScopeChoice.vue'
import { scopeOf } from './scope.ts'
import { shell } from './strings.ts'

/** A new collection: a name, what it starts with, where it shows. Enter creates it; arrows choose the template. */
const emit = defineEmits<{ made: [collection: Collection]; cancel: [] }>()
const planner = usePlanner()
const { store, mango } = planner
const { Button, Field } = mango.ui.components

const name = ref('')
const template = ref<TemplateId>('tasks')
const where = ref<'project' | 'everywhere'>(store.projectPath.value ? 'project' : 'everywhere')
const chosen = computed(() => TEMPLATES.find(t => t.id === template.value)!)
const group = ref<HTMLElement | null>(null)

function create() {
  const made = store.createCollection({ name: name.value, template: template.value, scope: scopeOf(store, where.value) })
  if (made) emit('made', made)
}
async function load() {
  const made = await importAsCollection(planner, scopeOf(store, where.value))
  if (!made) return
  if (name.value.trim()) store.updateCollection(made.id, { name: name.value.trim() })
  emit('made', store.collection(made.id) ?? made)
}
function onKey(e: KeyboardEvent) {
  const by = { ArrowDown: 1, ArrowUp: -1 }[e.key]
  if (!by) return
  e.preventDefault()
  const at = TEMPLATES.findIndex(t => t.id === template.value)
  template.value = TEMPLATES[(at + by + TEMPLATES.length) % TEMPLATES.length]!.id
  requestAnimationFrame(() => {
    if (group.value?.contains(document.activeElement)) group.value.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  })
}
</script>

<template>
  <form class="pl-new" @submit.prevent="create">
    <component :is="Field" :label="shell.name" for="pl-new-name">
      <input id="pl-new-name" v-model="name" class="input" type="text" :placeholder="chosen.name" autocomplete="off" spellcheck="false" @keydown="onKey">
    </component>
    <div class="pl-new__part">
      <span class="pl-new__label">{{ shell.template }}</span>
      <div ref="group" role="radiogroup" :aria-label="shell.template" class="pl-new__list" @keydown="onKey">
        <button
          v-for="t in TEMPLATES"
          :key="t.id"
          type="button"
          role="radio"
          class="pl-panel__row pl-new__row"
          :class="{ 'is-on': t.id === template }"
          :aria-checked="t.id === template"
          :tabindex="t.id === template ? 0 : -1"
          @click="template = t.id"
          @dblclick="create"
        >
          <Icon :name="t.icon" />
          <span class="pl-new__name">{{ t.name }}</span>
          <span class="pl-panel__label is-off">{{ t.description }}</span>
        </button>
      </div>
      <button type="button" class="pl-small" @click="load"><Icon name="file-input" />{{ shell.importCsv }}</button>
    </div>
    <footer class="pl-new__foot">
      <ScopeChoice v-model="where" />
      <span class="pl-new__space" />
      <component :is="Button" variant="ghost" @click="emit('cancel')">{{ shell.cancel }}</component>
      <component :is="Button" variant="primary" type="submit">{{ shell.create }}</component>
    </footer>
  </form>
</template>

<style scoped>
.pl-new { display: grid; gap: var(--space-4); padding-top: var(--space-1); }
.pl-new__part { display: grid; gap: 6px; justify-items: start; }
.pl-new__label { font-size: var(--text-xs); font-weight: 560; color: var(--fg-muted); }
.pl-new__list { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; }
.pl-new__row { min-height: 32px; padding-right: var(--space-2); }
.pl-new__row.is-on { background: var(--bg-active); }
.pl-new__name { flex: none; min-width: 52px; font-weight: 560; }
.pl-new__foot { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); padding-top: var(--space-2); }
.pl-new__space { flex: 1; }
</style>
