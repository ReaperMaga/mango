import { describe, expect, it } from 'vitest'
import type { GhCheck } from '~/types/ipc'
import {
  POLL_BUSY_MS, POLL_IDLE_MS, LOG_GRACE_MS, checkLink, checkSummary, defaultMethod, isJobUrl, jobWantsMore, labelColor,
  mergeQuestion, mergeStatus, mergeUnavailable, pollDelay, pollWait, sortChecks, tidyReference, tookMs,
} from './pulls'

const check = (state: GhCheck['state'], name: string = state, over: Partial<GhCheck> = {}): GhCheck =>
  ({ name, workflow: 'CI', state, url: null, description: null, required: false, ...over })

const pr = {
  kind: 'pr' as const,
  state: 'open' as const,
  number: 42,
  owner: 'acme',
  repo: 'shop',
  baseRef: 'main' as string | null,
  checkRuns: [] as GhCheck[],
  checks: null as 'success' | 'failure' | 'pending' | null,
  mergeable: 'mergeable' as 'mergeable' | 'conflicting' | 'unknown' | null,
  mergeState: 'clean' as Parameters<typeof mergeStatus>[0]['mergeState'],
  mergeMethods: ['merge', 'squash', 'rebase'] as ('merge' | 'squash' | 'rebase')[],
  defaultMergeMethod: 'squash' as 'merge' | 'squash' | 'rebase' | null,
  canMerge: true,
}

describe('checks', () => {
  it('sorts failures first, keeping order within a state', () => {
    const runs = [check('success', 'a'), check('skipped', 'b'), check('failure', 'c'), check('pending', 'd'), check('failure', 'e'), check('cancelled', 'f')]
    expect(sortChecks(runs).map(c => c.name)).toEqual(['c', 'e', 'f', 'd', 'a', 'b'])
  })

  it('sums them up in one line, as the desktop does', () => {
    expect(checkSummary({ checkRuns: [], checks: null })).toBeNull()
    expect(checkSummary({ checkRuns: [], checks: 'pending' })).toEqual({ tone: 'pending', text: 'Running' })
    expect(checkSummary({ checkRuns: [check('success')], checks: 'success' })).toEqual({ tone: 'success', text: 'Passed' })
    expect(checkSummary({ checkRuns: [check('success'), check('success')], checks: 'success' })).toEqual({ tone: 'success', text: 'All 2 passed' })
    expect(checkSummary({ checkRuns: [check('success'), check('skipped'), check('neutral')], checks: 'success' })).toEqual({ tone: 'success', text: '1 passed, 2 skipped' })
    expect(checkSummary({ checkRuns: [check('failure'), check('pending'), check('success')], checks: 'failure' })).toEqual({ tone: 'failure', text: '1 failed, 1 running, 1 passed' })
    expect(checkSummary({ checkRuns: [check('pending'), check('success')], checks: 'pending' })).toEqual({ tone: 'pending', text: '1 running, 1 passed' })
    expect(checkSummary({ checkRuns: [check('cancelled')], checks: null })).toEqual({ tone: 'failure', text: '1 cancelled' })
  })

  it('knows an Actions job on github.com by its link', () => {
    expect(isJobUrl('https://github.com/acme/shop/actions/runs/123/job/456')).toBe(true)
    expect(isJobUrl('https://github.com/acme/shop/actions/runs/123/job/456?pr=4#step:3:1')).toBe(true)
    expect(isJobUrl('https://evil.example/acme/shop/actions/runs/123/job/456')).toBe(false)
    expect(isJobUrl('http://github.com/acme/shop/actions/runs/123/job/456')).toBe(false)
    expect(isJobUrl('https://github.com/acme/shop/actions/runs/123')).toBe(false)
    expect(isJobUrl(null)).toBe(false)
  })

  it('opens other checks only at an https address', () => {
    expect(checkLink('https://app.netlify.com/sites/x/deploys/1')).toBe('https://app.netlify.com/sites/x/deploys/1')
    expect(checkLink('http://ci.example/1')).toBeNull()
    expect(checkLink('javascript:alert(1)')).toBeNull()
    expect(checkLink('file:///etc/passwd')).toBeNull()
    expect(checkLink('not a url')).toBeNull()
    expect(checkLink(null)).toBeNull()
  })
})

describe('labels', () => {
  it('takes only six-digit hex colours', () => {
    expect(labelColor('d73a4a')).toBe('#d73a4a')
    expect(labelColor('D73A4A')).toBe('#D73A4A')
    expect(labelColor('red')).toBeNull()
    expect(labelColor('fff')).toBeNull()
    expect(labelColor('d73a4a;background:url(x)')).toBeNull()
  })
})

describe('merging', () => {
  it('says what GitHub would do now', () => {
    expect(mergeStatus(pr)).toEqual({ tone: 'done', title: 'Ready to merge', detail: 'Into main.', ready: true })
    expect(mergeStatus({ ...pr, state: 'draft' }).ready).toBe(false)
    expect(mergeStatus({ ...pr, mergeable: 'conflicting' })).toMatchObject({ tone: 'error', title: 'Conflicts with main', ready: false })
    expect(mergeStatus({ ...pr, mergeState: 'dirty' }).title).toBe('Conflicts with main')
    expect(mergeStatus({ ...pr, mergeState: 'unknown' })).toMatchObject({ tone: 'checking', ready: false })
    expect(mergeStatus({ ...pr, mergeState: null }).tone).toBe('checking')
    expect(mergeStatus({ ...pr, mergeState: 'blocked' })).toMatchObject({ title: 'Blocked', detail: 'Branch protection wants approvals or passing checks.', ready: true })
    expect(mergeStatus({ ...pr, mergeState: 'blocked', checkRuns: [check('pending')] }).detail).toBe('Required checks have not passed yet.')
    expect(mergeStatus({ ...pr, mergeState: 'behind', baseRef: null })).toMatchObject({ tone: 'queued', title: 'Behind the base branch' })
    expect(mergeStatus({ ...pr, mergeState: 'unstable', checkRuns: [check('pending')] })).toMatchObject({ tone: 'running', title: 'Checks are running' })
    expect(mergeStatus({ ...pr, mergeState: 'unstable', checkRuns: [check('failure')] })).toMatchObject({ tone: 'error', title: 'Some checks failed' })
  })

  it('picks the default method only when it is allowed', () => {
    expect(defaultMethod(pr)).toBe('squash')
    expect(defaultMethod({ mergeMethods: ['rebase', 'merge'], defaultMergeMethod: 'squash' })).toBe('rebase')
    expect(defaultMethod({ mergeMethods: [], defaultMergeMethod: null })).toBe('squash')
  })

  it('asks the question with what will happen', () => {
    expect(mergeQuestion(pr, 'squash')).toBe('Squash and merge #42 into main on GitHub?')
    expect(mergeQuestion({ ...pr, checkRuns: [check('failure')] }, 'merge')).toBe('Create a merge commit #42 into main on GitHub? 1 check has not passed.')
    expect(mergeQuestion({ ...pr, checkRuns: [check('failure'), check('cancelled'), check('success')] }, 'rebase')).toBe('Rebase and merge #42 into main on GitHub? 2 checks have not passed.')
  })

  it('says why it cannot be merged from here', () => {
    expect(mergeUnavailable(pr)).toBeNull()
    expect(mergeUnavailable({ ...pr, canMerge: false })).toContain('cannot merge pull requests in acme/shop')
    expect(mergeUnavailable({ ...pr, mergeMethods: [] })).toContain('merge it on GitHub')
  })
})

describe('keeping it current', () => {
  it('reads often while something is unsettled, never once it is over', () => {
    expect(pollDelay(null)).toBeNull()
    expect(pollDelay(pr)).toBe(POLL_IDLE_MS)
    expect(pollDelay({ ...pr, checkRuns: [check('pending')] })).toBe(POLL_BUSY_MS)
    expect(pollDelay({ ...pr, checks: 'pending' })).toBe(POLL_BUSY_MS)
    expect(pollDelay({ ...pr, mergeable: 'unknown' })).toBe(POLL_BUSY_MS)
    expect(pollDelay({ ...pr, mergeState: 'unknown' })).toBe(POLL_BUSY_MS)
    expect(pollDelay({ ...pr, state: 'merged' })).toBeNull()
    expect(pollDelay({ ...pr, state: 'closed' })).toBeNull()
    expect(pollDelay({ ...pr, kind: 'issue' })).toBeNull()
  })

  it('counts from the last good read, the whole interval after a failure', () => {
    expect(pollWait(10_000, 1_000, false, 4_000)).toBe(7_000)
    expect(pollWait(10_000, 1_000, false, 30_000)).toBe(0)
    expect(pollWait(10_000, 1_000, true, 4_000)).toBe(10_000)
  })

  it('reads a job while it runs and for the grace period after', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(jobWantsMore(null)).toBe(false)
    expect(jobWantsMore({ state: 'pending', logReady: false, completedAt: null }, now)).toBe(true)
    expect(jobWantsMore({ state: 'queued', logReady: false, completedAt: null }, now)).toBe(true)
    expect(jobWantsMore({ state: 'success', logReady: true, completedAt: '2026-11-20T11:59:59Z' }, now)).toBe(false)
    expect(jobWantsMore({ state: 'failure', logReady: false, completedAt: '2026-11-20T11:59:00Z' }, now)).toBe(true)
    expect(jobWantsMore({ state: 'failure', logReady: false, completedAt: new Date(now - LOG_GRACE_MS - 1).toISOString() }, now)).toBe(false)
  })

  it('measures durations, null when a time is missing', () => {
    expect(tookMs('2026-11-20T12:00:00Z', '2026-11-20T12:01:30Z')).toBe(90_000)
    expect(tookMs(null, null)).toBeNull()
    expect(tookMs('garbage', null)).toBeNull()
    expect(tookMs('2026-11-20T12:00:00Z', null, Date.parse('2026-11-20T12:00:05Z'))).toBe(5_000)
  })
})

describe('references', () => {
  it('takes links, owner/repo#12, #12 and 12', () => {
    expect(tidyReference(' #12 ')).toBe('#12')
    expect(tidyReference('12')).toBe('12')
    expect(tidyReference('acme/shop#7')).toBe('acme/shop#7')
    expect(tidyReference('https://github.com/acme/shop/pull/7')).toBe('https://github.com/acme/shop/pull/7')
    expect(tidyReference('https://github.com/acme/shop/pull/7/files?x=1#y')).toBe('https://github.com/acme/shop/pull/7/files')
    expect(tidyReference('github.com/acme/shop/issues/3')).toBe('https://github.com/acme/shop/issues/3')
    expect(tidyReference('https://www.github.com/acme/shop/issues/3')).toBe('https://github.com/acme/shop/issues/3')
  })

  it('turns down anything else before asking the environment', () => {
    expect(tidyReference('')).toBeNull()
    expect(tidyReference('   ')).toBeNull()
    expect(tidyReference('https://gitlab.com/acme/shop/-/merge_requests/1')).toBeNull()
    expect(tidyReference('https://github.com.evil.example/acme/shop/pull/7')).toBeNull()
    expect(tidyReference('https://github.com/acme/shop')).toBeNull()
    expect(tidyReference('#12; rm -rf ~')).toBeNull()
    expect(tidyReference('$(id)/shop#1')).toBeNull()
    expect(tidyReference('-o/shop#1')).toBeNull()
  })
})
