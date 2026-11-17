import { Children, createContext, Fragment, isValidElement, useContext, type ReactNode } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { Check, ChevronRight } from 'lucide-react-native'
import { makeStyles, radius, space, touch, useTheme } from '@/theme'
import { Text } from './Text'

/**
 * An iOS inset grouped list in Mango's grounds: the section is Panel Lift on the canvas (lighter,
 * so it comes forward: the Lightness Ladder Rule), rows are flat inside it and split by soft
 * hairlines that start where the text does. Section headers are plain sentence-case titles, not
 * eyebrows: they name the group and carry no decoration.
 */

/**
 * The ground a list sits on. On the canvas a section is Panel Lift; inside a sheet (Raised) a panel
 * would be a darker surface above a lighter one, so the section stays transparent with a `line`
 * outline, as the desktop does for panels inside a dialog.
 */
export const ListGround = createContext<'canvas' | 'raised'>('canvas')

/** Rows read this to know whether to draw the hairline above them. */
const RowPosition = createContext<{ first: boolean }>({ first: true })

export interface ListSectionProps {
  title?: string
  /** A quiet line under the section: what the rows do, or why one is missing. */
  footer?: string
  /** Something at the right of the title (a count, a small action). */
  aside?: ReactNode
  children: ReactNode
  style?: StyleProp<ViewStyle>
}

export function ListSection({ title, footer, aside, children, style }: ListSectionProps) {
  const s = useStyles()
  const ground = useContext(ListGround)
  const rows = Children.toArray(children)
  return (
    <View style={[s.section, style]}>
      {title || aside ? (
        <View style={s.head}>
          {title ? <Text variant="captionStrong" tone="subtle" style={s.headTitle} accessibilityRole="header">{title}</Text> : <View style={{ flex: 1 }} />}
          {aside}
        </View>
      ) : null}
      <View style={[s.group, ground === 'raised' && s.groupRaised]}>
        {rows.map((row, i) => (
          <RowPosition.Provider key={isValidElement(row) && row.key != null ? row.key : i} value={{ first: i === 0 }}>
            <Fragment>{row}</Fragment>
          </RowPosition.Provider>
        ))}
      </View>
      {footer ? <Text variant="caption" tone="faint" style={s.footer}>{footer}</Text> : null}
    </View>
  )
}

export interface ListRowProps {
  title: string
  /** A second line: meta in subtle ink, or a status word through `subtitleTone`. */
  subtitle?: string
  subtitleTone?: 'subtle' | 'faint' | 'waiting' | 'error' | 'running' | 'queued' | 'done'
  /** The second line is machine text (a branch, a host): mono. */
  subtitleMono?: boolean
  /** Paths, hosts and branches set the title in mono (The Machine Text Rule). */
  mono?: boolean
  /** A 28pt column at the left: an icon, a ripeness dot, an agent mark. */
  leading?: ReactNode
  /** Short text at the right, before the accessory (a count, a value). */
  detail?: string
  /** Something custom at the right instead of the accessory. */
  trailing?: ReactNode
  /** `chevron` for rows that open a screen (the default when pressable), `check` for a picked option. */
  accessory?: 'chevron' | 'check' | 'none'
  destructive?: boolean
  disabled?: boolean
  onPress?: () => void
  onLongPress?: () => void
  accessibilityHint?: string
}

export function ListRow({ title, subtitle, subtitleTone = 'subtle', subtitleMono, mono, leading, detail, trailing, accessory, destructive, disabled, onPress, onLongPress, accessibilityHint }: ListRowProps) {
  const t = useTheme()
  const s = useStyles()
  const { first } = useContext(RowPosition)
  const acc = accessory ?? (onPress ? 'chevron' : 'none')
  const body = (
    <>
      {leading ? <View style={s.leading}>{leading}</View> : null}
      <View style={[s.main, !first && s.rule]}>
        <View style={s.text}>
          <Text
            variant={mono ? 'code' : 'bodySm'}
            tone={destructive ? 'error' : 'fg'}
            numberOfLines={1}
            ellipsizeMode={mono ? 'head' : 'tail'}
          >
            {title}
          </Text>
          {subtitle ? <Text variant={subtitleMono ? 'mono' : 'caption'} tone={subtitleTone} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {detail ? <Text variant="bodySm" tone="subtle" numberOfLines={1} tabular style={s.detail}>{detail}</Text> : null}
        {trailing}
        {acc === 'chevron' ? <ChevronRight size={18} strokeWidth={2} color={t.colors.fgFaint} /> : null}
        {acc === 'check' ? <Check size={18} strokeWidth={2.25} color={t.colors.accentInk} /> : null}
      </View>
    </>
  )
  if (!onPress && !onLongPress) return <View style={[s.row, subtitle ? s.row2 : null]}>{body}</View>
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, selected: acc === 'check' || undefined }}
      style={({ pressed }) => [s.row, subtitle ? s.row2 : null, pressed && s.pressed, disabled && s.disabled]}
    >
      {body}
    </Pressable>
  )
}

const useStyles = makeStyles(t => ({
  section: { gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', minHeight: 24, paddingHorizontal: space[4] },
  headTitle: { flex: 1 },
  group: {
    backgroundColor: t.colors.bgPanel,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.lineSoft,
    overflow: 'hidden',
  },
  groupRaised: { backgroundColor: 'transparent', borderWidth: 1, borderColor: t.colors.line },
  footer: { paddingHorizontal: space[4] },
  row: { flexDirection: 'row', alignItems: 'stretch', minHeight: touch.row, paddingLeft: space[4] },
  row2: { minHeight: touch.row2 - 4 },
  pressed: { backgroundColor: t.colors.bgActive },
  disabled: { opacity: 0.55 },
  leading: { width: 28, marginRight: space[3], alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[2], paddingRight: space[3], paddingVertical: space[2] },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.line },
  text: { flex: 1, minWidth: 0, gap: 1 },
  detail: { flexShrink: 0, maxWidth: '45%' },
}))
