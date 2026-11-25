package live

import "testing"

func TestSlowSubscriberIsDropped(t *testing.T) {
	b := New()
	slow, other := b.Subscribe("team"), b.Subscribe("other")
	for i := 1; i <= Buffer+1; i++ {
		b.Publish("team", Event{Seq: int64(i)}) // never blocks
	}
	select {
	case <-slow.Dropped:
	default:
		t.Fatal("not dropped")
	}
	if len(slow.C) != Buffer || len(other.C) != 0 {
		t.Fatalf("buffered %d, other %d", len(slow.C), len(other.C))
	}
	b.Publish("team", Event{Seq: 999}) // a dropped subscriber gets nothing more
	if len(slow.C) != Buffer {
		t.Fatal("published to a dropped subscriber")
	}
	b.Unsubscribe(slow) // harmless after a drop
	b.Close()
	b.Close()
	<-b.Done()
}
