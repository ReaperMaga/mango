/**
 * Work the window's `focus` starts, at most once per `ms`: alt-tabbing back and forth quickly would
 * otherwise re-read every open folder and file, every language server folder, the releases… each
 * time. A focus inside the quiet time is not dropped: it runs once when that time is over, so a file
 * changed meanwhile is still picked up, a few seconds late at worst. Plain functions, testable in Node.
 */
export interface FocusGate {
  (): void
  /** Forget a run still waiting (the component went away). */
  cancel: () => void
}

/** Focus-driven work is run at most this often. */
export const FOCUS_QUIET_MS = 5_000

export function focusGate(run: () => void, ms = FOCUS_QUIET_MS, now: () => number = () => Date.now()): FocusGate {
  let last = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    timer = undefined
    last = now()
    run()
  }
  const gate = (() => {
    const wait = last + ms - now()
    if (wait <= 0) {
      clearTimeout(timer)
      fire()
    } else {
      timer ??= setTimeout(fire, wait)
    }
  }) as FocusGate
  gate.cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  return gate
}
