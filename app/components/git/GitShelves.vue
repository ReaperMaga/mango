<script setup lang="ts">
/**
 * Unity VCS shelves in the Changes view: a folding "Shelves" section with an inline
 * "Shelve changes" form (comment, and whether the workspace drops the changes after),
 * and the user's shelves with Apply and a two-step Delete.
 */
import { Archive, ArchiveRestore, ChevronRight, Trash2, X } from 'lucide-vue-next'
import type { VcsShelve } from '~/types/ipc'
import { formatLocale } from '~/i18n'
import { useGit } from '~/stores/git'
import { shortAgo, useNow } from '~/utils/time'

const props = defineProps<{ path: string }>()

const { t } = useI18n()
const git = useGit()
const now = useNow()
const repo = computed(() => git.repo(props.path))
const shelves = computed(() => repo.value?.shelves ?? [])
const open = computed(() => repo.value?.shelvesOpen ?? false)
const busy = computed(() => !!git.busy)
const working = computed(() => git.isBusy(props.path, 'shelve'))

/* ---------- what a shelve takes: what the checkin would ---------- */

const files = computed(() => repo.value?.status?.files ?? [])
const picked = computed(() => files.value.filter(f => f.index))
/** Nothing staged takes everything, as Check in all does. */
const chosen = computed(() => (picked.value.length ? picked.value : files.value))
/** Private files: Unity VCS can't shelve them until they are under version control (a staged one is still private). */
const isPrivate = (f: { index: string | null; worktree: string | null }) => f.worktree === '?' || (!f.worktree && f.index === 'A')
const privates = computed(() => chosen.value.filter(isPrivate).length)
const taken = computed(() => chosen.value.length - privates.value)
const scope = computed(() => {
  if (!files.value.length) return t('git.shelves.nothing')
  if (!taken.value) return t('git.shelves.onlyNew')
  const what = picked.value.length
    ? t('git.shelves.takesStaged', taken.value)
    : t('git.shelves.takesAll', taken.value)
  return privates.value ? `${what} ${t('git.shelves.newStay', privates.value)}` : what
})

/* ---------- the shelve form ---------- */

const shelving = ref(false)
const comment = ref('')
/** Park the work: the workspace drops the shelved changes afterwards. The usual reason to shelve. */
const undo = ref(true)
const input = ref<HTMLInputElement | null>(null)
const root = ref<HTMLElement | null>(null)
const canShelve = computed(() => !busy.value && !!comment.value.trim() && taken.value > 0)

/** Open the form, optionally with a comment to start from (the checkin comment). */
async function start(initial = '') {
  if (!open.value) git.toggleShelves(props.path)
  comment.value = initial.trim()
  shelving.value = true
  await nextTick()
  root.value?.scrollIntoView({ block: 'nearest' })
  input.value?.focus()
}
async function submit() {
  if (!canShelve.value) return
  const text = comment.value.trim()
  if (await git.shelve(props.path, text, undo.value)) {
    shelving.value = false
    // Started from the checkin comment: it went with the shelve.
    const r = git.ensure(props.path)
    if (r.message.trim() === text) r.message = ''
    comment.value = ''
  }
}
function cancel() {
  shelving.value = false
}

/* ---------- the list ---------- */

/** Id of the shelve asking before it is deleted. */
const confirming = ref<number | null>(null)
watch(() => props.path, () => {
  confirming.value = null
  shelving.value = false
})

function apply(s: VcsShelve) {
  confirming.value = null
  void git.applyShelve(props.path, s.id)
}
function remove(s: VcsShelve) {
  confirming.value = null
  void git.deleteShelve(props.path, s.id)
}
const subject = (s: VcsShelve) => s.comment.split('\n')[0]?.trim() || t('git.shelves.noComment')
const tooltip = (s: VcsShelve) =>
  `sh:${s.id} · ${s.comment.trim() || t('git.shelves.noComment')}\n${[s.branch, s.owner, new Date(s.time).toLocaleString(formatLocale())].filter(Boolean).join(' · ')}`

defineExpose({ start })
</script>

<template>
  <section ref="root" class="gp__sec gs" :aria-label="t('git.shelves.title')">
    <div class="gp__sec-head">
      <button type="button" class="gp__sec-toggle" :aria-expanded="open" @click="git.toggleShelves(path)">
        <ChevronRight class="gp__caret" :class="{ 'is-open': open }" aria-hidden="true" />
        <span>{{ t('git.shelves.title') }}</span>
        <span v-if="repo?.shelves?.length" class="gp__count tabular">{{ repo.shelves.length }}</span>
      </button>
      <div class="gp__sec-actions">
        <UiIconButton size="sm" :label="t('git.shelves.shelveItem')" :active="shelving" :disabled="busy && !shelving" @click="shelving ? cancel() : start()">
          <Archive />
        </UiIconButton>
      </div>
    </div>

    <form v-if="shelving" class="gs__form" :aria-label="t('git.shelves.form')" @submit.prevent="submit" @keydown.esc.stop.prevent="cancel">
      <input
        ref="input"
        v-model="comment"
        class="gs__input"
        type="text"
        :placeholder="t('git.shelves.comment')"
        :aria-label="t('git.shelves.comment')"
        spellcheck="true"
      >
      <label class="gs__undo">
        <SettingsSwitch v-model="undo" labelledby="gs-undo-label" />
        <span id="gs-undo-label">{{ t('git.shelves.undo') }}</span>
      </label>
      <p class="gs__scope" :class="{ 'is-warn': files.length > 0 && !taken }">{{ scope }}</p>
      <div class="gs__btns">
        <UiButton size="sm" variant="ghost" @click="cancel">{{ t('common.actions.cancel') }}</UiButton>
        <UiButton
          size="sm"
          type="submit"
          :loading="working"
          :disabled="!canShelve"
          :title="undo ? t('git.shelves.undoTitle') : t('git.shelves.keepTitle')"
        >
          {{ undo ? t('git.shelves.shelveUndo') : t('git.shelves.shelve') }}
        </UiButton>
      </div>
    </form>

    <template v-if="open">
      <ul v-if="shelves.length" class="gs__list" role="list">
        <li v-for="s in shelves" :key="s.id" class="gs__item" :class="{ 'is-confirming': confirming === s.id }">
          <div class="gs__row" :title="tooltip(s)">
            <div class="gs__text">
              <span class="gs__subject">{{ subject(s) }}</span>
              <span class="gs__meta">
                <code class="gs__id">sh:{{ s.id }}</code>
                <code v-if="s.branch" class="gs__branch">{{ s.branch }}</code>
                <span class="gs__when tabular">{{ shortAgo(s.time, now) }}</span>
              </span>
            </div>
            <div v-if="confirming !== s.id" class="gs__actions">
              <UiIconButton size="sm" :label="t('git.shelves.apply', { id: `sh:${s.id}` })" :disabled="busy" @click="apply(s)"><ArchiveRestore /></UiIconButton>
              <UiIconButton size="sm" :label="t('git.shelves.deleteItem', { id: `sh:${s.id}` })" :disabled="busy" @click="confirming = s.id"><Trash2 /></UiIconButton>
            </div>
          </div>
          <div v-if="confirming === s.id" class="gs__confirm" role="alertdialog" :aria-label="t('git.shelves.delete', { id: `sh:${s.id}` })" @keydown.esc.stop.prevent="confirming = null">
            <span class="gs__ask">{{ t('git.shelves.deleteAsk', { id: `sh:${s.id}` }) }}</span>
            <button type="button" class="gs__yes" :disabled="busy" @click="remove(s)">{{ t('common.actions.delete') }}</button>
            <UiIconButton size="sm" :label="t('git.shelves.keep')" @click="confirming = null"><X /></UiIconButton>
          </div>
        </li>
      </ul>
      <p v-else-if="repo?.shelvesError" class="gs__quiet is-error selectable">{{ repo.shelvesError }}</p>
      <p v-else class="gs__quiet">{{ repo?.shelves === null ? t('git.shelves.reading') : t('git.shelves.empty') }}</p>
    </template>
  </section>
</template>

<style scoped>
/* The section head matches GitPanel's own sections (Staged, Changes, History). */
.gp__sec { padding-top: var(--space-2); }
.gp__sec-head { display: flex; align-items: center; height: 28px; padding-right: 3px; }
.gp__sec-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--fg-muted);
  text-align: left;
}
.gp__sec-toggle:hover { color: var(--fg); }
.gp__caret { width: 13px; height: 13px; flex: none; color: var(--fg-subtle); transition: transform var(--dur-fast) var(--ease-out); }
.gp__caret.is-open { transform: rotate(90deg); }
.gp__count { margin-left: 2px; font-weight: 500; color: var(--fg-faint); }
.gp__sec-actions { flex: none; display: flex; align-items: center; gap: 1px; }

/* ---------- form ---------- */
.gs__form {
  display: grid;
  gap: var(--space-2);
  margin: 2px 0 var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
}
.gs__input {
  width: 100%;
  height: 28px;
  padding: 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.gs__input::placeholder { color: var(--fg-faint); }
.gs__input:focus-visible { outline: none; }
.gs__input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.gs__undo { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--fg-muted); cursor: pointer; }
.gs__scope { margin: 0; font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--fg-subtle); }
.gs__scope.is-warn { color: var(--ripe-error-fg); }
.gs__btns { display: flex; justify-content: flex-end; gap: var(--space-1); }

/* ---------- list ---------- */
.gs__list { list-style: none; margin: 2px 0 0; padding: 0; display: grid; gap: 1px; }
.gs__item { min-width: 0; }
.gs__row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 40px;
  padding: 0 3px 0 var(--space-1);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.gs__row:hover, .gs__row:has(:focus-visible) { background: var(--bg-hover); }
.gs__item.is-confirming > .gs__row { background: var(--bg-active); }
.gs__text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.gs__subject {
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs__meta { display: flex; align-items: center; gap: var(--space-2); min-width: 0; font-size: var(--text-2xs); color: var(--fg-faint); }
.gs__id { flex: none; font-family: var(--font-mono); }
.gs__branch {
  flex: 0 1 auto;
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs__when { flex: none; margin-left: auto; }
.gs__actions { flex: none; display: none; align-items: center; gap: 1px; }
.gs__row:hover .gs__actions, .gs__row:has(:focus-visible) .gs__actions { display: flex; }

.gs__confirm {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 2px 0 var(--space-1);
  padding: var(--space-1) 3px var(--space-1) var(--space-2);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 35%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--ripe-error) 8%, transparent);
}
.gs__ask { flex: 1; min-width: 0; font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--fg-muted); }
.gs__yes {
  flex: none;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  border: 1px solid color-mix(in oklch, var(--ripe-error) 45%, transparent);
  font-size: var(--text-xs);
  font-weight: 560;
  color: var(--ripe-error-fg);
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out);
}
.gs__yes:hover:not(:disabled) { background: color-mix(in oklch, var(--ripe-error) 14%, transparent); }
.gs__yes:disabled { opacity: 0.55; }

.gs__quiet { margin: 0; padding: var(--space-2) var(--space-2) var(--space-2) var(--space-1); font-size: var(--text-xs); line-height: var(--leading-normal); color: var(--fg-subtle); }
.gs__quiet.is-error { color: var(--ripe-error-fg); }
</style>
