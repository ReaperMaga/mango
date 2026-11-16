/** One version's entry in `docs/changelog.md`: the file the docs site shows, read by Settings > Changelog. */
export interface ReleaseNotes {
  /** "0.1.8", or "Unreleased". */
  version: string
  /** A sentence or two under the version, before any group. */
  intro: string[]
  /** `### Group` sections; a bullet that sits under no group has a null title. */
  groups: Array<{ title: string | null; items: string[] }>
}

/**
 * The changelog's markdown → versions, newest first (the file's order). Only the shapes the file
 * uses: `## version`, `### group`, `- bullet` (a bullet may continue on indented lines) and plain
 * paragraphs. Whatever comes before the first `## ` (the title and a note) is left out.
 */
export function parseChangelog(source: string): ReleaseNotes[] {
  const out: ReleaseNotes[] = []
  let release: ReleaseNotes | null = null
  let group: ReleaseNotes['groups'][number] | null = null
  let item = -1 // index of the bullet being continued, -1 when none

  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const version = /^##\s+(.+)$/.exec(line)
    if (version) {
      release = { version: version[1]!.trim(), intro: [], groups: [] }
      out.push(release)
      group = null
      item = -1
      continue
    }
    if (!release) continue
    const title = /^###\s+(.+)$/.exec(line)
    if (title) {
      group = { title: title[1]!.trim(), items: [] }
      release.groups.push(group)
      item = -1
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      if (!group) { group = { title: null, items: [] }; release.groups.push(group) }
      item = group.items.push(bullet[1]!.trim()) - 1
      continue
    }
    if (!line.trim()) { item = -1; continue }
    if (item >= 0 && group && /^\s/.test(raw)) group.items[item] += ` ${line.trim()}`
    else if (!group) release.intro.push(line.trim())
  }
  return out
}
