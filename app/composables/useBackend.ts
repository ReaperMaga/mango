import type { Commands, Events, ProjectInfo, AgentInfo, AttachmentInfo, SetupTool, SetupToolId, VoiceModel, VoiceModelId } from '~/types/ipc'
import { attachmentKind, mimeFromName } from '~/utils/attachments'
import { baseName } from '~/utils/paths'
import { mockGit } from '~/composables/mockGit'
import { mockChatImage, mockFiles } from '~/composables/mockFiles'
import { mockGhItem, mockGhJob, mockGhMerge, mockGhPrCreate } from '~/composables/mockGithub'
import { mockPlasticReviewCreate, mockPlasticReviews } from '~/composables/mockReviews'
import { createMockEnvs } from '~/composables/mockEnvs'
import { isEnvPath } from '~/utils/envPath'

/**
 * Typed bridge to the Rust backend. Inside Tauri it calls real commands;
 * in a plain browser (`pnpm dev` without Tauri) it falls back to an in-memory
 * mock so the UI can be developed and screenshotted on its own.
 */

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type Args<K extends keyof Commands> = Commands[K][0]
type Result<K extends keyof Commands> = Commands[K][1]
type Unlisten = () => void

/**
 * Commands that read or change this computer's disk (or run in a local folder). A remote
 * project's path (`env://…`, see utils/envPath.ts) is not a folder here: they refuse it
 * before it reaches the backend. Callers check `isEnvPath` first; this is the safety net.
 * The `git_*`, `fs_*` and `gh_*` commands are not among them: the backend runs git, reads
 * files and finds the GitHub repository inside the environment.
 */
const LOCAL_ONLY = /^(open_project|forget_project|pty_spawn)$/

function refuseRemote(cmd: string, args: unknown): Error | null {
  if (!LOCAL_ONLY.test(cmd) || !args || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  return [a.path, a.root, a.cwd].some(v => typeof v === 'string' && isEnvPath(v))
    ? new Error('Not available for remote environments yet.')
    : null
}

export async function call<K extends keyof Commands>(cmd: K, args?: Args<K>): Promise<Result<K>> {
  const refused = refuseRemote(cmd, args)
  if (refused) throw refused
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<Result<K>>(cmd, (args ?? {}) as Record<string, unknown>)
  }
  return mock.call(cmd, args ?? ({} as Args<K>))
}

export async function on<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<Events[E]>(event, e => handler(e.payload))
  }
  return mock.on(event, handler)
}

/** Native folder picker. Returns null when cancelled. */
export async function pickFolder(title = 'Open folder', defaultPath?: string): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const res = await open({ directory: true, multiple: false, title, defaultPath })
    return typeof res === 'string' ? res : null
  }
  const p = window.prompt(`${title} (browser preview: type a path)`, defaultPath ?? '/home/you/Projects/')
  return p?.trim() || null
}

/** Native file picker (several files). Inside the app only; returns [] when cancelled or in the browser. */
export async function pickFiles(title = 'Attach files'): Promise<string[]> {
  if (!isTauri()) return []
  const { open } = await import('@tauri-apps/plugin-dialog')
  const res = await open({ multiple: true, directory: false, title })
  return Array.isArray(res) ? res : typeof res === 'string' ? [res] : []
}

export async function openExternal(url: string) {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

/** Window controls for the custom titlebar. No-ops in the browser. */
export const appWindow = {
  async minimize() {
    if (!isTauri()) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().minimize()
  },
  async toggleMaximize() {
    if (!isTauri()) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().toggleMaximize()
  },
  async close() {
    if (!isTauri()) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  },
}

/* ------------------------------------------------------------------ */
/* Browser mock                                                        */
/* ------------------------------------------------------------------ */

const MOCK_CHATS = 'mango.preview.chats'

const mock = (() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach(fn => fn(payload))
  const now = Date.now()
  const home = '/home/you'

  let recent: ProjectInfo[] = [
    { path: `${home}/Projects/mango`, name: 'mango', isGit: true, vcs: 'git', branch: 'main', lastOpened: now - 1000 * 60 * 4 },
    { path: `${home}/Projects/orchard-api`, name: 'orchard-api', isGit: true, vcs: 'git', branch: 'feat/rate-limits', lastOpened: now - 1000 * 60 * 60 * 5 },
    { path: `${home}/Projects/pulp-ui`, name: 'pulp-ui', isGit: true, vcs: 'git', branch: 'main', lastOpened: now - 1000 * 60 * 60 * 26 },
    { path: `${home}/Projects/fruit-stand`, name: 'fruit-stand', isGit: true, vcs: 'plastic', branch: '/main/feature/inventory', lastOpened: now - 1000 * 60 * 60 * 30 },
    { path: `${home}/Projects/notes`, name: 'notes', isGit: false, branch: null, lastOpened: now - 1000 * 60 * 60 * 24 * 6 },
  ]

  const remember = (p: ProjectInfo) => {
    recent = [p, ...recent.filter(r => r.path !== p.path)].slice(0, 30)
    return p
  }
  const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

  /* A tiny fake shell so the terminal panel has something to talk to. */
  interface FakePty {
    cwd: string
    line: string
    /** A shell inside a remote environment: its prompt's `user@instance`. */
    remote?: string
  }
  const ptys = new Map<string, FakePty>()
  const newPtyId = () => `pty-${Math.random().toString(36).slice(2, 8)}`
  const prompt = (p: FakePty) => (p.remote
    ? `\x1b[32m${p.remote}\x1b[0m:\x1b[34m${p.cwd.replace(/^\/home\/agent(?=\/|$)/, '~')}\x1b[0m$ `
    : `\x1b[32m${basename(p.cwd)}\x1b[0m \x1b[33m❯\x1b[0m `)
  const runLine = (id: string, p: FakePty, line: string) => {
    const out = (s: string) => emit('pty://data', { id, data: s })
    const [cmd, ...rest] = line.trim().split(/\s+/)
    switch (cmd) {
      case undefined:
      case '':
        break
      case 'pwd': out(`${p.cwd}\r\n`); break
      case 'ls': out('\x1b[1;34mapp\x1b[0m  \x1b[1;34msrc-tauri\x1b[0m  nuxt.config.ts  package.json  PRODUCT.md  README.md\r\n'); break
      case 'echo': out(`${rest.join(' ')}\r\n`); break
      case 'clear': out('\x1b[2J\x1b[H'); break
      case 'git': out('On branch main\r\nnothing to commit, working tree clean\r\n'); break
      case 'exit': emit('pty://exit', { id, code: 0 }); ptys.delete(id); return
      default: out(p.remote
        ? `\x1b[2msimulated: \x1b[0m${cmd}\x1b[2m runs inside the instance in the Mango app\x1b[0m\r\n`
        : `\x1b[2mbrowser preview: \x1b[0m${cmd}\x1b[2m runs for real inside the Mango app\x1b[0m\r\n`)
    }
    out(prompt(p))
  }

  /* Setup: Codex starts out missing so the dialog has something to install. */
  const setupTools: SetupTool[] = [
    { id: 'git', name: 'Git', installed: true, version: 'git version 2.47.1', path: '/usr/bin/git', install: { command: 'sudo apt-get install -y git', via: 'apt' }, helpUrl: 'https://git-scm.com/downloads' },
    { id: 'claude', name: 'Claude Code', installed: true, version: '2.4.1 (Claude Code)', path: `${home}/.local/bin/claude`, install: { command: 'curl -fsSL https://claude.ai/install.sh | bash', via: "Anthropic's installer" }, helpUrl: 'https://code.claude.com/docs/en/setup' },
    { id: 'codex', name: 'Codex', installed: false, version: null, path: null, install: { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', via: "OpenAI's installer" }, helpUrl: 'https://github.com/openai/codex' },
  ]
  /** Play a fake installer into a fake terminal, then mark the tool installed. */
  function fakeInstall(id: string, tool: SetupToolId) {
    const t = setupTools.find(x => x.id === tool)!
    const lines = [
      `\x1b[2m$ ${t.install?.command}\x1b[0m`,
      `Downloading ${t.name}…`,
      'Verifying checksum… ok',
      `Installing to ${home}/.local/bin`,
      `\x1b[32m✓\x1b[0m ${t.name} installed \x1b[2m(simulated: the browser preview installs nothing)\x1b[0m`,
    ]
    lines.forEach((line, i) => setTimeout(() => emit('pty://data', { id, data: `${line}\r\n` }), 250 + i * 420))
    setTimeout(() => {
      Object.assign(t, { installed: true, version: tool === 'codex' ? 'codex-cli 0.98.0' : '1.0.0', path: `${home}/.local/bin/${tool}` })
      emit('pty://exit', { id, code: 0 })
    }, 250 + lines.length * 420)
  }

  /* Voice: models "download" in a few seconds; transcription answers with a labelled stand-in. */
  const voiceModels: VoiceModel[] = [
    { id: 'tiny', name: 'Tiny', sizeBytes: 153_544_121, downloaded: false, downloading: false },
    { id: 'base', name: 'Base', sizeBytes: 292_886_385, downloaded: false, downloading: false },
    { id: 'small', name: 'Small', sizeBytes: 969_477_513, downloaded: false, downloading: false },
  ]
  const voiceCancel = new Set<VoiceModelId>()
  async function fakeVoiceDownload(id: VoiceModelId) {
    const m = voiceModels.find(x => x.id === id)
    if (!m) throw new Error(`There is no speech model called "${id}".`)
    if (m.downloaded) return
    m.downloading = true
    voiceCancel.delete(id)
    try {
      const steps = 40
      for (let i = 0; i <= steps; i++) {
        if (voiceCancel.has(id)) throw new Error('Download cancelled.')
        emit('voice://progress', { model: id, downloaded: Math.round(m.sizeBytes * i / steps), total: m.sizeBytes })
        await new Promise(r => setTimeout(r, 90))
      }
      m.downloaded = true
    } finally {
      m.downloading = false
    }
  }

  /* Attachments: kept in memory, under made-up paths. */
  const attachments = new Map<string, string>()
  function fakeAttachment(name: string, data: string): AttachmentInfo {
    const size = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    if (size > 25 * 1024 * 1024) throw new Error(`That file is ${(size / 1024 / 1024).toFixed(1)} MB; attachments can be at most 25 MB.`)
    const id = Math.random().toString(36).slice(2, 14)
    const clean = baseName(name).trim() || 'attachment'
    const path = `${home}/.local/share/dev.mango.app/attachments/${id}/${clean}`
    attachments.set(path, data)
    const mime = mimeFromName(clean)
    return { id, name: clean, path, mime, size, kind: attachmentKind(mime) }
  }

  /* Remote environments: made-up servers and instances (mockEnvs.ts); their shells are fake ptys too. */
  const envs = createMockEnvs({
    emit,
    newPty: newPtyId,
    openShell({ cwd, label, banner }) {
      const id = newPtyId()
      const p: FakePty = { cwd, line: '', remote: label }
      ptys.set(id, p)
      setTimeout(() => emit('pty://data', { id, data: `${banner}\r\n${prompt(p)}` }), 30)
      return id
    },
  })

  async function call(cmd: string, args: any): Promise<any> {
    await new Promise(r => setTimeout(r, 60))
    switch (cmd) {
      case 'recent_projects': return [...recent]
      // The preview keeps chats in localStorage, under a key of its own (the app's is the old one it migrates from).
      case 'chats_load': {
        const raw = JSON.parse(localStorage.getItem(MOCK_CHATS) || 'null') ?? {}
        return { threads: Object.values(raw.threads ?? {}), ui: raw.ui ?? null }
      }
      case 'chats_save': {
        const raw = JSON.parse(localStorage.getItem(MOCK_CHATS) || 'null') ?? {}
        const threads: Record<string, string> = raw.threads ?? {}
        for (const r of args.upsert) threads[r.id] = r.data
        for (const id of args.remove) delete threads[id]
        localStorage.setItem(MOCK_CHATS, JSON.stringify({ threads, ui: args.ui ?? raw.ui ?? null }))
        return
      }
      case 'open_project': {
        const existing = recent.find(r => r.path === args.path)
        return remember({ ...(existing ?? { path: args.path, name: basename(args.path), isGit: true, branch: 'main' }), lastOpened: Date.now() })
      }
      case 'forget_project': recent = recent.filter(r => r.path !== args.path); return
      case 'create_project':
        return remember({ path: `${args.parent.replace(/\/+$/, '')}/${args.name}`, name: args.name, isGit: !!args.gitInit, branch: args.gitInit ? 'main' : null, lastOpened: Date.now() })
      case 'git_clone': {
        const name = args.name || basename(String(args.url)).replace(/\.git$/, '')
        const lines = [`Cloning into '${name}'...`, 'remote: Enumerating objects: 1284, done.', 'remote: Counting objects: 100% (1284/1284), done.', 'Receiving objects:  48% (617/1284)', 'Receiving objects: 100% (1284/1284), 2.31 MiB | 9.8 MiB/s, done.', 'Resolving deltas: 100% (702/702), done.']
        for (const line of lines) {
          await new Promise(r => setTimeout(r, 380))
          emit('clone://progress', { jobId: args.jobId, line })
        }
        return remember({ path: `${args.parent.replace(/\/+$/, '')}/${name}`, name, isGit: true, branch: 'main', lastOpened: Date.now() })
      }
      case 'default_projects_dir': return `${home}/Projects`
      case 'detect_agents': return setupTools.filter(t => t.id !== 'git').map(t => ({
        id: t.id as AgentInfo['id'], name: t.name, installed: t.installed, version: t.version, path: t.path,
      })) satisfies AgentInfo[]
      case 'pty_spawn': {
        const id = newPtyId()
        const p: FakePty = { cwd: args.cwd || home, line: '' }
        ptys.set(id, p)
        setTimeout(() => emit('pty://data', { id, data: `\x1b[2mMango browser preview — a real login shell runs here inside the desktop app.\x1b[0m\r\n${prompt(p)}` }), 30)
        return id
      }
      case 'pty_write': {
        const p = ptys.get(args.id)
        if (!p) return
        for (const ch of String(args.data)) {
          if (ch === '\r') { emit('pty://data', { id: args.id, data: '\r\n' }); runLine(args.id, p, p.line); p.line = '' }
          else if (ch === '\x7f') { if (p.line) { p.line = p.line.slice(0, -1); emit('pty://data', { id: args.id, data: '\b \b' }) } }
          else if (ch === '\x03') { p.line = ''; emit('pty://data', { id: args.id, data: `^C\r\n${prompt(p)}` }) }
          else if (ch >= ' ') { p.line += ch; emit('pty://data', { id: args.id, data: ch }) }
        }
        return
      }
      case 'terminal_profiles': return [
        { id: 'zsh', name: 'Zsh', path: '/usr/bin/zsh', args: ['-l'], isDefault: true },
        { id: 'bash', name: 'Bash', path: '/usr/bin/bash', args: ['-l'], isDefault: false },
        { id: 'fish', name: 'fish', path: '/usr/bin/fish', args: ['-l'], isDefault: false },
        { id: 'sh', name: 'sh', path: '/bin/sh', args: ['-l'], isDefault: false },
      ]
      case 'pty_resize': return
      case 'pty_kill': ptys.delete(args.id); return
      case 'agent_auth_status': return {
        agent: args.agent, installed: !!setupTools.find(t => t.id === args.agent)?.installed, loggedIn: args.agent === 'claude',
        account: args.agent === 'claude' ? 'you@example.com' : null, plan: args.agent === 'claude' ? 'pro' : null, organization: null,
        method: args.agent === 'claude' ? 'claude.ai' : null, detail: args.agent === 'claude' ? null : 'Not logged in',
      }
      case 'agent_logout': return
      case 'setup_check': return setupTools.map(t => ({ ...t }))
      case 'setup_install': {
        const id = newPtyId()
        fakeInstall(id, args.tool)
        return id
      }
      // Local or in a remote environment (`remote`), the preview has no CLI: runAgentTurn simulates instead.
      case 'agent_spawn': throw new Error('Agents run only inside the Mango desktop app; the browser preview simulates replies.')
      case 'agent_write': case 'agent_close_stdin': case 'agent_kill': return
      case 'update_check': return {
        version: '0.2.0',
        currentVersion: '0.1.0',
        notes: 'Simulated update: the browser preview has no releases to install.',
        dateMs: now - 1000 * 60 * 60 * 3,
      }
      case 'update_install': {
        const total = 18_400_000
        for (let downloaded = 0; downloaded < total; downloaded += 1_150_000) {
          await new Promise(r => setTimeout(r, 120))
          emit('update://progress', { downloaded, total })
        }
        throw new Error('Simulated: the browser preview cannot install updates. Inside the Mango app this restarts into the new version.')
      }
      case 'attachment_save': return fakeAttachment(args.name, args.data)
      case 'attachment_import': throw new Error('The browser preview cannot read files from disk; paste or pick them instead.')
      case 'attachment_read': {
        const data = attachments.get(args.path)
        if (data === undefined) throw new Error('The attachment is gone from disk.')
        return data
      }
      case 'chat_image': return mockChatImage(args.path, args.base)
      case 'gh_item': await new Promise(r => setTimeout(r, 450)); return mockGhItem(args.path, args.reference)
      case 'gh_merge': await new Promise(r => setTimeout(r, 900)); return mockGhMerge(args.path, args.reference, args.method, args.headSha)
      case 'gh_job': await new Promise(r => setTimeout(r, 350)); return mockGhJob(args.url)
      case 'gh_pr_create': await new Promise(r => setTimeout(r, 1100)); return mockGhPrCreate(args.path, args.base, await mockGit('git_status', { path: args.path }))
      case 'plastic_reviews': await new Promise(r => setTimeout(r, 500)); return mockPlasticReviews(args.path)
      case 'plastic_review_create': await new Promise(r => setTimeout(r, 900)); return mockPlasticReviewCreate(args.path, args.title, args.reviewers)
      /* Browser: no native webview here (BrowserPane shows an iframe); pages "load" at once. */
      case 'browser_open': case 'browser_navigate': {
        const { id, url } = args as { id: string; url: string }
        if (url === 'about:blank') return
        let title = url
        try { title = new URL(url).host } catch { /* keep the URL */ }
        emit('browser://state', { id, url, title, loading: true })
        setTimeout(() => emit('browser://state', { id, url, title, loading: false }), 400)
        return
      }
      case 'browser_bounds': case 'browser_go': case 'browser_devtools': case 'browser_close': case 'browser_reset': return
      case 'browser_screenshot': throw new Error('The browser preview has no native browser to take a screenshot of.')
      case 'browser_mcp': throw new Error('Simulated agents do not use the browser tools.')
      case 'voice_models': return voiceModels.map(m => ({ ...m }))
      case 'voice_download': return fakeVoiceDownload(args.model)
      case 'voice_download_cancel': voiceCancel.add(args.model); return
      case 'voice_delete': { const m = voiceModels.find(x => x.id === args.model); if (m) m.downloaded = false; return }
      case 'voice_transcribe': {
        const duration = Math.round((atob(args.audio).length / 2 / 16000) * 10) / 10
        await new Promise(r => setTimeout(r, 700))
        return { text: `Simulated transcription of ${duration} s of audio; the desktop app runs Whisper here.`, language: args.language ?? 'en', duration }
      }
    }
    // Project env files, not remote environments: the in-memory project answers them.
    if (cmd === 'env_files' || cmd === 'env_gitignore_add') return mockFiles(cmd, args)
    if (cmd.startsWith('git_')) return mockGit(cmd, args)
    if (cmd.startsWith('fs_')) return mockFiles(cmd, args)
    if (cmd.startsWith('env_')) return envs(cmd, args)
    throw new Error(`mock: unknown command ${cmd}`)
  }

  function on(event: string, handler: (p: any) => void): Unlisten {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(handler)
    return () => listeners.get(event)?.delete(handler)
  }

  return { call: call as <K extends keyof Commands>(cmd: K, args: Args<K>) => Promise<Result<K>>, on: on as <E extends keyof Events>(e: E, h: (p: Events[E]) => void) => Unlisten }
})()
