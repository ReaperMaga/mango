/**
 * The loop behind live chats: while a screen shows a remote project's chats, look at the
 * environment every few seconds so a run on another computer shows up (and its end) without a
 * pull to refresh. Pure of React and the app's singletons; `useLiveChats.ts` wires it up.
 */

/** How often an open chat looks. Each look reads only small revision files; a chat is fetched only when it moved. */
export const LIVE_CHAT_MS = 4000
/** A project's chat list: the dots matter less than the chat itself, so a gentler pace. */
export const LIVE_LIST_MS = 8000

export interface PollOptions {
  /** Look right away, not only after the first wait. */
  immediate?: boolean
  /** A look is skipped (not postponed) while this says no: app in the background, phone offline. */
  canRun?: () => boolean
}

/**
 * Call `tick` every `ms`, one at a time: the next wait starts when the last look is over, however
 * long it took, so a slow connection is never piled on. A look that throws does not stop the loop.
 * Returns the function that stops it.
 */
export function startPolling(tick: () => Promise<unknown>, ms: number, { immediate = false, canRun = () => true }: PollOptions = {}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const look = async () => {
    timer = null
    if (stopped) return
    if (canRun()) {
      try { await tick() } catch { /* the next look tries again */ }
    }
    if (!stopped) timer = setTimeout(look, ms)
  }

  if (immediate) void look()
  else timer = setTimeout(look, ms)

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}
