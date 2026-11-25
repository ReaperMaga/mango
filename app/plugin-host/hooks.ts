/**
 * Running hook chains in registration order, each hook isolated: one that throws is skipped for that
 * call (and reported), the rest go on. Plain TypeScript (tests/).
 */

export interface HookEntry<F> { pluginId: string; fn: F }

export interface SendDraft<A> { text: string; attachments: A[] }

/**
 * `onBeforeSend`: each hook sees the previous one's result. `false` cancels (null comes back);
 * an object replaces `text` / `attachments`; anything else leaves them.
 */
export async function runBeforeSend<A, C extends SendDraft<A>>(
  hooks: ReadonlyArray<HookEntry<(ctx: C) => unknown>>,
  ctx: C,
  onError: (pluginId: string, e: unknown) => void,
): Promise<SendDraft<A> | null> {
  let draft: SendDraft<A> = { text: ctx.text, attachments: ctx.attachments }
  for (const h of [...hooks]) {
    let r: unknown
    try {
      r = await h.fn({ ...ctx, text: draft.text, attachments: [...draft.attachments] })
    } catch (e) {
      onError(h.pluginId, e)
      continue
    }
    if (r === false) return null
    if (r && typeof r === 'object') {
      const o = r as Partial<SendDraft<A>>
      draft = {
        text: typeof o.text === 'string' ? o.text : draft.text,
        attachments: Array.isArray(o.attachments) ? o.attachments : draft.attachments,
      }
    }
  }
  return draft
}

/** Call every handler with the same arguments; a throw (or a rejected promise) is reported and skipped. */
export function emitAll<Args extends unknown[]>(
  hooks: ReadonlyArray<HookEntry<(...a: Args) => unknown>>,
  args: Args,
  onError: (pluginId: string, e: unknown) => void,
) {
  for (const h of [...hooks]) {
    try {
      const r = h.fn(...args)
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(e => onError(h.pluginId, e))
    } catch (e) {
      onError(h.pluginId, e)
    }
  }
}

/**
 * `onBeforeClose`: all at once, at most `ms` together. What throws, or is not done by then, is reported; nothing is
 * waited for without hooks.
 */
export async function runBeforeClose(
  hooks: ReadonlyArray<HookEntry<() => unknown>>,
  ms: number,
  onError: (pluginId: string, e: unknown) => void,
): Promise<void> {
  if (!hooks.length) return
  const open = new Set(hooks)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
  await Promise.race([late, Promise.all([...hooks].map(async (h) => {
    try { await h.fn() } catch (e) { onError(h.pluginId, e) }
    open.delete(h)
  }))])
  clearTimeout(timer)
  for (const h of open) onError(h.pluginId, new Error(`Not done after ${ms} ms: Mango goes on closing.`))
}

/** `/name args` as name and args, or null when the text is not a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null
}

/** Keep the last `max` items (a plugin's log). Mutates and returns `list`. */
export function capped<T>(list: T[], item: T, max = 300): T[] {
  list.push(item)
  if (list.length > max) list.splice(0, list.length - max)
  return list
}

/** Arguments of a log call as one line: errors with their message (and stack's first frame), objects as JSON. */
export function logText(args: unknown[]): string {
  return args.map((a) => {
    if (a instanceof Error) return a.stack?.split('\n').slice(0, 2).join(' ') || `${a.name}: ${a.message}`
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ')
}
