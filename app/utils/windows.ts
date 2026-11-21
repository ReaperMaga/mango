/**
 * Mango's windows: which window shows what, and which window holds which chats. Pure logic, no
 * Vue or Tauri (tested in `tests/windows.test.ts`); `stores/windows.ts` runs it.
 *
 * - The main window (`main`) is the one Mango starts with. Others (`w-<n>` in the app) are
 *   opened on a project or on a single chat; what they show comes from their URL's query,
 *   read once at start-up (`parseWindowQuery`).
 * - A window *claims* projects (the ones it has open) and chats (a chat window's chat). A claim
 *   is held by one window at a time.
 * - Every chat belongs to exactly one window (`ownerOf`): the window claiming the chat itself
 *   (its top-level chat, for a sub-agent), else the window claiming its project, else the main
 *   window, which holds everything nobody claims. A window loads, shows, runs, saves and deletes
 *   only the chats it owns.
 */

export const MAIN_WINDOW = 'main'

export type WindowSpec =
  | { kind: 'main' }
  /** A window on a project; `path` null: one that starts on the welcome screen. */
  | { kind: 'project'; path: string | null }
  /** A window on one chat (and its sub-agent chats); `path` is its project when known. */
  | { kind: 'chat'; threadId: string; path: string | null }

export interface Claim { kind: 'project' | 'chat'; key: string }
/** Each window's claims, by window id (its own included). */
export type ClaimTable = Record<string, Claim[]>

/** A chat as ownership sees it: its project and its top-level chat (itself, for a top-level chat). */
export interface ChatRef { id: string; projectPath: string; rootId: string }

/** Where a new window goes on the screen (logical pixels), and its size. */
export interface WindowPlace { x?: number; y?: number; width?: number; height?: number }

const THREAD_ID = /^[\w-]{1,80}$/

/** The query (without `?`) a window opens with. `id` is for the browser preview, which has no window labels. */
export function windowQuery(spec: WindowSpec, id?: string): string {
  const q = new URLSearchParams()
  if (spec.kind === 'main') return ''
  q.set('window', spec.kind)
  if (spec.kind === 'chat') q.set('thread', spec.threadId)
  if (spec.path) q.set('path', spec.path)
  if (id) q.set('id', id)
  return q.toString()
}

/** What a window shows, from its URL's query. Anything unreadable is the main window. */
export function parseWindowQuery(search: string): WindowSpec & { id?: string } {
  const q = new URLSearchParams(search)
  const path = q.get('path') || null
  const id = q.get('id') ?? undefined
  const extra = id && /^w-[\w-]{1,40}$/.test(id) ? { id } : {}
  switch (q.get('window')) {
    case 'project': return { kind: 'project', path, ...extra }
    case 'chat': {
      const threadId = q.get('thread') ?? ''
      return THREAD_ID.test(threadId) ? { kind: 'chat', threadId, path, ...extra } : { kind: 'main' }
    }
    default: return { kind: 'main' }
  }
}

const same = (a: Claim, b: Claim) => a.kind === b.kind && a.key === b.key

/** The window holding a claim, or null. */
export function holderOf(table: ClaimTable, claim: Claim): string | null {
  for (const [id, claims] of Object.entries(table)) if (claims.some(c => same(c, claim))) return id
  return null
}

/** The window a chat belongs to (see the top of this file). */
export function ownerOf(table: ClaimTable, chat: Pick<ChatRef, 'projectPath' | 'rootId'>): string {
  return holderOf(table, { kind: 'chat', key: chat.rootId })
    ?? holderOf(table, { kind: 'project', key: chat.projectPath })
    ?? MAIN_WINDOW
}

/** `window` now holds `claims` too: each claim moves to it from whichever window held it. */
export function withClaims(table: ClaimTable, window: string, claims: Claim[]): ClaimTable {
  const next: ClaimTable = {}
  for (const [id, list] of Object.entries(table)) {
    next[id] = id === window ? list : list.filter(c => !claims.some(n => same(c, n)))
  }
  const own = next[window] ?? []
  next[window] = [...own, ...claims.filter(c => !own.some(o => same(o, c)))]
  return next
}

/** The table without a window (it closed): what it held goes back to whoever owns it next. */
export function withoutWindow(table: ClaimTable, window: string): ClaimTable {
  const next = { ...table }
  delete next[window]
  return next
}

/**
 * The table with only the windows that are still open (`open`, the backend's list) and `self`. A
 * window that went without saying goodbye (crashed, killed, a reload whose `bye` was lost) would
 * otherwise keep its projects listed as open elsewhere until Mango restarts.
 */
export function onlyOpen(table: ClaimTable, open: readonly string[], self: string): ClaimTable {
  const next: ClaimTable = {}
  for (const [id, claims] of Object.entries(table)) if (id === self || open.includes(id)) next[id] = claims
  return next
}

/** Of the chats `self` holds, the ones it no longer owns under `table`: they must be let go. */
export function lostChats(held: ChatRef[], table: ClaimTable, self: string): ChatRef[] {
  return held.filter(c => ownerOf(table, c) !== self)
}

/** Each chat's top-level chat, following `parentId` (at most 32 hops, so a loop cannot hang). */
export function rootIds(threads: { id: string; parentId?: string | null }[]): Map<string, string> {
  const parent = new Map(threads.map(t => [t.id, t.parentId ?? null]))
  const out = new Map<string, string>()
  for (const t of threads) {
    let id = t.id
    for (let hops = 0; hops < 32; hops++) {
      const up = parent.get(id)
      if (!up || !parent.has(up)) break
      id = up
    }
    out.set(t.id, id)
  }
  return out
}

/** Chats as ownership sees them. */
export function chatRefs(threads: { id: string; projectPath: string; parentId?: string | null }[]): ChatRef[] {
  const roots = rootIds(threads)
  return threads.map(t => ({ id: t.id, projectPath: t.projectPath, rootId: roots.get(t.id) ?? t.id }))
}

/** The claims a window makes: the projects it has open, or (a chat window) its chats. */
export function claimsFor(spec: WindowSpec, openProjects: string[], chats: string[] = []): Claim[] {
  if (spec.kind === 'chat') {
    return [...new Set([spec.threadId, ...chats])].map(key => ({ kind: 'chat' as const, key }))
  }
  return [
    ...[...new Set(openProjects)].map(key => ({ kind: 'project' as const, key })),
    ...[...new Set(chats)].map(key => ({ kind: 'chat' as const, key })),
  ]
}

/* ---------- dragging a chat out of its window ---------- */

/** How near the window's edge a dragged chat says that letting go outside opens a new window (CSS px). */
export const TEAR_EDGE = 28

/**
 * Where a dragged tab is, against the window's page (`width` × `height`, CSS px): `outside` it (letting
 * go there opens the chat in a window of its own), at its `edge`, or `inside`.
 */
export function dragPlace(x: number, y: number, width: number, height: number, edge = TEAR_EDGE): 'outside' | 'edge' | 'inside' {
  if (x < 0 || y < 0 || x >= width || y >= height) return 'outside'
  if (x < edge || y < edge || x >= width - edge || y >= height - edge) return 'edge'
  return 'inside'
}

/** A chat window's size when nothing else is asked for, and the smallest it may be (CSS px). */
export const CHAT_WINDOW = { width: 880, height: 820 }

/**
 * Where a torn-off chat's window opens, from the screen point it was let go at: its tab strip under
 * the pointer, the way the tab was held.
 */
export function tearOffPlace(screenX: number, screenY: number, size = CHAT_WINDOW): WindowPlace {
  return { x: Math.round(screenX - 120), y: Math.round(screenY - 56), width: size.width, height: size.height }
}

/**
 * The chats a closed window gives back that should come up as tabs where they land: a chat window's
 * chats (it held chats only). A project window's projects go back quietly.
 */
export function returningChats(claims: Claim[] | undefined): string[] {
  if (!claims?.length || claims.some(c => c.kind !== 'chat')) return []
  return claims.map(c => c.key)
}
