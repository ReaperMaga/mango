/**
 * "What's new": whether the changelog of the version you run has been opened yet. The help
 * button in the sidebar footer carries a dot until it has. A first run (nothing remembered)
 * counts as seen, so a fresh install starts quiet; the dot appears after an update.
 */
const KEY = 'mango.whatsNew.seen.v1'
const seen = ref<string | null>(null)
let loaded = false

export function useWhatsNew() {
  const { version } = useBuildInfo()

  function markSeen() {
    seen.value = version
    try { localStorage.setItem(KEY, version) } catch { /* the dot comes back next run */ }
  }

  if (!loaded) {
    loaded = true
    try { seen.value = localStorage.getItem(KEY) } catch { seen.value = null }
    if (seen.value === null) markSeen()
  }

  const unseen = computed(() => seen.value !== version)
  return { unseen, markSeen }
}
