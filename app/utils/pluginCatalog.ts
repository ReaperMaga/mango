import type { PluginCatalogEntry } from '~/types/ipc'

/**
 * Searching and filtering the official catalog in Settings > Plugins > Browse. Pure (plain-Node
 * testable, tests/pluginCatalog.test.ts): imports only types.
 *
 * The search is forgiving: case and accents are ignored, every word of the query must be found
 * somewhere (name, id, description, author, tags), and a word that is not found as written still
 * matches the name when its letters appear in order ("fcstmr" finds "Focus timer").
 */

export type CatalogOrigin = 'all' | 'official' | 'community'
export type CatalogState = 'any' | 'installed' | 'available'

export interface CatalogQuery {
  text: string
  origin: CatalogOrigin
  state: CatalogState
  /** One tag, or null for every tag. */
  tag: string | null
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** `needle`'s letters appear in `hay` in order. */
function subsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true
  return needle.length === 0
}

/** How well one entry matches the query's words: 0 is no match, higher is better. */
export function scoreEntry(e: PluginCatalogEntry, text: string): number {
  const words = fold(text).split(/[\s,]+/).filter(Boolean)
  if (!words.length) return 1
  const name = fold(e.name)
  const id = fold(e.id)
  const tags = e.tags.map(fold)
  const desc = fold(e.description)
  const author = fold(e.author)
  let score = 0
  for (const w of words) {
    if (name.startsWith(w) || id.startsWith(w)) score += 8
    else if (name.split(/[\s-]+/).some(p => p.startsWith(w))) score += 6
    else if (name.includes(w) || id.includes(w)) score += 5
    else if (tags.some(t => t === w)) score += 4
    else if (tags.some(t => t.includes(w))) score += 3
    else if (author.includes(w)) score += 2
    else if (desc.includes(w)) score += 1
    else if (w.length >= 3 && subsequence(w, name.replace(/[\s-]+/g, ''))) score += 1
    else return 0
  }
  return score
}

/** Every tag in the catalog, the most used first, then by name. */
export function catalogTags(entries: PluginCatalogEntry[]): string[] {
  const count = new Map<string, number>()
  for (const e of entries) for (const t of new Set(e.tags.map(x => x.trim().toLowerCase()).filter(Boolean))) count.set(t, (count.get(t) ?? 0) + 1)
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
}

/** The entries that pass the filters, best match first (official before community on a tie, then by name). */
export function filterCatalog(entries: PluginCatalogEntry[], q: CatalogQuery, isInstalled: (id: string) => boolean): PluginCatalogEntry[] {
  const out: Array<{ e: PluginCatalogEntry; score: number }> = []
  for (const e of entries) {
    if (q.origin === 'official' && !e.official) continue
    if (q.origin === 'community' && e.official) continue
    if (q.state === 'installed' && !isInstalled(e.id)) continue
    if (q.state === 'available' && isInstalled(e.id)) continue
    if (q.tag && !e.tags.some(t => t.trim().toLowerCase() === q.tag)) continue
    const score = scoreEntry(e, q.text)
    if (score > 0) out.push({ e, score })
  }
  return out
    .sort((a, b) => b.score - a.score || Number(b.e.official) - Number(a.e.official) || a.e.name.localeCompare(b.e.name))
    .map(x => x.e)
}
