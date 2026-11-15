<script setup lang="ts">
/**
 * A drawn (HTML) picture of the Mango window for the home page: sidebar of
 * chats by status, a chat waiting on an approval, and the docked terminal.
 * Content mirrors the app's demo threads. Decorative: one label for readers.
 */
type Ripe = 'running' | 'working' | 'waiting' | 'error' | 'done'
const body = 'M6.6 1.6c2.6.3 4.1 2.6 3.7 5.1-.4 2.4-2.4 3.9-4.6 3.7C3.3 10.2 1.6 8.3 1.8 6c.3-2.6 2.3-4.6 4.8-4.4Z'

const working: Array<{ title: string; sub: string; ripe: Ripe; when: string; active?: boolean; tone?: 'waiting' | 'error' }> = [
  { title: 'Persist threads to SQLite', sub: 'Working…', ripe: 'running', when: 'now' },
  { title: 'Clone dialog: show git progress', sub: 'Needs your approval', ripe: 'waiting', when: '1m', active: true, tone: 'waiting' },
  { title: 'Command palette fuzzy matching', sub: 'Failed', ripe: 'error', when: '2h', tone: 'error' },
  { title: 'Write the README', sub: 'Working · Claude Code', ripe: 'working', when: '1d' },
]
const settled = [
  { title: 'Wire the terminal to a real PTY', sub: 'Settled · Claude Code', when: '2m' },
  { title: 'Status check', sub: 'Settled · Claude Code', when: '1h' },
]
const tabs: Array<{ title: string; ripe: Ripe; active?: boolean }> = [
  { title: 'Wire the terminal to a real PTY', ripe: 'done' },
  { title: 'Clone dialog: show git progress', ripe: 'waiting', active: true },
  { title: 'Persist threads to SQLite', ripe: 'running' },
]
const level: Record<Ripe, number> = { running: 6, working: 6, waiting: 0, error: 0, done: 0 }
</script>

<template>
  <div class="win" role="img" aria-label="The Mango window: chats grouped by status in the sidebar, a Codex chat asking to run a command, and a terminal docked at the bottom.">
    <!-- titlebar -->
    <div class="tb">
      <div class="tb__left">
        <svg class="tb__mark" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" class="m-bg" /><path class="m-fg" d="M18 44V21.5h4.6l9.4 13 9.4-13H46V44h-5.4V30.4L32 42.2l-8.6-11.8V44Z" /></svg>
        <span class="tb__project">mango <i class="chev" /></span>
        <span class="tb__branch mono">
          <svg viewBox="0 0 24 24" class="ic"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 5-8 3-11.5 7.5" /></svg>
          main
        </span>
      </div>
      <div class="tb__search">
        <svg viewBox="0 0 24 24" class="ic"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
        <span class="tb__search-text">Search threads or run a command</span>
        <span class="kbd">Ctrl</span><span class="kbd">K</span>
      </div>
      <div class="tb__right">
        <span class="tb__att"><i class="att-dot" />2</span>
        <span class="tb__ctl"><i class="ctl-min" /></span>
        <span class="tb__ctl"><i class="ctl-max" /></span>
        <span class="tb__ctl"><i class="ctl-x" /></span>
      </div>
    </div>

    <div class="main">
      <!-- sidebar -->
      <aside class="side">
        <div class="side__new"><span>New chat</span><span class="side__kbd">Ctrl N</span></div>
        <div class="side__group">Working <span>4</span></div>
        <div v-for="t in working" :key="t.title" class="row" :class="{ 'is-active': t.active }">
          <svg class="ripe" :class="`ripe--${t.ripe}`" viewBox="0 0 12 12">
            <defs><clipPath :id="`c-${t.title.length}-${t.ripe}`"><rect x="0" y="0" width="12" height="12" :transform="`translate(0 ${level[t.ripe]})`" /></clipPath></defs>
            <path class="ripe__skin" :d="body" /><path class="ripe__flesh" :d="body" :clip-path="`url(#c-${t.title.length}-${t.ripe})`" />
          </svg>
          <span class="row__text">
            <span class="row__title">{{ t.title }}</span>
            <span class="row__sub" :class="t.tone && `tone-${t.tone}`">{{ t.sub }}</span>
          </span>
          <span class="row__when">{{ t.when }}</span>
        </div>
        <div class="side__spacer" />
        <div class="side__group">Settled <span>2</span></div>
        <div v-for="t in settled" :key="t.title" class="row">
          <svg class="ripe ripe--done" viewBox="0 0 12 12"><path class="ripe__skin" :d="body" /><path class="ripe__flesh" :d="body" /></svg>
          <span class="row__text">
            <span class="row__title">{{ t.title }}</span>
            <span class="row__sub">{{ t.sub }}</span>
          </span>
          <span class="row__when">{{ t.when }}</span>
        </div>
      </aside>

      <div class="work">
        <!-- chat tabs -->
        <div class="tabs">
          <span v-for="t in tabs" :key="t.title" class="tab" :class="{ 'is-active': t.active }">
            <svg class="ripe" :class="`ripe--${t.ripe}`" viewBox="0 0 12 12">
              <defs><clipPath :id="`t-${t.ripe}`"><rect x="0" y="0" width="12" height="12" :transform="`translate(0 ${level[t.ripe]})`" /></clipPath></defs>
              <path class="ripe__skin" :d="body" /><path class="ripe__flesh" :d="body" :clip-path="`url(#t-${t.ripe})`" />
            </svg>
            <span class="tab__title">{{ t.title }}</span>
          </span>
        </div>

        <!-- chat -->
        <div class="chat">
          <div class="chat__col">
            <div class="msg-user">Show git's clone progress inside the clone dialog instead of a spinner.</div>
            <p class="msg-agent">I'll check what <code>git clone --progress</code> prints, then stream each line into the dialog as it arrives.</p>
            <div class="tool"><span class="tool__verb">Searched</span><code>clone://progress</code><span class="tool__meta">2 matches in 2 files</span></div>
            <div class="tool"><span class="tool__verb">Read</span><code>app/components/CloneDialog.vue</code><span class="tool__meta">163 lines</span></div>
            <div class="tool"><span class="tool__verb">Edited</span><code>src-tauri/src/projects.rs</code><span class="tool__meta"><b class="add">+18</b> <b class="del">−3</b></span></div>

            <div class="approve">
              <div class="approve__head">
                <svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1V14M12 17h.01" /></svg>
                Codex wants to run a command
              </div>
              <div class="approve__cmd mono">git clone --progress https://github.com/tauri-apps/tauri /tmp/clone-check</div>
              <div class="approve__why">Check what git prints on a real clone before parsing it</div>
              <div class="approve__btns"><span class="btn btn--primary">Allow once</span><span class="btn">Deny</span></div>
            </div>

            <div class="composer">
              <span class="composer__ph">Ask Codex to build, fix or explain…</span>
              <span class="composer__bar">
                <span class="pill"><i class="agent-dot" />Codex</span><span class="pill">Default</span><span class="pill">Ask first</span>
              </span>
            </div>
          </div>
        </div>

        <!-- terminal -->
        <div class="term">
          <div class="term__tabs"><span class="term__tab">mango</span><span class="term__tab is-dim">pwsh</span></div>
          <div class="term__body mono">
            <div><span class="t-dir">mango</span> <span class="t-git">main</span> <span class="t-pr">❯</span> pnpm vue-tsc --noEmit</div>
            <div class="t-dim">Type check passed in 6.2s</div>
            <div><span class="t-dir">mango</span> <span class="t-git">main</span> <span class="t-pr">❯</span> <span class="caret" /></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Mango's own tokens for the drawing, light and dark (from app/assets/css/tokens.css). */
.win {
  --app: oklch(0.955 0.007 150);
  --canvas: oklch(0.985 0.004 150);
  --panel: oklch(1 0 0);
  --inset: oklch(0.975 0.005 150);
  --hover: oklch(0.90 0.010 150 / 0.55);
  --active: oklch(0.88 0.014 150 / 0.75);
  --line: oklch(0.88 0.008 150);
  --line-soft: oklch(0.92 0.006 150);
  --fg: oklch(0.24 0.015 160);
  --fg-muted: oklch(0.38 0.015 160);
  --fg-subtle: oklch(0.47 0.014 160);
  --fg-faint: oklch(0.53 0.012 160);
  --accent: oklch(0.74 0.17 60);
  --accent-fg: oklch(0.22 0.04 62);
  --accent-line: oklch(0.66 0.17 55 / 0.45);
  --running: oklch(0.68 0.18 50);
  --waiting: oklch(0.62 0.17 28);
  --waiting-fg: oklch(0.52 0.17 28);
  --done: oklch(0.70 0.16 88);
  --error: oklch(0.56 0.20 25);
  --error-fg: oklch(0.50 0.19 25);
  --leaf: oklch(0.45 0.12 150);
  --add: oklch(0.45 0.12 150);
  --del: oklch(0.50 0.18 25);
  --shadow: 0 30px 80px -30px oklch(0.3 0.02 160 / 0.35), 0 8px 24px -12px oklch(0.3 0.02 160 / 0.2);
}
.dark .win {
  --app: oklch(0.165 0.010 160);
  --canvas: oklch(0.195 0.010 160);
  --panel: oklch(0.215 0.011 160);
  --inset: oklch(0.145 0.009 160);
  --hover: oklch(0.27 0.012 160 / 0.55);
  --active: oklch(0.30 0.014 160 / 0.7);
  --line: oklch(0.30 0.012 160);
  --line-soft: oklch(0.26 0.011 160);
  --fg: oklch(0.94 0.008 150);
  --fg-muted: oklch(0.80 0.012 150);
  --fg-subtle: oklch(0.69 0.012 150);
  --fg-faint: oklch(0.64 0.012 155);
  --accent: oklch(0.79 0.16 58);
  --accent-fg: oklch(0.22 0.04 62);
  --accent-line: oklch(0.80 0.155 62 / 0.45);
  --running: oklch(0.77 0.17 52);
  --waiting: oklch(0.72 0.15 28);
  --waiting-fg: oklch(0.78 0.14 28);
  --done: oklch(0.89 0.15 92);
  --error: oklch(0.66 0.19 22);
  --error-fg: oklch(0.74 0.16 22);
  --leaf: oklch(0.78 0.11 150);
  --add: oklch(0.78 0.12 150);
  --del: oklch(0.74 0.14 22);
  --shadow: 0 40px 100px -30px oklch(0.05 0.01 160 / 0.8), 0 10px 30px -12px oklch(0.05 0.01 160 / 0.5);
}

.win {
  width: 100%;
  max-width: 1120px;
  height: 640px;
  display: grid;
  grid-template-rows: 40px 1fr;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--app);
  box-shadow: var(--shadow);
  color: var(--fg);
  font-family: 'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
  user-select: none;
}
.mono { font-family: var(--vp-font-family-mono); }
.ic { width: 13px; height: 13px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.chev { display: inline-block; width: 6px; height: 6px; margin: 0 2px 2px 4px; border-right: 1.5px solid var(--fg-subtle); border-bottom: 1.5px solid var(--fg-subtle); transform: rotate(45deg); }

/* ---------- titlebar ---------- */
.tb { display: grid; grid-template-columns: 1fr minmax(200px, 400px) 1fr; align-items: center; gap: 12px; padding-left: 12px; }
.tb__left, .tb__right { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tb__right { justify-content: flex-end; align-self: stretch; gap: 0; }
.tb__mark { width: 17px; height: 17px; flex: none; }
.m-bg { fill: var(--accent); }
.m-fg { fill: var(--accent-fg); }
.tb__project { font-weight: 600; white-space: nowrap; }
.tb__branch { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--fg-subtle); }
.tb__search {
  display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 6px 0 10px;
  border-radius: 6px; border: 1px solid var(--line-soft); background: var(--hover); color: var(--fg-faint);
}
.tb__search-text { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.kbd { padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); font-size: 10.5px; color: var(--fg-subtle); }
.tb__att { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; margin: auto 8px auto 0; border-radius: 999px; background: var(--hover); font-size: 11px; font-weight: 600; color: var(--fg-muted); }
.att-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--waiting); }
.tb__ctl { width: 40px; display: grid; place-items: center; }
.tb__ctl i { display: block; }
.ctl-min { width: 10px; border-top: 1.2px solid var(--fg-subtle); }
.ctl-max { width: 9px; height: 9px; border: 1.2px solid var(--fg-subtle); border-radius: 1.5px; }
.ctl-x { width: 11px; height: 11px; background: linear-gradient(45deg, transparent 46%, var(--fg-subtle) 46%, var(--fg-subtle) 54%, transparent 54%), linear-gradient(-45deg, transparent 46%, var(--fg-subtle) 46%, var(--fg-subtle) 54%, transparent 54%); }

/* ---------- body ---------- */
.main { display: grid; grid-template-columns: 250px 1fr; min-height: 0; }

.side { display: flex; flex-direction: column; gap: 1px; padding: 8px; min-width: 0; }
.side__new { display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 10px; margin-bottom: 10px; border-radius: 6px; background: var(--hover); font-weight: 600; }
.side__kbd { font-size: 10.5px; color: var(--fg-faint); font-weight: 400; }
.side__group { padding: 4px 8px; font-size: 11px; font-weight: 600; color: var(--fg-subtle); }
.side__group span { margin-left: 4px; font-weight: 400; color: var(--fg-faint); }
.side__spacer { flex: 1; }
.row { display: grid; grid-template-columns: 12px 1fr auto; gap: 8px; align-items: start; padding: 6px 8px; border-radius: 6px; }
.row.is-active { background: var(--active); }
.row .ripe { margin-top: 3px; }
.row__text { display: grid; min-width: 0; }
.row__title, .row__sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row__title { font-weight: 500; }
.row__sub { font-size: 11px; color: var(--fg-subtle); }
.row__when { font-size: 10.5px; color: var(--fg-faint); margin-top: 2px; }
.tone-waiting { color: var(--waiting-fg); }
.tone-error { color: var(--error-fg); }

.ripe { width: 12px; height: 12px; overflow: visible; }
.ripe__skin { fill: none; stroke: var(--c); stroke-width: 1.2; }
.ripe__flesh { fill: var(--c); stroke: var(--c); stroke-width: 1.2; }
.ripe--running, .ripe--working { --c: var(--running); }
.ripe--waiting { --c: var(--waiting); }
.ripe--error { --c: var(--error); }
.ripe--done { --c: var(--done); }

.work {
  display: grid;
  grid-template-rows: 34px 1fr 128px;
  min-width: 0;
  min-height: 0;
  border-top-left-radius: 10px;
  border-left: 1px solid var(--line-soft);
  border-top: 1px solid var(--line-soft);
  background: var(--canvas);
  overflow: hidden;
}
.tabs { display: flex; align-items: stretch; border-bottom: 1px solid var(--line-soft); overflow: hidden; }
.tab { display: flex; align-items: center; gap: 7px; max-width: 220px; padding: 0 12px; border-right: 1px solid var(--line-soft); color: var(--fg-subtle); }
.tab.is-active { color: var(--fg); background: var(--panel); box-shadow: inset 0 -1.5px 0 var(--accent); }
.tab__title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.chat { min-height: 0; overflow: hidden; padding: 18px 24px 14px; display: flex; justify-content: center; }
.chat__col { width: 100%; max-width: 600px; display: flex; flex-direction: column; gap: 8px; }
.msg-user { align-self: flex-end; max-width: 80%; padding: 8px 12px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line-soft); }
.msg-agent { margin: 4px 0 2px; color: var(--fg); line-height: 1.6; }
code { font-family: var(--vp-font-family-mono); font-size: 11px; padding: 0 4px; border-radius: 4px; background: var(--hover); color: var(--fg-muted); }
.tool { display: flex; align-items: baseline; gap: 8px; color: var(--fg-subtle); font-size: 12px; }
.tool__verb { color: var(--fg-muted); font-weight: 500; }
.tool code { background: none; padding: 0; color: var(--fg-muted); }
.tool__meta { margin-left: auto; font-size: 11px; color: var(--fg-faint); }
.add { color: var(--add); font-weight: 500; }
.del { color: var(--del); font-weight: 500; }

.approve { margin-top: 6px; padding: 12px; border-radius: 8px; border: 1px solid var(--accent-line); background: var(--panel); display: grid; gap: 8px; }
.approve__head { display: flex; align-items: center; gap: 7px; font-weight: 600; }
.approve__head .ic { color: var(--accent); }
.approve__cmd { padding: 8px 10px; border-radius: 6px; background: var(--inset); font-size: 11px; color: var(--fg); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.approve__why { font-size: 11.5px; color: var(--fg-subtle); }
.approve__btns { display: flex; gap: 6px; }
.btn { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 6px; font-weight: 550; color: var(--fg-muted); }
.btn--primary { background: var(--accent); color: var(--accent-fg); }

.composer { margin-top: auto; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); display: grid; gap: 10px; }
.composer__ph { color: var(--fg-faint); }
.composer__bar { display: flex; gap: 12px; font-size: 11px; color: var(--fg-subtle); }
.pill { display: inline-flex; align-items: center; gap: 5px; }
.agent-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-subtle); }

.term { border-top: 1px solid var(--line-soft); background: var(--inset); display: grid; grid-template-rows: 28px 1fr; min-height: 0; }
.term__tabs { display: flex; align-items: center; gap: 4px; padding: 0 8px; }
.term__tab { padding: 2px 8px; border-radius: 5px; background: var(--hover); font-size: 11px; color: var(--fg); }
.term__tab.is-dim { background: none; color: var(--fg-faint); }
.term__body { padding: 4px 14px; font-size: 11.5px; line-height: 1.7; color: var(--fg); }
.t-dir { color: var(--leaf); }
.t-git { color: var(--fg-subtle); }
.t-pr { color: var(--accent); }
.t-dim { color: var(--fg-faint); }
.caret { display: inline-block; width: 7px; height: 13px; vertical-align: -2px; background: var(--fg-muted); }

/* Narrow screens: the chat alone, like a narrow window with the sidebar hidden. */
@media (max-width: 900px) {
  .main { grid-template-columns: 1fr; }
  .side { display: none; }
  .work { border-left: 0; border-top-left-radius: 0; }
  .tb { grid-template-columns: auto 1fr auto; }
  .tb__branch, .tb__ctl { display: none; }
}
@media (max-width: 560px) {
  .win { height: 540px; }
  .work { grid-template-rows: 34px 1fr; }
  .term, .msg-agent { display: none; }
  .tb__search-text, .kbd { display: none; }
  .tb__search { justify-self: end; width: 30px; padding: 0; justify-content: center; }
  .chat { padding: 14px; }
  .tool__meta { display: none; }
  .tab:not(.is-active) { display: none; }
}
</style>
