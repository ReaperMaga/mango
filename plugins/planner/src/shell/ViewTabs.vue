<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import type { PluginMenuRow } from '../host.ts'
import { isGroupable, propertyOf, type Collection, type View, type ViewType } from '../model.ts'
import Icon from '../ui/Icon.vue'
import { onCommit } from '../values/onCommit.ts'
import { dropClass, stepPosition, useReorder } from './reorder.ts'
import { shell } from './strings.ts'

/**
 * The collection's views. Arrows move between them, Alt+arrows reorder, F2 or a double click renames. `compact`: the
 * one shown, with the others in its menu. A right click has what can be done with one.
 */
const props = defineProps<{ collection: Collection; view: View; compact: boolean; readonly: boolean }>()
const emit = defineEmits<{ pick: [viewId: string] }>()
const { store, mango } = usePlanner()

const strip = ref<HTMLElement | null>(null)
const renaming = ref<string | null>(null)
const draft = ref('')
const views = computed(() => props.collection.views)
const iconOf = (type: ViewType) => (type === 'board' ? 'square-kanban' : 'table-2')
const nameOf = (v: View) => v.name || (v.type === 'board' ? shell.board : shell.table)

watch(() => props.view.id, () => void nextTick(() => {
  strip.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}), { immediate: true })

const reorder = useReorder({
  axis: 'x',
  container: () => strip.value,
  hold: () => mango.ui.holdOverlay(),
  onDrop: (id, position) => store.moveView(props.collection.id, id, position),
  disabled: () => props.readonly || renaming.value !== null,
})

async function rename(v: View) {
  if (props.readonly) return
  if (props.compact) {
    const name = (await mango.ui.prompt({ title: shell.viewName, value: nameOf(v) }))?.trim()
    if (name && name !== v.name) store.updateView(props.collection.id, v.id, { name })
    return
  }
  draft.value = nameOf(v)
  renaming.value = v.id
  await nextTick()
  const input = strip.value?.querySelector('input')
  input?.focus()
  input?.select()
}
function commit(save: boolean) {
  const v = views.value.find(e => e.id === renaming.value)
  renaming.value = null
  const name = draft.value.trim()
  if (save && v && name && name !== v.name) store.updateView(props.collection.id, v.id, { name })
  if (v) void nextTick(() => strip.value?.querySelector<HTMLElement>(`[data-rid="${CSS.escape(v.id)}"] [role=tab]`)?.focus())
}

onCommit(() => {
  const name = draft.value.trim()
  if (renaming.value && name) store.updateView(props.collection.id, renaming.value, { name })
})
onBeforeUnmount(() => { if (renaming.value) commit(true) })

/** A property a board groups by is not worth repeating on its cards. */
function add(type: ViewType) {
  const c = props.collection
  const groupBy = type === 'board' ? (c.properties.find(p => p.type === 'select') ?? c.properties.find(isGroupable))?.id ?? null : null
  let left = 3
  const columns = c.properties.map(p => ({ propertyId: p.id, visible: type === 'table' || (p.id !== groupBy && left-- > 0) }))
  const made = store.addView(c.id, { name: type === 'board' ? shell.board : shell.table, type, groupBy, columns })
  if (made) {
    emit('pick', made.id)
    void nextTick(() => rename(made))
  }
}
const addRows = (): PluginMenuRow[] => [
  { label: shell.board, icon: 'square-kanban', group: shell.addView, onSelect: () => add('board') },
  { label: shell.table, icon: 'table-2', onSelect: () => add('table') },
]
function remove(v: View) {
  const at = views.value.findIndex(e => e.id === v.id)
  const next = views.value[at + 1] ?? views.value[at - 1]
  if (store.deleteView(props.collection.id, v.id) && v.id === props.view.id && next) emit('pick', next.id)
}
function viewRows(v: View): PluginMenuRow[] {
  const other: ViewType = v.type === 'board' ? 'table' : 'board'
  const locked = props.readonly
  return [
    { label: shell.renameView, icon: 'pencil', kbd: 'F2', disabled: locked, onSelect: () => void rename(v) },
    {
      label: other === 'board' ? shell.showAsBoard : shell.showAsTable, icon: iconOf(other), disabled: locked,
      onSelect: () => store.updateView(props.collection.id, v.id, { type: other }),
    },
    {
      label: shell.duplicate, icon: 'copy', disabled: locked,
      onSelect: () => { const made = store.duplicateView(props.collection.id, v.id); if (made) emit('pick', made.id) },
    },
    { label: shell.deleteView, icon: 'trash-2', danger: true, divider: true, disabled: locked || views.value.length < 2, onSelect: () => remove(v) },
  ]
}
const menu = (v: View, at: HTMLElement | { x: number; y: number }) => void mango.ui.contextMenu(at, [...viewRows(v), ...(props.readonly ? [] : addRows())])
function openAll(e: MouseEvent) {
  void mango.ui.contextMenu(e.currentTarget as HTMLElement, [
    ...views.value.map((v): PluginMenuRow => ({ label: nameOf(v), icon: iconOf(v.type), checked: v.id === props.view.id, onSelect: () => emit('pick', v.id) })),
    ...viewRows(props.view).map((r, i) => (i ? r : { ...r, divider: true, kbd: undefined })),
    ...(props.readonly ? [] : addRows()),
  ])
}

function onKey(e: KeyboardEvent, v: View) {
  const ids = views.value.map(x => x.id)
  const by = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
  if (by && e.altKey) {
    const position = props.readonly ? null : stepPosition(ids, v.id, by)
    if (position) store.moveView(props.collection.id, v.id, position)
  } else if (by || e.key === 'Home' || e.key === 'End') {
    const at = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (ids.indexOf(v.id) + by + ids.length) % ids.length
    emit('pick', ids[at]!)
    void nextTick(() => strip.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  } else if (e.key === 'F2') void rename(v)
  else if ((e.key === 'Delete' || e.key === 'Backspace') && !props.readonly && ids.length > 1) remove(v)
  else return
  e.preventDefault()
  e.stopPropagation()
}
defineExpose({ currentRows: () => viewRows(props.view), addRows })
const groupTitle = (v: View) => {
  const p = v.groupBy ? propertyOf(props.collection, v.groupBy) : null
  return p ? `${nameOf(v)}, ${shell.groupedBy(p.name)}` : nameOf(v)
}
</script>

<template>
  <button v-if="compact" type="button" class="pl-tab is-on pl-tab--one" aria-haspopup="menu" :aria-label="`${shell.views}: ${nameOf(view)}`" :title="nameOf(view)" @click="openAll">
    <Icon :name="iconOf(view.type)" /><span class="pl-tab__name">{{ nameOf(view) }}</span><Icon name="chevron-down" class="pl-tab__chev" />
  </button>
  <div v-else class="pl-tabs">
    <div ref="strip" class="pl-tabs__strip" role="tablist" :aria-label="shell.views">
      <div
        v-for="(v, i) in views"
        :key="v.id"
        class="pl-tabs__item"
        :class="dropClass(reorder, v.id, i === views.length - 1)"
        :data-rid="v.id"
        role="presentation"
        @contextmenu.prevent.stop="menu(v, { x: $event.clientX, y: $event.clientY })"
      >
        <input
          v-if="renaming === v.id"
          v-model="draft"
          class="pl-tabs__input"
          :aria-label="shell.viewName"
          :size="Math.max(6, Math.min(24, draft.length + 1))"
          autocomplete="off"
          @keydown.enter.prevent.stop="commit(true)"
          @keydown.esc.prevent.stop="commit(false)"
          @blur="renaming && commit(true)"
        >
        <template v-else>
          <button
            type="button"
            class="pl-tab"
            :class="{ 'is-on': v.id === view.id }"
            role="tab"
            :aria-selected="v.id === view.id"
            :tabindex="v.id === view.id ? 0 : -1"
            :title="groupTitle(v)"
            @pointerdown="reorder.start($event, v.id)"
            @click="emit('pick', v.id)"
            @dblclick="rename(v)"
            @keydown="onKey($event, v)"
          >
            <Icon :name="iconOf(v.type)" /><span class="pl-tab__name">{{ nameOf(v) }}</span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pl-tabs { min-width: 0; flex: 0 1 auto; padding: 2px; background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--radius-md); }
.pl-tabs__strip { display: flex; align-items: center; gap: 2px; min-width: 0; max-width: min(420px, 40cqw); overflow-x: auto; scrollbar-width: none; }
.pl-tabs__strip::-webkit-scrollbar { display: none; }
.pl-tabs__item { position: relative; flex: none; display: flex; align-items: center; }
.pl-tabs__item.is-dragging { opacity: 0.5; }
.pl-tabs__item.is-before::before, .pl-tabs__item.is-after::after { content: ''; position: absolute; top: 2px; bottom: 2px; width: 2px; border-radius: var(--radius-pill); background: var(--accent); z-index: 1; }
.pl-tabs__item.is-before::before { left: -2px; }
.pl-tabs__item.is-after::after { right: -2px; }
.pl-tab { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 180px; height: 24px; padding: 0 10px; border-radius: var(--radius-sm); font-size: var(--text-sm); font-weight: 550; color: var(--fg-subtle); transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out); }
.pl-tab > svg { flex: none; width: 13px; height: 13px; stroke-width: 1.75; }
.pl-tab:hover { color: var(--fg); }
.pl-tab.is-on { background: var(--bg-raised); color: var(--fg); }
:root[data-theme='light'] .pl-tabs .pl-tab.is-on { box-shadow: 0 0 0 1px var(--line); }
.pl-tab--one { flex: none; max-width: 150px; height: 30px; border: 1px solid var(--line); }
.pl-tab > svg.pl-tab__chev { width: 12px; height: 12px; color: var(--fg-faint); }
.pl-tab__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@container planner (max-width: 560px) {
  .pl-tab--one .pl-tab__name { display: none; }
}
.pl-tab:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: var(--radius-sm); }
.pl-tabs__input { height: 24px; padding: 0 var(--space-2); background: var(--bg-raised); border: 1px solid var(--accent-line); border-radius: var(--radius-sm); font-size: var(--text-sm); }
.pl-tabs__input:focus-visible { outline: none; border-radius: var(--radius-sm); }
</style>
