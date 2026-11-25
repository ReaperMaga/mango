/* Built from src/ by `pnpm plugins:build`. Do not edit. 9f06cdd52fddc3ca8fd2453701c3d3ee */

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
	function usePlanner() {
		const planner = (0, vue.inject)(PLANNER);
		if (!planner) throw new Error("Used outside of the planner.");
		return planner;
	}
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
	// plugins/planner/src/ui/Icon.vue?vue&type=script&setup=true&lang.ts
	/** A lucide icon by name, drawn by Mango. 15px unless styled otherwise. */
	var Icon_vue_vue_type_script_setup_true_lang_default = /*@__PURE__*/ (0, vue.defineComponent)({
		__name: "Icon",
		props: { name: {} },
		setup(__props) {
			const { Icon } = usePlanner().mango.ui.components;
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Icon)), {
					icon: __props.name,
					class: "pl-icon"
				}, null, 8, ["icon"]);
			};
		}
	});
	// \0plugin-vue:export-helper
	var _plugin_vue_export_helper_default = (sfc, props) => {
		const target = sfc.__vccOpts || sfc;
		for (const [key, val] of props) target[key] = val;
		return target;
	};
	// plugins/planner/src/ui/Icon.vue
	var Icon_default = /*#__PURE__*/ _plugin_vue_export_helper_default(Icon_vue_vue_type_script_setup_true_lang_default, [["__scopeId", "data-v-517fdef4"]]);
	// plugins/planner/src/ui/layers.ts
	var layers = [];
	function pushLayer(layer) {
		layers.push(layer);
		return () => {
			const i = layers.indexOf(layer);
			if (i >= 0) layers.splice(i, 1);
		};
	}
	var isTopLayer = (layer) => layers.at(-1) === layer;
	/** In this layer or one opened over it. */
	function inOrAbove(layer, el) {
		return layers.slice(layers.indexOf(layer)).some((l) => l.contains(el));
	}
	/** Mango's dialogs that are open. A popover may be in one: those open before it are under it, not over it. */
	var hostDialogs = () => [...document.querySelectorAll(".dlg__panel")];
	/** In one of Mango's own menus, dialogs or toasts over the planner's layer. */
	function inHostLayer(el, under = []) {
		const host = el instanceof Element ? el.closest(".menu__pop, .dlg__panel, .toast") : null;
		return host !== null && !under.includes(host);
	}
	var hostLayerOpen = (under = []) => document.querySelector(".menu__pop") !== null || hostDialogs().some((d) => !under.includes(d));
	/** Something floats that owns Escape: a popover of the planner, or a menu or dialog of Mango's. */
	var anyLayerOpen = () => layers.length > 0 || hostLayerOpen();
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
	// plugins/planner/src/strings.ts
	var strings$5 = {
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
		item: "item",
		items: "items",
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
		itemNames: {
			tasks: {
				one: "task",
				many: "tasks"
			},
			bugs: {
				one: "bug",
				many: "bugs"
			},
			notes: {
				one: "note",
				many: "notes"
			},
			empty: {
				one: "item",
				many: "items"
			}
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
				description: "Pages with a status and tags, on a board."
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
			backlog: "Backlog",
			review: "Review",
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
	// plugins/planner/src/model.ts
	/**
	* What the planner works with: collections of items with typed properties, seen through views.
	*
	* Two shapes of everything. The *stored* document is plain JSON that any version or a remote may have written;
	* changes are made to it as patches, so fields this version does not know stay. The *model* below is what the
	* UI reads: normalised from the stored document, complete and safe, and never written back. Treat it as
	* immutable: every change makes new objects and goes through the store.
	*/
	/** Named, so the UI maps them to design tokens. */
	var NAMED_COLORS = [
		"neutral",
		"blue",
		"green",
		"yellow",
		"orange",
		"red",
		"purple",
		"pink"
	];
	var isCustomColor = (c) => c.startsWith("#");
	/** A colour as it may be typed (`#RGB`, `rrggbb`) or stored, or null when it is none. */
	function readColor(v) {
		if (typeof v !== "string") return null;
		if (NAMED_COLORS.includes(v)) return v;
		const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim());
		if (!m) return null;
		const hex = m[1].toLowerCase();
		return `#${hex.length === 3 ? hex.replace(/./g, "$&$&") : hex}`;
	}
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
	var strings$4 = (v) => Array.isArray(v) ? [...new Set(v.filter((e) => typeof e === "string"))] : [];
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
	var colorAt = (i) => NAMED_COLORS[1 + i % (NAMED_COLORS.length - 1)];
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
	/** A date some days later, as a date. */
	function addDays(date, days) {
		const [y, m, d] = date.slice(0, 10).split("-").map(Number);
		return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
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
	var storedColor = (v) => (typeof v === "string" && (v.length === 7 || !v.startsWith("#")) ? readColor(v) : null) ?? "neutral";
	function normalizeOption(id, raw) {
		return {
			id,
			name: str(raw.name),
			color: storedColor(raw.color),
			order: str(raw.order)
		};
	}
	function normalizeProperty(id, raw) {
		const type = oneOf(PROPERTY_TYPES, raw.type, "unsupported");
		const options = ordered(entriesById(raw.options).map(([k, v]) => normalizeOption(k, v)));
		return {
			id,
			name: str(raw.name),
			type,
			order: str(raw.order),
			options,
			defaultOption: type === "select" ? options.find((o) => o.id === raw.defaultOption)?.id ?? null : null
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
				const known = strings$4(v).filter((o) => property.options.some((e) => e.id === o));
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
			hiddenGroups: strings$4(raw.hiddenGroups),
			collapsedGroups: strings$4(raw.collapsedGroups),
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
	function normalizeItemName(raw) {
		if (!isObject(raw)) return null;
		const one = str(raw.one).trim();
		const many = str(raw.many).trim();
		return one || many ? {
			one: one || many,
			many: many || one
		} : null;
	}
	/** What this many of a collection's items are called: `note`, `notes`. */
	function itemWord(c, n) {
		const name = c?.itemName;
		return n === 1 ? name?.one ?? strings$5.item : name?.many ?? strings$5.items;
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
			color: storedColor(r.color),
			description: str(r.description),
			itemName: normalizeItemName(r.itemName),
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
		const chats = isObject(r.chats) ? Object.entries(r.chats).filter(([id]) => isSafeKey(id)).sort((a, b) => num(a[1], 0) - num(b[1], 0)).map(([id]) => id) : strings$4(r.chats);
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
				const known = strings$4(raw).filter((id) => property.options.some((o) => o.id === id));
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
	// plugins/planner/src/item/strings.ts
	var strings$3 = {
		page: (title) => `Item: ${title || "Untitled"}`,
		untitled: "Untitled",
		title: "Title",
		close: "Close",
		back: (collection) => `Back to ${collection || "the collection"}`,
		expand: "Open as full page",
		dock: "Open at the side",
		more: "More",
		loading: "Loading…",
		loadFailed: "The planner could not be read",
		retry: "Try again",
		gone: "This item was deleted",
		goneBody: "It may have been deleted in another window. Undo can bring it back if you deleted it here.",
		backToCollection: "Back to the collection",
		empty: "Empty",
		properties: "Properties",
		addProperty: "Add property",
		propertyMenu: (name) => `${name || "Property"} menu`,
		openLink: "Open link",
		chats: "Chats",
		chatGone: "A chat that is no longer here",
		unlinkChat: "Unlink chat",
		showChat: (title) => `Show chat: ${title}`,
		body: "Notes",
		bodyEdit: "Notes. Press Enter to edit.",
		bodyPlaceholder: "Write notes, or a plan for a chat. Markdown works.",
		bold: "Bold",
		italic: "Italic",
		code: "Code",
		link: "Link",
		list: "List",
		tasks: "Tasks",
		done: "Done",
		startChat: "Start a chat",
		startFailed: "The chat could not be started",
		noProject: "Open a project first",
		linkActive: (title) => `Link “${title}”`,
		newChatTitle: "New chat",
		open: "Open",
		openChat: "Open chat",
		openChatGroup: "Chats",
		duplicate: "Duplicate",
		copyMarkdown: "Copy as Markdown",
		copied: "Copied as Markdown",
		copyFailed: "It could not be copied",
		delete: "Delete",
		deleteMany: (n) => `Delete ${n} items`,
		none: (property) => `No ${property.toLowerCase()}`
	};
	// plugins/planner/src/item/chats.ts
	/** The project a chat about this collection belongs to: its own when that is open, else the active one. */
	function projectFor(planner, collection) {
		const { workspace } = planner.mango;
		const scope = collection.scope;
		if (scope.kind === "project") {
			const own = workspace.openProjects().find((p) => projectKey(p) === projectKey(scope.path));
			if (own) return own;
		}
		return workspace.activeProject();
	}
	/** A new chat with the item in its composer, linked to it. Nothing is sent. */
	function startChat(planner, collection, item) {
		const { mango, store } = planner;
		const projectPath = projectFor(planner, collection);
		if (!projectPath) {
			mango.ui.toast({ title: strings$3.noProject });
			return false;
		}
		const now = store.item(collection.id, item.id) ?? item;
		const title = now.title.trim();
		try {
			const thread = mango.chat.create({ projectPath });
			store.linkChat(collection.id, item.id, thread.id);
			if (title) mango.chat.rename(thread.id, title);
			const text = [title, now.body.trim()].filter(Boolean).join("\n\n");
			const draft = mango.chat.draft(thread.id).trim();
			if (text) mango.chat.setDraft(thread.id, draft ? `${draft}\n\n${text}` : text);
			mango.chat.show(thread.id);
			return true;
		} catch (e) {
			mango.log.error("Starting a chat:", e);
			mango.ui.toast({
				title: strings$3.startFailed,
				body: e instanceof Error ? e.message : String(e),
				kind: "error"
			});
			return false;
		}
	}
	// plugins/planner/src/item/markdownEdit.ts
	var ITEM = /^((?:\s*>)*\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/;
	var QUOTE = /^((?:\s*>)+ ?)/;
	var TASK = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])(?=\s)/;
	var lineStart = (text, at) => text.lastIndexOf("\n", at - 1) + 1;
	var lineEnd = (text, at) => {
		const i = text.indexOf("\n", at);
		return i < 0 ? text.length : i;
	};
	/** Whether a position is inside a fenced code block. */
	function inCode(text, at) {
		let fence = null;
		for (const line of text.slice(0, lineStart(text, at)).split("\n")) fence = nextFence(line, fence);
		return fence !== null;
	}
	function nextFence(line, fence) {
		const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!m) return fence;
		if (fence === null) return m[1][0] === "`" && m[2].includes("`") ? null : m[1];
		return m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim() ? null : fence;
	}
	/** Enter: a list goes on, an empty entry of it ends it. Null: an ordinary new line. */
	function onEnter(text, start, end) {
		if (start !== end || inCode(text, start)) return null;
		const from = lineStart(text, start);
		const line = text.slice(from, lineEnd(text, start));
		const m = ITEM.exec(line) ?? QUOTE.exec(line);
		if (!m || start - from < m[0].length) return null;
		if (!line.slice(m[0].length).trim()) {
			const indent = /^\s+/.exec(line)?.[0] ?? "";
			if (m[2] && indent) return outdentLine(text, from, start);
			return {
				from,
				to: from + line.length,
				insert: "",
				start: from,
				end: from
			};
		}
		let prefix = m[0];
		if (m[2]) {
			const n = /^(\d+)([.)])$/.exec(m[2]);
			prefix = `${m[1]}${n ? `${Number(n[1]) + 1}${n[2]}` : m[2]}${m[3]}${m[4] ? "[ ] " : ""}`;
		}
		const insert = `\n${prefix}`;
		return {
			from: start,
			to: start,
			insert,
			start: start + insert.length,
			end: start + insert.length
		};
	}
	function outdentLine(text, from, caret) {
		const spaces = /^(?:\t| {1,2})/.exec(text.slice(from))?.[0].length ?? 0;
		return {
			from,
			to: from + spaces,
			insert: "",
			start: Math.max(from, caret - spaces),
			end: Math.max(from, caret - spaces)
		};
	}
	/** Tab and Shift+Tab: in a list or over several lines, its level; elsewhere Tab puts two spaces. Null: nothing to do. */
	function onTab(text, start, end, back) {
		const from = lineStart(text, start);
		const to = lineEnd(text, end > start && text[end - 1] === "\n" ? end - 1 : end);
		const lines = text.slice(from, to).split("\n");
		if (!back && start === end && !ITEM.test(lines[0])) return {
			from: start,
			to: end,
			insert: "  ",
			start: start + 2,
			end: start + 2
		};
		let first = 0;
		let total = 0;
		const next = lines.map((l, i) => {
			const cut = back ? /^(?:\t| {1,2})/.exec(l)?.[0].length ?? 0 : 0;
			const by = back ? -cut : l.trim() ? 2 : 0;
			if (i === 0) first = by;
			total += by;
			return back ? l.slice(cut) : by ? `  ${l}` : l;
		});
		if (!total) return null;
		const at = (p, by) => Math.max(from, p + by);
		return {
			from,
			to,
			insert: next.join("\n"),
			start: at(start, first),
			end: at(end, total)
		};
	}
	/** Bold, italic, code: around the selection, or taken away again. */
	function wrap(text, start, end, mark) {
		const n = mark.length;
		const chosen = text.slice(start, end);
		const before = /(\**)$/.exec(text.slice(0, start))[1].length;
		const after = /^(\**)/.exec(text.slice(end))[1].length;
		const around = Math.min(before, after);
		if (mark === "*" ? around % 2 === 1 : mark === "**" ? around >= 2 : text.slice(Math.max(0, start - n), start) === mark && text.slice(end, end + n) === mark) return {
			from: start - n,
			to: end + n,
			insert: chosen,
			start: start - n,
			end: end - n
		};
		const lead = chosen.trim() ? chosen.length - chosen.trimStart().length : 0;
		const trail = chosen.trim() ? chosen.length - chosen.trimEnd().length : 0;
		const core = chosen.slice(lead, chosen.length - trail);
		return {
			from: start,
			to: end,
			insert: `${chosen.slice(0, lead)}${mark}${core}${mark}${chosen.slice(chosen.length - trail)}`,
			start: start + lead + n,
			end: start + lead + n + core.length
		};
	}
	/** A link: the selection as its text, or as its address. */
	function link(text, start, end) {
		const chosen = text.slice(start, end);
		if (/^https?:\/\/\S+$/.test(chosen)) return {
			from: start,
			to: end,
			insert: `[](${chosen})`,
			start: start + 1,
			end: start + 1
		};
		const at = start + chosen.length + 3;
		return {
			from: start,
			to: end,
			insert: `[${chosen}](url)`,
			...chosen ? {
				start: at,
				end: at + 3
			} : {
				start: start + 1,
				end: start + 1
			}
		};
	}
	/** Every selected line becomes an entry (`- `, `- [ ] `, `1. `), or stops being one when all are. */
	function toggleList(text, start, end, kind) {
		const from = lineStart(text, start);
		const to = lineEnd(text, end > start && text[end - 1] === "\n" ? end - 1 : end);
		const lines = text.slice(from, to).split("\n");
		const isOne = (l) => {
			const m = ITEM.exec(l);
			return !!m && kind === "task" === !!m[4];
		};
		const filled = lines.filter((l) => l.trim());
		const off = filled.length > 0 && filled.every(isOne);
		const mark = kind === "task" ? "- [ ] " : "- ";
		const next = lines.map((l) => {
			if (!l.trim() && lines.length > 1) return l;
			const m = ITEM.exec(l);
			const indent = /^\s*/.exec(l)[0];
			const rest = m ? l.slice(m[0].length) : l.slice(indent.length);
			return off ? `${indent}${rest}` : `${indent}${mark}${rest}`;
		});
		const insert = next.join("\n");
		const grown = insert.length - (to - from);
		const firstGrown = next[0].length - lines[0].length;
		return start === end ? {
			from,
			to,
			insert,
			start: Math.max(from, start + firstGrown),
			end: Math.max(from, start + firstGrown)
		} : {
			from,
			to,
			insert,
			start: from,
			end: to + grown
		};
	}
	/** The task boxes of a text in order: where their mark is, and whether it is set. */
	function taskMarks(text) {
		const out = [];
		let fence = null;
		let at = 0;
		for (const line of text.split("\n")) {
			const was = fence;
			fence = nextFence(line, fence);
			const m = was === null && fence === null ? TASK.exec(line) : null;
			if (m) out.push({
				at: at + m[1].length,
				done: m[2] !== " "
			});
			at += line.length + 1;
		}
		return out;
	}
	/** The text with that task box turned. */
	function toggleTask(text, index) {
		const t = taskMarks(text)[index];
		return t ? `${text.slice(0, t.at)}${t.done ? " " : "x"}${text.slice(t.at + 1)}` : text;
	}
	// plugins/planner/src/item/ItemBody.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$36 = ["aria-label"];
	var _hoisted_2$32 = ["data-text"];
	var _hoisted_3$29 = [
		"value",
		"aria-label",
		"placeholder"
	];
	var _hoisted_4$29 = ["tabindex", "aria-label"];
	var _hoisted_5$25 = {
		key: 0,
		class: "pl-body__hint"
	};
	var _hoisted_6$22 = {
		key: 1,
		class: "selectable"
	};
	// plugins/planner/src/item/ItemBody.vue
	var ItemBody_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ItemBody",
		props: {
			collection: {},
			item: {},
			readonly: { type: Boolean }
		},
		setup(__props, { expose: __expose }) {
			const props = __props;
			const { mango, store } = usePlanner();
			const { Markdown, IconButton } = mango.ui.components;
			const editing = (0, vue.ref)(false);
			const area = (0, vue.ref)(null);
			const view = (0, vue.ref)(null);
			const isMac = mango.platform === "macos" || /Mac/.test(navigator.platform);
			const mod = isMac ? "⌘" : "Ctrl+";
			const base = (0, vue.computed)(() => props.collection.scope.kind === "project" ? props.collection.scope.path : store.projectPath.value);
			function save(body) {
				store.updateItem(props.collection.id, props.item.id, { body }, { defer: true });
			}
			async function edit(at = null) {
				if (props.readonly) return;
				editing.value = true;
				await (0, vue.nextTick)();
				const el = area.value;
				if (!el) return;
				const pos = at ?? el.value.length;
				el.focus({ preventScroll: at !== null });
				el.setSelectionRange(pos, pos);
				el.scrollIntoView({ block: "nearest" });
			}
			async function leave(refocus = false) {
				if (!editing.value) return;
				editing.value = false;
				store.flush();
				if (!refocus) return;
				await (0, vue.nextTick)();
				view.value?.focus({ preventScroll: true });
			}
			/** Not when the whole window lost the focus: it comes back where it was. */
			function onBlur(e) {
				if (!document.hasFocus() || e.relatedTarget?.closest(".pl-body__bar")) return;
				leave();
			}
			function apply(e) {
				const el = area.value;
				if (!el || !e) return false;
				el.focus();
				el.setSelectionRange(e.from, e.to);
				if (!(e.insert || e.from !== e.to ? document.execCommand(e.insert ? "insertText" : "delete", false, e.insert) : true)) {
					el.setRangeText(e.insert, e.from, e.to, "end");
					save(el.value);
				}
				el.setSelectionRange(e.start, e.end);
				return true;
			}
			function format(kind) {
				const el = area.value;
				if (!el) return;
				const { value: text, selectionStart: s, selectionEnd: e } = el;
				switch (kind) {
					case "bold": return apply(wrap(text, s, e, "**"));
					case "italic": return apply(wrap(text, s, e, "*"));
					case "code": return apply(wrap(text, s, e, "`"));
					case "link": return apply(link(text, s, e));
					default: return apply(toggleList(text, s, e, kind === "list" ? "bullet" : "task"));
				}
			}
			const FORMATS = [
				{
					kind: "bold",
					icon: "bold"
				},
				{
					kind: "italic",
					icon: "italic",
					shortcut: `${mod}I`
				},
				{
					kind: "code",
					icon: "code"
				},
				{
					kind: "link",
					icon: "link"
				},
				{
					kind: "list",
					icon: "list"
				},
				{
					kind: "tasks",
					icon: "list-checks"
				}
			];
			function onKey(e) {
				const el = area.value;
				if (!el || e.isComposing) return;
				const { value: text, selectionStart: s, selectionEnd: end } = el;
				const isMod = isMac ? e.metaKey : e.ctrlKey;
				if (isMod && !e.altKey && !e.shiftKey) {
					const kind = {
						b: "bold",
						i: "italic",
						k: "link",
						e: "code"
					}[e.key.toLowerCase()];
					if (kind) {
						e.preventDefault();
						e.stopPropagation();
						format(kind);
					} else if (e.key === "Enter") {
						e.preventDefault();
						leave(true);
					}
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					leave(true);
				} else if (e.key === "Enter" && !e.shiftKey && !isMod && !e.altKey) {
					if (apply(onEnter(text, s, end))) e.preventDefault();
				} else if (e.key === "Tab" && !isMod && !e.altKey) {
					if (apply(onTab(text, s, end, e.shiftKey))) e.preventDefault();
				}
			}
			/**
			* Where in the text a click on the rendered notes was: the same piece of text, as many times in. The end when
			* it cannot be told.
			*/
			function sourceAt(x, y) {
				const doc = document;
				const pos = document.caretPositionFromPoint?.(x, y);
				const range = pos ? null : doc.caretRangeFromPoint?.(x, y);
				const node = pos?.offsetNode ?? range?.startContainer;
				const offset = pos?.offset ?? range?.startOffset ?? 0;
				if (!(node instanceof Text) || !view.value?.contains(node) || !node.data.trim()) return null;
				let nth = 0;
				const walker = document.createTreeWalker(view.value, NodeFilter.SHOW_TEXT);
				for (let n = walker.nextNode(); n && n !== node; n = walker.nextNode()) nth += n.data.split(node.data).length - 1;
				let at = props.item.body.indexOf(node.data);
				while (nth-- > 0 && at >= 0) at = props.item.body.indexOf(node.data, at + node.data.length);
				return at < 0 ? null : at + offset;
			}
			function onViewClick(e) {
				if (e.defaultPrevented || e.target.closest("a, button, input, [data-plugin-block]")) return;
				if (!(getSelection()?.isCollapsed ?? true)) return;
				edit(sourceAt(e.clientX, e.clientY));
			}
			function onViewKey(e) {
				if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey || e.key !== "Enter") return;
				e.preventDefault();
				edit();
			}
			let pendingFocus = null;
			function boxes() {
				return [...view.value?.querySelectorAll("li input[type=\"checkbox\"]") ?? []];
			}
			function wireBoxes() {
				if (props.readonly) return;
				const all = boxes();
				if (!all.length || all.length !== taskMarks(props.item.body).length) return;
				for (const b of all) {
					b.disabled = false;
					b.setAttribute("aria-label", b.closest("li")?.innerText.split("\n")[0]?.trim() || strings$3.tasks);
				}
				if (pendingFocus !== null) {
					all[pendingFocus]?.focus({ preventScroll: true });
					pendingFocus = null;
				}
			}
			function onViewChange(e) {
				const i = boxes().indexOf(e.target);
				if (i < 0) return;
				if (document.activeElement === e.target) pendingFocus = i;
				store.updateItem(props.collection.id, props.item.id, { body: toggleTask(props.item.body, i) });
			}
			const observer = new MutationObserver(wireBoxes);
			(0, vue.watch)(view, (el) => {
				observer.disconnect();
				if (!el) return;
				observer.observe(el, {
					childList: true,
					subtree: true
				});
				wireBoxes();
			}, { flush: "post" });
			(0, vue.onMounted)(() => {
				if (view.value) {
					observer.observe(view.value, {
						childList: true,
						subtree: true
					});
					wireBoxes();
				}
			});
			(0, vue.onBeforeUnmount)(() => {
				observer.disconnect();
				if (editing.value) store.flush();
			});
			(0, vue.watch)(() => props.readonly, (v) => {
				if (v) leave();
			});
			__expose({ edit: () => edit(0) });
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("section", { class: (0, vue.normalizeClass)(["pl-body", { "is-editing": editing.value }]) }, [editing.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [(0, vue.createElementVNode)("div", {
					class: "pl-body__bar",
					role: "toolbar",
					"aria-label": (0, vue.unref)(strings$3).body
				}, [((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(FORMATS, (f) => {
					return (0, vue.createVNode)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
						key: f.kind,
						size: "sm",
						label: (0, vue.unref)(strings$3)[f.kind],
						shortcut: f.shortcut,
						onPointerdown: _cache[0] || (_cache[0] = (0, vue.withModifiers)(() => {}, ["prevent"])),
						onMousedown: _cache[1] || (_cache[1] = (0, vue.withModifiers)(() => {}, ["prevent"])),
						onClick: ($event) => format(f.kind)
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: f.icon }, null, 8, ["name"])]),
						_: 2
					}, 1064, [
						"label",
						"shortcut",
						"onClick"
					]);
				}), 64))], 8, _hoisted_1$36), (0, vue.createElementVNode)("div", {
					class: "pl-body__grow",
					"data-text": `${__props.item.body} `
				}, [(0, vue.createElementVNode)("textarea", {
					ref_key: "area",
					ref: area,
					value: __props.item.body,
					rows: "1",
					"aria-label": (0, vue.unref)(strings$3).body,
					placeholder: (0, vue.unref)(strings$3).bodyPlaceholder,
					onInput: _cache[2] || (_cache[2] = ($event) => save($event.target.value)),
					onKeydown: onKey,
					onBlur
				}, null, 40, _hoisted_3$29)], 8, _hoisted_2$32)], 64)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					key: 1,
					ref_key: "view",
					ref: view,
					class: (0, vue.normalizeClass)(["pl-body__view", {
						"is-empty": !__props.item.body.trim(),
						"is-fixed": __props.readonly
					}]),
					tabindex: __props.readonly ? void 0 : 0,
					role: "group",
					"aria-label": __props.readonly ? (0, vue.unref)(strings$3).body : (0, vue.unref)(strings$3).bodyEdit,
					onClick: onViewClick,
					onKeydown: onViewKey,
					onChange: onViewChange
				}, [!__props.item.body.trim() ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_5$25, (0, vue.toDisplayString)(__props.readonly ? (0, vue.unref)(strings$3).empty : (0, vue.unref)(strings$3).bodyPlaceholder), 1)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_6$22, [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Markdown)), {
					text: __props.item.body,
					base: base.value
				}, null, 8, ["text", "base"]))]))], 42, _hoisted_4$29))], 2);
			};
		}
	}), [["__scopeId", "data-v-f8b68696"]]);
	// plugins/planner/src/item/itemMenu.ts
	/** More choices than this do not belong in a menu. */
	var MAX_OPTIONS = 8;
	/** The menu of one item, or of several selected ones. */
	function itemMenu(planner, collection, itemIds, at, opts = {}) {
		const { mango, store } = planner;
		const items = itemIds.map((id) => store.item(collection.id, id)).filter((i) => i !== null);
		if (!items.length) return Promise.resolve();
		const ids = items.map((i) => i.id);
		const one = items.length === 1 ? items[0] : null;
		const rows = [];
		if (one) {
			const { open = (itemId) => planner.go({ itemId }) } = opts;
			if (open) rows.push({
				label: strings$3.open,
				icon: "panel-right",
				kbd: "Enter",
				onSelect: () => open(one.id)
			});
		}
		rows.push(...opts.rows ?? []);
		if (one) {
			rows.push({
				label: strings$3.startChat,
				icon: "message-square-plus",
				onSelect: () => {
					startChat(planner, collection, one);
				}
			});
			const chats = one.chats.flatMap((id) => mango.chat.get(id) ?? []).slice(-3);
			for (const t of chats) rows.push({
				label: chats.length === 1 ? strings$3.openChat : t.title || strings$3.newChatTitle,
				aside: chats.length === 1 ? t.title : void 0,
				icon: "message-square",
				onSelect: () => mango.chat.show(t.id)
			});
		}
		const status = statusOf(collection, opts.propertyId);
		if (status) {
			const set = (id) => store.updateItems(collection.id, ids, { values: { [status.id]: id } });
			const all = (id) => items.every((i) => valueOf(i, status) === id);
			status.options.forEach((o, i) => rows.push({
				label: o.name,
				checked: all(o.id),
				...i === 0 ? {
					divider: true,
					group: status.name
				} : {},
				onSelect: () => set(o.id)
			}));
			rows.push({
				label: strings$3.none(status.name),
				checked: all(null),
				onSelect: () => set(null)
			});
		}
		rows.push({
			label: strings$3.duplicate,
			icon: "copy-plus",
			divider: true,
			onSelect: () => {
				store.duplicateItems(collection.id, ids);
			}
		}, {
			label: strings$3.copyMarkdown,
			icon: "copy",
			onSelect: () => {
				copyMarkdown(planner, collection.id, ids);
			}
		}, {
			label: one ? strings$3.delete : strings$3.deleteMany(ids.length),
			icon: "trash-2",
			danger: true,
			divider: true,
			onSelect: () => {
				store.deleteItems(collection.id, ids);
				opts.deleted?.();
			}
		});
		return mango.ui.contextMenu(at, rows);
	}
	function statusOf(collection, propertyId) {
		const given = propertyId ? propertyOf(collection, propertyId) : null;
		const p = given?.type === "select" ? given : collection.properties.find((e) => e.type === "select") ?? null;
		return p && p.options.length > 0 && p.options.length <= MAX_OPTIONS ? p : null;
	}
	async function copyMarkdown(planner, collectionId, ids) {
		const { mango, store } = planner;
		try {
			const text = await store.exportMarkdown(collectionId, ids);
			if (text === null) return;
			await navigator.clipboard.writeText(text);
			mango.ui.toast({
				title: strings$3.copied,
				kind: "success",
				timeout: 2e3
			});
		} catch (e) {
			mango.log.error("Copying:", e);
			mango.ui.toast({
				title: strings$3.copyFailed,
				kind: "error"
			});
		}
	}
	// plugins/planner/src/ui/propertyIcons.ts
	var PROPERTY_ICONS = {
		text: "text-initial",
		number: "hash",
		select: "list",
		multiSelect: "tags",
		date: "calendar",
		checkbox: "square-check",
		url: "link",
		createdTime: "calendar-plus",
		updatedTime: "clock",
		unsupported: "puzzle"
	};
	// plugins/planner/src/ui/PropertyIcon.vue
	var PropertyIcon_default = /* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PropertyIcon",
		props: { type: {} },
		setup(__props) {
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, { name: (0, vue.unref)(PROPERTY_ICONS)[__props.type] }, null, 8, ["name"]);
			};
		}
	});
	// plugins/planner/src/ui/Popover.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$35 = ["aria-label"];
	/**
	* A floating panel, shown while mounted. `cover`: lies over the anchor instead of hanging from it (an editor in
	* place). What is marked `data-autofocus` (or the first control) gets the focus, and it goes back on close.
	*/
	var GAP = 4;
	var MARGIN = 8;
	var MAX_HEIGHT = 460;
	var MIN_HEIGHT = 120;
	var FOCUSABLE = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]";
	// plugins/planner/src/ui/Popover.vue
	var Popover_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "Popover",
		props: {
			anchor: {},
			width: { default: 260 },
			label: {},
			placement: { default: "bottom-start" },
			cover: { type: Boolean }
		},
		emits: ["close"],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			/** `escape`: the user backed out. `outside`: moved on. */
			const emit = __emit;
			const pop = (0, vue.ref)(null);
			const inner = (0, vue.ref)(null);
			const style = (0, vue.ref)({
				visibility: "hidden",
				left: "0",
				top: "0",
				width: `${props.width}px`
			});
			const opener = document.activeElement;
			/** The dialog it was opened from, if it was. */
			const under = hostDialogs();
			const layer = { contains: (el) => !!pop.value?.contains(el) };
			let rect = null;
			const isPoint = (a) => !(a instanceof HTMLElement);
			function place() {
				const el = inner.value;
				if (!el) return;
				const a = props.anchor;
				if (isPoint(a)) rect = {
					left: a.x,
					right: a.x,
					top: a.y,
					bottom: a.y
				};
				else if (a.isConnected || !rect) rect = a.getBoundingClientRect();
				const r = rect;
				const [vw, vh] = [window.innerWidth, window.innerHeight];
				const width = Math.min(props.width, vw - 16);
				const gap = isPoint(a) || props.cover ? 0 : GAP;
				const top = (props.cover ? r.top : r.bottom) + gap;
				const bottom = vh - (props.cover ? r.bottom : r.top) + gap;
				const below = vh - top - MARGIN;
				const above = vh - bottom - MARGIN;
				const wanted = Math.min(el.offsetHeight + 2, MAX_HEIGHT);
				const up = wanted > below && above > below;
				const left = Math.max(MARGIN, Math.min(props.placement === "bottom-end" ? r.right - width : r.left, vw - width - MARGIN));
				const clamp = (n) => `${Math.max(MARGIN, Math.min(n, vh - MARGIN - Math.min(wanted, MIN_HEIGHT)))}px`;
				style.value = {
					left: `${left}px`,
					width: `${width}px`,
					maxHeight: `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, up ? above : below))}px`,
					...up ? { bottom: clamp(bottom) } : { top: clamp(top) }
				};
			}
			function focusables() {
				return [...pop.value?.querySelectorAll(FOCUSABLE) ?? []].filter((e) => e.tabIndex >= 0 && e.offsetParent !== null);
			}
			function onWindowKey(e) {
				if (e.key !== "Escape" || e.isComposing || !isTopLayer(layer) || hostLayerOpen(under)) return;
				e.preventDefault();
				e.stopImmediatePropagation();
				emit("close", "escape");
			}
			function onKey(e) {
				e.stopPropagation();
				if (e.key !== "Tab") return;
				const all = focusables();
				const at = all.indexOf(document.activeElement);
				const next = e.shiftKey ? at <= 0 ? all.at(-1) : null : at === all.length - 1 ? all[0] : null;
				if (next) {
					e.preventDefault();
					next.focus();
				}
			}
			function onPointerDown(e) {
				const el = e.target;
				if (inOrAbove(layer, el) || inHostLayer(el, under)) return;
				const a = props.anchor;
				if (!isPoint(a) && a.contains(el)) {
					const swallow = (c) => {
						if (!a.contains(c.target)) return;
						c.preventDefault();
						c.stopPropagation();
					};
					window.addEventListener("click", swallow, {
						capture: true,
						once: true
					});
					window.addEventListener("pointerup", () => setTimeout(() => window.removeEventListener("click", swallow, true)), {
						capture: true,
						once: true
					});
				}
				emit("close", "outside");
			}
			function onScroll(e) {
				if (!pop.value?.contains(e.target)) place();
			}
			const hold = usePlanner().mango.ui.holdOverlay();
			const dropLayer = pushLayer(layer);
			const resize = new ResizeObserver(() => place());
			(0, vue.onMounted)(async () => {
				window.addEventListener("keydown", onWindowKey, true);
				window.addEventListener("pointerdown", onPointerDown, true);
				window.addEventListener("scroll", onScroll, true);
				window.addEventListener("resize", place);
				place();
				if (inner.value) resize.observe(inner.value);
				await (0, vue.nextTick)();
				(pop.value?.querySelector("[data-autofocus]") ?? focusables()[0] ?? pop.value)?.focus({ preventScroll: true });
			});
			(0, vue.onBeforeUnmount)(() => {
				hold.dispose();
				dropLayer();
				resize.disconnect();
				window.removeEventListener("keydown", onWindowKey, true);
				window.removeEventListener("pointerdown", onPointerDown, true);
				window.removeEventListener("scroll", onScroll, true);
				window.removeEventListener("resize", place);
				const now = document.activeElement;
				if ((!now || now === document.body || layer.contains(now)) && opener?.isConnected) opener.focus({ preventScroll: true });
			});
			__expose({ place });
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createBlock)(vue.Teleport, { to: "body" }, [(0, vue.createElementVNode)("div", {
					ref_key: "pop",
					ref: pop,
					class: "pl-pop",
					style: (0, vue.normalizeStyle)(style.value),
					role: "dialog",
					"aria-label": __props.label,
					"data-own-escape": "",
					tabindex: "-1",
					onKeydown: onKey
				}, [(0, vue.createElementVNode)("div", {
					ref_key: "inner",
					ref: inner
				}, [(0, vue.renderSlot)(_ctx.$slots, "default", {}, void 0, true)], 512)], 44, _hoisted_1$35)]);
			};
		}
	}), [["__scopeId", "data-v-f2b29bc6"]]);
	// plugins/planner/src/values/strings.ts
	var strings$2 = {
		edit: (name) => `Edit ${name || "property"}`,
		yes: "Yes",
		no: "No",
		openLink: "Open link",
		badLink: "Not a web address",
		saveHint: "Enter to save, Escape to cancel",
		multilineHint: "Enter to save, Shift+Enter for a new line",
		findOption: "Find or create an option",
		addOption: (word) => `Add ${word}`,
		newOption: (word) => `New ${word}`,
		editOptions: (words) => `Edit ${words}…`,
		editProperty: "Edit property…",
		editorTitle: (name) => `Edit ${name || "property"}`,
		optionCount: (n) => `${n}`,
		inUse: (n, word) => `${n} ${word} with it`,
		reorder: (name) => `Move ${name || "option"}. Arrow keys move it.`,
		deleteNamed: (name) => `Delete ${name || "option"}`,
		moveItemsTo: (n, word, option) => `Delete “${option}” and move its ${n} ${word} to`,
		noneOf: (property) => `No ${property.toLowerCase()}`,
		defaultOption: (words) => `New ${words} get`,
		nothing: "Nothing",
		gone: "This property was deleted.",
		option: "option",
		options: "options",
		create: (name) => `Create “${name}”`,
		noOptions: "No options yet. Type a name to make one.",
		editOption: (name) => `Edit ${name || "option"}`,
		optionName: "Name",
		color: "Color",
		colorOf: (name) => `Color of ${name || "option"}`,
		customColors: "Recent custom colors",
		saturation: "Saturation and brightness",
		saturationValue: (s, v) => `${s}% saturation, ${v}% brightness`,
		hue: "Hue",
		hex: "Hex color",
		colors: {
			neutral: "Neutral",
			blue: "Blue",
			green: "Green",
			yellow: "Yellow",
			orange: "Orange",
			red: "Red",
			purple: "Purple",
			pink: "Pink"
		},
		deleteOption: "Delete option",
		moveUp: "Move up",
		moveDown: "Move down",
		back: "Back",
		clear: "Clear",
		notANumber: "Enter a number",
		start: "Start",
		end: "End",
		startTime: "Start time",
		endTime: "End time",
		endDate: "End date",
		includeTime: "Include time",
		dateHint: "YYYY-MM-DD, tomorrow, +3",
		notADate: "Not a date. Try 2026-03-01, tomorrow or +3.",
		today: "Today",
		previousMonth: "Previous month",
		nextMonth: "Next month",
		newProperty: "New property",
		propertyName: "Property name",
		type: "Type",
		name: "Name",
		rename: "Rename…",
		renameTitle: "Rename property",
		changeType: "Change type…",
		hideInView: "Hide in this view",
		moveUpProperty: "Move up",
		moveDownProperty: "Move down",
		deleteProperty: "Delete property",
		deleteTitle: (name) => `Delete “${name}”?`,
		deleteBody: "Its values are removed from every item.",
		delete: "Delete",
		unsupported: "Made by a newer version of the planner",
		typeHint: {
			text: "Plain text",
			number: "A number",
			select: "One of a list",
			multiSelect: "Several of a list",
			date: "A day, a time or a range",
			checkbox: "Yes or no",
			url: "A web address",
			createdTime: "Filled in by itself",
			updatedTime: "Filled in by itself",
			unsupported: ""
		}
	};
	// plugins/planner/src/values/AddProperty.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$34 = { class: "pl-add" };
	var _hoisted_2$31 = [
		"aria-activedescendant",
		"aria-label",
		"placeholder"
	];
	var _hoisted_3$28 = ["aria-label"];
	var _hoisted_4$28 = [
		"id",
		"aria-selected",
		"title",
		"onPointermove",
		"onClick"
	];
	// plugins/planner/src/values/AddProperty.vue
	var AddProperty_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "AddProperty",
		props: {
			collectionId: {},
			anchor: {}
		},
		emits: ["close", "added"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store } = usePlanner();
			const name = (0, vue.ref)("");
			const active = (0, vue.ref)(0);
			const list = (0, vue.ref)(null);
			const types = PROPERTY_TYPES;
			const activeId = (0, vue.computed)(() => `pl-add-${types[active.value]}`);
			function add(type) {
				const made = store.addProperty(props.collectionId, {
					name: name.value.trim() || freeName(strings$5.propertyTypes[type]),
					type
				});
				emit("close");
				if (made) emit("added", made);
			}
			function freeName(base) {
				const taken = new Set(store.collection(props.collectionId)?.properties.map((p) => p.name.trim().toLowerCase()));
				for (let i = 1;; i++) {
					const n = i === 1 ? base : `${base} ${i}`;
					if (!taken.has(n.toLowerCase())) return n;
				}
			}
			function onKey(e) {
				if (e.isComposing) return;
				if (e.key === "ArrowDown") active.value = (active.value + 1) % types.length;
				else if (e.key === "ArrowUp") active.value = (active.value - 1 + types.length) % types.length;
				else if (e.key === "Enter") add(types[active.value]);
				else return;
				e.preventDefault();
				(0, vue.nextTick)(() => list.value?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }));
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
					anchor: __props.anchor,
					width: 240,
					label: (0, vue.unref)(strings$2).newProperty,
					onClose: _cache[1] || (_cache[1] = ($event) => emit("close"))
				}, {
					default: (0, vue.withCtx)(() => [(0, vue.createElementVNode)("div", _hoisted_1$34, [(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
						"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => name.value = $event),
						class: "pl-add__name",
						"data-autofocus": "",
						role: "combobox",
						"aria-expanded": "true",
						"aria-controls": "pl-add-types",
						"aria-activedescendant": activeId.value,
						"aria-label": (0, vue.unref)(strings$2).propertyName,
						placeholder: (0, vue.unref)(strings$2).propertyName,
						autocomplete: "off",
						onKeydown: onKey
					}, null, 40, _hoisted_2$31), [[vue.vModelText, name.value]]), (0, vue.createElementVNode)("div", {
						id: "pl-add-types",
						ref_key: "list",
						ref: list,
						class: "pl-add__list",
						role: "listbox",
						"aria-label": (0, vue.unref)(strings$2).type
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)((0, vue.unref)(types), (t, i) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							id: `pl-add-${t}`,
							key: t,
							class: (0, vue.normalizeClass)(["pl-add__row", { "is-active": i === active.value }]),
							role: "option",
							"aria-selected": i === active.value,
							title: (0, vue.unref)(strings$2).typeHint[t],
							onPointermove: ($event) => active.value = i,
							onClick: ($event) => add(t)
						}, [(0, vue.createVNode)(PropertyIcon_default, {
							type: t,
							class: "pl-add__icon"
						}, null, 8, ["type"]), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings$5).propertyTypes[t]), 1)], 42, _hoisted_4$28);
					}), 128))], 8, _hoisted_3$28)])]),
					_: 1
				}, 8, ["anchor", "label"]);
			};
		}
	}), [["__scopeId", "data-v-ed65ec1f"]]);
	// plugins/planner/src/ui/colors.ts
	/** The planner's colours as CSS values that work in both themes, whatever colour the user made up. */
	/** Categories, not chat states: the file tints, so nothing here reads as a chat's status. */
	var TOKENS = {
		blue: "var(--file-blue)",
		green: "var(--file-green)",
		yellow: "var(--file-yellow)",
		orange: "var(--file-orange)",
		red: "var(--file-red)",
		purple: "var(--file-purple)",
		pink: "color-mix(in oklab, var(--file-red) 50%, var(--file-purple))"
	};
	/**
	* How far a colour may go, as OKLCH lightness: text dark enough for light grounds and light enough for dark ones,
	* marks a little less so. `chroma` keeps a glaring colour inside what screens show. Fills take only the hue, at one
	* lightness, so black and white do not make a hole or a glare: `tint`, `strong` and `line` are how much of it.
	* tests/plannerColors.test.ts measures the contrast these give.
	*/
	var LIMITS = {
		text: {
			light: .46,
			dark: .79,
			chroma: .15
		},
		mark: {
			light: .63,
			dark: .56,
			chroma: .2
		},
		fill: .65,
		tint: 8,
		strong: 18,
		line: 28
	};
	/** The colour with its lightness held back for each theme (`color-scheme` follows Mango's). */
	var held = (color, l) => `light-dark(oklch(from ${color} min(l, ${l.light}) min(c, ${l.chroma}) h), oklch(from ${color} max(l, ${l.dark}) min(c, ${l.chroma}) h))`;
	var NEUTRAL = {
		dot: "var(--fg-faint)",
		fg: "var(--fg-muted)",
		tint: "var(--bg-panel)",
		line: "var(--line-soft)",
		strong: "var(--bg-active)"
	};
	var made = /* @__PURE__ */ new Map();
	function colorVar(color) {
		if (color === "neutral") return NEUTRAL;
		let vars = made.get(color);
		if (!vars) {
			const source = isCustomColor(color) ? color : TOKENS[color];
			const dot = held(source, LIMITS.mark);
			const fill = `oklch(from ${source} ${LIMITS.fill} min(c, ${LIMITS.mark.chroma}) h)`;
			const mix = (percent, ground) => `color-mix(in oklab, ${fill} ${percent}%, var(${ground}))`;
			vars = {
				dot,
				fg: held(source, LIMITS.text),
				tint: mix(LIMITS.tint, "--bg-panel"),
				line: mix(LIMITS.line, "--line-soft"),
				strong: mix(LIMITS.strong, "--bg-panel")
			};
			if (made.size > 500) made.clear();
			made.set(color, vars);
		}
		return vars;
	}
	/** The colour itself, not held back: in the picker. */
	var rawColor = (color) => color === "neutral" ? NEUTRAL.dot : isCustomColor(color) ? color : TOKENS[color];
	// plugins/planner/src/ui/hsv.ts
	function hexToHsv(hex) {
		const [r, g, b] = [
			1,
			3,
			5
		].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
		const max = Math.max(r, g, b);
		const d = max - Math.min(r, g, b);
		return {
			h: (d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60,
			s: max === 0 ? 0 : d / max,
			v: max
		};
	}
	function hsvToHex({ h, s, v }) {
		const part = (n) => {
			const k = (n + h / 60) % 6;
			const x = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
			return Math.round(x * 255).toString(16).padStart(2, "0");
		};
		return `#${part(5)}${part(3)}${part(1)}`;
	}
	// plugins/planner/src/ui/ColorPicker.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$33 = ["aria-label"];
	var _hoisted_2$30 = ["aria-label"];
	var _hoisted_3$27 = [
		"aria-checked",
		"aria-label",
		"title",
		"tabindex",
		"data-autofocus",
		"onClick",
		"onKeydown"
	];
	var _hoisted_4$27 = [
		"aria-label",
		"aria-valuenow",
		"aria-valuetext"
	];
	var _hoisted_5$24 = ["value", "aria-label"];
	var _hoisted_6$21 = [
		"value",
		"aria-label",
		"aria-invalid"
	];
	/**
	* A named colour or any other. `update:modelValue` follows every move (save it deferred), `change` comes once it is
	* settled (flush it). Also when it closes in the middle of one.
	*/
	var RECENT = "recentColors";
	var RECENT_MAX = 8;
	// plugins/planner/src/ui/ColorPicker.vue
	var ColorPicker_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ColorPicker",
		props: {
			modelValue: {},
			label: {}
		},
		emits: ["update:modelValue", "change"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { mango } = usePlanner();
			function readRecent() {
				const kept = mango.storage.get(RECENT);
				return (Array.isArray(kept) ? kept : []).map(readColor).filter((c) => c !== null && isCustomColor(c)).slice(0, RECENT_MAX);
			}
			const recent = (0, vue.ref)(readRecent());
			const root = (0, vue.ref)(null);
			const area = (0, vue.ref)(null);
			/** What a token is on screen right now, so that a custom colour starts from the named one. */
			function shownHex(color) {
				if (isCustomColor(color)) return color;
				try {
					const probe = document.createElement("span");
					probe.style.color = rawColor(color);
					document.body.append(probe);
					const css = getComputedStyle(probe).color;
					probe.remove();
					const ctx = document.createElement("canvas").getContext("2d");
					ctx.fillStyle = css;
					ctx.fillRect(0, 0, 1, 1);
					const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
					return `#${[
						r,
						g,
						b
					].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
				} catch {
					return "#808080";
				}
			}
			/** Kept apart from the hex, which forgets the hue of greys. */
			const hsv = (0, vue.ref)(hexToHsv(shownHex(props.modelValue)));
			const hexText = (0, vue.ref)(isCustomColor(props.modelValue) ? props.modelValue : "");
			const hexBad = (0, vue.ref)(false);
			(0, vue.watch)(() => props.modelValue, (c) => {
				hexBad.value = false;
				if (!isCustomColor(c)) hexText.value = "";
				else if (hsvToHex(hsv.value) !== c) {
					hexText.value = c;
					hsv.value = hexToHsv(c);
				}
			});
			let pending = null;
			function live(color) {
				pending = color;
				emit("update:modelValue", color);
			}
			function settle() {
				if (pending === null) return;
				const color = pending;
				pending = null;
				if (isCustomColor(color)) {
					recent.value = [color, ...readRecent().filter((c) => c !== color)].slice(0, RECENT_MAX);
					mango.storage.set(RECENT, [...recent.value]);
				}
				emit("change", color);
			}
			function choose(color) {
				hsv.value = hexToHsv(shownHex(color));
				live(color);
				settle();
			}
			function setHsv(next) {
				hsv.value = {
					...hsv.value,
					...next
				};
				const hex = hsvToHex(hsv.value);
				hexText.value = hex;
				live(hex);
			}
			(0, vue.onBeforeUnmount)(settle);
			const hue = (0, vue.computed)(() => `hsl(${hsv.value.h} 100% 50%)`);
			const clamp = (n) => Math.min(1, Math.max(0, n));
			let dragging = false;
			function toPoint(e) {
				const r = area.value.getBoundingClientRect();
				setHsv({
					s: clamp((e.clientX - r.left) / r.width),
					v: 1 - clamp((e.clientY - r.top) / r.height)
				});
			}
			function onDown(e) {
				if (e.button !== 0) return;
				dragging = true;
				e.currentTarget.setPointerCapture(e.pointerId);
				toPoint(e);
			}
			function onMove(e) {
				if (dragging) toPoint(e);
			}
			function onUp() {
				if (!dragging) return;
				dragging = false;
				settle();
			}
			function onAreaKey(e) {
				const by = e.shiftKey ? .1 : .02;
				const { s, v } = hsv.value;
				const next = {
					ArrowLeft: { s: s - by },
					ArrowRight: { s: s + by },
					ArrowUp: { v: v + by },
					ArrowDown: { v: v - by }
				}[e.key];
				if (!next) return;
				e.preventDefault();
				setHsv({
					s: clamp(next.s ?? s),
					v: clamp(next.v ?? v)
				});
			}
			function onKeyUp(e) {
				if (e.key.startsWith("Arrow") || [
					"Home",
					"End",
					"PageUp",
					"PageDown"
				].includes(e.key)) settle();
			}
			function typeHex(e) {
				hexText.value = e.target.value;
				hexBad.value = false;
				if (hexText.value.trim().replace("#", "").length === 6) takeHex(false);
			}
			function takeHex(done) {
				const t = hexText.value.trim();
				const c = t ? readColor(t) : null;
				if (c && isCustomColor(c)) {
					if (c !== props.modelValue || pending) {
						hsv.value = hexToHsv(c);
						live(c);
					}
					if (done) {
						hexText.value = c;
						settle();
					}
				} else if (done && t) hexBad.value = true;
			}
			const swatches = (0, vue.computed)(() => [...NAMED_COLORS, ...recent.value]);
			const nameOf = (c) => isCustomColor(c) ? c : strings$2.colors[c];
			const tabStop = (0, vue.computed)(() => swatches.value.includes(props.modelValue) ? props.modelValue : "neutral");
			function onSwatchKey(e, i) {
				const n = swatches.value.length;
				const to = {
					ArrowRight: i + 1,
					ArrowLeft: i - 1,
					ArrowDown: i + 8,
					ArrowUp: i - 8
				}[e.key];
				if (to === void 0) return;
				e.preventDefault();
				const next = e.key === "ArrowDown" || e.key === "ArrowUp" ? Math.min(n - 1, Math.max(0, to)) : (to + n) % n;
				root.value?.querySelectorAll(".pl-color__swatch")[next]?.focus();
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					ref_key: "root",
					ref: root,
					class: "pl-color",
					role: "group",
					"aria-label": __props.label
				}, [
					(0, vue.createElementVNode)("div", {
						class: "pl-color__swatches",
						role: "radiogroup",
						"aria-label": __props.label
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(swatches.value, (c, i) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: c,
							type: "button",
							role: "radio",
							class: "pl-color__swatch",
							"aria-checked": c === __props.modelValue,
							"aria-label": nameOf(c),
							title: nameOf(c),
							tabindex: c === tabStop.value ? 0 : -1,
							"data-autofocus": c === tabStop.value ? "" : void 0,
							onClick: ($event) => choose(c),
							onKeydown: ($event) => onSwatchKey($event, i)
						}, [(0, vue.createElementVNode)("span", { style: (0, vue.normalizeStyle)({ background: (0, vue.unref)(isCustomColor)(c) ? c : (0, vue.unref)(colorVar)(c).dot }) }, null, 4)], 40, _hoisted_3$27);
					}), 128))], 8, _hoisted_2$30),
					(0, vue.createElementVNode)("div", {
						ref_key: "area",
						ref: area,
						class: "pl-color__area",
						role: "slider",
						tabindex: "0",
						"aria-label": (0, vue.unref)(strings$2).saturation,
						"aria-valuenow": Math.round(hsv.value.s * 100),
						"aria-valuemin": "0",
						"aria-valuemax": "100",
						"aria-valuetext": (0, vue.unref)(strings$2).saturationValue(Math.round(hsv.value.s * 100), Math.round(hsv.value.v * 100)),
						style: (0, vue.normalizeStyle)({ "--pl-hue": hue.value }),
						onPointerdown: onDown,
						onPointermove: onMove,
						onPointerup: onUp,
						onPointercancel: onUp,
						onKeydown: onAreaKey,
						onKeyup: onKeyUp,
						onBlur: settle
					}, [(0, vue.createElementVNode)("span", {
						class: "pl-color__thumb",
						style: (0, vue.normalizeStyle)({
							left: `${hsv.value.s * 100}%`,
							top: `${(1 - hsv.value.v) * 100}%`,
							background: (0, vue.unref)(hsvToHex)(hsv.value)
						})
					}, null, 4)], 44, _hoisted_4$27),
					(0, vue.createElementVNode)("input", {
						type: "range",
						class: "pl-color__hue",
						min: "0",
						max: "359",
						step: "1",
						value: Math.round(hsv.value.h) % 360,
						"aria-label": (0, vue.unref)(strings$2).hue,
						onInput: _cache[0] || (_cache[0] = ($event) => setHsv({ h: Number($event.target.value) })),
						onChange: settle
					}, null, 40, _hoisted_5$24),
					(0, vue.createElementVNode)("label", { class: (0, vue.normalizeClass)(["pl-color__hex", { "is-bad": hexBad.value }]) }, [(0, vue.createElementVNode)("span", {
						style: (0, vue.normalizeStyle)({ background: (0, vue.unref)(rawColor)(__props.modelValue) }),
						"aria-hidden": "true"
					}, null, 4), (0, vue.createElementVNode)("input", {
						value: hexText.value,
						type: "text",
						maxlength: "9",
						spellcheck: "false",
						autocomplete: "off",
						placeholder: "#rrggbb",
						"aria-label": (0, vue.unref)(strings$2).hex,
						"aria-invalid": hexBad.value || void 0,
						onInput: typeHex,
						onChange: _cache[1] || (_cache[1] = ($event) => takeHex(true)),
						onKeydown: _cache[2] || (_cache[2] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => takeHex(true), ["prevent"]), ["enter"]))
					}, null, 40, _hoisted_6$21)], 2)
				], 8, _hoisted_1$33);
			};
		}
	}), [["__scopeId", "data-v-e35e2cff"]]);
	// plugins/planner/src/ui/ColorButton.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$32 = [
		"aria-label",
		"title",
		"aria-expanded",
		"disabled"
	];
	// plugins/planner/src/ui/ColorButton.vue
	var ColorButton_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ColorButton",
		props: {
			modelValue: {},
			label: {},
			disabled: { type: Boolean }
		},
		emits: ["update:modelValue", "change"],
		setup(__props, { emit: __emit }) {
			const emit = __emit;
			const anchor = (0, vue.shallowRef)(null);
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, null, [(0, vue.createElementVNode)("button", {
					type: "button",
					class: "pl-colorbtn",
					"aria-label": __props.label,
					title: __props.label,
					"aria-haspopup": "dialog",
					"aria-expanded": !!anchor.value,
					disabled: __props.disabled,
					onClick: _cache[0] || (_cache[0] = ($event) => anchor.value = $event.currentTarget)
				}, [(0, vue.createElementVNode)("span", { style: (0, vue.normalizeStyle)({ background: (0, vue.unref)(colorVar)(__props.modelValue).dot }) }, null, 4)], 8, _hoisted_1$32), anchor.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
					key: 0,
					anchor: anchor.value,
					width: 236,
					label: __props.label,
					onClose: _cache[3] || (_cache[3] = ($event) => anchor.value = null)
				}, {
					default: (0, vue.withCtx)(() => [(0, vue.createVNode)(ColorPicker_default, {
						"model-value": __props.modelValue,
						label: __props.label,
						"onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => emit("update:modelValue", $event)),
						onChange: _cache[2] || (_cache[2] = ($event) => emit("change", $event))
					}, null, 8, ["model-value", "label"])]),
					_: 1
				}, 8, ["anchor", "label"])) : (0, vue.createCommentVNode)("v-if", true)], 64);
			};
		}
	}), [["__scopeId", "data-v-48db138d"]]);
	// plugins/planner/src/ui/PickPopover.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$31 = ["aria-label", "aria-activedescendant"];
	var _hoisted_2$29 = {
		key: 0,
		class: "pl-pick__head"
	};
	var _hoisted_3$26 = [
		"id",
		"aria-selected",
		"onPointermove",
		"onClick"
	];
	var _hoisted_4$26 = { class: "pl-pick__label" };
	// plugins/planner/src/ui/PickPopover.vue
	var PickPopover_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PickPopover",
		props: {
			rows: {},
			anchor: {},
			label: {},
			heading: {},
			width: {}
		},
		emits: ["close", "pick"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const active = (0, vue.ref)(Math.max(0, props.rows.findIndex((r) => r.checked)));
			const list = (0, vue.ref)(null);
			const reveal = () => void (0, vue.nextTick)(() => list.value?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }));
			(0, vue.onMounted)(reveal);
			function pick(id) {
				if (id === void 0) return;
				emit("close");
				emit("pick", id);
			}
			function onKey(e) {
				const n = props.rows.length;
				if (!n) return;
				if (e.key === "ArrowDown") active.value = (active.value + 1) % n;
				else if (e.key === "ArrowUp") active.value = (active.value - 1 + n) % n;
				else if (e.key === "Home") active.value = 0;
				else if (e.key === "End") active.value = n - 1;
				else if (e.key === "Enter" || e.key === " ") pick(props.rows[active.value]?.id);
				else if (e.key === "Tab") emit("close");
				else return;
				e.preventDefault();
				reveal();
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
					anchor: __props.anchor,
					width: __props.width ?? 220,
					label: __props.label,
					onClose: _cache[0] || (_cache[0] = ($event) => emit("close"))
				}, {
					default: (0, vue.withCtx)(() => [(0, vue.createElementVNode)("div", {
						ref_key: "list",
						ref: list,
						class: "pl-pick",
						role: "listbox",
						"aria-label": __props.heading ?? __props.label,
						tabindex: "0",
						"data-autofocus": "",
						"aria-activedescendant": __props.rows[active.value] ? `pl-pick-${__props.rows[active.value].id}` : void 0,
						onKeydown: onKey
					}, [__props.heading ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_2$29, (0, vue.toDisplayString)(__props.heading), 1)) : (0, vue.createCommentVNode)("v-if", true), ((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(__props.rows, (r, i) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							id: `pl-pick-${r.id}`,
							key: r.id,
							class: (0, vue.normalizeClass)(["pl-pick__row", { "is-active": i === active.value }]),
							role: "option",
							"aria-selected": !!r.checked,
							onPointermove: ($event) => active.value = i,
							onClick: ($event) => pick(r.id)
						}, [
							r.color ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
								key: 0,
								class: "pl-pick__dot",
								style: (0, vue.normalizeStyle)({ background: (0, vue.unref)(colorVar)(r.color).dot }),
								"aria-hidden": "true"
							}, null, 4)) : r.icon ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
								key: 1,
								name: r.icon,
								class: "pl-pick__icon"
							}, null, 8, ["name"])) : (0, vue.createCommentVNode)("v-if", true),
							(0, vue.createElementVNode)("span", _hoisted_4$26, (0, vue.toDisplayString)(r.label), 1),
							r.checked ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
								key: 2,
								name: "check",
								class: "pl-pick__check"
							})) : (0, vue.createCommentVNode)("v-if", true)
						], 42, _hoisted_3$26);
					}), 128))], 40, _hoisted_1$31)]),
					_: 1
				}, 8, [
					"anchor",
					"width",
					"label"
				]);
			};
		}
	}), [["__scopeId", "data-v-64a59b01"]]);
	// plugins/planner/src/values/useOptionCounts.ts
	/** How many items have each option, by option id; null until the items are read. */
	function useOptionCounts(collectionId, propertyId) {
		const { store } = usePlanner();
		return (0, vue.computed)(() => {
			const c = store.collection(collectionId());
			const p = c && propertyOf(c, propertyId());
			const state = store.items(collectionId());
			if (!p || state.status !== "ready") return null;
			const out = /* @__PURE__ */ new Map();
			for (const item of state.items) {
				const v = valueOf(item, p);
				for (const id of Array.isArray(v) ? v : typeof v === "string" ? [v] : []) out.set(id, (out.get(id) ?? 0) + 1);
			}
			return out;
		});
	}
	// plugins/planner/src/values/DeleteOption.vue?vue&type=script&setup=true&lang.ts
	/** Deletes an option: at once when no item has it, else asks which one those get. Undo is in the toast. */
	var NONE$2 = "-";
	// plugins/planner/src/values/DeleteOption.vue
	var DeleteOption_default = /* @__PURE__ */ (0, vue.defineComponent)({
		__name: "DeleteOption",
		props: {
			collectionId: {},
			propertyId: {},
			optionId: {},
			anchor: {}
		},
		emits: ["close", "deleted"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store } = usePlanner();
			const collection = (0, vue.computed)(() => store.collection(props.collectionId));
			const property = (0, vue.computed)(() => collection.value && propertyOf(collection.value, props.propertyId));
			const option = (0, vue.computed)(() => property.value?.options.find((o) => o.id === props.optionId) ?? null);
			const counts = useOptionCounts(() => props.collectionId, () => props.propertyId);
			const count = (0, vue.computed)(() => counts.value?.get(props.optionId) ?? 0);
			const rows = (0, vue.computed)(() => [...(property.value?.options ?? []).filter((o) => o.id !== props.optionId).map((o) => ({
				id: o.id,
				label: o.name,
				color: o.color
			})), {
				id: NONE$2,
				label: strings$2.noneOf(property.value?.name ?? ""),
				color: "neutral"
			}]);
			async function remove(moveTo) {
				if (await store.deleteOption(props.collectionId, props.propertyId, props.optionId, { moveTo })) emit("deleted");
			}
			(0, vue.onMounted)(async () => {
				const known = counts.value !== null || await store.loadItems(props.collectionId);
				if (known && count.value > 0 && option.value) return;
				emit("close");
				if (known) remove(null);
			});
			return (_ctx, _cache) => {
				return option.value && count.value > 0 ? ((0, vue.openBlock)(), (0, vue.createBlock)(PickPopover_default, {
					key: 0,
					rows: rows.value,
					anchor: __props.anchor,
					width: 240,
					label: (0, vue.unref)(strings$2).deleteNamed(option.value.name),
					heading: (0, vue.unref)(strings$2).moveItemsTo(count.value, (0, vue.unref)(itemWord)(collection.value, count.value), option.value.name),
					onClose: _cache[0] || (_cache[0] = ($event) => emit("close")),
					onPick: _cache[1] || (_cache[1] = ($event) => remove($event === NONE$2 ? null : $event))
				}, null, 8, [
					"rows",
					"anchor",
					"label",
					"heading"
				])) : (0, vue.createCommentVNode)("v-if", true);
			};
		}
	});
	// plugins/planner/src/values/optionWords.ts
	function optionWords(property) {
		const name = property.name.trim().toLowerCase();
		if (!/^[a-z][a-z -]{1,23}$/.test(name)) return {
			one: strings$2.option,
			many: strings$2.options
		};
		if (/(?:ss|us|is|x|ch|sh)$/.test(name)) return {
			one: name,
			many: `${name}es`
		};
		if (/[^aeiou]ies$/.test(name)) return {
			one: name.replace(/ies$/, "y"),
			many: name
		};
		if (/(?:sses|uses|xes|ches|shes)$/.test(name)) return {
			one: name.replace(/es$/, ""),
			many: name
		};
		if (name.endsWith("s")) return {
			one: name.slice(0, -1),
			many: name
		};
		if (/[^aeiou]y$/.test(name)) return {
			one: name,
			many: name.replace(/y$/, "ies")
		};
		return {
			one: name,
			many: `${name}s`
		};
	}
	// plugins/planner/src/values/PropertyEditor.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$30 = {
		key: 0,
		class: "pl-pe__gone"
	};
	var _hoisted_2$28 = {
		key: 1,
		class: "pl-pe"
	};
	var _hoisted_3$25 = { class: "pl-pe__top" };
	var _hoisted_4$25 = { class: "pl-pe__field" };
	var _hoisted_5$23 = { class: "pl-pe__label" };
	var _hoisted_6$20 = ["value", "readonly"];
	var _hoisted_7$18 = { class: "pl-pe__field" };
	var _hoisted_8$17 = { class: "pl-pe__label" };
	var _hoisted_9$15 = ["disabled"];
	var _hoisted_10$14 = ["aria-label"];
	var _hoisted_11$11 = ["data-option"];
	var _hoisted_12$10 = [
		"aria-label",
		"title",
		"disabled",
		"onPointerdown",
		"onKeydown"
	];
	var _hoisted_13$8 = [
		"value",
		"readonly",
		"aria-label",
		"onInput",
		"onBlur",
		"onKeydown"
	];
	var _hoisted_14$6 = ["title"];
	var _hoisted_15$6 = {
		key: 0,
		class: "pl-pe__default"
	};
	var _hoisted_16$5 = { class: "pl-pe__label" };
	var _hoisted_17$4 = ["disabled"];
	/** A property: name, type and, for a select, its options. Every change is kept at once. `gone`: it was deleted. */
	var NONE$1 = "-";
	// plugins/planner/src/values/PropertyEditor.vue
	var PropertyEditor_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PropertyEditor",
		props: {
			collectionId: {},
			propertyId: {}
		},
		emits: ["gone"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { mango, store } = usePlanner();
			const { IconButton } = mango.ui.components;
			const collection = (0, vue.computed)(() => store.collection(props.collectionId));
			const property = (0, vue.computed)(() => (collection.value && propertyOf(collection.value, props.propertyId)) ?? null);
			const readonly = (0, vue.computed)(() => store.sourceStatus.value.readonly);
			const words = (0, vue.computed)(() => optionWords(property.value ?? { name: "" }));
			const counts = useOptionCounts(() => props.collectionId, () => props.propertyId);
			(0, vue.watch)(property, (p) => {
				if (!p) emit("gone");
			});
			(0, vue.onBeforeUnmount)(() => {
				store.flush();
			});
			function rename(e) {
				const name = e.target.value;
				if (name.trim()) store.renameProperty(props.collectionId, props.propertyId, name, { defer: true });
			}
			/** Without spaces around it; an emptied name is taken back. */
			function settleName(e, name, set) {
				const trimmed = name.trim();
				if (trimmed !== name) set(trimmed);
				e.target.value = trimmed;
				store.flush();
			}
			const typeAt = (0, vue.shallowRef)(null);
			const typeRows = (0, vue.computed)(() => PROPERTY_TYPES.map((t) => ({
				id: t,
				label: strings$5.propertyTypes[t],
				icon: PROPERTY_ICONS[t],
				checked: t === property.value?.type
			})));
			const defaultAt = (0, vue.shallowRef)(null);
			const defaultOption = (0, vue.computed)(() => property.value?.options.find((o) => o.id === property.value?.defaultOption) ?? null);
			const defaultRows = (0, vue.computed)(() => [{
				id: NONE$1,
				label: strings$2.nothing,
				color: "neutral",
				checked: !defaultOption.value
			}, ...(property.value?.options ?? []).map((o) => ({
				id: o.id,
				label: o.name,
				color: o.color,
				checked: o.id === defaultOption.value?.id
			}))]);
			const list = (0, vue.ref)(null);
			const deleting = (0, vue.shallowRef)(null);
			function setOption(o, change) {
				store.updateOption(props.collectionId, props.propertyId, o.id, change, { defer: true });
			}
			function renameOption(o, e) {
				const name = e.target.value;
				if (name.trim()) setOption(o, { name });
			}
			async function add() {
				const p = property.value;
				if (!p) return;
				const taken = new Set(p.options.map((o) => o.name.trim().toLowerCase()));
				const base = strings$2.newOption(words.value.one);
				let name = base;
				for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
				const made = store.addOption(props.collectionId, props.propertyId, name, colorAt(p.options.length));
				if (!made) return;
				await (0, vue.nextTick)();
				const el = list.value?.querySelector(`[data-option="${CSS.escape(made.id)}"] input`);
				el?.scrollIntoView({ block: "nearest" });
				el?.select();
			}
			function afterDelete(at) {
				(0, vue.nextTick)(() => {
					const inputs = list.value?.querySelectorAll(".pl-pe__opt input");
					inputs?.[Math.min(at, inputs.length - 1)]?.focus();
				});
			}
			const drag = (0, vue.ref)(null);
			const options = (0, vue.computed)(() => {
				const all = property.value?.options ?? [];
				const d = drag.value;
				if (!d) return [...all];
				return d.ids.flatMap((id) => all.find((o) => o.id === id) ?? []);
			});
			let stop = null;
			function startDrag(o, e) {
				if (e.button !== 0 || readonly.value) return;
				e.preventDefault();
				const handle = e.currentTarget;
				handle.focus();
				const hold = mango.ui.holdOverlay();
				drag.value = {
					id: o.id,
					ids: options.value.map((x) => x.id)
				};
				const move = (m) => {
					const d = drag.value;
					const rows = [...list.value?.querySelectorAll(".pl-pe__opt") ?? []];
					if (!d || !rows.length) return;
					let to = rows.findIndex((r) => {
						const b = r.getBoundingClientRect();
						return m.clientY < b.bottom;
					});
					if (to < 0) to = rows.length - 1;
					const from = d.ids.indexOf(d.id);
					if (to === from) return;
					const ids = d.ids.filter((id) => id !== d.id);
					ids.splice(to, 0, d.id);
					drag.value = {
						id: d.id,
						ids
					};
					(0, vue.nextTick)(() => list.value?.querySelector(`[data-option="${CSS.escape(d.id)}"] .pl-pe__handle`)?.focus());
				};
				const end = (keep) => {
					stop?.();
					const d = drag.value;
					drag.value = null;
					if (keep && d) moveTo(d.id, d.ids.indexOf(d.id));
				};
				const up = () => end(true);
				const cancel = () => end(false);
				const key = (k) => {
					if (k.key !== "Escape") return;
					k.preventDefault();
					k.stopImmediatePropagation();
					end(false);
				};
				handle.setAttribute("data-own-escape", "");
				stop = () => {
					stop = null;
					hold.dispose();
					handle.removeAttribute("data-own-escape");
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
					window.removeEventListener("pointercancel", cancel);
					window.removeEventListener("keydown", key, true);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
				window.addEventListener("pointercancel", cancel);
				window.addEventListener("keydown", key, true);
			}
			(0, vue.onBeforeUnmount)(() => stop?.());
			function moveTo(id, to) {
				const all = property.value?.options ?? [];
				const from = all.findIndex((o) => o.id === id);
				const other = all[to];
				if (from < 0 || !other || from === to) return;
				store.moveOption(props.collectionId, props.propertyId, id, to < from ? { before: other.id } : { after: other.id });
			}
			function onHandleKey(o, i, e) {
				const to = {
					ArrowUp: i - 1,
					ArrowDown: i + 1,
					Home: 0,
					End: options.value.length - 1
				}[e.key];
				if (to === void 0 || drag.value) return;
				e.preventDefault();
				const handle = e.currentTarget;
				moveTo(o.id, Math.max(0, Math.min(options.value.length - 1, to)));
				(0, vue.nextTick)(() => handle.focus());
			}
			return (_ctx, _cache) => {
				return !property.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_1$30, (0, vue.toDisplayString)((0, vue.unref)(strings$2).gone), 1)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_2$28, [
					(0, vue.createElementVNode)("div", _hoisted_3$25, [(0, vue.createElementVNode)("label", _hoisted_4$25, [(0, vue.createElementVNode)("span", _hoisted_5$23, (0, vue.toDisplayString)((0, vue.unref)(strings$2).name), 1), (0, vue.createElementVNode)("input", {
						class: "pl-pe__input",
						value: property.value.name,
						readonly: readonly.value,
						spellcheck: "false",
						autocomplete: "off",
						onInput: rename,
						onBlur: _cache[0] || (_cache[0] = ($event) => settleName($event, property.value.name, (name) => (0, vue.unref)(store).renameProperty(__props.collectionId, __props.propertyId, name, { defer: true })))
					}, null, 40, _hoisted_6$20)]), (0, vue.createElementVNode)("div", _hoisted_7$18, [(0, vue.createElementVNode)("span", _hoisted_8$17, (0, vue.toDisplayString)((0, vue.unref)(strings$2).type), 1), (0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-pe__pick",
						"aria-haspopup": "listbox",
						disabled: readonly.value || property.value.type === "unsupported",
						onClick: _cache[1] || (_cache[1] = ($event) => typeAt.value = $event.currentTarget)
					}, [
						(0, vue.createVNode)(PropertyIcon_default, { type: property.value.type }, null, 8, ["type"]),
						(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings$5).propertyTypes[property.value.type]), 1),
						(0, vue.createVNode)(Icon_default, { name: "chevron-down" })
					], 8, _hoisted_9$15)])]),
					(0, vue.unref)(hasOptions)(property.value) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [(0, vue.createElementVNode)("div", {
						ref_key: "list",
						ref: list,
						class: "pl-pe__list",
						role: "list",
						"aria-label": words.value.many
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(options.value, (o, i) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: o.id,
							class: (0, vue.normalizeClass)(["pl-pe__opt", { "is-drag": drag.value?.id === o.id }]),
							role: "listitem",
							"data-option": o.id
						}, [
							(0, vue.createElementVNode)("button", {
								type: "button",
								class: "pl-pe__handle",
								"aria-label": (0, vue.unref)(strings$2).reorder(o.name),
								title: (0, vue.unref)(strings$2).reorder(o.name),
								disabled: readonly.value,
								onPointerdown: ($event) => startDrag(o, $event),
								onKeydown: ($event) => onHandleKey(o, i, $event)
							}, [(0, vue.createVNode)(Icon_default, { name: "grip-vertical" })], 40, _hoisted_12$10),
							(0, vue.createVNode)(ColorButton_default, {
								"model-value": o.color,
								label: (0, vue.unref)(strings$2).colorOf(o.name),
								disabled: readonly.value,
								"onUpdate:modelValue": ($event) => setOption(o, { color: $event }),
								onChange: _cache[2] || (_cache[2] = ($event) => (0, vue.unref)(store).flush())
							}, null, 8, [
								"model-value",
								"label",
								"disabled",
								"onUpdate:modelValue"
							]),
							(0, vue.createElementVNode)("input", {
								class: "pl-pe__name",
								value: o.name,
								style: (0, vue.normalizeStyle)({ color: (0, vue.unref)(colorVar)(o.color).fg }),
								readonly: readonly.value,
								"aria-label": (0, vue.unref)(strings$2).optionName,
								spellcheck: "false",
								autocomplete: "off",
								onInput: ($event) => renameOption(o, $event),
								onBlur: ($event) => settleName($event, o.name, (name) => setOption(o, { name })),
								onKeydown: (0, vue.withKeys)((0, vue.withModifiers)(add, ["prevent"]), ["enter"])
							}, null, 44, _hoisted_13$8),
							(0, vue.unref)(counts) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
								key: 0,
								class: "pl-pe__count",
								title: (0, vue.unref)(strings$2).inUse((0, vue.unref)(counts).get(o.id) ?? 0, (0, vue.unref)(itemWord)(collection.value, (0, vue.unref)(counts).get(o.id) ?? 0))
							}, (0, vue.toDisplayString)((0, vue.unref)(counts).get(o.id) ?? 0), 9, _hoisted_14$6)) : (0, vue.createCommentVNode)("v-if", true),
							!readonly.value ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
								key: 1,
								size: "sm",
								label: (0, vue.unref)(strings$2).deleteNamed(o.name),
								onClick: ($event) => deleting.value = {
									id: o.id,
									anchor: $event.currentTarget
								}
							}, {
								default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "trash-2" })]),
								_: 1
							}, 8, ["label", "onClick"])) : (0, vue.createCommentVNode)("v-if", true)
						], 10, _hoisted_11$11);
					}), 128)), !readonly.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 0,
						type: "button",
						class: "pl-pe__add",
						onClick: add
					}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$2).addOption(words.value.one)), 1)])) : (0, vue.createCommentVNode)("v-if", true)], 8, _hoisted_10$14), property.value.type === "select" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_15$6, [(0, vue.createElementVNode)("span", _hoisted_16$5, (0, vue.toDisplayString)((0, vue.unref)(strings$2).defaultOption((0, vue.unref)(itemWord)(collection.value, 2))), 1), (0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-pe__pick",
						"aria-haspopup": "listbox",
						disabled: readonly.value,
						onClick: _cache[3] || (_cache[3] = ($event) => defaultAt.value = $event.currentTarget)
					}, [
						defaultOption.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("i", {
							key: 0,
							class: "pl-pe__dot",
							style: (0, vue.normalizeStyle)({ background: (0, vue.unref)(colorVar)(defaultOption.value.color).dot })
						}, null, 4)) : (0, vue.createCommentVNode)("v-if", true),
						(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)(defaultOption.value?.name ?? (0, vue.unref)(strings$2).nothing), 1),
						(0, vue.createVNode)(Icon_default, { name: "chevron-down" })
					], 8, _hoisted_17$4)])) : (0, vue.createCommentVNode)("v-if", true)], 64)) : (0, vue.createCommentVNode)("v-if", true),
					typeAt.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(PickPopover_default, {
						key: 1,
						rows: typeRows.value,
						anchor: typeAt.value,
						label: (0, vue.unref)(strings$2).type,
						onClose: _cache[4] || (_cache[4] = ($event) => typeAt.value = null),
						onPick: _cache[5] || (_cache[5] = ($event) => (0, vue.unref)(store).setPropertyType(__props.collectionId, __props.propertyId, $event))
					}, null, 8, [
						"rows",
						"anchor",
						"label"
					])) : (0, vue.createCommentVNode)("v-if", true),
					defaultAt.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(PickPopover_default, {
						key: 2,
						rows: defaultRows.value,
						anchor: defaultAt.value,
						label: (0, vue.unref)(strings$2).defaultOption((0, vue.unref)(itemWord)(collection.value, 2)),
						onClose: _cache[6] || (_cache[6] = ($event) => defaultAt.value = null),
						onPick: _cache[7] || (_cache[7] = ($event) => (0, vue.unref)(store).updateProperty(__props.collectionId, __props.propertyId, { defaultOption: $event === NONE$1 ? null : $event }))
					}, null, 8, [
						"rows",
						"anchor",
						"label"
					])) : (0, vue.createCommentVNode)("v-if", true),
					deleting.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(DeleteOption_default, {
						key: deleting.value.id,
						"collection-id": __props.collectionId,
						"property-id": __props.propertyId,
						"option-id": deleting.value.id,
						anchor: deleting.value.anchor,
						onClose: _cache[8] || (_cache[8] = ($event) => deleting.value = null),
						onDeleted: _cache[9] || (_cache[9] = ($event) => afterDelete(0))
					}, null, 8, [
						"collection-id",
						"property-id",
						"option-id",
						"anchor"
					])) : (0, vue.createCommentVNode)("v-if", true)
				]));
			};
		}
	}), [["__scopeId", "data-v-8e27bf46"]]);
	// plugins/planner/src/values/editProperty.ts
	/**
	* A property's editor in a dialog. Mango shows one dialog at a time: from inside a dialog, show `PropertyEditor`
	* there instead (a second one would wait until the first is closed).
	*/
	function editProperty(planner, collectionId, propertyId) {
		const c = planner.store.collection(collectionId);
		const property = c && propertyOf(c, propertyId);
		if (!property) return Promise.resolve();
		return planner.mango.ui.dialog({
			title: strings$2.editorTitle(property.name),
			width: 480,
			view: { component: (0, vue.defineComponent)({
				props: ["ctx"],
				setup(props) {
					(0, vue.provide)(PLANNER, planner);
					return () => (0, vue.h)(PropertyEditor_default, {
						collectionId,
						propertyId,
						onGone: () => props.ctx?.close()
					});
				}
			}) }
		}).then(() => planner.store.flush());
	}
	// plugins/planner/src/values/PropertyMenu.ts
	/**
	* A property's menu. `view`: can hide it there. `rows`: the view's own, above the rest. The menu opens others
	* (types) and asks (names) once it has closed.
	*/
	async function propertyMenu(planner, collection, property, at, view, rows = []) {
		const { mango, store } = planner;
		const all = collection.properties;
		const i = all.findIndex((p) => p.id === property.id);
		let next;
		const own = [
			{
				label: strings$2.rename,
				icon: "pencil",
				divider: rows.length > 0,
				onSelect: () => {
					next = rename;
				}
			},
			...property.type === "unsupported" ? [] : [{
				label: strings$2.changeType,
				icon: PROPERTY_ICONS[property.type],
				aside: strings$5.propertyTypes[property.type],
				onSelect: () => {
					next = changeType;
				}
			}],
			...hasOptions(property) ? [{
				label: strings$2.editOptions(optionWords(property).many),
				icon: "list",
				onSelect: () => {
					next = () => editProperty(planner, collection.id, property.id);
				}
			}] : [],
			...view ? [{
				label: strings$2.hideInView,
				icon: "eye-off",
				onSelect: hide
			}] : [],
			...view ? [] : [{
				label: strings$2.moveUpProperty,
				icon: "arrow-up",
				disabled: i <= 0,
				onSelect: () => store.moveProperty(collection.id, property.id, { before: all[i - 1].id })
			}, {
				label: strings$2.moveDownProperty,
				icon: "arrow-down",
				disabled: i < 0 || i >= all.length - 1,
				onSelect: () => store.moveProperty(collection.id, property.id, { after: all[i + 1].id })
			}],
			{
				label: strings$2.deleteProperty,
				icon: "trash-2",
				danger: true,
				divider: true,
				onSelect: () => {
					next = remove;
				}
			}
		];
		await mango.ui.contextMenu(at, [...rows, ...own]);
		await next?.();
		async function rename() {
			const name = (await mango.ui.prompt({
				title: strings$2.renameTitle,
				value: property.name,
				placeholder: strings$2.propertyName
			}))?.trim();
			if (name && name !== property.name) store.renameProperty(collection.id, property.id, name);
		}
		function changeType() {
			return mango.ui.contextMenu(at, PROPERTY_TYPES.map((t) => ({
				label: strings$5.propertyTypes[t],
				icon: PROPERTY_ICONS[t],
				checked: t === property.type,
				onSelect: () => {
					store.setPropertyType(collection.id, property.id, t);
				}
			})));
		}
		function hide() {
			const now = store.collection(collection.id)?.views.find((v) => v.id === view?.id);
			if (now) store.updateView(collection.id, now.id, { columns: now.columns.map((c) => c.propertyId === property.id ? {
				...c,
				visible: false
			} : c) });
		}
		async function remove() {
			if (await mango.ui.confirm({
				title: strings$2.deleteTitle(property.name),
				body: strings$2.deleteBody,
				confirmLabel: strings$2.delete,
				danger: true
			})) await store.deleteProperty(collection.id, property.id);
		}
	}
	// plugins/planner/src/values/dates.ts
	/** Dates as people read and type them. */
	var locale = () => document.documentElement.lang || void 0;
	/** A date string as a local moment. */
	function moment(date) {
		const [d, t] = date.split("T");
		const [y, m, day] = d.split("-").map(Number);
		const [h, min] = (t ?? "0:0").split(":").map(Number);
		const out = new Date(2e3, 0, 1, h, min);
		out.setFullYear(y, m - 1, day);
		return out;
	}
	var formats = /* @__PURE__ */ new Map();
	function format(options) {
		const key = `${locale()}${JSON.stringify(options)}`;
		let f = formats.get(key);
		if (!f) formats.set(key, f = new Intl.DateTimeFormat(locale(), options));
		return f;
	}
	var DAY = {
		month: "short",
		day: "numeric"
	};
	var DAY_YEAR = {
		month: "short",
		day: "numeric",
		year: "numeric"
	};
	var TIME = {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23"
	};
	function one(date, now, withYear) {
		const d = moment(date);
		const day = format(withYear || d.getFullYear() !== new Date(now).getFullYear() ? DAY_YEAR : DAY).format(d);
		return date.includes("T") ? `${day}, ${format(TIME).format(d)}` : day;
	}
	/** `Mar 1`, `Mar 1, 2027, 09:30`, `Mar 1 – Mar 4`. */
	function dateText(value, now) {
		if (!value.end) return one(value.start, now, false);
		const years = value.start.slice(0, 4) !== value.end.slice(0, 4);
		return `${one(value.start, now, years)} – ${one(value.end, now, years)}`;
	}
	var monthText = (month) => format({
		month: "long",
		year: "numeric"
	}).format(moment(`${month}-01`));
	var fullDate = (date) => format({
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric"
	}).format(moment(date));
	/** 0 Sunday … 6 Saturday, as this language's calendars start. */
	function firstWeekday() {
		try {
			const l = new Intl.Locale(locale() ?? navigator.language);
			return ((l.getWeekInfo?.() ?? l.weekInfo)?.firstDay ?? 1) % 7;
		} catch {
			return 1;
		}
	}
	/** Short names, starting with that day. */
	function weekdayNames(first) {
		return Array.from({ length: 7 }, (_, i) => format({ weekday: "short" }).format(new Date(2023, 0, 1 + first + i)));
	}
	/** The month some months later: `2026-03`. */
	function addMonths(month, n) {
		const [y, m] = month.split("-").map(Number);
		return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
	}
	/** The same day some months later, or that month's last. */
	function sameDayIn(date, n) {
		const month = addMonths(date.slice(0, 7), n);
		const last = addDays(`${addMonths(month, 1)}-01`, -1);
		const day = `${month}-${date.slice(8, 10)}`;
		return day > last ? last : day;
	}
	/** ISO dates, and the few words people use: today, tomorrow, yesterday, now, +3, +2w. */
	function readDate(text, now) {
		const t = text.trim().toLowerCase();
		const today = localDate(now);
		if (t === "now") return { start: localDateTime(now) };
		if (t === "today") return { start: today };
		if (t === "tomorrow") return { start: addDays(today, 1) };
		if (t === "yesterday") return { start: addDays(today, -1) };
		const rel = /^([+-]\d{1,4})\s*(d|days?|w|weeks?)?$/.exec(t);
		if (rel) return { start: addDays(today, Number(rel[1]) * (rel[2]?.startsWith("w") ? 7 : 1)) };
		return parseDate(text.trim().replace(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?!\d)/, (_, y, m, d) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`).replace(/([ T])(\d:\d\d)/g, (_, a, b) => `${a}0${b}`));
	}
	// plugins/planner/src/values/DateEditor.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$29 = { class: "pl-date" };
	var _hoisted_2$27 = { class: "pl-date__fields" };
	var _hoisted_3$24 = [
		"onUpdate:modelValue",
		"data-autofocus",
		"aria-label",
		"aria-invalid",
		"placeholder",
		"onFocus",
		"onChange",
		"onKeydown"
	];
	var _hoisted_4$24 = [
		"value",
		"aria-label",
		"onFocus",
		"onChange"
	];
	var _hoisted_5$22 = {
		key: 0,
		class: "pl-date__bad",
		role: "alert"
	};
	var _hoisted_6$19 = { class: "pl-date__month" };
	var _hoisted_7$17 = { "aria-live": "polite" };
	var _hoisted_8$16 = ["aria-label"];
	var _hoisted_9$14 = {
		class: "pl-date__week",
		role: "row"
	};
	var _hoisted_10$13 = ["aria-selected"];
	var _hoisted_11$10 = [
		"data-day",
		"tabindex",
		"aria-label",
		"aria-current",
		"onClick"
	];
	var _hoisted_12$9 = { class: "pl-date__foot" };
	var _hoisted_13$7 = ["aria-checked"];
	var _hoisted_14$5 = ["aria-checked"];
	var _hoisted_15$5 = { class: "pl-date__acts" };
	var _hoisted_16$4 = ["title"];
	// plugins/planner/src/values/DateEditor.vue
	var DateEditor_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "DateEditor",
		props: { value: {} },
		emits: ["change", "done"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { mango, store } = usePlanner();
			const { IconButton } = mango.ui.components;
			const today = (0, vue.computed)(() => localDate(store.now.value));
			const withEnd = (0, vue.ref)(!!props.value?.end);
			const withTime = (0, vue.ref)(!!props.value?.start.includes("T"));
			/** Which of the two the calendar sets. */
			const side = (0, vue.ref)("start");
			const start = (0, vue.computed)(() => props.value?.start ?? null);
			const end = (0, vue.computed)(() => props.value?.end ?? null);
			const day = (d) => d?.slice(0, 10) ?? null;
			const time = (d) => d?.slice(11, 16) || null;
			function save(s, e) {
				const full = (d, t) => withTime.value ? `${d.slice(0, 10)}T${time(d) ?? t}` : d.slice(0, 10);
				let a = full(s, "09:00");
				let b = withEnd.value && e ? full(e, time(a) ?? "09:00") : null;
				if (b !== null && b < a) [a, b] = [b, a];
				emit("change", b === null ? { start: a } : {
					start: a,
					end: b
				});
			}
			/** A day for the side being set, keeping that side's time. */
			function setDay(d) {
				const keep = (old) => time(old) ? `${d}T${time(old)}` : d;
				if (side.value === "end" && start.value) save(start.value, keep(end.value));
				else save(keep(start.value), end.value);
			}
			/** The time has a field of its own. */
			const text = (d) => day(d) ?? "";
			const drafts = (0, vue.ref)({
				start: text(start.value),
				end: text(end.value)
			});
			const bad = (0, vue.ref)(null);
			(0, vue.watch)(() => props.value, () => {
				drafts.value = {
					start: text(start.value),
					end: text(end.value)
				};
				bad.value = null;
			});
			/** Reads what was typed; false when it is no date. */
			function commit(which) {
				const t = drafts.value[which].trim();
				bad.value = null;
				if (t === text(which === "start" ? start.value : end.value)) return true;
				if (!t) {
					if (which === "start") emit("change", null);
					else if (start.value) save(start.value, null);
					return true;
				}
				const d = readDate(t, store.now.value);
				if (!d) {
					bad.value = which;
					return false;
				}
				if (d.start.includes("T")) withTime.value = true;
				if (d.end) withEnd.value = true;
				const timed = (next, old) => next.includes("T") || !time(old) ? next : `${next}T${time(old)}`;
				if (which === "end") save(start.value ?? d.start, timed(d.start, end.value));
				else save(timed(d.start, start.value), d.end ? timed(d.end, end.value) : end.value);
				month.value = d.start.slice(0, 7);
				cursor.value = d.start.slice(0, 10);
				return true;
			}
			function onInputKey(e, which) {
				if (e.isComposing) return;
				if (e.key === "Enter") {
					e.preventDefault();
					if (commit(which)) emit("done");
				} else if (e.key === "ArrowDown") {
					e.preventDefault();
					if (commit(which)) focusDay();
				}
			}
			const cursor = (0, vue.ref)(day(start.value) ?? today.value);
			const month = (0, vue.ref)(cursor.value.slice(0, 7));
			const grid = (0, vue.ref)(null);
			const first = firstWeekday();
			const names = weekdayNames(first);
			const weeks = (0, vue.computed)(() => {
				const one = `${month.value}-01`;
				const lead = ((/* @__PURE__ */ new Date(`${one}T12:00:00Z`)).getUTCDay() - first + 7) % 7;
				const from = addDays(one, -lead);
				const count = Math.ceil((lead + Number(addDays(`${addMonths(month.value, 1)}-01`, -1).slice(8))) / 7);
				return Array.from({ length: count }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(from, w * 7 + d)));
			});
			/** The day the keyboard is on, always one that shows. */
			const tabDay = (0, vue.computed)(() => cursor.value.startsWith(month.value) ? cursor.value : `${month.value}-01`);
			const isSelected = (d) => d === day(start.value) || withEnd.value && d === day(end.value);
			const inRange = (d) => !!start.value && !!end.value && d > day(start.value) && d < day(end.value);
			async function focusDay(d = tabDay.value) {
				cursor.value = d;
				month.value = d.slice(0, 7);
				await (0, vue.nextTick)();
				grid.value?.querySelector(`[data-day="${d}"]`)?.focus();
			}
			function turn(by) {
				month.value = addMonths(month.value, by);
			}
			function pick(d) {
				cursor.value = d;
				setDay(d);
				if (!withEnd.value && !withTime.value) emit("done");
				else if (withEnd.value && side.value === "start") side.value = "end";
			}
			function onGridKey(e) {
				const d = e.target.dataset.day;
				if (!d) return;
				const weekday = ((/* @__PURE__ */ new Date(`${d}T12:00:00Z`)).getUTCDay() - first + 7) % 7;
				const next = {
					ArrowLeft: () => addDays(d, -1),
					ArrowRight: () => addDays(d, 1),
					ArrowUp: () => addDays(d, -7),
					ArrowDown: () => addDays(d, 7),
					Home: () => addDays(d, -weekday),
					End: () => addDays(d, 6 - weekday),
					PageUp: () => sameDayIn(d, e.shiftKey ? -12 : -1),
					PageDown: () => sameDayIn(d, e.shiftKey ? 12 : 1)
				}[e.key]?.();
				if (!next) return;
				e.preventDefault();
				if (/^\d{4}-/.test(next)) focusDay(next);
			}
			function toggleEnd() {
				withEnd.value = !withEnd.value;
				side.value = withEnd.value ? "end" : "start";
				if (start.value) save(start.value, withEnd.value ? end.value ?? start.value : null);
			}
			function toggleTime() {
				withTime.value = !withTime.value;
				if (start.value) save(start.value, end.value);
			}
			function setTime(which, e) {
				const t = e.target.value;
				const s = start.value;
				if (!/^\d\d:\d\d$/.test(t) || !s) return;
				if (which === "start") save(`${day(s)}T${t}`, end.value);
				else save(s, `${day(end.value) ?? day(s)}T${t}`);
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$29, [
					(0, vue.createElementVNode)("div", _hoisted_2$27, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(withEnd.value ? ["start", "end"] : ["start"], (which) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: which,
							class: (0, vue.normalizeClass)(["pl-date__field", {
								"is-on": withEnd.value && side.value === which,
								"is-bad": bad.value === which
							}])
						}, [(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
							"onUpdate:modelValue": ($event) => drafts.value[which] = $event,
							type: "text",
							"data-autofocus": which === "start" ? "" : void 0,
							"aria-label": which === "start" ? (0, vue.unref)(strings$2).start : (0, vue.unref)(strings$2).end,
							"aria-invalid": bad.value === which || void 0,
							placeholder: which === "start" ? (0, vue.unref)(strings$2).dateHint : (0, vue.unref)(strings$2).end,
							spellcheck: "false",
							autocomplete: "off",
							onFocus: ($event) => {
								side.value = which;
								$event.target.select();
							},
							onChange: ($event) => commit(which),
							onKeydown: ($event) => onInputKey($event, which)
						}, null, 40, _hoisted_3$24), [[vue.vModelText, drafts.value[which]]]), withTime.value && (which === "start" ? start.value : end.value) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("input", {
							key: 0,
							type: "time",
							class: "pl-date__time",
							value: time(which === "start" ? start.value : end.value),
							"aria-label": which === "start" ? (0, vue.unref)(strings$2).startTime : (0, vue.unref)(strings$2).endTime,
							onFocus: ($event) => side.value = which,
							onChange: ($event) => setTime(which, $event)
						}, null, 40, _hoisted_4$24)) : (0, vue.createCommentVNode)("v-if", true)], 2);
					}), 128)), bad.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_5$22, (0, vue.toDisplayString)((0, vue.unref)(strings$2).notADate), 1)) : (0, vue.createCommentVNode)("v-if", true)]),
					(0, vue.createElementVNode)("div", _hoisted_6$19, [
						(0, vue.createElementVNode)("span", _hoisted_7$17, (0, vue.toDisplayString)((0, vue.unref)(monthText)(month.value)), 1),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
							size: "sm",
							label: (0, vue.unref)(strings$2).previousMonth,
							onClick: _cache[0] || (_cache[0] = ($event) => turn(-1))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "chevron-left" })]),
							_: 1
						}, 8, ["label"])),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
							size: "sm",
							label: (0, vue.unref)(strings$2).nextMonth,
							onClick: _cache[1] || (_cache[1] = ($event) => turn(1))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "chevron-right" })]),
							_: 1
						}, 8, ["label"]))
					]),
					(0, vue.createElementVNode)("div", {
						ref_key: "grid",
						ref: grid,
						class: "pl-date__grid",
						role: "grid",
						"aria-label": (0, vue.unref)(monthText)(month.value),
						onKeydown: onGridKey
					}, [(0, vue.createElementVNode)("div", _hoisted_9$14, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)((0, vue.unref)(names), (n) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
							key: n,
							class: "pl-date__name",
							role: "columnheader"
						}, (0, vue.toDisplayString)(n), 1);
					}), 128))]), ((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(weeks.value, (week) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: week[0],
							class: "pl-date__week",
							role: "row"
						}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(week, (d) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
								key: d,
								role: "gridcell",
								"aria-selected": isSelected(d),
								class: (0, vue.normalizeClass)(["pl-date__cell", { "is-range": inRange(d) }])
							}, [(0, vue.createElementVNode)("button", {
								type: "button",
								class: (0, vue.normalizeClass)(["pl-date__day", {
									"is-out": !d.startsWith(month.value),
									"is-today": d === today.value,
									"is-selected": isSelected(d)
								}]),
								"data-day": d,
								tabindex: d === tabDay.value ? 0 : -1,
								"aria-label": (0, vue.unref)(fullDate)(d),
								"aria-current": d === today.value ? "date" : void 0,
								onClick: ($event) => pick(d)
							}, (0, vue.toDisplayString)(Number(d.slice(8))), 11, _hoisted_11$10)], 10, _hoisted_10$13);
						}), 128))]);
					}), 128))], 40, _hoisted_8$16),
					(0, vue.createElementVNode)("div", _hoisted_12$9, [
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-date__opt",
							role: "switch",
							"aria-checked": withEnd.value,
							onClick: toggleEnd
						}, [(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings$2).endDate), 1), _cache[4] || (_cache[4] = (0, vue.createElementVNode)("i", {
							class: "pl-date__switch",
							"aria-hidden": "true"
						}, null, -1))], 8, _hoisted_13$7),
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-date__opt",
							role: "switch",
							"aria-checked": withTime.value,
							onClick: toggleTime
						}, [(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings$2).includeTime), 1), _cache[5] || (_cache[5] = (0, vue.createElementVNode)("i", {
							class: "pl-date__switch",
							"aria-hidden": "true"
						}, null, -1))], 8, _hoisted_14$5),
						(0, vue.createElementVNode)("div", _hoisted_15$5, [(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-date__act",
							onClick: _cache[2] || (_cache[2] = ($event) => pick(today.value))
						}, (0, vue.toDisplayString)((0, vue.unref)(strings$2).today), 1), __props.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: 0,
							type: "button",
							class: "pl-date__act",
							title: (0, vue.unref)(dateText)(__props.value, (0, vue.unref)(store).now.value),
							onClick: _cache[3] || (_cache[3] = ($event) => {
								emit("change", null);
								emit("done");
							})
						}, (0, vue.toDisplayString)((0, vue.unref)(strings$2).clear), 9, _hoisted_16$4)) : (0, vue.createCommentVNode)("v-if", true)])
					])
				]);
			};
		}
	}), [["__scopeId", "data-v-aacd3835"]]);
	// plugins/planner/src/ui/OptionTag.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$28 = ["title"];
	var _hoisted_2$26 = { class: "pl-tag__name" };
	// plugins/planner/src/ui/OptionTag.vue
	var OptionTag_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "OptionTag",
		props: { option: {} },
		setup(__props) {
			const props = __props;
			const color = (0, vue.computed)(() => colorVar(props.option.color));
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					class: "pl-tag",
					title: __props.option.name,
					style: (0, vue.normalizeStyle)({ color: color.value.fg })
				}, [(0, vue.createElementVNode)("span", {
					class: "pl-tag__dot",
					style: (0, vue.normalizeStyle)({ background: color.value.dot }),
					"aria-hidden": "true"
				}, null, 4), (0, vue.createElementVNode)("span", _hoisted_2$26, (0, vue.toDisplayString)(__props.option.name), 1)], 12, _hoisted_1$28);
			};
		}
	}), [["__scopeId", "data-v-5e67d769"]]);
	// plugins/planner/src/values/OptionEditor.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$27 = {
		key: 0,
		class: "pl-oe"
	};
	var _hoisted_2$25 = { class: "pl-oe__head" };
	var _hoisted_3$23 = ["aria-label", "title"];
	var _hoisted_4$23 = [
		"value",
		"aria-label",
		"onKeydown"
	];
	var _hoisted_5$21 = { class: "pl-oe__colors" };
	var _hoisted_6$18 = { class: "pl-oe__rows is-plain" };
	var _hoisted_7$16 = ["disabled"];
	var _hoisted_8$15 = ["disabled"];
	var _hoisted_9$13 = {
		key: 1,
		class: "pl-oe"
	};
	var _hoisted_10$12 = { class: "pl-oe__head" };
	var _hoisted_11$9 = [
		"aria-controls",
		"aria-activedescendant",
		"aria-label",
		"placeholder"
	];
	var _hoisted_12$8 = [
		"id",
		"aria-label",
		"aria-multiselectable"
	];
	var _hoisted_13$6 = [
		"id",
		"aria-selected",
		"onPointermove",
		"onClick"
	];
	var _hoisted_14$4 = { class: "pl-oe__tag" };
	var _hoisted_15$4 = [
		"aria-label",
		"title",
		"onClick"
	];
	var _hoisted_16$3 = { class: "pl-oe__new" };
	var _hoisted_17$3 = {
		key: 0,
		class: "pl-oe__note"
	};
	var _hoisted_18$2 = {
		key: 0,
		class: "pl-oe__foot"
	};
	// plugins/planner/src/values/OptionEditor.vue
	var OptionEditor_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "OptionEditor",
		props: {
			collectionId: {},
			property: {},
			items: {},
			set: { type: Function }
		},
		emits: ["done"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store } = usePlanner();
			const deleting = (0, vue.ref)(null);
			const multi = (0, vue.computed)(() => props.property.type === "multiSelect");
			const query = (0, vue.ref)("");
			const active = (0, vue.ref)(0);
			const input = (0, vue.ref)(null);
			const list = (0, vue.ref)(null);
			const idsOf = (item) => {
				const v = valueOf(item, props.property);
				return typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
			};
			/** Options every item has, and those only some have. */
			const counts = (0, vue.computed)(() => {
				const out = /* @__PURE__ */ new Map();
				for (const i of props.items) for (const id of idsOf(i)) out.set(id, (out.get(id) ?? 0) + 1);
				return out;
			});
			const has = (o) => props.items.length > 0 && counts.value.get(o.id) === props.items.length;
			const some = (o) => !has(o) && counts.value.has(o.id);
			const matches = (0, vue.computed)(() => {
				const q = query.value.trim().toLowerCase();
				return q ? props.property.options.filter((o) => o.name.toLowerCase().includes(q)) : props.property.options;
			});
			const createName = (0, vue.computed)(() => {
				const q = query.value.trim();
				return q && !props.property.options.some((o) => o.name.trim().toLowerCase() === q.toLowerCase()) ? q : null;
			});
			const rows = (0, vue.computed)(() => [...matches.value.map((o) => ({
				key: o.id,
				option: o
			})), ...createName.value ? [{
				key: "create",
				create: createName.value
			}] : []]);
			const canClear = (0, vue.computed)(() => counts.value.size > 0);
			active.value = Math.max(0, props.property.options.findIndex(has));
			(0, vue.nextTick)(reveal);
			(0, vue.watch)(query, () => {
				active.value = 0;
			});
			(0, vue.watch)(() => rows.value.length, (n) => {
				active.value = Math.max(0, Math.min(active.value, n - 1));
			});
			const rowId = (key) => `pl-opt-${props.property.id}-${key}`;
			function reveal() {
				list.value?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
			}
			function move(by) {
				const n = rows.value.length;
				if (n) active.value = (active.value + by + n) % n;
				(0, vue.nextTick)(reveal);
			}
			function pick(row) {
				if (!row) return;
				const option = row.option ?? store.addOption(props.collectionId, props.property.id, row.create ?? "", colorAt(props.property.options.length));
				if (!option) return;
				if (multi.value) {
					const remove = has(option);
					props.set((item) => {
						const ids = idsOf(item);
						const next = remove ? ids.filter((id) => id !== option.id) : ids.includes(option.id) ? ids : [...ids, option.id];
						return next.length ? [...next] : null;
					});
					query.value = "";
					input.value?.focus();
				} else {
					if (props.items.length) {
						props.set(option.id);
						emit("done");
					}
					query.value = "";
				}
			}
			function clear() {
				props.set(null);
				if (multi.value) input.value?.focus();
				else emit("done");
			}
			function onKey(e) {
				if (e.isComposing) return;
				const row = rows.value[active.value];
				if (e.key === "ArrowDown") move(1);
				else if (e.key === "ArrowUp") move(-1);
				else if (e.key === "Enter") pick(row);
				else if (e.key === "F2") {
					if (row?.option) startEdit(row.option);
				} else if (e.key === "Backspace" && !query.value && multi.value && props.items.length === 1) {
					const last = idsOf(props.items[0]).at(-1);
					if (!last) return;
					props.set((item) => {
						const next = idsOf(item).filter((id) => id !== last);
						return next.length ? next : null;
					});
				} else return;
				e.preventDefault();
			}
			const editing = (0, vue.ref)(null);
			const edited = (0, vue.computed)(() => props.property.options.find((o) => o.id === editing.value) ?? null);
			const editIndex = (0, vue.computed)(() => props.property.options.findIndex((o) => o.id === editing.value));
			const nameInput = (0, vue.ref)(null);
			async function startEdit(o) {
				editing.value = o.id;
				await (0, vue.nextTick)();
				nameInput.value?.select();
			}
			async function stopEdit() {
				const id = editing.value;
				tidyName();
				editing.value = null;
				await (0, vue.nextTick)();
				const at = rows.value.findIndex((r) => r.option?.id === id);
				if (at >= 0) active.value = at;
				input.value?.focus();
			}
			(0, vue.watch)(edited, (o) => {
				if (!o && editing.value) stopEdit();
			});
			/** Spaces are kept while typing. */
			function tidyName() {
				const o = edited.value;
				if (o && o.name !== o.name.trim()) store.updateOption(props.collectionId, props.property.id, o.id, { name: o.name.trim() }, { defer: true });
			}
			(0, vue.onBeforeUnmount)(() => {
				tidyName();
				store.flush();
			});
			function rename(e) {
				const name = e.target.value;
				if (edited.value && name.trim()) store.updateOption(props.collectionId, props.property.id, edited.value.id, { name }, { defer: true });
			}
			function moveOption(by) {
				const o = edited.value;
				const other = props.property.options[editIndex.value + by];
				if (o && other) store.moveOption(props.collectionId, props.property.id, o.id, by < 0 ? { before: other.id } : { after: other.id });
			}
			function recolor(color) {
				if (edited.value) store.updateOption(props.collectionId, props.property.id, edited.value.id, { color }, { defer: true });
			}
			return (_ctx, _cache) => {
				return edited.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$27, [
					(0, vue.createElementVNode)("div", _hoisted_2$25, [(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-oe__icon",
						"aria-label": (0, vue.unref)(strings$2).back,
						title: (0, vue.unref)(strings$2).back,
						onClick: stopEdit
					}, [(0, vue.createVNode)(Icon_default, { name: "arrow-left" })], 8, _hoisted_3$23), (0, vue.createElementVNode)("input", {
						ref_key: "nameInput",
						ref: nameInput,
						class: "pl-oe__input",
						"data-autofocus": "",
						value: edited.value.name,
						"aria-label": (0, vue.unref)(strings$2).optionName,
						spellcheck: "false",
						onInput: rename,
						onKeydown: (0, vue.withKeys)((0, vue.withModifiers)(stopEdit, ["prevent"]), ["enter"])
					}, null, 40, _hoisted_4$23)]),
					(0, vue.createElementVNode)("div", _hoisted_5$21, [(0, vue.createVNode)(ColorPicker_default, {
						"model-value": edited.value.color,
						label: (0, vue.unref)(strings$2).color,
						"onUpdate:modelValue": recolor,
						onChange: _cache[0] || (_cache[0] = ($event) => (0, vue.unref)(store).flush())
					}, null, 8, ["model-value", "label"])]),
					(0, vue.createElementVNode)("div", _hoisted_6$18, [
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-oe__row",
							disabled: editIndex.value <= 0,
							onClick: _cache[1] || (_cache[1] = ($event) => moveOption(-1))
						}, [(0, vue.createVNode)(Icon_default, { name: "arrow-up" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$2).moveUp), 1)], 8, _hoisted_7$16),
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-oe__row",
							disabled: editIndex.value >= __props.property.options.length - 1,
							onClick: _cache[2] || (_cache[2] = ($event) => moveOption(1))
						}, [(0, vue.createVNode)(Icon_default, { name: "arrow-down" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$2).moveDown), 1)], 8, _hoisted_8$15),
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-oe__row is-danger",
							onClick: _cache[3] || (_cache[3] = ($event) => deleting.value = $event.currentTarget)
						}, [(0, vue.createVNode)(Icon_default, { name: "trash-2" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$2).deleteOption), 1)])
					]),
					deleting.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(DeleteOption_default, {
						key: 0,
						"collection-id": __props.collectionId,
						"property-id": __props.property.id,
						"option-id": edited.value.id,
						anchor: deleting.value,
						onClose: _cache[4] || (_cache[4] = ($event) => deleting.value = null)
					}, null, 8, [
						"collection-id",
						"property-id",
						"option-id",
						"anchor"
					])) : (0, vue.createCommentVNode)("v-if", true)
				])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_9$13, [
					(0, vue.createElementVNode)("div", _hoisted_10$12, [(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
						ref_key: "input",
						ref: input,
						"onUpdate:modelValue": _cache[5] || (_cache[5] = ($event) => query.value = $event),
						class: "pl-oe__input",
						"data-autofocus": "",
						role: "combobox",
						"aria-expanded": "true",
						"aria-autocomplete": "list",
						"aria-controls": rowId("list"),
						"aria-activedescendant": rows.value[active.value] ? rowId(rows.value[active.value].key) : void 0,
						"aria-label": __props.property.name,
						placeholder: (0, vue.unref)(strings$2).findOption,
						spellcheck: "false",
						autocomplete: "off",
						onKeydown: onKey
					}, null, 40, _hoisted_11$9), [[vue.vModelText, query.value]])]),
					(0, vue.createElementVNode)("div", {
						id: rowId("list"),
						ref_key: "list",
						ref: list,
						class: "pl-oe__rows",
						role: "listbox",
						"aria-label": __props.property.name,
						"aria-multiselectable": multi.value || void 0
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(rows.value, (row, i) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							id: rowId(row.key),
							key: row.key,
							class: (0, vue.normalizeClass)(["pl-oe__row", { "is-active": i === active.value }]),
							role: "option",
							"aria-selected": row.option ? has(row.option) : false,
							onPointermove: ($event) => active.value = i,
							onClick: ($event) => pick(row)
						}, [row.option ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [
							(0, vue.createElementVNode)("span", _hoisted_14$4, [(0, vue.createVNode)(OptionTag_default, { option: row.option }, null, 8, ["option"])]),
							has(row.option) ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
								key: 0,
								name: "check",
								class: "pl-oe__check"
							})) : some(row.option) ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
								key: 1,
								name: "minus",
								class: "pl-oe__check is-some"
							})) : (0, vue.createCommentVNode)("v-if", true),
							(0, vue.createElementVNode)("button", {
								type: "button",
								class: "pl-oe__icon pl-oe__dots",
								tabindex: "-1",
								"aria-label": (0, vue.unref)(strings$2).editOption(row.option.name),
								title: `${(0, vue.unref)(strings$2).editOption(row.option.name)} (F2)`,
								onClick: (0, vue.withModifiers)(($event) => startEdit(row.option), ["stop"])
							}, [(0, vue.createVNode)(Icon_default, { name: "ellipsis" })], 8, _hoisted_15$4)
						], 64)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [(0, vue.createVNode)(Icon_default, {
							name: "plus",
							class: "pl-oe__plus"
						}), (0, vue.createElementVNode)("span", _hoisted_16$3, (0, vue.toDisplayString)((0, vue.unref)(strings$2).create(row.create ?? "")), 1)], 64))], 42, _hoisted_13$6);
					}), 128)), !rows.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_17$3, (0, vue.toDisplayString)((0, vue.unref)(strings$2).noOptions), 1)) : (0, vue.createCommentVNode)("v-if", true)], 8, _hoisted_12$8),
					canClear.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_18$2, [(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-oe__row",
						onClick: clear
					}, [(0, vue.createVNode)(Icon_default, { name: "x" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$2).clear), 1)])])) : (0, vue.createCommentVNode)("v-if", true)
				]));
			};
		}
	}), [["__scopeId", "data-v-f177d8df"]]);
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
	// plugins/planner/src/values/TextEditor.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$26 = { class: "pl-text" };
	var _hoisted_2$24 = ["data-text"];
	var _hoisted_3$22 = ["aria-label"];
	var _hoisted_4$22 = [
		"inputmode",
		"placeholder",
		"aria-label",
		"aria-invalid"
	];
	// plugins/planner/src/values/TextEditor.vue
	var TextEditor_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "TextEditor",
		props: {
			property: {},
			value: { type: [
				String,
				Number,
				Boolean,
				Array,
				Object,
				null
			] }
		},
		emits: ["change", "done"],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const initial = props.value === null ? "" : String(props.value);
			const text = (0, vue.ref)(initial);
			const el = (0, vue.ref)(null);
			const isNumber = props.property.type === "number";
			const number = (0, vue.computed)(() => text.value.trim() ? parseNumber(text.value) : null);
			const invalid = (0, vue.computed)(() => isNumber && text.value.trim() !== "" && number.value === null);
			const problem = (0, vue.computed)(() => {
				if (invalid.value) return strings$2.notANumber;
				return props.property.type === "url" && text.value.trim() && !safeUrl(text.value) ? strings$2.badLink : null;
			});
			let settled = false;
			function commit() {
				if (settled) return;
				settled = true;
				if (text.value === initial || invalid.value) return;
				if (isNumber) emit("change", number.value);
				else emit("change", (props.property.type === "url" ? text.value.trim() : text.value.trimEnd()) || null);
			}
			function cancel() {
				settled = true;
			}
			function onKey(e) {
				if (e.key !== "Enter" || e.isComposing || e.shiftKey && props.property.type === "text") return;
				e.preventDefault();
				if (invalid.value) return;
				commit();
				emit("done");
			}
			(0, vue.onMounted)(() => el.value?.select());
			(0, vue.onBeforeUnmount)(commit);
			__expose({
				commit,
				cancel
			});
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$26, [__props.property.type === "text" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					key: 0,
					class: "pl-text__grow",
					"data-text": `${text.value} `
				}, [(0, vue.withDirectives)((0, vue.createElementVNode)("textarea", {
					ref_key: "el",
					ref: el,
					"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => text.value = $event),
					"data-autofocus": "",
					rows: "1",
					"aria-label": __props.property.name,
					onKeydown: onKey
				}, null, 40, _hoisted_3$22), [[vue.vModelText, text.value]])], 8, _hoisted_2$24)) : (0, vue.withDirectives)(((0, vue.openBlock)(), (0, vue.createElementBlock)("input", {
					key: 1,
					ref_key: "el",
					ref: el,
					"onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => text.value = $event),
					"data-autofocus": "",
					class: "pl-text__input",
					type: "text",
					inputmode: isNumber ? "decimal" : "url",
					spellcheck: "false",
					autocomplete: "off",
					placeholder: __props.property.type === "url" ? "https://" : void 0,
					"aria-label": __props.property.name,
					"aria-invalid": invalid.value || void 0,
					onKeydown: onKey
				}, null, 40, _hoisted_4$22)), [[vue.vModelText, text.value]]), problem.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", {
					key: 2,
					class: (0, vue.normalizeClass)(["pl-text__note", { "is-error": invalid.value }]),
					role: "status"
				}, (0, vue.toDisplayString)(problem.value), 3)) : (0, vue.createCommentVNode)("v-if", true)]);
			};
		}
	}), [["__scopeId", "data-v-7d6d1be2"]]);
	// plugins/planner/src/values/ValuePopover.vue
	var ValuePopover_default = /* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ValuePopover",
		props: {
			collectionId: {},
			property: {},
			itemIds: {},
			anchor: {}
		},
		emits: ["close"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store } = usePlanner();
			/** As it is now: the one given may be from before an option was added. */
			const property = (0, vue.computed)(() => {
				const c = store.collection(props.collectionId);
				return (c && propertyOf(c, props.property.id)) ?? null;
			});
			const items = (0, vue.computed)(() => {
				const ids = new Set(props.itemIds);
				return store.items(props.collectionId).items.filter((i) => ids.has(i.id));
			});
			const gone = (0, vue.computed)(() => !property.value || isReadonly(property.value) || props.itemIds.length > 0 && !items.value.length);
			/** The value they all have, or null. */
			const common = (0, vue.computed)(() => {
				const p = property.value;
				const [first, ...rest] = items.value;
				if (!p || !first) return null;
				const v = valueOf(first, p);
				return rest.every((i) => JSON.stringify(valueOf(i, p)) === JSON.stringify(v)) ? v : null;
			});
			const commonDate = (0, vue.computed)(() => property.value?.type === "date" ? common.value : null);
			/** One change for all, or one for each group of items that end up with the same value. */
			function set(next) {
				const p = property.value;
				if (!p || !items.value.length) return;
				const groups = /* @__PURE__ */ new Map();
				for (const item of items.value) {
					const value = typeof next === "function" ? next(item) : next;
					const key = JSON.stringify(storedValue(value, p) ?? null);
					const group = groups.get(key);
					if (group) group.ids.push(item.id);
					else groups.set(key, {
						value,
						ids: [item.id]
					});
				}
				for (const g of groups.values()) store.updateItems(props.collectionId, g.ids, { values: { [p.id]: g.value } });
			}
			function toggleCheckbox() {
				const p = property.value;
				if (!p) return;
				set(!items.value.every((i) => valueOf(i, p) === true));
			}
			(0, vue.onMounted)(() => {
				if (property.value?.type === "checkbox") {
					toggleCheckbox();
					emit("close");
				}
			});
			(0, vue.watch)(gone, (v) => {
				if (v) emit("close");
			}, { immediate: true });
			const text = (0, vue.ref)(null);
			function onClose(reason) {
				if (reason === "escape") text.value?.cancel();
				emit("close");
			}
			const kind = (0, vue.computed)(() => {
				switch (property.value?.type) {
					case "select":
					case "multiSelect": return "options";
					case "date": return "date";
					case "text":
					case "number":
					case "url": return "text";
					default: return null;
				}
			});
			const width = (0, vue.computed)(() => {
				if (kind.value === "date") return 256;
				const w = props.anchor instanceof HTMLElement ? props.anchor.offsetWidth : 0;
				return Math.min(Math.max(w, kind.value === "options" ? 248 : 260), 480);
			});
			return (_ctx, _cache) => {
				return property.value && kind.value && !gone.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
					key: 0,
					anchor: __props.anchor,
					width: width.value,
					label: (0, vue.unref)(strings$2).edit(property.value.name),
					cover: kind.value === "text",
					onClose
				}, {
					default: (0, vue.withCtx)(() => [kind.value === "options" ? ((0, vue.openBlock)(), (0, vue.createBlock)(OptionEditor_default, {
						key: 0,
						"collection-id": __props.collectionId,
						property: property.value,
						items: items.value,
						set,
						onDone: _cache[0] || (_cache[0] = ($event) => emit("close"))
					}, null, 8, [
						"collection-id",
						"property",
						"items"
					])) : kind.value === "date" ? ((0, vue.openBlock)(), (0, vue.createBlock)(DateEditor_default, {
						key: 1,
						value: commonDate.value,
						onChange: set,
						onDone: _cache[1] || (_cache[1] = ($event) => emit("close"))
					}, null, 8, ["value"])) : ((0, vue.openBlock)(), (0, vue.createBlock)(TextEditor_default, {
						key: 2,
						ref_key: "text",
						ref: text,
						property: property.value,
						value: common.value,
						onChange: set,
						onDone: _cache[2] || (_cache[2] = ($event) => emit("close"))
					}, null, 8, ["property", "value"]))]),
					_: 1
				}, 8, [
					"anchor",
					"width",
					"label",
					"cover"
				])) : (0, vue.createCommentVNode)("v-if", true);
			};
		}
	});
	// plugins/planner/src/values/ValueView.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$25 = ["aria-label"];
	var _hoisted_2$23 = ["title"];
	var _hoisted_3$21 = ["title"];
	var _hoisted_4$21 = {
		key: 4,
		class: "pl-value pl-value--number"
	};
	var _hoisted_5$20 = ["title"];
	var _hoisted_6$17 = ["title"];
	// plugins/planner/src/values/ValueView.vue
	var ValueView_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ValueView",
		props: {
			property: {},
			item: {},
			wrap: { type: Boolean }
		},
		setup(__props) {
			const props = __props;
			const { mango, store } = usePlanner();
			const value = (0, vue.computed)(() => valueOf(props.item, props.property));
			const options = (0, vue.computed)(() => {
				const v = value.value;
				return (props.property.type === "select" && typeof v === "string" ? [v] : Array.isArray(v) ? v : []).flatMap((id) => props.property.options.find((o) => o.id === id) ?? []);
			});
			const date = (0, vue.computed)(() => {
				const v = value.value;
				return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
			});
			/** A newer version's value: as much of it as can be read. */
			const raw = (0, vue.computed)(() => {
				if (props.property.type !== "unsupported") return "";
				const v = props.item.values[props.property.id];
				return typeof v === "string" ? v : v === void 0 || v === null ? "" : JSON.stringify(v);
			});
			const href = (0, vue.computed)(() => props.property.type === "url" && typeof value.value === "string" ? safeUrl(value.value) : null);
			/** Without what every address has. */
			const shortUrl = (0, vue.computed)(() => String(value.value).replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""));
			function open() {
				if (href.value) mango.workspace.openBrowser(href.value);
			}
			return (_ctx, _cache) => {
				return __props.property.type === "checkbox" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					key: 0,
					class: (0, vue.normalizeClass)(["pl-value pl-value--check", { "is-on": value.value === true }]),
					role: "img",
					"aria-label": value.value === true ? (0, vue.unref)(strings$2).yes : (0, vue.unref)(strings$2).no
				}, [(0, vue.createVNode)(Icon_default, { name: value.value === true ? "square-check" : "square" }, null, 8, ["name"])], 10, _hoisted_1$25)) : options.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					key: 1,
					class: (0, vue.normalizeClass)(["pl-value pl-value--tags", { "is-wrap": __props.wrap }])
				}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(options.value, (o) => {
					return (0, vue.openBlock)(), (0, vue.createBlock)(OptionTag_default, {
						key: o.id,
						option: o
					}, null, 8, ["option"]);
				}), 128))], 2)) : date.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					key: 2,
					class: "pl-value pl-value--date",
					title: (0, vue.unref)(fullDate)(date.value.start)
				}, (0, vue.toDisplayString)((0, vue.unref)(dateText)(date.value, (0, vue.unref)(store).now.value)), 9, _hoisted_2$23)) : href.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					key: 3,
					class: "pl-value pl-value--url",
					title: `${(0, vue.unref)(strings$2).openLink}: ${href.value}`,
					onClick: (0, vue.withModifiers)(open, ["stop", "prevent"]),
					onPointerdown: _cache[0] || (_cache[0] = (0, vue.withModifiers)(() => {}, ["stop"]))
				}, (0, vue.toDisplayString)(shortUrl.value), 41, _hoisted_3$21)) : __props.property.type === "number" && value.value !== null ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_4$21, (0, vue.toDisplayString)(value.value), 1)) : (__props.property.type === "text" || __props.property.type === "url") && value.value !== null ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					key: 5,
					class: (0, vue.normalizeClass)(["pl-value", { "is-wrap": __props.wrap }]),
					title: __props.property.type === "url" ? (0, vue.unref)(strings$2).badLink : __props.wrap ? void 0 : String(value.value)
				}, (0, vue.toDisplayString)(value.value), 11, _hoisted_5$20)) : raw.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					key: 6,
					class: "pl-value pl-value--raw",
					title: (0, vue.unref)(strings$2).unsupported
				}, (0, vue.toDisplayString)(raw.value), 9, _hoisted_6$17)) : (0, vue.createCommentVNode)("v-if", true);
			};
		}
	}), [["__scopeId", "data-v-b9bf6c1e"]]);
	// plugins/planner/src/item/ItemProperties.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$24 = ["aria-label"];
	var _hoisted_2$22 = ["onContextmenu"];
	var _hoisted_3$20 = [
		"title",
		"disabled",
		"onClick"
	];
	var _hoisted_4$20 = { class: "pl-props__cell" };
	var _hoisted_5$19 = [
		"role",
		"aria-checked",
		"aria-label",
		"aria-haspopup",
		"tabindex",
		"data-value",
		"onClick",
		"onKeydown"
	];
	var _hoisted_6$16 = {
		key: 0,
		class: "pl-props__empty"
	};
	// plugins/planner/src/item/ItemProperties.vue
	var ItemProperties_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ItemProperties",
		props: {
			collection: {},
			item: {},
			readonly: { type: Boolean }
		},
		setup(__props) {
			const props = __props;
			const planner = usePlanner();
			const { mango, store } = planner;
			const rows = (0, vue.computed)(() => props.collection.properties.map((p) => {
				const value = valueOf(props.item, p);
				const unsupported = p.type === "unsupported" && props.item.values[p.id] !== void 0;
				return {
					property: p,
					empty: value === null && !unsupported,
					fixed: props.readonly || isReadonly(p),
					url: p.type === "url" && typeof value === "string" ? safeUrl(value) : null
				};
			}));
			const editing = (0, vue.shallowRef)(null);
			const editedProperty = (0, vue.computed)(() => editing.value ? propertyOf(props.collection, editing.value.propertyId) : null);
			function edit(p, e) {
				if (props.readonly || isReadonly(p)) return;
				if (p.type === "checkbox") {
					store.updateItem(props.collection.id, props.item.id, { values: { [p.id]: valueOf(props.item, p) !== true } });
					return;
				}
				editing.value = {
					propertyId: p.id,
					anchor: e.currentTarget
				};
			}
			function onValueKey(p, e) {
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					edit(p, e);
				} else if ((e.key === "Delete" || e.key === "Backspace") && !props.readonly && !isReadonly(p)) {
					e.preventDefault();
					store.updateItem(props.collection.id, props.item.id, { values: { [p.id]: null } });
				}
			}
			function menu(p, at) {
				if (!props.readonly) propertyMenu(planner, props.collection, p, at);
			}
			const addAnchor = (0, vue.shallowRef)(null);
			const list = (0, vue.ref)(null);
			/** On to its value, if it has one to fill in. */
			function onAdded(p) {
				setTimeout(() => {
					list.value?.querySelector(`[data-value="${CSS.escape(p.id)}"]`)?.focus();
				});
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					ref_key: "list",
					ref: list,
					class: "pl-props",
					role: "group",
					"aria-label": (0, vue.unref)(strings$3).properties
				}, [
					((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(rows.value, (row) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: row.property.id,
							class: "pl-props__row",
							onContextmenu: (0, vue.withModifiers)(($event) => menu(row.property, {
								x: $event.clientX,
								y: $event.clientY
							}), ["prevent"])
						}, [(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-props__name",
							title: row.property.name,
							disabled: __props.readonly,
							"aria-haspopup": "menu",
							onClick: ($event) => menu(row.property, $event.currentTarget)
						}, [(0, vue.createVNode)(PropertyIcon_default, { type: row.property.type }, null, 8, ["type"]), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)(row.property.name), 1)], 8, _hoisted_3$20), (0, vue.createElementVNode)("div", _hoisted_4$20, [
							(0, vue.createCommentVNode)(" Not a button: a link in it is pressed on its own. "),
							(0, vue.createElementVNode)("div", {
								class: (0, vue.normalizeClass)(["pl-props__value", {
									"is-fixed": row.fixed,
									"is-open": editing.value?.propertyId === row.property.id
								}]),
								role: row.fixed ? void 0 : row.property.type === "checkbox" ? "checkbox" : "button",
								"aria-checked": row.property.type === "checkbox" ? (0, vue.unref)(valueOf)(__props.item, row.property) === true : void 0,
								"aria-label": row.fixed ? void 0 : row.empty ? `${row.property.name}: ${(0, vue.unref)(strings$3).empty}` : row.property.type === "checkbox" ? row.property.name : void 0,
								"aria-haspopup": row.fixed || row.property.type === "checkbox" ? void 0 : "dialog",
								tabindex: row.fixed ? void 0 : 0,
								"data-value": row.property.id,
								onClick: ($event) => edit(row.property, $event),
								onKeydown: ($event) => onValueKey(row.property, $event)
							}, [row.empty ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_6$16, (0, vue.toDisplayString)((0, vue.unref)(strings$3).empty), 1)) : ((0, vue.openBlock)(), (0, vue.createBlock)(ValueView_default, {
								key: 1,
								property: row.property,
								item: __props.item,
								wrap: ""
							}, null, 8, ["property", "item"]))], 42, _hoisted_5$19),
							row.url ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(mango).ui.components.IconButton), {
								key: 0,
								size: "sm",
								label: (0, vue.unref)(strings$3).openLink,
								onClick: ($event) => (0, vue.unref)(mango).workspace.openBrowser(row.url)
							}, {
								default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "external-link" })]),
								_: 1
							}, 8, ["label", "onClick"])) : (0, vue.createCommentVNode)("v-if", true)
						])], 40, _hoisted_2$22);
					}), 128)),
					!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 0,
						type: "button",
						class: "pl-props__add",
						"aria-haspopup": "dialog",
						onClick: _cache[0] || (_cache[0] = ($event) => addAnchor.value = $event.currentTarget)
					}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$3).addProperty), 1)])) : (0, vue.createCommentVNode)("v-if", true),
					editing.value && editedProperty.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(ValuePopover_default, {
						key: editing.value.propertyId,
						"collection-id": __props.collection.id,
						property: editedProperty.value,
						"item-ids": [__props.item.id],
						anchor: editing.value.anchor,
						onClose: _cache[1] || (_cache[1] = ($event) => editing.value = null)
					}, null, 8, [
						"collection-id",
						"property",
						"item-ids",
						"anchor"
					])) : (0, vue.createCommentVNode)("v-if", true),
					addAnchor.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(AddProperty_default, {
						key: 2,
						"collection-id": __props.collection.id,
						anchor: addAnchor.value,
						onClose: _cache[2] || (_cache[2] = ($event) => addAnchor.value = null),
						onAdded
					}, null, 8, ["collection-id", "anchor"])) : (0, vue.createCommentVNode)("v-if", true)
				], 8, _hoisted_1$24);
			};
		}
	}), [["__scopeId", "data-v-02d7aab5"]]);
	// plugins/planner/src/item/ItemPage.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$23 = ["aria-label"];
	var _hoisted_2$21 = { class: "pl-page__head" };
	var _hoisted_3$19 = {
		key: 2,
		class: "pl-page__place"
	};
	var _hoisted_4$19 = { class: "pl-page__chat" };
	var _hoisted_5$18 = { class: "pl-page__col" };
	var _hoisted_6$15 = ["data-text"];
	var _hoisted_7$15 = [
		"value",
		"readonly",
		"aria-label",
		"placeholder"
	];
	var _hoisted_8$14 = ["aria-label"];
	var _hoisted_9$12 = ["title", "onClick"];
	var _hoisted_10$11 = {
		key: 1,
		class: "pl-chat__open is-gone"
	};
	var _hoisted_11$8 = {
		key: 0,
		class: "pl-chat"
	};
	var _hoisted_12$7 = {
		key: 1,
		class: "pl-page__note",
		role: "status"
	};
	var _hoisted_13$5 = { class: "pl-page__sub" };
	var _hoisted_14$3 = {
		key: 1,
		class: "pl-page__sub"
	};
	var _hoisted_15$3 = { class: "pl-page__sub" };
	// plugins/planner/src/item/ItemPage.vue
	var ItemPage_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ItemPage",
		props: {
			collection: {},
			itemId: {},
			mode: {}
		},
		emits: ["close", "toggle-mode"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const planner = usePlanner();
			const { mango, store } = planner;
			const { Button, IconButton, ThreadDot } = mango.ui.components;
			const state = (0, vue.computed)(() => store.items(props.collection.id));
			const item = (0, vue.computed)(() => store.item(props.collection.id, props.itemId));
			const readonly = (0, vue.computed)(() => store.sourceStatus.value.readonly);
			const root = (0, vue.ref)(null);
			const titleEl = (0, vue.ref)(null);
			const body = (0, vue.ref)(null);
			function setTitle(e) {
				const el = e.target;
				const at = el.selectionStart;
				const title = el.value.replace(/\s*\n\s*/g, " ");
				if (title !== el.value) {
					el.value = title;
					el.setSelectionRange(at, at);
				}
				store.updateItem(props.collection.id, props.itemId, { title }, { defer: true });
			}
			function onTitleKey(e) {
				if (e.isComposing) return;
				if (e.key === "Enter") {
					e.preventDefault();
					body.value?.edit();
				} else if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					root.value?.focus({ preventScroll: true });
				}
			}
			const chats = (0, vue.computed)(() => (item.value?.chats ?? []).map((id) => ({
				id,
				title: mango.chat.get(id)?.title ?? null
			})));
			/** The chat in view beside the planner, to link with one click. */
			const linkable = (0, vue.computed)(() => {
				const t = mango.chat.active();
				return t && !item.value?.chats.includes(t.id) ? {
					id: t.id,
					title: t.title
				} : null;
			});
			function chat() {
				if (item.value) startChat(planner, props.collection, item.value);
			}
			function chatMenu(e) {
				const known = chats.value.filter((c) => c.title !== null);
				if (!known.length) return chat();
				const rows = known.map((c) => ({
					label: c.title || strings$3.newChatTitle,
					icon: "message-square",
					onSelect: () => mango.chat.show(c.id)
				}));
				mango.ui.contextMenu(e.currentTarget, [...rows, {
					label: strings$3.startChat,
					icon: "message-square-plus",
					divider: true,
					onSelect: chat
				}]);
			}
			function menu(e) {
				itemMenu(planner, props.collection, [props.itemId], e.currentTarget, {
					open: null,
					deleted: () => emit("close")
				});
			}
			function onWindowKey(e) {
				if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || anyLayerOpen()) return;
				const el = e.target;
				if (!(!!el && !!root.value?.contains(el)) && !(el === document.body && root.value?.offsetParent && mango.ui.tabs.active()?.viewId === "planner")) return;
				e.preventDefault();
				emit("close");
			}
			const opener = document.activeElement;
			async function focusStart() {
				await (0, vue.nextTick)();
				if (item.value && !item.value.title && !readonly.value) titleEl.value?.focus({ preventScroll: true });
				else root.value?.focus({ preventScroll: true });
			}
			(0, vue.onMounted)(() => {
				window.addEventListener("keydown", onWindowKey);
				focusStart();
			});
			(0, vue.onBeforeUnmount)(() => {
				window.removeEventListener("keydown", onWindowKey);
				store.flush();
				if (root.value?.contains(document.activeElement) && opener?.isConnected) opener.focus({ preventScroll: true });
			});
			const scroller = (0, vue.ref)(null);
			(0, vue.watch)(() => props.itemId, () => {
				store.flush();
				scroller.value?.scrollTo({ top: 0 });
				if (item.value && !item.value.title && root.value?.contains(document.activeElement)) focusStart();
			});
			const collectionName = (0, vue.computed)(() => props.collection.name || strings$3.untitled);
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("article", {
					ref_key: "root",
					ref: root,
					class: (0, vue.normalizeClass)(["pl-page", `is-${__props.mode}`]),
					tabindex: "-1",
					"aria-label": (0, vue.unref)(strings$3).page(item.value?.title ?? "")
				}, [(0, vue.createElementVNode)("header", _hoisted_2$21, [
					__props.mode === "full" ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
						key: 0,
						label: (0, vue.unref)(strings$3).back(collectionName.value),
						shortcut: "Esc",
						onClick: _cache[0] || (_cache[0] = ($event) => emit("close"))
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "arrow-left" })]),
						_: 1
					}, 8, ["label"])) : ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
						key: 1,
						label: (0, vue.unref)(strings$3).close,
						shortcut: "Esc",
						onClick: _cache[1] || (_cache[1] = ($event) => emit("close"))
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "x" })]),
						_: 1
					}, 8, ["label"])),
					((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
						label: __props.mode === "full" ? (0, vue.unref)(strings$3).dock : (0, vue.unref)(strings$3).expand,
						onClick: _cache[2] || (_cache[2] = ($event) => emit("toggle-mode"))
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: __props.mode === "full" ? "panel-right" : "maximize-2" }, null, 8, ["name"])]),
						_: 1
					}, 8, ["label"])),
					__props.mode === "full" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_3$19, (0, vue.toDisplayString)(collectionName.value), 1)) : (0, vue.createCommentVNode)("v-if", true),
					_cache[7] || (_cache[7] = (0, vue.createElementVNode)("span", { class: "pl-page__gap" }, null, -1)),
					item.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 3 }, [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
						variant: "ghost",
						size: "sm",
						onClick: chatMenu
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "message-square" }), (0, vue.createElementVNode)("span", _hoisted_4$19, (0, vue.toDisplayString)(chats.value.some((c) => c.title !== null) ? (0, vue.unref)(strings$3).chats : (0, vue.unref)(strings$3).startChat), 1)]),
						_: 1
					})), ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
						label: (0, vue.unref)(strings$3).more,
						"aria-haspopup": "menu",
						onClick: menu
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "ellipsis" })]),
						_: 1
					}, 8, ["label"]))], 64)) : (0, vue.createCommentVNode)("v-if", true)
				]), item.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					key: 0,
					ref_key: "scroller",
					ref: scroller,
					class: "pl-page__scroll"
				}, [(0, vue.createElementVNode)("div", _hoisted_5$18, [
					(0, vue.createElementVNode)("div", {
						class: "pl-page__title",
						"data-text": `${item.value.title || (0, vue.unref)(strings$3).untitled} `
					}, [(0, vue.createElementVNode)("textarea", {
						ref_key: "titleEl",
						ref: titleEl,
						value: item.value.title,
						rows: "1",
						readonly: readonly.value,
						"aria-label": (0, vue.unref)(strings$3).title,
						placeholder: (0, vue.unref)(strings$3).untitled,
						onInput: setTitle,
						onKeydown: onTitleKey,
						onBlur: _cache[3] || (_cache[3] = ($event) => (0, vue.unref)(store).flush())
					}, null, 40, _hoisted_7$15)], 8, _hoisted_6$15),
					(0, vue.createVNode)(ItemProperties_default, {
						collection: __props.collection,
						item: item.value,
						readonly: readonly.value
					}, null, 8, [
						"collection",
						"item",
						"readonly"
					]),
					chats.value.length || linkable.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("ul", {
						key: 0,
						class: "pl-page__chats",
						"aria-label": (0, vue.unref)(strings$3).chats
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(chats.value, (c) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("li", {
							key: c.id,
							class: "pl-chat"
						}, [c.title !== null ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: 0,
							type: "button",
							class: "pl-chat__open",
							title: (0, vue.unref)(strings$3).showChat(c.title || (0, vue.unref)(strings$3).newChatTitle),
							onClick: ($event) => (0, vue.unref)(mango).chat.show(c.id)
						}, [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(ThreadDot)), { "thread-id": c.id }, null, 8, ["thread-id"])), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)(c.title || (0, vue.unref)(strings$3).newChatTitle), 1)], 8, _hoisted_9$12)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_10$11, [(0, vue.createVNode)(Icon_default, { name: "message-square" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings$3).chatGone), 1)])), !readonly.value ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
							key: 2,
							size: "sm",
							class: "pl-chat__unlink",
							label: (0, vue.unref)(strings$3).unlinkChat,
							onClick: ($event) => (0, vue.unref)(store).unlinkChat(__props.collection.id, item.value.id, c.id)
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "unlink" })]),
							_: 1
						}, 8, ["label", "onClick"])) : (0, vue.createCommentVNode)("v-if", true)]);
					}), 128)), linkable.value && !readonly.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("li", _hoisted_11$8, [(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-chat__open is-add",
						onClick: _cache[4] || (_cache[4] = ($event) => (0, vue.unref)(store).linkChat(__props.collection.id, item.value.id, linkable.value.id))
					}, [(0, vue.createVNode)(Icon_default, { name: "link" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings$3).linkActive(linkable.value.title || (0, vue.unref)(strings$3).newChatTitle)), 1)])])) : (0, vue.createCommentVNode)("v-if", true)], 8, _hoisted_8$14)) : (0, vue.createCommentVNode)("v-if", true),
					_cache[8] || (_cache[8] = (0, vue.createElementVNode)("hr", { class: "pl-page__rule" }, null, -1)),
					((0, vue.openBlock)(), (0, vue.createBlock)(ItemBody_default, {
						key: item.value.id,
						ref_key: "body",
						ref: body,
						collection: __props.collection,
						item: item.value,
						readonly: readonly.value
					}, null, 8, [
						"collection",
						"item",
						"readonly"
					]))
				])], 512)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_12$7, [state.value.status === "error" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [
					(0, vue.createElementVNode)("p", null, (0, vue.toDisplayString)((0, vue.unref)(strings$3).loadFailed), 1),
					(0, vue.createElementVNode)("p", _hoisted_13$5, (0, vue.toDisplayString)(state.value.error), 1),
					((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), { onClick: _cache[5] || (_cache[5] = ($event) => (0, vue.unref)(store).loadItems(__props.collection.id)) }, {
						default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$3).retry), 1)]),
						_: 1
					}))
				], 64)) : state.value.status !== "ready" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_14$3, (0, vue.toDisplayString)((0, vue.unref)(strings$3).loading), 1)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 2 }, [
					(0, vue.createElementVNode)("p", null, (0, vue.toDisplayString)((0, vue.unref)(strings$3).gone), 1),
					(0, vue.createElementVNode)("p", _hoisted_15$3, (0, vue.toDisplayString)((0, vue.unref)(strings$3).goneBody), 1),
					((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), { onClick: _cache[6] || (_cache[6] = ($event) => emit("close")) }, {
						default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$3).backToCollection), 1)]),
						_: 1
					}))
				], 64))]))], 10, _hoisted_1$23);
			};
		}
	}), [["__scopeId", "data-v-8c609c4b"]]);
	/** Every word of the search is somewhere in the title, the values as text, or the body. */
	function matchesSearch(collection, item, search) {
		const words = search.toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) return true;
		const parts = [item.title];
		for (const p of collection.properties) if (p.type !== "checkbox") parts.push(valueText(valueOf(item, p), p));
		parts.push(item.body);
		const text = parts.join("\n").toLowerCase();
		return words.every((w) => text.includes(w));
	}
	var isDate = (v) => typeof v === "object" && !Array.isArray(v);
	function matchesText(text, c) {
		if (c.operator === "isEmpty") return text === "";
		if (c.operator === "isNotEmpty") return text !== "";
		const a = text.trim().toLowerCase();
		const b = String(c.value).trim().toLowerCase();
		if (b === "") return true;
		switch (c.operator) {
			case "contains": return a.includes(b);
			case "notContains": return !a.includes(b);
			case "is": return a === b;
			case "isNot": return a !== b;
			case "startsWith": return a.startsWith(b);
			case "endsWith": return a.endsWith(b);
			default: return true;
		}
	}
	function matchesNumber(v, c) {
		const n = c.value;
		switch (c.operator) {
			case "eq": return v === n;
			case "neq": return v !== n;
			case "gt": return v > n;
			case "gte": return v >= n;
			case "lt": return v < n;
			case "lte": return v <= n;
			default: return true;
		}
	}
	/** By whole days: a range is in all the days it covers. */
	function matchesDate(v, c, today) {
		const start = v.start.slice(0, 10);
		const end = (v.end ?? v.start).slice(0, 10);
		const within = (from, to) => start <= to && end >= from;
		const day = typeof c.value === "string" ? c.value.slice(0, 10) : "";
		switch (c.operator) {
			case "is": return within(day, day);
			case "before": return start < day;
			case "after": return end > day;
			case "onOrBefore": return start <= day;
			case "onOrAfter": return end >= day;
			case "today": return within(today, today);
			case "overdue": return end < today;
			case "nextDays": return within(today, addDays(today, c.value));
			case "pastDays": return within(addDays(today, -c.value), today);
			default: return true;
		}
	}
	/** An unfinished condition (no value yet, or about a property that is gone) matches everything. */
	function matchesCondition(collection, item, c, now) {
		if (!isActive(c)) return true;
		if (c.propertyId === "title") return matchesText(item.title, c);
		const p = propertyOf(collection, c.propertyId);
		if (!p) return true;
		const v = valueOf(item, p);
		if (conditionValueKind(p.type, c.operator) === "text") return matchesText(typeof v === "string" ? v : "", c);
		if (c.operator === "isEmpty") return v === null;
		if (c.operator === "isNotEmpty") return v !== null;
		if (v === null) return c.operator === "isNot" || c.operator === "notContains" || c.operator === "neq";
		if (typeof v === "boolean") return v === c.value;
		if (typeof v === "number") return matchesNumber(v, c);
		if (isDate(v)) return matchesDate(v, c, localDate(now));
		const wanted = Array.isArray(c.value) ? c.value : [];
		const has = (Array.isArray(v) ? v : [v]).some((id) => wanted.includes(id));
		return c.operator === "is" || c.operator === "contains" ? has : !has;
	}
	/** Whether a condition has all it needs to filter anything. */
	function isActive(c) {
		if (isUnary(c.operator)) return true;
		return c.value !== null && c.value !== "" && !(Array.isArray(c.value) && !c.value.length);
	}
	function matchesFilter(collection, item, filter, now) {
		const active = filter.conditions.filter((c) => isActive(c) && (c.propertyId === "title" || propertyOf(collection, c.propertyId)));
		if (!active.length) return true;
		const test = (c) => matchesCondition(collection, item, c, now);
		return filter.match === "or" ? active.some(test) : active.every(test);
	}
	var text = new Intl.Collator(void 0, {
		numeric: true,
		sensitivity: "base"
	});
	function compareValues(a, b, p) {
		if (typeof a === "number" && typeof b === "number") return a - b;
		if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
		if (isDate(a) && isDate(b)) {
			if (a.start !== b.start) return a.start < b.start ? -1 : 1;
			const [x, y] = [a.end ?? a.start, b.end ?? b.start];
			return x === y ? 0 : x < y ? -1 : 1;
		}
		if (hasOptions(p)) {
			const rank = (v) => (Array.isArray(v) ? v : [v]).map((id) => p.options.findIndex((o) => o.id === id)).sort((x, y) => x - y);
			const [x, y] = [rank(a), rank(b)];
			for (let i = 0; i < Math.max(x.length, y.length); i++) {
				const d = (x[i] ?? -1) - (y[i] ?? -1);
				if (d) return d;
			}
			return 0;
		}
		return text.compare(String(a), String(b));
	}
	/** Sorted copy. Empty values are last either way; the manual order decides ties, and everything without sorts. */
	function sortItems(collection, items, sorts) {
		const out = [...items].sort(compareOrder);
		const keys = sorts.flatMap((s) => {
			if (s.propertyId === "title") return [{
				sort: s,
				property: null,
				values: new Map(out.map((i) => [i, i.title.trim() || null]))
			}];
			const property = propertyOf(collection, s.propertyId);
			return property ? [{
				sort: s,
				property,
				values: new Map(out.map((i) => [i, valueOf(i, property)]))
			}] : [];
		});
		if (!keys.length) return out;
		return out.sort((a, b) => {
			for (const { sort, property, values } of keys) {
				const x = values.get(a) ?? null;
				const y = values.get(b) ?? null;
				if (x === null || y === null) {
					if (x === y) continue;
					return x === null ? 1 : -1;
				}
				const d = property ? compareValues(x, y, property) : text.compare(String(x), String(y));
				if (d) return sort.direction === "desc" ? -d : d;
			}
			return 0;
		});
	}
	/** The groups of a property, in order. "No …" comes first, as a place for what is not sorted out yet. */
	function groupKeys(p) {
		return p.type === "checkbox" ? ["false", "true"] : ["", ...p.options.map((o) => o.id)];
	}
	/** The groups an item is in (several for a multi-select). */
	function groupsOf(item, p) {
		const v = valueOf(item, p);
		if (p.type === "checkbox") return [String(v === true)];
		if (Array.isArray(v)) return [...v];
		return [typeof v === "string" ? v : ""];
	}
	/** The value that puts an item into a group; for a multi-select, in place of group `from` when given. */
	function valueForGroup(p, key, item, from) {
		if (p.type === "checkbox") return key === "true";
		if (p.type !== "multiSelect") return key === "" ? null : key;
		if (key === "") return null;
		const value = item ? valueOf(item, p) : null;
		const now = Array.isArray(value) ? value : [];
		return from !== void 0 && now.includes(from) ? [...new Set(now.map((id) => id === from ? key : id))] : [...now.filter((id) => id !== key), key];
	}
	function groupItems(items, p, view) {
		if (!p) return [{
			key: "",
			name: "",
			color: "neutral",
			items,
			hidden: false,
			collapsed: false
		}];
		const lists = new Map(groupKeys(p).map((k) => [k, []]));
		for (const item of items) for (const key of groupsOf(item, p)) lists.get(key)?.push(item);
		return [...lists].map(([key, list]) => {
			const option = p.options.find((o) => o.id === key);
			return {
				key,
				name: option?.name ?? "",
				color: option?.color ?? "neutral",
				items: list,
				hidden: view.hiddenGroups.includes(key),
				collapsed: view.collapsedGroups.includes(key)
			};
		});
	}
	function runQuery(collection, items, view, options = {}) {
		const now = options.now ?? Date.now();
		const search = options.search?.trim() ?? "";
		const sorted = sortItems(collection, items.filter((i) => matchesFilter(collection, i, view.filter, now) && matchesSearch(collection, i, search)), view.sorts);
		const groupBy = view.groupBy ? propertyOf(collection, view.groupBy) : null;
		return {
			items: sorted,
			groups: groupItems(sorted, groupBy, view),
			groupBy,
			total: items.length
		};
	}
	/**
	* What a new item starts with: the properties' defaults, and in a view what makes it show up there: the group it
	* is added to, and what the filter plainly asks for (conditions that all must hold and name one value). A default
	* the filter would hide is left out.
	*/
	function defaultValues(collection, view, group, now = Date.now()) {
		const out = {};
		for (const p of collection.properties) {
			if (p.type !== "select" || !p.defaultOption) continue;
			const conditions = view?.filter.match === "and" ? view.filter.conditions.filter((c) => c.propertyId === p.id) : [];
			const probe = {
				id: "",
				collectionId: collection.id,
				title: "",
				icon: null,
				values: { [p.id]: p.defaultOption },
				body: "",
				order: "",
				chats: [],
				createdAt: now,
				updatedAt: now
			};
			if (conditions.every((c) => matchesCondition(collection, probe, c, now))) out[p.id] = p.defaultOption;
		}
		if (!view) return out;
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
	// plugins/planner/src/shell/CollectionIcon.vue
	var CollectionIcon_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "CollectionIcon",
		props: { collection: {} },
		setup(__props) {
			const props = __props;
			const color = (0, vue.computed)(() => props.collection.color === "neutral" ? "var(--fg-subtle)" : colorVar(props.collection.color).dot);
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
					class: "pl-cicon",
					style: (0, vue.normalizeStyle)({ color: color.value }),
					"aria-hidden": "true"
				}, [(0, vue.createVNode)(Icon_default, { name: __props.collection.icon }, null, 8, ["name"])], 4);
			};
		}
	}), [["__scopeId", "data-v-02b8ac3c"]]);
	// plugins/planner/src/shell/reorder.ts
	/** Rows or tabs put in another order with the pointer. Never HTML5 drag and drop: the desktop webview takes that over. */
	var START_PX = 4;
	function useReorder(o) {
		const dragging = (0, vue.ref)(null);
		const target = (0, vue.ref)(void 0);
		let stop = null;
		const entries = () => [...o.container()?.querySelectorAll("[data-rid]") ?? []];
		function start(e, id) {
			if (e.button !== 0 || o.disabled?.()) return;
			stop?.();
			const from = {
				x: e.clientX,
				y: e.clientY
			};
			let hold = null;
			const move = (ev) => {
				if (!dragging.value) {
					if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < START_PX) return;
					dragging.value = id;
					hold = o.hold();
					document.body.classList.add("is-reordering");
				}
				ev.preventDefault();
				const at = o.axis === "x" ? ev.clientX : ev.clientY;
				const next = entries().find((el) => {
					const r = el.getBoundingClientRect();
					return at < (o.axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2);
				});
				target.value = next?.dataset.rid ?? null;
			};
			const end = (drop) => {
				stop?.();
				const was = dragging.value;
				const t = target.value;
				const ids = entries().map((el) => el.dataset.rid);
				dragging.value = null;
				target.value = void 0;
				if (was === null) return;
				const swallow = (ev) => {
					ev.stopPropagation();
					ev.preventDefault();
				};
				window.addEventListener("click", swallow, {
					capture: true,
					once: true
				});
				setTimeout(() => window.removeEventListener("click", swallow, true));
				const same = t === void 0 || t === id || ids[ids.indexOf(id) + 1] === t || t === null && ids.at(-1) === id;
				if (drop && !same) o.onDrop(id, t === null ? "end" : { before: t });
			};
			const up = () => end(true);
			const cancel = () => end(false);
			const key = (ev) => {
				if (ev.key !== "Escape" || !dragging.value) return;
				ev.preventDefault();
				ev.stopPropagation();
				end(false);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("blur", cancel);
			window.addEventListener("keydown", key, true);
			stop = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", cancel);
				window.removeEventListener("blur", cancel);
				window.removeEventListener("keydown", key, true);
				document.body.classList.remove("is-reordering");
				hold?.dispose();
				stop = null;
			};
		}
		(0, vue.onBeforeUnmount)(() => stop?.());
		return {
			dragging,
			target,
			start
		};
	}
	/** The classes of an entry while something is dragged over the list. */
	function dropClass(r, id, last) {
		const t = r.target.value;
		return {
			"is-dragging": r.dragging.value === id,
			"is-before": t === id,
			"is-after": last && t === null
		};
	}
	/** Where Alt+arrow puts an entry: one step back or on, or null at the ends. */
	function stepPosition(ids, id, by) {
		const at = ids.indexOf(id);
		const other = ids[at + by];
		if (at < 0 || other === void 0) return null;
		return by < 0 ? { before: other } : { after: other };
	}
	/** A list with one entry put somewhere else. */
	function moved(list, idOf, id, position) {
		const entry = list.find((e) => idOf(e) === id);
		if (!entry) return [...list];
		const rest = list.filter((e) => e !== entry);
		if (position === "start") return [entry, ...rest];
		if (position === "end") return [...rest, entry];
		const key = "before" in position ? position.before : position.after;
		const at = rest.findIndex((e) => idOf(e) === key);
		if (at < 0) return [...rest, entry];
		const i = "before" in position ? at : at + 1;
		return [
			...rest.slice(0, i),
			entry,
			...rest.slice(i)
		];
	}
	// plugins/planner/src/shell/strings.ts
	/** The frame's words. */
	var shell = {
		noProjectBody: "The planner opens as a tab of a project. Collections shown everywhere are there in all of them.",
		thisProject: "This project",
		everywhere: "Everywhere",
		scope: "Where it shows",
		start: "Plan work beside your chats",
		startBody: "A collection holds items, such as tasks, bugs or notes, and shows them as a board or a table. Each item opens as a page. Everything can be changed later.",
		startList: "Start with",
		importCsv: "Import a CSV file…",
		importCsvHint: "A new collection with a property for every column.",
		importInto: "Import CSV…",
		imported: (n) => n === 1 ? "1 item imported" : `${n} items imported`,
		importFailed: "The file could not be read",
		fileTooLarge: "It is larger than 10 MB.",
		switchCollection: "Switch collection",
		findCollection: "Find a collection…",
		newCollectionRow: "New collection…",
		collectionMenu: (name) => `Options of ${name}`,
		name: "Name",
		unnamed: "Untitled",
		template: "Start from",
		create: "Create",
		cancel: "Cancel",
		icon: "Icon",
		colour: "Colour",
		description: "Description",
		itemOne: "One of its items is called",
		itemMany: "Several are called",
		editOptions: "Edit",
		heading: (word) => word.charAt(0).toUpperCase() + word.slice(1),
		editProperty: (name) => `Edit ${name}`,
		deleteProperty: (name) => `Delete ${name}`,
		backTo: (name) => name,
		done: "Done",
		editCollection: "Edit collection…",
		editCollectionTitle: "Edit collection",
		findIcon: "Find an icon…",
		duplicate: "Duplicate",
		duplicateItems: (many) => `Duplicate with ${many}`,
		transfer: "Import and export…",
		copyCsv: "Copy as CSV",
		copyMarkdown: "Copy as Markdown",
		saveCsv: "Save CSV in the project…",
		saveMarkdown: "Save Markdown in the project…",
		savePrompt: "Save in the project as",
		saveBody: "A path inside the project folder.",
		copied: "Copied",
		copyFailed: "It could not be copied",
		saved: (file) => `Saved ${file}`,
		saveFailed: "The file could not be saved",
		badPath: "Give a path inside the project, such as tasks.csv.",
		replace: (file) => `Replace ${file}?`,
		replaceBody: "A file of this name is there already.",
		replaceLabel: "Replace",
		openFile: "Open",
		deleteCollection: "Delete collection…",
		deleteConfirm: (name) => `Delete ${name}?`,
		deleteBody: (n, c) => n ? `Its ${n === 1 ? `${itemWord(c, 1)} goes` : `${n} ${itemWord(c, n)} go`} with it. You can undo this right after.` : "You can undo this right after.",
		deleteLabel: "Delete",
		undo: (what) => what ? `Undo ${what}` : "Undo",
		redo: (what) => what ? `Redo ${what}` : "Redo",
		views: "Views",
		viewMenu: "View…",
		addView: "Add a view",
		board: "Board",
		table: "Table",
		renameView: "Rename",
		viewName: "View name",
		groupedBy: (property) => `grouped by ${property}`,
		showAsBoard: "Show as a board",
		showAsTable: "Show as a table",
		deleteView: "Delete view",
		more: "More",
		addViewMenu: "Add view…",
		sortMenu: "Sort…",
		groupMenu: "Group…",
		propertiesMenu: "Properties…",
		filterItems: (many) => `Filter ${many}`,
		newNamed: (one) => `New ${one}`,
		openRepository: (name) => `Open ${name} in the browser`,
		projectNamed: (name) => `Project ${name}`,
		filter: "Filter",
		filterBy: "Filter by",
		addFilter: "Add filter",
		findProperty: "Find a property…",
		nothingFound: "Nothing found",
		title: "Title",
		matchAll: "Match all",
		matchAny: "Match any",
		matchHint: "Whether items have to match all of the filters or any of them",
		removeFilter: "Remove filter",
		editFilter: "Edit filter",
		clear: "Clear",
		clearAll: "Clear search and filters",
		clearFilters: "Clear filters",
		clearSearch: "Clear search",
		condition: "Condition",
		value: "Value",
		today: "Today",
		days: "Number of days",
		daysAre: {
			nextDays: "is in the next",
			pastDays: "is in the past"
		},
		dayCount: (n) => n === 1 ? "day" : `${n} days`,
		findOption: "Find an option…",
		noOptions: "This property has no options yet.",
		sortBy: "Sort by",
		addSort: "Add sort",
		ascending: "Ascending",
		descending: "Descending",
		removeSort: "Remove sort",
		clearSorts: "Clear sorting",
		editSort: "Change sorting",
		groupBy: "Group by",
		noGrouping: "No grouping",
		groups: "Groups",
		noGroupable: "Items can be grouped by a select, multi-select or checkbox property. This collection has none yet.",
		addProperty: "Add property",
		hide: (name) => `Hide ${name}`,
		show: (name) => `Show ${name}`,
		properties: "Properties",
		shown: "Shown in this view",
		noProperties: "No properties yet. Add one to give items a status, a date or anything else you track.",
		propertyMenu: "Property options",
		bodyPreview: "Show the start of the page on cards",
		reorder: (name) => `Move ${name} (Alt+arrow up or down)`,
		saving: "Saving…",
		readonly: "Read only",
		offline: "Offline",
		offlineBody: "Changes are kept and sent when the connection is back.",
		readonlyBody: "The planner cannot be changed right now.",
		itemsFailed: "The items could not be read",
		noMatches: (many) => `No ${many} match the filters`,
		noMatchesSearch: (text, many) => `No ${many} match “${text}”`,
		resizePane: "Resize the item",
		quickAdd: "New item",
		quickAddTo: "In",
		quickAddTitle: "Title",
		add: "Add",
		addAndOpen: "Add and open"
	};
	// plugins/planner/src/shell/PickList.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$22 = { class: "pl-pick" };
	var _hoisted_2$20 = {
		key: 0,
		class: "pl-pick__search"
	};
	var _hoisted_3$18 = [
		"aria-activedescendant",
		"aria-label",
		"placeholder"
	];
	var _hoisted_4$18 = {
		key: 1,
		class: "pl-pick__none"
	};
	var _hoisted_5$17 = [
		"aria-label",
		"aria-multiselectable",
		"tabindex",
		"aria-activedescendant"
	];
	var _hoisted_6$14 = {
		key: 0,
		class: "pl-pick__sep",
		role: "presentation"
	};
	var _hoisted_7$14 = {
		key: 1,
		class: "pl-pick__group",
		role: "presentation"
	};
	var _hoisted_8$13 = [
		"id",
		"aria-selected",
		"data-rid",
		"title",
		"onPointermove",
		"onPointerdown",
		"onClick",
		"onContextmenu"
	];
	var _hoisted_9$11 = { class: "pl-panel__label" };
	var _hoisted_10$10 = {
		key: 0,
		class: "pl-pick__aside"
	};
	var count = 0;
	// plugins/planner/src/shell/PickList.vue
	var PickList_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PickList",
		props: {
			rows: {},
			label: {},
			placeholder: {},
			multi: { type: Boolean },
			search: {
				type: Boolean,
				default: true
			},
			reorder: { default: null },
			maxHeight: { default: 320 },
			autofocus: {
				type: Boolean,
				default: true
			}
		},
		emits: [
			"pick",
			"move",
			"menu"
		],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const uid = `pl-pick-${++count}`;
			const query = (0, vue.ref)("");
			const active = (0, vue.ref)(0);
			const input = (0, vue.ref)(null);
			const list = (0, vue.ref)(null);
			const shown = (0, vue.computed)(() => {
				const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
				return props.rows.filter((r) => r.always || words.every((w) => r.label.toLowerCase().includes(w)));
			});
			const own = (0, vue.computed)(() => shown.value.filter((r) => !r.always));
			const none = (0, vue.computed)(() => query.value.trim() !== "" && !own.value.length);
			(0, vue.watch)(query, () => {
				active.value = 0;
			});
			(0, vue.watch)(() => shown.value.length, (n) => {
				active.value = Math.max(0, Math.min(active.value, n - 1));
			});
			const heading = (i) => {
				const g = shown.value[i]?.group;
				return g && g !== shown.value[i - 1]?.group ? g : null;
			};
			const divided = (i) => !!shown.value[i]?.always && i > 0 && !shown.value[i - 1].always;
			const classes = (r) => props.reorder && !r.always ? dropClass(props.reorder, r.id, r.id === own.value.at(-1)?.id) : {};
			function reveal() {
				(0, vue.nextTick)(() => list.value?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" }));
			}
			function step(by) {
				const n = shown.value.length;
				if (n) active.value = (active.value + by + n) % n;
				reveal();
			}
			function moveRow(by) {
				const row = shown.value[active.value];
				if (!row || row.always || query.value) return;
				emit("move", row.id, by);
				(0, vue.nextTick)(() => {
					const at = shown.value.findIndex((r) => r.id === row.id);
					if (at >= 0) active.value = at;
					reveal();
				});
			}
			function onKey(e) {
				if (e.isComposing || e.ctrlKey || e.metaKey) return;
				if (e.altKey && props.reorder && (e.key === "ArrowDown" || e.key === "ArrowUp")) moveRow(e.key === "ArrowDown" ? 1 : -1);
				else if (e.key === "ArrowDown") step(1);
				else if (e.key === "ArrowUp") step(-1);
				else if (e.key === "Home" && !query.value) {
					active.value = 0;
					reveal();
				} else if (e.key === "End" && !query.value) {
					active.value = Math.max(0, shown.value.length - 1);
					reveal();
				} else if (e.key === "ContextMenu" || e.key === "F10" && e.shiftKey) {
					const row = shown.value[active.value];
					const r = list.value?.querySelector(".is-active")?.getBoundingClientRect();
					if (row && r) emit("menu", row.id, {
						x: r.left + 24,
						y: r.bottom
					});
				} else if (e.key === "Enter" || e.key === " " && !props.search) {
					const row = shown.value[active.value];
					if (row) emit("pick", row.id);
				} else return;
				e.preventDefault();
				e.stopPropagation();
			}
			function onDown(e, r) {
				if (!r.always && !query.value) props.reorder?.start(e, r.id);
			}
			const focus = () => (input.value ?? list.value)?.focus({ preventScroll: true });
			(0, vue.onMounted)(() => {
				const at = props.multi ? -1 : shown.value.findIndex((r) => r.checked);
				if (at > 0) active.value = at;
				(0, vue.nextTick)(() => {
					if (props.autofocus) focus();
					reveal();
				});
			});
			__expose({ focus });
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$22, [
					__props.search ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_2$20, [(0, vue.createVNode)(Icon_default, { name: "search" }), (0, vue.withDirectives)((0, vue.createElementVNode)("input", {
						ref_key: "input",
						ref: input,
						"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => query.value = $event),
						type: "text",
						class: "pl-pick__input",
						role: "combobox",
						"aria-expanded": "true",
						"aria-controls": uid,
						"aria-activedescendant": shown.value.length ? `${uid}-${active.value}` : void 0,
						"aria-label": __props.label,
						placeholder: __props.placeholder,
						autocomplete: "off",
						spellcheck: "false",
						onKeydown: onKey
					}, null, 40, _hoisted_3$18), [[vue.vModelText, query.value]])])) : (0, vue.createCommentVNode)("v-if", true),
					none.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_4$18, (0, vue.toDisplayString)((0, vue.unref)(shell).nothingFound), 1)) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("div", {
						id: uid,
						ref_key: "list",
						ref: list,
						class: "pl-pick__list",
						role: "listbox",
						style: (0, vue.normalizeStyle)({ maxHeight: `${__props.maxHeight}px` }),
						"aria-label": __props.label,
						"aria-multiselectable": __props.multi || void 0,
						tabindex: __props.search ? -1 : 0,
						"aria-activedescendant": !__props.search && shown.value.length ? `${uid}-${active.value}` : void 0,
						onKeydown: _cache[2] || (_cache[2] = ($event) => !__props.search && onKey($event))
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(shown.value, (r, i) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: r.id }, [
							divided(i) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_6$14)) : (0, vue.createCommentVNode)("v-if", true),
							heading(i) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_7$14, (0, vue.toDisplayString)(heading(i)), 1)) : (0, vue.createCommentVNode)("v-if", true),
							(0, vue.createElementVNode)("div", {
								id: `${uid}-${i}`,
								class: (0, vue.normalizeClass)(["pl-panel__row pl-pick__row", [{ "is-active": i === active.value }, classes(r)]]),
								role: "option",
								"aria-selected": !!r.checked,
								"data-rid": r.always ? void 0 : r.id,
								title: r.label,
								onPointermove: ($event) => active.value = i,
								onPointerdown: ($event) => onDown($event, r),
								onMousedown: _cache[1] || (_cache[1] = (0, vue.withModifiers)(() => {}, ["prevent"])),
								onClick: ($event) => emit("pick", r.id),
								onContextmenu: (0, vue.withModifiers)(($event) => emit("menu", r.id, {
									x: $event.clientX,
									y: $event.clientY
								}), ["prevent"])
							}, [
								(0, vue.renderSlot)(_ctx.$slots, "icon", { row: r }, void 0, true),
								(0, vue.renderSlot)(_ctx.$slots, "default", { row: r }, () => [(0, vue.createElementVNode)("span", _hoisted_9$11, (0, vue.toDisplayString)(r.label), 1)], true),
								r.aside ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_10$10, (0, vue.toDisplayString)(r.aside), 1)) : (0, vue.createCommentVNode)("v-if", true),
								r.checked ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
									key: 1,
									name: "check",
									class: "pl-pick__check"
								})) : (0, vue.createCommentVNode)("v-if", true),
								(0, vue.renderSlot)(_ctx.$slots, "end", { row: r }, void 0, true)
							], 42, _hoisted_8$13)
						], 64);
					}), 128))], 44, _hoisted_5$17)
				]);
			};
		}
	}), [["__scopeId", "data-v-905cd5cf"]]);
	// plugins/planner/src/PickCollection.vue?vue&type=script&setup=true&lang.ts
	/** Which collection something goes into; a new one is one of the answers. */
	var NEW$1 = "+";
	// plugins/planner/src/PickCollection.vue
	var PickCollection_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PickCollection",
		props: { currentId: {} },
		emits: ["pick", "create"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store } = usePlanner();
			const rows = (0, vue.computed)(() => {
				const all = store.collections.value;
				return [...[...all.filter((c) => c.scope.kind === "project"), ...all.filter((c) => c.scope.kind !== "project")].map((c) => ({
					id: c.id,
					label: c.name || shell.unnamed,
					group: c.scope.kind === "project" ? shell.thisProject : shell.everywhere,
					checked: c.id === props.currentId
				})), {
					id: NEW$1,
					label: shell.newCollectionRow,
					always: true
				}];
			});
			function pick(id) {
				const c = store.collection(id);
				if (c) emit("pick", c);
				else emit("create");
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createBlock)(PickList_default, {
					class: "pl-choose",
					rows: rows.value,
					label: (0, vue.unref)(shell).switchCollection,
					placeholder: (0, vue.unref)(shell).findCollection,
					onPick: pick
				}, {
					icon: (0, vue.withCtx)(({ row }) => [(0, vue.unref)(store).collection(row.id) ? ((0, vue.openBlock)(), (0, vue.createBlock)(CollectionIcon_default, {
						key: 0,
						collection: (0, vue.unref)(store).collection(row.id)
					}, null, 8, ["collection"])) : ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
						key: 1,
						name: "plus"
					}))]),
					_: 1
				}, 8, [
					"rows",
					"label",
					"placeholder"
				]);
			};
		}
	}), [["__scopeId", "data-v-d6073789"]]);
	// plugins/planner/src/shell/IconPicker.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$21 = { class: "pl-icons" };
	var _hoisted_2$19 = [
		"placeholder",
		"aria-label",
		"onKeydown"
	];
	var _hoisted_3$17 = {
		key: 0,
		class: "pl-icons__none"
	};
	var _hoisted_4$17 = [
		"aria-pressed",
		"aria-label",
		"title",
		"tabindex",
		"onClick"
	];
	/** A collection's icon: a short list of lucide names that suit one, with words to find them by. */
	var PER_ROW = 8;
	// plugins/planner/src/shell/IconPicker.vue
	var IconPicker_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "IconPicker",
		props: { icon: {} },
		emits: ["icon"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const ICONS = [
				["square-kanban", "board tasks"],
				["list-todo", "tasks todo"],
				["square-check-big", "done tasks"],
				["table-2", "table"],
				["notebook-text", "notes"],
				["bug", "issue defect"],
				["rocket", "launch release"],
				["package", "release build"],
				["git-branch", "code"],
				["code", "code"],
				["terminal", "shell"],
				["wrench", "tools fix"],
				["hammer", "build"],
				["flask-conical", "test experiment"],
				["lightbulb", "ideas"],
				["target", "goal"],
				["flag", "milestone"],
				["calendar", "date plan"],
				["clock", "time"],
				["inbox", "incoming"],
				["archive", "old"],
				["bookmark", "reading saved"],
				["book-open", "docs reading"],
				["file-text", "document page"],
				["folder", "files"],
				["users", "people team"],
				["user", "person"],
				["message-circle", "chat feedback"],
				["mail", "email"],
				["phone", "call"],
				["shopping-cart", "buy"],
				["credit-card", "money payment"],
				["wallet", "money budget"],
				["trending-up", "growth metrics"],
				["palette", "design"],
				["image", "picture"],
				["camera", "photo"],
				["music", "sound"],
				["video", "film"],
				["puzzle", "plugin"],
				["layers", "stack"],
				["box", "model"],
				["database", "data"],
				["server", "host"],
				["cloud", "remote"],
				["globe", "web site"],
				["shield", "security"],
				["lock", "private"],
				["key", "access"],
				["star", "favourite"],
				["heart", "like"],
				["zap", "fast"],
				["flame", "urgent hot"],
				["sprout", "growing new"],
				["leaf", "plant"],
				["sun", "day"],
				["map", "roadmap"],
				["compass", "explore"],
				["briefcase", "work"],
				["graduation-cap", "learn study"],
				["gift", "present"],
				["coffee", "break"],
				["car", "travel"],
				["plane", "travel"]
			];
			const query = (0, vue.ref)("");
			const input = (0, vue.ref)(null);
			const grid = (0, vue.ref)(null);
			const shown = (0, vue.computed)(() => {
				const q = query.value.trim().toLowerCase();
				return ICONS.filter(([n, w]) => !q || n.includes(q) || w.includes(q)).map(([n]) => n);
			});
			const current = (0, vue.computed)(() => shown.value.includes(props.icon) ? props.icon : shown.value[0]);
			function arrows(e, perRow) {
				const by = {
					ArrowRight: 1,
					ArrowLeft: -1,
					ArrowDown: perRow,
					ArrowUp: -perRow
				}[e.key];
				if (!by) return;
				const all = [...e.currentTarget.querySelectorAll("button")];
				const next = all[all.indexOf(document.activeElement) + by];
				e.preventDefault();
				if (next) next.focus();
				else if (e.key === "ArrowUp") input.value?.focus();
			}
			function enterGrid() {
				grid.value?.querySelector("button[tabindex=\"0\"]")?.focus();
			}
			(0, vue.onMounted)(() => void (0, vue.nextTick)(() => input.value?.focus({ preventScroll: true })));
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$21, [
					(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
						ref_key: "input",
						ref: input,
						"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => query.value = $event),
						type: "text",
						class: "pl-input",
						placeholder: (0, vue.unref)(shell).findIcon,
						"aria-label": (0, vue.unref)(shell).findIcon,
						autocomplete: "off",
						spellcheck: "false",
						onKeydown: [(0, vue.withKeys)((0, vue.withModifiers)(enterGrid, ["prevent"]), ["down"]), _cache[1] || (_cache[1] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => current.value && emit("icon", current.value), ["prevent"]), ["enter"]))]
					}, null, 40, _hoisted_2$19), [[vue.vModelText, query.value]]),
					!shown.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_3$17, (0, vue.toDisplayString)((0, vue.unref)(shell).nothingFound), 1)) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("div", {
						ref_key: "grid",
						ref: grid,
						class: "pl-icons__grid",
						onKeydown: _cache[2] || (_cache[2] = ($event) => arrows($event, PER_ROW))
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(shown.value, (n) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: n,
							type: "button",
							class: (0, vue.normalizeClass)(["pl-icons__icon", { "is-on": n === __props.icon }]),
							"aria-pressed": n === __props.icon,
							"aria-label": n.replaceAll("-", " "),
							title: n.replaceAll("-", " "),
							tabindex: n === current.value ? 0 : -1,
							onClick: ($event) => emit("icon", n)
						}, [(0, vue.createVNode)(Icon_default, { name: n }, null, 8, ["name"])], 10, _hoisted_4$17);
					}), 128))], 544)
				]);
			};
		}
	}), [["__scopeId", "data-v-e6f39b8f"]]);
	// plugins/planner/src/shell/ScopeChoice.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$20 = ["aria-label", "title"];
	var _hoisted_2$18 = [
		"aria-checked",
		"tabindex",
		"onClick"
	];
	// plugins/planner/src/shell/ScopeChoice.vue
	var ScopeChoice_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ScopeChoice",
		props: {
			"modelValue": { required: true },
			"modelModifiers": {}
		},
		emits: ["update:modelValue"],
		setup(__props) {
			const model = (0, vue.useModel)(__props, "modelValue");
			const { store } = usePlanner();
			const CHOICES = [["project", shell.thisProject], ["everywhere", shell.everywhere]];
			function onKey(e) {
				if (![
					"ArrowLeft",
					"ArrowRight",
					"ArrowUp",
					"ArrowDown"
				].includes(e.key)) return;
				e.preventDefault();
				model.value = model.value === "project" ? "everywhere" : "project";
				const group = e.currentTarget;
				requestAnimationFrame(() => group.querySelector("[aria-checked=\"true\"]")?.focus());
			}
			return (_ctx, _cache) => {
				return (0, vue.unref)(store).projectPath.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					key: 0,
					class: "pl-scope",
					role: "radiogroup",
					"aria-label": (0, vue.unref)(shell).scope,
					title: (0, vue.unref)(shell).scope,
					onKeydown: onKey
				}, [((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(CHOICES, ([id, label]) => {
					return (0, vue.createElementVNode)("button", {
						key: id,
						type: "button",
						role: "radio",
						class: "pl-scope__one",
						"aria-checked": model.value === id,
						tabindex: model.value === id ? 0 : -1,
						onClick: ($event) => model.value = id
					}, (0, vue.toDisplayString)(label), 9, _hoisted_2$18);
				}), 64))], 40, _hoisted_1$20)) : (0, vue.createCommentVNode)("v-if", true);
			};
		}
	}), [["__scopeId", "data-v-566af589"]]);
	// plugins/planner/src/shell/CollectionSettings.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$19 = ["data-own-escape"];
	var _hoisted_2$17 = {
		key: 1,
		class: "pl-set"
	};
	var _hoisted_3$16 = { class: "pl-set__name" };
	var _hoisted_4$16 = [
		"disabled",
		"aria-label",
		"title",
		"aria-expanded"
	];
	var _hoisted_5$16 = ["readonly", "aria-label"];
	var _hoisted_6$13 = ["readonly"];
	var _hoisted_7$13 = { class: "pl-set__pair" };
	var _hoisted_8$12 = ["readonly", "placeholder"];
	var _hoisted_9$10 = ["readonly", "placeholder"];
	var _hoisted_10$9 = {
		key: 0,
		class: "pl-set__line"
	};
	var _hoisted_11$7 = { class: "pl-set__label" };
	var _hoisted_12$6 = {
		key: 1,
		class: "pl-set__part"
	};
	var _hoisted_13$4 = { class: "pl-set__line" };
	var _hoisted_14$2 = { class: "pl-set__label" };
	var _hoisted_15$2 = ["disabled"];
	var _hoisted_16$2 = { class: "pl-set__options" };
	var _hoisted_17$2 = { class: "pl-set__part" };
	var _hoisted_18$1 = { class: "pl-set__line" };
	var _hoisted_19$1 = { class: "pl-set__label" };
	var _hoisted_20$1 = {
		key: 0,
		class: "pl-panel__note pl-set__none"
	};
	var _hoisted_21$1 = ["data-rid", "onKeydown"];
	var _hoisted_22$1 = ["title", "onPointerdown"];
	var _hoisted_23$1 = ["title", "onClick"];
	var _hoisted_24$1 = { class: "pl-panel__label" };
	var _hoisted_25$1 = { class: "pl-set__type" };
	var _hoisted_26$1 = { class: "pl-set__foot" };
	// plugins/planner/src/shell/CollectionSettings.vue
	var CollectionSettings_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "CollectionSettings",
		props: {
			collectionId: {},
			groupBy: {},
			startAt: {}
		},
		emits: ["done", "remove"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store, mango } = usePlanner();
			const { Button, Field, IconButton } = mango.ui.components;
			const collection = (0, vue.computed)(() => store.collection(props.collectionId));
			(0, vue.watch)(collection, (c) => {
				if (!c) emit("done");
			});
			const readonly = (0, vue.computed)(() => store.sourceStatus.value.readonly);
			(0, vue.onBeforeUnmount)(() => {
				store.flush();
			});
			const name = (0, vue.ref)(collection.value?.name ?? "");
			const description = (0, vue.ref)(collection.value?.description ?? "");
			const one = (0, vue.ref)(collection.value?.itemName?.one ?? "");
			const many = (0, vue.ref)(collection.value?.itemName?.many ?? "");
			function setName() {
				if (name.value.trim()) store.updateCollection(props.collectionId, { name: name.value.trim() }, { defer: true });
			}
			function restoreName() {
				if (!name.value.trim()) name.value = collection.value?.name ?? "";
			}
			function setDescription() {
				store.updateCollection(props.collectionId, { description: description.value.trim() }, { defer: true });
			}
			function setWords() {
				const [a, b] = [one.value.trim(), many.value.trim()];
				store.updateCollection(props.collectionId, { itemName: a || b ? {
					one: a || b,
					many: b || a
				} : null }, { defer: true });
			}
			const where = (0, vue.computed)({
				get: () => collection.value?.scope.kind === "project" ? "project" : "everywhere",
				set(to) {
					const path = store.projectPath.value;
					if (to === "everywhere") store.updateCollection(props.collectionId, { scope: { kind: "everywhere" } });
					else if (path) store.updateCollection(props.collectionId, { scope: {
						kind: "project",
						path
					} });
				}
			});
			const iconAt = (0, vue.shallowRef)(null);
			const root = (0, vue.ref)(null);
			const box = (0, vue.ref)(null);
			const addAt = (0, vue.shallowRef)(null);
			const editing = (0, vue.ref)(props.startAt ?? null);
			const properties = (0, vue.computed)(() => collection.value?.properties ?? []);
			const status = (0, vue.computed)(() => {
				const c = collection.value;
				const p = c && props.groupBy ? propertyOf(c, props.groupBy) : null;
				return p && hasOptions(p) ? p : null;
			});
			const reorder = useReorder({
				axis: "y",
				container: () => box.value,
				hold: () => mango.ui.holdOverlay(),
				onDrop: (id, position) => store.moveProperty(props.collectionId, id, position),
				disabled: () => readonly.value
			});
			function step(e, id) {
				if (!e.altKey || e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
				e.preventDefault();
				const position = stepPosition(properties.value.map((p) => p.id), id, e.key === "ArrowUp" ? -1 : 1);
				if (position) store.moveProperty(props.collectionId, id, position);
			}
			function added(p) {
				if (hasOptions(p)) edit(p.id);
			}
			function edit(id) {
				editing.value = id;
				(0, vue.nextTick)(() => root.value?.querySelector(".pl-set__back")?.focus());
			}
			function back() {
				const id = editing.value;
				editing.value = null;
				(0, vue.nextTick)(() => {
					(id ? root.value?.querySelector(`[data-rid="${CSS.escape(id)}"] .pl-set__edit`) : null)?.focus();
				});
			}
			/** Backs out of the property, not of the dialog. */
			function onKey(e) {
				if (e.key !== "Escape" || !editing.value || e.defaultPrevented) return;
				e.preventDefault();
				e.stopPropagation();
				back();
			}
			return (_ctx, _cache) => {
				return collection.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					key: 0,
					ref_key: "root",
					ref: root,
					"data-own-escape": editing.value ? "" : void 0,
					onKeydown: onKey
				}, [
					editing.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-small pl-set__back",
						onClick: back
					}, [(0, vue.createVNode)(Icon_default, { name: "arrow-left" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).backTo(collection.value.name || (0, vue.unref)(shell).unnamed)), 1)]), ((0, vue.openBlock)(), (0, vue.createBlock)(PropertyEditor_default, {
						key: editing.value,
						"collection-id": __props.collectionId,
						"property-id": editing.value,
						onGone: back
					}, null, 8, ["collection-id", "property-id"]))], 64)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_2$17, [
						(0, vue.createElementVNode)("div", _hoisted_3$16, [
							(0, vue.createElementVNode)("button", {
								type: "button",
								class: "pl-set__icon",
								disabled: readonly.value,
								"aria-label": (0, vue.unref)(shell).icon,
								title: (0, vue.unref)(shell).icon,
								"aria-haspopup": "dialog",
								"aria-expanded": !!iconAt.value,
								onClick: _cache[0] || (_cache[0] = ($event) => iconAt.value = $event.currentTarget)
							}, [(0, vue.createVNode)(CollectionIcon_default, { collection: collection.value }, null, 8, ["collection"])], 8, _hoisted_4$16),
							(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
								"onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => name.value = $event),
								type: "text",
								class: "pl-input",
								readonly: readonly.value,
								"aria-label": (0, vue.unref)(shell).name,
								autocomplete: "off",
								spellcheck: "false",
								onInput: setName,
								onBlur: restoreName
							}, null, 40, _hoisted_5$16), [[vue.vModelText, name.value]]),
							(0, vue.createVNode)(ColorButton_default, {
								"model-value": collection.value.color,
								label: (0, vue.unref)(shell).colour,
								disabled: readonly.value,
								"onUpdate:modelValue": _cache[2] || (_cache[2] = (color) => (0, vue.unref)(store).updateCollection(__props.collectionId, { color }, { defer: true })),
								onChange: _cache[3] || (_cache[3] = ($event) => (0, vue.unref)(store).flush())
							}, null, 8, [
								"model-value",
								"label",
								"disabled"
							])
						]),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Field)), {
							label: (0, vue.unref)(shell).description,
							for: "pl-set-desc"
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
								id: "pl-set-desc",
								"onUpdate:modelValue": _cache[4] || (_cache[4] = ($event) => description.value = $event),
								class: "pl-input",
								type: "text",
								readonly: readonly.value,
								autocomplete: "off",
								onInput: setDescription
							}, null, 40, _hoisted_6$13), [[vue.vModelText, description.value]])]),
							_: 1
						}, 8, ["label"])),
						(0, vue.createElementVNode)("div", _hoisted_7$13, [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Field)), {
							label: (0, vue.unref)(shell).itemOne,
							for: "pl-set-one"
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
								id: "pl-set-one",
								"onUpdate:modelValue": _cache[5] || (_cache[5] = ($event) => one.value = $event),
								class: "pl-input",
								type: "text",
								readonly: readonly.value,
								placeholder: (0, vue.unref)(strings$5).item,
								autocomplete: "off",
								spellcheck: "false",
								onInput: setWords
							}, null, 40, _hoisted_8$12), [[vue.vModelText, one.value]])]),
							_: 1
						}, 8, ["label"])), ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Field)), {
							label: (0, vue.unref)(shell).itemMany,
							for: "pl-set-many"
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
								id: "pl-set-many",
								"onUpdate:modelValue": _cache[6] || (_cache[6] = ($event) => many.value = $event),
								class: "pl-input",
								type: "text",
								readonly: readonly.value,
								placeholder: (0, vue.unref)(strings$5).items,
								autocomplete: "off",
								spellcheck: "false",
								onInput: setWords
							}, null, 40, _hoisted_9$10), [[vue.vModelText, many.value]])]),
							_: 1
						}, 8, ["label"]))]),
						(0, vue.unref)(store).projectPath.value && !readonly.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_10$9, [(0, vue.createElementVNode)("span", _hoisted_11$7, (0, vue.toDisplayString)((0, vue.unref)(shell).scope), 1), (0, vue.createVNode)(ScopeChoice_default, {
							modelValue: where.value,
							"onUpdate:modelValue": _cache[7] || (_cache[7] = ($event) => where.value = $event)
						}, null, 8, ["modelValue"])])) : (0, vue.createCommentVNode)("v-if", true),
						status.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("section", _hoisted_12$6, [(0, vue.createElementVNode)("div", _hoisted_13$4, [(0, vue.createElementVNode)("h3", _hoisted_14$2, (0, vue.toDisplayString)((0, vue.unref)(shell).heading((0, vue.unref)(optionWords)(status.value).many)), 1), (0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-small",
							disabled: readonly.value,
							onClick: _cache[8] || (_cache[8] = ($event) => edit(status.value.id))
						}, [(0, vue.createVNode)(Icon_default, { name: "pencil" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).editOptions), 1)], 8, _hoisted_15$2)]), (0, vue.createElementVNode)("p", _hoisted_16$2, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(status.value.options, (o) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
								key: o.id,
								class: "pl-set__option",
								style: (0, vue.normalizeStyle)({ color: (0, vue.unref)(colorVar)(o.color).fg })
							}, [(0, vue.createElementVNode)("i", { style: (0, vue.normalizeStyle)({ background: (0, vue.unref)(colorVar)(o.color).dot }) }, null, 4), (0, vue.createTextVNode)((0, vue.toDisplayString)(o.name), 1)], 4);
						}), 128))])])) : (0, vue.createCommentVNode)("v-if", true),
						(0, vue.createElementVNode)("section", _hoisted_17$2, [
							(0, vue.createElementVNode)("div", _hoisted_18$1, [(0, vue.createElementVNode)("h3", _hoisted_19$1, (0, vue.toDisplayString)((0, vue.unref)(shell).properties), 1), !readonly.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
								key: 0,
								type: "button",
								class: "pl-small",
								"aria-haspopup": "dialog",
								onClick: _cache[9] || (_cache[9] = ($event) => addAt.value = $event.currentTarget)
							}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).addProperty), 1)])) : (0, vue.createCommentVNode)("v-if", true)]),
							!properties.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_20$1, (0, vue.toDisplayString)((0, vue.unref)(shell).noProperties), 1)) : (0, vue.createCommentVNode)("v-if", true),
							(0, vue.createElementVNode)("div", {
								ref_key: "box",
								ref: box
							}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(properties.value, (p, i) => {
								return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
									key: p.id,
									class: (0, vue.normalizeClass)(["pl-panel__row is-hoverable", (0, vue.unref)(dropClass)((0, vue.unref)(reorder), p.id, i === properties.value.length - 1)]),
									"data-rid": p.id,
									onKeydown: ($event) => step($event, p.id)
								}, [
									!readonly.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
										key: 0,
										class: "pl-panel__grip",
										title: (0, vue.unref)(shell).reorder(p.name),
										onPointerdown: ($event) => (0, vue.unref)(reorder).start($event, p.id)
									}, [(0, vue.createVNode)(Icon_default, { name: "grip-vertical" })], 40, _hoisted_22$1)) : (0, vue.createCommentVNode)("v-if", true),
									(0, vue.createElementVNode)("button", {
										type: "button",
										class: "pl-set__edit",
										title: (0, vue.unref)(shell).editProperty(p.name),
										onClick: ($event) => edit(p.id)
									}, [
										(0, vue.createVNode)(PropertyIcon_default, { type: p.type }, null, 8, ["type"]),
										(0, vue.createElementVNode)("span", _hoisted_24$1, (0, vue.toDisplayString)(p.name || (0, vue.unref)(shell).unnamed), 1),
										(0, vue.createElementVNode)("span", _hoisted_25$1, (0, vue.toDisplayString)((0, vue.unref)(strings$5).propertyTypes[p.type]), 1)
									], 8, _hoisted_23$1),
									(0, vue.createCommentVNode)(" No question first: it can be undone, and a second dialog would wait behind this one. "),
									!readonly.value ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
										key: 1,
										size: "sm",
										label: (0, vue.unref)(shell).deleteProperty(p.name),
										onClick: ($event) => (0, vue.unref)(store).deleteProperty(__props.collectionId, p.id)
									}, {
										default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "trash-2" })]),
										_: 1
									}, 8, ["label", "onClick"])) : (0, vue.createCommentVNode)("v-if", true)
								], 42, _hoisted_21$1);
							}), 128))], 512)
						]),
						(0, vue.createElementVNode)("footer", _hoisted_26$1, [!readonly.value ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							key: 0,
							variant: "danger",
							onClick: _cache[10] || (_cache[10] = ($event) => emit("remove"))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).deleteCollection), 1)]),
							_: 1
						})) : (0, vue.createCommentVNode)("v-if", true), ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							variant: "primary",
							class: "pl-set__done",
							onClick: _cache[11] || (_cache[11] = ($event) => emit("done"))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).done), 1)]),
							_: 1
						}))])
					])),
					iconAt.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 2,
						anchor: iconAt.value,
						width: 288,
						label: (0, vue.unref)(shell).icon,
						onClose: _cache[13] || (_cache[13] = ($event) => iconAt.value = null)
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(IconPicker_default, {
							icon: collection.value.icon,
							onIcon: _cache[12] || (_cache[12] = (icon) => (0, vue.unref)(store).updateCollection(__props.collectionId, { icon }))
						}, null, 8, ["icon"])]),
						_: 1
					}, 8, ["anchor", "label"])) : (0, vue.createCommentVNode)("v-if", true),
					addAt.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(AddProperty_default, {
						key: 3,
						"collection-id": __props.collectionId,
						anchor: addAt.value,
						onClose: _cache[14] || (_cache[14] = ($event) => addAt.value = null),
						onAdded: added
					}, null, 8, ["collection-id", "anchor"])) : (0, vue.createCommentVNode)("v-if", true)
				], 40, _hoisted_1$19)) : (0, vue.createCommentVNode)("v-if", true);
			};
		}
	}), [["__scopeId", "data-v-1d60dd00"]]);
	// plugins/planner/src/templates.ts
	/** What a new collection starts with. Nothing is made until the user picks one. */
	var t = strings$5.template;
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
					],
					defaultFirst: true
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
					],
					defaultFirst: true
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
			properties: [
				{
					key: "status",
					name: t.status,
					type: "select",
					options: [
						[t.backlog, "neutral"],
						[t.inProgress, "blue"],
						[t.review, "purple"],
						[t.done, "green"]
					],
					defaultFirst: true
				},
				{
					key: "tags",
					name: t.tags,
					type: "multiSelect"
				},
				{
					key: "edited",
					name: t.edited,
					type: "updatedTime"
				}
			],
			views: [{
				name: t.board,
				type: "board",
				groupBy: "status",
				show: ["tags"],
				cardPreview: "body"
			}, {
				name: t.table,
				type: "table",
				show: [
					"status",
					"tags",
					"edited"
				],
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
		...strings$5.templates[id],
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
			}])),
			...p.defaultOption ? { defaultOption: p.defaultOption } : {}
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
			cardPreview: v.cardPreview ?? "none"
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
			itemName: { ...strings$5.itemNames[id] },
			properties: Object.fromEntries(spec.properties.map((p, i) => {
				const options = p.options?.map(([name, color]) => ({
					id: newId(),
					name,
					color
				}));
				return [idOf(p.key), propertyData({
					name: p.name,
					type: p.type,
					order: propertyKeys[i],
					options,
					defaultOption: p.defaultFirst ? options?.[0]?.id : null
				})];
			})),
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
				cardPreview: v.cardPreview,
				sorts: v.sorts?.map(([p, direction]) => ({
					propertyId: idOf(p),
					direction
				}))
			}, viewKeys[i])]))
		};
	}
	// plugins/planner/src/shell/collectionMenu.ts
	var MAX_CSV = 10485760;
	var message = (e) => e instanceof Error ? e.message : String(e);
	/** Asks for a CSV file; null when none was chosen or it could not be read. */
	function pickCsv(mango) {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = ".csv,.tsv,.txt,text/csv";
			const fail = (body) => {
				mango.ui.toast({
					title: shell.importFailed,
					body,
					kind: "error"
				});
				resolve(null);
			};
			input.addEventListener("cancel", () => resolve(null));
			input.addEventListener("change", () => {
				const file = input.files?.[0];
				if (!file) return resolve(null);
				if (file.size > MAX_CSV) return fail(shell.fileTooLarge);
				file.text().then((text) => resolve({
					name: file.name.replace(/\.[^.]+$/, ""),
					text
				}), (e) => fail(message(e)));
			});
			input.click();
		});
	}
	async function importAsCollection({ mango, store }, scope) {
		const file = await pickCsv(mango);
		return file ? store.importCsvAsCollection(file.text, file.name, scope) : null;
	}
	async function importInto({ mango, store }, id) {
		const file = await pickCsv(mango);
		const n = file ? await store.importCsv(id, file.text) : 0;
		if (n) mango.ui.toast({
			title: shell.imported(n),
			kind: "success"
		});
	}
	var exported = (store, id, format) => format === "csv" ? store.exportCsv(id) : store.exportMarkdown(id);
	async function copy({ mango, store }, id, format) {
		const text = await exported(store, id, format);
		if (text === null) return;
		try {
			await navigator.clipboard.writeText(text.replace(/^﻿/, ""));
			mango.ui.toast({
				title: shell.copied,
				kind: "success",
				timeout: 2500
			});
		} catch (e) {
			mango.ui.toast({
				title: shell.copyFailed,
				body: message(e),
				kind: "error"
			});
		}
	}
	/** Mango has no "save as" for plugins, so a file goes into the project. */
	async function save({ mango, store }, c, format) {
		const project = mango.workspace.workdir() ?? mango.workspace.activeProject();
		if (!project) return;
		const slug = c.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "planner";
		const answer = (await mango.ui.prompt({
			title: shell.savePrompt,
			body: shell.saveBody,
			value: `${slug}.${format}`
		}))?.trim();
		if (answer === void 0) return;
		const parts = answer.split(/[\\/]+/);
		if (!answer || /^[\\/]|^[a-z]:/i.test(answer) || parts.some((p) => !p || p === "." || p === "..")) return mango.ui.toast({
			title: shell.saveFailed,
			body: shell.badPath,
			kind: "error"
		});
		const sep = project.includes("\\") && !project.includes("://") ? "\\" : "/";
		const join = (names) => [project.replace(/[\\/]+$/, ""), ...names].join(sep);
		const name = parts.at(-1);
		try {
			if ((await mango.files.list(join(parts.slice(0, -1))).catch(() => [])).some((e) => e.name.toLowerCase() === name.toLowerCase())) {
				if (!await mango.ui.confirm({
					title: shell.replace(name),
					body: shell.replaceBody,
					confirmLabel: shell.replaceLabel,
					danger: true
				})) return;
			}
			const text = await exported(store, c.id, format);
			if (text === null) return;
			const path = join(parts);
			await mango.files.write(path, text);
			mango.ui.toast({
				title: shell.saved(name),
				kind: "success",
				action: {
					label: shell.openFile,
					run: () => mango.workspace.openFile(path)
				}
			});
		} catch (e) {
			mango.ui.toast({
				title: shell.saveFailed,
				body: message(e),
				kind: "error"
			});
		}
	}
	/** Without what reading or asking needs: the caller composes them. The last is Delete. */
	function collectionRows(planner, c, groupBy) {
		const { store, go } = planner;
		const locked = store.sourceStatus.value.readonly;
		async function duplicate(items) {
			const made = await store.duplicateCollection(c.id, { items });
			if (made) go({ collectionId: made.id });
		}
		return [
			{
				label: shell.editCollection,
				icon: "settings-2",
				onSelect: () => void editCollection(planner, c, groupBy)
			},
			{
				label: shell.duplicate,
				icon: "copy",
				disabled: locked,
				onSelect: () => void duplicate(false)
			},
			{
				label: shell.duplicateItems(itemWord(c, 2)),
				icon: "copy-plus",
				disabled: locked,
				onSelect: () => void duplicate(true)
			},
			{
				label: shell.deleteCollection,
				icon: "trash-2",
				danger: true,
				divider: true,
				disabled: locked,
				onSelect: () => void removeCollection(planner, c)
			}
		];
	}
	async function editCollection(planner, c, groupBy) {
		if (await askCollectionSettings(planner, c.id, groupBy ?? null) === "remove") await removeCollection(planner, c);
	}
	async function removeCollection({ mango, store, go, route }, c) {
		if (!await store.loadItems(c.id)) return mango.ui.toast({
			title: shell.itemsFailed,
			body: store.items(c.id).error ?? "",
			kind: "error"
		});
		const body = shell.deleteBody(store.items(c.id).items.length, c);
		if (await mango.ui.confirm({
			title: shell.deleteConfirm(c.name || shell.unnamed),
			body,
			confirmLabel: shell.deleteLabel,
			danger: true
		}) && await store.deleteCollection(c.id) && route.value.collectionId === c.id) go({ collectionId: null });
	}
	function transferRows(planner, c) {
		const project = planner.store.projectPath.value;
		return [
			{
				label: shell.importInto,
				icon: "file-input",
				disabled: planner.store.sourceStatus.value.readonly,
				onSelect: () => void importInto(planner, c.id)
			},
			{
				label: shell.copyCsv,
				icon: "table",
				divider: true,
				onSelect: () => void copy(planner, c.id, "csv")
			},
			{
				label: shell.copyMarkdown,
				icon: "file-text",
				onSelect: () => void copy(planner, c.id, "md")
			},
			{
				label: shell.saveCsv,
				icon: "file-down",
				disabled: !project,
				onSelect: () => void save(planner, c, "csv")
			},
			{
				label: shell.saveMarkdown,
				icon: "file-down",
				disabled: !project,
				onSelect: () => void save(planner, c, "md")
			}
		];
	}
	// plugins/planner/src/shell/scope.ts
	function scopeOf(store, where) {
		const path = store.projectPath.value;
		return where === "project" && path ? {
			kind: "project",
			path
		} : { kind: "everywhere" };
	}
	// plugins/planner/src/shell/NewCollection.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$18 = ["placeholder"];
	var _hoisted_2$16 = { class: "pl-new__part" };
	var _hoisted_3$15 = { class: "pl-new__label" };
	var _hoisted_4$15 = ["aria-label"];
	var _hoisted_5$15 = [
		"aria-checked",
		"tabindex",
		"onClick"
	];
	var _hoisted_6$12 = { class: "pl-new__name" };
	var _hoisted_7$12 = { class: "pl-panel__label is-off" };
	var _hoisted_8$11 = { class: "pl-new__foot" };
	// plugins/planner/src/shell/NewCollection.vue
	var NewCollection_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "NewCollection",
		emits: ["made", "cancel"],
		setup(__props, { emit: __emit }) {
			const emit = __emit;
			const planner = usePlanner();
			const { store, mango } = planner;
			const { Button, Field } = mango.ui.components;
			const name = (0, vue.ref)("");
			const template = (0, vue.ref)("tasks");
			const where = (0, vue.ref)(store.projectPath.value ? "project" : "everywhere");
			const chosen = (0, vue.computed)(() => TEMPLATES.find((t) => t.id === template.value));
			const group = (0, vue.ref)(null);
			function create() {
				const made = store.createCollection({
					name: name.value,
					template: template.value,
					scope: scopeOf(store, where.value)
				});
				if (made) emit("made", made);
			}
			async function load() {
				const made = await importAsCollection(planner, scopeOf(store, where.value));
				if (!made) return;
				if (name.value.trim()) store.updateCollection(made.id, { name: name.value.trim() });
				emit("made", store.collection(made.id) ?? made);
			}
			function onKey(e) {
				const by = {
					ArrowDown: 1,
					ArrowUp: -1
				}[e.key];
				if (!by) return;
				e.preventDefault();
				const at = TEMPLATES.findIndex((t) => t.id === template.value);
				template.value = TEMPLATES[(at + by + TEMPLATES.length) % TEMPLATES.length].id;
				requestAnimationFrame(() => {
					if (group.value?.contains(document.activeElement)) group.value.querySelector("[aria-checked=\"true\"]")?.focus();
				});
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("form", {
					class: "pl-new",
					onSubmit: (0, vue.withModifiers)(create, ["prevent"])
				}, [
					((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Field)), {
						label: (0, vue.unref)(shell).name,
						for: "pl-new-name"
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
							id: "pl-new-name",
							"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => name.value = $event),
							class: "input",
							type: "text",
							placeholder: chosen.value.name,
							autocomplete: "off",
							spellcheck: "false",
							onKeydown: onKey
						}, null, 40, _hoisted_1$18), [[vue.vModelText, name.value]])]),
						_: 1
					}, 8, ["label"])),
					(0, vue.createElementVNode)("div", _hoisted_2$16, [
						(0, vue.createElementVNode)("span", _hoisted_3$15, (0, vue.toDisplayString)((0, vue.unref)(shell).template), 1),
						(0, vue.createElementVNode)("div", {
							ref_key: "group",
							ref: group,
							role: "radiogroup",
							"aria-label": (0, vue.unref)(shell).template,
							class: "pl-new__list",
							onKeydown: onKey
						}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)((0, vue.unref)(TEMPLATES), (t) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
								key: t.id,
								type: "button",
								role: "radio",
								class: (0, vue.normalizeClass)(["pl-panel__row pl-new__row", { "is-on": t.id === template.value }]),
								"aria-checked": t.id === template.value,
								tabindex: t.id === template.value ? 0 : -1,
								onClick: ($event) => template.value = t.id,
								onDblclick: create
							}, [
								(0, vue.createVNode)(Icon_default, { name: t.icon }, null, 8, ["name"]),
								(0, vue.createElementVNode)("span", _hoisted_6$12, (0, vue.toDisplayString)(t.name), 1),
								(0, vue.createElementVNode)("span", _hoisted_7$12, (0, vue.toDisplayString)(t.description), 1)
							], 42, _hoisted_5$15);
						}), 128))], 40, _hoisted_4$15),
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-small",
							onClick: load
						}, [(0, vue.createVNode)(Icon_default, { name: "file-input" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).importCsv), 1)])
					]),
					(0, vue.createElementVNode)("footer", _hoisted_8$11, [
						(0, vue.createVNode)(ScopeChoice_default, {
							modelValue: where.value,
							"onUpdate:modelValue": _cache[1] || (_cache[1] = ($event) => where.value = $event)
						}, null, 8, ["modelValue"]),
						_cache[3] || (_cache[3] = (0, vue.createElementVNode)("span", { class: "pl-new__space" }, null, -1)),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							variant: "ghost",
							onClick: _cache[2] || (_cache[2] = ($event) => emit("cancel"))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).cancel), 1)]),
							_: 1
						})),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							variant: "primary",
							type: "submit"
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).create), 1)]),
							_: 1
						}))
					])
				], 32);
			};
		}
	}), [["__scopeId", "data-v-f54a769e"]]);
	// plugins/planner/src/shell/keys.ts
	var isMac = (mango) => mango.platform === "macos" || mango.platform === "browser" && /Mac/.test(navigator.platform);
	/** `keyLabel(mango, 'Shift', 'Z')`: `Ctrl+Shift+Z`, or `⌘⇧Z` on a Mac. */
	function keyLabel(mango, ...keys) {
		const mac = isMac(mango);
		return [mac ? "⌘" : "Ctrl", ...keys.map((k) => mac && k === "Shift" ? "⇧" : k)].join(mac ? "" : "+");
	}
	var isMod = (mango, e) => isMac(mango) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
	function inTextField(target) {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
		return target instanceof HTMLInputElement && ![
			"checkbox",
			"radio",
			"button",
			"range",
			"color",
			"file"
		].includes(target.type);
	}
	// plugins/planner/src/shell/QuickAdd.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$17 = ["placeholder", "aria-label"];
	var _hoisted_2$15 = { class: "pl-quick__in" };
	var _hoisted_3$14 = ["aria-expanded"];
	var _hoisted_4$14 = { class: "pl-panel__label" };
	var _hoisted_5$14 = { class: "pl-quick__foot" };
	// plugins/planner/src/shell/QuickAdd.vue
	var QuickAdd_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "QuickAdd",
		props: { collectionId: {} },
		emits: ["added", "cancel"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store, mango } = usePlanner();
			const { Button } = mango.ui.components;
			const title = (0, vue.ref)("");
			const id = (0, vue.ref)(props.collectionId);
			const choosing = (0, vue.ref)(false);
			const busy = (0, vue.ref)(false);
			const input = (0, vue.ref)(null);
			const collection = (0, vue.computed)(() => store.collection(id.value) ?? store.collections.value[0] ?? null);
			const rows = (0, vue.computed)(() => store.collections.value.map((c) => ({
				id: c.id,
				label: c.name || shell.unnamed,
				checked: c.id === collection.value?.id
			})));
			async function add(open) {
				const c = collection.value;
				const text = title.value.trim();
				if (!c || busy.value || !text && !open) return;
				busy.value = true;
				const item = await store.createItem(c.id, { title: text }).finally(() => {
					busy.value = false;
				});
				if (item) emit("added", c, item, open);
			}
			function pick(picked) {
				id.value = picked;
				choosing.value = false;
				(0, vue.nextTick)(() => input.value?.focus());
			}
			function onKey(e) {
				if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
				e.preventDefault();
				add(true);
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("form", {
					class: "pl-quick",
					onSubmit: _cache[4] || (_cache[4] = (0, vue.withModifiers)(($event) => add(false), ["prevent"])),
					onKeydown: onKey
				}, [
					(0, vue.withDirectives)((0, vue.createElementVNode)("input", {
						ref_key: "input",
						ref: input,
						"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => title.value = $event),
						class: "pl-input pl-quick__title",
						type: "text",
						placeholder: (0, vue.unref)(shell).quickAddTitle,
						"aria-label": (0, vue.unref)(shell).quickAddTitle,
						autocomplete: "off"
					}, null, 8, _hoisted_1$17), [[vue.vModelText, title.value]]),
					(0, vue.createElementVNode)("div", _hoisted_2$15, [(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(shell).quickAddTo), 1), collection.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 0,
						type: "button",
						class: "pl-small pl-quick__pick",
						"aria-expanded": choosing.value,
						onClick: _cache[1] || (_cache[1] = ($event) => choosing.value = !choosing.value)
					}, [
						(0, vue.createVNode)(CollectionIcon_default, { collection: collection.value }, null, 8, ["collection"]),
						(0, vue.createElementVNode)("span", _hoisted_4$14, (0, vue.toDisplayString)(collection.value.name || (0, vue.unref)(shell).unnamed), 1),
						(0, vue.createVNode)(Icon_default, { name: "chevron-down" })
					], 8, _hoisted_3$14)) : (0, vue.createCommentVNode)("v-if", true)]),
					choosing.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(PickList_default, {
						key: 0,
						rows: rows.value,
						label: (0, vue.unref)(shell).switchCollection,
						placeholder: (0, vue.unref)(shell).findCollection,
						search: rows.value.length > 7,
						"max-height": 200,
						onPick: pick
					}, {
						icon: (0, vue.withCtx)(({ row }) => [(0, vue.unref)(store).collection(row.id) ? ((0, vue.openBlock)(), (0, vue.createBlock)(CollectionIcon_default, {
							key: 0,
							collection: (0, vue.unref)(store).collection(row.id)
						}, null, 8, ["collection"])) : (0, vue.createCommentVNode)("v-if", true)]),
						_: 1
					}, 8, [
						"rows",
						"label",
						"placeholder",
						"search"
					])) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("footer", _hoisted_5$14, [
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							variant: "ghost",
							onClick: _cache[2] || (_cache[2] = ($event) => emit("cancel"))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).cancel), 1)]),
							_: 1
						})),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							disabled: busy.value,
							title: (0, vue.unref)(keyLabel)((0, vue.unref)(mango), "Enter"),
							onClick: _cache[3] || (_cache[3] = ($event) => add(true))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).addAndOpen), 1)]),
							_: 1
						}, 8, ["disabled", "title"])),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							variant: "primary",
							type: "submit",
							loading: busy.value,
							disabled: !title.value.trim(),
							title: "Enter"
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).add), 1)]),
							_: 1
						}, 8, ["loading", "disabled"]))
					])
				], 32);
			};
		}
	}), [["__scopeId", "data-v-5752f7ce"]]);
	// plugins/planner/src/shell/dialogs.ts
	/** The planner's dialogs. They show in Mango's dialog, outside of the planner's tab, and get what its components need. */
	/** Shows a component in a dialog; `answer` closes it. Resolves with the answer, or null when it was closed. */
	async function ask(planner, title, width, view, on) {
		let result = null;
		await planner.mango.ui.dialog({
			title,
			width,
			view: { component: (0, vue.defineComponent)({
				props: ["ctx"],
				setup(props) {
					(0, vue.provide)(PLANNER, planner);
					const answer = (value) => {
						result = value;
						props.ctx?.close();
					};
					return () => (0, vue.h)(view, on(answer));
				}
			}) }
		});
		return result;
	}
	var askNewCollection = (planner) => ask(planner, strings$5.newCollection, 480, NewCollection_default, (answer) => ({
		onMade: answer,
		onCancel: () => answer(null)
	}));
	/** The collection the user picks, or makes. */
	async function askCollection(planner) {
		if (!planner.store.collections.value.length) return askNewCollection(planner);
		const picked = await ask(planner, strings$5.chooseCollection, 380, PickCollection_default, (answer) => ({
			currentId: planner.store.lastCollection(),
			onPick: answer,
			onCreate: () => answer("new")
		}));
		return picked === "new" ? askNewCollection(planner) : picked;
	}
	var askNewItem = (planner, collectionId) => ask(planner, shell.quickAdd, 440, QuickAdd_default, (answer) => ({
		collectionId,
		onAdded: (collection, item, open) => answer({
			collection,
			item,
			open
		}),
		onCancel: () => answer(null)
	}));
	/** `remove`: it is to be deleted, which asks in a dialog of its own. */
	var askCollectionSettings = (planner, collectionId, groupBy) => ask(planner, shell.editCollectionTitle, 480, CollectionSettings_default, (answer) => ({
		collectionId,
		groupBy,
		onDone: () => answer(null),
		onRemove: () => answer("remove")
	}));
	// plugins/planner/src/shell/filters.ts
	/** Filters and sorts in words, and changing them. */
	var propertyName = (c, id) => id === "title" ? shell.title : propertyOf(c, id)?.name || shell.unnamed;
	var operatorText = (o) => o === "nextDays" || o === "pastDays" ? shell.daysAre[o] : strings$5.operators[o];
	/** A condition's value in words; '' while it has none. */
	function conditionText(c, condition) {
		const { propertyId, operator, value } = condition;
		const property = propertyOf(c, propertyId);
		switch (conditionValueKind(property?.type ?? "title", operator)) {
			case "none": return "";
			case "options": return (Array.isArray(value) ? value : []).map((id) => property?.options.find((o) => o.id === id)?.name ?? "").filter(Boolean).join(", ");
			case "checkbox": return value === null ? "" : value ? strings$5.checked.toLowerCase() : strings$5.unchecked.toLowerCase();
			case "date": return typeof value === "string" ? dateText({ start: value.slice(0, 10) }, Date.now()) : "";
			case "number":
				if (typeof value !== "number") return "";
				return operator === "nextDays" || operator === "pastDays" ? shell.dayCount(value) : String(value);
			default: return typeof value === "string" ? value : "";
		}
	}
	/** The title and the properties, to pick one. */
	function propertyRows(c, except = []) {
		return [{
			id: TITLE,
			label: shell.title
		}, ...c.properties.map((p) => ({
			id: p.id,
			label: p.name || shell.unnamed
		}))].filter((r) => !except.includes(r.id));
	}
	function newCondition(c, propertyId) {
		const type = propertyOf(c, propertyId)?.type ?? "title";
		const operator = operatorsFor(type)[0];
		return {
			id: newId(),
			propertyId,
			operator,
			value: conditionValueKind(type, operator) === "checkbox" ? true : null
		};
	}
	function setFilter(store, c, v, change, typing = false) {
		store.updateView(c.id, v.id, { filter: {
			...v.filter,
			...change
		} }, { defer: typing });
	}
	function setSorts(store, c, v, sorts) {
		store.updateView(c.id, v.id, { sorts });
	}
	// plugins/planner/src/shell/ConditionEditor.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$16 = { class: "pl-cond" };
	var _hoisted_2$14 = { class: "pl-cond__head" };
	var _hoisted_3$13 = { class: "pl-cond__name" };
	var _hoisted_4$13 = [
		"aria-label",
		"aria-expanded",
		"data-autofocus"
	];
	var _hoisted_5$13 = ["aria-label", "title"];
	var _hoisted_6$11 = {
		key: 0,
		class: "pl-panel__note"
	};
	var _hoisted_7$11 = { class: "pl-cond__option" };
	var _hoisted_8$10 = {
		key: 3,
		class: "pl-cond__field"
	};
	var _hoisted_9$9 = ["value", "aria-label"];
	var _hoisted_10$8 = [
		"value",
		"placeholder",
		"aria-label"
	];
	var _hoisted_11$6 = [
		"value",
		"placeholder",
		"aria-label"
	];
	// plugins/planner/src/shell/ConditionEditor.vue
	var ConditionEditor_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ConditionEditor",
		props: {
			collection: {},
			condition: {}
		},
		emits: [
			"change",
			"remove",
			"done"
		],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store } = usePlanner();
			const property = (0, vue.computed)(() => propertyOf(props.collection, props.condition.propertyId));
			const type = (0, vue.computed)(() => property.value?.type ?? "title");
			const operators = (0, vue.computed)(() => operatorsFor(type.value).map((o) => ({
				id: o,
				label: operatorText(o),
				checked: o === props.condition.operator
			})));
			const kind = (0, vue.computed)(() => conditionValueKind(type.value, props.condition.operator));
			const choosing = (0, vue.ref)(false);
			const field = (0, vue.ref)(null);
			const value = (0, vue.computed)(() => props.condition.value);
			/** A number as it is typed: `-` and `1.` are on the way to one. */
			const draft = (0, vue.ref)(typeof props.condition.value === "number" ? String(props.condition.value) : "");
			const chosen = (0, vue.computed)(() => Array.isArray(value.value) ? value.value : []);
			const options = (0, vue.computed)(() => (property.value?.options ?? []).map((o) => ({
				id: o.id,
				label: o.name,
				checked: chosen.value.includes(o.id)
			})));
			const optionOf = (id) => property.value.options.find((o) => o.id === id);
			const checks = (0, vue.computed)(() => [{
				id: "true",
				label: strings$5.checked,
				checked: value.value === true
			}, {
				id: "false",
				label: strings$5.unchecked,
				checked: value.value === false
			}]);
			function setOperator(id) {
				const operator = id;
				choosing.value = false;
				const next = conditionValueKind(type.value, operator);
				if (next !== kind.value) draft.value = "";
				emit("change", next === kind.value ? { operator } : {
					operator,
					value: next === "checkbox" ? true : null
				});
				(0, vue.nextTick)(() => field.value?.focus());
			}
			function toggle(id) {
				const now = chosen.value;
				const next = now.includes(id) ? now.filter((i) => i !== id) : [...now, id];
				emit("change", { value: next.length ? next : null });
			}
			function setText(text) {
				emit("change", { value: text === "" ? null : text }, true);
			}
			function setNumber(text) {
				draft.value = text;
				const n = Number(text.trim().replace(",", "."));
				emit("change", { value: text.trim() === "" || !Number.isFinite(n) ? null : n }, true);
			}
			function setDate(text) {
				emit("change", { value: text || null }, true);
			}
			(0, vue.onMounted)(() => void (0, vue.nextTick)(() => field.value?.select()));
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$16, [(0, vue.createElementVNode)("div", _hoisted_2$14, [
					(0, vue.createElementVNode)("span", _hoisted_3$13, (0, vue.toDisplayString)((0, vue.unref)(propertyName)(__props.collection, __props.condition.propertyId)), 1),
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-small pl-cond__op",
						"aria-label": `${(0, vue.unref)(shell).condition}: ${(0, vue.unref)(operatorText)(__props.condition.operator)}`,
						"aria-expanded": choosing.value,
						"data-autofocus": kind.value === "none" ? "" : void 0,
						onClick: _cache[0] || (_cache[0] = ($event) => choosing.value = !choosing.value)
					}, [(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(operatorText)(__props.condition.operator)), 1), (0, vue.createVNode)(Icon_default, { name: "chevron-down" })], 8, _hoisted_4$13),
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-small pl-cond__remove",
						"aria-label": (0, vue.unref)(shell).removeFilter,
						title: (0, vue.unref)(shell).removeFilter,
						onClick: _cache[1] || (_cache[1] = ($event) => emit("remove"))
					}, [(0, vue.createVNode)(Icon_default, { name: "trash-2" })], 8, _hoisted_5$13)
				]), choosing.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(PickList_default, {
					key: 0,
					rows: operators.value,
					label: (0, vue.unref)(shell).condition,
					search: false,
					onPick: setOperator
				}, null, 8, ["rows", "label"])) : kind.value === "options" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [!options.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_6$11, (0, vue.toDisplayString)((0, vue.unref)(shell).noOptions), 1)) : ((0, vue.openBlock)(), (0, vue.createBlock)(PickList_default, {
					key: 1,
					rows: options.value,
					label: (0, vue.unref)(shell).value,
					placeholder: (0, vue.unref)(shell).findOption,
					search: options.value.length > 7,
					"max-height": 260,
					multi: "",
					onPick: toggle
				}, {
					default: (0, vue.withCtx)(({ row }) => [(0, vue.createElementVNode)("span", _hoisted_7$11, [(0, vue.createVNode)(OptionTag_default, { option: optionOf(row.id) }, null, 8, ["option"])])]),
					_: 1
				}, 8, [
					"rows",
					"label",
					"placeholder",
					"search"
				]))], 64)) : kind.value === "checkbox" ? ((0, vue.openBlock)(), (0, vue.createBlock)(PickList_default, {
					key: 2,
					rows: checks.value,
					label: (0, vue.unref)(shell).value,
					search: false,
					onPick: _cache[2] || (_cache[2] = (id) => emit("change", { value: id === "true" }))
				}, null, 8, ["rows", "label"])) : kind.value !== "none" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_8$10, [kind.value === "date" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("input", {
					key: 0,
					ref_key: "field",
					ref: field,
					type: "date",
					class: "pl-input",
					"data-autofocus": "",
					value: typeof value.value === "string" ? value.value.slice(0, 10) : "",
					"aria-label": (0, vue.unref)(shell).value,
					onInput: _cache[3] || (_cache[3] = ($event) => setDate($event.target.value)),
					onKeydown: _cache[4] || (_cache[4] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => emit("done"), ["prevent"]), ["enter"]))
				}, null, 40, _hoisted_9$9)) : kind.value === "number" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("input", {
					key: 1,
					ref_key: "field",
					ref: field,
					type: "text",
					inputmode: "decimal",
					class: "pl-input",
					"data-autofocus": "",
					value: draft.value,
					placeholder: type.value === "number" ? (0, vue.unref)(shell).value : (0, vue.unref)(shell).days,
					"aria-label": type.value === "number" ? (0, vue.unref)(shell).value : (0, vue.unref)(shell).days,
					onInput: _cache[5] || (_cache[5] = ($event) => setNumber($event.target.value)),
					onKeydown: _cache[6] || (_cache[6] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => emit("done"), ["prevent"]), ["enter"]))
				}, null, 40, _hoisted_10$8)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("input", {
					key: 2,
					ref_key: "field",
					ref: field,
					type: "text",
					class: "pl-input",
					"data-autofocus": "",
					value: value.value ?? "",
					placeholder: (0, vue.unref)(shell).value,
					"aria-label": (0, vue.unref)(shell).value,
					autocomplete: "off",
					spellcheck: "false",
					onInput: _cache[7] || (_cache[7] = ($event) => setText($event.target.value)),
					onKeydown: _cache[8] || (_cache[8] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => emit("done"), ["prevent"]), ["enter"]))
				}, null, 40, _hoisted_11$6)), kind.value === "date" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
					key: 3,
					type: "button",
					class: "pl-small",
					onClick: _cache[9] || (_cache[9] = ($event) => setDate((0, vue.unref)(localDate)((0, vue.unref)(store).now.value)))
				}, (0, vue.toDisplayString)((0, vue.unref)(shell).today), 1)) : (0, vue.createCommentVNode)("v-if", true)])) : (0, vue.createCommentVNode)("v-if", true)]);
			};
		}
	}), [["__scopeId", "data-v-f7301b42"]]);
	// plugins/planner/src/shell/SortPanel.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$15 = { class: "pl-panel pl-sort" };
	var _hoisted_2$13 = ["data-rid", "onKeydown"];
	var _hoisted_3$12 = ["title", "onPointerdown"];
	var _hoisted_4$12 = { class: "pl-panel__label" };
	var _hoisted_5$12 = ["onClick"];
	var _hoisted_6$10 = { class: "pl-panel__label" };
	var _hoisted_7$10 = { class: "pl-panel__label" };
	// plugins/planner/src/shell/SortPanel.vue
	var SortPanel_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "SortPanel",
		props: {
			collection: {},
			view: {}
		},
		emits: ["close"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store, mango } = usePlanner();
			const { IconButton } = mango.ui.components;
			const box = (0, vue.ref)(null);
			const adding = (0, vue.ref)(!props.view.sorts.length);
			const sorts = (0, vue.computed)(() => props.view.sorts);
			const rest = (0, vue.computed)(() => propertyRows(props.collection, sorts.value.map((s) => s.propertyId)));
			const set = (next) => setSorts(store, props.collection, props.view, next);
			const typeOf = (id) => id === "title" ? "text" : propertyOf(props.collection, id)?.type ?? "text";
			const reorder = useReorder({
				axis: "y",
				container: () => box.value,
				hold: () => mango.ui.holdOverlay(),
				onDrop: (id, position) => set(moved(sorts.value, (s) => s.propertyId, id, position))
			});
			function step(e, id) {
				if (!e.altKey || e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
				e.preventDefault();
				const position = stepPosition(sorts.value.map((s) => s.propertyId), id, e.key === "ArrowUp" ? -1 : 1);
				if (position) set(moved(sorts.value, (s) => s.propertyId, id, position));
			}
			function add(id) {
				set([...sorts.value, {
					propertyId: id,
					direction: "asc"
				}]);
				adding.value = false;
			}
			function remove(id) {
				const next = sorts.value.filter((s) => s.propertyId !== id);
				set(next);
				if (!next.length) emit("close");
			}
			const flip = (id) => set(sorts.value.map((s) => s.propertyId === id ? {
				...s,
				direction: s.direction === "asc" ? "desc" : "asc"
			} : s));
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$15, [(0, vue.createElementVNode)("div", {
					ref_key: "box",
					ref: box
				}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(sorts.value, (s, i) => {
					return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
						key: s.propertyId,
						class: (0, vue.normalizeClass)(["pl-panel__row", (0, vue.unref)(dropClass)((0, vue.unref)(reorder), s.propertyId, i === sorts.value.length - 1)]),
						"data-rid": s.propertyId,
						onKeydown: ($event) => step($event, s.propertyId)
					}, [
						(0, vue.createElementVNode)("span", {
							class: "pl-panel__grip",
							title: (0, vue.unref)(shell).reorder((0, vue.unref)(propertyName)(__props.collection, s.propertyId)),
							onPointerdown: ($event) => (0, vue.unref)(reorder).start($event, s.propertyId)
						}, [(0, vue.createVNode)(Icon_default, { name: "grip-vertical" })], 40, _hoisted_3$12),
						(0, vue.createVNode)(PropertyIcon_default, { type: typeOf(s.propertyId) }, null, 8, ["type"]),
						(0, vue.createElementVNode)("span", _hoisted_4$12, (0, vue.toDisplayString)((0, vue.unref)(propertyName)(__props.collection, s.propertyId)), 1),
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-small",
							onClick: ($event) => flip(s.propertyId)
						}, [(0, vue.createVNode)(Icon_default, { name: s.direction === "asc" ? "arrow-up" : "arrow-down" }, null, 8, ["name"]), (0, vue.createTextVNode)((0, vue.toDisplayString)(s.direction === "asc" ? (0, vue.unref)(shell).ascending : (0, vue.unref)(shell).descending), 1)], 8, _hoisted_5$12),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
							size: "sm",
							label: (0, vue.unref)(shell).removeSort,
							onClick: ($event) => remove(s.propertyId)
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "x" })]),
							_: 1
						}, 8, ["label", "onClick"]))
					], 42, _hoisted_2$13);
				}), 128))], 512), adding.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(PickList_default, {
					key: 0,
					rows: rest.value,
					label: (0, vue.unref)(shell).sortBy,
					placeholder: (0, vue.unref)(shell).findProperty,
					"max-height": 260,
					onPick: add
				}, {
					icon: (0, vue.withCtx)(({ row }) => [(0, vue.createVNode)(PropertyIcon_default, { type: typeOf(row.id) }, null, 8, ["type"])]),
					_: 1
				}, 8, [
					"rows",
					"label",
					"placeholder"
				])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [
					_cache[2] || (_cache[2] = (0, vue.createElementVNode)("div", { class: "pl-panel__sep" }, null, -1)),
					rest.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 0,
						type: "button",
						class: "pl-panel__row",
						onClick: _cache[0] || (_cache[0] = ($event) => adding.value = true)
					}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createElementVNode)("span", _hoisted_6$10, (0, vue.toDisplayString)((0, vue.unref)(shell).addSort), 1)])) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-panel__row",
						onClick: _cache[1] || (_cache[1] = ($event) => {
							set([]);
							emit("close");
						})
					}, [(0, vue.createVNode)(Icon_default, { name: "x" }), (0, vue.createElementVNode)("span", _hoisted_7$10, (0, vue.toDisplayString)((0, vue.unref)(shell).clearSorts), 1)])
				], 64))]);
			};
		}
	}), [["__scopeId", "data-v-77a26838"]]);
	// plugins/planner/src/shell/FilterBar.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$14 = ["disabled", "title"];
	var _hoisted_2$12 = [
		"data-cid",
		"disabled",
		"aria-expanded",
		"title",
		"onClick",
		"onKeydown"
	];
	var _hoisted_3$11 = { class: "pl-chip__name" };
	var _hoisted_4$11 = { class: "pl-chip__op" };
	var _hoisted_5$11 = {
		key: 0,
		class: "pl-chip__value"
	};
	var _hoisted_6$9 = {
		key: 1,
		class: "pl-chip__op"
	};
	var _hoisted_7$9 = [
		"aria-label",
		"title",
		"onClick"
	];
	var _hoisted_8$9 = ["title"];
	var _hoisted_9$8 = {
		key: 2,
		class: "pl-bar__sep",
		"aria-hidden": "true"
	};
	var _hoisted_10$7 = [
		"disabled",
		"aria-label",
		"title",
		"onKeydown"
	];
	var _hoisted_11$5 = { class: "pl-chip__name" };
	var _hoisted_12$5 = [
		"aria-label",
		"title",
		"onClick"
	];
	// plugins/planner/src/shell/FilterBar.vue
	var FilterBar_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "FilterBar",
		props: {
			collection: {},
			view: {},
			readonly: { type: Boolean }
		},
		emits: ["add"],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store } = usePlanner();
			const root = (0, vue.ref)(null);
			const editing = (0, vue.ref)(null);
			const sorting = (0, vue.ref)(null);
			const conditions = (0, vue.computed)(() => props.view.filter.conditions);
			const edited = (0, vue.computed)(() => conditions.value.find((c) => c.id === editing.value?.id) ?? null);
			(0, vue.watch)(() => props.view.id, () => {
				editing.value = null;
				sorting.value = null;
			});
			/** Opens a filter's editor, once its chip is there. */
			async function edit(id) {
				await (0, vue.nextTick)();
				const anchor = root.value?.querySelector(`[data-cid="${CSS.escape(id)}"]`);
				if (anchor) editing.value = {
					id,
					anchor
				};
			}
			function change(id, part, typing = false) {
				setFilter(store, props.collection, props.view, { conditions: conditions.value.map((c) => c.id === id ? {
					...c,
					...part
				} : c) }, typing);
			}
			function remove(id) {
				editing.value = null;
				setFilter(store, props.collection, props.view, { conditions: conditions.value.filter((c) => c.id !== id) });
			}
			function clearAll() {
				store.updateView(props.collection.id, props.view.id, {
					filter: {
						match: "and",
						conditions: []
					},
					sorts: []
				});
			}
			const onDelete = (e, run) => {
				if (e.key !== "Delete" && e.key !== "Backspace") return;
				e.preventDefault();
				e.stopPropagation();
				run();
			};
			__expose({ edit });
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					ref_key: "root",
					ref: root,
					class: "pl-bar"
				}, [
					conditions.value.length > 1 ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 0,
						type: "button",
						class: "pl-small",
						disabled: __props.readonly,
						title: (0, vue.unref)(shell).matchHint,
						onClick: _cache[0] || (_cache[0] = ($event) => (0, vue.unref)(setFilter)((0, vue.unref)(store), __props.collection, __props.view, { match: __props.view.filter.match === "and" ? "or" : "and" }))
					}, (0, vue.toDisplayString)(__props.view.filter.match === "and" ? (0, vue.unref)(shell).matchAll : (0, vue.unref)(shell).matchAny), 9, _hoisted_1$14)) : (0, vue.createCommentVNode)("v-if", true),
					((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(conditions.value, (c) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
							key: c.id,
							class: (0, vue.normalizeClass)(["pl-chip", {
								"is-idle": !(0, vue.unref)(isActive)(c),
								"is-open": editing.value?.id === c.id
							}])
						}, [(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-chip__main",
							"data-cid": c.id,
							disabled: __props.readonly,
							"aria-haspopup": "dialog",
							"aria-expanded": editing.value?.id === c.id,
							title: `${(0, vue.unref)(shell).editFilter}: ${(0, vue.unref)(propertyName)(__props.collection, c.propertyId)} ${(0, vue.unref)(operatorText)(c.operator)} ${(0, vue.unref)(conditionText)(__props.collection, c)}`,
							onClick: ($event) => edit(c.id),
							onKeydown: ($event) => onDelete($event, () => !__props.readonly && remove(c.id))
						}, [
							(0, vue.createVNode)(PropertyIcon_default, { type: c.propertyId === (0, vue.unref)("title") ? "text" : (0, vue.unref)(propertyOf)(__props.collection, c.propertyId)?.type ?? "text" }, null, 8, ["type"]),
							(0, vue.createElementVNode)("span", _hoisted_3$11, (0, vue.toDisplayString)((0, vue.unref)(propertyName)(__props.collection, c.propertyId)), 1),
							(0, vue.createElementVNode)("span", _hoisted_4$11, (0, vue.toDisplayString)((0, vue.unref)(operatorText)(c.operator)), 1),
							(0, vue.unref)(conditionText)(__props.collection, c) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_5$11, (0, vue.toDisplayString)((0, vue.unref)(conditionText)(__props.collection, c)), 1)) : !(0, vue.unref)(isActive)(c) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_6$9, "…")) : (0, vue.createCommentVNode)("v-if", true)
						], 40, _hoisted_2$12), !__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: 0,
							type: "button",
							class: "pl-chip__x",
							"aria-label": (0, vue.unref)(shell).removeFilter,
							title: (0, vue.unref)(shell).removeFilter,
							onClick: ($event) => remove(c.id)
						}, [(0, vue.createVNode)(Icon_default, { name: "x" })], 8, _hoisted_7$9)) : (0, vue.createCommentVNode)("v-if", true)], 2);
					}), 128)),
					conditions.value.length && !__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 1,
						type: "button",
						class: "pl-small",
						title: (0, vue.unref)(shell).addFilter,
						onClick: _cache[1] || (_cache[1] = ($event) => emit("add", $event.currentTarget))
					}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).filter), 1)], 8, _hoisted_8$9)) : (0, vue.createCommentVNode)("v-if", true),
					conditions.value.length && __props.view.sorts.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_9$8)) : (0, vue.createCommentVNode)("v-if", true),
					((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(__props.view.sorts, (s) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
							key: s.propertyId,
							class: "pl-chip"
						}, [(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-chip__main",
							disabled: __props.readonly,
							"aria-haspopup": "dialog",
							"aria-label": `${(0, vue.unref)(shell).editSort}: ${(0, vue.unref)(propertyName)(__props.collection, s.propertyId)}, ${s.direction === "asc" ? (0, vue.unref)(shell).ascending : (0, vue.unref)(shell).descending}`,
							title: (0, vue.unref)(shell).editSort,
							onClick: _cache[2] || (_cache[2] = ($event) => sorting.value = $event.currentTarget),
							onKeydown: ($event) => onDelete($event, () => !__props.readonly && (0, vue.unref)(setSorts)((0, vue.unref)(store), __props.collection, __props.view, __props.view.sorts.filter((e) => e.propertyId !== s.propertyId)))
						}, [(0, vue.createVNode)(Icon_default, { name: s.direction === "asc" ? "arrow-up" : "arrow-down" }, null, 8, ["name"]), (0, vue.createElementVNode)("span", _hoisted_11$5, (0, vue.toDisplayString)((0, vue.unref)(propertyName)(__props.collection, s.propertyId)), 1)], 40, _hoisted_10$7), !__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: 0,
							type: "button",
							class: "pl-chip__x",
							"aria-label": (0, vue.unref)(shell).removeSort,
							title: (0, vue.unref)(shell).removeSort,
							onClick: ($event) => (0, vue.unref)(setSorts)((0, vue.unref)(store), __props.collection, __props.view, __props.view.sorts.filter((e) => e.propertyId !== s.propertyId))
						}, [(0, vue.createVNode)(Icon_default, { name: "x" })], 8, _hoisted_12$5)) : (0, vue.createCommentVNode)("v-if", true)]);
					}), 128)),
					!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 3,
						type: "button",
						class: "pl-small",
						onClick: clearAll
					}, (0, vue.toDisplayString)((0, vue.unref)(shell).clear), 1)) : (0, vue.createCommentVNode)("v-if", true),
					editing.value && edited.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: editing.value.id,
						anchor: editing.value.anchor,
						width: 260,
						label: (0, vue.unref)(shell).editFilter,
						onClose: _cache[6] || (_cache[6] = ($event) => editing.value = null)
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(ConditionEditor_default, {
							collection: __props.collection,
							condition: edited.value,
							onChange: _cache[3] || (_cache[3] = (part, typing) => change(edited.value.id, part, typing)),
							onRemove: _cache[4] || (_cache[4] = ($event) => remove(edited.value.id)),
							onDone: _cache[5] || (_cache[5] = ($event) => editing.value = null)
						}, null, 8, ["collection", "condition"])]),
						_: 1
					}, 8, ["anchor", "label"])) : (0, vue.createCommentVNode)("v-if", true),
					sorting.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 5,
						anchor: sorting.value,
						width: 280,
						label: (0, vue.unref)(shell).sortBy,
						onClose: _cache[8] || (_cache[8] = ($event) => sorting.value = null)
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(SortPanel_default, {
							collection: __props.collection,
							view: __props.view,
							onClose: _cache[7] || (_cache[7] = ($event) => sorting.value = null)
						}, null, 8, ["collection", "view"])]),
						_: 1
					}, 8, ["anchor", "label"])) : (0, vue.createCommentVNode)("v-if", true)
				], 512);
			};
		}
	}), [["__scopeId", "data-v-c565ea5d"]]);
	// plugins/planner/src/shell/ItemPane.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$13 = [
		"aria-label",
		"aria-valuenow",
		"aria-valuemax"
	];
	/** The item beside the view: its left edge resizes it, and the width is kept. `overlay`: over the view, for want of room. */
	var KEY = "itemWidth";
	var DEFAULT = 440;
	var MIN = 340;
	/** What the view keeps beside it. */
	var VIEW_MIN = 320;
	var SLIVER = 120;
	// plugins/planner/src/shell/ItemPane.vue
	var ItemPane_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ItemPane",
		props: {
			available: {},
			overlay: { type: Boolean }
		},
		setup(__props) {
			const props = __props;
			const { mango } = usePlanner();
			const saved = mango.storage.get(KEY);
			const wanted = (0, vue.ref)(typeof saved === "number" && saved >= MIN ? saved : DEFAULT);
			const max = (0, vue.computed)(() => props.overlay ? props.available : Math.max(MIN, props.available - VIEW_MIN));
			/** Over the view it leaves a useful part of it, or none. */
			const width = (0, vue.computed)(() => {
				if (props.available < 560) return props.available;
				const w = Math.min(wanted.value, max.value);
				return props.overlay && props.available - w < SLIVER ? props.available : w;
			});
			const root = (0, vue.ref)(null);
			const resizing = (0, vue.ref)(false);
			function set(n) {
				wanted.value = Math.round(Math.max(MIN, Math.min(n, max.value)));
			}
			const keep = () => mango.storage.set(KEY, wanted.value);
			function start(e) {
				if (e.button !== 0) return;
				e.preventDefault();
				const hold = mango.ui.holdOverlay();
				const el = e.currentTarget;
				const right = root.value.getBoundingClientRect().right;
				el.setPointerCapture(e.pointerId);
				resizing.value = true;
				const move = (ev) => set(right - ev.clientX);
				const end = () => {
					el.removeEventListener("pointermove", move);
					el.removeEventListener("lostpointercapture", end);
					hold.dispose();
					resizing.value = false;
					keep();
				};
				el.addEventListener("pointermove", move);
				el.addEventListener("lostpointercapture", end);
			}
			function onKey(e) {
				const by = {
					ArrowLeft: 16,
					ArrowRight: -16
				}[e.key];
				if (!by) return;
				e.preventDefault();
				set(width.value + by);
				keep();
			}
			function reset() {
				wanted.value = DEFAULT;
				keep();
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("aside", {
					ref_key: "root",
					ref: root,
					class: (0, vue.normalizeClass)(["pl-pane", { "is-overlay": __props.overlay }]),
					style: (0, vue.normalizeStyle)({ width: `${width.value}px` })
				}, [__props.available >= 560 ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					key: 0,
					class: (0, vue.normalizeClass)(["pl-pane__edge", { "is-on": resizing.value }]),
					role: "separator",
					"aria-orientation": "vertical",
					tabindex: "0",
					"aria-label": (0, vue.unref)(shell).resizePane,
					"aria-valuenow": width.value,
					"aria-valuemin": MIN,
					"aria-valuemax": max.value,
					onPointerdown: start,
					onDblclick: reset,
					onKeydown: onKey
				}, null, 42, _hoisted_1$13)) : (0, vue.createCommentVNode)("v-if", true), (0, vue.renderSlot)(_ctx.$slots, "default", {}, void 0, true)], 6);
			};
		}
	}), [["__scopeId", "data-v-bf38ca5f"]]);
	// plugins/planner/src/shell/CollectionSwitcher.vue?vue&type=script&setup=true&lang.ts
	/** The collections to switch to: the project's, then those shown everywhere. Dragging a row (or Alt+arrows) reorders. */
	var NEW = "+";
	// plugins/planner/src/shell/CollectionSwitcher.vue
	var CollectionSwitcher_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "CollectionSwitcher",
		props: { currentId: {} },
		emits: [
			"pick",
			"create",
			"leave"
		],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const planner = usePlanner();
			const { store, mango } = planner;
			const { IconButton } = mango.ui.components;
			const box = (0, vue.ref)(null);
			const list = (0, vue.computed)(() => {
				const all = store.collections.value;
				return [...all.filter((c) => c.scope.kind === "project"), ...all.filter((c) => c.scope.kind !== "project")];
			});
			const byId = (0, vue.computed)(() => new Map(list.value.map((c) => [c.id, c])));
			const rows = (0, vue.computed)(() => [...list.value.map((c) => ({
				id: c.id,
				label: c.name || shell.unnamed,
				group: c.scope.kind === "project" ? shell.thisProject : shell.everywhere,
				checked: c.id === props.currentId
			})), {
				id: NEW,
				label: shell.newCollectionRow,
				always: true
			}]);
			/** The collections of its group: it only moves among those. */
			const group = (id) => list.value.filter((c) => c.scope.kind === byId.value.get(id)?.scope.kind).map((c) => c.id);
			const reorder = useReorder({
				axis: "y",
				container: () => box.value,
				hold: () => mango.ui.holdOverlay(),
				onDrop(id, position) {
					const ids = group(id);
					const others = ids.filter((i) => i !== id);
					const before = typeof position === "object" && "before" in position ? position.before : null;
					let to = null;
					if (before !== null && ids.includes(before)) to = position;
					else if (others.length) to = (before === null ? list.value.length : list.value.findIndex((c) => c.id === before)) <= list.value.findIndex((c) => c.id === ids[0]) ? { before: others[0] } : { after: others.at(-1) };
					if (to) store.moveCollection(id, to);
				},
				disabled: () => store.sourceStatus.value.readonly
			});
			function move(id, by) {
				const position = stepPosition(group(id), id, by);
				if (position) store.moveCollection(id, position);
			}
			function menu(id, at) {
				const c = byId.value.get(id);
				if (!c) return;
				mango.ui.contextMenu(at, collectionRows(planner, c).map((r) => ({
					...r,
					onSelect: () => {
						emit("leave");
						r.onSelect?.();
					}
				})));
			}
			function pick(id) {
				const c = byId.value.get(id);
				if (c) emit("pick", c);
				else emit("create");
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					ref_key: "box",
					ref: box
				}, [(0, vue.createVNode)(PickList_default, {
					rows: rows.value,
					label: (0, vue.unref)(shell).switchCollection,
					placeholder: (0, vue.unref)(shell).findCollection,
					reorder: (0, vue.unref)(reorder),
					onPick: pick,
					onMove: move,
					onMenu: menu
				}, {
					icon: (0, vue.withCtx)(({ row }) => [byId.value.get(row.id) ? ((0, vue.openBlock)(), (0, vue.createBlock)(CollectionIcon_default, {
						key: 0,
						collection: byId.value.get(row.id)
					}, null, 8, ["collection"])) : ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
						key: 1,
						name: "plus"
					}))]),
					end: (0, vue.withCtx)(({ row }) => [byId.value.get(row.id) ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
						key: 0,
						size: "sm",
						class: "pl-switch__more",
						tabindex: "-1",
						label: (0, vue.unref)(shell).collectionMenu(row.label),
						onPointerdown: _cache[0] || (_cache[0] = (0, vue.withModifiers)(() => {}, ["stop"])),
						onClick: (0, vue.withModifiers)(($event) => menu(row.id, $event.currentTarget), ["stop"])
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "ellipsis" })]),
						_: 1
					}, 40, ["label", "onClick"])) : (0, vue.createCommentVNode)("v-if", true)]),
					_: 1
				}, 8, [
					"rows",
					"label",
					"placeholder",
					"reorder"
				])], 512);
			};
		}
	}), [["__scopeId", "data-v-4c31956a"]]);
	// plugins/planner/src/shell/GroupPanel.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$12 = { class: "pl-panel pl-group" };
	var _hoisted_2$11 = { class: "pl-panel__note" };
	var _hoisted_3$10 = { class: "pl-panel__label" };
	var _hoisted_4$10 = { class: "pl-panel__head" };
	var _hoisted_5$10 = { class: "pl-panel__head" };
	/** What the view is grouped by, and which groups show. */
	var NONE = "-";
	// plugins/planner/src/shell/GroupPanel.vue
	var GroupPanel_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "GroupPanel",
		props: {
			collection: {},
			view: {}
		},
		emits: ["addProperty"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store, mango } = usePlanner();
			const { IconButton } = mango.ui.components;
			const usable = (0, vue.computed)(() => props.collection.properties.filter(isGroupable));
			const rows = (0, vue.computed)(() => [...props.view.type === "table" ? [{
				id: NONE,
				label: shell.noGrouping,
				checked: !props.view.groupBy
			}] : [], ...usable.value.map((p) => ({
				id: p.id,
				label: p.name || shell.unnamed,
				checked: p.id === props.view.groupBy
			}))]);
			const property = (0, vue.computed)(() => props.view.groupBy ? propertyOf(props.collection, props.view.groupBy) : null);
			const groups = (0, vue.computed)(() => {
				const p = property.value;
				if (!p) return [];
				return groupKeys(p).map((key) => {
					const option = p.options.find((o) => o.id === key) ?? null;
					return {
						key,
						option,
						name: option?.name || (key === "" ? strings$5.noGroup(p.name) : key === "true" ? strings$5.checked : key === "false" ? strings$5.unchecked : shell.unnamed),
						hidden: props.view.hiddenGroups.includes(key)
					};
				});
			});
			function pick(id) {
				const groupBy = id === NONE ? null : id;
				if (groupBy !== props.view.groupBy) store.updateView(props.collection.id, props.view.id, {
					groupBy,
					hiddenGroups: [],
					collapsedGroups: []
				});
			}
			function toggle(key, hidden) {
				const now = props.view.hiddenGroups.filter((k) => k !== key);
				store.updateView(props.collection.id, props.view.id, { hiddenGroups: hidden ? now : [...now, key] });
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$12, [!usable.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [(0, vue.createElementVNode)("p", _hoisted_2$11, (0, vue.toDisplayString)((0, vue.unref)(shell).noGroupable), 1), (0, vue.createElementVNode)("button", {
					type: "button",
					class: "pl-panel__row",
					onClick: _cache[0] || (_cache[0] = ($event) => emit("addProperty"))
				}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createElementVNode)("span", _hoisted_3$10, (0, vue.toDisplayString)((0, vue.unref)(shell).addProperty), 1)])], 64)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [
					(0, vue.createElementVNode)("div", _hoisted_4$10, (0, vue.toDisplayString)((0, vue.unref)(shell).groupBy), 1),
					(0, vue.createVNode)(PickList_default, {
						rows: rows.value,
						label: (0, vue.unref)(shell).groupBy,
						search: false,
						"max-height": 200,
						"data-autofocus": "",
						onPick: pick
					}, {
						icon: (0, vue.withCtx)(({ row }) => [row.id !== NONE ? ((0, vue.openBlock)(), (0, vue.createBlock)(PropertyIcon_default, {
							key: 0,
							type: (0, vue.unref)(propertyOf)(__props.collection, row.id)?.type ?? "text"
						}, null, 8, ["type"])) : ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
							key: 1,
							name: "minus"
						}))]),
						_: 1
					}, 8, ["rows", "label"]),
					groups.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [
						_cache[1] || (_cache[1] = (0, vue.createElementVNode)("div", { class: "pl-panel__sep" }, null, -1)),
						(0, vue.createElementVNode)("div", _hoisted_5$10, (0, vue.toDisplayString)((0, vue.unref)(shell).groups), 1),
						((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(groups.value, (g) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
								key: g.key,
								class: "pl-panel__row"
							}, [(0, vue.createElementVNode)("span", { class: (0, vue.normalizeClass)(["pl-panel__label pl-group__name", { "is-off": g.hidden }]) }, [g.option ? ((0, vue.openBlock)(), (0, vue.createBlock)(OptionTag_default, {
								key: 0,
								option: g.option
							}, null, 8, ["option"])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [(0, vue.createTextVNode)((0, vue.toDisplayString)(g.name), 1)], 64))], 2), ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
								size: "sm",
								label: g.hidden ? (0, vue.unref)(shell).show(g.name) : (0, vue.unref)(shell).hide(g.name),
								onClick: ($event) => toggle(g.key, g.hidden)
							}, {
								default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: g.hidden ? "eye-off" : "eye" }, null, 8, ["name"])]),
								_: 2
							}, 1032, ["label", "onClick"]))]);
						}), 128))
					], 64)) : (0, vue.createCommentVNode)("v-if", true)
				], 64))]);
			};
		}
	}), [["__scopeId", "data-v-8a1acaf9"]]);
	// plugins/planner/src/shell/PropertiesPanel.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$11 = { class: "pl-panel pl-props" };
	var _hoisted_2$10 = {
		key: 0,
		class: "pl-panel__note"
	};
	var _hoisted_3$9 = {
		key: 1,
		class: "pl-panel__head"
	};
	var _hoisted_4$9 = ["data-rid", "onKeydown"];
	var _hoisted_5$9 = ["title", "onPointerdown"];
	var _hoisted_6$8 = [
		"aria-checked",
		"title",
		"onClick"
	];
	var _hoisted_7$8 = {
		key: 2,
		class: "pl-panel__sep"
	};
	var _hoisted_8$8 = ["aria-checked"];
	var _hoisted_9$7 = { class: "pl-panel__label" };
	var _hoisted_10$6 = { class: "pl-panel__label" };
	// plugins/planner/src/shell/PropertiesPanel.vue
	var PropertiesPanel_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PropertiesPanel",
		props: {
			collection: {},
			view: {}
		},
		emits: ["addProperty"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const planner = usePlanner();
			const { store, mango } = planner;
			const { IconButton } = mango.ui.components;
			const box = (0, vue.ref)(null);
			const columns = (0, vue.computed)(() => props.view.columns.flatMap((c) => {
				const property = propertyOf(props.collection, c.propertyId);
				return property ? [{
					...c,
					property
				}] : [];
			}));
			const set = (next) => store.updateView(props.collection.id, props.view.id, { columns: next.map((c) => ({
				propertyId: c.propertyId,
				visible: c.visible
			})) });
			const toggle = (id) => set(props.view.columns.map((c) => c.propertyId === id ? {
				...c,
				visible: !c.visible
			} : c));
			const reorder = useReorder({
				axis: "y",
				container: () => box.value,
				hold: () => mango.ui.holdOverlay(),
				onDrop: (id, position) => set(moved(props.view.columns, (c) => c.propertyId, id, position))
			});
			function step(e, id) {
				if (!e.altKey || e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
				e.preventDefault();
				const position = stepPosition(columns.value.map((c) => c.propertyId), id, e.key === "ArrowUp" ? -1 : 1);
				if (position) set(moved(props.view.columns, (c) => c.propertyId, id, position));
			}
			const menu = (e, p) => void propertyMenu(planner, props.collection, p, e.currentTarget);
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$11, [
					!columns.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_2$10, (0, vue.toDisplayString)((0, vue.unref)(shell).noProperties), 1)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_3$9, (0, vue.toDisplayString)((0, vue.unref)(shell).shown), 1)),
					(0, vue.createElementVNode)("div", {
						ref_key: "box",
						ref: box
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(columns.value, (c, i) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: c.propertyId,
							class: (0, vue.normalizeClass)(["pl-panel__row is-hoverable", (0, vue.unref)(dropClass)((0, vue.unref)(reorder), c.propertyId, i === columns.value.length - 1)]),
							"data-rid": c.propertyId,
							onKeydown: ($event) => step($event, c.propertyId)
						}, [
							(0, vue.createElementVNode)("span", {
								class: "pl-panel__grip",
								title: (0, vue.unref)(shell).reorder(c.property.name),
								onPointerdown: ($event) => (0, vue.unref)(reorder).start($event, c.propertyId)
							}, [(0, vue.createVNode)(Icon_default, { name: "grip-vertical" })], 40, _hoisted_5$9),
							(0, vue.createElementVNode)("button", {
								type: "button",
								class: "pl-props__main",
								role: "switch",
								"aria-checked": c.visible,
								title: c.visible ? (0, vue.unref)(shell).hide(c.property.name) : (0, vue.unref)(shell).show(c.property.name),
								onClick: ($event) => toggle(c.propertyId)
							}, [
								(0, vue.createVNode)(PropertyIcon_default, { type: c.property.type }, null, 8, ["type"]),
								(0, vue.createElementVNode)("span", { class: (0, vue.normalizeClass)(["pl-panel__label", { "is-off": !c.visible }]) }, (0, vue.toDisplayString)(c.property.name || (0, vue.unref)(shell).unnamed), 3),
								(0, vue.createVNode)(Icon_default, {
									name: c.visible ? "eye" : "eye-off",
									class: (0, vue.normalizeClass)(["pl-props__eye", { "is-off": !c.visible }])
								}, null, 8, ["name", "class"])
							], 8, _hoisted_6$8),
							((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
								size: "sm",
								label: (0, vue.unref)(shell).propertyMenu,
								onClick: ($event) => menu($event, c.property)
							}, {
								default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "ellipsis" })]),
								_: 1
							}, 8, ["label", "onClick"]))
						], 42, _hoisted_4$9);
					}), 128))], 512),
					columns.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_7$8)) : (0, vue.createCommentVNode)("v-if", true),
					__props.view.type === "board" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 3,
						type: "button",
						class: "pl-panel__row",
						role: "switch",
						"aria-checked": __props.view.cardPreview === "body",
						onClick: _cache[0] || (_cache[0] = ($event) => (0, vue.unref)(store).updateView(__props.collection.id, __props.view.id, { cardPreview: __props.view.cardPreview === "body" ? "none" : "body" }))
					}, [
						(0, vue.createVNode)(Icon_default, { name: "text" }),
						(0, vue.createElementVNode)("span", _hoisted_9$7, (0, vue.toDisplayString)((0, vue.unref)(shell).bodyPreview), 1),
						__props.view.cardPreview === "body" ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
							key: 0,
							name: "check",
							class: "pl-panel__check"
						})) : (0, vue.createCommentVNode)("v-if", true)
					], 8, _hoisted_8$8)) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-panel__row",
						onClick: _cache[1] || (_cache[1] = ($event) => emit("addProperty"))
					}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createElementVNode)("span", _hoisted_10$6, (0, vue.toDisplayString)((0, vue.unref)(shell).addProperty), 1)])
				]);
			};
		}
	}), [["__scopeId", "data-v-efde5021"]]);
	// plugins/planner/src/shell/repository.ts
	/** The repository a project collection belongs to, as the app already knows it. */
	function useRepository(mango, collection) {
		const forge = (() => {
			try {
				return mango.stores.byId("forge");
			} catch {
				return null;
			}
		})();
		const path = (0, vue.computed)(() => {
			const { scope } = collection();
			return scope.kind === "project" ? scope.path : null;
		});
		(0, vue.watchEffect)(() => {
			if (path.value && typeof forge?.ensure === "function") forge.ensure(path.value);
		});
		return (0, vue.computed)(() => {
			if (!path.value) return null;
			const link = forge?.links?.[path.value];
			const text = (k) => isObject(link) && typeof link[k] === "string" ? link[k] : "";
			const url = text("host") && text("owner") && text("repo") ? safeUrl(`https://${text("host")}/${text("owner")}/${text("repo")}`) : null;
			if (url) return {
				label: `${text("owner")}/${text("repo")}`,
				url
			};
			const name = path.value.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1);
			return name ? {
				label: name,
				url
			} : null;
		});
	}
	// plugins/planner/src/shell/ViewTabs.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$10 = ["aria-label", "title"];
	var _hoisted_2$9 = { class: "pl-tab__name" };
	var _hoisted_3$8 = {
		key: 1,
		class: "pl-tabs"
	};
	var _hoisted_4$8 = ["aria-label"];
	var _hoisted_5$8 = ["data-rid", "onContextmenu"];
	var _hoisted_6$7 = ["aria-label", "size"];
	var _hoisted_7$7 = [
		"aria-selected",
		"tabindex",
		"title",
		"onPointerdown",
		"onClick",
		"onDblclick",
		"onKeydown"
	];
	var _hoisted_8$7 = { class: "pl-tab__name" };
	// plugins/planner/src/shell/ViewTabs.vue
	var ViewTabs_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "ViewTabs",
		props: {
			collection: {},
			view: {},
			compact: { type: Boolean },
			readonly: { type: Boolean }
		},
		emits: ["pick"],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { store, mango } = usePlanner();
			const strip = (0, vue.ref)(null);
			const renaming = (0, vue.ref)(null);
			const draft = (0, vue.ref)("");
			const views = (0, vue.computed)(() => props.collection.views);
			const iconOf = (type) => type === "board" ? "square-kanban" : "table-2";
			const nameOf = (v) => v.name || (v.type === "board" ? shell.board : shell.table);
			(0, vue.watch)(() => props.view.id, () => void (0, vue.nextTick)(() => {
				strip.value?.querySelector("[aria-selected=\"true\"]")?.scrollIntoView({
					block: "nearest",
					inline: "nearest"
				});
			}), { immediate: true });
			const reorder = useReorder({
				axis: "x",
				container: () => strip.value,
				hold: () => mango.ui.holdOverlay(),
				onDrop: (id, position) => store.moveView(props.collection.id, id, position),
				disabled: () => props.readonly || renaming.value !== null
			});
			async function rename(v) {
				if (props.readonly) return;
				if (props.compact) {
					const name = (await mango.ui.prompt({
						title: shell.viewName,
						value: nameOf(v)
					}))?.trim();
					if (name && name !== v.name) store.updateView(props.collection.id, v.id, { name });
					return;
				}
				draft.value = nameOf(v);
				renaming.value = v.id;
				await (0, vue.nextTick)();
				const input = strip.value?.querySelector("input");
				input?.focus();
				input?.select();
			}
			function commit(save) {
				const v = views.value.find((e) => e.id === renaming.value);
				renaming.value = null;
				const name = draft.value.trim();
				if (save && v && name && name !== v.name) store.updateView(props.collection.id, v.id, { name });
				if (v) (0, vue.nextTick)(() => strip.value?.querySelector(`[data-rid="${CSS.escape(v.id)}"] [role=tab]`)?.focus());
			}
			/** A property a board groups by is not worth repeating on its cards. */
			function add(type) {
				const c = props.collection;
				const groupBy = type === "board" ? (c.properties.find((p) => p.type === "select") ?? c.properties.find(isGroupable))?.id ?? null : null;
				let left = 3;
				const columns = c.properties.map((p) => ({
					propertyId: p.id,
					visible: type === "table" || p.id !== groupBy && left-- > 0
				}));
				const made = store.addView(c.id, {
					name: type === "board" ? shell.board : shell.table,
					type,
					groupBy,
					columns
				});
				if (made) {
					emit("pick", made.id);
					(0, vue.nextTick)(() => rename(made));
				}
			}
			const addRows = () => [{
				label: shell.board,
				icon: "square-kanban",
				group: shell.addView,
				onSelect: () => add("board")
			}, {
				label: shell.table,
				icon: "table-2",
				onSelect: () => add("table")
			}];
			function remove(v) {
				const at = views.value.findIndex((e) => e.id === v.id);
				const next = views.value[at + 1] ?? views.value[at - 1];
				if (store.deleteView(props.collection.id, v.id) && v.id === props.view.id && next) emit("pick", next.id);
			}
			function viewRows(v) {
				const other = v.type === "board" ? "table" : "board";
				const locked = props.readonly;
				return [
					{
						label: shell.renameView,
						icon: "pencil",
						kbd: "F2",
						disabled: locked,
						onSelect: () => void rename(v)
					},
					{
						label: other === "board" ? shell.showAsBoard : shell.showAsTable,
						icon: iconOf(other),
						disabled: locked,
						onSelect: () => store.updateView(props.collection.id, v.id, { type: other })
					},
					{
						label: shell.duplicate,
						icon: "copy",
						disabled: locked,
						onSelect: () => {
							const made = store.duplicateView(props.collection.id, v.id);
							if (made) emit("pick", made.id);
						}
					},
					{
						label: shell.deleteView,
						icon: "trash-2",
						danger: true,
						divider: true,
						disabled: locked || views.value.length < 2,
						onSelect: () => remove(v)
					}
				];
			}
			const menu = (v, at) => void mango.ui.contextMenu(at, [...viewRows(v), ...props.readonly ? [] : addRows()]);
			function openAll(e) {
				mango.ui.contextMenu(e.currentTarget, [
					...views.value.map((v) => ({
						label: nameOf(v),
						icon: iconOf(v.type),
						checked: v.id === props.view.id,
						onSelect: () => emit("pick", v.id)
					})),
					...viewRows(props.view).map((r, i) => i ? r : {
						...r,
						divider: true,
						kbd: void 0
					}),
					...props.readonly ? [] : addRows()
				]);
			}
			function onKey(e, v) {
				const ids = views.value.map((x) => x.id);
				const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
				if (by && e.altKey) {
					const position = props.readonly ? null : stepPosition(ids, v.id, by);
					if (position) store.moveView(props.collection.id, v.id, position);
				} else if (by || e.key === "Home" || e.key === "End") {
					const at = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (ids.indexOf(v.id) + by + ids.length) % ids.length;
					emit("pick", ids[at]);
					(0, vue.nextTick)(() => strip.value?.querySelector("[aria-selected=\"true\"]")?.focus());
				} else if (e.key === "F2") rename(v);
				else if ((e.key === "Delete" || e.key === "Backspace") && !props.readonly && ids.length > 1) remove(v);
				else return;
				e.preventDefault();
				e.stopPropagation();
			}
			__expose({
				currentRows: () => viewRows(props.view),
				addRows
			});
			const groupTitle = (v) => {
				const p = v.groupBy ? propertyOf(props.collection, v.groupBy) : null;
				return p ? `${nameOf(v)}, ${shell.groupedBy(p.name)}` : nameOf(v);
			};
			return (_ctx, _cache) => {
				return __props.compact ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
					key: 0,
					type: "button",
					class: "pl-tab is-on pl-tab--one",
					"aria-haspopup": "menu",
					"aria-label": `${(0, vue.unref)(shell).views}: ${nameOf(__props.view)}`,
					title: nameOf(__props.view),
					onClick: openAll
				}, [
					(0, vue.createVNode)(Icon_default, { name: iconOf(__props.view.type) }, null, 8, ["name"]),
					(0, vue.createElementVNode)("span", _hoisted_2$9, (0, vue.toDisplayString)(nameOf(__props.view)), 1),
					(0, vue.createVNode)(Icon_default, {
						name: "chevron-down",
						class: "pl-tab__chev"
					})
				], 8, _hoisted_1$10)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_3$8, [(0, vue.createElementVNode)("div", {
					ref_key: "strip",
					ref: strip,
					class: "pl-tabs__strip",
					role: "tablist",
					"aria-label": (0, vue.unref)(shell).views
				}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(views.value, (v, i) => {
					return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
						key: v.id,
						class: (0, vue.normalizeClass)(["pl-tabs__item", (0, vue.unref)(dropClass)((0, vue.unref)(reorder), v.id, i === views.value.length - 1)]),
						"data-rid": v.id,
						role: "presentation",
						onContextmenu: (0, vue.withModifiers)(($event) => menu(v, {
							x: $event.clientX,
							y: $event.clientY
						}), ["prevent", "stop"])
					}, [renaming.value === v.id ? (0, vue.withDirectives)(((0, vue.openBlock)(), (0, vue.createElementBlock)("input", {
						key: 0,
						"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => draft.value = $event),
						class: "pl-tabs__input",
						"aria-label": (0, vue.unref)(shell).viewName,
						size: Math.max(6, Math.min(24, draft.value.length + 1)),
						autocomplete: "off",
						onKeydown: [_cache[1] || (_cache[1] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => commit(true), ["prevent", "stop"]), ["enter"])), _cache[2] || (_cache[2] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => commit(false), ["prevent", "stop"]), ["esc"]))],
						onBlur: _cache[3] || (_cache[3] = ($event) => renaming.value && commit(true))
					}, null, 40, _hoisted_6$7)), [[vue.vModelText, draft.value]]) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 1,
						type: "button",
						class: (0, vue.normalizeClass)(["pl-tab", { "is-on": v.id === __props.view.id }]),
						role: "tab",
						"aria-selected": v.id === __props.view.id,
						tabindex: v.id === __props.view.id ? 0 : -1,
						title: groupTitle(v),
						onPointerdown: ($event) => (0, vue.unref)(reorder).start($event, v.id),
						onClick: ($event) => emit("pick", v.id),
						onDblclick: ($event) => rename(v),
						onKeydown: ($event) => onKey($event, v)
					}, [(0, vue.createVNode)(Icon_default, { name: iconOf(v.type) }, null, 8, ["name"]), (0, vue.createElementVNode)("span", _hoisted_8$7, (0, vue.toDisplayString)(nameOf(v)), 1)], 42, _hoisted_7$7))], 42, _hoisted_5$8);
				}), 128))], 8, _hoisted_4$8)]));
			};
		}
	}), [["__scopeId", "data-v-1133ba6f"]]);
	// plugins/planner/src/shell/PlannerHeader.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$9 = [
		"aria-expanded",
		"aria-label",
		"title"
	];
	var _hoisted_2$8 = { class: "pl-head__name" };
	var _hoisted_3$7 = {
		key: 0,
		class: "pl-head__count tabular"
	};
	var _hoisted_4$7 = ["title"];
	var _hoisted_5$7 = ["title"];
	var _hoisted_6$6 = {
		key: 3,
		class: "pl-head__count",
		role: "status"
	};
	var _hoisted_7$6 = { class: "pl-head__tools" };
	var _hoisted_8$6 = [
		"value",
		"placeholder",
		"aria-label",
		"title"
	];
	var _hoisted_9$6 = {
		key: 1,
		class: "tabular"
	};
	var _hoisted_10$5 = {
		key: 0,
		class: "pl-head__dot",
		"aria-hidden": "true"
	};
	var _hoisted_11$4 = { class: "pl-head__pad" };
	var _hoisted_12$4 = { class: "pl-head__pad" };
	// plugins/planner/src/shell/PlannerHeader.vue
	var PlannerHeader_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PlannerHeader",
		props: {
			collection: {},
			view: {},
			search: {},
			count: {},
			readonly: { type: Boolean },
			saving: { type: Boolean },
			width: {},
			covered: { type: Boolean }
		},
		emits: [
			"update:search",
			"collection",
			"view",
			"new-collection",
			"new-item",
			"filtered",
			"to-view"
		],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const planner = usePlanner();
			const { store, mango } = planner;
			const { Button, IconButton } = mango.ui.components;
			const pop = (0, vue.ref)(null);
			const more = (0, vue.ref)(null);
			const tabs = (0, vue.ref)(null);
			const searchInput = (0, vue.ref)(null);
			const searchOpen = (0, vue.ref)(false);
			/** Less room: the repository goes, then the views fold into one button, then the search field and the words. */
			const wide = (0, vue.computed)(() => props.width >= 900);
			const roomy = (0, vue.computed)(() => props.width >= 640);
			const compactViews = (0, vue.computed)(() => props.width < 820);
			const searching = (0, vue.computed)(() => roomy.value || searchOpen.value || props.search !== "");
			const filters = (0, vue.computed)(() => props.view.filter.conditions.length);
			/** What "…" has that is in use and not plain to see. */
			const marked = (0, vue.computed)(() => props.view.sorts.length > 0 || props.view.type === "table" && props.view.groupBy !== null || props.view.hiddenGroups.length > 0);
			const many = (0, vue.computed)(() => itemWord(props.collection, 2));
			const one = (0, vue.computed)(() => itemWord(props.collection, 1));
			const repository = useRepository(mango, () => props.collection);
			function open(name, anchor) {
				if (anchor) pop.value = {
					name,
					anchor
				};
			}
			const close = () => {
				pop.value = null;
			};
			async function menu(at) {
				let next;
				const panel = (name) => () => {
					next = () => open(name, more.value);
				};
				const then = (rows) => () => {
					next = () => mango.ui.contextMenu(at, rows);
				};
				const v = props.view;
				const own = collectionRows(planner, props.collection, v.groupBy).map((r, i) => i ? r : {
					...r,
					divider: true
				});
				const rows = [
					...props.readonly ? [] : [{
						label: shell.newNamed(one.value),
						icon: "plus",
						kbd: keyLabel(mango, "Shift", "Enter"),
						onSelect: () => emit("new-item")
					}],
					...props.readonly || props.covered ? [] : [
						{
							label: shell.sortMenu,
							icon: "arrow-up-down",
							aside: v.sorts.length ? String(v.sorts.length) : void 0,
							divider: true,
							onSelect: panel("sort")
						},
						{
							label: shell.groupMenu,
							icon: "group",
							aside: v.groupBy ? propertyOf(props.collection, v.groupBy)?.name : void 0,
							onSelect: panel("group")
						},
						{
							label: shell.propertiesMenu,
							icon: "sliders-horizontal",
							onSelect: panel("properties")
						}
					],
					{
						label: shell.viewMenu,
						aside: v.name,
						icon: v.type === "board" ? "square-kanban" : "table-2",
						divider: true,
						onSelect: then(tabs.value?.currentRows() ?? [])
					},
					...props.readonly ? [] : [{
						label: shell.addViewMenu,
						icon: "plus",
						onSelect: then(tabs.value?.addRows() ?? [])
					}],
					...own.slice(0, -1),
					{
						label: shell.transfer,
						icon: "arrow-down-up",
						onSelect: then(transferRows(planner, props.collection))
					},
					{
						label: shell.undo(store.undoLabel.value),
						icon: "undo-2",
						divider: true,
						kbd: keyLabel(mango, "Z"),
						disabled: props.readonly || !store.canUndo.value,
						onSelect: () => store.undo()
					},
					{
						label: shell.redo(store.redoLabel.value),
						icon: "redo-2",
						kbd: keyLabel(mango, "Shift", "Z"),
						disabled: props.readonly || !store.canRedo.value,
						onSelect: () => store.redo()
					},
					...own.slice(-1)
				];
				await mango.ui.contextMenu(at, rows);
				await next?.();
			}
			function addFilter(propertyId) {
				const c = newCondition(props.collection, propertyId);
				close();
				setFilter(store, props.collection, props.view, { conditions: [...props.view.filter.conditions, c] });
				emit("filtered", c.id);
			}
			function addProperty() {
				const anchor = pop.value?.anchor;
				if (anchor) (0, vue.nextTick)(() => open("addProperty", anchor));
			}
			const typeOf = (id) => id === "title" ? "text" : propertyOf(props.collection, id)?.type ?? "text";
			async function openSearch() {
				searchOpen.value = true;
				await (0, vue.nextTick)();
				searchInput.value?.focus();
				searchInput.value?.select();
			}
			function closeSearch(toView) {
				emit("update:search", "");
				searchOpen.value = false;
				if (toView) emit("to-view");
			}
			function onSearchKey(e) {
				if (e.isComposing) return;
				if (e.key === "Escape") closeSearch(true);
				else if (e.key === "ArrowDown" || e.key === "Enter") emit("to-view");
				else return;
				e.preventDefault();
				e.stopPropagation();
			}
			const titleTip = (0, vue.computed)(() => props.collection.description ? `${props.collection.description}\n${shell.switchCollection}` : shell.switchCollection);
			__expose({
				openSearch,
				openFilter: (anchor) => open("filter", anchor)
			});
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("header", { class: (0, vue.normalizeClass)(["pl-head", { "is-tight": !roomy.value }]) }, [
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-head__title",
						"aria-haspopup": "dialog",
						"aria-expanded": pop.value?.name === "switch",
						"aria-label": `${__props.collection.name || (0, vue.unref)(shell).unnamed}, ${(0, vue.unref)(shell).switchCollection.toLowerCase()}`,
						title: titleTip.value,
						onClick: _cache[0] || (_cache[0] = ($event) => open("switch", $event.currentTarget)),
						onContextmenu: _cache[1] || (_cache[1] = (0, vue.withModifiers)(($event) => menu({
							x: $event.clientX,
							y: $event.clientY
						}), ["prevent"]))
					}, [
						(0, vue.createVNode)(CollectionIcon_default, { collection: __props.collection }, null, 8, ["collection"]),
						(0, vue.createElementVNode)("span", _hoisted_2$8, (0, vue.toDisplayString)(__props.collection.name || (0, vue.unref)(shell).unnamed), 1),
						(0, vue.createVNode)(Icon_default, {
							name: "chevron-down",
							class: "pl-head__chev"
						})
					], 40, _hoisted_1$9),
					__props.count !== null && roomy.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_3$7, (0, vue.toDisplayString)(__props.count) + " " + (0, vue.toDisplayString)((0, vue.unref)(itemWord)(__props.collection, __props.count)), 1)) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.unref)(repository)?.url && wide.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 1,
						type: "button",
						class: "pl-head__repo",
						title: (0, vue.unref)(shell).openRepository((0, vue.unref)(repository).label),
						onClick: _cache[2] || (_cache[2] = ($event) => (0, vue.unref)(mango).workspace.openBrowser((0, vue.unref)(repository).url))
					}, [(0, vue.createVNode)(Icon_default, { name: "git-branch" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(repository).label), 1)], 8, _hoisted_4$7)) : (0, vue.unref)(repository) && wide.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
						key: 2,
						class: "pl-head__repo is-plain",
						title: (0, vue.unref)(shell).projectNamed((0, vue.unref)(repository).label)
					}, [(0, vue.createVNode)(Icon_default, { name: "folder" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(repository).label), 1)], 8, _hoisted_5$7)) : (0, vue.createCommentVNode)("v-if", true),
					__props.saving && roomy.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_6$6, (0, vue.toDisplayString)((0, vue.unref)(shell).saving), 1)) : (0, vue.createCommentVNode)("v-if", true),
					(0, vue.createElementVNode)("div", _hoisted_7$6, [
						(0, vue.createVNode)(ViewTabs_default, {
							ref_key: "tabs",
							ref: tabs,
							collection: __props.collection,
							view: __props.view,
							compact: compactViews.value,
							readonly: __props.readonly,
							onPick: _cache[3] || (_cache[3] = (id) => emit("view", id))
						}, null, 8, [
							"collection",
							"view",
							"compact",
							"readonly"
						]),
						!__props.covered ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [
							_cache[12] || (_cache[12] = (0, vue.createElementVNode)("span", {
								class: "pl-head__sep",
								"aria-hidden": "true"
							}, null, -1)),
							searching.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
								key: 0,
								class: (0, vue.normalizeClass)(["pl-search", {
									"is-wide": wide.value,
									"is-narrow": __props.width < 560
								}])
							}, [
								(0, vue.createVNode)(Icon_default, { name: "search" }),
								(0, vue.createElementVNode)("input", {
									ref_key: "searchInput",
									ref: searchInput,
									type: "text",
									value: __props.search,
									placeholder: (0, vue.unref)(shell).filterItems(many.value),
									"aria-label": (0, vue.unref)(shell).filterItems(many.value),
									title: `${(0, vue.unref)(shell).filterItems(many.value)} (${(0, vue.unref)(keyLabel)((0, vue.unref)(mango), "F")})`,
									autocomplete: "off",
									spellcheck: "false",
									onInput: _cache[4] || (_cache[4] = ($event) => emit("update:search", $event.target.value)),
									onKeydown: onSearchKey,
									onBlur: _cache[5] || (_cache[5] = ($event) => !__props.search && (searchOpen.value = false))
								}, null, 40, _hoisted_8$6),
								__props.search ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
									key: 0,
									size: "sm",
									label: (0, vue.unref)(shell).clearSearch,
									shortcut: "Esc",
									onMousedown: _cache[6] || (_cache[6] = (0, vue.withModifiers)(() => {}, ["prevent"])),
									onClick: _cache[7] || (_cache[7] = ($event) => closeSearch(true))
								}, {
									default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "x" })]),
									_: 1
								}, 40, ["label"])) : (0, vue.createCommentVNode)("v-if", true)
							], 2)) : ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
								key: 1,
								label: (0, vue.unref)(shell).filterItems(many.value),
								shortcut: (0, vue.unref)(keyLabel)((0, vue.unref)(mango), "F"),
								onClick: openSearch
							}, {
								default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "search" })]),
								_: 1
							}, 8, ["label", "shortcut"])),
							!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
								key: 2,
								variant: "ghost",
								size: "sm",
								class: (0, vue.normalizeClass)(["pl-head__filter", { "is-set": filters.value }]),
								"aria-haspopup": "dialog",
								"aria-expanded": pop.value?.name === "filter",
								"aria-label": filters.value ? `${(0, vue.unref)(shell).filter}: ${filters.value}` : (0, vue.unref)(shell).filter,
								title: (0, vue.unref)(shell).addFilter,
								onClick: _cache[8] || (_cache[8] = ($event) => open("filter", $event.currentTarget))
							}, {
								default: (0, vue.withCtx)(() => [
									(0, vue.createVNode)(Icon_default, { name: "list-filter" }),
									roomy.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(shell).filter), 1)], 64)) : (0, vue.createCommentVNode)("v-if", true),
									filters.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_9$6, (0, vue.toDisplayString)(filters.value), 1)) : (0, vue.createCommentVNode)("v-if", true)
								]),
								_: 1
							}, 8, [
								"class",
								"aria-expanded",
								"aria-label",
								"title"
							])) : (0, vue.createCommentVNode)("v-if", true)
						], 64)) : (0, vue.createCommentVNode)("v-if", true),
						(0, vue.createElementVNode)("span", {
							ref_key: "more",
							ref: more,
							class: "pl-head__more"
						}, [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
							label: (0, vue.unref)(shell).more,
							"aria-haspopup": "menu",
							onClick: _cache[9] || (_cache[9] = ($event) => menu($event.currentTarget))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "ellipsis" })]),
							_: 1
						}, 8, ["label"])), marked.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_10$5)) : (0, vue.createCommentVNode)("v-if", true)], 512)
					]),
					pop.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 4 }, [pop.value.name === "switch" ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 0,
						anchor: pop.value.anchor,
						width: 280,
						label: (0, vue.unref)(shell).switchCollection,
						onClose: close
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createElementVNode)("div", _hoisted_11$4, [(0, vue.createVNode)(CollectionSwitcher_default, {
							"current-id": __props.collection.id,
							onPick: _cache[10] || (_cache[10] = (c) => {
								close();
								emit("collection", c);
							}),
							onCreate: _cache[11] || (_cache[11] = ($event) => {
								close();
								emit("new-collection");
							}),
							onLeave: close
						}, null, 8, ["current-id"])])]),
						_: 1
					}, 8, ["anchor", "label"])) : pop.value.name === "filter" ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 1,
						anchor: pop.value.anchor,
						width: 240,
						placement: "bottom-end",
						label: (0, vue.unref)(shell).filterBy,
						onClose: close
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createElementVNode)("div", _hoisted_12$4, [(0, vue.createVNode)(PickList_default, {
							rows: (0, vue.unref)(propertyRows)(__props.collection),
							label: (0, vue.unref)(shell).filterBy,
							placeholder: (0, vue.unref)(shell).filterBy,
							onPick: addFilter
						}, {
							icon: (0, vue.withCtx)(({ row }) => [(0, vue.createVNode)(PropertyIcon_default, { type: typeOf(row.id) }, null, 8, ["type"])]),
							_: 1
						}, 8, [
							"rows",
							"label",
							"placeholder"
						])])]),
						_: 1
					}, 8, ["anchor", "label"])) : pop.value.name === "sort" ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 2,
						anchor: pop.value.anchor,
						width: 280,
						placement: "bottom-end",
						label: (0, vue.unref)(shell).sortBy,
						onClose: close
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(SortPanel_default, {
							collection: __props.collection,
							view: __props.view,
							onClose: close
						}, null, 8, ["collection", "view"])]),
						_: 1
					}, 8, ["anchor", "label"])) : pop.value.name === "group" ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 3,
						anchor: pop.value.anchor,
						width: 260,
						placement: "bottom-end",
						label: (0, vue.unref)(shell).groupBy,
						onClose: close
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(GroupPanel_default, {
							collection: __props.collection,
							view: __props.view,
							onAddProperty: addProperty
						}, null, 8, ["collection", "view"])]),
						_: 1
					}, 8, ["anchor", "label"])) : pop.value.name === "properties" ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 4,
						anchor: pop.value.anchor,
						width: 280,
						placement: "bottom-end",
						label: (0, vue.unref)(shell).properties,
						onClose: close
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(PropertiesPanel_default, {
							collection: __props.collection,
							view: __props.view,
							onAddProperty: addProperty
						}, null, 8, ["collection", "view"])]),
						_: 1
					}, 8, ["anchor", "label"])) : ((0, vue.openBlock)(), (0, vue.createBlock)(AddProperty_default, {
						key: 5,
						"collection-id": __props.collection.id,
						anchor: pop.value.anchor,
						onClose: close
					}, null, 8, ["collection-id", "anchor"]))], 64)) : (0, vue.createCommentVNode)("v-if", true)
				], 2);
			};
		}
	}), [["__scopeId", "data-v-876e3a69"]]);
	// plugins/planner/src/shell/PlannerSkeleton.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$8 = ["aria-label"];
	var _hoisted_2$7 = {
		key: 0,
		class: "pl-skel__head"
	};
	// plugins/planner/src/shell/PlannerSkeleton.vue
	var PlannerSkeleton_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "PlannerSkeleton",
		props: { head: { type: Boolean } },
		setup(__props) {
			const WIDTHS = [
				58,
				41,
				66,
				35,
				52,
				47
			];
			const late = (0, vue.ref)(false);
			let timer;
			(0, vue.onMounted)(() => {
				timer = setTimeout(() => {
					late.value = true;
				}, 150);
			});
			(0, vue.onBeforeUnmount)(() => clearTimeout(timer));
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					class: "pl-skel",
					role: "status",
					"aria-label": (0, vue.unref)(strings$5).loading
				}, [late.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [__props.head ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_2$7, [..._cache[0] || (_cache[0] = [(0, vue.createElementVNode)("span", {
					class: "pl-skel__bar",
					style: { "width": "120px" }
				}, null, -1), (0, vue.createElementVNode)("span", {
					class: "pl-skel__bar",
					style: { "width": "70px" }
				}, null, -1)])])) : (0, vue.createCommentVNode)("v-if", true), ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(WIDTHS, (w) => {
					return (0, vue.createElementVNode)("div", {
						key: w,
						class: "pl-skel__row"
					}, [(0, vue.createElementVNode)("span", {
						class: "pl-skel__bar",
						style: (0, vue.normalizeStyle)({ width: `${w}%` })
					}, null, 4)]);
				}), 64))], 64)) : (0, vue.createCommentVNode)("v-if", true)], 8, _hoisted_1$8);
			};
		}
	}), [["__scopeId", "data-v-41b255dc"]]);
	// plugins/planner/src/shell/StartScreen.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$7 = { class: "pl-start" };
	var _hoisted_2$6 = { class: "pl-start__in" };
	var _hoisted_3$6 = { class: "pl-start__title" };
	var _hoisted_4$6 = { class: "pl-start__body" };
	var _hoisted_5$6 = { class: "pl-start__head" };
	var _hoisted_6$5 = { class: "pl-start__sub" };
	var _hoisted_7$5 = { class: "pl-start__list" };
	var _hoisted_8$5 = ["onClick"];
	var _hoisted_9$5 = { class: "pl-start__name" };
	var _hoisted_10$4 = { class: "pl-start__hint" };
	var _hoisted_11$3 = { class: "pl-start__last" };
	var _hoisted_12$3 = { class: "pl-start__name" };
	var _hoisted_13$3 = { class: "pl-start__hint" };
	// plugins/planner/src/shell/StartScreen.vue
	var StartScreen_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "StartScreen",
		emits: ["made"],
		setup(__props, { emit: __emit }) {
			const emit = __emit;
			const planner = usePlanner();
			const { store } = planner;
			const where = (0, vue.ref)(store.projectPath.value ? "project" : "everywhere");
			const scope = () => scopeOf(store, where.value);
			function create(template) {
				const made = store.createCollection({
					template,
					scope: scope()
				});
				if (made) emit("made", made);
			}
			async function load() {
				const made = await importAsCollection(planner, scope());
				if (made) emit("made", made);
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$7, [(0, vue.createElementVNode)("div", _hoisted_2$6, [
					(0, vue.createElementVNode)("h2", _hoisted_3$6, (0, vue.toDisplayString)((0, vue.unref)(shell).start), 1),
					(0, vue.createElementVNode)("p", _hoisted_4$6, (0, vue.toDisplayString)((0, vue.unref)(shell).startBody), 1),
					(0, vue.createElementVNode)("div", _hoisted_5$6, [(0, vue.createElementVNode)("h3", _hoisted_6$5, (0, vue.toDisplayString)((0, vue.unref)(shell).startList), 1), (0, vue.createVNode)(ScopeChoice_default, {
						modelValue: where.value,
						"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => where.value = $event)
					}, null, 8, ["modelValue"])]),
					(0, vue.createElementVNode)("ul", _hoisted_7$5, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)((0, vue.unref)(TEMPLATES), (t) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("li", { key: t.id }, [(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-start__row",
							onClick: ($event) => create(t.id)
						}, [
							(0, vue.createVNode)(Icon_default, { name: t.icon }, null, 8, ["name"]),
							(0, vue.createElementVNode)("span", _hoisted_9$5, (0, vue.toDisplayString)(t.name), 1),
							(0, vue.createElementVNode)("span", _hoisted_10$4, (0, vue.toDisplayString)(t.description), 1)
						], 8, _hoisted_8$5)]);
					}), 128)), (0, vue.createElementVNode)("li", _hoisted_11$3, [(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-start__row",
						onClick: load
					}, [
						(0, vue.createVNode)(Icon_default, { name: "file-input" }),
						(0, vue.createElementVNode)("span", _hoisted_12$3, (0, vue.toDisplayString)((0, vue.unref)(shell).importCsv), 1),
						(0, vue.createElementVNode)("span", _hoisted_13$3, (0, vue.toDisplayString)((0, vue.unref)(shell).importCsvHint), 1)
					])])])
				])]);
			};
		}
	}), [["__scopeId", "data-v-d9bd5ee7"]]);
	// plugins/planner/src/views/board/cards.ts
	var cardKey = (c) => `${c.group}/${c.id}`;
	/** Where `index` is among `items` once the moving ones are out of it; undefined when there is nothing to be next to. */
	function positionAt(items, moving, index) {
		const rest = items.filter((i) => !moving.has(i.id));
		const next = rest[index];
		if (next) return { before: next.id };
		const last = rest.at(-1);
		return last ? { after: last.id } : void 0;
	}
	/** Whether putting `ids` at `index` leaves the column as it is. */
	function isSamePlace(items, ids, index) {
		const moving = new Set(ids);
		const rest = items.filter((i) => !moving.has(i.id)).map((i) => i.id);
		const after = [
			...rest.slice(0, index),
			...ids,
			...rest.slice(index)
		];
		return after.length === items.length && after.every((id, i) => id === items[i].id);
	}
	/** The index, among the ones that stay, that moves a block one step up (-1) or down (1); null at the end. */
	function stepIndex(items, moving, step) {
		const first = items.findIndex((i) => moving.has(i.id));
		if (first < 0) return null;
		const rest = items.length - items.filter((i) => moving.has(i.id)).length;
		const index = first + step;
		return index < 0 || index > rest ? null : index;
	}
	/** The first words of a body, without its markdown marks. */
	function previewText(body, max = 180) {
		const text = body.slice(0, max * 4).replace(/`{3}[^\n]*\n?|~{3}[^\n]*\n?/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "").replace(/[*`~]+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "").replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
	}
	/** How many of a body's tasks are done; null when it has none. */
	function taskCount(body) {
		let done = 0;
		let all = 0;
		for (const m of body.matchAll(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]/gm)) {
			all++;
			if (m[1] !== " ") done++;
		}
		return all ? {
			done,
			all
		} : null;
	}
	// plugins/planner/src/views/board/strings.ts
	/** The board's words. */
	var strings$1 = {
		board: (collection) => `${collection} board`,
		column: (group, n, word) => `${group}, ${n} ${word}`,
		newItem: (word) => `New ${word}`,
		newItemIn: (word, group) => `New ${word} in ${group}`,
		dropHere: (words) => `Drop ${words} here or press + to add one`,
		hasText: "Has text",
		tasks: (done, all) => `${done} of ${all} tasks done`,
		itemTitle: "Title",
		addHint: "Enter adds it, Escape stops",
		addedHidden: (title) => `${title} was added`,
		addedHiddenBody: "The search or filter of this view hides it.",
		open: "Open",
		columnMenu: (group) => `Options of ${group}`,
		rename: "Rename",
		colour: "Colour…",
		colourOf: (group) => `Colour of ${group}`,
		setDefault: (words) => `Default for new ${words}`,
		collapse: "Collapse",
		expand: (group) => `Expand ${group}`,
		hide: "Hide column",
		moveLeft: "Move left",
		moveRight: "Move right",
		deleteGroup: "Delete",
		addGroup: (word) => `Add ${word}`,
		editGroups: (words) => `Edit ${words}…`,
		groupName: "Name",
		hidden: "Hidden",
		showGroup: (group) => `Show ${group}`,
		linkedChats: (n) => n === 1 ? "A chat is linked" : `${n} chats are linked`,
		selected: (n, word) => `${n} ${word} selected`,
		moved: (what, group) => `${what} moved to ${group}`,
		movedTo: (what, group, at, of) => `${what} moved to ${group}, ${at} of ${of}`,
		added: (title, group) => `${title} added to ${group}`,
		cannotOrder: "This view is sorted, so the order cannot be changed by hand",
		columnMoved: (group, at, of) => `${group} moved, column ${at} of ${of}`,
		dragging: (what) => `Moving ${what}. Escape cancels.`,
		cancelled: "Move cancelled",
		groupTitle: "Choose what the columns are",
		groupBody: "A board has a column for each value of a property.",
		createStatus: "Create a Status property"
	};
	// plugins/planner/src/views/board/BoardCard.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$6 = { class: "pl-card" };
	var _hoisted_2$5 = { class: "pl-card__head" };
	var _hoisted_3$5 = {
		key: 0,
		class: "pl-card__preview"
	};
	var _hoisted_4$5 = {
		key: 1,
		class: "pl-card__foot"
	};
	var _hoisted_5$5 = ["title"];
	var _hoisted_6$4 = {
		key: 0,
		class: "pl-card__marks"
	};
	var _hoisted_7$4 = ["title"];
	var _hoisted_8$4 = ["title"];
	var _hoisted_9$4 = ["title"];
	// plugins/planner/src/views/board/BoardCard.vue
	var BoardCard_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "BoardCard",
		props: {
			collection: {},
			view: {},
			item: {}
		},
		setup(__props) {
			const props = __props;
			const { mango } = usePlanner();
			const { ThreadDot } = mango.ui.components;
			const values = (0, vue.computed)(() => props.view.columns.flatMap((c) => {
				const p = c.visible ? props.collection.properties.find((e) => e.id === c.propertyId) : void 0;
				const v = p ? valueOf(props.item, p) : null;
				return p && v !== null && v !== false ? [p] : [];
			}));
			const preview = (0, vue.computed)(() => props.view.cardPreview === "body" ? previewText(props.item.body) : "");
			const hasText = (0, vue.computed)(() => !preview.value && props.item.body.trim() !== "");
			const tasks = (0, vue.computed)(() => taskCount(props.item.body));
			/** The newest linked chat that is still there. */
			const chat = (0, vue.computed)(() => props.item.chats.findLast((id) => mango.chat.get(id)) ?? null);
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$6, [
					(0, vue.createElementVNode)("div", _hoisted_2$5, [__props.item.icon ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
						key: 0,
						name: __props.item.icon,
						class: "pl-card__icon"
					}, null, 8, ["name"])) : (0, vue.createCommentVNode)("v-if", true), (0, vue.createElementVNode)("span", { class: (0, vue.normalizeClass)(["pl-card__title", { "is-untitled": !__props.item.title }]) }, (0, vue.toDisplayString)(__props.item.title || (0, vue.unref)(strings$5).untitled), 3)]),
					preview.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_3$5, (0, vue.toDisplayString)(preview.value), 1)) : (0, vue.createCommentVNode)("v-if", true),
					values.value.length || hasText.value || tasks.value || chat.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_4$5, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(values.value, (p) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
							key: p.id,
							class: "pl-card__value",
							title: p.name
						}, [(0, vue.createVNode)(ValueView_default, {
							property: p,
							item: __props.item
						}, null, 8, ["property", "item"]), p.type === "checkbox" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [(0, vue.createTextVNode)((0, vue.toDisplayString)(p.name), 1)], 64)) : (0, vue.createCommentVNode)("v-if", true)], 8, _hoisted_5$5);
					}), 128)), hasText.value || tasks.value || chat.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_6$4, [
						hasText.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
							key: 0,
							class: "pl-card__mark",
							title: (0, vue.unref)(strings$1).hasText
						}, [(0, vue.createVNode)(Icon_default, { name: "align-left" })], 8, _hoisted_7$4)) : (0, vue.createCommentVNode)("v-if", true),
						tasks.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
							key: 1,
							class: "pl-card__mark",
							title: (0, vue.unref)(strings$1).tasks(tasks.value.done, tasks.value.all)
						}, [(0, vue.createVNode)(Icon_default, { name: "square-check" }), (0, vue.createTextVNode)((0, vue.toDisplayString)(tasks.value.done) + "/" + (0, vue.toDisplayString)(tasks.value.all), 1)], 8, _hoisted_8$4)) : (0, vue.createCommentVNode)("v-if", true),
						chat.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
							key: 2,
							class: "pl-card__mark",
							title: (0, vue.unref)(strings$1).linkedChats(__props.item.chats.length)
						}, [((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(ThreadDot)), {
							"thread-id": chat.value,
							size: 11
						}, null, 8, ["thread-id"])), __props.item.chats.length > 1 ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [(0, vue.createTextVNode)((0, vue.toDisplayString)(__props.item.chats.length), 1)], 64)) : (0, vue.createCommentVNode)("v-if", true)], 8, _hoisted_9$4)) : (0, vue.createCommentVNode)("v-if", true)
					])) : (0, vue.createCommentVNode)("v-if", true)])) : (0, vue.createCommentVNode)("v-if", true)
				]);
			};
		}
	}), [["__scopeId", "data-v-3272d10e"]]);
	// plugins/planner/src/views/board/InlineInput.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$5 = [
		"aria-label",
		"placeholder",
		"title"
	];
	// plugins/planner/src/views/board/InlineInput.vue
	var InlineInput_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "InlineInput",
		props: {
			label: {},
			placeholder: {},
			value: {},
			single: { type: Boolean },
			hint: {}
		},
		emits: ["add", "close"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const text = (0, vue.ref)(props.value ?? "");
			const input = (0, vue.ref)();
			let done = false;
			(0, vue.onMounted)(() => {
				input.value?.focus();
				input.value?.select();
			});
			function close(byKey) {
				if (done) return;
				done = true;
				emit("close", byKey);
			}
			function add() {
				const value = text.value.trim();
				if (!value) return false;
				text.value = "";
				emit("add", value);
				return true;
			}
			function onKey(e) {
				if (e.isComposing) return;
				if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
				if (e.key === "Enter") {
					e.preventDefault();
					if (!add() || props.single) close(true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					text.value = "";
					close(true);
				}
			}
			function onBlur() {
				if (done || !document.hasFocus()) return;
				add();
				close(false);
			}
			return (_ctx, _cache) => {
				return (0, vue.withDirectives)(((0, vue.openBlock)(), (0, vue.createElementBlock)("input", {
					ref_key: "input",
					ref: input,
					"onUpdate:modelValue": _cache[0] || (_cache[0] = ($event) => text.value = $event),
					class: "pl-inline",
					type: "text",
					spellcheck: "true",
					autocomplete: "off",
					"aria-label": __props.label,
					placeholder: __props.placeholder,
					title: __props.hint,
					onKeydown: onKey,
					onBlur
				}, null, 40, _hoisted_1$5)), [[vue.vModelText, text.value]]);
			};
		}
	}), [["__scopeId", "data-v-aa8f18f2"]]);
	// plugins/planner/src/views/board/BoardColumn.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$4 = ["data-col", "data-sortable"];
	var _hoisted_2$4 = [
		"data-group",
		"aria-label",
		"title"
	];
	var _hoisted_3$4 = { class: "pl-col__count" };
	var _hoisted_4$4 = { class: "pl-col__vertical" };
	var _hoisted_5$4 = [
		"data-col",
		"data-sortable",
		"aria-label"
	];
	var _hoisted_6$3 = ["title"];
	var _hoisted_7$3 = { class: "pl-col__count" };
	var _hoisted_8$3 = {
		key: 0,
		class: "pl-col__top"
	};
	var _hoisted_9$3 = ["data-group", "aria-label"];
	var _hoisted_10$3 = [
		"role",
		"aria-multiselectable",
		"aria-label"
	];
	var _hoisted_11$2 = [
		"aria-selected",
		"aria-posinset",
		"aria-setsize",
		"tabindex",
		"data-card",
		"data-group"
	];
	var _hoisted_12$2 = {
		key: 0,
		class: "pl-col__foot"
	};
	var _hoisted_13$2 = ["data-group", "aria-label"];
	var STEP = 60;
	// plugins/planner/src/views/board/BoardColumn.vue
	var BoardColumn_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "BoardColumn",
		props: {
			collection: {},
			view: {},
			group: {},
			name: {},
			sortable: { type: Boolean },
			readonly: { type: Boolean },
			openItemId: {},
			selected: {},
			moving: {},
			focusKey: {},
			adding: {},
			renaming: { type: Boolean },
			over: { type: Boolean },
			dropY: {}
		},
		emits: [
			"add",
			"startAdd",
			"stopAdd",
			"menu",
			"rename",
			"stopRename",
			"expand"
		],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { IconButton } = usePlanner().mango.ui.components;
			const one = (0, vue.computed)(() => itemWord(props.collection, 1));
			const many = (0, vue.computed)(() => itemWord(props.collection, 2));
			const heading = (0, vue.computed)(() => strings$1.column(props.name, props.group.items.length, itemWord(props.collection, props.group.items.length)));
			const colours = (0, vue.computed)(() => {
				const c = colorVar(props.group.color);
				return {
					"--pl-dot": c.dot,
					"--pl-fg": c.fg,
					"--pl-tint": c.tint,
					"--pl-line": c.line,
					"--pl-strong": c.strong
				};
			});
			/** Long columns show more as they are scrolled. */
			const limit = (0, vue.ref)(STEP);
			const cards = (0, vue.computed)(() => props.group.items.slice(0, limit.value).map((item) => {
				return {
					item,
					key: cardKey({
						id: item.id,
						group: props.group.key
					})
				};
			}));
			const body = (0, vue.ref)();
			function onScroll() {
				const el = body.value;
				if (el && cards.value.length < props.group.items.length && el.scrollHeight - el.scrollTop - el.clientHeight < 900) limit.value += STEP;
			}
			function onAdd(title, at) {
				emit("add", title, at);
				if (at === "end") toEnd();
			}
			async function toEnd() {
				limit.value = Math.max(limit.value, props.group.items.length + STEP);
				await (0, vue.nextTick)();
				if (body.value) body.value.scrollTop = body.value.scrollHeight;
			}
			__expose({
				/** Makes sure the card at this index is there. */
				reveal(index) {
					if (index >= limit.value) limit.value = index + STEP;
				},
				toTop() {
					if (body.value) body.value.scrollTop = 0;
				},
				toEnd
			});
			return (_ctx, _cache) => {
				return __props.group.collapsed ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("section", {
					key: 0,
					class: (0, vue.normalizeClass)(["pl-col is-collapsed", { "is-lit": __props.over }]),
					style: (0, vue.normalizeStyle)(colours.value),
					"data-col": __props.group.key,
					"data-sortable": __props.sortable || void 0
				}, [(0, vue.createElementVNode)("button", {
					type: "button",
					class: "pl-col__strip",
					"data-strip": "",
					"data-head": "",
					"data-group": __props.group.key,
					"aria-label": (0, vue.unref)(strings$1).expand(heading.value),
					"aria-expanded": "false",
					title: (0, vue.unref)(strings$1).expand(__props.name),
					onClick: _cache[0] || (_cache[0] = ($event) => emit("expand"))
				}, [
					_cache[11] || (_cache[11] = (0, vue.createElementVNode)("span", { class: "pl-col__dot" }, null, -1)),
					(0, vue.createElementVNode)("span", _hoisted_3$4, (0, vue.toDisplayString)(__props.group.items.length), 1),
					(0, vue.createElementVNode)("span", _hoisted_4$4, (0, vue.toDisplayString)(__props.name), 1)
				], 8, _hoisted_2$4)], 14, _hoisted_1$4)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("section", {
					key: 1,
					class: (0, vue.normalizeClass)(["pl-col", { "is-lit": __props.over && __props.dropY === null && __props.group.items.length > 0 }]),
					style: (0, vue.normalizeStyle)(colours.value),
					"data-col": __props.group.key,
					"data-sortable": __props.sortable || void 0,
					"aria-label": heading.value
				}, [
					(0, vue.createElementVNode)("header", {
						class: (0, vue.normalizeClass)(["pl-col__head", { "is-sortable": __props.sortable }]),
						"data-head": ""
					}, [_cache[13] || (_cache[13] = (0, vue.createElementVNode)("span", {
						class: "pl-col__dot",
						"aria-hidden": "true"
					}, null, -1)), __props.renaming ? ((0, vue.openBlock)(), (0, vue.createBlock)(InlineInput_default, {
						key: 0,
						single: "",
						label: (0, vue.unref)(strings$1).groupName,
						placeholder: (0, vue.unref)(strings$1).groupName,
						value: __props.group.name,
						onAdd: _cache[1] || (_cache[1] = ($event) => emit("rename", $event)),
						onClose: _cache[2] || (_cache[2] = ($event) => emit("stopRename", $event))
					}, null, 8, [
						"label",
						"placeholder",
						"value"
					])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [
						(0, vue.createElementVNode)("span", {
							class: "pl-col__name",
							title: __props.name
						}, (0, vue.toDisplayString)(__props.name), 9, _hoisted_6$3),
						(0, vue.createElementVNode)("span", _hoisted_7$3, (0, vue.toDisplayString)(__props.group.items.length), 1),
						_cache[12] || (_cache[12] = (0, vue.createElementVNode)("span", { class: "pl-col__spring" }, null, -1)),
						!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
							key: 0,
							size: "sm",
							label: (0, vue.unref)(strings$1).newItemIn(one.value, __props.name),
							onClick: _cache[3] || (_cache[3] = ($event) => emit("startAdd", "top"))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "plus" })]),
							_: 1
						}, 8, ["label"])) : (0, vue.createCommentVNode)("v-if", true),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
							size: "sm",
							label: (0, vue.unref)(strings$1).columnMenu(__props.name),
							"aria-haspopup": "menu",
							"data-menu": "",
							onClick: _cache[4] || (_cache[4] = ($event) => emit("menu", $event.currentTarget))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "ellipsis" })]),
							_: 1
						}, 8, ["label"]))
					], 64))], 2),
					(0, vue.createElementVNode)("div", {
						ref_key: "body",
						ref: body,
						class: "pl-col__body",
						"data-body": "",
						tabindex: "-1",
						onScrollPassive: onScroll
					}, [
						__props.adding === "top" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_8$3, [(0, vue.createVNode)(InlineInput_default, {
							label: (0, vue.unref)(strings$1).newItemIn(one.value, __props.name),
							placeholder: (0, vue.unref)(strings$1).itemTitle,
							hint: (0, vue.unref)(strings$1).addHint,
							onAdd: _cache[5] || (_cache[5] = ($event) => onAdd($event, "top")),
							onClose: _cache[6] || (_cache[6] = ($event) => emit("stopAdd", $event))
						}, null, 8, [
							"label",
							"placeholder",
							"hint"
						])])) : (0, vue.createCommentVNode)("v-if", true),
						!cards.value.length && !__props.readonly && __props.adding === null ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: 1,
							type: "button",
							class: (0, vue.normalizeClass)(["pl-col__zone", { "is-lit": __props.over }]),
							"data-new": "",
							"data-zone": "",
							"data-group": __props.group.key,
							"aria-label": (0, vue.unref)(strings$1).newItemIn(one.value, __props.name),
							onClick: _cache[7] || (_cache[7] = ($event) => emit("startAdd", "top"))
						}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings$1).dropHere(many.value)), 1)], 10, _hoisted_9$3)) : (0, vue.createCommentVNode)("v-if", true),
						(0, vue.createElementVNode)("div", {
							class: (0, vue.normalizeClass)(["pl-col__list", { "is-long": __props.group.items.length > STEP }]),
							"data-list": "",
							role: cards.value.length ? "listbox" : void 0,
							"aria-multiselectable": cards.value.length ? true : void 0,
							"aria-label": cards.value.length ? __props.name : void 0
						}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(cards.value, ({ item, key }, i) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
								key: item.id,
								class: (0, vue.normalizeClass)(["pl-col__card", {
									"is-selected": __props.selected.has(key),
									"is-open": item.id === __props.openItemId,
									"is-moving": __props.moving?.has(key)
								}]),
								role: "option",
								"aria-selected": __props.selected.has(key),
								"aria-posinset": i + 1,
								"aria-setsize": __props.group.items.length,
								tabindex: __props.focusKey === key ? 0 : -1,
								"data-card": item.id,
								"data-group": __props.group.key
							}, [(0, vue.createVNode)(BoardCard_default, {
								collection: __props.collection,
								view: __props.view,
								item
							}, null, 8, [
								"collection",
								"view",
								"item"
							])], 10, _hoisted_11$2);
						}), 128)), __props.over && __props.dropY !== null && cards.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: 0,
							class: "pl-col__drop",
							style: (0, vue.normalizeStyle)({ transform: `translateY(${__props.dropY}px)` })
						}, null, 4)) : (0, vue.createCommentVNode)("v-if", true)], 10, _hoisted_10$3)
					], 544),
					!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("footer", _hoisted_12$2, [__props.adding === "end" ? ((0, vue.openBlock)(), (0, vue.createBlock)(InlineInput_default, {
						key: 0,
						label: (0, vue.unref)(strings$1).newItemIn(one.value, __props.name),
						placeholder: (0, vue.unref)(strings$1).itemTitle,
						hint: (0, vue.unref)(strings$1).addHint,
						onAdd: _cache[8] || (_cache[8] = ($event) => onAdd($event, "end")),
						onClose: _cache[9] || (_cache[9] = ($event) => emit("stopAdd", $event))
					}, null, 8, [
						"label",
						"placeholder",
						"hint"
					])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
						key: 1,
						type: "button",
						class: "pl-col__new",
						"data-new": "",
						"data-foot": "",
						"data-group": __props.group.key,
						"aria-label": (0, vue.unref)(strings$1).newItemIn(one.value, __props.name),
						onClick: _cache[10] || (_cache[10] = ($event) => emit("startAdd", "end"))
					}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).newItem(one.value)), 1)], 8, _hoisted_13$2))])) : (0, vue.createCommentVNode)("v-if", true)
				], 14, _hoisted_5$4));
			};
		}
	}), [["__scopeId", "data-v-c62c38e3"]]);
	// plugins/planner/src/views/board/useBoardDrag.ts
	/** Dragging on the board: cards within and between columns, and columns by their header. Pointer events only. */
	var THRESHOLD = 4;
	var EDGE$1 = 44;
	var SPEED = 16;
	var CARD_GAP = 6;
	/** How far beside a column still counts as it. */
	var NEAR = 24;
	/** The click that ends a drag is not a click on what is under it. */
	function swallowClick() {
		const swallow = (e) => {
			e.stopPropagation();
			e.preventDefault();
		};
		window.addEventListener("click", swallow, {
			capture: true,
			once: true
		});
		setTimeout(() => window.removeEventListener("click", swallow, true), 0);
	}
	var same = (a, b) => JSON.stringify(a) === JSON.stringify(b) ? a : b;
	var speedAt = (pos, from, to) => {
		if (pos < from + EDGE$1) return -16 * Math.min(1, (from + EDGE$1 - pos) / EDGE$1);
		if (pos > to - EDGE$1) return SPEED * Math.min(1, (pos - to + EDGE$1) / EDGE$1);
		return 0;
	};
	function useBoardDrag(o) {
		const drag = (0, vue.shallowRef)(null);
		const cardTarget = (0, vue.shallowRef)(null);
		const columnTarget = (0, vue.shallowRef)(null);
		let start = null;
		let at = {
			x: 0,
			y: 0
		};
		let frame = 0;
		let hold = null;
		function onPointerDown(e) {
			if (start || e.button !== 0 || e.pointerType === "touch" || !o.enabled() || e.ctrlKey || e.metaKey || e.shiftKey) return;
			const el = e.target;
			const column = el.closest("[data-col]");
			const card = el.closest("[data-card]");
			const head = card ? null : el.closest("[data-head]");
			const control = el.closest("input, textarea, button, a, [contenteditable]");
			if (!column || control && control !== head) return;
			if (!card && !(head && column.dataset.sortable !== void 0)) return;
			const box = (card ?? head).getBoundingClientRect();
			start = {
				pointerId: e.pointerId,
				x: e.clientX,
				y: e.clientY,
				card: card ? {
					id: card.dataset.card,
					group: card.dataset.group
				} : null,
				column: column.dataset.col,
				width: box.width
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("blur", cancel);
			window.addEventListener("keydown", onKey, true);
		}
		function begin() {
			if (!start) return;
			try {
				o.board.value?.setPointerCapture(start.pointerId);
			} catch {}
			hold = o.mango.ui.holdOverlay();
			document.documentElement.style.cursor = "grabbing";
			if (start.card) {
				const cards = o.cardsFor(start.card);
				drag.value = {
					kind: "cards",
					cards,
					keys: new Set(cards.map(cardKey)),
					lead: start.card,
					width: start.width
				};
			} else drag.value = {
				kind: "column",
				group: start.column,
				width: start.width
			};
			o.onStart(drag.value);
			(0, vue.nextTick)(() => {
				if (!drag.value) return;
				moveGhost();
				frame = requestAnimationFrame(tick);
			});
		}
		function onMove(e) {
			if (!start || e.pointerId !== start.pointerId) return;
			at = {
				x: e.clientX,
				y: e.clientY
			};
			if (!drag.value) {
				if (Math.hypot(at.x - start.x, at.y - start.y) < THRESHOLD) return;
				begin();
			}
			moveGhost();
		}
		function moveGhost() {
			const el = o.ghost.value;
			if (el) el.style.transform = `translate(${at.x + 12}px, ${at.y + 10}px)`;
		}
		/** Every frame, as columns scroll under a pointer that rests at an edge. */
		function tick() {
			const d = drag.value;
			if (!d) return;
			autoscroll();
			if (d.kind === "cards") cardTarget.value = same(cardTarget.value, findCardTarget(d.cards));
			else columnTarget.value = same(columnTarget.value, findColumnTarget(d.group));
			frame = requestAnimationFrame(tick);
		}
		const columns = () => [...o.board.value?.querySelectorAll("[data-col]") ?? []];
		/** The column under the pointer, or the nearest one when it is in a gap; null off the board. */
		function columnAt() {
			const box = o.board.value?.getBoundingClientRect();
			if (!box || at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom) return null;
			let best = null;
			let nearest = NEAR;
			for (const c of columns()) {
				const r = c.getBoundingClientRect();
				const d = at.x < r.left ? r.left - at.x : at.x > r.right ? at.x - r.right : 0;
				if (d < nearest) [best, nearest] = [c, d];
			}
			return best;
		}
		function autoscroll() {
			const board = o.board.value;
			if (!board) return;
			const box = board.getBoundingClientRect();
			if (at.y >= box.top - EDGE$1 && at.y <= box.bottom + EDGE$1) board.scrollLeft += speedAt(at.x, box.left, box.right);
			if (drag.value?.kind !== "cards") return;
			const body = columnAt()?.querySelector("[data-body]");
			const r = body?.getBoundingClientRect();
			if (body && r && r.height > 88) body.scrollTop += speedAt(at.y, r.top, r.bottom);
		}
		function findCardTarget(moving) {
			const column = columnAt();
			if (!column) return null;
			const group = column.dataset.col;
			const list = column.querySelector("[data-list]");
			if (!list || !o.manual()) return {
				group,
				index: null,
				y: null
			};
			const ids = new Set(moving.map((c) => c.id));
			const cards = [...list.querySelectorAll("[data-card]")].filter((c) => !ids.has(c.dataset.card));
			let low = 0;
			let high = cards.length;
			while (low < high) {
				const mid = low + high >> 1;
				const r = cards[mid].getBoundingClientRect();
				if (at.y < r.top + r.height / 2) high = mid;
				else low = mid + 1;
			}
			const next = cards[low];
			const last = cards.at(-1);
			const y = next ? next.offsetTop - CARD_GAP / 2 : last ? last.offsetTop + last.offsetHeight + CARD_GAP / 2 : 0;
			return {
				group,
				index: low,
				y: Math.max(1, y)
			};
		}
		function findColumnTarget(group) {
			const board = o.board.value;
			const rest = columns().filter((c) => c.dataset.sortable !== void 0 && c.dataset.col !== group);
			if (!board || !rest.length) return null;
			const box = board.getBoundingClientRect();
			if (at.y < box.top - NEAR || at.y > box.bottom + NEAR) return null;
			const rects = rest.map((c) => c.getBoundingClientRect());
			const index = rects.filter((r) => at.x > r.left + r.width / 2).length;
			return {
				index,
				x: (index < rects.length ? rects[index].left - 4 : rects.at(-1).right + 4) - box.left + board.scrollLeft
			};
		}
		function end() {
			const board = o.board.value;
			if (start && board?.hasPointerCapture(start.pointerId)) board.releasePointerCapture(start.pointerId);
			start = null;
			cancelAnimationFrame(frame);
			hold?.dispose();
			hold = null;
			if (drag.value) document.documentElement.style.cursor = "";
			drag.value = null;
			cardTarget.value = null;
			columnTarget.value = null;
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("blur", cancel);
			window.removeEventListener("keydown", onKey, true);
		}
		function onUp(e) {
			if (!start || e.pointerId !== start.pointerId) return;
			const d = drag.value;
			if (!d) return end();
			at = {
				x: e.clientX,
				y: e.clientY
			};
			const cards = d.kind === "cards" ? findCardTarget(d.cards) : null;
			const column = d.kind === "column" ? findColumnTarget(d.group) : null;
			end();
			swallowClick();
			if (d.kind === "cards" && cards) o.onDropCards(d.cards, cards);
			else if (d.kind === "column" && column) o.onDropColumn(d.group, column.index);
			else o.onCancel();
		}
		function cancel() {
			const was = drag.value;
			end();
			if (was) o.onCancel();
		}
		function onKey(e) {
			if (!drag.value) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			if (e.key !== "Escape") return;
			cancel();
			window.addEventListener("pointerup", swallowClick, {
				capture: true,
				once: true
			});
		}
		(0, vue.onBeforeUnmount)(cancel);
		return {
			drag,
			cardTarget,
			columnTarget,
			onPointerDown
		};
	}
	// plugins/planner/src/views/board/BoardView.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$3 = {
		key: 0,
		class: "pl-setup"
	};
	var _hoisted_2$3 = { class: "pl-setup__box" };
	var _hoisted_3$3 = ["id"];
	var _hoisted_4$3 = { class: "pl-setup__body" };
	var _hoisted_5$3 = ["aria-labelledby"];
	var _hoisted_6$2 = ["onClick"];
	var _hoisted_7$2 = {
		key: 1,
		class: "pl-board"
	};
	var _hoisted_8$2 = ["aria-label"];
	var _hoisted_9$2 = {
		key: 0,
		class: "pl-board__end"
	};
	var _hoisted_10$2 = {
		key: 0,
		class: "pl-board__add"
	};
	var _hoisted_11$1 = { class: "pl-board__hidden" };
	var _hoisted_12$1 = ["title"];
	var _hoisted_13$1 = { class: "pl-board__count" };
	var _hoisted_14$1 = {
		class: "sr-only",
		role: "status",
		"aria-live": "polite"
	};
	var _hoisted_15$1 = {
		key: 0,
		class: "pl-ghost__count"
	};
	var _hoisted_16$1 = {
		key: 1,
		class: "pl-ghost__head"
	};
	var _hoisted_17$1 = { class: "pl-board__count" };
	// plugins/planner/src/views/board/BoardView.vue
	var BoardView_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "BoardView",
		props: {
			collection: {},
			view: {},
			result: {},
			search: {},
			readonly: { type: Boolean },
			openItemId: {}
		},
		emits: ["open"],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const planner = usePlanner();
			const { store, mango } = planner;
			const { Button, IconButton } = mango.ui.components;
			const property = (0, vue.computed)(() => props.result.groupBy);
			/** "No status" only while something is in it, or there is nowhere else. */
			const shownGroups = (0, vue.computed)(() => {
				const shown = props.result.groups.filter((g) => !g.hidden);
				const rest = shown.filter((g) => g.key !== "" || g.items.length);
				return rest.length ? rest : shown;
			});
			const hiddenGroups = (0, vue.computed)(() => props.result.groups.filter((g) => g.hidden));
			const groupByKey = (0, vue.computed)(() => new Map(props.result.groups.map((g) => [g.key, g])));
			const isOption = (g) => g.key !== "" && !!property.value && hasOptions(property.value);
			const canAddGroup = (0, vue.computed)(() => !props.readonly && !!property.value && hasOptions(property.value));
			const manual = (0, vue.computed)(() => props.view.sorts.length === 0);
			function nameOf(g) {
				if (isOption(g)) return g.name || strings$5.untitled;
				if (g.key === "") return strings$5.noGroup(property.value?.name ?? "");
				return g.key === "true" ? strings$5.checked : strings$5.unchecked;
			}
			const groupName = (key) => {
				const g = groupByKey.value.get(key);
				return g ? nameOf(g) : "";
			};
			const titleOf = (id) => store.item(props.collection.id, id)?.title || strings$5.untitled;
			const wordOf = (n) => itemWord(props.collection, n);
			const whatOf = (ids) => ids.length === 1 ? titleOf(ids[0]) : `${ids.length} ${wordOf(ids.length)}`;
			const without = (list, key) => list.filter((k) => k !== key);
			function setCollapsed(key, on) {
				const rest = without(props.view.collapsedGroups, key);
				store.updateView(props.collection.id, props.view.id, { collapsedGroups: on ? [...rest, key] : rest });
			}
			function setHidden(key, on) {
				const rest = without(props.view.hiddenGroups, key);
				store.updateView(props.collection.id, props.view.id, { hiddenGroups: on ? [...rest, key] : rest });
			}
			function collapse(key) {
				setCollapsed(key, true);
				setTimeout(() => focusInColumn(key, 0));
			}
			async function expand(key) {
				setCollapsed(key, false);
				await (0, vue.nextTick)();
				focusInColumn(key, 0);
			}
			function hide(key) {
				const next = neighbourColumn(key, 1) ?? neighbourColumn(key, -1);
				setHidden(key, true);
				if (next !== null) setTimeout(() => focusInColumn(next, 0));
			}
			const renaming = (0, vue.ref)(null);
			const addingGroup = (0, vue.ref)(false);
			const colouring = (0, vue.shallowRef)(null);
			/** Options a column can be dragged among: the ones on screen, in order. */
			const sortable = (0, vue.computed)(() => props.readonly ? [] : shownGroups.value.filter(isOption));
			/** Puts a column at an index among the other ones on screen. */
			function moveColumn(key, index) {
				const p = property.value;
				const rest = sortable.value.filter((g) => g.key !== key);
				const from = sortable.value.findIndex((g) => g.key === key);
				if (!p || from < 0 || from === index) return;
				const next = rest[index];
				const last = rest.at(-1);
				if (!last) return;
				store.moveOption(props.collection.id, p.id, key, next ? { before: next.key } : { after: last.key });
				announce(strings$1.columnMoved(groupName(key), index + 1, rest.length + 1));
			}
			function columnMenu(g, anchor) {
				const p = property.value;
				if (!p) return;
				const at = sortable.value.findIndex((e) => e.key === g.key);
				const rows = [];
				if (isOption(g) && !props.readonly) rows.push({
					label: strings$1.rename,
					icon: "pencil",
					onSelect: () => {
						renaming.value = g.key;
					}
				}, {
					label: strings$1.colour,
					icon: "palette",
					onSelect: () => void setTimeout(() => {
						colouring.value = {
							key: g.key,
							anchor
						};
					})
				}, ...p.type === "select" ? [{
					label: strings$1.setDefault(wordOf(2)),
					icon: "circle-dot",
					checked: p.defaultOption === g.key,
					onSelect: () => store.updateProperty(props.collection.id, p.id, { defaultOption: p.defaultOption === g.key ? null : g.key })
				}] : [], {
					label: strings$1.moveLeft,
					icon: "arrow-left",
					disabled: at <= 0,
					divider: true,
					onSelect: () => moveColumn(g.key, at - 1)
				}, {
					label: strings$1.moveRight,
					icon: "arrow-right",
					disabled: at < 0 || at === sortable.value.length - 1,
					onSelect: () => moveColumn(g.key, at + 1)
				});
				rows.push({
					label: strings$1.collapse,
					icon: "chevrons-right-left",
					divider: rows.length > 0,
					disabled: props.readonly,
					onSelect: () => collapse(g.key)
				}, {
					label: strings$1.hide,
					icon: "eye-off",
					disabled: props.readonly,
					onSelect: () => hide(g.key)
				});
				if (!props.readonly && hasOptions(p)) rows.push({
					label: strings$1.editGroups(optionWords(p).many),
					icon: "list",
					divider: true,
					onSelect: () => void setTimeout(() => editProperty(planner, props.collection.id, p.id))
				});
				if (isOption(g) && !props.readonly) rows.push({
					label: strings$1.deleteGroup,
					icon: "trash-2",
					danger: true,
					onSelect: () => void setTimeout(() => {
						deleting.value = {
							key: g.key,
							anchor
						};
					})
				});
				mango.ui.contextMenu(anchor, rows);
			}
			/** Asks where its items go when it has some. */
			const deleting = (0, vue.shallowRef)(null);
			let goes = null;
			function closeDelete() {
				goes = deleting.value?.key ?? null;
				deleting.value = null;
			}
			(0, vue.watch)(() => props.result.groups, (groups) => {
				if (goes === null || groups.some((g) => g.key === goes)) return;
				goes = null;
				if (document.activeElement === document.body) focus();
			}, { flush: "post" });
			function renameGroup(key, name) {
				if (property.value && name !== groupName(key)) store.updateOption(props.collection.id, property.value.id, key, { name });
			}
			/** While a colour is picked it shows; it is written once that is settled. */
			function setColour(color) {
				const key = colouring.value?.key;
				if (key && property.value) store.updateOption(props.collection.id, property.value.id, key, { color }, { defer: true });
			}
			function closeColours() {
				const at = colouring.value?.anchor;
				colouring.value = null;
				(0, vue.nextTick)(() => {
					if (document.activeElement === document.body) at?.focus();
				});
			}
			async function addGroup(name) {
				if (!property.value) return;
				const option = store.addOption(props.collection.id, property.value.id, name);
				if (option && props.view.hiddenGroups.includes(option.id)) setHidden(option.id, false);
				await (0, vue.nextTick)();
				if (board.value) board.value.scrollLeft = board.value.scrollWidth;
				const anchor = option && columnEl(option.id)?.querySelector("[data-menu]");
				if (anchor) {
					anchor.focus({ preventScroll: true });
					colouring.value = {
						key: option.id,
						anchor
					};
				}
			}
			/** Closing an inline field by key gives the focus back to what it stands in for. */
			async function stopAddGroup(byKey) {
				addingGroup.value = false;
				await (0, vue.nextTick)();
				if (byKey && !colouring.value) board.value?.querySelector("[data-add-group]")?.focus();
			}
			async function stopRename(byKey) {
				const key = renaming.value;
				renaming.value = null;
				await (0, vue.nextTick)();
				if (byKey && key) columnEl(key)?.querySelector("[data-menu]")?.focus();
			}
			const groupable = (0, vue.computed)(() => props.collection.properties.filter(isGroupable));
			function groupBy(propertyId) {
				store.updateView(props.collection.id, props.view.id, { groupBy: propertyId });
				(0, vue.nextTick)(focus);
			}
			function createStatus() {
				const t = strings$5.template;
				const p = store.addProperty(props.collection.id, {
					name: t.status,
					type: "select",
					options: [
						{
							name: t.toDo,
							color: "neutral"
						},
						{
							name: t.inProgress,
							color: "blue"
						},
						{
							name: t.done,
							color: "green"
						}
					]
				});
				if (p) groupBy(p.id);
			}
			const board = (0, vue.ref)();
			const columnViews = /* @__PURE__ */ new Map();
			const setColumn = (key, c) => {
				if (c) columnViews.set(key, c);
				else columnViews.delete(key);
			};
			const columnEl = (key) => board.value?.querySelector(`[data-col="${CSS.escape(key)}"]`) ?? null;
			const cardEl = (c) => columnEl(c.group)?.querySelector(`[data-card="${CSS.escape(c.id)}"]`) ?? null;
			const cardOf = (target) => {
				const el = target?.closest("[data-card]");
				return el ? {
					id: el.dataset.card,
					group: el.dataset.group
				} : null;
			};
			const message = (0, vue.ref)("");
			function announce(text) {
				message.value = message.value === text ? `${text} ` : text;
			}
			/** The card Tab goes to. With its index, for when it is gone. */
			const focused = (0, vue.shallowRef)(null);
			/** The focus is on that card, as far as anyone told. */
			let hasFocus = false;
			const itemsIn = (group) => groupByKey.value.get(group)?.items ?? [];
			const indexOf = (c) => itemsIn(c.group).findIndex((i) => i.id === c.id);
			const openGroups = (0, vue.computed)(() => shownGroups.value.filter((g) => !g.collapsed));
			const focusKey = (0, vue.computed)(() => {
				const f = focused.value;
				if (f && openGroups.value.some((g) => g.key === f.group && g.items.some((i) => i.id === f.id))) return cardKey(f);
				const first = openGroups.value.find((g) => g.items.length);
				return first ? cardKey({
					group: first.key,
					id: first.items[0].id
				}) : null;
			});
			async function focusCard(c) {
				const index = indexOf(c);
				if (index < 0) return;
				focused.value = {
					id: c.id,
					group: c.group,
					index
				};
				columnViews.get(c.group)?.reveal(index);
				await (0, vue.nextTick)();
				const el = cardEl(c);
				el?.focus({ preventScroll: true });
				el?.scrollIntoView({
					block: "nearest",
					inline: "nearest"
				});
			}
			/** The card at this index of a column, or the nearest; its "New item" when it has none. */
			function focusInColumn(key, index) {
				const g = groupByKey.value.get(key);
				if (!g) return;
				const item = g.collapsed ? void 0 : g.items[Math.max(0, Math.min(index, g.items.length - 1))];
				if (item) return void focusCard({
					id: item.id,
					group: key
				});
				(columnEl(key)?.querySelector("[data-strip], [data-new]"))?.focus({ preventScroll: true });
				columnEl(key)?.scrollIntoView({
					block: "nearest",
					inline: "nearest"
				});
			}
			function onFocusIn(e) {
				const c = cardOf(e.target);
				hasFocus = !!c;
				if (c) focused.value = {
					...c,
					index: indexOf(c)
				};
			}
			function onFocusOut(e) {
				if (e.relatedTarget) hasFocus = false;
			}
			let restoring = null;
			(0, vue.onBeforeUpdate)(() => {
				restoring = hasFocus && document.activeElement && board.value?.contains(document.activeElement) ? focused.value : null;
			});
			(0, vue.onUpdated)(() => {
				const f = restoring;
				restoring = null;
				if (!f || document.activeElement && document.activeElement !== document.body) return;
				if (indexOf(f) >= 0) return void focusCard(f);
				const elsewhere = openGroups.value.find((g) => g.items.some((i) => i.id === f.id));
				if (elsewhere) focusCard({
					id: f.id,
					group: elsewhere.key
				});
				else focusInColumn(f.group, f.index);
			});
			const selection = (0, vue.shallowRef)(/* @__PURE__ */ new Map());
			let anchor = null;
			/** What is still there of it, in the order of the board. */
			const selectedCards = (0, vue.computed)(() => {
				if (!selection.value.size) return [];
				return shownGroups.value.flatMap((g) => g.items.map((i) => ({
					id: i.id,
					group: g.key
				})).filter((c) => selection.value.has(cardKey(c))));
			});
			const selectedKeys = (0, vue.computed)(() => new Set(selectedCards.value.map(cardKey)));
			function select(cards) {
				selection.value = new Map(cards.map((c) => [cardKey(c), {
					id: c.id,
					group: c.group
				}]));
			}
			function clearSelection() {
				anchor = null;
				if (selection.value.size) select([]);
			}
			function toggle(c) {
				anchor = c;
				const key = cardKey(c);
				select(selectedKeys.value.has(key) ? selectedCards.value.filter((s) => cardKey(s) !== key) : [...selectedCards.value, c]);
				announce(strings$1.selected(selection.value.size, wordOf(selection.value.size)));
			}
			/** From the anchor to this card; just adds it when they are in different columns. */
			function extend(c) {
				const items = itemsIn(c.group);
				const from = anchor?.group === c.group ? items.findIndex((i) => i.id === anchor.id) : -1;
				const to = indexOf(c);
				if (from < 0) {
					anchor = c;
					select([...selectedCards.value, c]);
				} else select([...selectedCards.value.filter((s) => s.group !== c.group), ...items.slice(Math.min(from, to), Math.max(from, to) + 1).map((i) => ({
					id: i.id,
					group: c.group
				}))]);
				announce(strings$1.selected(selection.value.size, wordOf(selection.value.size)));
			}
			/** What an action on a card is about: the selection when it is part of it. */
			const cardsFor = (c) => selectedKeys.value.has(cardKey(c)) ? selectedCards.value : [c];
			const idsOf = (cards) => [...new Set(cards.map((c) => c.id))];
			(0, vue.watch)([() => props.collection.id, () => props.view.id], () => {
				clearSelection();
				focused.value = null;
				hasFocus = false;
				adding.value = null;
				renaming.value = null;
				addingGroup.value = false;
				colouring.value = null;
				deleting.value = null;
			});
			/** Moves cards into a column, at an index among its other cards (null: without a place of their own). */
			function place(cards, group, index) {
				const p = property.value;
				if (!p || props.readonly || !cards.length) return false;
				const ids = idsOf(cards);
				const items = itemsIn(group);
				const inPlace = cards.every((c) => c.group === group);
				const position = manual.value && index !== null ? positionAt(items, new Set(ids), index) : void 0;
				if (inPlace && (position === void 0 || isSamePlace(items, ids, index))) return false;
				store.moveItems(props.collection.id, {
					ids,
					group: inPlace ? void 0 : {
						propertyId: p.id,
						key: group,
						from: new Map(cards.map((c) => [c.id, c.group]))
					},
					position
				});
				const moved = cards.map((c) => ({
					id: c.id,
					group
				}));
				if (selection.value.size) select(moved);
				const what = whatOf(ids);
				(0, vue.nextTick)(() => {
					const at = indexOf({
						id: ids[0],
						group
					});
					announce(manual.value && index !== null && at >= 0 ? strings$1.movedTo(what, groupName(group), at + 1, itemsIn(group).length) : strings$1.moved(what, groupName(group)));
				});
				return true;
			}
			const ghost = (0, vue.ref)();
			const { drag, cardTarget, columnTarget, onPointerDown } = useBoardDrag({
				mango,
				board,
				ghost,
				enabled: () => !props.readonly && !!property.value,
				manual: () => manual.value,
				cardsFor,
				onStart: (d) => {
					if (d.kind === "cards" && !selectedKeys.value.has(cardKey(d.lead))) clearSelection();
					announce(strings$1.dragging(d.kind === "cards" ? whatOf(idsOf(d.cards)) : groupName(d.group)));
				},
				onDropCards: (cards, target) => {
					const g = groupByKey.value.get(target.group);
					if (!g) return;
					const ids = new Set(cards.map((c) => c.id));
					const end = g.items.filter((i) => !ids.has(i.id)).length;
					if (!place(cards, target.group, target.index ?? (manual.value ? end : null))) announce(strings$1.cancelled);
				},
				onDropColumn: moveColumn,
				onCancel: () => announce(strings$1.cancelled)
			});
			const movingKeys = (0, vue.computed)(() => drag.value?.kind === "cards" ? drag.value.keys : null);
			const leadItem = (0, vue.computed)(() => drag.value?.kind === "cards" ? store.item(props.collection.id, drag.value.lead.id) : null);
			const draggedGroup = (0, vue.computed)(() => drag.value?.kind === "column" ? groupByKey.value.get(drag.value.group) ?? null : null);
			const draggedCount = (0, vue.computed)(() => drag.value?.kind === "cards" ? idsOf(drag.value.cards).length : 0);
			function stepVertical(c, step) {
				if (!manual.value) return announce(strings$1.cannotOrder);
				const cards = cardsFor(c).filter((s) => s.group === c.group);
				const index = stepIndex(itemsIn(c.group), new Set(cards.map((s) => s.id)), step);
				if (index !== null && place(cards, c.group, index)) focusCard(c);
			}
			function stepHorizontal(c, step) {
				const next = shownGroups.value[shownGroups.value.findIndex((g) => g.key === c.group) + step];
				if (!next) return;
				const cards = cardsFor(c);
				const ids = new Set(cards.map((s) => s.id));
				const room = next.items.filter((i) => !ids.has(i.id)).length;
				if (!place(cards, next.key, manual.value ? Math.min(Math.max(0, indexOf(c)), room) : null)) return;
				if (next.collapsed) (0, vue.nextTick)(() => focusInColumn(next.key, 0));
				else focusCard({
					id: c.id,
					group: next.key
				});
			}
			const adding = (0, vue.shallowRef)(null);
			function startAdd(group, at) {
				if (props.readonly) return;
				if (groupByKey.value.get(group)?.collapsed) setCollapsed(group, false);
				adding.value = {
					group,
					at
				};
				const column = columnViews.get(group);
				at === "top" ? column?.toTop() : column?.toEnd();
			}
			async function stopAdd(byKey) {
				const was = adding.value;
				adding.value = null;
				if (!byKey || !was) return;
				await (0, vue.nextTick)();
				focusInColumn(was.group, was.at === "top" ? 0 : Infinity);
			}
			async function add(title, group, at) {
				const first = itemsIn(group)[0];
				const last = itemsIn(group).at(-1);
				const collectionId = props.collection.id;
				const name = groupName(group);
				const position = at === "top" ? first ? { before: first.id } : "start" : last ? { after: last.id } : "end";
				const item = await store.createItem(collectionId, {
					title,
					viewId: props.view.id,
					group,
					position
				});
				if (!item || collectionId !== props.collection.id) return;
				await (0, vue.nextTick)();
				if (props.result.items.some((i) => i.id === item.id)) return announce(strings$1.added(title, name));
				mango.ui.toast({
					title: strings$1.addedHidden(title),
					body: strings$1.addedHiddenBody,
					action: {
						label: strings$1.open,
						run: () => planner.go({
							collectionId,
							itemId: item.id
						})
					}
				});
			}
			/** At the top of the first group with a name, or the first there is. */
			function newItem() {
				if (props.readonly) return;
				const g = openGroups.value.find((e) => e.key !== "") ?? openGroups.value[0] ?? shownGroups.value[0];
				if (!g || !property.value) return;
				startAdd(g.key, "top");
				(0, vue.nextTick)(() => columnEl(g.key)?.scrollIntoView({
					block: "nearest",
					inline: "nearest"
				}));
			}
			function onClick(e) {
				const c = cardOf(e.target);
				if (!c) {
					if (!e.target.closest("button, input, a")) clearSelection();
					return;
				}
				if (e.target.closest("a, button")) return;
				if (e.shiftKey) return extend(c);
				if (e.ctrlKey || e.metaKey) return toggle(c);
				clearSelection();
				anchor = c;
				emit("open", c.id);
			}
			function openMenu(c, at) {
				if (!selectedKeys.value.has(cardKey(c))) clearSelection();
				const ids = idsOf(cardsFor(c));
				const after = neighbourOf(c, ids);
				itemMenu(planner, props.collection, ids, at, {
					open: (id) => emit("open", id),
					propertyId: property.value?.id,
					deleted: () => {
						clearSelection();
						setTimeout(after);
					}
				});
			}
			/** Focuses what takes the place of a card, when it and the others are gone. */
			function neighbourOf(c, ids) {
				const gone = new Set(ids);
				const items = itemsIn(c.group);
				const index = indexOf(c);
				const next = items.slice(index).find((i) => !gone.has(i.id)) ?? items.slice(0, index).findLast((i) => !gone.has(i.id));
				return () => next ? void focusCard({
					id: next.id,
					group: c.group
				}) : focusInColumn(c.group, 0);
			}
			function onContextMenu(e) {
				const c = cardOf(e.target);
				const head = e.target.closest("[data-head]");
				if (c) {
					e.preventDefault();
					openMenu(c, e.clientX || e.clientY ? {
						x: e.clientX,
						y: e.clientY
					} : cardEl(c));
				} else if (head && !e.target.closest("input")) {
					const g = groupByKey.value.get(head.closest("[data-col]")?.dataset.col ?? "");
					if (!g || g.collapsed) return;
					e.preventDefault();
					columnMenu(g, head.querySelector("[data-menu]") ?? head);
				}
			}
			function neighbourColumn(group, step) {
				return shownGroups.value[shownGroups.value.findIndex((g) => g.key === group) + step]?.key ?? null;
			}
			/** Answers whether the key was for the board. */
			function onCardKey(e, c) {
				const mod = e.ctrlKey || e.metaKey;
				const index = indexOf(c);
				const items = itemsIn(c.group);
				if (e.altKey && e.shiftKey && !mod) {
					if (e.key === "ArrowUp") stepVertical(c, -1);
					else if (e.key === "ArrowDown") stepVertical(c, 1);
					else if (e.key === "ArrowLeft") stepHorizontal(c, -1);
					else if (e.key === "ArrowRight") stepHorizontal(c, 1);
					else return false;
					return true;
				}
				if (e.key === "ContextMenu" || e.key === "F10" && e.shiftKey && !mod && !e.altKey) {
					const el = cardEl(c);
					if (el) openMenu(c, el);
					return true;
				}
				if (e.altKey) return false;
				if (mod) {
					if (e.key.toLowerCase() !== "a" || e.shiftKey) return false;
					select(openGroups.value.flatMap((g) => g.items.map((i) => ({
						id: i.id,
						group: g.key
					}))));
					announce(strings$1.selected(selectedCards.value.length, wordOf(selectedCards.value.length)));
					return true;
				}
				switch (e.key) {
					case "ArrowUp":
					case "ArrowDown": {
						const next = items[index + (e.key === "ArrowUp" ? -1 : 1)];
						if (!next) {
							if (e.key === "ArrowDown" && !e.shiftKey) columnEl(c.group)?.querySelector("[data-foot]")?.focus();
							return true;
						}
						const to = {
							id: next.id,
							group: c.group
						};
						if (e.shiftKey) {
							if (anchor?.group !== c.group || !selectedKeys.value.size) anchor = c;
							extend(to);
						}
						focusCard(to);
						return true;
					}
					case "ArrowLeft":
					case "ArrowRight": {
						const key = neighbourColumn(c.group, e.key === "ArrowLeft" ? -1 : 1);
						if (key !== null) focusInColumn(key, index);
						return true;
					}
					case "Home":
						focusInColumn(c.group, 0);
						return true;
					case "End":
						focusInColumn(c.group, Infinity);
						return true;
					case "Enter":
						emit("open", c.id);
						return true;
					case " ":
						toggle(c);
						return true;
					case "Escape":
						if (!selection.value.size) return false;
						clearSelection();
						return true;
					case "Delete":
						if (!props.readonly) {
							const ids = idsOf(cardsFor(c));
							const after = neighbourOf(c, ids);
							clearSelection();
							store.deleteItems(props.collection.id, ids);
							(0, vue.nextTick)(after);
						}
						return true;
					case "n":
					case "N":
						startAdd(c.group, "top");
						return true;
					default: return false;
				}
			}
			/** On a column's "New item", or a collapsed column. */
			function onEdgeKey(e, group) {
				if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
				switch (e.key) {
					case "ArrowUp":
						if (itemsIn(group).length) focusInColumn(group, Infinity);
						else columnEl(group)?.querySelector("[data-new]")?.focus();
						return true;
					case "ArrowDown":
						columnEl(group)?.querySelector("[data-foot]")?.focus();
						return true;
					case "ArrowLeft":
					case "ArrowRight": {
						const key = neighbourColumn(group, e.key === "ArrowLeft" ? -1 : 1);
						if (key !== null) focusInColumn(key, e.target.hasAttribute("data-foot") ? Infinity : 0);
						return true;
					}
					case "n":
					case "N":
						startAdd(group, "top");
						return true;
					default: return false;
				}
			}
			function onKey(e) {
				if (e.defaultPrevented || e.isComposing || drag.value) return;
				const c = cardOf(e.target);
				const edge = e.target.closest("[data-new], [data-strip]");
				if (!(c && e.target !== cardEl(c) ? false : c ? onCardKey(e, c) : edge ? onEdgeKey(e, edge.dataset.group) : false)) return;
				e.preventDefault();
				e.stopPropagation();
			}
			function focus() {
				(board.value?.querySelector("[data-card][tabindex=\"0\"]") ?? board.value?.querySelector("[data-new], [data-strip]") ?? board.value?.querySelector("button"))?.focus({ preventScroll: true });
			}
			__expose({
				newItem,
				focus
			});
			const pickId = (0, vue.useId)();
			return (_ctx, _cache) => {
				return !property.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$3, [(0, vue.createElementVNode)("div", _hoisted_2$3, [
					(0, vue.createElementVNode)("h3", {
						id: (0, vue.unref)(pickId),
						class: "pl-setup__title"
					}, (0, vue.toDisplayString)((0, vue.unref)(strings$1).groupTitle), 9, _hoisted_3$3),
					(0, vue.createElementVNode)("p", _hoisted_4$3, (0, vue.toDisplayString)((0, vue.unref)(strings$1).groupBody), 1),
					!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
						key: 0,
						class: "pl-setup__list",
						role: "group",
						"aria-labelledby": (0, vue.unref)(pickId)
					}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(groupable.value, (p) => {
						return (0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: p.id,
							type: "button",
							class: "pl-setup__row",
							onClick: ($event) => groupBy(p.id)
						}, [(0, vue.createVNode)(PropertyIcon_default, { type: p.type }, null, 8, ["type"]), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)(p.name), 1)], 8, _hoisted_6$2);
					}), 128))], 8, _hoisted_5$3)) : (0, vue.createCommentVNode)("v-if", true),
					!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
						key: 1,
						variant: groupable.value.length ? "secondary" : "primary",
						onClick: createStatus
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).createStatus), 1)]),
						_: 1
					}, 8, ["variant"])) : (0, vue.createCommentVNode)("v-if", true)
				])])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_7$2, [
					(0, vue.createElementVNode)("div", {
						ref_key: "board",
						ref: board,
						class: "pl-board__scroll",
						role: "group",
						"aria-label": (0, vue.unref)(strings$1).board(__props.collection.name),
						onPointerdown: _cache[1] || (_cache[1] = (...args) => (0, vue.unref)(onPointerDown) && (0, vue.unref)(onPointerDown)(...args)),
						onClick,
						onContextmenu: onContextMenu,
						onKeydown: onKey,
						onFocusin: onFocusIn,
						onFocusout: onFocusOut
					}, [
						((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(shownGroups.value, (g) => {
							return (0, vue.openBlock)(), (0, vue.createBlock)(BoardColumn_default, {
								key: g.key,
								ref_for: true,
								ref: (c) => setColumn(g.key, c),
								class: (0, vue.normalizeClass)({ "is-dragged": draggedGroup.value?.key === g.key }),
								collection: __props.collection,
								view: __props.view,
								group: g,
								name: nameOf(g),
								sortable: isOption(g) && !__props.readonly,
								readonly: __props.readonly,
								"open-item-id": __props.openItemId,
								selected: selectedKeys.value,
								moving: movingKeys.value,
								"focus-key": focusKey.value,
								adding: adding.value?.group === g.key ? adding.value.at : null,
								renaming: renaming.value === g.key,
								over: (0, vue.unref)(cardTarget)?.group === g.key,
								"drop-y": (0, vue.unref)(cardTarget)?.group === g.key ? (0, vue.unref)(cardTarget).y : null,
								onAdd: (title, at) => add(title, g.key, at),
								onStartAdd: ($event) => startAdd(g.key, $event),
								onStopAdd: stopAdd,
								onMenu: ($event) => columnMenu(g, $event),
								onRename: ($event) => renameGroup(g.key, $event),
								onStopRename: stopRename,
								onExpand: ($event) => expand(g.key)
							}, null, 8, [
								"class",
								"collection",
								"view",
								"group",
								"name",
								"sortable",
								"readonly",
								"open-item-id",
								"selected",
								"moving",
								"focus-key",
								"adding",
								"renaming",
								"over",
								"drop-y",
								"onAdd",
								"onStartAdd",
								"onMenu",
								"onRename",
								"onExpand"
							]);
						}), 128)),
						hiddenGroups.value.length || canAddGroup.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_9$2, [canAddGroup.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_10$2, [addingGroup.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(InlineInput_default, {
							key: 0,
							single: "",
							label: (0, vue.unref)(strings$1).groupName,
							placeholder: (0, vue.unref)(strings$1).groupName,
							onAdd: addGroup,
							onClose: stopAddGroup
						}, null, 8, ["label", "placeholder"])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
							key: 1,
							type: "button",
							class: "pl-board__addbtn",
							"data-add-group": "",
							onClick: _cache[0] || (_cache[0] = ($event) => addingGroup.value = true)
						}, [(0, vue.createVNode)(Icon_default, { name: "plus" }), (0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$1).addGroup((0, vue.unref)(optionWords)(property.value).one)), 1)]))])) : (0, vue.createCommentVNode)("v-if", true), hiddenGroups.value.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [(0, vue.createElementVNode)("h3", _hoisted_11$1, (0, vue.toDisplayString)((0, vue.unref)(strings$1).hidden), 1), ((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(hiddenGroups.value, (g) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
								key: g.key,
								class: "pl-board__row"
							}, [
								(0, vue.createElementVNode)("span", {
									class: "pl-board__name",
									title: nameOf(g)
								}, [isOption(g) ? ((0, vue.openBlock)(), (0, vue.createBlock)(OptionTag_default, {
									key: 0,
									option: g
								}, null, 8, ["option"])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [(0, vue.createTextVNode)((0, vue.toDisplayString)(nameOf(g)), 1)], 64))], 8, _hoisted_12$1),
								(0, vue.createElementVNode)("span", _hoisted_13$1, (0, vue.toDisplayString)(g.items.length), 1),
								!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
									key: 0,
									size: "sm",
									label: (0, vue.unref)(strings$1).showGroup(nameOf(g)),
									onClick: ($event) => setHidden(g.key, false)
								}, {
									default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "eye" })]),
									_: 1
								}, 8, ["label", "onClick"])) : (0, vue.createCommentVNode)("v-if", true)
							]);
						}), 128))], 64)) : (0, vue.createCommentVNode)("v-if", true)])) : (0, vue.createCommentVNode)("v-if", true),
						(0, vue.unref)(columnTarget) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: 1,
							class: "pl-board__line",
							style: (0, vue.normalizeStyle)({ transform: `translateX(${(0, vue.unref)(columnTarget).x}px)` })
						}, null, 4)) : (0, vue.createCommentVNode)("v-if", true)
					], 40, _hoisted_8$2),
					(0, vue.createElementVNode)("div", _hoisted_14$1, (0, vue.toDisplayString)(message.value), 1),
					colouring.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(Popover_default, {
						key: 0,
						anchor: colouring.value.anchor,
						width: 240,
						label: (0, vue.unref)(strings$1).colourOf(groupName(colouring.value.key)),
						placement: "bottom-end",
						onClose: closeColours
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(ColorPicker_default, {
							"model-value": groupByKey.value.get(colouring.value.key)?.color ?? "neutral",
							label: (0, vue.unref)(strings$1).colourOf(groupName(colouring.value.key)),
							"onUpdate:modelValue": setColour,
							onChange: _cache[2] || (_cache[2] = ($event) => (0, vue.unref)(store).flush())
						}, null, 8, ["model-value", "label"])]),
						_: 1
					}, 8, ["anchor", "label"])) : (0, vue.createCommentVNode)("v-if", true),
					deleting.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(DeleteOption_default, {
						key: 1,
						"collection-id": __props.collection.id,
						"property-id": property.value.id,
						"option-id": deleting.value.key,
						anchor: deleting.value.anchor,
						onClose: closeDelete
					}, null, 8, [
						"collection-id",
						"property-id",
						"option-id",
						"anchor"
					])) : (0, vue.createCommentVNode)("v-if", true),
					((0, vue.openBlock)(), (0, vue.createBlock)(vue.Teleport, { to: "body" }, [(0, vue.unref)(drag) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
						key: 0,
						ref_key: "ghost",
						ref: ghost,
						class: "pl-ghost",
						style: (0, vue.normalizeStyle)({ width: `${(0, vue.unref)(drag).width}px` }),
						"aria-hidden": "true"
					}, [leadItem.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
						key: 0,
						class: (0, vue.normalizeClass)(["pl-ghost__card", { "is-stack": draggedCount.value > 1 }])
					}, [(0, vue.createVNode)(BoardCard_default, {
						collection: __props.collection,
						view: __props.view,
						item: leadItem.value
					}, null, 8, [
						"collection",
						"view",
						"item"
					]), draggedCount.value > 1 ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_15$1, (0, vue.toDisplayString)(draggedCount.value), 1)) : (0, vue.createCommentVNode)("v-if", true)], 2)) : draggedGroup.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_16$1, [(0, vue.createVNode)(OptionTag_default, { option: draggedGroup.value }, null, 8, ["option"]), (0, vue.createElementVNode)("span", _hoisted_17$1, (0, vue.toDisplayString)(draggedGroup.value.items.length), 1)])) : (0, vue.createCommentVNode)("v-if", true)], 4)) : (0, vue.createCommentVNode)("v-if", true)]))
				]));
			};
		}
	}), [["__scopeId", "data-v-b31ff853"]]);
	// plugins/planner/src/views/table/strings.ts
	/** The table view's words. */
	var strings = {
		grid: (name) => `${name || "Untitled"} table`,
		title: "Title",
		untitled: "Untitled",
		open: "Open",
		openItem: (title) => `Open ${title || "Untitled"}`,
		newItem: "New item",
		newItemIn: (group) => `New item in ${group}`,
		addProperty: "Add a property",
		selectRow: (title) => `Select ${title || "Untitled"}`,
		selectAll: "Select all",
		reorder: "Drag to reorder",
		checked: "Checked",
		unchecked: "Not checked",
		noGroup: (property) => `No ${property.toLowerCase()}`,
		edit: (column) => `Edit ${column}`,
		sortAscending: "Sort ascending",
		sortDescending: "Sort descending",
		removeSort: "Remove sort",
		filter: "Filter on this",
		moveLeft: "Move left",
		moveRight: "Move right",
		resetWidth: "Reset width",
		selected: (n) => `${n} selected`,
		setProperty: "Set property",
		duplicate: "Duplicate",
		delete: "Delete",
		clear: "Clear selection",
		selectionActions: "Selected items",
		count: (n) => n === 1 ? "1 item" : `${n} items`,
		countOf: (n, total) => `${n} of ${total} items`,
		sum: (n) => `Sum ${n}`,
		checkedOf: (n, total) => `${n} of ${total}`,
		empty: "No items yet",
		noMatches: "Nothing matches",
		notPasted: (n) => n === 1 ? "1 value did not fit its column" : `${n} values did not fit their columns`
	};
	// plugins/planner/src/views/table/BulkBar.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$2 = ["aria-label"];
	var _hoisted_2$2 = {
		class: "pl-bulk__count",
		role: "status"
	};
	var _hoisted_3$2 = ["title"];
	var _hoisted_4$2 = ["title"];
	var _hoisted_5$2 = ["title"];
	// plugins/planner/src/views/table/BulkBar.vue
	var BulkBar_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "BulkBar",
		props: {
			collection: {},
			count: {}
		},
		emits: [
			"set",
			"duplicate",
			"delete",
			"clear"
		],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const { mango } = usePlanner();
			const { IconButton } = mango.ui.components;
			function setProperty(e) {
				const anchor = e.currentTarget;
				let picked = null;
				mango.ui.contextMenu(anchor, props.collection.properties.filter((p) => !isReadonly(p)).map((p) => ({
					label: p.name || strings$5.untitled,
					icon: PROPERTY_ICONS[p.type],
					onSelect: () => {
						picked = p;
					}
				}))).then(() => {
					if (picked) emit("set", picked, anchor);
				});
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					class: "pl-bulk",
					role: "toolbar",
					"aria-label": (0, vue.unref)(strings).selectionActions,
					onKeydown: _cache[3] || (_cache[3] = (0, vue.withKeys)((0, vue.withModifiers)(($event) => emit("clear"), ["stop", "prevent"]), ["esc"]))
				}, [
					(0, vue.createElementVNode)("span", _hoisted_2$2, (0, vue.toDisplayString)((0, vue.unref)(strings).selected(__props.count)), 1),
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-bulk__btn",
						title: (0, vue.unref)(strings).setProperty,
						"aria-haspopup": "menu",
						onClick: setProperty
					}, [(0, vue.createVNode)(Icon_default, { name: "sliders-horizontal" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings).setProperty), 1)], 8, _hoisted_3$2),
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-bulk__btn",
						title: (0, vue.unref)(strings).duplicate,
						onClick: _cache[0] || (_cache[0] = ($event) => emit("duplicate"))
					}, [(0, vue.createVNode)(Icon_default, { name: "copy" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings).duplicate), 1)], 8, _hoisted_4$2),
					(0, vue.createElementVNode)("button", {
						type: "button",
						class: "pl-bulk__btn is-danger",
						title: (0, vue.unref)(strings).delete,
						onClick: _cache[1] || (_cache[1] = ($event) => emit("delete"))
					}, [(0, vue.createVNode)(Icon_default, { name: "trash-2" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings).delete), 1)], 8, _hoisted_5$2),
					((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(IconButton)), {
						size: "sm",
						label: (0, vue.unref)(strings).clear,
						shortcut: "Esc",
						onClick: _cache[2] || (_cache[2] = ($event) => emit("clear"))
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(Icon_default, { name: "x" })]),
						_: 1
					}, 8, ["label"]))
				], 40, _hoisted_1$2);
			};
		}
	}), [["__scopeId", "data-v-18eb83c8"]]);
	// plugins/planner/src/views/table/CellInput.vue
	var CellInput_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "CellInput",
		props: {
			text: {},
			label: {},
			multiline: { type: Boolean },
			numeric: { type: Boolean },
			selectAll: { type: Boolean }
		},
		emits: ["commit", "cancel"],
		setup(__props, { emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const el = (0, vue.ref)(null);
			const start = props.multiline ? props.text : props.text.replace(/\s*\n\s*/g, " ");
			let over = false;
			function fit() {
				const box = el.value;
				if (!props.multiline || !box) return;
				box.style.height = "auto";
				box.style.height = `${Math.min(Math.max(box.scrollHeight + 2, 33), 180)}px`;
			}
			(0, vue.onMounted)(async () => {
				await (0, vue.nextTick)();
				const box = el.value;
				if (!box) return;
				box.focus({ preventScroll: true });
				if (props.selectAll) box.select();
				else box.setSelectionRange(box.value.length, box.value.length);
				fit();
			});
			function commit(then) {
				if (over) return;
				over = true;
				const text = el.value?.value ?? start;
				emit("commit", text === start ? props.text : text, then);
			}
			function onKey(e) {
				if (e.isComposing) return;
				if ([
					"Enter",
					"Tab",
					"Escape"
				].includes(e.key)) e.stopPropagation();
				if (e.key === "Enter" && props.multiline && (e.altKey || e.shiftKey)) {
					e.preventDefault();
					const box = el.value;
					box.setRangeText("\n", box.selectionStart ?? 0, box.selectionEnd ?? 0, "end");
					fit();
				} else if (e.key === "Enter") {
					e.preventDefault();
					commit(e.ctrlKey || e.metaKey ? "stay" : "down");
				} else if (e.key === "Tab") {
					e.preventDefault();
					commit(e.shiftKey ? "left" : "right");
				} else if (e.key === "Escape") {
					e.preventDefault();
					over = true;
					emit("cancel");
				}
			}
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)(__props.multiline ? "textarea" : "input"), {
					ref_key: "el",
					ref: el,
					class: (0, vue.normalizeClass)(["pl-cell-input", { "is-numeric": __props.numeric }]),
					value: (0, vue.unref)(start),
					"aria-label": __props.label,
					inputmode: __props.numeric ? "decimal" : void 0,
					rows: __props.multiline ? 1 : void 0,
					spellcheck: "false",
					autocomplete: "off",
					onInput: fit,
					onKeydown: onKey,
					onBlur: _cache[0] || (_cache[0] = ($event) => commit("blur")),
					onMousedown: _cache[1] || (_cache[1] = (0, vue.withModifiers)(() => {}, ["stop"])),
					onDblclick: _cache[2] || (_cache[2] = (0, vue.withModifiers)(() => {}, ["stop"])),
					onCopy: _cache[3] || (_cache[3] = (0, vue.withModifiers)(() => {}, ["stop"])),
					onCut: _cache[4] || (_cache[4] = (0, vue.withModifiers)(() => {}, ["stop"])),
					onPaste: _cache[5] || (_cache[5] = (0, vue.withModifiers)(() => {}, ["stop"])),
					onContextmenu: _cache[6] || (_cache[6] = (0, vue.withModifiers)(() => {}, ["stop"]))
				}, null, 40, [
					"class",
					"value",
					"aria-label",
					"inputmode",
					"rows"
				]);
			};
		}
	}), [["__scopeId", "data-v-0f838fba"]]);
	// plugins/planner/src/views/table/clipboard.ts
	/** Cells as text and back: tab separated, as spreadsheets write it. Pure. */
	var cellText = (item, field) => field ? valueText(valueOf(item, field), field) : item.title;
	var quote = (t) => /[\t\r\n"]/.test(t) ? `"${t.replaceAll("\"", "\"\"")}"` : t;
	function toTsv(items, fields) {
		return items.map((i) => fields.map((f) => quote(cellText(i, f))).join("	")).join("\n");
	}
	function parseTsv(source) {
		const text = source.replace(/\r\n?/g, "\n").replace(/\n$/, "");
		const rows = [[]];
		const quoted = /"((?:[^"]|"")*)"(?=[\t\n]|$)/y;
		const plain = /[^\t\n]*/y;
		for (let at = 0;;) {
			quoted.lastIndex = plain.lastIndex = at;
			const q = quoted.exec(text);
			const cell = q ? q[1].replaceAll("\"\"", "\"") : plain.exec(text)[0];
			at += q ? q[0].length : cell.length;
			rows.at(-1).push(cell);
			if (at >= text.length) return rows;
			if (text[at] === "\n") rows.push([]);
			at++;
		}
	}
	/**
	* What pasting into these items and fields does, from their first on. A single row goes into every item given.
	* `addOption` makes an option that is missing, and answers it.
	*/
	function planPaste(cells, items, fields, addOption) {
		const changes = /* @__PURE__ */ new Map();
		const sets = /* @__PURE__ */ new Map();
		/** The options made, by the id `parseValue` gave them. */
		const made = /* @__PURE__ */ new Map();
		let skipped = 0;
		const read = (cell, p) => {
			if (isReadonly(p)) return void 0;
			if (!cell.trim()) return p.type === "checkbox" ? false : null;
			let set = sets.get(p.id);
			if (!set) sets.set(p.id, set = new OptionSet(p.options));
			const value = parseValue(cell, p.type, set);
			if (value === null) return void 0;
			if (!hasOptions(p)) return value;
			const ids = (Array.isArray(value) ? value : [value]).flatMap((id) => {
				if (p.options.some((o) => o.id === id)) return [id];
				const real = made.get(id) ?? addOption(p, set.options.find((o) => o.id === id).name)?.id;
				if (!real) return [];
				made.set(id, real);
				return [real];
			});
			if (!ids.length) return void 0;
			return p.type === "select" ? ids[0] : ids;
		};
		for (const [y, item] of items.entries()) {
			const row = cells.length === 1 ? cells[0] : cells[y];
			if (!row) break;
			const values = {};
			const change = { values };
			for (const [x, cell] of row.entries()) {
				const field = fields[x];
				if (field === void 0) break;
				if (field === null) {
					change.title = cell.replace(/\s*\n\s*/g, " ").trim();
					continue;
				}
				const value = read(cell, field);
				if (value === void 0) skipped++;
				else values[field.id] = value;
			}
			if (change.title !== void 0 || Object.keys(values).length) changes.set(item.id, change);
		}
		return {
			changes,
			skipped
		};
	}
	// plugins/planner/src/views/table/drag.ts
	var EDGE = 36;
	/** Answers a function that ends the drag without a result (for unmounting). */
	function startDrag(e, o) {
		const from = {
			x: e.clientX,
			y: e.clientY
		};
		let at = from;
		let hold = null;
		let frame = 0;
		function begin() {
			hold = o.hold();
			document.documentElement.style.cursor = o.cursor ?? "grabbing";
			o.start?.();
			if (o.scroll) frame = requestAnimationFrame(tick);
		}
		function tick() {
			frame = requestAnimationFrame(tick);
			const { el, axis, inset = [0, 0] } = o.scroll;
			const r = el.getBoundingClientRect();
			const [p, start, end] = axis === "y" ? [
				at.y,
				r.top + inset[0],
				r.bottom - inset[1]
			] : [
				at.x,
				r.left + inset[0],
				r.right - inset[1]
			];
			const speed = p < start + EDGE ? (p - start - EDGE) / 3 : p > end - EDGE ? (p - end + EDGE) / 3 : 0;
			if (!speed) return;
			const by = Math.max(-16, Math.min(16, speed));
			if (axis === "y") el.scrollTop += by;
			else el.scrollLeft += by;
			o.move(at.x, at.y);
		}
		function onMove(ev) {
			if (ev.pointerId !== e.pointerId) return;
			at = {
				x: ev.clientX,
				y: ev.clientY
			};
			if (!hold) {
				if (Math.hypot(at.x - from.x, at.y - from.y) < (o.threshold ?? 4)) return;
				begin();
			}
			o.move(at.x, at.y);
		}
		function onKey(ev) {
			if (ev.key !== "Escape") return;
			ev.preventDefault();
			ev.stopImmediatePropagation();
			finish(false);
		}
		const onUp = (ev) => {
			if (ev.pointerId === e.pointerId) finish(true);
		};
		const onCancel = () => finish(false);
		function finish(done) {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onCancel);
			window.removeEventListener("keydown", onKey, true);
			cancelAnimationFrame(frame);
			if (!hold) return;
			hold.dispose();
			hold = null;
			document.documentElement.style.cursor = "";
			const swallow = (ev) => ev.stopPropagation();
			window.addEventListener("click", swallow, {
				capture: true,
				once: true
			});
			setTimeout(() => window.removeEventListener("click", swallow, true));
			o.end(done);
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onCancel);
		window.addEventListener("keydown", onKey, true);
		if (o.threshold === 0) begin();
		return () => finish(false);
	}
	var itemKey = (group, itemId) => `i/${group}/${itemId}`;
	function linesOf(result, readonly) {
		const out = [];
		for (const group of result.groups) {
			if (group.hidden && result.groupBy) continue;
			if (result.groupBy) {
				out.push({
					kind: "group",
					key: `g/${group.key}`,
					group
				});
				if (group.collapsed) continue;
			}
			for (const item of group.items) out.push({
				kind: "item",
				key: itemKey(group.key, item.id),
				group,
				item
			});
			if (!readonly) out.push({
				kind: "add",
				key: `a/${group.key}`,
				group
			});
		}
		return out;
	}
	/** The lines to draw for a scroll position, with some to spare on both sides. */
	function windowOf(count, scrollTop, height, spare = 8) {
		const first = Math.max(0, Math.floor(scrollTop / 32) - spare);
		return [Math.min(first, count), Math.min(count, Math.ceil((scrollTop + height) / 32) + spare)];
	}
	/** The items of the lines from one to another, either way round. */
	function itemsBetween(lines, a, b) {
		const part = lines.slice(Math.min(a, b), Math.max(a, b) + 1);
		return [...new Set(part.flatMap((l) => l.kind === "item" ? [l.item.id] : []))];
	}
	/** Where rows let go at a line boundary (0: above the first line) go; null when that is nowhere. */
	function dropAt(lines, boundary, sorted) {
		const above = lines[boundary - 1];
		const below = lines[boundary];
		const place = (group, position) => ({
			group,
			position: sorted ? void 0 : position,
			boundary
		});
		if (above?.kind === "item") return place(above.group, { after: above.item.id });
		if (below?.kind === "item") return place(below.group, { before: below.item.id });
		const group = above?.group ?? below?.group;
		if (!group) return null;
		const last = group.items.at(-1);
		return place(group, last ? { after: last.id } : void 0);
	}
	var allIn = (items, result, key) => !result.groupBy || items.every((i) => groupsOf(i, result.groupBy).includes(key));
	// plugins/planner/src/views/table/TableView.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1$1 = { class: "pl-table" };
	var _hoisted_2$1 = [
		"aria-label",
		"aria-rowcount",
		"aria-colcount",
		"aria-activedescendant",
		"aria-readonly"
	];
	var _hoisted_3$1 = {
		class: "pl-tr pl-tr--head",
		role: "row",
		"aria-rowindex": "1"
	};
	var _hoisted_4$1 = ["aria-label"];
	var _hoisted_5$1 = ["aria-checked", "aria-label"];
	var _hoisted_6$1 = [
		"id",
		"aria-colindex",
		"aria-sort",
		"title",
		"onPointerdown",
		"onClick",
		"onContextmenu"
	];
	var _hoisted_7$1 = { class: "pl-th__name" };
	var _hoisted_8$1 = ["onPointerdown", "onDblclick"];
	var _hoisted_9$1 = ["aria-label", "title"];
	var _hoisted_10$1 = [
		"aria-rowindex",
		"aria-selected",
		"onContextmenu"
	];
	var _hoisted_11 = ["title", "onPointerdown"];
	var _hoisted_12 = [
		"aria-checked",
		"aria-label",
		"onClick"
	];
	var _hoisted_13 = [
		"id",
		"aria-colindex",
		"aria-readonly",
		"data-col",
		"onMousedown"
	];
	var _hoisted_14 = ["title"];
	var _hoisted_15 = [
		"aria-label",
		"title",
		"onClick"
	];
	var _hoisted_16 = [
		"disabled",
		"aria-checked",
		"aria-label",
		"onClick"
	];
	var _hoisted_17 = {
		key: 3,
		class: "pl-td__text"
	};
	var _hoisted_18 = {
		key: 4,
		class: "pl-td__value"
	};
	var _hoisted_19 = ["aria-rowindex"];
	var _hoisted_20 = [
		"id",
		"aria-colspan",
		"aria-expanded",
		"onMousedown",
		"onClick"
	];
	var _hoisted_21 = {
		key: 1,
		class: "pl-line__name"
	};
	var _hoisted_22 = { class: "pl-line__count" };
	var _hoisted_23 = [
		"aria-label",
		"title",
		"onClick"
	];
	var _hoisted_24 = {
		key: 0,
		class: "pl-line__note"
	};
	var _hoisted_25 = {
		key: 0,
		class: "pl-none"
	};
	var _hoisted_26 = ["aria-rowindex"];
	var _hoisted_27 = ["aria-colindex", "title"];
	var GUTTER = 46;
	var ADD_W = 36;
	var HEAD_H = 32;
	var FOOT_H = 32;
	/** The key of the header in `active`. */
	var HEAD = "head";
	// plugins/planner/src/views/table/TableView.vue
	var TableView_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "TableView",
		props: {
			collection: {},
			view: {},
			result: {},
			search: {},
			readonly: { type: Boolean },
			openItemId: {}
		},
		emits: ["open"],
		setup(__props, { expose: __expose, emit: __emit }) {
			const props = __props;
			const emit = __emit;
			const planner = usePlanner();
			const { mango, store } = planner;
			const { ThreadDot } = mango.ui.components;
			const uid = (0, vue.useId)();
			const WIDTHS = {
				text: 200,
				number: 110,
				select: 140,
				multiSelect: 180,
				date: 150,
				checkbox: 96,
				url: 180,
				createdTime: 150,
				updatedTime: 150,
				unsupported: 140
			};
			const viewport = (0, vue.reactive)({
				width: 800,
				height: 600
			});
			const draftWidths = (0, vue.ref)({});
			const cols = (0, vue.computed)(() => {
				const out = [];
				let left = 0;
				const add = (id, field, name, fallback) => {
					let width = draftWidths.value[id] ?? props.view.widths[id] ?? fallback;
					if (!field) width = Math.min(width, Math.max(130, Math.round(viewport.width * .55) - GUTTER));
					out.push({
						id,
						field,
						name,
						width,
						left
					});
					left += width;
				};
				add(TITLE, null, strings.title, 300);
				for (const c of props.view.columns) {
					const p = c.visible ? propertyOf(props.collection, c.propertyId) : null;
					if (p) add(p.id, p, p.name || strings$5.untitled, WIDTHS[p.type]);
				}
				return out;
			});
			const colIndex = (0, vue.computed)(() => new Map(cols.value.map((c, i) => [c.id, i])));
			const rowWidth = (0, vue.computed)(() => GUTTER + cols.value.reduce((n, c) => n + c.width, 0) + ADD_W);
			const sortOf = (id) => props.view.sorts.find((s) => s.propertyId === id)?.direction ?? null;
			const sorted = (0, vue.computed)(() => props.view.sorts.length > 0);
			const grid = (0, vue.ref)(null);
			const scrollTop = (0, vue.ref)(0);
			const lines = (0, vue.computed)(() => linesOf(props.result, props.readonly));
			const lineIndex = (0, vue.computed)(() => new Map(lines.value.map((l, i) => [l.key, i])));
			const bodyHeight = (0, vue.computed)(() => Math.max(0, viewport.height - HEAD_H - FOOT_H));
			const shown = (0, vue.computed)(() => {
				const [from, to] = windowOf(lines.value.length, scrollTop.value, bodyHeight.value);
				const out = [];
				for (let i = from; i < to; i++) out.push({
					line: lines.value[i],
					index: i
				});
				const at = lineIndex.value.get(active.value?.key ?? "");
				if (at !== void 0 && at < from) out.unshift({
					line: lines.value[at],
					index: at
				});
				else if (at !== void 0 && at >= to) out.push({
					line: lines.value[at],
					index: at
				});
				return out;
			});
			let observer;
			(0, vue.onMounted)(() => {
				observer = new ResizeObserver(() => {
					if (!grid.value) return;
					viewport.width = grid.value.clientWidth;
					viewport.height = grid.value.clientHeight;
				});
				observer.observe(grid.value);
			});
			let stopDrag;
			(0, vue.onBeforeUnmount)(() => {
				observer?.disconnect();
				stopDrag?.();
			});
			const groupName = (g) => {
				const p = props.result.groupBy;
				if (!p || g.name) return g.name;
				if (p.type === "checkbox") return g.key === "true" ? strings.checked : strings.unchecked;
				return strings.noGroup(p.name);
			};
			const active = (0, vue.shallowRef)(null);
			const cellId = (key, col) => `${uid}-${key}-${col}`;
			const activeLine = (0, vue.computed)(() => lines.value[lineIndex.value.get(active.value?.key ?? "") ?? -1] ?? null);
			const activeCol = (0, vue.computed)(() => cols.value[colIndex.value.get(active.value?.col ?? "title") ?? 0]);
			const activeId = (0, vue.computed)(() => {
				if (!active.value) return void 0;
				if (active.value.key === HEAD) return cellId(HEAD, activeCol.value.id);
				const line = activeLine.value;
				return line ? cellId(line.key, line.kind === "item" ? activeCol.value.id : "line") : void 0;
			});
			const isActive = (key, col) => active.value?.key === key && activeCol.value.id === col;
			let lastIndex = 0;
			(0, vue.watch)(lines, (list) => {
				const now = active.value;
				if (!now || now.key === HEAD) return;
				const at = lineIndex.value.get(now.key);
				if (at !== void 0) return void (lastIndex = at);
				const id = now.key.startsWith("i/") ? now.key.slice(now.key.lastIndexOf("/") + 1) : null;
				const moved = id ? list.find((l) => l.kind === "item" && l.item.id === id) : void 0;
				const next = moved ?? list[Math.min(lastIndex, list.length - 1)];
				if (!moved && editing.value) editing.value = null;
				active.value = next ? {
					key: next.key,
					col: now.col
				} : null;
				if (editing.value && next) editing.value = {
					...editing.value,
					key: next.key
				};
			});
			function elementOf(cell = activeId.value) {
				return cell ? document.getElementById(cell) : null;
			}
			function activate(index, col = active.value?.col ?? "title", reveal = true) {
				const max = lines.value.length - 1;
				const i = Math.max(-1, Math.min(index, max));
				if (i < 0) active.value = {
					key: HEAD,
					col
				};
				else {
					lastIndex = i;
					active.value = {
						key: lines.value[i].key,
						col
					};
				}
				if (reveal) scrollTo(i, col);
			}
			function scrollTo(index, col) {
				const el = grid.value;
				if (!el) return;
				if (index >= 0) {
					const top = index * 32;
					if (top < el.scrollTop) el.scrollTop = top;
					else if (top + 32 > el.scrollTop + bodyHeight.value) el.scrollTop = top + 32 - bodyHeight.value;
				}
				const c = cols.value[colIndex.value.get(col) ?? 0];
				if (!c.field) {
					el.scrollLeft = 0;
					return;
				}
				const pinned = GUTTER + cols.value[0].width;
				const left = GUTTER + c.left;
				if (left - pinned < el.scrollLeft) el.scrollLeft = left - pinned;
				else if (left + c.width > el.scrollLeft + viewport.width) el.scrollLeft = left + c.width - viewport.width;
			}
			function focus() {
				if (!active.value && lines.value.length) activate(0, TITLE, false);
				grid.value?.focus({ preventScroll: true });
			}
			const currentIndex = () => active.value?.key === HEAD ? -1 : lineIndex.value.get(active.value?.key ?? "") ?? 0;
			const selection = (0, vue.shallowRef)(/* @__PURE__ */ new Set());
			/** Where Shift extends from. */
			let anchor = null;
			/** What was selected before the range being extended. */
			let anchorBase = /* @__PURE__ */ new Set();
			(0, vue.watch)(() => props.result.items, (items) => {
				if (!selection.value.size) return;
				const there = new Set(items.map((i) => i.id));
				const kept = [...selection.value].filter((id) => there.has(id));
				if (kept.length !== selection.value.size) selection.value = new Set(kept);
			});
			(0, vue.watch)(() => props.view.id, () => {
				selection.value = /* @__PURE__ */ new Set();
				active.value = null;
				editing.value = null;
				popover.value = null;
				if (grid.value) grid.value.scrollTop = grid.value.scrollLeft = 0;
			});
			const selectedItems = (0, vue.computed)(() => props.result.items.filter((i) => selection.value.has(i.id)));
			const allSelected = (0, vue.computed)(() => props.result.items.length > 0 && selection.value.size === props.result.items.length);
			function toggleSelected(line, range = false) {
				if (range && anchor) return selectTo(line.key);
				const next = new Set(selection.value);
				if (!next.delete(line.item.id)) next.add(line.item.id);
				setAnchor(line.key, next);
				selection.value = next;
			}
			function setAnchor(key, base) {
				anchor = key;
				anchorBase = base;
			}
			function selectTo(key) {
				if (!anchor || !lineIndex.value.has(anchor)) setAnchor(active.value?.key ?? key, /* @__PURE__ */ new Set());
				const [a, b] = [lineIndex.value.get(anchor), lineIndex.value.get(key)];
				if (a === void 0 || b === void 0) return;
				selection.value = /* @__PURE__ */ new Set([...anchorBase, ...itemsBetween(lines.value, a, b)]);
			}
			function clearSelection() {
				selection.value = /* @__PURE__ */ new Set();
				anchor = null;
				focus();
			}
			function selectAll() {
				selection.value = allSelected.value ? /* @__PURE__ */ new Set() : new Set(props.result.items.map((i) => i.id));
			}
			const editing = (0, vue.shallowRef)(null);
			const popover = (0, vue.shallowRef)(null);
			const liveProperty = (0, vue.computed)(() => popover.value?.kind === "value" ? propertyOf(props.collection, popover.value.property.id) : null);
			const isEditing = (key, col) => editing.value?.key === key && editing.value.col === col;
			const inPlace = (f) => !f || f.type === "text" || f.type === "number" || f.type === "url";
			const canEdit = (f) => !props.readonly && !(f && isReadonly(f));
			/** `typed`: what was typed to start it, in place of what is there. */
			async function edit(typed) {
				const line = activeLine.value;
				const { id, field } = activeCol.value;
				if (line?.kind !== "item" || !canEdit(field)) return;
				if (field?.type === "checkbox") return toggleCheckbox(line.item, field);
				scrollTo(currentIndex(), id);
				if (inPlace(field)) {
					editing.value = {
						key: line.key,
						col: id,
						text: typed ?? cellText(line.item, field),
						selectAll: typed === void 0 && field?.type !== "text"
					};
					return;
				}
				await (0, vue.nextTick)();
				const el = elementOf();
				if (el && field) popover.value = {
					kind: "value",
					property: field,
					itemIds: [line.item.id],
					anchor: el
				};
			}
			function commitEdit(text, then) {
				const was = editing.value;
				editing.value = null;
				const index = currentIndex();
				const line = was && lines.value[lineIndex.value.get(was.key) ?? -1];
				const col = was && cols.value[colIndex.value.get(was.col) ?? -1];
				if (line?.kind === "item" && col && text !== cellText(line.item, col.field)) {
					const { field } = col;
					if (!field) store.updateItem(props.collection.id, line.item.id, { title: text.trim() });
					else {
						const value = field.type === "number" ? parseNumber(text) : text.trim() ? field.type === "url" ? text.trim() : text : null;
						if (field.type === "number" && value === null && text.trim()) mango.ui.toast({
							title: strings.notPasted(1),
							kind: "warning"
						});
						else store.updateItem(props.collection.id, line.item.id, { values: { [field.id]: value } });
					}
				}
				if (then === "blur") return;
				grid.value?.focus({ preventScroll: true });
				if (then === "down") activate(index + 1, was?.col);
				else if (then !== "stay") step(then === "right" ? 1 : -1, index, was?.col);
			}
			function cancelEdit() {
				editing.value = null;
				grid.value?.focus({ preventScroll: true });
			}
			/** One cell on or back, over the row's end. */
			function step(by, index, col = TITLE) {
				const c = (colIndex.value.get(col) ?? 0) + by;
				if (c >= 0 && c < cols.value.length) return activate(index, cols.value[c].id);
				const next = lines.value.findIndex((l, i) => l.kind === "item" && i > index);
				if (by > 0 && next >= 0) return activate(next, TITLE);
				if (by < 0) {
					for (let i = index - 1; i >= 0; i--) if (lines.value[i].kind === "item") return activate(i, cols.value.at(-1).id);
				}
			}
			function toggleCheckbox(item, p) {
				if (!canEdit(p)) return;
				store.updateItem(props.collection.id, item.id, { values: { [p.id]: valueOf(item, p) !== true } });
			}
			function closePopover() {
				popover.value = null;
				(0, vue.nextTick)(() => {
					if (!document.activeElement || document.activeElement === document.body) grid.value?.focus({ preventScroll: true });
				});
			}
			async function addedProperty(p) {
				popover.value = null;
				await (0, vue.nextTick)();
				if (colIndex.value.has(p.id)) activate(-1, p.id);
				grid.value?.focus({ preventScroll: true });
			}
			/** The cells these keys are about: the selected rows, or the active one. */
			function clearCells() {
				const line = activeLine.value;
				const { field } = activeCol.value;
				if (line?.kind !== "item" || !canEdit(field)) return;
				store.updateItem(props.collection.id, line.item.id, field ? { values: { [field.id]: field.type === "checkbox" ? false : null } } : { title: "" });
			}
			function deleteSelected() {
				if (props.readonly) return;
				store.deleteItems(props.collection.id, [...selection.value]);
				clearSelection();
			}
			async function addItem(group, atTop = false) {
				if (props.readonly) return;
				if (group.collapsed) toggleGroup(group);
				const edge = atTop ? group.items[0] : group.items.at(-1);
				const item = await store.createItem(props.collection.id, {
					viewId: props.view.id,
					group: props.result.groupBy ? group.key : void 0,
					position: edge ? atTop ? { before: edge.id } : { after: edge.id } : atTop ? "start" : "end"
				});
				if (!item) return;
				await (0, vue.nextTick)();
				let at = lineIndex.value.get(itemKey(group.key, item.id));
				at ??= lines.value.findIndex((l) => l.kind === "item" && l.item.id === item.id);
				if (at < 0) return emit("open", item.id);
				activate(at, TITLE);
				await (0, vue.nextTick)();
				grid.value?.focus({ preventScroll: true });
				await edit();
			}
			function newItem() {
				const group = props.result.groups.find((g) => !(g.hidden && props.result.groupBy));
				if (group) addItem(group, true);
			}
			function toggleGroup(g) {
				const list = props.view.collapsedGroups;
				store.updateView(props.collection.id, props.view.id, { collapsedGroups: g.collapsed ? list.filter((k) => k !== g.key) : [...list, g.key] });
			}
			function updateView(change) {
				store.updateView(props.collection.id, props.view.id, change);
			}
			function sortBy(id, direction) {
				updateView({ sorts: sortOf(id) === direction ? [] : [{
					propertyId: id,
					direction
				}] });
			}
			function filterOn(id, field) {
				updateView({ filter: {
					...props.view.filter,
					conditions: [...props.view.filter.conditions, {
						id: newId(),
						propertyId: id,
						operator: operatorsFor(field?.type ?? "title")[0],
						value: null
					}]
				} });
			}
			function setWidth(id, width) {
				const { [id]: _, ...rest } = props.view.widths;
				updateView({ widths: width === null ? rest : {
					...rest,
					[id]: Math.round(Math.min(1200, Math.max(60, width)))
				} });
			}
			/** Before the column of another property, or last (null). */
			function moveColumn(id, before) {
				if (id === before) return;
				const moving = props.view.columns.find((c) => c.propertyId === id);
				if (!moving) return;
				const rest = props.view.columns.filter((c) => c !== moving);
				const at = before ? rest.findIndex((c) => c.propertyId === before) : rest.length;
				const next = [
					...rest.slice(0, at),
					moving,
					...rest.slice(at)
				];
				if (next.some((c, i) => c !== props.view.columns[i])) updateView({ columns: next });
			}
			function shiftColumn(id, by) {
				const i = colIndex.value.get(id);
				if (i === void 0 || i < 1) return;
				const to = by < 0 ? i - 1 : i + 2;
				if (to >= 1 && to <= cols.value.length) moveColumn(id, cols.value[to]?.id ?? null);
			}
			async function headerMenu(col, at) {
				active.value = {
					key: HEAD,
					col: col.id
				};
				if (props.readonly) return;
				const { field, id } = col;
				const i = colIndex.value.get(id);
				const rows = [{
					label: strings.sortAscending,
					icon: "arrow-up",
					checked: sortOf(id) === "asc",
					onSelect: () => sortBy(id, "asc")
				}, {
					label: strings.sortDescending,
					icon: "arrow-down",
					checked: sortOf(id) === "desc",
					onSelect: () => sortBy(id, "desc")
				}];
				if (sortOf(id)) rows.push({
					label: strings.removeSort,
					icon: "x",
					onSelect: () => updateView({ sorts: props.view.sorts.filter((s) => s.propertyId !== id) })
				});
				rows.push({
					label: strings.filter,
					icon: "list-filter",
					onSelect: () => filterOn(id, field)
				});
				if (field) rows.push({
					label: strings.moveLeft,
					icon: "arrow-left",
					divider: true,
					disabled: i < 2,
					onSelect: () => shiftColumn(id, -1)
				}, {
					label: strings.moveRight,
					icon: "arrow-right",
					disabled: i === cols.value.length - 1,
					onSelect: () => shiftColumn(id, 1)
				});
				if (props.view.widths[id]) rows.push({
					label: strings.resetWidth,
					icon: "move-horizontal",
					divider: !field,
					onSelect: () => setWidth(id, null)
				});
				if (field) await propertyMenu(planner, props.collection, field, at, props.view, rows);
				else await mango.ui.contextMenu(at, rows);
				if (!document.activeElement || document.activeElement === document.body) grid.value?.focus({ preventScroll: true });
			}
			function resize(e, col) {
				if (e.button !== 0 || props.readonly) return;
				const from = col.width;
				stopDrag = startDrag(e, {
					threshold: 2,
					cursor: "col-resize",
					hold: () => mango.ui.holdOverlay(),
					move: (x) => draftWidths.value = { [col.id]: Math.round(Math.min(1200, Math.max(60, from + x - e.clientX))) },
					end: (done) => {
						const width = draftWidths.value[col.id];
						if (done && width !== void 0) setWidth(col.id, width);
						draftWidths.value = {};
					}
				});
			}
			const colDrag = (0, vue.shallowRef)(null);
			function dragColumn(e, col) {
				if (e.button !== 0 || !col.field || props.readonly || e.pointerType === "touch") return;
				stopDrag = startDrag(e, {
					hold: () => mango.ui.holdOverlay(),
					scroll: {
						el: grid.value,
						axis: "x",
						inset: [GUTTER + cols.value[0].width, 0]
					},
					move: (x) => {
						const el = grid.value;
						const at = x - el.getBoundingClientRect().left + el.scrollLeft - GUTTER;
						const before = cols.value.slice(1).find((c) => at < c.left + c.width / 2);
						const last = cols.value.at(-1);
						colDrag.value = {
							id: col.id,
							before: before?.id ?? null,
							x: GUTTER + (before ? before.left : last.left + last.width)
						};
					},
					end: (done) => {
						const drag = colDrag.value;
						colDrag.value = null;
						if (done && drag) moveColumn(drag.id, drag.before);
					}
				});
			}
			const rowDrag = (0, vue.shallowRef)(null);
			/** In a sorted view the order is not the user's; rows can still go to another group. */
			const canDrag = (0, vue.computed)(() => !props.readonly && (!sorted.value || props.result.groupBy !== null));
			function dragRow(e, line) {
				if (e.button !== 0 || !canDrag.value) return;
				const ids = selection.value.has(line.item.id) ? selectedItems.value.map((i) => i.id) : [line.item.id];
				stopDrag = startDrag(e, {
					hold: () => mango.ui.holdOverlay(),
					scroll: {
						el: grid.value,
						axis: "y",
						inset: [HEAD_H, FOOT_H]
					},
					start: () => rowDrag.value = {
						ids: new Set(ids),
						drop: null
					},
					move: (_, y) => {
						const el = grid.value;
						const at = y - el.getBoundingClientRect().top - HEAD_H + el.scrollTop;
						const boundary = Math.max(0, Math.min(lines.value.length, Math.round(at / 32)));
						rowDrag.value = {
							ids: new Set(ids),
							drop: dropAt(lines.value, boundary, sorted.value)
						};
					},
					end: (done) => {
						const drop = rowDrag.value?.drop;
						rowDrag.value = null;
						if (done && drop) moveTo(ids, drop, line.group.key);
					}
				});
			}
			function moveTo(ids, drop, from) {
				const { groupBy } = props.result;
				const items = props.result.items.filter((i) => ids.includes(i.id));
				const regroup = groupBy && !(drop.group.key === from && allIn(items, props.result, from));
				let position = drop.position;
				const beside = position && ("after" in position ? position.after : position.before);
				if (beside && ids.includes(beside)) {
					const list = drop.group.items;
					const at = list.findIndex((i) => i.id === beside);
					const after = list.slice(0, at).findLast((i) => !ids.includes(i.id));
					const before = list.slice(at).find((i) => !ids.includes(i.id));
					position = after ? { after: after.id } : before ? { before: before.id } : void 0;
				}
				if (!regroup && !position) return;
				const key = active.value?.key;
				store.moveItems(props.collection.id, {
					ids,
					...regroup ? { group: {
						propertyId: groupBy.id,
						key: drop.group.key,
						...drop.group.key === from ? {} : { from }
					} } : {},
					...position ? { position } : {}
				});
				if (key && regroup) (0, vue.nextTick)(() => {
					const at = lineIndex.value.get(itemKey(drop.group.key, ids[0]));
					if (at !== void 0 && ids.some((id) => key.endsWith(id))) activate(at);
				});
			}
			/** Alt+Shift+Up/Down: past the neighbour, and out of the group at its end. */
			function nudge(by) {
				const line = activeLine.value;
				if (line?.kind !== "item" || !canDrag.value) return;
				const list = line.group.items;
				const neighbour = list[list.findIndex((i) => i.id === line.item.id) + by];
				if (neighbour) {
					if (sorted.value) return;
					store.moveItems(props.collection.id, {
						ids: [line.item.id],
						position: by < 0 ? { before: neighbour.id } : { after: neighbour.id }
					});
				} else if (props.result.groupBy) {
					const groups = props.result.groups.filter((g) => !g.hidden);
					const target = groups[groups.findIndex((g) => g.key === line.group.key) + by];
					if (!target) return;
					if (target.collapsed) toggleGroup(target);
					const edge = by < 0 ? target.items.at(-1) : target.items[0];
					const position = sorted.value || !edge ? void 0 : by < 0 ? { after: edge.id } : { before: edge.id };
					moveTo([line.item.id], {
						group: target,
						position,
						boundary: 0
					}, line.group.key);
				}
				(0, vue.nextTick)(() => scrollTo(currentIndex(), active.value?.col ?? "title"));
			}
			function copyText() {
				if (selection.value.size) return toTsv(selectedItems.value, cols.value.map((c) => c.field));
				const line = activeLine.value;
				if (line?.kind !== "item") return null;
				const text = cellText(line.item, activeCol.value.field);
				return text.includes("\n") ? toTsv([line.item], [activeCol.value.field]) : text;
			}
			function onCopy(e) {
				if (!ownKey(e)) return;
				const text = copyText();
				if (text === null) return;
				e.preventDefault();
				e.clipboardData?.setData("text/plain", text);
			}
			function onPaste(e) {
				if (!ownKey(e) || props.readonly) return;
				const text = e.clipboardData?.getData("text/plain");
				const line = activeLine.value;
				if (!text || line?.kind !== "item") return;
				e.preventDefault();
				const cells = parseTsv(text);
				const at = currentIndex();
				const { changes, skipped } = planPaste(cells, cells.length === 1 ? selection.value.has(line.item.id) ? selectedItems.value : [line.item] : lines.value.slice(at).flatMap((l) => l.kind === "item" ? [l.item] : []).slice(0, cells.length), cols.value.slice(colIndex.value.get(activeCol.value.id)).map((c) => c.field), (p, name) => store.addOption(props.collection.id, p.id, name));
				store.updateEach(props.collection.id, changes);
				if (skipped) mango.ui.toast({
					title: strings.notPasted(skipped),
					kind: "warning"
				});
			}
			function rowMenu(e, line, col) {
				if (!selection.value.has(line.item.id)) active.value = {
					key: line.key,
					col: col ?? active.value?.col ?? "title"
				};
				openMenu(line.item, {
					x: e.clientX,
					y: e.clientY
				});
			}
			function openMenu(item, at) {
				const ids = selection.value.has(item.id) ? selectedItems.value.map((i) => i.id) : [item.id];
				itemMenu(planner, props.collection, ids, at, { open: (id) => emit("open", id) });
			}
			async function setForSelected(p, el) {
				await (0, vue.nextTick)();
				popover.value = {
					kind: "value",
					property: p,
					itemIds: [...selection.value],
					anchor: el
				};
			}
			function duplicateSelected() {
				const copies = store.duplicateItems(props.collection.id, [...selection.value]);
				if (copies.length) selection.value = new Set(copies.map((i) => i.id));
			}
			/** Not in an editor of ours. */
			function ownKey(e) {
				return !editing.value && !popover.value && !(e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]"));
			}
			/** Buttons in the grid work without taking the focus: the grid keeps it, and the active cell with it. */
			function onMouseDown(e) {
				if (!e.target.closest("button, .pl-th")) return;
				e.preventDefault();
				grid.value?.focus({ preventScroll: true });
			}
			function onCellDown(e, line, col) {
				if (e.button !== 0) return;
				if (e.shiftKey) {
					e.preventDefault();
					grid.value?.focus({ preventScroll: true });
					selectTo(line.key);
				} else if (e.ctrlKey || e.metaKey) toggleSelected(line);
				else {
					setAnchor(line.key, /* @__PURE__ */ new Set());
					if (selection.value.size) selection.value = /* @__PURE__ */ new Set();
				}
				lastIndex = lineIndex.value.get(line.key) ?? 0;
				active.value = {
					key: line.key,
					col
				};
			}
			function onCellDouble(e) {
				if (!e.target.closest("button, a")) edit();
			}
			function onFocus() {
				if (!active.value && lines.value.length) activate(0, TITLE, false);
			}
			function onKey(e) {
				if (e.isComposing || !ownKey(e)) return;
				const mod = e.ctrlKey || e.metaKey;
				const line = activeLine.value;
				const onHead = active.value?.key === HEAD;
				const index = currentIndex();
				const col = activeCol.value;
				const done = () => {
					e.preventDefault();
					e.stopPropagation();
				};
				const move = (to, column) => {
					done();
					const from = active.value?.key;
					activate(to, column ?? col.id);
					if (e.shiftKey && from && from !== HEAD && active.value && active.value.key !== HEAD) {
						if (!anchor || !lineIndex.value.has(anchor)) setAnchor(from, /* @__PURE__ */ new Set());
						selectTo(active.value.key);
					} else if (active.value) setAnchor(active.value.key, /* @__PURE__ */ new Set());
				};
				const page = Math.max(1, Math.floor(bodyHeight.value / 32) - 1);
				if (e.altKey) {
					if (e.shiftKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
						done();
						nudge(e.key === "ArrowUp" ? -1 : 1);
					} else if (onHead && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !mod && !props.readonly) {
						done();
						const by = e.key === "ArrowLeft" ? -1 : 1;
						if (e.shiftKey) shiftColumn(col.id, by);
						else setWidth(col.id, col.width + by * 16);
					}
					return;
				}
				switch (e.key) {
					case "ArrowUp": return mod ? move(0) : move(index - 1);
					case "ArrowDown": return mod ? move(lines.value.length - 1) : move(index + 1);
					case "PageUp": return move(Math.max(0, index - page));
					case "PageDown": return move(index + page);
					case "ArrowLeft":
					case "ArrowRight": {
						if (mod) return;
						const by = e.key === "ArrowLeft" ? -1 : 1;
						if (line?.kind === "group") {
							done();
							if (line.group.collapsed === by > 0) toggleGroup(line.group);
							return;
						}
						const next = cols.value[(colIndex.value.get(col.id) ?? 0) + by];
						return next ? move(index, next.id) : done();
					}
					case "Home": return mod ? move(0, TITLE) : move(index, TITLE);
					case "End": return mod ? move(lines.value.length - 1, cols.value.at(-1).id) : move(index, cols.value.at(-1).id);
					case "Enter":
					case "F2":
						if (e.key === "Enter" && mod) {
							if (line?.kind !== "item") return;
							done();
							return emit("open", line.item.id);
						}
						done();
						if (onHead) {
							const el = elementOf();
							if (el) headerMenu(col, el);
						} else if (line?.kind === "group") toggleGroup(line.group);
						else if (line?.kind === "add") addItem(line.group);
						else edit();
						return;
					case " ":
						if (mod) return;
						done();
						if (line?.kind === "group") toggleGroup(line.group);
						else if (line?.kind === "add") addItem(line.group);
						else if (line?.kind === "item") {
							if (e.shiftKey) toggleSelected(line);
							else if (col.field?.type === "checkbox") toggleCheckbox(line.item, col.field);
							else edit();
						}
						return;
					case "Escape":
						if (!selection.value.size) return;
						done();
						return clearSelection();
					case "Delete":
					case "Backspace":
						done();
						return selection.value.size ? deleteSelected() : clearCells();
					case "ContextMenu":
					case "F10": {
						if (e.key === "F10" && !e.shiftKey) return;
						done();
						const el = elementOf();
						if (!el) return;
						if (onHead) headerMenu(col, el);
						else if (line?.kind === "item") openMenu(line.item, el);
						return;
					}
				}
				if (mod) {
					if (e.key.toLowerCase() === "a" && !e.shiftKey) {
						done();
						selection.value = new Set(props.result.items.map((i) => i.id));
					} else if (e.key.toLowerCase() === "d" && !e.shiftKey && selection.value.size && !props.readonly) {
						done();
						duplicateSelected();
					}
					return;
				}
				if (e.key.length === 1 && line?.kind === "item") {
					done();
					if (col.field?.type !== "checkbox") edit(e.key);
				}
			}
			const number = new Intl.NumberFormat(void 0, { maximumFractionDigits: 6 });
			const footer = (0, vue.computed)(() => new Map(cols.value.map((c) => {
				const { items, total } = props.result;
				if (!c.field) return [c.id, items.length === total ? strings.count(total) : strings.countOf(items.length, total)];
				const p = c.field;
				if (p.type === "number") {
					const values = items.map((i) => valueOf(i, p)).filter((v) => typeof v === "number");
					return [c.id, values.length ? strings.sum(number.format(values.reduce((a, b) => a + b, 0))) : ""];
				}
				if (p.type === "checkbox" && items.length) return [c.id, strings.checkedOf(items.filter((i) => valueOf(i, p) === true).length, items.length)];
				return [c.id, ""];
			})));
			const groupPreview = (g) => g.name ? {
				name: g.name,
				color: g.color
			} : null;
			const isEmpty = (0, vue.computed)(() => !props.result.items.length && !props.result.groupBy);
			__expose({
				newItem,
				focus
			});
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1$1, [
					(0, vue.createElementVNode)("div", {
						ref_key: "grid",
						ref: grid,
						class: (0, vue.normalizeClass)(["pl-grid", { "is-dragging": rowDrag.value || colDrag.value }]),
						role: "grid",
						tabindex: "0",
						"aria-label": (0, vue.unref)(strings).grid(__props.collection.name),
						"aria-rowcount": lines.value.length + 2,
						"aria-colcount": cols.value.length + 1,
						"aria-activedescendant": activeId.value,
						"aria-readonly": __props.readonly || void 0,
						"aria-multiselectable": "true",
						onScrollPassive: _cache[3] || (_cache[3] = ($event) => scrollTop.value = $event.target.scrollTop),
						onKeydown: onKey,
						onFocus,
						onMousedown: onMouseDown,
						onCopy,
						onPaste
					}, [(0, vue.createElementVNode)("div", {
						class: "pl-grid__inner",
						style: (0, vue.normalizeStyle)({ minWidth: `${rowWidth.value}px` }),
						role: "presentation"
					}, [
						(0, vue.createElementVNode)("div", _hoisted_3$1, [
							(0, vue.createElementVNode)("div", {
								class: (0, vue.normalizeClass)(["pl-gutter", { "is-on": selection.value.size }]),
								role: "columnheader",
								"aria-colindex": "1",
								"aria-label": (0, vue.unref)(strings).selectAll
							}, [__props.result.items.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
								key: 0,
								type: "button",
								class: "pl-check",
								role: "checkbox",
								tabindex: "-1",
								"aria-checked": allSelected.value ? "true" : selection.value.size ? "mixed" : "false",
								"aria-label": (0, vue.unref)(strings).selectAll,
								onClick: selectAll
							}, [(0, vue.createElementVNode)("span", { class: (0, vue.normalizeClass)(["pl-box", { "is-on": selection.value.size }]) }, [allSelected.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
								key: 0,
								name: "check"
							})) : selection.value.size ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
								key: 1,
								name: "minus"
							})) : (0, vue.createCommentVNode)("v-if", true)], 2)], 8, _hoisted_5$1)) : (0, vue.createCommentVNode)("v-if", true)], 10, _hoisted_4$1),
							((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(cols.value, (c, i) => {
								return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
									id: cellId(HEAD, c.id),
									key: c.id,
									class: (0, vue.normalizeClass)(["pl-th", {
										"is-title": !c.field,
										"is-active": isActive(HEAD, c.id),
										"is-moving": colDrag.value?.id === c.id,
										"is-numeric": c.field?.type === "number"
									}]),
									style: (0, vue.normalizeStyle)({ width: `${c.width}px` }),
									role: "columnheader",
									"aria-colindex": i + 2,
									"aria-sort": sortOf(c.id) ? sortOf(c.id) === "asc" ? "ascending" : "descending" : void 0,
									"aria-haspopup": "menu",
									title: c.name,
									onPointerdown: ($event) => dragColumn($event, c),
									onClick: ($event) => headerMenu(c, $event.currentTarget),
									onContextmenu: (0, vue.withModifiers)(($event) => headerMenu(c, {
										x: $event.clientX,
										y: $event.clientY
									}), ["prevent"])
								}, [
									(0, vue.createVNode)(PropertyIcon_default, {
										type: c.field?.type ?? "text",
										class: "pl-th__icon"
									}, null, 8, ["type"]),
									(0, vue.createElementVNode)("span", _hoisted_7$1, (0, vue.toDisplayString)(c.name), 1),
									sortOf(c.id) ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
										key: 0,
										class: "pl-th__sort",
										name: sortOf(c.id) === "asc" ? "arrow-up" : "arrow-down"
									}, null, 8, ["name"])) : (0, vue.createCommentVNode)("v-if", true),
									!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
										key: 1,
										class: (0, vue.normalizeClass)(["pl-th__resize", { "is-on": c.id in draftWidths.value }]),
										"aria-hidden": "true",
										onPointerdown: (0, vue.withModifiers)(($event) => resize($event, c), ["stop", "prevent"]),
										onClick: _cache[0] || (_cache[0] = (0, vue.withModifiers)(() => {}, ["stop"])),
										onDblclick: (0, vue.withModifiers)(($event) => setWidth(c.id, null), ["stop"])
									}, null, 42, _hoisted_8$1)) : (0, vue.createCommentVNode)("v-if", true)
								], 46, _hoisted_6$1);
							}), 128)),
							!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
								key: 0,
								type: "button",
								class: (0, vue.normalizeClass)(["pl-th-add", { "is-open": popover.value?.kind === "add" }]),
								"aria-label": (0, vue.unref)(strings).addProperty,
								title: (0, vue.unref)(strings).addProperty,
								"aria-haspopup": "dialog",
								onClick: _cache[1] || (_cache[1] = ($event) => popover.value = {
									kind: "add",
									anchor: $event.currentTarget
								})
							}, [(0, vue.createVNode)(Icon_default, { name: "plus" })], 10, _hoisted_9$1)) : (0, vue.createCommentVNode)("v-if", true)
						]),
						(0, vue.createElementVNode)("div", {
							class: "pl-body",
							role: "rowgroup",
							style: (0, vue.normalizeStyle)({ height: `${lines.value.length * (0, vue.unref)(32) + (selection.value.size ? 52 : 0)}px` })
						}, [((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(shown.value, ({ line, index }) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: line.key }, [line.kind === "item" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
								key: 0,
								class: (0, vue.normalizeClass)(["pl-tr", {
									"is-selected": selection.value.has(line.item.id),
									"is-open": __props.openItemId === line.item.id,
									"is-moving": rowDrag.value?.ids.has(line.item.id),
									"is-editing": editing.value?.key === line.key
								}]),
								style: (0, vue.normalizeStyle)({ top: `${index * (0, vue.unref)(32)}px` }),
								role: "row",
								"aria-rowindex": index + 2,
								"aria-selected": selection.value.has(line.item.id),
								onContextmenu: (0, vue.withModifiers)(($event) => rowMenu($event, line, $event.target.closest("[data-col]")?.dataset.col), ["prevent"])
							}, [(0, vue.createElementVNode)("div", {
								class: (0, vue.normalizeClass)(["pl-gutter", { "is-on": selection.value.size }]),
								role: "gridcell",
								"aria-colindex": "1"
							}, [canDrag.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", {
								key: 0,
								class: "pl-handle",
								title: (0, vue.unref)(strings).reorder,
								"aria-hidden": "true",
								onPointerdown: (0, vue.withModifiers)(($event) => dragRow($event, line), ["prevent"])
							}, [(0, vue.createVNode)(Icon_default, { name: "grip-vertical" })], 40, _hoisted_11)) : (0, vue.createCommentVNode)("v-if", true), (0, vue.createElementVNode)("button", {
								type: "button",
								class: "pl-check",
								role: "checkbox",
								tabindex: "-1",
								"aria-checked": selection.value.has(line.item.id),
								"aria-label": (0, vue.unref)(strings).selectRow(line.item.title),
								onClick: ($event) => toggleSelected(line, $event.shiftKey)
							}, [(0, vue.createElementVNode)("span", { class: (0, vue.normalizeClass)(["pl-box", { "is-on": selection.value.has(line.item.id) }]) }, [selection.value.has(line.item.id) ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
								key: 0,
								name: "check"
							})) : (0, vue.createCommentVNode)("v-if", true)], 2)], 8, _hoisted_12)], 2), ((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(cols.value, (c, i) => {
								return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
									id: cellId(line.key, c.id),
									key: c.id,
									class: (0, vue.normalizeClass)(["pl-td", {
										"is-title": !c.field,
										"is-active": isActive(line.key, c.id),
										"is-numeric": c.field?.type === "number",
										"is-editing": isEditing(line.key, c.id)
									}]),
									style: (0, vue.normalizeStyle)({ width: `${c.width}px` }),
									role: "gridcell",
									"aria-colindex": i + 2,
									"aria-readonly": !canEdit(c.field) || void 0,
									"data-col": c.id,
									onMousedown: ($event) => onCellDown($event, line, c.id),
									onDblclick: onCellDouble
								}, [isEditing(line.key, c.id) ? ((0, vue.openBlock)(), (0, vue.createBlock)(CellInput_default, {
									key: cellId(line.key, c.id),
									text: editing.value.text,
									"select-all": editing.value.selectAll,
									multiline: c.field?.type === "text",
									numeric: c.field?.type === "number",
									label: (0, vue.unref)(strings).edit(c.name),
									onCommit: commitEdit,
									onCancel: cancelEdit
								}, null, 8, [
									"text",
									"select-all",
									"multiline",
									"numeric",
									"label"
								])) : !c.field ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [
									line.item.icon ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
										key: 0,
										name: line.item.icon,
										class: "pl-title__icon"
									}, null, 8, ["name"])) : (0, vue.createCommentVNode)("v-if", true),
									(0, vue.createElementVNode)("span", {
										class: (0, vue.normalizeClass)(["pl-title__text", { "is-untitled": !line.item.title }]),
										title: line.item.title || void 0
									}, (0, vue.toDisplayString)(line.item.title || (0, vue.unref)(strings).untitled), 11, _hoisted_14),
									line.item.chats.length ? ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(ThreadDot)), {
										key: 1,
										"thread-id": line.item.chats.at(-1),
										size: 11,
										class: "pl-title__dot"
									}, null, 8, ["thread-id"])) : (0, vue.createCommentVNode)("v-if", true),
									(0, vue.createElementVNode)("button", {
										type: "button",
										class: "pl-open",
										tabindex: "-1",
										"aria-label": (0, vue.unref)(strings).openItem(line.item.title),
										title: `${(0, vue.unref)(strings).open} (${(0, vue.unref)(mango).platform === "macos" ? "⌘" : "Ctrl+"}Enter)`,
										onMousedown: _cache[2] || (_cache[2] = (0, vue.withModifiers)(() => {}, ["stop", "prevent"])),
										onClick: (0, vue.withModifiers)(($event) => emit("open", line.item.id), ["stop"])
									}, [(0, vue.createVNode)(Icon_default, { name: "panel-right-open" }), (0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings).open), 1)], 40, _hoisted_15)
								], 64)) : c.field.type === "checkbox" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
									key: 2,
									type: "button",
									class: "pl-check is-value",
									role: "checkbox",
									tabindex: "-1",
									disabled: __props.readonly,
									"aria-checked": (0, vue.unref)(valueOf)(line.item, c.field) === true,
									"aria-label": c.name,
									onClick: ($event) => toggleCheckbox(line.item, c.field)
								}, [(0, vue.createElementVNode)("span", { class: (0, vue.normalizeClass)(["pl-box", { "is-on": (0, vue.unref)(valueOf)(line.item, c.field) === true }]) }, [(0, vue.unref)(valueOf)(line.item, c.field) === true ? ((0, vue.openBlock)(), (0, vue.createBlock)(Icon_default, {
									key: 0,
									name: "check"
								})) : (0, vue.createCommentVNode)("v-if", true)], 2)], 8, _hoisted_16)) : c.field.type === "unsupported" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_17, (0, vue.toDisplayString)((0, vue.unref)(valueText)((0, vue.unref)(valueOf)(line.item, c.field), c.field)), 1)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_18, [(0, vue.createVNode)(ValueView_default, {
									property: c.field,
									item: line.item
								}, null, 8, ["property", "item"])]))], 46, _hoisted_13);
							}), 128))], 46, _hoisted_10$1)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
								key: 1,
								class: (0, vue.normalizeClass)(["pl-tr", line.kind === "group" ? "pl-tr--group" : "pl-tr--add"]),
								style: (0, vue.normalizeStyle)({ top: `${index * (0, vue.unref)(32)}px` }),
								role: "row",
								"aria-rowindex": index + 2
							}, [(0, vue.createElementVNode)("div", {
								id: cellId(line.key, "line"),
								class: (0, vue.normalizeClass)(["pl-line", { "is-active": active.value?.key === line.key }]),
								role: "gridcell",
								"aria-colindex": "1",
								"aria-colspan": cols.value.length + 1,
								"aria-expanded": line.kind === "group" ? !line.group.collapsed : void 0,
								onMousedown: ($event) => active.value = {
									key: line.key,
									col: activeCol.value.id
								},
								onClick: ($event) => line.kind === "group" ? toggleGroup(line.group) : addItem(line.group)
							}, [line.kind === "group" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 0 }, [
								(0, vue.createVNode)(Icon_default, {
									name: "chevron-right",
									class: (0, vue.normalizeClass)(["pl-line__chevron", { "is-open": !line.group.collapsed }])
								}, null, 8, ["class"]),
								groupPreview(line.group) ? ((0, vue.openBlock)(), (0, vue.createBlock)(OptionTag_default, {
									key: 0,
									option: groupPreview(line.group)
								}, null, 8, ["option"])) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_21, (0, vue.toDisplayString)(groupName(line.group)), 1)),
								(0, vue.createElementVNode)("span", _hoisted_22, (0, vue.toDisplayString)(line.group.items.length), 1),
								!__props.readonly ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("button", {
									key: 2,
									type: "button",
									class: "pl-line__add",
									tabindex: "-1",
									"aria-label": (0, vue.unref)(strings).newItemIn(groupName(line.group)),
									title: (0, vue.unref)(strings).newItemIn(groupName(line.group)),
									onClick: (0, vue.withModifiers)(($event) => addItem(line.group, true), ["stop"])
								}, [(0, vue.createVNode)(Icon_default, { name: "plus" })], 8, _hoisted_23)) : (0, vue.createCommentVNode)("v-if", true)
							], 64)) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 1 }, [
								(0, vue.createVNode)(Icon_default, {
									name: "plus",
									class: "pl-line__plus"
								}),
								(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)((0, vue.unref)(strings).newItem), 1),
								isEmpty.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("span", _hoisted_24, (0, vue.toDisplayString)(__props.result.total ? (0, vue.unref)(strings).noMatches : (0, vue.unref)(strings).empty), 1)) : (0, vue.createCommentVNode)("v-if", true)
							], 64))], 42, _hoisted_20)], 14, _hoisted_19))], 64);
						}), 128)), rowDrag.value?.drop ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: 0,
							class: "pl-dropline",
							style: (0, vue.normalizeStyle)({ top: `${rowDrag.value.drop.boundary * (0, vue.unref)(32) - 1}px` }),
							"aria-hidden": "true"
						}, null, 4)) : (0, vue.createCommentVNode)("v-if", true)], 4),
						__props.readonly && !__props.result.items.length ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_25, (0, vue.toDisplayString)(__props.result.total ? (0, vue.unref)(strings).noMatches : (0, vue.unref)(strings).empty), 1)) : (0, vue.createCommentVNode)("v-if", true),
						(0, vue.createElementVNode)("div", {
							class: "pl-tr pl-tr--foot",
							role: "row",
							"aria-rowindex": lines.value.length + 2
						}, [_cache[4] || (_cache[4] = (0, vue.createElementVNode)("div", {
							class: "pl-gutter",
							role: "gridcell",
							"aria-colindex": "1"
						}, null, -1)), ((0, vue.openBlock)(true), (0, vue.createElementBlock)(vue.Fragment, null, (0, vue.renderList)(cols.value, (c, i) => {
							return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
								key: c.id,
								class: (0, vue.normalizeClass)(["pl-tf", {
									"is-title": !c.field,
									"is-numeric": c.field?.type === "number"
								}]),
								style: (0, vue.normalizeStyle)({ width: `${c.width}px` }),
								role: "gridcell",
								"aria-colindex": i + 2,
								title: footer.value.get(c.id) || void 0
							}, (0, vue.toDisplayString)(footer.value.get(c.id)), 15, _hoisted_27);
						}), 128))], 8, _hoisted_26),
						colDrag.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
							key: 1,
							class: "pl-colline",
							style: (0, vue.normalizeStyle)({ left: `${colDrag.value.x - 1}px` }),
							"aria-hidden": "true"
						}, null, 4)) : (0, vue.createCommentVNode)("v-if", true)
					], 4)], 42, _hoisted_2$1),
					selection.value.size && !__props.readonly ? ((0, vue.openBlock)(), (0, vue.createBlock)(BulkBar_default, {
						key: 0,
						collection: __props.collection,
						count: selection.value.size,
						onSet: setForSelected,
						onDuplicate: duplicateSelected,
						onDelete: deleteSelected,
						onClear: clearSelection
					}, null, 8, ["collection", "count"])) : (0, vue.createCommentVNode)("v-if", true),
					popover.value?.kind === "value" && liveProperty.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(ValuePopover_default, {
						key: 1,
						"collection-id": __props.collection.id,
						property: liveProperty.value,
						"item-ids": popover.value.itemIds,
						anchor: popover.value.anchor,
						onClose: closePopover
					}, null, 8, [
						"collection-id",
						"property",
						"item-ids",
						"anchor"
					])) : (0, vue.createCommentVNode)("v-if", true),
					popover.value?.kind === "add" ? ((0, vue.openBlock)(), (0, vue.createBlock)(AddProperty_default, {
						key: 2,
						"collection-id": __props.collection.id,
						anchor: popover.value.anchor,
						onClose: closePopover,
						onAdded: addedProperty
					}, null, 8, ["collection-id", "anchor"])) : (0, vue.createCommentVNode)("v-if", true)
				]);
			};
		}
	}), [["__scopeId", "data-v-3583e578"]]);
	// plugins/planner/src/App.vue?vue&type=script&setup=true&lang.ts
	var _hoisted_1 = {
		key: 0,
		class: "pl-fail",
		role: "alert"
	};
	var _hoisted_2 = { class: "pl-fail__title" };
	var _hoisted_3 = {
		key: 0,
		class: "pl-fail__body selectable"
	};
	var _hoisted_4 = {
		key: 0,
		class: "pl-note",
		role: "status"
	};
	var _hoisted_5 = {
		key: 2,
		class: "pl-fail",
		role: "alert"
	};
	var _hoisted_6 = { class: "pl-fail__title" };
	var _hoisted_7 = {
		key: 0,
		class: "pl-fail__body selectable"
	};
	var _hoisted_8 = {
		key: 4,
		class: "pl-body"
	};
	var _hoisted_9 = ["inert"];
	var _hoisted_10 = {
		key: 0,
		class: "pl-note",
		role: "status"
	};
	/** The planner's tab: a header, the filters in use, the view, and the item that is open. */
	var MODE_KEY = "itemMode";
	// plugins/planner/src/App.vue
	var App_default = /*#__PURE__*/ _plugin_vue_export_helper_default(/* @__PURE__ */ (0, vue.defineComponent)({
		__name: "App",
		props: {
			mango: {},
			store: {},
			ctx: {}
		},
		setup(__props) {
			const props = __props;
			const { status, error, collections, collection: collectionOf, sourceStatus, saving } = props.store;
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
			const planner = {
				mango: props.mango,
				store: props.store,
				route,
				go
			};
			(0, vue.provide)(PLANNER, planner);
			const collection = (0, vue.computed)(() => collectionOf(route.value.collectionId));
			const view = (0, vue.computed)(() => {
				const c = collection.value;
				return c && (viewOf(c, route.value.viewId) ?? viewOf(c, props.store.lastView(c.id)) ?? c.views[0] ?? null);
			});
			const list = (0, vue.computed)(() => collection.value ? props.store.items(collection.value.id) : null);
			const readonly = (0, vue.computed)(() => sourceStatus.value.readonly);
			(0, vue.watchEffect)(() => {
				const id = route.value.collectionId;
				if (id && props.store.lastCollection() !== id) props.store.rememberCollection(id);
			});
			function show(c) {
				go({ collectionId: c.id });
				(0, vue.nextTick)(focusView);
			}
			function showView(viewId) {
				const c = collection.value;
				if (!c) return;
				props.store.rememberView(c.id, viewId);
				go({
					viewId,
					...covered.value ? { itemId: void 0 } : {}
				});
			}
			async function newCollection() {
				const made = await askNewCollection(planner);
				if (made) show(made);
			}
			const search = (0, vue.ref)("");
			const applied = (0, vue.ref)("");
			let searchTimer;
			(0, vue.watch)(search, (text) => {
				clearTimeout(searchTimer);
				if (!text) applied.value = "";
				else searchTimer = setTimeout(() => {
					applied.value = text;
				}, 80);
			});
			(0, vue.watch)(() => route.value.collectionId, () => {
				search.value = "";
			});
			const DAYS = /* @__PURE__ */ new Set([
				"today",
				"overdue",
				"nextDays",
				"pastDays"
			]);
			const result = (0, vue.computed)(() => {
				const c = collection.value;
				const v = view.value;
				if (!c || !v || !list.value) return null;
				const now = v.filter.conditions.some((x) => DAYS.has(x.operator)) ? props.store.now.value : void 0;
				return runQuery(c, list.value.items, v, {
					search: applied.value,
					now
				});
			});
			const filtering = (0, vue.computed)(() => !!view.value?.filter.conditions.some(isActive));
			const hasBar = (0, vue.computed)(() => !!view.value && view.value.filter.conditions.length + view.value.sorts.length > 0);
			const noMatches = (0, vue.computed)(() => !!result.value && result.value.total > 0 && !result.value.items.length && (filtering.value || applied.value.trim() !== ""));
			function clearAll() {
				search.value = "";
				if (filtering.value && collection.value && view.value) props.store.updateView(collection.value.id, view.value.id, { filter: {
					match: view.value.filter.match,
					conditions: []
				} });
			}
			const mode = (0, vue.ref)(props.mango.storage.get(MODE_KEY) === "full" ? "full" : "side");
			const item = (0, vue.computed)(() => {
				const id = route.value.itemId;
				return id && collection.value && list.value?.items.some((i) => i.id === id) ? id : null;
			});
			const full = (0, vue.computed)(() => item.value !== null && mode.value === "full");
			function toggleMode() {
				mode.value = mode.value === "side" ? "full" : "side";
				props.mango.storage.set(MODE_KEY, mode.value);
			}
			function closeItem() {
				go({ itemId: void 0 });
				(0, vue.nextTick)(focusView);
			}
			const root = (0, vue.ref)(null);
			const head = (0, vue.ref)(null);
			const bar = (0, vue.ref)(null);
			const viewRef = (0, vue.ref)(null);
			const width = (0, vue.ref)(1e3);
			const sideOver = (0, vue.computed)(() => width.value < 760);
			/** The item is all there is to see. */
			const covered = (0, vue.computed)(() => full.value || item.value !== null && width.value < 560);
			function focusView() {
				viewRef.value?.focus();
			}
			async function newItem() {
				if (readonly.value || list.value?.status !== "ready") return;
				if (covered.value || item.value && sideOver.value) go({ itemId: void 0 });
				search.value = "";
				await (0, vue.nextTick)();
				viewRef.value?.newItem();
			}
			async function editFilter(id) {
				await (0, vue.nextTick)();
				bar.value?.edit(id);
			}
			/** Not for a moment's write: only when it takes long. */
			const slow = (0, vue.ref)(false);
			let slowTimer;
			(0, vue.watch)(saving, (on) => {
				clearTimeout(slowTimer);
				if (on) slowTimer = setTimeout(() => {
					slow.value = true;
				}, 900);
				else slow.value = false;
			});
			const banner = (0, vue.computed)(() => {
				const s = sourceStatus.value;
				if (!s.online) return {
					icon: "cloud-off",
					title: shell.offline,
					body: s.message || shell.offlineBody
				};
				if (s.readonly) return {
					icon: "lock",
					title: shell.readonly,
					body: s.message || shell.readonlyBody
				};
				return null;
			});
			function onKey(e) {
				if (e.defaultPrevented || !isMod(props.mango, e) || e.altKey || anyLayerOpen()) return;
				const target = e.target;
				const inside = !!root.value?.contains(target);
				const bare = target === document.body && props.mango.ui.tabs.active()?.viewId === "planner";
				if (!inside && !bare) return;
				const key = e.key.toLowerCase();
				if (key === "f" && !e.shiftKey) {
					if (!collection.value || covered.value) return;
					head.value?.openSearch();
				} else if (key === "z" || key === "y" && !e.shiftKey) {
					if (inTextField(target)) return;
					if (key === "y" || e.shiftKey) props.store.redo();
					else props.store.undo();
				} else if (key === "enter" && e.shiftKey) newItem();
				else return;
				e.preventDefault();
				e.stopPropagation();
			}
			let sizes = null;
			(0, vue.onMounted)(() => {
				window.addEventListener("keydown", onKey);
				sizes = new ResizeObserver(() => {
					width.value = root.value?.clientWidth ?? width.value;
				});
				if (root.value) {
					width.value = root.value.clientWidth;
					sizes.observe(root.value);
				}
			});
			(0, vue.onBeforeUnmount)(() => {
				window.removeEventListener("keydown", onKey);
				sizes?.disconnect();
				clearTimeout(searchTimer);
				clearTimeout(slowTimer);
			});
			return (_ctx, _cache) => {
				return (0, vue.openBlock)(), (0, vue.createElementBlock)("div", {
					ref_key: "root",
					ref: root,
					class: "pl-app",
					"data-own-find": "",
					tabindex: "-1"
				}, [(0, vue.unref)(status) === "error" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_1, [
					(0, vue.createElementVNode)("p", _hoisted_2, (0, vue.toDisplayString)((0, vue.unref)(strings$5).loadFailed), 1),
					(0, vue.unref)(error) ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_3, (0, vue.toDisplayString)((0, vue.unref)(error)), 1)) : (0, vue.createCommentVNode)("v-if", true),
					((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
						size: "sm",
						onClick: _cache[0] || (_cache[0] = ($event) => __props.store.load())
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$5).retry), 1)]),
						_: 1
					}))
				])) : (0, vue.unref)(status) !== "ready" && !collection.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(PlannerSkeleton_default, {
					key: 1,
					head: ""
				})) : !collection.value || !view.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(StartScreen_default, {
					key: 2,
					onMade: show
				})) : ((0, vue.openBlock)(), (0, vue.createElementBlock)(vue.Fragment, { key: 3 }, [
					(0, vue.createVNode)(PlannerHeader_default, {
						ref_key: "head",
						ref: head,
						search: search.value,
						"onUpdate:search": _cache[1] || (_cache[1] = ($event) => search.value = $event),
						collection: collection.value,
						view: view.value,
						readonly: readonly.value,
						saving: slow.value,
						count: list.value?.status === "ready" ? list.value.items.length : null,
						width: width.value,
						covered: covered.value,
						onCollection: show,
						onView: showView,
						onNewCollection: newCollection,
						onNewItem: newItem,
						onFiltered: editFilter,
						onToView: focusView
					}, null, 8, [
						"search",
						"collection",
						"view",
						"readonly",
						"saving",
						"count",
						"width",
						"covered"
					]),
					banner.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_4, [
						(0, vue.createVNode)(Icon_default, { name: banner.value.icon }, null, 8, ["name"]),
						(0, vue.createElementVNode)("strong", null, (0, vue.toDisplayString)(banner.value.title), 1),
						(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)(banner.value.body), 1)
					])) : (0, vue.createCommentVNode)("v-if", true),
					hasBar.value && !covered.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(FilterBar_default, {
						key: 1,
						ref_key: "bar",
						ref: bar,
						collection: collection.value,
						view: view.value,
						readonly: readonly.value,
						onAdd: _cache[2] || (_cache[2] = (el) => head.value?.openFilter(el))
					}, null, 8, [
						"collection",
						"view",
						"readonly"
					])) : (0, vue.createCommentVNode)("v-if", true),
					list.value?.status === "error" ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_5, [
						(0, vue.createElementVNode)("p", _hoisted_6, (0, vue.toDisplayString)((0, vue.unref)(shell).itemsFailed), 1),
						list.value.error ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("p", _hoisted_7, (0, vue.toDisplayString)(list.value.error), 1)) : (0, vue.createCommentVNode)("v-if", true),
						((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)((0, vue.unref)(Button)), {
							size: "sm",
							onClick: _cache[3] || (_cache[3] = ($event) => __props.store.loadItems(collection.value.id))
						}, {
							default: (0, vue.withCtx)(() => [(0, vue.createTextVNode)((0, vue.toDisplayString)((0, vue.unref)(strings$5).retry), 1)]),
							_: 1
						}))
					])) : list.value?.status !== "ready" || !result.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(PlannerSkeleton_default, { key: 3 })) : ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_8, [(0, vue.withDirectives)((0, vue.createElementVNode)("div", {
						class: "pl-view",
						inert: full.value
					}, [noMatches.value ? ((0, vue.openBlock)(), (0, vue.createElementBlock)("div", _hoisted_10, [
						(0, vue.createVNode)(Icon_default, { name: "search-x" }),
						(0, vue.createElementVNode)("span", null, (0, vue.toDisplayString)(applied.value.trim() ? (0, vue.unref)(shell).noMatchesSearch(applied.value.trim(), (0, vue.unref)(itemWord)(collection.value, 2)) : (0, vue.unref)(shell).noMatches((0, vue.unref)(itemWord)(collection.value, 2))), 1),
						(0, vue.createElementVNode)("button", {
							type: "button",
							class: "pl-small pl-note__act",
							onClick: clearAll
						}, (0, vue.toDisplayString)(applied.value.trim() && filtering.value ? (0, vue.unref)(shell).clearAll : filtering.value ? (0, vue.unref)(shell).clearFilters : (0, vue.unref)(shell).clearSearch), 1)
					])) : (0, vue.createCommentVNode)("v-if", true), ((0, vue.openBlock)(), (0, vue.createBlock)((0, vue.resolveDynamicComponent)(view.value.type === "board" ? BoardView_default : TableView_default), {
						key: `${collection.value.id}/${view.value.id}/${view.value.type}`,
						ref_key: "viewRef",
						ref: viewRef,
						class: "pl-view__in",
						collection: collection.value,
						view: view.value,
						result: result.value,
						search: applied.value,
						readonly: readonly.value,
						"open-item-id": item.value,
						onOpen: _cache[4] || (_cache[4] = (id) => go({ itemId: id }))
					}, null, 40, [
						"collection",
						"view",
						"result",
						"search",
						"readonly",
						"open-item-id"
					]))], 8, _hoisted_9), [[vue.vShow, !full.value]]), item.value && full.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(ItemPage_default, {
						key: 0,
						collection: collection.value,
						"item-id": item.value,
						mode: "full",
						class: "pl-full",
						onClose: closeItem,
						onToggleMode: toggleMode
					}, null, 8, ["collection", "item-id"])) : item.value ? ((0, vue.openBlock)(), (0, vue.createBlock)(ItemPane_default, {
						key: 1,
						available: width.value,
						overlay: sideOver.value
					}, {
						default: (0, vue.withCtx)(() => [(0, vue.createVNode)(ItemPage_default, {
							collection: collection.value,
							"item-id": item.value,
							mode: "side",
							class: "pl-full",
							onClose: closeItem,
							onToggleMode: toggleMode
						}, null, 8, ["collection", "item-id"])]),
						_: 1
					}, 8, ["available", "overlay"])) : (0, vue.createCommentVNode)("v-if", true)]))
				], 64))], 512);
			};
		}
	}), [["__scopeId", "data-v-7a7a37b1"]]);
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
			toast(strings$5.loadFailed, stateOf(collectionId).error ?? "");
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
				toast(strings$5.readonly, sourceStatus.value.message);
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
				if (docs.some((d) => d.data === null && patched.has(keyOf(d)) && !removed.has(keyOf(d)))) toast(strings$5.saveFailed, strings$5.gone);
			} catch (e) {
				mango.log.error("Saving:", e);
				if (m.deferred && !disposed) {
					unsaved.push(m);
					return toast(strings$5.saveFailed, messageOf(e), {
						label: strings$5.retry,
						run: settleDeferred
					});
				}
				hide(m);
				if (m.undoEntry) {
					undoStack.value = undoStack.value.filter((u) => u !== m.undoEntry);
					redoStack.value = redoStack.value.filter((u) => u !== m.undoEntry);
				}
				toast(strings$5.saveFailed, messageOf(e));
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
			if (sourceStatus.value.readonly) return toast(strings$5.readonly, sourceStatus.value.message);
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
					label: strings$5.undo,
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
					name: input.name?.trim() || strings$5.templates[template].name,
					icon: input.icon ?? data.icon,
					color: input.color ?? data.color,
					scope: json(scope),
					order: place.get(id),
					createdAt: Date.now()
				}
			}, ...reorderOps(place, id)];
			startEmpty(id);
			return mutate(ops, strings$5.did.createCollection) ? collection(id) : null;
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
			patchCollection(id, fields(change), strings$5.did.editCollection, opts);
		}
		function moveCollection(id, position) {
			mutate(reorderOps(placeAt(allCollections.value, [id], position)), strings$5.did.editCollection);
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
						name: strings$5.copyOf(model.name),
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
			return mutate(ops, strings$5.did.duplicate) ? collection(copy) : null;
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
			}))], strings$5.did.deleteCollection)) return false;
			undoToast(strings$5.deletedCollection(model.name));
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
			const values = {
				...defaultValues(c, viewOf(c, input.viewId), input.group, at),
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
			}, ...itemOrderOps(collectionId, place, /* @__PURE__ */ new Set([id]))], strings$5.did.createItem) ? item(collectionId, id) : null;
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
			})), strings$5.did.editItem, opts);
		}
		function changeEach(collectionId, changes) {
			const c = collection(collectionId);
			if (!c) return;
			mutate([...changes].map(([id, change]) => ({
				...itemTarget(collectionId, id),
				op: "patch",
				patch: effective(rawItem(collectionId, id), itemPatch(c, change))
			})), strings$5.did.editItem);
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
			const from = move.group?.from;
			const patches = /* @__PURE__ */ new Map();
			for (const id of ids) {
				const change = groupable ? { values: { [groupable.id]: valueForGroup(groupable, move.group.key, byId.get(id), typeof from === "object" ? from.get(id) : from) } } : {};
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
			})), strings$5.did.moveItem);
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
					title: strings$5.copyOf(original.title),
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
			if (!mutate(ops, strings$5.did.duplicate)) return [];
			return copies.map((id) => item(collectionId, id)).filter((i) => i !== null);
		}
		function deleteItems(collectionId, itemIds) {
			const ids = [...new Set(itemIds)].filter((id) => rawItem(collectionId, id));
			if (!ids.length) return;
			if (mutate(ids.map((id) => ({
				...itemTarget(collectionId, id),
				op: "delete"
			})), strings$5.did.deleteItems(ids.length))) undoToast(strings$5.deletedItems(ids.length));
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
			}], strings$5.did.linkChat);
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
			return patchCollection(collectionId, patch, strings$5.did.editProperty) ? propertyOf(collection(collectionId), id) : null;
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
			}], strings$5.did.editProperty, opts);
		}
		function updateProperty(collectionId, propertyId, change, opts) {
			const c = collection(collectionId);
			if (!c || !propertyOf(c, propertyId)) return;
			const patch = fields(change).map((p) => ({
				...p,
				path: [
					"properties",
					propertyId,
					...p.path
				]
			}));
			patchCollection(collectionId, effective(rawCollection(collectionId), patch), strings$5.did.editProperty, opts);
		}
		function moveProperty(collectionId, propertyId, position) {
			const c = collection(collectionId);
			if (c && propertyOf(c, propertyId)) patchCollection(collectionId, orderPatch(["properties"], placeAt(c.properties, [propertyId], position)), strings$5.did.editProperty);
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
			})], strings$5.did.editProperty);
			if (ok && conversion.lost) undoToast(strings$5.valuesLost(conversion.lost));
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
			}))], strings$5.did.deleteProperty);
			if (ok) undoToast(strings$5.deletedProperty(property.name));
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
			}, ...orderPatch(base, place, id)], strings$5.did.editOption) ? propertyOf(collection(collectionId), propertyId)?.options.find((o) => o.id === id) ?? null : null;
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
			patchCollection(collectionId, patch, strings$5.did.editOption, opts);
		}
		function moveOption(collectionId, propertyId, optionId, position) {
			const property = propertyOf(collection(collectionId) ?? EMPTY, propertyId);
			if (!property?.options.some((o) => o.id === optionId)) return;
			patchCollection(collectionId, orderPatch([
				"properties",
				propertyId,
				"options"
			], placeAt(property.options, [optionId], position)), strings$5.did.editOption);
		}
		async function deleteOption(collectionId, propertyId, optionId, opts = {}) {
			const list = await withItems(collectionId);
			const c = collection(collectionId);
			const property = c && propertyOf(c, propertyId);
			const option = property?.options.find((o) => o.id === optionId);
			if (!list || !property || !option) return false;
			const moveTo = property.options.find((o) => o.id === opts.moveTo && o.id !== optionId)?.id ?? null;
			const drop = (v) => listOf(v).filter((e) => e !== optionId);
			/** Without it, or with the one that takes its place. */
			const swap = (v) => moveTo ? [...new Set(listOf(v).map((e) => e === optionId ? moveTo : e))] : drop(v);
			const patch = [
				{ path: [
					"properties",
					propertyId,
					"options",
					optionId
				] },
				...property.defaultOption === optionId ? [{
					path: [
						"properties",
						propertyId,
						"defaultOption"
					],
					value: moveTo
				}] : [],
				...viewPatches(collectionId, (v) => {
					const f = isObject(v.filter) ? v.filter : {};
					const conditions = listOf(f.conditions).flatMap((e) => {
						if (!isObject(e) || e.propertyId !== propertyId || !Array.isArray(e.value) || !e.value.includes(optionId)) return [e];
						const value = swap(e.value);
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
				})
			];
			const ok = mutate([{
				...collectionTarget(collectionId),
				op: "patch",
				patch
			}, ...list.flatMap((i) => {
				const v = i.values[propertyId];
				if (v === optionId) return [{
					...itemTarget(collectionId, i.id),
					op: "patch",
					patch: [moveTo ? {
						path: ["values", propertyId],
						value: moveTo
					} : { path: ["values", propertyId] }]
				}];
				if (!Array.isArray(v) || !v.includes(optionId)) return [];
				return [{
					...itemTarget(collectionId, i.id),
					op: "patch",
					patch: [{
						path: ["values", propertyId],
						value: swap(v)
					}]
				}];
			})], strings$5.did.deleteOption);
			if (ok) undoToast(strings$5.deletedOption(option.name));
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
			return patchCollection(collectionId, patch, strings$5.did.editView) ? viewOf(collection(collectionId), id) : null;
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
			patchCollection(collectionId, [...storeFallbackView(c), ...effective(rawCollection(collectionId), patch)], onlyLayout ? null : strings$5.did.editView, opts);
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
						name: strings$5.copyOf(view.name),
						order: place.get(id)
					}
				},
				...orderPatch(["views"], place, id)
			];
			return patchCollection(collectionId, patch, strings$5.did.duplicate) ? viewOf(collection(collectionId), id) : null;
		}
		function moveView(collectionId, viewId, position) {
			const c = collection(collectionId);
			if (c && viewOf(c, viewId)) patchCollection(collectionId, [...storeFallbackView(c), ...orderPatch(["views"], placeAt(c.views, [viewId], position))], strings$5.did.editView);
		}
		function deleteView(collectionId, viewId) {
			const c = collection(collectionId);
			const view = c && viewOf(c, viewId);
			if (!c || !view || c.views.length < 2) return false;
			const ok = patchCollection(collectionId, [{ path: ["views", viewId] }], strings$5.did.deleteView);
			if (ok) undoToast(strings$5.deletedView(view.name));
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
				toast(strings$5.importEmpty);
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
			}, ...ops], strings$5.did.import) ? plan.items.length : 0;
		}
		async function importCsvAsCollection(csv, name, scope) {
			const id = newId();
			const { plan, ops } = importOps(id, csv, [], []);
			if (!ops.length) {
				toast(strings$5.importEmpty);
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
						name: name.trim() || strings$5.newCollection,
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
			], strings$5.did.import) ? collection(id) : null;
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
			updateEach: changeEach,
			moveItems,
			duplicateItems,
			deleteItems,
			linkChat: (c, id, threadId) => setChat(c, id, threadId, true),
			unlinkChat: (c, id, threadId) => setChat(c, id, threadId, false),
			addProperty,
			renameProperty,
			updateProperty,
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
		/** Shows the planner's tab, where it was or at `route`. */
		function open(route) {
			if (!mango.workspace.activeProject()) return mango.ui.toast({
				title: strings$5.noProject,
				body: shell.noProjectBody
			});
			mango.ui.tabs.open(VIEW_ID, {
				title: strings$5.planner,
				key: TAB_KEY,
				state: route ? { ...route } : void 0
			});
		}
		function toggle() {
			if (isOpen()) mango.ui.tabs.close(VIEW_ID, TAB_KEY);
			else open();
		}
		/** For dialogs outside of the tab: going somewhere opens it there. */
		const planner = {
			mango,
			store,
			route: (0, vue.computed)(() => readRoute(mango.ui.tabs.active()?.state) ?? { collectionId: store.lastCollection() }),
			go: (route) => open({
				collectionId: route.collectionId ?? store.lastCollection(),
				...route
			})
		};
		/** The collections are there; says so when they could not be read. */
		async function loaded() {
			if (store.status.value !== "ready") await store.load();
			for (let i = 0; i < 100 && store.status.value === "loading"; i++) await new Promise((r) => setTimeout(r, 50));
			if (store.status.value === "ready") return true;
			mango.ui.toast({
				title: strings$5.loadFailed,
				body: store.error.value ?? "",
				kind: "error"
			});
			return false;
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
			title: strings$5.planner,
			icon: ICON,
			shortcut: "planner",
			active: isOpen,
			run: () => open()
		});
		mango.shortcuts.register({
			id: "planner",
			label: strings$5.commands.open,
			key: "Mod+Shift+D",
			run: toggle
		});
		mango.commands.register({
			id: "open",
			title: strings$5.commands.open,
			icon: ICON,
			keywords: "board kanban tasks notes table",
			run: () => open()
		});
		mango.commands.register({
			id: "new-item",
			title: strings$5.commands.newItem,
			icon: ICON,
			keywords: "planner task bug note add",
			run: async () => {
				if (!await loaded()) return;
				const shown = (isOpen() ? readRoute(mango.ui.tabs.active()?.state)?.collectionId : null) ?? store.lastCollection();
				const collection = store.collections.value.find((c) => c.id === shown) ?? store.collections.value[0] ?? await askNewCollection(planner);
				if (!collection) return;
				const added = await askNewItem(planner, collection.id);
				if (!added) return;
				const route = {
					collectionId: added.collection.id,
					itemId: added.item.id
				};
				if (added.open) return open(route);
				mango.ui.toast({
					title: strings$5.itemAdded(added.collection.name),
					kind: "success",
					action: {
						label: strings$5.show,
						run: () => open(route)
					}
				});
			}
		});
		mango.commands.register({
			id: "new-collection",
			title: strings$5.commands.newCollection,
			icon: ICON,
			keywords: "planner board table",
			run: async () => {
				if (!await loaded()) return;
				const collection = await askNewCollection(planner);
				if (collection) open({ collectionId: collection.id });
			}
		});
		mango.ui.menus.register("thread", {
			id: "add",
			label: strings$5.commands.addThread,
			icon: ICON,
			run: async ({ threadId }) => {
				const title = mango.chat.get(threadId)?.title;
				if (title === void 0 || !await loaded()) return;
				const collection = await askCollection(planner);
				if (!collection) return;
				const item = await store.createItem(collection.id, {
					title,
					chats: [threadId]
				});
				if (!item) return;
				mango.ui.toast({
					title: strings$5.itemAdded(collection.name),
					kind: "success",
					action: {
						label: strings$5.show,
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
