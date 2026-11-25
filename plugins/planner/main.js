/* Built from src/ by `pnpm plugins:build`. Do not edit. ccc655272c92930e5a8df74b4751c0e3 */

let active = null

/** The bundle, with Vue from Mango. */
function load(__vue) {
var __plugin = (function(exports, vue) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	// plugins/planner/src/patch.ts
	var UNSAFE = /* @__PURE__ */ new Set([
		"__proto__",
		"constructor",
		"prototype"
	]);
	function isObject(v) {
		return typeof v === "object" && v !== null && !Array.isArray(v);
	}
	/** Keys that could reach an object's prototype never come out of a document. */
	var isSafeKey = (key) => key !== "" && !UNSAFE.has(key);
	/** Entries by id. Also reads a list of `{ id }` objects, should another writer have stored one. */
	function entriesById(v) {
		if (Array.isArray(v)) {
			const out = /* @__PURE__ */ new Map();
			for (const e of v) if (isObject(e) && typeof e.id === "string" && isSafeKey(e.id)) out.set(e.id, e);
			return [...out];
		}
		if (!isObject(v)) return [];
		return Object.entries(v).filter((e) => isSafeKey(e[0]) && isObject(e[1]));
	}
	function childObject(parent, key) {
		const v = Object.hasOwn(parent, key) ? parent[key] : void 0;
		if (isObject(v)) return { ...v };
		if (Array.isArray(v)) return Object.fromEntries(entriesById(v));
		return null;
	}
	/**
	* The document with the patch applied (a copy; untouched parts are shared). A path into an entry that is gone
	* (`['views', 'deleted', 'name']`) does nothing: an edit never brings back half of what someone else deleted.
	*/
	function applyPatch(doc, patch) {
		const out = { ...doc };
		for (const op of patch) {
			if (!op.path.length || !op.path.every(isSafeKey)) continue;
			let at = out;
			let ok = true;
			for (let i = 0; i < op.path.length - 1; i++) {
				const key = op.path[i];
				const next = childObject(at, key);
				if (!next && (i === 1 || op.value === void 0)) {
					ok = false;
					break;
				}
				at = at[key] = next ?? {};
			}
			if (!ok) continue;
			const last = op.path[op.path.length - 1];
			if (op.value === void 0) delete at[last];
			else at[last] = op.value;
		}
		return out;
	}
	function readPath(doc, path) {
		let at = doc;
		for (const key of path) {
			const o = isObject(at) ? at : Array.isArray(at) ? Object.fromEntries(entriesById(at)) : null;
			if (!o || !Object.hasOwn(o, key)) return void 0;
			at = o[key];
		}
		return at;
	}
	/** The patch that takes `applyPatch(doc, patch)` back to `doc`, touching only the same fields. */
	function invertPatch(doc, patch) {
		const inverse = [];
		let at = doc;
		for (const op of patch) {
			const value = readPath(at, op.path);
			inverse.unshift(value === void 0 ? { path: op.path } : {
				path: op.path,
				value
			});
			at = applyPatch(at, [op]);
		}
		return inverse;
	}
	// plugins/planner/src/context.ts
	/** What every component of the planner gets: Mango, the store, and where in the planner it is. */
	/** The tab view's id, and the key of its one tab per project. */
	var VIEW_ID = "planner";
	var TAB_KEY = "main";
	var PLANNER = Symbol("planner");
	/** A tab's state as a route, whatever an older version kept there. */
	function readRoute(state) {
		if (!isObject(state)) return null;
		const text = (v) => typeof v === "string" && v ? v : void 0;
		return {
			collectionId: text(state.collectionId) ?? null,
			viewId: text(state.viewId),
			itemId: text(state.itemId)
		};
	}
	// plugins/planner/src/strings.ts
	var strings$1 = {
		planner: "Planner",
		noProject: "Open a project first",
		untitled: "Untitled",
		undo: "Undo",
		redo: "Redo",
		commands: {
			open: "Open planner",
			newItem: "New item…",
			newCollection: "New collection…",
			addThread: "Add to planner"
		},
		collection: "Collection",
		newItemPrompt: "What is it?",
		newItemIn: (name) => `New item in ${name}`,
		newCollection: "New collection",
		chooseCollection: "Add to which collection?",
		noCollections: "No collections yet",
		noCollectionsBody: "Make one from a template to get started.",
		noCollectionsForItem: "There is no collection to add to yet. Make one in the planner first.",
		itemAdded: (name) => `Added to ${name}`,
		show: "Show",
		itemCount: (n) => n === 1 ? "1 item" : `${n} items`,
		noGroup: (property) => `No ${property.toLowerCase()}`,
		checked: "Checked",
		unchecked: "Not checked",
		loading: "Loading…",
		loadFailed: "The planner could not be read",
		saveFailed: "The change was not saved",
		readonly: "This can only be read right now",
		gone: "It was deleted somewhere else, so the change was left out.",
		retry: "Try again",
		valuesLost: (n) => `${n === 1 ? "1 value" : `${n} values`} could not be carried over`,
		importEmpty: "There is nothing to import in that file.",
		/** What an undo entry is called ("Undo delete item"). */
		did: {
			createItem: "new item",
			editItem: "edit",
			moveItem: "move",
			deleteItems: (n) => n === 1 ? "delete item" : `delete ${n} items`,
			duplicate: "duplicate",
			createCollection: "new collection",
			editCollection: "edit collection",
			deleteCollection: "delete collection",
			editProperty: "edit property",
			deleteProperty: "delete property",
			editOption: "edit option",
			deleteOption: "delete option",
			editView: "edit view",
			deleteView: "delete view",
			import: "import",
			linkChat: "link chat"
		},
		deletedItems: (n) => n === 1 ? "Item deleted" : `${n} items deleted`,
		deletedCollection: (name) => `${name || "Collection"} deleted`,
		deletedProperty: (name) => `${name || "Property"} deleted`,
		deletedOption: (name) => `${name || "Option"} deleted`,
		deletedView: (name) => `${name || "View"} deleted`,
		copyOf: (name) => `${name || "Untitled"} (copy)`,
		propertyTypes: {
			text: "Text",
			number: "Number",
			select: "Select",
			multiSelect: "Multi-select",
			date: "Date",
			checkbox: "Checkbox",
			url: "Link",
			createdTime: "Created",
			updatedTime: "Last edited",
			unsupported: "Unsupported"
		},
		operators: {
			contains: "contains",
			notContains: "does not contain",
			is: "is",
			isNot: "is not",
			startsWith: "starts with",
			endsWith: "ends with",
			eq: "=",
			neq: "≠",
			gt: ">",
			gte: "≥",
			lt: "<",
			lte: "≤",
			before: "is before",
			after: "is after",
			onOrBefore: "is on or before",
			onOrAfter: "is on or after",
			today: "is today",
			overdue: "is in the past",
			nextDays: "is in the next (days)",
			pastDays: "is in the past (days)",
			isEmpty: "is empty",
			isNotEmpty: "is not empty"
		},
		templates: {
			tasks: {
				name: "Tasks",
				description: "Work on a board, with a status, a priority and a due date."
			},
			bugs: {
				name: "Bugs",
				description: "Reports with a severity and a status, from new to fixed."
			},
			notes: {
				name: "Notes",
				description: "Pages with tags, in a plain list."
			},
			empty: {
				name: "Empty",
				description: "A table with nothing in it yet."
			}
		},
		template: {
			board: "Board",
			table: "Table",
			status: "Status",
			priority: "Priority",
			due: "Due",
			severity: "Severity",
			tags: "Tags",
			link: "Link",
			toDo: "To do",
			inProgress: "In progress",
			done: "Done",
			high: "High",
			medium: "Medium",
			low: "Low",
			critical: "Critical",
			major: "Major",
			minor: "Minor",
			new: "New",
			confirmed: "Confirmed",
			fixing: "Fixing",
			fixed: "Fixed",
			edited: "Edited"
		}
	};
	// plugins/planner/src/order.ts
	/**
	* Positions as short strings ("fractional indexing"): a new position between two others is a new key, so moving
	* one thing writes one thing. Keys are read as base-62 fractions and compare as plain strings.
	*
	* Two writers may make the same key, and data from elsewhere may hold anything: ties are broken by id
	* (`compareOrder`), and `between` answers null when nothing fits, which is when the caller re-spaces (`spread`).
	*/
	var DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	var BASE = 62;
	/** Adding at either end counts up or down in this many digits, so keys stay short however much is added. */
	var WIDTH = 5;
	var CAPACITY = BASE ** WIDTH;
	var MAX_LENGTH = 200;
	/** A key is usable when it is base-62 and does not end in 0 (nothing fits between `a` and `a0`). */
	function isKey(key) {
		return typeof key === "string" && key.length <= MAX_LENGTH && /^[0-9A-Za-z]*[1-9A-Za-z]$/.test(key);
	}
	function toNumber(key) {
		let n = 0;
		for (let i = 0; i < WIDTH; i++) n = n * BASE + (i < key.length ? DIGITS.indexOf(key[i]) : 0);
		return n;
	}
	function fromNumber(n) {
		let s = "";
		for (let i = 0; i < WIDTH; i++) {
			s = DIGITS[n % BASE] + s;
			n = Math.floor(n / BASE);
		}
		return s;
	}
	/** The midpoint of two fractions; `b` null is 1. Requires a < b. */
	function midpoint(a, b) {
		let prefix = "";
		for (let i = 0;; i++) {
			const x = i < a.length ? DIGITS.indexOf(a[i]) : 0;
			const y = b === null ? BASE : i < b.length ? DIGITS.indexOf(b[i]) : 0;
			if (x === y) {
				prefix += DIGITS[x];
				continue;
			}
			if (y - x > 1) return prefix + DIGITS[Math.floor((x + y) / 2)];
			prefix += DIGITS[x];
			b = null;
		}
	}
	/**
	* A key after `a` and before `b` (null: no limit on that side). Null when there is none: the keys are equal, out
	* of order, or not keys at all.
	*/
	function between(a, b) {
		if (a !== null && !isKey(a)) return null;
		if (b !== null && !isKey(b)) return null;
		let key;
		if (a === null && b === null) key = fromNumber(Math.floor(CAPACITY / 2) + 1);
		else if (b === null) {
			let n = toNumber(a) + 1;
			if (n % BASE === 0) n++;
			key = n < CAPACITY ? fromNumber(n) : midpoint(a, null);
		} else if (a === null) {
			let n = toNumber(b) - 1;
			if (n % BASE === 0) n--;
			key = n > 0 ? fromNumber(n) : midpoint("", b);
		} else if (a < b) key = midpoint(a, b);
		else return null;
		return isKey(key) ? key : null;
	}
	/** `n` keys in order, evenly spaced with room on both sides. */
	function spread(n) {
		const step = Math.max(2, Math.floor(CAPACITY / (n + 1)));
		return Array.from({ length: n }, (_, i) => {
			const at = step * (i + 1);
			return fromNumber(at % BASE === 0 ? at + 1 : at);
		});
	}
	/** `n` keys after `a` and before `b`, or null when they do not fit. */
	function manyBetween(a, b, n) {
		if (a !== null && b !== null && !(a < b)) return null;
		const out = [];
		const down = a === null && b !== null;
		let edge = down ? b : a;
		for (let i = 0; i < n; i++) {
			const key = down ? between(null, edge) : between(edge, b);
			if (key === null) return null;
			out.push(key);
			edge = key;
		}
		return down ? out.reverse() : out;
	}
	function compareOrder(a, b) {
		if (a.order !== b.order) return a.order < b.order ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	}
	/**
	* The keys that put `ids` (in this sequence) at `position` among `list`. Usually only theirs; when the keys
	* around that place leave no room, the whole list's. An unknown neighbour counts as the end.
	*/
	function placeAt(list, ids, position) {
		const moving = new Set(ids);
		const rest = list.filter((e) => !moving.has(e.id)).sort(compareOrder);
		let index = rest.length;
		if (position === "start") index = 0;
		else if (position !== "end") {
			const at = rest.findIndex((e) => e.id === ("before" in position ? position.before : position.after));
			if (at >= 0) index = "before" in position ? at : at + 1;
		}
		const keys = manyBetween(rest[index - 1]?.order ?? null, rest[index]?.order ?? null, ids.length);
		if (keys) return new Map(ids.map((id, i) => [id, keys[i]]));
		const all = [
			...rest.slice(0, index).map((e) => e.id),
			...ids,
			...rest.slice(index).map((e) => e.id)
		];
		const fresh = spread(all.length);
		return new Map(all.map((id, i) => [id, fresh[i]]));
	}
	// plugins/planner/src/model.ts
	/**
	* What the planner works with: collections of items with typed properties, seen through views.
	*
	* Two shapes of everything. The *stored* document is plain JSON that any version or a remote may have written;
	* changes are made to it as patches, so fields this version does not know stay. The *model* below is what the
	* UI reads: normalised from the stored document, complete and safe, and never written back. Treat it as
	* immutable: every change makes new objects and goes through the store.
	*/
	/** Named, so the UI maps them to design tokens and both themes work. */
	var COLORS = [
		"neutral",
		"blue",
		"green",
		"yellow",
		"orange",
		"red",
		"purple",
		"pink"
	];
	var PROPERTY_TYPES = [
		"text",
		"number",
		"select",
		"multiSelect",
		"date",
		"checkbox",
		"url",
		"createdTime",
		"updatedTime"
	];
	/** The property id of an item's title, in sorts, filters and column widths. */
	var TITLE = "title";
	function newId() {
		return globalThis.crypto.randomUUID();
	}
	var str = (v, fallback = "") => typeof v === "string" ? v : fallback;
	var num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
	var oneOf = (all, v, fallback) => all.includes(v) ? v : fallback;
	var strings = (v) => Array.isArray(v) ? [...new Set(v.filter((e) => typeof e === "string"))] : [];
	var ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
	var iconName = (v) => typeof v === "string" && v.length <= 64 && ICON_NAME.test(v) ? v : null;
	/** Sorted by `order`; entries without a usable one go last, as they came. */
	function ordered(list) {
		const bad = list.filter((e) => !isKey(e.order));
		const good = list.filter((e) => isKey(e.order)).sort(compareOrder);
		if (!bad.length) return good;
		return [...good, ...bad.map((e, i) => ({
			...e,
			order: `zzzz${spread(bad.length)[i]}`
		}))];
	}
	/** Colours in turn, for new options. */
	var colorAt = (i) => COLORS[1 + i % (COLORS.length - 1)];
	var DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
	function isDateString(v) {
		const m = typeof v === "string" ? DATE.exec(v) : null;
		if (!m) return false;
		const [y, mo, d] = [
			+m[1],
			+m[2],
			+m[3]
		];
		const date = new Date(Date.UTC(y, mo - 1, d));
		if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false;
		return m[4] === void 0 || +m[4] < 24 && +m[5] < 60;
	}
	var two = (n) => String(n).padStart(2, "0");
	/** Local date of a moment: `2026-03-01`. */
	function localDate(ms) {
		const d = new Date(ms);
		return `${String(d.getFullYear()).padStart(4, "0")}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
	}
	/** Local date and time of a moment: `2026-03-01T09:30`. */
	function localDateTime(ms) {
		const d = new Date(ms);
		return `${localDate(ms)}T${two(d.getHours())}:${two(d.getMinutes())}`;
	}
	/** Text a person may have written as a date, or null. ISO forms only: anything else is a guess. */
	function parseDate(text) {
		const [a, b, more] = text.trim().split(/\s*(?:\/|→|\s+to\s+)\s*/);
		const read = (s) => {
			const t = s?.trim().replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/, "$1T$2");
			return isDateString(t) ? t : null;
		};
		if (more !== void 0) return null;
		const start = read(a);
		if (!start) return null;
		if (b === void 0) return { start };
		const end = read(b);
		return end && end >= start ? {
			start,
			end
		} : null;
	}
	var formatDate = (d) => d.end ? `${d.start} to ${d.end}` : d.start;
	function normalizeOption(id, raw) {
		return {
			id,
			name: str(raw.name),
			color: oneOf(COLORS, raw.color, "neutral"),
			order: str(raw.order)
		};
	}
	function normalizeProperty(id, raw) {
		return {
			id,
			name: str(raw.name),
			type: oneOf(PROPERTY_TYPES, raw.type, "unsupported"),
			order: str(raw.order),
			options: ordered(entriesById(raw.options).map(([k, v]) => normalizeOption(k, v)))
		};
	}
	var isGroupable = (p) => p.type === "select" || p.type === "multiSelect" || p.type === "checkbox";
	var hasOptions = (p) => p.type === "select" || p.type === "multiSelect";
	/** Filled in by the planner, never by the user. */
	var isReadonly = (p) => p.type === "createdTime" || p.type === "updatedTime" || p.type === "unsupported";
	var COMMON = ["isEmpty", "isNotEmpty"];
	var TEXT_OPERATORS = [
		"contains",
		"notContains",
		"is",
		"isNot",
		"startsWith",
		"endsWith",
		...COMMON
	];
	var DATE_OPERATORS = [
		"is",
		"before",
		"after",
		"onOrBefore",
		"onOrAfter",
		"today",
		"overdue",
		"nextDays",
		"pastDays",
		...COMMON
	];
	/** The operators a filter on this property offers, the usual one first. */
	function operatorsFor(type) {
		switch (type) {
			case "number": return [
				"eq",
				"neq",
				"gt",
				"gte",
				"lt",
				"lte",
				...COMMON
			];
			case "select": return [
				"is",
				"isNot",
				...COMMON
			];
			case "multiSelect": return [
				"contains",
				"notContains",
				...COMMON
			];
			case "date": return DATE_OPERATORS;
			case "createdTime":
			case "updatedTime": return DATE_OPERATORS.filter((o) => o !== "overdue" && !COMMON.includes(o));
			case "checkbox": return ["is"];
			case "unsupported": return COMMON;
			default: return TEXT_OPERATORS;
		}
	}
	/** Operators that need no value. */
	var isUnary = (op) => op === "isEmpty" || op === "isNotEmpty" || op === "today" || op === "overdue";
	/** What kind of value a condition takes. */
	function conditionValueKind(type, op) {
		if (isUnary(op)) return "none";
		if (op === "nextDays" || op === "pastDays" || type === "number") return "number";
		if (type === "select" || type === "multiSelect") return "options";
		if (type === "date" || type === "createdTime" || type === "updatedTime") return "date";
		return type === "checkbox" ? "checkbox" : "text";
	}
	function normalizeCondition(raw, properties) {
		if (!isObject(raw)) return null;
		const propertyId = str(raw.propertyId);
		const property = properties.get(propertyId);
		if (!property && propertyId !== "title") return null;
		const type = property?.type ?? "title";
		const operator = raw.operator;
		if (!operatorsFor(type).includes(operator)) return null;
		const v = raw.value;
		let value = null;
		switch (conditionValueKind(type, operator)) {
			case "text":
				value = typeof v === "string" ? v : null;
				break;
			case "number":
				value = typeof v === "number" && Number.isFinite(v) ? v : null;
				break;
			case "date":
				value = isDateString(v) ? v : null;
				break;
			case "checkbox":
				value = typeof v === "boolean" ? v : null;
				break;
			case "options": {
				const known = strings(v).filter((o) => property.options.some((e) => e.id === o));
				value = known.length ? known : null;
				break;
			}
		}
		return {
			id: str(raw.id) || newId(),
			propertyId,
			operator,
			value
		};
	}
	function normalizeView(id, raw, properties) {
		const byId = new Map(properties.map((p) => [p.id, p]));
		const type = oneOf(["board", "table"], raw.type, "table");
		let groupBy = str(raw.groupBy) || null;
		if (groupBy && !(byId.has(groupBy) && isGroupable(byId.get(groupBy)))) groupBy = null;
		if (!groupBy && type === "board") groupBy = (properties.find((p) => p.type === "select") ?? properties.find(isGroupable))?.id ?? null;
		const columns = [];
		const seen = /* @__PURE__ */ new Set();
		for (const c of Array.isArray(raw.columns) ? raw.columns : []) {
			if (!isObject(c)) continue;
			const propertyId = str(c.propertyId);
			if (!byId.has(propertyId) || seen.has(propertyId)) continue;
			seen.add(propertyId);
			columns.push({
				propertyId,
				visible: c.visible !== false
			});
		}
		for (const p of properties) if (!seen.has(p.id)) columns.push({
			propertyId: p.id,
			visible: type === "table"
		});
		const sorts = [];
		for (const s of Array.isArray(raw.sorts) ? raw.sorts : []) {
			if (!isObject(s)) continue;
			const propertyId = str(s.propertyId);
			if (propertyId !== "title" && !byId.has(propertyId) || sorts.some((e) => e.propertyId === propertyId)) continue;
			sorts.push({
				propertyId,
				direction: s.direction === "desc" ? "desc" : "asc"
			});
		}
		const filter = isObject(raw.filter) ? raw.filter : {};
		const widths = {};
		if (isObject(raw.widths)) {
			for (const [k, v] of Object.entries(raw.widths)) if (isSafeKey(k) && (k === "title" || byId.has(k))) widths[k] = Math.round(Math.min(1200, Math.max(60, num(v, 160))));
		}
		return {
			id,
			name: str(raw.name),
			type,
			order: str(raw.order),
			groupBy,
			hiddenGroups: strings(raw.hiddenGroups),
			collapsedGroups: strings(raw.collapsedGroups),
			sorts,
			filter: {
				match: filter.match === "or" ? "or" : "and",
				conditions: (Array.isArray(filter.conditions) ? filter.conditions : []).map((c) => normalizeCondition(c, byId)).filter((c) => c !== null)
			},
			columns,
			widths,
			cardPreview: oneOf(["none", "body"], raw.cardPreview, "none")
		};
	}
	function normalizeScope(raw) {
		return isObject(raw) && raw.kind === "project" && typeof raw.path === "string" && raw.path ? {
			kind: "project",
			path: raw.path
		} : { kind: "everywhere" };
	}
	/** The id of the table a collection without any view is shown with. */
	var FALLBACK_VIEW = "default";
	function normalizeCollection(raw, meta) {
		const r = isObject(raw) ? raw : {};
		const properties = ordered(entriesById(r.properties).filter(([id]) => id !== TITLE).map(([id, v]) => normalizeProperty(id, v)));
		let views = ordered(entriesById(r.views).map(([id, v]) => normalizeView(id, v, properties)));
		if (!views.length) views = [normalizeView(FALLBACK_VIEW, {
			name: "Table",
			type: "table",
			order: "V"
		}, properties)];
		return {
			id: meta.id,
			name: str(r.name),
			icon: iconName(r.icon) ?? "square-kanban",
			color: oneOf(COLORS, r.color, "neutral"),
			scope: normalizeScope(r.scope),
			order: str(r.order),
			properties,
			views,
			createdAt: num(r.createdAt, meta.createdAt),
			updatedAt: meta.updatedAt
		};
	}
	function normalizeItem(raw, meta, collectionId) {
		const r = isObject(raw) ? raw : {};
		const chats = isObject(r.chats) ? Object.entries(r.chats).filter(([id]) => isSafeKey(id)).sort((a, b) => num(a[1], 0) - num(b[1], 0)).map(([id]) => id) : strings(r.chats);
		return {
			id: meta.id,
			collectionId,
			title: str(r.title),
			icon: iconName(r.icon),
			values: isObject(r.values) ? Object.fromEntries(Object.entries(r.values).filter(([k]) => isSafeKey(k))) : {},
			body: str(r.body),
			order: str(r.order),
			chats,
			createdAt: num(r.createdAt, meta.createdAt),
			updatedAt: meta.updatedAt
		};
	}
	/** A stored value as this property understands it, or null (empty, or not one of its values). */
	function readValue(raw, property) {
		switch (property.type) {
			case "text":
			case "url": return typeof raw === "string" && raw !== "" ? raw : null;
			case "number": return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
			case "checkbox": return raw === true;
			case "select": return typeof raw === "string" && property.options.some((o) => o.id === raw) ? raw : null;
			case "multiSelect": {
				const known = strings(raw).filter((id) => property.options.some((o) => o.id === id));
				return known.length ? known : null;
			}
			case "date":
				if (!isObject(raw) || !isDateString(raw.start)) return null;
				return isDateString(raw.end) && raw.end >= raw.start ? {
					start: raw.start,
					end: raw.end
				} : { start: raw.start };
			default: return null;
		}
	}
	/** An item's value of a property, or null when it is empty. A checkbox is never empty. */
	function valueOf(item, property) {
		if (property.type === "createdTime") return { start: localDateTime(item.createdAt) };
		if (property.type === "updatedTime") return { start: localDateTime(item.updatedAt) };
		return readValue(item.values[property.id], property);
	}
	/** What is stored for a value: checked, and undefined (nothing) when it is empty or not a value of the property. */
	function storedValue(value, property) {
		if (value === null || isReadonly(property)) return void 0;
		const v = readValue(value, property);
		if (v === null || v === false) return void 0;
		return structuredClone(v);
	}
	/** A value as plain text: option names, dates, `Yes` / `No`. */
	function valueText(value, property) {
		if (value === null) return "";
		if (typeof value === "boolean") return value ? "Yes" : "No";
		if (typeof value === "number") return String(value);
		const name = (id) => property.options.find((o) => o.id === id)?.name ?? "";
		if (typeof value === "string") return property.type === "select" ? name(value) : value;
		if (Array.isArray(value)) return value.map(name).join(", ");
		return formatDate(value);
	}
	/** A web address that is safe to open (http or https), or null. A missing scheme means https. */
	function safeUrl(text) {
		const t = text.trim();
		if (!t) return null;
		try {
			const url = new URL(/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t) ? t : `https://${t}`);
			return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
		} catch {
			return null;
		}
	}
	/** The same folder however it is written: separators, a trailing one, the case of a Windows path. */
	function projectKey(path) {
		const p = path.replace(/\\/g, "/").replace(/(?<=.)\/+$/, "");
		return /^[a-z]:/i.test(p) || p.startsWith("//") && path.includes("\\") ? p.toLowerCase() : p;
	}
	/** Whether a collection shows while this project is open (null: no project). */
	function isInScope(scope, projectPath) {
		return scope.kind === "everywhere" || projectPath !== null && projectKey(scope.path) === projectKey(projectPath);
	}
	var propertyOf = (c, id) => c.properties.find((p) => p.id === id) ?? null;
	var viewOf = (c, id) => c.views.find((v) => v.id === id) ?? null;
	// plugins/planner/src/templates.ts
	/** What a new collection starts with. Nothing is made until the user picks one. */
	var t = strings$1.template;
	var SPECS = {
		tasks: {
			icon: "square-kanban",
			color: "blue",
			properties: [
				{
					key: "status",
					name: t.status,
					type: "select",
					options: [
						[t.toDo, "neutral"],
						[t.inProgress, "blue"],
						[t.done, "green"]
					]
				},
				{
					key: "priority",
					name: t.priority,
					type: "select",
					options: [
						[t.high, "red"],
						[t.medium, "yellow"],
						[t.low, "neutral"]
					]
				},
				{
					key: "due",
					name: t.due,
					type: "date"
				}
			],
			views: [{
				name: t.board,
				type: "board",
				groupBy: "status",
				show: ["priority", "due"]
			}, {
				name: t.table,
				type: "table",
				show: [
					"status",
					"priority",
					"due"
				]
			}]
		},
		bugs: {
			icon: "bug",
			color: "red",
			properties: [
				{
					key: "status",
					name: t.status,
					type: "select",
					options: [
						[t.new, "neutral"],
						[t.confirmed, "yellow"],
						[t.fixing, "blue"],
						[t.fixed, "green"]
					]
				},
				{
					key: "severity",
					name: t.severity,
					type: "select",
					options: [
						[t.critical, "red"],
						[t.major, "orange"],
						[t.minor, "neutral"]
					]
				},
				{
					key: "link",
					name: t.link,
					type: "url"
				}
			],
			views: [{
				name: t.board,
				type: "board",
				groupBy: "status",
				show: ["severity"]
			}, {
				name: t.table,
				type: "table",
				show: [
					"status",
					"severity",
					"link"
				],
				sorts: [["severity", "asc"]]
			}]
		},
		notes: {
			icon: "notebook-text",
			color: "yellow",
			properties: [{
				key: "tags",
				name: t.tags,
				type: "multiSelect"
			}, {
				key: "edited",
				name: t.edited,
				type: "updatedTime"
			}],
			views: [{
				name: t.table,
				type: "table",
				show: ["tags", "edited"],
				sorts: [["edited", "desc"]]
			}]
		},
		empty: {
			icon: "table-2",
			color: "neutral",
			properties: [],
			views: [{
				name: t.table,
				type: "table",
				show: []
			}]
		}
	};
	var TEMPLATES = Object.keys(SPECS).map((id) => ({
		id,
		...strings$1.templates[id],
		icon: SPECS[id].icon
	}));
	function propertyData(p) {
		const keys = spread(p.options?.length ?? 0);
		return {
			name: p.name,
			type: p.type,
			order: p.order,
			options: Object.fromEntries((p.options ?? []).map((o, i) => [o.id ?? newId(), {
				name: o.name,
				color: o.color ?? "neutral",
				order: keys[i]
			}]))
		};
	}
	function viewData(v, order) {
		return {
			name: v.name,
			type: v.type,
			order,
			groupBy: v.groupBy ?? null,
			hiddenGroups: [],
			collapsedGroups: [],
			sorts: (v.sorts ?? []).map((s) => ({ ...s })),
			filter: v.filter ? {
				match: v.filter.match,
				conditions: v.filter.conditions.map((c) => ({ ...c }))
			} : {
				match: "and",
				conditions: []
			},
			columns: (v.columns ?? []).map((c) => ({ ...c })),
			widths: {},
			cardPreview: "none"
		};
	}
	/** The stored properties and views of a new collection, with ids of its own. */
	function templateData(id) {
		const spec = SPECS[id];
		const ids = new Map(spec.properties.map((p) => [p.key, newId()]));
		const idOf = (key) => key === "title" ? TITLE : ids.get(key);
		const propertyKeys = spread(spec.properties.length);
		const viewKeys = spread(spec.views.length);
		return {
			icon: spec.icon,
			color: spec.color,
			properties: Object.fromEntries(spec.properties.map((p, i) => [idOf(p.key), propertyData({
				name: p.name,
				type: p.type,
				order: propertyKeys[i],
				options: p.options?.map(([name, color]) => ({
					name,
					color
				}))
			})])),
			views: Object.fromEntries(spec.views.map((v, i) => [newId(), viewData({
				name: v.name,
				type: v.type,
				groupBy: v.groupBy ? idOf(v.groupBy) : null,
				columns: [...v.show.map((k) => ({
					propertyId: idOf(k),
					visible: true
				})), ...spec.properties.filter((p) => !v.show.includes(p.key)).map((p) => ({
					propertyId: idOf(p.key),
					visible: false
				}))],
				sorts: v.sorts?.map(([p, direction]) => ({
					propertyId: idOf(p),
					direction
				}))
			}, viewKeys[i])]))
		};
	}
	// plugins/planner/src/App.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$1 = { class: "planner" };
	var _hoisted_2 = { key: 0 };
	var _hoisted_3 = { class: "planner__row" };
	var _hoisted_4 = { key: 0 };
	var _hoisted_5 = { key: 1 };
	var _hoisted_6 = { key: 2 };
	var _hoisted_7 = { class: "planner__row" };
	/** The planner's tab. A plain list for now. */
	var App_vue_vue_type_script_setup_true_lang_default = /*@__PURE__*/ (0, vue.defineComponent)({
		__name: "App",
		props: {
			mango: {},
			store: {},
			ctx: {}
		},
		setup(__props) {
			const props = __props;
			const { status, error, collections, collection: collectionOf } = props.store;
			const { Button } = props.mango.ui.components;
			const route = (0, vue.computed)(() => {
				const r = readRoute(props.ctx.state);
				if (r?.collectionId && collectionOf(r.collectionId)) return r;
				return { collectionId: (collections.value.find((c) => c.id === props.store.lastCollection()) ?? collections.value[0])?.id ?? null };
			});
			function go(next) {
				const elsewhere = next.collectionId !== void 0 && next.collectionId !== route.value.collectionId;
				props.ctx.setState({
					...elsewhere ? {} : route.value,
					...next
				});
			}
			(0, vue.provide)(PLANNER, {
				mango: props.mango,
				store: props.store,
				route,
				go
			});
			(0, vue.watchEffect)(() => {
				const id = readRoute(props.ctx.state)?.collectionId;
				if (id && collectionOf(id)) props.store.rememberCollection(id);
			});
			const collection = (0, vue.computed)(() => collectionOf(route.value.collectionId));
			const list = (0, vue.computed)(() => collection.value ? props.store.items(collection.value.id) : null);
			function create(template) {
				const made = props.store.createCollection({ template });
				if (made) go({ collectionId: made.id });
			}
			async function addItem() {
				if (!collection.value) return;
				const title = await props.mango.ui.prompt({ title: strings$1.newItemIn(collection.value.name) });
				if (title?.trim()) await props.store.createItem(collection.value.id, { title: title.trim() });
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$1, [
					(0, vue.unref)(status) === "error" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_2, [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).loadFailed) + ": " + (0, vue.toDisplayString)((0, vue.unref)(error)) + " ", 1), ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), { onClick: _cache[0] || (_cache[0] = ($event) => __props.store.load()) }, {
						default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).retry), 1)]),
						_: 1
					}))])) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("nav", _hoisted_3, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)((0, vue.unref)(collections), (c) => {
						return (0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							key: c.id,
							variant: "ghost",
							onClick: ($event) => go({ collectionId: c.id })
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)(c.name), 1)]),
							_: 2
						}, 1032, ["onClick"]);
					}), 128))]),
					collection.value && list.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [
						(0, vue.createElementVNode)("h2", null, (0, vue.toDisplayString)(collection.value.name), 1),
						list.value.status === "error" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_4, [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).loadFailed) + ": " + (0, vue.toDisplayString)(list.value.error) + " ", 1), ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), { onClick: _cache[1] || (_cache[1] = ($event) => __props.store.loadItems(collection.value.id)) }, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).retry), 1)]),
							_: 1
						}))])) : list.value.status !== "ready" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_5, (0, vue.toDisplayString)((0, vue.unref)(strings$1).loading), 1)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("ul", _hoisted_6, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(list.value.items, (i) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("li", { key: i.id }, (0, vue.toDisplayString)(i.title || (0, vue.unref)(strings$1).untitled), 1);
						}), 128))])),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), { onClick: addItem }, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).newItemIn(collection.value.name)), 1)]),
							_: 1
						}))
					], 64)) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("div", _hoisted_7, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)((0, vue.unref)(TEMPLATES), (t) => {
						return (0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							key: t.id,
							onClick: ($event) => create(t.id)
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).newCollection) + ": " + (0, vue.toDisplayString)(t.name), 1)]),
							_: 2
						}, 1032, ["onClick"]);
					}), 128))])
				]);
			};
		}
	});
	// \0plugin-vue:export-helper
	var _plugin_vue_export_helper_default = (sfc, props) => {
		const target = sfc.__vccOpts || sfc;
		for (const [key, val] of props) target[key] = val;
		return target;
	};
	// plugins/planner/src/App.vue
	var App_default = /*#__PURE__*/ _plugin_vue_export_helper_default(App_vue_vue_type_script_setup_true_lang_default, [["__scopeId", "data-v-7a7a37b1"]]);
	// plugins/planner/src/PickCollection.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1 = { class: "planner-pick" };
	// plugins/planner/src/PickCollection.vue
	var PickCollection_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PickCollection",
		props: {
			mango: {},
			collections: {}
		},
		emits: ["pick"],
		setup(__props, { emit: __emit }) {
			const emit = __emit;
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("ul", _hoisted_1, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(__props.collections, (c) => {
					return (0, vue.openBlock)(), (0, vue.createElementBlock)("li", { key: c.id }, [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)(__props.mango.ui.components.Button), {
						variant: "ghost",
						onClick: ($event) => emit("pick", c)
					}, {
						default: (0, vue.withCtx)(() => [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)(__props.mango.ui.components.Icon), { icon: c.icon }, null, 8, ["icon"])), (0, vue.createTextVNode)(" " + (0, vue.toDisplayString)(c.name), 1)]),
						_: 2
					}, 1032, ["onClick"]))]);
				}), 128))]);
			};
		}
	}), [["__scopeId", "data-v-d6073789"]]);
	// plugins/planner/src/convert.ts
	/** Changing a property's type: what becomes of its values, and the options that have to exist for them. */
	var TRUE = /* @__PURE__ */ new Set([
		"yes",
		"true",
		"1",
		"x",
		"done",
		"on",
		"checked",
		"✓"
	]);
	/** Numbers as people write them: `1,200.5`, `1 200`, `12%`, `$5`. Null when it is not one. */
	function parseNumber(text) {
		let t = text.trim().replace(/^[$€£]\s*|\s*[%$€£]$/g, "").replace(/[\s ']/g, "");
		if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replaceAll(",", "");
		else if (/^[+-]?\d+,\d+$/.test(t)) t = t.replace(",", ".");
		if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
		const n = Number(t);
		return Number.isFinite(n) ? n : null;
	}
	/** Finds or adds options by name, whatever its case. */
	var OptionSet = class {
		options;
		byName;
		constructor(existing) {
			this.options = [...existing];
			this.byName = new Map(existing.map((o) => [o.name.trim().toLowerCase(), o.id]));
		}
		idOf(name) {
			const key = name.trim().toLowerCase();
			let id = this.byName.get(key);
			if (!id) {
				id = newId();
				this.byName.set(key, id);
				const order = between(this.options.at(-1)?.order ?? null, null);
				this.options.push({
					id,
					name: name.trim(),
					color: colorAt(this.options.length),
					order: order ?? ""
				});
			}
			return id;
		}
		/** The options, the added ones after those there were; all re-spaced if an order was unusable. */
		list() {
			if (this.options.every((o) => o.order)) return this.options;
			const keys = spread(this.options.length);
			return this.options.map((o, i) => ({
				...o,
				order: keys[i]
			}));
		}
	};
	/** Text read as a value of a property's type, with options made as needed; null when it is not one. */
	function parseValue(text, type, options) {
		const t = text.trim();
		if (type === "checkbox") return TRUE.has(t.toLowerCase());
		if (!t) return null;
		switch (type) {
			case "text": return text;
			case "url": return t;
			case "number": return parseNumber(t);
			case "date": return parseDate(t);
			case "select": return options.idOf(t);
			case "multiSelect": {
				const names = t.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
				return names.length ? [...new Set(names.map((n) => options.idOf(n)))] : null;
			}
			default: return null;
		}
	}
	function convertProperty(property, type, items) {
		const options = new OptionSet(property.options);
		const values = /* @__PURE__ */ new Map();
		let lost = 0;
		for (const item of items) {
			const value = valueOf(item, property);
			if (value === null || value === false) {
				if (property.id in item.values) values.set(item.id, null);
				continue;
			}
			const next = convertValue(value, property, type, options);
			if (next === null || next === false) lost++;
			values.set(item.id, next);
		}
		return {
			property: {
				...property,
				type,
				options: options.list()
			},
			values,
			lost
		};
	}
	function convertValue(value, from, type, options) {
		if (type === "multiSelect" && from.type === "select") return [value];
		if (type === "select" && from.type === "multiSelect") return value[0] ?? null;
		if (type === "checkbox") return typeof value === "number" ? value !== 0 : parseValue(valueText(value, from), type, options);
		if (type === "number" && typeof value === "boolean") return 1;
		if (type === "date" && typeof value === "object" && !Array.isArray(value)) return value;
		return parseValue(typeof value === "object" && !Array.isArray(value) ? formatDate(value) : valueText(value, from), type, options);
	}
	// plugins/planner/src/csv.ts
	/** Collections as CSV and Markdown, and CSV read back. Pure functions; the store runs them. */
	/** What a spreadsheet would run as a formula. Such a cell gets a leading apostrophe, which reading takes off. */
	var FORMULA = /^\s*[=+\-@]|^[\t\r]/;
	var GUARDED = /^'(?=\s*[=+\-@]|[\t\r'])/;
	function csvCell(text, isNumber = false) {
		let t = text;
		if (!isNumber && (FORMULA.test(t) || GUARDED.test(t))) t = `'${t}`;
		return /[",\r\n;\t]|^\s|\s$/.test(t) ? `"${t.replaceAll("\"", "\"\"")}"` : t;
	}
	/** Rows of cells. Quotes, doubled quotes, line breaks in quotes; comma, semicolon or tab, whichever the first line uses. */
	function parseCsv(source) {
		const text = source.replace(/^﻿/, "");
		const delimiter = detectDelimiter(text);
		const rows = [];
		let row = [];
		let cell = "";
		let quoted = false;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (quoted) {
				if (c !== "\"") cell += c;
				else if (text[i + 1] === "\"") {
					cell += "\"";
					i++;
				} else quoted = false;
			} else if (c === "\"" && cell === "") quoted = true;
			else if (c === delimiter) {
				row.push(cell);
				cell = "";
			} else if (c === "\n" || c === "\r") {
				if (c === "\r" && text[i + 1] === "\n") i++;
				row.push(cell);
				rows.push(row);
				row = [];
				cell = "";
			} else cell += c;
		}
		if (cell !== "" || row.length) {
			row.push(cell);
			rows.push(row);
		}
		return rows.filter((r) => r.some((c) => c.trim() !== "")).map((r) => r.map((c) => c.replace(GUARDED, "")));
	}
	function detectDelimiter(text) {
		const counts = {
			",": 0,
			";": 0,
			"	": 0
		};
		let quoted = false;
		for (const c of text) if (c === "\"") quoted = !quoted;
		else if (!quoted && (c === "\n" || c === "\r")) break;
		else if (!quoted && c in counts) counts[c]++;
		return Object.entries(counts).reduce((best, e) => e[1] > best[1] ? e : best)[0];
	}
	/** Title, properties and body, one row per item; a UTF-8 mark in front so spreadsheets read it right. */
	function toCsv(collection, items, options = {}) {
		const properties = options.properties ?? collection.properties;
		return `﻿${[[
			options.titleLabel ?? "Title",
			...properties.map((p) => p.name),
			options.bodyLabel ?? "Body"
		].map((c) => csvCell(c)), ...items.map((item) => [
			csvCell(item.title),
			...properties.map((p) => csvCell(valueText(valueOf(item, p), p), p.type === "number")),
			csvCell(item.body)
		])].map((r) => r.join(",")).join("\r\n")}\r\n`;
	}
	var oneLine = (s) => s.replace(/\s+/g, " ").trim();
	/** Text that must not turn into Markdown of its own. */
	var escapeInline = (s) => oneLine(s).replace(/([\\`*_[\]<>#|])/g, "\\$1");
	/** One item as Markdown: a heading, its properties, its body. */
	function itemToMarkdown(collection, item, level = 1) {
		const lines = [`${"#".repeat(level)} ${escapeInline(item.title) || "Untitled"}`, ""];
		const props = collection.properties.map((p) => {
			const v = valueText(valueOf(item, p), p);
			const url = p.type === "url" ? safeUrl(v) : null;
			return v ? `- **${escapeInline(p.name)}:** ${url ? `<${url}>` : escapeInline(v)}` : "";
		}).filter(Boolean);
		if (props.length) lines.push(...props, "");
		if (item.body.trim()) lines.push(item.body.trim(), "");
		return lines.join("\n");
	}
	function toMarkdown(collection, items) {
		return [`# ${escapeInline(collection.name) || "Untitled"}\n`, ...items.map((i) => itemToMarkdown(collection, i, 2))].join("\n");
	}
	var TITLE_NAMES = /* @__PURE__ */ new Set([
		"title",
		"name",
		"task",
		"summary",
		"item"
	]);
	var BODY_NAMES = /* @__PURE__ */ new Set([
		"body",
		"notes",
		"description",
		"content"
	]);
	/** The type a column's texts look like; text when they disagree. */
	function inferType(texts) {
		const filled = texts.map((t) => t.trim()).filter(Boolean);
		if (!filled.length) return "text";
		if (filled.every((t) => /^(yes|no|true|false|x)$/i.test(t))) return "checkbox";
		if (filled.every((t) => parseNumber(t) !== null)) return "number";
		if (filled.every((t) => parseDate(t) !== null)) return "date";
		if (filled.every((t) => /^https?:\/\/\S+$/i.test(t))) return "url";
		const distinct = new Set(filled.map((t) => t.toLowerCase()));
		return filled.every((t) => t.length <= 40 && !t.includes("\n")) && distinct.size <= 12 && filled.length >= 3 && distinct.size <= filled.length / 2 ? "select" : "text";
	}
	/**
	* How rows (the first is the header) come into a collection: columns go to properties of the same name, others
	* become new ones of the type they look like. Nothing is dropped but values a typed property cannot hold.
	*/
	function planImport(rows, existing = []) {
		const [head, ...body] = rows;
		if (!head) return {
			properties: [],
			items: []
		};
		const names = head.map((h) => h.trim());
		const lower = names.map((n) => n.toLowerCase());
		const owned = new Set(existing.map((p) => p.name.trim().toLowerCase()));
		const titleAt = Math.max(0, lower.findIndex((n) => TITLE_NAMES.has(n) && !owned.has(n)));
		const bodyAt = lower.findIndex((n, i) => i !== titleAt && BODY_NAMES.has(n) && !owned.has(n));
		const used = /* @__PURE__ */ new Set();
		const changed = /* @__PURE__ */ new Map();
		let lastOrder = existing.at(-1)?.order ?? null;
		const fresh = spread(names.length);
		const columns = names.map((name, at) => {
			if (at === titleAt || at === bodyAt) return null;
			const texts = body.map((r) => r[at] ?? "");
			if (!name && texts.every((t) => !t.trim())) return null;
			let property = existing.find((p) => !used.has(p.id) && p.name.trim().toLowerCase() === lower[at]);
			if (!property) {
				lastOrder = between(lastOrder, null) ?? fresh[at];
				property = {
					id: newId(),
					name: name || `Column ${at + 1}`,
					type: inferType(texts),
					order: lastOrder,
					options: []
				};
				changed.set(property.id, property);
			}
			used.add(property.id);
			return {
				at,
				property,
				options: new OptionSet(property.options)
			};
		}).filter((c) => c !== null);
		const items = body.map((row) => {
			const values = {};
			for (const { at, property, options } of columns) {
				const v = parseValue(row[at] ?? "", property.type, options);
				if (v !== null && v !== false) values[property.id] = v;
			}
			return {
				title: oneLine(row[titleAt] ?? ""),
				body: bodyAt < 0 ? "" : row[bodyAt] ?? "",
				values
			};
		});
		for (const { property, options } of columns) if (hasOptions(property) && options.options.length > property.options.length) changed.set(property.id, {
			...property,
			options: options.list()
		});
		return {
			properties: [...changed.values()],
			items
		};
	}
	// plugins/planner/src/data/local.ts
	var COLLECTIONS = "collections";
	var ITEMS = "items_";
	var ATTEMPTS = 10;
	/** Documents in one write of the host's, which takes 2000. A larger write (a big import) is made in several. */
	var BATCH = 1500;
	var STATUS = {
		online: true,
		readonly: false
	};
	var nameOf = (a) => a.kind === "collection" ? COLLECTIONS : ITEMS + a.collectionId;
	var keyOf$1 = (collection, id) => `${collection}/${id}`;
	function toSourceDoc(doc) {
		const isCollection = doc.collection === COLLECTIONS;
		if (!isCollection && !doc.collection.startsWith(ITEMS)) return null;
		const data = doc.deleted || doc.data === null ? null : isObject(doc.data) ? doc.data : {};
		return {
			kind: isCollection ? "collection" : "item",
			id: doc.id,
			collectionId: isCollection ? doc.id : doc.collection.slice(6),
			seq: doc.seq,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
			data
		};
	}
	/** Split so that all changes to one document stay together. */
	function batches(ops) {
		if (ops.length <= BATCH) return [[...ops]];
		const byDoc = /* @__PURE__ */ new Map();
		for (const op of ops) {
			const key = keyOf$1(nameOf(op), op.id);
			byDoc.get(key)?.push(op) ?? byDoc.set(key, [op]);
		}
		const docs = [...byDoc.values()];
		return Array.from({ length: Math.ceil(docs.length / BATCH) }, (_, i) => docs.slice(i * BATCH, (i + 1) * BATCH).flat());
	}
	var isDoc = (d) => d !== null;
	/** The documents a refused write lists, however the error reached us. */
	function conflictsOf(error) {
		const list = error?.conflicts;
		return Array.isArray(list) ? list : null;
	}
	var LocalSource = class {
		label = "This computer";
		data;
		/** The newest of every document seen, tombstones too: its revision is what a patch is written against. */
		known = /* @__PURE__ */ new Map();
		handlers = /* @__PURE__ */ new Set();
		listening;
		constructor(data) {
			this.data = data;
			this.listening = data.onChange((change) => {
				change.docs.forEach((d) => this.see(d));
				const docs = change.docs.map(toSourceDoc).filter(isDoc);
				if (docs.length) for (const h of [...this.handlers]) h(docs);
			});
		}
		async loadCollections() {
			return this.list(COLLECTIONS);
		}
		async loadItems(collectionId) {
			return this.list(ITEMS + collectionId);
		}
		async write(ops) {
			const out = [];
			for (const batch of batches(ops)) out.push(...await this.writeBatch(batch));
			return out;
		}
		async writeBatch(ops) {
			for (let attempt = 1;; attempt++) {
				const { writes, keys } = await this.prepare(ops);
				try {
					(writes.length ? await this.data.write(writes) : []).forEach((d) => this.see(d));
					return keys.map((k) => this.known.get(k)).map((d) => d ? toSourceDoc(d) : null).filter(isDoc);
				} catch (e) {
					const conflicts = conflictsOf(e);
					if (!conflicts || attempt >= ATTEMPTS) throw e;
					for (const d of conflicts) this.known.set(keyOf$1(d.collection, d.id), d);
				}
			}
		}
		subscribe(handler) {
			this.handlers.add(handler);
			return () => {
				this.handlers.delete(handler);
			};
		}
		status() {
			return STATUS;
		}
		onStatus() {
			return () => {};
		}
		dispose() {
			this.listening.dispose();
			this.handlers.clear();
		}
		see(doc) {
			const key = keyOf$1(doc.collection, doc.id);
			const old = this.known.get(key);
			if (!old || old.seq <= doc.seq) this.known.set(key, doc);
		}
		async list(collection) {
			const docs = await this.data.list(collection);
			docs.forEach((d) => this.see(d));
			return docs.map(toSourceDoc).filter(isDoc);
		}
		/** One host write per document, from the newest copy of it. */
		async prepare(ops) {
			const work = /* @__PURE__ */ new Map();
			for (const op of ops) {
				const collection = nameOf(op);
				const key = keyOf$1(collection, op.id);
				let w = work.get(key);
				if (!w) {
					let before = this.known.get(key) ?? null;
					if (!before && op.op !== "create") {
						before = await this.data.get(collection, op.id);
						if (before) this.see(before);
					}
					const alive = before && !before.deleted && before.data !== null;
					w = {
						address: op,
						before,
						data: alive ? isObject(before.data) ? before.data : {} : null,
						touched: false,
						expect: true
					};
					work.set(key, w);
				}
				if (op.op === "create") {
					if (w.data !== null) throw new Error(`A document with the id ${op.id} exists already.`);
					w.data = op.data;
					w.touched = true;
				} else if (op.op === "delete") {
					w.expect = false;
					w.touched ||= w.data !== null;
					w.data = null;
				} else if (w.data !== null) {
					w.data = applyPatch(w.data, op.patch);
					w.touched = true;
				}
			}
			const writes = [];
			for (const { address, before, data, touched, expect } of work.values()) {
				if (!touched) continue;
				const at = {
					collection: nameOf(address),
					id: address.id
				};
				if (data === null) {
					if (before && !before.deleted) writes.push({
						op: "delete",
						...at
					});
				} else writes.push({
					op: "put",
					...at,
					data,
					...expect ? { expectedRev: before && !before.deleted ? before.rev : 0 } : {}
				});
			}
			return {
				writes,
				keys: [...work.keys()]
			};
		}
	};
	/** Whether a condition has all it needs to filter anything. */
	function isActive(c) {
		if (isUnary(c.operator)) return true;
		return c.value !== null && c.value !== "" && !(Array.isArray(c.value) && !c.value.length);
	}
	new Intl.Collator(void 0, {
		numeric: true,
		sensitivity: "base"
	});
	/** The value that puts an item into a group; for a multi-select, in place of group `from` when given. */
	function valueForGroup(p, key, item, from) {
		if (p.type === "checkbox") return key === "true";
		if (p.type !== "multiSelect") return key === "" ? null : key;
		if (key === "") return null;
		const value = item ? valueOf(item, p) : null;
		const now = Array.isArray(value) ? value : [];
		return from !== void 0 && now.includes(from) ? [...new Set(now.map((id) => id === from ? key : id))] : [...now.filter((id) => id !== key), key];
	}
	/**
	* Values that make a new item show up in a view: those of the group it is added to, and what the filter plainly
	* asks for (conditions that all must hold and name one value).
	*/
	function defaultValues(collection, view, group, now = Date.now()) {
		const out = {};
		if (view.filter.match === "and" || view.filter.conditions.filter(isActive).length === 1) for (const c of view.filter.conditions) {
			const p = propertyOf(collection, c.propertyId);
			if (!p || !isActive(c) || isReadonly(p) || p.id in out) continue;
			if (c.operator === "today") out[p.id] = { start: localDate(now) };
			else if (c.operator === "is" && p.type === "select") out[p.id] = c.value[0];
			else if (c.operator === "contains" && p.type === "multiSelect") out[p.id] = [c.value[0]];
			else if (c.operator === "is" && p.type === "checkbox") out[p.id] = c.value;
			else if (c.operator === "is" && p.type === "date") out[p.id] = { start: c.value };
			else if (c.operator === "is" && p.type === "text") out[p.id] = c.value;
			else if (c.operator === "eq") out[p.id] = c.value;
		}
		const groupBy = view.groupBy ? propertyOf(collection, view.groupBy) : null;
		if (groupBy && group !== void 0 && group !== null) {
			const v = valueForGroup(groupBy, group);
			if (v === null) delete out[groupBy.id];
			else out[groupBy.id] = v;
		}
		return out;
	}
	// plugins/planner/src/store.ts
	/**
	* The planner's state, made once per activation: reactive to read, and the only way to change anything.
	*
	* Every change is a list of source operations. It shows at once (an overlay on what the source last said), is
	* written in order, and is taken back with a toast when the write fails. Typed text (`defer`) is written after a
	* pause, and stays on screen when it cannot be saved. Destructive changes and edits can be undone.
	*
	* Models are immutable and replaced on change, so a `computed` over them is enough to follow everything.
	*/
	var DEFER_MS = 400;
	/** The same message is not shown again for this long. */
	var TOAST_REST_MS = 5e3;
	/** View settings that are only how it looks right now: not steps to undo. */
	var LAYOUT = /* @__PURE__ */ new Set(["collapsedGroups", "widths"]);
	var keyOf = (o) => `${o.kind}/${o.collectionId}/${o.id}`;
	var messageOf = (e) => e instanceof Error ? e.message : String(e);
	var json = (v) => JSON.parse(JSON.stringify(v));
	var samePath = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
	var collectionTarget = (id) => ({
		kind: "collection",
		id,
		collectionId: id
	});
	var itemTarget = (collectionId, id) => ({
		kind: "item",
		id,
		collectionId
	});
	function applyOps(data, ops) {
		let out = data;
		for (const op of ops) if (op.op === "create") out = op.data;
		else if (op.op === "delete") out = null;
		else if (out) out = applyPatch(out, op.patch);
		return out;
	}
	function createStore(mango, options = {}) {
		const source = options.source ?? new LocalSource(mango.data);
		const deferMs = options.deferMs ?? DEFER_MS;
		const status = (0, vue.ref)("idle");
		const error = (0, vue.ref)(null);
		const sourceStatus = (0, vue.shallowRef)(source.status());
		const projectPath = (0, vue.ref)(mango.workspace.activeProject());
		const now = (0, vue.ref)(Date.now());
		const saving = (0, vue.ref)(false);
		const allCollections = (0, vue.shallowRef)([]);
		const collections = (0, vue.computed)(() => allCollections.value.filter((c) => isInScope(c.scope, projectPath.value)));
		const undoStack = (0, vue.shallowRef)([]);
		const redoStack = (0, vue.shallowRef)([]);
		const entries = /* @__PURE__ */ new Map();
		const itemStates = /* @__PURE__ */ new Map();
		const itemModels = /* @__PURE__ */ new Map();
		const loadingItems = /* @__PURE__ */ new Map();
		let disposed = false;
		let deferred = null;
		let timer;
		/** Text that could not be written: still shown, and written again with the next change. */
		let unsaved = [];
		let chain = Promise.resolve();
		let writing = 0;
		const lastToasts = /* @__PURE__ */ new Map();
		function entryFor(o) {
			const key = keyOf(o);
			let e = entries.get(key);
			if (!e) entries.set(key, e = {
				kind: o.kind,
				id: o.id,
				collectionId: o.collectionId,
				base: null,
				pending: []
			});
			return e;
		}
		/** The stored document as it will be once everything is written. */
		function currentOf(e) {
			if (!e) return null;
			return e.pending.reduce((data, m) => applyOps(data, m.ops.filter((o) => o.kind === e.kind && o.id === e.id && o.collectionId === e.collectionId)), e.base?.data ?? null);
		}
		const rawCollection = (id) => currentOf(entries.get(keyOf(collectionTarget(id))));
		const rawItem = (collectionId, id) => currentOf(entries.get(keyOf(itemTarget(collectionId, id))));
		/** Rebuilds the models of these documents, and the lists they are in. */
		function publish(keys) {
			let collectionsChanged = false;
			const changedItems = /* @__PURE__ */ new Set();
			const list = new Map(allCollections.value.map((c) => [c.id, c]));
			for (const key of keys) {
				const e = entries.get(key);
				if (!e) continue;
				const data = currentOf(e);
				const at = e.pending.at(-1)?.at;
				const meta = {
					id: e.id,
					createdAt: e.base?.createdAt ?? at ?? 0,
					updatedAt: at ?? e.base?.updatedAt ?? 0
				};
				if (e.kind === "collection") {
					collectionsChanged = true;
					if (data) list.set(e.id, normalizeCollection(data, meta));
					else list.delete(e.id);
				} else {
					let models = itemModels.get(e.collectionId);
					if (!models) itemModels.set(e.collectionId, models = /* @__PURE__ */ new Map());
					if (data) models.set(e.id, normalizeItem(data, meta, e.collectionId));
					else models.delete(e.id);
					changedItems.add(e.collectionId);
				}
				if (!data && !e.base && !e.pending.length) entries.delete(key);
			}
			if (collectionsChanged) allCollections.value = ordered([...list.values()]);
			for (const id of changedItems) {
				const state = itemStates.get(id);
				if (state) state.items = ordered([...itemModels.get(id)?.values() ?? []]);
			}
		}
		/** Takes documents from the source; a newer one seen before stays. */
		function take(docs) {
			const changed = [];
			for (const doc of docs) {
				if (doc.kind === "item" && !itemStates.has(doc.collectionId)) continue;
				const e = entryFor(doc);
				if (e.base && e.base.seq > doc.seq) continue;
				e.base = doc;
				changed.push(keyOf(doc));
			}
			return changed;
		}
		async function load() {
			if (status.value === "loading") return;
			status.value = "loading";
			error.value = null;
			try {
				publish(take(await source.loadCollections()));
				status.value = "ready";
			} catch (e) {
				status.value = "error";
				error.value = messageOf(e);
				mango.log.error("Loading collections:", e);
			}
		}
		function stateOf(collectionId) {
			let s = itemStates.get(collectionId);
			if (!s) itemStates.set(collectionId, s = (0, vue.shallowReactive)({
				status: "idle",
				error: null,
				items: []
			}));
			return s;
		}
		function loadItems(collectionId) {
			const s = stateOf(collectionId);
			if (s.status === "ready") return Promise.resolve(true);
			let job = loadingItems.get(collectionId);
			if (!job) {
				job = (async () => {
					await Promise.resolve();
					s.status = "loading";
					s.error = null;
					try {
						publish(take(await source.loadItems(collectionId)));
						s.status = "ready";
						return true;
					} catch (e) {
						s.status = "error";
						s.error = messageOf(e);
						mango.log.error("Loading items:", e);
						return false;
					} finally {
						loadingItems.delete(collectionId);
					}
				})();
				loadingItems.set(collectionId, job);
			}
			return job;
		}
		function items(collectionId) {
			const s = stateOf(collectionId);
			if (s.status === "idle" && !disposed) loadItems(collectionId);
			return s;
		}
		/** Loads the items or says why not. */
		async function withItems(collectionId) {
			if (await loadItems(collectionId)) return stateOf(collectionId).items;
			toast(strings$1.loadFailed, stateOf(collectionId).error ?? "");
			return null;
		}
		const collection = (id) => allCollections.value.find((c) => c.id === id) ?? null;
		function item(collectionId, itemId) {
			return items(collectionId).items.find((i) => i.id === itemId) ?? null;
		}
		function toast(title, body, action) {
			const key = `${title}\n${body ?? ""}`;
			if (Date.now() - (lastToasts.get(key) ?? 0) < TOAST_REST_MS) return;
			lastToasts.set(key, Date.now());
			mango.ui.toast({
				title,
				body,
				kind: "error",
				action
			});
		}
		function inverseOf(ops) {
			const inverse = [];
			const seen = /* @__PURE__ */ new Map();
			for (const op of ops) {
				const key = keyOf(op);
				const before = seen.has(key) ? seen.get(key) : currentOf(entries.get(key));
				const target = {
					kind: op.kind,
					id: op.id,
					collectionId: op.collectionId
				};
				if (op.op === "create") inverse.unshift({
					...target,
					op: "delete"
				});
				else if (op.op === "delete") {
					if (before) inverse.unshift({
						...target,
						op: "create",
						data: before
					});
				} else if (before) inverse.unshift({
					...target,
					op: "patch",
					patch: invertPatch(before, op.patch)
				});
				seen.set(key, applyOps(before, [op]));
			}
			return inverse;
		}
		/** Makes a change. False when it may not be made. */
		function mutate(ops, label, opts = {}) {
			ops = ops.filter((o) => o.op !== "patch" || o.patch.length);
			if (!ops.length) return true;
			if (sourceStatus.value.readonly) {
				toast(strings$1.readonly, sourceStatus.value.message);
				return false;
			}
			if (opts.defer) {
				addDeferred(ops, label);
				return true;
			}
			settleDeferred();
			const m = newMutation(ops, label, false);
			show(m);
			enqueue(m);
			return true;
		}
		function newMutation(ops, label, isDeferred) {
			const undoEntry = label === null ? null : {
				label,
				undo: inverseOf(ops),
				redo: [...ops]
			};
			if (undoEntry) record(undoEntry);
			return {
				ops,
				at: Date.now(),
				deferred: isDeferred,
				undoEntry
			};
		}
		function record(entry) {
			undoStack.value = [...undoStack.value, entry].slice(-100);
			redoStack.value = [];
		}
		function show(m) {
			const keys = new Set(m.ops.map(keyOf));
			for (const op of m.ops) {
				const e = entryFor(op);
				if (!e.pending.includes(m)) e.pending.push(m);
			}
			publish(keys);
		}
		function hide(m) {
			const keys = new Set(m.ops.map(keyOf));
			for (const key of keys) {
				const e = entries.get(key);
				if (e) e.pending = e.pending.filter((p) => p !== m);
			}
			publish(keys);
		}
		/** Text as it is typed: joins what is waiting, a newer text of one field replacing the older. */
		function addDeferred(ops, label) {
			if (deferred) {
				const m = deferred;
				m.at = Date.now();
				const fresh = [];
				for (const op of ops) if (op.op !== "patch" || !replaceIn(m.ops, op)) fresh.push(op);
				if (m.undoEntry) {
					if (fresh.length) m.undoEntry.undo = [...inverseOf(fresh), ...m.undoEntry.undo];
					m.undoEntry.redo = [...m.ops, ...fresh];
				} else if (label !== null && fresh.length) {
					m.undoEntry = {
						label,
						undo: inverseOf(fresh),
						redo: [...fresh]
					};
					record(m.undoEntry);
				}
				m.ops = [...m.ops, ...fresh];
				show(m);
			} else {
				deferred = newMutation(ops, label, true);
				show(deferred);
			}
			saving.value = true;
			clearTimeout(timer);
			timer = setTimeout(settleDeferred, deferMs);
		}
		/** Replaces the values of a patch that is waiting already; false when one of its fields is not in it. */
		function replaceIn(ops, op) {
			const at = ops.findIndex((o) => o.op === "patch" && keyOf(o) === keyOf(op) && op.patch.every((p) => o.patch.some((q) => samePath(p.path, q.path))));
			const old = ops[at];
			if (old?.op !== "patch") return false;
			ops[at] = {
				...old,
				patch: old.patch.map((q) => op.patch.findLast((p) => samePath(p.path, q.path)) ?? q)
			};
			return true;
		}
		/** Hands what is waiting to the writer. */
		function settleDeferred() {
			clearTimeout(timer);
			const again = unsaved;
			unsaved = [];
			again.forEach(enqueue);
			const m = deferred;
			deferred = null;
			if (m) enqueue(m);
		}
		function enqueue(m) {
			writing++;
			saving.value = true;
			chain = chain.then(() => writeOut(m)).finally(() => {
				writing--;
				saving.value = writing > 0 || deferred !== null || unsaved.length > 0;
			});
		}
		async function writeOut(m) {
			try {
				const docs = await source.write(m.ops);
				take(docs);
				hide(m);
				const patched = new Set(m.ops.filter((o) => o.op === "patch").map(keyOf));
				const removed = new Set(m.ops.filter((o) => o.op === "delete").map(keyOf));
				if (docs.some((d) => d.data === null && patched.has(keyOf(d)) && !removed.has(keyOf(d)))) toast(strings$1.saveFailed, strings$1.gone);
			} catch (e) {
				mango.log.error("Saving:", e);
				if (m.deferred && !disposed) {
					unsaved.push(m);
					return toast(strings$1.saveFailed, messageOf(e), {
						label: strings$1.retry,
						run: settleDeferred
					});
				}
				hide(m);
				if (m.undoEntry) {
					undoStack.value = undoStack.value.filter((u) => u !== m.undoEntry);
					redoStack.value = redoStack.value.filter((u) => u !== m.undoEntry);
				}
				toast(strings$1.saveFailed, messageOf(e));
			}
		}
		function step(from, to, which) {
			settleDeferred();
			const entry = from.value.at(-1);
			if (!entry) return;
			const m = {
				ops: [...entry[which]],
				at: Date.now(),
				deferred: false,
				undoEntry: entry
			};
			if (sourceStatus.value.readonly) return toast(strings$1.readonly, sourceStatus.value.message);
			from.value = from.value.slice(0, -1);
			to.value = [...to.value, entry];
			if (!m.ops.length) return;
			show(m);
			enqueue(m);
		}
		const undo = () => step(undoStack, redoStack, "undo");
		const redo = () => step(redoStack, undoStack, "redo");
		/** Undoes this very change, while it is still the last one; otherwise by a change of its own. */
		function undoToast(title) {
			const entry = undoStack.value.at(-1);
			if (!entry) return;
			mango.ui.toast({
				title,
				kind: "info",
				action: {
					label: strings$1.undo,
					run: () => {
						if (undoStack.value.at(-1) === entry) return undo();
						if (!undoStack.value.includes(entry)) return;
						undoStack.value = undoStack.value.filter((u) => u !== entry);
						mutate([...entry.undo], null);
					}
				}
			});
		}
		const patchCollection = (id, patch, label, opts) => mutate([{
			...collectionTarget(id),
			op: "patch",
			patch
		}], label, opts);
		function createCollection(input = {}) {
			const template = input.template ?? "empty";
			const data = templateData(template);
			const scope = input.scope ?? (projectPath.value ? {
				kind: "project",
				path: projectPath.value
			} : { kind: "everywhere" });
			const id = newId();
			const place = placeAt(allCollections.value, [id], "end");
			const ops = [{
				...collectionTarget(id),
				op: "create",
				data: {
					...data,
					name: input.name?.trim() || strings$1.templates[template].name,
					icon: input.icon ?? data.icon,
					color: input.color ?? data.color,
					scope: json(scope),
					order: place.get(id),
					createdAt: Date.now()
				}
			}, ...reorderOps(place, id)];
			startEmpty(id);
			return mutate(ops, strings$1.did.createCollection) ? collection(id) : null;
		}
		/** A new collection has no items to read. */
		function startEmpty(id) {
			stateOf(id).status = "ready";
		}
		/** Patches for collections whose order changed around a new one. */
		function reorderOps(place, except) {
			return [...place].filter(([id]) => id !== except).map(([id, order]) => ({
				...collectionTarget(id),
				op: "patch",
				patch: [{
					path: ["order"],
					value: order
				}]
			}));
		}
		function updateCollection(id, change, opts) {
			patchCollection(id, fields(change), strings$1.did.editCollection, opts);
		}
		function moveCollection(id, position) {
			mutate(reorderOps(placeAt(allCollections.value, [id], position)), strings$1.did.editCollection);
		}
		async function duplicateCollection(id, opts = {}) {
			const list = opts.items ? await withItems(id) : [];
			const raw = rawCollection(id);
			const model = collection(id);
			if (!list || !raw || !model) return null;
			const copy = newId();
			const at = Date.now();
			const place = placeAt(allCollections.value, [copy], { after: id });
			const ops = [
				{
					...collectionTarget(copy),
					op: "create",
					data: {
						...raw,
						name: strings$1.copyOf(model.name),
						order: place.get(copy),
						createdAt: at
					}
				},
				...reorderOps(place, copy),
				...list.flatMap((i) => {
					const data = rawItem(id, i.id);
					return data ? [{
						...itemTarget(copy, newId()),
						op: "create",
						data: {
							...data,
							createdAt: at
						}
					}] : [];
				})
			];
			startEmpty(copy);
			return mutate(ops, strings$1.did.duplicate) ? collection(copy) : null;
		}
		async function deleteCollection(id) {
			const list = await withItems(id);
			const model = collection(id);
			if (!list || !model) return false;
			if (!mutate([{
				...collectionTarget(id),
				op: "delete"
			}, ...list.map((i) => ({
				...itemTarget(id, i.id),
				op: "delete"
			}))], strings$1.did.deleteCollection)) return false;
			undoToast(strings$1.deletedCollection(model.name));
			return true;
		}
		/** The stored form of values, each checked against its property. */
		function storedValues(c, values) {
			const out = {};
			for (const [id, v] of Object.entries(values)) {
				const p = propertyOf(c, id);
				const stored = p ? storedValue(v, p) : void 0;
				if (stored !== void 0) out[id] = stored;
			}
			return out;
		}
		async function createItem(collectionId, input = {}) {
			if (stateOf(collectionId).status !== "ready" && !await withItems(collectionId)) return null;
			const c = collection(collectionId);
			if (!c) return null;
			const id = newId();
			const at = Date.now();
			const view = viewOf(c, input.viewId);
			const values = {
				...view ? defaultValues(c, view, input.group, at) : {},
				...input.values
			};
			const place = placeAt(stateOf(collectionId).items, [id], input.position ?? "end");
			return mutate([{
				...itemTarget(collectionId, id),
				op: "create",
				data: {
					title: input.title ?? "",
					icon: input.icon ?? null,
					body: input.body ?? "",
					values: storedValues(c, values),
					chats: Object.fromEntries((input.chats ?? []).map((t, i) => [t, at + i])),
					order: place.get(id),
					createdAt: at
				}
			}, ...itemOrderOps(collectionId, place, /* @__PURE__ */ new Set([id]))], strings$1.did.createItem) ? item(collectionId, id) : null;
		}
		function itemOrderOps(collectionId, place, except) {
			return [...place].filter(([id]) => !except.has(id)).map(([id, order]) => ({
				...itemTarget(collectionId, id),
				op: "patch",
				patch: [{
					path: ["order"],
					value: order
				}]
			}));
		}
		function itemPatch(c, change) {
			const patch = [];
			if (change.title !== void 0) patch.push({
				path: ["title"],
				value: change.title
			});
			if (change.icon !== void 0) patch.push({
				path: ["icon"],
				value: change.icon
			});
			if (change.body !== void 0) patch.push({
				path: ["body"],
				value: change.body
			});
			for (const [id, v] of Object.entries(change.values ?? {})) {
				const p = propertyOf(c, id);
				if (!p) continue;
				const value = storedValue(v, p);
				patch.push(value === void 0 ? { path: ["values", id] } : {
					path: ["values", id],
					value
				});
			}
			return patch;
		}
		/** Without what is so already: no write, and nothing to undo. */
		function effective(raw, patch) {
			return raw ? patch.filter((p) => JSON.stringify(readPath(raw, p.path)) !== JSON.stringify(p.value)) : [];
		}
		function changeItems(collectionId, itemIds, change, opts) {
			const c = collection(collectionId);
			if (!c) return;
			const patch = itemPatch(c, change);
			mutate(itemIds.map((id) => ({
				...itemTarget(collectionId, id),
				op: "patch",
				patch: effective(rawItem(collectionId, id), patch)
			})), strings$1.did.editItem, opts);
		}
		function moveItems(collectionId, move) {
			const c = collection(collectionId);
			if (!c) return;
			const list = stateOf(collectionId).items;
			const byId = new Map(list.map((i) => [i.id, i]));
			const ids = move.ids.filter((id) => byId.has(id));
			const place = move.position === void 0 ? /* @__PURE__ */ new Map() : placeAt(list, ids, move.position);
			const property = move.group ? propertyOf(c, move.group.propertyId) : null;
			const groupable = property && isGroupable(property) ? property : null;
			const patches = /* @__PURE__ */ new Map();
			for (const id of ids) {
				const change = groupable ? { values: { [groupable.id]: valueForGroup(groupable, move.group.key, byId.get(id), move.group.from) } } : {};
				patches.set(id, itemPatch(c, change));
			}
			for (const [id, order] of place) patches.set(id, [...patches.get(id) ?? [], {
				path: ["order"],
				value: order
			}]);
			mutate([...patches].map(([id, patch]) => ({
				...itemTarget(collectionId, id),
				op: "patch",
				patch: effective(rawItem(collectionId, id), patch)
			})), strings$1.did.moveItem);
		}
		function duplicateItems(collectionId, itemIds) {
			let list = stateOf(collectionId).items;
			const at = Date.now();
			const ops = [];
			const copies = [];
			for (const original of list.filter((i) => itemIds.includes(i.id))) {
				const raw = rawItem(collectionId, original.id);
				if (!raw) continue;
				const id = newId();
				const place = placeAt(list, [id], { after: original.id });
				const data = {
					...raw,
					title: strings$1.copyOf(original.title),
					order: place.get(id),
					chats: {},
					createdAt: at
				};
				ops.push({
					...itemTarget(collectionId, id),
					op: "create",
					data
				}, ...itemOrderOps(collectionId, place, /* @__PURE__ */ new Set([id])));
				list = [...list.map((i) => place.has(i.id) ? {
					...i,
					order: place.get(i.id)
				} : i), {
					...original,
					id,
					order: place.get(id)
				}];
				copies.push(id);
			}
			if (!mutate(ops, strings$1.did.duplicate)) return [];
			return copies.map((id) => item(collectionId, id)).filter((i) => i !== null);
		}
		function deleteItems(collectionId, itemIds) {
			const ids = [...new Set(itemIds)].filter((id) => rawItem(collectionId, id));
			if (!ids.length) return;
			if (mutate(ids.map((id) => ({
				...itemTarget(collectionId, id),
				op: "delete"
			})), strings$1.did.deleteItems(ids.length))) undoToast(strings$1.deletedItems(ids.length));
		}
		function setChat(collectionId, itemId, threadId, linked) {
			const existing = item(collectionId, itemId);
			if (!existing || existing.chats.includes(threadId) === linked) return;
			const patch = [linked ? {
				path: ["chats", threadId],
				value: Date.now()
			} : { path: ["chats", threadId] }];
			mutate([{
				...itemTarget(collectionId, itemId),
				op: "patch",
				patch
			}], strings$1.did.linkChat);
		}
		function fields(change) {
			return Object.entries(change).filter(([, v]) => v !== void 0).map(([k, v]) => ({
				path: [k],
				value: json(v)
			}));
		}
		function addProperty(collectionId, input, position = "end") {
			const c = collection(collectionId);
			if (!c) return null;
			const id = newId();
			const place = placeAt(c.properties, [id], position);
			const patch = [{
				path: ["properties", id],
				value: propertyData({
					...input,
					order: place.get(id)
				})
			}, ...orderPatch(["properties"], place, id)];
			return patchCollection(collectionId, patch, strings$1.did.editProperty) ? propertyOf(collection(collectionId), id) : null;
		}
		function orderPatch(prefix, place, except) {
			return [...place].filter(([id]) => id !== except).map(([id, value]) => ({
				path: [
					...prefix,
					id,
					"order"
				],
				value
			}));
		}
		function renameProperty(collectionId, propertyId, name, opts) {
			patchCollection(collectionId, [{
				path: [
					"properties",
					propertyId,
					"name"
				],
				value: name
			}], strings$1.did.editProperty, opts);
		}
		function moveProperty(collectionId, propertyId, position) {
			const c = collection(collectionId);
			if (c && propertyOf(c, propertyId)) patchCollection(collectionId, orderPatch(["properties"], placeAt(c.properties, [propertyId], position)), strings$1.did.editProperty);
		}
		/** Every stored view with its fields rewritten where `change` answers something else than they are. */
		function viewPatches(collectionId, change) {
			return entriesById(rawCollection(collectionId)?.views).flatMap(([id, view]) => Object.entries(change(view)).filter(([k, v]) => JSON.stringify(view[k]) !== JSON.stringify(v)).map(([k, value]) => ({
				path: [
					"views",
					id,
					k
				],
				value
			})));
		}
		const listOf = (v) => Array.isArray(v) ? v : [];
		const without = (v, propertyId) => listOf(v).filter((e) => !(isObject(e) && e.propertyId === propertyId));
		function filterWithout(v, propertyId) {
			const f = isObject(v) ? v : {};
			return {
				...f,
				conditions: without(f.conditions, propertyId)
			};
		}
		async function setPropertyType(collectionId, propertyId, type) {
			const list = await withItems(collectionId);
			const c = collection(collectionId);
			const property = c && propertyOf(c, propertyId);
			if (!list || !property || type === "unsupported" || propertyId === "title") return false;
			if (property.type === type) return true;
			const conversion = convertProperty(property, type, list);
			const added = conversion.property.options.filter((o) => !property.options.some((e) => e.id === o.id));
			const patch = [
				{
					path: [
						"properties",
						propertyId,
						"type"
					],
					value: type
				},
				...added.map((o) => ({
					path: [
						"properties",
						propertyId,
						"options",
						o.id
					],
					value: {
						name: o.name,
						color: o.color,
						order: o.order
					}
				})),
				...viewPatches(collectionId, (v) => ({
					...isObject(v.filter) ? { filter: filterWithout(v.filter, propertyId) } : {},
					...v.groupBy === propertyId && !isGroupable(conversion.property) ? { groupBy: null } : {},
					...v.groupBy === propertyId ? {
						hiddenGroups: [],
						collapsedGroups: []
					} : {}
				}))
			];
			const ok = mutate([{
				...collectionTarget(collectionId),
				op: "patch",
				patch
			}, ...[...conversion.values].map(([id, v]) => {
				const value = storedValue(v, conversion.property);
				return {
					...itemTarget(collectionId, id),
					op: "patch",
					patch: [value === void 0 ? { path: ["values", propertyId] } : {
						path: ["values", propertyId],
						value
					}]
				};
			})], strings$1.did.editProperty);
			if (ok && conversion.lost) undoToast(strings$1.valuesLost(conversion.lost));
			return ok;
		}
		async function deleteProperty(collectionId, propertyId) {
			const list = await withItems(collectionId);
			const c = collection(collectionId);
			const property = c && propertyOf(c, propertyId);
			if (!list || !property) return false;
			const patch = [{ path: ["properties", propertyId] }, ...viewPatches(collectionId, (v) => ({
				sorts: without(v.sorts, propertyId),
				filter: filterWithout(v.filter, propertyId),
				columns: without(v.columns, propertyId),
				...isObject(v.widths) ? { widths: Object.fromEntries(Object.entries(v.widths).filter(([k]) => k !== propertyId)) } : {},
				...v.groupBy === propertyId ? {
					groupBy: null,
					hiddenGroups: [],
					collapsedGroups: []
				} : {}
			}))];
			const ok = mutate([{
				...collectionTarget(collectionId),
				op: "patch",
				patch
			}, ...list.filter((i) => propertyId in i.values).map((i) => ({
				...itemTarget(collectionId, i.id),
				op: "patch",
				patch: [{ path: ["values", propertyId] }]
			}))], strings$1.did.deleteProperty);
			if (ok) undoToast(strings$1.deletedProperty(property.name));
			return ok;
		}
		function addOption(collectionId, propertyId, name, color) {
			const c = collection(collectionId);
			const property = c && propertyOf(c, propertyId);
			const label = name.trim();
			if (!property || !label) return null;
			const same = property.options.find((o) => o.name.trim().toLowerCase() === label.toLowerCase());
			if (same) return same;
			const id = newId();
			const place = placeAt(property.options, [id], "end");
			const base = [
				"properties",
				propertyId,
				"options"
			];
			return patchCollection(collectionId, [{
				path: [...base, id],
				value: {
					name: label,
					color: color ?? colorAt(property.options.length),
					order: place.get(id)
				}
			}, ...orderPatch(base, place, id)], strings$1.did.editOption) ? propertyOf(collection(collectionId), propertyId)?.options.find((o) => o.id === id) ?? null : null;
		}
		function updateOption(collectionId, propertyId, optionId, change, opts) {
			const patch = fields(change).map((p) => ({
				...p,
				path: [
					"properties",
					propertyId,
					"options",
					optionId,
					...p.path
				]
			}));
			patchCollection(collectionId, patch, strings$1.did.editOption, opts);
		}
		function moveOption(collectionId, propertyId, optionId, position) {
			const property = propertyOf(collection(collectionId) ?? EMPTY, propertyId);
			if (!property?.options.some((o) => o.id === optionId)) return;
			patchCollection(collectionId, orderPatch([
				"properties",
				propertyId,
				"options"
			], placeAt(property.options, [optionId], position)), strings$1.did.editOption);
		}
		async function deleteOption(collectionId, propertyId, optionId) {
			const list = await withItems(collectionId);
			const c = collection(collectionId);
			const option = c && propertyOf(c, propertyId)?.options.find((o) => o.id === optionId);
			if (!list || !option) return false;
			const drop = (v) => listOf(v).filter((e) => e !== optionId);
			const patch = [{ path: [
				"properties",
				propertyId,
				"options",
				optionId
			] }, ...viewPatches(collectionId, (v) => {
				const f = isObject(v.filter) ? v.filter : {};
				const conditions = listOf(f.conditions).flatMap((e) => {
					if (!isObject(e) || e.propertyId !== propertyId || !Array.isArray(e.value) || !e.value.includes(optionId)) return [e];
					const value = drop(e.value);
					return value.length ? [{
						...e,
						value
					}] : [];
				});
				return {
					filter: {
						...f,
						conditions
					},
					...v.groupBy === propertyId ? {
						hiddenGroups: drop(v.hiddenGroups),
						collapsedGroups: drop(v.collapsedGroups)
					} : {}
				};
			})];
			const ok = mutate([{
				...collectionTarget(collectionId),
				op: "patch",
				patch
			}, ...list.flatMap((i) => {
				const v = i.values[propertyId];
				if (v === optionId) return [{
					...itemTarget(collectionId, i.id),
					op: "patch",
					patch: [{ path: ["values", propertyId] }]
				}];
				if (!Array.isArray(v) || !v.includes(optionId)) return [];
				return [{
					...itemTarget(collectionId, i.id),
					op: "patch",
					patch: [{
						path: ["values", propertyId],
						value: drop(v)
					}]
				}];
			})], strings$1.did.deleteOption);
			if (ok) undoToast(strings$1.deletedOption(option.name));
			return ok;
		}
		function addView(collectionId, input, position = "end") {
			const c = collection(collectionId);
			if (!c) return null;
			const id = newId();
			const keep = storeFallbackView(c);
			const place = placeAt(c.views, [id], position);
			const patch = [
				...keep,
				{
					path: ["views", id],
					value: viewData(input, place.get(id))
				},
				...orderPatch(["views"], place, id)
			];
			return patchCollection(collectionId, patch, strings$1.did.editView) ? viewOf(collection(collectionId), id) : null;
		}
		/** The view shown for want of any becomes a real one before it is changed. */
		function storeFallbackView(c) {
			if (entriesById(rawCollection(c.id)?.views).length) return [];
			return c.views.map((v) => ({
				path: ["views", v.id],
				value: viewData({
					...v,
					filter: {
						match: "and",
						conditions: []
					}
				}, v.order)
			}));
		}
		function updateView(collectionId, viewId, change, opts) {
			const c = collection(collectionId);
			if (!c || !viewOf(c, viewId)) return;
			const patch = fields(change).map((p) => ({
				...p,
				path: [
					"views",
					viewId,
					...p.path
				]
			}));
			const onlyLayout = Object.keys(change).every((k) => LAYOUT.has(k));
			patchCollection(collectionId, [...storeFallbackView(c), ...effective(rawCollection(collectionId), patch)], onlyLayout ? null : strings$1.did.editView, opts);
		}
		function duplicateView(collectionId, viewId) {
			const c = collection(collectionId);
			const view = c && viewOf(c, viewId);
			if (!c || !view) return null;
			const id = newId();
			const keep = storeFallbackView(c);
			const raw = readPath(rawCollection(collectionId) ?? {}, ["views", viewId]);
			const data = isObject(raw) ? raw : keep[0]?.value;
			const place = placeAt(c.views, [id], { after: viewId });
			const patch = [
				...keep,
				{
					path: ["views", id],
					value: {
						...data,
						name: strings$1.copyOf(view.name),
						order: place.get(id)
					}
				},
				...orderPatch(["views"], place, id)
			];
			return patchCollection(collectionId, patch, strings$1.did.duplicate) ? viewOf(collection(collectionId), id) : null;
		}
		function moveView(collectionId, viewId, position) {
			const c = collection(collectionId);
			if (c && viewOf(c, viewId)) patchCollection(collectionId, [...storeFallbackView(c), ...orderPatch(["views"], placeAt(c.views, [viewId], position))], strings$1.did.editView);
		}
		function deleteView(collectionId, viewId) {
			const c = collection(collectionId);
			const view = c && viewOf(c, viewId);
			if (!c || !view || c.views.length < 2) return false;
			const ok = patchCollection(collectionId, [{ path: ["views", viewId] }], strings$1.did.deleteView);
			if (ok) undoToast(strings$1.deletedView(view.name));
			return ok;
		}
		async function exported(collectionId, itemIds, make) {
			const list = await withItems(collectionId);
			const c = collection(collectionId);
			if (!list || !c) return null;
			const byId = new Map(list.map((i) => [i.id, i]));
			return make(c, itemIds ? itemIds.map((id) => byId.get(id)).filter((i) => i !== void 0) : list);
		}
		function importOps(collectionId, csv, existing, items) {
			const plan = planImport(parseCsv(csv), existing);
			const at = Date.now();
			const ids = plan.items.map(newId);
			const keys = manyBetween(ordered(items).at(-1)?.order ?? null, null, ids.length);
			const place = keys ? null : placeAt(items, ids, "end");
			const byId = new Map([...existing, ...plan.properties].map((p) => [p.id, p]));
			const creates = plan.items.map((i, n) => ({
				...itemTarget(collectionId, ids[n]),
				op: "create",
				data: {
					title: i.title,
					icon: null,
					body: i.body,
					values: Object.fromEntries(Object.entries(i.values).flatMap(([id, v]) => {
						const stored = storedValue(v, byId.get(id));
						return stored === void 0 ? [] : [[id, stored]];
					})),
					chats: {},
					order: keys?.[n] ?? place.get(ids[n]),
					createdAt: at
				}
			}));
			const reorder = place ? itemOrderOps(collectionId, place, new Set(ids)) : [];
			return {
				plan,
				ops: [...creates, ...reorder]
			};
		}
		async function importCsv(collectionId, csv) {
			const list = await withItems(collectionId);
			const c = collection(collectionId);
			if (!list || !c) return 0;
			const { plan, ops } = importOps(collectionId, csv, c.properties, list);
			if (!ops.length) {
				toast(strings$1.importEmpty);
				return 0;
			}
			const patch = plan.properties.flatMap((p) => {
				const old = propertyOf(c, p.id);
				if (!old) return [{
					path: ["properties", p.id],
					value: propertyData(p)
				}];
				return p.options.filter((o) => !old.options.some((e) => e.id === o.id)).map((o) => ({
					path: [
						"properties",
						p.id,
						"options",
						o.id
					],
					value: {
						name: o.name,
						color: o.color,
						order: o.order
					}
				}));
			});
			return mutate([{
				...collectionTarget(collectionId),
				op: "patch",
				patch
			}, ...ops], strings$1.did.import) ? plan.items.length : 0;
		}
		async function importCsvAsCollection(csv, name, scope) {
			const id = newId();
			const { plan, ops } = importOps(id, csv, [], []);
			if (!ops.length) {
				toast(strings$1.importEmpty);
				return null;
			}
			const template = templateData("empty");
			const keys = spread(plan.properties.length);
			const place = placeAt(allCollections.value, [id], "end");
			startEmpty(id);
			return mutate([
				{
					...collectionTarget(id),
					op: "create",
					data: {
						...template,
						name: name.trim() || strings$1.newCollection,
						properties: Object.fromEntries(plan.properties.map((p, i) => [p.id, propertyData({
							...p,
							order: keys[i]
						})])),
						scope: json(scope ?? (projectPath.value ? {
							kind: "project",
							path: projectPath.value
						} : { kind: "everywhere" })),
						order: place.get(id),
						createdAt: Date.now()
					}
				},
				...reorderOps(place, id),
				...ops
			], strings$1.did.import) ? collection(id) : null;
		}
		const uiKey = () => `ui:${projectPath.value ? projectKey(projectPath.value) : ""}`;
		function ui() {
			const v = mango.storage.get(uiKey());
			return isObject(v) ? v : {};
		}
		const unsubscribe = source.subscribe((docs) => publish(take(docs)));
		const unsubscribeStatus = source.onStatus((s) => {
			sourceStatus.value = s;
		});
		const project = mango.workspace.onProjectChange((path) => {
			projectPath.value = path;
		});
		const clock = setInterval(() => {
			now.value = Date.now();
		}, 6e4);
		const leave = () => settleDeferred();
		const hasWindow = typeof window !== "undefined";
		if (hasWindow) {
			window.addEventListener("pagehide", leave);
			window.addEventListener("beforeunload", leave);
			window.addEventListener("blur", leave);
		}
		async function flush() {
			settleDeferred();
			await chain;
		}
		function dispose() {
			if (disposed) return;
			settleDeferred();
			disposed = true;
			clearInterval(clock);
			project.dispose();
			unsubscribeStatus();
			if (hasWindow) {
				window.removeEventListener("pagehide", leave);
				window.removeEventListener("beforeunload", leave);
				window.removeEventListener("blur", leave);
			}
			chain.finally(() => {
				unsubscribe();
				source.dispose();
			});
		}
		load();
		return {
			status,
			error,
			sourceStatus,
			projectPath,
			allCollections,
			collections,
			now,
			saving,
			collection,
			items,
			item,
			load,
			loadItems,
			itemsForChat: (threadId) => [...itemStates.values()].flatMap((s) => s.items.filter((i) => i.chats.includes(threadId))),
			createCollection,
			updateCollection,
			moveCollection,
			duplicateCollection,
			deleteCollection,
			createItem,
			updateItem: (c, id, change, opts) => changeItems(c, [id], change, opts),
			updateItems: (c, ids, change) => changeItems(c, ids, change),
			moveItems,
			duplicateItems,
			deleteItems,
			linkChat: (c, id, threadId) => setChat(c, id, threadId, true),
			unlinkChat: (c, id, threadId) => setChat(c, id, threadId, false),
			addProperty,
			renameProperty,
			moveProperty,
			setPropertyType,
			deleteProperty,
			addOption,
			updateOption,
			moveOption,
			deleteOption,
			addView,
			updateView,
			duplicateView,
			moveView,
			deleteView,
			exportCsv: (id, ids) => exported(id, ids, toCsv),
			exportMarkdown: (id, ids) => exported(id, ids, toMarkdown),
			importCsv,
			importCsvAsCollection,
			canUndo: (0, vue.computed)(() => undoStack.value.length > 0),
			canRedo: (0, vue.computed)(() => redoStack.value.length > 0),
			undoLabel: (0, vue.computed)(() => undoStack.value.at(-1)?.label ?? null),
			redoLabel: (0, vue.computed)(() => redoStack.value.at(-1)?.label ?? null),
			undo,
			redo,
			lastCollection: () => ui().collection ?? null,
			rememberCollection: (id) => {
				mango.storage.set(uiKey(), {
					...ui(),
					collection: id ?? void 0
				});
			},
			lastView: (id) => ui().views?.[id] ?? null,
			rememberView: (id, viewId) => {
				mango.storage.set(uiKey(), {
					...ui(),
					views: {
						...ui().views,
						[id]: viewId
					}
				});
			},
			flush,
			dispose
		};
	}
	/** Stands in for a collection that is gone. */
	var EMPTY = { properties: [] };
	// plugins/planner/src/main.ts
	var ICON = "square-kanban";
	var current = null;
	function activate(mango) {
		const store = createStore(mango);
		current = store;
		mango.onDispose(() => {
			store.dispose();
			if (current === store) current = null;
		});
		const isOpen = () => mango.ui.tabs.active()?.viewId === VIEW_ID;
		function open(route) {
			if (!mango.workspace.activeProject()) return mango.ui.toast({ title: strings$1.noProject });
			mango.ui.tabs.open(VIEW_ID, {
				title: strings$1.planner,
				key: TAB_KEY,
				state: route ? { ...route } : void 0
			});
		}
		function toggle() {
			if (isOpen()) mango.ui.tabs.close(VIEW_ID, TAB_KEY);
			else open();
		}
		mango.ui.tabs.register({
			id: VIEW_ID,
			icon: ICON,
			header: "none",
			restore: true,
			view: {
				component: App_default,
				props: {
					mango,
					store
				}
			}
		});
		mango.ui.navItems.register({
			id: "planner",
			title: strings$1.planner,
			icon: ICON,
			shortcut: "planner",
			active: isOpen,
			run: () => open()
		});
		mango.shortcuts.register({
			id: "planner",
			label: strings$1.commands.open,
			key: "Mod+Shift+D",
			run: toggle
		});
		/** The only collection, or the one the user picks; says so when there is none. */
		async function chooseCollection() {
			const list = store.collections.value;
			if (!list.length) {
				mango.ui.toast({
					title: strings$1.noCollections,
					body: strings$1.noCollectionsForItem,
					action: {
						label: strings$1.commands.open,
						run: () => open()
					}
				});
				return null;
			}
			if (list.length === 1) return list[0];
			let picked = null;
			await mango.ui.dialog({
				title: strings$1.chooseCollection,
				width: 360,
				view: { component: {
					props: ["ctx"],
					setup: (props) => () => (0, vue.h)(PickCollection_default, {
						mango,
						collections: list,
						onPick: (c) => {
							picked = c;
							props.ctx?.close();
						}
					})
				} }
			});
			return picked;
		}
		mango.commands.register({
			id: "open",
			title: strings$1.commands.open,
			icon: ICON,
			keywords: "board kanban tasks notes table",
			run: () => open()
		});
		mango.commands.register({
			id: "new-item",
			title: strings$1.commands.newItem,
			icon: ICON,
			keywords: "planner task bug note",
			run: async () => {
				const shown = isOpen() ? readRoute(mango.ui.tabs.active()?.state)?.collectionId ?? store.lastCollection() : null;
				const collection = store.collections.value.find((c) => c.id === shown) ?? await chooseCollection();
				if (!collection) return;
				const title = (await mango.ui.prompt({
					title: strings$1.newItemIn(collection.name),
					placeholder: strings$1.newItemPrompt
				}))?.trim();
				if (!title) return;
				const item = await store.createItem(collection.id, { title });
				if (item) open({
					collectionId: collection.id,
					itemId: item.id
				});
			}
		});
		mango.commands.register({
			id: "new-collection",
			title: strings$1.commands.newCollection,
			icon: ICON,
			keywords: "planner board table",
			run: async () => {
				const name = (await mango.ui.prompt({
					title: strings$1.newCollection,
					placeholder: strings$1.templates.tasks.name
				}))?.trim();
				if (!name) return;
				const collection = store.createCollection({
					name,
					template: "tasks"
				});
				if (collection) open({ collectionId: collection.id });
			}
		});
		mango.ui.menus.register("thread", {
			id: "add",
			label: strings$1.commands.addThread,
			icon: ICON,
			run: async ({ threadId }) => {
				const title = mango.chat.get(threadId)?.title;
				const collection = title === void 0 ? null : await chooseCollection();
				if (!collection) return;
				const item = await store.createItem(collection.id, {
					title,
					chats: [threadId]
				});
				if (!item) return;
				mango.ui.toast({
					title: strings$1.itemAdded(collection.name),
					kind: "success",
					action: {
						label: strings$1.show,
						run: () => open({
							collectionId: collection.id,
							itemId: item.id
						})
					}
				});
			}
		});
	}
	/** Before the plugin goes: what was typed is written. */
	async function deactivate() {
		await current?.flush();
	}
	exports.activate = activate;
	exports.deactivate = deactivate;
	return exports;
})({}, __vue);
return __plugin
}

export function activate(mango) {
  active = load(mango.vue)
  return active.activate(mango)
}

export function deactivate() {
  return active?.deactivate?.()
}
