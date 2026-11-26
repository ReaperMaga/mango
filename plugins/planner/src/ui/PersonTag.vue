<script setup lang="ts">
import { computed } from 'vue'
import { colorVar } from './colors.ts'
import { personColor, personInitial, type PersonView } from './people.ts'

/**
 * A person: a round initial in their colour, and their name. One no longer in the space has no colour and their name
 * held back. `youWord`: said after the name when it is whoever looks. `formerWord`: the tooltip's word for a former one.
 */
const props = defineProps<{ person: PersonView; youWord?: string; formerWord?: string }>()
const color = computed(() => colorVar(props.person.former || props.person.unknown ? 'neutral' : personColor(props.person.id)))
const title = computed(() => [props.person.name, props.person.former && props.formerWord ? `· ${props.formerWord}` : ''].filter(Boolean).join(' '))
</script>

<template>
  <span class="pl-person" :class="{ 'is-former': person.former || person.unknown }" :title="title">
    <span class="pl-person__avatar" :style="{ background: color.strong, color: color.fg }" aria-hidden="true">{{ personInitial(person.name) }}</span>
    <span class="pl-person__name">{{ person.name }}</span>
    <span v-if="person.you && youWord" class="pl-person__you">{{ youWord }}</span>
  </span>
</template>

<style scoped>
.pl-person {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  height: 20px;
  font-size: var(--text-xs);
  line-height: 20px;
  vertical-align: middle;
  color: var(--fg);
}
.pl-person__avatar {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}
.pl-person__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-person__you { flex: none; color: var(--fg-subtle); }
.pl-person.is-former .pl-person__name { color: var(--fg-subtle); }
</style>
