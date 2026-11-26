# Copy as Markdown

- **Copy as Markdown** on an agent reply (its message actions) copies the reply's text as Markdown.
- **Copy chat as Markdown** in a chat's menu, or in the command palette for the active chat, copies the whole chat as a
  transcript: the title, the agent and date, then each message under **You** or the agent's name, with attached files
  and tool calls as short lines.

Settings: tool calls in the transcript as one line each, with their output, or left out; whether to include the agent's thinking.

Shows: `chat.messageActions`, `ui.menus.register('thread', …)`, `chat.get` and the `Thread` / `Message` / `Part` shapes, `commands`.
