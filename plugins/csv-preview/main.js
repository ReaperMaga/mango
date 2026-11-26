/**
 * CSV preview: renders ```csv and ```tsv blocks in agent replies as a table.
 *
 * The block is agent output, so it is untrusted: every cell goes in through `textContent`, never
 * `innerHTML`, and nothing in it is turned into a link or markup.
 */

/**
 * Parse delimited text (RFC 4180: quoted fields may hold the delimiter, newlines and doubled quotes).
 * Returns rows of strings; a trailing newline does not make an empty last row.
 */
export function parseDelimited(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let i = 0
  const src = String(text ?? '')
  while (i < src.length) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') { quoted = true; i++; continue }
    if (c === delimiter) { row.push(field); field = ''; i++; continue }
    if (c === '\r' || c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/

/** Columns whose non-empty cells are all numbers, so they can be right-aligned. */
export function numericColumns(rows, width) {
  const numeric = new Array(width).fill(true)
  const seen = new Array(width).fill(false)
  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      const v = (row[c] ?? '').trim()
      if (!v) continue
      seen[c] = true
      if (!NUMBER.test(v) || v === '.' || v === '-' || v === '+') numeric[c] = false
    }
  }
  return numeric.map((n, c) => n && seen[c])
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

export function activate(mango) {
  const setting = (key, fallback) => {
    try {
      const v = mango.settings.get(key)
      return v === undefined || v === null ? fallback : v
    } catch {
      return fallback
    }
  }

  mango.chat.codeBlocks.register({
    languages: ['csv', 'tsv'],
    view: {
      mount(host, { code, language }) {
        const delimiter = language === 'tsv' ? '\t' : ','
        let rows
        try {
          rows = parseDelimited(code, delimiter).filter(r => r.some(v => v.trim() !== ''))
        } catch (e) {
          mango.log.warn('Could not parse a block:', e)
          rows = []
        }

        const root = el('div', 'mango-csv')
        const bar = el('div', 'mango-csv__bar')
        const label = el('span', 'mango-csv__label')
        const toggle = el('button', 'mango-csv__toggle', 'Raw')
        toggle.type = 'button'
        toggle.setAttribute('aria-pressed', 'false')
        bar.append(label, toggle)

        const raw = el('pre', 'mango-csv__raw', code)
        raw.hidden = true

        const scroller = el('div', 'mango-csv__scroll')
        const width = rows.reduce((w, r) => Math.max(w, r.length), 0)
        const hasHeader = setting('header', true) !== false && rows.length > 1
        const head = hasHeader ? rows[0] : null
        const body = hasHeader ? rows.slice(1) : rows
        const max = Math.max(1, Number(setting('maxRows', 200)) || 200)
        const shown = body.slice(0, max)
        const numeric = numericColumns(shown, width)

        if (width === 0) {
          // Nothing tabular in it: show the text as it is.
          raw.hidden = false
          toggle.hidden = true
          label.textContent = language.toUpperCase()
        } else {
          const table = el('table', 'mango-csv__table')
          if (head) {
            const tr = el('tr')
            for (let c = 0; c < width; c++) {
              const th = el('th', numeric[c] ? 'is-num' : '', head[c] ?? '')
              th.scope = 'col'
              tr.append(th)
            }
            const thead = el('thead')
            thead.append(tr)
            table.append(thead)
          }
          const tbody = el('tbody')
          for (const row of shown) {
            const tr = el('tr')
            for (let c = 0; c < width; c++) tr.append(el('td', numeric[c] ? 'is-num' : '', row[c] ?? ''))
            tbody.append(tr)
          }
          table.append(tbody)
          scroller.append(table)

          const count = `${body.length.toLocaleString()} row${body.length === 1 ? '' : 's'}, ${width} column${width === 1 ? '' : 's'}`
          label.textContent = body.length > shown.length
            ? `${language.toUpperCase()} · first ${shown.length.toLocaleString()} of ${count}`
            : `${language.toUpperCase()} · ${count}`
        }

        const onToggle = () => {
          const showRaw = raw.hidden
          raw.hidden = !showRaw
          scroller.hidden = showRaw
          toggle.textContent = showRaw ? 'Table' : 'Raw'
          toggle.setAttribute('aria-pressed', String(showRaw))
        }
        toggle.addEventListener('click', onToggle)

        root.append(bar, scroller, raw)
        host.append(root)
        return () => {
          toggle.removeEventListener('click', onToggle)
          root.remove()
        }
      },
    },
  })
}
