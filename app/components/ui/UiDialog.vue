<script setup lang="ts">
/**
 * Modal shell for short, focused tasks (new project, clone). Closes on Escape
 * and scrim click; traps nothing fancy — the dialog's own form owns focus.
 */
const props = withDefaults(defineProps<{ open: boolean; title: string; width?: number }>(), { width: 460 })
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    e.stopPropagation()
    emit('close')
  }
}

watch(() => props.open, async (open) => {
  if (!open) return
  await nextTick()
  panel.value?.querySelector<HTMLElement>('input, textarea, button[data-autofocus]')?.focus()
})

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="open" class="dlg" @mousedown.self="emit('close')">
        <section ref="panel" class="dlg__panel" role="dialog" aria-modal="true" :aria-label="title" :style="{ width: `${width}px` }">
          <header class="dlg__head">
            <h2>{{ title }}</h2>
          </header>
          <div class="dlg__body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="dlg__foot">
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dlg {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: start center;
  padding-top: 14vh;
  background: var(--scrim);
}
.dlg__panel {
  max-width: calc(100vw - 32px);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.dlg__head { padding: var(--space-5) var(--space-5) var(--space-2); }
.dlg__head h2 { margin: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; }
.dlg__body { padding: var(--space-2) var(--space-5) var(--space-5); }
.dlg__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--line-soft);
  background: color-mix(in oklch, var(--bg-app) 40%, var(--bg-raised));
}

.dlg-enter-active, .dlg-leave-active { transition: opacity var(--dur-med) var(--ease-out); }
.dlg-enter-active .dlg__panel, .dlg-leave-active .dlg__panel { transition: transform var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out); }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
.dlg-enter-from .dlg__panel, .dlg-leave-to .dlg__panel { transform: translateY(-6px) scale(0.985); opacity: 0; }
</style>
