import { fromBase64, splitNul, utf8Decode, utf8Encode } from './bytes'
import type { GitChange, GitChangeKind } from './types'

/**
 * The git side of the backend, ported from the desktop's `src-tauri/src/git.rs`: the pure parts
 * (porcelain v2 status, numstat, diff finishing, path and ref checks) and the batch script that
 * runs several commands in one SSH round trip (`run_all`).
 */

/** A diff larger than this is cut off with a marker line. */
export const DIFF_CAP = 400 * 1024
const DIFF_TRUNCATED = '\\ Diff truncated at 400 KB'

/** One file in `git status --porcelain=v2 -z` (the desktop's `GitFile`). */
export interface GitFile {
  path: string
  origPath: string | null
  /** Staged side: M, A, D, R or C. */
  index: string | null
  /** Working-tree side: M, D, `?` for untracked, `U` for a conflict. */
  worktree: string | null
  conflicted: boolean
}

export interface ParsedStatus {
  /** Full hash of HEAD; null on an unborn branch. */
  oid: string | null
  /** null when HEAD is detached. */
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

/** One side of an `XY` pair: `.` is unchanged, a type change shows as a modification. */
function side(code: string): string | null {
  if (code === '.' || code === ' ') return null
  return code === 'T' ? 'M' : code
}

/** Split once at each of the first `n - 1` spaces (Rust's `splitn(n, ' ')`). */
function splitn(s: string, n: number): string[] {
  const out: string[] = []
  let rest = s
  while (out.length < n - 1) {
    const at = rest.indexOf(' ')
    if (at < 0) break
    out.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  out.push(rest)
  return out
}

/** Parse `git status --porcelain=v2 --branch -z` (records end in NUL, paths are verbatim). */
export function parseStatus(bytes: Uint8Array): ParsedStatus {
  const out: ParsedStatus = { oid: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const records = splitNul(bytes).map(utf8Decode)
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    const kind = record[0]
    if (!kind) continue
    if (kind === '#') {
      const [, key, value] = splitn(record, 3)
      if (key === undefined || value === undefined) continue
      if (key === 'branch.oid' && value !== '(initial)') out.oid = value
      else if (key === 'branch.head' && value !== '(detached)') out.branch = value
      else if (key === 'branch.upstream') out.upstream = value
      else if (key === 'branch.ab') {
        for (const part of value.split(' ')) {
          if (part.startsWith('+')) out.ahead = Number.parseInt(part.slice(1), 10) || 0
          else if (part.startsWith('-')) out.behind = Number.parseInt(part.slice(1), 10) || 0
        }
      }
    } else if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const renamed = kind === '2'
      const want = renamed ? 10 : 9
      const fields = splitn(record, want)
      // The original path is its own record; take it even if this one is malformed.
      const orig = renamed ? records[++i] : undefined
      const xy = fields[1]
      const path = fields[fields.length - 1]
      if (xy === undefined || path === undefined || xy.length !== 2 || fields.length !== want) continue
      out.files.push({ path, origPath: orig ? orig : null, index: side(xy[0]!), worktree: side(xy[1]!), conflicted: false })
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = splitn(record, 11)
      if (fields.length !== 11) continue
      out.files.push({ path: fields[10]!, origPath: null, index: null, worktree: 'U', conflicted: true })
    } else if (kind === '?') {
      const path = record.slice(2)
      if (path) out.files.push({ path, origPath: null, index: null, worktree: '?', conflicted: false })
    }
    // `!` (ignored) and anything unknown are skipped.
  }
  return out
}

/** Lines added and removed per path, from `git diff --numstat -z`; null for a binary file. */
export type Numstat = Map<string, { additions: number | null; deletions: number | null }>

/**
 * `git diff --numstat -z`: `added<TAB>removed<TAB>path NUL`, or for a rename
 * `added<TAB>removed<TAB> NUL old NUL new NUL`; `-` counts for binary files.
 */
export function parseNumstat(bytes: Uint8Array): Numstat {
  const out: Numstat = new Map()
  const parts = splitNul(bytes).map(utf8Decode)
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]!
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(rec)
    if (!m) continue
    let path = m[3]!
    if (!path) {
      // A rename: the old and new paths follow as records of their own.
      i += 2
      path = parts[i] ?? ''
      if (!path) continue
    }
    const n = (s: string) => (s === '-' ? null : Number.parseInt(s, 10))
    out.set(path, { additions: n(m[1]!), deletions: n(m[2]!) })
  }
  return out
}

/** Numstats added together (staged plus unstaged, on a branch with no commit yet). */
export function addNumstats(a: Numstat, b: Numstat): Numstat {
  const out: Numstat = new Map(a)
  for (const [path, s] of b) {
    const had = out.get(path)
    if (!had) out.set(path, s)
    else {
      const sum = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y)
      out.set(path, { additions: sum(had.additions, s.additions), deletions: sum(had.deletions, s.deletions) })
    }
  }
  return out
}

function kindOf(f: GitFile): GitChangeKind {
  if (f.conflicted) return 'conflicted'
  if (f.worktree === '?') return 'untracked'
  if (f.index === 'R' || f.index === 'C' || f.worktree === 'R') return 'renamed'
  if (f.worktree === 'D') return 'deleted'
  if (f.index === 'A') return 'added'
  if (f.index === 'D') return 'deleted'
  return 'modified'
}

/** The status' files as the phone shows them: one row per file, with its size when known. */
export function toChanges(files: GitFile[], stats: Numstat): GitChange[] {
  return files.map((f) => {
    const s = f.worktree === '?' || f.conflicted ? undefined : stats.get(f.path)
    const c: GitChange = {
      path: f.path,
      kind: kindOf(f),
      staged: f.index !== null && !f.conflicted,
      additions: s?.additions ?? null,
      deletions: s?.deletions ?? null,
    }
    if (f.origPath) c.from = f.origPath
    return c
  })
}

/** Captured diff bytes as text, cut at a line boundary with a marker line when capped. */
export function finishDiff(bytes: Uint8Array, truncated: boolean): string {
  if (!truncated) return utf8Decode(bytes)
  const end = bytes.lastIndexOf(10)
  const kept = end >= 0 ? bytes.subarray(0, end + 1) : new Uint8Array(0)
  return `${utf8Decode(kept)}${DIFF_TRUNCATED}\n`
}

/** Git's own "new file" header line, present before the first hunk. */
export function isNewFileDiff(diff: string): boolean {
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@')) return false
    if (l.startsWith('new file mode ')) return true
  }
  return false
}

/** A path relative to the repository root that cannot escape it; throws otherwise. */
export function cleanRel(file: string): string {
  const bad = () => new Error(`"${file}" is not a path inside the repository`)
  if (!file || file.includes('\0') || file.startsWith('/') || file.startsWith('\\')) throw bad()
  // Like Rust's `Path::components` on Unix: only normal parts (and `.`) may appear.
  if (file.split('/').some(p => p === '..')) throw bad()
  return file
}

/** A ref name that is safe to hand to git as an argument; throws otherwise. */
export function safeRef(name: string): string {
  const n = name.trim()
  if (!n) throw new Error('Enter a branch name')
  if (n.startsWith('-') || /\s/.test(n) || n.includes('..')) throw new Error(`"${n}" is not a valid branch name`)
  return n
}

/** Git redraws progress with `\r`; keep only the final state of each line. */
export function tidyOutput(text: string): string {
  return text
    .split(/\n/)
    .map(l => (l.split('\r').pop() ?? l).trimEnd())
    .filter(l => l.length > 0)
    .join('\n')
}

/** Add a plain-language first line to the push failures people actually hit (`explain_sync_failure`). */
export function explainSyncFailure(detail: string): string {
  const lower = detail.toLowerCase()
  let lead: string
  if (lower.includes('terminal prompts disabled') || lower.includes('authentication failed') || lower.includes('permission denied (publickey')) {
    lead = "The remote asked for credentials Mango can't enter. Sign in from a terminal first (a credential helper, `gh auth login`, or an SSH key), then try again."
  } else if (lower.includes('non-fast-forward') || lower.includes('fetch first')) {
    lead = "The remote has commits you don't have yet. Pull, then push again."
  } else if (lower.includes('could not resolve host') || lower.includes('could not read from remote')) {
    lead = "Couldn't reach the remote. Check the connection and the remote's address."
  } else return detail
  return `${lead}\n\n${detail}`
}

export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/* ---------- several commands, one round trip ---------- */

/** Git's own options and environment for a command that can never wait for a terminal. */
export const GIT_ENV: [string, string][] = [
  // Never hang on a credential prompt nobody can see.
  ['GIT_TERMINAL_PROMPT', '0'],
  // File names are data, not glob patterns (`pages/[id].vue`).
  ['GIT_LITERAL_PATHSPECS', '1'],
]
export const GIT_OPTS = ['--no-pager', '-c', 'core.quotepath=off', '-c', 'color.ui=never']

/**
 * A read-only git command for the batch: `env … git …`. It doesn't take the index lock
 * (`GIT_OPTIONAL_LOCKS=0`), so polling never collides with the agent's own git.
 */
export function gitRead(args: readonly string[]): string[] {
  return ['env', ...GIT_ENV.map(([k, v]) => `${k}=${v}`), 'GIT_OPTIONAL_LOCKS=0', 'git', ...GIT_OPTS, ...args]
}

/** One command's result, as the desktop's `Output`. */
export interface Output {
  code: number | null
  stdout: Uint8Array
  stderr: Uint8Array
  /** stdout hit its cap and the rest was dropped. */
  truncated: boolean
}

export const ok = (o: Output) => o.code === 0
export const text = (o: Output) => utf8Decode(o.stdout)
export const lineOf = (o: Output) => text(o).replace(/[\r\n]+$/, '')
/** stderr then stdout, cleaned up for display, or what failed. */
export function errorOf(o: Output, what: string): string {
  const detail = tidyOutput(`${utf8Decode(o.stderr)}\n${utf8Decode(o.stdout)}`)
  if (detail) return detail
  return o.code === null ? `${what} was interrupted` : `${what} failed (exit code ${o.code})`
}

/** A captured string as an `Output` (for single commands run without the batch). */
export function outputOf(code: number | null, stdout: string, stderr: string): Output {
  return { code, stdout: utf8Encode(stdout), stderr: utf8Encode(stderr), truncated: false }
}

/**
 * `bash` script behind `runAll`: its arguments are, per command, the number of words, the most
 * stdout to send back, then the words. Each command prints a header
 * (`MANGO-RUN <exit code> <stdout bytes> <stderr bytes>`), then its stdout (up to the cap) and
 * stderr, each base64 on a line of its own. Same idea and header as the desktop's `BATCH`, but
 * base64 keeps the bytes exact through the SSH module's text decoding, where the desktop reads
 * raw bytes. Stdout is cut at the source, so a huge diff never lands in full on the instance's
 * disk; the size in the header is then one past the cap. It all goes out in one write at the end.
 */
export const BATCH = `command -v base64 >/dev/null 2>&1 || { echo MANGO-ERR:nobase64; exit 0; }
d=$(mktemp -d) || exit 1
trap 'rm -rf -- "$d"' EXIT
while [ "$#" -gt 0 ]; do
  n=$1 cap=$2
  shift 2
  # One byte past the cap tells a cut-off answer apart; the command stops once head has it.
  "\${@:1:$n}" 2>"$d/e" </dev/null | head -c "$((cap + 1))" >"$d/o"
  c=\${PIPESTATUS[0]}
  shift "$n"
  {
    printf 'MANGO-RUN %s %s %s\\n' "$c" $(wc -c <"$d/o") $(wc -c <"$d/e")
    head -c "$cap" "$d/o" | base64 | tr -d '\\n'; echo
    head -c 65536 "$d/e" | base64 | tr -d '\\n'; echo
  } >>"$d/all" || exit 1
done
cat "$d/all"`

/** How much of each command's stderr `BATCH` sends back. */
const STDERR_CAP = 65536

export interface BatchCmd {
  argv: string[]
  /** Most stdout to keep. */
  cap: number
}

/** The arguments of `BATCH` for `cmds`. */
export function batchArgs(cmds: readonly BatchCmd[]): string[] {
  const out: string[] = []
  for (const c of cmds) out.push(String(c.argv.length), String(Math.min(c.cap, 2 ** 40)), ...c.argv)
  return out
}

/** The outputs `BATCH` printed, one per command; null when they aren't all there. */
export function parseBatch(stdout: string, caps: readonly number[]): Output[] | null {
  // A login shell's profile may print something first.
  let at = stdout.indexOf('MANGO-RUN ')
  if (at < 0) return null
  const lines = stdout.slice(at).split('\n')
  const outs: Output[] = []
  let i = 0
  for (const cap of caps) {
    const head = lines[i]
    const outLine = lines[i + 1]
    const errLine = lines[i + 2]
    if (head === undefined || outLine === undefined || errLine === undefined) return null
    const m = /^MANGO-RUN (-?\d+) +(\d+) +(\d+)\s*$/.exec(head)
    if (!m) return null
    const stdoutBytes = fromBase64(outLine.trim())
    const stderrBytes = fromBase64(errLine.trim())
    const outLen = Number(m[2])
    const errLen = Number(m[3])
    // Every byte the header announces must be there, or the answer was cut off.
    if (!stdoutBytes || !stderrBytes || stdoutBytes.length !== Math.min(outLen, cap) || stderrBytes.length !== Math.min(errLen, STDERR_CAP)) return null
    outs.push({ code: Number(m[1]), stdout: stdoutBytes, stderr: stderrBytes, truncated: outLen > cap })
    i += 3
  }
  return outs
}

/* ---------- scripts that run in a work tree ---------- */

/**
 * `sh` script: an untracked (or, on a branch with no commit, any) file as an added one, `$1` =
 * the file. A real folder (a nested repository) and a missing file give no diff. `--no-index`
 * exits 1 when the sides differ, the expected case, so that is turned into 0.
 */
export const UNTRACKED_DIFF = `f=$1
if [ -d "$f" ] && [ ! -L "$f" ]; then exit 0; fi
if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 0; fi
git ${GIT_OPTS.join(' ')} diff --no-color --no-ext-diff --no-index -- /dev/null "$f"
c=$?
[ "$c" = 1 ] && exit 0
exit "$c"`

/**
 * `sh` script (login shell, in the work tree root) staging and committing in one round trip:
 * `$1` is `all` (stage everything) or `some` (stage the files that follow); the message is on
 * stdin. Exit 3: staging failed, 4: the commit failed (both with git's own words on stderr).
 * On success, prints the new commit's short hash.
 */
export const COMMIT = `g() { git ${GIT_OPTS.join(' ')} "$@"; }
what=$1
shift
if [ "$what" = all ]; then g add -A || exit 3; else g add -A -- "$@" || exit 3; fi
g commit -q -F - || exit 4
g rev-parse --short HEAD`
