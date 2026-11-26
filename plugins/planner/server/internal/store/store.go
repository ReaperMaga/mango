// Package store keeps spaces, access tokens and documents in one SQLite file.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Error is a refusal a person can act on. The API answers it with its Status and Code.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func invalid(format string, args ...any) error {
	return &Error{Status: 400, Code: "invalid", Message: fmt.Sprintf(format, args...)}
}

func tooLarge(format string, args ...any) error {
	return &Error{Status: 413, Code: "too_large", Message: fmt.Sprintf(format, args...)}
}

// ErrNotFound is returned for a space or token that does not exist.
var ErrNotFound = errors.New("not found")

// Store is the database. Writes to documents are made one at a time (mu), so a space's seq only grows and
// the order writes are committed in is the order of their seq.
type Store struct {
	w, r *sql.DB
	mu   sync.Mutex
	// Now is the clock, in ms since the epoch. Tests replace it.
	Now func() int64
	// OnCommit is called after each committed write that changed documents, in commit order, with the
	// documents it changed. It must not block.
	OnCommit func(space string, seq int64, docs []Doc)

	touchMu sync.Mutex
	touched map[string]int64
}

const schema = `
CREATE TABLE IF NOT EXISTS spaces (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	seq INTEGER NOT NULL DEFAULT 0,
	horizon INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
	id TEXT PRIMARY KEY,
	space_id TEXT NOT NULL,
	name TEXT NOT NULL,
	role TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER,
	person_id TEXT
);
CREATE TABLE IF NOT EXISTS people (
	id TEXT PRIMARY KEY,
	space_id TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS people_by_space ON people (space_id);
CREATE TABLE IF NOT EXISTS docs (
	space_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	id TEXT NOT NULL,
	collection_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	data TEXT,
	PRIMARY KEY (space_id, kind, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS docs_by_seq ON docs (space_id, seq);
CREATE INDEX IF NOT EXISTS docs_by_collection ON docs (space_id, kind, collection_id);
CREATE TABLE IF NOT EXISTS mutations (
	space_id TEXT NOT NULL,
	mutation_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	docs TEXT NOT NULL,
	PRIMARY KEY (space_id, mutation_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mutations_by_age ON mutations (created_at);
`

func dsn(path string, txlock string) string {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Add("_txlock", txlock)
	// A plain path (no "file:"): the driver takes the query off and opens the file by its name as it is.
	return path + "?" + q.Encode()
}

// Open opens (and makes, when needed) the database at path.
func Open(path string) (*Store, error) {
	w, err := sql.Open("sqlite", dsn(path, "immediate"))
	if err != nil {
		return nil, err
	}
	// One connection writes; its transactions take the write lock when they begin, so they never fail
	// half way because another connection wrote first.
	w.SetMaxOpenConns(1)
	if _, err := w.Exec(schema); err != nil {
		w.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if err := migrate(w); err != nil {
		w.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	r, err := sql.Open("sqlite", dsn(path, "deferred"))
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	return &Store{w: w, r: r, Now: func() int64 { return time.Now().UnixMilli() }, touched: map[string]int64{}}, nil
}

func (s *Store) Close() error {
	return errors.Join(s.r.Close(), s.w.Close())
}

// ValidName reports whether s is 1 to max characters of A-Z a-z 0-9 _ -.
func ValidName(s string, max int) bool {
	if len(s) == 0 || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// Space is a separate set of documents with its own seq.
type Space struct {
	ID        string
	Name      string
	CreatedAt int64
	Seq       int64
	Horizon   int64
	Docs      int64
	Tokens    int64
}

func (s *Store) AddSpace(ctx context.Context, id, name string) error {
	if !ValidName(id, 64) {
		return invalid("A space id is 1 to 64 characters of A-Z a-z 0-9 _ -.")
	}
	if name == "" {
		name = id
	}
	res, err := s.w.ExecContext(ctx, `INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, id, name, s.Now())
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return invalid("There is a space %q already.", id)
	}
	return nil
}

func (s *Store) Spaces(ctx context.Context) ([]Space, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, name, created_at, seq, horizon,
		(SELECT COUNT(*) FROM docs WHERE space_id = spaces.id AND data IS NOT NULL),
		(SELECT COUNT(*) FROM tokens WHERE space_id = spaces.id AND revoked_at IS NULL)
		FROM spaces ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Space
	for rows.Next() {
		var sp Space
		if err := rows.Scan(&sp.ID, &sp.Name, &sp.CreatedAt, &sp.Seq, &sp.Horizon, &sp.Docs, &sp.Tokens); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

// RemoveSpace deletes a space with its documents, tokens and remembered mutations.
func (s *Store) RemoveSpace(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM spaces WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	for _, q := range []string{`DELETE FROM docs WHERE space_id = ?`, `DELETE FROM tokens WHERE space_id = ?`, `DELETE FROM people WHERE space_id = ?`, `DELETE FROM mutations WHERE space_id = ?`} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// touch notes when a token was used, at most once a minute per token, without making the request wait.
func (s *Store) touch(tokenID string) {
	now := s.Now()
	s.touchMu.Lock()
	if now-s.touched[tokenID] < 60_000 {
		s.touchMu.Unlock()
		return
	}
	s.touched[tokenID] = now
	s.touchMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = s.w.ExecContext(ctx, `UPDATE tokens SET last_used_at = ? WHERE id = ?`, now, tokenID)
	}()
}

// Prune forgets mutation ids older than keepMutations and tombstones older than keepTombstones
// (never, when it is 0). A space's horizon becomes the highest seq it pruned, so changes can tell a client
// that was away longer to read everything again.
func (s *Store) Prune(ctx context.Context, keepMutations, keepTombstones time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.Now()
	if _, err := tx.ExecContext(ctx, `DELETE FROM mutations WHERE created_at < ?`, now-keepMutations.Milliseconds()); err != nil {
		return err
	}
	if keepTombstones > 0 {
		cutoff := now - keepTombstones.Milliseconds()
		if _, err := tx.ExecContext(ctx, `UPDATE spaces SET horizon = MAX(horizon,
			(SELECT COALESCE(MAX(seq), 0) FROM docs WHERE space_id = spaces.id AND data IS NULL AND updated_at < ?))`, cutoff); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM docs WHERE data IS NULL AND updated_at < ?`, cutoff); err != nil {
			return err
		}
	}
	return tx.Commit()
}
