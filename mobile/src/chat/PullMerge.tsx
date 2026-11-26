import { useEffect, useState, type ComponentType } from 'react'
import { View } from 'react-native'
import { CircleAlert, CircleCheck, CircleDashed, CircleX, GitMerge, type LucideProps } from 'lucide-react-native'
import type { LinkedItem } from '~/types/chat'
import type { GhMergeMethod } from '~/types/ipc'
import type { Colors } from '@/theme'
import { makeStyles, space, useTheme } from '@/theme'
import { Button, ButtonRow, Segmented, Sheet, Spinner, Text, haptic } from '@/ui'
import type { GhDetail } from '@/remote/github'
import { useLinks } from '@/state/links'
import { MERGE_METHODS, defaultMethod, mergeMethodsOf, mergeQuestion, mergeStatus, mergeUnavailable, type MergeTone } from './pulls'
import { forgeName, itemNoun, providerOf } from '~/utils/forge'

const ICON: Record<Exclude<MergeTone, 'checking'>, ComponentType<LucideProps>> = {
  done: CircleCheck,
  running: CircleDashed,
  queued: CircleAlert,
  error: CircleX,
  idle: CircleAlert,
}
const MARK: Record<Exclude<MergeTone, 'checking'>, keyof Colors> = {
  done: 'ripeDone',
  running: 'ripeRunning',
  queued: 'ripeQueued',
  error: 'ripeError',
  idle: 'fgSubtle',
}

export interface PullMergeProps {
  threadId: string
  link: LinkedItem
  item: GhDetail
  projectPath: string
}

/**
 * Merging an open pull request or GitLab merge request (the desktop's `LinksMerge.vue`), docked under
 * its screen: whether GitHub or GitLab would take it now, and the merge button. Merging asks once more
 * first, in a sheet where the method is picked among the ones the repository allows (GitLab: merge or
 * squash): it changes the base branch for everyone.
 */
export function PullMerge({ threadId, link, item, projectPath }: PullMergeProps) {
  const t = useTheme()
  const s = useStyles()
  const status = mergeStatus(item)
  const unavailable = mergeUnavailable(item)
  const allowed = mergeMethodsOf(item)
  const provider = providerOf(item)
  const [method, setMethod] = useState<GhMergeMethod>(() => defaultMethod(item))
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (!allowed.includes(method)) setMethod(defaultMethod(item)) }, [allowed.join(','), method, item])
  // The branch moved under an open question: ask again with what is true now.
  useEffect(() => { if (!busy) setAsking(false) }, [item.headSha]) // eslint-disable-line react-hooks/exhaustive-deps

  const merge = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await useLinks.getState().merge(threadId, link, projectPath, method)
      haptic('success')
    } catch (e) {
      haptic('warning')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setAsking(false)
    }
  }

  const Icon = status.tone === 'checking' ? null : ICON[status.tone]
  return (
    <View style={s.root}>
      <View style={s.status} accessible accessibilityRole="summary" accessibilityLiveRegion="polite" accessibilityLabel={`${status.title}. ${status.detail ?? ''}`}>
        <View style={s.icon}>
          {Icon ? <Icon size={18} strokeWidth={1.9} color={t.colors[MARK[status.tone as Exclude<MergeTone, 'checking'>]]} /> : <Spinner size={16} />}
        </View>
        <View style={s.words}>
          <Text variant="label" numberOfLines={1}>{status.title}</Text>
          {status.detail ? <Text variant="caption" tone="subtle">{status.detail}</Text> : null}
        </View>
      </View>

      {unavailable
        ? <Text variant="caption" tone="subtle">{unavailable}</Text>
        : (
            <Button
              label={MERGE_METHODS[method].action}
              icon={GitMerge}
              variant={status.ready ? 'primary' : 'secondary'}
              disabled={!status.ready}
              loading={busy}
              block
              accessibilityHint={status.ready ? `Asks before merging on ${forgeName(provider)}` : status.title}
              onPress={() => { setError(null); haptic('select'); setAsking(true) }}
            />
          )}

      {error ? <Text variant="caption" tone="error" selectable accessibilityRole="alert">{error}</Text> : null}

      <Sheet visible={asking} onClose={() => { if (!busy) setAsking(false) }} title={`Merge ${itemNoun('pr', provider)}`}>

        <View style={s.sheet}>
          {allowed.length > 1
            ? (
                <View style={s.methods}>
                  <Segmented
                    label="Merge method"
                    value={method}
                    onChange={setMethod}
                    options={allowed.map(m => ({ value: m, label: MERGE_METHODS[m].short }))}
                  />
                  <Text variant="caption" tone="subtle">{MERGE_METHODS[method].hint}</Text>
                </View>
              )
            : null}
          <Text variant="bodySm" tone="muted" selectable>{mergeQuestion(item, method)}</Text>
          <ButtonRow style={s.buttons}>
            <Button label="Cancel" variant="ghost" disabled={busy} onPress={() => setAsking(false)} />
            <Button label={MERGE_METHODS[method].action} variant="primary" icon={GitMerge} loading={busy} onPress={merge} />
          </ButtonRow>
        </View>
      </Sheet>
    </View>
  )
}

const useStyles = makeStyles(() => ({
  root: { gap: space[3] },
  status: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2] },
  icon: { width: 20, paddingTop: 1, alignItems: 'center' },
  words: { flex: 1, minWidth: 0, gap: 1 },
  sheet: { gap: space[4] },
  methods: { gap: space[2] },
  buttons: { justifyContent: 'flex-end' },
}))
