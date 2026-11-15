# Updates

Mango updates itself from its [GitHub releases](https://github.com/ReaperMaga/mango/releases). The newest release on GitHub is the newest version of Mango.

## How Mango checks

A few seconds after launch, and then every hour while it runs, Mango reads the update information attached to the latest release. If that release is newer than the version you run, an **Update** button appears in the titlebar, next to the window controls.

Checking sends nothing about you or your projects: it downloads one small file from GitHub.

To turn the automatic checks off, go to **Settings > General > Updates** and switch off **Check for updates automatically**. **Check now** in the same place checks at any time, and so does **Check for updates** in the command palette (<kbd>Ctrl/⌘</kbd> <kbd>K</kbd>).

## Installing an update

Click **Update** in the titlebar and choose **Update and restart**, or use the button of the same name in **Settings > General**. **Release notes** opens the release on GitHub first, if you want to see what changed.

Mango then:

1. downloads the installer for your platform, showing its progress in the titlebar,
2. checks its signature, and refuses an installer that was not signed by the Mango release build,
3. installs it and starts the new version.

Running chats and terminals stop when Mango restarts; the menu tells you how many chats are running before you start. Your chats, tabs and settings stay as they were.

| Installed from | What the update does |
| --- | --- |
| Windows installer (`-setup.exe`) | Runs the new installer with a small progress window, then starts Mango. |
| Windows MSI | Runs the new MSI the same way. |
| AppImage | Replaces the AppImage file in place. |
| `.deb` / `.rpm` | Installs the new package. Linux asks for your password, because packages install system-wide. |

If an update fails, the button turns into **Update failed** with the reason, and you can try again. You can always download the installer yourself from the [install page](./install) and install it over the old version.

## Development builds

Builds run from source (`pnpm dev`, `pnpm app`) do not check on their own. **Check now** still works, but installing an update there replaces it with the released app.
