<script setup lang="ts">
import { ref } from 'vue'
import { usePlanner } from '../context.ts'
import type { Collection, Scope } from '../model.ts'
import { TEMPLATES, type TemplateId } from '../templates.ts'
import Icon from '../ui/Icon.vue'
import { importAsCollection } from './collectionMenu.ts'
import ScopeChoice from './ScopeChoice.vue'
import { scopeOf } from './repository.ts'
import { shell } from './strings.ts'

/** Nothing here yet: what the planner is, and what to start with. */
const emit = defineEmits<{ made: [collection: Collection] }>()
const planner = usePlanner()
const { store } = planner
const where = ref<'project' | 'everywhere'>(store.projectPath.value ? 'project' : 'everywhere')
const scope = (): Scope => scopeOf(planner, where.value)

function create(template: TemplateId) {
  const made = store.createCollection({ template, scope: scope() })
  if (made) emit('made', made)
}
async function load() {
  const made = await importAsCollection(planner, scope())
  if (made) emit('made', made)
}
</script>

<template>
  <div class="pl-start">
    <div class="pl-start__in">
      <h2 class="pl-start__title">{{ shell.start }}</h2>
      <p class="pl-start__body">{{ shell.startBody }}</p>
      <div class="pl-start__head">
        <h3 class="pl-start__sub">{{ shell.startList }}</h3>
        <ScopeChoice v-model="where" />
      </div>
      <ul class="pl-start__list">
        <li v-for="t in TEMPLATES" :key="t.id">
          <button type="button" class="pl-start__row" @click="create(t.id)">
            <Icon :name="t.icon" />
            <span class="pl-start__name">{{ t.name }}</span>
            <span class="pl-start__hint">{{ t.description }}</span>
          </button>
        </li>
        <li class="pl-start__last">
          <button type="button" class="pl-start__row" @click="load">
            <Icon name="file-input" />
            <span class="pl-start__name">{{ shell.importCsv }}</span>
            <span class="pl-start__hint">{{ shell.importCsvHint }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.pl-start { flex: 1; min-height: 0; overflow: auto; display: grid; justify-items: center; align-items: start; padding: clamp(24px, 12vh, 120px) var(--space-5) var(--space-6); }
.pl-start__in { width: min(580px, 100%); }
.pl-start__title { margin: 0 0 var(--space-2); font-size: var(--text-xl); font-weight: 620; letter-spacing: -0.015em; line-height: var(--leading-tight); text-wrap: balance; }
.pl-start__body { margin: 0; max-width: 62ch; font-size: var(--text-md); color: var(--fg-muted); text-wrap: pretty; }
.pl-start__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; margin: var(--space-6) 0 var(--space-2); }
.pl-start__sub { margin: 0; font-size: var(--text-sm); font-weight: 600; }
.pl-start__list { margin: 0 calc(-1 * var(--space-2)); padding: 0; list-style: none; }
.pl-start__last { margin-top: var(--space-1); padding-top: var(--space-1); border-top: 1px solid var(--line-soft); }
.pl-start__row { display: grid; grid-template-columns: 16px 136px minmax(0, 1fr); align-items: baseline; gap: var(--space-3); width: 100%; min-height: 36px; padding: var(--space-2); border-radius: var(--radius-sm); text-align: left; font-size: var(--text-sm); }
.pl-start__row > svg { align-self: center; width: 16px; height: 16px; stroke-width: 1.75; color: var(--fg-subtle); }
.pl-start__row:hover { background: var(--bg-hover); }
.pl-start__row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: var(--radius-sm); }
.pl-start__name { font-weight: 560; color: var(--fg); }
.pl-start__hint { color: var(--fg-subtle); text-wrap: pretty; }
@container planner (max-width: 520px) {
  .pl-start__row { grid-template-columns: 16px minmax(0, 1fr); row-gap: 0; }
  .pl-start__hint { grid-column: 2; }
}
</style>
