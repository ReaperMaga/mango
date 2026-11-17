import type { Env } from './types'

/**
 * Remote command lines, ported from the desktop (`src-tauri/src/envs/ssh.rs` and the validators
 * in `envs/mod.rs`). SSH hands the remote user's shell one string, so every argument is
 * POSIX-quoted here (`quote`) and joined (`line`); `incus exec` then passes its argv to the
 * instance verbatim, without another shell in between.
 *
 * A joined environment has no master: SSH lands inside the environment as its agent user, and
 * `inInstance` runs what would be `incus exec` through `sudo -n` there instead (or directly, for
 * a command that only had to become the agent user).
 *
 * Everything that reaches a remote shell from the UI or a link passes one of the validators
 * below first, and then only travels as a quoted argument.
 */

/** The account the agents run as inside every instance (created by the `base` component). */
export const AGENT_USER = 'agent'
export const AGENT_HOME = '/home/agent'

/** POSIX shell quoting: plain words stay as they are, anything else is single-quoted. */
export function quote(s: string): string {
  const plain = s.length > 0 && /^[A-Za-z0-9\-_./=:@%+,]+$/.test(s)
  return plain ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Join an argv into one shell line for the remote side. */
export function line(argv: readonly string[]): string {
  return argv.map(quote).join(' ')
}

/** How a command talks to the user: captured (`-T`, the phone's only kind today) or in a terminal (`-t`). */
export type Mode = 'batch' | 'tty'

/** The Incus remote a server's instances live on, or null for its default. */
const incusRemote = (env: Env) => env.server?.incusRemote?.trim() || null

/** `remote:instance`, or just `instance` on the server's default remote. */
export function target(env: Env, instance: string): string {
  const r = incusRemote(env)
  return r ? `${r}:${instance}` : instance
}

/** `remote:` (for `incus list`), or null for the default remote. */
export function remotePrefix(env: Env): string | null {
  const r = incusRemote(env)
  return r ? `${r}:` : null
}

/** `incus exec <target> -T|-t -- <inner…>` (runs as root inside the instance). */
export function incusExec(env: Env, instance: string, mode: Mode, inner: readonly string[]): string[] {
  return ['incus', 'exec', target(env, instance), mode === 'batch' ? '-T' : '-t', '--', ...inner]
}

/**
 * The remote argv running `inner` as root inside `instance`: `incus exec` on a server, `sudo -n`
 * in a joined environment, where SSH already lands as the agent user (with passwordless sudo,
 * from the base component). There an `asAgent` argv skips `sudo` and `runuser` altogether.
 * Throws for an instance a joined environment does not give access to.
 */
export function inInstance(env: Env, instance: string, mode: Mode, inner: readonly string[]): string[] {
  const d = env.joined
  if (!d) return incusExec(env, instance, mode, inner)
  if (instance !== d.instance) throw new Error(`${env.name} gives access to ${d.instance} only, not to ${instance}.`)
  const runuser = ['runuser', '-u', AGENT_USER, '--']
  if (env.endpoint.user === AGENT_USER && inner.length > runuser.length && runuser.every((w, i) => inner[i] === w)) {
    return inner.slice(runuser.length)
  }
  return ['sudo', '-n', '--', ...inner]
}

/** The fixed PATH of `asAgentPlain`. */
const PLAIN_PATH = '$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/** Enters the folder in `$1`, or explains why not (the backend turns that line into an error). */
const ENTER = 'cd -- "$1" || { echo "Mango: the folder $1 does not exist in this environment." >&2; exit 1; }; shift; exec "$@"'

function asAgentIn(login: boolean, cwd: string | null, vars: readonly (readonly [string, string])[], argv: readonly string[]): string[] {
  return [
    'runuser', '-u', AGENT_USER, '--', 'env',
    `HOME=${AGENT_HOME}`, `USER=${AGENT_USER}`, `LOGNAME=${AGENT_USER}`, 'SHELL=/bin/bash',
    ...vars.map(([k, v]) => `${k}=${v}`),
    'bash',
    login ? '-lc' : '-c',
    login ? ENTER : `PATH="${PLAIN_PATH}"; export PATH; ${ENTER}`,
    'mango',
    cwd ?? AGENT_HOME,
    ...argv,
  ]
}

/**
 * Instance-side argv running `argv` as the agent user from `cwd` (home when null), in a login
 * shell so `~/.local/bin` and friends are on PATH. `vars` must be validated (`validEnvKey`).
 */
export const asAgent = (cwd: string | null, vars: readonly (readonly [string, string])[], argv: readonly string[]) =>
  asAgentIn(true, cwd, vars, argv)

/**
 * `asAgent` without the login shell: no profile scripts, PATH is a fixed list. For quick reads
 * that run often; a read that finds a tool missing on this PATH is retried with the login shell.
 */
export const asAgentPlain = (cwd: string | null, vars: readonly (readonly [string, string])[], argv: readonly string[]) =>
  asAgentIn(false, cwd, vars, argv)

/* ---------- validation: everything from the UI or a link passes one of these ---------- */

const isControl = (c: string) => {
  const n = c.codePointAt(0)!
  return n < 0x20 || (n >= 0x7f && n <= 0x9f)
}
/** Rust's `char::is_control` over a whole string. */
export const hasControl = (s: string) => [...s].some(isControl)

/** An Incus instance name: a letter, then letters, digits and dashes (max 63), no trailing dash. */
export function validInstance(s: string): void {
  const ok = s.length <= 63 && /^[A-Za-z][A-Za-z0-9-]*$/.test(s) && !s.endsWith('-')
  if (!ok) throw new Error(`"${s}" can't be an instance name. Use a letter, then letters, digits and dashes (up to 63).`)
}

/** A folder inside an instance: absolute, no `..`, no control characters. */
export function validInstanceDir(s: string): void {
  const ok = s.startsWith('/') && utf8Length(s) <= 1000 && !s.split('/').includes('..') && !hasControl(s)
  if (!ok) throw new Error(`"${s}" is not an absolute folder path inside the environment.`)
}

/** An environment variable name for an agent run. */
export const validEnvKey = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)

/** An SSH destination host or `user@host`. Never an option. */
export function validSshDest(s: string): void {
  const ok = s.length > 0 && s.length <= 255 && !s.startsWith('-') && /^[A-Za-z0-9._@%+:-]+$/.test(s)
  if (!ok) throw new Error(`"${s}" is not an SSH destination. Use user@host.`)
}

/** An Incus remote name (as in `incus remote list`). */
export function validRemote(s: string): void {
  const ok = s.length > 0 && s.length <= 63 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)
  if (!ok) throw new Error(`"${s}" is not an Incus remote name.`)
}

/** This phone's id for an env, the `<hostId>` of `env://<hostId>/…`. */
export const validEnvId = (s: string): boolean => /^[a-z0-9-]{1,64}$/.test(s)

/** UTF-8 length, as Rust's `str::len` counts. */
export function utf8Length(s: string): number {
  let n = 0
  for (const c of s) {
    const cp = c.codePointAt(0)!
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

/** Unix ms as `2026-11-20 14:05 UTC`, for messages (the desktop's `utc_text`). */
export function utcText(ms: number): string {
  const d = new Date(Math.floor(ms / 60000) * 60000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}
