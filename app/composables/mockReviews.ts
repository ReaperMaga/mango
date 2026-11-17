import type { GitStatus, PlasticReview, PlasticReviews } from '~/types/ipc'
import { mockGit } from '~/composables/mockGit'

/**
 * `plastic_reviews` and `plastic_review_create` for the browser preview: a handful of made-up code
 * reviews in the Unity VCS project (`fruit-stand`), in every status, that follow its branch. A review
 * asked for here joins them until the page reloads.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let nextId = 1420
/** Reviews asked for in this session, by project path. */
const asked = new Map<string, PlasticReview[]>()

function seeded(now: number): PlasticReview[] {
  const r = (id: number, p: Partial<PlasticReview> & Pick<PlasticReview, 'title' | 'status' | 'owner' | 'target' | 'created'>): PlasticReview => ({
    id, guid: null, assignee: null, reviewers: [], targetType: 'branch', modified: null, comments: null, unresolved: null, ...p,
  })
  return [
    r(1412, {
      title: 'Inventory: stack items and show totals', status: 'reworkRequired', owner: 'you@orchard.studio', target: '/main/feature/inventory',
      created: now - 2 * DAY, modified: now - 3 * HOUR, comments: 7, unresolved: 2,
      reviewers: [{ name: 'maria@orchard.studio', status: 'reworkRequired' }, { name: 'leads', status: 'underReview' }],
    }),
    r(1398, {
      title: 'Inventory grid prefab', status: 'reviewed', owner: 'you@orchard.studio', target: '/main/feature/inventory',
      created: now - 9 * DAY, modified: now - 8 * DAY, comments: 3, unresolved: 0,
      reviewers: [{ name: 'maria@orchard.studio', status: 'reviewed' }],
    }),
    r(1417, {
      title: 'Weather: rain slows the delivery cart', status: 'underReview', owner: 'jun@orchard.studio', target: '/main/feature/weather',
      created: now - 5 * HOUR, modified: now - 40 * MIN, comments: 1, unresolved: 1,
      reviewers: [{ name: 'you@orchard.studio', status: 'underReview' }, { name: 'maria@orchard.studio', status: 'reviewed' }],
    }),
    r(1415, {
      title: 'Fix crates falling through the barn floor', status: 'underReview', owner: 'maria@orchard.studio', target: '/main/fix/crate-physics',
      created: now - 26 * HOUR, comments: 0, unresolved: 0,
      reviewers: [{ name: 'you@orchard.studio', status: 'underReview' }],
    }),
    r(1403, {
      title: 'Bump the shader cache version', status: 'reworkRequired', owner: 'jun@orchard.studio', targetType: 'changeset', target: 'cs:2231',
      created: now - 4 * DAY, assignee: 'maria@orchard.studio',
    }),
    r(1388, {
      title: 'Release 1.2 notes', status: 'reviewed', owner: 'maria@orchard.studio', target: '/main/release-1.2',
      created: now - 14 * DAY,
    }),
  ]
}

async function plasticStatus(path: string): Promise<GitStatus> {
  const status = await mockGit('git_status', { path }) as GitStatus
  if (status.vcs !== 'plastic') throw new Error("Code reviews are a Unity Version Control feature, and this folder isn't in a Unity VCS workspace.")
  return status
}

export async function mockPlasticReviews(path: string): Promise<PlasticReviews> {
  const status = await plasticStatus(path)
  const all = [...(asked.get(path) ?? []), ...seeded(Date.now())].sort((a, b) => b.created - a.created)
  const branch = status.branch
  const branchReviews = branch ? all.filter(r => r.targetType === 'branch' && r.target === branch) : []
  const open = all.filter(r => r.status !== 'reviewed' && !branchReviews.includes(r))
  return { repository: status.repository, branch, branchReviews, open, more: false }
}

export async function mockPlasticReviewCreate(path: string, title: string, reviewers: string | null): Promise<number> {
  const status = await plasticStatus(path)
  const clean = title.trim().replace(/\s+/g, ' ')
  if (!clean) throw new Error('Give the review a title.')
  if (!status.branch) throw new Error("The workspace isn't on a branch. Switch to the branch you want reviewed first.")
  const names = (reviewers ?? '').split(/[,;\s]+/).filter(Boolean)
  const bad = names.find(n => !/^[\p{L}\p{N}._@+-]+$/u.test(n) || n.startsWith('-'))
  if (bad) throw new Error(`"${bad}" is not a user name Unity VCS knows. Separate several with commas.`)
  const id = nextId++
  const review: PlasticReview = {
    id, guid: null, title: clean, status: 'underReview', owner: 'you@orchard.studio', assignee: null,
    reviewers: names.map(name => ({ name, status: 'underReview' })), targetType: 'branch', target: status.branch,
    created: Date.now(), modified: null, comments: 0, unresolved: 0,
  }
  asked.set(path, [review, ...(asked.get(path) ?? [])])
  return id
}
