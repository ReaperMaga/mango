# Turn chime

Plays a short chime when an agent finishes its turn: two rising notes when it went well, two lower ones when it failed.
The tones are made with WebAudio, so there are no sound files.

Settings: when to play it (only while Mango is in the background, always, or never) and the volume.
Turns of sub-agents do not chime, and several chats finishing at once chime once.
**Turn chime: play both chimes** in the command palette lets you hear them.

Shows: `chat.onTurnEnd`, `chat.get`, `select` and `number` settings, cleaning up in `onDispose`.
