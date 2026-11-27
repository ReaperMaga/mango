import type { Ref } from 'vue'
import type { GitGraphCommit } from '~/types/ipc'
import { formatLocale, t } from '~/i18n'
import { call } from '~/composables/useBackend'
import { gitLogError, useGitLog } from '~/stores/gitLog'
import { useGit } from '~/stores/git'
import { createLaneLayout, looksLikeHash, parseLogQuery, type GraphRow } from '~/utils/gitLog'
import { vcsTerms } from '~/utils/vcs'

/*
 * The Git log view's state: what is loaded (a page at a time), the filters, search and jumps, the selection,
 * and the virtualised list's measures. GitLogPanel draws it; `stores/gitLog.ts` has the actions on a commit.
 */

const PAGE = 300
/** The most `git_graph` gives at once. */
const PAGE_MAX = 1000
/** How far back a jump reads before it gives up and shows the commit's details alone. */
const JUMP_CAP = 5000
/** Rows drawn above and below those in view. */
const OVERSCAN = 8

/** The branch filter's "current branch": whatever is checked out (git follows HEAD, so a checkout needs no new choice; Lore reads it as the working tree's branch). */
export const CURRENT_BRANCH = 'HEAD'
/** The branch filter's default, for every folder: all branches (null). */
const DEFAULT_REFS: string | null = null

/** Under this list width the rows fold into two lines. */
const NARROW = 520
/** From this list width the author has a column. */
const AUTHOR_COLUMN = 620
/** From this width the details sit beside the list; under it they take its place. */
const SIDE_BY_SIDE = 760

interface Options {
  path: () => string | null
  visible: () => boolean
  root: Readonly<Ref<HTMLElement | null>>
  scroller: Readonly<Ref<HTMLElement | null>>
}

export function useGitLogView({ path, visible, root, scroller }: Options) {
  const log = useGitLog()
  const git = useGit()

  const phase = ref<'none' | 'loading' | 'ready' | 'error' | 'notRepo' | 'unity'>('loading')
  const error = ref('')
  const notice = ref('')
  const commits = shallowRef<GitGraphCommit[]>([])
  const rows = shallowRef<GraphRow[]>([])
  const lanes = ref(1)
  const more = ref(false)
  const loadingMore = ref(false)
  const refreshing = ref(false)
  const head = ref<string | null>(null)
  const branch = ref<string | null>(null)
  const selected = ref<string | null>(null)
  /** The commit the details show: the selection, or one the log can't show (filtered out, very old). */
  const shownHash = ref<string | null>(null)
  const detailOpen = ref(false)

  const query = ref('')
  const applied = ref({ text: '', author: '' })
  const author = ref('')
  /** `CURRENT_BRANCH`, null for every branch (the default), or one ref. Not kept: each folder starts at the default. */
  const refFilter = ref<string | null>(DEFAULT_REFS)

  const rootWidth = ref(1000)
  const listWidth = ref(800)
  const viewHeight = ref(0)
  const scrollTop = ref(0)

  const narrow = computed(() => listWidth.value < NARROW)
  const showAuthor = computed(() => listWidth.value >= AUTHOR_COLUMN)
  const sideBySide = computed(() => rootWidth.value >= SIDE_BY_SIDE)
  const rowHeight = computed(() => (narrow.value ? 40 : 26))
  /** Searched, or one author's: a plain list, as the commits between are missing. */
  const flat = computed(() => !!(applied.value.text || applied.value.author))
  const index = computed(() => new Map(commits.value.map((c, i) => [c.hash, i])))
  const inView = computed(() => {
    const start = Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - OVERSCAN)
    const end = Math.ceil((scrollTop.value + (viewHeight.value || 400)) / rowHeight.value) + OVERSCAN
    return commits.value.slice(start, end).map((commit, i) => ({
      commit,
      index: start + i,
      row: flat.value ? null : rows.value[start + i] ?? null,
    }))
  })

  let layout = createLaneLayout()
  /** Bumped by every load and folder change: an answer to an older one is dropped. */
  let token = 0
  /** The folder the list holds. */
  let loadedPath: string | null | undefined
  /** Something changed while the tab was hidden: refresh when it shows. */
  let stale = false
  /** A jump that waits for the list. */
  let pendingJump: string | null = null
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  /* ---------- the list ---------- */

  function setCommits(list: GitGraphCommit[], hasMore: boolean) {
    layout = createLaneLayout()
    const placed = flat.value ? [] : list.map(layout.place)
    commits.value = list
    rows.value = placed
    lanes.value = placed.reduce((max, r) => Math.max(max, r.width), 1)
    more.value = hasMore && list.length > 0
  }

  function appendCommits(list: GitGraphCommit[]) {
    const placed = flat.value ? [] : list.map(layout.place)
    commits.value = commits.value.concat(list)
    rows.value = rows.value.concat(placed)
    lanes.value = placed.reduce((max, r) => Math.max(max, r.width), lanes.value)
  }

  function readGraph(folder: string, skip: number, limit: number) {
    return call('git_graph', {
      path: folder,
      refs: refFilter.value ? [refFilter.value] : null,
      skip,
      limit,
      text: applied.value.text || null,
      author: applied.value.author || null,
    })
  }

  function setScroll(top: number) {
    const el = scroller.value
    if (!el) return
    el.scrollTop = Math.max(0, top)
    scrollTop.value = el.scrollTop
  }

  async function load({ keep = false } = {}) {
    const folder = path()
    const mine = ++token
    stale = false
    loadedPath = folder
    loadingMore.value = false
    refreshing.value = false
    if (!keep) notice.value = ''
    if (!folder) {
      phase.value = 'none'
      setCommits([], false)
      return
    }
    const keeping = keep && phase.value === 'ready'
    if (keeping) refreshing.value = true
    else phase.value = 'loading'
    try {
      const status = await call('git_status', { path: folder })
      if (mine !== token) return
      if (!status.isRepo || !vcsTerms(status.vcs).log) {
        phase.value = status.isRepo ? 'unity' : 'notRepo'
        setCommits([], false)
        return
      }
      // A refresh reads as far back as was loaded, so the view stays where it is.
      const want = keeping ? Math.max(PAGE, commits.value.length) : PAGE
      const list: GitGraphCommit[] = []
      let hasMore = true
      while (hasMore && list.length < want) {
        const page = await readGraph(folder, list.length, Math.min(PAGE_MAX, want - list.length))
        if (mine !== token) return
        head.value = page.head
        branch.value = page.branch
        list.push(...page.commits)
        hasMore = page.more && page.commits.length > 0
      }
      const top = scrollTop.value
      const at = Math.floor(top / rowHeight.value)
      const anchor = keeping && top >= rowHeight.value / 2 ? commits.value[at]?.hash : undefined
      const offset = top - at * rowHeight.value
      setCommits(list, hasMore)
      phase.value = 'ready'
      if (!keeping) {
        if (!index.value.has(selected.value ?? '')) selected.value = list[0]?.hash ?? null
        shownHash.value = selected.value
      }
      await nextTick()
      if (mine !== token) return
      if (!keeping) setScroll(0)
      else if (anchor && index.value.has(anchor)) setScroll(index.value.get(anchor)! * rowHeight.value + offset)
      refreshing.value = false
      if (pendingJump) {
        const hash = pendingJump
        pendingJump = null
        void jumpTo(hash, true)
      }
      maybeMore()
    } catch (e) {
      if (mine !== token) return
      phase.value = 'error'
      error.value = gitLogError(e)
    } finally {
      if (mine === token) refreshing.value = false
    }
  }

  async function loadMore(): Promise<boolean> {
    const folder = path()
    // A refresh reads the same pages again: it and a next page would race.
    if (!folder || !more.value || loadingMore.value || refreshing.value || phase.value !== 'ready') return false
    const mine = token
    loadingMore.value = true
    try {
      const page = await readGraph(folder, commits.value.length, PAGE)
      if (mine !== token) return false
      appendCommits(page.commits)
      more.value = page.more && page.commits.length > 0
      return page.commits.length > 0
    } catch (e) {
      if (mine === token) {
        more.value = false
        notice.value = t('git.log.moreFailed', { error: gitLogError(e) })
      }
      return false
    } finally {
      if (mine === token) loadingMore.value = false
    }
  }

  function maybeMore() {
    const last = Math.ceil((scrollTop.value + viewHeight.value) / rowHeight.value)
    if (last > commits.value.length - 60) void loadMore()
  }

  function onScroll() {
    scrollTop.value = scroller.value?.scrollTop ?? 0
    maybeMore()
  }

  /* ---------- selection and jumps ---------- */

  function select(i: number, where: 'nearest' | 'center' = 'nearest') {
    const commit = commits.value[i]
    if (!commit) return
    selected.value = commit.hash
    shownHash.value = commit.hash
    const top = i * rowHeight.value
    if (where === 'center') setScroll(top - (viewHeight.value - rowHeight.value) / 2)
    else if (top < scrollTop.value) setScroll(top)
    else if (top + rowHeight.value > scrollTop.value + viewHeight.value) setScroll(top + rowHeight.value - viewHeight.value)
    maybeMore()
  }

  function focusList() {
    void nextTick(() => scroller.value?.focus({ preventScroll: true }))
  }

  async function resolve(folder: string, rev: string): Promise<GitGraphCommit | null> {
    try {
      return (await call('git_graph', { path: folder, refs: [rev], skip: 0, limit: 1 })).commits[0] ?? null
    } catch {
      return null // not a revision here: the callers say so, or search for it as text
    }
  }

  async function jumpTo(target: string, focus = false) {
    const folder = path()
    if (!folder) return
    notice.value = ''
    const want = target.toLowerCase()
    let at = index.value.get(want) ?? commits.value.findIndex(c => c.hash.startsWith(want))
    let full = commits.value[at]?.hash
    if (at < 0) {
      full = (await resolve(folder, target))?.hash
      if (folder !== path()) return
      if (!full) {
        notice.value = t('git.log.noCommit', { target })
        return
      }
      at = index.value.get(full) ?? -1
      while (at < 0 && more.value && commits.value.length < JUMP_CAP) {
        if (!await loadMore()) break
        at = index.value.get(full) ?? -1
      }
      if (folder !== path()) return
    }
    if (at >= 0) {
      detailOpen.value = false
      await nextTick()
      select(at, 'center')
      if (focus) focusList()
      return
    }
    // Outside what the log shows (another branch filter, a search, or very old): the details show it alone.
    selected.value = null
    shownHash.value = full ?? null
    if (!sideBySide.value) detailOpen.value = true
    notice.value = refFilter.value || flat.value
      ? t('git.log.notInView', { commit: full?.slice(0, 7) })
      : t('git.log.tooFar', { commit: full?.slice(0, 7), n: JUMP_CAP.toLocaleString(formatLocale()) })
  }

  async function setRefFilter(name: string | null) {
    if (refFilter.value === name) return
    refFilter.value = name
    await load()
  }

  async function goToRef(name: string) {
    const folder = path()
    if (!folder) return
    const commit = await resolve(folder, name)
    if (folder !== path()) return
    if (!commit) {
      notice.value = t('git.log.refNotFound', { name })
      return
    }
    const onCurrent = refFilter.value === CURRENT_BRANCH && (name === branch.value || name === CURRENT_BRANCH)
    if (refFilter.value && refFilter.value !== name && !onCurrent) await setRefFilter(null)
    if (flat.value) await clearSearch()
    await jumpTo(commit.hash, true)
  }

  /* ---------- search and the author filter ---------- */

  async function applySearch(focus = false) {
    clearTimeout(searchTimer)
    const folder = path()
    if (!folder) return
    const q = query.value.trim()
    notice.value = ''
    if (looksLikeHash(q)) {
      const hit = await resolve(folder, q)
      // Typed on, or moved to another folder, meanwhile.
      if (folder !== path() || q !== query.value.trim()) return
      if (hit?.hash.startsWith(q.toLowerCase())) {
        if (flat.value) {
          applied.value = { text: '', author: '' }
          author.value = ''
          await load()
        }
        await jumpTo(hit.hash, focus)
        return
      }
    }
    const parsed = parseLogQuery(q)
    const next = { text: parsed.text, author: parsed.author || author.value }
    if (next.text !== applied.value.text || next.author !== applied.value.author) {
      applied.value = next
      selected.value = null
      await load()
    }
    if (focus && commits.value.length) focusList()
  }

  function searchSoon() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void applySearch(), 300)
  }

  async function clearSearch() {
    query.value = ''
    author.value = ''
    await applySearch()
  }

  async function setAuthor(name: string) {
    author.value = name
    await applySearch()
  }

  /* ---------- refreshing: only while the tab shows ---------- */

  function refreshSoon(delay: number) {
    if (!visible()) {
      stale = true
      return
    }
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      if (phase.value !== 'loading' && phase.value !== 'none') void load({ keep: true })
    }, delay)
  }

  function refreshNow() {
    clearTimeout(refreshTimer)
    void load({ keep: true })
  }

  function takeJump() {
    const jump = log.jump
    if (!jump || jump.path !== path()) return
    log.jump = null
    const ready = phase.value === 'ready' && loadedPath === jump.path && visible()
    if (ready) void nextTick(() => jumpTo(jump.hash, true))
    else pendingJump = jump.hash
  }

  watch(path, () => {
    token++
    loadedPath = undefined
    pendingJump = null
    clearTimeout(searchTimer)
    clearTimeout(refreshTimer)
    phase.value = 'loading'
    refreshing.value = false
    selected.value = null
    shownHash.value = null
    detailOpen.value = false
    query.value = ''
    author.value = ''
    applied.value = { text: '', author: '' }
    refFilter.value = DEFAULT_REFS
    setCommits([], false)
    takeJump()
    if (visible()) void load()
  })
  watch(visible, (now) => {
    if (!now) return
    takeJump()
    if (loadedPath !== path()) void load()
    else if (stale || pendingJump) void load({ keep: true })
  })
  watch(() => log.jump, takeJump)
  watch(() => log.revision, () => refreshSoon(0))
  // A commit, checkout or pull seen by Mango's own git state moves HEAD.
  watch(() => {
    const status = git.status(path())
    return { folder: path(), at: status ? `${status.head} ${status.branch}` : null }
  }, (now, before) => {
    if (now.folder === before.folder && now.at && before.at && now.at !== before.at) refreshSoon(200)
  })

  takeJump()
  if (visible()) void load()

  const onFocus = () => refreshSoon(150)
  // An agent's turn ended: branches and tags may have moved without HEAD.
  const onFilesChanged = () => refreshSoon(600)

  let frame = 0
  let observer: ResizeObserver | undefined
  function measure() {
    // Hidden (another tab in front) measures nothing: keep the last sizes, or the rows would fold meanwhile.
    if (root.value?.clientWidth) rootWidth.value = root.value.clientWidth
    const el = scroller.value
    if (!el?.clientWidth) return
    listWidth.value = el.clientWidth
    viewHeight.value = el.clientHeight
    // Moving the tab between the panel and the main area resets the element's scroll.
    if (el.scrollTop !== scrollTop.value) setScroll(scrollTop.value)
    maybeMore()
  }

  onMounted(() => {
    window.addEventListener('focus', onFocus)
    window.addEventListener('mango:files-changed', onFilesChanged)
    // Measured on the next frame: changing the layout inside the callback would loop the observer.
    observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    if (root.value) observer.observe(root.value)
    if (scroller.value) observer.observe(scroller.value)
  })
  // The list comes and goes with the narrow details view.
  watch(scroller, (el, old) => {
    if (old) observer?.unobserve(old)
    if (el && observer) {
      observer.observe(el)
      void nextTick(() => setScroll(scrollTop.value))
    }
  })
  onBeforeUnmount(() => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('mango:files-changed', onFilesChanged)
    observer?.disconnect()
    cancelAnimationFrame(frame)
    clearTimeout(searchTimer)
    clearTimeout(refreshTimer)
    token++
  })

  // `reactive`, so the template reads `view.phase` rather than `view.phase.value`.
  return reactive({
    phase, error, notice, commits, lanes, more, loadingMore, refreshing, head, branch, selected, shownHash, detailOpen,
    query, applied, author, refFilter, flat, index, inView,
    rootWidth, viewHeight, narrow, showAuthor, sideBySide, rowHeight,
    onScroll, select, focusList, jumpTo, setRefFilter, goToRef, applySearch, searchSoon, clearSearch, setAuthor, refreshNow,
  })
}
