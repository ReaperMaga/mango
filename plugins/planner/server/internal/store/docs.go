package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/ReaperMaga/mango/plugins/planner/server/internal/patch"
)

const (
	MaxDocBytes  = 1 << 20 // a document's data, as JSON
	MaxOps       = 20_000  // operations in one write
	ChangesLimit = 5_000   // documents in one answer of changes (one write is never split)
	MaxNameLen   = 128     // ids, collection ids and mutation ids
)

// Doc is a document as the protocol sends it. Data is nil for a tombstone.
type Doc struct {
	Kind         string          `json:"kind"`
	ID           string          `json:"id"`
	CollectionID string          `json:"collectionId"`
	Seq          int64           `json:"seq"`
	CreatedAt    int64           `json:"createdAt"`
	UpdatedAt    int64           `json:"updatedAt"`
	Data         json.RawMessage `json:"data"`
}

// Op is one operation of a write: "create" (with Data), "patch" (with Patch) or "delete".
type Op struct {
	Op           string
	Kind         string
	ID           string
	CollectionID string
	Data         map[string]any
	Patch        []patch.Op
}

type address struct {
	Kind         string `json:"kind"`
	ID           string `json:"id"`
	CollectionID string `json:"collectionId"`
}

func (a address) tombstone() Doc {
	return Doc{Kind: a.Kind, ID: a.ID, CollectionID: a.CollectionID}
}

// ValidateOps checks what can be checked without the database.
func ValidateOps(mutationID string, ops []Op) error {
	if !ValidName(mutationID, MaxNameLen) {
		return invalid("mutationId must be 1 to 128 characters of A-Z a-z 0-9 _ -.")
	}
	if len(ops) > MaxOps {
		return invalid("That is %d operations in one write. The most is %d.", len(ops), MaxOps)
	}
	for i, op := range ops {
		if op.Kind != "collection" && op.Kind != "item" {
			return invalid("ops[%d]: kind must be collection or item.", i)
		}
		if !ValidName(op.ID, MaxNameLen) || !ValidName(op.CollectionID, MaxNameLen) {
			return invalid("ops[%d]: id and collectionId must be 1 to 128 characters of A-Z a-z 0-9 _ -.", i)
		}
		if op.Kind == "collection" && op.CollectionID != op.ID {
			return invalid("ops[%d]: a collection's collectionId is its own id.", i)
		}
		switch op.Op {
		case "create":
			if op.Data == nil {
				return invalid("ops[%d]: a create needs data, a JSON object.", i)
			}
		case "patch", "delete":
		default:
			return invalid("ops[%d]: op must be create, patch or delete.", i)
		}
	}
	return nil
}

func encodeData(v map[string]any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

func decodeData(b []byte) (map[string]any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v map[string]any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	if v == nil {
		v = map[string]any{}
	}
	return v, nil
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

const docColumns = `kind, id, collection_id, seq, created_at, updated_at, data`

func scanDoc(scan func(...any) error) (Doc, error) {
	var d Doc
	var data sql.NullString
	if err := scan(&d.Kind, &d.ID, &d.CollectionID, &d.Seq, &d.CreatedAt, &d.UpdatedAt, &data); err != nil {
		return d, err
	}
	if data.Valid {
		d.Data = json.RawMessage(data.String)
	}
	return d, nil
}

// getDoc is the stored document at an address, or nil when it was never written (or was pruned).
func getDoc(ctx context.Context, q querier, space string, a address) (*Doc, error) {
	d, err := scanDoc(q.QueryRowContext(ctx, `SELECT `+docColumns+` FROM docs WHERE space_id = ? AND kind = ? AND id = ?`, space, a.Kind, a.ID).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func queryDocs(ctx context.Context, q querier, query string, args ...any) ([]Doc, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	docs := []Doc{}
	for rows.Next() {
		d, err := scanDoc(rows.Scan)
		if err != nil {
			return nil, err
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

func spaceSeq(ctx context.Context, q querier, space string) (seq, horizon int64, err error) {
	err = q.QueryRowContext(ctx, `SELECT seq, horizon FROM spaces WHERE id = ?`, space).Scan(&seq, &horizon)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// Seq is the space's latest seq.
func (s *Store) Seq(ctx context.Context, space string) (int64, error) {
	seq, _, err := spaceSeq(ctx, s.r, space)
	return seq, err
}

// List answers the live documents of a kind (of one collection, for items), with the space's seq at the time
// of reading.
func (s *Store) List(ctx context.Context, space, kind, collectionID string) (int64, []Doc, error) {
	tx, err := s.r.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	seq, _, err := spaceSeq(ctx, tx, space)
	if err != nil {
		return 0, nil, err
	}
	query := `SELECT ` + docColumns + ` FROM docs WHERE space_id = ? AND kind = ? AND data IS NOT NULL`
	args := []any{space, kind}
	if kind == "item" {
		query += ` AND collection_id = ?`
		args = append(args, collectionID)
	}
	docs, err := queryDocs(ctx, tx, query+` ORDER BY created_at, id`, args...)
	return seq, docs, err
}

// Changes is an answer of changes: documents written after a seq, or Resync.
type Changes struct {
	Seq    int64 `json:"seq"`
	Docs   []Doc `json:"docs"`
	More   bool  `json:"more,omitempty"`
	Resync bool  `json:"resync,omitempty"`
}

// Changes answers everything written after since, oldest first, at most about limit documents: a page ends
// between writes, so asking again from its Seq misses nothing. A single write larger than limit comes whole.
func (s *Store) Changes(ctx context.Context, space string, since int64, limit int) (Changes, error) {
	tx, err := s.r.BeginTx(ctx, nil)
	if err != nil {
		return Changes{}, err
	}
	defer tx.Rollback()
	seq, horizon, err := spaceSeq(ctx, tx, space)
	if err != nil {
		return Changes{}, err
	}
	if since < horizon || since > seq {
		return Changes{Seq: seq, Docs: []Doc{}, Resync: true}, nil
	}
	docs, err := queryDocs(ctx, tx, `SELECT `+docColumns+` FROM docs WHERE space_id = ? AND seq > ? ORDER BY seq, kind, id LIMIT ?`, space, since, limit+1)
	if err != nil {
		return Changes{}, err
	}
	if len(docs) <= limit {
		return Changes{Seq: seq, Docs: docs}, nil
	}
	last := docs[limit-1].Seq
	if docs[limit].Seq != last {
		docs = docs[:limit]
	} else {
		// The page would end inside a write: end it before that write, or, when that write is all of it,
		// answer the whole write.
		n := limit
		for n > 0 && docs[n-1].Seq == last {
			n--
		}
		if n > 0 {
			docs = docs[:n]
		} else if docs, err = queryDocs(ctx, tx, `SELECT `+docColumns+` FROM docs WHERE space_id = ? AND seq = ? ORDER BY kind, id`, space, last); err != nil {
			return Changes{}, err
		}
	}
	return Changes{Seq: docs[len(docs)-1].Seq, Docs: docs, More: true}, nil
}

// Write applies ops in one transaction, all of them or none, and answers every document they named as it is
// now. A mutationId seen before is not applied again.
func (s *Store) Write(ctx context.Context, space, mutationID string, ops []Op) (int64, []Doc, error) {
	if err := ValidateOps(mutationID, ops); err != nil {
		return 0, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	seq, _, err := spaceSeq(ctx, tx, space)
	if err != nil {
		return 0, nil, err
	}

	var named []byte
	err = tx.QueryRowContext(ctx, `SELECT docs FROM mutations WHERE space_id = ? AND mutation_id = ?`, space, mutationID).Scan(&named)
	if err == nil {
		var addresses []address
		if err := json.Unmarshal(named, &addresses); err != nil {
			return 0, nil, err
		}
		docs := make([]Doc, len(addresses))
		for i, a := range addresses {
			d, err := getDoc(ctx, tx, space, a)
			if err != nil {
				return 0, nil, err
			}
			if d == nil {
				docs[i] = a.tombstone()
			} else {
				docs[i] = *d
			}
		}
		return seq, docs, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, nil, err
	}

	// One write per document: the ops on it folded, in order, onto what is stored.
	type work struct {
		address
		stored *Doc
		data   map[string]any // nil: a tombstone, or never written
		result *Doc
	}
	works := map[address]*work{}
	var order []*work
	for i, op := range ops {
		key := address{Kind: op.Kind, ID: op.ID}
		w := works[key]
		if w == nil {
			a := address{Kind: op.Kind, ID: op.ID, CollectionID: op.CollectionID}
			stored, err := getDoc(ctx, tx, space, a)
			if err != nil {
				return 0, nil, err
			}
			w = &work{address: a, stored: stored}
			if stored != nil && stored.CollectionID != op.CollectionID {
				return 0, nil, invalid("ops[%d]: item %s is in collection %s, not %s.", i, op.ID, stored.CollectionID, op.CollectionID)
			}
			if stored != nil && stored.Data != nil {
				if w.data, err = decodeData(stored.Data); err != nil {
					return 0, nil, err
				}
			}
			works[key] = w
			order = append(order, w)
		} else if w.CollectionID != op.CollectionID {
			return 0, nil, invalid("ops[%d]: item %s is named in collection %s and in %s.", i, op.ID, w.CollectionID, op.CollectionID)
		}
		switch op.Op {
		case "create":
			// When it exists, it is the same one (ids are random): a create tried again.
			if w.data == nil {
				w.data = op.Data
			}
		case "patch":
			if w.data != nil {
				w.data = patch.Apply(w.data, op.Patch)
			}
		case "delete":
			w.data = nil
		}
	}

	now := s.Now()
	next := seq + 1
	var changed []Doc
	for _, w := range order {
		var data []byte
		if w.data != nil {
			if data, err = encodeData(w.data); err != nil {
				return 0, nil, err
			}
			if len(data) > MaxDocBytes {
				return 0, nil, tooLarge("The %s %s would be %d bytes of JSON. The most is %d, so nothing was changed.", w.Kind, w.ID, len(data), MaxDocBytes)
			}
		}
		wasAlive := w.stored != nil && w.stored.Data != nil
		if (!wasAlive && data == nil) || (wasAlive && data != nil && bytes.Equal(data, w.stored.Data)) {
			continue
		}
		d := Doc{Kind: w.Kind, ID: w.ID, CollectionID: w.CollectionID, Seq: next, CreatedAt: now, UpdatedAt: now, Data: data}
		if w.stored != nil {
			d.CreatedAt = w.stored.CreatedAt
		}
		var text sql.NullString
		if data != nil {
			text = sql.NullString{String: string(data), Valid: true}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO docs (space_id, kind, id, collection_id, seq, created_at, updated_at, data)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (space_id, kind, id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at, data = excluded.data`,
			space, d.Kind, d.ID, d.CollectionID, d.Seq, d.CreatedAt, d.UpdatedAt, text); err != nil {
			return 0, nil, err
		}
		w.result = &d
		changed = append(changed, d)
	}
	if len(changed) > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE spaces SET seq = ? WHERE id = ?`, next, space); err != nil {
			return 0, nil, err
		}
		seq = next
	}

	addresses := make([]address, len(order))
	docs := make([]Doc, len(order))
	for i, w := range order {
		addresses[i] = w.address
		switch {
		case w.result != nil:
			docs[i] = *w.result
		case w.stored != nil:
			docs[i] = *w.stored
		default:
			docs[i] = w.address.tombstone()
		}
	}
	list, err := json.Marshal(addresses)
	if err != nil {
		return 0, nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO mutations (space_id, mutation_id, created_at, docs) VALUES (?, ?, ?, ?)`,
		space, mutationID, now, string(list)); err != nil {
		return 0, nil, err
	}
	if err := tx.Commit(); err != nil {
		return 0, nil, err
	}
	if len(changed) > 0 && s.OnCommit != nil {
		s.OnCommit(space, seq, changed)
	}
	return seq, docs, nil
}
