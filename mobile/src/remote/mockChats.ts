import type { LinkedItem, Message, Part, Thread } from '~/types/chat'
import type { GhState } from './github'
import { demoThreads } from '~/utils/demoThreads'
import { MOCK_SHOT_PATH } from './mockPictures'

/**
 * The chats the web preview's environments hold before anyone writes one: a few per project, each
 * about that project, so Home and the project screens look like a real week of work rather than the
 * same demo copied everywhere. Ids are stable (the preview reseeds on every page load, and the phone
 * keeps what it saw before). Clearly mock content: every chat is marked simulated.
 */

const MIN = 60_000
const HOUR = 60 * MIN

type Seed = Omit<Thread, 'id' | 'projectPath' | 'messages' | 'createdAt' | 'updatedAt' | 'seen' | 'mode' | 'simulated'> & {
  slug: string
  /** Minutes ago. */
  created: number
  updated: number
  seen?: boolean
  /** [user text, agent parts] per turn; the agent replies a minute after each message. */
  turns: [string, Part[]][]
}

function build(projectPath: string, idPrefix: string, now: number, seeds: Seed[]): Thread[] {
  return seeds.map(({ slug, created, updated, seen = true, turns, ...rest }) => {
    const id = `${idPrefix}-${slug}`
    const messages: Message[] = []
    turns.forEach(([text, parts], i) => {
      const at = now - created * MIN + i * 6 * MIN
      messages.push({ id: `${id}-u${i}`, role: 'user', createdAt: at, parts: [{ type: 'text', text }] })
      if (parts.length) messages.push({ id: `${id}-a${i}`, role: 'agent', createdAt: at + MIN, parts, elapsedMs: 3 * MIN, outcome: rest.status === 'error' && i === turns.length - 1 ? 'error' : 'done' })
    })
    return {
      ...rest,
      id,
      projectPath,
      mode: 'ask',
      seen,
      simulated: true,
      createdAt: now - created * MIN,
      updatedAt: now - updated * MIN,
      messages,
    }
  })
}

function mockLink(kind: LinkedItem['kind'], owner: string, repo: string, number: number, source: LinkedItem['source'], title?: string, state?: LinkedItem['state']): LinkedItem {
  return {
    key: `github.com/${owner}/${repo}#${number}`,
    kind,
    url: `https://github.com/${owner}/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    host: 'github.com',
    owner,
    repo,
    number,
    ...(title ? { title } : {}),
    ...(state ? { state } : {}),
    source,
    linkedAt: Date.UTC(2026, 10, 12),
  }
}

/**
 * What the preview's "GitHub" answers for the linked items above (`backend.ghItem`). An item
 * missing here reads as gh not being signed in, so that state shows too (the shop-admin draft).
 */
export const MOCK_GITHUB: Record<string, GhState> = {
  'github.com/acme/shop-api#128': { kind: 'pr', title: 'Refund endpoint with idempotency keys', state: 'merged', stateReason: null },
  'github.com/acme/shop-api#97': { kind: 'issue', title: 'Refunds can run twice when the client retries', state: 'closed', stateReason: 'completed' },
  'github.com/acme/shop-api#131': { kind: 'issue', title: 'checkout.test.ts > reserves stock is flaky on CI', state: 'open', stateReason: null },
}

const SEEDS: Record<string, Seed[]> = {
  'shop-api': [
    {
      slug: 'refunds',
      title: 'Refund endpoint with idempotency keys',
      agent: 'claude',
      model: 'opus',
      effort: null,
      status: 'done',
      seen: false,
      branch: 'feat/orders',
      links: [
        mockLink('pr', 'acme', 'shop-api', 128, 'agent', 'Refund endpoint with idempotency keys', 'open'),
        mockLink('issue', 'acme', 'shop-api', 97, 'user', 'Refunds can run twice when the client retries', 'open'),
      ],
      created: 75,
      updated: 4,
      turns: [[
        'Add POST /orders/:id/refund. It must be safe to retry: the same Idempotency-Key header returns the first answer instead of refunding twice.',
        [
          { type: 'thinking', text: 'Store the key with the response in a table keyed by (key, route). A unique index makes a concurrent retry fail instead of double-refunding.', seconds: 5 },
          { type: 'tool', tool: 'read', target: 'src/routes/orders.ts', status: 'ok', summary: '212 lines' },
          { type: 'tool', tool: 'write', target: 'migrations/0014_idempotency_keys.sql', status: 'ok', summary: '+11' },
          {
            type: 'tool', tool: 'edit', target: 'src/routes/orders.ts', status: 'ok', summary: '+24 −2', diff: [
              { kind: 'hunk', text: '@@ router.post(\'/orders/:id/cancel\'' },
              { kind: 'ctx', text: '})' },
              { kind: 'add', text: '' },
              { kind: 'add', text: 'router.post(\'/orders/:id/refund\', idempotent(), async (req, res) => {' },
              { kind: 'add', text: '  const order = await orders.get(req.params.id)' },
              { kind: 'add', text: '  if (!order) return res.status(404).json({ error: \'not-found\' })' },
              { kind: 'add', text: '  res.json(await refund(order))' },
              { kind: 'add', text: '})' },
            ],
          },
          { type: 'tool', tool: 'bash', target: 'pnpm test routes/orders', status: 'ok', summary: '18 passed', output: ' ✓ routes/orders.test.ts (18 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  18 passed (18)' },
          { type: 'text', text: 'Refunds are in, and retrying is safe.\n\n- `idempotent()` stores each answer under its `Idempotency-Key` for 24 hours; a retry gets the stored answer back.\n- Two requests racing with the same key: the second gets **409** instead of a second refund (unique index on `(key, route)`).\n- New migration `0014_idempotency_keys.sql`.\n\nThree new tests cover a retry, a race and a refund of an already refunded order.' },
        ],
      ]],
    },
    {
      slug: 'flaky-ci',
      title: 'Checkout test fails on CI only',
      agent: 'codex',
      model: 'default',
      effort: null,
      status: 'error',
      branch: 'feat/orders',
      links: [mockLink('issue', 'acme', 'shop-api', 131, 'user')],
      created: 5 * 60,
      updated: 4 * 60,
      turns: [[
        '`checkout.test.ts > reserves stock` passes here but fails on CI about one run in five. Find out why.',
        [
          { type: 'tool', tool: 'search', target: 'reserveStock', status: 'ok', summary: '6 matches in 4 files' },
          { type: 'tool', tool: 'read', target: 'test/checkout.test.ts', status: 'ok', summary: '96 lines' },
          { type: 'tool', tool: 'bash', target: 'for i in $(seq 20); do pnpm vitest run checkout -t "reserves stock" || break; done', status: 'error', summary: 'failed on run 7', output: "AssertionError: expected 4 to equal 3\n ❯ test/checkout.test.ts:58:31\n\n  Expected: 3\n  Received: 4" },
          { type: 'text', text: 'It fails locally too, on the 7th run: two tests share the `sku-42` fixture and run in parallel, so one sees the other\'s reservation. Giving each test its own SKU should fix it; I was cut off before I could change the fixtures.' },
        ],
      ]],
    },
    {
      slug: 'pagination',
      title: 'Cursor pagination for GET /orders',
      agent: 'claude',
      model: 'sonnet',
      effort: null,
      status: 'working',
      branch: 'feat/orders',
      created: 26 * 60,
      updated: 25 * 60,
      turns: [[
        'GET /orders returns everything. Page it with an opaque cursor, 50 per page by default.',
        [
          { type: 'tool', tool: 'read', target: 'src/routes/orders.ts', status: 'ok', summary: '188 lines' },
          { type: 'tool', tool: 'edit', target: 'src/routes/orders.ts', status: 'ok', summary: '+19 −3' },
          { type: 'text', text: 'Done: `GET /orders?limit=50&after=<cursor>` returns `{ items, next }`. The cursor is the last order\'s `(created_at, id)` in base64url, so new orders never shift a page. The old unpaged call still works and returns the first page.' },
        ],
      ]],
    },
  ],
  scratch: [
    {
      slug: 'bun-sqlite',
      title: 'Try bun:sqlite against better-sqlite3',
      agent: 'claude',
      model: 'haiku',
      effort: null,
      status: 'working',
      branch: 'main',
      created: 3 * 24 * 60,
      updated: 3 * 24 * 60 - 20,
      turns: [[
        'Write a tiny benchmark: insert 100k rows and read them back, with bun:sqlite and with better-sqlite3 under Node.',
        [
          { type: 'tool', tool: 'write', target: 'bench/sqlite.ts', status: 'ok', summary: '+48' },
          { type: 'tool', tool: 'bash', target: 'bun bench/sqlite.ts && node bench/sqlite.mjs', status: 'ok', summary: 'finished in 6.1s', output: 'bun:sqlite       insert 100k  212 ms   read 100k   61 ms\nbetter-sqlite3   insert 100k  298 ms   read 100k   94 ms' },
          { type: 'text', text: '| | insert 100k | read 100k |\n| --- | ---: | ---: |\n| bun:sqlite | 212 ms | 61 ms |\n| better-sqlite3 | 298 ms | 94 ms |\n\nBoth inside one transaction; without it each is about 40× slower. The script is in `bench/sqlite.ts`.' },
        ],
      ]],
    },
  ],
  shop: [
    {
      slug: 'rounding',
      title: 'Cart total is off by a cent',
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      status: 'done',
      seen: false,
      branch: 'main',
      created: 50,
      updated: 12,
      turns: [[
        'A customer saw 19.99 + 0.01 shipping come out as 20.01. Fix the rounding in the cart.',
        [
          { type: 'tool', tool: 'search', target: 'toFixed(', status: 'ok', summary: '9 matches in 5 files' },
          {
            type: 'tool', tool: 'edit', target: 'src/cart/total.ts', status: 'ok', summary: '+6 −5', diff: [
              { kind: 'hunk', text: '@@ export function cartTotal(lines: CartLine[], shipping: number)' },
              { kind: 'del', text: '  const sum = lines.reduce((t, l) => t + l.price * l.qty, 0)' },
              { kind: 'del', text: '  return Number((sum + shipping).toFixed(2))' },
              { kind: 'add', text: '  // Cents all the way: floats only at the edges.' },
              { kind: 'add', text: '  const cents = lines.reduce((t, l) => t + toCents(l.price) * l.qty, 0) + toCents(shipping)' },
              { kind: 'add', text: '  return cents / 100' },
            ],
          },
          { type: 'tool', tool: 'bash', target: 'pnpm test cart', status: 'ok', summary: '31 passed' },
          { type: 'text', text: 'Totals are now summed in whole cents and divided once at the end, so 19.99 + 0.01 is 20.00. I added the customer\'s case as a test, plus one with 1,000 lines of 0.10 to catch drift.' },
        ],
      ]],
    },
    {
      slug: 'reviews',
      title: 'Lazy-load reviews on the product page',
      agent: 'claude',
      model: 'opus',
      effort: null,
      status: 'working',
      branch: 'main',
      created: 9 * 60,
      updated: 8 * 60,
      turns: [
        [
          'The product page waits for all reviews before it renders. Load the first 5 with the page and the rest when they scroll into view.',
          [
            { type: 'tool', tool: 'read', target: 'src/pages/product/[slug].tsx', status: 'ok', summary: '143 lines' },
            { type: 'tool', tool: 'write', target: 'src/components/ReviewList.tsx', status: 'ok', summary: '+71' },
            { type: 'text', text: 'The page now renders with the first 5 reviews; `ReviewList` fetches the next page when its last item is 600px from the viewport. Largest Contentful Paint on the slowest product went from 2.8 s to 1.1 s locally.' },
          ],
        ],
        [
          'Show a skeleton row while the next page loads.',
          [
            { type: 'tool', tool: 'edit', target: 'src/components/ReviewList.tsx', status: 'ok', summary: '+14 −1' },
            { type: 'text', text: 'Added: three skeleton rows, the same height as a review, while a page loads. They respect reduced motion (no shimmer).' },
          ],
        ],
        [
          'Show me how it looks on a phone.',
          [
            { type: 'tool', tool: 'web', target: 'browser_take_screenshot', status: 'ok', summary: '360×480' },
            { type: 'text', text: `The product page at 360 px wide, with the first reviews and the skeleton rows below them:\n\n![Product page on a phone](${MOCK_SHOT_PATH})\n\nThe reviews start below the fold, so the page paints before any of them load.` },
          ],
        ],
      ],
    },
  ],
  'shop-admin': [
    {
      slug: 'passkeys',
      title: 'Sign in to the admin with passkeys',
      agent: 'claude',
      model: 'opus',
      effort: null,
      status: 'working',
      branch: null,
      links: [mockLink('pr', 'acme', 'shop-admin', 42, 'agent', 'Passkey sign-in plan', 'draft')],
      created: 2 * 24 * 60,
      updated: 2 * 24 * 60 - 30,
      turns: [[
        'Plan passkey sign-in for the admin. Keep passwords as a fallback for now. Don\'t write code yet.',
        [
          { type: 'thinking', text: 'WebAuthn needs an origin the browser trusts; the admin runs behind the same domain, so the RP ID is the shop\'s domain.', seconds: 7 },
          { type: 'text', text: 'Plan:\n\n1. Add `@simplewebauthn/server`; store credentials in a `passkeys` table (user, credential id, public key, counter).\n2. Settings > Security: "Add a passkey" for signed-in admins.\n3. Sign-in page: "Use a passkey" first, password below it.\n4. Turn passwords off per admin once they have two passkeys.\n\nOpen question: should support staff on shared machines keep passwords?' },
        ],
      ]],
    },
  ],
}

/** The chats a project starts with in the preview (`dir`: its folder in the instance). */
export function mockChats(projectPath: string, dir: string, idPrefix: string, now = Date.now()): Thread[] {
  const name = dir.split('/').pop() ?? dir
  // Mango's own repository gets the desktop's demo chats, which are about Mango.
  if (name === 'mango') {
    return demoThreads(projectPath).slice(0, 3).map((t, i) => ({ ...t, id: `${idPrefix}-${i}` }))
  }
  return build(projectPath, idPrefix, now, SEEDS[name] ?? [])
}
