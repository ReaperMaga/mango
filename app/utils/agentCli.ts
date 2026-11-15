import type { AgentId } from '~/types/chat'

/**
 * The command-line tool behind each agent: its binary and how to sign in to
 * and out of it. Installing is the backend's business (`setup_install`).
 */
export const AGENT_CLI: Partial<Record<AgentId, { bin: string; login: string[]; logout: string }>> = {
  claude: { bin: 'claude', login: ['claude', 'auth', 'login'], logout: 'claude auth logout' },
  codex: { bin: 'codex', login: ['codex', 'login'], logout: 'codex logout' },
}

/** CLIs print versions in their own formats ("2.1.3 (Claude Code)", "git version 2.47.1.windows.1"): keep the number. */
export function shortVersion(version: string | null): string | null {
  return version?.match(/\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/)?.[0] ?? version
}

/** Copy text, with a fallback for webviews without the async clipboard. */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* nothing else to try */ }
    ta.remove()
  }
}
