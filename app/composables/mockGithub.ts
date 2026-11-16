import type { GhItem } from '~/types/ipc'
import { baseName } from '~/utils/paths'

/**
 * `gh_item` for the browser preview: GitHub cannot be asked from here, so any pull request or
 * issue comes back made up (and says so in its description), consistently per number.
 */

/** A drawn stand-in for a screenshot, so the preview shows how pictures in a description look. */
const PICTURE = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
<rect width="640" height="300" rx="10" fill="#1c2421"/>
<rect x="0" y="0" width="150" height="300" rx="10" fill="#151b19"/>
<rect x="18" y="24" width="96" height="10" rx="5" fill="#3a4642"/>
<rect x="18" y="50" width="112" height="22" rx="6" fill="#26302d"/>
<circle cx="30" cy="61" r="5" fill="#f0a640"/>
<rect x="42" y="57" width="70" height="8" rx="4" fill="#9aa7a2"/>
<rect x="18" y="80" width="112" height="22" rx="6" fill="none"/>
<circle cx="30" cy="91" r="5" fill="none" stroke="#7fb069" stroke-width="2"/>
<rect x="42" y="87" width="56" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="28" width="300" height="12" rx="6" fill="#d8e0dc"/>
<rect x="176" y="54" width="420" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="70" width="380" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="100" width="420" height="120" rx="8" fill="#121816"/>
<rect x="194" y="120" width="180" height="8" rx="4" fill="#7fb069"/>
<rect x="194" y="138" width="240" height="8" rx="4" fill="#e06c5f"/>
<rect x="194" y="156" width="210" height="8" rx="4" fill="#7fb069"/>
<rect x="194" y="174" width="150" height="8" rx="4" fill="#5d6a66"/>
<rect x="176" y="244" width="420" height="34" rx="10" fill="#26302d"/>
<rect x="560" y="251" width="24" height="20" rx="5" fill="#f0a640"/>
</svg>`)}`

export function mockGhItem(path: string, reference: string): GhItem {
  const ref = reference.trim()
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(pull|pulls|issues)\/(\d+)/i.exec(ref)
  const short = /^(?:([\w.-]+)\/([\w.-]+))?#?(\d+)$/.exec(ref)
  if (!url && !short) throw new Error('Paste a pull request or issue link (https://github.com/owner/repo/pull/12) or its number (#12).')
  const host = url ? url[1]!.toLowerCase() : 'github.com'
  const owner = url?.[2] ?? short?.[1] ?? 'you'
  const repo = url?.[3] ?? short?.[2] ?? baseName(path || 'project')
  const number = Number(url?.[5] ?? short?.[3])
  // Even numbers are pull requests, odd ones issues, unless the link says which.
  const isPr = url ? url[4]!.toLowerCase() !== 'issues' || number % 2 === 0 : number % 2 === 0
  const now = Date.now()
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString()

  if (isPr) {
    return {
      kind: 'pr', url: `https://${host}/${owner}/${repo}/pull/${number}`, host, owner, repo, number,
      title: number === 42 ? 'fix(chat): keep the pane when its tab closes' : 'feat(git): show ahead and behind counts in the branch popup',
      // The one the simulated agent just opened is open; others vary so the list shows a few states.
      state: number === 42 || number % 3 !== 0 ? 'open' : 'merged', stateReason: null,
      author: { login: 'you', avatarUrl: null },
      createdAt: at(0.2), updatedAt: at(0.1),
      bodyHtml: `<h2>Why</h2>
<p>Closing the last tab of a split left its pane blank, and a message sent there had nowhere to go.</p>
<h2>What changes</h2>
<ul>
<li><code>closeTab</code> returns early for unknown ids</li>
<li>Panes that showed the closed chat fall back to the neighbouring tab of the same project</li>
<li>An empty second pane closes instead of staying blank</li>
</ul>
<p><a href="https://github.com/${owner}/${repo}/pull/${number}"><img src="${PICTURE}" alt="The split view after closing a tab"></a></p>
<h2>Testing</h2>
<ul>
<li><input type="checkbox" checked disabled> Typecheck</li>
<li><input type="checkbox" checked disabled> <code>cargo test</code></li>
<li><input type="checkbox" disabled> Tried on Windows</li>
</ul>
<p><em>Simulated: the browser preview cannot ask GitHub. Inside the Mango app this is read with the GitHub CLI.</em></p>`,
      labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'chat', color: '0e8a16' }],
      comments: 2,
      headRef: number === 42 ? 'fix/pane-fallback' : 'feat/branch-counts', baseRef: 'main',
      additions: 38, deletions: 11, changedFiles: 3,
      reviewDecision: 'review_required', checks: 'pending',
    }
  }
  return {
    kind: 'issue', url: `https://${host}/${owner}/${repo}/issues/${number}`, host, owner, repo, number,
    title: 'Closing the last tab leaves a blank pane',
    state: 'open', stateReason: null,
    author: { login: 'you', avatarUrl: null },
    createdAt: at(26), updatedAt: at(3),
    bodyHtml: `<p>With two chats split side by side, closing the right one's last tab leaves an empty pane.</p>
<h3>Steps</h3>
<ol><li>Split the chat view</li><li>Close the tab in the right pane</li></ol>
<blockquote><p>Expected: the pane closes or shows the next chat.</p></blockquote>
<p><em>Simulated: the browser preview cannot ask GitHub.</em></p>`,
    labels: [{ name: 'bug', color: 'd73a4a' }],
    comments: 0,
    headRef: null, baseRef: null, additions: null, deletions: null, changedFiles: null, reviewDecision: null, checks: null,
  }
}
