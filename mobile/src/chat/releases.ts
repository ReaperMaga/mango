import type { GhRun, GhRunJob } from '~/types/ipc'
import {
  isActive, latestRelease, totalDownloads, typicalDuration,
  type ReleaseEntry, type SortedReleases,
} from '~/utils/releaseRuns'
import { GITHUB_HOST } from '@/remote/github'
import type { Release } from '@/remote/releases'
import { formatDuration, shortAgo } from './time'

/**
 * What the Releases screens say, as plain functions (tested in releases.test.ts). Which run belongs
 * to which release, job summaries and files by platform are the desktop's `~/utils/releaseRuns.ts`.
 */

/** How often the list is read while a build runs, and an open build while it runs (the desktop's 15s and 10s). */
export const LIST_BUSY_MS = 15_000
export const RUN_BUSY_MS = 10_000
/** The list while nothing builds, as long as it is on screen. */
export const LIST_IDLE_MS = 120_000

/** Opened in the browser only when on github.com (a link from GitHub's answer, never trusted further). */
export function githubLink(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.toLowerCase() === GITHUB_HOST ? u.toString() : null
  } catch { return null }
}

/** "just now", "6 min ago", "3 hours ago", "2 days ago", "on 12 Mar". */
export function agoWords(iso: string | null | undefined, now = Date.now()): string | null {
  const ts = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(ts)) return null
  const a = shortAgo(ts, now)
  if (a === 'now') return 'just now'
  const m = /^(\d+)([mhd])$/.exec(a)
  if (!m) return `on ${a}`
  const n = Number(m[1])
  const unit = m[2] === 'm' ? 'min' : m[2] === 'h' ? (n === 1 ? 'hour' : 'hours') : (n === 1 ? 'day' : 'days')
  return `${n} ${unit} ago`
}

/** An entry's title: the release's, or what its run is. */
export function entryTitle(e: ReleaseEntry): string {
  if (e.kind === 'release') return e.release.name
  return e.why === 'trial' ? 'Trial build' : (e.run.headBranch ?? 'Release build')
}

/** Under a row of the list: the tag, its files and downloads ("v0.1.33 · 10 files · 19 downloads"). */
export function entryFacts(e: ReleaseEntry): string {
  if (e.kind === 'run') {
    const where = e.run.headBranch ? `${e.run.headBranch} · ` : ''
    return `${where}${e.run.workflow || 'Release'} #${e.run.number}`
  }
  const parts = [e.release.tag]
  const files = e.release.assets.filter(a => !(a.name.endsWith('.sig') && e.release.assets.some(b => b.name === a.name.slice(0, -4)))).length
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`)
  const d = totalDownloads(e.release.assets)
  if (d) parts.push(`${d} download${d === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** When the entry happened, for the row's right edge. */
export function entryWhen(e: ReleaseEntry): string | null {
  const at = e.kind === 'release' ? (e.release.publishedAt ?? e.run?.createdAt ?? e.release.createdAt) : e.run.createdAt
  return at || null
}

/** Who did what, and when ("github-actions published 6 min ago"). */
export function byline(e: ReleaseEntry, now = Date.now()): { who: string; what: string } {
  if (e.kind === 'release') {
    const r = e.release
    const who = r.author?.login.replace(/\[bot\]$/, '') ?? 'Someone'
    return r.publishedAt ? { who, what: `published ${agoWords(r.publishedAt, now)}` } : { who, what: `drafted it ${agoWords(r.createdAt, now)}` }
  }
  return { who: e.run.workflow || 'Release', what: `${e.why === 'trial' ? 'started by hand' : 'started by the tag'} ${agoWords(e.run.createdAt, now)}` }
}

/** How long the run has gone on, or took. */
export function runTook(run: GhRun, now = Date.now()): string | null {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  if (!Number.isFinite(start)) return null
  if (isActive(run.state)) return formatDuration(Math.max(0, now - start))
  const end = Date.parse(run.updatedAt)
  return Number.isFinite(end) && end >= start ? formatDuration(end - start) : null
}

/** About when a running build ends, from how long the last good ones took. */
export function runEta(run: GhRun, runs: GhRun[], now = Date.now(), time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })): string | null {
  if (!isActive(run.state)) return null
  const usual = typicalDuration(runs, run.workflowId, run.id)
  if (usual === null) return null
  const start = Date.parse(run.startedAt ?? run.createdAt)
  if (!Number.isFinite(start)) return null
  const minutes = Math.max(1, Math.round(usual / 60_000))
  if (now - start > usual) return `Taking longer than usual (about ${minutes} min).`
  return `Recent builds took about ${minutes} min: done around ${time(start + usual)}.`
}

/** A job's time, or why it has none. */
export function jobTook(j: GhRunJob, now = Date.now()): string | null {
  if (j.state === 'queued') return 'Waiting'
  if (j.state === 'skipped') return 'Skipped'
  if (!j.startedAt) return null
  const start = Date.parse(j.startedAt)
  const end = j.completedAt ? Date.parse(j.completedAt) : now
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : null
}

/** What the project screen's Releases row says under its title. */
export function releasesSummary(sorted: SortedReleases, releases: Release[]): { text: string; tone: 'running' | 'error' | 'subtle' } {
  const building = sorted.inProgress.filter(e => e.run && isActive(e.run.state))
  if (building.length) {
    const first = building[0]!
    const name = first.kind === 'release' ? first.release.tag : entryTitle(first)
    return { text: building.length === 1 ? `Building ${name}` : `${building.length} builds running`, tone: 'running' }
  }
  const failed = sorted.inProgress.find(e => e.run && (e.run.state === 'failure'))
  if (failed) return { text: `Build failed: ${failed.kind === 'release' ? failed.release.tag : entryTitle(failed)}`, tone: 'error' }
  const latest = latestRelease(releases)
  if (latest) return { text: `Latest ${latest.tag}`, tone: 'subtle' }
  return { text: releases.length ? `${releases.length} release${releases.length === 1 ? '' : 's'}` : 'No releases yet', tone: 'subtle' }
}

/** The action a finished, unhappy run offers: re-run what failed, or all of a cancelled one. */
export function rerunAction(run: GhRun | null): 'rerun-failed' | 'rerun' | null {
  if (!run) return null
  if (run.state === 'failure') return 'rerun-failed'
  if (run.state === 'cancelled') return 'rerun'
  return null
}
