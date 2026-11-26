<script setup lang="ts">
import { Link2, MessageSquare, RefreshCw, Search } from 'lucide-vue-next'
import type { LinkedItem } from '~/types/chat'
import type { GhListItem } from '~/types/ipc'
import { useLinks } from '~/stores/links'
import { itemKey } from '~/utils/githubLinks'
import { stateOf } from '~/utils/linkState'
import { highlight, numberMatch, pickerRows } from '~/utils/linkPicker'
import { useForge } from '~/stores/forge'
import { itemSigil } from '~/utils/forge'

/**
 * Picking a pull request (GitLab: merge request) or issue to link to a chat: one field over the
 * project's open ones. Typing filters them (a number, a title, a branch); a link, `owner/repo#12`
 * (GitLab `group/project!12`) or a number the list lacks is offered as itself. Enter links the
 * highlighted row.
 *
 * Without a chat it only browses: the row chosen is read and handed back (`pick`), linked to nothing.
 */

const props = withDefaults(defineProps<{
  /** The chat to link to; without one the picker browses (see `pick`). */
  chatId?: string
  projectPath: string
  /** Keys already linked to the chat: not offered again. */
  linked?: string[]
  /** Fills the tool window (the empty state) rather than sitting under its header (the link form). */
  fill?: boolean
  autofocus?: boolean
}>(), { chatId: undefined, linked: () => [], fill: false, autofocus: false })

const emit = defineEmits<{ linked: []; cancel: []; pick: [link: LinkedItem] }>()

/** Browsing (no chat): a row opens its item rather than linking it. */
const browsing = computed(() => !props.chatId)

const { t } = useI18n()
const links = useLinks()
const query = ref('')
const active = ref(0)
const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const input = ref<HTMLInputElement | null>(null)

const uid = useId()
const listId = `lp-pick-${uid}`
const optionId = (i: number) => `lp-pick-${uid}-${i}`

onMounted(() => {
  void links.loadOpen(props.projectPath)
  if (props.autofocus) input.value?.focus()
})
watch(() => props.projectPath, p => void links.loadOpen(p))

const state = computed(() => links.open[props.projectPath])
/** GitHub's pull requests or GitLab's merge requests: from the list once read, from the remotes before. */
const forge = useForge()
watch(() => props.projectPath, p => forge.ensure(p), { immediate: true })
const provider = computed(() => state.value?.list?.provider ?? forge.providerOf(props.projectPath))
const sigil = (kind: GhListItem['kind']) => itemSigil(kind, provider.value)
const repoName = computed(() => (state.value?.list ? `${state.value.list.owner}/${state.value.list.repo}` : null))
const available = computed<GhListItem[]>(() => {
  const list = state.value?.list
  if (!list) return []
  const taken = new Set(props.linked)
  return list.items.filter(i => !taken.has(itemKey(list.host, list.owner, list.repo, i.number, i.kind, list.provider)))
})
const rows = computed(() => pickerRows(available.value, query.value, provider.value))

/** What each row links, in order: the typed reference first when there is one. */
type Row = { kind: 'reference'; reference: string } | { kind: 'item'; item: GhListItem }
const options = computed<Row[]>(() => [
  ...(rows.value.reference ? [{ kind: 'reference' as const, reference: rows.value.reference }] : []),
  ...rows.value.items.map(item => ({ kind: 'item' as const, item })),
])

watch(query, () => { active.value = 0; error.value = null })
watch(() => options.value.length, (n) => { if (active.value >= n) active.value = Math.max(0, n - 1) })

const firstLoad = computed(() => !!state.value?.loading && !state.value.list)
const listError = computed(() => (state.value?.list ? null : state.value?.error ?? null))
const searching = computed(() => !!query.value.trim())

async function choose(row: Row | undefined) {
  if (!row || busy.value) return
  const reference = row.kind === 'reference' ? row.reference : row.item.url
  busy.value = reference
  error.value = null
  try {
    if (props.chatId) {
      await links.linkByReference(props.chatId, reference)
      query.value = ''
      emit('linked')
    } else {
      emit('pick', await links.lookup(props.projectPath, reference))
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = null
  }
}

function move(by: number) {
  const n = options.value.length
  if (!n) return
  active.value = (active.value + by + n) % n
  nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView({ block: 'nearest' }))
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); void choose(options.value[active.value]) }
  else if (e.key === 'Escape') {
    e.preventDefault()
    // Keep the Esc from closing anything around the picker while it clears the field.
    if (query.value) { e.stopPropagation(); query.value = '' }
    else emit('cancel')
  }
}

const isBusy = (row: Row) => busy.value === (row.kind === 'reference' ? row.reference : row.item.url)
/** `#12`, `!12` or `12`: a number looked up in the project's own repository. */
const isNumberRef = (reference: string) => /^[#!]?[0-9]+$/.test(reference)
const refLabel = (reference: string) => {
  if (!isNumberRef(reference)) return browsing.value ? t('links.picker.openThis') : t('links.picker.linkThis')
  // A bare number on GitLab: a merge request with that number, else the issue.
  if (/^[0-9]/.test(reference)) return browsing.value ? t('links.picker.openNumber', { number: reference }) : t('links.picker.linkNumber', { number: reference })
  return browsing.value ? t('links.picker.openRef', { ref: reference }) : t('links.picker.linkRef', { ref: reference })
}
</script>

<template>
  <div class="pick" :class="{ 'pick--fill': fill }">
    <div class="pick__field">
      <div class="pick__box" :class="{ 'is-invalid': error }">
        <component :is="browsing ? Search : Link2" class="pick__lead" aria-hidden="true" />
        <input
          ref="input"
          v-model="query"
          class="pick__input"
          type="text"
          role="combobox"
          :aria-label="browsing ? t(`links.picker.find.${provider}`) : t(`links.picker.toLink.${provider}`)"
          aria-autocomplete="list"
          :aria-expanded="options.length > 0"
          :aria-controls="listId"
          :aria-activedescendant="options.length ? optionId(active) : undefined"
          :aria-invalid="!!error || undefined"
          :aria-describedby="error ? `${listId}-error` : undefined"
          :placeholder="browsing ? t(`links.picker.findPlaceholder.${provider}`) : t(`links.picker.linkPlaceholder.${provider}`)"
          spellcheck="false"
          autocomplete="off"
          @keydown="onKey"
        >
      </div>
      <p v-if="error" :id="`${listId}-error`" class="pick__error selectable" role="alert">{{ error }}</p>
      <LinksHostingButton class="pick__hosting" :error="error" />
    </div>

    <div class="pick__scroll">
      <div v-if="firstLoad" class="pick__skeleton" :aria-label="t(`links.picker.reading.${provider}`)" role="status">
        <span v-for="n in 4" :key="n" class="pick__ghost"><span /><span /></span>
      </div>

      <template v-else>
        <div v-if="state?.list || options.length" class="pick__group">
          <span class="pick__group-name">{{ searching ? t('links.picker.matches') : t('links.picker.openIn', { repo: repoName }) }}</span>
          <span class="pick__count tabular">{{ rows.items.length }}</span>
          <UiIconButton
            v-if="!searching && state?.list"
            class="pick__refresh"
            :class="{ 'is-spinning': state?.loading }"
            size="sm"
            :label="t('links.picker.listAgain')"
            :disabled="state?.loading || undefined"
            @click="links.loadOpen(projectPath, true)"
          >
            <RefreshCw />
          </UiIconButton>
        </div>

        <ul v-if="options.length" :id="listId" class="pick__list" role="listbox" :aria-label="t(`links.picker.openList.${provider}`)">
          <li
            v-for="(row, i) in options"
            :id="optionId(i)"
            :key="row.kind === 'reference' ? `ref:${row.reference}` : row.item.url"
            class="pick__row"
            :class="{ 'is-active': i === active, 'is-busy': isBusy(row) }"
            role="option"
            :aria-selected="i === active"
            :title="row.kind === 'item' ? row.item.url : undefined"
            @pointermove="active = i"
            @mousedown.prevent
            @click="choose(row)"
          >
            <template v-if="row.kind === 'reference'">
              <Link2 class="pick__icon" aria-hidden="true" />
              <span class="pick__text">
                <span class="pick__name">{{ refLabel(row.reference) }}</span>
                <span class="pick__sub"><span class="pick__ell">{{ isNumberRef(row.reference) ? (repoName ? t('links.picker.lookedUp', { repo: repoName }) : t('links.picker.lookedUpProject')) : row.reference }}</span></span>
              </span>
            </template>
            <template v-else>
              <component :is="stateOf(row.item.kind, row.item.state, null, provider).icon" class="pick__icon" :class="`is-${stateOf(row.item.kind, row.item.state, null, provider).tone}`" aria-hidden="true" />
              <span class="pick__text">
                <span class="pick__name"><template v-for="(seg, s) in highlight(row.item.title, query)" :key="s"><mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></span>
                <span class="pick__sub">
                  <span class="pick__state" :class="`is-${stateOf(row.item.kind, row.item.state, null, provider).tone}`">{{ stateOf(row.item.kind, row.item.state, null, provider).word }}</span>
                  <span class="tabular">{{ sigil(row.item.kind) }}<mark v-if="numberMatch(row.item.number, query)">{{ String(row.item.number).slice(0, numberMatch(row.item.number, query)) }}</mark>{{ String(row.item.number).slice(numberMatch(row.item.number, query)) }}</span>
                  <span class="pick__ell">{{ row.item.kind === 'pr' ? row.item.headRef : t('links.noun.issue') }}</span>
                </span>
              </span>
            </template>
            <span class="pick__end" aria-hidden="true">
              <span v-if="isBusy(row)" class="pick__spin" />
              <span v-else-if="i === active" class="pick__kbd">Enter</span>
            </span>
          </li>
        </ul>

        <p v-else-if="listError" class="pick__note selectable">
          {{ t('links.picker.listError', { error: listError }) }}
          <span class="pick__note-hint">{{ t('links.picker.linkWorks') }}</span>
          <LinksHostingButton class="pick__hosting" :error="listError" />
        </p>
        <p v-else-if="searching" class="pick__note">{{ browsing ? t('links.picker.noMatchOpen') : t('links.picker.noMatchLink') }}</p>
        <p v-else-if="state?.list" class="pick__note">{{ browsing ? t('links.picker.noneOpen', { repo: repoName }) : t('links.picker.noneLink', { repo: repoName }) }}</p>
      </template>
    </div>

    <p v-if="fill" class="pick__foot"><MessageSquare aria-hidden="true" />{{ browsing ? t('links.picker.openChat') : t(`links.picker.agentLinks.${provider}`) }}</p>
  </div>
</template>

<style scoped>
.pick { display: flex; flex-direction: column; min-height: 0; }
.pick--fill { flex: 1; border-top: 1px solid var(--line-soft); }

.pick__field { flex: none; display: grid; gap: 6px; padding: var(--space-3) var(--space-3) var(--space-1); }
.pick__box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 32px;
  padding: 0 var(--space-2) 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.pick__box:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.pick__box.is-invalid { border-color: color-mix(in oklch, var(--ripe-error) 60%, transparent); }
.pick__lead { flex: none; width: 14px; height: 14px; stroke-width: 1.85; color: var(--fg-faint); }
.pick__box:focus-within .pick__lead { color: var(--fg-subtle); }
.pick__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  font-size: var(--text-sm);
  color: var(--fg);
  caret-color: var(--accent);
  outline: none;
}
.pick__input::placeholder { color: var(--fg-faint); }
.pick__error { margin: 0; font-size: var(--text-xs); color: var(--ripe-error-fg); overflow-wrap: anywhere; }

.pick__scroll { flex: 1; min-height: 0; overflow: auto; padding-bottom: var(--space-2); }
.pick:not(.pick--fill) .pick__scroll { max-height: 280px; }

.pick__group { display: flex; align-items: center; gap: 6px; min-height: 26px; padding: var(--space-1) var(--space-2) 2px var(--space-4); font-size: var(--text-xs); }
.pick__group-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 560; color: var(--fg-subtle); }
.pick__count { color: var(--fg-faint); }
.pick__refresh { margin-left: auto; }
.pick__refresh.is-spinning :deep(svg) { animation: pick-spin 0.8s linear infinite; }

.pick__list { margin: 0; padding: 2px var(--space-2); list-style: none; display: grid; gap: 2px; }
.pick__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 6px var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.pick__row:hover, .pick:focus-within .pick__row.is-active { background: var(--bg-hover); }
.pick__row:active { background: var(--bg-active); }
.pick__icon { flex: none; width: 15px; height: 15px; margin-top: 2px; stroke-width: 1.85; color: var(--fg-subtle); }
.pick__text { flex: 1; display: grid; gap: 1px; min-width: 0; }
.pick__name { font-size: var(--text-sm); font-weight: 520; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pick__row:hover .pick__name, .pick:focus-within .pick__row.is-active .pick__name { color: var(--fg); }
.pick__sub { display: flex; gap: 6px; min-width: 0; font-size: var(--text-xs); color: var(--fg-faint); white-space: nowrap; }
.pick__state { font-weight: 560; }
.pick__ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
mark { background: none; color: var(--fg); font-weight: 650; }
.pick__end { flex: none; align-self: center; display: flex; align-items: center; min-width: 0; }
.pick__kbd {
  display: none;
  font-size: var(--text-2xs);
  font-weight: 500;
  line-height: 1;
  color: var(--fg-faint);
  padding: 3px 5px;
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: var(--radius-xs);
  background: var(--bg-panel);
}
.pick:focus-within .pick__row.is-active .pick__kbd { display: inline-block; }
.pick__spin { width: 12px; height: 12px; border-radius: 50%; border: 1.75px solid var(--fg-subtle); border-right-color: transparent; animation: pick-spin 0.7s linear infinite; }
@keyframes pick-spin { to { transform: rotate(360deg); } }

.pick__note { margin: 0; padding: var(--space-2) var(--space-4); font-size: var(--text-sm); color: var(--fg-subtle); max-width: 52ch; overflow-wrap: anywhere; }
.pick__note-hint { display: block; margin-top: 2px; color: var(--fg-faint); }
.pick__hosting { margin-top: var(--space-2); }

.pick__skeleton { display: grid; gap: 2px; padding: var(--space-2) var(--space-2) 0; }
.pick__ghost { display: grid; gap: 6px; padding: 8px var(--space-2) 8px calc(var(--space-2) + 23px); }
.pick__ghost span { display: block; height: 8px; border-radius: var(--radius-xs); background: var(--bg-hover); animation: pick-pulse 1.4s var(--ease-in-out) infinite alternate; }
.pick__ghost span + span { width: 38%; height: 6px; }
.pick__ghost:nth-child(2) span:first-child { width: 72%; }
.pick__ghost:nth-child(3) span:first-child { width: 84%; }
.pick__ghost:nth-child(4) span:first-child { width: 60%; }
@keyframes pick-pulse { to { opacity: 0.45; } }

.pick__foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.pick__foot svg { flex: none; width: 13px; height: 13px; stroke-width: 1.85; }

.is-running { color: var(--ripe-running-fg); }
.pick__icon.is-running { color: var(--ripe-running); }
.is-queued { color: var(--ripe-queued-fg); }
.pick__icon.is-queued { color: var(--ripe-queued); }

@media (prefers-reduced-motion: reduce) {
  .pick__ghost span, .pick__refresh.is-spinning :deep(svg) { animation: none; }
}
</style>
