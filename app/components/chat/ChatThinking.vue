<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'

const props = defineProps<{ text: string; seconds: number; live?: boolean }>()
const open = ref(false)
</script>

<template>
  <div class="th" :class="{ 'is-open': open }">
    <button type="button" class="th__head" :aria-expanded="props.text ? open : undefined" :disabled="!props.text" @click="open = !open">
      <ChevronRight v-if="props.text" class="th__caret" />
      <span v-if="props.live" class="th__live">Thinking…</span>
      <span v-else>Thought for {{ props.seconds }}s</span>
    </button>
    <UiReveal>
      <p v-if="props.text && (open || props.live)" class="th__body selectable">{{ props.text }}</p>
    </UiReveal>
  </div>
</template>

<style scoped>
.th { font-size: var(--text-sm); color: var(--fg-subtle); }
.th__head { display: inline-flex; align-items: center; gap: 4px; height: 24px; color: var(--fg-subtle); border-radius: var(--radius-xs); }
.th__head:hover:not(:disabled) { color: var(--fg-muted); }
.th__head:disabled { cursor: default; }
.th__caret { width: 13px; height: 13px; transition: transform var(--dur-fast) var(--ease-out); }
.th.is-open .th__caret { transform: rotate(90deg); }
.th__live { color: var(--fg-muted); animation: breathe 1.6s var(--ease-in-out) infinite; }
.th__body {
  margin: 2px 0 0 17px;
  padding-left: var(--space-3);
  border-left: 1px solid var(--line);
  line-height: var(--leading-chat);
  color: var(--fg-subtle);
  max-width: 68ch;
}
@keyframes breathe { 50% { opacity: 0.45; } }
</style>
