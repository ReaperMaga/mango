<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { usePlanner } from '../context.ts'
import type { Collection, Item } from '../model.ts'
import { onCommit } from '../values/onCommit.ts'
import { fitsRichText } from './notes/markdown.ts'
import MarkdownText from './notes/MarkdownText.vue'
import NotesEditor from './notes/NotesEditor.vue'
import { strings } from './strings.ts'

/**
 * An item's notes. Rich text, unless the user wants the Markdown or the text has something in it rich text would
 * lose. Which one is looked at again only when the text comes from elsewhere, never while it is typed.
 */
const props = defineProps<{ collection: Collection; item: Item; readonly: boolean }>()
const emit = defineEmits<{ leave: [] }>()
const { mango, store } = usePlanner()

const KEY = 'notesAsMarkdown'
const asMarkdown = ref(mango.storage.get<unknown>(KEY) === true)
const fits = ref(fitsRichText(props.item.body))
const rich = computed(() => fits.value && !asMarkdown.value)
const editor = ref<{ edit(): void; focus(): void; commit(): void } | null>(null)
const noteId = `pl-notes-note-${Math.random().toString(36).slice(2, 8)}`

let own = props.item.body
function save(body: string) {
  own = body
  store.updateItem(props.collection.id, props.item.id, { body }, { defer: true })
}
watch(() => props.item.body, (body) => {
  if (body === own) return
  own = body
  // As rich text the editor looks at it itself.
  if (!rich.value && !asMarkdown.value) fits.value = fitsRichText(body)
})

const commit = () => editor.value?.commit()
onCommit(commit)
onBeforeUnmount(() => {
  commit()
  void store.flush()
})

async function toggle() {
  commit()
  void store.flush()
  if (!asMarkdown.value) asMarkdown.value = true
  else {
    asMarkdown.value = false
    fits.value = fitsRichText(props.item.body)
  }
  mango.storage.set(KEY, asMarkdown.value)
  await nextTick()
  editor.value?.focus()
}

defineExpose({ edit: () => editor.value?.edit(), toggle, asMarkdown: computed(() => asMarkdown.value) })
</script>

<template>
  <section class="pl-body">
    <p v-if="!rich && !asMarkdown" :id="noteId" class="pl-body__note">{{ strings.notRich }}</p>
    <NotesEditor
      v-if="rich"
      ref="editor"
      :body="item.body"
      :readonly="readonly"
      @change="save"
      @unfit="fits = false"
      @blur="store.flush()"
      @leave="emit('leave')"
    />
    <MarkdownText
      v-else
      ref="editor"
      :body="item.body"
      :readonly="readonly"
      :described-by="asMarkdown ? undefined : noteId"
      @change="save"
      @blur="store.flush()"
      @leave="emit('leave')"
    />
  </section>
</template>

<style scoped>
.pl-body { position: relative; display: flex; flex-direction: column; flex: 1; gap: var(--space-2); min-width: 0; min-height: 160px; padding-top: var(--space-3); }
.pl-body__note { margin: 0; padding: 0 var(--space-2); font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
</style>
