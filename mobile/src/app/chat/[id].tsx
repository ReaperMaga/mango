import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Camera, Ellipsis, FolderOpen, GitCompareArrows, Image as ImageIcon } from 'lucide-react-native'
import { AGENTS, type Message, type Thread } from '~/types/chat'
import { makeStyles, radius, space, useTheme } from '@/theme'
import { Badge, Banner, Button, ButtonRow, EmptyState, IconButton, ListRow, ListSection, Sheet, Text, haptic } from '@/ui'
import { ChatComposer, ChatMessage, ChatWorking } from '@/chat'
import { envOf } from '@/remote/chatSync'
import { useEnvs } from '@/state/envs'
import { isBusy, useThreads, type QueuedMessage } from '@/state/threads'
import { ThreadActions } from '@/screens/ThreadActions'
import { useAttachments, type AttachSource } from '@/screens/useAttachments'
import { placeOf, projectName } from '@/screens/names'

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
  const at = thread ? envOf(thread.projectPath) : null
  const env = useEnvs(st => (at ? st.envs.find(e => e.id === at.hostId) ?? null : null))
  const conn = useEnvs(st => (at ? st.status[at.hostId] : undefined))
  const [menu, setMenu] = useState(false)
  const [keyboard, setKeyboard] = useState(false)
  const [attachMenu, setAttachMenu] = useState(false)
  const files = useAttachments(thread?.projectPath ?? null)
  const list = useRef<FlatList<Message>>(null)
  const atBottom = useRef(true)

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
            <IconButton icon={GitCompareArrows} label="Changes" onPress={() => router.push({ pathname: '/changes', params: { path: thread.worktree ?? thread.projectPath } })} />
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
      <FlatList
        ref={list}
        data={thread.messages}
        keyExtractor={m => m.id}
        renderItem={({ item, index }) => (
          <Item
            message={item}
            thread={thread}
            last={index === thread.messages.length - 1}
            onOpenChild={childId => router.push({ pathname: '/chat/[id]', params: { id: childId } })}
          />
        )}
        contentContainerStyle={[s.content, !thread.messages.length && s.emptyContent]}
        ListHeaderComponent={(
          <View style={s.head}>
            {thread.simulated ? <Badge label="Simulated" dashed style={s.center} /> : null}
            {conn?.state === 'error' && env
              ? <Banner tone="error" message={`${env.name} can't be reached right now, so messages can't go out. ${conn.message ?? ''}`.trim()} />
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
            {busy ? <ChatWorking thread={thread} waitingOnTasks={tasksLeft} /> : null}
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
        />
      </View>
      <Sheet visible={attachMenu} onClose={() => setAttachMenu(false)} title="Attach">
        <ListSection footer={`Files go into ${env?.name ?? 'the environment'}, where ${agentName} reads them. Pictures are also shown to it directly.`}>
          <ListRow title="Photo Library" leading={<ImageIcon size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => attachFrom('photos')} />
          <ListRow title="Take Photo" leading={<Camera size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => attachFrom('camera')} />
          <ListRow title="Choose File" leading={<FolderOpen size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} accessory="none" onPress={() => attachFrom('files')} />
        </ListSection>
      </Sheet>
      <ThreadActions threadId={id} visible={menu} onClose={() => setMenu(false)} onDeleted={() => router.back()} />
    </KeyboardAvoidingView>
  )
}

/**
 * One message. Kept from re-rendering while another message streams: a chat's snapshot changes on
 * every chunk, but only the message being written (and the last one's live state) needs drawing.
 */
const Item = memo(function Item({ message, thread, last, onOpenChild }: { message: Message; thread: Thread; last: boolean; onOpenChild: (id: string) => void }) {
  const store = useThreads.getState()
  return (
    <ChatMessage
      message={message}
      thread={thread}
      last={last}
      onResolveApproval={(i, allow) => store.resolveApproval(thread.id, message.id, i, allow)}
      onAnswerQuestion={(i, answers) => store.answerQuestion(thread.id, message.id, i, answers)}
      onOpenChild={onOpenChild}
    />
  )
}, (a, b) => a.message === b.message && a.last === b.last && a.thread.agent === b.thread.agent
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
  title: { alignItems: 'center', maxWidth: 220, minHeight: 44, justifyContent: 'center' },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  composer: { paddingHorizontal: space[3], paddingTop: space[1], backgroundColor: t.colors.bgCanvas },
  attachError: { marginBottom: space[2] },
  queued: { alignItems: 'flex-end', gap: space[1] },
  queuedBubble: {
    maxWidth: '88%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.xs,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: t.colors.lineStrong,
  },
}))
