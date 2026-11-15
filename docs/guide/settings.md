# Settings

Open Settings with <kbd>Ctrl</kbd> <kbd>,</kbd>, the **Settings** button at the bottom of the sidebar, or the command palette. Press <kbd>Ctrl</kbd> <kbd>,</kbd> again or <kbd>Esc</kbd> to close it. Settings covers the workspace while it is open, so workspace shortcuts pause until you close it.

There are four sections: General, Agents, Terminal and Appearance. <kbd>↑</kbd> and <kbd>↓</kbd> move between them.

## General

**Permissions for new chats** sets the [permission mode](./chats#permission-modes) every new chat starts with: Plan, Ask first, Accept edits or Full auto. You can still change it in any chat.

**Updates** shows whether a newer release is out, with **Check now**, **Update and restart** and **Release notes**, and the switch for **Check for updates automatically**. See [Updates](./updates).

**About Mango** shows the version, the commit it was built from, the build date and the Tauri version. Builds run from source with `pnpm dev` or `pnpm app` are marked **Development build**. **Copy version info** copies all of it, which is handy for a bug report.

## Agents

Mango runs the agent CLIs installed on your computer, and you sign in with each tool's own sign-in, so your credentials stay with it. Each agent has a row with its version and the path of the command Mango found.

- **Not installed**: Mango could not find the command. The row shows the install command (`npm install -g @anthropic-ai/claude-code` or `npm install -g @openai/codex`) with a copy button. Run it in a terminal, then press **Check again**.
- **Not signed in**: **Sign in** runs the CLI's own login (`claude auth login` or `codex login`) in a terminal right inside the row. Finish in your browser; **Open sign-in page** and **Copy link** help when the CLI prints a link. If the page gives you a code, paste it into the terminal and press <kbd>Enter</kbd> (the code may stay hidden as you paste). Mango checks the sign-in again when the command ends.
- **Signed in**: shows the account when the CLI reports one. **Switch account** runs the login again; **Sign out** asks first, then runs the CLI's own sign-out. Chats that use that agent stop working until you sign in again.

The refresh button on a row checks the agent again, for example after you installed or signed in from your own terminal.

**Default agent for new chats** picks which agent an empty chat starts with. You can still pick the other one in any chat.

## Terminal

- **Shell for new terminals**: every shell Mango found on this computer, with its path and arguments. The system default is marked. **Look again** searches again, for example after installing a shell. Terminals that are already open keep their shell. If the shell you picked is no longer installed, new terminals use the system default and the section says so.
- **Font size**: from 9 to 22 px in half-pixel steps. Applies to open terminals straight away.
- **Cursor**: Bar, Block or Underline.
- **Blinking cursor**: on or off.

See [Terminal](./terminal) for the panel itself.

## Appearance

- **Theme**: Dark, Light or System (follows your computer's light or dark setting). The sun / moon button in the titlebar switches theme too.
- **Color scheme**: Mango, Blue, Purple, Pink or Graphite. A scheme tints the background and sets the accent color; status colors stay the same.
