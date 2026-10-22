// BOUNDED, EXPLICIT pagination of the Workforce reads an agent's model sees (the live Claude Code milestone, 2026-10-22).
//
// An agent client shows its model a bounded tool result (Agntei: 8,000 characters per result; the MCP text adds an
// envelope and a one-line preamble, and the second-net mask can lengthen a string). A read that does not fit was cut
// mid-JSON by the client: silently, possibly through authorization- or money-relevant fields. Here nothing is ever cut:
//   * a list is PAGED: rows are added while the page stays inside MODEL_RESULT_BUDGET; `page.next_cursor` reads on;
//   * a row too large on its own is CONDENSED: its largest members (an assignment's input.candidates, output.research,
//     evidence …) are replaced by an explicit stub that names the member, its size and the exact call that reads it;
//   * a member read (`part`) is itself paged (array items, object entries, or a long string in numbered chunks).
// Every page says `complete: true|false`. Evidence refs are only ever moved behind a stub, never dropped.
import { gwErr } from '../../errors.js'

/** The payload budget of one model-facing read (characters of JSON), well inside the client's 8,000. */
export const MODEL_RESULT_BUDGET = 5_600
const STUB_MIN = 240 // a member smaller than this is never worth a stub
const size = (v) => JSON.stringify(v ?? null).length

export function encodeCursor(o) { return Buffer.from(JSON.stringify(o)).toString('base64url') }
export function decodeCursor(s, expectKind) {
  if (s == null) return null
  let o = null
  try { o = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')) } catch { o = null }
  if (!o || typeof o !== 'object' || o.k !== expectKind || !Number.isInteger(o.o) || o.o < 0 || o.o > 100_000) throw gwErr('invalid_input', 'CURSOR_INVALID', 'this cursor is not one LeadCommand returned for this read (pass next_cursor back unchanged)')
  return o
}

/** The value at a dotted path (a.b.c; array indexes as numbers), or undefined. */
export function at(root, path) {
  let v = root
  for (const k of String(path).split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[Array.isArray(v) ? Number(k) : k] }
  return v
}
const setAt = (root, path, value) => {
  const ks = String(path).split('.')
  const copy = Array.isArray(root) ? [...root] : { ...root }
  let cur = copy
  for (let i = 0; i < ks.length - 1; i += 1) { const k = ks[i]; cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] }; cur = cur[k] }
  cur[ks.at(-1)] = value
  return copy
}

/** The explicit stand-in for a member moved out of the page. */
export function stub(value, path, readWith) {
  // _paged names the member exactly as its read takes it (read_with.arguments.part), else its path in this record
  return { _paged: readWith?.arguments?.part ?? path, kind: Array.isArray(value) ? 'array' : typeof value === 'string' ? 'string' : 'object', ...(Array.isArray(value) ? { items: value.length } : value && typeof value === 'object' ? { keys: Object.keys(value).length } : {}), chars: size(value), read_with: readWith }
}

/** The members of a row worth stubbing (depth ≤ 3 under the given roots), largest first. */
function members(row, roots) {
  const out = []
  const walk = (v, path, depth) => {
    if (v == null || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k
      if (x != null && typeof x === 'object' || typeof x === 'string') { const n = size(x); if (n >= STUB_MIN) out.push({ path: p, n }) }
      if (depth < 3 && x && typeof x === 'object' && !Array.isArray(x)) walk(x, p, depth + 1)
    }
  }
  for (const r of roots) { const v = at(row, r); if (v != null && size(v) >= STUB_MIN) out.push({ path: r, n: size(v) }); if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, r, 1) }
  return out.sort((a, b) => b.n - a.n || (a.path < b.path ? -1 : 1))
}

/**
 * A row that fits `budget`: its largest members (under `roots`) replaced by stubs until it does — the most specific large
 * member first (a container is stubbed whole only when no single child of it carries most of its size), so the small fields
 * around it stay readable in place.
 */
export function condense(row, { budget, roots, readWith }) {
  if (size(row) <= budget) return { row, stubbed: [] }
  let r = row
  const stubbed = []
  for (let guard = 0; guard < 60 && size(r) > budget; guard += 1) {
    const ms = members(r, roots).filter((m) => { const v = at(r, m.path); return !(v && typeof v === 'object' && v._paged) })
    const pick = ms.find((m) => !ms.some((d) => d.path.startsWith(`${m.path}.`) && d.n >= m.n * 0.5))
    if (!pick) break
    r = setAt(r, pick.path, stub(at(r, pick.path), pick.path, readWith(pick.path)))
    stubbed.push(pick.path)
  }
  return { row: r, stubbed }
}

/**
 * Page a list of rows inside the budget (each row condensed when it alone would not fit).
 * @returns {{ items: object[], page: { offset, returned, total, next_cursor, complete, budget_chars, condensed } }}
 */
export function pageRows(rows, { offset = 0, budget = MODEL_RESULT_BUDGET, kind, roots = ['input', 'output', 'evidence'], readWith, extra = 0 }) {
  const items = []
  const condensed = []
  let used = extra + 200
  let i = offset
  for (; i < rows.length; i += 1) {
    const room = budget - used
    let row = rows[i]
    if (size(row) > room) {
      // condense a row only when it would not fit even on a page of its own; otherwise it starts the next page
      if (items.length && size(row) <= budget - extra - 200) break
      const c = condense(row, { budget: Math.max(room, 400), roots, readWith: (p) => readWith(row, p) })
      if (size(c.row) > room && items.length) break
      row = c.row
      if (c.stubbed.length) condensed.push({ id: row.assignment_id ?? row.id ?? i, members: c.stubbed })
    }
    items.push(row)
    used += size(row) + 1
  }
  const next = i < rows.length ? encodeCursor({ k: kind, o: i }) : null
  return { items, page: { offset, returned: items.length, total: rows.length, next_cursor: next, complete: next == null && !condensed.length, budget_chars: budget, ...(condensed.length ? { condensed } : {}) } }
}

/**
 * Page ONE member (`part`) of a record: array items, object entries ([key, value]) or a long string in chunks, inside the budget.
 * An item too large on its own is condensed like a row (with a read_with naming its own path).
 */
export function pagePart(value, { part, offset = 0, budget = MODEL_RESULT_BUDGET, kind, readWith, extra = 0 }) {
  if (value === undefined) throw gwErr('not_found', 'PART_NOT_FOUND', `this record has no member ${String(part).slice(0, 80)}`)
  if (typeof value === 'string') {
    const chunk = Math.max(500, budget - extra - 400)
    const total = Math.ceil(value.length / chunk) || 1
    const idx = Math.min(offset, total - 1)
    const next = idx + 1 < total ? encodeCursor({ k: kind, o: idx + 1 }) : null
    return { part, kind: 'string', chunk: idx + 1, chunks: total, text: value.slice(idx * chunk, (idx + 1) * chunk), page: { offset: idx, returned: 1, total, next_cursor: next, complete: next == null, budget_chars: budget } }
  }
  if (value === null || typeof value !== 'object') return { part, kind: typeof value, value, page: { offset: 0, returned: 1, total: 1, next_cursor: null, complete: true, budget_chars: budget } }
  const isArr = Array.isArray(value)
  const entries = isArr ? value : Object.entries(value).map(([k, v]) => ({ key: k, value: v }))
  const r = pageRows(entries, { offset, budget, kind, roots: isArr ? [] : ['value'], extra: extra + 100, readWith: (row, p) => readWith(isArr ? `${part}.${entries.indexOf(row)}${p ? `.${p}` : ''}` : `${part}.${row.key}${p.replace(/^value/, '')}`) })
  // an array item too large for a page of its own: its largest members (any depth ≤ 3) become stubs
  const items = r.items.map((x, j) => (size(x) > budget - extra - 300 && x && typeof x === 'object' ? condense(x, { budget: budget - extra - 300, roots: Object.keys(x), readWith: (p) => readWith(`${part}.${offset + j}.${p}`) }).row : x))
  return { part, kind: isArr ? 'array' : 'object', items, page: r.page }
}

/** The input-schema members every paged Workforce read accepts. */
export const PART_PATTERN = '^[a-z_]{1,40}(\\.[a-z0-9_]{1,40}){0,4}$'
export const CURSOR_PATTERN = '^[A-Za-z0-9_-]{4,400}$'
