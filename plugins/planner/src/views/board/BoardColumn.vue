<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { usePlanner } from '../../context.ts'
import type { Collection, View } from '../../model.ts'
import type { Group } from '../../query.ts'
import Icon from '../../ui/Icon.vue'
import OptionTag from '../../ui/OptionTag.vue'
import BoardCard from './BoardCard.vue'
import { cardKey } from './cards.ts'
import InlineInput from './InlineInput.vue'
import { strings } from './strings.ts'

const props = defineProps<{
  collection: Collection
  view: View
  group: Group
  /** What the column is called. */
  name: string
  /** The group is an option, with a name and a colour of its own. */
  isOption: boolean
  /** Its header can be dragged. */
  sortable: boolean
  readonly: boolean
  openItemId: string | null
  selected: ReadonlySet<string>
  /** Keys of the cards on their way elsewhere. */
  moving: ReadonlySet<string> | null
  /** The card Tab goes to. */
  focusKey: string | null
  adding: 'top' | 'end' | null
  renaming: boolean
  /** A drop would land here; at this height, or wherever the sort puts it (null). */
  over: boolean
  dropY: number | null
}>()
const emit = defineEmits<{
  add: [title: string, at: 'top' | 'end']
  startAdd: [at: 'top' | 'end']
  stopAdd: [byKey: boolean]
  menu: [anchor: HTMLElement]
  rename: [name: string]
  stopRename: [byKey: boolean]
  expand: []
}>()
const { IconButton } = usePlanner().mango.ui.components

/** Long columns show more as they are scrolled. */
const STEP = 60
const limit = ref(STEP)
const cards = computed(() => props.group.items.slice(0, limit.value).map((item) => {
  const key = cardKey({ id: item.id, group: props.group.key })
  return { item, key }
}))
const body = ref<HTMLElement>()

function onScroll() {
  const el = body.value
  if (el && cards.value.length < props.group.items.length && el.scrollHeight - el.scrollTop - el.clientHeight < 900) limit.value += STEP
}
function onAdd(title: string, at: 'top' | 'end') {
  emit('add', title, at)
  if (at === 'end') void toEnd()
}
async function toEnd() {
  limit.value = Math.max(limit.value, props.group.items.length + STEP)
  await nextTick()
  if (body.value) body.value.scrollTop = body.value.scrollHeight
}

defineExpose({
  /** Makes sure the card at this index is there. */
  reveal(index: number) {
    if (index >= limit.value) limit.value = index + STEP
  },
  toTop() {
    if (body.value) body.value.scrollTop = 0
  },
  toEnd,
})
</script>

<template>
  <section
    v-if="group.collapsed"
    class="pl-col is-collapsed"
    :class="{ 'is-over': over }"
    :data-col="group.key"
    :data-sortable="sortable || undefined"
  >
    <button
      type="button"
      class="pl-col__strip"
      data-strip
      data-head
      :data-group="group.key"
      :aria-label="strings.expand(strings.column(name, group.items.length))"
      aria-expanded="false"
      :title="strings.expand(name)"
      @click="emit('expand')"
    >
      <Icon name="chevron-right" class="pl-col__chevron" />
      <span class="pl-col__count">{{ group.items.length }}</span>
      <span class="pl-col__vertical">{{ name }}</span>
    </button>
  </section>

  <section v-else class="pl-col" :class="{ 'is-sorted': over && dropY === null }" :data-col="group.key" :data-sortable="sortable || undefined" :aria-label="strings.column(name, group.items.length)">
    <header class="pl-col__head" :class="{ 'is-sortable': sortable }" data-head>
      <InlineInput v-if="renaming" single :label="strings.groupName" :placeholder="strings.groupName" :value="group.name" @add="emit('rename', $event)" @close="emit('stopRename', $event)" />
      <template v-else>
        <span class="pl-col__name" :title="name">
          <OptionTag v-if="isOption" :option="group" />
          <template v-else>{{ name }}</template>
        </span>
        <span class="pl-col__count">{{ group.items.length }}</span>
        <span class="pl-col__spring" />
        <component :is="IconButton" class="pl-col__btn" size="sm" :label="strings.columnMenu(name)" aria-haspopup="menu" @click="emit('menu', $event.currentTarget)"><Icon name="ellipsis" /></component>
        <component :is="IconButton" v-if="!readonly" class="pl-col__btn" size="sm" :label="strings.newItemIn(name)" @click="emit('startAdd', 'top')"><Icon name="plus" /></component>
      </template>
    </header>

    <div ref="body" class="pl-col__body" data-body tabindex="-1" @scroll.passive="onScroll">
      <div v-if="adding === 'top'" class="pl-col__top">
        <InlineInput :label="strings.newItemIn(name)" :placeholder="strings.itemTitle" :hint="strings.addHint" @add="onAdd($event, 'top')" @close="emit('stopAdd', $event)" />
      </div>
      <div class="pl-col__list" :class="{ 'is-long': group.items.length > STEP }" data-list :role="cards.length ? 'listbox' : undefined" :aria-multiselectable="cards.length ? true : undefined" :aria-label="cards.length ? name : undefined">
        <div
          v-for="({ item, key }, i) in cards"
          :key="item.id"
          class="pl-col__card"
          :class="{ 'is-selected': selected.has(key), 'is-open': item.id === openItemId, 'is-moving': moving?.has(key) }"
          role="option"
          :aria-selected="selected.has(key)"
          :aria-posinset="i + 1"
          :aria-setsize="group.items.length"
          :tabindex="focusKey === key ? 0 : -1"
          :data-card="item.id"
          :data-group="group.key"
        >
          <BoardCard :collection="collection" :view="view" :item="item" />
        </div>
        <div v-if="over && dropY !== null" class="pl-col__drop" :style="{ transform: `translateY(${dropY}px)` }" />
      </div>
      <div v-if="!readonly" class="pl-col__foot">
        <InlineInput v-if="adding === 'end'" :label="strings.newItemIn(name)" :placeholder="strings.itemTitle" :hint="strings.addHint" @add="onAdd($event, 'end')" @close="emit('stopAdd', $event)" />
        <button v-else type="button" class="pl-col__new" data-new :data-group="group.key" :aria-label="strings.newItemIn(name)" @click="emit('startAdd', 'end')">
          <Icon name="plus" />{{ strings.newItem }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pl-col {
  position: relative;
  flex: none;
  width: min(272px, calc(100cqw - 40px));
  min-height: 0;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
}
/* Without a line to show where: the sort decides. */
.pl-col.is-sorted::after, .pl-col.is-collapsed.is-over::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid var(--accent-line);
  border-radius: inherit;
  pointer-events: none;
}
.pl-col__head { flex: none; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px 0 8px; }
.pl-col__head.is-sortable { cursor: grab; }
.pl-col__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--fg-subtle);
}
.pl-col__count { flex: none; font-size: var(--text-xs); color: var(--fg-faint); font-variant-numeric: tabular-nums; }
.pl-col__spring { flex: 1; }
.pl-col__btn { opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
.pl-col:hover .pl-col__btn, .pl-col:focus-within .pl-col__btn { opacity: 1; }
@media (hover: none) { .pl-col__btn { opacity: 1; } }

.pl-col__body { flex: 1 1 auto; min-height: 0; overflow: hidden auto; padding: 2px 0 0 8px; scrollbar-gutter: stable; }
.pl-col__top { padding: 1px 2px 8px 0; }
.pl-col__list { position: relative; display: flex; flex-direction: column; gap: 6px; padding-right: 2px; min-height: 2px; }
.pl-col__card { flex: none; border-radius: var(--radius-sm); }
/* Only there: a column as tall as its cards would be sized by the guess. */
.pl-col__list.is-long > .pl-col__card { content-visibility: auto; contain-intrinsic-size: auto 52px; }
.pl-col__card:hover > :deep(.pl-card) { background: var(--bg-raised); }
.pl-col__card.is-open > :deep(.pl-card) { box-shadow: inset 0 0 0 1px var(--line-strong); background: var(--bg-raised); }
.pl-col__card.is-selected > :deep(.pl-card) {
  background: color-mix(in oklab, var(--accent) 12%, var(--bg-panel));
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.pl-col__card.is-moving { opacity: 0.45; }
.pl-col__card:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; border-radius: var(--radius-sm); }
.pl-col__drop {
  position: absolute;
  left: 0;
  right: 2px;
  top: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
}
.pl-col__foot { position: sticky; bottom: 0; padding: 6px 2px 6px 0; background: var(--bg-canvas); }
.pl-col__new {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.pl-col__new :deep(svg) { width: 14px; height: 14px; }
.pl-col__new:hover { background: var(--bg-hover); color: var(--fg); }
.pl-col__new:focus-visible { outline-offset: -2px; }

.pl-col.is-collapsed { width: 36px; }
.pl-col__strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 0;
  max-height: 100%;
  padding: 11px 0;
  border-radius: var(--radius-md);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  font-weight: 560;
  overflow: hidden;
  transition: background var(--dur-fast) var(--ease-out);
}
.pl-col__strip:hover { background: var(--bg-hover); color: var(--fg); }
.pl-col__strip:focus-visible { outline-offset: -2px; }
.pl-col__chevron { flex: none; width: 14px; height: 14px; }
.pl-col__vertical { writing-mode: vertical-rl; min-height: 0; max-height: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .pl-col__btn, .pl-col__strip, .pl-col__new { transition: none; } }
</style>
