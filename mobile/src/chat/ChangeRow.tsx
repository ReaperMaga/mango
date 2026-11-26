import { Pressable, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { makeStyles, space, touch, useTheme, type Colors } from '@/theme'
import { Text } from '@/ui'

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

/**
 * One changed file. The same shape as the remote layer's `GitChange` (`src/remote/types.ts`), so
 * the Changes screen passes those straight in; kept structural here so this stays presentational.
 */
export interface ChangeRowFile {
  path: string
  /** For a rename: where it came from. */
  from?: string
  kind: ChangeKind
  staged?: boolean
  additions: number | null
  deletions: number | null
}

const KIND: Record<ChangeKind, { letter: string; word: string; ink: keyof Colors; chip: keyof Colors }> = {
  modified: { letter: 'M', word: 'Modified', ink: 'accentInk', chip: 'chipAccent' },
  renamed: { letter: 'R', word: 'Renamed', ink: 'accentInk', chip: 'chipAccent' },
  added: { letter: 'A', word: 'Added', ink: 'diffAddFg', chip: 'chipAdd' },
  deleted: { letter: 'D', word: 'Deleted', ink: 'diffDelFg', chip: 'chipDel' },
  untracked: { letter: '?', word: 'New file, not tracked yet', ink: 'ripeQueuedFg', chip: 'chipQueued' },
  conflicted: { letter: 'U', word: 'Merge conflict', ink: 'ripeErrorFg', chip: 'chipError' },
}

export interface ChangeRowProps {
  change: ChangeRowFile
  onPress?: () => void
  onLongPress?: () => void
  /** The file whose diff is open beside the list (iPad): Active Wash. */
  selected?: boolean
}

/**
 * A changed file, as the desktop's `GitFileRow.vue`: a kind letter on a 14% tint of its colour, the
 * file name, its folder in faint mono truncated from the left so the nearest folder stays readable,
 * and the +/− counts in the diff inks.
 */
export function ChangeRow({ change, onPress, onLongPress, selected = false }: ChangeRowProps) {
  const t = useTheme()
  const s = useStyles()
  const k = KIND[change.kind]
  const path = change.path.replace(/\/+$/, '')
  const cut = path.lastIndexOf('/')
  const name = path.slice(cut + 1)
  const dir = cut > 0 ? path.slice(0, cut) : ''
  const word = change.kind === 'renamed' && change.from ? `Renamed from ${change.from}` : k.word
  const counts = [
    change.additions ? `${change.additions} added` : '',
    change.deletions ? `${change.deletions} removed` : '',
  ].filter(Boolean).join(', ')

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}${dir ? ` in ${dir}` : ''}. ${word}${change.staged ? ', staged' : ''}${counts ? `. ${counts}` : ''}`}
      accessibilityHint="Opens the diff"
      accessibilityState={{ selected: selected || undefined }}
      style={({ pressed }) => [s.row, (pressed || selected) && s.on]}
    >
      <View style={[s.chip, { backgroundColor: t.colors[k.chip] }]}>
        <Text style={[s.letter, { color: t.colors[k.ink] }]} maxFontSizeMultiplier={1.2}>{k.letter}</Text>
      </View>
      <View style={s.names}>
        <Text
          variant="bodySm"
          numberOfLines={1}
          style={[s.name, change.kind === 'deleted' && s.deleted]}
        >
          {name}
        </Text>
        {dir ? <Text variant="monoSm" tone="faint" numberOfLines={1} ellipsizeMode="head" style={s.dir}>{dir}</Text> : null}
      </View>
      {change.additions || change.deletions
        ? (
            <View style={s.counts}>
              {change.additions ? <Text variant="caption" tabular style={s.add}>+{change.additions}</Text> : null}
              {change.deletions ? <Text variant="caption" tabular style={s.del}>−{change.deletions}</Text> : null}
            </View>
          )
        : null}
      {onPress ? <ChevronRight size={16} strokeWidth={2} color={t.colors.fgFaint} /> : null}
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: touch.row,
    paddingLeft: space[4],
    paddingRight: space[3],
  },
  on: { backgroundColor: t.colors.bgActive },
  chip: { width: 20, height: 20, borderRadius: t.radius.xs, alignItems: 'center', justifyContent: 'center' },
  letter: { ...t.fonts.monoSemibold, fontSize: t.fontSize.monoSm, lineHeight: 14 },
  names: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  name: { flexShrink: 0, maxWidth: '70%', color: t.colors.fg },
  deleted: { color: t.colors.fgSubtle, textDecorationLine: 'line-through', textDecorationColor: t.colors.fgFaint },
  dir: { flex: 1, minWidth: 0 },
  counts: { flexDirection: 'row', gap: 6 },
  add: { color: t.colors.diffAddFg },
  del: { color: t.colors.diffDelFg },
}))
