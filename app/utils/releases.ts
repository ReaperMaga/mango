/** Mango's repository on GitHub. */
export const REPO_URL = 'https://github.com/ReaperMaga/mango'

/** Where Mango's releases live. The updater's endpoint is in src-tauri/tauri.conf.json. */
export const RELEASES_URL = `${REPO_URL}/releases`

/** A new issue, its body started with the version info a bug report needs. */
export const newIssueUrl = (info: string) => `${REPO_URL}/issues/new?body=${encodeURIComponent(`\n\n---\n${info}`)}`

/** The GitHub release page of one version (tags are `vX.Y.Z`). */
export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version.replace(/^v/, '')}`
