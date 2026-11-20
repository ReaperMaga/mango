import { useEffect, useState, type ComponentType } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { ChevronRight, CircleCheck, CircleDot, CircleSlash, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Link2, type LucideProps } from 'lucide-react-native'
import type { LinkedItem } from '~/types/chat'
import type { Colors } from '@/theme'
import { makeStyles, space, touch, useTheme } from '@/theme'
import { Button, ButtonRow, ListRow, ListSection, Sheet, Spinner, Text, TextField, haptic } from '@/ui'
import { validGhRef, type GhState } from '@/remote/github'
import { linkState, type LinkIcon, type LinkTone } from './linkState'

/** The state marks, as the desktop's `linkState.ts` picks them. */
export const LINK_ICONS: Record<LinkIcon, ComponentType<LucideProps>> = {
  'pr': GitPullRequest,
  'pr-draft': GitPullRequestDraft,
  'pr-merged': GitMerge,
  'pr-closed': GitPullRequestClosed,
  'issue': CircleDot,
  'issue-done': CircleCheck,
  'issue-skipped': CircleSlash,
}

/** A state's colour: the text grade, since the mark sits beside its word. */
export const LINK_TONE_COLORS: Record<LinkTone, keyof Colors> = {
  running: 'ripeRunningFg',
  queued: 'ripeQueuedFg',
  done: 'ripeDoneFg',
  error: 'ripeErrorFg',
  idle: 'fgFaint',
}

/** How many items the bar names before it says "+N". */
const BAR_ITEMS = 2

export interface ChatLinksBarProps {
  links: LinkedItem[]
  onPress: () => void
}

/**
 * A slim bar under the chat's header while it has linked pull requests or issues: each one's
 * state mark and number, in the ripeness colours, so a merged or failed item shows at a glance.
 * Tapping it opens the item when there is one (as the desktop's tool window does), else the list
 * (`ChatLinksSheet`).
 */
export function ChatLinksBar({ links, onPress }: ChatLinksBarProps) {
  const t = useTheme()
  const s = useStyles()
  if (!links.length) return null
  const shown = links.slice(0, BAR_ITEMS)
  const more = links.length - shown.length
  const said = links.map((l) => {
    const look = linkState(l.kind, l.state)
    return `${look.noun} ${l.number}${l.state ? `, ${look.word.toLowerCase()}` : ''}`
  }).join('; ')
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Linked: ${said}`}
      accessibilityHint={links.length === 1 ? `Shows ${links[0]!.kind === 'pr' ? 'the pull request' : 'the issue'}` : 'Shows the pull requests and issues of this chat'}
      style={({ pressed }) => [s.bar, pressed && s.pressed]}
    >
      {shown.map((l) => {
        const look = linkState(l.kind, l.state)
        const Icon = LINK_ICONS[look.icon]
        return (
          <View key={l.key} style={s.item}>
            <Icon size={15} strokeWidth={1.75} color={t.colors[LINK_TONE_COLORS[look.tone]]} />
            <Text variant="caption" tone="muted" tabular numberOfLines={1}>#{l.number}</Text>
            {l.state ? <Text variant="caption" tone="subtle" numberOfLines={1}>{look.word}</Text> : null}
          </View>
        )
      })}
      {more ? <Text variant="caption" tone="subtle" tabular>+{more}</Text> : null}
      <View style={s.fill} />
      <Text variant="caption" tone="subtle" numberOfLines={1}>{links.length === 1 ? (links[0]!.kind === 'pr' ? 'Pull request' : 'Issue') : 'Linked'}</Text>
      <ChevronRight size={16} strokeWidth={2} color={t.colors.fgFaint} />
    </Pressable>
  )
}

export interface ChatLinksSheetProps {
  visible: boolean
  onClose: () => void
  links: LinkedItem[]
  /** What GitHub said just now, by link key (newer than the title and state saved on the link). */
  live: Record<string, GhState>
  /** Reading the latest from GitHub. */
  loading: boolean
  /** Why the latest could not be read; the saved titles and states still show. */
  error: string | null
  /** Open one item's screen (the sheet closes first). */
  onOpen: (link: LinkedItem) => void
  /** Link the item a reference names; rejects with a message to show under the field. */
  onLink: (reference: string) => Promise<LinkedItem>
}

/**
 * The pull requests and issues linked to the chat (the desktop's Pull requests tool window list):
 * state, title, repository and number. Each opens its own screen; ones not on github.com are
 * listed but not opened. Below them, a field links one by hand.
 */
export function ChatLinksSheet({ visible, onClose, links, live, loading, error, onOpen, onLink }: ChatLinksSheetProps) {
  const t = useTheme()
  const s = useStyles()
  const [adding, setAdding] = useState(false)
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Opening with nothing linked goes straight to the field; a half-typed link does not outlive the sheet.
  useEffect(() => {
    if (visible) {
      setAdding(!links.length)
    } else {
      setReference('')
      setAddError(null)
    }
    // Only on opening and closing: linking one while open must not close the field under the person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const submit = async () => {
    if (!reference.trim() || busy) return
    setBusy(true)
    setAddError(null)
    try {
      const link = await onLink(reference)
      haptic('success')
      setReference('')
      setAdding(false)
      onOpen(link)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const footer = error ?? (loading ? 'Reading the latest from GitHub…' : undefined)
  return (
    <Sheet visible={visible} onClose={onClose} title="Pull requests and issues" action={loading ? <Spinner size={16} label="Reading from GitHub" /> : undefined}>
      <View style={s.body}>
        {links.length
          ? (
              <ListSection footer={footer}>
                {links.map((l) => {
                  const now = live[l.key]
                  const look = linkState(now?.kind ?? l.kind, now?.state ?? l.state, now?.stateReason)
                  const Icon = LINK_ICONS[look.icon]
                  const readable = validGhRef(l)
                  const title = now?.title ?? l.title ?? `${look.noun} #${l.number}`
                  return (
                    <ListRow
                      key={l.key}
                      title={title}
                      subtitle={`${look.word} · ${l.owner}/${l.repo} #${l.number}`}
                      leading={<Icon size={20} strokeWidth={1.75} color={t.colors[LINK_TONE_COLORS[look.tone]]} />}
                      accessibilityHint={readable ? 'Shows its checks, description and actions' : 'Only github.com items open from here'}
                      onPress={readable ? () => onOpen(l) : undefined}
                    />
                  )
                })}
              </ListSection>
            )
          : (
              <Text variant="bodySm" tone="muted" style={s.empty}>
                When the agent opens a pull request or an issue in this chat, it shows up here. Ask it to “open a pull request” when the work is done.
              </Text>
            )}

        {adding
          ? (
              <View style={s.add}>
                <TextField
                  label="Pull request or issue"
                  value={reference}
                  onChangeText={(v) => { setReference(v); if (addError) setAddError(null) }}
                  placeholder="Link, owner/repo#12 or #12"
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  keyboardType="url"
                  returnKeyType="go"
                  onSubmitEditing={submit}
                  autoFocus={!!links.length}
                  error={addError}
                  hint="A number is looked up in this project's GitHub repository."
                />
                <ButtonRow>
                  <Button label="Link" variant="primary" icon={Link2} loading={busy} disabled={!reference.trim()} onPress={submit} />
                  {links.length ? <Button label="Cancel" variant="ghost" disabled={busy} onPress={() => { setAdding(false); setReference(''); setAddError(null) }} /> : null}
                </ButtonRow>
              </View>
            )
          : (
              <ListSection>
                <ListRow
                  title="Link a pull request or issue"
                  leading={<Link2 size={20} strokeWidth={1.75} color={t.colors.accentInk} />}
                  accessory="none"
                  onPress={() => setAdding(true)}
                />
              </ListSection>
            )}
      </View>
    </Sheet>
  )
}

const useStyles = makeStyles(t => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: touch.min,
    paddingLeft: space[4],
    paddingRight: space[3],
    backgroundColor: t.colors.bgCanvas,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.colors.lineSoft,
  },
  pressed: { backgroundColor: t.colors.bgActive },
  item: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  fill: { flex: 1 },
  body: { gap: space[5] },
  empty: { paddingHorizontal: space[1] },
  add: { gap: space[3] },
}))
