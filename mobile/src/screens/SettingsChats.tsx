import { useState } from 'react'
import { Archive, Bot, CornerDownRight, Folders, Shield, Trash2, Wrench } from 'lucide-react-native'
import { AGENTS, type AgentId } from '~/types/chat'
import type { PermissionMode } from '~/agents/types'
import { useTheme } from '@/theme'
import { AgentIcon, ListRow, ListSection, ToggleRow } from '@/ui'
import { usePrefs } from '@/state/prefs'
import { HOME_VIEWS, modeLabel, MODES, TOOL_CALLS, type FollowUp, type HomeView, type ToolCalls } from '@/state/prefsModel'
import { OptionSheet } from './OptionSheet'

const FOLLOW_UPS: ReadonlyArray<{ value: FollowUp; label: string; hint: string }> = [
  { value: 'queue', label: 'Queue', hint: 'A message written while the agent works waits for its turn to end.' },
  { value: 'steer', label: 'Steer', hint: 'It goes to the agent at once, to change course mid-turn.' },
]

type Picking = 'home' | 'mode' | 'agent' | 'tools' | 'follow' | null

const AGENT_IDS = Object.keys(AGENTS) as AgentId[]
const AGENT_OPTIONS = [
  { value: 'ask', label: 'Ask each time', hint: 'Pick Claude Code or Codex when you start a chat.' },
  ...AGENT_IDS.map(a => ({ value: a, label: AGENTS[a].name, hint: undefined })),
] as ReadonlyArray<{ value: AgentId | 'ask'; label: string; hint?: string }>

/** Settings > Chats: what a new chat starts with, what a chat shows, and how a message sent mid-run behaves. */
export function ChatsSection() {
  const t = useTheme()
  const { homeView, defaultMode, defaultAgent, toolCalls, followUp } = usePrefs()
  const [picking, setPicking] = useState<Picking>(null)
  const close = () => setPicking(null)
  const icon = { size: 20, strokeWidth: 1.75, color: t.colors.fgSubtle }
  return (
    <>
      <ListSection footer="How the Home screen lists your chats.">
        <ListRow
          title="Home list"
          leading={<Folders {...icon} />}
          detail={HOME_VIEWS.find(o => o.value === homeView)?.label}
          onPress={() => setPicking('home')}
        />
      </ListSection>

      <ListSection footer="Defaults for new chats. You can change the agent, model and permissions in any chat.">
        <ListRow
          title="Permissions"
          leading={<Shield {...icon} />}
          detail={modeLabel(defaultMode)}
          onPress={() => setPicking('mode')}
        />
        <ListRow
          title="Agent"
          leading={defaultAgent ? <AgentIcon agent={defaultAgent} size={20} color={t.colors.fgSubtle} /> : <Bot {...icon} />}
          detail={defaultAgent ? AGENTS[defaultAgent].name : 'Ask each time'}
          onPress={() => setPicking('agent')}
        />
        <ListRow
          title="Tool calls"
          leading={<Wrench {...icon} />}
          detail={TOOL_CALLS.find(o => o.value === toolCalls)?.label}
          onPress={() => setPicking('tools')}
        />
        <ListRow
          title="Messages while it works"
          leading={<CornerDownRight {...icon} />}
          detail={FOLLOW_UPS.find(o => o.value === followUp)?.label}
          onPress={() => setPicking('follow')}
        />
      </ListSection>

      <OptionSheet<HomeView>
        visible={picking === 'home'}
        title="Home list"
        options={HOME_VIEWS}
        value={homeView}
        onChange={v => usePrefs.getState().set('homeView', v)}
        onClose={close}
      />
      <OptionSheet<PermissionMode>
        visible={picking === 'mode'}
        title="Permissions"
        options={MODES}
        value={defaultMode}
        onChange={v => usePrefs.getState().set('defaultMode', v)}
        onClose={close}
        footer="How much an agent may do before it checks with you."
      />
      <OptionSheet<AgentId | 'ask'>
        visible={picking === 'agent'}
        title="Agent"
        options={AGENT_OPTIONS}
        value={defaultAgent ?? 'ask'}
        onChange={v => usePrefs.getState().set('defaultAgent', v === 'ask' ? null : v)}
        onClose={close}
        footer="Listed first, marked Default, when you start a chat."
      />
      <OptionSheet<ToolCalls>
        visible={picking === 'tools'}
        title="Tool calls"
        options={TOOL_CALLS}
        value={toolCalls}
        onChange={v => usePrefs.getState().set('toolCalls', v)}
        onClose={close}
        footer="Which commands, edits and searches a chat lists. Approvals, questions and errors always show."
      />
      <OptionSheet<FollowUp>
        visible={picking === 'follow'}
        title="Messages while it works"
        options={FOLLOW_UPS}
        value={followUp}
        onChange={v => usePrefs.getState().set('followUp', v)}
        onClose={close}
      />
    </>
  )
}

/** Settings > Confirmations: the questions Mango asks before it changes your chats. */
export function ConfirmSection() {
  const t = useTheme()
  const confirmArchive = usePrefs(s => s.confirmArchive)
  const confirmDelete = usePrefs(s => s.confirmDelete)
  return (
    <ListSection footer="Mango asks before it changes your chats. A deleted chat is gone on every computer.">
      <ToggleRow
        title="Archiving a chat"
        leading={<Archive size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
        value={confirmArchive}
        onChange={on => usePrefs.getState().set('confirmArchive', on)}
      />
      <ToggleRow
        title="Deleting a chat"
        leading={<Trash2 size={20} strokeWidth={1.75} color={t.colors.fgSubtle} />}
        value={confirmDelete}
        onChange={on => usePrefs.getState().set('confirmDelete', on)}
      />
    </ListSection>
  )
}
