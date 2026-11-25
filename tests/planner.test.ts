/**
 * The planner's pure parts (plugins/planner/src): order keys, patches, normalising, values, queries,
 * type changes, CSV.
 *
 *   node --test tests/planner.test.ts     (or: pnpm test)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { between, compareOrder, isKey, manyBetween, placeAt, spread } from '../plugins/planner/src/order.ts'
import { applyPatch, invertPatch, type JsonObject } from '../plugins/planner/src/patch.ts'
import {
  addDays, isDateString, isInScope, normalizeCollection, normalizeItem, parseDate, safeUrl, storedValue, valueOf,
  type Collection, type Item, type View,
} from '../plugins/planner/src/model.ts'
import { defaultValues, groupsOf, matchesFilter, NO_GROUP, runQuery, sortItems, valueForGroup } from '../plugins/planner/src/query.ts'
import { convertProperty, parseNumber } from '../plugins/planner/src/convert.ts'
import { csvCell, inferType, itemToMarkdown, parseCsv, planImport, toCsv } from '../plugins/planner/src/csv.ts'
import { templateData, TEMPLATES } from '../plugins/planner/src/templates.ts'

const meta = (id: string) => ({ id, createdAt: 1, updatedAt: 2 })

function tasks(extra: JsonObject = {}): Collection {
  return normalizeCollection({
    name: 'Tasks',
    properties: {
      status: { name: 'Status', type: 'select', order: 'a', options: {
        todo: { name: 'To do', color: 'neutral', order: 'a' }, done: { name: 'Done', color: 'green', order: 'b' },
      } },
      tags: { name: 'Tags', type: 'multiSelect', order: 'b', options: { x: { name: 'X', order: 'a' }, y: { name: 'Y', order: 'b' } } },
      points: { name: 'Points', type: 'number', order: 'c' },
      due: { name: 'Due', type: 'date', order: 'd' },
      ok: { name: 'OK', type: 'checkbox', order: 'e' },
      note: { name: 'Note', type: 'text', order: 'f' },
    },
    views: { v: { name: 'Board', type: 'board', order: 'a', groupBy: 'status' } },
    ...extra,
  }, meta('c'))
}
const item = (id: string, values: JsonObject = {}, more: JsonObject = {}): Item =>
  normalizeItem({ title: id, order: id, values, ...more }, meta(id), 'c')
const view = (c: Collection, change: Partial<View> = {}): View => ({ ...c.views[0]!, ...change })

/* ---------------------------------------------------------------- order */

test('order: keys between, before and after, always fitting and growing slowly', () => {
  let keys = [between(null, null)!]
  let seed = 7
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
  for (let i = 0; i < 2000; i++) {
    const at = random(keys.length + 1)
    const key = between(keys[at - 1] ?? null, keys[at] ?? null)
    assert.ok(key && isKey(key))
    keys.splice(at, 0, key)
  }
  assert.deepEqual(keys, [...keys].sort())
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(Math.max(...keys.map(k => k.length)) < 40)

  keys = ['V']
  for (let i = 0; i < 5000; i++) keys.push(between(keys.at(-1)!, null)!)
  for (let i = 0; i < 5000; i++) keys.unshift(between(null, keys[0]!)!)
  assert.deepEqual(keys, [...keys].sort())
  assert.ok(keys.every(k => k.length <= 5))

  assert.ok(between('zzzzzz', null)! > 'zzzzzz')
  assert.ok(between(null, '00001')! < '00001')
})

test('order: equal and garbled keys re-space the list', () => {
  assert.equal(between('a', 'a'), null)
  assert.equal(between('b', 'a'), null)
  assert.equal(between('a!', null), null)
  assert.equal(between('a', 'a0'), null)
  assert.equal(manyBetween('V', 'V', 2), null)
  const list = [{ id: '1', order: 'V' }, { id: '2', order: 'V' }, { id: '3', order: '' }, { id: '4', order: 'ü' }]
  const place = placeAt(list, ['new'], { after: '1' })
  assert.equal(place.size, 5)
  const after = [...list.map(e => ({ ...e, order: place.get(e.id)! })), { id: 'new', order: place.get('new')! }].sort(compareOrder)
  // Garbled keys sort where they sort; what matters is that the new one is right after its neighbour.
  assert.equal(after[after.findIndex(e => e.id === '1') + 1]!.id, 'new')
  const keys = spread(5000)
  assert.deepEqual(keys, [...keys].sort())
  assert.ok(keys.every(isKey))
})

test('order: placing moves only what was asked when there is room', () => {
  const list = ['a', 'b', 'c', 'd'].map(id => ({ id, order: id }))
  const place = placeAt(list, ['d', 'a'], { before: 'c' })
  assert.deepEqual([...place.keys()], ['d', 'a'])
  const sorted = list.map(e => ({ ...e, order: place.get(e.id) ?? e.order })).sort(compareOrder).map(e => e.id)
  assert.deepEqual(sorted, ['b', 'd', 'a', 'c'])
  assert.ok(placeAt(list, ['d'], 'start').get('d')! < 'a')
})

/* ---------------------------------------------------------------- patches */

test('patch: fields merge, unknown ones stay, gone entries stay gone, inverses undo', () => {
  const doc: JsonObject = { name: 'A', future: { x: 1 }, views: { v: { name: 'V', later: true } }, values: { a: 1 } }
  const one = [{ path: ['views', 'v', 'name'], value: 'W' }]
  const two = [{ path: ['values', 'b'], value: 2 }, { path: ['values', 'a'] }]
  const both = applyPatch(applyPatch(doc, one), two)
  assert.deepEqual(both, { name: 'A', future: { x: 1 }, views: { v: { name: 'W', later: true } }, values: { b: 2 } })
  assert.deepEqual(applyPatch(applyPatch(doc, two), one), both)
  assert.deepEqual(applyPatch(doc, [{ path: ['views', 'gone', 'name'], value: 'x' }]), doc)
  assert.deepEqual(applyPatch({}, [{ path: ['__proto__', 'polluted'], value: 1 }]), {})
  assert.equal(({} as { polluted?: number }).polluted, undefined)
  const p = [...one, ...two, { path: ['views', 'n'], value: {} }, { path: ['views', 'n', 'name'], value: 'N' }]
  assert.deepEqual(applyPatch(applyPatch(doc, p), invertPatch(doc, p)), doc)
  // A list of { id } someone else stored is read as entries.
  assert.deepEqual(applyPatch({ views: [{ id: 'v', name: 'V' }] }, one), { views: { v: { id: 'v', name: 'W' } } })
})

/* ---------------------------------------------------------------- model */

test('model: anything normalises', () => {
  for (const raw of [null, 1, 'x', [], {}, { properties: 3, views: [null, 4], scope: 'x' }, { properties: { __proto__: {}, p: null } }]) {
    const c = normalizeCollection(raw, meta('c'))
    assert.equal(c.views.length, 1)
    assert.deepEqual(c.scope, { kind: 'everywhere' })
    assert.equal(normalizeItem(raw, meta('i'), 'c').title, '')
  }
  const c = normalizeCollection({
    icon: '<svg>', color: 'teal',
    properties: { f: { name: 'Formula', type: 'formula', order: 'a' }, s: { type: 'select', order: 'b' }, title: { type: 'text' } },
    views: { v: { type: 'board', groupBy: 'nope', sorts: [{ propertyId: 'nope' }, { propertyId: 'title', direction: 'desc' }],
      filter: { match: 'x', conditions: [{ propertyId: 'nope', operator: 'is' }, { propertyId: 'title', operator: 'gt' }, { id: '1', propertyId: 'title', operator: 'contains', value: 4 }] },
      widths: { title: 9999, nope: 4 }, hiddenGroups: ['a', 'a', 3] } },
  }, meta('c'))
  assert.equal(c.icon, 'square-kanban')
  assert.deepEqual(c.properties.map(p => [p.id, p.type]), [['f', 'unsupported'], ['s', 'select']])
  const v = c.views[0]!
  assert.equal(v.groupBy, 's')
  assert.deepEqual(v.sorts, [{ propertyId: 'title', direction: 'desc' }])
  assert.deepEqual(v.filter, { match: 'and', conditions: [{ id: '1', propertyId: 'title', operator: 'contains', value: null }] })
  assert.deepEqual(v.widths, { title: 1200 })
  assert.deepEqual(v.hiddenGroups, ['a'])
  assert.deepEqual(v.columns.map(e => e.propertyId), ['f', 's'])
})

test('model: values are read as their property understands them', () => {
  const c = tasks()
  const at = (id: string) => c.properties.find(p => p.id === id)!
  const i = item('a', { status: 'gone', tags: ['x', 'gone', 'x'], points: '3', due: { start: '2026-02-30' }, ok: 'yes' })
  assert.equal(valueOf(i, at('status')), null)
  assert.deepEqual(valueOf(i, at('tags')), ['x'])
  assert.equal(valueOf(i, at('points')), null)
  assert.equal(valueOf(i, at('due')), null)
  assert.equal(valueOf(i, at('ok')), false)
  assert.equal(storedValue(false, at('ok')), undefined)
  assert.equal(storedValue('', at('note')), undefined)
  assert.equal(storedValue('nope', at('status')), undefined)
  assert.deepEqual(storedValue({ start: '2026-03-02', end: '2026-03-01' }, at('due')), { start: '2026-03-02' })
})

test('model: dates, links and scopes', () => {
  assert.ok(isDateString('2024-02-29') && !isDateString('2026-02-29') && isDateString('2026-01-01T09:30') && !isDateString('2026-01-01T25:00'))
  assert.equal(addDays('2026-02-27', 2), '2026-03-01')
  assert.deepEqual(parseDate('2026-01-01 to 2026-01-05'), { start: '2026-01-01', end: '2026-01-05' })
  assert.deepEqual(parseDate('2026-01-01 10:00:30'), { start: '2026-01-01T10:00' })
  assert.equal(parseDate('01/02/2026'), null)
  assert.equal(safeUrl('javascript:alert(1)'), null)
  assert.equal(safeUrl('example.com/a'), 'https://example.com/a')
  assert.equal(safeUrl('localhost:3000'), 'https://localhost:3000/')
  assert.ok(isInScope({ kind: 'project', path: 'C:\\Code\\App\\' }, 'c:/code/app'))
  assert.ok(!isInScope({ kind: 'project', path: '/code/App' }, '/code/app'))
  assert.ok(!isInScope({ kind: 'project', path: '/code' }, null))
})

test('templates make collections that normalise to what they say', () => {
  for (const t of TEMPLATES) {
    const c = normalizeCollection({ name: t.name, ...templateData(t.id) }, meta('c'))
    assert.ok(c.views.length >= 1 && c.icon === t.icon)
    for (const v of c.views) assert.ok(v.type !== 'board' || v.groupBy)
  }
  const c = normalizeCollection(templateData('tasks'), meta('c'))
  assert.deepEqual(c.properties[0]!.options.map(o => o.name), ['To do', 'In progress', 'Done'])
})

test('model: documents from before custom colours, defaults and item names load as they were', () => {
  const c = normalizeCollection({
    name: 'Old', color: 'blue',
    properties: { s: { name: 'Status', type: 'select', order: 'V', options: { a: { name: 'A', color: 'green', order: 'V' } } }, t: { name: 'T', type: 'text', order: 'W', defaultOption: 'a' } },
  }, meta('c'))
  assert.deepEqual([c.color, c.description, c.itemName], ['blue', '', null])
  assert.deepEqual(c.properties.map(p => p.defaultOption), [null, null])
  const names = (v: unknown) => normalizeCollection({ itemName: v }, meta('c')).itemName
  assert.deepEqual(names({ one: ' note ' }), { one: 'note', many: 'note' })
  assert.deepEqual(names({ one: 3, many: 'notes' }), { one: 'notes', many: 'notes' })
  for (const bad of [null, 'note', {}, { one: ' ' }, []]) assert.equal(names(bad), null)
})

test('templates: notes are a board of statuses with a default', () => {
  const c = normalizeCollection(templateData('notes'), meta('c'))
  const status = c.properties[0]!
  assert.deepEqual(status.options.map(o => [o.name, o.color]), [['Backlog', 'neutral'], ['In progress', 'blue'], ['Review', 'purple'], ['Done', 'green']])
  assert.equal(status.defaultOption, status.options[0]!.id)
  assert.deepEqual([c.views[0]!.type, c.views[0]!.groupBy, c.views[0]!.cardPreview], ['board', status.id, 'body'])
  assert.deepEqual(c.itemName, { one: 'note', many: 'notes' })
})

/* ---------------------------------------------------------------- query */

test('query: filters by type', () => {
  const c = tasks()
  const now = new Date(2026, 2, 10, 12).getTime()
  const a = item('alpha', { status: 'todo', tags: ['x'], points: 3, due: { start: '2026-03-08', end: '2026-03-11' }, ok: true, note: 'Hello World' })
  const b = item('beta')
  const hits = (propertyId: string, operator: string, value: unknown = null, match: 'and' | 'or' = 'and') => [a, b]
    .filter(i => matchesFilter(c, i, { match, conditions: [{ id: '1', propertyId, operator, value } as never] }, now)).map(i => i.title)
  assert.deepEqual(hits('title', 'contains', 'ALP'), ['alpha'])
  assert.deepEqual(hits('note', 'startsWith', 'hello'), ['alpha'])
  assert.deepEqual(hits('note', 'notContains', 'world'), ['beta'])
  assert.deepEqual(hits('note', 'isEmpty'), ['beta'])
  assert.deepEqual(hits('points', 'gte', 3), ['alpha'])
  assert.deepEqual(hits('points', 'neq', 4), ['alpha', 'beta'])
  assert.deepEqual(hits('status', 'is', ['todo', 'done']), ['alpha'])
  assert.deepEqual(hits('status', 'isNot', ['todo']), ['beta'])
  assert.deepEqual(hits('tags', 'contains', ['x']), ['alpha'])
  assert.deepEqual(hits('tags', 'notContains', ['x']), ['beta'])
  assert.deepEqual(hits('ok', 'is', false), ['beta'])
  assert.deepEqual(hits('due', 'today'), ['alpha'])
  assert.deepEqual(hits('due', 'overdue'), [])
  assert.deepEqual(hits('due', 'is', '2026-03-09'), ['alpha'])
  assert.deepEqual(hits('due', 'before', '2026-03-08'), [])
  assert.deepEqual(hits('due', 'nextDays', 2), ['alpha'])
  // Not filled in yet, or about nothing.
  assert.deepEqual(hits('status', 'is'), ['alpha', 'beta'])
  assert.deepEqual(hits('gone', 'is', 'x', 'or'), ['alpha', 'beta'])
})

test('query: sorts with empties last and the manual order for ties', () => {
  const c = tasks()
  const list = [item('d', { points: 1 }), item('a'), item('c', { points: 10 }), item('b', { points: 1 })]
  const ids = (direction: 'asc' | 'desc') => sortItems(c, list, [{ propertyId: 'points', direction }]).map(i => i.id)
  assert.deepEqual(ids('asc'), ['b', 'd', 'c', 'a'])
  assert.deepEqual(ids('desc'), ['c', 'b', 'd', 'a'])
  assert.deepEqual(sortItems(c, list, []).map(i => i.id), ['a', 'b', 'c', 'd'])
  const byStatus = sortItems(c, [item('1', { status: 'done' }), item('2', { status: 'todo' })], [{ propertyId: 'status', direction: 'asc' }])
  assert.deepEqual(byStatus.map(i => i.id), ['2', '1'])
  const titles = [item('1', {}, { title: 'item 10' }), item('2', {}, { title: 'Item 9' }), item('3', {}, { title: ' ' })]
  assert.deepEqual(sortItems(c, titles, [{ propertyId: 'title', direction: 'desc' }]).map(i => i.id), ['1', '2', '3'])
})

test('query: groups, search and defaults', () => {
  const c = tasks()
  const list = [item('a', { status: 'todo', tags: ['x', 'y'] }, { body: 'needle here' }), item('b', { status: 'gone' }), item('c', { status: 'done', ok: true })]
  const r = runQuery(c, list, view(c, { hiddenGroups: ['done'], collapsedGroups: [NO_GROUP] }))
  assert.deepEqual(r.groups.map(g => [g.key, g.items.map(i => i.id), g.hidden, g.collapsed]), [
    [NO_GROUP, ['b'], false, true], ['todo', ['a'], false, false], ['done', ['c'], true, false],
  ])
  assert.deepEqual(runQuery(c, list, view(c, { groupBy: 'ok' })).groups.map(g => [g.key, g.items.length]), [['false', 2], ['true', 1]])
  assert.deepEqual(runQuery(c, list, view(c, { groupBy: null })).groups.map(g => g.items.length), [3])
  assert.deepEqual(runQuery(c, list, view(c), { search: 'NEEDLE  to' }).items.map(i => i.id), ['a'])

  const tags = c.properties.find(p => p.id === 'tags')!
  assert.deepEqual(groupsOf(list[0]!, tags), ['x', 'y'])
  assert.deepEqual(valueForGroup(tags, 'y', list[0], 'x'), ['y'])
  assert.deepEqual(valueForGroup(tags, 'y', item('z', { tags: ['x'] })), ['x', 'y'])
  assert.equal(valueForGroup(tags, NO_GROUP, list[0]), null)

  const filtered = view(c, { filter: { match: 'and', conditions: [
    { id: '1', propertyId: 'status', operator: 'is', value: ['todo'] }, { id: '2', propertyId: 'ok', operator: 'is', value: true },
  ] } })
  assert.deepEqual(defaultValues(c, filtered), { status: 'todo', ok: true })
  assert.deepEqual(defaultValues(c, filtered, 'done'), { status: 'done', ok: true })
  assert.deepEqual(defaultValues(c, filtered, NO_GROUP), { ok: true })
})

/* ---------------------------------------------------------------- type changes */

test('convert: values come along where they can', () => {
  const c = tasks()
  const note = c.properties.find(p => p.id === 'note')!
  const list = [item('1', { note: 'High' }), item('2', { note: 'high ' }), item('3', { note: 'a, b' }), item('4')]
  const select = convertProperty(note, 'select', list)
  assert.deepEqual(select.property.options.map(o => o.name), ['High', 'a, b'])
  assert.equal(select.values.get('1'), select.values.get('2'))
  assert.equal(select.values.has('4'), false)
  const multi = convertProperty(note, 'multiSelect', list)
  assert.equal((multi.values.get('3') as string[]).length, 2)
  // And back: names again.
  const back = convertProperty(select.property, 'text', [item('1', { note: select.values.get('1') as string })])
  assert.equal(back.values.get('1'), 'High')
  assert.equal(back.property.options.length, 2)
  const numbers = convertProperty(note, 'number', [item('1', { note: '1,200.5' }), item('2', { note: 'x' })])
  assert.equal(numbers.values.get('1'), 1200.5)
  assert.equal(numbers.values.get('2'), null)
  assert.equal(numbers.lost, 1)
  const points = c.properties.find(p => p.id === 'points')!
  assert.equal(convertProperty(points, 'checkbox', [item('1', { points: 2 })]).values.get('1'), true)
  const due = c.properties.find(p => p.id === 'due')!
  assert.equal(convertProperty(due, 'text', [item('1', { due: { start: '2026-01-01' } })]).values.get('1'), '2026-01-01')
  assert.equal(parseNumber('1,5'), 1.5)
  assert.equal(parseNumber('1.2.3'), null)
})

/* ---------------------------------------------------------------- CSV */

test('csv: quotes, formulas and reading back', () => {
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell(' @x'), "' @x")
  assert.equal(csvCell('-5', true), '-5')
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"')
  for (const t of ['=HYPERLINK("x")', '- list', "'quoted", "''=x", '+1', 'a\nb', ' lead', '"', 'plain', "'=x"]) {
    assert.deepEqual(parseCsv(`h,${csvCell(t)}\r\n`), [['h', t]], t)
  }
  assert.deepEqual(parseCsv('\uFEFFa;b\n1;"x;y"\n\n'), [['a', 'b'], ['1', 'x;y']])

  const c = tasks()
  const rows = parseCsv(toCsv(c, [item('one', { status: 'todo', points: -2, tags: ['x', 'y'], ok: true }, { body: 'line\n"two"' })]))
  assert.deepEqual(rows, [
    ['Title', 'Status', 'Tags', 'Points', 'Due', 'OK', 'Note', 'Body'],
    ['one', 'To do', 'X, Y', '-2', '', 'Yes', '', 'line\n"two"'],
  ])
  const plan = planImport(rows, c.properties)
  assert.deepEqual(plan.properties, [])
  assert.deepEqual(plan.items, [{ title: 'one', body: 'line\n"two"', values: { status: 'todo', tags: ['x', 'y'], points: -2, ok: true } }])
})

test('csv: new columns get the type they look like, new names an option', () => {
  assert.equal(inferType(['1', '2.5', '']), 'number')
  assert.equal(inferType(['2026-01-01']), 'date')
  assert.equal(inferType(['https://a.b']), 'url')
  assert.equal(inferType(['a', 'b', 'a', 'b']), 'select')
  assert.equal(inferType(['one', 'two']), 'text')
  const plan = planImport(parseCsv('Name,Status,Size\nA,To do,1\nB,Blocked,2\n'), tasks().properties)
  assert.deepEqual(plan.properties.map(p => [p.name, p.type]), [['Size', 'number'], ['Status', 'select']])
  assert.deepEqual(plan.properties[1]!.options.map(o => o.name), ['To do', 'Done', 'Blocked'])
  assert.deepEqual(plan.items.map(i => i.title), ['A', 'B'])
  assert.deepEqual(planImport([]), { properties: [], items: [] })
})

test('markdown: titles and values cannot become markup', () => {
  const md = itemToMarkdown(tasks(), item('i', { status: 'todo', note: '<b>*x*' }, { title: 'A # b\nc', body: '- [ ] do' }))
  assert.equal(md, '# A \\# b c\n\n- **Status:** To do\n- **OK:** No\n- **Note:** \\<b\\>\\*x\\*\n\n- [ ] do\n')
})
