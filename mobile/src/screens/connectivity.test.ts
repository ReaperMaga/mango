import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCatchUp, regained, watchNetwork, type NetworkSnapshot, type NetworkSource } from './connectivity'

/** A network the test switches by hand. */
function fakeNetwork(initial: NetworkSnapshot) {
  const listeners = new Set<(s: NetworkSnapshot) => void>()
  const source: NetworkSource = {
    current: async () => initial,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
  return { source, emit: (s: NetworkSnapshot) => listeners.forEach(l => l(s)), listeners }
}

const WIFI = { online: true, kind: 'WIFI' }
const CELL = { online: true, kind: 'CELLULAR' }
const NONE = { online: false, kind: 'NONE' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('watching the network', () => {
  it('catches up when the network is back or changes interface, not on the first report', async () => {
    const net = fakeNetwork(WIFI)
    const seen: (boolean | null)[] = []
    const catchUp = vi.fn()
    const stop = watchNetwork(net.source, s => seen.push(s.online), catchUp, 500)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([true])
    expect(catchUp).not.toHaveBeenCalled()

    net.emit(NONE)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([true, false])
    expect(catchUp).not.toHaveBeenCalled()

    // Back: several reports in a row settle into one catch-up.
    net.emit(CELL)
    net.emit(WIFI)
    await vi.advanceTimersByTimeAsync(499)
    expect(catchUp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(catchUp).toHaveBeenCalledTimes(1)

    // Wi-Fi to cellular without going offline: the old connections are dead too.
    net.emit(CELL)
    await vi.advanceTimersByTimeAsync(500)
    expect(catchUp).toHaveBeenCalledTimes(2)
    net.emit(CELL)
    await vi.advanceTimersByTimeAsync(500)
    expect(catchUp).toHaveBeenCalledTimes(2)

    stop()
    expect(net.listeners.size).toBe(0)
    net.emit(NONE)
    net.emit(WIFI)
    await vi.advanceTimersByTimeAsync(1000)
    expect(catchUp).toHaveBeenCalledTimes(2)
  })

  it('knows what counts as regained', () => {
    expect(regained(null, WIFI)).toBe(false)
    expect(regained(NONE, WIFI)).toBe(true)
    expect(regained(WIFI, CELL)).toBe(true)
    expect(regained(WIFI, WIFI)).toBe(false)
    expect(regained(WIFI, NONE)).toBe(false)
    expect(regained({ online: null, kind: 'UNKNOWN' }, WIFI)).toBe(false)
  })
})

describe('catching up', () => {
  function steps(online: boolean | null = true) {
    const log: string[] = []
    let release: () => void = () => {}
    const s = {
      reset: vi.fn(async () => { log.push('reset') }),
      reconnectNow: vi.fn(() => { log.push('reconnect') }),
      checkAllEnvs: vi.fn(async () => { log.push('check'); await new Promise<void>(r => { release = r }) }),
      syncChatsEverywhere: vi.fn(async () => { log.push('sync') }),
      flushRemoteChats: vi.fn(async () => { log.push('flush') }),
      online: () => online,
    }
    return { s, log, release: () => release() }
  }

  it('drops connections, reattaches runs, then checks, pulls and pushes', async () => {
    const { s, log, release } = steps()
    const catchUp = createCatchUp(s)
    const done = catchUp()
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toEqual(['reset', 'reconnect', 'check', 'sync', 'flush'])
    // Asked again meanwhile: one more round after this one, not two at once.
    void catchUp()
    void catchUp()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toEqual(['reset', 'reconnect', 'check', 'sync', 'flush', 'reset', 'reconnect', 'check', 'sync', 'flush'])
    release()
    await done
  })

  it('offline, only drops the connections', async () => {
    const { s, log } = steps(false)
    await createCatchUp(s)()
    expect(log).toEqual(['reset', 'reconnect'])
  })

  it('keeps going when a step fails', async () => {
    const { s, log } = steps()
    s.reset.mockRejectedValueOnce(new Error('x'))
    s.checkAllEnvs.mockRejectedValueOnce(new Error('offline'))
    await createCatchUp(s)()
    expect(log).toEqual(['reconnect', 'sync', 'flush'])
  })
})
