/*
 * Terminals move between the docked panel and the main area without restarting: TerminalPanel keeps
 * one xterm per terminal and teleports it into whichever main-area pane registered a slot for it.
 *
 * Moving one by hand is a tab drag (`useTabDrag.ts`).
 *
 * Plugins' panel tabs (`ui.panelTabs`) move the same way, their views keyed by ref (`<pluginId>.<id>`,
 * which never collides with a terminal id): see TerminalPanel and PanelTabPane.
 */

/* ---------- where main-area terminals are drawn ---------- */

const slots = shallowReactive(new Map<string, HTMLElement[]>())

/** The element a main-area terminal is drawn in right now (the latest pane to show it), or null. */
export function terminalSlot(terminalId: string): HTMLElement | null {
  const list = slots.get(terminalId)
  return list?.[list.length - 1] ?? null
}

/** A pane shows this terminal in `el` until the returned function is called. */
export function registerTerminalSlot(terminalId: string, el: HTMLElement): () => void {
  slots.set(terminalId, [...(slots.get(terminalId) ?? []), el])
  return () => {
    const rest = (slots.get(terminalId) ?? []).filter(x => x !== el)
    if (rest.length) slots.set(terminalId, rest)
    else slots.delete(terminalId)
  }
}
