/**
 * Catching up when the network comes back: plain TypeScript (no React Native), so it is tested
 * with a fake network (`connectivity.test.ts`). `lifecycle.ts` wires it to expo-network and the
 * app's backend.
 */

/** What the system says about the network. `online` null: not known (yet). */
export interface NetworkSnapshot {
  online: boolean | null
  /** The interface: 'WIFI', 'CELLULAR', … A change means every open connection is dead. */
  kind: string
}

export interface NetworkSource {
  current(): Promise<NetworkSnapshot>
  /** Returns how to stop listening. */
  subscribe(listener: (s: NetworkSnapshot) => void): () => void
}

export interface CatchUpSteps {
  /** Drop every SSH connection: they may be dead without knowing it yet. */
  reset(): Promise<void>
  /** Runs that lost their connection attach again now. */
  reconnectNow(): void
  checkAllEnvs(): Promise<void>
  syncChatsEverywhere(): Promise<void>
  /** Send pending chat saves now, not at their next retry. */
  flushRemoteChats(): Promise<void>
  /** False while the phone is known to be offline: then only the connections are dropped. */
  online(): boolean | null
}

/**
 * One catch-up at a time: drop connections, reattach runs, then check, pull and push. A call
 * while one runs makes one more run after it (the network may have changed again meanwhile).
 */
export function createCatchUp(steps: CatchUpSteps): () => Promise<void> {
  let running: Promise<void> | null = null
  let again = false
  const once = async () => {
    await steps.reset().catch(() => {})
    steps.reconnectNow()
    if (steps.online() === false) return
    await Promise.all([
      steps.checkAllEnvs().catch(() => {}),
      steps.syncChatsEverywhere().catch(() => {}),
      steps.flushRemoteChats().catch(() => {}),
    ])
  }
  return function catchUp() {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await once()
      } while (again)
    })().finally(() => { running = null })
    return running
  }
}

/** The network came back, or moved to another interface (Wi-Fi to cellular and back). */
export function regained(before: NetworkSnapshot | null, now: NetworkSnapshot): boolean {
  if (!before || now.online !== true) return false
  if (before.online === false) return true
  return before.online === true && before.kind !== now.kind
}

/**
 * Follow the network: every report goes to `onChange`; one that means connections must be made
 * anew calls `catchUp`, once the reports settle (`settleMs`: an interface change comes as a few).
 * Returns how to stop.
 */
export function watchNetwork(
  source: NetworkSource, onChange: (s: NetworkSnapshot) => void, catchUp: () => void, settleMs = 750,
): () => void {
  let last: NetworkSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const seen = (s: NetworkSnapshot) => {
    if (stopped) return
    const before = last
    last = s
    onChange(s)
    if (!regained(before, s)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!stopped) catchUp()
    }, settleMs)
  }
  const off = source.subscribe(seen)
  // The first state is only recorded: nothing was lost yet.
  source.current().then((s) => { if (!last) { last = s; onChange(s) } }, () => {})
  return () => {
    stopped = true
    off()
    if (timer) clearTimeout(timer)
  }
}
