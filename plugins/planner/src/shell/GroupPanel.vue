<script setup lang="ts">
import { computed } from 'vue'
import { usePlanner } from '../context.ts'
import { isGroupable, propertyOf, type Collection, type View } from '../model.ts'
import { groupKeys, NO_GROUP } from '../query.ts'
import { strings } from '../strings.ts'
import Icon from '../ui/Icon.vue'
import OptionTag from '../ui/OptionTag.vue'
import PropertyIcon from '../ui/PropertyIcon.vue'
import PickList, { type PickRow } from './PickList.vue'
import { shell } from './strings.ts'

/** What the view is grouped by, and which groups show. */
const props = defineProps<{ collection: Collection; view: View }>()
const emit = defineEmits<{ addProperty: [] }>()
const { store, mango } = usePlanner()
const { IconButton } = mango.ui.components
const NONE = '-'

const usable = computed(() => props.collection.properties.filter(isGroupable))
const rows = computed<PickRow[]>(() => [
  ...(props.view.type === 'table' ? [{ id: NONE, label: shell.noGrouping, checked: !props.view.groupBy }] : []),
  ...usable.value.map(p => ({ id: p.id, label: p.name || shell.unnamed, checked: p.id === props.view.groupBy })),
])
const property = computed(() => (props.view.groupBy ? propertyOf(props.collection, props.view.groupBy) : null))
const groups = computed(() => {
  const p = property.value
  if (!p) return []
  return groupKeys(p).map((key) => {
    const option = p.options.find(o => o.id === key) ?? null
    const name = option?.name || (key === NO_GROUP ? strings.noGroup(p.name) : key === 'true' ? strings.checked : key === 'false' ? strings.unchecked : shell.unnamed)
    return { key, option, name, hidden: props.view.hiddenGroups.includes(key) }
  })
})

function pick(id: string) {
  const groupBy = id === NONE ? null : id
  if (groupBy !== props.view.groupBy) store.updateView(props.collection.id, props.view.id, { groupBy, hiddenGroups: [], collapsedGroups: [] })
}
function toggle(key: string, hidden: boolean) {
  const now = props.view.hiddenGroups.filter(k => k !== key)
  store.updateView(props.collection.id, props.view.id, { hiddenGroups: hidden ? now : [...now, key] })
}
</script>

<template>
  <div class="pl-panel pl-group">
    <template v-if="!usable.length">
      <p class="pl-panel__note">{{ shell.noGroupable }}</p>
      <button type="button" class="pl-panel__row" @click="emit('addProperty')"><Icon name="plus" /><span class="pl-panel__label">{{ shell.addProperty }}</span></button>
    </template>
    <template v-else>
      <div class="pl-panel__head">{{ shell.groupBy }}</div>
      <PickList :rows="rows" :label="shell.groupBy" :search="false" :max-height="200" data-autofocus @pick="pick">
        <template #icon="{ row }">
          <PropertyIcon v-if="row.id !== NONE" :type="propertyOf(collection, row.id)?.type ?? 'text'" />
          <Icon v-else name="minus" />
        </template>
      </PickList>
      <template v-if="groups.length">
        <div class="pl-panel__sep" />
        <div class="pl-panel__head">{{ shell.groups }}</div>
        <div v-for="g in groups" :key="g.key" class="pl-panel__row">
          <span class="pl-panel__label pl-group__name" :class="{ 'is-off': g.hidden }">
            <OptionTag v-if="g.option" :option="g.option" /><template v-else>{{ g.name }}</template>
          </span>
          <component :is="IconButton" size="sm" :label="g.hidden ? shell.show(g.name) : shell.hide(g.name)" @click="toggle(g.key, g.hidden)">
            <Icon :name="g.hidden ? 'eye-off' : 'eye'" />
          </component>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.pl-group { padding: var(--space-1); }
.pl-group__name { display: flex; align-items: center; }
.pl-group__name.is-off { opacity: 0.6; }
</style>
