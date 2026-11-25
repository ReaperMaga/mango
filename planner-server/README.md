# planner-server

A small server that keeps the Mango Planner's boards in one place, so several computers (or several people)
see the same boards and each other's changes as they happen.

It is a store of JSON documents with field-level patches: it knows nothing of boards, properties or views. Two
people who change different fields of one card both win; the last writer wins a field. Everything is kept in
one SQLite file. What the Planner and the server say to each other is in [PROTOCOL.md](PROTOCOL.md).

## Build

Go 1.26 or newer. There is no C compiler involved (the SQLite driver is pure Go), so it builds for any platform
from any platform:

```bash
go build                                         # ./planner-server
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build   # for a Raspberry Pi or an ARM server
go test ./...
```

## Run

```bash
./planner-server serve --addr :8080 --db /var/lib/planner/planner.db
```

| Flag | Default | |
|---|---|---|
| `--addr` | `:8080` (`PLANNER_ADDR`) | where to listen |
| `--db` | `planner.db` (`PLANNER_DB`) | the SQLite file; made when missing |
| `--allow-origin` | `*` (`PLANNER_ALLOW_ORIGIN`) | origins allowed by CORS, comma separated. `*` is safe: nothing rides on cookies |
| `--keep-tombstones` | `90d` | how long deleted documents are remembered (`90d`, `90`, or a duration like `2160h`; `0` keeps them for good). A computer away for longer reads everything again |
| `--tls-cert`, `--tls-key` | | serve HTTPS with these PEM files |

It logs one line per request (method, path, status, duration) to stderr. Tokens and documents never reach the log.
It stops cleanly on Ctrl+C or SIGTERM.

## Spaces and tokens

A **space** is a separate set of boards. An **access token** belongs to one space, and may `write` (the default)
or only `read`. Make them with the same binary, pointed at the same database (the server may be running):

```bash
./planner-server space add team --name "Team"
./planner-server token add --space team --name "Ana"
./planner-server token add --space team --name "Wall screen" --role read
```

`token add` prints the token once; the server keeps only its SHA-256. Give each person or computer its own,
so one can be revoked without the others.

**A token is for a person.** `--name` is who: the Planner's **Person** properties (an assignee, a reviewer) offer the
space's people, and show everyone in the space who is who. A name the space has already (in any case) adds a token for
that person, so `--name "Ana"` on her laptop and her desktop is one person to assign. Someone with only read tokens is
nobody to assign. A name is up to 64 characters and does not start with `@`.

Everyone can change their own name in Mango (**Settings > Planner server > Your name**); assignments follow, because the
Planner stores people by id. You can rename someone too:

```bash
./planner-server person list                 # ids, names, and who may be assigned
./planner-server person rename per_1a2b3c4d5e6f --name "Ana Lopes"
```

Planners that are connected show a new name at once when it was changed in Mango, and within half a minute when it was
changed here. A database from an older planner-server is brought up to date when it opens: one person for each name
its tokens had in a space.

```bash
./planner-server token list                  # never shows tokens, only their ids
./planner-server token revoke tok_1a2b3c4d5e6f
./planner-server space list
./planner-server space remove team --yes     # deletes its documents and tokens for good
```

All of these take `--db` (or `PLANNER_DB`) too.

## Connect from Mango

In Mango, open **Settings > Planner server** (or run **Connect to a planner server…** from the command palette), and
fill in:

- **Server address:** `https://planner.example.com` (the address of this server)
- **Access token:** the `pls_…` token from `token add`

The Planner then shows the space's collections beside the ones on that computer, and changes from other computers as
they are made. A new collection goes where **Kept on** says, and **Move to …** in a collection's menu moves one between
the computer and the server. Chat links stay on the computer that made them; the server never sees them.

Use HTTPS for anything but a test on your own machine. The token goes with every request, and on macOS the app
refuses plain `http://` addresses other than `localhost`.

## HTTPS

Tokens travel in every request, so anything beyond your own computer needs HTTPS. Either put the server behind
a reverse proxy that handles certificates, for example Caddy:

```
planner.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

(Caddy streams the event stream as is. With nginx, turn off `proxy_buffering` for `/v1/events` and give it a
long `proxy_read_timeout`; the server sends a ping every 25 s.) Or give the server a certificate itself:

```bash
./planner-server serve --addr :443 --tls-cert fullchain.pem --tls-key privkey.pem
```

## Backups

Everything is in the database file (and, while the server runs, its `-wal` and `-shm` files beside it). Copy it
while the server runs with SQLite's own backup:

```bash
sqlite3 /var/lib/planner/planner.db ".backup /backups/planner-$(date +%F).db"
```

or stop the server and copy the file. To restore, stop the server and put the copy in place (without old
`-wal` or `-shm` files). Computers that saw newer writes than the backup notice and read everything again.

## systemd

```ini
# /etc/systemd/system/planner-server.service
[Unit]
Description=Mango Planner server
After=network-online.target
Wants=network-online.target

[Service]
User=planner
ExecStart=/usr/local/bin/planner-server serve --addr 127.0.0.1:8080 --db /var/lib/planner/planner.db
StateDirectory=planner
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --no-create-home planner
sudo systemctl enable --now planner-server
sudo -u planner planner-server token add --space team --name laptop --db /var/lib/planner/planner.db
```

## Docker

```bash
docker build -t planner-server .
docker run -d --name planner -p 8080:8080 -v planner-data:/data planner-server
docker exec planner /planner-server space add team --name "Team"
docker exec planner /planner-server token add --space team --name laptop
```

The database is `/data/planner.db`, in the volume. The image runs as a user without privileges.
