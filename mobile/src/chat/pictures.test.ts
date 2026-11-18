import { describe, expect, it } from 'vitest'
import { KEEP, RETRY_MS, createPictureCache } from './pictures'

const tick = () => new Promise(r => setTimeout(r, 0))

describe('picture cache', () => {
  it('loads each picture once and tells listeners when it arrives', async () => {
    let calls = 0
    const cache = createPictureCache(async () => { calls++; return { data: 'AAAA', mime: 'image/png', size: 3 } })
    let heard = 0
    cache.subscribe(() => heard++)
    expect(cache.get('env://h/i/p', 'a.png').status).toBe('loading')
    expect(cache.get('env://h/i/p', 'a.png').status).toBe('loading')
    await tick(); await tick()
    expect(cache.get('env://h/i/p', 'a.png')).toMatchObject({ status: 'ready', uri: 'data:image/png;base64,AAAA' })
    expect(calls).toBe(1)
    expect(heard).toBe(1)
  })

  it('tries a failed picture again only after a while, or when asked', async () => {
    let clock = 0
    let calls = 0
    const cache = createPictureCache(async () => { calls++; throw new Error('nope') }, () => clock)
    cache.get('b', 'x.png')
    await tick(); await tick()
    expect(cache.get('b', 'x.png')).toMatchObject({ status: 'error', error: 'nope' })
    await tick()
    expect(calls).toBe(1)
    clock = RETRY_MS
    cache.get('b', 'x.png')
    await tick(); await tick()
    expect(calls).toBe(2)
    cache.retry('b', 'x.png')
    expect(cache.get('b', 'x.png').status).toBe('loading')
    await tick()
    expect(calls).toBe(3)
  })

  it('keeps only the newest pictures', async () => {
    const cache = createPictureCache(async (_, p) => ({ data: p, mime: 'image/png', size: 1 }))
    for (let i = 0; i <= KEEP; i++) cache.get('b', `${i}.png`)
    await tick(); await tick()
    expect(cache.get('b', `${KEEP}.png`).status).toBe('ready')
    expect(cache.get('b', '0.png').status).toBe('loading')
  })
})
