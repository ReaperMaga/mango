import type { ContextPart, ContextUsage } from './types.ts'

/**
 * How full a conversation's context window is, read from what each CLI reports. Plain
 * TypeScript, no dependencies: the adapters, the runner, the UI and the phone app share it.
 */

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)

/**
 * Claude Code's answer to the `get_context_usage` control request (what `/context` shows):
 * the total, the model's window, where it compacts by itself, and what fills it. Null when
 * the answer has no usable total.
 */
export function claudeContext(r: any): ContextUsage | null {
  const used = num(r?.totalTokens)
  const max = num(r?.maxTokens)
  if (used === null || !max) return null
  const parts: ContextPart[] = []
  for (const c of Array.isArray(r.categories) ? r.categories : []) {
    const tokens = num(c?.tokens)
    // Deferred tools are only listed for the model to load on demand: not in the window.
    if (tokens === null || c.isDeferred || c.kind === 'deferred' || typeof c.name !== 'string') continue
    const kind = c.kind === 'free' ? 'free' : c.kind === 'buffer' ? 'buffer' : 'used'
    if (kind === 'used' && !tokens) continue
    parts.push({ id: typeof c.id === 'string' && c.id ? c.id : c.name, label: c.name, tokens, kind })
  }
  const compactAt = r.isAutoCompactEnabled === false ? null : num(r.autoCompactThreshold)
  return {
    used,
    max,
    ...(compactAt ? { compactAt } : {}),
    ...(parts.length ? { parts } : {}),
    ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
    at: Date.now(),
  }
}

/**
 * The prompt size of one Claude request (`message_start`'s `usage`): every input token,
 * cached or not, is in the window. Null when the message carries none.
 */
export function claudeRequestTokens(usage: any): number | null {
  const parts = [usage?.input_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens].map(num)
  if (parts.every(p => p === null)) return null
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0)
}

/**
 * Codex's `thread/tokenUsage/updated`: `last` is the newest request, which holds the whole
 * conversation as the model saw it; `modelContextWindow` its window (null when Codex does not know).
 */
export function codexContext(tokenUsage: any): ContextUsage | null {
  const used = num(tokenUsage?.last?.totalTokens)
  if (used === null) return null
  return { used, max: num(tokenUsage?.modelContextWindow) ?? 0, at: Date.now() }
}

/**
 * A new reading over the one before. A reading without the window size (a live one, taken
 * mid-turn) keeps the window and the compaction point of the last full one; its breakdown
 * is dropped, since the parts would no longer add up.
 */
export function mergeContext(prev: ContextUsage | null | undefined, next: ContextUsage): ContextUsage {
  if (next.max > 0 || !prev) return next
  return {
    used: next.used,
    max: prev.max,
    ...(prev.compactAt ? { compactAt: prev.compactAt } : {}),
    ...(prev.model ? { model: prev.model } : {}),
    at: next.at,
  }
}

/** How full, 0 to 100; null when the window size is unknown. */
export function contextPercent(c: Pick<ContextUsage, 'used' | 'max'> | null | undefined): number | null {
  if (!c || !(c.max > 0)) return null
  return Math.max(0, Math.min(100, Math.round((c.used / c.max) * 100)))
}

/**
 * How close the conversation is to where the CLI compacts it by itself (or to the end of the
 * window when it does not say): 'high' from 80%, 'full' from 95%.
 */
export function contextLevel(c: Pick<ContextUsage, 'used' | 'max' | 'compactAt'>): 'ok' | 'high' | 'full' {
  const limit = c.compactAt || c.max
  if (!limit) return 'ok'
  const f = c.used / limit
  return f >= 0.95 ? 'full' : f >= 0.8 ? 'high' : 'ok'
}

/** 512, 1.2k, 93.8k, 200k, 1M, 1.5M */
export function formatTokens(n: number): string {
  const short = (v: number) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n >= 1_000_000) return `${short(n / 1_000_000)}M`
  if (n >= 1000) {
    const k = n / 1000
    // 999.95k would print as "1000k".
    return k >= 999.5 ? '1M' : `${short(k)}k`
  }
  return String(Math.max(0, Math.round(n)))
}

/** A saved reading, checked: data from older builds or another computer may be anything. */
export function normalizeContext(c: any): ContextUsage | undefined {
  const used = num(c?.used)
  const max = num(c?.max)
  if (used === null || max === null) return undefined
  const parts = Array.isArray(c.parts)
    ? c.parts.filter((p: any) => p && typeof p.label === 'string' && num(p.tokens) !== null && ['used', 'buffer', 'free'].includes(p.kind))
      .map((p: any): ContextPart => ({ id: typeof p.id === 'string' ? p.id : p.label, label: p.label, tokens: num(p.tokens)!, kind: p.kind }))
    : []
  const compactAt = num(c.compactAt)
  return {
    used,
    max,
    ...(compactAt ? { compactAt } : {}),
    ...(parts.length ? { parts } : {}),
    ...(typeof c.model === 'string' && c.model ? { model: c.model } : {}),
    at: num(c.at) ?? 0,
  }
}
