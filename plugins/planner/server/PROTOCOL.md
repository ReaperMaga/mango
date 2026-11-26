# Planner server protocol, v1

What the Planner plugin (`plugins/planner/src/data/remote.ts`) and `planner-server` say to each other. The server is a
store of JSON documents with field-level patches; it knows nothing of boards, properties or views. The plugin's side of
the contract is `PlannerSource` in `plugins/planner/src/data/source.ts`.

## Spaces, tokens, roles

A server holds any number of **spaces**. Each is a separate set of documents with its own `seq`. An **access token**
belongs to one space and has a role:

| Role | May |
|---|---|
| `read` | read and follow changes |
| `write` | that, and write |

Tokens are made with the server's command line (`planner-server token add`). The server stores only their SHA-256.
Each token is for a **person** of its space. A person has an id (`per_` and 12 hex characters) that never changes,
and a name they may change (`POST /v1/me`): 1 to 64 printable characters, not starting with `@`, and nobody else's
in the space, in any case. One person's tokens (a laptop, a desktop) share the person. See `GET /v1/people`.
A token is `pls_` followed by 43 characters of base64url (32 random bytes). It is sent as
`Authorization: Bearer <token>` on every request, and as nothing else: not in a URL, never in a cookie.

## Documents

```jsonc
{
  "kind": "collection",            // or "item"
  "id": "8f0c…",                   // see "Names"
  "collectionId": "8f0c…",         // a collection: its own id. An item: the collection it is in
  "seq": 42,                       // where this write stands among all writes of the space: higher is newer
  "createdAt": 1764150000000,      // ms since the epoch, server time, when first written (kept across a delete)
  "updatedAt": 1764150000000,      // ms, server time, of this write
  "data": { … }                    // a JSON object, or null for a tombstone (deleted)
}
```

A document is addressed by `(kind, id)`; ids are unique within a space per kind. An item's `collectionId` is fixed when it is
created: a write naming another `collectionId` for an item the server has (a tombstone too) is refused (`invalid`). A
collection's `collectionId` is its `id`.

Tombstones are kept, so a client that was away learns of deletions (see `changes`). A document nobody ever wrote is
answered as a tombstone with `seq: 0`, `createdAt: 0`, `updatedAt: 0`.

**Names.** `id` and `collectionId`: 1 to 128 characters of `A-Z a-z 0-9 _ -`. **Sizes.** A document's `data` is at most
1 MiB of JSON; a write has at most 20 000 operations; a request body at most 64 MiB.

## Patches

A patch is a list of `{ "path": ["views", "v1", "name"], "value": "Board" }`. Leaving `value` out removes the field.
Applied in order, exactly as `applyPatch` in `plugins/planner/src/patch.ts`:

- An empty path, or one with a key that is `""`, `__proto__`, `constructor` or `prototype`, does nothing.
- Walking the path, depth 0, 1, 2, …: the last key is set (or removed). Before that, each step needs an object at that key.
  Odd depths (1, 3, …) are *entries* (an id inside a container): if the entry is missing, the whole op does nothing.
  Even depths are *containers*: a missing one is made (an empty object), unless the op removes, then it does nothing.
- An array met on the way is read as entries by id: `[{ "id": "a", … }, …]` becomes `{ "a": { "id": "a", … } }` (later
  wins; elements that are not objects with a string `id` that is a safe key are dropped), and is stored as that object.
- A value that is not an object or array met on the way counts as missing.

## Requests

All bodies and answers are JSON (`Content-Type: application/json`) except the event stream. Answers carry
`Cache-Control: no-store`.

### `GET /v1/hello`

```json
{ "protocol": 1, "server": "planner-server 0.1.0", "space": { "id": "team", "name": "Team" }, "role": "write", "me": { "id": "per_1a2b3c4d5e6f", "name": "Ana" }, "seq": 42 }
```

`me` is the person the token is for. A server older than people leaves it out.

### `GET /v1/people`

Everyone in the space, sorted by name. `active`: they have a write token that is not revoked, so they may be assigned.
The others stay listed, so what they were assigned keeps their name.

```json
{
  "me": { "id": "per_1a2b3c4d5e6f", "name": "Ana" },
  "people": [
    { "id": "per_1a2b3c4d5e6f", "name": "Ana", "active": true },
    { "id": "per_9f8e7d6c5b4a", "name": "Wall screen", "active": false }
  ]
}
```

The planner stores a person as their id: a **Person** property's value is a list of ids, so a new name shows everywhere
at once. The property also writes down each assigned person's name when it is given (`people`, `{ "<id>": { "name": … } }`
in the property), and brings it up to date when it hears of a rename, so the name still reads where the server is not.

### `POST /v1/me`

```json
{ "name": "Ana Lopes" }
```

Renames the person the token is for, read tokens too, and answers as `GET /v1/people`. A name someone else in the space
has (in any case) is refused with `409` (`conflict`); a name that is not one with `400` (`invalid`). Everyone following
the space gets a `people` event.

### `GET /v1/collections`

Live collections, no tombstones: `{ "seq": 42, "docs": [Doc, …] }`. `seq` is the space's latest at the time of reading.

### `GET /v1/collections/{collectionId}/items`

Live items of that collection (whether or not the collection exists): `{ "seq": 42, "docs": [Doc, …] }`.

### `POST /v1/write`

```jsonc
{
  "mutationId": "c1f9…",           // 1 to 128 of A-Z a-z 0-9 _ -
  "ops": [
    { "op": "create", "kind": "item", "id": "…", "collectionId": "…", "data": { … } },
    { "op": "patch",  "kind": "collection", "id": "…", "collectionId": "…", "patch": [ { "path": […], "value": … } ] },
    { "op": "delete", "kind": "item", "id": "…", "collectionId": "…" }
  ]
}
```

All of it or nothing, in one transaction. Ops are applied in order; several ops on one document are folded into one
write of it.

- `create`: writes `data` when the document does not exist or is a tombstone. When it exists already, that document
  stays as it is (it is the same one: ids are random, so this is a create tried again).
- `patch`: applied to the live document. On a tombstone or a document never written it does nothing.
- `delete`: makes it a tombstone, whatever it is now. On a tombstone or a document never written it does nothing.

Each document actually changed gets a new `seq` (all of one write share its `seq`) and `updatedAt`. A patch that leaves the
data as it was changes nothing.

The answer is every document the ops named, as it is now (one entry per document, in the order first named):
`{ "seq": 43, "docs": [Doc, …] }`.

**Tried again:** the server remembers each `mutationId` of the space for at least 7 days. A write whose `mutationId` it has
seen is not applied again; it answers with the documents named in it as they are now.

### `GET /v1/changes?since=N`

Everything written after `seq` N, tombstones included, oldest first, about 5 000 documents at most:
`{ "seq": 50, "docs": [Doc, …], "more": false }`. With `more: true`, ask again from the answer's `seq`, which is then the last
document's. A page never ends inside one write: a write of more than 5 000 documents comes whole. When N is older than what the server still knows (tombstones are pruned after `--keep-tombstones`, 90 days by
default), or larger than the space's `seq` (the server was reset), the answer is `{ "seq": 50, "resync": true, "docs": [] }`:
read everything again.

### `GET /v1/events?since=N`

A [server-sent event](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream
(`Content-Type: text/event-stream`), read with `fetch` (the token goes in the header, so not `EventSource`):

```
event: hello
data: {"protocol":1,"server":"planner-server 0.1.0","space":{"id":"team","name":"Team"},"role":"write","me":{"id":"per_1a2b3c4d5e6f","name":"Ana"},"seq":42}

event: docs
data: {"seq":43,"docs":[…]}

event: people
data: {}

event: resync
data: {"seq":50}

: ping
```

- `hello` first, always.
- Then, when `since` is given: what `changes?since=N` would answer, as `docs` events (or one `resync`), then live writes.
- `docs`: every write as it is committed, the client's own too. Deliver order is commit order.
- `people`: the space's people changed (a rename, a token added or revoked): read `GET /v1/people` again. Sent at once
  for a rename through `POST /v1/me`, and within a ping for changes made with the command line.
- `resync`: the client missed writes it cannot be told one by one (it was too far behind, or more than 256 writes
  piled up for a slow stream); it reads everything again. The stream goes on live after it.
- A comment line (`: ping`) every 25 s keeps proxies from closing the stream. A stream whose token was revoked, or whose
  space was removed, ends at the next one.

The client reconnects after a lost stream with `since` set to the last `seq` it saw, waiting 1 s, 2 s, 4 s … up to 30 s.

## Errors

Any status other than 2xx answers `{ "error": { "code": "…", "message": "…" } }`; the message is for a person.

| Status | `code` | The plugin's `SourceError` kind |
|---|---|---|
| 400 | `invalid` | `invalid` |
| 401 | `unauthorized` (missing, unknown or revoked token) | `refused` |
| 403 | `forbidden` (a `read` token writing) | `refused` |
| 404 | `not_found` (no such route) | `invalid` |
| 409 | `conflict` (a name someone else in the space has) | `invalid` |
| 413 | `too_large` (a document over 1 MiB, a body over 64 MiB) | `invalid` |
| 429 | `rate_limited` (not sent by this server yet) | `offline` |
| 5xx | `internal` | `unknown` (`offline` for 502, 503, 504) |
| — | network error, timeout | `offline` |

## CORS

Answers allow `Access-Control-Allow-Origin` of the request's origin when it is in `--allow-origin` (comma separated; `*`
by default, which is safe because nothing rides on cookies), `Access-Control-Allow-Headers: Authorization, Content-Type`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS`, and answer `OPTIONS` preflights with 204.

## Known limits

- Removing a space and adding it again starts its `seq` at 0. A client whose `seq` is higher is told to `resync`; one that
  was away until the new space wrote past it is not, and misses what was written in between.
