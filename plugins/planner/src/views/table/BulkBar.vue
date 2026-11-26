<script setup lang="ts">
import { usePlanner } from '../../context.ts'
import { isReadonly, itemWord, type Collection, type Property } from '../../model.ts'
import { strings as shared } from '../../strings.ts'
import Icon from '../../ui/Icon.vue'
import { PROPERTY_ICONS } from '../../ui/propertyIcons.ts'
import { strings } from './strings.ts'

/** What can be done with the selected items. */
const props = defineProps<{ collection: Collection; count: number }>()
const emit = defineEmits<{ set: [property: Property, anchor: HTMLElement]; duplicate: []; delete: []; clear: [] }>()
const { mango } = usePlanner()
const { IconButton } = mango.ui.components

function setProperty(e: MouseEvent) {
  const anchor = e.currentTarget as HTMLElement
  let picked: Property | null = null
  void mango.ui.contextMenu(anchor, props.collection.properties.filter(p => !isReadonly(p)).map(p => ({
    label: p.name || shared.untitled,
    icon: PROPERTY_ICONS[p.type],
    onSelect: () => { picked = p },
  }))).then(() => { if (picked) emit('set', picked, anchor) })
}
</script>

<template>
  <div class="pl-bulk" role="toolbar" :aria-label="strings.selectionActions(itemWord(collection, 2))" @keydown.esc.stop.prevent="emit('clear')">
    <span class="pl-bulk__count" role="status">{{ strings.selected(count, itemWord(collection, count)) }}</span>
    <button type="button" class="pl-bulk__btn" :title="strings.setProperty" aria-haspopup="menu" @click="setProperty">
      <Icon name="sliders-horizontal" /><span>{{ strings.setProperty }}</span>
    </button>
    <button type="button" class="pl-bulk__btn" :title="strings.duplicate" @click="emit('duplicate')">
      <Icon name="copy" /><span>{{ strings.duplicate }}</span>
    </button>
    <button type="button" class="pl-bulk__btn is-danger" :title="strings.delete" @click="emit('delete')">
      <Icon name="trash-2" /><span>{{ strings.delete }}</span>
    </button>
    <component :is="IconButton" size="sm" :label="strings.clear" shortcut="Esc" @click="emit('clear')"><Icon name="x" /></component>
  </div>
</template>

<style scoped>
.pl-bulk {
  position: absolute;
  z-index: 6;
  left: 50%;
  bottom: 44px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: calc(100% - var(--space-4));
  height: 38px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
  animation: pl-bulk-in var(--dur-fast) var(--ease-out);
}
@keyframes pl-bulk-in { from { opacity: 0; transform: translate(-50%, 4px); } }
.pl-bulk__count { margin-right: var(--space-2); color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pl-bulk__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-weight: 560;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.pl-bulk__btn :deep(svg) { flex: none; width: 14px; height: 14px; stroke-width: 1.75; }
.pl-bulk__btn:hover { background: var(--bg-hover); color: var(--fg); }
.pl-bulk__btn:active { background: var(--bg-active); }
.pl-bulk__btn.is-danger:hover { color: var(--ripe-error-fg); }
@container pl-table (max-width: 480px) {
  .pl-bulk__btn span { display: none; }
}
@media (prefers-reduced-motion: reduce) { .pl-bulk { animation: none; } }
</style>
