/** Where Mango's releases live. The updater's endpoint is in src-tauri/tauri.conf.json. */
export const RELEASES_URL = 'https://github.com/ReaperMaga/mango/releases'

/** The GitHub release page of one version (tags are `vX.Y.Z`). */
export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version.replace(/^v/, '')}`
