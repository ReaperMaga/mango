<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePlanner, VIEW_ID } from '../context.ts'
import type { PluginMenuRow } from '../host.ts'
import { itemWord, type Collection } from '../model.ts'
import Icon from '../ui/Icon.vue'
import { anyLayerOpen } from '../ui/layers.ts'
import { startChat } from './chats.ts'
import ItemBody from './ItemBody.vue'
import { itemMenu } from './itemMenu.ts'
import ItemProperties from './ItemProperties.vue'
import { onCommit } from '../values/onCommit.ts'
import { strings } from './strings.ts'

/** An item as a page, at the side of its collection or in place of it. Fills its container. */
const props = defineProps<{ collection: Collection; itemId: string; mode: 'side' | 'full' }>()
const emit = defineEmits<{ close: []; 'toggle-mode': [] }>()
const planner = usePlanner()
const { mango, store } = planner
const { Button, IconButton, ThreadDot } = mango.ui.components

const state = computed(() => store.items(props.collection.id))
const item = computed(() => store.item(props.collection.id, props.itemId))
const readonly = computed(() => store.sourceStatus.value.readonly)

/* ---------- title */

const root = ref<HTMLElement | null>(null)
const titleEl = ref<HTMLTextAreaElement | null>(null)
const body = ref<InstanceType<typeof ItemBody> | null>(null)
function setTitle(e: Event) {
  const el = e.target as HTMLTextAreaElement
  const at = el.selectionStart
  // One line, also when several are pasted.
  const title = el.value.replace(/\s*\n\s*/g, ' ')
  if (title !== el.value) {
    el.value = title
    el.setSelectionRange(at, at)
  }
  store.updateItem(props.collection.id, props.itemId, { title }, { defer: true })
}
onCommit(() => {
  const el = titleEl.value
  if (el && item.value && el.value !== item.value.title) store.updateItem(props.collection.id, props.itemId, { title: el.value.replace(/\s*\n\s*/g, ' ') })
})
function onTitleKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter') {
    e.preventDefault()
    void body.value?.edit()
  } else if (e.key === 'Escape') {
    // First out of the title, then out of the page.
    e.preventDefault()
    e.stopPropagation()
    root.value?.focus({ preventScroll: true })
  }
}

/* ---------- chats */

const chats = computed(() => (item.value?.chats ?? []).map(id => ({ id, title: mango.chat.get(id)?.title ?? null })))
/** The chat in view beside the planner, to link with one click. */
const linkable = computed(() => {
  const t = mango.chat.active()
  return t && !item.value?.chats.includes(t.id) ? { id: t.id, title: t.title } : null
})
function chat() {
  if (item.value) startChat(planner, props.collection, item.value)
}
function chatMenu(e: MouseEvent) {
  const known = chats.value.filter(c => c.title !== null)
  if (!known.length) return chat()
  const rows: PluginMenuRow[] = known.map(c => ({ label: c.title || strings.newChatTitle, icon: 'message-square', onSelect: () => mango.chat.show(c.id) }))
  void mango.ui.contextMenu(e.currentTarget as HTMLElement, [...rows, { label: strings.startChat, icon: 'message-square-plus', divider: true, onSelect: chat }])
}
function menu(e: MouseEvent) {
  void itemMenu(planner, props.collection, [props.itemId], e.currentTarget as HTMLElement, {
    open: null,
    rows: [body.value?.asMarkdown
      ? { label: strings.editAsRich, icon: 'pilcrow', onSelect: () => body.value?.toggle() }
      : { label: strings.editAsMarkdown, icon: 'code', onSelect: () => body.value?.toggle() }],
    deleted: () => emit('close'),
  })
}

/* ---------- focus and Escape */

function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || anyLayerOpen()) return
  const el = e.target as HTMLElement | null
  const own = !!el && !!root.value?.contains(el)
  // With the focus nowhere (after a click on nothing) it is the page's while the planner is in front.
  if (!own && !(el === document.body && root.value?.offsetParent && mango.ui.tabs.active()?.viewId === VIEW_ID)) return
  e.preventDefault()
  emit('close')
}
const opener = document.activeElement as HTMLElement | null
async function focusStart() {
  await nextTick()
  if (item.value && !item.value.title && !readonly.value) titleEl.value?.focus({ preventScroll: true })
  else root.value?.focus({ preventScroll: true })
}
onMounted(() => {
  window.addEventListener('keydown', onWindowKey)
  void focusStart()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  void store.flush()
  if (root.value?.contains(document.activeElement) && opener?.isConnected) opener.focus({ preventScroll: true })
})
// Another item in the same page: only what moves on purpose moves the focus.
const scroller = ref<HTMLElement | null>(null)
watch(() => props.itemId, () => {
  void store.flush()
  scroller.value?.scrollTo({ top: 0 })
  if (item.value && !item.value.title && root.value?.contains(document.activeElement)) void focusStart()
})

const collectionName = computed(() => props.collection.name || strings.untitled)
</script>

<template>
  <article ref="root" class="pl-page" :class="`is-${mode}`" tabindex="-1" :aria-label="strings.page(itemWord(collection, 1), item?.title ?? '')">
    <header class="pl-page__head">
      <component :is="IconButton" v-if="mode === 'full'" :label="strings.back(collectionName)" shortcut="Esc" @click="emit('close')"><Icon name="arrow-left" /></component>
      <component :is="IconButton" v-else :label="strings.close" shortcut="Esc" @click="emit('close')"><Icon name="x" /></component>
      <component :is="IconButton" :label="mode === 'full' ? strings.dock : strings.expand" @click="emit('toggle-mode')"><Icon :name="mode === 'full' ? 'panel-right' : 'maximize-2'" /></component>
      <span class="pl-page__gap" />
      <template v-if="item">
        <component :is="Button" variant="ghost" size="sm" @click="chatMenu">
          <Icon name="message-square" />
          <span class="pl-page__chat">{{ chats.some(c => c.title !== null) ? strings.chats : strings.startChat }}</span>
        </component>
        <component :is="IconButton" :label="strings.more" aria-haspopup="menu" @click="menu"><Icon name="ellipsis" /></component>
      </template>
    </header>

    <div v-if="item" ref="scroller" class="pl-page__scroll">
      <div class="pl-page__col">
        <div class="pl-page__title" :data-text="`${item.title || strings.untitled} `">
          <textarea
            ref="titleEl"
            :value="item.title"
            rows="1"
            :readonly="readonly"
            :aria-label="strings.title"
            :placeholder="strings.untitled"
            @input="setTitle"
            @keydown="onTitleKey"
            @blur="store.flush()"
          />
        </div>

        <ItemProperties :collection="collection" :item="item" :readonly="readonly" />

        <ul v-if="chats.length || linkable" class="pl-page__chats" :aria-label="strings.chats">
          <li v-for="c in chats" :key="c.id" class="pl-chat">
            <button v-if="c.title !== null" type="button" class="pl-chat__open" :title="strings.showChat(c.title || strings.newChatTitle)" @click="mango.chat.show(c.id)">
              <component :is="ThreadDot" :thread-id="c.id" />
              <span>{{ c.title || strings.newChatTitle }}</span>
            </button>
            <span v-else class="pl-chat__open is-gone"><Icon name="message-square" /><span>{{ strings.chatGone }}</span></span>
            <component :is="IconButton" v-if="!readonly" size="sm" class="pl-chat__unlink" :label="strings.unlinkChat" @click="store.unlinkChat(collection.id, item.id, c.id)"><Icon name="unlink" /></component>
          </li>
          <li v-if="linkable && !readonly" class="pl-chat">
            <button type="button" class="pl-chat__open is-add" @click="store.linkChat(collection.id, item.id, linkable.id)">
              <Icon name="link" /><span>{{ strings.linkActive(linkable.title || strings.newChatTitle) }}</span>
            </button>
          </li>
        </ul>

        <hr class="pl-page__rule">
        <ItemBody :key="item.id" ref="body" :collection="collection" :item="item" :readonly="readonly" @leave="root?.focus({ preventScroll: true })" />
      </div>
    </div>

    <div v-else class="pl-page__note" role="status">
      <template v-if="state.status === 'error'">
        <p>{{ strings.loadFailed }}</p>
        <p class="pl-page__sub">{{ state.error }}</p>
        <component :is="Button" @click="store.loadItems(collection.id)">{{ strings.retry }}</component>
      </template>
      <p v-else-if="state.status !== 'ready'" class="pl-page__sub">{{ strings.loading }}</p>
      <template v-else>
        <p>{{ strings.gone(itemWord(collection, 1)) }}</p>
        <p class="pl-page__sub">{{ strings.goneBody }}</p>
        <component :is="Button" @click="emit('close')">{{ strings.backToCollection }}</component>
      </template>
    </div>
  </article>
</template>

<style scoped>
.pl-page {
  --pl-page-bg: var(--bg-canvas);
  container: pl-page / inline-size;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--pl-page-bg);
  color: var(--fg);
}
.pl-page:focus-visible { outline: none; border-radius: 0; }
.pl-page__head { display: flex; align-items: center; gap: 2px; flex: none; height: var(--tabbar-h); padding: 0 var(--space-2); border-bottom: 1px solid var(--line-soft); }
.pl-page__gap { flex: 1; }
.pl-page__scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.pl-page__col { display: flex; flex-direction: column; gap: var(--space-3); min-height: 100%; max-width: 760px; margin: 0 auto; padding: var(--space-4) var(--space-3) var(--space-6); }
.pl-page__title { display: grid; }
.pl-page__title > textarea, .pl-page__title::after {
  grid-area: 1 / 1;
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 0;
  background: none;
  font: inherit;
  font-size: var(--text-xl);
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: 1.3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pl-page__title::after { content: attr(data-text); visibility: hidden; }
.pl-page__title > textarea { resize: none; overflow: hidden; }
.pl-page__title > textarea::placeholder { color: var(--fg-faint); }
.pl-page__title > textarea:focus-visible { outline: none; }
.pl-page__chats { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
.pl-chat { display: flex; align-items: center; gap: var(--space-1); min-width: 0; border-radius: var(--radius-sm); }
.pl-chat:hover { background: var(--bg-hover); }
.pl-chat__open { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; height: 30px; padding: 0 var(--space-2); border-radius: var(--radius-sm); font-size: var(--text-sm); text-align: left; }
.pl-chat__open span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-chat__open.is-gone, .pl-chat__open.is-add { color: var(--fg-subtle); }
.pl-chat__open.is-add:hover { color: var(--fg); }
.pl-chat__unlink { margin-right: var(--space-1); opacity: 0; }
.pl-chat:hover .pl-chat__unlink, .pl-chat__unlink:focus-visible { opacity: 1; }
.pl-page__rule { width: 100%; height: 1px; margin: var(--space-1) 0 0; border: 0; background: var(--line-soft); }
.pl-page__note { flex: 1; display: grid; place-content: center; justify-items: center; gap: var(--space-2); padding: var(--space-6); text-align: center; font-size: var(--text-md); }
.pl-page__note p { margin: 0; max-width: 44ch; }
.pl-page__sub { font-size: var(--text-sm); color: var(--fg-subtle); }
@container pl-page (min-width: 620px) {
  .pl-page__col { padding: var(--space-6) var(--space-6) var(--space-10); }
}
@container pl-page (max-width: 300px) {
  .pl-page__chat { display: none; }
}
</style>
