/**
 * What one plugin registered, so it can all be undone at once (disable, reload, remove).
 * Plain TypeScript: no Vue, so `tests/` can run it in Node.
 */

export interface Disposable { dispose(): void }

/** A disposable that runs `fn` once, however often it is disposed. */
export function once(fn: () => void): Disposable {
  let done = false
  return { dispose() { if (done) return; done = true; fn() } }
}

export class DisposableScope {
  private undo: Array<() => void> = []
  private _disposed = false
  private onError: (e: unknown) => void

  /** `onError` gets each error an undo throws (the others still run). */
  constructor(onError: (e: unknown) => void = () => {}) {
    this.onError = onError
  }

  get disposed() { return this._disposed }
  get size() { return this.undo.length }

  /**
   * Track an undo; the returned Disposable runs it now (once) and forgets it. Added after the scope
   * was disposed (an `await` in `activate` that returns late), it runs at once.
   */
  add(fn: () => void): Disposable {
    if (this._disposed) {
      this.run(fn)
      return { dispose() {} }
    }
    let done = false
    const wrapped = () => {
      if (done) return
      done = true
      this.run(fn)
    }
    this.undo.push(wrapped)
    return {
      dispose: () => {
        const i = this.undo.indexOf(wrapped)
        if (i >= 0) this.undo.splice(i, 1)
        wrapped()
      },
    }
  }

  /** Undo everything, newest first. Later `add`s run at once. */
  dispose() {
    if (this._disposed) return
    this._disposed = true
    const all = this.undo.splice(0).reverse()
    for (const fn of all) fn()
  }

  private run(fn: () => void) {
    try { fn() } catch (e) { this.onError(e) }
  }
}
