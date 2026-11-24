<script setup lang="ts">
import {
  ChevronDown, Cloud, Copy, Ellipsis, FileText, GitBranch, GitBranchPlus, GitCommitHorizontal, Locate, RefreshCw, Search, User, X,
} from 'lucide-vue-next'
import type { GitBranchList, GitGraphCommit } from '~/types/ipc'
import type { MenuItem } from '~/types/ui'
import { CURRENT_BRANCH, useGitLogView } from '~/composables/useGitLogView'
import { holdOverlay } from '~/composables/useOverlay'
import { useGitLog } from '~/stores/gitLog'
import { useGit } from '~/stores/git'
import { useWorkspace } from '~/stores/workspace'
import { sortGitRefs } from '~/utils/gitLog'
import { fullDateTime, longAgo, useNow } from '~/utils/time'

/**
 * The Git log, a tab of the bottom panel: the history of the folder in view as a commit graph, a line a
 * commit, with the selected commit's details beside it. `useGitLogView` holds its state; the list draws
 * only the rows in view.
 */
const props = defineProps<{ path: string | null; visible: boolean }>()

const { t } = useI18n()
const ws = useWorkspace()
const log = useGitLog()
const git = useGit()
const now = useNow()

const root = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const commitPane = ref<{ focusFiles: () => void } | null>(null)
const view = useGitLogView({ path: () => props.path, visible: () => props.visible, root, scroller })

const LANE = 12
const AUTHORS_MAX = 40
const SKELETON = [42, 34, 51, 38, 46, 29, 40, 48]

const graphWidth = computed(() => 8 + LANE * (view.flat ? 1 : Math.min(view.narrow ? 8 : 16, view.lanes)))
const columns = computed(() => (view.narrow
  ? `${graphWidth.value}px minmax(0, 1fr) 24px`
  : `${graphWidth.value}px minmax(0, 1fr)${view.showAuthor ? ' 140px' : ''} 136px 64px 24px`))
const listHeight = computed(() => (view.commits.length + Number(view.more)) * view.rowHeight)

/** The branch filter as the toolbar says it. */
const filterName = computed(() =>
  (view.refFilter === CURRENT_BRANCH ? view.branch ?? t('git.refs.head') : view.refFilter ?? t('git.log.allBranches')))
const filterIsBranch = computed(() => !!view.refFilter && (view.refFilter !== CURRENT_BRANCH || !!view.branch))
const filterTitle = computed(() => {
  if (view.refFilter === CURRENT_BRANCH) return view.branch ? t('git.log.showingCurrentNamed', { branch: view.branch }) : t('git.log.showingCurrent')
  return view.refFilter ? t('git.log.showing', { ref: view.refFilter }) : t('git.log.showingAll')
})

const searchSummary = computed(() => {
  if (view.phase !== 'ready' || !view.flat) return ''
  const count = view.commits.length
  const { text, author } = view.applied
  const n = `${count}${view.more ? '+' : ''}`
  // "1+" is more than one.
  const plural = view.more ? Math.max(2, count) : count
  if (text && author) return t('git.log.foundBoth', { n, text, author }, plural)
  return text ? t('git.log.foundText', { n, text }, plural) : t('git.log.foundAuthor', { n, author }, plural)
})

const empty = computed<{ title: string; hint?: string; action?: { label: string; run: () => void } } | null>(() => {
  switch (view.phase) {
    case 'none': return { title: t('git.log.noProject'), hint: t('git.log.noProjectHint') }
    case 'notRepo': return { title: t('git.log.notRepo'), hint: t('git.log.notRepoHint') }
    case 'unity': return { title: t('git.log.unity'), hint: t('git.log.unityHint') }
    case 'error': return { title: t('git.log.couldNotRead'), hint: view.error, action: { label: t('common.actions.retry'), run: view.refreshNow } }
    case 'loading': return null
  }
  if (view.commits.length) return null
  if (view.flat) {
    return {
      title: t('git.log.noMatch'),
      hint: t('git.log.noMatchHint'),
      action: { label: t('git.log.clearFilters'), run: () => void view.clearSearch() },
    }
  }
  if (view.refFilter && view.refFilter !== CURRENT_BRANCH) {
    return { title: t('git.log.nothingOn', { ref: filterName.value }), action: { label: t('git.log.showAll'), run: () => void view.setRefFilter(null) } }
  }
  return { title: t('git.noCommits'), hint: t('git.log.noCommitsHint') }
})

/* ---------- details ---------- */

const onlyDetail = computed(() => !view.sideBySide && view.detailOpen && !!view.shownHash && !!props.path)
const showSplit = computed(() => view.sideBySide && view.phase === 'ready' && !!view.shownHash && !!props.path)
const shownRefs = computed(() => view.commits[view.index.get(view.shownHash ?? '') ?? -1]?.refs)

function openDetail(hash: string) {
  view.shownHash = hash
  if (view.sideBySide) void nextTick(() => commitPane.value?.focusFiles())
  else view.detailOpen = true
}
function closeDetail() {
  view.detailOpen = false
  view.focusList()
}

/* ---------- the split ---------- */

const DETAIL_MIN = 280
const DETAIL_DEFAULT = 380
const clampDetail = (w: number) => Math.round(Math.min(Math.max(DETAIL_MIN, w), view.rootWidth * 0.6))
const dragWidth = ref<number | null>(null)
const detailWidth = computed(() => clampDetail(dragWidth.value ?? ws.gitLogWidth))
let release = () => {}

function saveWidth(width: number) {
  ws.gitLogWidth = width
  ws.persist()
}
function onSplitDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragWidth.value = detailWidth.value
  // A browser's page would swallow the pointer once it crosses it: the browsers hide during the drag.
  release = holdOverlay()
}
function onSplitMove(e: PointerEvent) {
  if (dragWidth.value === null || !root.value) return
  dragWidth.value = clampDetail(root.value.getBoundingClientRect().right - e.clientX)
}
function onSplitUp() {
  if (dragWidth.value === null) return
  // A plain click (the first of a double click) changes nothing.
  if (dragWidth.value !== clampDetail(ws.gitLogWidth)) saveWidth(dragWidth.value)
  dragWidth.value = null
  release()
}
function onSplitKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 48 : 16
  if (e.key === 'ArrowLeft') saveWidth(clampDetail(detailWidth.value + step))
  else if (e.key === 'ArrowRight') saveWidth(clampDetail(detailWidth.value - step))
  else return
  e.preventDefault()
}
onBeforeUnmount(() => release())

/* ---------- menus ---------- */

const branchList = shallowRef<GitBranchList | null>(null)

async function toggleBranches(toggle: () => void, open: boolean) {
  const path = props.path
  if (open || !path) return toggle()
  branchList.value = git.branchLists[path] ?? null
  const read = git.loadBranchList(path).then((list) => {
    if (path === props.path) branchList.value = list
  }).catch(() => { /* the menu still offers the current branch and all of them */ })
  // The menu picks its side by the rows it has: wait for the first read.
  if (!branchList.value) await read
  if (path === props.path) toggle()
}

const branchItems = computed<MenuItem[]>(() => {
  const current = branchList.value?.current ?? view.branch
  const goTo = (name: string) => ({ label: t('git.log.goTo', { name }), icon: Locate, onSelect: () => void view.goToRef(name) })
  const items: MenuItem[] = [
    {
      label: t('git.branches.current'),
      aside: current ?? t('git.log.detached'),
      asideMono: !!current,
      check: 'radio',
      checked: view.refFilter === CURRENT_BRANCH,
      action: goTo(current ?? CURRENT_BRANCH),
      onSelect: () => void view.setRefFilter(CURRENT_BRANCH),
    },
    { label: t('git.log.allBranches'), check: 'radio', checked: view.refFilter === null, onSelect: () => void view.setRefFilter(null) },
  ]
  const groups = [
    { group: t('git.log.localBranches'), list: branchList.value?.local.filter(b => b.name !== current) ?? [] },
    { group: t('git.log.remoteBranches'), list: branchList.value?.remote ?? [] },
  ]
  for (const { group, list } of groups) {
    list.forEach(({ name }, i) => items.push({
      ...(i === 0 ? { group, divider: true } : {}),
      label: name,
      labelMono: true,
      check: 'radio',
      checked: view.refFilter === name,
      action: goTo(name),
      onSelect: () => void view.setRefFilter(name),
    }))
  }
  return items
})

const authorItems = computed<MenuItem[]>(() => {
  const counts = new Map<string, number>()
  for (const c of view.commits) counts.set(c.author, (counts.get(c.author) ?? 0) + 1)
  const people = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, AUTHORS_MAX).map(([name]) => name)
  if (view.author && !people.includes(view.author)) people.unshift(view.author)
  return [
    { label: t('git.log.anyAuthor'), check: 'radio', checked: !view.author, onSelect: () => void view.setAuthor('') },
    ...people.map((name, i): MenuItem => ({
      ...(i === 0 ? { group: view.flat ? t('git.log.authors') : t('git.log.authorsLoaded'), divider: true } : {}),
      label: name,
      check: 'radio',
      checked: view.author === name,
      onSelect: () => void view.setAuthor(name),
    })),
  ]
})

const rowMenu = ref<{ showAt: (x: number, y: number) => void } | null>(null)
const menuCommit = shallowRef<GitGraphCommit | null>(null)

const rowItems = computed<MenuItem[]>(() => {
  const c = menuCommit.value
  const path = props.path
  if (!c || !path) return []
  const copy = (text: string, what: 'hash' | 'subject') => {
    void log.copy(text, what)
    view.focusList()
  }
  const items: MenuItem[] = [
    { label: t('git.log.showDetails'), icon: FileText, onSelect: () => openDetail(c.hash) },
    { label: t('git.commit.copyHash'), icon: Copy, divider: true, aside: c.shortHash, asideMono: true, onSelect: () => copy(c.hash, 'hash') },
    { label: t('git.log.copySubject'), icon: Copy, onSelect: () => copy(c.subject, 'subject') },
    { label: t('git.log.newBranchHere'), icon: GitBranchPlus, divider: true, onSelect: () => void log.newBranchAt(path, c) },
  ]
  // Not offered for the commit HEAD already sits on without a branch.
  if (c.hash !== view.head || view.branch) {
    items.push({ label: t('git.log.checkoutRevision'), icon: GitCommitHorizontal, aside: c.shortHash, asideMono: true, onSelect: () => log.checkoutCommit(path, c) })
  }
  const locals = new Set(c.refs.filter(r => r.kind === 'branch').map(r => r.name))
  for (const r of sortGitRefs(c.refs)) {
    const tracking = r.name.slice(r.name.indexOf('/') + 1)
    const local = r.kind === 'branch' && !r.current
    const remote = r.kind === 'remote' && tracking !== view.branch && !locals.has(tracking)
    if (!local && !remote) continue
    items.push({ label: t('git.log.checkout'), icon: remote ? Cloud : GitBranch, aside: r.name, asideMono: true, onSelect: () => log.checkoutBranch(path, r.name, remote) })
  }
  return items
})

async function openRowMenu(i: number, x: number, y: number) {
  const commit = view.commits[i]
  if (!commit) return
  // Selected without scrolling: a scroll closes menus.
  view.selected = commit.hash
  view.shownHash = commit.hash
  menuCommit.value = commit
  await nextTick()
  rowMenu.value?.showAt(x, y)
}
function onMore(e: MouseEvent, i: number) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  void openRowMenu(i, box.left, box.bottom + 4)
}

/* ---------- keyboard ---------- */

function onRowClick(i: number) {
  view.select(i)
  scroller.value?.focus({ preventScroll: true })
}

function onListKey(e: KeyboardEvent) {
  const last = view.commits.length - 1
  const at = view.index.get(view.selected ?? '') ?? -1
  const page = Math.max(1, Math.floor(view.viewHeight / view.rowHeight) - 1)
  const moves: Record<string, number> = {
    ArrowDown: at + 1, ArrowUp: at - 1, PageDown: at + page, PageUp: at - page, Home: 0, End: last,
  }
  const to = moves[e.key]
  if (to !== undefined) {
    e.preventDefault()
    view.select(Math.max(0, Math.min(last, to)))
  } else if (e.key === 'Enter' && view.selected) {
    e.preventDefault()
    openDetail(view.selected)
  } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && at >= 0) {
    e.preventDefault()
    const row = scroller.value?.querySelector(`[data-index="${at}"]`)?.getBoundingClientRect()
    void openRowMenu(at, (row?.left ?? 0) + 24, row?.bottom ?? 0)
  } else if (e.key === 'Escape' && view.flat) {
    e.preventDefault()
    void view.clearSearch()
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && view.selected && !String(window.getSelection() ?? '')) {
    e.preventDefault()
    void log.copy(view.selected, 'hash')
  }
}

function onFind(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
  e.preventDefault()
  e.stopPropagation()
  searchInput.value?.focus()
  searchInput.value?.select()
}

function clearQuery() {
  view.query = ''
  void view.applySearch()
  searchInput.value?.focus()
}
function onSearchInput(e: Event) {
  view.query = (e.target as HTMLInputElement).value
  view.searchSoon()
}
function onSearchKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    void view.applySearch(true)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (view.query) clearQuery()
    else view.focusList()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!view.selected) view.select(0)
    view.focusList()
  }
}
</script>

<template>
  <!-- data-own-find: Ctrl/Cmd+F is the log's search here, not the chat's find (useShortcuts). -->
  <div ref="root" class="gl" data-own-find @keydown="onFind">
    <div class="gl__bar">
      <label class="gl__search">
        <Search aria-hidden="true" />
        <input
          ref="searchInput"
          type="text"
          :value="view.query"
          :placeholder="t('git.log.search')"
          spellcheck="false"
          autocomplete="off"
          :aria-label="t('git.log.searchLabel')"
          :title="t('git.log.searchTitle')"
          @input="onSearchInput"
          @keydown="onSearchKey"
        >
        <button v-if="view.query" type="button" class="gl__clear" :aria-label="t('git.log.clearSearch')" :title="t('git.log.clearTitle')" @click="clearQuery"><X /></button>
      </label>

      <UiMenu class="gl__pick" :items="branchItems" :width="240" :max-width="360" :label="t('git.branches.title')">
        <template #default="{ toggle, open }">
          <button
            type="button"
            class="gl__filter"
            :class="{ 'is-set': view.refFilter !== CURRENT_BRANCH, 'is-open': open }"
            :title="filterTitle"
            aria-haspopup="menu"
            :aria-expanded="open"
            @click="toggleBranches(toggle, open)"
          >
            <GitBranch aria-hidden="true" />
            <span class="gl__filter-text" :class="{ 'is-mono': filterIsBranch }">{{ filterName }}</span>
            <ChevronDown class="gl__chevron" aria-hidden="true" />
          </button>
        </template>
      </UiMenu>

      <UiMenu class="gl__pick" :items="authorItems" :width="220" :max-width="360" :label="t('git.log.authors')">
        <template #default="{ toggle, open }">
          <button
            type="button"
            class="gl__filter"
            :class="{ 'is-set': view.author, 'is-open': open }"
            :title="view.author ? t('git.log.byAuthor', { author: view.author }) : t('git.log.oneAuthor')"
            aria-haspopup="menu"
            :aria-expanded="open"
            @click="toggle"
          >
            <User aria-hidden="true" />
            <span class="gl__filter-text">{{ view.author || t('git.log.anyAuthor') }}</span>
            <ChevronDown class="gl__chevron" aria-hidden="true" />
          </button>
        </template>
      </UiMenu>

      <span class="gl__gap" />
      <UiIconButton :label="t('common.actions.refresh')" :class="{ 'gl__busy': view.refreshing }" @click="view.refreshNow()"><RefreshCw /></UiIconButton>
    </div>

    <p v-if="view.notice" class="gl__note" role="status">{{ view.notice }}</p>
    <p v-else-if="searchSummary" class="gl__note" role="status">
      {{ searchSummary }}
      <button type="button" class="gl__link" @click="view.clearSearch()">{{ t('git.log.clear') }}</button>
    </p>

    <div v-if="onlyDetail" class="gl__body">
      <div class="gl__detail is-full">
        <GitLogCommit :path="path!" :hash="view.shownHash!" :refs="shownRefs" back @back="closeDetail" @jump="hash => view.jumpTo(hash, true)" />
      </div>
    </div>
    <div v-else class="gl__body">
      <div class="gl__main">
        <div v-if="!view.narrow && view.phase === 'ready' && view.commits.length" class="gl__head" :style="{ gridTemplateColumns: columns }" aria-hidden="true">
          <span /><span>{{ t('git.log.subject') }}</span><span v-if="view.showAuthor">{{ t('git.log.author') }}</span><span>{{ t('git.log.date') }}</span><span>{{ t('git.log.commit') }}</span><span />
        </div>

        <div
          ref="scroller"
          class="gl__list"
          role="listbox"
          tabindex="0"
          :aria-label="t('git.log.commits')"
          :aria-activedescendant="view.index.has(view.selected ?? '') ? `gitlog-${view.selected}` : undefined"
          @scroll.passive="view.onScroll()"
          @keydown="onListKey"
        >
          <div v-if="empty" class="gl__empty" role="status">
            <p class="gl__empty-title">{{ empty.title }}</p>
            <p v-if="empty.hint" class="gl__empty-hint">{{ empty.hint }}</p>
            <UiButton v-if="empty.action" size="sm" @click="empty.action.run">{{ empty.action.label }}</UiButton>
          </div>
          <div v-else-if="view.phase === 'loading'" aria-hidden="true">
            <div v-for="(w, i) in SKELETON" :key="i" class="gl__skeleton" :style="{ height: `${view.rowHeight}px` }">
              <span class="gl__skeleton-dot" /><span class="gl__skeleton-bar" :style="{ width: `${w}%` }" />
            </div>
          </div>
          <div v-else class="gl__rows" :style="{ height: `${listHeight}px` }">
            <div
              v-for="{ commit: c, index: i, row } in view.inView"
              :id="`gitlog-${c.hash}`"
              :key="c.hash"
              class="gl__row"
              :class="{ 'is-selected': c.hash === view.selected, 'is-merge': c.parents.length > 1 }"
              :style="{ transform: `translateY(${i * view.rowHeight}px)`, height: `${view.rowHeight}px`, gridTemplateColumns: columns }"
              :data-index="i"
              role="option"
              :aria-selected="c.hash === view.selected"
              :aria-label="`${c.subject}, ${c.author}, ${longAgo(c.time, now)}, ${c.shortHash}${c.parents.length > 1 ? `, ${t('git.log.mergeCommit')}` : ''}`"
              @click="onRowClick(i)"
              @dblclick="openDetail(c.hash)"
              @contextmenu.prevent="openRowMenu(i, $event.clientX, $event.clientY)"
            >
              <GitLogGraph :row="row" :width="graphWidth" :height="view.rowHeight" :merge="c.parents.length > 1" :head="c.hash === view.head" />
              <span v-if="view.narrow" class="gl__two">
                <span class="gl__line">
                  <span class="gl__subject" :title="c.subject">{{ c.subject }}</span>
                  <GitLogRefs v-if="c.refs.length" :refs="c.refs" :max="2" />
                </span>
                <span class="gl__meta">
                  <span class="gl__who">{{ c.author }}</span>
                  <span class="gl__dot" aria-hidden="true">·</span>
                  <span class="gl__when tabular" :title="fullDateTime(c.time)">{{ longAgo(c.time, now) }}</span>
                  <span class="gl__dot" aria-hidden="true">·</span>
                  <span class="gl__short">{{ c.shortHash }}</span>
                </span>
              </span>
              <template v-else>
                <span class="gl__line">
                  <span class="gl__subject" :title="view.showAuthor ? c.subject : `${c.subject}\n${c.author}`">{{ c.subject }}</span>
                  <GitLogRefs v-if="c.refs.length" :refs="c.refs" :max="4" />
                </span>
                <span v-if="view.showAuthor" class="gl__cell" :title="`${c.author} <${c.authorEmail}>`">{{ c.author }}</span>
                <span class="gl__cell tabular" :title="fullDateTime(c.time)">{{ longAgo(c.time, now) }}</span>
                <span class="gl__cell gl__short">{{ c.shortHash }}</span>
              </template>
              <button type="button" class="gl__more" tabindex="-1" :title="t('git.log.moreActions')" :aria-label="t('git.log.moreActionsFor', { commit: c.shortHash })" @click.stop="onMore($event, i)" @dblclick.stop>
                <Ellipsis />
              </button>
            </div>
            <div v-if="view.more" class="gl__loading" :style="{ transform: `translateY(${view.commits.length * view.rowHeight}px)`, height: `${view.rowHeight}px` }">
              {{ view.loadingMore ? t('git.log.readingMore') : '' }}
            </div>
          </div>
        </div>
      </div>

      <template v-if="showSplit">
        <div
          class="gl__split"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          :aria-label="t('git.log.resize')"
          :aria-valuenow="detailWidth"
          @pointerdown="onSplitDown"
          @pointermove="onSplitMove"
          @pointerup="onSplitUp"
          @pointercancel="onSplitUp"
          @lostpointercapture="onSplitUp"
          @keydown="onSplitKey"
          @dblclick="saveWidth(DETAIL_DEFAULT)"
        />
        <div class="gl__detail" :style="{ width: `${detailWidth}px` }">
          <GitLogCommit ref="commitPane" :path="path!" :hash="view.shownHash!" :refs="shownRefs" @jump="hash => view.jumpTo(hash, true)" />
        </div>
      </template>
    </div>

    <UiMenu ref="rowMenu" class="gl__context" :items="rowItems" :width="240" :max-width="360" :label="menuCommit ? t('git.log.commitNamed', { commit: menuCommit.shortHash }) : t('git.log.commit')" />
  </div>
</template>

<style scoped>
.gl {
  position: relative;
  height: 100%;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---------- toolbar ---------- */
.gl__bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--line-soft);
}
.gl__search {
  flex: 0 1 320px;
  min-width: 120px;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--space-1) 0 var(--space-2);
  background: var(--bg-inset);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.gl__search:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
.gl__search > svg { flex: none; width: 14px; height: 14px; stroke-width: 1.75; color: var(--fg-subtle); }
.gl__search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg);
  font-size: var(--text-sm);
}
.gl__search input::placeholder { color: var(--fg-faint); }
.gl__search input:focus-visible { outline: none; }
.gl__clear { display: grid; place-items: center; width: 20px; height: 20px; border-radius: var(--radius-xs); color: var(--fg-subtle); }
.gl__clear svg { width: 13px; height: 13px; stroke-width: 1.75; }
.gl__clear:hover { background: var(--bg-hover); color: var(--fg); }

.gl__pick { flex: 0 1 auto; max-width: 180px; }
.gl__filter {
  min-width: 0;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 6px 0 var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  font-weight: 540;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.gl__filter > svg { flex: none; width: 14px; height: 14px; stroke-width: 1.75; }
.gl__filter .gl__chevron { width: 12px; height: 12px; color: var(--fg-faint); }
.gl__filter-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl__filter-text.is-mono { font-family: var(--font-mono); font-size: var(--text-2xs); font-weight: 500; }
.gl__filter:hover, .gl__filter.is-open { background: var(--bg-hover); color: var(--fg); }
.gl__filter.is-set { color: var(--fg); }
.gl__filter.is-set > svg:first-child { color: var(--accent-ink); }
.gl__gap { flex: 1; }
.gl__busy :deep(svg) { animation: gl-spin 900ms linear infinite; }
@keyframes gl-spin { to { transform: rotate(360deg); } }

.gl__note {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  padding: 6px var(--space-3);
  border-bottom: 1px solid var(--line-soft);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  overflow-wrap: anywhere;
}
.gl__link { flex: none; color: var(--accent-ink); font-size: var(--text-xs); font-weight: 560; }
.gl__link:hover { text-decoration: underline; text-underline-offset: 2px; }

/* ---------- body and split ---------- */
.gl__body { flex: 1; min-height: 0; display: flex; }
.gl__main { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.gl__split {
  flex: none;
  position: relative;
  width: 1px;
  background: var(--line-soft);
  cursor: col-resize;
  touch-action: none;
}
/* A 7px grip over the 1px rule. */
.gl__split::before { content: ''; position: absolute; inset: 0 -3px; z-index: 5; }
.gl__split:hover, .gl__split:active, .gl__split:focus-visible { background: var(--accent-line); outline: none; }
.gl__detail { flex: none; min-width: 0; display: flex; flex-direction: column; }
.gl__detail.is-full { flex: 1; }

/* ---------- the list ---------- */
/* Both keep the scrollbar's gutter, so the headings stay over their columns. */
.gl__head, .gl__list { scrollbar-gutter: stable; }
.gl__head {
  flex: none;
  display: grid;
  align-items: center;
  column-gap: var(--space-3);
  height: 26px;
  padding-right: var(--space-2);
  overflow: hidden;
  border-bottom: 1px solid var(--line-soft);
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  font-weight: 560;
}
.gl__list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.gl__list:focus-visible { outline: none; }
.gl__rows { position: relative; }
.gl__row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  align-items: center;
  column-gap: var(--space-3);
  padding-right: var(--space-2);
  contain: layout style;
}
.gl__row:hover { background: var(--bg-hover); }
.gl__row.is-selected { background: var(--bg-active); }
.gl__list:focus-visible .gl__row.is-selected { box-shadow: inset 0 0 0 1px var(--focus-ring); }
.gl__two { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.gl__line { min-width: 0; display: flex; align-items: center; gap: 6px; }
.gl__subject {
  flex: 0 1 auto;
  min-width: 2.5em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
}
.gl__row.is-merge .gl__subject { color: var(--fg-subtle); }
.gl__meta {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 5px;
  color: var(--fg-subtle);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  white-space: nowrap;
}
.gl__who { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gl__when { flex: none; }
.gl__dot { flex: none; color: var(--fg-faint); }
.gl__short { flex: none; font-family: var(--font-mono); }
.gl__meta .gl__short { font-size: var(--text-2xs); color: var(--fg-faint); }
.gl__cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-subtle); font-size: var(--text-xs); }
.gl__more { display: grid; place-items: center; width: 22px; height: 22px; border-radius: var(--radius-xs); color: var(--fg-subtle); opacity: 0; }
.gl__more svg { width: 14px; height: 14px; stroke-width: 1.75; }
.gl__row:hover .gl__more, .gl__row.is-selected .gl__more { opacity: 1; }
.gl__more:hover { background: var(--bg-active); color: var(--fg); }
.gl__loading {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  place-items: center;
  color: var(--fg-faint);
  font-size: var(--text-xs);
}
.gl__context { position: absolute; }

/* ---------- empty, loading ---------- */
.gl__empty { display: grid; justify-items: start; gap: var(--space-1); padding: var(--space-5) var(--space-4); }
.gl__empty-title { margin: 0; color: var(--fg-muted); font-size: var(--text-md); font-weight: 560; }
.gl__empty-hint {
  margin: 0 0 var(--space-1);
  max-width: 44ch;
  color: var(--fg-subtle);
  font-size: var(--text-sm);
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.gl__skeleton { display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-3); }
.gl__skeleton-dot { flex: none; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--line-strong); }
.gl__skeleton-bar { height: 8px; border-radius: var(--radius-xs); background: var(--bg-hover); animation: gl-breathe 1.6s var(--ease-in-out) infinite alternate; }
@keyframes gl-breathe { from { opacity: 0.55; } to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .gl__busy :deep(svg), .gl__skeleton-bar { animation: none; }
}
</style>
