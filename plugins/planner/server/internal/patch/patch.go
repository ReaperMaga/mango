// Package patch applies field-level patches to JSON documents, exactly as applyPatch in
// plugins/planner/src/patch.ts does.
//
// Documents are decoded with json.Decoder.UseNumber, so they are made of map[string]any, []any, string,
// json.Number, bool and nil.
//
// Paths alternate: containers (`views`, `options`) at even depths and the entries in them by id at odd depths.
// A container that is not there yet is made, an entry never is: that would bring back half of what someone
// else deleted.
package patch

// Op sets the field at Path to Value, or removes it when Remove is set (the value was left out).
// A Value of nil with Remove unset sets the field to JSON null.
type Op struct {
	Path   []string
	Value  any
	Remove bool
}

// IsSafeKey reports whether a key may come out of a document: keys that could reach an object's prototype
// in JavaScript never do.
func IsSafeKey(key string) bool {
	return key != "" && key != "__proto__" && key != "constructor" && key != "prototype"
}

// EntriesByID reads a list of objects with a string `id` as an object by id (later wins). Elements that are
// not objects with a safe string id are dropped.
func EntriesByID(list []any) map[string]any {
	out := make(map[string]any, len(list))
	for _, e := range list {
		if o, ok := e.(map[string]any); ok {
			if id, ok := o["id"].(string); ok && IsSafeKey(id) {
				out[id] = o
			}
		}
	}
	return out
}

// Apply returns a copy of doc with the patch applied. doc itself is not changed.
func Apply(doc map[string]any, ops []Op) map[string]any {
	out, _ := deepCopy(doc).(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	for _, op := range ops {
		if len(op.Path) == 0 || !allSafe(op.Path) {
			continue
		}
		if applies(out, op) {
			apply(out, op)
		}
	}
	return out
}

func allSafe(path []string) bool {
	for _, k := range path {
		if !IsSafeKey(k) {
			return false
		}
	}
	return true
}

// child is what setAt's childObject sees at parent[key]: an object, an array read as entries, or nothing.
func child(parent map[string]any, key string) (map[string]any, bool) {
	switch v := parent[key].(type) {
	case map[string]any:
		return v, true
	case []any:
		return EntriesByID(v), true
	}
	return nil, false
}

// applies walks the path without changing anything and reports whether the op does something. In the
// reference, an op that finds no way through returns null and the document stays as it was, arrays included.
func applies(doc map[string]any, op Op) bool {
	at := doc
	last := len(op.Path) - 1
	for depth := 0; depth < last; depth++ {
		next, ok := child(at, op.Path[depth])
		if !ok {
			isEntry := depth%2 == 1
			if isEntry || op.Remove {
				return false
			}
			// A new container is empty, so the entry after it is missing unless it is the last key.
			return depth+1 == last
		}
		at = next
	}
	return true
}

// apply changes doc in place along a path that applies. doc is the private copy made by Apply, so every
// object on the way may be changed; arrays met on the way are stored as the objects they were read as.
func apply(doc map[string]any, op Op) {
	at := doc
	last := len(op.Path) - 1
	for depth := 0; depth < last; depth++ {
		key := op.Path[depth]
		next, ok := child(at, key)
		if !ok {
			next = map[string]any{}
		}
		if _, isObject := at[key].(map[string]any); !isObject {
			at[key] = next
		}
		at = next
	}
	key := op.Path[last]
	if op.Remove {
		delete(at, key)
	} else {
		// A copy: a later op may walk into it and change it in place, and op belongs to the caller.
		at[key] = deepCopy(op.Value)
	}
}

func deepCopy(v any) any {
	switch v := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, e := range v {
			out[k] = deepCopy(e)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, e := range v {
			out[i] = deepCopy(e)
		}
		return out
	}
	return v
}
