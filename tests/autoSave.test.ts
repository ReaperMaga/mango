/**
 * Saving files by themselves (app/utils/autoSave.ts): when, in which order, and never over what
 * changed on disk. A pretend disk stands in for the backend, with fake time. Plain Node:
 *
 *   node --test tests/autoSave.test.ts      (or: pnpm test)
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RETRY_MS, canAutoSave, compareDisk, createAutoSave, keepsBackup, nothingWritten, overlaps, sameFolder, saveFailure, saveTiming } from '../app/utils/autoSave.ts'

interface Doc {
  path: string
  project: string
  dirty: boolean
  loading: boolean
  conflict: boolean
  closing: boolean
  error: string | null
  binary: boolean
  tooLarge: boolean
  disk: string | null
  /** The text being edited, and the disk's time this file expects. */
  text: string
  time: number
}

const REMOTE = 'env://host/box/work'

function setUp(t: TestContext, opts: { on?: boolean, latency?: number } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const disk = new Map<string, { text: string, time: number }>()
  const open: Doc[] = []
  const log: string[] = []
  const state = {
    on: opts.on ?? true,
    latency: opts.latency ?? 0,
    failing: false,
    throwing: false,
    writing: 0,
    atOnce: 0,
    perFile: new Map<Doc, number>(),
  }

  const saver = createAutoSave<Doc>({
    on: () => state.on,
    open: () => open,
    timing: f => saveTiming(f.project.startsWith('env://'), f.disk?.length ?? 0),
    lane: f => (f.project.startsWith('env://') ? f.project : null),
    // What stores/files.ts does around fs_write_file.
    async write(f, force) {
      const { path, text } = f
      assert.equal(state.perFile.get(f) ?? 0, 0, `two writes of ${path} at once`)
      state.perFile.set(f, 1)
      state.atOnce = Math.max(state.atOnce, ++state.writing)
      log.push(`start ${path} ${text}`)
      try {
        if (state.latency) await new Promise(resolve => setTimeout(resolve, state.latency))
        if (state.throwing) throw new Error('connection dropped')
        const there = disk.get(path)
        if (state.failing || !there) {
          log.push(`failed ${path}`)
          return false
        }
        if (!force && there.time !== f.time) {
          f.conflict = true
          log.push(`stale ${path}`)
          return false
        }
        disk.set(path, { text, time: there.time + 1 })
        Object.assign(f, { disk: text, time: there.time + 1, conflict: false, dirty: f.text !== text })
        log.push(`saved ${path} ${text}`)
        return true
      } finally {
        state.writing--
        state.perFile.set(f, 0)
      }
    },
  })

  const add = (path: string, project = '/p') => {
    disk.set(path, { text: 'base', time: 1 })
    const f: Doc = { path, project, dirty: false, loading: false, conflict: false, closing: false, error: null, binary: false, tooLarge: false, disk: 'base', text: 'base', time: 1 }
    open.push(f)
    return f
  }
  const type = (f: Doc, text: string) => {
    f.text = text
    f.dirty = text !== f.disk
    saver.edited(f)
  }
  const outside = (path: string, text: string) => disk.set(path, { text, time: disk.get(path)!.time + 1 })
  /** As stores/files.ts's recheck does. */
  const recheck = async (f: Doc) => {
    const now = disk.get(f.path)!
    if (f.dirty) {
      if (now.text !== f.disk) f.conflict = true
      else f.time = now.time
    } else {
      Object.assign(f, { disk: now.text, text: now.text, time: now.time })
    }
  }
  /** Let promises settle. */
  const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
  const pass = async (ms: number) => {
    await settle()
    for (let left = ms; left > 0; left -= 50) {
      t.mock.timers.tick(Math.min(50, left))
      await settle()
    }
  }
  const onDisk = (path: string) => disk.get(path)?.text
  const count = (what: string) => log.filter(l => l.startsWith(what)).length
  return { saver, state, open, disk, log, add, type, outside, recheck, settle, pass, onDisk, count }
}

/* ---------- typing ---------- */

test('a file saves once typing rests, not per key', async (t) => {
  const { add, type, pass, onDisk, count } = setUp(t)
  const f = add('a')
  for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
    type(f, text)
    await pass(300)
  }
  assert.equal(count('start'), 0)
  await pass(650)
  assert.equal(count('start'), 0)
  await pass(100)
  assert.equal(onDisk('a'), 'hello')
  assert.equal(count('start'), 1)
  assert.equal(f.dirty, false)
})

test('typing without a pause still saves every ten seconds', async (t) => {
  const { add, type, pass, count } = setUp(t)
  const f = add('a')
  for (let i = 1; i <= 60; i++) {
    type(f, 'x'.repeat(i))
    await pass(400)
  }
  assert.equal(count('saved'), 2)
})

test('a remote or very large file waits longer', async (t) => {
  const { add, type, pass, onDisk } = setUp(t)
  const far = add('far', REMOTE)
  const big = add('big')
  big.disk = 'x'.repeat(600 * 1024)
  type(far, 'new')
  type(big, 'new')
  await pass(2900)
  assert.deepEqual([onDisk('far'), onDisk('big')], ['base', 'base'])
  await pass(200)
  assert.deepEqual([onDisk('far'), onDisk('big')], ['new', 'new'])
})

test('undone back to what is saved, nothing is written', async (t) => {
  const { add, type, pass, count } = setUp(t)
  const f = add('a')
  type(f, 'x')
  await pass(500)
  type(f, 'base')
  await pass(20_000)
  assert.equal(count('start'), 0)
  // And the next edit waits for its own pause, not the first one's.
  type(f, 'y')
  await pass(900)
  assert.equal(count('start'), 0)
})

/* ---------- what never saves itself ---------- */

test('only dirty, readable text without a question open saves itself', () => {
  const ok = { dirty: true, loading: false, conflict: false, closing: false, error: null, binary: false, tooLarge: false, disk: '' }
  assert.equal(canAutoSave(ok), true)
  for (const no of [{ dirty: false }, { loading: true }, { conflict: true }, { closing: true }, { error: 'x no longer exists' }, { binary: true }, { tooLarge: true }, { disk: null }]) {
    assert.equal(canAutoSave({ ...ok, ...no }), false, JSON.stringify(no))
  }
})

test('a conflicted, errored, binary, too large, or asked-about file is never written by itself', async (t) => {
  const { saver, add, type, pass, count } = setUp(t)
  const bad = [{ conflict: true }, { closing: true }, { error: 'gone' }, { binary: true }, { tooLarge: true }, { loading: true }]
  bad.forEach((state, i) => {
    const f = Object.assign(add(`f${i}`), state)
    type(f, 'edit')
  })
  saver.soon()
  await saver.flush()
  await pass(30_000)
  assert.equal(count('start'), 0)
})

test('a file that changed on disk is not overwritten, and waits for the user', async (t) => {
  const { saver, add, type, outside, pass, onDisk, count } = setUp(t)
  const f = add('a')
  type(f, 'mine')
  outside('a', 'agent')
  await pass(1100)
  assert.equal(onDisk('a'), 'agent')
  assert.equal(f.conflict, true)

  type(f, 'mine, more')
  saver.soon()
  await saver.flush()
  await pass(200_000)
  assert.equal(count('start'), 1)
  assert.equal(onDisk('a'), 'agent')

  // "Overwrite the file".
  assert.equal(await saver.save(f, true), true)
  assert.equal(onDisk('a'), 'mine, more')
  type(f, 'after')
  await pass(1100)
  assert.equal(onDisk('a'), 'after')
})

test('two windows with the same file: the second finds a conflict', async (t) => {
  const { add, type, pass, onDisk, disk } = setUp(t)
  const here = add('a')
  const there = add('a')
  disk.set('a', { text: 'base', time: 1 })
  type(here, 'from this window')
  await pass(1100)
  type(there, 'from the other')
  await pass(1100)
  assert.equal(onDisk('a'), 'from this window')
  assert.equal(there.conflict, true)
})

test('a closed file is not written by a timer left behind', async (t) => {
  const { open, add, type, pass, count } = setUp(t)
  const f = add('a')
  type(f, 'x')
  open.splice(open.indexOf(f), 1)
  await pass(5000)
  assert.equal(count('start'), 0)
})

/* ---------- one write at a time ---------- */

test('typing during a save saves again afterwards, never alongside', async (t) => {
  const { add, type, pass, onDisk, log } = setUp(t, { latency: 2500 })
  const f = add('a')
  type(f, 'one')
  await pass(1100)
  type(f, 'two')
  await pass(1500)
  type(f, 'three')
  await pass(9000)
  assert.equal(onDisk('a'), 'three')
  assert.equal(f.conflict, false)
  assert.deepEqual(log, ['start a one', 'saved a one', 'start a three', 'saved a three'])
})

test('undo to the saved text during a save is saved too', async (t) => {
  const { add, type, pass, onDisk } = setUp(t, { latency: 1000 })
  const f = add('a')
  type(f, 'edit')
  await pass(1100)
  type(f, 'base')
  assert.equal(f.dirty, false)
  await pass(5000)
  assert.equal(onDisk('a'), 'base')
  assert.equal(f.dirty, false)
})

test('flush waits for the write under way, then writes the latest text', async (t) => {
  const { saver, add, type, pass, onDisk } = setUp(t, { latency: 800 })
  const f = add('a')
  type(f, 'first')
  await pass(1050)
  type(f, 'last')
  let over = false
  void saver.flush().then(() => { over = true })
  await pass(700)
  assert.equal(over, false)
  await pass(1000)
  assert.equal(over, true)
  assert.equal(onDisk('a'), 'last')
})

test('flush of an undo made during a write writes the undo', async (t) => {
  const { saver, add, type, pass, onDisk } = setUp(t, { latency: 800 })
  const f = add('a')
  type(f, 'edit')
  await pass(1050)
  type(f, 'base')
  void saver.flush()
  await pass(1700)
  assert.equal(onDisk('a'), 'base')
})

test('a remote project writes one file after another; others do not wait', async (t) => {
  const { saver, state, add, type, pass, onDisk } = setUp(t, { latency: 1000 })
  const files = [add('a', REMOTE), add('b', REMOTE), add('c', REMOTE)]
  for (const f of files) type(f, `new ${f.path}`)
  void saver.flush()
  await pass(3200)
  assert.equal(state.atOnce, 1)
  assert.deepEqual(files.map(f => onDisk(f.path)), ['new a', 'new b', 'new c'])

  const local = [add('d'), add('e')]
  for (const f of local) type(f, 'new')
  void saver.flush()
  await pass(1100)
  assert.equal(state.atOnce, 2)
})

test('a write that waited its turn looks again before it goes', async (t) => {
  const { saver, add, type, pass, onDisk, count } = setUp(t, { latency: 1000 })
  const a = add('a', REMOTE)
  const b = add('b', REMOTE)
  type(a, 'x')
  type(b, 'y')
  void saver.flush()
  await pass(200)
  b.conflict = true
  await pass(3000)
  assert.equal(onDisk('b'), 'base')
  assert.equal(count('start b'), 0)
})

test('Ctrl+S during a save is not lost', async (t) => {
  const { saver, add, type, pass, onDisk } = setUp(t, { latency: 600 })
  const f = add('a')
  type(f, 'one')
  await pass(1050)
  type(f, 'two')
  let saved: boolean | null = null
  void saver.save(f).then((ok) => { saved = ok })
  await pass(1400)
  assert.equal(saved, true)
  assert.equal(onDisk('a'), 'two')
})

/* ---------- attention moving away ---------- */

test('leaving the editor saves at once', async (t) => {
  const { saver, add, type, settle, onDisk } = setUp(t)
  const f = add('a')
  type(f, 'x')
  saver.soon()
  await settle()
  assert.equal(onDisk('a'), 'x')
})

test('a save starts before soon() returns, so a page going away has sent it', (t) => {
  const { saver, add, type, log } = setUp(t)
  type(add('a'), 'x')
  saver.soon()
  assert.deepEqual(log.slice(0, 1), ['start a x'])
})

test('leaving during a save saves what was typed since as soon as it is over', async (t) => {
  const { saver, add, type, pass, onDisk } = setUp(t, { latency: 500 })
  const f = add('a')
  type(f, 'one')
  await pass(1050)
  type(f, 'two')
  saver.soon()
  await pass(1200)
  assert.equal(onDisk('a'), 'two')
})

/* ---------- git and other work from outside ---------- */

test('an operation sees the saved text', async (t) => {
  const { saver, add, type, settle, onDisk, recheck } = setUp(t)
  const f = add('a')
  type(f, 'edited')
  let seen: string | undefined
  void saver.around(() => true, async () => { seen = onDisk('a') }, () => recheck(f))
  await settle()
  assert.equal(seen, 'edited')
})

test('an operation that only reads sees it too, and saving goes on during it', async (t) => {
  const { saver, add, type, pass, onDisk } = setUp(t)
  const f = add('a')
  type(f, 'edited')
  let seen: string | undefined
  void saver.around(() => true, async () => {
    seen = onDisk('a')
    await new Promise(resolve => setTimeout(resolve, 5000))
  })
  await pass(100)
  assert.equal(seen, 'edited')
  type(f, 'more')
  await pass(1200)
  assert.equal(onDisk('a'), 'more')
})

test('a discard is never undone by a save afterwards', async (t) => {
  const { saver, add, type, outside, recheck, pass, onDisk } = setUp(t)
  const f = add('a')
  type(f, 'edit')
  void saver.around(() => true, async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
    outside('a', 'committed')
  }, () => recheck(f))
  await pass(5000)
  assert.equal(onDisk('a'), 'committed')
  assert.equal(f.text, 'committed')
  assert.equal(f.dirty, false)
})

test('typing during a checkout does not save until the disk was looked at', async (t) => {
  const { saver, add, type, outside, recheck, pass, onDisk, count } = setUp(t)
  const f = add('a')
  let checked = false
  void saver.around(() => true, async () => {
    await new Promise(resolve => setTimeout(resolve, 4000))
    outside('a', 'other branch')
  }, async () => {
    await new Promise(resolve => setTimeout(resolve, 300))
    await recheck(f)
    checked = true
  })
  await pass(50)
  type(f, 'typed meanwhile')
  saver.soon()
  await pass(4100)
  assert.equal(checked, false)
  assert.equal(count('start'), 0)
  await pass(3000)
  assert.equal(count('start'), 0)
  assert.equal(onDisk('a'), 'other branch')
  assert.equal(f.conflict, true)
})

test('typing during an operation that left the file alone saves once it is over', async (t) => {
  const { saver, add, type, recheck, pass, onDisk } = setUp(t)
  const f = add('a')
  void saver.around(() => true, () => new Promise(resolve => setTimeout(resolve, 3000)), () => recheck(f))
  await pass(100)
  type(f, 'typed')
  await pass(2700)
  assert.equal(onDisk('a'), 'base')
  await pass(400)
  assert.equal(onDisk('a'), 'typed')
})

test('the operation waits for a write under way', async (t) => {
  const { saver, add, type, outside, recheck, pass, onDisk, log } = setUp(t, { latency: 900 })
  const f = add('a')
  type(f, 'edit')
  await pass(1050)
  void saver.around(() => true, async () => {
    log.push('discard')
    outside('a', 'committed')
  }, () => recheck(f))
  await pass(5000)
  assert.deepEqual(log, ['start a edit', 'saved a edit', 'discard'])
  assert.equal(onDisk('a'), 'committed')
})

test('a failed operation lets saving go on and passes its reason on', async (t) => {
  const { saver, add, type, recheck, pass, onDisk } = setUp(t)
  const f = add('a')
  const run = saver.around(() => true, async () => { throw new Error('pull failed') }, () => recheck(f))
  await assert.rejects(run, /pull failed/)
  type(f, 'after')
  await pass(1100)
  assert.equal(onDisk('a'), 'after')
})

test('a check that fails still lets saving go on', async (t) => {
  const { saver, add, type, pass, onDisk } = setUp(t)
  const f = add('a')
  await assert.rejects(saver.around(() => true, async () => {}, async () => { throw new Error('offline') }), /offline/)
  type(f, 'after')
  await pass(1100)
  assert.equal(onDisk('a'), 'after')
})

test('flush waits for an operation to end before it writes', async (t) => {
  const { saver, add, type, recheck, pass, log } = setUp(t)
  const f = add('a')
  void saver.around(() => true, async () => {
    await new Promise(resolve => setTimeout(resolve, 1000))
    log.push('work done')
  }, () => recheck(f))
  await pass(50)
  type(f, 'typed')
  void saver.flush()
  await pass(1100)
  assert.deepEqual(log, ['work done', 'start a typed', 'saved a typed'])
})

test('a file with nothing to save does not wait for an operation to end', async (t) => {
  const { saver, add, recheck, pass } = setUp(t)
  const f = add('a')
  void saver.around(() => true, () => new Promise(resolve => setTimeout(resolve, 60_000)), () => recheck(f))
  await pass(50)
  let over = false
  // What closing the window does.
  void saver.flush().then(() => { over = true })
  await pass(50)
  assert.equal(over, true)
})

test('two overlapping operations both finish', async (t) => {
  const { saver, add, type, recheck, pass } = setUp(t)
  const f = add('a')
  type(f, 'edit')
  const done: number[] = []
  for (const i of [1, 2]) {
    void saver.around(() => true, () => new Promise(resolve => setTimeout(resolve, 500)), () => recheck(f)).then(() => done.push(i))
  }
  await pass(100)
  type(f, 'more')
  void saver.around(() => true, async () => {}, () => recheck(f)).then(() => done.push(3))
  await pass(1500)
  assert.deepEqual(done.sort(), [1, 2, 3])
})

test('other working copies save meanwhile', async (t) => {
  const { saver, add, type, recheck, pass, onDisk } = setUp(t)
  const here = add('a', '/p')
  const there = add('b', '/q')
  void saver.around(f => f.project === '/p', () => new Promise(resolve => setTimeout(resolve, 5000)), () => recheck(here))
  await pass(50)
  type(there, 'other')
  await pass(1100)
  assert.equal(onDisk('b'), 'other')
})

/* ---------- rename and delete ---------- */

test('a rename waits for the write; later saves go to the new path', async (t) => {
  const { saver, disk, add, type, pass, onDisk, log } = setUp(t, { latency: 700 })
  const f = add('old')
  type(f, 'one')
  await pass(1050)
  type(f, 'two')
  void (async () => {
    const release = saver.hold(x => x === f, true)
    await saver.settle(x => x === f)
    log.push('rename')
    disk.set('new', disk.get('old')!)
    disk.delete('old')
    f.path = 'new'
    release()
  })()
  await pass(3000)
  assert.equal(disk.has('old'), false)
  assert.equal(onDisk('new'), 'two')
  assert.deepEqual(log, ['start old one', 'saved old one', 'rename', 'start new two', 'saved new two'])
})

test("the user's save waits for a rename and lands on the new path", async (t) => {
  const { saver, disk, add, type, pass, onDisk } = setUp(t)
  const f = add('old')
  const release = saver.hold(x => x === f, true)
  type(f, 'text')
  void saver.save(f)
  await pass(100)
  assert.equal(onDisk('old'), 'base')
  disk.set('new', disk.get('old')!)
  disk.delete('old')
  f.path = 'new'
  release()
  await pass(100)
  assert.equal(onDisk('new'), 'text')
  assert.equal(disk.has('old'), false)
})

test('a project that moves while held saves to where it went', async (t) => {
  const { saver, disk, add, type, pass, onDisk } = setUp(t)
  const f = add('old', 'env://host/box/work')
  const its = (x: Doc) => x.project.startsWith('env://host/box/') || x.project.startsWith('env://host/box2/')
  const release = saver.hold(its, true)
  type(f, 'typed during the rename')
  void saver.save(f)
  await pass(5000)
  assert.equal(onDisk('old'), 'base')
  disk.set('new', { ...disk.get('old')! })
  Object.assign(f, { path: 'new', project: 'env://host/box2/work' })
  release()
  await pass(100)
  assert.equal(onDisk('old'), 'base', 'another instance can have the old name by now')
  assert.equal(onDisk('new'), 'typed during the rename')
})

test("the user's save does not wait for git", async (t) => {
  const { saver, add, type, settle, onDisk } = setUp(t)
  const f = add('a')
  const release = saver.hold(x => x === f)
  type(f, 'now')
  await saver.save(f)
  await settle()
  assert.equal(onDisk('a'), 'now')
  release()
})

test('a deleted file is not written again', async (t) => {
  const { saver, open, disk, add, type, pass, count } = setUp(t)
  const f = add('a')
  const release = saver.hold(x => x === f, true)
  type(f, 'edit')
  let saved: boolean | null = null
  void saver.save(f).then((ok) => { saved = ok })
  await pass(100)
  disk.delete('a')
  open.splice(open.indexOf(f), 1)
  release()
  await pass(5000)
  assert.equal(saved, false)
  assert.equal(count('start'), 0)
  assert.equal(disk.has('a'), false)
})

/* ---------- failures ---------- */

test('a failing save is tried a few times, ever later, and not per key', async (t) => {
  const { state, saver, add, type, pass, count } = setUp(t)
  state.failing = true
  const f = add('a')
  type(f, 'x')
  await pass(1050)
  assert.equal(count('start'), 1)
  for (let i = 0; i < 3; i++) {
    type(f, `x${i}`)
    saver.soon()
    await pass(1100)
  }
  assert.equal(count('start'), 1, 'waits for its retry')
  await pass(RETRY_MS.reduce((a, b) => a + b, 0) + 5000)
  assert.equal(count('start'), RETRY_MS.length + 1)
  await pass(1_000_000)
  assert.equal(count('start'), RETRY_MS.length + 1, 'then it stops')
})

test('it saves by itself once saving works again', async (t) => {
  const { state, add, type, pass, onDisk } = setUp(t)
  state.failing = true
  const f = add('a')
  type(f, 'x')
  await pass(1100)
  state.failing = false
  await pass(5100)
  assert.equal(onDisk('a'), 'x')
})

test('an edit after the retries ran out tries again', async (t) => {
  const { state, add, type, pass, onDisk } = setUp(t)
  state.failing = true
  const f = add('a')
  type(f, 'x')
  await pass(400_000)
  state.failing = false
  type(f, 'xy')
  await pass(1100)
  assert.equal(onDisk('a'), 'xy')
})

test('flush tries a failing save once, and reports back', async (t) => {
  const { state, saver, add, type, pass, count } = setUp(t)
  state.failing = true
  const f = add('a')
  type(f, 'x')
  await pass(1100)
  await saver.flush()
  assert.equal(count('start'), 2)
  assert.equal(f.dirty, true)
})

test('a write that throws is a failed save, not a stuck one', async (t) => {
  const { state, saver, add, type, pass, onDisk } = setUp(t)
  state.throwing = true
  const f = add('a', REMOTE)
  type(f, 'x')
  await pass(3100)
  state.throwing = false
  await saver.flush()
  assert.equal(onDisk('a'), 'x')
})

/* ---------- turned off ---------- */

test('turned off, nothing saves, waits or holds', async (t) => {
  const { saver, add, type, pass, count } = setUp(t, { on: false })
  const f = add('a')
  type(f, 'x')
  saver.soon()
  await saver.flush()
  let after = false
  assert.equal(await saver.around(() => true, async () => 7, async () => { after = true }), 7)
  await pass(30_000)
  assert.equal(count('start'), 0)
  assert.equal(after, false)
  assert.equal(await saver.save(f), true)
})

test('turned off before the timer is due, it does not save; on again, what is dirty saves', async (t) => {
  const { saver, state, add, type, pass, count, onDisk } = setUp(t)
  type(add('a'), 'x')
  state.on = false
  await pass(3000)
  assert.equal(count('start'), 0)
  state.on = true
  saver.soon()
  await pass(50)
  assert.equal(onDisk('a'), 'x')
})

/* ---------- the disk's text, and paths ---------- */

test('identical or our own text on disk is no conflict', () => {
  const edit = () => 'edited'
  assert.equal(compareDisk('base', 'base', undefined, edit), 'known')
  assert.equal(compareDisk('edited', 'base', undefined, edit), 'same')
  assert.equal(compareDisk('sent', 'base', 'sent', edit), 'known')
  assert.equal(compareDisk('agent', 'base', 'sent', edit), 'changed')
  assert.equal(compareDisk(null, null, undefined, () => null), 'changed')
})

test('line endings and the end of the file count as text', () => {
  assert.equal(compareDisk('a\r\n', 'a\n', undefined, () => 'b'), 'changed')
  assert.equal(compareDisk('a', 'a\n', undefined, () => 'b'), 'changed')
  assert.equal(compareDisk('a\r\n', 'a\r\n', undefined, () => 'b\r\n'), 'known')
})

test('working copies overlap by folder, not by spelling', () => {
  assert.equal(overlaps('C:\\Work\\App', 'c:/work/app/'), true)
  assert.equal(overlaps('C:\\Work\\App\\web', 'c:/work/app'), true)
  assert.equal(overlaps('/work/app', '/work/app/web'), true)
  assert.equal(overlaps('/work/app', '/work/app2'), false)
  assert.equal(overlaps('/work/App', '/work/app'), false)
  assert.equal(overlaps('\\\\srv\\Share\\a', '//srv/share/a/b'), true)
  assert.equal(overlaps('env://h/box/', 'env://h/box/home/agent/app'), true)
  assert.equal(overlaps('env://h/box/', 'env://h/box2/home'), false)
})

test('the same folder, however it is spelled', () => {
  assert.ok(sameFolder('C:\\work\\App.worktrees\\fix\\', 'c:/work/app.worktrees/fix'))
  assert.ok(!sameFolder('/w/App', '/w/app'))
  assert.ok(!sameFolder('C:/work/app', 'C:/work/app/sub'))
})

test('only a refusal says that nothing was written', () => {
  const rust = readFileSync(new URL('../src-tauri/src/files.rs', import.meta.url), 'utf8')
  for (const said of ['is read-only', 'is not a file', 'no longer exists', 'links to a place outside the project']) {
    assert.ok(nothingWritten(`src/a.ts ${said}`, 'src/a.ts'), said)
    assert.ok(rust.includes(said), `files.rs no longer says: ${said}`)
  }
  assert.ok(nothingWritten('Could not save a.ts: the connection dropped before all of it arrived. Try again.', 'a.ts'))
  assert.ok(rust.includes(': the connection dropped before all of it arrived. Try again.'))
  for (const why of [
    'connection dropped',
    'Could not save a.ts: ssh exited with 255: the file system is read-only',
    'Could not save a.ts: No space left on device',
    'Could not save a.ts, and it may be incomplete now. Its text from before is kept in the environment at /tmp/x/old.',
    'Saved a.ts, but the environment\'s answer was not understood. Reopen the file to check it.',
    'b.ts is read-only',
  ]) assert.ok(!nothingWritten(why, 'a.ts'), why)
})

test('a save that left the file broken waits for the user and keeps saying where the backup is', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const kept = 'Could not save a.ts, and it may be incomplete now. Its text from before is kept in the environment at /tmp/x/old.'
  const f = { dirty: true, loading: false, conflict: false, closing: false, error: null, binary: false, tooLarge: false, disk: 'base', saveError: null as string | null }
  let writes = 0
  const saver = createAutoSave<typeof f>({
    on: () => true,
    open: () => [f],
    timing: () => saveTiming(true, 10),
    lane: () => null,
    write: async () => {
      writes++
      f.saveError = saveFailure(f.saveError, writes === 1 ? kept : 'no connection.')
      return false
    },
  })
  await saver.save(f)
  assert.equal(canAutoSave(f), false)
  saver.edited(f)
  saver.soon()
  await saver.flush()
  t.mock.timers.tick(RETRY_MS.reduce((a, b) => a + b, 0) + 30_000)
  await Promise.resolve()
  assert.equal(writes, 1, 'never by itself')
  await saver.save(f)
  await saver.save(f)
  assert.equal(writes, 3, 'when asked')
  assert.equal(f.saveError, `${kept} Trying again: no connection.`)
  assert.ok(keepsBackup(f.saveError))
  assert.equal(saveFailure('no connection.', 'timed out.'), 'timed out.')
  f.saveError = 'no connection.'
  assert.equal(canAutoSave(f), true, 'other failures are tried again')
})
