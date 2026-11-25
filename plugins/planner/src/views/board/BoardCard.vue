<script setup lang="ts">
import { computed } from 'vue'
import { usePlanner } from '../../context.ts'
import { valueOf, type Collection, type Item, type Property, type View } from '../../model.ts'
import { strings as shared } from '../../strings.ts'
import Icon from '../../ui/Icon.vue'
import ValueView from '../../values/ValueView.vue'
import { previewText } from './cards.ts'
import { strings } from './strings.ts'

/** What a card shows. It handles nothing itself: the board listens for all of them. */
const props = defineProps<{ collection: Collection; view: View; item: Item }>()
const { mango } = usePlanner()
const { ThreadDot } = mango.ui.components

const values = computed(() => props.view.columns.flatMap((c): Property[] => {
  const p = c.visible ? props.collection.properties.find(e => e.id === c.propertyId) : undefined
  const v = p ? valueOf(props.item, p) : null
  return p && v !== null && v !== false ? [p] : []
}))
const preview = computed(() => (props.view.cardPreview === 'body' ? previewText(props.item.body) : ''))
/** The newest linked chat that is still there. */
const chat = computed(() => props.item.chats.findLast(id => mango.chat.get(id)) ?? null)
</script>

<template>
  <div class="pl-card">
    <div class="pl-card__head">
      <Icon v-if="item.icon" :name="item.icon" class="pl-card__icon" />
      <span class="pl-card__title" :class="{ 'is-untitled': !item.title }">{{ item.title || shared.untitled }}</span>
      <span v-if="chat" class="pl-card__chat" :title="strings.linkedChats(item.chats.length)"><component :is="ThreadDot" :thread-id="chat" :size="11" /></span>
    </div>
    <p v-if="preview" class="pl-card__preview">{{ preview }}</p>
    <div v-if="values.length" class="pl-card__values">
      <span v-for="p in values" :key="p.id" class="pl-card__value" :title="p.name">
        <ValueView :property="p" :item="item" />
        <template v-if="p.type === 'checkbox'">{{ p.name }}</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.pl-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 9px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  box-shadow: inset 0 0 0 1px var(--line-soft);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.pl-card__head { display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
.pl-card__icon { flex: none; width: 14px; height: 14px; margin-top: 2px; color: var(--fg-subtle); }
.pl-card__title {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: var(--text-sm);
  line-height: 1.4;
  color: var(--fg);
}
.pl-card__title.is-untitled { color: var(--fg-faint); }
.pl-card__chat { flex: none; display: inline-flex; margin-top: 3px; }
.pl-card__preview {
  margin: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: var(--text-xs);
  line-height: 1.4;
  color: var(--fg-subtle);
}
.pl-card__values { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; font-size: var(--text-xs); color: var(--fg-subtle); }
.pl-card__value { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; overflow: hidden; }
</style>
