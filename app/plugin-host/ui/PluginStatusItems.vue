<script setup lang="ts">
import PluginIcon from './PluginIcon.vue'
import { read, reg, report, shown } from '~/plugin-host/registry'
import type { Owned } from '~/plugin-host/registry'
import type { PluginIcon as Icon, PluginStatusItem } from '~/plugin-host/types'

/**
 * Plugins' status items (`ui.statusItems`) in one place: after the project in the titlebar, its right
 * side, or a row in the sidebar foot. Quiet chrome like the titlebar's own widgets: subtle ink, the Hover Wash when one
 * can be clicked. Nothing renders while no plugin has one there.
 */
const props = defineProps<{ location: PluginStatusItem['location'] }>()

interface Row { key: string; text: string; icon: Icon | undefined; tooltip: string; item: Owned<PluginStatusItem> }

const rows = computed<Row[]>(() => reg.statusItems
  .filter(i => i.location === props.location && shown(i))
  .map(i => ({
    key: i.fullId,
    text: String(read(i.text, i.pluginId, '', 'status text') ?? ''),
    icon: read(i.icon, i.pluginId, undefined, 'status icon'),
    tooltip: String(read(i.tooltip, i.pluginId, '', 'status tooltip') ?? ''),
    item: i,
  }))
  .filter(r => r.text || r.icon))

function click(r: Row) {
  try { r.item.onClick?.() } catch (e) { report(r.item.pluginId, e, `status item ${r.item.id}`) }
}
</script>

<template>
  <div v-if="rows.length" class="psi" :class="`psi--${location}`" role="group" aria-label="Plugin status">
    <component
      :is="r.item.onClick ? 'button' : 'span'"
      v-for="r in rows"
      :key="r.key"
      :type="r.item.onClick ? 'button' : undefined"
      class="psi__item"
      :class="{ 'is-button': !!r.item.onClick }"
      :title="r.tooltip || undefined"
      :aria-label="location === 'project' || !r.text ? r.text || r.tooltip || undefined : undefined"
      @click="r.item.onClick && click(r)"
    >
      <PluginIcon v-if="r.icon" :icon="r.icon" class="psi__icon" />
      <span v-if="r.text" class="psi__text tabular">{{ r.text }}</span>
    </component>
  </div>
</template>

<style scoped>
.psi {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.psi--sidebar {
  flex-wrap: wrap;
  padding: var(--space-1) var(--space-2);
  border-top: 1px solid var(--line-soft);
}
.psi__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  min-width: 0;
  max-width: 220px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  font: inherit;
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.psi--titlebar .psi__item,
.psi--project .psi__item { height: 28px; }
.psi--project .psi__item { color: var(--fg-muted); }
/* Beside the project and branch room runs out first: the icon stays, the words are in the tooltip. */
@media (max-width: 1180px) {
  .psi--project { flex: none; }
  .psi--project .psi__icon ~ .psi__text { display: none; }
}
.psi__item.is-button { cursor: pointer; }
.psi__item.is-button:hover { background: var(--bg-hover); color: var(--fg); }
.psi__item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.psi__icon { flex: none; width: 14px; height: 14px; stroke-width: 1.85; }
.psi__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
