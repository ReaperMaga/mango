import { describe, expect, it } from 'vitest'
import type { GhJobStep } from '~/types/ipc'
import {
  GH_QUERY, JOB_LOG, NOT_A_JOB, PR_CREATE, STEP_LINES,
  checkedTarget, chooseRemote, createdTarget, detailFailure, detailFromJson, epochSeconds, ghDetailArgv, ghError, ghFailure, ghItemArgv,
  ghJobArgv, ghJobLogArgv, ghMergeArgv, ghPrCreateArgv, ghWebUrl, isSha, jobFailure, jobFromJson, jobLogFailure, mergeFailure, parseGhDetail,
  parseGhItem, parseJobUrl, parseReference, parseRemotes, prCreateFailure, projectRepo, repoFromUrl, runState, splitLog, splitStamp, targetOf,
  targetOfRef, validGhOwner, validGhRepo, type GhRef, type GhTarget,
} from './github'
import { line } from './shell'

const ref = (over: Partial<GhRef> = {}): GhRef => ({ kind: 'pr', host: 'github.com', owner: 'acme', repo: 'shop-api', number: 128, ...over })

describe('github references', () => {
  it('accepts real owners and repositories only', () => {
    expect(validGhOwner('acme')).toBe(true)
    expect(validGhOwner('a-b-9')).toBe(true)
    expect(validGhOwner('-acme')).toBe(false)
    expect(validGhOwner('acme;rm')).toBe(false)
    expect(validGhOwner('a'.repeat(40))).toBe(false)
    expect(validGhRepo('shop.api_v2-x')).toBe(true)
    expect(validGhRepo('..')).toBe(false)
    expect(validGhRepo('a/b')).toBe(false)
    expect(validGhRepo('$(id)')).toBe(false)
  })

  it('builds the web address from the parts, on github.com only', () => {
    expect(ghWebUrl(ref())).toBe('https://github.com/acme/shop-api/pull/128')
    expect(ghWebUrl(ref({ kind: 'issue', number: 7 }))).toBe('https://github.com/acme/shop-api/issues/7')
    expect(ghWebUrl(ref({ host: 'GitHub.com' }))).toBe('https://github.com/acme/shop-api/pull/128')
    expect(ghWebUrl(ref({ host: 'evil.example' }))).toBeNull()
    expect(ghWebUrl(ref({ owner: 'javascript:' }))).toBeNull()
    expect(ghWebUrl(ref({ number: 0 }))).toBeNull()
    expect(ghWebUrl(ref({ number: 1.5 }))).toBeNull()
  })

  it('reads one item with gh api, every value quoted', () => {
    const argv = ghItemArgv(ref())
    expect(argv.slice(0, 5)).toEqual(['gh', 'api', '--hostname', 'github.com', 'repos/acme/shop-api/issues/128'])
    expect(line(argv)).toContain("'{title, state, state_reason, draft, merged_at: .pull_request.merged_at, pr: (.pull_request != null)}'")
    expect(() => ghItemArgv(ref({ repo: 'x;reboot' }))).toThrow(/github.com/)
    expect(() => ghItemArgv(ref({ host: 'gitlab.com' }))).toThrow()
  })
})

describe('parseGhItem', () => {
  const out = (v: object) => `${JSON.stringify(v)}\n`
  it('tells pull request states apart', () => {
    expect(parseGhItem(out({ title: 'A', state: 'open', draft: false, merged_at: null, pr: true }))).toEqual({ kind: 'pr', title: 'A', state: 'open', stateReason: null })
    expect(parseGhItem(out({ title: 'A', state: 'open', draft: true, merged_at: null, pr: true }))?.state).toBe('draft')
    expect(parseGhItem(out({ title: 'A', state: 'closed', draft: false, merged_at: '2026-11-01T10:00:00Z', pr: true }))?.state).toBe('merged')
    expect(parseGhItem(out({ title: 'A', state: 'closed', draft: false, merged_at: null, pr: true }))?.state).toBe('closed')
  })
  it('reads issues with their reason', () => {
    expect(parseGhItem(out({ title: 'B', state: 'closed', state_reason: 'NOT_PLANNED', draft: null, merged_at: null, pr: false })))
      .toEqual({ kind: 'issue', title: 'B', state: 'closed', stateReason: 'not_planned' })
  })
  it('refuses anything else', () => {
    expect(parseGhItem('')).toBeNull()
    expect(parseGhItem('not json')).toBeNull()
    expect(parseGhItem(out({ state: 'open' }))).toBeNull()
    expect(parseGhItem(out({ title: 'C', state: 'weird' }))).toBeNull()
  })
})

describe('ghFailure', () => {
  it('says what to do when gh is missing or signed out', () => {
    expect(ghFailure('dev', ref(), 127, 'bash: line 1: gh: command not found')).toMatch(/not installed in dev/)
    expect(ghFailure('dev', ref(), 2, 'sh: 1: gh: not found\n')).toMatch(/not installed in dev/)
    expect(ghFailure('dev', ref(), 4, 'To get started with GitHub CLI, please run:  gh auth login')).toMatch(/not signed in/)
    expect(ghFailure('dev', ref(), 1, 'gh: Bad credentials (HTTP 401)')).toMatch(/not signed in/)
    expect(ghFailure('dev', ref(), 1, 'gh: Not Found (HTTP 404)')).toMatch(/acme\/shop-api#128/)
    expect(ghFailure('dev', ref(), 1, 'error connecting to api.github.com\n')).toBe('Could not read from GitHub: error connecting to api.github.com')
    expect(ghFailure('dev', ref(), null, '')).toMatch(/interrupted/)
  })
})

/* ---------- ported from the tests of src-tauri/src/github.rs ---------- */

const full = (host: string, owner: string, repo: string, number: number) => ({ kind: 'full', target: { host, owner, repo, number } })
const repoT = (host: string, owner: string, name: string) => [host, owner, name]

describe('references', () => {
  it('parses links, owner/repo#n and bare numbers', () => {
    expect(parseReference('12')).toEqual({ kind: 'number', number: 12 })
    expect(parseReference(' #7 ')).toEqual({ kind: 'number', number: 7 })
    expect(parseReference('octo/hello.world#3')).toEqual(full('github.com', 'octo', 'hello.world', 3))
    expect(parseReference('https://github.com/ReaperMaga/mango/pull/19')).toEqual(full('github.com', 'ReaperMaga', 'mango', 19))
    expect(parseReference('https://www.GitHub.com/a/b/pull/19/files#diff-1')).toEqual(full('github.com', 'a', 'b', 19))
    expect(parseReference('https://github.com/a/b/issues/4#issuecomment-99')).toEqual(full('github.com', 'a', 'b', 4))
    expect(parseReference('https://git.example.com:8443/team/app/pulls/5')).toEqual(full('git.example.com:8443', 'team', 'app', 5))
  })

  it('refuses what is not a reference', () => {
    for (const bad of [
      '', '#', '0', 'abc', '99999999999', 'https://github.com/a/b', 'https://github.com/a/b/tree/main',
      'https://github.com/a/b/pull/x', 'https://github.com/../b/pull/1', 'https://github.com/a b/c/pull/1',
      'ftp://github.com/a/b/pull/1', '@file#1', 'a/@b#1', '2147483648',
    ]) {
      expect(() => parseReference(bad), bad).toThrow(/Paste a pull request or issue link/)
    }
  })

  it('keeps the phone to github.com and to names GitHub allows', () => {
    const t = (over: Partial<GhTarget>): GhTarget => ({ host: 'github.com', owner: 'o', repo: 'r', number: 5, ...over })
    expect(checkedTarget(t({ host: 'GitHub.com' })).host).toBe('github.com')
    expect(() => checkedTarget(t({ host: 'git.example.com' }))).toThrow(/only.*github\.com|github\.com\. Only/)
    expect(() => checkedTarget(t({ owner: 'a;rm' }))).toThrow()
    expect(() => checkedTarget(t({ owner: 'a.b' }))).toThrow()
    expect(() => checkedTarget(t({ number: 0 }))).toThrow()
    expect(() => checkedTarget(t({ number: 2 ** 31 }))).toThrow()
    expect(() => targetOfRef({ kind: 'pr', host: 'github.com', owner: '-x', repo: 'r', number: 1 })).toThrow(/github.com/)
    const n = parseReference('#12')
    expect(targetOf(n, { owner: 'acme', repo: 'shop' })).toEqual({ host: 'github.com', owner: 'acme', repo: 'shop', number: 12 })
    expect(() => targetOf(parseReference('https://gitlab.com/a/b/pull/1'), { owner: 'x', repo: 'y' })).toThrow(/gitlab\.com is not github\.com/)
  })
})

describe('remotes', () => {
  it('reads repositories from remote URLs', () => {
    const mango = repoT('github.com', 'acme', 'mango')
    for (const url of [
      'https://github.com/acme/mango.git', 'https://github.com/acme/mango', 'https://github.com/acme/mango/',
      'http://www.github.com/acme/mango', 'https://user:token@github.com/acme/mango.git', 'git@github.com:acme/mango.git',
      'git@github.com:acme/mango', 'github.com:acme/mango.git', 'ssh://git@github.com/acme/mango.git',
      'ssh://git@ssh.github.com:443/acme/mango.git', 'git+ssh://git@github.com/acme/mango', 'git://github.com/acme/mango.git',
      '  HTTPS://GitHub.com/acme/mango.git\n',
    ]) {
      expect(repoFromUrl(url), url).toEqual(mango)
    }
    expect(repoFromUrl('git@git.corp.example:team/app.git')).toEqual(repoT('git.corp.example', 'team', 'app'))
    expect(repoFromUrl('https://ghe.example.com:8443/team/app')).toEqual(repoT('ghe.example.com', 'team', 'app'))
    expect(repoFromUrl('https://acme.ghe.com/team/app.js.git')).toEqual(repoT('acme.ghe.com', 'team', 'app.js'))
    for (const url of [
      '', '/srv/git/mango.git', '../mango', 'C:\\repos\\mango', 'C:/repos/mango', 'file:///srv/git/acme/mango.git',
      'work:acme/mango.git', 'https://github.com/acme', 'https://github.com/acme/mango/extra', 'https://github.com/acme/../mango',
      'git@github.com:acme/mango;rm -rf.git', 'https://-evil.com/acme/mango', 'git@github.com:/',
    ]) {
      expect(repoFromUrl(url), url).toBeNull()
    }
  })

  it('parses git remote -v', () => {
    const list = 'origin\tgit@github.com:me/mango.git (fetch)\norigin\tgit@github.com:me/mango.git (push)\n'
      + 'upstream\thttps://github.com/acme/mango (fetch)\nupstream\tno_push (push)\n\n'
    expect(parseRemotes(list)).toEqual([['origin', 'git@github.com:me/mango.git'], ['upstream', 'https://github.com/acme/mango']])
    expect(parseRemotes('')).toEqual([])
  })

  it('chooses the remote gh would', () => {
    const fork = 'git@github.com:me/mango.git'
    const main = 'https://github.com/acme/mango.git'
    expect(chooseRemote([['origin', fork], ['upstream', main]])).toEqual(repoT('github.com', 'acme', 'mango'))
    expect(chooseRemote([['origin', fork], ['github', main]])).toEqual(repoT('github.com', 'acme', 'mango'))
    expect(chooseRemote([['mine', main], ['origin', fork]])).toEqual(repoT('github.com', 'me', 'mango'))
    expect(chooseRemote([['b', fork], ['a', main]])).toEqual(repoT('github.com', 'me', 'mango'))
    expect(chooseRemote([['only', main]])).toEqual(repoT('github.com', 'acme', 'mango'))
    expect(chooseRemote([['origin', 'git@gitlab.com:acme/mango.git'], ['mirror', fork]])).toEqual(repoT('github.com', 'me', 'mango'))
    expect(chooseRemote([['upstream', '/srv/git/mango.git'], ['origin', fork]])).toEqual(repoT('github.com', 'me', 'mango'))
    expect(chooseRemote([['origin', 'git@git.corp.example:team/app.git']])).toEqual(repoT('git.corp.example', 'team', 'app'))
    expect(chooseRemote([['origin', '../elsewhere']])).toBeNull()
    expect(chooseRemote([])).toBeNull()
  })

  it('finds the project repository on github.com only', () => {
    expect(projectRepo('origin\tgit@github.com:acme/shop.git (fetch)\n')).toEqual({ owner: 'acme', repo: 'shop' })
    expect(() => projectRepo(null)).toThrow(/not a git repository/)
    expect(() => projectRepo('origin\t/srv/x.git (fetch)\n')).toThrow(/None of the project's git remotes/)
    expect(() => projectRepo('origin\tgit@git.corp.example:team/app.git (fetch)\n')).toThrow(/on git\.corp\.example, and the phone reads only github\.com/)
  })
})

const T: GhTarget = { host: 'github.com', owner: 'o', repo: 'r', number: 5 }

describe('one item in full', () => {
  it('reads it with gh api graphql: -f for strings, -F only for the number', () => {
    const argv = ghDetailArgv(T)
    expect(argv).toEqual(['gh', 'api', 'graphql', '--hostname', 'github.com', '-f', 'owner=o', '-f', 'name=r', '-F', 'number=5', '-f', `query=${GH_QUERY}`])
    expect(GH_QUERY).toContain(' body ')
    expect(GH_QUERY).not.toContain('bodyHTML')
    expect(line(argv)).toContain("'query=query($owner: String!")
    // Nothing unvalidated reaches an argv.
    expect(() => ghDetailArgv({ ...T, owner: 'a;rm' })).toThrow()
    expect(() => ghDetailArgv({ ...T, repo: '$(id)' })).toThrow()
    expect(() => ghDetailArgv({ ...T, owner: '@etc' })).toThrow()
    expect(() => ghDetailArgv({ ...T, host: 'evil.example' })).toThrow()
  })

  it('reads a pull request', () => {
    const contexts = [
      { __typename: 'CheckRun', name: 'Frontend', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2', isRequired: true, checkSuite: { workflowRun: { workflow: { name: 'CI' } } } },
      { __typename: 'CheckRun', name: 'Backend', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: null, isRequired: false, checkSuite: { workflowRun: null } },
      { __typename: 'CheckRun', name: 'Windows', status: 'IN_PROGRESS', conclusion: null, isRequired: false, checkSuite: null },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: 'https://ci.example.com/9', description: 'Build errored', isRequired: false },
    ]
    const v = { data: { repository: {
      viewerPermission: 'WRITE', mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: 'SQUASH',
      issueOrPullRequest: {
        __typename: 'PullRequest', title: 'feat: x', url: 'https://github.com/o/r/pull/5', number: 5, state: 'OPEN', isDraft: true,
        body: '## Hi\n\n- one', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', author: { login: 'me', avatarUrl: 'https://a/x.png' },
        headRefName: 'feat/x', headRefOid: 'd013dd471daf6f6672ea035294ab4f01282f9c38', baseRefName: 'main', additions: 10, deletions: 2, changedFiles: 3,
        reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', comments: { totalCount: 4 },
        labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: contexts } } } }] },
      },
    } } }
    const item = parseGhDetail(JSON.stringify(v), T, 'dev')
    expect(item).toMatchObject({
      kind: 'pr', state: 'draft', headRef: 'feat/x', baseRef: 'main', reviewDecision: 'changes_requested', checks: 'failure', comments: 4,
      body: '## Hi\n\n- one', author: { login: 'me', avatarUrl: 'https://a/x.png' }, labels: [{ name: 'bug', color: 'd73a4a' }],
      headSha: 'd013dd471daf6f6672ea035294ab4f01282f9c38', mergeable: 'conflicting', mergeState: 'dirty',
      mergeMethods: ['squash', 'rebase'], defaultMergeMethod: 'squash', canMerge: true, additions: 10, deletions: 2, changedFiles: 3,
    })
    expect(item.checkRuns.map(c => [c.name, c.state])).toEqual([['Frontend', 'success'], ['Backend', 'failure'], ['Windows', 'pending'], ['ci/legacy', 'failure']])
    expect(item.checkRuns[0]!.workflow).toBe('CI')
    expect(item.checkRuns[0]!.required && !item.checkRuns[1]!.required).toBe(true)
    expect(item.checkRuns[3]).toEqual({ name: 'ci/legacy', workflow: null, state: 'failure', url: 'https://ci.example.com/9', description: 'Build errored', required: false })
    expect('bodyHtml' in item).toBe(false)
  })

  it('read access may not merge', () => {
    const v = { data: { repository: { viewerPermission: 'READ', squashMergeAllowed: true, issueOrPullRequest: { __typename: 'PullRequest', state: 'OPEN', number: 5 } } } }
    const item = detailFromJson(v, T)
    expect(item.canMerge).toBe(false)
    expect(item.checkRuns).toEqual([])
    expect(item.mergeMethods).toEqual(['squash'])
    expect(item.url).toBe('https://github.com/o/r/pull/5')
  })

  it('reads an issue', () => {
    const v = { data: { repository: { issueOrPullRequest: {
      __typename: 'Issue', title: 'Crash', url: 'https://github.com/o/r/issues/5', number: 5, state: 'CLOSED', stateReason: 'NOT_PLANNED',
      body: '', createdAt: '', updatedAt: '', author: null, comments: { totalCount: 0 }, labels: { nodes: [] },
    } } } }
    const item = detailFromJson(v, T)
    expect(item).toMatchObject({ kind: 'issue', state: 'closed', stateReason: 'not_planned', author: null, headRef: null, checks: null, canMerge: false, mergeMethods: [] })
  })

  it('merged wins over draft, closed is closed, and missing items are named', () => {
    const pr = (state: string) => ({ data: { repository: { issueOrPullRequest: { __typename: 'PullRequest', state, isDraft: true, number: 5 } } } })
    expect(detailFromJson(pr('MERGED'), T).state).toBe('merged')
    expect(detailFromJson(pr('CLOSED'), T).state).toBe('closed')
    expect(() => detailFromJson({ data: { repository: { issueOrPullRequest: null } } }, T)).toThrow('There is no pull request or issue #5 in o/r.')
    expect(() => detailFromJson({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository with the name 'o/r'." }] }, T)).toThrow(/^GitHub: Could not resolve/)
    expect(() => parseGhDetail('nope', T, 'dev')).toThrow(/unexpected/)
  })

  it('words gh failures', () => {
    expect(ghError('dev', 127, 'bash: gh: command not found')).toMatch(/not installed in dev/)
    expect(ghError('dev', 4, 'To get started with GitHub CLI, please run:  gh auth login')).toMatch(/not signed in/)
    expect(ghError('dev', 1, 'gh: Could not resolve to a Repository', '', T)).toMatch(/no repository o\/r/)
    expect(ghError('dev', 1, '')).toMatch(/without saying why \(exit code 1\)/)
    expect(ghError('dev', null, '')).toMatch(/interrupted/)
    // GraphQL errors exit 1 and still print the answer.
    const none = JSON.stringify({ data: { repository: { issueOrPullRequest: null } }, errors: [{ message: 'Could not resolve to an issue or pull request with the number of 5.' }] })
    expect(detailFailure('dev', T, 1, 'gh: Could not resolve to an issue or pull request with the number of 5.', none)).toBe('There is no pull request or issue #5 in o/r.')
    const noRepo = JSON.stringify({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository with the name 'o/r'." }] })
    expect(detailFailure('dev', T, 1, "gh: Could not resolve to a Repository with the name 'o/r'.", noRepo)).toMatch(/no repository o\/r/)
    expect(detailFailure('dev', T, 4, 'gh auth login', '')).toMatch(/not signed in/)
  })
})

describe('merging', () => {
  const sha = 'd013dd471daf6f6672ea035294ab4f01282f9c38'
  it('builds the PUT, refusing bad requests before asking GitHub', () => {
    expect(ghMergeArgv(T, 'squash', sha)).toEqual(['gh', 'api', '--hostname', 'github.com', '--method', 'PUT', 'repos/o/r/pulls/5/merge', '-f', 'merge_method=squash', '-f', `sha=${sha}`])
    expect(() => ghMergeArgv(T, 'fast-forward', sha)).toThrow(/not a merge method/)
    expect(() => ghMergeArgv(T, 'squash', 'HEAD')).toThrow(/again/)
    expect(() => ghMergeArgv(T, 'squash', `${sha.slice(0, 39)};`)).toThrow(/again/)
    expect(() => ghMergeArgv({ ...T, owner: 'a;rm' }, 'squash', sha)).toThrow()
    expect(isSha(sha)).toBe(true)
    expect(isSha('a'.repeat(64))).toBe(true)
    expect(isSha('g'.repeat(40))).toBe(false)
  })

  it('explains refused merges', () => {
    expect(mergeFailure('dev', T, 1, '{}', 'gh: something (HTTP 409)')).toMatch(/new commits/)
    expect(mergeFailure('dev', T, 1, '{"message":"Required status check \\"CI\\" is failing."}', 'gh: x (HTTP 405)')).toBe('GitHub refused the merge: Required status check "CI" is failing.')
    expect(mergeFailure('dev', T, 1, '{}', 'gh: x (HTTP 422)')).toBe('GitHub refused the merge: it cannot be merged right now.')
    expect(mergeFailure('dev', T, 1, '{}', 'gh: x (HTTP 403)')).toMatch(/may not merge pull requests in o\/r/)
    expect(mergeFailure('dev', T, 1, '{"message":"Not Found"}', 'gh: Not Found (HTTP 404)')).toBe('The account gh is signed in with may not merge pull requests in o/r. GitHub says: Not Found')
    expect(mergeFailure('dev', T, 127, '', 'sh: 1: gh: not found')).toMatch(/not installed in dev/)
  })
})

describe('jobs', () => {
  it('parses job links, github.com only', () => {
    expect(parseJobUrl('https://github.com/o/r/actions/runs/43950306942/job/133590732587?pr=4')).toEqual({ host: 'github.com', owner: 'o', repo: 'r', job: 133590732587 })
    for (const bad of [
      '', 'http://github.com/o/r/actions/runs/1/job/2', 'https://github.com/o/r/actions/runs/1', 'https://github.com/o/r/pull/1',
      'https://github.com/../r/actions/runs/1/job/2', 'https://github.com/o/r/actions/runs/x/job/2', 'https://github.com/o/r/actions/runs/1/job/-2',
      'https://ci.example.com/build/9', 'https://github.com/a;rm/r/actions/runs/1/job/2',
    ]) {
      expect(() => parseJobUrl(bad), bad).toThrow(NOT_A_JOB)
    }
    expect(() => parseJobUrl('https://ghe.example.com/o/r/actions/runs/1/job/2')).toThrow(/reads only github\.com/)
  })

  it('reads a job and its log through gh, every value validated', () => {
    const t = parseJobUrl('https://github.com/o/r/actions/runs/1/job/2')
    expect(ghJobArgv(t)).toEqual(['gh', 'api', '--hostname', 'github.com', 'repos/o/r/actions/jobs/2'])
    expect(ghJobLogArgv(t)).toEqual(['sh', '-c', JOB_LOG, 'mango-job', 'repos/o/r/actions/jobs/2', '1'])
    expect(ghJobLogArgv(t, false).at(-1)).toBe('0')
    expect(JOB_LOG).toContain('--allow-escape-sequences')
    expect(jobFailure('dev', t, 1, 'gh: Not Found (HTTP 404)')).toBe('GitHub has no job 2 in o/r, or the account gh is signed in with in dev cannot see it.')
    expect(jobLogFailure('dev', 1, 'gh: Gone (HTTP 410)')).toMatch(/expired/)
    expect(jobLogFailure('dev', 1, 'gh: Not Found (HTTP 404)')).toBe('GitHub has no log for this job.')
  })

  it('job states', () => {
    expect(runState('in_progress', null)).toBe('pending')
    expect(runState('queued', null)).toBe('queued')
    expect(runState(null, null)).toBe('queued')
    expect(runState('completed', 'timed_out')).toBe('failure')
    expect(runState('completed', 'skipped')).toBe('skipped')
    expect(runState('completed', 'stale')).toBe('neutral')
  })

  it('reads iso times', () => {
    const t = epochSeconds('2026-11-16T20:29:33Z')!
    expect(epochSeconds('2026-11-16T20:29:33.9418942Z')).toBe(t)
    expect(epochSeconds('2026-11-16T20:29:34Z')).toBe(t + 1)
    expect(epochSeconds('2026-11-17T00:00:00Z')! - epochSeconds('2026-11-16T00:00:00Z')!).toBe(86_400)
    expect(epochSeconds('1970-01-01T00:00:00Z')).toBe(0)
    expect(epochSeconds('2024-03-01T00:00:00Z')! - epochSeconds('2024-02-28T00:00:00Z')!).toBe(2 * 86_400)
    expect(t).toBe(Date.parse('2026-11-16T20:29:33Z') / 1000)
    expect(epochSeconds('not a time')).toBeNull()
    expect(splitStamp('2026-11-16T20:29:33.94Z hello world')).toEqual([t, 'hello world'])
    expect(splitStamp('plain line')).toEqual([null, 'plain line'])
  })

  const step = (number: number, name: string, conclusion: string, start: string, end: string) =>
    ({ number, name, status: 'completed', conclusion, started_at: `2026-11-16T20:29:${start}Z`, completed_at: `2026-11-16T20:29:${end}Z` })

  it('splits a log into its steps', () => {
    const v = { id: 2, name: 'build', workflow_name: 'CI', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/actions/runs/1/job/2', steps: [
      step(1, 'Set up job', 'success', '33', '35'),
      step(2, 'Run actions/checkout@v7', 'success', '35', '36'),
      step(3, 'Lint', 'skipped', '36', '36'),
      step(4, 'Build', 'success', '36', '36'),
      step(5, 'Test', 'failure', '36', '40'),
      step(14, 'Post Run actions/checkout@v7', 'success', '40', '40'),
      step(15, 'Complete job', 'success', '40', '40'),
    ] }
    const log = '\uFEFF2026-11-16T20:29:33.94Z Current runner version: \'2.338.2\'\n'
      + '2026-11-16T20:29:35.18Z Complete job name: build\n'
      + '2026-11-16T20:29:35.27Z ##[group]Run actions/checkout@v7\n'
      + '2026-11-16T20:29:35.28Z ##[endgroup]\n'
      + '2026-11-16T20:29:36.01Z ##[group]Run pnpm build\n'
      + '2026-11-16T20:29:36.02Z ##[start-action display=Inner;id=x]\n'
      + '2026-11-16T20:29:36.03Z ##[group]Run echo inner\n'
      + '2026-11-16T20:29:36.04Z ##[end-action id=x;outcome=success]\n'
      + '2026-11-16T20:29:36.05Z built\r\n'
      + '2026-11-16T20:29:36.50Z ##[group]Run pnpm test\n'
      + '2026-11-16T20:29:39.00Z \x1b[31mFAIL\x1b[0m one test\n'
      + '2026-11-16T20:29:39.10Z ##[error]Process completed with exit code 1.\n'
      + '2026-11-16T20:29:40.10Z Post job cleanup.\n'
      + '2026-11-16T20:29:40.20Z Cleaning up orphan processes\n'
    const job = jobFromJson(v)
    expect([job.state, job.workflow, job.id, job.url]).toEqual(['failure', 'CI', 2, 'https://github.com/o/r/actions/runs/1/job/2'])
    splitLog(log, job.steps)
    const lines = job.steps.map(s => s.lines)
    expect(lines[0]).toEqual(["Current runner version: '2.338.2'", 'Complete job name: build'])
    expect(lines[1]).toEqual(['##[group]Run actions/checkout@v7', '##[endgroup]'])
    expect(lines[2]).toEqual([])
    expect(lines[3]).toEqual(['##[group]Run pnpm build', '##[group]Run echo inner', 'built'])
    expect(lines[4]).toEqual(['##[group]Run pnpm test', '\x1b[31mFAIL\x1b[0m one test', '##[error]Process completed with exit code 1.'])
    expect(lines[5]).toEqual(['Post job cleanup.'])
    expect(lines[6]).toEqual(['Cleaning up orphan processes'])
  })

  it('a long step keeps its end', () => {
    const job = jobFromJson({ status: 'completed', conclusion: 'success', steps: [step(1, 'Spam', 'success', '00', '59')] })
    const log = Array.from({ length: STEP_LINES + 7 }, (_, i) => `2026-11-16T20:29:10.0Z line ${i}\n`).join('')
    splitLog(log, job.steps)
    const s = job.steps[0] as GhJobStep
    expect(s.omitted).toBe(7)
    expect(s.lines).toHaveLength(STEP_LINES)
    expect(s.lines[0]).toBe('line 7')
  })

  it('leaves steps that never started alone', () => {
    const job = jobFromJson({ status: 'in_progress', steps: [{ number: 1, name: 'Wait', status: 'queued' }] })
    expect(job.state).toBe('pending')
    splitLog('2026-11-16T20:29:10.0Z x\n', job.steps)
    expect(job.steps[0]!.lines).toEqual([])
  })
})

describe('opening a pull request', () => {
  it('runs gh pr create --fill in the folder, the base checked', () => {
    expect(ghPrCreateArgv(null)).toEqual(['sh', '-c', PR_CREATE, 'mango-pr', ''])
    expect(ghPrCreateArgv(' main ')).toEqual(['sh', '-c', PR_CREATE, 'mango-pr', 'main'])
    expect(() => ghPrCreateArgv('--repo=evil/x')).toThrow(/not a valid branch name/)
    expect(() => ghPrCreateArgv('a b')).toThrow(/not a valid branch name/)
    expect(() => ghPrCreateArgv('a..b')).toThrow(/not a valid branch name/)
    expect(PR_CREATE).toContain('gh pr create --fill "--head=$b" "--base=$1"')
  })

  it('finds the pull request gh created', () => {
    const t = createdTarget('https://github.com/acme/app/pull/12\n')!
    expect([t.owner, t.repo, t.number]).toEqual(['acme', 'app', 12])
    const exists = 'a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/acme/app/pull/7'
    expect(createdTarget(exists)!.number).toBe(7)
    expect(createdTarget('Creating pull request for feat/x into main\n')).toBeNull()
    expect(createdTarget('https://github.com/acme/app/issues/3')).toBeNull()
  })

  it('words its failures', () => {
    expect(prCreateFailure('dev', null, 3, 'MANGO-ERR:detached\n')).toMatch(/HEAD is detached/)
    expect(prCreateFailure('dev', null, 128, 'fatal: not a git repository (or any of the parent directories): .git\n')).toMatch(/not a git repository/)
    expect(prCreateFailure('dev', 'main', 1, "MANGO-BRANCH:feat/x\npull request create failed: GraphQL: Head sha can't be blank (createPullRequest)")).toBe('feat/x is not on GitHub yet. Push it first, then open the pull request.')
    expect(prCreateFailure('dev', 'main', 1, 'MANGO-BRANCH:feat/x\npull request create failed: GraphQL: No commits between main and feat/x (createPullRequest)')).toMatch(/^feat\/x has no commits that main doesn't have/)
    expect(prCreateFailure('dev', null, 4, 'MANGO-BRANCH:feat/x\nTo get started with GitHub CLI, please run:  gh auth login')).toMatch(/not signed in/)
    expect(prCreateFailure('dev', null, 1, 'MANGO-BRANCH:feat/x\nboom')).toBe('The GitHub CLI failed: boom')
  })
})
