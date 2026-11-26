// Package live hands committed writes to the event streams following a space.
package live

import (
	"sync"

	"github.com/ReaperMaga/mango/plugins/planner/server/internal/store"
)

// Event is one committed write: the documents it changed. Or, with People, word that the space's people
// changed (a rename): no documents, no seq.
type Event struct {
	Seq    int64       `json:"seq"`
	Docs   []store.Doc `json:"docs"`
	People bool        `json:"-"`
}

// Buffer is how many writes a stream may be behind before it is dropped (and told to resync).
const Buffer = 256

// Sub is one stream's subscription. Events arrive on C in commit order. Dropped is closed when the stream
// fell too far behind: it no longer gets events and must resync.
type Sub struct {
	C       chan Event
	Dropped chan struct{}
	space   string
}

// Broker never blocks a writer: a subscriber that cannot keep up is dropped instead.
type Broker struct {
	mu     sync.Mutex
	subs   map[string]map[*Sub]struct{}
	done   chan struct{}
	closed bool
}

func New() *Broker {
	return &Broker{subs: map[string]map[*Sub]struct{}{}, done: make(chan struct{})}
}

// Done is closed when the broker is closed (the server is shutting down).
func (b *Broker) Done() <-chan struct{} { return b.done }

func (b *Broker) Subscribe(space string) *Sub {
	s := &Sub{C: make(chan Event, Buffer), Dropped: make(chan struct{}), space: space}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.subs[space] == nil {
		b.subs[space] = map[*Sub]struct{}{}
	}
	b.subs[space][s] = struct{}{}
	return s
}

func (b *Broker) Unsubscribe(s *Sub) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.remove(s)
}

func (b *Broker) remove(s *Sub) {
	if subs := b.subs[s.space]; subs != nil {
		delete(subs, s)
		if len(subs) == 0 {
			delete(b.subs, s.space)
		}
	}
}

// Publish hands a committed write to every subscriber of its space.
func (b *Broker) Publish(space string, ev Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs[space] {
		select {
		case s.C <- ev:
		default:
			b.remove(s)
			close(s.Dropped)
		}
	}
}

// Close ends every stream.
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.closed {
		b.closed = true
		close(b.done)
	}
}
