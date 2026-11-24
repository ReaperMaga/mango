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
