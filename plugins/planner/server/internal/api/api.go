// Package api is the HTTP side of the protocol (PROTOCOL.md).
package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ReaperMaga/mango/plugins/planner/server/internal/live"
	"github.com/ReaperMaga/mango/plugins/planner/server/internal/patch"
	"github.com/ReaperMaga/mango/plugins/planner/server/internal/store"
)

const (
	Protocol     = 1
	MaxBodyBytes = 64 << 20
)

// Server answers the protocol's requests.
type Server struct {
	Store  *store.Store
	Broker *live.Broker
	// Name is what hello says the server is, e.g. "planner-server 0.1.0".
	Name string
	Log  *slog.Logger
	// PingEvery is how often an event stream gets a comment line.
	PingEvery time.Duration
	// MaxBody is the largest request body, in bytes.
	MaxBody int64

	origins   map[string]bool
	anyOrigin bool
}

// New makes a server. allowOrigin is the --allow-origin list: comma separated origins, or "*" for any.
func New(st *store.Store, broker *live.Broker, name, allowOrigin string, log *slog.Logger) *Server {
	s := &Server{Store: st, Broker: broker, Name: name, Log: log, PingEvery: 25 * time.Second, MaxBody: MaxBodyBytes, origins: map[string]bool{}}
	for _, o := range strings.Split(allowOrigin, ",") {
		o = strings.TrimRight(strings.TrimSpace(o), "/")
		if o == "*" {
			s.anyOrigin = true
		} else if o != "" {
			s.origins[o] = true
		}
	}
	return s
}

// Handler is every route, with logging, CORS and recovery around it.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/hello", s.auth(false, s.hello))
	mux.HandleFunc("GET /v1/people", s.auth(false, s.people))
	mux.HandleFunc("POST /v1/me", s.auth(false, s.rename))
	mux.HandleFunc("GET /v1/collections", s.auth(false, s.collections))
	mux.HandleFunc("GET /v1/collections/{collectionId}/items", s.auth(false, s.items))
	mux.HandleFunc("POST /v1/write", s.auth(true, s.write))
	mux.HandleFunc("GET /v1/changes", s.auth(false, s.changes))
	mux.HandleFunc("GET /v1/events", s.auth(false, s.events))
	mux.HandleFunc("OPTIONS /", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "There is no "+r.Method+" "+r.URL.Path+" here.")
	})
	return s.recover(s.logged(s.headers(mux)))
}

// Errors

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var b errorBody
	b.Error.Code, b.Error.Message = code, message
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="planner"`)
	}
	writeJSON(w, status, b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		http.Error(w, `{"error":{"code":"internal","message":"The answer could not be written."}}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b.Bytes())
}

// fail answers an error from the store: its own refusal, or an internal error (logged, not shown).
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var e *store.Error
	switch {
	case errors.As(err, &e):
		writeError(w, e.Status, e.Code, e.Message)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusUnauthorized, "unauthorized", "This token's space is gone.")
	default:
		if r.Context().Err() == nil {
			s.Log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		}
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on the server. Its log says more.")
	}
}

// Middleware

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the connection (flushes, deadlines).
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// logged writes one line per request. Never the query, a header or a body: no token or document reaches the log.
func (s *Server) logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		s.Log.Info("request", "method", r.Method, "path", r.URL.Path, "status", sw.status, "duration", time.Since(start).Round(time.Microsecond))
	})
}

func (s *Server) recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.Log.Error("panic", "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(v))
				writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on the server. Its log says more.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Add("Vary", "Origin")
		if origin := r.Header.Get("Origin"); origin != "" && (s.anyOrigin || s.origins[origin]) {
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Max-Age", "600")
		}
		next.ServeHTTP(w, r)
	})
}

func bearer(r *http.Request) string {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

type handler func(w http.ResponseWriter, r *http.Request, p *store.Principal)

func (s *Server) auth(write bool, h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearer(r)
		if token == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Send an access token: Authorization: Bearer <token>.")
			return
		}
		p, err := s.Store.Authenticate(r.Context(), token)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "This access token is unknown or was revoked.")
			return
		}
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if write && !p.CanWrite() {
			writeError(w, http.StatusForbidden, "forbidden", "This access token may read, not write.")
			return
		}
		h(w, r, p)
	}
}

// Routes

type helloBody struct {
	Protocol int    `json:"protocol"`
	Server   string `json:"server"`
	Space    struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"space"`
	Role string `json:"role"`
	// Me is the person this token is for.
	Me  *meBody `json:"me,omitempty"`
	Seq int64   `json:"seq"`
}

type meBody struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func meOf(p *store.Principal) *meBody {
	if p.PersonID == "" {
		return nil
	}
	return &meBody{ID: p.PersonID, Name: p.Name}
}

func (s *Server) helloOf(p *store.Principal, seq int64) helloBody {
	b := helloBody{Protocol: Protocol, Server: s.Name, Role: p.Role, Me: meOf(p), Seq: seq}
	b.Space.ID, b.Space.Name = p.SpaceID, p.SpaceName
	return b
}

func (s *Server) hello(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	seq, err := s.Store.Seq(r.Context(), p.SpaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.helloOf(p, seq))
}

type peopleBody struct {
	Me     *meBody        `json:"me"`
	People []store.Person `json:"people"`
}

func (s *Server) peopleOf(r *http.Request, p *store.Principal) (peopleBody, error) {
	list, err := s.Store.People(r.Context(), p.SpaceID)
	if err != nil {
		return peopleBody{}, err
	}
	me := meOf(p)
	for _, person := range list {
		if me != nil && person.ID == me.ID {
			me.Name = person.Name
		}
	}
	return peopleBody{Me: me, People: list}, nil
}

// people is everyone in the space: who may be assigned (active), and who was.
func (s *Server) people(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	body, err := s.peopleOf(r, p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// rename is POST /v1/me: the person a token is for gives themselves a new name. A read token may too.
func (s *Server) rename(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	var body struct {
		Name *string `json:"name"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if err := d.Decode(&body); err != nil || body.Name == nil {
		writeError(w, http.StatusBadRequest, "invalid", "Send your new name: {\"name\": \"…\"}.")
		return
	}
	if p.PersonID == "" {
		writeError(w, http.StatusBadRequest, "invalid", "This token is for nobody in particular.")
		return
	}
	changed, err := s.Store.RenamePerson(r.Context(), p.SpaceID, p.PersonID, *body.Name)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if changed {
		s.Broker.Publish(p.SpaceID, live.Event{People: true})
	}
	out, err := s.peopleOf(r, p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type docsBody struct {
	Seq  int64       `json:"seq"`
	Docs []store.Doc `json:"docs"`
}

func (s *Server) collections(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	seq, docs, err := s.Store.List(r.Context(), p.SpaceID, "collection", "")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, docsBody{seq, docs})
}

func (s *Server) items(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	id := r.PathValue("collectionId")
	if !store.ValidName(id, store.MaxNameLen) {
		writeError(w, http.StatusBadRequest, "invalid", "A collection id is 1 to 128 characters of A-Z a-z 0-9 _ -.")
		return
	}
	seq, docs, err := s.Store.List(r.Context(), p.SpaceID, "item", id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, docsBody{seq, docs})
}

func parseSince(r *http.Request) (int64, bool, error) {
	v := r.URL.Query().Get("since")
	if v == "" {
		return 0, false, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return 0, false, errors.New("since must be a seq: a whole number, 0 or more.")
	}
	return n, true, nil
}

func (s *Server) changes(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	since, _, err := parseSince(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
		return
	}
	ch, err := s.Store.Changes(r.Context(), p.SpaceID, since, store.ChangesLimit)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ch)
}

// The body of a write

// optional is a JSON value that may be left out: set tells a left-out value from null.
type optional struct {
	set   bool
	value any
}

func (o *optional) UnmarshalJSON(b []byte) error {
	o.set = true
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	return d.Decode(&o.value)
}

type writeBody struct {
	MutationID string `json:"mutationId"`
	Ops        []struct {
		Op           string `json:"op"`
		Kind         string `json:"kind"`
		ID           string `json:"id"`
		CollectionID string `json:"collectionId"`
		Data         any    `json:"data"`
		Patch        *[]struct {
			Path  *[]string `json:"path"`
			Value optional  `json:"value"`
		} `json:"patch"`
	} `json:"ops"`
}

func decodeWrite(body io.Reader) (string, []store.Op, error) {
	d := json.NewDecoder(body)
	d.UseNumber()
	var b writeBody
	if err := d.Decode(&b); err != nil {
		return "", nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return "", nil, errors.New("there is more after the JSON object")
	}
	if len(b.Ops) > store.MaxOps {
		return "", nil, fmt.Errorf("that is %d operations in one write; the most is %d", len(b.Ops), store.MaxOps)
	}
	ops := make([]store.Op, len(b.Ops))
	for i, o := range b.Ops {
		op := store.Op{Op: o.Op, Kind: o.Kind, ID: o.ID, CollectionID: o.CollectionID}
		switch o.Op {
		case "create":
			data, ok := o.Data.(map[string]any)
			if !ok {
				return "", nil, fmt.Errorf("ops[%d]: data must be a JSON object", i)
			}
			op.Data = data
		case "patch":
			if o.Patch == nil {
				return "", nil, fmt.Errorf("ops[%d]: a patch needs patch, a list of { path, value }", i)
			}
			op.Patch = make([]patch.Op, len(*o.Patch))
			for j, po := range *o.Patch {
				if po.Path == nil {
					return "", nil, fmt.Errorf("ops[%d].patch[%d]: path must be a list of strings", i, j)
				}
				op.Patch[j] = patch.Op{Path: *po.Path, Value: po.Value.value, Remove: !po.Value.set}
			}
		}
		ops[i] = op
	}
	return b.MutationID, ops, nil
}

func (s *Server) write(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	mutationID, ops, err := decodeWrite(http.MaxBytesReader(w, r.Body, s.MaxBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("A request body is at most %d bytes.", s.MaxBody))
			return
		}
		writeError(w, http.StatusBadRequest, "invalid", "This write is not valid: "+err.Error()+".")
		return
	}
	seq, docs, err := s.Store.Write(r.Context(), p.SpaceID, mutationID, ops)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, docsBody{seq, docs})
}
