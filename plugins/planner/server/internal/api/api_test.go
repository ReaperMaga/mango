package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ReaperMaga/mango/plugins/planner/server/internal/live"
	"github.com/ReaperMaga/mango/plugins/planner/server/internal/store"
)

type env struct {
	url         string
	write, read string
	readPerson  string
	st          *store.Store
	srv         *Server
	httpSrv     *httptest.Server
}

func setup(t *testing.T, allowOrigin string, configure func(*Server, *http.Server)) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	broker := live.New()
	st.OnCommit = func(space string, seq int64, docs []store.Doc) {
		broker.Publish(space, live.Event{Seq: seq, Docs: docs})
	}
	ctx := context.Background()
	if err := st.AddSpace(ctx, "team", "Team"); err != nil {
		t.Fatal(err)
	}
	write, _, _ := st.AddToken(ctx, "team", "w", "write")
	read, readTok, _ := st.AddToken(ctx, "team", "r", "read")
	srv := New(st, broker, "planner-server test", allowOrigin, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hs := httptest.NewUnstartedServer(srv.Handler())
	if configure != nil {
		configure(srv, hs.Config)
	}
	hs.Config.RegisterOnShutdown(broker.Close)
	hs.Start()
	t.Cleanup(func() {
		broker.Close()
		hs.Close()
		st.Close()
	})
	return &env{url: hs.URL, write: write, read: read, readPerson: readTok.PersonID, st: st, srv: srv, httpSrv: hs}
}

func (e *env) do(t *testing.T, method, path, token, body string) (*http.Response, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, e.url+path, r)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(raw) > 0 {
		d := json.NewDecoder(strings.NewReader(string(raw)))
		d.UseNumber()
		if err := d.Decode(&out); err != nil {
			t.Fatalf("%s %s: not JSON: %s", method, path, raw)
		}
	}
	return resp, out
}

func code(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func encode(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestAuth(t *testing.T) {
	e := setup(t, "*", nil)
	for _, tc := range []struct {
		method, path, token, body string
		status                    int
		code                      string
	}{
		{"GET", "/v1/hello", "", "", 401, "unauthorized"},
		{"GET", "/v1/hello", "pls_nope", "", 401, "unauthorized"},
		{"GET", "/v1/events", "pls_nope", "", 401, "unauthorized"},
		{"POST", "/v1/write", e.read, `{"mutationId":"m1","ops":[]}`, 403, "forbidden"},
		{"GET", "/v1/nowhere", e.read, "", 404, "not_found"},
		{"POST", "/v1/hello", e.read, "", 404, "not_found"},
	} {
		resp, body := e.do(t, tc.method, tc.path, tc.token, tc.body)
		if resp.StatusCode != tc.status || code(body) != tc.code {
			t.Errorf("%s %s: %d %v", tc.method, tc.path, resp.StatusCode, body)
		}
		if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Content-Type") != "application/json" {
			t.Errorf("%s %s: headers %v", tc.method, tc.path, resp.Header)
		}
	}
	resp, body := e.do(t, "GET", "/v1/hello", e.read, "")
	if resp.StatusCode != 200 || encode(body) != `{"me":{"id":"`+e.readPerson+`","name":"r"},"protocol":1,"role":"read","seq":0,"server":"planner-server test","space":{"id":"team","name":"Team"}}` {
		t.Errorf("hello: %d %v", resp.StatusCode, encode(body))
	}
}

func TestPeople(t *testing.T) {
	e := setup(t, "*", nil)
	_, ana, _ := e.st.AddToken(context.Background(), "team", "Ana", "write")
	resp, body := e.do(t, "GET", "/v1/people", e.read, "")
	people, _ := body["people"].([]any)
	me, _ := body["me"].(map[string]any)
	if resp.StatusCode != 200 || len(people) != 3 || me["name"] != "r" {
		t.Fatalf("people: %d %s", resp.StatusCode, encode(body))
	}
	first := people[0].(map[string]any)
	if first["id"] != ana.PersonID || first["name"] != "Ana" || first["active"] != true {
		t.Errorf("first: %v", first)
	}
	if resp, body := e.do(t, "GET", "/v1/people", "", ""); resp.StatusCode != 401 || code(body) != "unauthorized" {
		t.Errorf("without a token: %d %v", resp.StatusCode, body)
	}
}

func TestRenameMe(t *testing.T) {
	e := setup(t, "*", nil)
	events, stop := openStream(t, e, "")
	defer stop()
	if ev := next(t, events, true); ev.name != "hello" || !strings.Contains(ev.data, `"name":"r"`) {
		t.Fatalf("hello: %+v", ev)
	}
	// A read token renames its own person too.
	resp, body := e.do(t, "POST", "/v1/me", e.read, `{"name":"  Rita  "}`)
	if me, _ := body["me"].(map[string]any); resp.StatusCode != 200 || me["name"] != "Rita" {
		t.Fatalf("rename: %d %s", resp.StatusCode, encode(body))
	}
	// Everyone following the space hears that the people changed.
	if ev := next(t, events, true); ev.name != "people" {
		t.Errorf("event: %+v", ev)
	}
	if _, body := e.do(t, "GET", "/v1/hello", e.read, ""); !strings.Contains(encode(body), `"name":"Rita"`) {
		t.Errorf("hello after: %s", encode(body))
	}
	for _, tc := range []struct{ body, code string }{
		{`{"name":"W"}`, "conflict"},
		{`{"name":"@me"}`, "invalid"},
		{`{"nom":"x"}`, "invalid"},
		{`nope`, "invalid"},
	} {
		if _, body := e.do(t, "POST", "/v1/me", e.read, tc.body); code(body) != tc.code {
			t.Errorf("%s: %s", tc.body, encode(body))
		}
	}
}

func TestRenameFromElsewhereIsHeardAtPing(t *testing.T) {
	e := setup(t, "*", func(s *Server, _ *http.Server) { s.PingEvery = 50 * time.Millisecond })
	events, stop := openStream(t, e, "")
	defer stop()
	next(t, events, true)
	// The command line renames in another process: the server learns of it by looking.
	if _, err := e.st.RenamePerson(context.Background(), "team", e.readPerson, "Rita"); err != nil {
		t.Fatal(err)
	}
	if ev := next(t, events, true); ev.name != "people" {
		t.Errorf("event: %+v", ev)
	}
}

func TestCORS(t *testing.T) {
	e := setup(t, "tauri://localhost, http://tauri.localhost", nil)
	preflight := func(origin string) *http.Response {
		req, _ := http.NewRequest("OPTIONS", e.url+"/v1/write", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	resp := preflight("tauri://localhost")
	h := resp.Header
	if resp.StatusCode != 204 || h.Get("Access-Control-Allow-Origin") != "tauri://localhost" ||
		h.Get("Access-Control-Allow-Headers") != "Authorization, Content-Type" || h.Get("Access-Control-Allow-Methods") != "GET, POST, OPTIONS" {
		t.Errorf("allowed: %d %v", resp.StatusCode, h)
	}
	if resp := preflight("https://evil.example"); resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("not allowed: %v", resp.Header)
	}
	any := setup(t, "*", nil)
	req, _ := http.NewRequest("GET", any.url+"/v1/hello", nil)
	req.Header.Set("Origin", "https://anywhere.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 || resp.Header.Get("Access-Control-Allow-Origin") != "https://anywhere.example" {
		t.Errorf("any: %d %v", resp.StatusCode, resp.Header)
	}
}

func TestWriteAndRead(t *testing.T) {
	e := setup(t, "*", func(s *Server, _ *http.Server) { s.MaxBody = 4096 })
	resp, body := e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m1","ops":[
		{"op":"create","kind":"collection","id":"c1","collectionId":"c1","data":{"name":"Board","big":123456789012345678901234567890,"f":0.1000000000000000000001}},
		{"op":"create","kind":"item","id":"i1","collectionId":"c1","data":{"title":"<a>","values":{}}},
		{"op":"patch","kind":"item","id":"i1","collectionId":"c1","patch":[{"path":["values","p1"],"value":null},{"path":["title"]}]}
	]}`)
	if resp.StatusCode != 200 {
		t.Fatalf("write: %d %v", resp.StatusCode, body)
	}
	docs := body["docs"].([]any)
	if body["seq"] != json.Number("1") || len(docs) != 2 {
		t.Fatalf("write: %v", encode(body))
	}
	if got := encode(docs[1].(map[string]any)["data"]); got != `{"values":{"p1":null}}` {
		t.Errorf("item data %s", got)
	}

	_, body = e.do(t, "GET", "/v1/collections", e.read, "")
	c := body["docs"].([]any)[0].(map[string]any)
	if got := encode(c["data"]); got != `{"big":123456789012345678901234567890,"f":0.1000000000000000000001,"name":"Board"}` {
		t.Errorf("numbers: %s", got)
	}
	if c["kind"] != "collection" || c["collectionId"] != "c1" || c["seq"] != json.Number("1") {
		t.Errorf("collection %v", c)
	}
	_, body = e.do(t, "GET", "/v1/collections/c1/items", e.read, "")
	if len(body["docs"].([]any)) != 1 {
		t.Errorf("items %v", body)
	}
	_, body = e.do(t, "GET", "/v1/collections/other/items", e.read, "")
	if docs := body["docs"].([]any); len(docs) != 0 || body["seq"] != json.Number("1") {
		t.Errorf("other items %v", body)
	}

	// Patch, delete, then changes.
	_, body = e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m2","ops":[
		{"op":"patch","kind":"collection","id":"c1","collectionId":"c1","patch":[{"path":["name"],"value":"Team board"}]},
		{"op":"delete","kind":"item","id":"i1","collectionId":"c1"}]}`)
	if body["seq"] != json.Number("2") {
		t.Fatalf("m2 %v", body)
	}
	_, body = e.do(t, "GET", "/v1/changes?since=1", e.read, "")
	if docs := body["docs"].([]any); len(docs) != 2 || body["seq"] != json.Number("2") || body["more"] != nil || docs[1].(map[string]any)["data"] != nil {
		t.Errorf("changes %v", encode(body))
	}
	_, body = e.do(t, "GET", "/v1/changes?since=9", e.read, "")
	if body["resync"] != true || body["seq"] != json.Number("2") {
		t.Errorf("resync %v", body)
	}
	resp, body = e.do(t, "GET", "/v1/changes?since=-1", e.read, "")
	if resp.StatusCode != 400 || code(body) != "invalid" {
		t.Errorf("since -1: %d %v", resp.StatusCode, body)
	}

	// Tried again: answered as it is now, not applied twice.
	_, body = e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m1","ops":[{"op":"create","kind":"item","id":"i1","collectionId":"c1","data":{}}]}`)
	if docs := body["docs"].([]any); len(docs) != 2 || docs[1].(map[string]any)["data"] != nil || body["seq"] != json.Number("2") {
		t.Errorf("retry %v", encode(body))
	}

	for name, tc := range map[string]struct {
		body   string
		status int
	}{
		"not JSON":            {`{"mutationId":`, 400},
		"no mutation id":      {`{"ops":[]}`, 400},
		"data not an object":  {`{"mutationId":"x","ops":[{"op":"create","kind":"item","id":"i","collectionId":"c","data":[1]}]}`, 400},
		"data null":           {`{"mutationId":"x","ops":[{"op":"create","kind":"item","id":"i","collectionId":"c","data":null}]}`, 400},
		"path not strings":    {`{"mutationId":"x","ops":[{"op":"patch","kind":"item","id":"i","collectionId":"c","patch":[{"path":["a",1]}]}]}`, 400},
		"no path":             {`{"mutationId":"x","ops":[{"op":"patch","kind":"item","id":"i","collectionId":"c","patch":[{"value":1}]}]}`, 400},
		"no patch":            {`{"mutationId":"x","ops":[{"op":"patch","kind":"item","id":"i","collectionId":"c"}]}`, 400},
		"collection mismatch": {`{"mutationId":"x","ops":[{"op":"delete","kind":"item","id":"i1","collectionId":"c2"}]}`, 400},
		"bad kind":            {`{"mutationId":"x","ops":[{"op":"delete","kind":"board","id":"i1","collectionId":"c1"}]}`, 400},
		"two values":          {`{"mutationId":"x","ops":[]} {}`, 400},
		"too large":           {`{"mutationId":"x","ops":[],"pad":"` + strings.Repeat("x", 5000) + `"}`, 413},
	} {
		resp, body := e.do(t, "POST", "/v1/write", e.write, tc.body)
		want := map[int]string{400: "invalid", 413: "too_large"}[tc.status]
		if resp.StatusCode != tc.status || code(body) != want {
			t.Errorf("%s: %d %v", name, resp.StatusCode, body)
		}
	}
	if seq, _ := e.st.Seq(context.Background(), "team"); seq != 2 {
		t.Errorf("seq %d after refused writes", seq)
	}
}

type event struct{ name, data string }

// readEvents parses a stream into events; comment lines come as events named ":".
func readEvents(body io.Reader, out chan<- event) {
	defer close(out)
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	var ev event
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if ev.name != "" {
				out <- ev
			}
			ev = event{}
		case strings.HasPrefix(line, ":"):
			out <- event{name: ":", data: line}
		case strings.HasPrefix(line, "event: "):
			ev.name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			ev.data = strings.TrimPrefix(line, "data: ")
		}
	}
}

func next(t *testing.T, events <-chan event, skipPings bool) event {
	t.Helper()
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatal("the stream ended")
			}
			if skipPings && ev.name == ":" {
				continue
			}
			return ev
		case <-time.After(5 * time.Second):
			t.Fatal("no event within 5 s")
		}
	}
}

func openStream(t *testing.T, e *env, query string) (<-chan event, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", e.url+"/v1/events"+query, nil)
	req.Header.Set("Authorization", "Bearer "+e.read)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %d %v", resp.StatusCode, resp.Header)
	}
	events := make(chan event, 100)
	go readEvents(resp.Body, events)
	return events, func() { cancel(); resp.Body.Close() }
}

func TestEvents(t *testing.T) {
	e := setup(t, "*", func(s *Server, hs *http.Server) {
		s.PingEvery = 150 * time.Millisecond
		// Short timeouts: the stream must outlive them.
		hs.WriteTimeout = 300 * time.Millisecond
		hs.ReadTimeout = 300 * time.Millisecond
	})
	e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m1","ops":[{"op":"create","kind":"collection","id":"c1","collectionId":"c1","data":{"n":1}}]}`)
	e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m2","ops":[{"op":"create","kind":"collection","id":"c2","collectionId":"c2","data":{"n":2}}]}`)

	events, stop := openStream(t, e, "?since=1")
	defer stop()
	if ev := next(t, events, true); ev.name != "hello" || !strings.Contains(ev.data, `"seq":2`) || !strings.Contains(ev.data, `"role":"read"`) {
		t.Fatalf("hello: %+v", ev)
	}
	if ev := next(t, events, true); ev.name != "docs" || !strings.HasPrefix(ev.data, `{"seq":2,"docs":[{"kind":"collection","id":"c2"`) {
		t.Fatalf("backlog: %+v", ev)
	}

	time.Sleep(700 * time.Millisecond) // past both timeouts
	if ev := next(t, events, false); ev.name != ":" {
		t.Fatalf("ping: %+v", ev)
	}
	e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m3","ops":[{"op":"patch","kind":"collection","id":"c1","collectionId":"c1","patch":[{"path":["n"],"value":3}]}]}`)
	ev := next(t, events, true)
	if ev.name != "docs" || !strings.HasPrefix(ev.data, `{"seq":3,"docs":[{"kind":"collection","id":"c1"`) || !strings.Contains(ev.data, `"data":{"n":3}`) {
		t.Fatalf("live: %+v", ev)
	}
	// A write that changes nothing sends nothing; the next one comes next.
	e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m4","ops":[{"op":"patch","kind":"collection","id":"c1","collectionId":"c1","patch":[{"path":["n"],"value":3}]}]}`)
	e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m5","ops":[{"op":"delete","kind":"collection","id":"c2","collectionId":"c2"}]}`)
	if ev := next(t, events, true); ev.name != "docs" || !strings.HasPrefix(ev.data, `{"seq":4,`) || !strings.Contains(ev.data, `"data":null`) {
		t.Fatalf("live 2: %+v", ev)
	}
}

func TestEventsWithoutSinceAndResync(t *testing.T) {
	e := setup(t, "*", nil)
	e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m1","ops":[{"op":"create","kind":"collection","id":"c1","collectionId":"c1","data":{}}]}`)

	events, stop := openStream(t, e, "")
	defer stop()
	if ev := next(t, events, true); ev.name != "hello" || !strings.Contains(ev.data, `"seq":1`) {
		t.Fatalf("hello: %+v", ev)
	}
	e.do(t, "POST", "/v1/write", e.write, `{"mutationId":"m2","ops":[{"op":"create","kind":"collection","id":"c2","collectionId":"c2","data":{}}]}`)
	if ev := next(t, events, true); ev.name != "docs" || !strings.HasPrefix(ev.data, `{"seq":2,`) {
		t.Fatalf("live: %+v", ev)
	}

	ahead, stop2 := openStream(t, e, "?since=50")
	defer stop2()
	next(t, ahead, true)
	if ev := next(t, ahead, true); ev.name != "resync" || ev.data != `{"seq":2}` {
		t.Fatalf("resync: %+v", ev)
	}
}

func TestEventsEndWhenTokenRevoked(t *testing.T) {
	e := setup(t, "*", func(s *Server, _ *http.Server) { s.PingEvery = 50 * time.Millisecond })
	events, stop := openStream(t, e, "")
	defer stop()
	next(t, events, true)
	tokens, _ := e.st.Tokens(context.Background(), "team")
	for _, tok := range tokens {
		if tok.Role == "read" {
			e.st.RevokeToken(context.Background(), tok.ID)
		}
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-events:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("the stream did not end")
		}
	}
}
