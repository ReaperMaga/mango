export const general = {
  description: 'Defaults for new chats, and what Mango asks before it acts.',
  language: {
    title: 'Language',
    hint: 'The language of Mango\'s interface. Agent replies and terminal output are not translated.',
    label: 'Interface language',
    system: 'System',
  },
  permissions: {
    title: 'Permissions for new chats',
    hint: 'How much an agent may do before it checks with you. You can change this in any chat.',
  },
  modes: {
    plan: {
      label: 'Plan',
      hint: 'Read-only. The agent explores and proposes a plan; it changes nothing.',
    },
    ask: {
      label: 'Ask first',
      hint: 'The agent asks before every edit and every command.',
    },
    edits: {
      label: 'Accept edits',
      hint: 'The agent edits files without asking, and still asks before commands.',
    },
    auto: {
      label: 'Full auto',
      hint: 'The agent never asks. It edits files and runs commands on its own.',
    },
  },
  confirm: {
    title: 'Confirmations',
    hint: 'Questions Mango asks before it changes your chats.',
    archive: 'Archive confirmation',
    archiveHint: 'Ask before a chat moves to Archived.',
    delete: 'Delete confirmation',
    deleteHint: 'Ask before a chat and its messages are deleted.',
  },
  windows: {
    title: 'Windows',
    hint: 'A window can hold several projects side by side, or each can have its own.',
    openIn: 'Open a project in',
    openInHint: 'When this window already has other projects open.',
    ask: 'Ask each time',
    this: 'This window',
    new: 'New window',
  },
}
