/// <reference types="node" />
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { utf8Decode } from './bytes'
import { BATCH, COMMIT, DIFF_CAP, UNTRACKED_DIFF, batchArgs, gitRead, parseBatch, parseNumstat, parseStatus, toChanges } from './git'
import { ATTACH, FETCH, LIST, PROJECTS, PUT, REMOVE, parseFetch, parseList, parseProjects, validAttachmentName } from './sshBackend'
import { readFileSync } from 'node:fs'
import type { Env } from './types'

/**
 * The remote scripts themselves, run by this computer's `sh`/`bash` against scratch folders
 * (like the desktop's `scripts_round_trip` and `batch_script_round_trip` tests).
 */

const scratch: string[] = []
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `mango-${name}-`))
  scratch.push(d)
  return d
}
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })

function run(shell: string, script: string, args: string[], opts: { home?: string; cwd?: string; stdin?: string } = {}) {
  const r = spawnSync(shell, ['-c', script, 'mango', ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.home ? { HOME: opts.home } : {}), GIT_CONFIG_NOSYSTEM: '1' },
    input: opts.stdin ?? '',
    encoding: 'utf8',
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

const haveGit = spawnSync('git', ['--version']).status === 0

describe('attachment script', () => {
  it('writes the bytes under the attachment id and prints the path', () => {
    const home = tmp('attach')
    for (const name of ['shot 1.png', 'отчёт.pdf', "it's.txt"]) {
      validAttachmentName(name)
      const bytes = Buffer.from(`hello ${name}\n\u0000\u00ff`)
      const r = run('sh', ATTACH, ['att-1', name], { home, stdin: bytes.toString('base64') })
      expect(r.code).toBe(0)
      const path = r.stdout.replace(/\n$/, '')
      expect(path.endsWith(`/.local/share/mango/attachments/att-1/${name}`)).toBe(true)
      expect(readFileSync(path).equals(bytes)).toBe(true)
    }
  })

  it('leaves nothing behind when the data is not base64', () => {
    const home = tmp('attach-bad')
    const r = run('sh', ATTACH, ['att-2', 'x.txt'], { home, stdin: '!!!not base64!!!' })
    expect(r.code).not.toBe(0)
    expect(spawnSync('ls', ['-A', join(home, '.local/share/mango/attachments/att-2')], { encoding: 'utf8' }).stdout).toBe('')
  })

  it('refuses names that would leave the folder or hide', () => {
    for (const bad of ['../x', 'a/b', '.hidden', '-rf', '', 'a\nb']) expect(() => validAttachmentName(bad)).toThrow()
  })
})

describe('chat scripts', () => {
  it('round-trip in a scratch home', () => {
    const home = tmp('chats')
    const sh = (script: string, args: string[], stdin = '') => {
      const r = run('sh', script, args, { home, stdin })
      expect(r.code, r.stderr).toBe(0)
      return r.stdout
    }
    expect(sh(LIST, [])).toBe('')
    expect(sh(PUT, ['a', '0', '10'], '{"id":"a","v":1}').trim()).toBe('ok')
    // Another computer that last saw nothing (or an older revision) is refused.
    expect(sh(PUT, ['a', '5', '11'], '{"id":"a","v":0}').trim()).toBe('stale')
    expect(sh(PUT, ['a', '10', '12'], '{"id":"a","v":2}').trim()).toBe('ok')
    expect(sh(PUT, ['b', '0', '3'], '{"id":"b"}').trim()).toBe('ok')
    let list = parseList(sh(LIST, []))
    expect(list).toHaveLength(2)
    expect(list).toContainEqual({ id: 'a', rev: 12 })
    expect(parseFetch(sh(FETCH, ['a', 'missing']))).toEqual(['{"id":"a","v":2}'])
    sh(REMOVE, ['b'])
    expect(sh(PUT, ['b', '3', '99'], '{}').trim()).toBe('gone')
    list = parseList(sh(LIST, []))
    expect(list).toContainEqual({ id: 'b', rev: null })
    expect(parseFetch(sh(FETCH, ['b']))).toEqual([])
  })

  it('parses listings with tombstones first and fetched chats', () => {
    expect(parseList('a 12\nb 7\nbad id 3\nc x\nb -\nd -\n')).toEqual([
      { id: 'a', rev: 12 },
      { id: 'b', rev: null },
      { id: 'd', rev: null },
    ])
    expect(parseFetch('{"id":"a"}\0{bad\0{"id":"b"}\0')).toEqual(['{"id":"a"}', '{"id":"b"}'])
  })
})

describe('batch script', () => {
  it('runs every command and keeps its output exact', () => {
    const cmds = [
      { argv: ['printf', 'a\\nb'], cap: 100 },
      { argv: ['sh', '-c', "printf 'MANGO-RUN 9 9 9\\n'; echo oops >&2; exit 3"], cap: 100 },
      { argv: ['printf', '%s', '0123456789'], cap: 4 },
      { argv: ['true'], cap: 100 },
      { argv: ['printf', 'gr\\303\\274\\303\\237e \\000 x'], cap: 100 },
      // Endless output: the cap stops the command itself.
      { argv: ['yes'], cap: 6 },
    ]
    const r = run('bash', BATCH, batchArgs(cmds))
    expect(r.code, r.stderr).toBe(0)
    const caps = cmds.map(c => c.cap)
    // Something a profile printed first is skipped.
    const got = parseBatch(`welcome\n${r.stdout}`, caps)!
    expect(got).toHaveLength(6)
    expect([got[0]!.code, utf8Decode(got[0]!.stdout), got[0]!.truncated]).toEqual([0, 'a\nb', false])
    expect(got[1]!.code).toBe(3)
    expect(utf8Decode(got[1]!.stdout)).toBe('MANGO-RUN 9 9 9\n')
    expect(utf8Decode(got[1]!.stderr)).toBe('oops\n')
    expect([utf8Decode(got[2]!.stdout), got[2]!.truncated]).toEqual(['0123', true])
    expect([got[3]!.code, got[3]!.stdout.length, got[3]!.stderr.length]).toEqual([0, 0, 0])
    expect(utf8Decode(got[4]!.stdout)).toBe('grüße \0 x')
    expect([utf8Decode(got[5]!.stdout), got[5]!.truncated]).toEqual(['y\ny\ny\n', true])
    // A cut-off answer is not a result.
    expect(parseBatch(r.stdout.slice(0, r.stdout.length - 3), caps)).toBeNull()
  })
})

describe.skipIf(!haveGit)('git in a real repository', () => {
  const repo = tmp('repo')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  beforeAll(() => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
  })

  it('reads status and sizes in one batch, before and after the first commit', () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    mkdirSync(join(repo, 'pages'))
    writeFileSync(join(repo, 'pages', '[id].vue'), '<template/>\n')
    git('add', 'a.txt')
    const read = () => {
      const cmds = [
        { argv: gitRead(['rev-parse', '--show-toplevel']), cap: 4096 },
        { argv: gitRead(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']), cap: 1 << 20 },
        { argv: gitRead(['diff', '--numstat', '-z', '--no-color', '--no-ext-diff', '-M', 'HEAD']), cap: 1 << 20 },
      ]
      const r = run('bash', BATCH, batchArgs(cmds), { cwd: repo })
      return parseBatch(r.stdout, cmds.map(c => c.cap))!
    }
    let [where, status, stats] = read()
    expect(utf8Decode(where!.stdout).trim().endsWith(repo.split('/').pop()!)).toBe(true)
    let s = parseStatus(status!.stdout)
    expect(s.oid).toBeNull()
    // No commit yet: there is no HEAD to compare with.
    expect(stats!.code).not.toBe(0)
    expect(toChanges(s.files, new Map()).map(c => [c.path, c.kind, c.staged])).toEqual([
      ['a.txt', 'added', true],
      ['pages/[id].vue', 'untracked', false],
    ])

    git('commit', '-q', '-m', 'first')
    writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\n')
    ;[where, status, stats] = read()
    s = parseStatus(status!.stdout)
    expect(s.branch).toBe('main')
    expect(toChanges(s.files, parseNumstat(stats!.stdout))[0]).toEqual({ path: 'a.txt', kind: 'modified', staged: false, additions: 2, deletions: 1 })
  })

  it('shows an untracked file as added, with brackets in its name taken literally', () => {
    const r = run('bash', BATCH, batchArgs([{ argv: ['env', 'GIT_LITERAL_PATHSPECS=1', 'sh', '-c', UNTRACKED_DIFF, 'sh', 'pages/[id].vue'], cap: DIFF_CAP }]), { cwd: repo })
    const [o] = parseBatch(r.stdout, [DIFF_CAP])!
    expect(o!.code).toBe(0)
    expect(utf8Decode(o!.stdout)).toContain('+<template/>')
    const dir = run('bash', BATCH, batchArgs([{ argv: ['sh', '-c', UNTRACKED_DIFF, 'sh', 'pages'], cap: DIFF_CAP }]), { cwd: repo })
    expect(parseBatch(dir.stdout, [DIFF_CAP])![0]!.stdout.length).toBe(0)
  })

  it('stages and commits in one go', () => {
    const some = run('sh', COMMIT, ['some', 'a.txt'], { cwd: repo, stdin: 'Change a\n' })
    expect(some.code, some.stderr).toBe(0)
    expect(some.stdout.trim()).toMatch(/^[0-9a-f]{7,}$/)
    expect(git('log', '-1', '--format=%s').trim()).toBe('Change a')
    // The untracked file was left out.
    expect(git('status', '--porcelain')).toContain('?? pages/')
    const all = run('sh', COMMIT, ['all'], { cwd: repo, stdin: 'Add page\n' })
    expect(all.code, all.stderr).toBe(0)
    expect(git('status', '--porcelain')).toBe('')
    // Nothing left: the commit itself fails.
    expect(run('sh', COMMIT, ['all'], { cwd: repo, stdin: 'Empty\n' }).code).toBe(4)
  })
})

describe('projects script', () => {
  const env: Env = {
    id: 'h1',
    name: 'Lab',
    endpoint: { host: 'lab', port: 22, user: 'me', keyId: 'k', hostKey: 'x' },
    server: { incusRemote: null },
    addedAt: 0,
  }

  it('finds repositories under the home, outermost first, without worktrees', () => {
    const home = tmp('home')
    const repo = (dir: string, head: string) => {
      mkdirSync(join(home, dir, '.git'), { recursive: true })
      writeFileSync(join(home, dir, '.git', 'HEAD'), `${head}\n`)
    }
    repo('work/shop', 'ref: refs/heads/main')
    repo('work/my app', 'ref: refs/heads/feat/x')
    repo('work/detached', '1111111111111111111111111111111111111111')
    repo('work/shop/vendor-lib', 'ref: refs/heads/main') // nested: part of shop
    repo('work/node_modules/dep', 'ref: refs/heads/main') // skipped
    repo('.cache/thing', 'ref: refs/heads/main') // hidden: skipped
    repo('a/b/c/d/e/too-deep', 'ref: refs/heads/main') // beyond the depth
    // A linked worktree (`.git` is a file pointing at its git dir): part of shop, skipped.
    mkdirSync(join(home, 'work/shop/.git/worktrees/wt'), { recursive: true })
    writeFileSync(join(home, 'work/shop/.git/worktrees/wt/HEAD'), 'ref: refs/heads/wt-branch\n')
    mkdirSync(join(home, 'trees/wt'), { recursive: true })
    writeFileSync(join(home, 'trees/wt/.git'), `gitdir: ${join(home, 'work/shop/.git/worktrees/wt')}\n`)

    const r = run('bash', PROJECTS, [], { home })
    expect(r.code, r.stderr).toBe(0)
    const got = parseProjects(r.stdout, env, 'dev')
    expect(got.map(p => [p.path, p.name, p.branch])).toEqual([
      [`env://h1/dev${home}/work/detached`, 'detached', null],
      [`env://h1/dev${home}/work/my app`, 'my app', 'feat/x'],
      [`env://h1/dev${home}/work/shop`, 'shop', 'main'],
    ])
    expect(() => parseProjects('MANGO-ERR:nobase64\n', env, 'dev')).toThrow(/base64/)
  })
})
