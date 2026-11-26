<script setup lang="ts">
import { useOverlay } from '~/composables/useOverlay'
/**
 * Modal shell for short, focused tasks (new project, clone, setup). Closes on
 * Escape and scrim click unless `dismissible` is false (e.g. while something
 * runs that closing would cut off); traps nothing fancy — the dialog's own
 * form owns focus. A tall body scrolls inside the panel.
 */
const props = withDefaults(
  defineProps<{ open: boolean; title: string; width?: number; dismissible?: boolean }>(),
  { width: 460, dismissible: true },
)
const emit = defineEmits<{ close: [] }>()
/* The browsers' native pages would cover the dialog: they hide while it is open. */
useOverlay(() => props.open)

const panel = ref<HTMLElement | null>(null)
/** The body is scrolled down: the head gets an edge so cut-off content reads as scrolled, not broken. */
const scrolled = ref(false)
const onBodyScroll = (e: Event) => { scrolled.value = (e.target as HTMLElement).scrollTop > 0 }

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    // In an embedded terminal Escape belongs to the program; a popup over the dialog that says so closes itself first.
    if ((e.target as HTMLElement | null)?.closest?.('.xterm, [data-own-escape]')) return
    e.stopPropagation()
    if (props.dismissible) emit('close')
  }
}

watch(() => props.open, async (open) => {
  if (!open) return
  scrolled.value = false
  await nextTick()
  // Land inside the dialog even when it has nothing to type into yet.
  ;(panel.value?.querySelector<HTMLElement>('input, textarea, button[data-autofocus]') ?? panel.value)?.focus()
})

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="open" class="dlg" @mousedown.self="dismissible && emit('close')">
        <section ref="panel" class="dlg__panel" tabindex="-1" role="dialog" aria-modal="true" :aria-label="title" :style="{ width: `${width}px` }">
          <header class="dlg__head" :class="{ 'is-scrolled': scrolled }">
            <h2>{{ title }}</h2>
          </header>
          <div class="dlg__body" @scroll.passive="onBodyScroll">
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
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 32px);
  max-height: calc(86vh - 24px);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.dlg__panel:focus-visible { outline: none; }
.dlg__head {
  flex: none;
  padding: var(--space-5) var(--space-5) var(--space-2);
  border-bottom: 1px solid transparent;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.dlg__head.is-scrolled { border-bottom-color: var(--line); }
.dlg__head h2 { margin: 0; font-size: var(--text-lg); font-weight: 620; letter-spacing: -0.01em; }
.dlg__body {
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-5) var(--space-5);
}
.dlg__foot {
  flex: none;
  display: flex;
  align-items: center;
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
