import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startPolling } from './livePoll'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('startPolling', () => {
  it('looks every interval, not before', async () => {
    const tick = vi.fn(async () => {})
    const stop = startPolling(tick, 1000)
    await vi.advanceTimersByTimeAsync(999)
    expect(tick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(tick).toHaveBeenCalledTimes(3)
    stop()
  })

  it('can look right away', async () => {
    const tick = vi.fn(async () => {})
    const stop = startPolling(tick, 1000, { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it('waits for a slow look to end before the next wait starts', async () => {
    let release = () => {}
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const stop = startPolling(tick, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(tick).toHaveBeenCalledTimes(1)
    // Ten intervals pass while the look is still going: nothing piles up.
    await vi.advanceTimersByTimeAsync(10000)
    expect(tick).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(999)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(tick).toHaveBeenCalledTimes(2)
    stop()
  })

  it('skips a look while it may not run, and goes on after', async () => {
    let ok = false
    const tick = vi.fn(async () => {})
    const stop = startPolling(tick, 1000, { canRun: () => ok })
    await vi.advanceTimersByTimeAsync(3000)
    expect(tick).not.toHaveBeenCalled()
    ok = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(tick).toHaveBeenCalledTimes(1)
    stop()
  })

  it('survives a look that throws', async () => {
    const tick = vi.fn(async () => { throw new Error('offline') })
    const stop = startPolling(tick, 1000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(tick).toHaveBeenCalledTimes(3)
    stop()
  })

  it('stops for good, even mid-look', async () => {
    let release = () => {}
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const stop = startPolling(tick, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    stop()
    release()
    await vi.advanceTimersByTimeAsync(10000)
    expect(tick).toHaveBeenCalledTimes(1)
  })
})
