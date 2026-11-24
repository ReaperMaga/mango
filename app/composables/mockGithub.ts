import type { GhCheck, GhItem, GhJob, GhJobStep, GhListItem, GhMergeMethod, GhOpenItems, GhRepoLink, GhRunState, GitStatus } from '~/types/ipc'
import { baseName } from '~/utils/paths'

/**
 * `gh_item` for the browser preview: GitHub cannot be asked from here, so any pull request or
 * issue comes back made up (and says so in its description), consistently per number.
 */

/** A drawn stand-in for a screenshot, so the preview shows how pictures in a description look. */
const PICTURE = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
<rect width="640" height="300" rx="10" fill="#1c2421"/>
<rect x="0" y="0" width="150" height="300" rx="10" fill="#151b19"/>
<rect x="18" y="24" width="96" height="10" rx="5" fill="#3a4642"/>
<rect x="18" y="50" width="112" height="22" rx="6" fill="#26302d"/>
<circle cx="30" cy="61" r="5" fill="#f0a640"/>
<rect x="42" y="57" width="70" height="8" rx="4" fill="#9aa7a2"/>
<rect x="18" y="80" width="112" height="22" rx="6" fill="none"/>
<circle cx="30" cy="91" r="5" fill="none" stroke="#7fb069" stroke-width="2"/>
<rect x="42" y="87" width="56" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="28" width="300" height="12" rx="6" fill="#d8e0dc"/>
<rect x="176" y="54" width="420" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="70" width="380" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="100" width="420" height="120" rx="8" fill="#121816"/>
<rect x="194" y="120" width="180" height="8" rx="4" fill="#7fb069"/>
<rect x="194" y="138" width="240" height="8" rx="4" fill="#e06c5f"/>
<rect x="194" y="156" width="210" height="8" rx="4" fill="#7fb069"/>
<rect x="194" y="174" width="150" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="244" width="420" height="34" rx="10" fill="#26302d"/>
<rect x="560" y="251" width="24" height="20" rx="5" fill="#f0a640"/>
</svg>`)}`

function parse(path: string, reference: string) {
  const ref = reference.trim()
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(pull|pulls|issues)\/(\d+)/i.exec(ref)
  const short = /^(?:([\w.-]+)\/([\w.-]+))?#?(\d+)$/.exec(ref)
  if (!url && !short) throw new Error('Paste a pull request or issue link (https://github.com/owner/repo/pull/12) or its number (#12).')
  const host = url ? url[1]!.toLowerCase() : 'github.com'
  const owner = url?.[2] ?? short?.[1] ?? 'you'
  const repo = url?.[3] ?? short?.[2] ?? baseName(path || 'project')
  const number = Number(url?.[5] ?? short?.[3])
  // Even numbers are pull requests, odd ones issues, unless the link says which.
  const isPr = url ? url[4]!.toLowerCase() !== 'issues' || number % 2 === 0 : number % 2 === 0
  return { host, owner, repo, number, isPr, key: `${host}/${owner}/${repo}#${number}` }
}

/** When each pull request was first read: its checks finish one after another from then on. */
const firstRead = new Map<string, number>()
/** Pull requests merged in this session. */
const mergedHere = new Set<string>()
const HEAD = 'd013dd471daf6f6672ea035294ab4f01282f9c38'

/** Three CI jobs that pass one by one; on pull requests other than #42 the Windows one fails. */
function mockChecks(key: string, owner: string, repo: string, number: number, done: boolean): GhCheck[] {
  const since = done ? Infinity : Date.now() - (firstRead.get(key) ?? Date.now())
  const run = `https://github.com/${owner}/${repo}/actions/runs/4386139`
  const job = (name: string, after: number, fails = false, required = false): GhCheck => {
    const url = `${run}/job/${name.length}`
    jobs.set(url, { name, after, fails, key, done })
    return {
      name, workflow: 'CI', required, description: null, url,
      state: since < after ? 'pending' : fails ? 'failure' : 'success',
    }
  }
  return [
    job('Frontend', 8_000, false, true),
    job('Backend (Linux)', 18_000),
    job('Backend (Windows)', 30_000, number !== 42),
  ]
}

/** The jobs `mockChecks` made up, by link, so `gh_job` tells the same story. */
const jobs = new Map<string, { name: string; after: number; fails: boolean; key: string; done: boolean }>()

/**
 * A job made up elsewhere (the mock releases' workflow runs): it starts at `startedAt` and ends
 * `after` ms later, failing if `fails`, so `gh_job` shows the same steps and log.
 */
export function registerMockJob(url: string, name: string, startedAt: number, after: number, fails: boolean) {
  jobs.set(url, { name, after, fails, key: url, done: false })
  firstRead.set(url, startedAt)
}

/** The same job under another link (a GitLab job page for a GitHub mock's job). */
export function aliasMockJob(from: string, to: string) {
  const known = jobs.get(from)
  if (known) jobs.set(to, known)
}

const ESC = '\x1b'
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`
const green = (s: string) => `${ESC}[32m${s}${ESC}[0m`
const cargo = (verb: string, rest: string) => `${ESC}[1m${ESC}[32m${verb.padStart(12)}${ESC}[0m ${rest}`
const cmd = (s: string) => `${ESC}[36;1m${s}${ESC}[0m`

/** A job's steps and what each prints (its share of the job's time, then its lines). */
function mockSteps(name: string, fails: boolean): { name: string; share: number; lines: string[] }[] {
  const frontend = name === 'Frontend'
  const linux = frontend || name.includes('Linux')
  const run = frontend ? 'pnpm vue-tsc --noEmit -p .nuxt/tsconfig.app.json' : 'cargo test --locked'
  const passed = Array.from({ length: 36 }, (_, i) => `test suite::case_${String(i + 1).padStart(2, '0')} ... ok`)
  const result = frontend
    ? ['', '> mango@0.1.8 typecheck', '> vue-tsc --noEmit', '', `${green('✓')} 214 files checked`]
    : [
        cargo('Compiling', `mango v0.1.8 (${linux ? '/home/runner/work/mango/mango/src-tauri' : 'D:\\a\\mango\\mango\\src-tauri'})`),
        cargo('Finished', '`test` profile [unoptimized + debuginfo] target(s) in 2m 41s'),
        cargo('Running', 'unittests src/lib.rs'),
        '',
        'running 126 tests',
        ...passed.slice(0, fails ? 12 : 36),
        ...(fails
          ? [
              `test pty::tests::spawns_the_default_shell ... ${red('FAILED')}`,
              '',
              'failures:',
              '',
              '---- pty::tests::spawns_the_default_shell stdout ----',
              "thread 'pty::tests::spawns_the_default_shell' panicked at src\\pty.rs:412:9:",
              'assertion `left == right` failed: the shell did not echo',
              '  left: ""',
              ' right: "hello"',
              '',
              `test result: ${red('FAILED')}. 125 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.81s`,
              '',
              '##[error]Process completed with exit code 101.',
            ]
          : ['', `test result: ${green('ok')}. 126 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.94s`]),
      ]
  return [
    { name: 'Set up job', share: 0.08, lines: [
      "Current runner version: '2.338.2'",
      '##[group]Operating System',
      linux ? 'Ubuntu' : 'Microsoft Windows Server 2025',
      linux ? '24.04.3' : '10.0.26100',
      '##[endgroup]',
      '##[group]GITHUB_TOKEN Permissions',
      'Contents: read',
      'Metadata: read',
      '##[endgroup]',
      'Secret source: Actions',
      'Prepare workflow directory',
      'Prepare all required actions',
      "Download action repository 'actions/checkout@v5' (SHA:3d3c42e5aac5ba805825da76410c181273ba90b1)",
      `Complete job name: ${name}`,
    ] },
    { name: 'Run actions/checkout@v5', share: 0.07, lines: [
      '##[group]Run actions/checkout@v5',
      'with:',
      '  repository: you/mango',
      '  fetch-depth: 1',
      '##[endgroup]',
      'Syncing repository: you/mango',
      '##[group]Fetching the repository',
      '[command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +d013dd47:refs/remotes/pull/42/merge',
      ' * [new ref]         d013dd47 -> pull/42/merge',
      '##[endgroup]',
      '[command]/usr/bin/git log -1 --format=%H',
      'd013dd471daf6f6672ea035294ab4f01282f9c38',
    ] },
    { name: frontend ? 'Install dependencies' : 'Set up Rust', share: 0.25, lines: frontend
      ? ['##[group]Run pnpm install --frozen-lockfile', cmd('pnpm install --frozen-lockfile'), '##[endgroup]',
          'Lockfile is up to date, resolution step is skipped', 'Packages: +812',
          'Progress: resolved 812, reused 812, downloaded 0, added 812, done',
          '##[warning]Node.js 20 actions are deprecated. Update actions/setup-node to v5.']
      : ['##[group]Run dtolnay/rust-toolchain@stable', 'with:', '  toolchain: stable', '##[endgroup]',
          '[command]rustup toolchain install stable --profile minimal', 'info: syncing channel updates', 'stable unchanged - rustc 1.93.0'] },
    { name: frontend ? 'Typecheck' : 'Test', share: 0.5, lines: [`##[group]Run ${run}`, cmd(run), '##[endgroup]', ...result] },
    { name: 'Post Run actions/checkout@v5', share: 0.05, lines: ['Post job cleanup.', '[command]/usr/bin/git version', 'git version 2.53.0'] },
    { name: 'Complete job', share: 0.05, lines: ['Cleaning up orphan processes'] },
  ]
}

/** `gh_job` for the browser preview: the job's steps finish one after another, then its log shows. */
export function mockGhJob(url: string): GhJob {
  const known = jobs.get(url)
  if (!known) throw new Error('That check is not a GitHub Actions job, so Mango cannot show its log. Open it on GitHub instead.')
  const { name, after, fails, key, done } = known
  const start = done ? Date.now() - after - 60_000 : (firstRead.get(key) ?? Date.now())
  const elapsed = Date.now() - start
  const plan = mockSteps(name, fails)
  const iso = (ms: number) => new Date(start + ms).toISOString()
  const failing = fails ? 3 : -1
  let at = 0
  const steps: GhJobStep[] = plan.map((p, i) => {
    const from = at
    const to = (at += p.share * after)
    // After a failed step the rest is skipped, except clean-up.
    const skipped = failing >= 0 && i > failing && i < plan.length - 2
    const state: GhRunState = elapsed < from ? 'queued' : elapsed < to ? 'pending'
      : skipped ? 'skipped' : i === failing ? 'failure' : 'success'
    return {
      number: i + 1, name: p.name, state,
      startedAt: elapsed >= from ? iso(from) : null, completedAt: elapsed >= to ? iso(to) : null,
      lines: [], omitted: 0,
    }
  })
  const finished = elapsed >= after
  // A GitLab job's log comes without GitHub's markers (GitLab's own sections are steps already) and with a progress bar redrawn by `\r`.
  const gitlab = isGitlabJob(url)
  const shown = (lines: string[]) => (gitlab
    ? [...lines.filter(l => !l.startsWith('##[endgroup]')).map(l => l.replace(/^##\[(?:group|warning|error)\]/, '')), 'Uploading artifacts... 10%\r\x1b[0KUploading artifacts... 100%']
    : lines)
  if (finished) plan.forEach((p, i) => { if (steps[i]!.state !== 'skipped') steps[i]!.lines = shown(p.lines) })
  return {
    provider: gitlab ? 'gitlab' : 'github',
    id: name.length, name, workflow: gitlab ? 'test' : 'CI', url,
    state: finished ? (fails ? 'failure' : 'success') : 'pending',
    startedAt: iso(0), completedAt: finished ? iso(after) : null,
    steps, logReady: finished, logError: null, logTruncated: false,
  }
}

export function mockGhMerge(path: string, reference: string, _method: GhMergeMethod, headSha: string) {
  if (isGitlabMock(path) || isGitlabRef(reference)) {
    const { key, kind } = glParse(path, reference)
    if (kind !== 'pr') throw new Error('GitLab refused the merge: issues cannot be merged.')
    if (mergedHere.has(key)) throw new Error('GitLab refused the merge: the merge request is already merged.')
    if (headSha !== HEAD) throw new Error('The branch got new commits since this was read. Look at them, then merge again.')
    mergedHere.add(key)
    return
  }
  const { key, isPr, number } = parse(path, reference)
  if (!isPr) throw new Error('GitHub refused the merge: issues cannot be merged.')
  if (mergedHere.has(key) || (number !== 42 && number % 3 === 0)) throw new Error('GitHub refused the merge: Pull Request is not mergeable')
  if (headSha !== HEAD) throw new Error('The branch got new commits since this was read. Look at them, then merge again.')
  mergedHere.add(key)
}

/** Pull requests opened in this session (`gh_pr_create`), by key: they read back with their own branch and title. */
const opened = new Map<string, { title: string; head: string; base: string }>()
/** Pull requests opened for a branch, by `owner/repo:branch`: opening again returns the same one. */
const openedFor = new Map<string, number>()
let nextNumber = 58

/** `gh_pr_create` for the browser preview: a made-up pull request from the folder's branch. */
export function mockGhPrCreate(path: string, base: string, status: GitStatus): GhItem {
  const branch = status.branch
  if (!branch) throw new Error('HEAD is detached, so there is no branch to open a pull request from. Switch to a branch first.')
  if (!status.upstream) throw new Error(`pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch (createPullRequest)\nPush ${branch} first.`)
  const repo = baseName(status.mainRoot ?? path)
  if (isGitlabMock(status.mainRoot ?? path)) {
    const number = glOpenedFor.get(branch) ?? (glNext += 1)
    glOpenedFor.set(branch, number)
    const words = (branch.split('/').pop() ?? branch).replace(/[-_]/g, ' ')
    glListed.set(`${GL_HOST}/${GL_OWNER}/${repo}!${number}`.toLowerCase(), { title: words.charAt(0).toUpperCase() + words.slice(1), draft: false, head: branch })
    return mockGhItem(status.mainRoot ?? path, `!${number}`)
  }
  const forKey = `you/${repo}:${branch}`
  const number = openedFor.get(forKey) ?? (nextNumber += 2)
  openedFor.set(forKey, number)
  const words = (branch.split('/').pop() ?? branch).replace(/[-_]/g, ' ')
  opened.set(`github.com/you/${repo}#${number}`, { title: words.charAt(0).toUpperCase() + words.slice(1), head: branch, base })
  return mockGhItem(path, `you/${repo}#${number}`)
}

/** What the browser preview's "open" list holds, by key, so an item linked from it reads back the same. */
const listed = new Map<string, { title: string; draft: boolean; head: string | null }>()

/* ---------- GitLab, for the preview's orchard-api project ---------- */

/** The preview's project on GitLab: orchard-api lives in a nested group on gitlab.com. */
const GL_HOST = 'gitlab.com'
const GL_OWNER = 'acme/backend'
export const isGitlabMock = (path: string) => baseName(path || '') === 'orchard-api'
const glBase = (repo: string) => `https://${GL_HOST}/${GL_OWNER}/${repo}`
/** A reference that only GitLab writes: a `/-/` link or a `!12` merge request. */
const isGitlabRef = (reference: string) => /\/-\/(?:merge_requests|issues|work_items)\/\d+/.test(reference) || /!\d+$/.test(reference.trim())
const isGitlabJob = (url: string) => url.includes('/-/jobs/')

/** Merge requests and issues counted apart, as GitLab does: !12 and #12 are both there. */
const GL_OPEN: Array<['pr' | 'issue', number, string, boolean, string | null, number]> = [
  ['pr', 14, 'feat(api): rate limits per token', false, 'feat/rate-limits', 0.4],
  ['issue', 14, 'Webhook retries pile up after an outage', false, null, 3],
  ['pr', 12, 'fix(db): close idle connections', true, 'fix/idle-connections', 9],
  ['issue', 12, 'Document the self-managed setup', false, null, 30],
  ['issue', 9, 'Health check reports ready before migrations finish', false, null, 70],
]
const glListed = new Map<string, { title: string; draft: boolean; head: string | null }>()
const glOpenedFor = new Map<string, number>()
let glNext = 20

function glParse(path: string, reference: string) {
  const ref = reference.trim()
  const url = /^https?:\/\/([^/]+)\/(.+)\/([^/]+)\/-\/(merge_requests|issues|work_items)\/(\d+)/i.exec(ref)
  const short = /^(?:(.+)\/([^/!#]+))?([#!]?)(\d+)$/.exec(ref)
  if (!url && !short) throw new Error('Paste a merge request or issue link (https://gitlab.com/group/project/-/merge_requests/12), or its number (!12 for a merge request, #12 for an issue).')
  const host = url ? url[1]!.toLowerCase() : GL_HOST
  const owner = url?.[2] ?? short?.[1] ?? GL_OWNER
  const repo = url?.[3] ?? short?.[2] ?? baseName(path || 'project')
  const number = Number(url?.[5] ?? short?.[4])
  const kind: 'pr' | 'issue' = url ? (url[4]!.toLowerCase() === 'merge_requests' ? 'pr' : 'issue') : short?.[3] === '#' ? 'issue' : 'pr'
  return { host, owner, repo, number, kind, key: `${host}/${owner}/${repo}${kind === 'pr' ? '!' : '#'}${number}`.toLowerCase() }
}

/** A GitHub mock check's job, under a GitLab job link that tells the same story. */
function glJob(repo: string, url: string | null): string | null {
  if (!url) return null
  const id = /(\d+)$/.exec(url)?.[1] ?? '1'
  const to = `${glBase(repo)}/-/jobs/${4_810_000 + Number(id)}`
  const known = jobs.get(url)
  if (known) jobs.set(to, known)
  return to
}

function glItem(path: string, reference: string): GhItem {
  const { host, owner, repo, number, kind, key } = glParse(path, reference)
  // The GitHub preview's #42 (a pull request) and #41 (an issue) tell the story; GitLab's names go on top.
  const base = madeUpItem(path, kind === 'pr' ? `${GL_OWNER.replace('/', '-')}/${repo}#42` : `${GL_OWNER.replace('/', '-')}/${repo}#41`)
  const shown = glListed.get(key)
  const merged = mergedHere.has(key)
  const web = `https://${host}/${owner}/${repo}`
  const url = `${web}/-/${kind === 'pr' ? 'merge_requests' : 'issues'}/${number}`
  const state = kind === 'issue' ? 'open' : merged ? 'merged' : shown?.draft ? 'draft' : 'open'
  return {
    ...base,
    provider: 'gitlab', kind, url, host, owner, repo, number, state,
    title: shown?.title ?? base.title,
    headRef: kind === 'pr' ? shown?.head ?? base.headRef : null,
    mergeable: state === 'open' || state === 'draft' ? base.mergeable : null,
    mergeState: state === 'draft' ? 'draft' : state === 'open' ? base.mergeState : null,
    reviewDecision: kind === 'pr' ? 'review_required' : null,
    checkRuns: base.checkRuns.map(c => ({ ...c, workflow: c.required ? 'build' : 'test', url: glJob(repo, c.url) })),
    mergeMethods: kind === 'pr' ? ['merge', 'squash'] : [],
    defaultMergeMethod: kind === 'pr' ? 'merge' : null,
    bodyHtml: kind === 'pr'
      ? `<h2>What changes</h2>
<ul>
<li>Each API token gets its own bucket, refilled every minute</li>
<li>Requests over the limit get <code>429</code> with a <code>Retry-After</code> header</li>
</ul>
<p>Closes <a href="/${owner}/${repo}/-/issues/14" data-reference-type="issue">#14</a>.</p>
<p><a href="/${owner}/${repo}/uploads/limits.png"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" data-src="${PICTURE}" alt="Requests per token, before and after" class="lazy"></a></p>
<p><em>Simulated: the browser preview cannot ask GitLab. Inside the Mango app this is read with the GitLab CLI.</em></p>`
      : `<p>After a webhook endpoint is down for a while, every retry fires at once when it comes back.</p>
<p>Related to <a href="/${owner}/${repo}/-/merge_requests/14">!14</a>.</p>
<p><em>Simulated: the browser preview cannot ask GitLab.</em></p>`,
  }
}

/** `gh_repo_link` for the browser preview: orchard-api is on gitlab.com, every other project on github.com under the same made-up owner as `mockGhOpenItems`. */
export function mockGhRepoLink(path: string): GhRepoLink {
  if (isGitlabMock(path)) return { provider: 'gitlab', host: GL_HOST, owner: GL_OWNER, repo: baseName(path) }
  return { provider: 'github', host: 'github.com', owner: 'you', repo: baseName(path || 'project') }
}

/** `gh_open_items` for the browser preview: a few made-up open pull requests (even numbers) and issues (odd). */
export function mockGhOpenItems(path: string): GhOpenItems {
  if (isGitlabMock(path)) {
    const repo = baseName(path)
    const items: GhListItem[] = GL_OPEN.map(([kind, number, title, draft, head, ago]) => {
      glListed.set(`${GL_HOST}/${GL_OWNER}/${repo}${kind === 'pr' ? '!' : '#'}${number}`.toLowerCase(), { title, draft, head })
      return {
        kind, number, title, state: draft ? 'draft' : 'open', headRef: head, author: 'you',
        url: `${glBase(repo)}/-/${kind === 'pr' ? 'merge_requests' : 'issues'}/${number}`,
        updatedAt: new Date(Date.now() - ago * 3_600_000).toISOString(),
      }
    })
    return { provider: 'gitlab', host: GL_HOST, owner: GL_OWNER, repo, items }
  }
  const owner = 'you'
  const repo = baseName(path || 'project')
  const hour = 3_600_000
  const made: Array<[number, string, boolean, string | null, number]> = [
    [64, 'feat(links): pick a pull request to link from the open ones', false, 'feat/links-picker', 0.3],
    [61, 'Settings crashes when an env file is empty', false, null, 2],
    [58, 'fix(git): keep the branch popup inside the window', true, 'fix/branch-popup', 5],
    [55, 'Terminal loses focus after a dialog closes', false, null, 20],
    [52, 'perf(files): read big folders in pages', false, 'perf/files-pages', 30],
    [49, 'Voice input stops after a minute on Windows', false, null, 72],
    [46, 'docs: explain remote environments in the README', true, 'docs/remote-envs', 120],
  ]
  const items: GhListItem[] = made.map(([number, title, draft, head, ago]) => {
    const kind = number % 2 === 0 ? 'pr' : 'issue'
    listed.set(`github.com/${owner}/${repo}#${number}`, { title, draft, head })
    return {
      kind, number, title, state: draft ? 'draft' : 'open', headRef: head, author: 'you',
      url: `https://github.com/${owner}/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
      updatedAt: new Date(Date.now() - ago * hour).toISOString(),
    }
  })
  return { provider: 'github', host: 'github.com', owner, repo, items }
}

export function mockGhItem(path: string, reference: string): GhItem {
  if (isGitlabMock(path) || isGitlabRef(reference)) return glItem(path, reference)
  const item = madeUpItem(path, reference)
  const shown = listed.get(parse(path, reference).key)
  if (!shown) return item
  if (item.kind !== 'pr') return { ...item, title: shown.title }
  if (item.state === 'merged') return { ...item, title: shown.title, headRef: shown.head }
  return { ...item, title: shown.title, headRef: shown.head, state: shown.draft ? 'draft' : 'open', mergeState: shown.draft ? 'draft' : item.mergeState }
}

function madeUpItem(path: string, reference: string): GhItem {
  const { host, owner, repo, number, isPr, key } = parse(path, reference)
  const mine = opened.get(key)
  if (mine) {
    const item = mockGhItem(path, `${owner}/${repo}#42`)
    return { ...item, url: `https://${host}/${owner}/${repo}/pull/${number}`, number, title: mine.title, headRef: mine.head, baseRef: mine.base, state: 'open', checkRuns: [], checks: null, mergeState: 'clean', reviewDecision: null, comments: 0, createdAt: new Date().toISOString(), bodyHtml: '<p><em>Simulated: the browser preview cannot ask GitHub. Inside the Mango app this pull request is opened with the GitHub CLI.</em></p>' }
  }
  const now = Date.now()
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString()

  if (isPr) {
    if (!firstRead.has(key)) firstRead.set(key, now)
    const state = mergedHere.has(key) || (number !== 42 && number % 3 === 0) ? 'merged' : 'open'
    const checkRuns = mockChecks(key, owner, repo, number, state === 'merged')
    const checks = checkRuns.some(c => c.state === 'failure') ? 'failure'
      : checkRuns.some(c => c.state === 'pending') ? 'pending' : 'success'
    return {
      provider: 'github',
      kind: 'pr', url: `https://${host}/${owner}/${repo}/pull/${number}`, host, owner, repo, number,
      title: number === 42 ? 'fix(chat): keep the pane when its tab closes' : 'feat(git): show ahead and behind counts in the branch popup',
      // The one the simulated agent just opened is open; others vary so the list shows a few states.
      state, stateReason: null,
      author: { login: 'you', avatarUrl: null },
      createdAt: at(0.2), updatedAt: at(0.1),
      bodyHtml: `<h2>Why</h2>
<p>Closing the last tab of a split left its pane blank, and a message sent there had nowhere to go.</p>
<h2>What changes</h2>
<ul>
<li><code>closeTab</code> returns early for unknown ids</li>
<li>Panes that showed the closed chat fall back to the neighbouring tab of the same project</li>
<li>An empty second pane closes instead of staying blank</li>
</ul>
<p><a href="https://github.com/${owner}/${repo}/pull/${number}"><img src="${PICTURE}" alt="The split view after closing a tab"></a></p>
<h2>Testing</h2>
<ul>
<li><input type="checkbox" checked disabled> Typecheck</li>
<li><input type="checkbox" checked disabled> <code>cargo test</code></li>
<li><input type="checkbox" disabled> Tried on Windows</li>
</ul>
<p><em>Simulated: the browser preview cannot ask GitHub. Inside the Mango app this is read with the GitHub CLI.</em></p>`,
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'chat', color: '0e8a16' }],
      comments: 2,
      headRef: number === 42 ? 'fix/pane-fallback' : 'feat/branch-counts', baseRef: 'main',
      additions: 38, deletions: 11, changedFiles: 3,
      reviewDecision: 'review_required', checks, checkRuns, headSha: HEAD,
      mergeable: state === 'open' ? 'mergeable' : null,
      mergeState: state !== 'open' ? null : checks === 'success' ? 'clean' : 'unstable',
      mergeMethods: ['merge', 'squash', 'rebase'], defaultMergeMethod: 'squash', canMerge: true,
    }
  }
  return {
    provider: 'github',
    kind: 'issue', url: `https://${host}/${owner}/${repo}/issues/${number}`, host, owner, repo, number,
    title: 'Closing the last tab leaves a blank pane',
    state: 'open', stateReason: null,
    author: { login: 'you', avatarUrl: null },
    createdAt: at(26), updatedAt: at(3),
    bodyHtml: `<p>With two chats split side by side, closing the right one's last tab leaves an empty pane.</p>
<h3>Steps</h3>
<ol><li>Split the chat view</li><li>Close the tab in the right pane</li></ol>
<blockquote><p>Expected: the pane closes or shows the next chat.</p></blockquote>
<p><em>Simulated: the browser preview cannot ask GitHub.</em></p>`,
    labels: [{ name: 'bug', color: 'd73a4a' }],
    comments: 0,
    headRef: null, baseRef: null, additions: null, deletions: null, changedFiles: null, reviewDecision: null, checks: null,
    checkRuns: [], headSha: null, mergeable: null, mergeState: null, mergeMethods: [], defaultMergeMethod: null, canMerge: false,
  }
}
