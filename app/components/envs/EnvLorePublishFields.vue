<script setup lang="ts">
import { ChevronDown, TriangleAlert } from 'lucide-vue-next'
import type { EnvHostAddress } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { ALL_V4, LORE_PORT, exposesPublicly, validListenAddress, validPublishPort } from '~/utils/lorePublish'

/**
 * Where to publish a Lore server on its Incus host: one of the host's addresses (its tailnet and
 * private ones first), all of them, or one typed in, and a port. Saying so plainly when the choice
 * opens it to the internet, which it has no sign-in for. Used by the create dialog and the
 * instance page's Lore server panel; the caller sends it (`env_lore_publish`, `lorePublish`).
 */
const props = defineProps<{
  /** What the host offers (`env_host_addresses`, or `env_lore_server`'s `addresses`). */
  addresses: readonly EnvHostAddress[]
  /** Why there is nothing to offer, when there isn't (type an address). */
  note?: string | null
  /** Show what is wrong (after a first try). */
  touched?: boolean
  /** For the ids of the fields. */
  idPrefix: string
}>()
const address = defineModel<string>('address', { required: true })
const port = defineModel<string>('port', { required: true })

const { t } = useI18n()

const known = computed(() => props.addresses.some(a => a.address === address.value) || address.value === ALL_V4)
const custom = ref(false)
watch(() => props.addresses, () => { if (!known.value && address.value) custom.value = true }, { immediate: true })

const kindLabel = (a: EnvHostAddress) => t(`envs.lore.kinds.${a.kind}`)
const label = computed(() => {
  if (custom.value) return t('envs.lore.otherAddressLabel')
  if (address.value === ALL_V4) return `${t('envs.lore.all')} (${ALL_V4})`
  const a = props.addresses.find(x => x.address === address.value)
  return a ? `${a.address} · ${kindLabel(a)}` : address.value
})

const items = computed<MenuItem[]>(() => [
  ...props.addresses.map(a => ({
    label: a.address,
    hint: `${kindLabel(a)} · ${a.interface}`,
    checked: !custom.value && address.value === a.address,
    onSelect: () => { custom.value = false; address.value = a.address },
  })),
  {
    label: `${t('envs.lore.all')} (${ALL_V4})`,
    hint: t('envs.lore.kinds.public'),
    checked: !custom.value && address.value === ALL_V4,
    divider: props.addresses.length > 0,
    onSelect: () => { custom.value = false; address.value = ALL_V4 },
  },
  {
    label: t('envs.lore.otherAddress'),
    checked: custom.value,
    onSelect: async () => {
      custom.value = true
      address.value = ''
      await nextTick()
      document.getElementById(`${props.idPrefix}-address-custom`)?.focus()
    },
  },
])

const addressError = computed(() => (validListenAddress(address.value) ? null : t('envs.lore.addressInvalid')))
const portError = computed(() => (validPublishPort(port.value) ? null : t('envs.lore.portInvalid')))
const exposed = computed(() => !addressError.value && exposesPublicly(address.value, props.addresses))
</script>

<template>
  <div class="lpf">
    <div class="lpf__row">
      <UiField :label="t('envs.lore.address')" :for="`${idPrefix}-address`" :error="touched ? addressError : null">
        <UiMenu :items="items" :width="300" :label="t('envs.lore.address')">
          <template #default="{ toggle, open }">
            <button
              :id="`${idPrefix}-address`"
              type="button"
              class="lpf__select"
              :class="{ 'is-open': open }"
              aria-haspopup="menu"
              :aria-expanded="open"
              @click="toggle"
            >
              <span class="lpf__select-label">{{ label }}</span>
              <ChevronDown aria-hidden="true" />
            </button>
          </template>
        </UiMenu>
        <input
          v-if="custom"
          :id="`${idPrefix}-address-custom`"
          v-model="address"
          class="input lpf__mono"
          type="text"
          placeholder="100.101.7.1"
          :aria-label="t('envs.lore.otherAddressLabel')"
          autocomplete="off"
          spellcheck="false"
        >
      </UiField>
      <UiField :label="t('envs.lore.port')" :for="`${idPrefix}-port`" :error="touched ? portError : null">
        <input
          :id="`${idPrefix}-port`"
          v-model="port"
          class="input tabular lpf__port"
          type="text"
          inputmode="numeric"
          :placeholder="String(LORE_PORT)"
          autocomplete="off"
        >
      </UiField>
    </div>
    <p v-if="note" class="lpf__hint">{{ note }}</p>
    <p v-if="exposed" class="lpf__warn" role="note">
      <TriangleAlert aria-hidden="true" />
      <span>{{ t('envs.lore.publicWarning') }}</span>
    </p>
  </div>
</template>

<style scoped>
.lpf { display: grid; gap: var(--space-2); min-width: 0; }
.lpf__row { display: grid; grid-template-columns: minmax(0, 1fr) 104px; gap: var(--space-3); align-items: start; }
.lpf__row :deep(.field + .field) { margin-top: 0; }
.lpf__row :deep(.menu) { display: flex; }
.lpf__mono { margin-top: 6px; font-family: var(--font-mono); font-size: var(--text-xs); }
.lpf__port { font-variant-numeric: tabular-nums; }

/* A menu trigger that reads as a field (as in the create dialog). */
.lpf__select {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 32px;
  padding: 0 var(--space-2) 0 var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  text-align: left;
  color: var(--fg);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.lpf__select:hover { border-color: var(--line-strong); }
.lpf__select.is-open { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.lpf__select:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.lpf__select-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.lpf__select :deep(svg) { flex: none; width: 14px; height: 14px; color: var(--fg-subtle); }

.lpf__hint { margin: 0; font-size: var(--text-xs); color: var(--fg-subtle); text-wrap: pretty; }
.lpf__warn {
  display: flex;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--fg);
  text-wrap: pretty;
}
.lpf__warn :deep(svg) { flex: none; width: 14px; height: 14px; margin-top: 2px; color: var(--ripe-waiting); }
</style>
