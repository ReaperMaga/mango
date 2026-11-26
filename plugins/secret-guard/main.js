/**
 * Secret guard: looks at every outgoing message (`chat.onBeforeSend`) for things that look like
 * credentials and, per the `action` setting, asks, masks them or blocks the send.
 *
 * It only ever logs the kind of secret it found and how many, never the text itself: the plugin log
 * is shown in Settings and mirrored to the console.
 */

/**
 * What counts as a secret. Each `re` must be global; it matches the secret itself (look-behinds keep
 * the surrounding words, such as `password=`, out of the match so masking leaves them readable).
 */
const RULES = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { kind: 'AWS secret key', re: /(?<=aws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi },
  { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Stripe key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'API key', re: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
]

/** `password = hunter22`, `"api_key": "…"`: only the value is the secret. */
const GENERIC = {
  kind: 'password',
  re: /(?<=\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)["']?\s*[:=]\s*["']?)[^\s"'`,;]{6,}/gi,
}

/** Values that are clearly placeholders, not secrets, so examples in a prompt do not trip the guard. */
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_]+%|(?:your|my|example|changeme|placeholder|redacted|dummy|test)[\w-]*)$/i

/** Every secret in `text`, as non-overlapping ranges in order. */
export function findSecrets(text, { generic = true } = {}) {
  const rules = generic ? [...RULES, GENERIC] : RULES
  const found = []
  for (const { kind, re } of rules) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      if (kind === 'password' && PLACEHOLDER.test(m[0])) continue
      found.push({ kind, start: m.index, end: m.index + m[0].length })
    }
  }
  // Earlier rules are more specific: keep the first range that claims a stretch of text.
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept = []
  for (const f of found) {
    const last = kept[kept.length - 1]
    if (!last || f.start >= last.end) kept.push(f)
  }
  return kept
}

/** `text` with each found secret replaced by `[redacted <kind>]`. */
export function mask(text, secrets) {
  let out = ''
  let at = 0
  for (const s of secrets) {
    out += text.slice(at, s.start) + `[redacted ${s.kind}]`
    at = s.end
  }
  return out + text.slice(at)
}

/** "a GitHub token and 2 passwords" */
export function summarize(secrets) {
  const counts = new Map()
  for (const s of secrets) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1)
  const parts = [...counts].map(([kind, n]) => (n === 1 ? `${/^[aeiouAEIOU]/.test(kind) ? 'an' : 'a'} ${kind}` : `${n} ${kind}s`))
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function activate(mango) {
  mango.chat.onBeforeSend(async ({ text }) => {
    let secrets
    try {
      secrets = findSecrets(text ?? '', { generic: mango.settings.get('generic') !== false })
    } catch (e) {
      // A bug in the scan must not stop people from chatting; say so in the log.
      mango.log.error('Scan failed, message sent unchecked:', e instanceof Error ? e.message : String(e))
      return
    }
    if (!secrets.length) return

    const what = summarize(secrets)
    const action = mango.settings.get('action') ?? 'ask'
    mango.log.info(`Found ${what} in an outgoing message (${action})`)

    if (action === 'mask') {
      mango.ui.toast({ title: 'Secret masked', body: `Replaced ${what} before sending.`, kind: 'warning' })
      return { text: mask(text, secrets) }
    }

    if (action === 'block') {
      mango.ui.toast({ title: 'Message not sent', body: `It contains ${what}. Remove it and send again.`, kind: 'error' })
      return false
    }

    let send = false
    try {
      send = await mango.ui.confirm({
        title: 'This message looks like it holds a secret',
        body: `Found ${what}. Whatever you send is stored by the agent's provider. Send it anyway?`,
        confirmLabel: 'Send anyway',
        danger: true,
      })
    } catch (e) {
      // No answer is a no: keep the message here.
      mango.log.error('Could not ask:', e instanceof Error ? e.message : String(e))
    }
    if (send) return
    mango.ui.toast({ title: 'Message not sent', body: `Remove ${what} and send again.`, kind: 'info' })
    return false
  })
}
