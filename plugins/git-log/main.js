/**
 * Git log: the project's history as a commit graph in a tool window, in the manner of JetBrains IDEs.
 *
 * Branches and merges are drawn as coloured lanes beside each commit; the list is virtualised (only the rows in
 * view are rendered) and pages in 300 commits at a time as you scroll. Search by text (or `author:name`), jump to a
 * hash, filter by branch or author; the selected commit's message and files sit in a split beside the log, and each
 * file's diff opens in a tab. It lives in the bottom panel beside the terminals.
 *
 * Written with `mango.vue` (defineComponent + h) like the other official plugins: one file, no build step. The
 * helpers above `activate` are pure and exported for tests (`tests/gitLogLanes.test.ts`); importing this file
 * does nothing by itself.
 */

/* ================================================================ pure helpers */

/** How many lane colours there are (`.gitlog-lane-0` … in styles.css). */
export const LANE_COLORS = 5

/**
 * The lane layout over a list of commits in date order (a commit never before its children), one commit at a
 * time, so later pages continue where the earlier ones stopped.
 *
 * `active` holds, per lane, the commit that lane is waiting for. A commit takes the lane waiting for it (the
 * leftmost when several are; the others merge into it), or a free one when nothing waits for it (a branch tip).
 * Its first parent continues in the same lane; each further parent joins a lane already waiting for it, or
 * starts a new one in the leftmost free slot. A slot freed in this row is not reused in the same row, so a lane
 * never both ends and starts in one row.
 *
 * Each row says: `lane` (the node's column) and its `color`; `through`, lanes passing by top to bottom; `up`,
 * lines coming from the top into the node; `down`, lines leaving the node for the bottom (to the parents'
 * lanes); `width`, the columns the row uses. A parent that is not loaded (yet) keeps its lane open, so its line
 * runs off the bottom of the last row and picks up again when the next page comes in.
 */
export function createLaneLayout(colors = LANE_COLORS) {
  /** @type {Array<{ hash: string, color: number } | null>} */
  const active = []
  let nextColor = 0
  const newColor = () => nextColor++ % colors
  const freeSlot = (skip) => {
    for (let i = 0; i < active.length; i++) if (!active[i] && !skip.has(i)) return i
    return active.length
  }

  function place(commit) {
    const hash = commit.hash
    const matching = []
    for (let i = 0; i < active.length; i++) if (active[i] && active[i].hash === hash) matching.push(i)
    const freed = new Set()
    let lane
    let color
    if (matching.length) {
      lane = matching[0]
      color = active[lane].color
    } else {
      lane = freeSlot(freed)
      color = newColor()
    }
    const up = matching.map(i => ({ from: i, color: active[i].color }))
    for (const i of matching) {
      active[i] = null
      if (i !== lane) freed.add(i)
    }
    const through = []
    for (let i = 0; i < active.length; i++) if (active[i] && i !== lane) through.push({ lane: i, color: active[i].color })

    const parents = Array.isArray(commit.parents) ? commit.parents : []
    const down = []
    if (parents.length) {
      active[lane] = { hash: parents[0], color }
      down.push({ to: lane, color })
      const seen = new Set([parents[0]])
      for (const p of parents.slice(1)) {
        if (seen.has(p)) continue
        seen.add(p)
        const j = active.findIndex(s => s && s.hash === p)
        if (j >= 0) {
          down.push({ to: j, color: active[j].color })
          continue
        }
        const slot = freeSlot(freed)
        const c = newColor()
        active[slot] = { hash: p, color: c }
        down.push({ to: slot, color: c })
      }
    } else if (lane < active.length) {
      active[lane] = null
    }
    while (active.length && !active[active.length - 1]) active.pop()

    let width = lane + 1
    for (const t of through) width = Math.max(width, t.lane + 1)
    for (const u of up) width = Math.max(width, u.from + 1)
    for (const d of down) width = Math.max(width, d.to + 1)
    return { lane, color, up, through, down, width }
  }

  return { place, lanes: () => active.length }
}

/** The rows for a whole list at once. */
export function layoutLanes(commits, colors = LANE_COLORS) {
  const layout = createLaneLayout(colors)
  return commits.map(c => layout.place(c))
}

/** A query that may be a commit hash: 4 to 64 hex digits. */
export const looksLikeHash = q => /^[0-9a-f]{4,64}$/i.test(String(q ?? '').trim())

/** The search field's text: `author:name` (or `author:"two words"`) picks the author, the rest is message text. */
export function parseQuery(q) {
  let author = ''
  const text = String(q ?? '').replace(/(?:^|\s)author:(?:"([^"]*)"|(\S+))/i, (_, quoted, word) => {
    author = (quoted ?? word ?? '').trim()
    return ' '
  }).replace(/\s+/g, ' ').trim()
  return { text, author }
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function relativeTime(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  const date = new Date(ts)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A full date and time for tooltips and the detail tab. */
export const fullTime = ts => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * A unified diff as display lines: `hunk` (the @@ line), `add`, `del`, `ctx` with old and new line numbers,
 * and `meta` for what git says about the file (new, deleted, renamed, binary). The `diff --git`, `index`,
 * `---` and `+++` lines are dropped: the tab shows the file already.
 */
export function parseDiff(text) {
  const out = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of String(text ?? '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      out.push({ kind: 'hunk', text: line, old: null, new: null })
      continue
    }
    if (!inHunk || line.startsWith('diff --git ')) {
      inHunk = false
      if (/^(diff --git |index |--- |\+\+\+ )/.test(line) || !line) continue
      out.push({ kind: 'meta', text: line, old: null, new: null })
      continue
    }
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), old: null, new: newNo++ })
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), old: oldNo++, new: null })
    else if (line.startsWith('\\')) out.push({ kind: 'meta', text: line.slice(2), old: null, new: null })
    else if (line.startsWith(' ')) out.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ })
  }
  return out
}

/** A repository-relative path (forward slashes) under a root that may use backslashes. */
export function joinRepoPath(root, rel) {
  const base = String(root ?? '').replace(/[\\/]+$/, '')
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base}${sep}${String(rel ?? '').replace(/^\/+/, '').split('/').join(sep)}`
}

const REF_ORDER = { head: 0, branch: 1, remote: 2, tag: 3 }
/** The checked-out branch (or detached HEAD) first, then branches, remote branches, tags. */
export const sortRefs = refs => [...(refs ?? [])].sort((a, b) =>
  Number(b.current) - Number(a.current) || (REF_ORDER[a.kind] ?? 9) - (REF_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name))

/** The backend has no commit graph yet (an older Mango): its error names the command as unknown. */
export function needsNewerMango(e) {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return /git_(graph|commit_show|commit_diff)/.test(msg) && /not found|unknown|not implemented|not allowed|no such command/i.test(msg)
}

/* ================================================================ the plugin */

const PAGE = 300
/** The branch filter's default: whatever is checked out (git follows HEAD, so a checkout needs no new choice). */
const CURRENT = 'HEAD'
const JUMP_CAP = 5000
const OVERSCAN = 8

/** Lucide icons (ISC licence) as node lists, drawn at 1.75 stroke like Mango's own. */
const ICONS = {
  search: [['path', { d: 'm21 21-4.34-4.34' }], ['circle', { cx: 11, cy: 11, r: 8 }]],
  branch: [['path', { d: 'M15 6a9 9 0 0 0-9 9V3' }], ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }]],
  refresh: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]],
  more: [['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }], ['circle', { cx: 5, cy: 12, r: 1 }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  tag: [['path', { d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z' }], ['circle', { cx: 7.5, cy: 7.5, r: 0.5, fill: 'currentColor' }]],
  cloud: [['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }]],
  locate: [['line', { x1: 2, x2: 5, y1: 12, y2: 12 }], ['line', { x1: 19, x2: 22, y1: 12, y2: 12 }], ['line', { x1: 12, x2: 12, y1: 2, y2: 5 }], ['line', { x1: 12, x2: 12, y1: 19, y2: 22 }], ['circle', { cx: 12, cy: 12, r: 7 }]],
  copy: [['rect', { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
  branchPlus: [['path', { d: 'M6 3v12' }], ['path', { d: 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' }], ['path', { d: 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' }], ['path', { d: 'M15 6a9 9 0 0 0-9 9' }], ['path', { d: 'M18 15v6' }], ['path', { d: 'M21 18h-6' }]],
  file: [['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }], ['path', { d: 'M10 9H8' }], ['path', { d: 'M16 13H8' }], ['path', { d: 'M16 17H8' }]],
  chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  commit: [['circle', { cx: 12, cy: 12, r: 3 }], ['line', { x1: 3, x2: 9, y1: 12, y2: 12 }], ['line', { x1: 15, x2: 21, y1: 12, y2: 12 }]],
  user: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
  back: [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
  open: [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
}

export function activate(mango) {
  // Bottom panel tabs (and the history commands) arrived after 0.1.38: say so instead of failing to start.
  if (!mango.ui.panelTabs) {
    mango.log.warn('This Mango has no bottom panel tabs for plugins; update Mango to use the Git log.')
    mango.ui.toast({ title: 'Git log needs a newer Mango', body: 'Update Mango, then turn the plugin on again.', kind: 'warning' })
    return
  }
  const { defineComponent, h, ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick, reactive, Teleport } = mango.vue

  const call = (cmd, args) => mango.backend.call(cmd, args)
  const errText = e => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e?.message ?? e ?? 'Something went wrong'))
  const folderName = p => String(p ?? '').replace(/^env:\/\/[^/]+\/[^/]+\//, '').split(/[\\/]/).filter(Boolean).pop() ?? ''

  const icon = (name, cls = 'gitlog-icon') => h('svg', {
    class: cls, viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }, (ICONS[name] ?? []).map(([tag, attrs]) => h(tag, attrs)))

  /* ---- shared between the panel tab and the diff tabs ---- */

  /** A request to show a commit in the log: the view showing `path` takes it. */
  const bus = reactive({ jump: null })
  let jumpSeq = 0
  const turnTick = ref(0)
  mango.chat.onTurnEnd(() => { turnTick.value++ })

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text)
      mango.ui.toast({ title: `Copied the ${what}`, kind: 'success', timeout: 1800 })
    } catch (e) {
      mango.ui.toast({ title: `Could not copy the ${what}`, body: errText(e), kind: 'error' })
    }
  }

  const openPanel = () => {
    try {
      mango.ui.panelTabs.open('log')
    } catch (e) {
      mango.log.warn('Could not open the Git log tab:', e)
    }
  }

  /** Show a commit in the log (the panel opens at it). */
  const showInLog = (path, hash) => {
    bus.jump = { path, hash, seq: ++jumpSeq, handled: false }
    openPanel()
  }

  /** A file's diff in a commit, as a main-area tab (one per commit and file). */
  const openDiff = (path, commit, file) => {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1)
    try {
      mango.ui.tabs.open('diff', {
        title: `${name} @ ${commit.shortHash}`,
        key: `${commit.hash}:${file.path}`,
        state: { path, hash: commit.hash, shortHash: commit.shortHash, subject: commit.subject, file: { ...file } },
      })
    } catch (e) {
      mango.ui.toast({ title: `Could not open the diff of ${name}`, body: errText(e), kind: 'error' })
    }
  }

  /** The repository root of a folder (for opening files), read once per folder. */
  const roots = new Map()
  const rootOf = async (path) => {
    if (!roots.has(path)) {
      const st = await call('git_status', { path })
      roots.set(path, st?.root ?? path)
    }
    return roots.get(path)
  }
  const openInEditor = async (path, file) => {
    try {
      mango.workspace.openFile(joinRepoPath(await rootOf(path), file))
    } catch (e) {
      mango.ui.toast({ title: `Could not open ${file}`, body: errText(e), kind: 'error' })
    }
  }

  const afterChange = (path) => {
    mango.git.refresh(path).catch(() => {})
  }

  const refIcon = r => (r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : r.kind === 'head' ? 'commit' : 'branch')
  const refTitle = r => (r.kind === 'head' ? 'Detached HEAD' : r.kind === 'tag' ? `Tag ${r.name}` : r.kind === 'remote' ? `Remote branch ${r.name}` : r.current ? `${r.name}, the checked-out branch` : `Branch ${r.name}`)
  const refChip = r => h('span', { class: ['gitlog-ref', `is-${r.kind}`, r.current && 'is-current'], title: refTitle(r) }, [
    icon(refIcon(r), 'gitlog-ref__icon'),
    h('span', { class: 'gitlog-ref__name' }, r.name),
  ])

  const empty = (title, hint, action) => h('div', { class: 'gitlog-empty', role: 'status' }, [
    h('p', { class: 'gitlog-empty__title' }, title),
    hint ? h('p', { class: 'gitlog-empty__hint' }, hint) : null,
    action ? h('button', { type: 'button', class: 'gitlog-link', onClick: action.run }, action.label) : null,
  ])

  /* ---- a small menu: teleported, fixed, kept inside the view it belongs to ---- */

  const PopMenu = defineComponent({
    name: 'GitLogMenu',
    props: { x: Number, y: Number, items: Array, bounds: Object, label: String, minWidth: Number },
    emits: ['close'],
    setup(props, { emit }) {
      const el = ref(null)
      const pos = ref({ left: props.x, top: props.y, visibility: 'hidden' })
      const actionable = i => props.items[i] && !props.items[i].divider && !props.items[i].group && !props.items[i].disabled
      const active = ref(-1)
      const keyed = ref(false)

      const place = () => {
        const m = el.value
        if (!m) return
        const r = m.getBoundingClientRect()
        const b = props.bounds ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        const right = Math.min(b.right, window.innerWidth) - 4
        const bottom = Math.min(b.bottom, window.innerHeight) - 4
        const left = Math.max(Math.max(b.left, 0) + 4, Math.min(props.x, right - r.width))
        let top = props.y
        if (top + r.height > bottom) top = Math.max(Math.max(b.top, 0) + 4, Math.min(props.y - r.height - 8, bottom - r.height))
        pos.value = { left, top, visibility: 'visible' }
      }
      const close = (restore = false) => emit('close', restore)
      const onDoc = (e) => { if (el.value && !el.value.contains(e.target)) close(false) }
      const onBlur = () => close(false)
      onMounted(() => {
        place()
        // Focus once it is shown: a hidden element can't take it.
        nextTick(() => el.value?.focus({ preventScroll: true }))
        document.addEventListener('pointerdown', onDoc, true)
        window.addEventListener('blur', onBlur)
        window.addEventListener('resize', onBlur)
      })
      onBeforeUnmount(() => {
        document.removeEventListener('pointerdown', onDoc, true)
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('resize', onBlur)
      })

      const run = (item, side = false) => {
        close(true)
        const fn = side ? item.side?.run : item.run
        if (fn) Promise.resolve().then(fn).catch(e => mango.log.error(e))
      }
      const move = (step) => {
        const n = props.items.length
        let i = active.value
        for (let k = 0; k < n; k++) {
          i = i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n
          if (actionable(i)) { active.value = i; break }
        }
        nextTick(() => el.value?.querySelector('.gitlog-menu__item.is-active')?.scrollIntoView({ block: 'nearest' }))
      }
      const onKeydown = (e) => {
        keyed.value = true
        const item = props.items[active.value]
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
        else if (e.key === 'Home') { e.preventDefault(); active.value = -1; move(1) }
        else if (e.key === 'End') { e.preventDefault(); active.value = -1; move(-1) }
        else if ((e.key === 'Enter' || e.key === ' ') && item && actionable(active.value)) { e.preventDefault(); run(item, e.shiftKey && !!item.side) }
        else if (e.key === 'ArrowRight' && item?.side) { e.preventDefault(); run(item, true) }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
        else if (e.key === 'Tab') { e.preventDefault(); close(true) }
      }
      return () => h('div', {
        ref: el,
        class: ['gitlog-menu', keyed.value && 'is-keyed'],
        role: 'menu',
        tabindex: -1,
        'aria-label': props.label,
        style: { left: `${pos.value.left}px`, top: `${pos.value.top}px`, visibility: pos.value.visibility, minWidth: props.minWidth ? `${props.minWidth}px` : undefined },
        onKeydown,
        onContextmenu: e => e.preventDefault(),
      }, props.items.map((item, i) => {
        if (item.divider) return h('div', { key: `d${i}`, class: 'gitlog-menu__sep', role: 'separator' })
        if (item.group) return h('div', { key: `g${i}`, class: 'gitlog-menu__group' }, item.group)
        return h('div', {
          key: `i${i}`,
          class: ['gitlog-menu__item', i === active.value && 'is-active', item.disabled && 'is-disabled'],
          role: item.checked !== undefined ? 'menuitemradio' : 'menuitem',
          'aria-checked': item.checked !== undefined ? String(!!item.checked) : undefined,
          'aria-disabled': item.disabled ? 'true' : undefined,
          onPointermove: () => { if (actionable(i)) { active.value = i; keyed.value = false } },
          onClick: () => { if (actionable(i)) run(item) },
        }, [
          h('span', { class: 'gitlog-menu__icon' }, item.glyph ? icon(item.glyph) : null),
          h('span', { class: ['gitlog-menu__label', item.mono && 'is-mono'], title: item.title ?? item.label }, item.label),
          item.aside ? h('span', { class: ['gitlog-menu__aside', item.asideMono && 'is-mono'], title: item.aside }, item.aside) : null,
          item.side
            ? h('button', {
              type: 'button',
              tabindex: -1,
              class: 'gitlog-menu__side',
              title: item.side.label,
              'aria-label': item.side.label,
              onClick: (e) => { e.stopPropagation(); run(item, true) },
            }, icon(item.side.glyph))
            : item.checked ? h('span', { class: 'gitlog-menu__check' }, icon('check')) : null,
        ])
      }))
    },
  })

  /* ---- the selected commit, in the panel's right-hand split ---- */

  const STATUS_WORD = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' }
  const details = new Map() // `${path}\u0001${hash}` -> GitCommitDetail, the last few

  const CommitPane = defineComponent({
    name: 'GitLogCommitPane',
    props: { path: String, hash: String, back: Boolean },
    emits: ['jump', 'back'],
    setup(props, { emit }) {
      const detail = shallowRef(null)
      const error = ref('')
      const loading = ref(false)
      const active = ref(null)
      const filesEl = ref(null)
      let token = 0
      let timer = null

      async function load() {
        clearTimeout(timer)
        const my = ++token
        error.value = ''
        if (!props.path || !props.hash) { detail.value = null; return }
        const key = `${props.path}\u0001${props.hash}`
        if (details.has(key)) {
          detail.value = details.get(key)
          active.value = detail.value.files[0]?.path ?? null
          return
        }
        loading.value = true
        // Arrowing through the log asks only for the commit it stops on.
        timer = setTimeout(async () => {
          try {
            const d = await call('git_commit_show', { path: props.path, hash: props.hash })
            if (my !== token) return
            details.set(key, d)
            if (details.size > 60) details.delete(details.keys().next().value)
            detail.value = d
            active.value = d.files[0]?.path ?? null
          } catch (e) {
            if (my !== token) return
            detail.value = null
            error.value = needsNewerMango(e) ? 'This needs a newer Mango.' : errText(e)
          } finally {
            if (my === token) loading.value = false
          }
        }, 120)
      }
      watch(() => `${props.path}\u0001${props.hash}`, load, { immediate: true })
      onBeforeUnmount(() => { clearTimeout(timer); token++ })

      const onFilesKey = (e) => {
        const files = detail.value?.files ?? []
        const i = files.findIndex(f => f.path === active.value)
        let next = -1
        if (e.key === 'ArrowDown') next = Math.min(files.length - 1, i + 1)
        else if (e.key === 'ArrowUp') next = Math.max(0, i - 1)
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = files.length - 1
        else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); openDiff(props.path, detail.value, files[i]); return }
        if (next < 0 || next === i) return
        e.preventDefault()
        active.value = files[next].path
        nextTick(() => filesEl.value?.querySelector('.gitlog-file.is-selected')?.scrollIntoView({ block: 'nearest' }))
      }

      const fileRow = (d, f) => {
        const slash = f.path.lastIndexOf('/')
        const dir = slash >= 0 ? f.path.slice(0, slash + 1) : ''
        const st = f.status?.[0] ?? 'M'
        return h('div', {
          key: f.path,
          role: 'option',
          id: `gitlog-file-${d.shortHash}-${f.path}`,
          'aria-selected': String(f.path === active.value),
          class: ['gitlog-file', f.path === active.value && 'is-selected'],
          title: `${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}\nClick to open the diff`,
          onClick: () => {
            active.value = f.path
            openDiff(props.path, d, f)
          },
        }, [
          h('span', { class: ['gitlog-file__st', `is-${st}`], title: STATUS_WORD[st] ?? f.status }, st),
          h('span', { class: 'gitlog-file__path' }, [dir ? h('span', { class: 'gitlog-file__dir' }, dir) : null, h('span', { class: 'gitlog-file__name' }, f.path.slice(slash + 1))]),
          f.additions === null
            ? h('span', { class: 'gitlog-file__bin' }, 'binary')
            : h('span', { class: 'gitlog-file__counts' }, [
              f.additions ? h('span', { class: 'gitlog-add' }, `+${f.additions}`) : null,
              f.deletions ? h('span', { class: 'gitlog-del' }, `−${f.deletions}`) : null,
            ]),
        ])
      }

      return () => {
        const d = detail.value
        const backBtn = props.back
          ? h('button', { type: 'button', class: 'gitlog-back', onClick: () => emit('back') }, [icon('back'), 'Log'])
          : null
        if (error.value) return h('div', { class: 'gitlog-pane' }, [backBtn, empty('Could not read this commit', error.value, { label: 'Try again', run: load })])
        if (!d) return h('div', { class: 'gitlog-pane', 'aria-busy': loading.value ? 'true' : undefined }, [backBtn, loading.value ? h('p', { class: 'gitlog-pane__quiet' }, 'Reading the commit…') : h('p', { class: 'gitlog-pane__quiet' }, 'Select a commit to see its files.')])
        const adds = d.files.reduce((s, f) => s + (f.additions ?? 0), 0)
        const dels = d.files.reduce((s, f) => s + (f.deletions ?? 0), 0)
        const sameCommitter = d.committer === d.author && Math.abs(d.commitTime - d.time) < 60_000
        return h('div', { class: ['gitlog-pane', loading.value && 'is-stale'] }, [
          backBtn,
          h('div', { class: 'gitlog-pane__head' }, [
            h('h2', { class: 'gitlog-pane__subject selectable' }, d.subject || '(no message)'),
            d.refs.length ? h('div', { class: 'gitlog-refs is-wrap' }, sortRefs(d.refs).map(refChip)) : null,
            d.body ? h('p', { class: 'gitlog-pane__body selectable' }, d.body) : null,
            h('dl', { class: 'gitlog-facts' }, [
              h('dt', 'Author'),
              h('dd', { class: 'selectable', title: `${d.author} <${d.authorEmail}>, ${fullTime(d.time)}` }, [h('span', d.author), h('span', { class: 'gitlog-facts__soft' }, `, ${fullTime(d.time)}`)]),
              sameCommitter ? null : h('dt', 'Committer'),
              sameCommitter ? null : h('dd', { class: 'selectable', title: `${d.committer}, ${fullTime(d.commitTime)}` }, [h('span', d.committer), h('span', { class: 'gitlog-facts__soft' }, `, ${fullTime(d.commitTime)}`)]),
              h('dt', 'Commit'),
              h('dd', { class: 'gitlog-facts__line' }, [
                h('span', { class: 'gitlog-mono selectable', title: d.hash }, d.hash),
                h('button', { type: 'button', class: 'gitlog-iconbtn is-small', title: 'Copy hash', 'aria-label': 'Copy hash', onClick: () => copy(d.hash, 'hash') }, icon('copy')),
              ]),
              h('dt', d.parents.length > 1 ? 'Parents' : 'Parent'),
              h('dd', { class: 'gitlog-facts__line' }, d.parents.length
                ? d.parents.map(p => h('button', { type: 'button', class: 'gitlog-hashlink', title: `Go to ${p.slice(0, 7)} in the log`, onClick: () => emit('jump', p) }, p.slice(0, 7)))
                : [h('span', { class: 'gitlog-facts__soft' }, 'None, the first commit')]),
            ]),
          ]),
          h('h3', { class: 'gitlog-files__title' }, [
            `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed`,
            adds ? h('span', { class: 'gitlog-add' }, ` +${adds}`) : null,
            dels ? h('span', { class: 'gitlog-del' }, ` −${dels}`) : null,
          ]),
          d.files.length
            ? h('div', {
              ref: filesEl,
              class: 'gitlog-files',
              role: 'listbox',
              tabindex: 0,
              'aria-label': 'Changed files; Enter opens the diff',
              'aria-activedescendant': active.value ? `gitlog-file-${d.shortHash}-${active.value}` : undefined,
              onKeydown: onFilesKey,
            }, d.files.map(f => fileRow(d, f)))
            : h('p', { class: 'gitlog-pane__quiet' }, d.parents.length > 1 ? 'A merge with no changes of its own against its first parent.' : 'This commit changed no files.'),
        ])
      }
    },
  })

  /* ---- the log: graph, toolbar, search, paging, the split ---- */

  const SPLIT_KEY = 'split-width'
  const AUTHOR_MAX = 40

  const GitLogView = defineComponent({
    name: 'GitLogView',
    props: { path: String, visible: { type: Boolean, default: true } },
    setup(props) {
      const LANE_W = 12
      const PAD = 4

      const rootEl = ref(null)
      const scroller = ref(null)
      const searchEl = ref(null)
      const rootW = ref(1000)
      const listW = ref(800)

      /** none | loading | ready | error | notRepo | unity | newer */
      const phase = ref('loading')
      const message = ref('')
      const commits = shallowRef([])
      const rows = shallowRef([])
      const lanesUsed = ref(1)
      const more = ref(false)
      const loadingMore = ref(false)
      const refreshing = ref(false)
      const head = ref(null)
      const branch = ref(null)
      const selected = ref(null)
      /** The commit the split shows: the selection, or one the log can't show (filtered out, very old). */
      const shown = ref(null)
      const detailOpen = ref(false)
      const query = ref('')
      const applied = ref({ text: '', author: '' })
      const authorFilter = ref('')
      /** What the log shows: `CURRENT` (the default, follows whatever is checked out), null for every branch, or one ref. */
      const refFilter = ref(CURRENT)
      const scrollTop = ref(0)
      const viewH = ref(0)
      const menu = shallowRef(null)
      const notice = ref('')
      const split = ref(Number(mango.storage.get(SPLIT_KEY)) || 380)
      let layout = null
      let token = 0
      /** Something changed while the tab was hidden: refresh when it shows. */
      let stale = false
      let loadedPath = undefined

      /** Wide rows (one line, columns) unless the list is narrow; then two-line rows. */
      const narrow = computed(() => listW.value < 520)
      const RH = computed(() => (narrow.value ? 40 : 26))
      const MAX_LANES = computed(() => (narrow.value ? 8 : 16))
      const showAuthor = computed(() => listW.value >= 620)
      /** The detail sits beside the list from this width; under it, it takes the panel's place. */
      const sideBySide = computed(() => rootW.value >= 760)
      const splitW = computed(() => Math.round(Math.min(Math.max(280, split.value), rootW.value * 0.6)))

      /** The branch filter as the toolbar says it. */
      const filterName = computed(() => (refFilter.value === CURRENT ? branch.value ?? 'Detached HEAD' : refFilter.value ?? 'All branches'))
      const flat = computed(() => !!(applied.value.text || applied.value.author))
      const index = computed(() => {
        const m = new Map()
        commits.value.forEach((c, i) => m.set(c.hash, i))
        return m
      })
      const graphW = computed(() => PAD * 2 + LANE_W * (flat.value ? 1 : Math.min(MAX_LANES.value, Math.max(1, lanesUsed.value))))
      const columns = computed(() => (narrow.value
        ? `${graphW.value}px minmax(0, 1fr) 24px`
        : `${graphW.value}px minmax(0, 1fr)${showAuthor.value ? ' 140px' : ''} 136px 64px 24px`))

      const graphArgs = (skip, limit) => ({
        path: props.path,
        refs: refFilter.value ? [refFilter.value] : null,
        skip,
        limit,
        text: applied.value.text || null,
        author: applied.value.author || null,
      })

      const setCommits = (list, hasMore) => {
        layout = createLaneLayout()
        const r = flat.value ? [] : list.map(c => layout.place(c))
        commits.value = list
        rows.value = r
        lanesUsed.value = r.reduce((m, x) => Math.max(m, x.width), 1)
        more.value = hasMore && list.length > 0
      }
      const appendCommits = (list) => {
        if (!list.length) return
        const r = flat.value || !layout ? [] : list.map(c => layout.place(c))
        commits.value = commits.value.concat(list)
        if (r.length) rows.value = rows.value.concat(r)
        lanesUsed.value = r.reduce((m, x) => Math.max(m, x.width), lanesUsed.value)
      }

      const anchor = () => {
        const i = Math.floor(scrollTop.value / RH.value)
        return { hash: commits.value[i]?.hash ?? null, offset: scrollTop.value - i * RH.value, atTop: scrollTop.value < RH.value / 2 }
      }
      const setScroll = (top) => {
        const el = scroller.value
        if (!el) return
        el.scrollTop = Math.max(0, top)
        scrollTop.value = el.scrollTop
      }

      async function load({ keep = false } = {}) {
        const path = props.path
        const my = ++token
        stale = false
        loadedPath = path
        loadingMore.value = false
        if (!keep) notice.value = ''
        if (!path) {
          phase.value = 'none'
          setCommits([], false)
          return
        }
        const keeping = keep && phase.value === 'ready'
        if (keeping) refreshing.value = true
        else phase.value = 'loading'
        try {
          const st = await call('git_status', { path })
          if (my !== token) return
          if (!st?.isRepo) { phase.value = 'notRepo'; setCommits([], false); return }
          if (st.vcs && st.vcs !== 'git') { phase.value = 'unity'; setCommits([], false); return }
          const want = keeping ? Math.max(PAGE, commits.value.length) : PAGE
          const list = []
          let hasMore = true
          let g = null
          while (list.length < want && hasMore) {
            g = await call('git_graph', graphArgs(list.length, Math.min(1000, want - list.length)))
            if (my !== token) return
            list.push(...g.commits)
            hasMore = !!g.more
            if (!g.commits.length) break
          }
          const at = keeping ? anchor() : null
          head.value = g?.head ?? null
          branch.value = g?.branch ?? null
          setCommits(list, hasMore)
          phase.value = 'ready'
          if (!keeping) {
            selected.value = list.some(c => c.hash === selected.value) ? selected.value : list[0]?.hash ?? null
            shown.value = selected.value
          }
          await nextTick()
          if (at && !at.atTop && at.hash && index.value.has(at.hash)) setScroll(index.value.get(at.hash) * RH.value + at.offset)
          else if (!keeping) setScroll(0)
          if (pendingJump && my === token) {
            const hash = pendingJump
            pendingJump = null
            void jumpTo(hash, { focus: true })
          }
          maybeMore()
        } catch (e) {
          if (my !== token) return
          if (needsNewerMango(e)) phase.value = 'newer'
          else {
            phase.value = 'error'
            message.value = errText(e)
          }
        } finally {
          if (my === token) refreshing.value = false
        }
      }

      async function loadMore() {
        if (!more.value || loadingMore.value || phase.value !== 'ready') return false
        const my = token
        loadingMore.value = true
        try {
          const g = await call('git_graph', graphArgs(commits.value.length, PAGE))
          if (my !== token) return false
          appendCommits(g.commits)
          more.value = !!g.more && g.commits.length > 0
          return g.commits.length > 0
        } catch (e) {
          if (my === token) {
            more.value = false
            notice.value = `Could not read more history: ${errText(e)}`
          }
          return false
        } finally {
          if (my === token) loadingMore.value = false
        }
      }

      const maybeMore = () => {
        const last = Math.ceil((scrollTop.value + viewH.value) / RH.value)
        if (last > commits.value.length - 60) void loadMore()
      }

      /* ---- refresh: folder change, turn end, window focus, a new HEAD; only while showing ---- */

      let refreshTimer = null
      const scheduleRefresh = (delay = 300) => {
        if (!props.visible) { stale = true; return }
        clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
          if (phase.value === 'loading' || phase.value === 'none') return
          void load({ keep: true })
        }, delay)
      }
      const refreshNow = () => {
        clearTimeout(refreshTimer)
        void load({ keep: phase.value === 'ready' })
      }

      let pendingJump = null
      const takeJump = () => {
        const j = bus.jump
        if (!j || j.handled || j.path !== props.path) return
        j.handled = true
        if (phase.value === 'ready' && loadedPath === props.path) void jumpTo(j.hash, { focus: true })
        else pendingJump = j.hash
      }

      watch(() => props.path, () => {
        selected.value = null
        shown.value = null
        detailOpen.value = false
        query.value = ''
        applied.value = { text: '', author: '' }
        authorFilter.value = ''
        refFilter.value = CURRENT
        menu.value = null
        if (props.visible) void load()
        else stale = true
      })
      watch(() => props.visible, (v) => {
        if (!v) return
        if (loadedPath !== props.path) void load()
        else if (stale) void load({ keep: true })
        takeJump()
      })
      watch(turnTick, () => scheduleRefresh(600))
      watch(() => bus.jump, takeJump)
      // Mango's own git state for this folder (read only): a commit, checkout or pull moves HEAD.
      const storeHead = () => {
        try {
          const st = mango.stores?.git?.status?.(props.path)
          return st ? `${st.head ?? ''}\u0001${st.branch ?? ''}` : null
        } catch {
          return null
        }
      }
      watch(storeHead, (now, before) => { if (now && before && now !== before) scheduleRefresh(200) })

      if (props.visible) void load()
      else stale = true
      takeJump()

      const onFocus = () => scheduleRefresh(150)
      let ro = null
      onMounted(() => {
        window.addEventListener('focus', onFocus)
        // Measured on the next frame: changing the layout inside the callback would loop the observer.
        let frame = 0
        ro = new ResizeObserver(() => {
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(() => {
            if (rootEl.value) rootW.value = rootEl.value.clientWidth
            if (scroller.value) {
              listW.value = scroller.value.clientWidth
              viewH.value = scroller.value.clientHeight
            }
            maybeMore()
          })
        })
        if (rootEl.value) ro.observe(rootEl.value)
        if (scroller.value) ro.observe(scroller.value)
      })
      onBeforeUnmount(() => {
        window.removeEventListener('focus', onFocus)
        ro?.disconnect()
        clearTimeout(refreshTimer)
        clearTimeout(searchTimer)
        token++
      })
      // The list element comes and goes with the narrow detail view: observe whichever is there.
      watch(scroller, (el, old) => {
        if (old) ro?.unobserve(old)
        if (el && ro) {
          ro.observe(el)
          nextTick(() => setScroll(scrollTop.value))
        }
      })

      /* ---- selection and jumping ---- */

      const reveal = (i, how = 'nearest') => {
        const top = i * RH.value
        if (how === 'center') setScroll(top - (viewH.value - RH.value) / 2)
        else if (top < scrollTop.value) setScroll(top)
        else if (top + RH.value > scrollTop.value + viewH.value) setScroll(top + RH.value - viewH.value)
      }
      const select = (i, how) => {
        const c = commits.value[i]
        if (!c) return
        selected.value = c.hash
        shown.value = c.hash
        reveal(i, how)
        maybeMore()
      }
      const focusList = () => nextTick(() => scroller.value?.focus({ preventScroll: true }))

      async function resolve(rev) {
        const g = await call('git_graph', { path: props.path, refs: [rev], skip: 0, limit: 1 })
        return g.commits[0] ?? null
      }

      async function jumpTo(target, { focus = false } = {}) {
        notice.value = ''
        const want = String(target).toLowerCase()
        const find = () => (index.value.has(want) ? index.value.get(want) : commits.value.findIndex(c => c.hash.startsWith(want)))
        let i = find()
        let full = i >= 0 ? commits.value[i].hash : null
        if (i < 0) {
          try {
            full = (await resolve(target))?.hash ?? null
          } catch {
            full = null
          }
          if (!full) {
            notice.value = `No commit ${target} in this repository.`
            return false
          }
          i = index.value.get(full) ?? -1
          while (i < 0 && more.value && commits.value.length < JUMP_CAP) {
            if (!(await loadMore())) break
            i = index.value.get(full) ?? -1
          }
        }
        if (i >= 0) {
          select(i, 'center')
          if (!sideBySide.value && detailOpen.value) detailOpen.value = false
          if (focus) focusList()
          return true
        }
        // Outside what the log shows (another branch filter, a search, or very old): the split shows it alone.
        selected.value = null
        shown.value = full
        if (!sideBySide.value) detailOpen.value = true
        notice.value = refFilter.value || flat.value
          ? `${full.slice(0, 7)} is not in this view of the log; its details are on the right.`
          : `${full.slice(0, 7)} is further back than ${JUMP_CAP.toLocaleString()} commits; its details are on the right.`
        return true
      }

      const setFilter = async (name) => {
        if (refFilter.value === name) return
        refFilter.value = name
        await load()
      }
      async function goToRef(name) {
        try {
          const c = await resolve(name)
          if (!c) return
          const here = refFilter.value === CURRENT && (name === branch.value || name === CURRENT)
          if (refFilter.value && refFilter.value !== name && !here) await setFilter(null)
          if (flat.value) await clearSearch()
          await jumpTo(c.hash, { focus: true })
        } catch (e) {
          notice.value = errText(e)
        }
      }

      /* ---- search and the author filter ---- */

      let searchTimer = null
      const nextFilter = () => {
        const q = parseQuery(query.value.trim())
        return { text: q.text, author: q.author || authorFilter.value }
      }
      async function applySearch({ focus = false } = {}) {
        clearTimeout(searchTimer)
        const q = query.value.trim()
        notice.value = ''
        if (looksLikeHash(q)) {
          let hit = null
          try { hit = await resolve(q) } catch { hit = null }
          if (hit && hit.hash.startsWith(q.toLowerCase()) && q === query.value.trim()) {
            if (flat.value) {
              applied.value = { text: '', author: '' }
              authorFilter.value = ''
              await load()
            }
            await jumpTo(hit.hash, { focus })
            return
          }
        }
        const next = nextFilter()
        if (next.text === applied.value.text && next.author === applied.value.author) {
          if (focus && commits.value.length) focusList()
          return
        }
        applied.value = next
        selected.value = null
        await load()
        if (focus && commits.value.length) focusList()
      }
      const clearSearch = async () => {
        query.value = ''
        authorFilter.value = ''
        await applySearch()
      }
      const setAuthor = async (name) => {
        authorFilter.value = name
        await applySearch()
      }
      const onSearchInput = (e) => {
        query.value = e.target.value
        clearTimeout(searchTimer)
        searchTimer = setTimeout(() => void applySearch(), 300)
      }
      const onSearchKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); void applySearch({ focus: true }) }
        else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (query.value) {
            query.value = ''
            void applySearch()
          } else focusList()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (!selected.value && commits.value.length) select(0)
          focusList()
        }
      }

      /* ---- actions ---- */

      const openDetail = (hash) => {
        shown.value = hash
        if (sideBySide.value) nextTick(() => rootEl.value?.querySelector('.gitlog-files')?.focus({ preventScroll: true }))
        else detailOpen.value = true
      }

      async function checkoutBranch(name, remote) {
        const ok = await mango.ui.confirm({
          title: `Check out ${name}?`,
          body: remote
            ? `Switches ${folderName(props.path)} to a local branch tracking ${name} (made if it doesn't exist yet). Git stops if uncommitted changes would be overwritten.`
            : `Switches ${folderName(props.path)} to ${name}. Git stops if uncommitted changes would be overwritten.`,
          confirmLabel: 'Check out',
        })
        if (!ok) return
        try {
          if (remote) {
            const local = await call('git_checkout_remote', { path: props.path, branch: name })
            mango.ui.toast({ title: `Switched to ${local || name}`, kind: 'success' })
          } else {
            await call('git_checkout', { path: props.path, branch: name, create: false })
            mango.ui.toast({ title: `Switched to ${name}`, kind: 'success' })
          }
        } catch (e) {
          mango.ui.toast({ title: `Could not check out ${name}`, body: errText(e), kind: 'error', timeout: 0 })
        } finally {
          afterChange(props.path)
          scheduleRefresh(0)
        }
      }

      /** Check out one commit, leaving HEAD detached (no branch). */
      async function checkoutCommit(c) {
        const ok = await mango.ui.confirm({
          title: `Check out ${c.shortHash}?`,
          body: `Puts ${folderName(props.path)} on "${c.subject}" with no branch checked out (a detached HEAD). Commits made there belong to no branch until you start one. Git stops if uncommitted changes would be overwritten.`,
          confirmLabel: 'Check out',
        })
        if (!ok) return
        try {
          await call('git_checkout_commit', { path: props.path, hash: c.hash })
          mango.ui.toast({ title: `Checked out ${c.shortHash}`, body: 'HEAD is detached.', kind: 'success', action: { label: 'New branch here', run: () => void newBranchAt(c, true) } })
        } catch (e) {
          mango.ui.toast({ title: `Could not check out ${c.shortHash}`, body: needsNewerMango(e) ? 'This needs a newer Mango.' : errText(e), kind: 'error', timeout: 0 })
        } finally {
          afterChange(props.path)
          scheduleRefresh(0)
        }
      }

      async function newBranchAt(c, checkout = false) {
        const name = (await mango.ui.prompt({
          title: 'New branch',
          body: `Starts at ${c.shortHash}, "${c.subject}". Your working copy stays where it is.`,
          placeholder: 'feat/my-change',
        }))?.trim()
        if (!name) return
        try {
          await call('git_branch_create', { path: props.path, name, from: c.hash, checkout })
          mango.ui.toast(checkout
            ? { title: `Switched to ${name}`, kind: 'success' }
            : { title: `Created ${name}`, kind: 'success', action: { label: 'Check out', run: () => void checkoutBranch(name, false) } })
        } catch (e) {
          mango.ui.toast({ title: `Could not create ${name}`, body: errText(e), kind: 'error', timeout: 0 })
        } finally {
          afterChange(props.path)
          scheduleRefresh(0)
        }
      }

      const rowMenuItems = (c) => {
        const items = [
          { label: 'Show details', glyph: 'file', run: () => openDetail(c.hash) },
          { divider: true },
          { label: 'Copy hash', glyph: 'copy', aside: c.shortHash, asideMono: true, run: () => copy(c.hash, 'hash') },
          { label: 'Copy subject', glyph: 'copy', run: () => copy(c.subject, 'subject') },
          { divider: true },
          { label: 'New branch here…', glyph: 'branchPlus', run: () => newBranchAt(c) },
        ]
        // Not offered for the commit HEAD already sits on without a branch.
        if (!(c.hash === head.value && !branch.value)) items.push({ label: 'Check out revision', glyph: 'commit', aside: c.shortHash, asideMono: true, run: () => checkoutCommit(c) })
        const locals = new Set(c.refs.filter(r => r.kind === 'branch').map(r => r.name))
        for (const r of sortRefs(c.refs)) {
          const tracking = r.name.split('/').slice(1).join('/')
          if (r.kind === 'branch' && !r.current) items.push({ label: 'Check out', glyph: 'branch', aside: r.name, asideMono: true, run: () => checkoutBranch(r.name, false) })
          if (r.kind === 'remote' && tracking !== branch.value && !locals.has(tracking)) {
            items.push({ label: 'Check out', glyph: 'cloud', aside: r.name, asideMono: true, run: () => checkoutBranch(r.name, true) })
          }
        }
        return items
      }

      const bounds = () => rootEl.value?.getBoundingClientRect() ?? null
      let returnFocus = null
      const openMenu = (opts) => {
        returnFocus = document.activeElement
        menu.value = { ...opts, bounds: bounds() }
      }
      const closeMenu = (restore) => {
        menu.value = null
        if (restore && returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true })
        returnFocus = null
      }
      const openRowMenu = (i, x, y) => {
        const c = commits.value[i]
        if (!c) return
        selected.value = c.hash
        shown.value = c.hash
        openMenu({ x, y, items: rowMenuItems(c), label: `Commit ${c.shortHash}` })
      }

      async function openBranchMenu(e) {
        const r = e.currentTarget.getBoundingClientRect()
        let list = null
        try { list = await call('git_branch_list', { path: props.path }) } catch { list = null }
        const cur = list?.current ?? branch.value
        const goTo = name => ({ glyph: 'locate', label: `Go to ${name}`, run: () => goToRef(name) })
        const items = [
          { label: 'Current branch', aside: cur ?? 'detached HEAD', asideMono: !!cur, checked: refFilter.value === CURRENT, run: () => setFilter(CURRENT), side: goTo(cur ?? CURRENT) },
          { label: 'All branches', checked: refFilter.value === null, run: () => setFilter(null) },
        ]
        const local = (list?.local ?? []).filter(b => b.name !== cur)
        if (local.length) items.push({ divider: true }, { group: 'Local branches' }, ...local.map(b => ({ label: b.name, mono: true, checked: refFilter.value === b.name, run: () => setFilter(b.name), side: goTo(b.name) })))
        const remote = list?.remote ?? []
        if (remote.length) items.push({ divider: true }, { group: 'Remote branches' }, ...remote.map(b => ({ label: b.name, mono: true, checked: refFilter.value === b.name, run: () => setFilter(b.name), side: goTo(b.name) })))
        openMenu({ x: r.left, y: r.bottom + 4, items, label: 'Branches', minWidth: 220 })
      }

      function openAuthorMenu(e) {
        const r = e.currentTarget.getBoundingClientRect()
        const counts = new Map()
        for (const c of commits.value) counts.set(c.author, (counts.get(c.author) ?? 0) + 1)
        const people = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, AUTHOR_MAX).map(([n]) => n)
        if (authorFilter.value && !people.includes(authorFilter.value)) people.unshift(authorFilter.value)
        const items = [
          { label: 'Any author', checked: !authorFilter.value, run: () => setAuthor('') },
          ...(people.length ? [{ divider: true }, { group: flat.value ? 'Authors' : 'Authors in the loaded history' }] : []),
          ...people.map(n => ({ label: n, checked: authorFilter.value === n, run: () => setAuthor(n) })),
        ]
        openMenu({ x: r.left, y: r.bottom + 4, items, label: 'Authors', minWidth: 200 })
      }

      /* ---- the split ---- */

      const onSplitDown = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const handle = e.currentTarget
        handle.setPointerCapture(e.pointerId)
        const right = rootEl.value.getBoundingClientRect().right
        const move = (ev) => { split.value = Math.round(right - ev.clientX) }
        const up = () => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', up)
          handle.removeEventListener('pointercancel', up)
          split.value = splitW.value
          try { mango.storage.set(SPLIT_KEY, split.value) } catch { /* only a preference */ }
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
        handle.addEventListener('pointercancel', up)
      }
      const onSplitKey = (e) => {
        const step = e.shiftKey ? 48 : 16
        if (e.key === 'ArrowLeft') split.value = splitW.value + step
        else if (e.key === 'ArrowRight') split.value = splitW.value - step
        else return
        e.preventDefault()
        try { mango.storage.set(SPLIT_KEY, splitW.value) } catch { /* only a preference */ }
      }

      /* ---- keyboard ---- */

      const pageRows = () => Math.max(1, Math.floor(viewH.value / RH.value) - 1)
      const onListKey = (e) => {
        const n = commits.value.length
        const i = index.value.get(selected.value) ?? -1
        const mod = e.ctrlKey || e.metaKey
        if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(n - 1, i + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, i - 1)) }
        else if (e.key === 'PageDown') { e.preventDefault(); select(Math.min(n - 1, i + pageRows())) }
        else if (e.key === 'PageUp') { e.preventDefault(); select(Math.max(0, i - pageRows())) }
        else if (e.key === 'Home') { e.preventDefault(); select(0) }
        else if (e.key === 'End') { e.preventDefault(); select(n - 1) }
        else if (e.key === 'Enter' && selected.value) { e.preventDefault(); openDetail(selected.value) }
        else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && i >= 0) {
          e.preventDefault()
          const row = scroller.value?.querySelector(`[data-index="${i}"]`)?.getBoundingClientRect()
          openRowMenu(i, (row?.left ?? 0) + 24, (row?.bottom ?? 0))
        } else if (e.key === 'Escape' && flat.value) { e.preventDefault(); void clearSearch() }
        else if (mod && e.key.toLowerCase() === 'c' && selected.value && !String(window.getSelection?.() ?? '')) { e.preventDefault(); void copy(selected.value, 'hash') }
      }
      const onRootKey = (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          e.stopPropagation()
          if (detailOpen.value) detailOpen.value = false
          nextTick(() => {
            searchEl.value?.focus()
            searchEl.value?.select()
          })
        }
      }

      const onScroll = () => {
        scrollTop.value = scroller.value?.scrollTop ?? 0
        maybeMore()
      }

      /* ---- rendering ---- */

      const laneX = l => PAD + l * LANE_W + LANE_W / 2

      const graphCell = (c, row) => {
        const W = graphW.value
        const H = RH.value
        const cy = H / 2
        const merge = c.parents.length > 1
        const isHead = c.hash === head.value
        const r = 3.5
        const reach = isHead ? r + 2.5 : r
        if (!row) {
          return h('svg', { class: 'gitlog-graph', width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, [
            h('circle', { class: ['gitlog-lane-0 gitlog-node', merge && 'is-merge'], cx: laneX(0), cy, r: merge ? r - 0.5 : r }),
          ])
        }
        const x = laneX(row.lane)
        const kids = []
        const line = (d, color) => kids.push(h('path', { d, class: `gitlog-lane-${color}` }))
        for (const t of row.through) line(`M${laneX(t.lane)} 0V${H}`, t.color)
        for (const u of row.up) {
          const xf = laneX(u.from)
          const end = cy - reach
          line(u.from === row.lane ? `M${x} 0V${end}` : `M${xf} 0C${xf} ${end * 0.55} ${x} ${end * 0.45} ${x} ${end}`, u.color)
        }
        for (const d of row.down) {
          const xt = laneX(d.to)
          const start = cy + reach
          const mid = (start + H) / 2
          line(d.to === row.lane ? `M${x} ${start}V${H}` : `M${x} ${start}C${x} ${mid} ${xt} ${mid} ${xt} ${H}`, d.color)
        }
        kids.push(h('circle', { class: [`gitlog-lane-${row.color} gitlog-node`, merge && 'is-merge'], cx: x, cy, r: merge ? r - 0.5 : r }))
        if (isHead) kids.push(h('circle', { class: `gitlog-lane-${row.color} gitlog-head-ring`, cx: x, cy, r: r + 2.5 }))
        return h('svg', { class: 'gitlog-graph', width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, kids)
      }

      const chips = (refs, max) => {
        if (!refs?.length) return null
        const sorted = sortRefs(refs)
        const rest = sorted.slice(max)
        return h('span', { class: 'gitlog-refs' }, [
          ...sorted.slice(0, max).map(refChip),
          rest.length ? h('span', { class: 'gitlog-ref is-more', title: rest.map(r => r.name).join(', ') }, `+${rest.length}`) : null,
        ])
      }

      const moreButton = (c, i) => h('button', {
        type: 'button',
        class: 'gitlog-row__more',
        tabindex: -1,
        title: 'More actions',
        'aria-label': `More actions for ${c.shortHash}`,
        onClick: (e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          openRowMenu(i, r.left, r.bottom + 4)
        },
        onDblclick: e => e.stopPropagation(),
      }, icon('more'))

      const rowView = (c, i) => {
        const row = flat.value ? null : rows.value[i]
        const isSel = c.hash === selected.value
        const merge = c.parents.length > 1
        const author = h('span', { class: 'gitlog-row__author', title: `${c.author} <${c.authorEmail}>` }, c.author)
        const time = h('span', { class: 'gitlog-row__time', title: fullTime(c.time) }, relativeTime(c.time))
        const hash = h('span', { class: 'gitlog-row__hash' }, c.shortHash)
        const subject = h('span', { class: 'gitlog-row__subject', title: showAuthor.value || narrow.value ? c.subject : `${c.subject}\n${c.author}` }, c.subject)
        return h('div', {
          key: c.hash,
          id: `gitlog-${c.hash}`,
          'data-index': i,
          role: 'option',
          'aria-selected': String(isSel),
          'aria-label': `${c.subject}, ${c.author}, ${relativeTime(c.time)}, ${c.shortHash}${merge ? ', merge commit' : ''}`,
          class: ['gitlog-row', isSel && 'is-selected', merge && 'is-merge'],
          style: { transform: `translateY(${i * RH.value}px)`, height: `${RH.value}px`, gridTemplateColumns: columns.value },
          onClick: () => { select(i); scroller.value?.focus({ preventScroll: true }) },
          onDblclick: () => openDetail(c.hash),
          onContextmenu: (e) => { e.preventDefault(); openRowMenu(i, e.clientX, e.clientY) },
        }, narrow.value
          ? [
            graphCell(c, row),
            h('span', { class: 'gitlog-row__text' }, [
              h('span', { class: 'gitlog-row__main' }, [subject, chips(c.refs, 2)]),
              h('span', { class: 'gitlog-row__meta' }, [author, h('span', { class: 'gitlog-dot', 'aria-hidden': 'true' }, '·'), time, h('span', { class: 'gitlog-dot', 'aria-hidden': 'true' }, '·'), hash]),
            ]),
            moreButton(c, i),
          ]
          : [graphCell(c, row), h('span', { class: 'gitlog-row__main' }, [subject, chips(c.refs, 4)]), showAuthor.value ? author : null, time, hash, moreButton(c, i)])
      }

      const skeleton = () => h('div', { class: 'gitlog-skeleton', 'aria-hidden': 'true' }, Array.from({ length: 8 }, (_, i) =>
        h('div', { class: 'gitlog-skeleton__row', style: { height: `${RH.value}px` } }, [
          h('span', { class: 'gitlog-skeleton__dot' }),
          h('span', { class: 'gitlog-skeleton__bar', style: { width: `${[42, 34, 51, 38, 46, 29, 40, 48][i]}%` } }),
        ])))

      const listBody = () => {
        switch (phase.value) {
          case 'none': return empty('No project open', 'Open a project to see its history.')
          case 'loading': return skeleton()
          case 'notRepo': return empty('Not a git repository', 'This folder has no git history. Initialise it from the Changes tool window to start one.')
          case 'unity': return empty('No graph for Unity Version Control', 'The commit graph reads git history. The Changes tool window lists this workspace\'s changesets.')
          case 'newer': return empty('This needs a newer Mango', 'The Git log plugin reads history through commands this version of Mango does not have yet. Update Mango, then reopen this tab.')
          case 'error': return empty('Could not read the history', message.value, { label: 'Try again', run: refreshNow })
        }
        if (!commits.value.length) {
          if (flat.value) return empty('No commits match', 'Search looks in commit messages; the author filter and author:name narrow it to a person. Escape clears the search.', { label: 'Clear filters', run: () => void clearSearch() })
          if (refFilter.value) return empty(`Nothing on ${filterName.value}`, null, { label: 'Show all branches', run: () => void setFilter(null) })
          return empty('No commits yet', 'The graph fills in after the first commit.')
        }
        const n = commits.value.length
        const rh = RH.value
        const start = Math.max(0, Math.floor(scrollTop.value / rh) - OVERSCAN)
        const end = Math.min(n, Math.ceil((scrollTop.value + (viewH.value || 400)) / rh) + OVERSCAN)
        const visible = []
        for (let i = start; i < end; i++) visible.push(rowView(commits.value[i], i))
        return h('div', { class: 'gitlog-list__inner', style: { height: `${n * rh + (more.value ? rh : 0)}px` } }, [
          ...visible,
          more.value ? h('div', { key: 'more', class: 'gitlog-list__more', style: { transform: `translateY(${n * rh}px)`, height: `${rh}px` } }, loadingMore.value ? 'Reading more history…' : '') : null,
        ])
      }

      const status = () => {
        if (notice.value) return h('p', { class: 'gitlog-note', role: 'status' }, notice.value)
        if (phase.value === 'ready' && flat.value) {
          const what = [applied.value.text && `matching "${applied.value.text}"`, applied.value.author && `by ${applied.value.author}`].filter(Boolean).join(' ')
          return h('p', { class: 'gitlog-note', role: 'status' }, [
            `${commits.value.length}${more.value ? '+' : ''} commit${commits.value.length === 1 && !more.value ? '' : 's'} ${what}`,
            h('button', { type: 'button', class: 'gitlog-link', onClick: () => void clearSearch() }, 'Clear'),
          ])
        }
        return null
      }

      const toolbar = () => h('div', { class: 'gitlog-bar' }, [
        h('label', { class: 'gitlog-search' }, [
          icon('search'),
          h('input', {
            ref: searchEl,
            type: 'text',
            value: query.value,
            placeholder: 'Text or hash',
            spellcheck: false,
            autocomplete: 'off',
            'aria-label': 'Search commits by text or hash',
            title: 'Commit message text, or a hash to jump to. author:name finds an author.',
            onInput: onSearchInput,
            onKeydown: onSearchKey,
          }),
          query.value
            ? h('button', { type: 'button', class: 'gitlog-search__clear', 'aria-label': 'Clear search', title: 'Clear (Esc)', onClick: () => { query.value = ''; void applySearch(); searchEl.value?.focus() } }, icon('x'))
            : null,
        ]),
        h('button', {
          type: 'button',
          class: ['gitlog-filter', refFilter.value !== CURRENT && 'is-set'],
          title: refFilter.value === CURRENT
            ? `Showing the current branch${branch.value ? ` (${branch.value})` : ''}; pick another branch or all of them`
            : refFilter.value ? `Showing ${refFilter.value}` : 'Showing all branches; pick one, or go to a branch',
          'aria-haspopup': 'menu',
          'aria-expanded': String(menu.value?.label === 'Branches'),
          onClick: openBranchMenu,
        }, [
          icon('branch'),
          h('span', { class: ['gitlog-filter__label', refFilter.value && (refFilter.value !== CURRENT || branch.value) && 'is-mono'] }, filterName.value),
          icon('chevron', 'gitlog-icon gitlog-filter__chev'),
        ]),
        h('button', {
          type: 'button',
          class: ['gitlog-filter', authorFilter.value && 'is-set'],
          title: authorFilter.value ? `Commits by ${authorFilter.value}` : 'Show one author\'s commits',
          'aria-haspopup': 'menu',
          'aria-expanded': String(menu.value?.label === 'Authors'),
          onClick: openAuthorMenu,
        }, [
          icon('user'),
          h('span', { class: 'gitlog-filter__label' }, authorFilter.value || 'Any author'),
          icon('chevron', 'gitlog-icon gitlog-filter__chev'),
        ]),
        h('span', { class: 'gitlog-bar__gap' }),
        h('button', { type: 'button', class: ['gitlog-iconbtn', refreshing.value && 'is-busy'], title: 'Refresh', 'aria-label': 'Refresh', onClick: refreshNow }, icon('refresh')),
      ])

      const header = () => (!narrow.value && phase.value === 'ready' && commits.value.length
        ? h('div', { class: 'gitlog-thead', style: { gridTemplateColumns: columns.value }, 'aria-hidden': 'true' }, [
          h('span'), h('span', 'Subject'), showAuthor.value ? h('span', 'Author') : null, h('span', 'Date'), h('span', 'Commit'), h('span'),
        ])
        : null)

      const pane = (back) => h(CommitPane, {
        path: props.path,
        hash: shown.value,
        back,
        onJump: hash => void jumpTo(hash, { focus: true }),
        onBack: () => { detailOpen.value = false; focusList() },
      })

      return () => {
        const showSplit = sideBySide.value && phase.value === 'ready' && !!shown.value
        const onlyDetail = !sideBySide.value && detailOpen.value && !!shown.value
        return h('div', { ref: rootEl, class: 'gitlog', onKeydown: onRootKey }, [
          toolbar(),
          status(),
          onlyDetail
            ? h('div', { class: 'gitlog-body' }, [h('div', { class: 'gitlog-detail is-full' }, [pane(true)])])
            : h('div', { class: 'gitlog-body' }, [
              h('div', { class: 'gitlog-main' }, [
                header(),
                h('div', {
                  ref: scroller,
                  class: 'gitlog-list',
                  role: 'listbox',
                  tabindex: 0,
                  'aria-label': 'Commits',
                  'aria-activedescendant': selected.value && index.value.has(selected.value) ? `gitlog-${selected.value}` : undefined,
                  onScroll,
                  onKeydown: onListKey,
                }, [listBody()]),
              ]),
              showSplit
                ? h('div', {
                  class: 'gitlog-split',
                  role: 'separator',
                  tabindex: 0,
                  'aria-orientation': 'vertical',
                  'aria-label': 'Resize the commit details',
                  'aria-valuenow': splitW.value,
                  onPointerdown: onSplitDown,
                  onKeydown: onSplitKey,
                  onDblclick: () => { split.value = 380; try { mango.storage.set(SPLIT_KEY, 380) } catch { /* only a preference */ } },
                })
                : null,
              showSplit ? h('div', { class: 'gitlog-detail', style: { width: `${splitW.value}px` } }, [pane(false)]) : null,
            ]),
          menu.value
            ? h(Teleport, { to: 'body' }, [h(PopMenu, {
              x: menu.value.x, y: menu.value.y, items: menu.value.items, bounds: menu.value.bounds, label: menu.value.label, minWidth: menu.value.minWidth,
              onClose: closeMenu,
            })])
            : null,
        ])
      }
    },
  })

  /* ---- a file of a commit in a main-area tab ---- */

  const DIFF_CAP = 3000

  const DiffView = defineComponent({
    name: 'GitLogDiff',
    props: ['ctx'],
    setup(props) {
      const state = computed(() => props.ctx?.state ?? null)
      const lines = shallowRef(null)
      const error = ref('')
      const loading = ref(true)
      const showAll = ref(false)
      let token = 0

      async function load() {
        const s = state.value
        const my = ++token
        if (!s?.path || !s.hash || !s.file) { loading.value = false; return }
        loading.value = true
        error.value = ''
        try {
          const text = await call('git_commit_diff', { path: s.path, hash: s.hash, file: s.file.path })
          if (my !== token) return
          lines.value = parseDiff(text)
        } catch (e) {
          if (my !== token) return
          error.value = needsNewerMango(e) ? 'This needs a newer Mango.' : errText(e)
        } finally {
          if (my === token) loading.value = false
        }
      }
      watch(() => (state.value ? `${state.value.path}\u0001${state.value.hash}\u0001${state.value.file?.path}` : ''), load, { immediate: true })

      return () => {
        const s = state.value
        if (!s?.file) return h('div', { class: 'gitlog-diffview' }, [empty('This tab lost its file', 'Mango restarted since it opened. Open the file again from the Git log.')])
        const f = s.file
        const all = lines.value ?? []
        const shownLines = showAll.value ? all : all.slice(0, DIFF_CAP)
        const digits = String(all.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0)).length
        return h('div', { class: 'gitlog-diffview' }, [
          h('header', { class: 'gitlog-diff__head' }, [
            h('span', { class: 'gitlog-diff__path selectable', title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path),
            h('button', {
              type: 'button',
              class: 'gitlog-diff__commit',
              title: `Show ${s.shortHash} in the Git log`,
              onClick: () => showInLog(s.path, s.hash),
            }, [h('span', { class: 'gitlog-mono' }, s.shortHash), h('span', { class: 'gitlog-diff__subject' }, s.subject)]),
            f.additions !== null ? h('span', { class: 'gitlog-file__counts' }, [
              f.additions ? h('span', { class: 'gitlog-add' }, `+${f.additions}`) : null,
              f.deletions ? h('span', { class: 'gitlog-del' }, `−${f.deletions}`) : null,
            ]) : null,
            h('button', {
              type: 'button',
              class: 'gitlog-btn',
              disabled: f.status === 'D',
              title: f.status === 'D' ? 'This commit deleted the file' : 'Open the file as it is in your working copy',
              onClick: () => void openInEditor(s.path, f.path),
            }, [icon('open'), 'Open file']),
          ]),
          loading.value && !lines.value
            ? h('p', { class: 'gitlog-diff__note' }, 'Reading the diff…')
            : error.value
              ? h('p', { class: 'gitlog-diff__note is-error' }, error.value)
              : !all.length
                ? h('p', { class: 'gitlog-diff__note' }, f.additions === null ? 'A binary file; there is no text diff to show.' : 'No changes to show for this file.')
                : h('div', { class: 'gitlog-diff__scroll selectable', tabindex: 0, 'aria-label': `Diff of ${f.path}`, style: { '--gitlog-digits': digits } }, [
                  h('div', { class: 'gitlog-diff__lines' }, shownLines.map((l, i) => h('div', { key: i, class: ['gitlog-dl', `is-${l.kind}`] }, l.kind === 'hunk' || l.kind === 'meta'
                    ? [h('span', { class: 'gitlog-dl__text' }, l.text)]
                    : [
                      h('span', { class: 'gitlog-dl__num' }, l.old ?? ''),
                      h('span', { class: 'gitlog-dl__num' }, l.new ?? ''),
                      h('span', { class: 'gitlog-dl__sign' }, l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '),
                      h('span', { class: 'gitlog-dl__text' }, l.text),
                    ]))),
                  all.length > shownLines.length
                    ? h('button', { type: 'button', class: 'gitlog-diff__all', onClick: () => { showAll.value = true } }, `Show all ${all.length.toLocaleString()} lines`)
                    : null,
                ]),
        ])
      }
    },
  })

  /* ---- registration ---- */

  mango.ui.panelTabs.register({
    id: 'log',
    title: 'Git log',
    icon: 'git-graph',
    view: {
      component: defineComponent({
        name: 'GitLogPanelTab',
        props: ['ctx'],
        setup: props => () => h(GitLogView, { path: props.ctx?.projectPath ?? null, visible: props.ctx?.visible !== false }),
      }),
    },
  })

  mango.ui.tabs.register({ id: 'diff', icon: 'git-commit-horizontal', view: { component: DiffView } })

  mango.commands.register({
    id: 'show',
    title: 'Show Git log',
    icon: 'git-graph',
    keywords: 'history commits graph branches',
    run: openPanel,
  })

  mango.shortcuts.register({ id: 'show', label: 'Show Git log', key: 'Mod+Alt+9', run: openPanel })

  mango.commands.register({
    id: 'go-to-commit',
    title: 'Go to commit…',
    detail: 'Git log',
    icon: 'git-commit-horizontal',
    keywords: 'hash sha revision log',
    when: () => !!mango.workspace.workdir(),
    run: async () => {
      const path = mango.workspace.workdir()
      if (!path) return
      const q = (await mango.ui.prompt({ title: 'Go to commit', placeholder: 'A hash, branch or tag' }))?.trim()
      if (!q) return
      try {
        const g = await call('git_graph', { path, refs: [q], skip: 0, limit: 1 })
        const c = g.commits[0]
        if (!c) throw new Error(`Nothing found for ${q}`)
        showInLog(path, c.hash)
      } catch (e) {
        mango.ui.toast({ title: needsNewerMango(e) ? 'This needs a newer Mango' : `Could not find ${q}`, body: needsNewerMango(e) ? undefined : errText(e), kind: 'warning' })
      }
    },
  })
}
