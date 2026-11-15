---
name: Mango
description: A desktop agent workbench where every thread visibly ripens, from queued to working to needs-you to done.
colors:
  # Dark theme (default), Mango scheme (default). Source of truth: app/assets/css/tokens.css, same names with a leading "--".
  # The other colour schemes (blue, purple, pink, graphite) are recorded in .impeccable/design.json under extensions.schemes.
  bg-app: "oklch(0.165 0.010 160)"
  bg-canvas: "oklch(0.195 0.010 160)"
  bg-panel: "oklch(0.215 0.011 160)"
  bg-raised: "oklch(0.25 0.012 160)"
  bg-inset: "oklch(0.145 0.009 160)"
  bg-hover: "oklch(0.27 0.012 160 / 0.55)"
  bg-active: "oklch(0.30 0.014 160 / 0.7)"
  line-soft: "oklch(0.26 0.011 160)"
  line: "oklch(0.30 0.012 160)"
  line-strong: "oklch(0.38 0.014 160)"
  fg: "oklch(0.94 0.008 150)"
  fg-muted: "oklch(0.80 0.012 150)"
  fg-subtle: "oklch(0.69 0.012 150)"
  fg-faint: "oklch(0.64 0.012 155)"
  accent: "oklch(0.79 0.16 58)"
  accent-strong: "oklch(0.83 0.165 58)"
  accent-fg: "oklch(0.22 0.04 62)"
  accent-ink: "oklch(0.82 0.15 62)"
  accent-soft: "oklch(0.80 0.155 62 / 0.14)"
  accent-line: "oklch(0.80 0.155 62 / 0.45)"
  ripe-idle: "oklch(0.58 0.015 155)"
  ripe-queued: "oklch(0.70 0.11 150)"
  ripe-running: "oklch(0.77 0.17 52)"
  ripe-waiting: "oklch(0.72 0.15 28)"
  ripe-done: "oklch(0.89 0.15 92)"
  ripe-error: "oklch(0.66 0.19 22)"
  ripe-queued-fg: "oklch(0.78 0.11 150)"
  ripe-running-fg: "oklch(0.82 0.15 62)"
  ripe-waiting-fg: "oklch(0.78 0.14 28)"
  ripe-done-fg: "oklch(0.89 0.15 92)"
  ripe-error-fg: "oklch(0.74 0.16 22)"
  diff-add-bg: "oklch(0.70 0.11 150 / 0.12)"
  diff-add-fg: "oklch(0.78 0.12 150)"
  diff-del-bg: "oklch(0.66 0.19 22 / 0.12)"
  diff-del-fg: "oklch(0.74 0.14 22)"
  focus-ring: "oklch(0.80 0.155 62 / 0.7)"
  selection: "oklch(0.80 0.155 62 / 0.28)"
  scrim: "oklch(0.08 0.01 160 / 0.55)"
  # Light theme (:root[data-theme='light']). Same token names in CSS; "-light" exists only in this file.
  bg-app-light: "oklch(0.955 0.007 150)"
  bg-canvas-light: "oklch(0.985 0.004 150)"
  bg-panel-light: "oklch(1 0 0)"
  bg-raised-light: "oklch(1 0 0)"
  bg-inset-light: "oklch(0.975 0.005 150)"
  bg-hover-light: "oklch(0.90 0.010 150 / 0.55)"
  bg-active-light: "oklch(0.88 0.014 150 / 0.75)"
  line-soft-light: "oklch(0.92 0.006 150)"
  line-light: "oklch(0.88 0.008 150)"
  line-strong-light: "oklch(0.80 0.010 150)"
  fg-light: "oklch(0.24 0.015 160)"
  fg-muted-light: "oklch(0.38 0.015 160)"
  fg-subtle-light: "oklch(0.47 0.014 160)"
  fg-faint-light: "oklch(0.53 0.012 160)"
  accent-light: "oklch(0.74 0.17 60)"
  accent-strong-light: "oklch(0.70 0.17 58)"
  accent-fg-light: "oklch(0.22 0.04 62)"
  accent-ink-light: "oklch(0.52 0.15 50)"
  accent-soft-light: "oklch(0.72 0.16 60 / 0.16)"
  accent-line-light: "oklch(0.66 0.17 55 / 0.45)"
  ripe-idle-light: "oklch(0.66 0.012 155)"
  ripe-queued-light: "oklch(0.58 0.12 150)"
  ripe-running-light: "oklch(0.68 0.18 50)"
  ripe-waiting-light: "oklch(0.62 0.17 28)"
  ripe-done-light: "oklch(0.70 0.16 88)"
  ripe-error-light: "oklch(0.56 0.20 25)"
  ripe-queued-fg-light: "oklch(0.46 0.12 150)"
  ripe-running-fg-light: "oklch(0.52 0.14 50)"
  ripe-waiting-fg-light: "oklch(0.52 0.17 28)"
  ripe-done-fg-light: "oklch(0.50 0.11 85)"
  ripe-error-fg-light: "oklch(0.50 0.19 25)"
  diff-add-bg-light: "oklch(0.70 0.12 150 / 0.14)"
  diff-add-fg-light: "oklch(0.45 0.12 150)"
  diff-del-bg-light: "oklch(0.62 0.19 25 / 0.12)"
  diff-del-fg-light: "oklch(0.50 0.18 25)"
  focus-ring-light: "oklch(0.60 0.17 52 / 0.7)"
  selection-light: "oklch(0.72 0.16 60 / 0.25)"
  scrim-light: "oklch(0.30 0.02 160 / 0.25)"
typography:
  display:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.025em"
    fontFeature: "'cv11', 'ss01', 'ss03'"
  headline:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "19px"
    fontWeight: 620
    lineHeight: 1.5
    letterSpacing: "-0.015em"
    fontFeature: "'cv11', 'ss01', 'ss03'"
  title:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 620
    lineHeight: 1.5
    letterSpacing: "-0.01em"
    fontFeature: "'cv11', 'ss01', 'ss03'"
  body:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'cv11', 'ss01', 'ss03'"
  body-chat:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.62
    fontFeature: "'cv11', 'ss01', 'ss03'"
  body-sm:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'cv11', 'ss01', 'ss03'"
  label:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12.5px"
    fontWeight: 560
    lineHeight: 1.5
    fontFeature: "'cv11', 'ss01', 'ss03'"
  caption:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'cv11', 'ss01', 'ss03'"
  micro:
    fontFamily: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "'cv11', 'ss01', 'ss03'"
  mono:
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
  button-secondary:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-secondary-hover:
    backgroundColor: "{colors.bg-raised}"
  button-ghost:
    textColor: "{colors.fg-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-ghost-hover:
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.fg}"
  icon-button:
    textColor: "{colors.fg-subtle}"
    rounded: "{rounded.sm}"
    size: "28px"
  icon-button-sm:
    textColor: "{colors.fg-subtle}"
    rounded: "{rounded.xs}"
    size: "22px"
  icon-button-hover:
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.fg}"
  icon-button-active:
    backgroundColor: "{colors.bg-active}"
    textColor: "{colors.fg}"
  input:
    backgroundColor: "{colors.bg-inset}"
    textColor: "{colors.fg}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  menu:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "4px"
    width: "240px"
  menu-item:
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
    height: "30px"
  menu-item-active:
    backgroundColor: "{colors.bg-hover}"
  dialog:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    width: "460px"
  command-palette:
    backgroundColor: "{colors.bg-raised}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    width: "600px"
  composer:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "12px 8px 8px 12px"
  composer-send:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.sm}"
    size: "28px"
  chat-tab:
    textColor: "{colors.fg-subtle}"
    typography: "{typography.body-sm}"
    padding: "0 4px 0 10px"
    height: "36px"
  chat-tab-active:
    backgroundColor: "{colors.bg-canvas}"
    textColor: "{colors.fg}"
  thread-row:
    textColor: "{colors.fg-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 6px 6px 8px"
    height: "44px"
  thread-row-current:
    backgroundColor: "{colors.bg-active}"
    textColor: "{colors.fg}"
  kbd:
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.fg-subtle}"
    typography: "{typography.micro}"
    rounded: "{rounded.xs}"
    padding: "0 5px"
    height: "18px"
  ripeness-dot:
    size: "12px"
---

# Design System: Mango

## Overview

**Creative North Star: "The Orchard at Dusk"**

Mango is a desktop workbench for running several coding-agent threads at once, and its whole visual system is built around one idea: a thread is fruit on a branch, and you can see how ripe it is from across the room. In the default Mango scheme the ground is leaf shade, a green-black so low in chroma it reads as dark neutral until it sits next to a true grey. Against it, a single warm family (ripe mango flesh) carries action and identity, and a short ripening scale (bare stem, unripe leaf green, ripening orange, blush coral, ripe gold, bruise red) carries thread status. Nothing else is coloured.

The density is that of a tool, not a page: a 13.5px base, 12.5px and 11.5px for most chrome, rows of 28 to 44px, a 40px custom titlebar. Surfaces are told apart by small steps of lightness and hairlines one step lighter than the ground; shadows are kept for layers that actually float. Motion is short and decelerating (120ms state changes, 220ms for panels and dialogs), and the only thing that moves on its own is work in progress: the half-filled fruit whose level breathes, a "Thinking…" label, a streaming caret, a spinner.

The light theme is the same orchard in daylight: pale leaf-tinted paper, white panels, the accent fill kept bright while accent text and status text are deepened to hold contrast. Dark is the default; the theme is switched by `data-theme` on the root, and every component reads tokens only, so no component has a theme branch.

A colour scheme, chosen in Settings and set by `data-scheme` on the root, retints the grounds and swaps the accent family: Mango (the default, everything described here), Blue, Purple, Pink, and Graphite (neutral grey grounds with the mango accent kept). The ripening scale and the diff colours are the same in every scheme, so a thread's status reads the same whatever the room is painted.

**Key Characteristics:**
- Leaf-shade grounds (hue 160, chroma about 0.01, in the default Mango scheme) in four lightness steps, plus an inset well darker than all of them.
- One accent family per scheme (ripe mango by default), split by job: a fill with its own ink, and a separate ink for accent-coloured text and icons.
- Status as ripeness: colour plus fill level, in a fruit-shaped mark used in the sidebar, tabs, pane headers and the titlebar counter.
- Inter Variable at tool density with fractional weights; JetBrains Mono only where the content is machine text.
- Radius grows with the size of the surface: 4, 6, 8, 12px.
- Chrome is not selectable and uses the default cursor; content is selectable.
- Lucide line icons at 1.75 stroke, 16px in a 28px target, 14px in a 22px target.

## Colors

A near-neutral green-black ground, one warm accent family, and a ripening scale for status. All values are authored in OKLCH in `app/assets/css/tokens.css`; the frontmatter mirrors the default Mango scheme, with light-theme values under a `-light` suffix. The names below are Mango's; other schemes keep the roles and change the values.

### Primary
- **Ripe Mango** (`accent`): the accent as a fill. The primary button, the composer's send button, the active chat tab's 2px underline, the on-state of a switch, progress bar fill, the streaming caret, the app mark.
- **Ripe Mango Bright** (`accent-strong`): hover state of an accent fill. Lighter in dark, deeper in light.
- **Mango Stone Ink** (`accent-fg`): the dark ink that sits on an accent fill (button label, send arrow). The same value in both themes.
- **Mango Ink** (`accent-ink`): the accent as text or icon colour on a ground: links, the check mark of a selected menu item, matched characters in the command palette, the New chat icon, the active terminal tab's icon. Deepened sharply in the light theme.
- **Mango Wash** (`accent-soft`) and **Mango Line** (`accent-line`): translucent accent. The wash is the 3px focus halo around inputs and the composer and the tile behind the primary welcome action; the line is the focused input border and the colour a resize handle takes on hover.

### Secondary
The ripening scale. Each status has a mark grade (the fruit, small dots, tinted borders and washes) and, except idle, a text grade for words.

- **Bare Stem** (`ripe-idle`): idle threads, and an agent CLI that is not installed.
- **Unripe Leaf Green** (`ripe-queued`, `ripe-queued-fg`): queued. Also the small "available" dot beside an installed agent and the icon of an approval that was allowed.
- **Ripening Mango** (`ripe-running`, `ripe-running-fg`): working. A touch redder than the accent so a running thread and a button are not the same orange.
- **Blush Coral** (`ripe-waiting`, `ripe-waiting-fg`): needs you. The pending approval card takes a 55% border and a 7% wash of it.
- **Ripe Gold** (`ripe-done`, `ripe-done-fg`): done.
- **Bruise Red** (`ripe-error`, `ripe-error-fg`): failed, and destructive or invalid states in controls (danger button, field error, error banners at a 10 to 12% wash).
- **Diff green and red** (`diff-add-*`, `diff-del-*`): the leaf and bruise hues again, as a 12% row wash with text-grade ink, for added and removed lines.

### Neutral
- **Leaf-Shade Ground** (`bg-app`): the window itself: titlebar, sidebar.
- **Work Canvas** (`bg-canvas`): the main work area, one step lighter, with a 12px top-left corner where it meets the chrome.
- **Panel Lift** (`bg-panel`): surfaces that sit on the canvas: composer, user message bubble, secondary button, approval card.
- **Raised Layer** (`bg-raised`): floating layers: menus, dialogs, command palette.
- **Inset Well** (`bg-inset`): darker than every ground. The terminal, code blocks, command previews, text inputs.
- **Hover Wash** and **Active Wash** (`bg-hover`, `bg-active`): translucent, so they work on any ground. Hover and "shown" use the first; pressed, current and selected use the second.
- **Lines** (`line-soft`, `line`, `line-strong`): hairlines. Soft for dividers between regions, regular for the outline of a panel or control, strong for hover outlines and scrollbar thumbs.
- **Ink** (`fg`, `fg-muted`, `fg-subtle`, `fg-faint`): four steps. Primary text; secondary text and resting row titles; meta, hints and resting icons; timestamps and placeholders. The faintest step still clears 4.5:1 on every ground in both themes.
- **Terminal palette** (`--term-*` in tokens.css): a 16-colour ANSI set per theme, read by xterm at runtime. It is not used anywhere else. Its background and foreground follow the scheme; the ANSI colours do not.

### Color Schemes
Three root variables drive every neutral: `--hue-ground` (grounds, lines, shadows, scrim, idle stem; 160 in Mango), `--hue-ink` (text; 150 in Mango) and `--ground-tint` (a chroma multiplier; 1 in Mango, 0 is pure grey). The light theme swaps the two hues between grounds and ink. A scheme sets those three and, unless it keeps the mango accent, its own accent family (`accent`, `accent-strong`, `accent-fg`, `accent-ink`, `accent-soft`, `accent-line`, `selection`, `focus-ring`) for each theme. The per-scheme values are in the sidecar under `extensions.schemes`.

- **Mango** (default): ground hue 160, ink hue 150, tint 1; ripe-mango accent.
- **Blue:** hue 255, tint 1.3; accent at hue 252 to 260.
- **Purple:** hue 295, tint 1.3; accent at hue 295.
- **Pink:** hue 350, tint 1.1; accent at hue 350 to 355.
- **Graphite:** tint 0 (neutral grey grounds and text); mango accent kept.

Every scheme keeps `accent-fg` on `accent` at 4.5:1 or better and `accent-ink` at 5:1 or better on every ground. Any element carrying `data-scheme` re-derives the theme tokens from its own scheme, which is how a preview can show a scheme other than the current one.

### Named Rules
**The Fill-or-Ink Rule.** Mango has two jobs and two tokens. As a fill it is `accent` and the text on it is `accent-fg`. As text or an icon on a ground it is `accent-ink`. Never set text in `accent`, and never fill with `accent-ink`; in the light theme the two are far apart and the wrong one fails contrast.

**The Two-Grade Rule.** A status colour drawn as a mark (the fruit, a dot, a border, a wash) uses `ripe-*`. The same status written as words uses `ripe-*-fg`.

**The Ripeness Rule.** Status is never colour alone. It is colour plus fill level, in the ripeness dot, and wherever it matters it is also a word ("Working…", "Needs your approval", "Stopped with an error").

**The Scheme Rule.** A scheme may change the grounds and the accent family, never the status (`ripe-*`) or diff colours. Components still read tokens only; no component knows which scheme is on.

## Typography

**Display Font:** Inter Variable (with Inter, ui-sans-serif, system-ui)
**Body Font:** Inter Variable (same stack)
**Label/Mono Font:** JetBrains Mono Variable (with JetBrains Mono, ui-monospace, SF Mono, Menlo)

**Character:** One sans at tool density, tuned with the variable axis rather than with size: emphasis is a step of weight (560, 600, 620) more often than a step of scale. Inter runs with `cv11`, `ss01` and `ss03` (single-storey a, open digits, round quotes). The mono is a working face, not a flavour.

### Hierarchy
- **Display** (650, 26px, 1.25, -0.025em): the product name on the welcome hub. One per screen at most.
- **Headline** (620, 19px, -0.015em): the question in an empty chat pane.
- **Title** (620, 15px, -0.01em): dialog titles; headings inside agent prose (640); the command palette input (regular weight at this size).
- **Body** (400, 13.5px, 1.5): the base size. Welcome action titles, palette results, pane titles (600).
- **Body, chat** (400, 13.5px, 1.62): agent prose and user messages. Thinking text is capped at 68ch; the chat column at 780px.
- **Body, small** (400, 12.5px): the workhorse of the chrome: menu items, inputs, thread titles, tabs, tool lines.
- **Label** (560, 12.5px): button labels and emphasised control text; 600 for names (project switcher, group headers at 11.5px).
- **Caption** (400, 11.5px): meta lines, hints, field labels (560), status words (560).
- **Micro** (400, 10.5px): timestamps, keycaps (500), footers.
- **Mono** (JetBrains Mono, 11.5px): paths, branch names, tool targets, diff lines, command previews; 10.5px inside chips and logs.
- **Code** (JetBrains Mono, 12.5px, 1.55): code blocks in agent prose. The terminal runs at 12.5px, line height 1.25, with a blinking bar cursor.

Labels are sentence case throughout. Numbers that line up (counts, timestamps, durations) use tabular figures.

### Named Rules
**The Geometric Precision Rule.** `text-rendering: geometricPrecision` on the root is required, not a preference. Without it Linux webviews round Inter's narrow semibold word space down to 3px and words run together.

**The Machine Text Rule.** Monospace is for code, paths, branches and the terminal. Never for labels, numbers in the chrome, or decoration.

## Layout

A fixed application frame, not a page. The window is a two-row grid: a 40px titlebar over the body. The body is a resizable sidebar (264px by default, 200 to 420px) on the app ground beside a main column on the canvas. The main column stacks a 36px chat tab strip, one or two chat panes (a draggable split, 25 to 75%), and a docked terminal panel that takes 34% of the column by default (14 to 80%). Each chat pane is a 40px header, a scrolling message column capped at 780px and centred, and a composer docked at the bottom on the same 780px measure. With no project open, the body is a single centred column of 560px sitting a little above the optical middle.

Spacing steps on a 4px grid (`spacing.1` to `spacing.12`). Padding inside a region is 12 to 24px; gaps between sibling controls are 2 to 8px; list rows are separated by 1 to 2px so hover washes do not touch. Row heights do the rhythm: 22 and 28px for icon targets, 26 to 32px for controls, 30 to 34px for menu and list rows, 44px for a two-line thread row.

There are no viewport breakpoints. The window has a minimum of 960 by 600px and the layout holds there by truncating: every title, path and label ellipsises rather than wrapping. The one adaptive rule is a container query on the composer: under 400px wide it hides the permissions label and the attach button and keeps the agent and model pickers.

Resize handles are invisible 6px strips over a boundary that show a 1 to 2px Mango Line on hover and while dragging; double-click resets.

## Elevation & Depth

Depth is tonal first. Four grounds step up in lightness as surfaces come toward you (app, canvas, panel, raised), an inset well steps down for machine text, and hairlines one or two steps lighter than the ground outline panels and controls. Shadows are a second, sparing signal reserved for layers that are lifted off the canvas.

In the light theme panel and raised are both white, so the top two rungs are told apart by their outline and shadow rather than by lightness.

Stacking is fixed: resize handles 5, titlebar 20, menus 50, dialogs 60, command palette 70. Dialogs and the palette sit over a scrim (`scrim`; the palette's is thinner, at 70%).

### Shadow Vocabulary
- **Pop** (`--shadow-pop`; dark: `0 12px 32px -8px oklch(0.05 0.01 160 / 0.6), 0 2px 6px oklch(0.05 0.01 160 / 0.35)`): menus, dialogs, the command palette. Always paired with a `line` border and the raised ground.
- **Soft** (`--shadow-soft`; dark: `0 4px 14px -6px oklch(0.05 0.01 160 / 0.5)`): the composer, which is docked but lifted above the transcript.
- **Focus halo** (`0 0 0 3px` in `accent-soft`): around a focused text input and around the composer when focus is inside it. Not elevation; it is the field-level focus treatment.

Both shadows are tinted with the ground hue and are much lighter in the light theme (see the sidecar for those values).

### Named Rules
**The Lightness Ladder Rule.** A surface that is closer to the user is lighter: app, then canvas, then panel, then raised. Never lift a surface with a border alone, and never put a darker surface above a lighter one, except the inset well, which reads as a cut into its parent.

**The Floating Shadow Rule.** Shadows belong to layers that float: menus, dialogs, the palette, and the composer. Rows, cards in the flow, tabs and rails are flat.

## Shapes

Corners are softly rounded and the radius follows the size of the thing: 4px for the smallest pieces (keycaps, chips, small icon buttons, inline code, the focus ring), 6px for controls and rows (buttons, inputs, menu items, thread rows), 8px for panels inside content (menus, code blocks, tool output, approval cards, welcome rows), 12px for the largest surfaces (dialogs, the palette, the composer, the canvas's top-left corner, the user message bubble). Full pills are used only for small counters and tags, the switch and the progress track.

Borders are 1px hairlines in the line tokens, never heavier. Tinted borders are made by mixing a status colour toward transparent (35 to 60%). The user's message bubble has one squared corner (4px, bottom right) so it reads as spoken from the right; that is the only asymmetric radius besides the canvas corner.

The system's one figurative shape is the ripeness dot: a slightly lopsided mango silhouette with a small leaf, drawn on a 12-unit grid with a 1.2 stroke. The app mark (`ui/MangoMark.vue`, and `assets/icon.svg`, the source of the app icons) is the same fruit, fully ripe in Ripe Mango with the leaf in Unripe Leaf Green, and a Roman inscription capital M (thick and thin strokes, bracketed serifs) cut out of the flesh so the ground shows through. Everything else is rectangles and circles.

## Components

Controls are quiet until touched: resting chrome has no fill, hover adds the Hover Wash, pressed and current states add the Active Wash, and every state change runs 120ms on the decelerating ease.

**The Chrome and Content Rule.** Chrome text is not selectable and keeps the default cursor, like a native app. Anything a person would read closely or copy (messages, thinking text, tool output, command previews, path previews, logs) carries `.selectable`. Inputs and the terminal are always selectable.

### Ripeness Dot
The signature. A fruit-shaped mark, 12px by default (11px in tabs, 9px in the titlebar counter), whose outline is always drawn and whose flesh fills from the bottom as the thread ripens.

- **Idle:** hollow, Bare Stem, leaf in the same grey.
- **Queued:** hollow, Unripe Leaf Green.
- **Working:** half filled, Ripening Mango, and the fill level breathes between roughly a third and two thirds on a 1.8s loop.
- **Needs you:** full, Blush Coral.
- **Done:** full, Ripe Gold.
- **Failed:** full, Bruise Red, leaf dimmed.
- **Unseen:** a done or needs-you result the user has not looked at gets a 1.5px halo ring in the status colour, 3px outside the fruit, at 45% opacity. The row's title goes to primary ink at 560 at the same time.

Colour changes over 220ms and the fill level over 420ms, so a status change is seen as ripening rather than as a swap. Each dot carries a text label for assistive tech and as a tooltip.

### Buttons
- **Shape:** gently rounded (6px), 30px tall with 12px side padding; 26px and 36px sizes. Label at 12.5px, weight 550. Icons 15px at 1.85 stroke.
- **Primary:** Ripe Mango fill with Mango Stone Ink. One per view: the dialog's confirm, "Allow once".
- **Secondary:** Panel Lift fill with a `line` border; hover goes to the raised ground and a strong line.
- **Ghost:** no fill, muted ink; hover adds the Hover Wash and primary ink. Used for cancel and deny.
- **Danger:** no fill, error-coloured label and a 40% error border; hover adds a 12% error wash.
- **States:** pressed nudges down half a pixel; disabled is 55% opacity; loading shows a 12px ring spinner before the label.
- **Icon button:** a 28px square (22px small) with a 16px (14px) icon in subtle ink. Hover: Hover Wash and primary ink. Toggled on: Active Wash and primary ink, with `aria-pressed`.
- **Composer send:** a 28px Ripe Mango square with an up arrow. Empty input: Active Wash with faint ink. While the agent works it becomes a stop button in inverted ink (primary ink fill, canvas-coloured square).

### Chips
- **Picker chip (composer):** 26px tall, no fill, 11.5px at 540 in subtle ink, a 12px chevron; hover and open add the Hover Wash. The agent chip leads with an 8px identity dot (a mango square for Claude Code, a grey circle for Codex).
- **Branch chip:** 18px tall, mono 10.5px, Hover Wash fill with a soft line, 4px corners.
- **Tag pill:** 10.5px at 560 inside a dashed strong-line pill, for a qualifier such as "Simulated".
- **Attention counter (titlebar):** a 22px pill with a 9px ripeness dot and a tabular count.
- **Keycap:** 18px tall, 10.5px at 500, Hover Wash fill, soft line, 4px corners. Shortcuts are shown as separate keycaps, never as "Ctrl+K" text.

### Cards / Containers
- **Composer:** Panel Lift, `line` border, 12px corners, the Soft shadow. Focus inside it strengthens the border and adds the focus halo. The input grows from one line to 280px.
- **User message:** Panel Lift bubble with a soft line, right aligned, at most 620px or 88% of the column. Agent replies have no container at all; they are prose on the canvas.
- **Tool line:** a 28px row of icon, verb, mono target and a right-aligned tabular summary; expandable ones open an Inset Well panel (8px corners) with a diff or output. A running tool shows a ring spinner in Ripening Mango.
- **Approval card:** Panel Lift, 8px corners, command shown in an Inset Well. While pending it takes the Blush Coral border and wash and holds the one primary button; once resolved it drops to a plain line and subtle ink.
- **Dialog:** raised ground, `line` border, 12px corners, Pop shadow, 460px wide by default (a task that needs room sets its own width, as "Get started" does at 600px), placed 14vh from the top. The panel is a column capped at `calc(86vh - 24px)`: a 15px title, a body with 20px padding that scrolls inside the panel when it runs tall, and a footer set off by a soft line and a slightly darker ground with actions right aligned. While the body is scrolled, the head takes a 1px `line` bottom edge, faded in over 120ms, so cut-off content reads as scrolled rather than broken. Escape and a scrim click close it, except while something runs that closing would cut off (the dialog is then not dismissible), and Escape inside an embedded terminal belongs to the program. On open, focus goes to the first field or the `data-autofocus` button, else to the panel itself. Enters by fading and settling 6px down from 98.5% scale over 220ms.
- **Tool rows (in a dialog):** a status icon in a 14px lead column, the name (600) with a subtle version beside it, a status word (560, in the status's text grade) followed by a subtle meta line, and the row's one action at the right. Rows are split by `line` rules, with no container around the list.
- **Embedded terminal (job panel):** an installer or a CLI sign-in running in place. An outlined group with a `line` border and 8px corners: a 38px header with a status ring (or a warning icon once failed), a title, and ghost actions (Stop, Cancel, Copy link); then the terminal, inset on `--term-bg` under a rule; then one line of subtle hint. Focus inside it turns the border to Mango Line; a failed run turns it to the error colour mixed 45% toward transparent and keeps the output. Its ground follows the Lightness Ladder Rule: on the canvas (Settings > Agents) it sits on Panel Lift, inside a raised dialog it stays transparent, because a panel ground there would be a darker surface above a lighter one.
- **Command palette:** the same floating treatment at 600px wide: a 50px search row at 15px, grouped results in 34px rows, the selected row in Active Wash, matched characters in Mango Ink at 600.

### Inputs / Fields
- **Style:** 32px tall, Inset Well fill, `line` border, 6px corners, 12.5px text, faint placeholder. A field is label (11.5px, 560, muted) over control over one line of hint, 6px apart; fields stack 16px apart.
- **Focus:** the border turns to Mango Line and a 3px Mango Wash halo appears. The global ring is suppressed on fields. The caret is Ripe Mango.
- **Everything else:** `:focus-visible` draws a 2px `focus-ring` outline at 1px offset.
- **Error:** a 60% error border and the hint replaced by an error message with `role="alert"`.
- **Switch:** a 30 by 18px pill; off is Active Wash with a strong inset line and a muted thumb, on is Ripe Mango with a Mango Stone Ink thumb.
- **Scheme picker** (Settings > Appearance, "Color scheme"): a radio group of 52 by 36px miniature workspaces, each painted in its own scheme through `data-scheme` (an app-ground rail, the canvas with two faint text lines, a small accent button), with the scheme name in 11.5px subtle ink below. Hover strengthens the preview's border; the selected one is ringed with a 2px `accent` outline at 2px offset and its name goes to primary ink at 560; keyboard focus rings it in `focus-ring`.
- **Path preview:** an Inset Well row showing the resulting path in mono, truncated from the left so the final folder (primary ink, 600) always stays visible.

### Navigation
- **Titlebar (40px):** app mark, sidebar toggle, project switcher (600, with a chevron, opens a menu), branch in mono; a centred command search styled as a quiet field with two keycaps; attention counter, terminal toggle, theme toggle, then 44px-wide window controls whose close button fills with the error colour on hover. The whole bar is a window drag region.
- **Sidebar:** a full-width "New chat" button (Panel Lift, soft line, Mango Ink icon, keycaps), then the current project's threads in three sections: the open chats ("Working"), then Settled and Archived, which fold away. The open section grows to fill the list, so Settled and Archived always sit at the bottom of the sidebar. Group headers are 28px, 11.5px at 600, with a rotating caret and a faint count; their actions appear on hover. A thread row is 44px: ripeness dot, title over a one-line status, timestamp at the right that gives way to a "more" button on hover. Shown in a pane: Hover Wash. Current: Active Wash and primary ink. The footer lists agent availability with 6px dots.
- **Chat tabs (36px):** ripeness dot, title, close button that appears on hover or when active. The active tab takes the canvas ground and a 2px Ripe Mango underline; a tab shown in the other split pane takes a strong-line underline instead.
- **Terminal tabs:** 24px pills on the Inset Well; the active one gets the Hover Wash and a Mango Ink icon.
- **Menus:** raised ground, 8px corners, Pop shadow, 4px padding; 30px items at 12.5px with an optional icon column, a second hint line, and either a Mango Ink check or a faint shortcut at the right. The active item gets the Hover Wash. Opens 6px from its trigger, scaling from 97% in 120ms.

## Do's and Don'ts

### Do:
- **Do** take every colour, size, space, radius and duration from `app/assets/css/tokens.css`. Components read tokens only; that is what makes the light theme and the colour schemes work without a single theme or scheme branch.
- **Do** use `accent` with `accent-fg` for fills and `accent-ink` for accent-coloured text and icons (The Fill-or-Ink Rule).
- **Do** use `ripe-*` for marks, borders and washes and `ripe-*-fg` for status words (The Two-Grade Rule).
- **Do** show thread status with the ripeness dot wherever a thread is named, and back it with a status word where there is room.
- **Do** lift surfaces by lightness: app, canvas, panel, raised, with the inset well for terminals, code and inputs.
- **Do** keep `text-rendering: geometricPrecision` on the root.
- **Do** mark readable or copyable content with `.selectable`; leave chrome unselectable.
- **Do** truncate with an ellipsis and keep a `title` on the element; the frame must hold at 960 by 600px.
- **Do** keep state transitions at 120ms and panel or dialog movement at 220ms on `--ease-out`, and honour `prefers-reduced-motion` (the base stylesheet already collapses durations).
- **Do** write labels in sentence case and show shortcuts as keycaps.

### Don't:
- **Don't** set text in `accent` or fill with `accent-ink`.
- **Don't** signal status with colour alone, and don't draw status as a plain round dot where the ripeness dot belongs.
- **Don't** introduce a second accent hue within a scheme. Colour outside the scheme's accent family and the ripening scale is reserved for the terminal's ANSI palette.
- **Don't** let a scheme touch `ripe-*` or `diff-*` (The Scheme Rule).
- **Don't** put shadows on rows, tabs, rails or cards in the flow; shadows are for menus, dialogs, the palette and the composer.
- **Don't** separate surfaces with a border alone when they are at different depths; change the ground.
- **Don't** use monospace for anything that is not code, a path, a branch or terminal output.
- **Don't** write a raw colour, pixel font size or duration in a component when a token exists.
- **Don't** animate anything that is not a state change or work in progress.
