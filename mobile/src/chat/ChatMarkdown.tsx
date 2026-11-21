import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Animated, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Check, Copy } from 'lucide-react-native'
import { lexer, type Token, type Tokens } from 'marked'
import { makeStyles, space, useReducedMotion, useTheme } from '@/theme'
import { Text, haptic } from '@/ui'
import { localImagePath } from '~/utils/imagePaths'
import { ChatPicture } from './ChatPicture'

/**
 * Agent markdown, drawn natively by walking `marked`'s tokens (the desktop renders the same
 * tokens to HTML in `ChatMarkdown.vue`). Agent output is untrusted text, so:
 * - raw HTML is shown as the literal text it is, never interpreted;
 * - links open only when they are http(s), in the system browser; anything else stays text;
 * - pictures (`![alt](path)`) are shown only from files inside the chat's environment (a
 *   screenshot the agent took there), read through `backend.chatImage`, which accepts nothing but
 *   real raster images. Web addresses are never fetched (a picture URL can carry data out of the
 *   chat): those, and every picture when there is no `base`, show their alt text only.
 */
export interface ChatMarkdownProps {
  text: string
  /** Still being written: a Ripe Mango caret blinks at the end. */
  streaming?: boolean
  /** The chat's folder in its environment (`env://…`): pictures are read there. None: alt text only. */
  base?: string | null
}

const SAFE_LINK = /^https?:\/\//i

/** Text tokens keep character references as written; show them as the characters they stand for. */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
function decode(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function ChatMarkdown({ text, streaming = false, base = null }: ChatMarkdownProps) {
  const s = useStyles()
  const tokens = useMemo(() => {
    try {
      return lexer(text, { gfm: true, breaks: false })
    } catch {
      return null
    }
  }, [text])
  if (!tokens) return <Text variant="chat" selectable>{text}</Text>
  const blocks = tokens.filter(t => t.type !== 'space' && t.type !== 'def')
  return <View style={s.root}>{renderBlocks(blocks, { s, base }, streaming)}</View>
}

type S = ReturnType<typeof useStyles>
/** What every block needs: the styles, and where pictures are read. */
interface Ctx { s: S; base: string | null }

/** A picture the environment can show: a local path in a chat that has one. */
function pictureOf(tk: Token, base: string | null): { path: string; name: string } | null {
  if (tk.type !== 'image' || !base) return null
  const t = tk as Tokens.Image
  const path = localImagePath(t.href)
  if (!path) return null
  return { path, name: t.text.trim() || path.split('/').filter(Boolean).pop() || 'Picture' }
}

type Run = { kind: 'text'; tokens: Token[] } | { kind: 'picture'; path: string; name: string }

/** A paragraph's inline tokens, split around its pictures (a picture cannot sit inside a line of text here). */
function runsOf(tokens: Token[], base: string | null): Run[] {
  const runs: Run[] = []
  for (const tk of tokens) {
    const pic = pictureOf(tk, base)
    if (pic) { runs.push({ kind: 'picture', ...pic }); continue }
    const last = runs[runs.length - 1]
    if (last?.kind === 'text') last.tokens.push(tk)
    else runs.push({ kind: 'text', tokens: [tk] })
  }
  // The line breaks and spaces between pictures are not text of their own.
  return runs.filter(r => r.kind === 'picture' || r.tokens.some(t => t.raw.trim() !== ''))
}

/** Blocks in order; the caret goes at the end of the last one that is text, else on its own after. */
function renderBlocks(tokens: Token[], c: Ctx, caret: boolean): ReactNode[] {
  const out: ReactNode[] = []
  tokens.forEach((tk, i) => {
    const last = i === tokens.length - 1
    out.push(block(tk, `b${i}`, c, caret && last, i === 0, last))
  })
  if (caret && !tokens.length) out.push(<Caret key="caret" />)
  return out
}

function block(tk: Token, key: string, c: Ctx, caret: boolean, first: boolean, last: boolean): ReactNode {
  const { s } = c
  const edge = [first && s.first, last && s.last]
  switch (tk.type) {
    case 'paragraph':
    case 'text': {
      const t = tk as Tokens.Paragraph | Tokens.Text
      const runs = t.tokens && c.base ? runsOf(t.tokens, c.base) : null
      if (runs?.some(r => r.kind === 'picture')) {
        const end = runs[runs.length - 1]!
        return (
          <View key={key} style={[s.p, ...edge]}>
            {runs.map((r, i) => r.kind === 'picture'
              ? <ChatPicture key={i} base={c.base!} path={r.path} name={r.name} />
              : (
                  <Text key={i} variant="chat" selectable>
                    {inline(r.tokens, s, `${key}-${i}`)}
                    {caret && r === end ? <CaretText /> : null}
                  </Text>
                ))}
            {caret && end.kind === 'picture' ? <Caret /> : null}
          </View>
        )
      }
      return (
        <Text key={key} variant="chat" selectable style={[s.p, ...edge]}>
          {t.tokens ? inline(t.tokens, s, key) : decode(t.text)}
          {caret ? <CaretText /> : null}
        </Text>
      )
    }
    case 'heading': {
      const t = tk as Tokens.Heading
      return (
        <Text key={key} selectable accessibilityRole="header" style={[t.depth <= 3 ? s.h : s.h4, ...edge]}>
          {inline(t.tokens, s, key)}
          {caret ? <CaretText /> : null}
        </Text>
      )
    }
    case 'code': {
      const t = tk as Tokens.Code
      return (
        <View key={key} style={[s.pre, ...edge]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false} contentContainerStyle={s.preScroll}>
            <Text selectable style={s.code}>{t.text.replace(/\n$/, '')}</Text>
          </ScrollView>
          {caret ? null : <CopyCode text={t.text.replace(/\n$/, '')} />}
          {caret ? <Caret /> : null}
        </View>
      )
    }
    case 'blockquote': {
      const t = tk as Tokens.Blockquote
      return (
        <View key={key} style={[s.quote, ...edge]}>
          {renderBlocks(t.tokens.filter(x => x.type !== 'space'), c, caret)}
        </View>
      )
    }
    case 'list': {
      const t = tk as Tokens.List
      const start = typeof t.start === 'number' ? t.start : 1
      return (
        <View key={key} style={[s.list, ...edge]}>
          {t.items.map((item, i) => {
            const body = item.tokens.filter(x => x.type !== 'checkbox' && x.type !== 'space')
            const lastItem = i === t.items.length - 1
            return (
              <View key={i} style={s.item}>
                {item.task
                  ? <TaskBox checked={!!item.checked} />
                  : <Text variant="chat" style={s.marker} tabular>{t.ordered ? `${start + i}.` : '•'}</Text>}
                <View style={s.itemBody}>{renderBlocks(body, c, caret && lastItem)}</View>
              </View>
            )
          })}
        </View>
      )
    }
    case 'table': {
      const t = tk as Tokens.Table
      // Each column as wide as its longest cell needs, within limits; long cells wrap inside it.
      const widths = t.header.map((h, c) => {
        const longest = Math.max(h.text.length, ...t.rows.map(r => r[c]?.text.length ?? 0))
        return Math.min(260, Math.max(72, longest * 8.6 + space[5]))
      })
      const row = (cells: Tokens.TableCell[], head: boolean, r: number) => (
        <View key={r} style={[s.tr, head && s.th]}>
          {cells.map((cell, c) => (
            <Text
              key={c}
              selectable
              variant="bodySm"
              tone={head ? 'muted' : 'fg'}
              tabular
              style={[s.td, { width: widths[c], textAlign: cell.align ?? 'left' }, head && s.thText]}
            >
              {inline(cell.tokens, s, `${key}-${r}-${c}`)}
            </Text>
          ))}
        </View>
      )
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false} bounces={false} style={[s.table, ...edge]}>
          <View>
            {row(t.header, true, -1)}
            {t.rows.map((r, i) => row(r, false, i))}
          </View>
        </ScrollView>
      )
    }
    case 'hr':
      return <View key={key} style={[s.hr, ...edge]} />
    case 'html':
      // Shown as written. Never interpreted.
      return (
        <Text key={key} variant="chat" selectable style={[s.p, ...edge]}>
          {(tk as Tokens.HTML).text.replace(/\n+$/, '')}
          {caret ? <CaretText /> : null}
        </Text>
      )
    default:
      return 'tokens' in tk && Array.isArray(tk.tokens)
        ? <Text key={key} variant="chat" selectable style={[s.p, ...edge]}>{inline(tk.tokens, s, key)}</Text>
        : <Text key={key} variant="chat" selectable style={[s.p, ...edge]}>{decode(tk.raw)}</Text>
  }
}

function inline(tokens: Token[], s: S, prefix: string): ReactNode[] {
  return tokens.map((tk, i) => {
    const key = `${prefix}.${i}`
    switch (tk.type) {
      case 'text': {
        const t = tk as Tokens.Text
        return t.tokens ? <Text key={key}>{inline(t.tokens, s, key)}</Text> : decode(t.text)
      }
      case 'escape':
        return (tk as Tokens.Escape).text
      case 'strong':
        return <Text key={key} style={s.strong}>{inline((tk as Tokens.Strong).tokens, s, key)}</Text>
      case 'em':
        return <Text key={key} style={s.em}>{inline((tk as Tokens.Em).tokens, s, key)}</Text>
      case 'del':
        return <Text key={key} style={s.del}>{inline((tk as Tokens.Del).tokens, s, key)}</Text>
      case 'codespan':
        return <Text key={key} style={s.codespan}>{(tk as Tokens.Codespan).text}</Text>
      case 'br':
        return '\n'
      case 'link': {
        const t = tk as Tokens.Link
        const label = inline(t.tokens, s, key)
        if (!SAFE_LINK.test(t.href)) return <Text key={key}>{label}</Text>
        return (
          <Text
            key={key}
            style={s.link}
            accessibilityRole="link"
            accessibilityHint={t.href}
            onPress={() => { Linking.openURL(t.href).catch(() => {}) }}
          >
            {label}
          </Text>
        )
      }
      case 'image': {
        // Alt text only: a web picture is never fetched, and a local one shows only on its own (runsOf).
        const alt = (tk as Tokens.Image).text.trim()
        return <Text key={key} style={s.alt}>{alt || 'Picture'}</Text>
      }
      case 'html':
        return (tk as Tokens.Tag).text
      case 'checkbox':
        return null
      default:
        return 'text' in tk && typeof tk.text === 'string' ? decode(tk.text) : tk.raw
    }
  })
}

/** A task-list box: Inset Well, filled with Ripe Mango and a tick when done. */
function TaskBox({ checked }: { checked: boolean }) {
  const t = useTheme()
  const s = useStyles()
  return (
    <View style={[s.box, checked && s.boxOn]} accessibilityLabel={checked ? 'Done' : 'Not done'}>
      {checked ? <Check size={11} strokeWidth={3} color={t.colors.accentFg} /> : null}
    </View>
  )
}

/** A code block's own copy button, at its top right corner. */
function CopyCode({ text }: { text: string }) {
  const t = useTheme()
  const s = useStyles()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const id = setTimeout(() => setDone(false), 1600)
    return () => clearTimeout(id)
  }, [done])
  return (
    <Pressable
      onPress={() => { void Clipboard.setStringAsync(text).then(() => { haptic('success'); setDone(true) }) }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={done ? 'Copied' : 'Copy code'}
      style={({ pressed }) => [s.copy, pressed && s.copyPressed]}
    >
      {done ? <Check size={14} strokeWidth={2.2} color={t.colors.fg} /> : <Copy size={14} strokeWidth={1.85} color={t.colors.fgSubtle} />}
    </Pressable>
  )
}

/** The streaming caret at the end of a line of text: a Ripe Mango block, blinking. */
function CaretText() {
  const s = useStyles()
  const blink = useBlink()
  return <Animated.Text style={[s.caretText, { opacity: blink }]}>{'  '}</Animated.Text>
}

/** The caret on its own line, after a code block or a table. */
function Caret() {
  const s = useStyles()
  const blink = useBlink()
  return <Animated.View style={[s.caretBlock, { opacity: blink }]} />
}

function useBlink() {
  const reduced = useReducedMotion()
  const v = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (reduced) return
    // steps(2) over 1s: on for half, off for half.
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(500),
      Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
      Animated.delay(500),
      Animated.timing(v, { toValue: 1, duration: 0, useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [reduced, v])
  return v
}

const useStyles = makeStyles(t => ({
  root: {},
  first: { marginTop: 0 },
  last: { marginBottom: 0 },
  p: { marginBottom: Math.round(t.fontSize.body * 0.7) },
  h: { ...t.type.title, ...t.fonts.semibold, color: t.colors.fg, marginTop: Math.round(t.fontSize.body * 1.2), marginBottom: Math.round(t.fontSize.body * 0.4) },
  h4: { ...t.type.chat, ...t.fonts.semibold, color: t.colors.fg, marginTop: space[3], marginBottom: space[1] },
  strong: { ...t.fonts.semibold },
  em: { ...t.fonts.italic },
  del: { textDecorationLine: 'line-through', color: t.colors.fgMuted },
  codespan: {
    ...t.fonts.mono,
    fontSize: Math.round(t.fontSize.body * 0.88),
    backgroundColor: t.colors.bgHover,
    color: t.colors.fg,
  },
  link: { color: t.colors.accentInk, textDecorationLine: 'underline', textDecorationColor: t.colors.accentLine },
  alt: { color: t.colors.fgSubtle, fontSize: t.fontSize.bodySm },
  pre: {
    marginBottom: Math.round(t.fontSize.body * 0.8),
    backgroundColor: t.colors.bgInset,
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
    borderRadius: t.radius.md,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  copy: {
    position: 'absolute',
    top: space[1],
    right: space[1],
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.bgRaised,
    borderWidth: 1,
    borderColor: t.colors.lineSoft,
  },
  copyPressed: { backgroundColor: t.colors.bgActive },
  preScroll: { paddingVertical: space[3], paddingHorizontal: space[4] },
  code: { ...t.type.code, color: t.colors.fg },
  quote: {
    marginBottom: Math.round(t.fontSize.body * 0.8),
    paddingLeft: space[3],
    borderLeftWidth: 1,
    borderLeftColor: t.colors.lineStrong,
    opacity: 0.92,
  },
  list: { marginBottom: Math.round(t.fontSize.body * 0.8) },
  item: { flexDirection: 'row', alignItems: 'flex-start', marginVertical: 2 },
  marker: { minWidth: 20, paddingRight: 6, color: t.colors.fgFaint },
  box: {
    width: 14,
    height: 14,
    marginTop: 6,
    marginRight: space[2],
    borderRadius: t.radius.xs,
    borderWidth: 1.5,
    borderColor: t.colors.lineStrong,
    backgroundColor: t.colors.bgInset,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: t.colors.accent, borderColor: t.colors.accent },
  itemBody: { flex: 1, minWidth: 0 },
  table: { marginBottom: Math.round(t.fontSize.body * 0.8), flexGrow: 0 },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.lineSoft },
  th: { borderBottomColor: t.colors.line },
  td: { paddingVertical: 6, paddingHorizontal: 10 },
  thText: { ...t.fonts.semibold },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: t.colors.lineSoft, marginVertical: Math.round(t.fontSize.body * 1.2) },
  caretText: { backgroundColor: t.colors.accent },
  caretBlock: { width: 7, height: 17, borderRadius: 1, backgroundColor: t.colors.accent, marginTop: 2 },
}))
