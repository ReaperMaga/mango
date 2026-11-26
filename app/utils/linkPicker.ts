import type { ForgeProvider, GhListItem } from '~/types/ipc'

/**
 * Picking a pull request (GitLab: merge request) or issue to link (LinksPicker): the repository's open ones, filtered as
 * the user types, and the reference typed itself when it names one the list does not hold (a
 * closed one, another repository's). Plain functions, so they run in Node tests.
 */

/**
 * A link or a reference with its repository: names one item without the list. GitHub
 * `https://host/owner/repo/pull/12` or `owner/repo#12`; GitLab `https://host/group/project/-/merge_requests/12`
 * (or `/-/issues/12`, `/-/work_items/12`) or `group/sub/project!12`.
 */
const FULL_REF = /^(?:https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/(?:pull|pulls|issues)\/\d+\S*|https?:\/\/[^\s/]+\/(?:[\w.-]+\/){2,}-\/(?:merge_requests|issues|work_items)\/\d+\S*|[\w.-]+(?:\/[\w.-]+)+[#!]\d+)$/i

/** `#12`, `!12` (a GitLab merge request) or `12`. */
const NUMBER = /^([#!]?)(\d{1,10})$/

export function isFullReference(query: string): boolean {
  return FULL_REF.test(query.trim())
}

/** The number typed (`#12`, `!12`, `12`), or null. */
export function typedNumber(query: string): number | null {
  const m = NUMBER.exec(query.trim())
  const n = m ? Number(m[2]) : 0
  return n > 0 ? n : null
}

/** The mark typed before a number: `#`, `!`, or null for a bare number. */
function typedMark(query: string): '#' | '!' | null {
  const m = NUMBER.exec(query.trim())
  return m?.[1] === '#' ? '#' : m?.[1] === '!' ? '!' : null
}

/** Lower-case words of a query, without `#` or `!` marks. */
function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map(w => w.replace(/^[#!]/, '')).filter(Boolean)
}

/** The link of an item without what may follow its number (`/files`, `/diffs`, `#issuecomment-…`). */
const bare = (url: string) => url.toLowerCase().replace(/^http:/, 'https:')
  .replace(/^(https:\/\/[^/]+\/[^/]+\/[^/]+\/)pulls\//, '$1pull/')
  .replace(/\/-\/work_items\/(\d)/, '/-/issues/$1')
  .replace(/^(.+?\/(?:pull|issues|merge_requests)\/\d+).*$/, '$1')

export interface PickerRows {
  /** The query itself, to look up on GitHub or GitLab, when it names an item the list does not hold. */
  reference: string | null
  /** Items that match, best first. */
  items: GhListItem[]
}

/**
 * What the picker offers for `query`: every item when it is empty; for a number, the item with that
 * number first and then those whose number starts with it; for a link, that item; otherwise the
 * items whose title, branch or number holds every word typed.
 */
export function pickerRows(items: GhListItem[], query: string, provider: ForgeProvider = 'github'): PickerRows {
  const q = query.trim()
  if (!q) return { reference: null, items }
  if (isFullReference(q)) {
    const want = bare(q)
    const hit = items.filter(i => bare(i.url) === want)
    return { reference: hit.length ? null : q, items: hit }
  }
  const n = typedNumber(q)
  if (n !== null) {
    const digits = String(n)
    // GitLab numbers merge requests (`!12`) and issues (`#12`) apart: a mark picks one kind; a bare number shows both.
    const mark = typedMark(q)
    const kind = provider !== 'gitlab' || !mark ? null : mark === '!' ? 'pr' : 'issue'
    const pool = kind ? items.filter(i => i.kind === kind) : items
    const exact = pool.filter(i => i.number === n)
    const rest = pool.filter(i => i.number !== n && String(i.number).startsWith(digits))
    // GitLab reads a bare number as a merge request, else an issue: it goes as typed.
    const sign = provider === 'gitlab' ? (mark ?? '') : '#'
    return { reference: exact.length ? null : `${sign}${n}`, items: [...exact, ...rest] }
  }
  const want = words(q)
  return {
    reference: null,
    items: items.filter((i) => {
      const hay = `${i.title} ${i.headRef ?? ''} ${i.number}`.toLowerCase()
      return want.every(w => hay.includes(w))
    }),
  }
}

export interface Segment { text: string; hit: boolean }

/** `text` cut where the query's words appear in it, to show them in bold. Case is kept. */
export function highlight(text: string, query: string): Segment[] {
  const want = typedNumber(query) === null ? words(query) : []
  if (!want.length) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const hits = new Array<boolean>(text.length).fill(false)
  for (const w of want) {
    for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + w.length)) hits.fill(true, at, at + w.length)
  }
  const out: Segment[] = []
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1]
    if (last && last.hit === hits[i]) last.text += text[i]
    else out.push({ text: text[i]!, hit: hits[i]! })
  }
  return out
}

/** How many leading digits of `#number` the query matched (for `#7` on #75: 1), or 0. */
export function numberMatch(number: number, query: string): number {
  const n = typedNumber(query)
  if (n === null) return 0
  const digits = String(n)
  return String(number).startsWith(digits) ? digits.length : 0
}
