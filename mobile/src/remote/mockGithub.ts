import type { GhJob } from '~/types/ipc'
import {
  GITHUB_HOST, checkedTarget, jobFromJson, mergeFailure, parseJobUrl, splitLog,
  type GhDetail, type GhState, type GhTarget,
} from './github'

/**
 * What the preview's "GitHub" knows: the pull requests and issues the mock chats link to, in
 * full, with their checks and the GitHub Actions jobs behind them. Made up, and the descriptions
 * say so. `createMockGithub` keeps one backend's changes (a merge, a pull request it opened).
 */

const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const ago = (h: number) => iso(Date.now() - h * HOUR)
/** A log line's timestamp, with the seven fraction digits the runner prints. */
const stamp = (ms: number) => new Date(ms).toISOString().replace('Z', '0000Z')

const SIMULATED = '_Simulated: the preview cannot ask GitHub. In the app this is read with the GitHub CLI inside the environment._'

/** The commit #134's branch points at (`ghMerge` checks it, as GitHub does). */
export const MOCK_HEAD_134 = '5be1c2f0a9d84e3b7c6f1a2d3e4b5c6d7e8f9a0b'

const job = (owner: string, repo: string, run: number, id: number) => `https://github.com/${owner}/${repo}/actions/runs/${run}/job/${id}`

const BASE: Omit<GhDetail, 'kind' | 'owner' | 'repo' | 'number' | 'url' | 'title' | 'state' | 'body'> = {
  host: GITHUB_HOST,
  stateReason: null,
  author: { login: 'ana-dev', avatarUrl: null },
  createdAt: '',
  updatedAt: '',
  labels: [],
  comments: 0,
  headRef: null, baseRef: null, additions: null, deletions: null, changedFiles: null, reviewDecision: null,
  checks: null, checkRuns: [], headSha: null, mergeable: null, mergeState: null, mergeMethods: [], defaultMergeMethod: null, canMerge: false,
}

function items(): GhDetail[] {
  return [
    {
      ...BASE,
      kind: 'pr', owner: 'acme', repo: 'shop-api', number: 128, url: 'https://github.com/acme/shop-api/pull/128',
      title: 'Refund endpoint with idempotency keys',
      state: 'merged',
      createdAt: ago(30), updatedAt: ago(3),
      body: `## Why

A client that retries \`POST /orders/:id/refund\` after a timeout could refund the same order twice (#97).

## What changes

- New \`idempotent()\` middleware: the first answer is stored under its \`Idempotency-Key\` for 24 hours, and a retry gets it back.
- Two requests racing with the same key: the second gets **409** instead of a second refund.
- Migration \`0014_idempotency_keys.sql\` with a unique index on \`(key, route)\`.

\`\`\`ts
router.post('/orders/:id/refund', idempotent(), async (req, res) => {
  res.json(await refund(await orders.get(req.params.id)))
})
\`\`\`

## Testing

1. \`pnpm test routes/orders\`: 18 passed, three of them new.
2. Retried by hand with \`curl\` and the same key: one refund.

Closes #97. Background: [Stripe on idempotent requests](https://docs.stripe.com/api/idempotent_requests).

${SIMULATED}`,
      labels: [{ name: 'feature', color: 'a2eeef' }, { name: 'payments', color: 'fbca04' }],
      comments: 3,
      headRef: 'feat/orders', baseRef: 'main', additions: 142, deletions: 9, changedFiles: 6,
      reviewDecision: 'approved', checks: 'success',
      checkRuns: [
        { name: 'Lint', workflow: 'CI', state: 'success', url: job('acme', 'shop-api', 18021334, 51002001), description: null, required: true },
        { name: 'Test (node 24)', workflow: 'CI', state: 'success', url: job('acme', 'shop-api', 18021334, 51002002), description: null, required: true },
        { name: 'codecov/patch', workflow: null, state: 'success', url: 'https://app.codecov.io/gh/acme/shop-api/pull/128', description: '96.1% of diff hit (target 80.0%)', required: false },
      ],
      headSha: '0c7d9e2b4a6f8e1d3c5b7a9f0e2d4c6b8a1f3e5d', mergeable: 'unknown', mergeState: 'unknown',
      mergeMethods: ['merge', 'squash', 'rebase'], defaultMergeMethod: 'squash', canMerge: true,
    },
    {
      ...BASE,
      kind: 'issue', owner: 'acme', repo: 'shop-api', number: 97, url: 'https://github.com/acme/shop-api/issues/97',
      title: 'Refunds can run twice when the client retries',
      state: 'closed', stateReason: 'completed',
      author: { login: 'jo-support', avatarUrl: null },
      createdAt: ago(24 * 9), updatedAt: ago(3),
      body: `### What happened

Order **#55120** was refunded twice. The mobile client timed out after 10 s and retried; both requests reached the payment provider.

### Steps

1. Slow the provider down (\`PROVIDER_DELAY_MS=12000\`)
2. Refund an order from the app
3. Watch the logs: two \`refund.created\` events

### Expected

One refund, whatever the client does.

${SIMULATED}`,
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'priority: high', color: 'b60205' }, { name: 'payments', color: 'fbca04' }],
      comments: 5,
    },
    {
      ...BASE,
      kind: 'issue', owner: 'acme', repo: 'shop-api', number: 131, url: 'https://github.com/acme/shop-api/issues/131',
      title: 'checkout.test.ts > reserves stock is flaky on CI',
      state: 'open',
      createdAt: ago(28), updatedAt: ago(4),
      body: `\`checkout.test.ts > reserves stock\` fails about one run in five on CI and never locally.

\`\`\`
AssertionError: expected 3 to be 2
  at test/checkout.test.ts:58:31
\`\`\`

- [x] Seen on \`main\`
- [ ] Seen on a branch without the stock changes

The last failure: [CI run 18020871](https://github.com/acme/shop-api/actions/runs/18020871).

${SIMULATED}`,
      labels: [{ name: 'flaky-test', color: 'e99695' }, { name: 'ci', color: '1d76db' }],
      comments: 1,
    },
    {
      ...BASE,
      kind: 'pr', owner: 'acme', repo: 'shop-api', number: 134, url: 'https://github.com/acme/shop-api/pull/134',
      title: 'Wait for the stock reservation before asserting in checkout tests',
      state: 'open',
      createdAt: ago(4), updatedAt: ago(0.3),
      body: `## Why

\`reserves stock\` asserted before the reservation's transaction committed. CI's slower disks made the race visible (#131).

## What changes

- \`reserveStock\` returns once the transaction committed, not when it was queued
- The test awaits \`reserved\` and checks the count after it
- A second test runs ten checkouts at once against the same item

## Not in this pull request

The Node 22 job is still running; the Node 24 failure is the known \`pg\` timeout, tracked in #135.

${SIMULATED}`,
      labels: [{ name: 'flaky-test', color: 'e99695' }, { name: 'tests', color: 'c5def5' }],
      comments: 2,
      headRef: 'fix/flaky-reserve-stock', baseRef: 'main', additions: 38, deletions: 12, changedFiles: 4,
      reviewDecision: 'approved', checks: 'failure',
      checkRuns: [
        { name: 'Lint', workflow: 'CI', state: 'success', url: job('acme', 'shop-api', 18024410, 51007001), description: null, required: true },
        { name: 'Test (node 24)', workflow: 'CI', state: 'failure', url: job('acme', 'shop-api', 18024410, 51007002), description: null, required: false },
        { name: 'Test (node 22)', workflow: 'CI', state: 'pending', url: job('acme', 'shop-api', 18024410, 51007003), description: null, required: false },
        { name: 'Deploy preview', workflow: 'Preview', state: 'skipped', url: job('acme', 'shop-api', 18024411, 51007010), description: null, required: false },
        { name: 'ci/coverage', workflow: null, state: 'success', url: 'https://coverage.example.com/acme/shop-api/134', description: 'Coverage 91.2% (+0.4%)', required: false },
      ],
      headSha: MOCK_HEAD_134, mergeable: 'mergeable', mergeState: 'unstable',
      mergeMethods: ['merge', 'squash', 'rebase'], defaultMergeMethod: 'squash', canMerge: true,
    },
  ]
}

/** What the list shows of an item. */
export const stateOf = (d: GhDetail): GhState => ({ kind: d.kind, title: d.title, state: d.state, stateReason: d.stateReason })

const keyOf = (t: Pick<GhTarget, 'owner' | 'repo' | 'number'>) => `github.com/${t.owner}/${t.repo}#${t.number}`.toLowerCase()

/**
 * Items the preview's gh is "signed out" for: their list entry and their screen show that
 * state (the shop-admin draft).
 */
export const MOCK_SIGNED_OUT = new Set(['github.com/acme/shop-admin#42'])

/** The linked items by key, as the list reads them (`ghItem`). */
export const MOCK_GITHUB_ITEMS: Record<string, GhState> = Object.fromEntries(items().map(d => [keyOf(d), stateOf(d)]))

/* ---------- GitHub Actions jobs ---------- */

const ESC = '\x1b'
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`
const green = (s: string) => `${ESC}[32m${s}${ESC}[0m`
const dim = (s: string) => `${ESC}[90m${s}${ESC}[0m`
const cyan = (s: string) => `${ESC}[36;1m${s}${ESC}[0m`

interface StepPlan { name: string; seconds: number; lines: string[]; conclusion?: 'success' | 'failure' | 'skipped' }
interface JobPlan { id: number; run: number; name: string; workflow: string; minutesAgo: number; running?: boolean; steps: StepPlan[] }

const setUp = (name: string): StepPlan => ({
  name: 'Set up job', seconds: 2, lines: [
    "Current runner version: '2.338.2'",
    '##[group]Operating System', 'Ubuntu', '24.04.3', 'LTS', '##[endgroup]',
    '##[group]GITHUB_TOKEN Permissions', 'Contents: read', 'Metadata: read', '##[endgroup]',
    'Secret source: Actions',
    "Download action repository 'actions/checkout@v5' (SHA:3d3c42e5aac5ba805825da76410c181273ba90b1)",
    "Download action repository 'actions/setup-node@v5' (SHA:a0853c24544627f65ddf259abe73b1d18a591444)",
    `Complete job name: ${name}`,
  ],
})
const checkout = (sha: string): StepPlan => ({
  name: 'Run actions/checkout@v5', seconds: 2, lines: [
    '##[group]Run actions/checkout@v5', 'with:', '  repository: acme/shop-api', '  fetch-depth: 1', '##[endgroup]',
    'Syncing repository: acme/shop-api',
    '##[group]Fetching the repository',
    `[command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +${sha}:refs/remotes/pull/134/merge`,
    ` * [new ref]         ${sha.slice(0, 8)} -> pull/134/merge`,
    '##[endgroup]',
    '[command]/usr/bin/git log -1 --format=%H', sha,
  ],
})
const setupNode = (v: string): StepPlan => ({
  name: 'Run actions/setup-node@v5', seconds: 6, lines: [
    '##[group]Run actions/setup-node@v5', 'with:', `  node-version: ${v}`, '  cache: pnpm', '##[endgroup]',
    `Found in cache @ /opt/hostedtoolcache/node/${v}.4.0/x64`,
    '##[warning]The `cache-dependency-path` input is empty; using pnpm-lock.yaml at the repository root.',
  ],
})
const install: StepPlan = {
  name: 'Install', seconds: 11, lines: [
    '##[group]Run pnpm install --frozen-lockfile', cyan('pnpm install --frozen-lockfile'), '##[endgroup]',
    'Lockfile is up to date, resolution step is skipped', 'Packages: +412',
    `Progress: resolved 412, reused 412, downloaded 0, added 412, ${green('done')}`,
  ],
}
const cleanup: StepPlan[] = [
  { name: 'Post Run actions/checkout@v5', seconds: 1, lines: ['Post job cleanup.', '[command]/usr/bin/git version', 'git version 2.53.0'] },
  { name: 'Complete job', seconds: 1, lines: ['Cleaning up orphan processes'] },
]
const passed = (names: string[]) => names.map(n => ` ${green('✓')} ${n} ${dim(`${20 + n.length}ms`)}`)
const TESTS = ['routes/orders.test.ts (18 tests)', 'checkout.test.ts (9 tests)', 'refunds.test.ts (6 tests)', 'stock.test.ts (11 tests)']

const JOBS: JobPlan[] = [
  {
    id: 51002001, run: 18021334, name: 'Lint', workflow: 'CI', minutesAgo: 31 * 60,
    steps: [setUp('Lint'), checkout('0c7d9e2b4a6f8e1d3c5b7a9f0e2d4c6b8a1f3e5d'), setupNode('24'), install,
      { name: 'Lint', seconds: 9, lines: ['##[group]Run pnpm lint', cyan('pnpm lint'), '##[endgroup]', '> shop-api@2.4.0 lint', '> eslint .', '', `${green('✔')} No problems found.`] },
      ...cleanup],
  },
  {
    id: 51002002, run: 18021334, name: 'Test (node 24)', workflow: 'CI', minutesAgo: 31 * 60,
    steps: [setUp('Test (node 24)'), checkout('0c7d9e2b4a6f8e1d3c5b7a9f0e2d4c6b8a1f3e5d'), setupNode('24'), install,
      { name: 'Test', seconds: 24, lines: ['##[group]Run pnpm test', cyan('pnpm test'), '##[endgroup]', ...passed(TESTS), '', ` Test Files  ${green('4 passed')} (4)`, `      Tests  ${green('44 passed')} (44)`] },
      ...cleanup],
  },
  {
    id: 51007001, run: 18024410, name: 'Lint', workflow: 'CI', minutesAgo: 40,
    steps: [setUp('Lint'), checkout(MOCK_HEAD_134), setupNode('24'), install,
      { name: 'Lint', seconds: 8, lines: ['##[group]Run pnpm lint', cyan('pnpm lint'), '##[endgroup]', '> shop-api@2.4.0 lint', '> eslint .', '', `${green('✔')} No problems found.`] },
      ...cleanup],
  },
  {
    id: 51007002, run: 18024410, name: 'Test (node 24)', workflow: 'CI', minutesAgo: 40,
    steps: [setUp('Test (node 24)'), checkout(MOCK_HEAD_134), setupNode('24'), install,
      {
        name: 'Test', seconds: 41, conclusion: 'failure', lines: [
          '##[group]Run pnpm test', cyan('pnpm test'), '##[endgroup]',
          ...passed(TESTS.slice(0, 3)),
          ` ${red('×')} stock.test.ts > reserves under load ${dim('30004ms')}`,
          `   ${red('→ Timed out acquiring a connection from the pool after 30000ms')}`,
          '',
          `${red(' FAIL ')} stock.test.ts > reserves under load`,
          'Error: Timed out acquiring a connection from the pool after 30000ms',
          ' ❯ Pool.connect node_modules/pg-pool/index.js:45:11',
          ' ❯ test/stock.test.ts:71:18',
          '',
          ` Test Files  ${red('1 failed')} | ${green('3 passed')} (4)`,
          `      Tests  ${red('1 failed')} | ${green('43 passed')} (44)`,
          '##[error]Process completed with exit code 1.',
        ],
      },
      { name: 'Upload coverage', seconds: 0, conclusion: 'skipped', lines: [] },
      ...cleanup],
  },
  {
    id: 51007003, run: 18024410, name: 'Test (node 22)', workflow: 'CI', minutesAgo: 3, running: true,
    steps: [setUp('Test (node 22)'), checkout(MOCK_HEAD_134), setupNode('22'), install,
      { name: 'Test', seconds: 600, lines: [] },
      { name: 'Upload coverage', seconds: 5, lines: [] },
      ...cleanup],
  },
  {
    id: 51007010, run: 18024411, name: 'Deploy preview', workflow: 'Preview', minutesAgo: 40,
    steps: [],
  },
]

/** A job as GitHub's API answers for it, and its raw log (timestamped lines), as `gh` would print them. */
function jobAnswer(plan: JobPlan): { json: object; log: string | null } {
  const start = Date.now() - plan.minutesAgo * 60_000
  let at = start
  const log: string[] = []
  const now = Date.now()
  const steps = plan.steps.map((s, i) => {
    const from = at
    const to = s.conclusion === 'skipped' ? from : from + s.seconds * 1000
    at = to
    const status = !plan.running || to <= now ? 'completed' : from <= now ? 'in_progress' : 'queued'
    if (status === 'completed' && s.conclusion !== 'skipped') {
      s.lines.forEach((l, k) => log.push(`${stamp(from + Math.min(k * 40, s.seconds * 1000 - 1))} ${l}`))
    }
    return {
      number: i + 1, name: s.name, status,
      conclusion: status === 'completed' ? s.conclusion ?? 'success' : null,
      started_at: status === 'queued' ? null : iso(from),
      completed_at: status === 'completed' ? iso(to) : null,
    }
  })
  const failed = steps.some(s => s.conclusion === 'failure')
  const skippedJob = plan.steps.length === 0
  const json = {
    id: plan.id, run_id: plan.run, name: plan.name, workflow_name: plan.workflow,
    html_url: `https://github.com/acme/shop-api/actions/runs/${plan.run}/job/${plan.id}`,
    status: plan.running ? 'in_progress' : 'completed',
    conclusion: plan.running ? null : skippedJob ? 'skipped' : failed ? 'failure' : 'success',
    started_at: iso(start), completed_at: plan.running ? null : iso(at),
    steps,
  }
  return { json, log: plan.running || skippedJob ? null : `﻿${log.join('\n')}\n` }
}

/* ---------- one backend's GitHub ---------- */

/** The repository each mock project's remotes point at, by folder name. */
export const mockRepoOf = (folder: string): { owner: string; repo: string } => ({ owner: 'acme', repo: folder })

export interface MockGithub {
  /** An item in full; throws the real messages (signed out, no such item, no such repository). */
  detail(t: GhTarget, instance: string): GhDetail
  merge(t: GhTarget, method: string, headSha: string, instance: string): void
  job(url: string): GhJob
  /** Open (or find) the pull request from `branch` into `base` (null: main) in `repo`. */
  prCreate(repo: { owner: string; repo: string }, branch: string, base: string | null, instance: string): GhDetail
}

export function createMockGithub(): MockGithub {
  const known = new Map(items().map(d => [keyOf(d), d]))
  /** Pull requests opened here, by `owner/repo:branch`. */
  const openedFor = new Map<string, number>()
  let next = 140

  const signedOut = (instance: string) => `The GitHub CLI in ${instance} is not signed in. Run gh auth login in its terminal, then try again.`

  function detail(t: GhTarget, instance: string): GhDetail {
    const c = checkedTarget(t)
    const key = keyOf(c)
    if (MOCK_SIGNED_OUT.has(key)) throw new Error(signedOut(instance))
    const found = known.get(key)
    if (found) return JSON.parse(JSON.stringify(found)) as GhDetail
    if (![...known.values()].some(d => d.owner === c.owner && d.repo === c.repo)) {
      throw new Error(`GitHub has no repository ${c.owner}/${c.repo}, or the account gh is signed in with in ${instance} cannot see it.`)
    }
    throw new Error(`There is no pull request or issue #${c.number} in ${c.owner}/${c.repo}.`)
  }

  return {
    detail,

    merge(t, method, headSha, instance) {
      const d = known.get(keyOf(detail(t, instance)))!
      if (d.kind !== 'pr' || d.state === 'merged' || d.state === 'closed') {
        throw new Error(mergeFailure(instance, t, 1, '{"message":"Pull Request is not mergeable"}', 'gh: Pull Request is not mergeable (HTTP 405)'))
      }
      if (d.headSha !== headSha) {
        throw new Error(mergeFailure(instance, t, 1, '{"message":"Head branch was modified. Review and try the merge again."}', 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)'))
      }
      if (!d.mergeMethods.includes(method as never)) {
        throw new Error(mergeFailure(instance, t, 1, `{"message":"${method} merges are not allowed on this repository."}`, 'gh: Method not allowed (HTTP 405)'))
      }
      Object.assign(d, { state: 'merged', mergeable: 'unknown', mergeState: 'unknown', updatedAt: iso(Date.now()) })
    },

    job(url) {
      const t = parseJobUrl(url)
      const plan = JOBS.find(j => j.id === t.job && t.owner === 'acme' && t.repo === 'shop-api')
      if (!plan) throw new Error(`GitHub has no job ${t.job} in ${t.owner}/${t.repo}, or the account gh is signed in with cannot see it.`)
      const { json, log } = jobAnswer(plan)
      const out = jobFromJson(json)
      if (log !== null) {
        splitLog(log, out.steps)
        out.logReady = true
      }
      return out
    },

    prCreate(repo, branch, base, instance) {
      const into = base ?? 'main'
      if (branch === into) {
        throw new Error(`${branch} has no commits that ${base ?? 'the default branch'} doesn't have, so there is nothing to open a pull request for.`)
      }
      const forKey = `${repo.owner}/${repo.repo}:${branch}`
      const number = openedFor.get(forKey) ?? next++
      openedFor.set(forKey, number)
      const key = keyOf({ ...repo, number })
      if (!known.has(key)) {
        const words = (branch.split('/').pop() ?? branch).replace(/[-_]/g, ' ')
        const sha = Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
        known.set(key, {
          ...BASE,
          kind: 'pr', owner: repo.owner, repo: repo.repo, number, url: `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`,
          title: words.charAt(0).toUpperCase() + words.slice(1),
          state: 'open',
          author: { login: 'ana-dev', avatarUrl: null },
          createdAt: iso(Date.now()), updatedAt: iso(Date.now()),
          body: `- ${words}\n\n${SIMULATED}`,
          headRef: branch, baseRef: into, additions: 12, deletions: 3, changedFiles: 2,
          reviewDecision: 'review_required', checks: null, checkRuns: [],
          headSha: sha, mergeable: 'mergeable', mergeState: 'clean',
          mergeMethods: ['merge', 'squash', 'rebase'], defaultMergeMethod: 'squash', canMerge: true,
        })
      }
      return detail({ host: GITHUB_HOST, ...repo, number }, instance)
    },
  }
}
