import type { PermissionMode } from '~/agents/types'
import { AGENTS, type AgentId } from '~/types/chat'
import { notifyPrefsOf, type NotifyPrefs } from '~/utils/notifications'

/**
 * The phone's preferences (Settings), as plain data: the desktop's Preferences, Behaviour and
 * Notifications that make sense on a phone. Kept apart from the store so it runs in plain Node.
 */

/** What a chat shows of the tools an agent runs (the desktop's Settings > Behaviour). */
export type ToolCalls = 'all' | 'hide-ok' | 'hide' | 'zen'
/** What a message sent during a turn does: wait for the turn to end, or go to the agent right away. */
export type FollowUp = 'queue' | 'steer'

/** How Home lists chats: a folder per project (open one for its chats), or every chat in one list. */
export type HomeView = 'projects' | 'latest'

export interface AppPrefs {
  homeView: HomeView
  toolCalls: ToolCalls
  /** The permission mode a new chat starts with. */
  defaultMode: PermissionMode
  /** Projects with their own mode for new chats, by project path; the others use `defaultMode`. */
  projectModes: Record<string, PermissionMode>
  /** The agent a new chat starts with; null asks every time. */
  defaultAgent: AgentId | null
  followUp: FollowUp
  /** Ask before a chat moves to Archived. */
  confirmArchive: boolean
  /** Ask before a chat and its messages are deleted. */
  confirmDelete: boolean
  notify: NotifyPrefs
}

export const MODES: ReadonlyArray<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'plan', label: 'Plan', hint: 'Read-only. The agent explores and proposes a plan; it changes nothing.' },
  { value: 'ask', label: 'Ask first', hint: 'The agent asks before every edit and every command.' },
  { value: 'edits', label: 'Accept edits', hint: 'The agent edits files without asking, and still asks before commands.' },
  { value: 'auto', label: 'Full auto', hint: 'The agent never asks. It edits files and runs commands on its own.' },
]

export const TOOL_CALLS: ReadonlyArray<{ value: ToolCalls; label: string; hint: string }> = [
  { value: 'all', label: 'Show all', hint: 'Every command, edit and search an agent runs.' },
  { value: 'hide-ok', label: 'Hide successful', hint: 'Only the ones that failed.' },
  { value: 'hide', label: 'Hide all', hint: 'Just the conversation.' },
  { value: 'zen', label: 'Zen', hint: 'Only final answers.' },
]

export const HOME_VIEWS: ReadonlyArray<{ value: HomeView; label: string; hint: string }> = [
  { value: 'projects', label: 'By project', hint: 'A folder per project. Open one to see its chats.' },
  { value: 'latest', label: 'Latest first', hint: 'Every chat in one list, the newest on top.' },
]

export const DEFAULT_PREFS: AppPrefs = {
  homeView: 'projects',
  toolCalls: 'all',
  defaultMode: 'ask',
  projectModes: {},
  defaultAgent: null,
  followUp: 'queue',
  confirmArchive: false,
  confirmDelete: true,
  // Notifications ask the system for permission, so they start off here (on the desktop they start on).
  notify: { ...notifyPrefsOf({}), enabled: false },
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback

const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

const MODE_VALUES = MODES.map(m => m.value)

/** The saved per-project modes, dropping anything that is not a known mode. */
function projectModesOf(v: unknown): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {}
  if (v && typeof v === 'object') {
    for (const [path, mode] of Object.entries(v as Record<string, unknown>)) {
      if (typeof mode === 'string' && (MODE_VALUES as string[]).includes(mode)) out[path] = mode as PermissionMode
    }
  }
  return out
}

/** The mode a new chat in this project starts with: the project's own, else the default. */
export const modeForProject = (prefs: Pick<AppPrefs, 'defaultMode' | 'projectModes'>, path: string): PermissionMode =>
  prefs.projectModes[path] ?? prefs.defaultMode

/** Preferences from whatever was saved, tolerating missing, old or hand-edited data. */
export function normalizePrefs(raw: unknown): AppPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const notify = (o.notify && typeof o.notify === 'object' ? o.notify : {}) as Record<string, unknown>
  return {
    homeView: oneOf(o.homeView, HOME_VIEWS.map(v => v.value), DEFAULT_PREFS.homeView),
    toolCalls: oneOf(o.toolCalls, TOOL_CALLS.map(t => t.value), DEFAULT_PREFS.toolCalls),
    defaultMode: oneOf(o.defaultMode, MODES.map(m => m.value), DEFAULT_PREFS.defaultMode),
    projectModes: projectModesOf(o.projectModes),
    defaultAgent: typeof o.defaultAgent === 'string' && o.defaultAgent in AGENTS ? (o.defaultAgent as AgentId) : null,
    followUp: oneOf(o.followUp, ['queue', 'steer'] as const, DEFAULT_PREFS.followUp),
    confirmArchive: flag(o.confirmArchive, DEFAULT_PREFS.confirmArchive),
    confirmDelete: flag(o.confirmDelete, DEFAULT_PREFS.confirmDelete),
    notify: { ...notifyPrefsOf(notify), enabled: flag(notify.enabled, DEFAULT_PREFS.notify.enabled) },
  }
}

/** A mode in a few words, for the end of a line ("Opus · asks before edits"). */
export const MODE_SHORT: Record<PermissionMode, string> = {
  plan: 'plans only',
  ask: 'asks before edits',
  edits: 'accepts edits',
  auto: 'never asks',
}

export const modeLabel = (mode: PermissionMode) => MODES.find(m => m.value === mode)?.label ?? mode
