# CSV preview

Shows ` ```csv ` and ` ```tsv ` blocks in agent replies as a table: a header row, numbers right-aligned, and a row and
column count. **Raw** switches to the text as the agent wrote it.

Settings: rows shown before the table is cut (200), whether the first row is the header.

Agent output is untrusted, so every cell is set with `textContent`; nothing in the block becomes markup or a link.

Shows: `chat.codeBlocks` with a framework-free `mount`, a `styles` file using Mango's tokens (it follows the theme and
colour scheme).
