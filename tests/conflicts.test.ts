/**
 * Conflict blocks in a file mid-merge, and resolving them, for the merge editor.
 *
 *   node --test tests/conflicts.test.ts      (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockAtOrAfter, hasConflictMarkers, locateInSide, parseConflicts, resolveText, splitLines } from '../app/utils/conflicts.ts'

const TWO_WAY = `import a from 'a'
<<<<<<< HEAD
import b from 'b'
=======
import c from 'c'
>>>>>>> feature/x

export const x = 1
<<<<<<< HEAD
const mine = 1
=======
>>>>>>> feature/x
end
`

test('two-way blocks: sides, labels and places', () => {
  const p = parseConflicts(TWO_WAY)
  assert.equal(p.blocks.length, 2)
  const [a, b] = p.blocks
  assert.deepEqual([a!.start, a!.splitAt, a!.end, a!.baseAt], [1, 3, 5, null])
  assert.deepEqual([a!.ours, a!.theirs, a!.base], [["import b from 'b'"], ["import c from 'c'"], null])
  assert.deepEqual([a!.oursLabel, a!.theirsLabel, a!.baseLabel], ['HEAD', 'feature/x', null])
  // One side deleted its lines.
  assert.deepEqual([b!.ours, b!.theirs], [['const mine = 1'], []])
  assert.equal(p.eol, '\n')
  assert.equal(hasConflictMarkers(TWO_WAY), true)
})

test('diff3 and zdiff3 blocks have a base section', () => {
  const text = 'top\n<<<<<<< ours\nmain line\n||||||| original\nbase line\n=======\nfeat line\n>>>>>>> theirs\nbottom\n'
  const [b] = parseConflicts(text).blocks
  assert.deepEqual([b!.ours, b!.base, b!.theirs, b!.baseLabel], [['main line'], ['base line'], ['feat line'], 'original'])
  assert.equal(resolveText(text, b!, 'theirs'), 'top\nfeat line\nbottom\n')
  // zdiff3 names the base by its commit; an empty base is still a base.
  const z = parseConflicts('<<<<<<< HEAD\nx\n||||||| 3f2a91c\n=======\ny\n>>>>>>> main\n').blocks[0]!
  assert.deepEqual([z.base, z.baseLabel], [[], '3f2a91c'])
})

test('resolving: ours, theirs, both, and an empty side', () => {
  const p = parseConflicts(TWO_WAY)
  const first = "<<<<<<< HEAD\nimport b from 'b'\n=======\nimport c from 'c'\n>>>>>>> feature/x\n"
  assert.equal(resolveText(TWO_WAY, p.blocks[0]!, 'ours'), TWO_WAY.replace(first, "import b from 'b'\n"))
  assert.equal(resolveText(TWO_WAY, p.blocks[0]!, 'both').split('\n').slice(0, 3).join('\n'), "import a from 'a'\nimport b from 'b'\nimport c from 'c'")
  // Taking the side that has nothing removes the block's lines entirely.
  const gone = resolveText(TWO_WAY, p.blocks[1]!, 'theirs')
  assert.equal(gone, `import a from 'a'\n${first}\nexport const x = 1\nend\n`)
  // Resolve both one after the other: no markers left.
  let text = resolveText(TWO_WAY, p.blocks[0]!, 'theirs')
  text = resolveText(text, parseConflicts(text).blocks[0]!, 'ours')
  assert.equal(hasConflictMarkers(text), false)
  assert.equal(text, "import a from 'a'\nimport c from 'c'\n\nexport const x = 1\nconst mine = 1\nend\n")
})

test('CRLF files keep their line endings', () => {
  const text = 'a\r\n<<<<<<< HEAD\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> main\r\nz\r\n'
  const p = parseConflicts(text)
  assert.equal(p.eol, '\r\n')
  assert.deepEqual(p.blocks[0]!.ours, ['mine'])
  assert.equal(resolveText(text, p.blocks[0]!, 'both'), 'a\r\nmine\r\ntheirs\r\nz\r\n')
  assert.equal(resolveText(text, p.blocks[0]!, 'ours'), 'a\r\nmine\r\nz\r\n')
})

test('markers at the end of the file, with and without a last line break', () => {
  const bare = 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> main'
  const b = parseConflicts(bare).blocks[0]!
  assert.equal(resolveText(bare, b, 'theirs'), 'a\ntheirs')
  assert.equal(resolveText(bare, b, 'ours'), 'a\nmine')
  // An empty side at the very end takes the line break before it too.
  const empty = 'a\n<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> main'
  assert.equal(resolveText(empty, parseConflicts(empty).blocks[0]!, 'ours'), 'a')
  // A whole file that is one block.
  const whole = '<<<<<<< HEAD\nx\n=======\n>>>>>>> main\n'
  assert.equal(resolveText(whole, parseConflicts(whole).blocks[0]!, 'theirs'), '')
})

test('text that only looks like markers stays text', () => {
  // A Markdown heading underline, longer runs, and markers of another size inside a block.
  const md = 'Title\n=======\n\n<<<<<<<< not a marker\n>>>>>>>> nor this\n'
  assert.equal(parseConflicts(md).blocks.length, 0)
  assert.equal(hasConflictMarkers(md), false)
  const nested = '<<<<<<< HEAD\n<<<<<<<<< inner\nx\n=========\ny\n>>>>>>>>> inner\n=======\nz\n>>>>>>> main\n'
  const [b] = parseConflicts(nested).blocks
  assert.deepEqual(b!.ours, ['<<<<<<<<< inner', 'x', '=========', 'y', '>>>>>>>>> inner'])
  assert.deepEqual(b!.theirs, ['z'])
  // A marker needs a space before its label.
  assert.equal(parseConflicts('<<<<<<<HEAD\na\n=======\nb\n>>>>>>> m\n').blocks.length, 0)
})

test('a block that never closes is no block, but still counts as markers left', () => {
  const open = 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n'
  assert.equal(parseConflicts(open).blocks.length, 0)
  assert.equal(hasConflictMarkers(open), true)
  // A new opening before the split: the first one was never a block, the second is.
  const twice = '<<<<<<< HEAD\nstray\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n'
  const blocks = parseConflicts(twice).blocks
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.start, 2)
})

test('the block at the cursor, and where a block is in a side', () => {
  const p = parseConflicts(TWO_WAY)
  assert.equal(blockAtOrAfter(p.blocks, 1), 0)
  assert.equal(blockAtOrAfter(p.blocks, 6), 0)
  assert.equal(blockAtOrAfter(p.blocks, 7), 1)
  assert.equal(blockAtOrAfter(p.blocks, 13), -1)
  const ours = splitLines("import a from 'a'\nimport b from 'b'\n\nexport const x = 1\nconst mine = 1\nend\n")
  assert.deepEqual(locateInSide(ours, ["import b from 'b'"], "import a from 'a'", 1), { line: 2, count: 1 })
  // The side has nothing there: just after the line above the block.
  const theirs = splitLines("import a from 'a'\nimport c from 'c'\n\nexport const x = 1\nend\n")
  assert.deepEqual(locateInSide(theirs, [], 'export const x = 1', 7), { line: 5, count: 0 })
  // The nearest of several matches wins.
  assert.deepEqual(locateInSide(['x', 'a', 'x', 'b', 'x'], ['x'], null, 3), { line: 3, count: 1 })
  assert.equal(locateInSide(['a'], ['zzz'], 'nope', 0), null)
})
