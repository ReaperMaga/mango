import type { ContextPart, ContextUsage, PromptCache, TurnUsage } from './types.ts'

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

/**
 * A Claude Code `result` message's usage added to what the run used before. `total_cost_usd` is
 * the CLI's own running total, so it replaces the cost rather than adding to it.
 */
export function addClaudeUsage(prev: TurnUsage | null, result: any): TurnUsage | null {
  const u = result?.usage
  const input = [u?.input_tokens, u?.cache_creation_input_tokens, u?.cache_read_input_tokens].reduce<number>((s, v) => s + (num(v) ?? 0), 0)
  const output = num(u?.output_tokens) ?? 0
  const cost = typeof result?.total_cost_usd === 'number' && result.total_cost_usd >= 0 ? result.total_cost_usd : undefined
  if (!input && !output && cost === undefined) return prev
  const costUsd = cost ?? prev?.costUsd
  return { input: (prev?.input ?? 0) + input, output: (prev?.output ?? 0) + output, ...(costUsd !== undefined ? { costUsd } : {}) }
}

/**
 * How long a Claude request's prompt stays cached, from its `usage`: an hour on subscriptions, five minutes
 * otherwise. Undefined for a request that added nothing to the cache: it carries no time of its own.
 */
export function claudeCacheTtl(usage: any): number | undefined {
  const c = usage?.cache_creation
  if (c?.ephemeral_1h_input_tokens > 0) return 3_600_000
  if (c?.ephemeral_5m_input_tokens > 0) return 300_000
  return undefined
}

/** A request seen now over what was known: without a time of its own it keeps the one before it. Unset until that is known. */
export function mergeCache(prev: PromptCache | undefined, e: { at: number; ttlMs?: number }, owner: string): PromptCache | undefined {
  const ttlMs = e.ttlMs ?? (prev?.for === owner ? prev.ttlMs : undefined)
  return ttlMs ? { at: e.at, ttlMs, for: owner } : undefined
}

/** What a saved chat says about its cache, checked. */
export function normalizeCache(c: any): PromptCache | undefined {
  const at = num(c?.at)
  const ttlMs = num(c?.ttlMs)
  if (!at || !ttlMs || typeof c.for !== 'string') return undefined
  return { at, ttlMs, for: c.for, ...(c.tried === true ? { tried: true as const } : {}) }
}

/**
 * Codex reports the conversation's running totals. What this run used is the growth since just
 * before its first request: `total - last` of the first reading is the total from before it.
 * `base` carries that starting point between readings.
 */
export function codexTurnUsage(tokenUsage: any, base: { input: number; output: number } | null): { usage: TurnUsage; base: { input: number; output: number } } | null {
  const total = tokenUsage?.total
  const last = tokenUsage?.last
  const tin = num(total?.inputTokens)
  const tout = num(total?.outputTokens)
  if (tin === null || tout === null) return null
  const start = base ?? { input: Math.max(0, tin - (num(last?.inputTokens) ?? 0)), output: Math.max(0, tout - (num(last?.outputTokens) ?? 0)) }
  return { usage: { input: Math.max(0, tin - start.input), output: Math.max(0, tout - start.output) }, base: start }
}

/** "$0.04", "$1.27", "<$0.01" */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}
