import { describe, expect, it } from 'vitest'
import type { Forge } from './gitlab'
import {
  BAD_REFERENCE, MR_DETAILS, NO_PROJECT, createdMr, glDetailArgv, glDetailFromJson, glJobArgvs, glJobFromJson, glMergeArgv, glMergeFailure,
  glMrDetailsArgv, glMrPostArgv, glQuery, glRunState, glStateArgv, glTargetOfRef, isoFromEpoch, mergeStatus, mrPostFailure, parseGlJobUrl,
  parseGlState, parseMrDetails, postedIid, prText, route, schemaLacksField, splitTrace, type GlKind, type GlTarget,
} from './gitlabItems'
import { STEP_LINES, epochSeconds } from './github'
import { line } from './shell'

/** Ported from the tests of `src-tauri/src/gitlab_items.rs`, plus what only the phone does. */

const forge = (host: string, owner: string, repo: string): Forge => ({ provider: 'gitlab', host, owner, repo })
const gl = (host: string, path: string, iid: number, kind: GlKind) => {
  const i = path.lastIndexOf('/')
  return { to: 'gitlab', target: { forge: forge(host, path.slice(0, i), path.slice(i + 1)), iid, kind } }
}
const KNOWN = ['git.corp.io']
const onGitlab = forge('gitlab.example.com', 'team/sub', 'app')
const onGithub: Forge = { provider: 'github', host: 'github.com', owner: 'o', repo: 'r' }

describe('routing references', () => {
  it('routes links', () => {
    expect(route('https://gitlab.com/group/sub/proj/-/merge_requests/12/diffs?x=1#note_5', KNOWN, null, 'dev')).toEqual(gl('gitlab.com', 'group/sub/proj', 12, 'mr'))
    expect(route('https://www.GitLab.com/g/p/-/issues/4', KNOWN, null, 'dev')).toEqual(gl('gitlab.com', 'g/p', 4, 'issue'))
    expect(route('https://git.corp.io/a/b/c/d/-/work_items/9', KNOWN, null, 'dev')).toEqual(gl('git.corp.io', 'a/b/c/d', 9, 'issue'))
    expect(route('https://gitlab.example.com:8443/g/p/-/merge_requests/1', KNOWN, null, 'dev')).toEqual(gl('gitlab.example.com:8443', 'g/p', 1, 'mr'))
    expect(route('https://github.com/o/r/pull/3', KNOWN, null, 'dev')).toEqual({ to: 'github' })
    expect(route('https://ghe.example.com/o/r/issues/3', KNOWN, null, 'dev')).toEqual({ to: 'github' })
    expect(() => route('https://evil.example.com/g/p/-/merge_requests/1', KNOWN, null, 'dev')).toThrow(/not a GitLab server the GitLab CLI in dev is signed in to/)
  })

  it('refuses junk links', () => {
    for (const bad of [
      'https://gitlab.com/g/p/-/merge_requests/x',
      'https://gitlab.com/g/p/-/merge_requests/0',
      'https://gitlab.com/g/p/-/merge_requests/99999999999',
      'https://gitlab.com/g/p/-/merge_requests/',
      'https://gitlab.com/p/-/merge_requests/1',
      'https://gitlab.com/-/merge_requests/1',
      'https://gitlab.com/../p/-/issues/1',
      'https://gitlab.com/g/-p/-/issues/1',
      'https://gitlab.com/g/p.git/-/issues/1',
      'https://gitlab.com/g/p/-/pipelines/1',
      'https://gitlab.com/g/p',
      'https://gitlab.com/g%2F/p/-/issues/1',
      'https://gitlab.com/g p/q/-/issues/1',
      'https://-bad.gitlab.com/g/p/-/issues/1',
    ]) expect(() => route(bad, KNOWN, null, 'dev'), bad).toThrow()
  })

  it('routes short references', () => {
    expect(route('!12', KNOWN, onGitlab, 'dev')).toEqual(gl('gitlab.example.com', 'team/sub/app', 12, 'mr'))
    expect(route(' #7 ', KNOWN, onGitlab, 'dev')).toEqual(gl('gitlab.example.com', 'team/sub/app', 7, 'issue'))
    expect(route('7', KNOWN, onGitlab, 'dev')).toEqual(gl('gitlab.example.com', 'team/sub/app', 7, 'either'))
    expect(route('other/proj#3', KNOWN, onGitlab, 'dev')).toEqual(gl('gitlab.example.com', 'other/proj', 3, 'issue'))
    expect(route('g/sub/proj!3', KNOWN, onGitlab, 'dev')).toEqual(gl('gitlab.example.com', 'g/sub/proj', 3, 'mr'))
    expect(route('g/proj!3', KNOWN, onGithub, 'dev')).toEqual(gl('gitlab.com', 'g/proj', 3, 'mr'))
    expect(route('g/sub/proj#3', KNOWN, onGithub, 'dev')).toEqual(gl('gitlab.com', 'g/sub/proj', 3, 'issue'))
    expect(route('#7', KNOWN, onGithub, 'dev')).toEqual({ to: 'github' })
    expect(route('7', KNOWN, null, 'dev')).toEqual({ to: 'github' })
    expect(route('o/r#7', KNOWN, onGithub, 'dev')).toEqual({ to: 'github' })
    expect(() => route('!12', KNOWN, onGithub, 'dev')).toThrow(NO_PROJECT)
    for (const bad of ['!', '!x', '!0', 'a!1', 'g/-x!1', 'a/b/../c#1', '@file!1', '!99999999999']) {
      expect(() => route(bad, KNOWN, onGitlab, 'dev'), bad).toThrow()
    }
    expect(() => route('nonsense', KNOWN, onGitlab, 'dev')).toThrow(BAD_REFERENCE)
  })

  it('checks a linked item before anything is read', () => {
    const ref = { provider: 'gitlab' as const, kind: 'pr' as const, host: 'GitLab.com', owner: 'a/b', repo: 'c', number: 3 }
    expect(glTargetOfRef(ref)).toEqual({ forge: forge('gitlab.com', 'a/b', 'c'), iid: 3, kind: 'mr' })
    expect(() => glTargetOfRef({ ...ref, owner: 'a;b' })).toThrow()
    expect(() => glTargetOfRef({ ...ref, host: '$(id).io' })).toThrow()
    expect(() => glTargetOfRef({ ...ref, number: 0 })).toThrow()
  })
})

const target = (kind: GlKind): GlTarget => ({ forge: forge('git.corp.io', 'team/sub', 'app'), iid: 12, kind })

describe('reading one item', () => {
  it('fits the query to the kind, and retries without the paid fields', () => {
    const q = glQuery('either', true)
    expect(q.includes('mergeRequest(iid: $iid)') && q.includes('issue(iid: $iid)') && q.includes('approvalsLeft')).toBe(true)
    expect(glQuery('mr', false)).not.toContain('approvalsLeft')
    expect(glQuery('issue', true)).not.toContain('mergeRequest')
    expect(glQuery('issue', true)).not.toContain('EXTRA')
    expect(glQuery('either', false)).not.toContain('EXTRA')
    // The phone reads the Markdown, not the HTML.
    expect(glQuery('either', true)).toContain(' description ')
    expect(glQuery('either', true)).not.toContain('descriptionHtml')
    expect(schemaLacksField({ errors: [{ message: "Field 'approvalsLeft' doesn't exist on type 'MergeRequest'" }] })).toBe(true)
    expect(schemaLacksField({ data: {} })).toBe(false)
    const argv = glDetailArgv(target('mr'))
    expect(line(argv)).toContain('glab api --hostname git.corp.io graphql -f fullPath=team/sub/app -f iid=12 ')
    expect(argv).not.toContain('-F')
  })

  const mrJson = (): any => ({ data: { project: {
    squashOption: { option: 'DEFAULT_ON' },
    mergeRequest: {
      iid: '12', title: 'feat: x', webUrl: 'https://git.corp.io/team/sub/app/-/merge_requests/12',
      state: 'opened', draft: false, description: 'hi',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
      author: { username: 'ann', avatarUrl: '/uploads/-/system/user/avatar/1/a.png' },
      labels: { nodes: [{ title: 'bug', color: '#D73A4A' }, { title: 'odd', color: 'red' }] },
      userNotesCount: 4, sourceBranch: 'feat/x', targetBranch: 'main',
      diffHeadSha: 'd013dd471daf6f6672ea035294ab4f01282f9c38', squashOnMerge: false, conflicts: false,
      diffStatsSummary: { additions: 10, deletions: 2, fileCount: 3 },
      detailedMergeStatus: 'CI_STILL_RUNNING',
      userPermissions: { canMerge: true },
      approvedBy: { nodes: [] },
      approved: false, approvalsLeft: 1, approvalsRequired: 1,
      headPipeline: { status: 'RUNNING', jobs: { nodes: [
        { id: 'gid://gitlab/Ci::Build/501', name: 'lint', status: 'SUCCESS', webPath: '/team/sub/app/-/jobs/501', allowFailure: false, stage: { name: 'test' } },
        { id: 'gid://gitlab/Ci::Build/502', name: 'e2e', status: 'FAILED', webPath: null, allowFailure: true, stage: { name: 'test' } },
        { id: 'gid://gitlab/Ci::Build/503', name: 'deploy', status: 'MANUAL', allowFailure: false, stage: { name: 'deploy' } },
        { id: 'gid://gitlab/Ci::Build/504', name: 'build', status: 'RUNNING', webPath: '/team/sub/app/-/jobs/504', allowFailure: false, stage: null },
      ] } },
    },
  } } })

  it('reads a merge request', () => {
    const item = glDetailFromJson(mrJson(), target('either'))
    expect([item.provider, item.kind, item.state, item.number]).toEqual(['gitlab', 'pr', 'open', 12])
    expect([item.host, item.owner, item.repo]).toEqual(['git.corp.io', 'team/sub', 'app'])
    expect(item.url).toBe('https://git.corp.io/team/sub/app/-/merge_requests/12')
    expect(item.author).toEqual({ login: 'ann', avatarUrl: null })
    expect(item.body).toBe('hi')
    expect(item.labels).toEqual([{ name: 'bug', color: 'd73a4a' }, { name: 'odd', color: '' }])
    expect(item.comments).toBe(4)
    expect([item.headRef, item.baseRef]).toEqual(['feat/x', 'main'])
    expect([item.additions, item.deletions, item.changedFiles]).toEqual([10, 2, 3])
    expect(item.reviewDecision).toBe('review_required')
    expect(item.checks).toBe('pending')
    expect(item.checkRuns.map(c => [c.name, c.state, c.required, c.workflow])).toEqual([
      ['lint', 'success', true, 'test'], ['e2e', 'failure', false, 'test'], ['deploy', 'neutral', true, 'deploy'], ['build', 'pending', true, null],
    ])
    expect(item.checkRuns[0]!.url).toBe('https://git.corp.io/team/sub/app/-/jobs/501')
    expect(item.checkRuns[1]!.url).toBe('https://git.corp.io/team/sub/app/-/jobs/502')
    expect(item.headSha).toBe('d013dd471daf6f6672ea035294ab4f01282f9c38')
    expect([item.mergeable, item.mergeState]).toEqual(['mergeable', 'blocked'])
    expect(item.mergeMethods).toEqual(['merge', 'squash'])
    expect(item.defaultMergeMethod).toBe('squash')
    expect(item.canMerge).toBe(true)
    expect(parseGlJobUrl(item.checkRuns[0]!.url!).job).toBe(501)
  })

  it('reads merge request variants', () => {
    let v = mrJson()
    Object.assign(v.data.project.mergeRequest, { draft: true, conflicts: true, detailedMergeStatus: 'CONFLICT', approved: true, approvalsLeft: 0, userPermissions: { canMerge: false }, headPipeline: null })
    v.data.project.squashOption = { option: 'NEVER' }
    let item = glDetailFromJson(v, target('mr'))
    expect(item.state).toBe('draft')
    expect([item.mergeable, item.mergeState]).toEqual(['conflicting', 'dirty'])
    expect(item.reviewDecision).toBe('approved')
    expect(item.mergeMethods).toEqual(['merge'])
    expect(item.defaultMergeMethod).toBe('merge')
    expect(item.checks === null && item.checkRuns.length === 0 && !item.canMerge).toBe(true)

    v = mrJson()
    v.data.project.mergeRequest.state = 'merged'
    v.data.project.squashOption = { option: 'ALWAYS' }
    item = glDetailFromJson(v, target('mr'))
    expect(item.state).toBe('merged')
    expect(item.mergeMethods).toEqual(['squash'])
    expect(item.canMerge).toBe(false)

    v = mrJson()
    for (const k of ['approved', 'approvalsLeft', 'approvalsRequired']) delete v.data.project.mergeRequest[k]
    v.data.project.mergeRequest.detailedMergeStatus = 'MERGEABLE'
    delete v.data.project.squashOption
    item = glDetailFromJson(v, target('mr'))
    expect(item.reviewDecision).toBeNull()
    expect([item.mergeable, item.mergeState]).toEqual(['mergeable', 'clean'])
    expect(item.mergeMethods).toEqual(['merge', 'squash'])
  })

  it('maps merge statuses', () => {
    expect(mergeStatus('MERGEABLE', false)).toEqual(['mergeable', 'clean'])
    expect(mergeStatus('NEED_REBASE', false)).toEqual(['mergeable', 'behind'])
    expect(mergeStatus('DRAFT_STATUS', false)).toEqual(['mergeable', 'draft'])
    expect(mergeStatus('CHECKING', false)).toEqual(['unknown', 'unknown'])
    expect(mergeStatus('DISCUSSIONS_NOT_RESOLVED', false)).toEqual(['mergeable', 'blocked'])
    expect(mergeStatus('CI_MUST_PASS', false)).toEqual(['mergeable', 'blocked'])
    expect(mergeStatus('SOMETHING_NEW', true)).toEqual(['conflicting', 'dirty'])
  })

  it('reads an issue', () => {
    const v: any = { data: { project: { mergeRequest: null, issue: {
      iid: '5', title: 'Crash', webUrl: 'https://git.corp.io/team/sub/app/-/issues/5', state: 'closed',
      description: '', createdAt: '', updatedAt: '', author: null, userNotesCount: 2, labels: { nodes: [] }, closedAsDuplicateOf: null,
    } } } }
    let item = glDetailFromJson(v, target('either'))
    expect([item.kind, item.state, item.number, item.comments]).toEqual(['issue', 'closed', 5, 2])
    expect(item.stateReason).toBe('completed')
    expect(item.headRef === null && item.checks === null && item.mergeMethods.length === 0 && !item.canMerge).toBe(true)
    v.data.project.issue.closedAsDuplicateOf = { iid: '3' }
    expect(glDetailFromJson(v, target('issue')).stateReason).toBe('duplicate')
    v.data.project.issue.state = 'opened'
    item = glDetailFromJson(v, target('issue'))
    expect([item.state, item.stateReason]).toEqual(['open', null])
  })

  it('names what is missing', () => {
    const none = { data: { project: { mergeRequest: null, issue: null } } }
    expect(() => glDetailFromJson(none, target('either'))).toThrow('merge request or issue 12 in team/sub/app')
    expect(() => glDetailFromJson(none, target('mr'))).toThrow('!12')
    expect(() => glDetailFromJson({ data: { project: null } }, target('issue'))).toThrow('no project team/sub/app')
    expect(() => glDetailFromJson({ data: null, errors: [{ message: 'boom' }] }, target('issue'))).toThrow('GitLab: boom')
  })

  it('reads the list\'s title and state with a small query', () => {
    const argv = glStateArgv(target('mr'))
    expect(line(argv)).toContain('mergeRequest(iid: $iid) { title state draft }')
    expect(parseGlState(JSON.stringify({ data: { project: { mergeRequest: { title: 'A', state: 'opened', draft: true } } } }), target('mr')))
      .toEqual({ kind: 'pr', title: 'A', state: 'draft', stateReason: null })
    expect(parseGlState(JSON.stringify({ data: { project: { mergeRequest: { title: 'A', state: 'merged' } } } }), target('mr'))?.state).toBe('merged')
    expect(parseGlState(JSON.stringify({ data: { project: { issue: { title: 'B', state: 'closed' } } } }), target('issue')))
      .toEqual({ kind: 'issue', title: 'B', state: 'closed', stateReason: 'completed' })
    expect(parseGlState('nope', target('mr'))).toBeNull()
    expect(parseGlState(JSON.stringify({ data: { project: null } }), target('mr'))).toBeNull()
  })
})

describe('merging', () => {
  const sha = 'd013dd471daf6f6672ea035294ab4f01282f9c38'
  it('refuses bad merges before asking GitLab', () => {
    expect(() => glMergeArgv(target('mr'), 'rebase', sha)).toThrow(/rebasing/)
    expect(() => glMergeArgv(target('mr'), 'ff', sha)).toThrow(/not a merge method/)
    expect(() => glMergeArgv(target('mr'), 'merge', 'HEAD')).toThrow(/again/)
    expect(() => glMergeArgv(target('issue'), 'merge', sha)).toThrow(/issue/)
    expect(line(glMergeArgv(target('mr'), 'merge', sha))).toBe(`glab api --hostname git.corp.io projects/team%2Fsub%2Fapp/merge_requests/12/merge --method PUT -f sha=${sha}`)
  })

  it('explains refused merges', () => {
    const t = target('mr')
    expect(glMergeFailure('dev', t, 1, '{}', 'glab: 409 Conflict (HTTP 409)')).toMatch(/new commits/)
    expect(glMergeFailure('dev', t, 1, '{"message":"Branch cannot be merged"}', 'glab: 406 Not Acceptable (HTTP 406)')).toMatch(/GitLab says: Branch cannot be merged$/)
    expect(glMergeFailure('dev', t, 1, '{"message":"405 Method Not Allowed"}', 'glab: 405 Method Not Allowed (HTTP 405)')).toMatch(/will not merge it yet/)
    expect(glMergeFailure('dev', t, 1, '{"message":["SHA does not match HEAD"]}', '422 Unprocessable Entity')).toMatch(/GitLab says: SHA does not match HEAD$/)
    expect(glMergeFailure('dev', t, 1, '{}', 'glab: 403 Forbidden (HTTP 403)')).toMatch(/may not merge in team\/sub\/app/)
    expect(glMergeFailure('dev', t, 1, '', 'glab: 401 Unauthorized (HTTP 401)')).toMatch(/not signed in to git\.corp\.io/)
  })
})

describe('opening a merge request', () => {
  const f = forge('git.corp.io', 'team/sub', 'app')

  it('finds the merge request glab named', () => {
    const printed = '\nCreating merge request for feat/x into main in team/sub/app\n\n!12 feat: x (feat/x)\n https://git.corp.io/team/sub/app/-/merge_requests/12\n'
    expect(createdMr(printed, f, KNOWN)).toEqual(target('mr'))
    const exists = 'failed to create merge request: 409 Conflict {message: [Another open merge request already exists for this source branch: !7]}'
    expect(createdMr(exists, f, KNOWN)?.iid).toBe(7)
    expect(createdMr('Creating merge request for feat/x into main\n', f, KNOWN)).toBeNull()
    expect(createdMr('https://evil.example.com/a/b/-/merge_requests/3', f, KNOWN)).toBeNull()
    expect(createdMr('https://gitlab.com/a/b/-/issues/3', f, KNOWN)).toBeNull()
  })

  it('reads the branch and its commits in the folder, then posts raw fields', () => {
    expect(line(glMrDetailsArgv(f, 'main'))).toContain(' mango-mr main git.corp.io projects/team%2Fsub%2Fapp')
    expect(glMrDetailsArgv(f, null)[4]).toBe('')
    expect(() => glMrDetailsArgv(f, '-x')).toThrow()
    expect(MR_DETAILS).toContain('refs/remotes/origin/HEAD')
    expect(parseMrDetails('MANGO-BRANCH:feat/x\nMANGO-BASE:main\nfeat: x\x1fbody\x1e\n', null)).toEqual({ branch: 'feat/x', base: 'main', title: 'feat: x', body: 'body' })
    expect(() => parseMrDetails('MANGO-BRANCH:feat/x\nMANGO-BASE:main\n', null)).toThrow(/no commits that main/)
    expect(() => parseMrDetails('MANGO-BRANCH:feat/x\nMANGO-BASE:\n', null)).toThrow(/default branch/)
    expect(() => parseMrDetails('MANGO-BRANCH:feat/x\nMANGO-BASE:-x\na\x1f\x1e', null)).toThrow()
    const argv = glMrPostArgv(f, { branch: 'feat/x', base: 'main', title: '@x', body: 'b' })
    expect(line(argv)).toBe("glab api --hostname git.corp.io projects/team%2Fsub%2Fapp/merge_requests --method POST -f source_branch=feat/x -f target_branch=main -f title=@x -f description=b")
    expect(argv).not.toContain('-F')
    expect(postedIid('{"iid":12,"id":99}')).toBe(12)
    expect(postedIid('nope')).toBeNull()
    expect(mrPostFailure('dev', 'git.corp.io', 'feat/x', 1, 'glab: 404 Not Found', '{"message":"404 Source branch Not Found"}')).toMatch(/feat\/x is not on GitLab yet/)
  })

  it('titles it from the commits as the desktop does', () => {
    expect(prText('feat/x', '')).toBeNull()
    expect(prText('feat/x', 'one\x1fwhy\x1e')).toEqual(['one', 'why'])
    expect(prText('feat/add-thing_now', '\none\x1f\x1e\ntwo\x1fb\x1e')).toEqual(['Add thing now', '- one\n- two'])
  })
})

describe('jobs', () => {
  it('parses job links', () => {
    const t = parseGlJobUrl('https://gitlab.com/group/sub/proj/-/jobs/8123456789?foo=1')
    expect([t.forge.host, `${t.forge.owner}/${t.forge.repo}`, t.job]).toEqual(['gitlab.com', 'group/sub/proj', 8123456789])
    for (const bad of [
      '', 'https://gitlab.com/g/p/-/jobs/', 'https://gitlab.com/g/p/-/jobs/x', 'https://gitlab.com/g/p/-/jobs/0', 'https://gitlab.com/g/p/-/pipelines/1',
      'https://gitlab.com/p/-/jobs/1', 'https://gitlab.com/../p/-/jobs/1', 'https://gitlab.com/g/.p/-/jobs/1', 'ftp://gitlab.com/g/p/-/jobs/1',
    ]) expect(() => parseGlJobUrl(bad), bad).toThrow()
    const [job, trace] = glJobArgvs(t)
    expect(job).toEqual(['glab', 'api', '--hostname', 'gitlab.com', 'projects/group%2Fsub%2Fproj/jobs/8123456789'])
    expect(trace[4]).toBe('projects/group%2Fsub%2Fproj/jobs/8123456789/trace')
  })

  it('maps job states', () => {
    expect(glRunState('running')).toBe('pending')
    expect(glRunState('created')).toBe('queued')
    expect(glRunState('waiting_for_resource')).toBe('queued')
    expect(glRunState('success')).toBe('success')
    expect(glRunState('failed')).toBe('failure')
    expect(glRunState('canceled')).toBe('cancelled')
    expect(glRunState('skipped')).toBe('skipped')
    expect(glRunState('manual')).toBe('neutral')
    const job = glJobFromJson({ id: 9, name: 'test', stage: 'test', status: 'failed', web_url: 'https://gitlab.com/g/p/-/jobs/9', started_at: '2026-11-16T20:29:33.000Z', finished_at: null }, 'https://gitlab.com/g/p/-/jobs/9')
    expect([job.provider, job.id, job.state, job.workflow, job.startedAt]).toEqual(['gitlab', 9, 'failure', 'test', '2026-11-16T20:29:33.000Z'])
  })

  it('writes epoch seconds as ISO', () => {
    expect(isoFromEpoch(0)).toBe('1970-01-01T00:00:00Z')
    expect(isoFromEpoch(epochSeconds('2026-11-16T20:29:33Z')!)).toBe('2026-11-16T20:29:33Z')
    expect(isoFromEpoch(epochSeconds('2024-02-29T23:59:59Z')!)).toBe('2024-02-29T23:59:59Z')
  })

  const E = '\x1b[0K'
  const trace = () => [
    '\x1b[0KRunning with gitlab-runner 17.5.0 (abc)\x1b[0;m',
    '  on runner-1 xyz',
    `section_start:1763324973:prepare_executor\r${E}${E}\x1b[36;1mPreparing the "docker" executor\x1b[0;m`,
    'Using Docker executor with image node:24 ...',
    `section_end:1763324975:prepare_executor\r${E}section_start:1763324975:get_sources\r${E}${E}\x1b[36;1mGetting source from Git repository\x1b[0;m`,
    'Fetching changes with git depth set to 20...',
    `section_end:1763324976:get_sources\r${E}`,
    `section_start:1763324976:step_script\r${E}${E}\x1b[36;1mExecuting "step_script" stage of the job script\x1b[0;m`,
    '\x1b[32;1m$ pnpm install\x1b[0;m',
    `section_start:1763324977:deps[collapsed=true]\r${E}Install dependencies`,
    'progress 10%\rprogress 50%\rprogress 100%',
    `section_end:1763324979:deps\r${E}`,
    '',
    '\x1b[31mFAIL\x1b[0m one test',
    `section_end:1763324980:step_script\r${E}`,
    `section_start:1763324980:cleanup_file_variables\r${E}${E}\x1b[36;1mCleaning up project directory and file based variables\x1b[0;m`,
    `section_end:1763324981:cleanup_file_variables\r${E}`,
    '\x1b[31;1mERROR: Job failed: exit code 1',
    '\x1b[0;m',
  ].join('\n')

  it('splits a trace into sections', () => {
    const steps = splitTrace(trace(), 'failure')
    expect(steps.map(s => [s.number, s.name, s.state])).toEqual([
      [1, 'Runner', 'success'],
      [2, 'Preparing the "docker" executor', 'success'],
      [3, 'Getting source from Git repository', 'success'],
      [4, 'Executing "step_script" stage of the job script', 'failure'],
      [5, 'Cleaning up project directory and file based variables', 'success'],
      [6, 'Result', 'failure'],
    ])
    expect(steps[0]!.lines).toEqual(['Running with gitlab-runner 17.5.0 (abc)\x1b[0;m', '  on runner-1 xyz'])
    expect(steps[1]!.lines).toEqual(['Using Docker executor with image node:24 ...'])
    expect(steps[1]!.startedAt).toBe(isoFromEpoch(1763324973))
    expect(steps[1]!.completedAt).toBe(isoFromEpoch(1763324975))
    expect(steps[3]!.lines).toEqual(['\x1b[32;1m$ pnpm install\x1b[0;m', '##[group]Install dependencies', 'progress 100%', '##[endgroup]', '', '\x1b[31mFAIL\x1b[0m one test'])
    expect(steps[4]!.lines).toEqual([])
    expect(steps[5]!.lines).toEqual(['\x1b[31;1mERROR: Job failed: exit code 1', '\x1b[0;m'])
    expect(steps.every(s => s.lines.every(l => !l.includes('section_') && !l.includes('\r')))).toBe(true)
    expect(splitTrace(trace(), 'success').every(s => s.state === 'success')).toBe(true)
  })

  it('reads a running trace and timestamped lines', () => {
    const log = [
      '2026-11-16T20:29:33.100000Z 00O Running with gitlab-runner 17.5.0',
      `2026-11-16T20:29:33.200000Z 00O section_start:1763324973:step_script\r${E}Executing script`,
      '2026-11-16T20:29:34.000000Z 01E half a ',
      '2026-11-16T20:29:34.100000Z 01E+line',
      '2026-11-16T20:29:35.000000Z 00O still going',
    ].join('\n')
    const steps = splitTrace(log, 'pending')
    expect(steps.map(s => [s.name, s.state])).toEqual([['Runner', 'success'], ['Executing script', 'pending']])
    expect(steps[1]!.lines).toEqual(['half a line', 'still going'])
    expect(steps[1]!.completedAt).toBeNull()
    expect(splitTrace(log, 'cancelled')[1]!.state).toBe('cancelled')
    expect(splitTrace('', 'success')).toEqual([])
  })

  it('ignores what only looks like a marker', () => {
    const steps = splitTrace('echo section_start:abc:x\nsection_end:1:not ours\r\x1b[0K\n', 'success')
    expect(steps).toHaveLength(1)
    expect(steps[0]!.lines).toEqual(['echo section_start:abc:x', 'section_end:1:not ours'])
  })

  it('keeps the end of a long section', () => {
    let log = `section_start:1:s\r${E}S\n`
    for (let i = 0; i < STEP_LINES + 3; i++) log += `line ${i}\n`
    log += `section_end:2:s\r${E}\n`
    const steps = splitTrace(log, 'success')
    expect([steps[0]!.omitted, steps[0]!.lines.length]).toEqual([3, STEP_LINES])
    expect(steps[0]!.lines[0]).toBe('line 3')
  })
})
