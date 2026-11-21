/** The async clipboard can be refused (no permission, unfocused webview); the old copy command still works then. */
function copyFallback(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  return ok
}

/** Puts text on the clipboard. False when nothing took it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyFallback(text)
  }
}
