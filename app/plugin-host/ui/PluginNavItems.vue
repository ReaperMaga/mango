<script setup lang="ts">
import PluginIcon from './PluginIcon.vue'
import { pluginRef } from '~/plugin-host/ids'
import { guarded, read, reg, shown } from '~/plugin-host/registry'
import type { Owned } from '~/plugin-host/registry'
import type { PluginNavItem } from '~/plugin-host/types'
import { useWorkspace } from '~/stores/workspace'

/**
 * Plugins' places in Mango's navigation (`ui.navItems`): rows under New chat in the sidebar, or icon buttons in
 * the titlebar while the sidebar is hidden. Nothing renders while no plugin has one.
 */
defineProps<{ place: 'sidebar' | 'titlebar' }>()
const { t } = useI18n()
const ws = useWorkspace()

const rows = computed(() => reg.navItems.filter(i => shown(i)).map((i) => {
  const badge = read(i.badge, i.pluginId, null, 'nav badge')
  const count = typeof badge === 'number' && badge > 0 ? Math.floor(badge) : 0
  return {
    key: i.fullId,
    item: i,
    title: i.title,
    icon: i.icon,
    count,
    name: count ? t('shell.tools.items', { label: i.title }, count) : i.title,
    binding: i.shortcut ? pluginRef(i.pluginId, i.shortcut) : null,
    active: read(i.active, i.pluginId, false, 'nav active') === true,
  }
}))

const capped = (n: number) => (n > 99 ? '99+' : String(n))
const run = (i: Owned<PluginNavItem>) => { void guarded(i.pluginId, `nav item ${i.id}`, () => i.run()) }
</script>

<template>
  <nav v-if="rows.length" class="pni" :class="`pni--${place}`" :aria-label="t('plugins.view.navigation')">
    <template v-if="place === 'sidebar'">
      <button
        v-for="r in rows"
        :key="r.key"
        type="button"
        class="pni__row"
        :class="{ 'is-active': r.active }"
        :aria-label="r.name"
        :aria-current="r.active ? 'page' : undefined"
        :title="r.binding ? ws.withKey(r.title, r.binding) : r.title"
        @click="run(r.item)"
      >
        <PluginIcon :icon="r.icon" class="pni__icon" />
        <span class="pni__title">{{ r.title }}</span>
        <span v-if="r.count" class="pni__count tabular" aria-hidden="true">{{ capped(r.count) }}</span>
        <template v-if="r.binding"><kbd v-for="k in ws.keyParts(r.binding)" :key="k" aria-hidden="true">{{ k }}</kbd></template>
      </button>
    </template>
    <template v-else>
      <span v-for="r in rows" :key="r.key" class="pni__cell">
        <UiIconButton :label="r.name" :shortcut="r.binding ? ws.keyLabel(r.binding) : ''" :active="r.active" @click="run(r.item)">
          <PluginIcon :icon="r.icon" />
        </UiIconButton>
        <span v-if="r.count" class="pni__mark tabular" aria-hidden="true">{{ capped(r.count) }}</span>
      </span>
    </template>
  </nav>
</template>

<style scoped>
.pni--sidebar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 var(--space-2) var(--space-2) var(--space-3);
}
.pni__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 6px 0 11px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--fg-muted);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.pni__row:hover { background: var(--bg-hover); color: var(--fg); }
.pni__row.is-active { background: var(--bg-active); color: var(--fg); }
.pni__row:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -1px; }
.pni__icon { flex: none; width: 15px; height: 15px; stroke-width: 1.85; color: var(--fg-subtle); }
.pni__row:hover .pni__icon, .pni__row.is-active .pni__icon { color: inherit; }
.pni__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pni__count { flex: none; padding: 0 2px; font-size: var(--text-xs); color: var(--fg-subtle); }
.pni__row kbd { flex: none; white-space: nowrap; }
.pni__row kbd + kbd { margin-left: -4px; }

.pni--titlebar { flex: none; display: flex; align-items: center; gap: 2px; margin-right: var(--space-1); }
.pni__cell { position: relative; display: inline-flex; }
/* The tool strip's count. */
.pni__mark {
  position: absolute;
  top: -3px;
  right: -4px;
  min-width: 14px;
  padding: 0 3px;
  border-radius: var(--radius-pill);
  background: var(--bg-raised);
  color: var(--fg);
  box-shadow: 0 0 0 1.5px var(--bg-app);
  font-size: var(--text-2xs);
  font-weight: 600;
  line-height: 14px;
  text-align: center;
  pointer-events: none;
}
</style>
