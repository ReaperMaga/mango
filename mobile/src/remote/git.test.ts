import { describe, expect, it } from 'vitest'
import { utf8Encode } from './bytes'
import {
  addNumstats, cleanRel, explainSyncFailure, finishDiff, isNewFileDiff, parseBatch, parseNumstat, parseStatus,
  safeRef, tidyOutput, toChanges, type GitFile,
} from './git'

/** Ported from the tests of `src-tauri/src/git.rs`. */

const H = '1111111111111111111111111111111111111111'
const Z = '0000000000000000000000000000000000000000'
const st = (s: string) => parseStatus(utf8Encode(s))
const file = (path: string, index: string | null, worktree: string | null): GitFile =>
  ({ path, origPath: null, index, worktree, conflicted: false })

describe('git status', () => {
  it('reads branch headers', () => {
    const s = st(`# branch.oid ${H}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0`)
    expect([s.oid, s.branch, s.upstream, s.ahead, s.behind]).toEqual([H, 'main', 'origin/main', 2, 1])
    expect(s.files).toEqual([])
  })

  it('without an upstream, or with a gone one', () => {
    let s = st(`# branch.oid ${H}\0# branch.head feat/panel\0? notes.md\0`)
    expect([s.branch, s.upstream, s.ahead, s.behind]).toEqual(['feat/panel', null, 0, 0])
    expect(s.files).toEqual([file('notes.md', null, '?')])
    s = st(`# branch.oid ${H}\0# branch.head old\0# branch.upstream origin/old\0`)
    expect([s.upstream, s.ahead, s.behind]).toEqual(['origin/old', 0, 0])
  })

  it('detached and unborn', () => {
    let s = st(`# branch.oid ${H}\0# branch.head (detached)\0`)
    expect([s.branch, s.oid]).toEqual([null, H])
    s = st('# branch.oid (initial)\0# branch.head main\0')
    expect([s.oid, s.branch]).toEqual([null, 'main'])
  })

  it('ordinary entries', () => {
    const s = st(
      `1 .M N... 100644 100644 100644 ${H} ${H} app/stores/git.ts\0`
      + `1 M. N... 100644 100644 100644 ${H} ${H} README.md\0`
      + `1 MM N... 100644 100644 100644 ${H} ${H} src-tauri/src/lib.rs\0`
      + `1 A. N... 000000 100644 100644 ${Z} ${H} app/components/git/GitPanel.vue\0`
      + `1 .D N... 100644 100644 000000 ${H} ${H} old.txt\0`
      + `1 D. N... 100644 000000 000000 ${H} ${Z} gone.txt\0`
      + `1 .T N... 100644 100644 120000 ${H} ${H} link\0`,
    )
    expect(s.files).toEqual([
      file('app/stores/git.ts', null, 'M'),
      file('README.md', 'M', null),
      file('src-tauri/src/lib.rs', 'M', 'M'),
      file('app/components/git/GitPanel.vue', 'A', null),
      file('old.txt', null, 'D'),
      file('gone.txt', 'D', null),
      file('link', null, 'M'),
    ])
  })

  it('renames take the next record as their origin', () => {
    const s = st(
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 app/utils/time ago.ts\0app/utils/old time.ts\0`
      + `1 .M N... 100644 100644 100644 ${H} ${H} after.txt\0`,
    )
    expect(s.files).toEqual([
      { path: 'app/utils/time ago.ts', origPath: 'app/utils/old time.ts', index: 'R', worktree: null, conflicted: false },
      file('after.txt', null, 'M'),
    ])
    const r = st(`2 RM N... 100644 100644 100644 ${H} ${H} R087 b.rs\0a.rs\0`).files[0]!
    expect([r.index, r.worktree, r.origPath]).toEqual(['R', 'M', 'a.rs'])
  })

  it('untracked names with spaces and unicode, conflicts, garbage', () => {
    expect(st('? docs/release notes (draft).md\0? grüße/日本語 ファイル.txt\0! node_modules/\0').files).toEqual([
      file('docs/release notes (draft).md', null, '?'),
      file('grüße/日本語 ファイル.txt', null, '?'),
    ])
    const c = st(
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} app/pages/merge me.vue\0`
      + `u DU N... 100644 000000 100644 100644 ${H} ${Z} ${H} deleted-by-us.txt\0`,
    ).files
    expect(c.map(f => [f.path, f.conflicted, f.index, f.worktree])).toEqual([
      ['app/pages/merge me.vue', true, null, 'U'],
      ['deleted-by-us.txt', true, null, 'U'],
    ])
    expect(st('\0\x001 short\0x unknown\0? \0#\0# branch.ab\0')).toEqual({ oid: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] })
  })

  it('becomes the phone\'s change list with sizes', () => {
    const stats = parseNumstat(utf8Encode('3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '10\t0\t\0docs/old.md\0docs/new.md\0'))
    expect(stats.get('src/a.ts')).toEqual({ additions: 3, deletions: 1 })
    expect(stats.get('img.png')).toEqual({ additions: null, deletions: null })
    expect(stats.get('docs/new.md')).toEqual({ additions: 10, deletions: 0 })
    const files: GitFile[] = [
      file('src/a.ts', 'M', 'M'),
      { path: 'docs/new.md', origPath: 'docs/old.md', index: 'R', worktree: null, conflicted: false },
      file('img.png', null, 'M'),
      file('new.ts', 'A', 'D'),
      file('gone.ts', 'D', null),
      file('scratch.txt', null, '?'),
      { ...file('merge.ts', null, 'U'), conflicted: true },
    ]
    expect(toChanges(files, stats)).toEqual([
      { path: 'src/a.ts', kind: 'modified', staged: true, additions: 3, deletions: 1 },
      { path: 'docs/new.md', from: 'docs/old.md', kind: 'renamed', staged: true, additions: 10, deletions: 0 },
      { path: 'img.png', kind: 'modified', staged: false, additions: null, deletions: null },
      { path: 'new.ts', kind: 'deleted', staged: true, additions: null, deletions: null },
      { path: 'gone.ts', kind: 'deleted', staged: true, additions: null, deletions: null },
      { path: 'scratch.txt', kind: 'untracked', staged: false, additions: null, deletions: null },
      { path: 'merge.ts', kind: 'conflicted', staged: false, additions: null, deletions: null },
    ])
    const sum = addNumstats(parseNumstat(utf8Encode('1\t2\ta\0')), parseNumstat(utf8Encode('3\t4\ta\0-\t-\tb\0')))
    expect(sum.get('a')).toEqual({ additions: 4, deletions: 6 })
    expect(sum.get('b')).toEqual({ additions: null, deletions: null })
  })
})

describe('git helpers', () => {
  it('ends a truncated diff on a line with the marker', () => {
    expect(finishDiff(utf8Encode('@@ -1 +1 @@\n-a\n+b\n+half a li'), true)).toBe('@@ -1 +1 @@\n-a\n+b\n\\ Diff truncated at 400 KB\n')
    expect(finishDiff(utf8Encode('+b\n'), false)).toBe('+b\n')
    expect(isNewFileDiff('diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1 @@\n+x\n')).toBe(true)
    expect(isNewFileDiff('diff --git a/x b/x\n@@ -1 +1 @@\n+new file mode \n')).toBe(false)
  })

  it('takes relative paths and safe refs only', () => {
    expect(cleanRel('src/a b.ts')).toBe('src/a b.ts')
    expect(cleanRel('./a')).toBe('./a')
    for (const bad of ['', '/etc/passwd', '\\x', '../x', 'a/../../x', 'a\0b']) expect(() => cleanRel(bad)).toThrow()
    expect(safeRef(' feature/x ')).toBe('feature/x')
    for (const bad of ['', '-x', 'a b', 'a..b']) expect(() => safeRef(bad)).toThrow()
  })

  it('tidies output and explains push failures', () => {
    expect(tidyOutput('Counting 10%\rCounting 100%\n\n  done  \n')).toBe('Counting 100%\n  done')
    expect(explainSyncFailure('fatal: could not read Username: terminal prompts disabled')).toMatch(/^The remote asked for credentials/)
    expect(explainSyncFailure(' ! [rejected] main -> main (fetch first)')).toMatch(/^The remote has commits/)
    expect(explainSyncFailure('boom')).toBe('boom')
  })

  it('refuses a cut-off batch answer', () => {
    expect(parseBatch('', [10])).toBeNull()
    expect(parseBatch('MANGO-RUN 0 2 0\nYQ==\n', [10])).toBeNull()
    expect(parseBatch('MANGO-RUN 0 1 0\n!!\n\n', [10])).toBeNull()
  })
})
