import type { Message, Part, Thread } from '~/types/chat'
import { awaitsUser } from '~/types/chat'
import type { AgentEvent } from '~/agents/types'
import { mergeContext } from '~/agents/context'
import { envPath, parseEnvPath } from '~/utils/envPath'
import type { ThreadsState } from '@/state/threads'

/**
 * One agent turn's effect on its chat: every `AgentEvent` an adapter emits, applied to the thread
 * exactly as the desktop does it (`app/agents/index.ts`, the `emit` inside `runAgentTurn`). Each
 * case below mirrors the desktop's case of the same name, in the same order.
 *
 * The one structural difference: the desktop mutates Vue-reactive objects in place and keeps
 * references to them. Here chats are immutable snapshots in a zustand store, so a turn remembers
 * its messages by id and every change goes through `store.edit`, which hands out a copy of the
 * chat with those messages (and their parts) copied, ready to change.
 */

type Store = ThreadsState
type ToolPart = Extract<Part, { type: 'tool' }>

/**
 * Where a run writes: the chat's own agent messages, or a sub-agent's chat. A message the user
 * steers in mid-turn sits after the current one, and what the agent does from then on goes into
 * a new one below it; rows started earlier (a command still running) keep updating where they are.
 */
export interface Target { threadId: string; msgIds: string[]; msgId: string; ended?: boolean }

/**
 * Where the agent's CLI runs for a project: `cwd` is the folder inside its instance (the adapter
 * sees that), `remote` the environment. The phone only has remote projects.
 */
export interface Place { cwd: string; remote: { hostId: string; instance: string } | null }

export function placeOf(projectPath: string): Place {
  const loc = parseEnvPath(projectPath)
  return loc
    ? { cwd: loc.dir, remote: { hostId: loc.hostId, instance: loc.instance } }
    : { cwd: projectPath, remote: null }
}

const msgOf = (t: Thread, id: string) => t.messages.find(m => m.id === id)

export function findIn<T extends Part['type']>(t: Thread, target: Target, type: T, id: string) {
  for (let i = target.msgIds.length - 1; i >= 0; i--) {
    const part = msgOf(t, target.msgIds[i]!)?.parts.find(p => p.type === type && 'id' in p && p.id === id)
    if (part) return part as Extract<Part, { type: T }>
  }
  return undefined
}

/** Append to the target's current message (in a draft from `store.edit`). */
function push<P extends Part>(t: Thread, target: Target, part: P): P {
  msgOf(t, target.msgId)?.parts.push(part)
  return part
}

/** Close what a run left open in a chat: running rows fail, open approvals are cancelled. */
function settleParts(t: Thread, msgIds: string[], status: 'done' | 'error' | 'stopped') {
  for (const p of t.messages.filter(m => msgIds.includes(m.id)).flatMap(m => m.parts)) {
    if (p.type === 'tool' && p.status === 'running') { p.status = 'error'; p.summary = status === 'stopped' ? 'stopped' : 'did not finish' }
    if ((p.type === 'approval' || p.type === 'question') && p.state === 'pending') p.state = 'cancelled'
    if (p.type === 'thinking' && p.seconds === 0) p.seconds = 1
  }
}

/** An agent message with nothing in it (stopped before any output) would render as a gap. */
function dropEmpty(t: Thread, msgIds: string[]) {
  t.messages = t.messages.filter(m => !(msgIds.includes(m.id) && !m.parts.length))
}

const TASK_END_SUMMARY = { done: 'finished', error: 'failed', stopped: 'stopped' } as const

export interface Turn {
  emit(e: AgentEvent): void
  /** Resolves after `turn-end` was applied. */
  finished: Promise<void>
  readonly ended: boolean
  place: Place
  main: Target
  /** Folders the agent moved into during this turn: their files changed too. */
  moved: Set<string>
  /** What the agent does from now on goes into a new reply below the last message (after a steer). */
  nextMessage(): void
}

/**
 * Start applying a turn's events to chat `threadId`, whose agent reply `first` is already in it.
 * `onEnd` runs when the turn ends, before the status changes (the run is forgotten there).
 */
export function createTurn(store: Store, threadId: string, first: Message, workdir: string, onEnd: () => void = () => {}): Turn {
  const main: Target = { threadId, msgIds: [first.id], msgId: first.id }
  const place = placeOf(workdir)
  /** Sub-agents' chats, by the id of the tool call that started each. */
  const subs = new Map<string, Target>()
  const targetFor = (agent: string | undefined) => (agent ? subs.get(agent) : main)
  const editIn = <R>(to: Target, fn: (t: Thread) => R) => store.edit(to.threadId, fn, to.msgIds)
  const pendingApprovals = () => {
    const t = store.byId(threadId)
    return !!t && main.msgIds.some(id => msgOf(t, id)?.parts.some(awaitsUser))
  }
  const moved = new Set<string>()
  let ended = false
  let finish!: () => void
  const finished = new Promise<void>(resolve => (finish = resolve))

  /** End a sub-agent's chat: how it went shows as its status and on its last message. */
  const endSub = (target: Target, status: 'done' | 'error' | 'stopped') => {
    if (target.ended) return
    target.ended = true
    editIn(target, (t) => {
      settleParts(t, target.msgIds, status)
      if (status === 'stopped') push(t, target, { type: 'notice', level: 'info', text: 'Stopped.' })
      dropEmpty(t, target.msgIds)
    })
    // A finished sub-agent has nothing pending: it is settled, unlike a chat, which only the user settles.
    store._setStatus(target.threadId, status === 'error' ? 'error' : 'done', status)
  }

  const nextMessage = () => {
    const next = store._pushAgentMessage(threadId)
    if (!next) return
    main.msgIds.push(next.id)
    main.msgId = next.id
  }

  const emit = (e: AgentEvent) => {
    if (ended) return
    const t = store.byId(threadId)
    if (!t) {
      // The chat was deleted while it ran: nothing to show, but the run must still end.
      if (e.type === 'turn-end') { ended = true; onEnd(); store._clearLive(threadId); finish() }
      return
    }
    switch (e.type) {
      case 'session':
        store.edit(threadId, (d) => { d.sessionId = e.sessionId })
        break
      case 'context':
        // Kept with the chat, so the desktop shows it too; the phone does not draw it yet.
        store.edit(threadId, (d) => { d.context = mergeContext(d.context, e.usage) })
        break
      case 'workdir': {
        // The agent moved its session (Claude Code's EnterWorktree / ExitWorktree): later turns follow
        // it. A remote run reports the folder inside its instance.
        const folder = place.remote ? envPath({ ...place.remote, dir: e.path }) : e.path
        moved.add(folder)
        void store.moveToWorktree(threadId, folder, e.branch ?? null)
        break
      }
      case 'text-delta': {
        const to = targetFor(e.agent)
        if (!to) break
        editIn(to, (d) => {
          const part = findIn(d, to, 'text', e.id) ?? push(d, to, { type: 'text', id: e.id, text: '' })
          part.text += e.text
        })
        break
      }
      case 'text': {
        const to = targetFor(e.agent)
        if (!to) break
        editIn(to, (d) => {
          const part = findIn(d, to, 'text', e.id) ?? push(d, to, { type: 'text', id: e.id, text: '' })
          part.text = e.text
        })
        break
      }
      case 'thinking-delta': {
        const to = targetFor(e.agent)
        if (!to) break
        editIn(to, (d) => {
          const part = findIn(d, to, 'thinking', e.id) ?? push(d, to, { type: 'thinking', id: e.id, text: '', seconds: 0 })
          part.text += e.text
        })
        break
      }
      case 'thinking-end': {
        const to = targetFor(e.agent)
        if (!to) break
        editIn(to, (d) => {
          const part = findIn(d, to, 'thinking', e.id)
          if (!part) return
          part.seconds = Math.max(e.seconds ?? 0, part.text ? 1 : 0)
          // A thinking block with no visible text and no measurable time is noise.
          if (!part.text && part.seconds < 1) {
            const owner = d.messages.find(m => to.msgIds.includes(m.id) && m.parts.includes(part))
            owner?.parts.splice(owner.parts.indexOf(part), 1)
          }
        })
        break
      }
      case 'tool-start': {
        const to = targetFor(e.agent)
        if (!to) break
        editIn(to, (d) => {
          if (!findIn(d, to, 'tool', e.id)) push(d, to, { type: 'tool', id: e.id, tool: e.tool, label: e.label, target: e.target, status: 'running' })
        })
        break
      }
      case 'tool-update': {
        const to = targetFor(e.agent)
        if (!to) break
        // Pictures a tool produced are left out: the phone has no attachment store to keep them in.
        editIn(to, (d) => {
          const part = findIn(d, to, 'tool', e.id)
          if (!part) return
          if (e.target !== undefined) part.target = e.target
          if (e.summary !== undefined) part.summary = e.summary
          if (e.output !== undefined) part.output = e.output
          if (e.diff !== undefined) part.diff = e.diff
        })
        break
      }
      case 'tool-end': {
        const to = targetFor(e.agent)
        if (!to) break
        const part = editIn(to, (d) => {
          const part = findIn(d, to, 'tool', e.id)
          if (!part) return undefined
          part.status = e.status
          if (e.summary !== undefined) part.summary = e.summary
          if (e.output !== undefined) part.output = e.output
          if (e.diff !== undefined) part.diff = e.diff
          return part
        })
        if (!part) break
        // `gh pr create` and the like: the new pull request or issue belongs to this chat.
        store._linkCreated(to.threadId, part)
        store.persist(to.threadId)
        break
      }
      case 'subagent-start': {
        if (subs.has(e.id)) break
        const parent = targetFor(e.parent) ?? main
        const child = store._createSubagent(parent.threadId, { toolId: e.id, title: e.title, agentType: e.agentType, prompt: e.prompt })
        const first = child && store._pushAgentMessage(child.id)
        if (!child || !first) break
        subs.set(e.id, { threadId: child.id, msgIds: [first.id], msgId: first.id })
        // The parent's "Delegated" row opens the sub-agent's chat.
        editIn(parent, (d) => {
          const row = findIn(d, parent, 'tool', e.id)
          if (row) row.childId = child.id
        })
        break
      }
      case 'subagent-end': {
        const sub = subs.get(e.id)
        if (sub) endSub(sub, e.status)
        break
      }
      case 'task-start':
        store._taskStart(threadId, { id: e.id, kind: e.kind, title: e.title, ...(e.toolId ? { toolId: e.toolId } : {}) })
        break
      case 'task-update':
        store._taskUpdate(threadId, e.id, { ...(e.title ? { title: e.title } : {}), ...(e.activity ? { activity: e.activity } : {}) })
        break
      case 'task-end': {
        store._taskEnd(threadId, e.id, e.status, e.summary)
        // The row that started it said "in background"; now it says how that went.
        const toolId = store.liveOf(threadId)?.tasks.find(x => x.id === e.id)?.toolId
        if (!toolId) break
        for (const to of [main, ...subs.values()]) {
          const now = store.byId(to.threadId)
          if (!now || !findIn(now, to, 'tool', toolId)) continue
          editIn(to, (d) => {
            const row = findIn(d, to, 'tool', toolId) as ToolPart
            if (row.status === 'ok') row.summary = TASK_END_SUMMARY[e.status]
            if (e.status === 'error') row.status = 'error'
          })
          break
        }
        break
      }
      case 'answered':
        store._setIdle(threadId, true)
        break
      case 'resume': {
        // The agent picks up again by itself: a reply of its own, saying what it reacts to.
        store._setIdle(threadId, false)
        const before = main.msgId
        nextMessage()
        if (main.msgId === before) break
        editIn(main, d => push(d, main, { type: 'notice', level: 'info', text: e.reason }))
        break
      }
      case 'approval': {
        const part: Part = { type: 'approval', id: e.id, title: e.title, command: e.command, reason: e.reason, state: 'pending' }
        editIn(main, (d) => {
          // Sit right under the tool row the request is about, not after later rows.
          const mine = main.msgIds.map(id => msgOf(d, id)).filter((m): m is Message => !!m)
          const owner = (e.toolId && mine.find(m => m.parts.some(p => p.type === 'tool' && p.id === e.toolId))) || msgOf(d, main.msgId)
          if (!owner) return
          const at = e.toolId ? owner.parts.findIndex(p => p.type === 'tool' && p.id === e.toolId) : -1
          if (at >= 0) owner.parts.splice(at + 1, 0, part)
          else owner.parts.push(part)
        })
        store._setStatus(threadId, 'waiting')
        break
      }
      case 'question': {
        const part: Part = { type: 'question', id: e.id, questions: e.questions, ...(e.title ? { title: e.title } : {}), ...(e.message ? { message: e.message } : {}), state: 'pending' }
        editIn(main, d => push(d, main, part))
        store._setStatus(threadId, 'waiting')
        break
      }
      case 'approval-cancelled': {
        editIn(main, (d) => {
          const part = findIn(d, main, 'approval', e.id) ?? findIn(d, main, 'question', e.id)
          if (part?.state === 'pending') part.state = 'cancelled'
        })
        if (!pendingApprovals() && store.byId(threadId)?.status === 'waiting') store._setStatus(threadId, 'running')
        break
      }
      case 'turn-end': {
        ended = true
        editIn(main, d => settleParts(d, main.msgIds, e.status))
        // Sub-agents end with the run that started them.
        for (const sub of subs.values()) endSub(sub, e.status === 'error' ? 'error' : 'stopped')
        editIn(main, (d) => {
          if (e.status === 'error') {
            push(d, main, { type: 'notice', level: 'error', text: e.error || 'The agent stopped unexpectedly.' })
            // A conversation the CLI can no longer resume would fail forever: start fresh next time.
            if (/no longer has this conversation|could not be resumed/i.test(e.error ?? '')) d.sessionId = null
          }
          if (e.status === 'stopped') push(d, main, { type: 'notice', level: 'info', text: 'Stopped.' })
          dropEmpty(d, main.msgIds)
        })
        onEnd()
        store._clearLive(threadId)
        // Answering never settles a chat: it stays Working until the user marks it settled.
        store._setStatus(threadId, e.status === 'error' ? 'error' : 'working', e.status)
        finish()
        break
      }
    }
    // New output from the main conversation means it is no longer only waiting on background work.
    if ((e.type === 'text-delta' || e.type === 'tool-start') && !e.agent && store.liveOf(threadId)?.idle) store._setIdle(threadId, false)
    const to = 'agent' in e && e.agent ? subs.get(e.agent) : undefined
    if (to) store._touch(to.threadId)
    store._touch(threadId)
  }

  return {
    emit,
    finished,
    get ended() { return ended },
    place,
    main,
    moved,
    nextMessage,
  }
}
