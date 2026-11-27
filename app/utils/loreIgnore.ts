/**
 * A `.loreignore` for a folder that becomes a Lore repository (`lore_init`). Lore reads only that file:
 * not `.gitignore`, not Unity VCS's `ignore.conf`. So the rules come over from those, converted where
 * Lore differs:
 *
 * - Unity VCS's regex rules (`^…$`) become globs when they are simple (`^*.private.[0-9]+$` →
 *   `*.private.[0-9]*`), else they are dropped with a comment: Lore has no regular expressions.
 * - An exception that starts with `**` (such as `!**` + `/Gen/...`) is dropped with a comment: Lore refuses
 *   it, and then `lore status` fails for the whole repository.
 * - Rules that differ only in case (`Library` and `library`) are kept once: Lore matches names
 *   case-insensitively.
 * - Other version control's metadata (`.git/`, `.plastic/`) is ignored: Lore would track it otherwise.
 *
 * Plain Node testable (`tests/loreIgnore.test.ts`). The backend refuses what [`loreIgnoreProblem`]
 * refuses (`lore_init` in src-tauri/src/projects.rs): keep them in step.
 */

export interface LoreIgnoreSources {
  /** The folder's own `.gitignore`, if any. */
  gitignore?: string | null
  /** Unity VCS's `ignore.conf` in the folder, if any. */
  plasticIgnore?: string | null
  /** The folder has `.git` (a repository or a worktree). */
  git?: boolean
  /** The folder is a Unity VCS workspace (`.plastic`). */
  plastic?: boolean
  /** It looks like a Unity project (`Assets/` and `ProjectSettings/`). */
  unity?: boolean
}

/** What one line of an ignore file becomes. */
export type IgnoreLine =
  | { kind: 'blank' }
  | { kind: 'comment'; text: string }
  | { kind: 'rule'; text: string; from?: string }
  | { kind: 'dropped'; text: string; reason: 'regex' | 'exception' }

/** `^…$` (Unity VCS) as a glob, or null when it is more than a glob can say. */
export function regexToGlob(rule: string): string | null {
  if (!rule.startsWith('^') || !rule.endsWith('$') || rule.length < 3) return null
  let s = rule.slice(1, -1)
  // Placeholders keep the converted parts out of the check for what is left of the regex.
  s = s.replace(/\\\./g, '\u0000')
  s = s.replace(/\.\*/g, '*').replace(/\.\+/g, '\u0001').replace(/\]\+/g, ']*')
  if (/[()|{}+?\\^$]/.test(s)) return null
  s = s.replace(/\u0000/g, '.').replace(/\u0001/g, '?*')
  // A glob that is nothing but wildcards would ignore everything.
  if (!/[^*?/]/.test(s) || s.startsWith('!')) return null
  return s
}

/** Why Lore would refuse `rule`, or null. */
function refused(rule: string): boolean {
  return /^!\s*\*\*/.test(rule)
}

/** One line of a `.gitignore` or `ignore.conf`, converted. */
export function convertIgnoreLine(raw: string): IgnoreLine {
  const line = raw.replace(/\r$/, '').replace(/\s+$/, '')
  if (!line.trim()) return { kind: 'blank' }
  if (line.startsWith('#')) return { kind: 'comment', text: line }
  const rule = line.trimStart()
  if (rule.startsWith('^') && rule.endsWith('$')) {
    const glob = regexToGlob(rule)
    return glob ? { kind: 'rule', text: glob, from: rule } : { kind: 'dropped', text: rule, reason: 'regex' }
  }
  if (refused(rule)) return { kind: 'dropped', text: rule, reason: 'exception' }
  return { kind: 'rule', text: rule }
}

/** A Unity project's rules, for one with no ignore file of its own (after GitHub's Unity.gitignore). */
export const UNITY_TEMPLATE = [
  '# Unity-generated folders',
  '/Library/',
  '/Temp/',
  '/Obj/',
  '/Build/',
  '/Builds/',
  '/Logs/',
  '/UserSettings/',
  '/MemoryCaptures/',
  '/Recordings/',
  '',
  '# IDEs',
  '.vs/',
  '.vscode/',
  '.idea/',
  '.gradle/',
  'ExportedObj/',
  '.consulo/',
  '',
  '# Generated projects and solutions (only in the root)',
  '/*.csproj',
  '/*.unityproj',
  '/*.sln',
  '/*.slnx',
  '*.suo',
  '*.tmp',
  '*.user',
  '*.userprefs',
  '*.pidb',
  '*.booproj',
  '*.svd',
  '*.pdb',
  '*.mdb',
  '*.opendb',
  '*.VC.db',
  '*.pidb.meta',
  '*.pdb.meta',
  '*.mdb.meta',
  'sysinfo.txt',
  'mono_crash.*',
  'crashlytics-build.properties',
  '',
  '# Builds and packages',
  '*.apk',
  '*.aab',
  '*.app',
  '*.unitypackage',
  '*.unitypackage.meta',
  '',
  '# Addressables',
  '/Assets/AddressableAssetsData/*/*.bin*',
  '/Assets/StreamingAssets/aa.meta',
  '/Assets/StreamingAssets/aa/*',
  '',
  '# OS files',
  '.DS_Store',
  'Thumbs.db',
  'Desktop.ini',
].join('\n')

/** Collapses runs of blank lines and trims them at both ends. */
function tidy(lines: string[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    if (!l && (!out.length || !out[out.length - 1])) continue
    out.push(l)
  }
  while (out.length && !out[out.length - 1]) out.pop()
  return out
}

/**
 * The `.loreignore` to offer for a folder, or '' when there is nothing to ignore. `seen` (lower-case
 * rules) is shared by all sections, so the first spelling of a rule wins.
 */
export function loreIgnoreFrom(src: LoreIgnoreSources): string {
  const seen = new Set<string>()
  const sections: string[][] = []
  const sourceNames: string[] = []

  const meta: string[] = []
  if (src.git) meta.push('.git/')
  if (src.plastic) meta.push('.plastic/')
  for (const m of meta) seen.add(m.toLowerCase())
  if (meta.length) sections.push(['# Other version control\'s metadata', ...meta])

  const convert = (text: string, title: string) => {
    const out: string[] = [`# From ${title}`]
    let rules = 0
    for (const raw of text.split('\n')) {
      const l = convertIgnoreLine(raw)
      if (l.kind === 'blank') out.push('')
      else if (l.kind === 'comment') out.push(l.text)
      else if (l.kind === 'dropped') {
        out.push(l.reason === 'regex'
          ? `# Dropped, Lore has no regular expressions: ${l.text}`
          : `# Dropped, Lore refuses an exception that starts with **: ${l.text}`)
      } else {
        const key = l.text.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        if (l.from) out.push(`# Was ${l.from}`)
        out.push(l.text)
        rules++
      }
    }
    if (rules || out.some(l => l.startsWith('# Dropped'))) {
      sections.push(tidy(out))
      sourceNames.push(title.replace(/ \(.*\)$/, ''))
    }
  }
  if (src.plasticIgnore?.trim()) convert(src.plasticIgnore, 'ignore.conf (Unity VCS)')
  if (src.gitignore?.trim()) convert(src.gitignore, '.gitignore')

  if (src.unity && !src.plasticIgnore?.trim() && !src.gitignore?.trim()) {
    sections.push(UNITY_TEMPLATE.split('\n').filter((l) => {
      if (!l || l.startsWith('#')) return true
      const key = l.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }))
    sourceNames.push('a Unity template')
  }

  if (!sections.length) return ''
  const head = [
    `# Files Lore leaves alone${sourceNames.length ? `, made from ${sourceNames.join(' and ')}` : ''}.`,
    '# Lore reads only this file, not .gitignore or ignore.conf.',
  ]
  return `${[head, ...sections].map(s => s.join('\n')).join('\n\n')}\n`
}

/** The first line Lore would refuse (1-based), or null. Mirrors `ignore_problem` in projects.rs. */
export function loreIgnoreProblem(text: string): { line: number; text: string } | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const rule = lines[i]!.trim()
    if (refused(rule)) return { line: i + 1, text: rule }
  }
  return null
}
