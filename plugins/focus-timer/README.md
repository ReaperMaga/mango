# Focus timer

A work and break timer in the titlebar. Click it to start or pause; when a focus block ends, a toast and a
system notification say so and the break is ready (or starts on its own, if you turn that on).

- Settings: focus length (25 minutes), break length (5 minutes), start the next block on its own.
- Commands (Ctrl+K): **Focus timer: start or pause**, **Focus timer: reset**, **Focus timer: skip to the next block**.
- A running timer keeps going across a restart of Mango.

Shows: `ui.statusItems` with reactive getters (`mango.vue.ref`), `commands`, `ui.toast`, `ui.notify`, `storage`, `onDispose`.
