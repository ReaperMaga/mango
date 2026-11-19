import { create } from 'zustand'
import type { AgentId, Attachment, BackgroundTask, LinkedItem, Message, Part, PermissionMode, QuestionAnswers, Thread } from '~/types/chat'
import { AGENTS, awaitsUser } from '~/types/chat'
import { createdBy } from '~/utils/githubLinks'
import { createPrPrompt } from '~/utils/createPr'
import { branchFromMessage, untakenName, workdirOf, worktreeName } from '~/utils/worktrees'
import { backend } from '@/remote'
import { attachRemoteChats, noteSaved } from '@/remote/chatSync'
import { answerQuestion as answerRun, interruptRun, isRunning, respondApproval, runAgentTurn, steerRun, stopTask } from '@/agents/run'
import { type ChatFiles, ChatHistory } from '@/state/chatHistory'
import { chatFiles } from '@/state/chatFiles'
import { byListOrder, errorText, isBusy, isClear, isCommand, isSafeId, normalizeLoaded, titleFrom, uid } from '@/state/threadModel'

/**
 * The phone's chats: a zustand port of the desktop's `app/stores/threads.ts`, without what only a
 * desktop has (tabs, panes, the links panel). "New chat in a worktree" works as on the desktop: the
 * worktree is added inside the environment on the first send (`_addWorktreeFor`). A chat is the desktop's `Thread`,
 * stored and shaped the same, so either app shows and continues what the other wrote.
 *
 * Chats are immutable snapshots: change one only through `edit` (or the actions), which replaces
 * it with a changed copy, so a component that selects a chat or a message re-renders when it
 * changes. Selectors that build a list (`byProject`) return a new array each time: use them with
 * `useShallow` (`zustand/react/shallow`).
 *
 * Saving: every change marks the chat for the debounced save (`persist`), which writes the phone's
 * own copy (`chatHistory.ts`) and hands remote projects' chats to `chatSync` for their environment.
 */

export { isBusy }

/** A message written while the agent works: it waits for the turn to end unless the user sends it now. */
export interface QueuedMessage {
  id: string
  text: string
  attachments: Attachment[]
  /** Already in the chat (sent now, but the run could not take it): only its turn is still due. */
  shown?: boolean
}

/** What a running chat has going on besides its reply. Not saved: it dies with the run. */
export interface LiveState {
  /** Background commands and sub-agents of the run, finished ones included until it ends. */
  tasks: BackgroundTask[]
  /** The agent has answered and only waits on background tasks. */
  idle: boolean
  /**
   * The run's connection to its environment dropped and it is being attached again: the agent
   * keeps working there meanwhile, so the chat stays Working.
   */
  reconnecting?: boolean
}

/** What a message sent during a turn does: wait for the turn to end, or go to the agent right away. */
export type FollowUp = 'queue' | 'steer'

export interface NewChat {
  projectPath: string
  agent: AgentId
  model?: string
  mode?: PermissionMode
  effort?: string | null
  branch?: string | null
  /**
   * "New chat in a worktree": the chat runs nowhere until its first message, which names a new
   * branch and adds a linked worktree for it (inside the environment) before the agent starts.
   */
  inWorktree?: boolean
}

export interface ThreadsState {
  threads: Record<string, Thread>
  /** The saved chats have been read. */
  loaded: boolean
  /** Per chat id, while its run has background work (see LiveState). */
  live: Record<string, LiveState>
  /** Per chat id: messages waiting for the running turn to end. Not saved. */
  queue: Record<string, QueuedMessage[]>
  /** Per chat id: what is typed in its composer and not sent yet. Not saved. */
  drafts: Record<string, string>
  /** The chat on screen: a turn that finishes there counts as seen. */
  viewing: string | null
  followUp: FollowUp

  /* ---- reading ---- */
  byId(id: string | null | undefined): Thread | null
  /** A project's chats in list order, without archived ones and sub-agents (those sit under their parent). */
  byProject(path: string): Thread[]
  archivedFor(path: string): Thread[]
  /** The sub-agent chats a chat (or a sub-agent) started, oldest first. */
  childrenOf(id: string): Thread[]
  /** The top-level chat a sub-agent chat belongs to (a top-level chat is its own). */
  rootOf(id: string): Thread | null
  /** The folder a chat works in: its top-level chat's worktree, or the project. */
  workdirFor(id: string | null | undefined): string | null
  liveOf(id: string): LiveState | undefined
  /** Chats that need the user: a question or approval open, or a finished turn not seen yet. */
  attentionCount(): number

  /* ---- loading and saving ---- */
  /** Read the saved chats (`files`: where; the platform's store by default) and start saving and syncing. */
  load(files?: ChatFiles): Promise<void>
  /** Save soon. With ids, only those chats are compared; without, all are, which also drops deleted ones. */
  persist(ids?: string | string[]): void
  /** Save what is pending now. */
  flush(): Promise<boolean>
  /** What `chatSync` reads and changes (its `RemoteSource`). */
  remoteSource(): {
    byId: (id: string) => Thread | null
    threads: () => Thread[]
    busy: (t: Thread) => boolean
    adopt: (threads: Thread[]) => Thread[]
    drop: (ids: string[]) => void
  }

  /* ---- chats ---- */
  create(opts: NewChat): Thread
  rename(id: string, title: string): void
  /** Put a chat away: it leaves the list, nothing is deleted. */
  archive(id: string): void
  unarchive(id: string): void
  /** Delete a chat, with the sub-agent chats under it. */
  remove(id: string): void
  /** Set a chat's status by hand: Working, or Settled. While an agent runs, the run owns the status. */
  setStatus(id: string, status: 'working' | 'done'): void
  setAgent(id: string, agent: AgentId): void
  /** `efforts`: the levels the new model accepts; an effort it doesn't know is dropped. */
  setModel(id: string, model: string, efforts?: string[]): void
  setEffort(id: string, effort: string | null): void
  setMode(id: string, mode: PermissionMode): void
  setDraft(id: string, text: string): void
  setViewing(id: string | null): void
  setFollowUp(followUp: FollowUp): void
  link(id: string, link: LinkedItem): boolean
  unlink(id: string, key: string): void

  /* ---- talking to the agent ---- */
  /**
   * Append a user message and start the agent. While the agent is working the message waits in the
   * chat's queue and goes out as the next turn; with `followUp` 'steer' (or `opposite` flipping it)
   * it goes to the running turn instead.
   */
  send(id: string, text: string, attachments?: Attachment[], opposite?: boolean): Promise<void>
  /** Give a waiting message to the running turn now; one it cannot take is answered next. */
  sendNow(id: string, queuedId: string): Promise<void>
  /** Take a waiting message back without sending it. */
  dropQueued(id: string, queuedId: string): void
  /** Answer an approval request inside a message. */
  resolveApproval(threadId: string, messageId: string, partIndex: number, allow: boolean): void
  /** Answer an agent's questions (null: dismissed without an answer). */
  answerQuestion(threadId: string, messageId: string, partIndex: number, answers: QuestionAnswers | null): void
  stop(id: string): void
  /** Stop one background task or sub-agent of the chat's run. */
  stopTask(threadId: string, taskOrToolId: string): void

  /* ---- low level: the agent driver (`agents/turn.ts`) and chat sync ---- */
  /**
   * Change chat `id`: `fn` gets a copy of it (with the messages in `msgIds` copied too, and their
   * parts; 'all' for every message) to change in place, which then replaces the chat. Messages not
   * listed are shared with the old snapshot and must not be changed. Returns what `fn` returns.
   */
  edit<R>(id: string, fn: (draft: Thread) => R, msgIds?: readonly string[] | 'all'): R | undefined
  moveToWorktree(id: string, folder: string, branch: string | null): Promise<void>
  /**
   * Add the worktree a chat waits for: a new branch named after its first message (`-2`, `-3` …
   * when that branch or folder is taken), from the project's HEAD. Rejects with git's reason.
   */
  _addWorktreeFor(id: string): Promise<void>
  _adoptRemote(incoming: Thread[]): Thread[]
  _appendUser(id: string, text: string, attachments: Attachment[]): void
  _runTurn(id: string, text: string, attachments: Attachment[]): Promise<void>
  _sendFollowUps(id: string): Promise<void>
  _createSubagent(parentId: string, opts: { toolId: string; title: string; agentType?: string; prompt?: string }): Thread | null
  _linkCreated(id: string, part: Extract<Part, { type: 'tool' }>): void
  _taskStart(id: string, task: Omit<BackgroundTask, 'status' | 'startedAt'>): void
  _taskUpdate(id: string, taskId: string, patch: Partial<Pick<BackgroundTask, 'title' | 'activity'>>): void
  _taskEnd(id: string, taskId: string, status: BackgroundTask['status'], summary?: string): void
  _setIdle(id: string, idle: boolean): void
  /** The run lost its connection (true) or got it back (false). */
  _setReconnecting(id: string, on: boolean): void
  _clearLive(id: string): void
  _pushAgentMessage(id: string): Message | null
  _pushPart(id: string, msgId: string, part: Part): void
  /** `outcome` says how a run ended; a finished turn goes back to Working, never to Settled. */
  _setStatus(id: string, status: Thread['status'], outcome?: Message['outcome']): void
  /** The chat changed (an agent's output too): note the time, and save it soon. */
  _touch(id: string): void
}

/** A copy of `t` to change, with the listed messages (and their parts) copied as well. */
function draftOf(t: Thread, msgIds?: readonly string[] | 'all'): Thread {
  const own = msgIds === 'all' ? null : new Set(msgIds ?? [])
  return {
    ...t,
    messages: t.messages.map(m => (own === null || own.has(m.id) ? { ...m, parts: m.parts.map(p => ({ ...p })) } : m)),
  }
}

let history: ChatHistory | null = null
/** Chats whose queue waits for the user: the run was stopped, so nothing goes out by itself. */
const held = new Set<string>()

export const useThreads = create<ThreadsState>()((set, get) => ({
  threads: {},
  loaded: false,
  live: {},
  queue: {},
  drafts: {},
  viewing: null,
  followUp: 'queue',

  byId: id => (id ? get().threads[id] ?? null : null),
  byProject: path => Object.values(get().threads).filter(t => t.projectPath === path && !t.archived && !t.parentId).sort(byListOrder),
  archivedFor: path => Object.values(get().threads).filter(t => t.projectPath === path && t.archived && !t.parentId).sort((a, b) => b.updatedAt - a.updatedAt),
  childrenOf: id => Object.values(get().threads).filter(t => t.parentId === id).sort((a, b) => a.createdAt - b.createdAt),
  rootOf(id) {
    let t = get().byId(id)
    for (let hops = 0; t?.parentId && hops < 32; hops++) t = get().byId(t.parentId)
    return t
  },
  workdirFor(id) {
    const root = get().rootOf(id ?? '')
    return root ? workdirOf(root) : null
  },
  liveOf: id => get().live[id],
  attentionCount: () => Object.values(get().threads).filter(t => !t.archived && !t.parentId && (t.status === 'waiting' || (t.status === 'done' && !t.seen))).length,

  async load(files = chatFiles) {
    history?.dispose()
    const h = new ChatHistory(files, (changed, removed) => noteSaved(changed, removed))
    history = h
    let raw: Thread[] = []
    try {
      raw = await h.load()
    } catch (e) {
      console.error('Mango could not read its chats:', e)
    }
    const threads: Record<string, Thread> = {}
    for (const t of raw) {
      // Anything that was mid-run when the app closed is no longer running.
      try { threads[t.id] = normalizeLoaded(t) } catch { /* a chat that cannot be read is left out */ }
    }
    held.clear()
    set({ threads, loaded: true, live: {}, queue: {} })
    h.attach({ threads: () => Object.values(get().threads), byId: id => get().byId(id) })
    // Remote projects' chats are kept in their environment too (see `remote/chatSync.ts`).
    attachRemoteChats(get().remoteSource())
    // Statuses changed by loading (a run cut off by closing the app) are saved too.
    h.markChanged()
  },

  persist(ids) {
    history?.markChanged(ids)
  },

  flush() {
    return history?.flush() ?? Promise.resolve(true)
  },

  remoteSource() {
    return {
      byId: (id: string) => get().byId(id),
      threads: () => Object.values(get().threads),
      busy: (t: Thread) => isBusy(t) || isRunning(t.id),
      adopt: (incoming: Thread[]) => get()._adoptRemote(incoming),
      drop: (ids: string[]) => { for (const id of ids) if (get().byId(id)) get().remove(id) },
    }
  },

  /**
   * Chats from a remote project's environment (saved there by another computer, or by this phone
   * before): new ones are added, newer copies replace the ones here. Nothing in them runs here.
   */
  _adoptRemote(incoming) {
    const adopted: Thread[] = []
    for (const raw of incoming) {
      if (!raw || !isSafeId(raw.id) || !Array.isArray(raw.messages)) continue
      try { adopted.push(normalizeLoaded(raw)) } catch { /* unreadable: left out */ }
    }
    if (!adopted.length) return []
    set(s => ({ threads: { ...s.threads, ...Object.fromEntries(adopted.map(t => [t.id, t])) } }))
    get().persist(adopted.map(t => t.id))
    return adopted.map(t => get().byId(t.id)!)
  },

  create({ projectPath, agent, model, mode, effort, branch, inWorktree = false }) {
    const pick = model ?? AGENTS[agent].models[0]!.id
    // Reuse an untouched empty chat of the project (waiting for a worktree or not, as asked) instead of piling up "New chat" rows.
    const blank = Object.values(get().threads).find(x => x.projectPath === projectPath && !x.worktree && !!x.awaitingWorktree === inWorktree
      && x.messages.length === 0 && x.title === 'New chat' && !x.archived && !x.parentId)
    if (blank) {
      get().edit(blank.id, (d) => {
        d.agent = agent
        d.model = pick
        d.effort = effort ?? null
        if (mode) d.mode = mode
        d.seen = true
      })
      get().persist(blank.id)
      return get().byId(blank.id)!
    }
    const now = Date.now()
    const t: Thread = {
      id: uid('t'),
      projectPath,
      title: 'New chat',
      agent,
      model: pick,
      mode: mode ?? 'ask',
      effort: effort ?? null,
      status: 'working',
      messages: [],
      createdAt: now,
      updatedAt: now,
      seen: true,
      branch: branch ?? null,
      ...(inWorktree ? { awaitingWorktree: true as const } : {}),
    }
    set(s => ({ threads: { ...s.threads, [t.id]: t } }))
    get().persist(t.id)
    return t
  },

  rename(id, title) {
    if (!title.trim()) return
    get().edit(id, (d) => { d.title = title.trim() })
    get().persist(id)
  },

  archive(id) {
    const t = get().byId(id)
    if (!t || isBusy(t)) return
    get().edit(id, (d) => { d.archived = true; d.seen = true })
    get().persist(id)
  },

  unarchive(id) {
    get().edit(id, (d) => { d.archived = false })
    get().persist(id)
  },

  remove(id) {
    const all = Object.values(get().threads)
    const doomed = new Set([id])
    for (let grew = true; grew;) {
      grew = false
      for (const t of all) if (t.parentId && doomed.has(t.parentId) && !doomed.has(t.id)) { doomed.add(t.id); grew = true }
    }
    for (const x of doomed) held.delete(x)
    const without = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => !doomed.has(k)))
    set(s => ({
      threads: without(s.threads),
      queue: without(s.queue),
      drafts: without(s.drafts),
      viewing: s.viewing && doomed.has(s.viewing) ? null : s.viewing,
    }))
    get().persist()
  },

  setStatus(id, status) {
    const t = get().byId(id)
    if (!t || isBusy(t)) return
    get().edit(id, (d) => { d.status = status; d.seen = true; d.archived = false })
    get().persist(id)
  },

  setAgent(id, agent) {
    get().edit(id, (d) => {
      if (d.agent === agent) return
      d.agent = agent
      d.model = AGENTS[agent].models[0]!.id
      d.effort = null
      // Each CLI keeps its own conversation; the other agent starts fresh.
      d.sessionId = null
    })
    get().persist(id)
  },

  setModel(id, model, efforts) {
    get().edit(id, (d) => {
      d.model = model
      if (d.effort && efforts && !efforts.includes(d.effort)) d.effort = null
    })
    get().persist(id)
  },

  setEffort(id, effort) {
    get().edit(id, (d) => { d.effort = effort })
    get().persist(id)
  },

  setMode(id, mode) {
    get().edit(id, (d) => { d.mode = mode })
    get().persist(id)
  },

  setDraft(id, text) {
    set(s => {
      const drafts = { ...s.drafts }
      if (text) drafts[id] = text
      else delete drafts[id]
      return { drafts }
    })
  },

  setViewing(id) {
    set({ viewing: id })
    const t = get().byId(id)
    if (t && !t.seen && (t.status === 'working' || t.status === 'done')) {
      get().edit(t.id, (d) => { d.seen = true })
      get().persist(t.id)
    }
  },

  setFollowUp(followUp) {
    set({ followUp })
  },

  link(id, link) {
    const root = get().rootOf(id)
    if (!root) return false
    const had = root.links?.some(l => l.key === link.key) ?? false
    get().edit(root.id, (d) => {
      d.links = had
        ? d.links!.map(l => (l.key === link.key ? { ...l, url: link.url, kind: link.kind, ...(link.title ? { title: link.title } : {}), ...(link.state ? { state: link.state } : {}) } : l))
        : [...(d.links ?? []), { ...link }]
    })
    get().persist(root.id)
    return !had
  },

  unlink(id, key) {
    const root = get().rootOf(id)
    if (!root?.links) return
    get().edit(root.id, (d) => {
      const rest = (d.links ?? []).filter(l => l.key !== key)
      if (rest.length) d.links = rest
      else delete d.links
    })
    get().persist(root.id)
  },

  async send(id, text, attachments = [], opposite = false) {
    const t = get().byId(id)
    // A sub-agent's chat is written by its parent's run only.
    if (!t || t.parentId || (!text.trim() && !attachments.length)) return
    if (t.archived) get().edit(id, (d) => { d.archived = false }) // writing in an archived chat brings it back
    if (isBusy(t)) {
      const queued: QueuedMessage = { id: uid('q'), text: text.trim(), attachments }
      set(s => ({ queue: { ...s.queue, [id]: [...(s.queue[id] ?? []), queued] } }))
      // Steer: hand it to the running turn now. Queue: it waits for the turn to end. `opposite` flips the
      // setting for this one message. When the agent has answered and only background tasks keep the
      // run open there is nothing to disturb, so it goes straight in unless queueing was asked for.
      const steer = (get().followUp === 'steer') !== opposite
      if ((steer || (get().live[id]?.idle && !opposite)) && !isCommand(queued.text)) await get().sendNow(id, queued.id)
      return
    }
    held.delete(id)
    get()._appendUser(id, text.trim(), attachments)
    await get()._runTurn(id, text.trim(), attachments)
    await get()._sendFollowUps(id)
  },

  async sendNow(id, queuedId) {
    const t = get().byId(id)
    const list = get().queue[id]
    const q = list?.find(x => x.id === queuedId)
    if (!t || !list || !q) return
    // No run to hand it to (between turns): it stays queued.
    if (!isRunning(id)) return
    const rest = list.filter(x => x.id !== queuedId)
    set(s => {
      const queue = { ...s.queue }
      if (rest.length) queue[id] = rest
      else delete queue[id]
      return { queue }
    })
    held.delete(id)
    get()._appendUser(id, q.text, q.attachments)
    if (!isBusy(get().byId(id)!)) {
      await get()._runTurn(id, q.text, q.attachments)
      await get()._sendFollowUps(id)
      return
    }
    // A command waits for the turn to end and then runs on its own; anything else steers.
    if (!isCommand(q.text) && await steerRun(id, q.text, q.attachments)) return
    set(s => ({ queue: { ...s.queue, [id]: [{ ...q, shown: true }, ...(s.queue[id] ?? [])] } }))
    // The turn may have ended while the steer was being tried: nothing else would send it then.
    const now = get().byId(id)
    if (now && !isBusy(now)) await get()._sendFollowUps(id)
  },

  dropQueued(id, queuedId) {
    set(s => {
      const rest = (s.queue[id] ?? []).filter(q => q.id !== queuedId)
      const queue = { ...s.queue }
      if (rest.length) queue[id] = rest
      else delete queue[id]
      return { queue }
    })
  },

  /** A user message into the chat (the title follows the first one). */
  _appendUser(id, text, attachments) {
    const msg: Message = {
      id: uid('m'),
      role: 'user',
      parts: text ? [{ type: 'text', text }] : [],
      createdAt: Date.now(),
    }
    if (attachments.length) msg.attachments = attachments.map(a => ({ ...a }))
    get().edit(id, (d) => {
      d.messages.push(msg)
      if (d.title === 'New chat' && !isClear(text)) d.title = createPrPrompt(text) ? 'Create a pull request' : titleFrom(text.trim() || attachments[0]!.name)
      d.updatedAt = Date.now()
    })
    get().persist(id)
  },

  /** One turn for a message already in the chat, or Mango's own `/clear` and `/create-pr`. */
  async _runTurn(id, text, attachments) {
    const t = get().byId(id)
    if (!t) return
    if (isClear(text) && !attachments.length) {
      // The CLI's conversation is left behind; the next message starts a fresh one.
      get().edit(id, (d) => { d.sessionId = null })
      const m = get()._pushAgentMessage(id)
      if (m) get()._pushPart(id, m.id, { type: 'notice', level: 'info', text: `New conversation. ${AGENTS[t.agent].name} no longer sees the messages above.` })
      get().persist(id)
      return
    }
    get().edit(id, (d) => { d.status = 'queued' })
    get().persist(id)
    if (t.awaitingWorktree) {
      // Nothing has run in this chat yet: a message kept from a failed try goes along with this one.
      const asked = t.messages.filter(m => m.role === 'user')
      if (asked.length > 1) {
        text = asked.map(m => m.parts.map(p => (p.type === 'text' ? p.text : '')).join('')).filter(Boolean).join('\n\n')
        attachments = asked.flatMap(m => m.attachments ?? [])
      }
      try {
        await get()._addWorktreeFor(id)
      } catch (e) {
        const m = get()._pushAgentMessage(id)
        if (m) {
          get()._pushPart(id, m.id, {
            type: 'notice',
            level: 'error',
            text: `Could not make a worktree for this chat: ${errorText(e)}. Nothing ran yet; send a message to try again (what you wrote goes along).`,
          })
        }
        get()._setStatus(id, 'error', 'error')
        return
      }
      // Stopped while the worktree was being made: the chat is ready there, the turn does not start.
      if (get().byId(id)?.status !== 'queued') return
    }
    // Mango's own `/create-pr`: the chat keeps the command, the agent gets the instructions.
    await runAgentTurn(id, createPrPrompt(text) ?? text, attachments)
  },

  /** Messages written while the last turn ran: one turn answers all the plain ones in a row. */
  async _sendFollowUps(id) {
    for (;;) {
      const t = get().byId(id)
      const waiting = get().queue[id]
      if (!t || !waiting?.length || isBusy(t) || held.has(id)) return
      // A command goes out on its own; plain messages written in a row go out together.
      let n = 1
      if (!isCommand(waiting[0]!.text)) while (n < waiting.length && !isCommand(waiting[n]!.text)) n++
      const batch = waiting.slice(0, n)
      set(s => {
        const queue = { ...s.queue }
        const rest = waiting.slice(n)
        if (rest.length) queue[id] = rest
        else delete queue[id]
        return { queue }
      })
      for (const w of batch) if (!w.shown) get()._appendUser(id, w.text, w.attachments)
      await get()._runTurn(id, batch.map(w => w.text).filter(Boolean).join('\n\n'), batch.flatMap(w => w.attachments))
    }
  },

  resolveApproval(threadId, messageId, partIndex, allow) {
    const part = get().byId(threadId)?.messages.find(m => m.id === messageId)?.parts[partIndex]
    if (!part || part.type !== 'approval' || part.state !== 'pending') return
    get().edit(threadId, (d) => {
      const p = d.messages.find(m => m.id === messageId)!.parts[partIndex] as typeof part
      p.state = allow ? 'allowed' : 'denied'
      if (!d.messages.some(m => m.parts.some(awaitsUser)) && d.status === 'waiting') d.status = 'running'
    }, [messageId])
    get().persist(threadId)
    if (part.id) respondApproval(threadId, part.id, allow)
  },

  answerQuestion(threadId, messageId, partIndex, answers) {
    const part = get().byId(threadId)?.messages.find(m => m.id === messageId)?.parts[partIndex]
    if (!part || part.type !== 'question' || part.state !== 'pending') return
    get().edit(threadId, (d) => {
      const p = d.messages.find(m => m.id === messageId)!.parts[partIndex] as typeof part
      p.state = answers ? 'answered' : 'dismissed'
      // A secret answer goes to the agent only, never into the saved chat.
      if (answers) p.answers = answers.map((a, i) => (p.questions[i]?.secret && a.length ? ['••••••'] : a))
      if (!d.messages.some(m => m.parts.some(awaitsUser)) && d.status === 'waiting') d.status = 'running'
    }, [messageId])
    get().persist(threadId)
    if (part.id) answerRun(threadId, part.id, answers)
  },

  stop(id) {
    const t = get().byId(id)
    if (!t || (t.status !== 'running' && t.status !== 'queued' && t.status !== 'waiting')) return
    // A sub-agent stops on its own; the run it belongs to goes on.
    if (t.parentId) {
      const root = get().rootOf(id)
      if (root && t.toolId) stopTask(root.id, t.toolId)
      return
    }
    // Stop means stop: messages waiting for the next turn stay in the queue but are not sent.
    held.add(id)
    // A run winds down by itself and reports 'stopped'.
    if (interruptRun(id)) return
    // No run behind the status (it was cut off): just put the chat back.
    get()._clearLive(id)
    for (const c of get().childrenOf(id)) if (c.status === 'running') get().edit(c.id, (d) => { d.status = 'error' })
    get().edit(id, (d) => { d.status = 'working' })
    get().persist()
  },

  stopTask(threadId, taskOrToolId) {
    stopTask(threadId, taskOrToolId)
  },

  edit(id, fn, msgIds) {
    const t = get().threads[id]
    if (!t) return undefined
    const draft = draftOf(t, msgIds)
    const result = fn(draft)
    set(s => (s.threads[id] ? { threads: { ...s.threads, [id]: draft } } : {}))
    return result
  },

  /**
   * The chat (its top-level chat, for a sub-agent) now works in `folder`: a linked worktree inside
   * its environment, or the project folder itself. `branch` when known; otherwise it is read from git.
   */
  async moveToWorktree(id, folder, branch) {
    const t = get().rootOf(id)
    if (!t || !folder) return
    const worktree = folder === t.projectPath ? null : folder
    if (!branch) branch = await backend.gitState(folder).then(s => s.branch, () => null)
    // The chat may have moved on while git was read.
    const now = get().byId(t.id)
    if (!now) return
    const same = (now.worktree ?? null) === worktree && !now.awaitingWorktree && (!branch || now.branch === branch)
    if (same) return
    get().edit(now.id, (d) => {
      d.worktree = worktree
      if (branch) d.branch = branch
      delete d.awaitingWorktree
    })
    get().persist(now.id)
  },

  async _addWorktreeFor(id) {
    const t = get().byId(id)
    if (!t?.awaitingWorktree) return
    const path = t.projectPath
    const first = t.messages.find(m => m.role === 'user')
    const firstText = first?.parts.map(p => (p.type === 'text' ? p.text : '')).join(' ') ?? ''
    const base = branchFromMessage(firstText || t.title)
    // Unreadable is not fatal: the add itself says when a name is taken, and the next one is tried.
    const known = await backend.gitWorktrees(path).catch(() => null)
    const taken = [
      ...(known?.branches ?? []),
      ...(known?.worktrees ?? []).flatMap(w => [worktreeName(w.path), ...(w.branch ? [w.branch] : [])]),
    ]
    let failure: unknown = null
    // A name taken since the list was read (or one the list missed) is tried again with the next number.
    for (let attempt = 0; attempt < 4; attempt++) {
      const branch = untakenName(base, taken)
      try {
        const wt = await backend.gitWorktreeAdd(path, branch)
        await get().moveToWorktree(id, wt.path, wt.branch ?? branch)
        return
      } catch (e) {
        failure = e
        if (!/already (exists|checked out|used)|not empty/i.test(errorText(e))) break
        taken.push(branch)
      }
    }
    throw failure
  },

  _createSubagent(parentId, opts) {
    const parent = get().byId(parentId)
    if (!parent) return null
    const now = Date.now()
    const t: Thread = {
      id: uid('t'),
      projectPath: parent.projectPath,
      title: titleFrom(opts.title) || 'Sub-agent',
      agent: parent.agent,
      model: parent.model,
      mode: parent.mode,
      effort: null,
      status: 'running',
      messages: opts.prompt ? [{ id: uid('m'), role: 'user', parts: [{ type: 'text', text: opts.prompt }], createdAt: now, fromAgent: true }] : [],
      createdAt: now,
      updatedAt: now,
      seen: true,
      simulated: parent.simulated,
      branch: parent.branch ?? null,
      parentId,
      toolId: opts.toolId,
      ...(opts.agentType ? { agentType: opts.agentType } : {}),
    }
    set(s => ({ threads: { ...s.threads, [t.id]: t } }))
    get().persist([t.id, parentId])
    return t
  },

  /** A tool call finished: when it created a pull request or issue, link it to the chat. */
  _linkCreated(id, part) {
    const root = get().rootOf(id)
    if (!root) return
    for (const ref of createdBy(part)) get().link(root.id, { ...ref, source: 'agent', linkedAt: Date.now() })
  },

  _taskStart(id, task) {
    set((s) => {
      const live = s.live[id] ?? { tasks: [], idle: false }
      if (live.tasks.some(x => x.id === task.id)) return {}
      return { live: { ...s.live, [id]: { ...live, tasks: [...live.tasks, { ...task, status: 'running', startedAt: Date.now() }] } } }
    })
  },

  _taskUpdate(id, taskId, patch) {
    set((s) => {
      const live = s.live[id]
      if (!live?.tasks.some(x => x.id === taskId)) return {}
      return { live: { ...s.live, [id]: { ...live, tasks: live.tasks.map(x => (x.id === taskId ? { ...x, ...patch } : x)) } } }
    })
  },

  _taskEnd(id, taskId, status, summary) {
    set((s) => {
      const live = s.live[id]
      const task = live?.tasks.find(x => x.id === taskId)
      if (!live || !task || task.status !== 'running') return {}
      const ended: BackgroundTask = { ...task, status, endedAt: Date.now(), activity: undefined, ...(summary ? { summary } : {}) }
      return { live: { ...s.live, [id]: { ...live, tasks: live.tasks.map(x => (x.id === taskId ? ended : x)) } } }
    })
  },

  _setIdle(id, idle) {
    set((s) => {
      if (!idle && !s.live[id]) return {}
      return { live: { ...s.live, [id]: { ...(s.live[id] ?? { tasks: [] }), idle } } }
    })
  },

  _setReconnecting(id, on) {
    set((s) => {
      if (!!s.live[id]?.reconnecting === on || (!on && !s.live[id])) return {}
      return { live: { ...s.live, [id]: { ...(s.live[id] ?? { tasks: [], idle: false }), reconnecting: on } } }
    })
  },

  /** The run ended: its background work is over. */
  _clearLive(id) {
    if (!get().live[id]) return
    set((s) => {
      const live = { ...s.live }
      delete live[id]
      return { live }
    })
  },

  _pushAgentMessage(id) {
    if (!get().byId(id)) return null
    const m: Message = { id: uid('m'), role: 'agent', parts: [], createdAt: Date.now() }
    get().edit(id, (d) => { d.messages.push(m) })
    return m
  },

  _pushPart(id, msgId, part) {
    get().edit(id, (d) => { d.messages.find(m => m.id === msgId)?.parts.push(part) }, [msgId])
    get()._touch(id)
  },

  _setStatus(id, status, outcome) {
    const t = get().byId(id)
    if (!t) return
    // A run just ended: note on its message how long the whole turn took.
    const wasBusy = isBusy(t)
    const last = t.messages[t.messages.length - 1]
    get().edit(id, (d) => {
      d.status = status
      if (wasBusy && !isBusy(d)) {
        const lastDraft = d.messages[d.messages.length - 1]
        if (lastDraft?.role === 'agent' && lastDraft.elapsedMs === undefined) {
          const asked = [...d.messages].reverse().find(m => m.role === 'user')
          lastDraft.elapsedMs = Date.now() - (asked?.createdAt ?? lastDraft.createdAt)
          lastDraft.outcome = outcome ?? (status === 'error' ? 'error' : 'stopped')
        }
      }
      if (outcome === 'done') d.seen = get().viewing === id
      d.updatedAt = Date.now()
    }, last ? [last.id] : [])
    get().persist(id)
  },

  _touch(id) {
    get().edit(id, (d) => { d.updatedAt = Date.now() })
    get().persist(id)
  },
}))
