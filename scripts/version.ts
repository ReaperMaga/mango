/**
 * Mango's version. package.json is the single source: tauri.conf.json reads it
 * from there ("version": "../package.json") and the frontend bakes it in at
 * build time (nuxt.config.ts). Cargo needs its own copy, which this script
 * keeps in step.
 *
 *   node scripts/version.ts                 show the version and whether every copy agrees
 *   node scripts/version.ts --check         the same, exit 1 if they disagree (for CI)
 *   node scripts/version.ts patch|minor|major|<x.y.z[-pre]>   set a new version everywhere
 *
 * A bump also writes the changelog: commits since the last `vX.Y.Z` tag (feat, fix, perf) and
 * whatever stands under `## Unreleased` in docs/changelog.md become the new version's section.
 *
 * It never commits or tags; it prints the commands for that.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyRelease, notesFromSubjects } from './changelog.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = {
  pkg: `${root}package.json`,
  tauri: `${root}src-tauri/tauri.conf.json`,
  cargo: `${root}src-tauri/Cargo.toml`,
  lock: `${root}src-tauri/Cargo.lock`,
  changelog: `${root}docs/changelog.md`,
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
// The first `version = "…"` in Cargo.toml is the [package] one: it comes before any dependency table.
const CARGO_VERSION = /^(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m
const LOCK_VERSION = /(\[\[package\]\]\r?\nname = "mango"\r?\nversion = ")([^"]+)(")/

const read = (path: string) => readFileSync(path, 'utf8')
const pkgVersion = () => JSON.parse(read(files.pkg)).version as string

function copies() {
  const tauri = JSON.parse(read(files.tauri)).version as string
  return {
    'package.json': pkgVersion(),
    'src-tauri/tauri.conf.json': tauri === '../package.json' ? pkgVersion() : `${tauri} (should be "../package.json")`,
    'src-tauri/Cargo.toml': read(files.cargo).match(CARGO_VERSION)?.[2] ?? '(not found)',
    'src-tauri/Cargo.lock': read(files.lock).match(LOCK_VERSION)?.[2] ?? '(not found)',
  }
}

function report() {
  const all = copies()
  const want = all['package.json']
  let ok = true
  for (const [file, v] of Object.entries(all)) {
    const same = v === want
    ok &&= same
    console.log(`${same ? '  ok ' : '  !! '} ${file.padEnd(26)} ${v}`)
  }
  return ok
}

function next(current: string, how: string): string {
  if (SEMVER.test(how)) return how
  const m = current.match(SEMVER)
  if (!m) throw new Error(`package.json has "${current}", which is not a version this script understands.`)
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (how === 'major') return `${maj + 1}.0.0`
  if (how === 'minor') return `${maj}.${min + 1}.0`
  // A patch bump of a prerelease finishes that release (1.2.0-beta.1 -> 1.2.0).
  if (how === 'patch') return m[4] ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`
  throw new Error(`"${how}" is neither patch, minor, major nor a version like 1.2.3 or 1.2.3-beta.1.`)
}

/** Replace the version in place, keeping the file's own formatting and line endings. */
function setIn(path: string, pattern: RegExp, version: string) {
  const text = read(path)
  if (!pattern.test(text)) throw new Error(`No version found in ${path}.`)
  writeFileSync(path, text.replace(pattern, `$1${version}$3`))
}

/** Subjects of the commits since the last desktop release tag, oldest first. */
function commitsSinceRelease(): string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const tag = git('tag', '--list', 'v[0-9]*', '--sort=-v:refname').split('\n')[0]
  const range = tag ? [`${tag}..HEAD`] : []
  return git('log', ...range, '--no-merges', '--reverse', '--format=%s').split('\n').filter(Boolean)
}

const arg = process.argv[2]

if (!arg || arg === '--check') {
  console.log(`Mango ${pkgVersion()}`)
  const ok = report()
  if (!ok) console.log('\nOut of step. Run `pnpm bump <version>` with the version you want to fix every copy.')
  process.exit(ok || arg !== '--check' ? 0 : 1)
}

try {
  const before = pkgVersion()
  const version = next(before, arg)
  setIn(files.pkg, /("version":\s*")([^"]+)(")/, version)
  setIn(files.cargo, CARGO_VERSION, version)
  setIn(files.lock, LOCK_VERSION, version)
  writeFileSync(files.changelog, applyRelease(read(files.changelog), version, notesFromSubjects(commitsSinceRelease())))
  const tauri = JSON.parse(read(files.tauri))
  if (tauri.version !== '../package.json') setIn(files.tauri, /("version":\s*")([^"]+)(")/, '../package.json')
  console.log(`Mango ${before} -> ${version}`)
  report()
  console.log('Changelog: docs/changelog.md has a section for it. Read it over before committing.')
  console.log(`\nTo release it:\n  git commit -am "chore(release): v${version}"\n  git tag v${version}`)
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
