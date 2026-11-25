export const behavior = {
  description: 'How the composer sends, and what a chat shows while the agent works.',
  composer: 'Composer',
  sendKey: {
    label: 'Send shortcut',
    hint: 'Choose when Enter sends a message or inserts a new line.',
  },
  followUps: 'Follow-ups',
  followUp: {
    label: 'Follow-up behavior',
    hint: 'Queue messages written while the agent works, or steer the current run. Press {shortcut} to do the opposite for one message.',
    queue: 'Queue',
    steer: 'Steer',
  },
  breaks: {
    title: 'Long breaks',
    label: 'Large Claude Code chats after a break',
    hint: 'After about an hour, a chat’s next message has the whole conversation read again. Above {tokens} tokens, Mango can ask to compact it first, or compact it just before that. Automatic uses some of your limit without asking. Compacting keeps a summary and can lose details.',
    ask: 'Ask when I return',
    auto: 'Compact automatically',
    off: 'Off',
    above: 'Ask or compact above',
    aboveHint: 'How large a chat has to be, in tokens. A project can have its own in Settings > Projects.',
  },
  activity: 'Activity',
  toolCalls: {
    label: 'Tool calls in chat',
    hint: 'Hide the commands, edits and searches agents run. Hide successful keeps failures. Zen shows only final answers. Approvals, questions and errors always show.',
    all: 'Show all',
    'hide-ok': 'Hide successful',
    hide: 'Hide all',
    zen: 'Zen',
  },
}
