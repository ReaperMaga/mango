/**
 * Changelog from commits. `pnpm bump` calls this: it turns the Conventional Commit subjects since the
 * last desktop release into bullets and writes them into `docs/changelog.md` under the new version.
 * Plain Node, erasable TypeScript only.
 *
 * Only `feat`, `fix` and `perf` count, and not the ones scoped `mobile` (the phone app has its own
 * tags). Bullets already written by hand under `## Unreleased` are kept and come first.
 */

const GROUPS: Array<{ types: string[]; title: string }> = [
  { types: ['feat'], title: 'New' },
  { types: ['fix'], title: 'Fixes' },
  { types: ['perf'], title: 'Performance' },
]

/** "feat(git): add x (#12)" -> a bullet "Add x.", or null when the commit does not belong in the changelog. */
export function bulletFor(subject: string): { type: string; text: string } | null {
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject.trim())
  if (!m) return null
  const type = m[1]!
  if (!GROUPS.some((g) => g.types.includes(type))) return null
  if ((m[2] ?? '').split(',').map((s) => s.trim()).includes('mobile')) return null
  let text = m[4]!.replace(/\s*\(#\d+\)\s*$/, '').trim()
  if (!text) return null
  text = text[0]!.toUpperCase() + text.slice(1)
  if (!/[.!?]$/.test(text)) text += '.'
  return { type, text }
}

/** The `### group` blocks (markdown) for a list of commit subjects, oldest first as given. */
export function notesFromSubjects(subjects: string[]): string {
  const by = new Map<string, string[]>()
  for (const s of subjects) {
    const b = bulletFor(s)
    if (!b) continue
    const group = GROUPS.find((g) => g.types.includes(b.type))!.title
    const list = by.get(group) ?? []
    if (!list.includes(b.text)) list.push(b.text)
    by.set(group, list)
  }
  return GROUPS.filter((g) => by.has(g.title))
    .map((g) => `### ${g.title}\n\n${by.get(g.title)!.map((t) => `- ${t}`).join('\n')}\n`)
    .join('\n')
}

/**
 * Put the release into the changelog: the hand-written `## Unreleased` section (if any) plus the
 * generated notes become `## <version>`. Returns the file unchanged when the version is already there.
 */
export function applyRelease(source: string, version: string, generated: string): string {
  const text = source.replace(/\r\n/g, '\n')
  if (new RegExp(`^##\\s+${version.replace(/[.+]/g, '\\$&')}\\s*$`, 'm').test(text)) return source
  const unreleased = /^##\s+Unreleased\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text)
  const hand = unreleased ? unreleased[1]!.trim() : ''
  const body = [hand, generated.trim()].filter(Boolean).join('\n\n')
  if (!body) throw new Error('No user-visible commits (feat, fix, perf) since the last release and nothing under "## Unreleased": the changelog would be empty.')
  const section = `## ${version}\n\n${body}\n\n`
  if (unreleased) return text.replace(unreleased[0], section.replace(/\n\n$/, '\n\n'))
  const first = text.search(/^##\s/m)
  return first < 0 ? `${text.trimEnd()}\n\n${section}` : text.slice(0, first) + section + text.slice(first)
}
