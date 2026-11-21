import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowDown, Camera, Ellipsis, FolderOpen, GitCompareArrows, Image as ImageIcon } from 'lucide-react-native'
import { AGENTS, type BackgroundTask, type LinkedItem, type Message, type Thread } from '~/types/chat'
import { makeStyles, space, useTheme } from '@/theme'
import { Badge, Banner, Button, ButtonRow, EmptyState, IconButton, ListRow, ListSection, Sheet, Text, haptic } from '@/ui'
import { ChatComposer, ChatContextSheet, ChatFind, ChatMessage, ChatMessageActions, ChatWorking } from '@/chat'
import { dayLabel, sameDay } from '@/chat/time'
import { ChatTasks, ChatTasksSheet } from '@/chat/ChatTasks'
import { ChatLinksBar, ChatLinksSheet } from '@/chat/ChatLinks'
import { readTaskOutput } from '@/agents/run'
import { envOf } from '@/remote/chatSync'
import { LIVE_CHAT_MS } from '@/screens/livePoll'
import { useLiveChats } from '@/screens/useLiveChats'
import { useEnvs } from '@/state/envs'
import { useNetwork } from '@/state/network'
import { isBusy, useThreads, type QueuedMessage } from '@/state/threads'
import { usePrefs } from '@/state/prefs'
import type { ToolCalls } from '@/state/prefsModel'
import { ThreadActions } from '@/screens/ThreadActions'
import { useAttachments, type AttachSource } from '@/screens/useAttachments'
import { placeOf, projectName, reconnectingText } from '@/screens/names'
import { useLinkDetails } from '@/screens/useLinkDetails'
import { useLinks } from '@/state/links'
import { validGhRef } from '@/remote/github'

/** How close to the end (pt) still counts as "at the bottom": new output then keeps it in view. */
const STICK = 80

/**
 * A chat: the conversation, the live "working" row while the agent runs, and the composer above
 * the keyboard. While the reader is at the bottom new output keeps it there; scrolled up, it stays
 * put. Being on screen marks the chat seen, so a turn that ends here does not ring its dot.
 */
export default function ChatScreen() {
  const s = useStyles()
  const t = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const { id } = useLocalSearchParams<{ id: string }>()
  const thread = useThreads(st => st.threads[id] ?? null)
  const draft = useThreads(st => st.drafts[id] ?? '')
  const queue = useThreads(st => st.queue[id])
  const live = useThreads(st => st.live[id])
  const elsewhere = useThreads(st => st.elsewhere[id] ?? null)
  const toolCalls = usePrefs(st => st.toolCalls)
  const contextPending = useThreads(st => st.contextReading[id])
  // A chat from before Mango kept context readings gets one when it opens (no turn is run).
  useEffect(() => { void useThreads.getState().readContext(id) }, [id])
  // A sub-agent's chat shows the links of the chat that started it, as on the desktop.
  const root = useThreads(st => (st.threads[id] ? st.rootOf(id) : null))
  const links = root?.links ?? NO_LINKS
  const at = thread ? envOf(thread.projectPath) : null
  const env = useEnvs(st => (at ? st.envs.find(e => e.id === at.hostId) ?? null : null))
  const conn = useEnvs(st => (at ? st.status[at.hostId] : undefined))
  const offline = useNetwork(st => st.online === false)
  const [menu, setMenu] = useState(false)
  const [keyboard, setKeyboard] = useState(false)
  const [attachMenu, setAttachMenu] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [linksOpen, setLinksOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const linkDetails = useLinkDetails(root?.id ?? id, root?.projectPath ?? null, links, linksOpen)
  const readOutput = useCallback((taskId: string) => readTaskOutput(id, taskId), [id])
  const files = useAttachments(thread?.projectPath ?? null)
  const [findOpen, setFindOpen] = useState(false)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [away, setAway] = useState(false)
  const list = useRef<FlatList<Row>>(null)
  const atBottom = useRef(true)
  const messages = thread?.messages
  // The messages with a mark before the first of each day.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    ;(messages ?? []).forEach((message, index) => {
      const prev = messages![index - 1]
      if (!prev || !sameDay(prev.createdAt, message.createdAt)) out.push({ kind: 'day', key: `d:${message.id}`, ts: message.createdAt })
      out.push({ kind: 'message', key: message.id, message, last: index === messages!.length - 1 })
    })
    return out
  }, [messages])
  const openActions = useCallback((m: Message) => setActionsFor(m.id), [])

  // A run on another computer, and its end, show up here without a pull to refresh.
  useLiveChats(thread?.projectPath, LIVE_CHAT_MS, true)

  useFocusEffect(useCallback(() => {
    useThreads.getState().setViewing(id)
    return () => { if (useThreads.getState().viewing === id) useThreads.getState().setViewing(null) }
  }, [id]))

  // With the keyboard up the composer sits on it; the home indicator's inset is only for when it is down.
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true))
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false))
    return () => { show.remove(); hide.remove() }
  }, [])

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < STICK
    // Far from the end (more than a screen): offer the way back down.
    const far = contentSize.height - contentOffset.y - layoutMeasurement.height > layoutMeasurement.height
    setAway(prev => (prev === far ? prev : far))
  }
  const toLatest = () => { atBottom.current = true; list.current?.scrollToEnd({ animated: true }) }
  const jumpTo = (messageIndex: number) => {
    const id = thread?.messages[messageIndex]?.id
    const at = rows.findIndex(r => r.kind === 'message' && r.message.id === id)
    setFindOpen(false)
    if (at < 0) return
    atBottom.current = false
    // The sheet's own exit first: the list scrolls under a closing modal otherwise.
    setTimeout(() => list.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.1 }), 350)
  }
  const follow = () => { if (atBottom.current) list.current?.scrollToEnd({ animated: false }) }

  if (!thread) {
    return (
      <View style={s.screen}>
        <Stack.Screen options={{ title: '' }} />
        <EmptyState title="This chat is gone" body="It was deleted, here or on another computer." action={<Button label="Go back" onPress={() => router.back()} />} />
      </View>
    )
  }

  const busy = isBusy(thread)
  const agentName = AGENTS[thread.agent].name
  const models = AGENTS[thread.agent].models
  const tasksLeft = live?.idle ? live.tasks.filter(x => x.status === 'running').length : 0
  const readOnly = !!thread.parentId
  const store = useThreads.getState()

  const chatId = root?.id ?? id
  /** One linked item's screen; from the sheet, once the sheet has gone (iOS won't push under a closing modal). */
  const openLink = (l: LinkedItem, fromSheet = false) => {
    const go = () => router.push({ pathname: '/pull', params: { chat: chatId, key: l.key } })
    if (!fromSheet) return go()
    setLinksOpen(false)
    setTimeout(go, 350)
  }
  // With one item the bar goes straight to it, as the desktop's tool window does.
  const onLinksBar = () => {
    if (links.length === 1 && validGhRef(links[0]!)) openLink(links[0]!)
    else setLinksOpen(true)
  }

  const send = (text: string) => {
    store.setDraft(id, '')
    atBottom.current = true
    void store.send(id, text, files.take())
    requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }))
  }

  const attachFrom = (source: AttachSource) => {
    setAttachMenu(false)
    // The sheet's own exit first: iOS won't present a picker over a closing modal.
    setTimeout(() => { void files.add(source) }, 350)
  }

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <Pressable
            onLongPress={() => { haptic('select'); setMenu(true) }}
            accessibilityRole="header"
            accessibilityHint="Long press to rename, change the status or delete"
            style={s.title}
          >
            <Text variant="label" numberOfLines={1} maxFontSizeMultiplier={1.2}>{thread.title}</Text>
            <Text variant="micro" tone="subtle" numberOfLines={1} maxFontSizeMultiplier={1.2}>
              {projectName(thread.projectPath)}{env ? ` · ${placeOf(thread.projectPath, env)}` : ''}
            </Text>
          </Pressable>
        ),
        headerRight: () => (
          <View style={s.headerButtons}>
            <IconButton icon={GitCompareArrows} label="Changes" onPress={() => router.push({ pathname: '/changes', params: { path: thread.worktree ?? thread.projectPath, chat: chatId } })} />
            <IconButton icon={Ellipsis} label="Chat actions" onPress={() => setMenu(true)} />
          </View>
        ),
      }}
    />
  )

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      {header}
      <ChatLinksBar links={links} onPress={onLinksBar} />
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={r => r.key}
        renderItem={({ item }) => (item.kind === 'day'
          ? <DayMark ts={item.ts} />
          : (
              <Item
                message={item.message}
                thread={thread}
                last={item.last}
                toolCalls={toolCalls}
                onOpenChild={childId => router.push({ pathname: '/chat/[id]', params: { id: childId } })}
                onActions={openActions}
              />
            ))}
        onScrollToIndexFailed={(info) => {
          // The row is not measured yet: go near it, then try again.
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.1 }), 120)
        }}
        contentContainerStyle={[s.content, !thread.messages.length && s.emptyContent]}
        ListHeaderComponent={(
          <View style={s.head}>
            {thread.simulated ? <Badge label="Simulated" dashed style={s.center} /> : null}
            {offline
              ? (
                  <Banner
                    title="No internet connection"
                    message={busy
                      ? `${agentName} keeps working in ${env?.name ?? 'its environment'}. Mango reconnects when this phone is back online.`
                      : 'Messages can go out once this phone is back online.'}
                  />
                )
              : conn?.state === 'error' && env
                ? <Banner tone="error" message={`${env.name} can't be reached right now, so messages can't go out. ${conn.message ?? ''}`.trim()} />
                // A running chat says it in its working row.
                : conn?.state === 'reconnecting' && env && !live?.reconnecting
                  ? <Banner message={reconnectingText([env.name])} />
                  : null}
          </View>
        )}
        ListEmptyComponent={(
          <EmptyState
            title={`What should ${agentName} do?`}
            body={`It works in ${projectName(thread.projectPath)}${env ? `, ${placeOf(thread.projectPath, env)}` : ''}. Ask it to build, fix or explain something.`}
          />
        )}
        ListFooterComponent={(
          <View style={s.foot}>
            {queue?.length ? queue.map(q => <Queued key={q.id} q={q} threadId={id} running={busy} />) : null}
            {busy ? <ChatWorking thread={thread} waitingOnTasks={tasksLeft} reconnectingTo={live?.reconnecting ? env?.name ?? 'the environment' : null} /> : null}
            {!busy && elsewhere ? <ChatWorking thread={thread} elsewhere={elsewhere} /> : null}
            {live?.tasks.length ? <ChatTasks tasks={live.tasks} onPress={() => setTasksOpen(true)} /> : null}
          </View>
        )}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onContentSizeChange={follow}
        onLayout={follow}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        initialNumToRender={20}
      />
      {away
        ? (
            <View style={s.jump} pointerEvents="box-none">
              <Pressable onPress={toLatest} accessibilityRole="button" accessibilityLabel="Jump to latest message" style={({ pressed }) => [s.jumpBtn, pressed && s.jumpPressed]}>
                <ArrowDown size={18} strokeWidth={2} color={t.colors.fg} />
              </Pressable>
            </View>
          )
        : null}
      <View style={[s.composer, { paddingBottom: keyboard ? space[2] : Math.max(insets.bottom, space[2]) }]}>
        {files.error
          ? <Banner tone="error" message={files.error} onDismiss={files.clearError} style={s.attachError} />
          : null}
        <ChatComposer
          workdir={store.workdirFor(id) ?? thread.projectPath}
          value={draft}
          onChangeText={text => store.setDraft(id, text)}
          onSend={send}
          onStop={() => store.stop(id)}
          running={busy}
          agent={thread.agent}
          model={thread.model}
          mode={thread.mode}
          effort={thread.effort ?? null}
          onModelChange={model => store.setModel(id, model, models.find(m => m.id === model)?.efforts)}
          onModeChange={mode => store.setMode(id, mode)}
          onEffortChange={effort => store.setEffort(id, effort)}
          disabled={readOnly}
          autoFocus={!readOnly && !thread.messages.length}
          placeholder={readOnly ? `A sub-agent's chat: ${agentName} writes it from the chat that started it.` : undefined}
          attachments={files.files}
          onAttach={readOnly ? undefined : () => setAttachMenu(true)}
          onRemoveAttachment={files.remove}
          context={readOnly ? undefined : thread.context ?? null}
          contextPending={!!contextPending}
          onContext={() => setContextOpen(true)}
        />
      </View>
      <Sheet visible={attachMenu} onClose={() => setAttachMenu(false)} title="Attach">
        <ListSection footer={`Files go into ${env?.name ?? 'the environment'}, where ${agentName} reads them. Pictures are also shown to it directly.`}>
          <ListRow title="Photo Library" leading={<ImageIcon size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => attachFrom('photos')} />
          <ListRow title="Take Photo" leading={<Camera size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => attachFrom('camera')} />
          <ListRow title="Choose File" leading={<FolderOpen size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => attachFrom('files')} />
        </ListSection>
      </Sheet>
      <ChatTasksSheet
        visible={tasksOpen && !!live?.tasks.length}
        onClose={() => setTasksOpen(false)}
        tasks={live?.tasks ?? NO_TASKS}
        onStop={taskId => store.stopTask(id, taskId)}
        readOutput={readOutput}
        childOf={subagentChat}
        onOpenChild={childId => router.push({ pathname: '/chat/[id]', params: { id: childId } })}
      />
      <ChatContextSheet
        visible={contextOpen}
        onClose={() => setContextOpen(false)}
        usage={thread.context ?? null}
        pending={!!contextPending}
        agentName={agentName}
        running={busy}
        // Not through `send`: the draft and its attachments stay for the next message.
        onCompact={() => { atBottom.current = true; void store.send(id, '/compact') }}
      />
      <ChatLinksSheet
        visible={linksOpen}
        onClose={() => setLinksOpen(false)}
        links={links}
        live={linkDetails.live}
        loading={linkDetails.loading}
        error={linkDetails.error}
        onOpen={l => openLink(l, true)}
        onLink={reference => useLinks.getState().linkByReference(chatId, reference)}
      />
      <ThreadActions
        threadId={id}
        visible={menu}
        onClose={() => setMenu(false)}
        onDeleted={() => router.back()}
        onLinks={() => { setMenu(false); setTimeout(() => setLinksOpen(true), 350) }}
        onFind={() => { setMenu(false); setTimeout(() => setFindOpen(true), 350) }}
      />
      <ChatFind visible={findOpen} onClose={() => setFindOpen(false)} messages={thread.messages} onPick={jumpTo} />
      <ChatMessageActions
        threadId={id}
        messageId={actionsFor}
        onClose={() => setActionsFor(null)}
        onBranched={newId => { setActionsFor(null); setTimeout(() => router.push({ pathname: '/chat/[id]', params: { id: newId } }), 350) }}
      />
    </KeyboardAvoidingView>
  )
}

/** What the list draws: a message, or the mark before a day's first. */
type Row =
  | { kind: 'day'; key: string; ts: number }
  | { kind: 'message'; key: string; message: Message; last: boolean }

function DayMark({ ts }: { ts: number }) {
  const s = useStyles()
  return <Text variant="caption" tone="faint" style={s.day} accessibilityRole="header">{dayLabel(ts)}</Text>
}

const NO_LINKS: LinkedItem[] = []
const NO_TASKS: BackgroundTask[] = []

/** The chat a background sub-agent writes, if it has one. */
function subagentChat(task: BackgroundTask): string | null {
  if (task.kind !== 'agent' || !task.toolId) return null
  const all = useThreads.getState().threads
  for (const c of Object.values(all)) if (c.parentId && c.toolId === task.toolId) return c.id
  return null
}

/**
 * One message. Kept from re-rendering while another message streams: a chat's snapshot changes on
 * every chunk, but only the message being written (and the last one's live state) needs drawing.
 */
const Item = memo(function Item({ message, thread, last, toolCalls, onOpenChild, onActions }: { message: Message; thread: Thread; last: boolean; toolCalls: ToolCalls; onOpenChild: (id: string) => void; onActions: (m: Message) => void }) {
  const store = useThreads.getState()
  return (
    <ChatMessage
      message={message}
      thread={thread}
      last={last}
      toolCalls={toolCalls}
      onResolveApproval={(i, allow) => store.resolveApproval(thread.id, message.id, i, allow)}
      onAnswerQuestion={(i, answers) => store.answerQuestion(thread.id, message.id, i, answers)}
      onOpenChild={onOpenChild}
      onActions={thread.parentId ? undefined : onActions}
    />
  )
}, (a, b) => a.message === b.message && a.last === b.last && a.toolCalls === b.toolCalls && a.thread.agent === b.thread.agent
  && (!b.last || a.thread.status === b.thread.status))

/** A message written while the agent works: it goes out when the turn ends, or now if asked. */
function Queued({ q, threadId, running }: { q: QueuedMessage; threadId: string; running: boolean }) {
  const s = useStyles()
  const store = useThreads.getState()
  return (
    <View style={s.queued}>
      <Text variant="caption" tone="subtle">{q.shown ? 'Sent, answered next' : 'Waiting for this turn to end'}</Text>
      <View style={s.queuedBubble}><Text variant="chat" tone="muted" selectable numberOfLines={6}>{q.text}</Text></View>
      {q.shown
        ? null
        : (
            <ButtonRow>
              {running ? <Button label="Send now" size="sm" variant="ghost" onPress={() => { void store.sendNow(threadId, q.id) }} /> : null}
              <Button label="Remove" size="sm" variant="ghost" onPress={() => store.dropQueued(threadId, q.id)} />
            </ButtonRow>
          )}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  content: { paddingHorizontal: space[4], paddingTop: space[2], paddingBottom: space[4], gap: space[5] },
  emptyContent: { flexGrow: 1, justifyContent: 'center' },
  head: { gap: space[3] },
  center: { alignSelf: 'center' },
  foot: { gap: space[3] },
  day: { alignSelf: 'center', marginVertical: space[1] },
  jump: { position: 'absolute', right: space[4], bottom: 96, alignItems: 'flex-end' },
  jumpBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.bgRaised,
    borderWidth: 1,
    borderColor: t.colors.line,
  },
  jumpPressed: { backgroundColor: t.colors.bgActive },
  title: { alignItems: 'center', maxWidth: 220, minHeight: 44, justifyContent: 'center' },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  composer: { paddingHorizontal: space[3], paddingTop: space[1], backgroundColor: t.colors.bgCanvas },
  attachError: { marginBottom: space[2] },
  queued: { alignItems: 'flex-end', gap: space[1] },
  queuedBubble: {
    maxWidth: '88%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: t.radius.lg,
    borderBottomRightRadius: t.radius.xs,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: t.colors.lineStrong,
  },
}))
