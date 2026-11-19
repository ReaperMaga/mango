# Shipping the iOS app

The iOS app in `mobile/` ships to TestFlight from `.github/workflows/mobile.yml`. It builds with [EAS Build](https://docs.expo.dev/build/introduction/) in Expo's cloud, so the workflow runs on an ordinary Linux runner and needs no Mac, and uploads the build with [EAS Submit](https://docs.expo.dev/submit/ios/).

The app has its own version, separate from the desktop's: `expo.version` in `mobile/app.json` is the version the App Store shows. EAS counts the build number up for every production build (`appVersionSource: remote` and `autoIncrement` in `mobile/eas.json`), so several builds of one version can go to TestFlight.

## One-time setup

You need a seat on the `averix-enterprise` Expo account, the Apple Developer Program team that owns `info.averix.mango.ios`, and the app in App Store Connect (its id is `submit.production.ios.ascAppId` in `eas.json`).

1. **Signing credentials in EAS.** In `mobile/`, run `npx eas-cli@latest credentials --platform ios`, pick the `production` profile, then **Build Credentials**: let EAS create (or upload) the distribution certificate and the App Store provisioning profile. It signs in to your Apple account for this; the workflow never does.
2. **The App Store Connect API key in EAS.** In the same menu, **App Store Connect: Manage your API Key**: let EAS create one, or upload a `.p8` key (App Store Connect > Users and Access > Integrations > Team Keys, Admin or App Manager role). EAS Submit uses it to upload builds.
3. **The `EXPO_TOKEN` secret.** Create an access token on expo.dev (account settings > Access tokens; a robot user of the organisation is best, since its token is tied to no person) and store it in the repository:

   ```bash
   gh secret set EXPO_TOKEN
   ```

That is the only secret the workflow reads; the Apple credentials stay in EAS. Without it the run stops at its first step. A first `eas build --platform ios --profile production` run by hand also walks you through steps 1 and 2.

## Ship a build

1. Set the version in `mobile/app.json` (`expo.version`) and keep `mobile/package.json` in step. Skip this to send another build of the same version.
2. Commit, tag and push:

   ```bash
   git commit -am "chore(release): mobile-vX.Y.Z"
   git tag mobile-vX.Y.Z
   git push
   git push origin mobile-vX.Y.Z
   ```

The tag must match `expo.version`, or the run stops. Desktop `vX.Y.Z` tags do not start it, and a `mobile-v…` tag does not start the desktop release.

To ship or try a build without a tag, run **Mobile (iOS)** by hand in GitHub Actions (or `gh workflow run mobile.yml --ref <branch>`). Untick **submit** (`-f submit=false`) to build without uploading to TestFlight.

## What the run does

1. Typechecks and tests `mobile/` (`pnpm typecheck`, `pnpm test`).
2. Starts a `production` build on EAS (`eas build --platform ios --profile production --non-interactive --auto-submit`). EAS uploads the whole repository, since the app imports the desktop's `app/agents` and `app/types`, and signs the build with the credentials stored there.
3. When the build finishes, EAS submits it to App Store Connect with the stored API key. The job waits for both and fails if either does (it times out after two hours; a build already running in EAS carries on regardless).

Each run spends EAS build minutes, which is why nothing builds on a plain push to `main`.

## Where to watch

- The run in GitHub Actions: its log links to the build and the submission on expo.dev.
- All builds: [expo.dev](https://expo.dev) > averix-enterprise > mango > Builds, or `npx eas-cli@latest build:list --platform ios` in `mobile/`.
- App Store Connect > the app > TestFlight. Apple processes an uploaded build for a few minutes to half an hour before testers get it. The app declares no non-exempt encryption (`ITSAppUsesNonExemptEncryption` in `app.json`), so TestFlight asks no export compliance question.
