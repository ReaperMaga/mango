import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import type { DiffLine } from '~/types/chat'
import { fonts, fontSize, makeStyles, radius, space } from '@/theme'
import { Spinner, Text } from '@/ui'

/**
 * A unified diff, as the desktop draws it (`git/GitDiff.vue` in the Changes view, the diff inside
 * `ChatTool.vue` in a chat): line numbers, a sign column, added and removed lines on the diff
 * washes with their text-grade inks, hunk headers as quiet bands. Lines never wrap; the block
 * scrolls sideways. Used by a tool row (`lines`) and by the Changes screen (`text` from git).
 */
export interface ChatDiffProps {
  /** A tool call's diff, already split (`Part.diff`). */
  lines?: DiffLine[]
  /** A file's unified diff as git prints it. `null` while it loads. */
  text?: string | null
  error?: string | null
  /** Take the whole screen (the Changes screen): no frame, scrolls both ways. Otherwise an inline block in the flow. */
  fill?: boolean
  style?: StyleProp<ViewStyle>
}

type Kind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta'
interface Row { kind: Kind; text: string; n: number | null }

/** Rows drawn before the reader asks for the rest: long diffs stay quick to open. */
const PAGE = 400

/** Port of GitDiff.vue's parser (unified diffs only; the phone has no side-by-side view). */
function parseGit(source: string) {
  const rows: Row[] = []
  let binary = false
  let truncated = false
  let renamedFrom: string | null = null
  let created = false
  let inHunk = false
  let columns = 1
  let oldN = 0
  let newN = 0
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
      rows.push({ kind: 'hunk', text: line, n: null })
      continue
    }
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) { inHunk = false; continue }
    if (!inHunk) {
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') binary = true
      else if (line.startsWith('rename from ')) renamedFrom = line.slice('rename from '.length)
      else if (line.startsWith('new file mode ')) created = true
      continue
    }
    if (line.startsWith('\\')) { rows.push({ kind: 'meta', text: line.replace(/^\\ ?/, ''), n: null }); continue }
    const marks = line.slice(0, columns)
    const kind: Kind = marks.includes('+') ? 'add' : marks.includes('-') ? 'del' : 'ctx'
    let n: number | null = null
    if (columns === 1) {
      n = kind === 'del' ? oldN : newN
      if (kind !== 'add') oldN++
      if (kind !== 'del') newN++
    }
    rows.push({ kind, text: line.slice(columns), n })
  }
  return { rows, binary, truncated, renamedFrom, created }
}

/** A tool's lines carry no numbers; when its hunk headers have ranges, count from them. */
function numberLines(lines: DiffLine[]): Row[] {
  let oldN = 0
  let newN = 0
  let known = false
  return lines.map((l) => {
    if (l.kind === 'hunk') {
      const m = l.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      known = !!m
      if (m) { oldN = Number(m[1]); newN = Number(m[2]) }
      return { kind: 'hunk', text: l.text, n: null }
    }
    if (!known) return { kind: l.kind, text: l.text, n: null }
    const n = l.kind === 'del' ? oldN : newN
    if (l.kind !== 'add') oldN++
    if (l.kind !== 'del') newN++
    return { kind: l.kind, text: l.text, n }
  })
}

const SIGN: Record<Kind, string> = { add: '+', del: '−', ctx: ' ', hunk: '', meta: '' }
/** JetBrains Mono's advance is 0.6em. */
const CH = fontSize.mono * 0.6

export function ChatDiff({ lines, text, error, fill = false, style }: ChatDiffProps) {
  const s = useStyles()
  const [shown, setShown] = useState(PAGE)

  const parsed = useMemo(() => {
    if (lines) return { rows: numberLines(lines), binary: false, truncated: false, renamedFrom: null, created: false }
    return parseGit(text ?? '')
  }, [lines, text])

  const widest = parsed.rows.reduce((w, r) => (r.n !== null && r.n > w ? r.n : w), 0)
  const numbered = widest > 0
  const numWidth = Math.max(2, String(widest).length) * CH + space[3]
  const visible = parsed.rows.slice(0, shown)
  const rest = parsed.rows.length - visible.length

  const notes: { text: string; error?: boolean }[] = []
  if (error) notes.push({ text: error, error: true })
  else if (text === null && !lines) notes.push({ text: '' })
  else {
    if (parsed.renamedFrom) notes.push({ text: `Renamed from ${parsed.renamedFrom}` })
    if (parsed.binary) notes.push({ text: 'Binary file: no text diff to show.' })
    else if (!parsed.rows.length) notes.push({ text: parsed.created ? 'New empty file.' : 'No changes to show.' })
    if (parsed.truncated) notes.push({ text: 'The diff is too long to show in full.' })
  }

  const body = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hscroll} bounces={false}>
      <View style={s.lines} accessibilityLabel="Diff">
        {visible.map((r, i) => (
          <View key={i} style={[s.line, s[r.kind], r.kind === 'hunk' && i === 0 && s.firstHunk]}>
            {r.kind !== 'hunk' && numbered ? <Text style={[s.mono, s.num, { width: numWidth }]}>{r.n ?? ''}</Text> : null}
            {r.kind !== 'hunk' ? <Text style={[s.mono, s.sign, s[`${r.kind}Ink`]]}>{SIGN[r.kind]}</Text> : null}
            <Text selectable style={[s.mono, s.text, s[`${r.kind}Ink`]]}>{r.text || ' '}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  )

  return (
    <View style={[fill ? s.fill : s.box, style]}>
      {notes.map((n, i) => n.text
        ? <Text key={i} variant={n.error ? 'mono' : 'caption'} tone={n.error ? 'error' : 'subtle'} selectable style={[s.note, i > 0 && s.rule]}>{n.text}</Text>
        : <View key={i} style={s.loading}><Spinner size={14} label="Loading the diff" /></View>)}
      {visible.length
        ? fill
          ? <ScrollView style={s.vscroll} contentContainerStyle={s.vpad}>{body}{rest > 0 ? <More rest={rest} onPress={() => setShown(v => v + PAGE * 5)} /> : null}</ScrollView>
          : <View style={[s.inline, notes.length ? s.rule : null]}>{body}{rest > 0 ? <More rest={rest} onPress={() => setShown(v => v + PAGE)} /> : null}</View>
        : null}
    </View>
  )
}

function More({ rest, onPress }: { rest: number; onPress: () => void }) {
  const s = useStyles()
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [s.more, pressed && s.morePressed]}>
      <Text variant="caption" tone="subtle" tabular>Show {rest > PAGE ? `${PAGE} more` : `the last ${rest}`} line{rest === 1 ? '' : 's'}</Text>
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  box: {
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    backgroundColor: t.colors.bgInset,
    overflow: 'hidden',
  },
  fill: { flex: 1, backgroundColor: t.colors.bgInset },
  vscroll: { flex: 1 },
  vpad: { paddingBottom: space[8] },
  inline: {},
  hscroll: { flexGrow: 1 },
  lines: { flexGrow: 1, paddingVertical: 6 },
  line: { flexDirection: 'row', paddingRight: space[3] },
  // Ligatures off, as the desktop's diff: `::` and `->` stay the characters they are.
  mono: { fontFamily: fonts.mono, fontSize: fontSize.mono, lineHeight: Math.round(fontSize.mono * 1.7), fontVariant: ['no-common-ligatures', 'no-contextual'] },
  num: { textAlign: 'right', paddingRight: 2, color: t.colors.fgFaint },
  sign: { width: 18, textAlign: 'center', color: t.colors.fgFaint },
  text: { color: t.colors.fgMuted },
  ctx: {},
  add: { backgroundColor: t.colors.diffAddBg },
  del: { backgroundColor: t.colors.diffDelBg },
  hunk: {
    marginVertical: 4,
    paddingLeft: space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
    backgroundColor: t.colors.bgHover,
  },
  firstHunk: { marginTop: -6, borderTopWidth: 0 },
  meta: {},
  ctxInk: {},
  addInk: { color: t.colors.diffAddFg },
  delInk: { color: t.colors.diffDelFg },
  hunkInk: { color: t.colors.fgFaint },
  metaInk: { color: t.colors.fgFaint },
  note: { paddingHorizontal: space[3], paddingVertical: space[2] },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.lineSoft },
  loading: { padding: space[3], alignItems: 'flex-start' },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.lineSoft },
  morePressed: { backgroundColor: t.colors.bgHover },
}))
