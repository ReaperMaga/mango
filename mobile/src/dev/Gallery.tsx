import { useMemo, useState, type ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { FolderGit2, Inbox, Moon, Plus, RefreshCw, Server, Settings, Smartphone, Sun } from 'lucide-react-native'
import type { AgentQuestion, Message, PermissionMode, Thread } from '~/types/chat'
import { demoThreads } from '~/utils/demoThreads'
import { makeStyles, space, useAppearance, useTheme, type Appearance } from '@/theme'
import { OFFLINE, reconnectingText } from '@/screens/names'
import { Badge, Banner, Button, ButtonRow, EmptyState, IconButton, ListRow, ListSection, MangoMark, RipenessDot, Segmented, Sheet, Spinner, Text, TextField, type DotStatus } from '@/ui'
import { ChangeRow, ChatComposer, ChatDiff, ChatMessage, ChatWorking, ThreadRow, useNow, type ChangeRowFile } from '@/chat'

/**
 * Every component of the phone UI with realistic data, for the web preview and the simulator.
 * Not part of the app: the integrator points the index route back at the real screens.
 */

const PROJECT = 'env://demo/dev/home/you/mango'

const markdown = `## What changed

The terminal panel now runs your login shell through a **real PTY**, and output streams over \`pty://data\`.

1. Split UTF-8 sequences are buffered, so *box-drawing* characters arrive intact.
2. Each tab keeps its xterm instance mounted while hidden.
   - nested: resizing calls \`pty_resize\` after a fit

- [x] Wire \`pty_spawn\`
- [ ] Persist scrollback

\`\`\`rust
pub fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    STATE.with(|s| s.resize(id, cols, rows)).map_err(|e| e.to_string())
}
\`\`\`

| Command | Time | Result |
|---|--:|---|
| cargo check | 14.2s | ok |
| pnpm typecheck | 9.8s | ok |

> Raw HTML stays text: <img src="https://example.com/x.png" onerror="alert(1)"> and pictures show their alt text: ![a screenshot of the panel](https://example.com/shot.png)

See [the Tauri docs](https://tauri.app) or [a local file](file:///etc/passwd); run \`pnpm app\` and toggle the panel with **Ctrl+J**.`

const questions: AgentQuestion[] = [
  {
    header: 'Storage',
    question: 'Where should chat history live?',
    options: [
      { label: 'SQLite file', description: 'One row per chat, in the app data folder' },
      { label: 'JSON files', description: 'One file per chat, easy to inspect' },
    ],
    freeText: true,
  },
  {
    question: 'Which platforms must keep compiling?',
    multiSelect: true,
    options: [{ label: 'macOS' }, { label: 'Windows' }, { label: 'Linux' }],
    preset: ['macOS'],
  },
  { question: 'Paste the deploy token', options: [], secret: true, optional: true },
]

const changes: ChangeRowFile[] = [
  { path: 'src-tauri/src/pty.rs', kind: 'added', additions: 142, deletions: null },
  { path: 'src-tauri/src/lib.rs', kind: 'modified', staged: true, additions: 6, deletions: 1 },
  { path: 'app/components/terminal/TerminalPanel.vue', kind: 'modified', additions: 31, deletions: 12 },
  { path: 'app/components/terminal/OldTerminal.vue', kind: 'deleted', additions: null, deletions: 88 },
  { path: 'docs/notes/pty.md', kind: 'untracked', additions: null, deletions: null },
  { path: 'app/stores/workspace.ts', kind: 'conflicted', additions: 3, deletions: 3 },
]

const gitDiff = `diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs
index 3f2a1c4..9b0e7d2 100644
--- a/src-tauri/src/lib.rs
+++ b/src-tauri/src/lib.rs
@@ -12,7 +12,12 @@ mod projects;
 mod git;
 mod projects;
+mod pty;

 pub fn run() {
     tauri::Builder::default()
-        .invoke_handler(tauri::generate_handler![open_project])
+        .manage(pty::PtyState::default())
+        .invoke_handler(tauri::generate_handler![
+            open_project, pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill,
+        ])
         .run(tauri::generate_context!())
         .expect("error while running tauri application");
 }
`

const STATUSES: DotStatus[] = ['archived', 'queued', 'running', 'working', 'waiting', 'done', 'error']

export function Gallery({ sheetOpen = false }: { sheetOpen?: boolean }) {
  const t = useTheme()
  const s = useStyles()
  const insets = useSafeAreaInsets()
  const { appearance, setAppearance } = useAppearance()
  const now = useNow()

  const threads = useMemo<Thread[]>(() => demoThreads(PROJECT), [])
  const done = threads.find(x => x.status === 'done')!
  const waiting = threads.find(x => x.status === 'waiting')!
  const running = threads.find(x => x.status === 'running')!
  const failed = threads.find(x => x.status === 'error')!

  const extra = useMemo<Message[]>(() => [
    { id: 'u1', role: 'user', createdAt: now - 60_000, parts: [{ type: 'text', text: 'Summarise what you changed, with the commands you ran.' }] },
    { id: 'a1', role: 'agent', createdAt: now - 50_000, elapsedMs: 74_000, outcome: 'done', parts: [{ type: 'text', text: markdown }] },
    {
      id: 'a2', role: 'agent', createdAt: now - 40_000, parts: [
        { type: 'question', questions, state: 'pending' },
        { type: 'notice', level: 'error', text: 'Claude Code is not signed in. Sign in from Settings > Agents, then send again.' },
      ],
    },
  ], [now])

  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [model, setModel] = useState('opus')
  const [effort, setEffort] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState(sheetOpen)
  const [host, setHost] = useState('forge.example.com')
  const [loading, setLoading] = useState(false)

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { paddingTop: insets.top + space[4], paddingBottom: insets.bottom + space[12] }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={s.top}>
        <MangoMark size={28} />
        <Text variant="display" style={s.flex}>Mango</Text>
        <IconButton icon={Settings} label="Settings" onPress={() => setSheet(true)} />
      </View>
      <Segmented<Appearance>
        label="Appearance"
        value={appearance}
        onChange={setAppearance}
        options={[
          { value: 'system', label: 'System', icon: Smartphone },
          { value: 'dark', label: 'Dark', icon: Moon },
          { value: 'light', label: 'Light', icon: Sun },
        ]}
      />

      <Section title="Ripeness">
        <View style={s.dots}>
          {STATUSES.map(st => (
            <View key={st} style={s.dotCell}>
              <RipenessDot status={st} size={18} />
              <Text variant="micro" tone="subtle">{st}</Text>
            </View>
          ))}
        </View>
        <View style={s.dots}>
          <RipenessDot status="done" size={14} unseen />
          <RipenessDot status="waiting" size={14} unseen />
          <RipenessDot status="running" size={24} />
          <RipenessDot status="waiting" size={32} />
          <MangoMark size={32} />
          <Spinner size={16} color={t.colors.ripeRunning} label="Loading" />
        </View>
      </Section>

      <Section title="Chats">
        <ListSection title="mango" aside={<Badge label="5" />}>
          {threads.map(th => <ThreadRow key={th.id} thread={th} now={now} onPress={() => {}} />)}
          <ThreadRow thread={{ ...done, id: 'pc-1', status: 'working', title: 'Run on the desktop' }} elsewhere={{ status: 'running', at: now }} now={now} onPress={() => {}} />
          <ThreadRow thread={{ ...done, id: 'pc-2', status: 'working', title: 'Asking on the desktop' }} elsewhere={{ status: 'waiting', at: now }} now={now} onPress={() => {}} />
        </ListSection>
      </Section>

      <Section title="Environments">
        <ListSection title="Servers" footer="Mango reaches them over SSH with this phone's own key.">
          <ListRow title="forge" subtitle="3 instances · 2 running" leading={<Server size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} detail="2" onPress={() => {}} />
          <ListRow title="/home/you/mango" mono subtitle="feat/terminal" leading={<FolderGit2 size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />} onPress={() => {}} />
          <ListRow title="Remove this server" destructive onPress={() => {}} accessory="none" />
        </ListSection>
      </Section>

      <Section title="Changes">
        <ListSection title="feat/terminal" aside={<ButtonRow><Badge label="↑2" tone="accent" /></ButtonRow>}>
          {changes.map(c => <ChangeRow key={c.path} change={c} onPress={() => {}} />)}
        </ListSection>
        <ChatDiff text={gitDiff} />
        <ChatDiff text={null} />
        <ChatDiff text="Binary files a/icon.png and b/icon.png differ" />
      </Section>

      <Section title="Conversation">
        <View style={s.chat}>
          {done.messages.map((m, i) => <ChatMessage key={m.id} message={m} thread={done} last={i === done.messages.length - 1} />)}
          {extra.map(m => <ChatMessage key={m.id} message={m} thread={done} onAnswerQuestion={() => {}} />)}
          {waiting.messages.map((m, i) => <ChatMessage key={m.id} message={m} thread={waiting} last={i === waiting.messages.length - 1} onResolveApproval={() => {}} />)}
          <ChatWorking thread={waiting} />
          {running.messages.map((m, i) => <ChatMessage key={m.id} message={m} thread={running} last={i === running.messages.length - 1} />)}
          <ChatWorking thread={running} />
          <ChatWorking thread={running} reconnectingTo="forge" />
          <ChatWorking thread={{ ...running, status: 'working' }} elsewhere={{ status: 'running', at: now }} />
          <ChatWorking thread={{ ...running, status: 'working' }} elsewhere={{ status: 'waiting', at: now }} />
          <ChatWorking thread={{ ...running, status: 'working' }} elsewhere={{ status: 'running', at: now - 14 * 60000 }} />
          {failed.messages.map(m => <ChatMessage key={m.id} message={m} thread={failed} />)}
          <ChatMessage
            thread={done}
            message={{ id: 'r', role: 'agent', createdAt: now, parts: [
              { type: 'approval', command: 'rm -rf target', reason: '', state: 'allowed' },
              { type: 'approval', command: 'git push --force', reason: '', state: 'denied' },
              { type: 'question', questions: questions.slice(0, 2), state: 'answered', answers: [['SQLite file'], ['macOS', 'Linux']] },
            ] }}
          />
        </View>
        <ChatComposer
          value={draft}
          onChangeText={setDraft}
          onSend={() => { setDraft(''); setBusy(true) }}
          onStop={() => setBusy(false)}
          running={busy}
          agent="claude"
          model={model}
          mode={mode}
          effort={effort}
          onModelChange={setModel}
          onModeChange={setMode}
          onEffortChange={setEffort}
        />
      </Section>

      <Section title="Buttons">
        <ButtonRow>
          <Button label="Allow once" variant="primary" />
          <Button label="Connect" icon={Plus} />
          <Button label="Cancel" variant="ghost" />
          <Button label="Discard" variant="danger" />
        </ButtonRow>
        <ButtonRow>
          <Button label="Refresh" size="sm" icon={RefreshCw} loading={loading} onPress={() => { setLoading(true); setTimeout(() => setLoading(false), 1500) }} />
          <Button label="Disabled" size="sm" disabled />
          <IconButton icon={RefreshCw} label="Refresh" />
          <IconButton icon={Settings} label="Settings" active />
          <IconButton icon={Plus} label="New chat" size="sm" />
        </ButtonRow>
        <Button label="Commit 6 files" variant="primary" size="lg" block />
        <View style={s.dots}>
          <Badge label="Simulated" dashed />
          <Badge label="Working" tone="running" />
          <Badge label="Needs you" tone="waiting" />
          <Badge label="Settled" tone="done" />
          <Badge label="Failed" tone="error" />
          <Badge label="12" tone="accent" />
        </View>
      </Section>

      <Section title="Fields and messages">
        <TextField label="Host" value={host} onChangeText={setHost} mono autoCapitalize="none" hint="A name from ~/.ssh/config, or user@host:port." />
        <TextField label="Name" placeholder="forge" error="That name is taken by another server." />
        <Banner tone="error" title="Could not connect" message="ssh: connect to host forge.example.com port 22: Operation timed out. Check the host and that the server is up, then try again." action={<Button label="Try again" size="sm" />} onDismiss={() => {}} />
        <Banner tone="waiting" message="2 chats need you: an approval and a question." />
        <Banner message="Replies here are simulated: there is no server behind the web preview." />
        <Banner title={OFFLINE.title} message={OFFLINE.message} />
        <Banner message={reconnectingText(['forge'])} />
      </Section>

      <Section title="Empty">
        <View style={s.panel}>
          <EmptyState
            icon={Inbox}
            title="No chats in this project yet"
            body="Start one here, or on the desktop: chats in an environment show up on every computer that opens it."
            action={<Button label="New chat" variant="primary" icon={Plus} />}
          />
        </View>
      </Section>

      <Sheet visible={sheet} onClose={() => setSheet(false)} title="Settings">
        <ListSection title="Appearance">
          {(['system', 'dark', 'light'] as const).map(a => (
            <ListRow key={a} title={a === 'system' ? 'Match the phone' : a === 'dark' ? 'Dark' : 'Light'} accessory={appearance === a ? 'check' : 'none'} onPress={() => setAppearance(a)} />
          ))}
        </ListSection>
      </Sheet>
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const s = useStyles()
  return (
    <View style={s.section}>
      <Text variant="headline" accessibilityRole="header">{title}</Text>
      {children}
    </View>
  )
}

const useStyles = makeStyles(t => ({
  screen: { flex: 1, backgroundColor: t.colors.bgCanvas },
  content: { paddingHorizontal: space[4], gap: space[4] },
  top: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  flex: { flex: 1 },
  section: { gap: space[4], marginTop: space[6] },
  dots: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[3] },
  dotCell: { alignItems: 'center', gap: space[1], minWidth: 40 },
  chat: { gap: space[5] },
  panel: { backgroundColor: t.colors.bgPanel, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.lineSoft },
}))
