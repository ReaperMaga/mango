/**
 * Renaming and deleting an entry with what goes with it (app/utils/companions.ts), failures included.
 *
 *   node --test tests/companions.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SplitError, companionsOf, removeTogether, renameTogether, type Folder } from '../app/utils/companions.ts'

type Fault = 'refuse' | 'lost'

/**
 * A folder in memory. `faults` by the number of the rename or remove call, from 0: refused, or done
 * with the reply lost.
 */
function folder(start: string[], o: { faults?: Record<number, Fault>, big?: boolean, unreadableAfter?: number, anyCase?: boolean } = {}) {
  const names = new Set(start)
  let calls = 0
  let lists = 0
  const spelt = (n: string) => (names.has(n) ? n : o.anyCase ? [...names].find(x => x.toLowerCase() === n.toLowerCase()) : undefined)
  const act = (work: () => void) => {
    const fault = o.faults?.[calls++]
    if (fault === 'refuse') throw new Error('in use by another process')
    work()
    if (fault === 'lost') throw new Error('connection closed')
  }
  const io: Folder = {
    async list() {
      if (o.unreadableAfter !== undefined && lists >= o.unreadableAfter) throw new Error('connection closed')
      lists++
      return o.big ? null : new Set(names)
    },
    async has(name) { return !!spelt(name) },
    async rename(from, to) {
      act(() => {
        const at = spelt(from)
        if (!at) throw new Error(`${from} no longer exists`)
        const there = spelt(to)
        if (there && there !== at) throw new Error(`${to} already exists`)
        names.delete(at)
        names.add(to)
      })
    },
  }
  const remove = async (name: string) => {
    act(() => { if (!names.delete(name)) throw new Error(`${name} no longer exists`) })
    return { deleted: true, reason: null }
  }
  return { io, remove, now: () => [...names].sort(), lists: () => lists }
}

const META = ['.meta']
const PAIR = ['A.cs', 'A.cs.meta']
const rename = (f: ReturnType<typeof folder>, to = 'B.cs', from = 'A.cs') => renameTogether(f.io, from, to, META)

test('both move', async () => {
  const f = folder(PAIR)
  await rename(f)
  assert.deepEqual(f.now(), ['B.cs', 'B.cs.meta'])
})

test('without companions it is one rename and no listing', async () => {
  const f = folder(['A.cs'])
  await renameTogether(f.io, 'A.cs', 'B.cs', [])
  assert.deepEqual([f.now(), f.lists()], [['B.cs'], 0])
})

test('a refusal leaves both as they were', async () => {
  for (const call of [0, 1]) {
    const f = folder(PAIR, { faults: { [call]: 'refuse' } })
    await assert.rejects(rename(f))
    assert.deepEqual(f.now(), PAIR, `call ${call}`)
  }
})

test('a lost reply never splits the pair', async () => {
  const last = folder(PAIR, { faults: { 1: 'lost' } })
  await rename(last)
  assert.deepEqual(last.now(), ['B.cs', 'B.cs.meta'], 'all of it was done')

  const first = folder(PAIR, { faults: { 0: 'lost' } })
  await assert.rejects(rename(first), /Nothing was renamed/)
  assert.deepEqual(first.now(), PAIR)
})

test('what cannot be put back, or cannot be known, is a split', async () => {
  const stuck = folder(PAIR, { faults: { 1: 'refuse', 2: 'refuse' } })
  await assert.rejects(rename(stuck), (e: unknown) => e instanceof SplitError && e.moved[0]!.to === 'B.cs')

  const blind = folder(PAIR, { faults: { 0: 'lost' }, unreadableAfter: 1 })
  await assert.rejects(rename(blind), (e: unknown) => e instanceof SplitError && /not known/.test(e.message))
})

test('a taken name is refused before anything moves, and is never renamed back', async () => {
  const meta = folder([...PAIR, 'B.cs.meta'])
  await assert.rejects(rename(meta), /already exists/)
  assert.deepEqual(meta.now(), ['A.cs', 'A.cs.meta', 'B.cs.meta'])

  // The entry went away and another has the new name: that one is not ours to move.
  const other = folder(['A.cs.meta', 'B.cs'])
  await assert.rejects(rename(other))
  assert.deepEqual(other.now(), ['A.cs.meta', 'B.cs'])
})

test('case: alone, and a companion spelt differently', async () => {
  const only = folder(PAIR, { anyCase: true })
  await rename(only, 'a.cs')
  assert.deepEqual(only.now(), ['a.cs', 'a.cs.meta'])

  const mixed = folder(['Player.cs', 'player.cs.meta'], { anyCase: true })
  await rename(mixed, 'player.cs', 'Player.cs')
  assert.deepEqual(mixed.now(), ['player.cs', 'player.cs.meta'])

  // Where case counts, another entry's companion is its own.
  const two = folder(['A.cs', 'a.cs', 'a.cs.meta'])
  assert.deepEqual((await companionsOf(two.io, 'A.cs', META)).found, [])
})

test('a folder too big to list', async () => {
  const f = folder(PAIR, { big: true })
  await rename(f)
  assert.deepEqual(f.now(), ['B.cs', 'B.cs.meta'])
})

test('delete: both, through a lost reply, one that went by itself, one that will not go', async () => {
  const both = folder(PAIR)
  await removeTogether(both.io, 'A.cs', ['A.cs.meta'], both.remove)
  assert.deepEqual(both.now(), [])

  const lost = folder(PAIR, { faults: { 0: 'lost' } })
  assert.deepEqual((await removeTogether(lost.io, 'A.cs', ['A.cs.meta'], lost.remove)).left, [])
  assert.deepEqual(lost.now(), [])

  const itself = folder(['A.cs'])
  assert.deepEqual((await removeTogether(itself.io, 'A.cs', ['A.cs.meta'], itself.remove)).left, [])

  const held = folder(PAIR, { faults: { 1: 'refuse' } })
  assert.equal((await removeTogether(held.io, 'A.cs', ['A.cs.meta'], held.remove)).left[0]!.name, 'A.cs.meta')

  const main = folder(PAIR, { faults: { 0: 'refuse' } })
  await assert.rejects(removeTogether(main.io, 'A.cs', ['A.cs.meta'], main.remove))
  assert.deepEqual(main.now(), PAIR)
})
