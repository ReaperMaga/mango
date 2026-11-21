# Secret guard

Looks at every message before it is sent and stops credentials from reaching the agent (and its provider's logs).

It recognises AWS access and secret keys, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Slack
tokens (`xox…`), Stripe live keys, Google API keys, `sk-…` API keys (OpenAI, Anthropic), JWTs, private key blocks and,
unless you turn it off, values assigned to `password`, `secret`, `token` or `api_key` (obvious placeholders such as
`<your-token>` or `${TOKEN}` are left alone).

**When a message holds a secret** (Settings > Plugins > Secret guard):

- **Ask before sending** (default): a dialog names what was found; **Send anyway** sends the message unchanged.
- **Mask the secret and send**: each secret becomes `[redacted <kind>]` and the rest is sent.
- **Block the message**: nothing is sent.

The plugin's log records the kind of secret and the action, never the secret itself.
It is a safety net, not a guarantee: a secret in an unusual format gets through.

Shows: `chat.onBeforeSend`, `ui.confirm`, `ui.toast`, `select` settings.
