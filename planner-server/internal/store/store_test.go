package store

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ReaperMaga/mango/planner-server/internal/patch"
)

var ctx = context.Background()

type clock struct{ ms int64 }

func (c *clock) now() int64 { return c.ms }

func open(t *testing.T) (*Store, *clock) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	c := &clock{ms: 1_000_000}
	s.Now = c.now
	if err := s.AddSpace(ctx, "team", "Team"); err != nil {
		t.Fatal(err)
	}
	return s, c
}

func obj(t *testing.T, s string) map[string]any {
	t.Helper()
	v, err := decodeData([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func createCollection(t *testing.T, id, data string) Op {
	return Op{Op: "create", Kind: "collection", ID: id, CollectionID: id, Data: obj(t, data)}
}

func createItem(t *testing.T, id, collection, data string) Op {
	return Op{Op: "create", Kind: "item", ID: id, CollectionID: collection, Data: obj(t, data)}
}

func patchOp(kind, id, collection string, ops ...patch.Op) Op {
	return Op{Op: "patch", Kind: kind, ID: id, CollectionID: collection, Patch: ops}
}

func del(kind, id, collection string) Op {
	return Op{Op: "delete", Kind: kind, ID: id, CollectionID: collection}
}

func write(t *testing.T, s *Store, mutation string, ops ...Op) (int64, []Doc) {
	t.Helper()
	seq, docs, err := s.Write(ctx, "team", mutation, ops)
	if err != nil {
		t.Fatalf("write %s: %v", mutation, err)
	}
	return seq, docs
}

func data(d Doc) string {
	if d.Data == nil {
		return "null"
	}
	return string(d.Data)
}

func TestCreateExistingIsUnchanged(t *testing.T) {
	s, c := open(t)
	write(t, s, "m1", createCollection(t, "c1", `{"name":"A"}`))
	c.ms += 10
	seq, docs := write(t, s, "m2", createCollection(t, "c1", `{"name":"B"}`))
	if seq != 1 || len(docs) != 1 || data(docs[0]) != `{"name":"A"}` || docs[0].Seq != 1 || docs[0].UpdatedAt != 1_000_000 {
		t.Fatalf("got seq %d %+v", seq, docs)
	}
}

func TestCreateOnTombstoneResurrects(t *testing.T) {
	s, c := open(t)
	write(t, s, "m1", createCollection(t, "c1", `{"name":"A"}`))
	c.ms += 10
	_, docs := write(t, s, "m2", del("collection", "c1", "c1"))
	if docs[0].Data != nil || docs[0].Seq != 2 {
		t.Fatalf("not deleted: %+v", docs[0])
	}
	c.ms += 10
	seq, docs := write(t, s, "m3", createCollection(t, "c1", `{"name":"B"}`))
	d := docs[0]
	if seq != 3 || d.Seq != 3 || data(d) != `{"name":"B"}` || d.CreatedAt != 1_000_000 || d.UpdatedAt != 1_000_020 {
		t.Fatalf("got seq %d %+v", seq, d)
	}
}

func TestPatchAndDeleteOnMissing(t *testing.T) {
	s, _ := open(t)
	seq, docs := write(t, s, "m1",
		patchOp("item", "i1", "c1", patch.Op{Path: []string{"title"}, Value: "x"}),
		del("item", "i2", "c1"),
	)
	if seq != 0 || len(docs) != 2 {
		t.Fatalf("got seq %d %+v", seq, docs)
	}
	for _, d := range docs {
		if d.Data != nil || d.Seq != 0 || d.CreatedAt != 0 || d.UpdatedAt != 0 || d.CollectionID != "c1" || d.Kind != "item" {
			t.Errorf("not a tombstone: %+v", d)
		}
	}
	// A patch on a tombstone does nothing either.
	write(t, s, "m2", createItem(t, "i3", "c1", `{}`), del("item", "i3", "c1"))
	seq, docs = write(t, s, "m3", patchOp("item", "i3", "c1", patch.Op{Path: []string{"a"}, Value: "x"}), del("item", "i3", "c1"))
	if seq != 0 || len(docs) != 1 || docs[0].Data != nil || docs[0].Seq != 0 {
		t.Fatalf("got seq %d %+v", seq, docs)
	}
}

func TestOpsOnOneDocumentFold(t *testing.T) {
	s, _ := open(t)
	var committed []Doc
	s.OnCommit = func(space string, seq int64, docs []Doc) { committed = append(committed, docs...) }
	seq, docs := write(t, s, "m1",
		createCollection(t, "c1", `{"name":"A","views":{}}`),
		createItem(t, "i1", "c1", `{"title":"t"}`),
		patchOp("collection", "c1", "c1", patch.Op{Path: []string{"views", "v1"}, Value: obj(t, `{"name":"Board"}`)}),
		patchOp("collection", "c1", "c1", patch.Op{Path: []string{"views", "v1", "name"}, Value: nil}),
		patchOp("collection", "c1", "c1", patch.Op{Path: []string{"name"}, Remove: true}),
	)
	if seq != 1 || len(docs) != 2 || docs[0].ID != "c1" || docs[1].ID != "i1" {
		t.Fatalf("got seq %d %+v", seq, docs)
	}
	if got := data(docs[0]); got != `{"views":{"v1":{"name":null}}}` {
		t.Errorf("data %s", got)
	}
	if len(committed) != 2 {
		t.Errorf("committed %d docs", len(committed))
	}
	ch, _ := s.Changes(ctx, "team", 0, ChangesLimit)
	if ch.Seq != 1 || len(ch.Docs) != 2 {
		t.Errorf("changes %+v", ch)
	}
	// Create, then delete in one write: a document that never was.
	seq, docs = write(t, s, "m2", createItem(t, "i2", "c1", `{}`), del("item", "i2", "c1"))
	if seq != 1 || docs[0].Seq != 0 || docs[0].Data != nil {
		t.Fatalf("got seq %d %+v", seq, docs)
	}
}

func TestPatchThatChangesNothing(t *testing.T) {
	s, _ := open(t)
	write(t, s, "m1", createCollection(t, "c1", `{"name":"A","n":12345678901234567890}`))
	calls := 0
	s.OnCommit = func(string, int64, []Doc) { calls++ }
	seq, docs := write(t, s, "m2",
		patchOp("collection", "c1", "c1", patch.Op{Path: []string{"name"}, Value: "A"}),
		patchOp("collection", "c1", "c1", patch.Op{Path: []string{"views", "v1", "name"}, Value: "x"}),
	)
	if seq != 1 || docs[0].Seq != 1 || calls != 0 {
		t.Fatalf("got seq %d %+v, %d commits", seq, docs, calls)
	}
	if got := data(docs[0]); got != `{"n":12345678901234567890,"name":"A"}` {
		t.Errorf("data %s", got)
	}
}

func TestWriteIsAllOrNothing(t *testing.T) {
	s, _ := open(t)
	write(t, s, "m1", createItem(t, "i1", "c1", `{}`))
	cases := map[string][]Op{
		"collection mismatch":      {createCollection(t, "c2", `{}`), patchOp("item", "i1", "c9", patch.Op{Path: []string{"a"}, Value: "x"})},
		"named in two collections": {createCollection(t, "c2", `{}`), createItem(t, "i5", "c1", `{}`), del("item", "i5", "c2")},
		"too large":                {createCollection(t, "c2", `{}`), createItem(t, "i5", "c1", `{"s":"`+strings.Repeat("x", MaxDocBytes)+`"}`)},
		"bad op":                   {createCollection(t, "c2", `{}`), {Op: "move", Kind: "item", ID: "i1", CollectionID: "c1"}},
		"bad id":                   {createCollection(t, "c2", `{}`), {Op: "delete", Kind: "item", ID: "a/b", CollectionID: "c1"}},
		"collection's own id":      {{Op: "create", Kind: "collection", ID: "c2", CollectionID: "c3", Data: map[string]any{}}},
		"create without data":      {{Op: "create", Kind: "item", ID: "i5", CollectionID: "c1"}},
	}
	for name, ops := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, err := s.Write(ctx, "team", "bad-"+strings.ReplaceAll(name, " ", "-"), ops)
			var e *Error
			if !errors.As(err, &e) || (e.Code != "invalid" && e.Code != "too_large") {
				t.Fatalf("got %v", err)
			}
			if seq, _ := s.Seq(ctx, "team"); seq != 1 {
				t.Errorf("seq %d", seq)
			}
			if _, docs, _ := s.List(ctx, "team", "collection", ""); len(docs) != 0 {
				t.Errorf("collections %+v", docs)
			}
		})
	}
	// The refused mutation ids were not remembered: the same id with good ops is applied.
	if seq, _ := write(t, s, "bad-collection-mismatch", createCollection(t, "c2", `{}`)); seq != 2 {
		t.Errorf("seq %d", seq)
	}
}

func TestMutationTriedAgain(t *testing.T) {
	s, c := open(t)
	write(t, s, "m1", createCollection(t, "c1", `{"n":1}`), patchOp("item", "i9", "c1"))
	write(t, s, "m2", patchOp("collection", "c1", "c1", patch.Op{Path: []string{"n"}, Value: json.Number("2")}))
	seq, docs := write(t, s, "m1", createCollection(t, "c1", `{"n":1}`), patchOp("collection", "c1", "c1", patch.Op{Path: []string{"n"}, Value: json.Number("3")}))
	if seq != 2 || len(docs) != 2 || data(docs[0]) != `{"n":2}` || docs[0].Seq != 2 || docs[1].ID != "i9" || docs[1].Seq != 0 {
		t.Fatalf("got seq %d %+v", seq, docs)
	}
	// Forgotten after 7 days.
	c.ms += 8 * 24 * time.Hour.Milliseconds()
	if err := s.Prune(ctx, 7*24*time.Hour, 0); err != nil {
		t.Fatal(err)
	}
	if seq, _ := write(t, s, "m1", patchOp("collection", "c1", "c1", patch.Op{Path: []string{"n"}, Value: json.Number("3")})); seq != 3 {
		t.Errorf("seq %d", seq)
	}
}

func TestChangesPages(t *testing.T) {
	s, _ := open(t)
	write(t, s, "m1", createItem(t, "a", "c", `{}`), createItem(t, "b", "c", `{}`))
	write(t, s, "m2", createItem(t, "c", "c", `{}`), createItem(t, "d", "c", `{}`))
	write(t, s, "m3", createItem(t, "e", "c", `{}`))
	ids := func(docs []Doc) string {
		var out []string
		for _, d := range docs {
			out = append(out, d.ID)
		}
		return strings.Join(out, ",")
	}
	ch, _ := s.Changes(ctx, "team", 0, 3)
	if ch.Seq != 1 || !ch.More || ids(ch.Docs) != "a,b" {
		t.Fatalf("page 1 %+v", ch)
	}
	ch, _ = s.Changes(ctx, "team", ch.Seq, 3)
	if ch.Seq != 3 || ch.More || ids(ch.Docs) != "c,d,e" {
		t.Fatalf("page 2 %+v", ch)
	}
	ch, _ = s.Changes(ctx, "team", 0, 1)
	if ch.Seq != 1 || !ch.More || ids(ch.Docs) != "a,b" {
		t.Fatalf("a write larger than a page %+v", ch)
	}
	ch, _ = s.Changes(ctx, "team", 3, 3)
	if ch.Seq != 3 || ch.More || ch.Resync || len(ch.Docs) != 0 {
		t.Fatalf("up to date %+v", ch)
	}
	ch, _ = s.Changes(ctx, "team", 4, 3)
	if ch.Seq != 3 || !ch.Resync || len(ch.Docs) != 0 {
		t.Fatalf("after a reset %+v", ch)
	}
}

func TestPruneTombstones(t *testing.T) {
	s, c := open(t)
	write(t, s, "m1", createItem(t, "a", "c", `{}`), createItem(t, "b", "c", `{}`))
	write(t, s, "m2", del("item", "a", "c"))
	c.ms += 50 * 24 * time.Hour.Milliseconds()
	write(t, s, "m3", del("item", "b", "c"))
	c.ms += 50 * 24 * time.Hour.Milliseconds()
	if err := s.Prune(ctx, 7*24*time.Hour, 90*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if ch, _ := s.Changes(ctx, "team", 1, ChangesLimit); !ch.Resync || ch.Seq != 3 {
		t.Fatalf("behind the horizon %+v", ch)
	}
	ch, _ := s.Changes(ctx, "team", 2, ChangesLimit)
	if ch.Resync || len(ch.Docs) != 1 || ch.Docs[0].ID != "b" {
		t.Fatalf("at the horizon %+v", ch)
	}
	// The pruned tombstone is now a document never written.
	_, docs := write(t, s, "m4", del("item", "a", "c"))
	if docs[0].Seq != 0 {
		t.Errorf("%+v", docs[0])
	}
}

func TestCollectionIDIsFixed(t *testing.T) {
	s, _ := open(t)
	write(t, s, "m1", createItem(t, "i1", "c1", `{}`), createItem(t, "i2", "c1", `{}`))
	write(t, s, "m2", del("item", "i2", "c1"))
	for _, op := range []Op{createItem(t, "i1", "c2", `{}`), del("item", "i1", "c2"), createItem(t, "i2", "c2", `{}`)} {
		if _, _, err := s.Write(ctx, "team", "x", []Op{op}); err == nil || err.(*Error).Code != "invalid" {
			t.Errorf("%s %s in c2: %v", op.Op, op.ID, err)
		}
	}
	_, items, _ := s.List(ctx, "team", "item", "c1")
	if len(items) != 1 || items[0].ID != "i1" {
		t.Errorf("items %+v", items)
	}
}

func TestTokens(t *testing.T) {
	s, _ := open(t)
	token, tok, err := s.AddToken(ctx, "team", "laptop", "read")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, "pls_") || len(token) != 47 {
		t.Errorf("token %q", token)
	}
	p, err := s.Authenticate(ctx, token)
	if err != nil || p.SpaceID != "team" || p.SpaceName != "Team" || p.Role != "read" || p.CanWrite() {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := s.Authenticate(ctx, token+"x"); err != ErrNotFound {
		t.Errorf("unknown: %v", err)
	}
	if _, _, err := s.AddToken(ctx, "nope", "x", "write"); err != ErrNotFound {
		t.Errorf("no space: %v", err)
	}
	if err := s.RevokeToken(ctx, tok.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Authenticate(ctx, token); err != ErrNotFound {
		t.Errorf("revoked: %v", err)
	}
}

func TestRemoveSpace(t *testing.T) {
	s, _ := open(t)
	token, _, _ := s.AddToken(ctx, "team", "laptop", "write")
	write(t, s, "m1", createCollection(t, "c1", `{}`))
	if err := s.RemoveSpace(ctx, "team"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Authenticate(ctx, token); err != ErrNotFound {
		t.Errorf("token: %v", err)
	}
	if err := s.AddSpace(ctx, "team", ""); err != nil {
		t.Fatal(err)
	}
	if _, docs, _ := s.List(ctx, "team", "collection", ""); len(docs) != 0 {
		t.Errorf("docs %+v", docs)
	}
	if err := s.AddSpace(ctx, "team", ""); err == nil {
		t.Error("added twice")
	}
	if err := s.AddSpace(ctx, strings.Repeat("a", 65), ""); err == nil {
		t.Error("a long id")
	}
}
