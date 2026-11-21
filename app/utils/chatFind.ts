/**
 * Asks the chat pane in front to open its find bar. The shortcut (Mod+F) bumps it; the active
 * chat pane watches it. A counter, so asking again while the bar is open still refocuses it.
 */
export const findRequest = ref(0)
