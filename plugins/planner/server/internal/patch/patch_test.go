package patch

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func parse(t *testing.T, s string) any {
	t.Helper()
	d := json.NewDecoder(strings.NewReader(s))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		t.Fatalf("parse %s: %v", s, err)
	}
	return v
}

func encode(t *testing.T, v any) string {
	t.Helper()
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(b.String())
}

func set(t *testing.T, value string, path ...string) Op {
	return Op{Path: path, Value: parse(t, value)}
}

func remove(path ...string) Op { return Op{Path: path, Remove: true} }

func TestApply(t *testing.T) {
	tests := []struct {
		name string
		doc  string
		ops  []Op
		want string
	}{
		{"set a field", `{}`, []Op{set(t, `1`, "a")}, `{"a":1}`},
		{"replace a field", `{"a":{"b":1}}`, []Op{set(t, `"x"`, "a")}, `{"a":"x"}`},
		{"remove a field", `{"a":1,"b":2}`, []Op{remove("a")}, `{"b":2}`},
		{"remove a missing field", `{"b":2}`, []Op{remove("a")}, `{"b":2}`},
		{"null sets null", `{"a":1}`, []Op{set(t, `null`, "a")}, `{"a":null}`},
		{"a missing container is made", `{}`, []Op{set(t, `{"name":"A"}`, "views", "v1")}, `{"views":{"v1":{"name":"A"}}}`},
		{"a missing entry is never made", `{}`, []Op{set(t, `"B"`, "views", "v1", "name")}, `{}`},
		{"a missing entry in a container", `{"views":{}}`, []Op{set(t, `"B"`, "views", "v1", "name")}, `{"views":{}}`},
		{"a field of an entry", `{"views":{"v1":{"name":"A","k":1}}}`, []Op{set(t, `"B"`, "views", "v1", "name")}, `{"views":{"v1":{"k":1,"name":"B"}}}`},
		{"removing makes no container", `{}`, []Op{remove("views", "v1")}, `{}`},
		{"removing an entry", `{"views":{"v1":{},"v2":{}}}`, []Op{remove("views", "v1")}, `{"views":{"v2":{}}}`},
		{"removing in a missing entry", `{"views":{}}`, []Op{remove("views", "v1", "name")}, `{"views":{}}`},
		{"a container inside an entry is made", `{"props":{"p1":{}}}`, []Op{set(t, `{"label":"x"}`, "props", "p1", "options", "o1")}, `{"props":{"p1":{"options":{"o1":{"label":"x"}}}}}`},
		{"a container that is not the last but one is never made", `{"props":{"p1":{}}}`, []Op{set(t, `"x"`, "props", "p1", "options", "o1", "label")}, `{"props":{"p1":{}}}`},
		{"a scalar container counts as missing", `{"views":"x"}`, []Op{set(t, `1`, "views", "v1")}, `{"views":{"v1":1}}`},
		{"a scalar entry counts as missing", `{"views":{"v1":5}}`, []Op{set(t, `1`, "views", "v1", "name")}, `{"views":{"v1":5}}`},
		{"a null entry counts as missing", `{"views":{"v1":null}}`, []Op{set(t, `1`, "views", "v1", "name")}, `{"views":{"v1":null}}`},
		{
			"an array is read as entries and stored as an object",
			`{"views":[{"id":"a","n":1},{"id":"b"},{"id":"a","n":2},3,null,{"id":"__proto__"},{"id":""},{"id":5},{"n":1}]}`,
			[]Op{set(t, `7`, "views", "b", "n")},
			`{"views":{"a":{"id":"a","n":2},"b":{"id":"b","n":7}}}`,
		},
		{"an array at an entry's container", `{"v":{"e":{"c":[{"id":"k"}]}}}`, []Op{set(t, `1`, "v", "e", "c", "k", "x")}, `{"v":{"e":{"c":{"k":{"id":"k","x":1}}}}}`},
		{"an array is replaced when it is the last key", `{"views":[{"id":"a"}]}`, []Op{set(t, `{}`, "views")}, `{"views":{}}`},
		{"an op that does nothing leaves an array as it was", `{"views":[{"id":"a"}]}`, []Op{set(t, `1`, "views", "x", "n")}, `{"views":[{"id":"a"}]}`},
		{"removing through an array", `{"views":[{"id":"a"},{"id":"b"}]}`, []Op{remove("views", "a")}, `{"views":{"b":{"id":"b"}}}`},
		{"an empty path does nothing", `{"a":1}`, []Op{{Path: nil, Value: "x"}, {Path: []string{}, Remove: true}}, `{"a":1}`},
		{"unsafe keys do nothing", `{"a":{"b":{}}}`, []Op{
			set(t, `1`, "__proto__"), set(t, `1`, "constructor"), set(t, `1`, "prototype"), set(t, `1`, ""),
			set(t, `1`, "a", "b", "__proto__"), remove("a", ""),
		}, `{"a":{"b":{}}}`},
		{"ops apply in order", `{}`, []Op{set(t, `{}`, "views", "v1"), set(t, `"x"`, "views", "v1", "name"), remove("views", "v1", "gone")}, `{"views":{"v1":{"name":"x"}}}`},
		{"a later op changes a value an earlier one set", `{}`, []Op{set(t, `{"v1":{"a":1}}`, "views"), set(t, `2`, "views", "v1", "a")}, `{"views":{"v1":{"a":2}}}`},
		{"numbers keep their digits", `{"big":12345678901234567890123}`, []Op{set(t, `0.10000000000000000000001`, "f"), set(t, `-1e400`, "e")}, `{"big":12345678901234567890123,"e":-1e400,"f":0.10000000000000000000001}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc := parse(t, tt.doc).(map[string]any)
			before := encode(t, doc)
			got := encode(t, Apply(doc, tt.ops))
			if got != encode(t, parse(t, tt.want)) {
				t.Errorf("got  %s\nwant %s", got, tt.want)
			}
			if encode(t, doc) != before {
				t.Errorf("the input changed: %s", encode(t, doc))
			}
		})
	}
}

func TestApplyDoesNotShareValues(t *testing.T) {
	value := parse(t, `{"v1":{"a":1}}`)
	ops := []Op{{Path: []string{"views"}, Value: value}, set(t, `2`, "views", "v1", "a")}
	Apply(map[string]any{}, ops)
	if got := encode(t, value); got != `{"v1":{"a":1}}` {
		t.Errorf("the op's value changed: %s", got)
	}
}
