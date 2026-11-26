package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/ReaperMaga/mango/plugins/planner/server/internal/live"
	"github.com/ReaperMaga/mango/plugins/planner/server/internal/store"
)

type stream struct {
	w  http.ResponseWriter
	rc *http.ResponseController
}

func (st stream) send(event string, v any) error {
	var b bytes.Buffer
	b.WriteString("event: " + event + "\ndata: ")
	e := json.NewEncoder(&b) // one line: Encode ends it with "\n"
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return err
	}
	b.WriteString("\n")
	return st.flush(b.Bytes())
}

func (st stream) flush(b []byte) error {
	if _, err := st.w.Write(b); err != nil {
		return err
	}
	return st.rc.Flush()
}

// peopleKey says who the space's people are, to tell when that changed; "" when it cannot be read.
func (s *Server) peopleKey(ctx context.Context, space string) string {
	list, err := s.Store.People(ctx, space)
	if err != nil {
		return ""
	}
	b, _ := json.Marshal(list)
	return string(b)
}

type seqBody struct {
	Seq int64 `json:"seq"`
}

// events is GET /v1/events: hello, then what changes?since=N would answer, then every write as it is
// committed. It subscribes before reading anything, and skips live writes it already sent, so nothing is
// missed or sent twice between the backlog and the live writes.
func (s *Server) events(w http.ResponseWriter, r *http.Request, p *store.Principal) {
	since, hasSince, err := parseSince(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
		return
	}
	ctx := r.Context()
	sub := s.Broker.Subscribe(p.SpaceID)
	defer func() { s.Broker.Unsubscribe(sub) }()
	seq, err := s.Store.Seq(ctx, p.SpaceID)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// The stream lasts: the server's read and write timeouts are for ordinary requests.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	st := stream{w, rc}
	if st.send("hello", s.helloOf(p, seq)) != nil {
		return
	}

	last := seq
	for hasSince {
		ch, err := s.Store.Changes(ctx, p.SpaceID, since, store.ChangesLimit)
		if err != nil {
			if ctx.Err() == nil {
				s.Log.Error("event stream", "space", p.SpaceID, "err", err)
			}
			return
		}
		if ch.Resync {
			last = ch.Seq
			if st.send("resync", seqBody{ch.Seq}) != nil {
				return
			}
			break
		}
		if len(ch.Docs) > 0 && st.send("docs", live.Event{Seq: ch.Seq, Docs: ch.Docs}) != nil {
			return
		}
		since = ch.Seq
		if !ch.More {
			last = ch.Seq
			break
		}
	}

	token := bearer(r)
	// The people as last told, to tell a change made from the command line (another process) at the next ping.
	people := s.peopleKey(ctx, p.SpaceID)
	ping := time.NewTicker(s.PingEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.Broker.Done():
			return
		case ev := <-sub.C:
			if ev.People {
				people = s.peopleKey(ctx, p.SpaceID)
				if st.send("people", struct{}{}) != nil {
					return
				}
				continue
			}
			if ev.Seq <= last {
				continue
			}
			last = ev.Seq
			if st.send("docs", ev) != nil {
				return
			}
		case <-sub.Dropped:
			// Too far behind to be told write by write: follow again from now, and say so.
			sub = s.Broker.Subscribe(p.SpaceID)
			if last, err = s.Store.Seq(ctx, p.SpaceID); err != nil {
				return
			}
			if st.send("resync", seqBody{last}) != nil {
				return
			}
		case <-ping.C:
			// A token revoked (or a space removed) since the stream began ends it.
			if _, err := s.Store.Authenticate(ctx, token); errors.Is(err, store.ErrNotFound) {
				return
			}
			if now := s.peopleKey(ctx, p.SpaceID); now != people {
				people = now
				if st.send("people", struct{}{}) != nil {
					return
				}
			}
			if st.flush([]byte(": ping\n\n")) != nil {
				return
			}
		}
	}
}
