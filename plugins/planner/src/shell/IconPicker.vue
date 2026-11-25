<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import Icon from '../ui/Icon.vue'
import { shell } from './strings.ts'

/** A collection's icon: a short list of lucide names that suit one, with words to find them by. */
const props = defineProps<{ icon: string }>()
const emit = defineEmits<{ icon: [name: string] }>()

const ICONS: Array<[name: string, words: string]> = [
  ['square-kanban', 'board tasks'], ['list-todo', 'tasks todo'], ['square-check-big', 'done tasks'], ['table-2', 'table'], ['notebook-text', 'notes'],
  ['bug', 'issue defect'], ['rocket', 'launch release'], ['package', 'release build'], ['git-branch', 'code'], ['code', 'code'],
  ['terminal', 'shell'], ['wrench', 'tools fix'], ['hammer', 'build'], ['flask-conical', 'test experiment'], ['lightbulb', 'ideas'],
  ['target', 'goal'], ['flag', 'milestone'], ['calendar', 'date plan'], ['clock', 'time'], ['inbox', 'incoming'],
  ['archive', 'old'], ['bookmark', 'reading saved'], ['book-open', 'docs reading'], ['file-text', 'document page'], ['folder', 'files'],
  ['users', 'people team'], ['user', 'person'], ['message-circle', 'chat feedback'], ['mail', 'email'], ['phone', 'call'],
  ['shopping-cart', 'buy'], ['credit-card', 'money payment'], ['wallet', 'money budget'], ['trending-up', 'growth metrics'], ['palette', 'design'],
  ['image', 'picture'], ['camera', 'photo'], ['music', 'sound'], ['video', 'film'], ['puzzle', 'plugin'],
  ['layers', 'stack'], ['box', 'model'], ['database', 'data'], ['server', 'host'], ['cloud', 'remote'],
  ['globe', 'web site'], ['shield', 'security'], ['lock', 'private'], ['key', 'access'], ['star', 'favourite'],
  ['heart', 'like'], ['zap', 'fast'], ['flame', 'urgent hot'], ['sprout', 'growing new'], ['leaf', 'plant'],
  ['sun', 'day'], ['map', 'roadmap'], ['compass', 'explore'], ['briefcase', 'work'], ['graduation-cap', 'learn study'],
  ['gift', 'present'], ['coffee', 'break'], ['car', 'travel'], ['plane', 'travel'],
]
const PER_ROW = 8
const query = ref('')
const input = ref<HTMLInputElement | null>(null)
const grid = ref<HTMLElement | null>(null)
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return ICONS.filter(([n, w]) => !q || n.includes(q) || w.includes(q)).map(([n]) => n)
})
const current = computed(() => (shown.value.includes(props.icon) ? props.icon : shown.value[0]))

function arrows(e: KeyboardEvent, perRow: number) {
  const by = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[e.key]
  if (!by) return
  const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button')]
  const next = all[all.indexOf(document.activeElement as HTMLElement) + by]
  e.preventDefault()
  if (next) next.focus()
  else if (e.key === 'ArrowUp') input.value?.focus()
}
function enterGrid() {
  grid.value?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus()
}
onMounted(() => void nextTick(() => input.value?.focus({ preventScroll: true })))
</script>

<template>
  <div class="pl-icons">
    <input
      ref="input"
      v-model="query"
      type="text"
      class="pl-input"
      :placeholder="shell.findIcon"
      :aria-label="shell.findIcon"
      autocomplete="off"
      spellcheck="false"
      @keydown.down.prevent="enterGrid"
      @keydown.enter.prevent="current && emit('icon', current)"
    >
    <p v-if="!shown.length" class="pl-icons__none">{{ shell.nothingFound }}</p>
    <div ref="grid" class="pl-icons__grid" @keydown="arrows($event, PER_ROW)">
      <button
        v-for="n in shown"
        :key="n"
        type="button"
        class="pl-icons__icon"
        :class="{ 'is-on': n === icon }"
        :aria-pressed="n === icon"
        :aria-label="n.replaceAll('-', ' ')"
        :title="n.replaceAll('-', ' ')"
        :tabindex="n === current ? 0 : -1"
        @click="emit('icon', n)"
      >
        <Icon :name="n" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.pl-icons { display: grid; gap: var(--space-2); padding: var(--space-1); }
.pl-icons__grid { display: grid; grid-template-columns: repeat(8, 1fr); max-height: 240px; overflow-y: auto; }
.pl-icons__icon { display: grid; place-items: center; height: 30px; border-radius: var(--radius-sm); color: var(--fg-muted); }
.pl-icons__icon > svg { width: 16px; height: 16px; stroke-width: 1.75; }
.pl-icons__icon:hover { background: var(--bg-hover); color: var(--fg); }
.pl-icons__icon.is-on { background: var(--bg-active); color: var(--fg); }
.pl-icons__icon:focus-visible, .pl-icons__none { margin: 0; padding: var(--space-1); font-size: var(--text-sm); color: var(--fg-subtle); }
</style>
