# AGENTS.md (mobile)

Mango's iOS app: Expo SDK 58, React Native 0.88, expo-router, TypeScript. Read the root `AGENTS.md` first; its
rules (remote environments, agents, git safety, design, Conventional Commits) apply here too.

## What it is

The phone is one more computer opening a Mango remote environment. It joins one from a share link
(`mango://join/…`, scanned as a QR code) or reaches a server the user added (the phone's key in its
`authorized_keys`), then lists projects, reads, continues and starts chats, and reviews, commits and pushes changes.
Nothing of Mango's runs on the server: every action is a command over SSH, the same one the desktop runs.

## Commands

```bash
pnpm install
pnpm web          # the UI in a browser at :8081 with the in-memory mock backend (simulated replies, labelled so)
pnpm ios          # expo run:ios: prebuild + development build on the simulator or a device (Xcode 16.3+)
pnpm typecheck    # tsc --noEmit (must be clean)
pnpm test         # vitest (must pass)
CI=1 npx expo export --platform ios --output-dir /tmp/mango-ios   # proves the Hermes bundle builds without Xcode
npx eas-cli@latest build --profile development --platform ios     # a development build in the cloud (eas.json)
```

`npx expo install <pkg>` to add a dependency (it picks the SDK-compatible version). pnpm runs with
`node-linker=hoisted` (`.npmrc`), as Expo needs.

## Layout

```
modules/mango-ssh/   local Expo module: SSH in Swift (SwiftNIO SSH via spm_dependency), keys in the Keychain; Android is a stub
src/ssh/             types.ts (the contract), native.ts (wrapper), mock.ts, index.ts (`ssh`)
src/remote/          the environment: shell.ts (quoting, command lines, validators: ports of envs/ssh.rs and envs/mod.rs),
                     shareLink.ts (envs/token.rs, join.rs), git.ts, sshBackend.ts (chats_remote.rs, git.rs, agent_proc.rs),
                     mockBackend.ts, chatSync*.ts (app/utils/remoteChats.ts), index.ts (`backend`)
src/attachments/     picking (Photos, camera, Files), previews, pictures fitted for the model, upload into the
                     environment (`~/.local/share/mango/attachments/<id>/`); input.ts: what a run gets (pure)
src/voice/           dictation: transcript.ts (merging, locales, messages: pure), engine.native.ts (Apple's recognizer via
                     expo-speech-recognition, on-device required where offered), engine.ts (Web Speech API or simulated), useDictation
src/agents/          run.ts + turn.ts (app/agents/index.ts: drives the desktop's own adapters), simulated.ts (fake CLI for web)
src/state/           envs.ts, threads.ts (zustand), chatHistory.ts + chatFiles*.ts (the phone's working copy of chats)
src/theme/           tokens.ts (from app/assets/css/tokens.css, both themes), ThemeProvider, fonts
src/ui/, src/chat/   the component kit and chat components (presentational)
src/app/             routes (expo-router); src/screens/ shared screen code and the app lifecycle
```

`~/…` imports resolve to the desktop's `../app/…` (tsconfig `paths`, `metro.config.js`, `vitest.config.mts`): the
agent adapters and chat types are shared, not copied. Only import types and plain TypeScript from there.

## Rules

- **Stay compatible with the desktop.** Chat JSON, the files under `~/.local/share/mango/chats`, revisions and
  `env://@` paths, command lines and scripts are ports of the desktop's; when one side changes, change the other.
- **Security** as on the desktop: host keys are always pinned (share links carry them; a server's is confirmed by
  its fingerprint once); private keys never leave the native side; every value from the UI, a link or a chat file
  passes a validator and reaches the shell only through `quote`; agent output is untrusted (`ChatMarkdown` renders no
  HTML, opens only http(s) links and fetches no images).
- **iOS kills sockets in the background.** The lifecycle (`src/screens/lifecycle.ts`) flushes chats on the way out
  and resets connections and syncs on the way back; a run cut off must end, never stay "Working".
- **Design:** tokens only (`src/theme/tokens.ts`, kept in step with `tokens.css`), the impeccable process from the
  root `AGENTS.md`, iOS idioms (44pt targets, safe areas, sheets, back swipe). Check both themes.
- Never create or edit `ios/` or `android/` by hand (Continuous Native Generation): configure through `app.json`,
  config plugins and the module's podspec.
- Expo changes every SDK: read the versioned docs (https://docs.expo.dev/versions/v58.0.0/,
  https://docs.expo.dev/llms.txt) rather than memory before touching an Expo or React Native API.

## Verifying a change

Typecheck and tests always; the web preview for UI (both themes, a 390x844 viewport). Native behaviour (SSH, camera,
Keychain, deep links, backgrounding) needs a development build on a simulator or iPhone, against a throwaway
environment. Say what was and was not run on iOS.
