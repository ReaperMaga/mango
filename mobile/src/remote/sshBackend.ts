import type { AgentId } from '~/types/chat'
import type { AgentTransport, SpawnFn } from '~/agents/types'
import { envPath } from '~/utils/envPath'
import type { RunResult, SshApi } from '@/ssh/types'
import { startRemoteRun, type RemoteRun } from './agentRun'
import { fromBase64, splitNul, utf8Decode } from './bytes'
import {
  BATCH, COMMIT, DIFF_CAP, GIT_ENV, GIT_OPTS, UNTRACKED_DIFF,
  addNumstats, batchArgs, cleanRel, count, errorOf, explainSyncFailure, explainWorktreeAdd, finishDiff, gitRead,
  lineOf, ok, parseBatch, parseBranchRefs, parseNumstat, parseStatus, parseWorktrees, safeRef, text, tidyOutput, toChanges,
  worktreeAddArgs, worktreeFolder,
  type BatchCmd, type GitFile, type Numstat, type Output, type RawWorktree,
} from './git'
import {
  AGENT_HOME, asAgent, asAgentPlain, inInstance, line, remotePrefix, utcText,
  validEnvKey, validInstance, validInstanceDir,
} from './shell'
import { IMAGE_READ, MAX_IMAGE_BYTES, checkedPicturePath, parsePicture } from './images'
import { GH_ENV, ghFailure, ghItemArgv, parseGhItem } from './github'
import type {
  Env, EnvRemote, GitState, GitWorktree, GitWorktreeList, Instance, InstanceState, RemoteBackend, RemoteChatEntry, RemoteProject, RemotePut,
} from './types'

/**
 * `RemoteBackend` over SSH, a port of what the desktop runs in an environment: the chat scripts
 * of `chats_remote.rs`, the git reads and writes of `git.rs` (through its `EnvAt`), instance
 * listing from `envs/incus.rs`, and agent runs from `agent_proc.rs::remote`.
 *
 * Round trips are the cost to watch (a phone is often on a distant network): reads that would
 * run one after another go in one SSH call (`runAll`), and reads skip the login shell
 * (`runPlain`) unless a tool turns out to be found only through it. Every value from the UI
 * passes a validator and reaches the remote shell only quoted (`shell.ts`).
 */

/** Captured commands finish quickly; this only catches a stuck one. */
const LOCAL_TIMEOUT = 120_000
/** Push and commit (hooks may run a test suite). */
const SLOW_TIMEOUT = 600_000
const MAX_IDS = 500

export interface SshBackendDeps {
  ssh: SshApi
  /** A fresh unique id (run tags). */
  newId: () => string
  /** Unix ms; tests pin it. */
  now?: () => number
}

/** Where a command runs: a folder inside an instance of an env (the desktop's `EnvAt`). */
interface Place {
  env: Env
  instance: string
  dir: string
}

/* ---------- errors a person can act on ---------- */

/** `true` for 100.64.0.0/10, the range Tailscale hands out. */
export function isTailnet(ip: string): boolean {
  const [a, b] = ip.split('.').map(p => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  return a === 100 && b !== undefined && b >= 64 && b <= 127
}

const SIGN_IN_REFUSED = ['permission denied (', 'too many authentication failures', 'authentication failed', 'auth fail', 'all authentication methods']
const HOST_KEY_CHANGED = ['host key verification failed', 'remote host identification has changed', 'host key mismatch', 'host key does not match', 'unexpected host key']
const UNREACHABLE = [
  'connection refused', 'connection timed out', 'operation timed out', 'timed out', 'no route to host',
  'network is unreachable', 'could not resolve hostname', 'connection reset', 'connection closed by',
  'host is down', 'name or service not known', 'nodename nor servname', 'not connected to the internet',
]
const has = (lower: string, list: readonly string[]) => list.some(p => lower.includes(p))

/**
 * A message a person can act on, from a failed SSH or `incus` run (the desktop's `ssh::explain`).
 * `code` 255 stands for SSH itself failing, as OpenSSH reports it; a rejection from the SSH
 * module is explained as one (`transportError`).
 */
export function explain(env: Env, code: number | null, stderr: string, stdout: string, now = Date.now()): string {
  const text = stderr.trim() ? stderr : stdout
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const tail = lines.slice(-4).join('\n')
  const withTail = (m: string) => (tail ? `${m}\n${tail}` : m)
  if (env.joined) {
    const m = explainDirect(env, code, text.toLowerCase(), tail, now)
    if (m) return m
  }
  const lower = tail.toLowerCase()
  if (code === 255 || lower.includes('permission denied (') || lower.includes('could not resolve hostname')) {
    if (has(lower, SIGN_IN_REFUSED) || lower.includes('permission denied')) {
      return withTail(`${env.name} refused the SSH sign-in. Check that this phone's public key is in ~/.ssh/authorized_keys of ${env.endpoint.user} on the server.`)
    }
    if (has(lower, HOST_KEY_CHANGED)) {
      return withTail(`${env.name}'s identity changed since this phone trusted it, so Mango did not connect: the server may have been reinstalled, or someone is in between. If you know why, remove the server and add it again.`)
    }
    if (has(lower, UNREACHABLE)) {
      return withTail(`Could not reach ${env.name} at ${env.endpoint.host} port ${env.endpoint.port}. Check this phone's connection, and that the server is up.`)
    }
    return withTail(`Could not connect to ${env.name} over SSH.`)
  }
  if (lower.includes('incus: command not found') || lower.includes('incus: not found')) {
    return `${env.name} has no \`incus\` command. Install the Incus client on the server, or pick another server.`
  }
  if (!tail) return `The command on ${env.name} failed (exit ${code ?? '?'}).`
  return tail
}

/** `explain` for a joined environment, where the usual advice does not apply. `lower` is all of the output. */
function explainDirect(env: Env, code: number | null, lower: string, tail: string, now: number): string | null {
  const d = env.joined
  if (!d) return null
  const ended = d.expiresAt !== null && d.expiresAt <= now ? d.expiresAt : null
  const ask = `Ask whoever shared it (${d.sharedFrom}) for a new link.`
  if (lower.includes('sudo: a password is required') || lower.includes('sudo: a terminal is required')) {
    return `The agent user in ${env.name} may not use sudo without a password, which Mango needs for this. Ask the owner to install (or update) the Base system component.`
  }
  // 255 is SSH itself failing; anything else came from inside.
  if (code !== 255) return null
  if (has(lower, HOST_KEY_CHANGED)) {
    return `The environment's identity changed since the link was made, so Mango did not connect to ${env.name}: it may have been rebuilt, or someone is in between. ${ask}`
  }
  if (has(lower, SIGN_IN_REFUSED)) {
    return ended !== null
      ? `Your access to ${env.name} ended on ${utcText(ended)}. ${ask}`
      : `${env.name} no longer accepts this link: access was probably revoked. ${ask}`
  }
  let m: string
  if (has(lower, UNREACHABLE)) {
    const host = env.endpoint.host
    m = `Could not reach ${env.name} at ${host} port ${env.endpoint.port}.`
    if (ended !== null) m += ` Access ended on ${utcText(ended)}.`
    else if (isTailnet(host) || host.endsWith('.ts.net')) m += " It is shared over Tailscale: check that this phone is on the owner's tailnet and Tailscale is running."
    else m += ' The environment may be stopped, or a firewall blocks that port: ask whoever shared it to check.'
  } else m = `Could not connect to ${env.name} over SSH.`
  return tail ? `${m}\n${tail}` : m
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A rejection from the SSH module (no connection, refused sign-in, timeout…), explained. */
export function transportError(env: Env, e: unknown, now = Date.now()): Error {
  return new Error(explain(env, 255, messageOf(e), '', now))
}

/** Messages of the SSH module (`SshErrors.swift`) and OpenSSH that mean the network let us down. */
const CONNECTION_LOST = [
  ...UNREACHABLE, 'could not reach', 'unreachable', 'connection was closed', 'was reset', 'network connection was lost',
  'offline', 'broken pipe', 'software caused connection abort',
]

/**
 * Whether a rejection from the SSH module means the connection failed (no network, a timeout,
 * a reset) rather than the server saying no (sign-in refused, a changed host key): the first
 * is worth waiting out, the second needs the person.
 */
export function isConnectionLoss(e: unknown): boolean {
  const lower = messageOf(e).toLowerCase()
  if (has(lower, SIGN_IN_REFUSED) || has(lower, HOST_KEY_CHANGED) || lower.includes('identity changed')) return false
  return has(lower, CONNECTION_LOST)
}

/* ---------- agent runs ---------- */

/** The environment variable that marks every process of one run. */
export const RUN_TAG = 'MANGO_RUN'

/**
 * `sh -c` script, `$1` = run id (the desktop's `STOP_SCRIPT`). Finds the tagged processes
 * through `/proc/*\/environ`, adds their descendants, TERMs them, and KILLs any still there
 * after ~3 s. Closing the SSH channel alone does not reliably stop a CLI in the instance.
 */
export const STOP_SCRIPT = `tag="MANGO_RUN=$1"
tree() {
  roots=""
  for d in /proc/[0-9]*; do
    grep -qzxF -- "$tag" "$d/environ" 2>/dev/null && roots="$roots \${d#/proc/}"
  done
  [ -n "$roots" ] || return 0
  cat /proc/[0-9]*/status 2>/dev/null | awk -v roots="$roots" '
    /^Pid:/ { pid = $2 }
    /^PPid:/ { parent[pid] = $2 }
    END {
      n = split(roots, r, " "); for (i = 1; i <= n; i++) keep[r[i]] = 1
      do { more = 0; for (p in parent) if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; more = 1 } } while (more)
      for (p in keep) print p
    }'
}
pids=$(tree)
[ -n "$pids" ] || exit 0
kill -TERM $pids 2>/dev/null
i=0
while [ $i -lt 12 ]; do
  sleep 0.25
  pids=$(tree)
  [ -n "$pids" ] || exit 0
  i=$((i + 1))
done
kill -KILL $pids 2>/dev/null
exit 0`

/** The binary name for a known agent id. Anything else is refused. */
export function binaryFor(agent: string): string {
  if (agent === 'claude' || agent === 'codex') return agent
  throw new Error(`Unknown agent "${agent}"`)
}

/** The remote argv of `STOP_SCRIPT` for one run. Root (`sudo -n` when joined) sees every process. */
export function stopLine(env: Env, instance: string, runId: string): string[] {
  return inInstance(env, instance, 'batch', ['sh', '-c', STOP_SCRIPT, 'mango-stop', runId])
}

/**
 * An agent run that outlives the connection (the desktop's `RUN_SCRIPT` in `agent_proc.rs`, the
 * same text: a test compares them). `sh -c` script, `$0` = mango-run, `$1` = start | attach |
 * close, `$2` = run id. The client side is `agentRun.ts`.
 */
export const RUN_SCRIPT = `# mango-run: an agent run that outlives the connection. $1 = start | attach | close, $2 = run id.
# start <id> <program> <args…>: start the run detached, then attach from the beginning.
# attach <id> <out offset> <err offset>: stream its stdout and stderr from those byte offsets,
#   feed this stdin to it, and end with the line "mango-run:exit <code>" on stderr. Offsets count
#   only bytes after the line "mango-run:attached" each stream starts with (a login shell may print first).
# close <id>: end its input.
mode=$1 id=$2
shift 2
case $id in ''|*[!A-Za-z0-9-]*) echo "Mango: bad run id." >&2; exit 2 ;; esac
base="$HOME/.cache/mango/runs" dir="$HOME/.cache/mango/runs/$id"
gone() { echo "mango-run:gone" >&2; exit 1; }
case $mode in
start)
  umask 077
  mkdir -p "$base" || exit 1
  find "$base" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null
  mkdir "$dir" && mkfifo "$dir/in" && : >"$dir/out" && : >"$dir/err" && touch "$dir/alive" || exit 1
  setsid sh -c '
    dir=$1; shift
    echo $$ >"$dir/pid.tmp" && mv "$dir/pid.tmp" "$dir/pid"
    exec 3<>"$dir/in"
    "$@" <"$dir/in" >>"$dir/out" 2>>"$dir/err" 3>&- &
    pid=$! stopped=
    while kill -0 $pid 2>/dev/null; do
      sleep 1
      [ -e "$dir/closed" ] && exec 3>&-
      if [ -z "$stopped" ] && [ -n "$(find "$dir/alive" -mmin +30 2>/dev/null)" ]; then
        echo "Mango: nothing was connected to this run for 30 minutes, so it was stopped." >>"$dir/err"
        kill -TERM $pid; stopped=1
      fi
    done
    wait $pid; echo $? >"$dir/code.tmp" && mv "$dir/code.tmp" "$dir/code"
  ' mango-runner "$dir" "$@" </dev/null >/dev/null 2>&1 &
  i=0
  while [ ! -e "$dir/pid" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  set -- 0 0
  ;;
attach) ;;
close) [ -d "$dir" ] || gone; touch "$dir/closed"; exit 0 ;;
*) exit 2 ;;
esac
[ -e "$dir/pid" ] || gone
pid=$(cat "$dir/pid")
touch "$dir/alive"
exec 4<&0
feed=
if [ ! -e "$dir/closed" ]; then cat <&4 >"$dir/in" 2>/dev/null & feed=$!; fi
( while kill -0 $$ 2>/dev/null; do
    touch "$dir/alive"
    [ -n "$feed" ] && [ -e "$dir/closed" ] && kill $feed 2>/dev/null
    sleep 1
  done ) </dev/null >/dev/null 2>&1 &
beat=$!
echo "mango-run:attached"
echo "mango-run:attached" >&2
tail -c +$(($2 + 1)) --pid="$pid" -f "$dir/err" >&2 &
e=$!
tail -c +$(($1 + 1)) --pid="$pid" -f "$dir/out"
wait $e
kill $beat $feed 2>/dev/null
i=0
while [ ! -e "$dir/code" ] && [ $i -lt 25 ]; do sleep 0.2; i=$((i + 1)); done
code=$(cat "$dir/code" 2>/dev/null)
echo "mango-run:exit \${code:-143}" >&2
exit "\${code:-143}"
`

/** The variables of a run, checked and in a stable order, its tag last. */
function runVars(vars: Record<string, string> | undefined, runId: string): [string, string][] {
  const list: [string, string][] = []
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (!validEnvKey(k) || k === RUN_TAG) throw new Error(`"${k}" can't be passed to an agent in an environment.`)
    if (v.includes('\0')) throw new Error(`The value of ${k} contains a NUL character.`)
    list.push([k, v])
  }
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  list.push([RUN_TAG, runId])
  return list
}

/** A run id as `RUN_SCRIPT` takes it (it checks again). */
function validRunId(runId: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error('That run id is not valid.')
}

/**
 * The remote argv starting `program args…` as the agent user inside `instance`, from `cwd`
 * (the agent's home when empty), tagged with the run id: `RUN_SCRIPT start`, which starts it
 * detached and attaches to it from the beginning.
 */
export function spawnLine(
  env: Env, instance: string, cwd: string, vars: Record<string, string> | undefined, runId: string, program: string, args: readonly string[],
): string[] {
  validInstance(instance)
  validRunId(runId)
  const dir = cwd.trim()
  if (dir) validInstanceDir(dir)
  const list = runVars(vars, runId)
  if (args.some(a => a.includes('\0'))) throw new Error('An argument for the agent contains a NUL character.')
  return inInstance(env, instance, 'batch', asAgent(dir || null, list, ['sh', '-c', RUN_SCRIPT, 'mango-run', 'start', runId, program, ...args]))
}

/**
 * Attach to a run again after a dropped connection, its output resumed from these byte counts
 * (`RUN_SCRIPT attach`). From the agent's home, where the run's files are: the project folder
 * may have gone meanwhile.
 */
export function attachLine(env: Env, instance: string, runId: string, outBytes: number, errBytes: number): string[] {
  validInstance(instance)
  validRunId(runId)
  if (!Number.isSafeInteger(outBytes) || outBytes < 0 || !Number.isSafeInteger(errBytes) || errBytes < 0) throw new Error('Bad output offsets.')
  return inInstance(env, instance, 'batch', asAgent(null, [[RUN_TAG, runId]], ['sh', '-c', RUN_SCRIPT, 'mango-run', 'attach', runId, String(outBytes), String(errBytes)]))
}

/** End a run's stdin (`RUN_SCRIPT close`). */
export function closeLine(env: Env, instance: string, runId: string): string[] {
  validInstance(instance)
  validRunId(runId)
  return inInstance(env, instance, 'batch', asAgent(null, [[RUN_TAG, runId]], ['sh', '-c', RUN_SCRIPT, 'mango-run', 'close', runId]))
}

/**
 * A `Mango: …` line explaining why a remote run ended, when it is not already clear from what
 * it printed (the desktop's `remote::hint`). `stderr` is its last stderr lines. A dropped
 * connection is not an end any more (the run is attached again), so it needs no words here.
 */
export function hint(env: Env, instance: string, program: string, code: number | null, stderr: string, sawStdout: boolean): string | null {
  const lower = stderr.toLowerCase()
  const first = (s: string) => s.split('\n')[0] ?? ''
  if (sawStdout) return null
  if (code === 255) return `Mango: ${first(explain(env, code, stderr, ''))}`
  if (lower.includes('incus: command not found') || lower.includes('incus: not found')) {
    return `Mango: ${first(explain(env, code, stderr, ''))}`
  }
  if (lower.includes('instance is not running')) {
    return `Mango: the environment ${instance} is not running. Start it under Environments, then try again.`
  }
  if (lower.includes('instance not found') || lower.includes('error: not found')) {
    return `Mango: there is no environment named ${instance} on ${env.name} any more.`
  }
  if (code === 127 && lower.includes(`${program}: not found`)) {
    return `Mango: ${program} is not installed in the environment ${instance}. Install it from the environment's components, then try again.`
  }
  return null
}

/* ---------- chats kept in the environment (`chats_remote.rs`) ---------- */

/** A file name as an attachment keeps it: one path segment, no hidden-file or option tricks. */
export function validAttachmentName(name: string): void {
  // eslint-disable-next-line no-control-regex
  const ok = name.length > 0 && name.length <= 200 && !/[/\\\u0000-\u001f\u007f]/.test(name) && !name.startsWith('.') && !name.startsWith('-')
  if (!ok) throw new Error(`"${name}" can't be used as a file name in the environment.`)
}

export function validChatId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`${JSON.stringify(id)} is not a chat id.`)
}

function idsChecked(ids: readonly string[]): void {
  if (ids.length > MAX_IDS) throw new Error(`At most ${MAX_IDS} chats at a time.`)
  ids.forEach(validChatId)
}

export const LIST = `
d="$HOME/.local/share/mango/chats"
[ -d "$d" ] || exit 0
cd "$d" || exit 1
for f in *.at; do [ -f "$f" ] && { printf '%s ' "\${f%.at}"; head -n 1 -- "$f"; }; done
for f in *.gone; do [ -f "$f" ] && printf '%s -\\n' "\${f%.gone}"; done
exit 0
`

/** The chats `LIST` printed; a tombstone wins over a copy left behind (a delete cut off half way). */
export function parseList(text: string): RemoteChatEntry[] {
  const out: RemoteChatEntry[] = []
  for (const l of text.split('\n')) {
    const at = l.indexOf(' ')
    if (at < 0) continue
    const id = l.slice(0, at)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue
    const v = l.slice(at + 1).trim()
    let rev: number | null
    if (v === '-') rev = null
    else if (/^[+-]?\d+$/.test(v) && Number.isSafeInteger(Number(v))) rev = Number(v)
    else continue
    const e = out.find(x => x.id === id)
    if (e) { if (rev === null) e.rev = null }
    else out.push({ id, rev })
  }
  return out
}

export const FETCH = `
d="$HOME/.local/share/mango/chats"
cd "$d" 2>/dev/null || exit 0
for id; do [ -f "$id.json" ] && { cat -- "$id.json"; printf '\\0'; }; done
exit 0
`

const isJson = (s: string) => { try { JSON.parse(s); return true } catch { return false } }

/** The NUL-separated chats `FETCH` printed (JSON never holds a raw NUL), only valid JSON. */
export function parseFetch(text: string): string[] {
  return text.split('\0').filter(c => c.length > 0 && isJson(c))
}

export const PUT = `
d="$HOME/.local/share/mango/chats"
mkdir -p "$d" && chmod 700 "$d" && cd "$d" || exit 1
if [ -f "$1.gone" ]; then cat >/dev/null; echo gone; exit 0; fi
if [ -f "$1.at" ]; then
  have=$(head -n 1 -- "$1.at")
  case "$have" in ''|*[!0-9]*) ;; *) if [ "$have" -gt "$2" ]; then cat >/dev/null; echo stale; exit 0; fi ;; esac
fi
cat > ".$1.tmp" && mv -f ".$1.tmp" "$1.json" && printf '%s\\n' "$3" > ".$1.at.tmp" && mv -f ".$1.at.tmp" "$1.at" || exit 1
echo ok
`

/** Attachments: `$1` the attachment id, `$2` its file name; the bytes come base64 on stdin. */
export const ATTACH = `
d="$HOME/.local/share/mango/attachments"
mkdir -p "$d/$1" && chmod 700 "$d" "$d/$1" && cd "$d/$1" || exit 1
base64 -d > ".$2.part" && mv -f -- ".$2.part" "$2" || { rm -f -- ".$2.part"; exit 1; }
printf '%s/%s\\n' "$PWD" "$2"
`

export const REMOVE = `
d="$HOME/.local/share/mango/chats"
mkdir -p "$d" && chmod 700 "$d" && cd "$d" || exit 1
for id; do : > "$id.gone" && rm -f -- "$id.json" "$id.at" || exit 1; done
`

/* ---------- instances (`envs/incus.rs`) ---------- */

function stateOf(s: string): InstanceState {
  switch (s.toLowerCase()) {
    case 'running': case 'ready': case 'thawed': return 'running'
    case 'stopped': return 'stopped'
    case 'starting': return 'starting'
    case 'stopping': case 'aborting': return 'stopping'
    case 'frozen': case 'freezing': return 'frozen'
    case 'error': case 'broken': return 'error'
    default: return 'unknown'
  }
}

/** `incus list --format json` to instances. */
export function parseInstances(json: string): Instance[] {
  let v: unknown
  try { v = JSON.parse(json) } catch (e) { throw new Error(`The server's instance list was not readable: ${messageOf(e)}`) }
  if (!Array.isArray(v)) throw new Error("The server's instance list was not readable.")
  const out: Instance[] = []
  for (const inst of v as Record<string, unknown>[]) {
    if (!inst || typeof inst.name !== 'string') continue
    const st = inst.state && typeof inst.state === 'object' ? (inst.state as Record<string, unknown>) : null
    const status = typeof st?.status === 'string' ? st.status : typeof inst.status === 'string' ? inst.status : null
    out.push({ name: inst.name, state: status ? stateOf(status) : 'unknown', kind: typeof inst.type === 'string' ? inst.type : 'container' })
  }
  return out
}

/* ---------- projects ---------- */

/**
 * `bash -c` script (as the agent user, in its home): the git repositories under the home, at
 * most four folders deep, skipping hidden and dependency folders. One `MANGO-PROJECTS:<base64>`
 * line of NUL-terminated pairs, `<folder> NUL <branch or nothing> NUL`; the branch comes from
 * the repository's HEAD file, so git itself does not run. Names never pass through the shell as
 * code, and base64 keeps odd bytes intact.
 */
export const PROJECTS = `export LC_ALL=C
cd -- "$HOME" 2>/dev/null || { echo MANGO-ERR:home; exit 0; }
command -v base64 >/dev/null 2>&1 || { echo MANGO-ERR:nobase64; exit 0; }
list() {
  n=0
  find . -maxdepth 5 \\( -name .git -prune -print0 \\) -o \\( \\( -name '.?*' -o -name node_modules -o -name target -o -name vendor \\) -prune \\) 2>/dev/null |
  while IFS= read -r -d '' g; do
    n=$((n + 1))
    [ "$n" -gt 300 ] && break
    dir=\${g%/.git}
    case $dir in .) dir=$HOME ;; *) dir=$HOME/\${dir#./} ;; esac
    if [ -d "$g" ]; then gd=$g
    elif [ -f "$g" ]; then
      gd=$(sed -n 's/^gitdir: //p' "$g" | head -n 1)
      case $gd in /*) ;; *) gd=$(dirname -- "$g")/$gd ;; esac
    else continue
    fi
    head=$(head -n 1 -- "$gd/HEAD" 2>/dev/null)
    case $head in "ref: refs/heads/"*) b=\${head#ref: refs/heads/} ;; *) b= ;; esac
    printf '%s\\0%s\\0' "$dir" "$b"
  done
}
printf 'MANGO-PROJECTS:%s\\n' "$(list | base64 | tr -d '\\n')"`

/** What `PROJECTS` printed, as projects of `env`'s `instance` (outermost repositories only, by path). */
export function parseProjects(out: string, env: Env, instance: string): RemoteProject[] {
  const lines = out.split('\n').map(l => l.trim())
  const err = lines.find(l => l.startsWith('MANGO-ERR:'))
  if (err) {
    throw new Error(err === 'MANGO-ERR:nobase64'
      ? 'base64 is not installed in this environment. Install the base component first.'
      : `The agent user's home folder is missing in ${instance}.`)
  }
  const payload = [...lines].reverse().find(l => l.startsWith('MANGO-PROJECTS:'))
  const bytes = payload === undefined ? null : fromBase64(payload.slice('MANGO-PROJECTS:'.length))
  if (!bytes) throw new Error(`Could not list the projects in ${instance}.`)
  const parts = splitNul(bytes).map(utf8Decode)
  const found = new Map<string, string | null>()
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const dir = parts[i]!.replace(/\/+$/, '') || '/'
    try { validInstanceDir(dir) } catch { continue }
    if (!found.has(dir)) found.set(dir, parts[i + 1] || null)
  }
  const dirs = [...found.keys()].sort()
  // A submodule or a repository kept inside another is part of that project.
  const outer = dirs.filter(d => !dirs.some(o => o !== d && (o === '/' || d.startsWith(`${o}/`))))
  return outer.map(dir => ({
    path: envPath({ hostId: env.id, instance, dir }),
    name: dir.split('/').filter(Boolean).pop() ?? dir,
    branch: found.get(dir) ?? null,
  }))
}

/** Which agent CLIs the login shell finds. */
const AGENTS_SCRIPT = 'for c in claude codex; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done; exit 0'

/* ---------- env:// paths ---------- */

/** The parts of a remote project's path, validated like the desktop's `parse_env_path`. */
export function parseProjectPath(path: string): { hostId: string; instance: string; dir: string } {
  const bad = () => new Error(`"${path}" is not a remote project path.`)
  const t = path.trim()
  if (!t.startsWith('env://')) throw bad()
  const rest = t.slice('env://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) throw bad()
  const hostId = rest.slice(0, slash)
  const after = rest.slice(slash + 1)
  const at = after.indexOf('/')
  const instance = at < 0 ? after : after.slice(0, at)
  const dir = at < 0 ? '/' : after.slice(at)
  if (!/^[A-Za-z0-9-]{1,64}$/.test(hostId)) throw bad()
  validInstance(instance)
  validInstanceDir(dir)
  return { hostId, instance, dir }
}

/* ---------- the backend ---------- */

/** A command that failed because something it runs isn't on the plain PATH. */
function profileNeeded(code: number | null, stderr: string): boolean {
  return code !== 0 && (
    code === 127
    || stderr.includes(': command not found')
    || stderr.includes(': not found')
    || stderr.includes("'git': No such file")
    || stderr.split('\n').some(l => l.includes('cannot run ') && l.endsWith('No such file or directory'))
  )
}

function gitMissing(instance: string, code: number | null, stderr: string): string | null {
  const missing = code === 127 && (stderr.includes('git: command not found') || stderr.includes('git: not found') || stderr.includes("'git': No such file"))
  return missing
    ? `git is not installed in ${instance}. Install it there (for example \`sudo apt install git\` in its terminal), then try again.`
    : null
}

/** A failed command's own words (stderr, then stdout), or what failed (the desktop's `Output::error`). */
function failure(r: RunResult, what: string): string {
  const detail = tidyOutput(`${r.stderr}\n${r.stdout}`)
  if (detail) return detail
  return r.code === null ? `${what} was interrupted` : `${what} failed (exit code ${r.code})`
}

const NO_REMOTE = 'This repository has no remote yet. Add one first:\n  git remote add origin <url>'

export function createSshBackend(deps: SshBackendDeps): RemoteBackend {
  const { ssh, newId } = deps
  const now = deps.now ?? Date.now
  let lookup: (hostId: string) => Env | null = () => null
  /** Environments (env, instance) whose tools only the login shell finds. */
  const loginOnly = new Set<string>()
  /** Work tree roots of project folders, so an action costs one round trip instead of two. */
  const roots = new Map<string, string>()
  /** The last status of each project folder (renames and untracked files, for `gitDiff`). */
  const lastFiles = new Map<string, GitFile[]>()
  /** Endpoints used, so `reset()` can drop them all. */
  const used = new Map<string, Env>()
  /** Agent runs that may still need this backend: attached, reattaching, or owing a stop. */
  const runs = new Set<RemoteRun>()
  /** Until when (ms) a run that loses its channel attaches again at once: just after `reset()`. */
  let quickUntil = 0
  /** Envs whose connection failed (a run's dropped, or a command could not reach them), and who hears of it. */
  const unreachable = new Set<string>()
  /** Runs per env that are reattaching now: the env is not back while one still is. */
  const lostRuns = new Map<string, number>()
  const listeners = new Set<(envId: string, state: 'lost' | 'back') => void>()
  const tell = (envId: string, state: 'lost' | 'back') => {
    for (const l of listeners) {
      try { l(envId, state) } catch (e) { console.error('A connection listener failed:', e) }
    }
  }
  function down(envId: string) {
    if (unreachable.has(envId)) return
    unreachable.add(envId)
    tell(envId, 'lost')
  }
  function up(envId: string) {
    if (!unreachable.has(envId) || (lostRuns.get(envId) ?? 0) > 0) return
    unreachable.delete(envId)
    tell(envId, 'back')
  }

  const envById = (hostId: string): Env => {
    const env = lookup(hostId)
    if (!env) throw new Error("That environment is no longer in Mango's list. Add it again.")
    used.set(env.id, env)
    return env
  }

  const placeOf = (projectPath: string): Place => {
    const loc = parseProjectPath(projectPath)
    return { env: envById(loc.hostId), instance: loc.instance, dir: loc.dir }
  }

  const homeOf = (at: EnvRemote): Place => {
    validInstance(at.instance)
    return { env: envById(at.hostId), instance: at.instance, dir: AGENT_HOME }
  }

  /** Run a remote argv over the env's shared connection; a transport failure is explained. */
  async function runRemote(env: Env, argv: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    let r: RunResult
    try {
      r = await ssh.run(env.endpoint, line(argv), { timeoutMs: opts.timeoutMs ?? LOCAL_TIMEOUT, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) })
    } catch (e) {
      if (isConnectionLoss(e)) down(env.id)
      throw transportError(env, e, now())
    }
    up(env.id)
    return r
  }

  /** `runRemote`, its stdout on exit 0 and an explained error otherwise (the desktop's `ssh::run`). */
  async function runOk(env: Env, argv: string[], timeoutMs = 30_000): Promise<string> {
    const r = await runRemote(env, argv, { timeoutMs })
    if (r.code === 0) return r.stdout
    throw new Error(explain(env, r.code, r.stderr, r.stdout, now()))
  }

  const placeKey = (p: Place) => `${p.env.id}\0${p.instance}`

  /**
   * Run `argv` as the agent user in the place's folder. A connection or environment problem is
   * an error; anything else is the command's own result (the desktop's `EnvAt::exec_raw`).
   */
  async function execRaw(p: Place, login: boolean, vars: [string, string][], argv: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const inner = login ? asAgent(p.dir, vars, argv) : asAgentPlain(p.dir, vars, argv)
    const r = await runRemote(p.env, inInstance(p.env, p.instance, 'batch', inner), opts)
    if (r.code === 0) return r
    // incus says `Error: …` (instance stopped or gone), and sudo explains itself.
    if (r.stderr.split('\n').some(l => l.startsWith('Error: ') || l.startsWith('sudo: '))) {
      throw new Error(explain(p.env, r.code, r.stderr, '', now()))
    }
    const folder = r.stderr.split('\n').find(l => l.startsWith('Mango: the folder '))
    if (folder) throw new Error(`The folder ${folder.slice('Mango: the folder '.length)}`)
    return r
  }

  async function exec(p: Place, login: boolean, vars: [string, string][], argv: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const r = await execRaw(p, login, vars, argv, opts)
    const missing = gitMissing(p.instance, r.code, r.stderr)
    if (missing) throw new Error(missing)
    return r
  }

  /** `exec` without the login shell, falling back to it (for good) when a tool is missing on the plain PATH. */
  async function runPlain(p: Place, vars: [string, string][], argv: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    if (loginOnly.has(placeKey(p))) return exec(p, true, vars, argv, opts)
    const r = await execRaw(p, false, vars, argv, opts)
    if (!profileNeeded(r.code, r.stderr)) return r
    loginOnly.add(placeKey(p))
    return exec(p, true, vars, argv, opts)
  }

  /**
   * Run `cmds` in the place's folder and return each one's output, in order, in one SSH call;
   * a failing command doesn't stop the ones after it (the desktop's `run_all`).
   */
  async function runAll(p: Place, cmds: BatchCmd[], timeoutMs = LOCAL_TIMEOUT): Promise<Output[]> {
    const argv = ['bash', '-c', BATCH, 'mango', ...batchArgs(cmds)]
    const caps = cmds.map(c => Math.min(c.cap, 2 ** 40))
    const batch = async (login: boolean) => {
      const r = await exec(p, login, [], argv, { timeoutMs })
      if (r.stdout.includes('MANGO-ERR:nobase64')) throw new Error('base64 is not installed in this environment. Install the base component first.')
      const outs = parseBatch(r.stdout, caps)
      if (!outs) {
        const detail = tidyOutput(r.stderr)
        throw new Error(`Could not read git's answer from ${p.instance}.${detail ? `\n${detail}` : ''}`)
      }
      return outs
    }
    const key = placeKey(p)
    let outs = await batch(loginOnly.has(key))
    // git (or a tool it runs, like git-lfs) only on the login shell's PATH.
    if (!loginOnly.has(key) && outs.some(o => profileNeeded(o.code, utf8Decode(o.stderr)))) {
      loginOnly.add(key)
      outs = await batch(true)
    }
    for (const o of outs) {
      const missing = gitMissing(p.instance, o.code, utf8Decode(o.stderr))
      if (missing) throw new Error(missing)
    }
    return outs
  }

  const folderKey = (p: Place) => `${p.env.id}\0${p.instance}\0${p.dir}`

  /** The work tree root a git command needs, from the cache or one `rev-parse`. */
  async function rootOf(p: Place): Promise<Place> {
    const cached = roots.get(folderKey(p))
    if (cached) return { ...p, dir: cached }
    const [where] = await runAll(p, [{ argv: gitRead(['rev-parse', '--show-toplevel']), cap: 64 * 1024 }])
    const root = located(where!)
    if (!root) throw new Error(`${p.dir} in ${p.instance} is not inside a git repository`)
    roots.set(folderKey(p), root)
    return { ...p, dir: root }
  }

  /** The work tree root `rev-parse --show-toplevel` printed; null outside a repository. */
  function located(out: Output): string | null {
    const root = text(out).split('\n')[0]
    if (!root || !ok(out)) {
      const reason = utf8Decode(out.stderr)
      // Git refuses repositories owned by someone else; that is not "no repo".
      if (reason.includes('safe.directory')) throw new Error(tidyOutput(reason))
      return null
    }
    return root
  }

  /** What a chat script printed; a failure is an error (the desktop's `chats_remote::sh`). */
  async function chatScript(at: EnvRemote, script: string, args: string[], stdin?: string): Promise<string> {
    const p = homeOf(at)
    const r = await runPlain(p, [], ['sh', '-c', script, 'sh', ...args], { ...(stdin !== undefined ? { stdin } : {}) })
    if (r.code !== 0) throw new Error(`Could not reach the chats saved in ${at.instance}: ${failure(r, 'The command')}`)
    return r.stdout
  }

  const statusCmd = (untracked: boolean): BatchCmd => ({
    argv: gitRead(['status', '--porcelain=v2', '--branch', '-z', untracked ? '--untracked-files=all' : '--untracked-files=no']),
    cap: 64 * 1024 * 1024,
  })
  const numstatCmd = (...range: string[]): BatchCmd => ({
    argv: gitRead(['diff', '--numstat', '-z', '--no-color', '--no-ext-diff', '-M', ...range]),
    cap: 16 * 1024 * 1024,
  })

  const worktreeListCmd = (z: boolean): BatchCmd => ({ argv: gitRead(['worktree', 'list', '--porcelain', ...(z ? ['-z'] : [])]), cap: 4 * 1024 * 1024 })

  /**
   * The worktrees from a `worktree list -z` output. Git before 2.36 has no `-z` there; it gets
   * the line form in one more round trip (the desktop's `worktree_list`).
   */
  async function worktreesFrom(p: Place, out: Output): Promise<RawWorktree[]> {
    if (ok(out)) return parseWorktrees(text(out), '\0')
    if (!utf8Decode(out.stderr).includes('unknown switch')) throw new Error(errorOf(out, 'git worktree list'))
    const [plain] = await runAll(p, [worktreeListCmd(false)])
    if (!ok(plain!)) throw new Error(errorOf(plain!, 'git worktree list'))
    return parseWorktrees(text(plain!), '\n')
  }

  /** A worktree folder inside the instance as the `env://` path the chats use. */
  const worktreeOf = (p: Place, w: RawWorktree, isMain: boolean): GitWorktree =>
    ({ path: envPath({ hostId: p.env.id, instance: p.instance, dir: w.path }), branch: w.branch, isMain })

  const backend: RemoteBackend = {
    real: true,

    setEnvLookup(fn) {
      lookup = fn
    },

    async check(env) {
      used.set(env.id, env)
      // A server must also have the Incus client; a joined environment only has to answer.
      const script = env.joined
        ? 'exit 0'
        : 'command -v incus >/dev/null 2>&1 || { echo "incus: command not found" >&2; exit 127; }'
      await runOk(env, ['sh', '-c', script], 30_000)
    },

    async instances(env) {
      used.set(env.id, env)
      if (env.joined) {
        // Its one instance, which must answer (the desktop shows it as "unknown" instead).
        await runOk(env, ['sh', '-c', 'exit 0'], 20_000)
        return [{ name: env.joined.instance, state: 'running', kind: null }]
      }
      const prefix = remotePrefix(env)
      const out = await runOk(env, ['incus', 'list', ...(prefix ? [prefix] : []), '--format', 'json'], 30_000)
      return parseInstances(out)
    },

    async projects(env, instance) {
      used.set(env.id, env)
      validInstance(instance)
      const p: Place = { env, instance, dir: AGENT_HOME }
      const r = await runPlain(p, [], ['bash', '-c', PROJECTS, 'mango-projects'], { timeoutMs: 30_000 })
      if (r.code !== 0 && !r.stdout.includes('MANGO-')) throw new Error(explain(env, r.code, r.stderr, r.stdout, now()))
      return parseProjects(r.stdout, env, instance)
    },

    async agentsInstalled(env, instance) {
      used.set(env.id, env)
      validInstance(instance)
      const r = await exec({ env, instance, dir: AGENT_HOME }, true, [], ['sh', '-c', AGENTS_SCRIPT], { timeoutMs: 30_000 })
      if (r.code !== 0) throw new Error(explain(env, r.code, r.stderr, r.stdout, now()))
      const found = new Set(r.stdout.split('\n').map(l => l.trim()))
      return (['claude', 'codex'] as AgentId[]).filter(a => found.has(a))
    },

    async chatsList(at) {
      return parseList(await chatScript(at, LIST, []))
    },

    async chatsFetch(at, ids) {
      idsChecked(ids)
      if (!ids.length) return []
      return parseFetch(await chatScript(at, FETCH, [...ids]))
    },

    async chatsPut(at, id, base, rev, data) {
      validChatId(id)
      if (!Number.isSafeInteger(base) || !Number.isSafeInteger(rev) || base < 0 || rev <= base) {
        throw new Error("A chat's revision must be newer than the one it replaces.")
      }
      if (!isJson(data)) throw new Error(`Chat ${JSON.stringify(id)} was not saved: its data is not valid JSON.`)
      const answer = (await chatScript(at, PUT, [id, String(base), String(rev)], data)).replace(/[\r\n]+$/, '')
      if (answer === 'ok' || answer === 'stale' || answer === 'gone') return answer as RemotePut
      throw new Error(`Saving the chat in ${at.instance} gave an unexpected answer: ${answer}`)
    },

    async attachmentPut(at, id, name, data) {
      validChatId(id)
      validAttachmentName(name)
      const r = await runPlain(homeOf(at), [], ['sh', '-c', ATTACH, 'sh', id, name], { stdin: data, timeoutMs: 120_000 })
      if (r.code !== 0) throw new Error(`Could not put ${name} into ${at.instance}: ${failure(r, 'The upload')}`)
      const path = r.stdout.replace(/[\r\n]+$/, '')
      if (!path.startsWith('/') || !path.endsWith(`/${name}`)) throw new Error(`Putting ${name} into ${at.instance} gave an unexpected answer.`)
      return path
    },

    async chatsRemove(at, ids) {
      idsChecked(ids)
      if (!ids.length) return
      await chatScript(at, REMOVE, [...ids])
    },

    async gitState(projectPath): Promise<GitState> {
      const p = placeOf(projectPath)
      // Where, what and how much at once: one round trip. Outside a work tree they just fail.
      const [where, status, stats] = await runAll(p, [
        { argv: gitRead(['rev-parse', '--show-toplevel']), cap: 64 * 1024 },
        statusCmd(true),
        numstatCmd('HEAD'),
      ])
      const root = located(where!)
      if (!root) {
        roots.delete(folderKey(p))
        lastFiles.delete(projectPath)
        return { repo: false, branch: null, ahead: 0, behind: 0, upstream: false, changes: [] }
      }
      roots.set(folderKey(p), root)
      if (!ok(status!)) throw new Error(errorOf(status!, 'git status'))
      const parsed = parseStatus(status!.stdout)
      let sizes: Numstat = ok(stats!) ? parseNumstat(stats!.stdout) : new Map()
      if (parsed.oid === null && parsed.files.length) {
        // No commit yet, so no HEAD to compare with: staged plus unstaged.
        const [staged, unstaged] = await runAll({ ...p, dir: root }, [numstatCmd('--cached'), numstatCmd()])
        sizes = addNumstats(ok(staged!) ? parseNumstat(staged!.stdout) : new Map(), ok(unstaged!) ? parseNumstat(unstaged!.stdout) : new Map())
      }
      lastFiles.set(projectPath, parsed.files)
      return {
        repo: true,
        branch: parsed.branch,
        ahead: parsed.ahead,
        behind: parsed.behind,
        upstream: parsed.upstream !== null,
        changes: toChanges(parsed.files, sizes),
      }
    },

    async gitDiff(projectPath, file) {
      cleanRel(file)
      const p = placeOf(projectPath)
      const root = await rootOf(p)
      const known = lastFiles.get(projectPath)?.find(f => f.path === file)
      const untracked = (): BatchCmd => ({ argv: ['env', ...GIT_ENV.map(([k, v]) => `${k}=${v}`), 'sh', '-c', UNTRACKED_DIFF, 'sh', file], cap: DIFF_CAP })
      const diffText = (o: Output, what: string) => {
        // A capped diff ends git with a broken pipe; that is still a result.
        if (!ok(o) && !o.truncated) throw new Error(errorOf(o, what))
        return finishDiff(o.stdout, o.truncated)
      }
      if (known?.worktree === '?') {
        const [o] = await runAll(root, [untracked()])
        return diffText(o!, 'git diff')
      }
      // A rename shows as its two sides together, so only the real edits show.
      const paths = known?.origPath ? [cleanRel(known.origPath), file] : [file]
      const [diff, tracked, head] = await runAll(root, [
        { argv: gitRead(['diff', '--no-color', '--no-ext-diff', '-M', 'HEAD', '--', ...paths]), cap: DIFF_CAP },
        { argv: gitRead(['ls-files', '-z', '--', file]), cap: 64 * 1024 },
        { argv: gitRead(['rev-parse', '-q', '--verify', 'HEAD^{commit}']), cap: 1024 },
      ])
      const born = ok(head!)
      if (born) {
        const t = diffText(diff!, 'git diff')
        if (t) return t
        if (!ok(tracked!)) throw new Error(errorOf(tracked!, 'git ls-files'))
        if (tracked!.stdout.length) return ''
      }
      // Untracked, or no commit yet: the whole file is new.
      const [o] = await runAll(root, [untracked()])
      return diffText(o!, 'git diff')
    },

    async gitCommit(projectPath, message, files) {
      const p = placeOf(projectPath)
      const root = await rootOf(p)
      const msg = message.trim()
      if (!msg) throw new Error('Write a commit message first')
      const list = files ?? []
      list.forEach(cleanRel)
      const argv = ['sh', '-c', COMMIT, 'mango-commit', files ? 'some' : 'all', ...list]
      if (files && !list.length) throw new Error('Pick the files to commit first.')
      const r = await exec(root, true, GIT_ENV, argv, { stdin: `${msg}\n`, timeoutMs: SLOW_TIMEOUT })
      lastFiles.delete(projectPath)
      if (r.code === 0) {
        const last = r.stdout.split('\n').map(l => l.trim()).filter(Boolean).pop()
        return last ?? ''
      }
      if (r.code === 3) throw new Error(failure(r, 'git add'))
      // Work out why, without depending on the language of git's messages: one more round trip.
      const [status, identity, merging] = await runAll(root, [
        statusCmd(false),
        { argv: gitRead(['var', 'GIT_AUTHOR_IDENT']), cap: 64 * 1024 },
        { argv: gitRead(['rev-parse', '-q', '--verify', 'MERGE_HEAD']), cap: 1024 },
      ])
      const parsed = ok(status!) ? parseStatus(status!.stdout) : null
      const conflicts = parsed?.files.filter(f => f.conflicted).length ?? 0
      if (conflicts > 0) {
        const one = conflicts === 1
        throw new Error(`${conflicts} file${one ? '' : 's'} still ${one ? 'has' : 'have'} merge conflicts. Resolve and stage ${one ? 'it' : 'them'} before committing.`)
      }
      if (!ok(identity!)) {
        throw new Error("Git doesn't know who you are yet. Set your name and email in the environment's terminal, then commit again:\n  git config --global user.name \"Your Name\"\n  git config --global user.email you@example.com")
      }
      if (!ok(merging!) && parsed && !parsed.files.some(f => f.index !== null)) {
        throw new Error('Nothing is staged. Stage the changes you want in this commit first.')
      }
      throw new Error(failure(r, 'git commit'))
    },

    async gitPush(projectPath) {
      const p = placeOf(projectPath)
      const root = await rootOf(p)
      const [status, remotes, preferred] = await runAll(root, [
        statusCmd(false),
        { argv: gitRead(['remote']), cap: 64 * 1024 },
        { argv: gitRead(['config', '--get', 'remote.pushDefault']), cap: 4096 },
      ])
      if (!ok(status!)) throw new Error(errorOf(status!, 'git status'))
      const s = parseStatus(status!.stdout)
      if (!s.branch) throw new Error('HEAD is detached, so there is no branch to push. Switch to a branch first.')
      if (s.oid === null) throw new Error('There are no commits to push yet.')
      let args: string[]
      let remote: string | null = null
      if (s.upstream) args = ['push']
      else {
        // First push: publish the branch and start tracking it.
        if (!ok(remotes!)) throw new Error(errorOf(remotes!, 'git remote'))
        const all = text(remotes!).split('\n').map(l => l.trim()).filter(Boolean)
        const want = lineOf(preferred!)
        remote = all.includes(want) ? want : all.includes('origin') ? 'origin' : all[0] ?? null
        if (!remote) throw new Error(NO_REMOTE)
        args = ['push', '-u', remote, s.branch]
      }
      const r = await exec(root, true, GIT_ENV, ['git', ...GIT_OPTS, ...args], { timeoutMs: SLOW_TIMEOUT })
      if (r.code !== 0) {
        throw new Error(explainSyncFailure(failure(r, 'git push')))
      }
      if (s.upstream) {
        return s.ahead === 0
          ? `Nothing to push. ${s.upstream} already has every commit.`
          : `Pushed ${count(s.ahead, 'commit', 'commits')} to ${s.upstream}.`
      }
      return `Published ${s.branch} to ${remote}/${s.branch}.`
    },

    async gitWorktrees(projectPath): Promise<GitWorktreeList> {
      const p = placeOf(projectPath)
      const [where, list, heads] = await runAll(p, [
        { argv: gitRead(['rev-parse', '--show-toplevel']), cap: 64 * 1024 },
        worktreeListCmd(true),
        { argv: gitRead(['for-each-ref', '--format=%(refname)', 'refs/heads']), cap: 4 * 1024 * 1024 },
      ])
      const root = located(where!)
      if (!root) throw new Error(`${p.dir} in ${p.instance} is not inside a git repository`)
      roots.set(folderKey(p), root)
      const raw = await worktreesFrom({ ...p, dir: root }, list!)
      if (!ok(heads!)) throw new Error(errorOf(heads!, 'git for-each-ref'))
      return {
        worktrees: raw.map((w, i) => ({ w, i })).filter(({ w }) => !w.bare).map(({ w, i }) => worktreeOf(p, w, i === 0)),
        branches: parseBranchRefs(text(heads!)),
      }
    },

    async gitWorktreeAdd(projectPath, branch): Promise<GitWorktree> {
      const name = safeRef(branch)
      const p = placeOf(projectPath)
      // Where, the worktrees, and whether the name is free and valid: one round trip.
      const [where, list, valid, taken] = await runAll(p, [
        { argv: gitRead(['rev-parse', '--show-toplevel']), cap: 64 * 1024 },
        worktreeListCmd(true),
        { argv: gitRead(['check-ref-format', '--branch', name]), cap: 4096 },
        { argv: gitRead(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]), cap: 4096 },
      ])
      const root = located(where!)
      if (!root) throw new Error(`${p.dir} in ${p.instance} is not inside a git repository`)
      roots.set(folderKey(p), root)
      const at = { ...p, dir: root }
      const main = (await worktreesFrom(at, list!))[0]
      if (!main || main.bare) throw new Error('This repository has no main working tree to put worktrees beside')
      const folder = worktreeFolder(main.path, name)
      validInstanceDir(folder)
      const shown = envPath({ hostId: p.env.id, instance: p.instance, dir: folder })
      if (!ok(valid!)) throw new Error(`"${name}" is not a valid branch name`)
      if (ok(taken!)) throw new Error(`A branch named "${name}" already exists`)
      // It may run hooks (post-checkout), so the login shell, as the desktop's `git worktree add`.
      const r = await exec(at, true, GIT_ENV, ['git', ...GIT_OPTS, ...worktreeAddArgs(name, folder)], { timeoutMs: SLOW_TIMEOUT })
      if (r.code !== 0) throw new Error(explainWorktreeAdd(failure(r, 'git worktree add'), name, shown))
      return { path: shown, branch: name, isMain: false }
    },

    async chatImage(projectPath, path) {
      const file = checkedPicturePath(path)
      // Through the batch runner: it hands back stdout as bytes (base64 on the wire), so the picture arrives intact.
      const [o] = await runAll(placeOf(projectPath), [
        { argv: ['sh', '-c', IMAGE_READ, 'sh', file, String(MAX_IMAGE_BYTES)], cap: MAX_IMAGE_BYTES + 256 },
      ])
      return parsePicture(file, o!)
    },

    async ghItem(projectPath, ref) {
      const argv = ghItemArgv(ref)
      const { hostId, instance } = parseProjectPath(projectPath)
      // From the agent's home: the project folder may be gone, and gh needs no repository here.
      const r = await runPlain(homeOf({ hostId, instance }), GH_ENV, argv, { timeoutMs: 30_000 })
      if (r.code !== 0) throw new Error(ghFailure(instance, ref, r.code, r.stderr))
      const item = parseGhItem(r.stdout)
      if (!item) throw new Error(`Could not read GitHub's answer from ${instance}.`)
      return item
    },

    spawnFor(agent, projectPath): SpawnFn {
      return async (args, h, vars) => {
        const p = placeOf(projectPath)
        const program = binaryFor(agent)
        const runId = newId()
        // The instance root stands for the agent's home (questions that need no project).
        const argv = spawnLine(p.env, p.instance, p.dir === '/' ? '' : p.dir, vars, runId, program, args)
        const envId = p.env.id
        const run = await startRemoteRun({
          ssh,
          endpoint: p.env.endpoint,
          instance: p.instance,
          startLine: line(argv),
          attachLine: (out, err) => line(attachLine(p.env, p.instance, runId, out, err)),
          // Resolves on any answer: a run gone already (`mango-run:gone`) has nothing left to close.
          close: async () => { await runRemote(p.env, closeLine(p.env, p.instance, runId), { timeoutMs: 30_000 }) },
          stop: async () => { await runRemote(p.env, stopLine(p.env, p.instance, runId), { timeoutMs: 30_000 }) },
          hint: (code, stderr, sawStdout) => hint(p.env, p.instance, program, code, stderr, sawStdout),
          startError: e => {
            if (isConnectionLoss(e)) down(envId)
            return transportError(p.env, e, now())
          },
          onConnection(state) {
            const n = (lostRuns.get(envId) ?? 0) + (state === 'lost' ? 1 : -1)
            if (n > 0) lostRuns.set(envId, n)
            else lostRuns.delete(envId)
            if (state === 'lost') down(envId)
            else up(envId)
          },
          quick: () => now() < quickUntil,
        }, h)
        up(envId)
        runs.add(run)
        return run.transport
      }
    },

    reconnectNow() {
      for (const run of [...runs]) {
        if (run.settled) runs.delete(run)
        else run.reconnectNow()
      }
    },

    watchConnections(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async reset(env) {
      const list = env ? [env] : [...used.values()]
      // Runs whose channels this closes attach again right away, not after a backoff.
      quickUntil = now() + 5000
      await Promise.all(list.map(e => ssh.disconnect(e.endpoint).catch(() => {})))
    },
  }
  return backend
}
