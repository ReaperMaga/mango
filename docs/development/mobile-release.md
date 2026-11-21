# Shipping the iOS app

The iOS app in `mobile/` ships to TestFlight from `.github/workflows/mobile.yml`. It builds with [EAS Build](https://docs.expo.dev/build/introduction/) in Expo's cloud, so the workflow runs on an ordinary Linux runner and needs no Mac, and uploads the build with [EAS Submit](https://docs.expo.dev/submit/ios/).

The app has its own version, separate from the desktop's: `expo.version` in `mobile/app.json` is the version the App Store shows. EAS counts the build number up for every production build (`appVersionSource: remote` and `autoIncrement` in `mobile/eas.json`), so several builds of one version can go to TestFlight.

## One-time setup

You need a seat on the `averix-enterprise` Expo account, the Apple Developer Program team that owns `info.averix.mango.ios`, and the app in App Store Connect (its id is `submit.production.ios.ascAppId` in `eas.json`).

1. **Signing credentials in EAS.** In `mobile/`, run `npx eas-cli@latest credentials --platform ios`, pick the `production` profile, then **Build Credentials**: let EAS create (or upload) the distribution certificate and the App Store provisioning profile. It signs in to your Apple account for this; the workflow never does.
2. **The App Store Connect API key in EAS.** In the same menu, **App Store Connect: Manage your API Key**, then **Set up your project to use an API Key for EAS Submit**: pick a stored key, or add a `.p8` key (App Store Connect > Users and Access > Integrations > Team Keys, Admin or App Manager role). Declining the Apple sign-in is fine here. The menu says "App Store Connect API Key already set up" once the key is assigned to `info.averix.mango.ios`; the build checks exactly that, and without it `--auto-submit` fails with "App Store Connect API Keys cannot be set up in --non-interactive mode".
3. **The `EXPO_TOKEN` secret.** Create an access token on expo.dev (organisation settings > Access tokens) for a robot user with the **Developer** role or higher; a Runner robot may not read the stored credentials ("Entity not authorized: AppleAppIdentifierEntity"). Store it in the repository:

   ```bash
   gh secret set EXPO_TOKEN
   ```

4. **The `APPLE_TEAM_ID` secret** (the 10-character team id from developer.apple.com > Membership; the macOS release uses the same one). With it, the build signs in to Apple with the key from step 2, so EAS can turn on capabilities the app gained (Push Notifications for `expo-notifications`, say) and make a new provisioning profile by itself. Without it a new capability fails the Xcode build with "Provisioning profile … doesn't include the … capability".

The Apple credentials stay in EAS. Without `EXPO_TOKEN` the run stops at its first step. A first `eas build --platform ios --profile production` run by hand also walks you through steps 1 and 2.

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
