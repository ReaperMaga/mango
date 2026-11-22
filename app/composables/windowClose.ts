import { appWindow, isTauri } from '~/composables/useBackend'

/**
 * Ask `mayClose` whenever this window is asked to close (titlebar, the OS, `appWindow.close`): it
 * stays open until the answer is there, and for a false one. In the browser preview the page goes
 * whatever the answer.
 */
export async function onWindowClose(mayClose: () => Promise<boolean>) {
  if (!isTauri()) return appWindow.onClose(async () => { await mayClose() })
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  let asking: Promise<boolean> | null = null
  await getCurrentWindow().onCloseRequested(async (event) => {
    // A second press of Close while files save waits for the same answer.
    asking ??= mayClose()
      .catch((e) => {
        console.error('Mango could not finish before closing the window:', e)
        return true
      })
      .finally(() => { asking = null })
    if (!await asking) event.preventDefault()
  })
}
