import { defineStore } from 'pinia'
import type { AgentId, Message, Part, Thread } from '~/types/chat'
import { AGENTS } from '~/types/chat'
import { interruptRun, respondApproval, runAgentTurn } from '~/agents'
import { useWorkspace } from '~/stores/workspace'
import { isDiffTab, parseDiffTab } from '~/utils/diffTabs'
import { useGit } from '~/stores/git'
import { demoThreads } from '~/utils/demoThreads'

const LS_KEY = 'mango.threads.v1'
const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export interface Pane { id: string; threadId: string | null }

export const useThreads = defineStore('threads', {
  state: () => ({
    threads: [] as Thread[],
    /** Open tabs, in order (thread ids). */
    tabs: [] as string[],
    /** One or two side-by-side chat panes. */
    panes: [{ id: 'pane-a', threadId: null }] as Pane[],
    activePaneId: 'pane-a',
    /** Default agent for new chats. */
    defaultAgent: 'claude' as AgentId,
  }),

  getters: {
    byId: s => (id: string | null | undefined) => s.threads.find(t => t.id === id) ?? null,
    /** A project's chats, newest first, without the archived ones. */
    forProject: s => (path: string) =>
      s.threads.filter(t => t.projectPath === path && !t.archived).sort(byListOrder),
    archivedFor: s => (path: string) =>
      s.threads.filter(t => t.projectPath === path && t.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    activePane: s => s.panes.find(p => p.id === s.activePaneId) ?? s.panes[0]!,
    activeThread(): Thread | null {
      return this.byId(this.activePane.threadId)
    },
    isSplit: s => s.panes.length > 1,
    /** Threads that need the user: shown as a count in the titlebar. */
    attentionCount: s => s.threads.filter(t => !t.archived && (t.status === 'waiting' || (t.status === 'done' && !t.seen))).length,
  },

  actions: {
    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
        if (raw?.threads) {
          // Anything that was mid-run when the app closed is no longer running.
          this.threads = raw.threads.map(normalizeLoaded)
          this.tabs = (raw.tabs ?? []).filter((id: string) => this.threads.some(t => t.id === id))
          this.panes = raw.panes?.length ? raw.panes : this.panes
          this.activePaneId = this.panes.some(p => p.id === raw.activePaneId) ? raw.activePaneId : this.panes[0]!.id
          this.defaultAgent = raw.defaultAgent ?? 'claude'
        }
      } catch { /* start fresh */ }
    },

    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          threads: this.threads,
          // Diff tabs are a view onto git state, not something to restore next time.
          tabs: this.tabs.filter(id => !isDiffTab(id)),
          panes: this.panes.map(p => (isDiffTab(p.threadId) ? { ...p, threadId: null } : p)),
          activePaneId: this.activePaneId, defaultAgent: this.defaultAgent,
        }))
      } catch { /* storage unavailable */ }
    },

    /** Seed realistic demo threads for a project (command palette: “Load demo threads”). */
    loadDemo(projectPath: string) {
      const demo = demoThreads(projectPath)
      this.threads.push(...demo)
      for (const t of demo.slice(0, 3)) if (!this.tabs.includes(t.id)) this.tabs.push(t.id)
      this.show(demo[0]!.id)
      this.persist()
    },

    create(projectPath: string, agentArg?: AgentId, branch: string | null = null): Thread {
      const agent = agentArg ?? this.defaultAgent
      // Reuse an untouched empty chat instead of piling up "New chat" rows.
      const blank = this.threads.find(x => x.projectPath === projectPath && x.messages.length === 0 && x.title === 'New chat' && !x.archived)
      if (blank) {
        if (agentArg) { blank.agent = agentArg; blank.model = AGENTS[agentArg].models[0]!.id }
        this.show(blank.id)
        return blank
      }
      const t: Thread = {
        id: uid('t'),
        projectPath,
        title: 'New chat',
        agent,
        model: AGENTS[agent].models[0]!.id,
        mode: useWorkspace().defaultMode,
        status: 'idle',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seen: true,
        branch,
      }
      this.threads.push(t)
      this.show(t.id)
      this.persist()
      return t
    },

    /** Show a thread in the active pane (or the pane that already shows it). */
    show(id: string, paneId?: string) {
      if (!this.tabs.includes(id)) this.tabs.push(id)
      const already = this.panes.find(p => p.threadId === id)
      if (already && !paneId) {
        this.activePaneId = already.id
      } else {
        const pane = this.panes.find(p => p.id === (paneId ?? this.activePaneId)) ?? this.panes[0]!
        pane.threadId = id
        this.activePaneId = pane.id
      }
      const t = this.byId(id)
      if (t && t.status === 'done') t.seen = true
      this.persist()
    },

    closeTab(id: string) {
      const i = this.tabs.indexOf(id)
      if (i === -1) return
      this.tabs.splice(i, 1)
      const diff = parseDiffTab(id)
      if (diff) useGit().closeDiff(diff.projectPath, diff.key)
      const fallback = this.tabs[Math.min(i, this.tabs.length - 1)] ?? null
      for (const p of this.panes) if (p.threadId === id) p.threadId = this.panes.some(o => o.threadId === fallback) ? null : fallback
      if (this.panes.length > 1) {
        const empty = this.panes.find(p => p.threadId === null)
        if (empty) this.closePane(empty.id)
      }
      this.persist()
    },

    /** Show `next` in the place of the tab `old` (browsing diffs reuses one tab instead of piling them up). */
    replaceTab(old: string, next: string) {
      const i = this.tabs.indexOf(old)
      if (i === -1 || this.tabs.includes(next)) {
        this.show(next)
        if (i !== -1 && old !== next) this.closeTab(old)
        return
      }
      this.tabs[i] = next
      for (const p of this.panes) if (p.threadId === old) p.threadId = next
      const diff = parseDiffTab(old)
      if (diff) useGit().closeDiff(diff.projectPath, diff.key)
    },

    focusPane(paneId: string) {
      this.activePaneId = paneId
      const t = this.byId(this.panes.find(p => p.id === paneId)?.threadId)
      if (t && t.status === 'done') t.seen = true
    },

    /** Open a second pane to the right; shows `threadId` or the next tab. */
    split(threadId?: string) {
      if (this.panes.length > 1) {
        if (threadId) this.show(threadId, this.panes[1]!.id)
        return
      }
      const current = this.activePane.threadId
      const next = threadId ?? this.tabs.find(id => id !== current) ?? null
      this.panes.push({ id: 'pane-b', threadId: next })
      this.activePaneId = 'pane-b'
      this.persist()
    },

    closePane(paneId: string) {
      if (this.panes.length === 1) return
      this.panes = this.panes.filter(p => p.id !== paneId)
      this.panes[0]!.id = 'pane-a'
      this.activePaneId = 'pane-a'
      this.persist()
    },

    /**
     * Move a chat within its project's list, next to `targetId`. From then on
     * that project keeps the hand-made order (new chats still arrive on top).
     */
    reorder(id: string, targetId: string, where: 'before' | 'after') {
      const t = this.byId(id)
      if (!t || id === targetId) return
      const ids = this.forProject(t.projectPath).map(x => x.id).filter(x => x !== id)
      const at = ids.indexOf(targetId)
      if (at === -1) return
      ids.splice(where === 'before' ? at : at + 1, 0, id)
      ids.forEach((x, i) => { const th = this.byId(x); if (th) th.order = i })
      this.persist()
    },
    /** Keyboard / menu version of dragging: one place up or down. */
    move(id: string, by: -1 | 1) {
      const t = this.byId(id)
      if (!t) return
      const ids = this.forProject(t.projectPath).map(x => x.id)
      const target = ids[ids.indexOf(id) + by]
      if (target) this.reorder(id, target, by < 0 ? 'before' : 'after')
    },
    /** Forget the hand-made order of a project: newest activity first again. */
    resetOrder(projectPath: string) {
      for (const t of this.threads) if (t.projectPath === projectPath) delete t.order
      this.persist()
    },

    /** Set a chat's status by hand: Idle, Working (in progress) or Settled. While an agent runs, the run owns the status. */
    setStatus(id: string, status: 'idle' | 'working' | 'done') {
      const t = this.byId(id)
      if (!t || isBusy(t)) return
      t.status = status
      t.seen = true
      t.archived = false
      this.persist()
    },

    /** Put a chat away: it leaves the list and its tab closes, nothing is deleted. */
    archive(id: string) {
      const t = this.byId(id)
      if (!t || isBusy(t)) return
      t.archived = true
      t.seen = true
      this.closeTab(id)
      this.persist()
    },

    unarchive(id: string) {
      const t = this.byId(id)
      if (!t) return
      t.archived = false
      this.persist()
    },

    rename(id: string, title: string) {
      const t = this.byId(id)
      if (t && title.trim()) { t.title = title.trim(); this.persist() }
    },

    remove(id: string) {
      this.closeTab(id)
      this.threads = this.threads.filter(t => t.id !== id)
      for (const p of this.panes) if (p.threadId === id) p.threadId = null
      this.persist()
    },

    setAgent(id: string, agent: AgentId) {
      const t = this.byId(id)
      if (!t) return
      if (t.agent !== agent) {
        t.agent = agent
        t.model = AGENTS[agent].models[0]!.id
        // Each CLI keeps its own conversation; the other agent starts fresh.
        t.sessionId = null
      }
      this.defaultAgent = agent
      this.persist()
    },

    setModel(id: string, model: string) {
      const t = this.byId(id)
      if (t) { t.model = model; this.persist() }
    },

    setMode(id: string, mode: Thread['mode']) {
      const t = this.byId(id)
      if (t) { t.mode = mode; this.persist() }
    },

    /** Append a user message and start the (mock) agent. */
    async send(id: string, text: string) {
      const t = this.byId(id)
      if (!t || !text.trim() || ['running', 'queued', 'waiting'].includes(t.status)) return
      t.archived = false // writing in an archived chat brings it back
      const msg: Message = { id: uid('m'), role: 'user', parts: [{ type: 'text', text: text.trim() }], createdAt: Date.now() }
      t.messages.push(msg)
      if (t.title === 'New chat') t.title = titleFrom(text)
      t.status = 'queued'
      t.updatedAt = Date.now()
      this.persist()
      await runAgentTurn(this, t.id, text.trim())
    },

    /** Resolve an approval request inside a message. */
    resolveApproval(threadId: string, messageId: string, partIndex: number, allow: boolean) {
      const t = this.byId(threadId)
      const part = t?.messages.find(m => m.id === messageId)?.parts[partIndex]
      if (!t || !part || part.type !== 'approval' || part.state !== 'pending') return
      part.state = allow ? 'allowed' : 'denied'
      const stillWaiting = t.messages.some(m => m.parts.some(p => p.type === 'approval' && p.state === 'pending'))
      if (!stillWaiting && t.status === 'waiting') t.status = 'running'
      this.persist()
      if (part.id) respondApproval(threadId, part.id, allow)
      // The simulated agent (browser preview) awaits this instead.
      approvalWaiters.get(`${threadId}:${messageId}:${partIndex}`)?.(allow)
    },

    stop(id: string) {
      const t = this.byId(id)
      if (!t || (t.status !== 'running' && t.status !== 'queued' && t.status !== 'waiting')) return
      // A real run winds down by itself and reports 'stopped'; the simulated one is just flagged.
      if (interruptRun(id)) return
      stopFlags.add(id)
      t.status = 'idle'
      this.persist()
    },

    /* -------- low-level mutations used by the agent driver -------- */
    _pushAgentMessage(id: string): Message | null {
      const t = this.byId(id)
      if (!t) return null
      const m: Message = { id: uid('m'), role: 'agent', parts: [], createdAt: Date.now() }
      t.messages.push(m)
      return t.messages[t.messages.length - 1]!
    },
    _pushPart(id: string, msg: Message, part: Part) {
      msg.parts.push(part)
      this._touch(id)
      return msg.parts[msg.parts.length - 1]!
    },
    _setStatus(id: string, status: Thread['status']) {
      const t = this.byId(id)
      if (!t) return
      // A run just ended: note on its message how long the whole turn took.
      const wasBusy = isBusy(t)
      t.status = status
      if (wasBusy && !isBusy(t)) {
        const last = t.messages[t.messages.length - 1]
        if (last?.role === 'agent' && last.elapsedMs === undefined) {
          const asked = [...t.messages].reverse().find(m => m.role === 'user')
          last.elapsedMs = Date.now() - (asked?.createdAt ?? last.createdAt)
          last.outcome = status === 'done' ? 'done' : status === 'error' ? 'error' : 'stopped'
        }
      }
      const visible = this.panes.some(p => p.threadId === id)
      if (status === 'done') t.seen = visible
      this._touch(id)
      this.persist()
    },
    _touch(id: string) {
      const t = this.byId(id)
      if (t) t.updatedAt = Date.now()
    },
  },
})

/**
 * Sidebar order: chats the user placed by hand keep their place; chats without
 * a place (new ones) come first, newest activity on top.
 */
function byListOrder(a: Thread, b: Thread) {
  if (a.order === undefined && b.order === undefined) return b.updatedAt - a.updatedAt
  if (a.order === undefined) return -1
  if (b.order === undefined) return 1
  return a.order - b.order
}

/** Running, starting or waiting for an approval: its status belongs to the run. */
export const isBusy = (t: Thread) => t.status === 'running' || t.status === 'queued' || t.status === 'waiting'

export const approvalWaiters = new Map<string, (allow: boolean) => void>()
export const stopFlags = new Set<string>()

/** Threads from disk: nothing is running after a restart, and older builds stored other model/mode values. */
function normalizeLoaded(t: Thread): Thread {
  const agent: AgentId = t.agent in AGENTS ? t.agent : 'claude'
  const model = AGENTS[agent].models.some(m => m.id === t.model) ? t.model : AGENTS[agent].models[0]!.id
  const mode = (['plan', 'ask', 'edits', 'auto'] as const).includes(t.mode) ? t.mode : 'ask'
  const interrupted = ['running', 'queued', 'waiting'].includes(t.status)
  const messages = t.messages.map(m => ({
    ...m,
    parts: m.parts.map((p): Part => {
      if (p.type === 'approval' && p.state === 'pending') return { ...p, state: 'cancelled' }
      if (p.type === 'tool' && p.status === 'running') return { ...p, status: 'error', summary: 'did not finish' }
      return p
    }),
  }))
  return { ...t, agent, model, mode, messages, status: interrupted ? 'idle' : t.status }
}

function titleFrom(text: string) {
  const line = text.trim().split('\n')[0]!.replace(/[`*_#>]/g, '')
  return line.length > 48 ? `${line.slice(0, 46).trimEnd()}…` : line
}
