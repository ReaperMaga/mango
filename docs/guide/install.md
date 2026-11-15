# Install

Mango is built for Windows (x64) and Linux (x64). The current release is <ReleaseVersion />.

## Before you start

Mango runs the agent command-line tools installed on your computer. It does not ship an agent of its own, and it never sees or stores your credentials. You need at least one of them, signed in with its own sign-in.

You don't have to install them first: on its first launch Mango opens **Get started**, which installs what is missing and signs you in. See [Getting started](./getting-started#get-started). To install them yourself instead:

| Tool | Windows (PowerShell) | Linux and macOS | Sign in |
| --- | --- | --- | --- |
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| Codex | `irm https://chatgpt.com/codex/install.ps1 \| iex` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex login` |
| Git | `winget install --id Git.Git -e` | your package manager, e.g. `sudo apt install git` | |

`npm install -g @anthropic-ai/claude-code` and `npm install -g @openai/codex` work too, if you already use Node.js. You can also sign in later from **Settings > Agents**, which runs the login command in a terminal inside Mango. See [Settings](./settings#agents).

For the Changes view you need `git` on your `PATH`. For Unity Version Control workspaces you need the Unity VCS (Plastic SCM) client and its `cm` command; see [Unity Version Control](./unity-vcs).

## Download

<DownloadTable />

Older and newer builds are on the [releases page](https://github.com/ReaperMaga/mango/releases); [latest release](https://github.com/ReaperMaga/mango/releases/latest) always points at the newest one.

## Windows

Run `Mango_<version>_x64-setup.exe`. The `.msi` installs the same app and suits managed or scripted installs.

**SmartScreen warning.** The installers are not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Choose **More info**, then **Run anyway**.

**WebView2.** Mango draws its window with Microsoft Edge WebView2. Windows 11 and current Windows 10 already include it. If it is missing, the installer sets it up (this needs an internet connection).

## Linux

The AppImage runs on most distributions without installing anything:

```bash
chmod +x Mango_*_amd64.AppImage
./Mango_*_amd64.AppImage
```

If your distribution has no FUSE 2 library, AppImages fail to start; install `libfuse2` (Debian, Ubuntu) or `fuse-libs` (Fedora).

Or install the package for your distribution:

```bash
# Debian, Ubuntu and derivatives
sudo apt install ./Mango_*_amd64.deb

# Fedora, RHEL and derivatives
sudo dnf install ./Mango-*-1.x86_64.rpm
```

Mango needs WebKitGTK 4.1 at runtime (`libwebkit2gtk-4.1-0` on Debian and Ubuntu, `webkit2gtk4.1` on Fedora). The `.deb` and `.rpm` packages pull it in; with the AppImage, install it yourself if it is missing.

## macOS

There is no macOS build yet. Parts of Mango already account for macOS (shortcuts use <kbd>⌘</kbd>, the terminal looks for your login shell), but no release is built or tested there. You can [build it from source](../development/building).

## Check the version

The version you are running, and the commit it was built from, are in **Settings > General > About Mango**. **Copy version info** copies them for a bug report.
