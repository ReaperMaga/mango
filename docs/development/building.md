# Building from source

Mango is a Rust + [Tauri 2](https://tauri.app) app with a [Nuxt 4](https://nuxt.com) frontend running as a single-page app. You need:

- Node.js 24 and pnpm 10
- Rust (stable) with Cargo
- The Tauri system prerequisites for your platform; see [Tauri's prerequisites guide](https://tauri.app/start/prerequisites/)

On Linux (Debian and Ubuntu package names):

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev libssl-dev
```

On macOS, the Xcode command line tools (`xcode-select --install`) are enough. `src-tauri/tauri.macos.conf.json` adds the macOS window settings (native traffic lights over Mango's titlebar) and bundle settings on top of `tauri.conf.json`. To build the other Mac architecture, add its target (`rustup target add x86_64-apple-darwin`) and pass `--target x86_64-apple-darwin` to `pnpm tauri build`.

## Get the code

```bash
git clone https://github.com/ReaperMaga/mango.git
cd mango
pnpm install
```

## Run

```bash
pnpm dev        # the UI only, at http://localhost:1420, with an in-memory mock backend
pnpm app        # the desktop app (tauri dev): starts Nuxt on :1420 and opens the window
pnpm app:build  # release build and installers
```

### The browser preview

`pnpm dev` serves the frontend in a browser with no Rust backend behind it. A mock backend supplies projects, a git repository and simulated agents, which is handy for working on the UI:

- Agent replies are simulated and labelled **Simulated**; no CLI runs.
- **Load demo threads** in the command palette (<kbd>Ctrl</kbd> <kbd>K</kbd>) fills the sidebar with sample chats.

The dev port is 1420; `nuxt.config.ts` and `src-tauri/tauri.conf.json` must agree on it.

## Checks

```bash
# Typecheck the frontend (must be clean)
pnpm nuxt prepare && pnpm vue-tsc --noEmit -p .nuxt/tsconfig.app.json

# Backend tests and build, with no new warnings
cd src-tauri && cargo test && cargo build

# Windows must keep compiling (CI also checks macOS)
cd src-tauri && cargo check --target x86_64-pc-windows-msvc
```

## Try an agent adapter

`scripts/try-agent.ts` drives an agent adapter against the real CLI, outside the app. Run it in a scratch folder, never in the Mango repository, and keep prompts tiny: every run spends your agent quota.

```bash
node scripts/try-agent.ts claude /path/to/scratch-project "say hi" --mode ask --raw
```

## Cross-compile the Windows installer from Linux

You need `nsis`, `lld`, `llvm` and `clang`, the MSVC Rust target and `cargo-xwin`:

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

## The documentation site

This site lives in `docs/` and is built with [VitePress](https://vitepress.dev):

```bash
pnpm docs:dev       # live preview
pnpm docs:build     # static build into docs/.vitepress/dist
pnpm docs:preview   # serve the built site
```

The download links and the version in the navigation come from the root `package.json`, so they follow `pnpm bump` without editing the docs.
