# Releasing

Mango uses [semantic versioning](https://semver.org). The root `package.json` is the single source of the version:

- `src-tauri/tauri.conf.json` reads it (`"version": "../package.json"`).
- The frontend bakes it in at build time together with the git commit (`nuxt.config.ts`); it shows in **Settings > Preferences**.
- `pnpm bump` keeps the copies in `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` in step.
- This documentation reads it at build time for the download links and the version in the navigation.

Never edit a version by hand.

## The updater signing key

Mango [updates itself](../guide/updates) from GitHub releases, and only installs bundles signed with Mango's updater key. The public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`; the private half is a repository secret the release build signs with:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | The contents of the private key file. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password. Leave it unset for a key without one. |

The release workflow stops at its first step when the key secret is missing. Set it with the GitHub CLI:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/mango-updater.key
```

Keep the private key safe and backed up. Installed copies of Mango only accept updates signed with it: if it is lost, users have to install the next version by hand. To replace it, generate a new pair with `pnpm tauri signer generate -w ~/.tauri/mango-updater.key`, put the public key in `tauri.conf.json`, update the secret, and expect that one release to be a manual install.

Updater bundles and their signatures are only produced in the release workflow, which adds `--config src-tauri/tauri.updater.conf.json` (`bundle.createUpdaterArtifacts`). A local `pnpm app:build` needs no key.

## Cut a release

1. Set the new version everywhere:

   ```bash
   pnpm bump patch     # or minor, major, or an exact version such as 1.2.3
   ```

   `pnpm version:check` confirms that every copy agrees (it exits with 1 if not). The bump script never commits or tags; it prints the commands for that.

2. The [changelog](../changelog) (`docs/changelog.md`) was written by the bump: the `feat`, `fix` and `perf` commits since the last tag, plus anything under `## Unreleased`. Read it over and polish the wording before committing. The release workflow stops if the version has no section.

3. Commit and tag:

   ```bash
   git commit -am "chore(release): vX.Y.Z"
   git tag vX.Y.Z
   ```

4. Push the commit and the tag:

   ```bash
   git push
   git push origin vX.Y.Z
   ```

## What the tag starts

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`:

1. **Check version**: every copy of the version must agree, and the tag must match `package.json`; otherwise the run stops. It then creates a draft GitHub release for the tag, with generated notes.
2. **Build**: Windows x64, Linux x64, macOS Apple Silicon and macOS Intel build in parallel (both Macs on GitHub's Apple Silicon runner; Intel is cross-compiled with `--target x86_64-apple-darwin`) with `tauri-action`, sign every installer with the updater key, and upload the installers, their `.sig` files and `latest.json` to the draft release.
3. **Publish**: once every build has succeeded, the release leaves draft and is marked as the latest. From then on, running copies of Mango find it: the updater reads `releases/latest/download/latest.json`. A version with a pre-release suffix (`1.2.0-beta.1`) is published as a pre-release instead.

The release carries these files (for version `X.Y.Z`):

| Platform | File |
| --- | --- |
| Windows | `Mango_X.Y.Z_x64-setup.exe`, `Mango_X.Y.Z_x64_en-US.msi` |
| macOS | `Mango_X.Y.Z_aarch64.dmg`, `Mango_X.Y.Z_x64.dmg` (plus the updater bundles `Mango_aarch64.app.tar.gz`, `Mango_x64.app.tar.gz`) |
| Linux | `Mango_X.Y.Z_amd64.AppImage`, `Mango_X.Y.Z_amd64.deb`, `Mango-X.Y.Z-1.x86_64.rpm` |

The [install page](../guide/install) links to these names for the version in `package.json`, so they are right as soon as the release is published.

The workflow can also be started by hand (**Run workflow** in GitHub Actions). A manual run builds every platform and keeps the installers as workflow artifacts, without creating a release: use it to try a build before tagging.

### Build cache

A run for a tag can only restore caches saved on that tag or on `main`, so a release cannot reuse what the previous release compiled. `.github/workflows/rust-cache.yml` does the same release build (without installers) on `main` whenever `src-tauri/` changes, and twice a week so the cache does not expire. Both workflows use the cache key `release`; the release workflow only reads it. A release then compiles Mango itself instead of every dependency. The same workflow also runs the CI's Rust jobs on `main` (keys `ci-linux`, `ci-windows` and `ci-macos`), which is the only place they save their caches for pull requests to restore. If the cache is cold (new `Cargo.lock`, new Rust version), run **Rust cache** by hand before tagging.

### macOS signing

The release builds sign the macOS app with a Developer ID Application certificate and notarize it, using these repository secrets (the "Apple signing secrets" step exports only the ones that are set; see [Tauri's macOS signing guide](https://tauri.app/distribute/sign/macos/)):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the certificate and its private key as a `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12`'s password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `KEYCHAIN_PASSWORD` | any random string, for the build's temporary keychain |
| `APPLE_API_KEY_P8` | an App Store Connect API key (Users and Access > Integrations > Team Keys, Developer role or higher): the `.p8` file's contents, for notarization |
| `APPLE_API_KEY`, `APPLE_API_ISSUER` | that key's Key ID and the Issuer ID shown above the key list |

Without `APPLE_CERTIFICATE` the app is unsigned; without the notarization secrets it is signed but not notarized, and the run warns either way.

Tauri signs the app and the DMG, and `scripts/release-macos.sh` (tauri-action's build command on macOS) then notarizes the DMG and staples the ticket to it. The API key reaches the build as `NOTARY_*`, not `APPLE_API_*`, so Tauri does not notarize on its own: it waits on Apple with no time limit, and a slow notary queue once held a release for four hours. The script retries its uploads and status checks, and gives Apple 40 minutes (`NOTARY_TIMEOUT_MINUTES`). Past that the job fails and prints the submission id. Check it from a Mac with `xcrun notarytool info <id> --key … --key-id … --issuer …` and re-run the failed jobs once Apple is through. The first submissions from a new developer team are the slow ones; after that notarization takes minutes. The updater bundle holds the same signed app as the DMG, so it is covered by the same submission. The hardened runtime that notarization requires blocks the microphone unless the app asks for it, so `src-tauri/Entitlements.plist` carries `com.apple.security.device.audio-input` for dictation. Local builds are not signed.

Make the `.p12` with `openssl pkcs12 -export -legacy …` (macOS cannot read OpenSSL 3's default format) and encode it with `base64 -i cert.p12`. The certificate expires (the date shows in Keychain Access): before then, create a new one at developer.apple.com and replace the first three secrets.

## Documentation

The documentation site deploys from `.github/workflows/docs.yml` on every push to `main`: it builds the site with `pnpm docs:build` and publishes it to GitHub Pages at <https://reapermaga.github.io/mango/>. GitHub Pages must be set to deploy from GitHub Actions in the repository settings.

Because the site reads the version from `package.json`, the release commit updates the download links. Pushing it to `main` before the tag's build has finished means the links point at installers that are still being built for a few minutes.
