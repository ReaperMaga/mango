# Terminal

Mango has a real terminal docked at the bottom of the window: a pseudo-terminal (PTY) running a real shell, rendered with xterm.js. It is there for everything the agents should not do for you, or that you would rather do yourself.

## Show and hide

- <kbd>Ctrl</kbd> <kbd>J</kbd> or <kbd>Ctrl</kbd> <kbd>`</kbd> toggles the terminal. Both work while the terminal has focus too.
- The terminal button in the titlebar does the same.
- **Hide terminal** in the panel's header hides it; your terminals keep running.

Drag the top edge of the panel to resize it. Double-click the edge, or use **Maximize panel** / **Restore panel size**, to switch between the normal and a tall height.

## Tabs

Each terminal is a tab in the panel header. <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>T</kbd> or the **+** opens a new one in the current project's folder, with your default shell. Hover a tab to see its shell and working folder.

With a tab focused, <kbd>←</kbd> <kbd>→</kbd>, <kbd>Home</kbd> and <kbd>End</kbd> move between tabs. The **×** on a tab closes it.

When a shell exits, its tab stays open (its tooltip says "exited"); press <kbd>Enter</kbd> in it to start the shell again.

## Shells

Mango looks for the shells installed on your machine:

- **Windows**: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, MSYS2 and Cygwin, Nushell, and every installed WSL distribution.
- **Linux and macOS**: your login shell (`$SHELL`), the shells listed in `/etc/shells`, and well-known shells on your `PATH`.

The arrow next to the **+** opens a menu of every shell found, to start a terminal with a different one. The default for new terminals is set in [Settings > Terminal](./settings#terminal), along with the font size and cursor.

## Keys inside the terminal

While the terminal has focus, the shell gets your keys, including <kbd>Ctrl</kbd> <kbd>C</kbd> and <kbd>Ctrl</kbd> <kbd>W</kbd>. Only two Mango shortcuts still work there: <kbd>Ctrl</kbd> <kbd>K</kbd> (command palette) and <kbd>Ctrl</kbd> <kbd>J</kbd> / <kbd>Ctrl</kbd> <kbd>`</kbd> (toggle the terminal).

## Links

Web addresses printed in the terminal are clickable and open in your browser, including the hyperlinks some CLIs print for sign-in.
