<script setup lang="ts">
/** One file's unified diff, as returned by `git_diff`. */
const props = defineProps<{
  /** null until the first load finishes */
  text: string | null
  error?: string | null
  /** Fill the parent (main pane) instead of sitting in a small inline box. */
  fill?: boolean
  /** Old and new side by side. Falls back to one column when only one side has lines. */
  split?: boolean
}>()

interface Line {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'
  text: string
  /** Line number in the new file (old file for removed lines). */
  n: number | null
  /** Line numbers on each side, for the side-by-side view. */
  o: number | null
  w: number | null
}

/** Rows drawn before the reader asks for the rest. */
const PAGE = 1200

const parsed = computed(() => {
  const lines: Line[] = []
  let binary = false
  let truncated = false
  let renamedFrom: string | null = null
  let created = false
  let modeChanged = false
  let inHunk = false
  // Combined (merge) diffs carry one marker column per parent.
  let columns = 1
  let oldN = 0
  let newN = 0
  let widest = 0

  const source = props.text ?? ''
  const raw = source.split('\n')
  if (raw[raw.length - 1] === '') raw.pop()

  for (const line of raw) {
    if (line.startsWith('\\ Diff truncated')) { truncated = true; continue }
    if (line.startsWith('@@')) {
      const m = line.match(/^(@{2,}) (.+?) @{2,}/)
      columns = m ? m[1]!.length - 1 : 1
      const ranges = m ? m[2]!.split(' ') : []
      oldN = Number.parseInt(ranges[0]?.slice(1) ?? '', 10) || 0
      newN = Number.parseInt(ranges[ranges.length - 1]?.slice(1) ?? '', 10) || 0
      inHunk = true
      lines.push({ kind: 'hunk', text: line, n: null, o: null, w: null })
      continue
    }
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) { inHunk = false; continue }
    if (!inHunk) {
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') binary = true
      else if (line.startsWith('rename from ')) renamedFrom = line.slice('rename from '.length)
      else if (line.startsWith('new file mode ')) created = true
      else if (line.startsWith('old mode ')) modeChanged = true
      continue
    }
    if (line.startsWith('\\')) { lines.push({ kind: 'meta', text: line.replace(/^\\ ?/, ''), n: null, o: null, w: null }); continue }

    const marks = line.slice(0, columns)
    const kind = marks.includes('+') ? 'add' : marks.includes('-') ? 'del' : 'ctx'
    let n: number | null = null
    let o: number | null = null
    let w: number | null = null
    if (columns === 1) {
      n = kind === 'del' ? oldN : newN
      if (kind !== 'add') o = oldN++
      if (kind !== 'del') w = newN++
      widest = Math.max(widest, n)
    }
    lines.push({ kind, text: line.slice(columns), n, o, w })
  }

  return { lines, binary, truncated, renamedFrom, created, modeChanged, digits: Math.max(2, String(widest).length) }
})

const showAll = ref(false)
watch(() => props.text, () => (showAll.value = false))
const visible = computed(() => (showAll.value ? parsed.value.lines : parsed.value.lines.slice(0, PAGE)))
const hidden = computed(() => parsed.value.lines.length - visible.value.length)

/** What to say when there are no lines to draw. */
const empty = computed(() => {
  const p = parsed.value
  if (props.text === null) return props.error ? null : 'Reading diff…'
  if (p.binary) return 'Binary file. Nothing to show as text.'
  if (p.lines.length) return null
  if (p.truncated) return null
  if (p.renamedFrom) return 'Moved without changes to its content.'
  if (p.created) return 'Empty file.'
  if (p.modeChanged) return 'Only the file mode changed.'
  return 'No changes to show.'
})

const sign = { add: '+', del: '−', ctx: ' ', hunk: ' ', meta: ' ' } as const

/* ---------- side by side ---------- */

interface Row { head?: string; left: Line | null; right: Line | null }

/** Pair removed lines with the added lines that replaced them, hunk by hunk. */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const dels: Line[] = []
  const adds: Line[] = []
  const flush = () => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) out.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    dels.length = 0
    adds.length = 0
  }
  for (const l of visible.value) {
    if (l.kind === 'del') { dels.push(l); continue }
    if (l.kind === 'add') { adds.push(l); continue }
    flush()
    if (l.kind === 'hunk' || l.kind === 'meta') out.push({ head: l.text, left: null, right: null })
    else out.push({ left: l, right: l })
  }
  flush()
  return out
})

/** Two columns only help when both sides have something to compare. */
const sideBySide = computed(() => {
  if (!props.split) return false
  const kinds = new Set(parsed.value.lines.map(l => l.kind))
  return kinds.has('add') && kinds.has('del')
})
</script>

<template>
  <div class="gd" :class="{ 'gd--fill': fill }">
    <p v-if="error" class="gd__note gd__note--error selectable" role="alert">{{ error }}</p>
    <p v-if="parsed.renamedFrom" class="gd__note selectable">Renamed from <code>{{ parsed.renamedFrom }}</code></p>
    <p v-if="empty" class="gd__note">{{ empty }}</p>

    <div
      v-if="visible.length && sideBySide"
      class="gd__scroll gd__scroll--split selectable"
      role="table"
      aria-label="Diff, old on the left and new on the right"
      tabindex="0"
      :style="{ '--gd-digits': parsed.digits }"
    >
      <template v-for="(r, i) in rows" :key="i">
        <div v-if="r.head !== undefined" class="gd__head" role="row">{{ r.head }}</div>
        <div v-else class="gd__pair" role="row">
          <div class="gd__side" :class="r.left ? `gd__side--${r.left.kind}` : 'gd__side--none'" role="cell">
            <span class="gd__num tabular" aria-hidden="true">{{ r.left?.o ?? '' }}</span>
            <span class="gd__text">{{ r.left ? (r.left.text || ' ') : '' }}</span>
          </div>
          <div class="gd__side" :class="r.right ? `gd__side--${r.right.kind}` : 'gd__side--none'" role="cell">
            <span class="gd__num tabular" aria-hidden="true">{{ r.right?.w ?? '' }}</span>
            <span class="gd__text">{{ r.right ? (r.right.text || ' ') : '' }}</span>
          </div>
        </div>
      </template>
    </div>

    <div
      v-else-if="visible.length"
      class="gd__scroll selectable"
      role="table"
      aria-label="Diff"
      tabindex="0"
      :style="{ '--gd-digits': parsed.digits }"
    >
      <!-- One box as wide as the longest line, so row tints reach the end when scrolled sideways. -->
      <div class="gd__lines">
        <div v-for="(l, i) in visible" :key="i" class="gd__line" :class="`gd__line--${l.kind}`" role="row">
          <span class="gd__num tabular" aria-hidden="true">{{ l.n ?? '' }}</span>
          <span class="gd__sign" aria-hidden="true">{{ sign[l.kind] }}</span>
          <span class="gd__text" role="cell">{{ l.text || ' ' }}</span>
        </div>
      </div>
    </div>

    <button v-if="hidden > 0" type="button" class="gd__more" @click="showAll = true">
      Show {{ hidden.toLocaleString() }} more lines
    </button>
    <p v-if="parsed.truncated" class="gd__note">Too large to show in full. The diff stops at 400 KB.</p>
  </div>
</template>

<style scoped>
.gd {
  margin: 2px 0 var(--space-2);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  overflow: hidden;
}
.gd__note {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--fg-subtle);
  overflow-wrap: anywhere;
}
.gd__note code { font-size: var(--text-2xs); color: var(--fg-muted); }
.gd__note--error { color: var(--ripe-error-fg); font-family: var(--font-mono); white-space: pre-wrap; }
.gd__note + .gd__scroll, .gd__scroll + .gd__note, .gd__more + .gd__note, .gd__note + .gd__note { border-top: 1px solid var(--line-soft); }

.gd__scroll {
  max-height: 340px;
  padding: 6px 0;
  overflow: auto;
  font-family: var(--font-mono);
  font-variant-ligatures: none;
  font-size: var(--text-xs);
  line-height: 1.7;
  tab-size: 4;
}
.gd__scroll:focus-visible { outline-offset: -2px; border-radius: var(--radius-md); }
.gd__lines { width: max-content; min-width: 100%; }
.gd__line { display: flex; padding-right: var(--space-3); white-space: pre; }
.gd__num {
  flex: none;
  width: calc(var(--gd-digits, 2) * 1ch + var(--space-3));
  padding-right: 2px;
  text-align: right;
  color: var(--fg-faint);
  user-select: none;
  -webkit-user-select: none;
}
.gd__sign {
  flex: none;
  width: 18px;
  text-align: center;
  color: var(--fg-faint);
  user-select: none;
  -webkit-user-select: none;
}
.gd__text { color: var(--fg-muted); }

.gd__line--add { background: var(--diff-add-bg); }
.gd__line--add .gd__sign, .gd__line--add .gd__text { color: var(--diff-add-fg); }
.gd__line--del { background: var(--diff-del-bg); }
.gd__line--del .gd__sign, .gd__line--del .gd__text { color: var(--diff-del-fg); }
.gd__line--hunk { margin: 4px 0; padding-left: var(--space-3); border-block: 1px solid var(--line-soft); background: var(--bg-hover); }
.gd__line--hunk:first-child { margin-top: -6px; border-top: 0; }
.gd__line--hunk .gd__num, .gd__line--hunk .gd__sign { display: none; }
.gd__line--hunk .gd__text, .gd__line--meta .gd__text { color: var(--fg-faint); }

/* ---------- main pane (fill) ---------- */
.gd--fill {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
}
.gd--fill .gd__scroll { flex: 1; min-height: 0; max-height: none; font-size: var(--text-sm); }
.gd--fill .gd__scroll:focus-visible { border-radius: 0; }

/* ---------- side by side ---------- */
.gd__scroll--split { padding: 0 0 6px; }
.gd__pair { display: grid; grid-template-columns: 1fr 1fr; }
.gd__side {
  display: flex;
  min-width: 0;
  padding-right: var(--space-3);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.gd__side + .gd__side { border-left: 1px solid var(--line-soft); }
.gd__side .gd__num { margin-right: var(--space-3); }
.gd__side--del { background: var(--diff-del-bg); }
.gd__side--del .gd__text { color: var(--diff-del-fg); }
.gd__side--add { background: var(--diff-add-bg); }
.gd__side--add .gd__text { color: var(--diff-add-fg); }
/* The side with no counterpart: a quiet hatch-free blank, slightly sunk. */
.gd__side--none { background: var(--bg-hover); }
.gd__head {
  padding: 2px var(--space-3);
  border-block: 1px solid var(--line-soft);
  background: var(--bg-hover);
  color: var(--fg-faint);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.gd__head:first-child { border-top: 0; }

.gd__more {
  display: block;
  width: 100%;
  height: 28px;
  border-top: 1px solid var(--line-soft);
  font-size: var(--text-xs);
  color: var(--fg-subtle);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.gd__more:hover { background: var(--bg-hover); color: var(--fg); }
</style>
