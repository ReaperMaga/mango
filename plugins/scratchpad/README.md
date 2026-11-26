# Scratchpad

A **Scratchpad** tool window on the right with one plain-text note per project: draft a long prompt, keep findings
between chats, paste a stack trace for later.

**Send to chat** (or <kbd>Ctrl/⌘</kbd> <kbd>Enter</kbd>) sends the note to the active chat; with text selected, only the
selection. Notes are saved as you type and stay on this computer. **Open scratchpad** in the command palette opens it.

Shows: `ui.toolWindows`, a Vue component written with `mango.vue` (`defineComponent` + `h`), `storage`,
`workspace.onProjectChange`, `chat.send`, a `styles` file built on Mango's design tokens.
