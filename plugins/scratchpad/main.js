/**
 * Scratchpad: a tool window with one plain-text note per project, kept in the plugin's storage.
 * "Send to chat" sends the note (or the selected part of it) to the active chat as a message.
 *
 * Written with `mango.vue` (defineComponent + h): there is no SFC compiler at runtime, and render
 * functions keep the plugin a single file with no build step.
 */

const SAVE_DELAY = 400
const noteKey = projectPath => `note:${projectPath ?? ''}`

export function activate(mango) {
  const { defineComponent, h, ref, computed, watch, onBeforeUnmount } = mango.vue

  /* ---- the note store: one ref per project, saved debounced ---- */

  const project = ref(mango.workspace.activeProject())
  mango.workspace.onProjectChange(p => { project.value = p })

  const pending = new Map() // storage key -> timer
  const flush = (key, text) => {
    clearTimeout(pending.get(key))
    pending.delete(key)
    try {
      if (text) mango.storage.set(key, text)
      else mango.storage.delete(key)
    } catch (e) {
      mango.log.error('Could not save the note:', e)
    }
  }
  const saveLater = (key, text) => {
    clearTimeout(pending.get(key))
    pending.set(key, setTimeout(() => flush(key, text), SAVE_DELAY))
  }
  const read = key => {
    try {
      const v = mango.storage.get(key)
      return typeof v === 'string' ? v : ''
    } catch {
      return ''
    }
  }

  // Unsaved edits are written before the plugin goes away (disable, reload, quit).
  const latest = new Map() // storage key -> text not yet flushed
  mango.onDispose(() => {
    for (const [key, text] of latest) flush(key, text)
    latest.clear()
  })

  /* ---- sending ---- */

  const sendToChat = async (text) => {
    const body = text.trim()
    if (!body) return
    const thread = mango.chat.active()
    if (!thread) {
      mango.ui.toast({ title: 'No chat to send to', body: 'Open a chat, then send the note again.', kind: 'warning' })
      return
    }
    try {
      await mango.chat.send(thread.id, body)
    } catch (e) {
      mango.log.error('Send failed:', e)
      mango.ui.toast({ title: 'Could not send the note', body: e instanceof Error ? e.message : String(e), kind: 'error' })
    }
  }

  /* ---- the view ---- */

  const Scratchpad = defineComponent({
    name: 'ScratchpadView',
    setup() {
      const key = computed(() => noteKey(project.value))
      const text = ref(read(key.value))
      const area = ref(null)
      const sending = ref(false)

      // Switching projects: save what was typed for the old one, load the new one.
      watch(key, (next, prev) => {
        if (latest.has(prev)) {
          flush(prev, latest.get(prev))
          latest.delete(prev)
        }
        text.value = read(next)
      })

      const onInput = (e) => {
        text.value = e.target.value
        latest.set(key.value, text.value)
        saveLater(key.value, text.value)
      }

      onBeforeUnmount(() => {
        if (latest.has(key.value)) {
          flush(key.value, latest.get(key.value))
          latest.delete(key.value)
        }
      })

      // The selection when there is one, so a long note can hold several prompts.
      const selected = () => {
        const el = area.value
        if (!el || el.selectionStart === el.selectionEnd) return text.value
        return text.value.slice(el.selectionStart, el.selectionEnd)
      }

      const send = async () => {
        if (sending.value) return
        sending.value = true
        try { await sendToChat(selected()) } finally { sending.value = false }
      }

      const onKeydown = (e) => {
        // Ctrl/Cmd+Enter sends, like the composer.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          send()
        }
      }

      const name = computed(() => project.value?.split(/[\\/]/).filter(Boolean).pop() ?? 'No project')

      return () => h('div', { class: 'mango-scratchpad' }, [
        h('textarea', {
          ref: area,
          class: 'mango-scratchpad__text',
          value: text.value,
          placeholder: `Notes for ${name.value}. Ctrl+Enter sends them (or the selected part) to the active chat.`,
          spellcheck: false,
          'aria-label': `Notes for ${name.value}`,
          onInput,
          onKeydown,
        }),
        h('div', { class: 'mango-scratchpad__bar' }, [
          h('span', { class: 'mango-scratchpad__meta' }, text.value ? `${text.value.length.toLocaleString()} characters` : 'Saved with the project'),
          h('button', {
            type: 'button',
            class: 'mango-scratchpad__send',
            disabled: !text.value.trim() || sending.value,
            onClick: send,
          }, 'Send to chat'),
        ]),
      ])
    },
  })

  mango.ui.toolWindows.register({
    id: 'scratchpad',
    title: 'Scratchpad',
    icon: 'notebook-pen',
    view: { component: Scratchpad },
  })

  mango.commands.register({
    id: 'open',
    title: 'Open scratchpad',
    icon: 'notebook-pen',
    keywords: 'notes',
    run: () => mango.ui.toolWindows.open('scratchpad'),
  })
}
