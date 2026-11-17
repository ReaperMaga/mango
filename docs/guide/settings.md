# Settings

Open Settings with <kbd>Ctrl</kbd> <kbd>,</kbd>, the **Settings** button at the bottom of the sidebar, or the command palette. Press <kbd>Ctrl</kbd> <kbd>,</kbd> again or <kbd>Esc</kbd> to close it. Settings covers the workspace while it is open, so workspace shortcuts pause until you close it.

The list on the left has two headlines: **General** (Preferences, Projects, Appearance, Voice) and **Technical** (Environments, Terminal, Behaviour, Maintenance). Agents, Archive and Changelog sit at the bottom. <kbd>↑</kbd> and <kbd>↓</kbd> move between sections.

## Preferences

**Permissions for new chats** sets the [permission mode](./chats#permission-modes) every new chat starts with: Plan, Ask first, Accept edits or Full auto. You can still change it in any chat.

**Confirmations** are two switches: ask before a chat is archived (off by default) and before it is deleted (on by default).


## Maintenance

**Updates** shows whether a newer release is out, with **Check now**, **Update and restart** and **Release notes**, and the switch for **Check for updates automatically**. See [Updates](./updates).

**About Mango** shows the version, the commit it was built from, the build date and the Tauri version. Builds run from source with `pnpm dev` or `pnpm app` are marked **Development build**. **Copy version info** copies all of it, which is handy for a bug report.

## Projects

Settings for one project at a time: pick it at the top ("Applying settings for").

- **Name**: shows the project under another name in Mango. The folder is not renamed.
- **Project icon**: the project's initials on a color. Automatic picks one from the folder; choose a color to set your own.
- **Pin**: pinned projects come first in the project lists.
- **Archive**: hides the project from the Recent list and closes it. Its chats and folder are kept, and opening the project again brings it back.
- **New chats**: the **Agent**, **Model** and **Permissions** a new chat in this project starts with, instead of the defaults.
- **Environment variables**: the project's `.env` files, one tab each. Every `.env`, `.env.*` and `*.env` at the project root shows up on its own; example files such as `.env.example` stay out unless you add them by name. **New file** creates one under any name, and **Delete file** removes one (after asking). Edit a file as **Fields**, rows of name and value, or as **Raw** text: values stay hidden until you press **Show values**. Pasting `NAME=value` lines into a name adds them all, and lines you don't touch, comments and quoting are kept. Changes are drafts until you **Save** (<kbd>Ctrl/⌘</kbd> <kbd>S</kbd>) or **Revert**; if the file changed on disk in the meantime, Mango asks before overwriting it. A file git doesn't ignore gets a warning with **Add to .gitignore**. "Environment variables" in the command palette opens this part directly.
- **Remove project** (under **Danger**): asks first, then deletes the project's entry and its chats. Files on disk are not touched.

## Behaviour

- **Send shortcut**: Enter sends and <kbd>Shift</kbd> <kbd>Enter</kbd> breaks the line (the default), or <kbd>Ctrl/⌘</kbd> <kbd>Enter</kbd> sends and Enter breaks the line.
- **Follow-up behavior**: what happens to a message you write while the agent works. **Queue** (the default) holds it until the turn ends; **Steer** hands it to the running turn, which reads it at its next step. The other key combination does the opposite for one message: <kbd>Ctrl/⌘</kbd> <kbd>Enter</kbd> with Enter as the send shortcut, or <kbd>Ctrl/⌘</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> with the other.
- **Tool calls in chat**: **Show all**, **Hide successful** (failures stay), **Hide all**, or **Zen** (only the final answers). Approvals, questions and errors always show.

## Agents

Mango runs the agent CLIs installed on your computer, and you sign in with each tool's own sign-in, so your credentials stay with it. Each agent has a row with its version and the path of the command Mango found.

- **Not installed**: Mango could not find the command. **Install…** opens [Get started](./getting-started#get-started), which runs the vendor's installer for you. If you installed it yourself, press **Check again**.
- **Not signed in**: **Sign in** runs the CLI's own login (`claude auth login` or `codex login`) in a terminal right inside the row. Finish in your browser; **Open sign-in page** and **Copy link** help when the CLI prints a link. If the page gives you a code, paste it into the terminal and press <kbd>Enter</kbd> (the code may stay hidden as you paste). Mango checks the sign-in again when the command ends.
- **Signed in**: shows the account when the CLI reports one. **Switch account** runs the login again; **Sign out** asks first, then runs the CLI's own sign-out. Chats that use that agent stop working until you sign in again.

The refresh button on a row checks the agent again, for example after you installed or signed in from your own terminal.

**Default agent for new chats** picks which agent an empty chat starts with. You can still pick the other one in any chat.

## Archive

Every chat you archived, newest first, with the project, the agent and when it last changed. **Restore** brings a chat back to the sidebar; the trash button deletes it (after asking, unless Delete confirmation is off). With archived chats in more than one project, a menu at the top filters by project.

## Terminal

- **Shell for new terminals**: every shell Mango found on this computer, with its path and arguments. The system default is marked. **Look again** searches again, for example after installing a shell. Terminals that are already open keep their shell. If the shell you picked is no longer installed, new terminals use the system default and the section says so.
- **Font size**: from 9 to 22 px in half-pixel steps. Applies to open terminals straight away.
- **Cursor**: Bar, Block or Underline.
- **Blinking cursor**: on or off.

See [Terminal](./terminal) for the panel itself.

## Appearance

- **Theme**: Dark, Light or System (follows your computer's light or dark setting). The sun / moon button in the titlebar switches theme too.
- **Color scheme**: Mango, Blue, Teal, Green, Purple, Pink, Red, Slate, Uchiha (near-black with a crimson accent) or Graphite. A scheme tints the background and sets the accent color; status colors stay the same.
- **Interface font**: Inter, Geist, DM Sans, Manrope or your system font.
- **Code font**: JetBrains Mono, Fira Code, Source Code Pro, Geist Mono or your system monospace font. It applies to code, paths, the editor and the terminal straight away.
- **Text size**: Small, Default, Large or Extra large. Scales the interface text; the terminal keeps its own size.
- **Corners**: Sharp, Default or Round.
- **Animations**: System (follows your computer's setting), Full or Reduced.
