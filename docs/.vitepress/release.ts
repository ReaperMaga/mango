import { readFileSync } from 'node:fs'

/**
 * The release the docs point at, derived from the root package.json at build
 * time. `pnpm bump` changes that version, so the download links follow it
 * without touching the docs.
 *
 * Asset names are the ones tauri-action uploads for tag `v<version>`
 * (see .github/workflows/release.yml).
 */

export const REPO = 'https://github.com/ReaperMaga/mango'

export interface ReleaseAsset {
  id: string
  platform: 'Windows' | 'macOS' | 'Linux'
  format: string
  file: string
  url: string
  note?: string
  recommended?: boolean
}

export interface Release {
  version: string
  tag: string
  /** The release page for this version. */
  url: string
  /** Whatever GitHub marks as the latest release. */
  latestUrl: string
  /** Every release. */
  allUrl: string
  assets: ReleaseAsset[]
}

export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  return pkg.version as string
}

export function releaseFor(version: string): Release {
  const tag = `v${version}`
  const download = (file: string) => `${REPO}/releases/download/${tag}/${file}`
  const asset = (a: Omit<ReleaseAsset, 'url'>): ReleaseAsset => ({ ...a, url: download(a.file) })
  return {
    version,
    tag,
    url: `${REPO}/releases/tag/${tag}`,
    latestUrl: `${REPO}/releases/latest`,
    allUrl: `${REPO}/releases`,
    assets: [
      asset({ id: 'windows-exe', platform: 'Windows', format: 'Installer (.exe)', file: `Mango_${version}_x64-setup.exe`, note: 'NSIS installer', recommended: true }),
      asset({ id: 'windows-msi', platform: 'Windows', format: 'MSI (.msi)', file: `Mango_${version}_x64_en-US.msi`, note: 'For managed or scripted installs' }),
      asset({ id: 'macos-arm64', platform: 'macOS', format: 'Apple Silicon (.dmg)', file: `Mango_${version}_aarch64.dmg`, note: 'M1 and later', recommended: true }),
      asset({ id: 'macos-x64', platform: 'macOS', format: 'Intel (.dmg)', file: `Mango_${version}_x64.dmg` }),
      asset({ id: 'linux-appimage', platform: 'Linux', format: 'AppImage', file: `Mango_${version}_amd64.AppImage`, note: 'Runs on most distributions', recommended: true }),
      asset({ id: 'linux-deb', platform: 'Linux', format: 'Debian / Ubuntu (.deb)', file: `Mango_${version}_amd64.deb` }),
      asset({ id: 'linux-rpm', platform: 'Linux', format: 'Fedora / RHEL (.rpm)', file: `Mango-${version}-1.x86_64.rpm` }),
    ],
  }
}

export const release = releaseFor(readVersion())
