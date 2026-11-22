import { watch } from 'vue'
import { call, isTauri, on, windowLabel } from '~/composables/useBackend'

/**
 * Keep the backend told whether this window has unsaved text: a page too busy to answer a close is
 * then not closed over it (src-tauri/src/windows.rs). At once, as the page may be busy the next
 * moment, and first as it starts: what the page before it said is over.
 */
export function tellUnsaved(has: () => boolean) {
  watch(has, (unsaved) => {
    void call('window_unsaved', { unsaved }).catch((e) => { console.error('Mango could not tell whether text is unsaved:', e) })
  }, { immediate: true, flush: 'sync' })
}

/**
 * Answer the backend whenever it asks whether this window may close (titlebar, the OS,
 * `appWindow.close`): at once that the page heard, or the backend decides without it after a few
 * seconds (src-tauri/src/windows.rs), then `mayClose`'s answer, however long that takes. Register it before
 * anything slow. In the browser preview the tab goes whatever the answer (best effort).
 */
export async function onWindowClose(mayClose: () => Promise<boolean>) {
  if (!isTauri()) {
    window.addEventListener('pagehide', () => { void mayClose() })
    return
  }
  const self = windowLabel()
  let asking: Promise<boolean> | null = null
  await on('window://close', async ({ label, id }) => {
    if (label !== self) return
    // False: too late, the backend decided or asks the user. Shutting down for it would be wrong.
    if (await call('window_close_heard', { id }).catch(() => true) === false) return
    // Each press gets an answer; pressing again while files save waits for the same one.
    asking ??= mayClose()
      .catch((e) => {
        console.error('Mango could not finish before closing the window:', e)
        return true
      })
      .finally(() => { asking = null })
    const close = await asking
    await call('window_close_answer', { id, close }).catch((e) => { console.error('Mango could not close the window:', e) })
  })
}
