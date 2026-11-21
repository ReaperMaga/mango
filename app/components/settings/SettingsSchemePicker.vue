<script setup lang="ts">
import type { SchemeId } from '~/stores/workspace'

/**
 * Colour scheme choice as small previews of the workspace. Each preview carries
 * its own `data-scheme`, so tokens.css paints it in that scheme whatever the
 * current one is. Native radios underneath, like SettingsSegmented.
 */
defineProps<{
  modelValue: SchemeId
  /** `swatch`: a plugin scheme's own colour for the preview's accent button; `hint`: who adds it (a tooltip). */
  options: Array<{ value: SchemeId; label: string; swatch?: string; hint?: string }>
  /** id of the element that names the group */
  labelledby?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: SchemeId] }>()
const name = useId()
</script>

<template>
  <div class="schemes" role="radiogroup" :aria-labelledby="labelledby">
    <label v-for="o in options" :key="o.value" class="scheme" :title="o.hint">
      <input
        class="scheme__input"
        type="radio"
        :name="name"
        :value="o.value"
        :checked="modelValue === o.value"
        @change="emit('update:modelValue', o.value)"
      >
      <span class="scheme__preview" :data-scheme="o.value" aria-hidden="true">
        <span class="scheme__rail" />
        <span class="scheme__lines">
          <span class="scheme__line" />
          <span class="scheme__line scheme__line--short" />
        </span>
        <span class="scheme__accent" :style="o.swatch ? { background: o.swatch } : undefined" />
      </span>
      <span class="scheme__label">{{ o.label }}</span>
    </label>
  </div>
</template>

<style scoped>
.schemes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-2);
}
.scheme {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
/* The real radio covers the whole option: clicks and focus land on it directly. */
.scheme__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}

/* A miniature workspace: rail, canvas with two text lines, an accent button. */
.scheme__preview {
  position: relative;
  display: flex;
  width: 52px;
  height: 36px;
  overflow: hidden;
  background: var(--bg-canvas);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.scheme__rail {
  flex: none;
  width: 14px;
  background: var(--bg-app);
  border-right: 1px solid var(--line-soft);
}
.scheme__lines {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 0 0 6px;
}
.scheme__line {
  display: block;
  width: 20px;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--fg-faint);
  opacity: 0.7;
}
.scheme__line--short { width: 13px; }
.scheme__accent {
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 14px;
  height: 8px;
  border-radius: var(--radius-xs);
  background: var(--accent);
}

.scheme__label {
  font-size: var(--text-xs);
  font-weight: 520;
  color: var(--fg-subtle);
  transition: color var(--dur-fast) var(--ease-out);
}

.scheme__input:hover ~ .scheme__preview { border-color: var(--line-strong); }
.scheme__input:hover ~ .scheme__label { color: var(--fg-muted); }
.scheme__input:checked ~ .scheme__preview { outline-color: var(--accent); }
.scheme__input:checked ~ .scheme__label { color: var(--fg); font-weight: 560; }
.scheme__input:focus-visible ~ .scheme__preview { outline-color: var(--focus-ring); }

@media (prefers-reduced-motion: reduce) {
  .scheme__preview,
  .scheme__label { transition: none; }
}
</style>
