// A READ-ONLY, PostgREST-shaped query builder over a verified read-only pg connection
// (rc-8.5.21-c). Diagnostics written against supabase-js (`sb.from(t).select(...).eq(...)`)
// keep their call sites, but run as the role-enforced read-only diagnostics role from
// scripts/lib/prod-db-credentials.mjs instead of the service-role key.
//
// Supported (the subset the ops scripts use): select(cols | '*' | alias:col->>key, { count: 'exact', head }),
// eq, neq, gt, gte, lt, lte, like, ilike, in, is, or('col.op.value,…'), order, limit, range,
// single, maybeSingle. Anything else (embedded resources, aliases, casts, writes, rpc)
// throws before a query is sent. Results resolve to { data, error, count } like
// supabase-js; database errors are returned in `error`, never thrown.
import { connectReadOnlyDiagnostics } from './prod-db-credentials.mjs'

const IDENT = /^[a-z_][a-z0-9_]*$/
const ident = (name, what = 'identifier') => {
  const s = String(name ?? '').trim()
  if (!IDENT.test(s)) throw new Error(`read-only rest: unsupported ${what} ${JSON.stringify(name)}`)
  return `"${s}"`
}
function relation(table) {
  const parts = String(table).split('.')
  if (parts.length > 2) throw new Error(`read-only rest: bad table ${table}`)
  return parts.length === 2 ? `${ident(parts[0], 'schema')}.${ident(parts[1], 'table')}` : `public.${ident(parts[0], 'table')}`
}
// select terms: col | alias:col | col->key | col->>key | alias:col->>key (PostgREST names
// an unaliased JSON path after its last key)
const TERM = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)(?:(->>?)([a-z_][a-z0-9_]*))?$/
function columns(sel) {
  const s = String(sel ?? '*').trim()
  if (s === '*' || s === '') return '*'
  return s.split(',').map((raw) => {
    const m = TERM.exec(raw.trim())
    if (!m) throw new Error(`read-only rest: unsupported select term ${JSON.stringify(raw)}`)
    const [, alias, col, arrow, key] = m
    const expr = arrow ? `${ident(col)}${arrow}'${key}'` : ident(col)
    const name = alias || (arrow ? key : null)
    return name ? `${expr} as ${ident(name)}` : expr
  }).join(', ')
}

// PostgREST JSON shapes: bigint/numeric as numbers, timestamptz as ISO strings.
export const REST_TYPES = Object.freeze({
  getTypeParser(oid, format) {
    if (format === 'binary') return (v) => v
    switch (oid) {
      case 20: case 21: case 23: case 700: case 701: case 1700:
        return (v) => (v === null ? null : Number(v))
      case 16: return (v) => v === 't' || v === 'true'
      case 114: case 3802: return (v) => (v === null ? null : JSON.parse(v))
      case 1184: return (v) => (v === null ? null : new Date(v).toISOString())
      case 1114: return (v) => (v === null ? null : String(v).replace(' ', 'T'))
      default: return (v) => v
    }
  },
})

const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' }

function isClause(col, value) {
  const v = value === null || value === 'null' ? 'null' : value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : null
  if (!v) throw new Error(`read-only rest: is(${col}) supports null / true / false only`)
  return `${ident(col, 'column')} is ${v}`
}

class Query {
  constructor(exec, table) {
    this.exec = exec
    this.rel = relation(table)
    this.cols = '*'
    this.countMode = null
    this.head = false
    this.where = []
    this.params = []
    this.orders = []
    this.lim = null
    this.off = null
    this.one = null
  }
  p(v) { this.params.push(v); return `$${this.params.length}` }
  select(cols = '*', opts = {}) {
    this.cols = columns(cols)
    if (opts.count) {
      if (opts.count !== 'exact') throw new Error('read-only rest: only count: "exact" is supported')
      this.countMode = 'exact'
    }
    this.head = Boolean(opts.head)
    return this
  }
  filter(col, op, value) {
    if (op === 'in') return this.in(col, value)
    if (op === 'is') { this.where.push(isClause(col, value)); return this }
    if (!OPS[op]) throw new Error(`read-only rest: unsupported operator ${op}`)
    this.where.push(`${ident(col, 'column')} ${OPS[op]} ${this.p(value)}`)
    return this
  }
  eq(c, v) { return this.filter(c, 'eq', v) }
  neq(c, v) { return this.filter(c, 'neq', v) }
  gt(c, v) { return this.filter(c, 'gt', v) }
  gte(c, v) { return this.filter(c, 'gte', v) }
  lt(c, v) { return this.filter(c, 'lt', v) }
  lte(c, v) { return this.filter(c, 'lte', v) }
  like(c, v) { return this.filter(c, 'like', v) }
  ilike(c, v) { return this.filter(c, 'ilike', v) }
  is(c, v) { return this.filter(c, 'is', v) }
  in(c, values) {
    this.where.push(`${ident(c, 'column')} = any(${this.p([...(values || [])])})`)
    return this
  }
  /** PostgREST or-filter: "a.is.null,a.eq.x,b.in.(1,2)" (no nesting). */
  or(expr) {
    const parts = []
    for (const term of String(expr).match(/[^,(]+(?:\([^)]*\))?/g) || []) {
      const m = /^\s*([a-z_][a-z0-9_]*)\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/.exec(term)
      if (!m) throw new Error(`read-only rest: unsupported or() term ${JSON.stringify(term)}`)
      const [, col, op, raw] = m
      if (op === 'is') parts.push(isClause(col, raw))
      else if (op === 'in') parts.push(`${ident(col, 'column')} = any(${this.p(raw.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim()).filter(Boolean))})`)
      else parts.push(`${ident(col, 'column')} ${OPS[op]} ${this.p(raw)}`)
    }
    if (parts.length) this.where.push(`(${parts.join(' or ')})`)
    return this
  }
  order(col, { ascending = true, nullsFirst } = {}) {
    this.orders.push(`${ident(col, 'order column')} ${ascending ? 'asc' : 'desc'}${nullsFirst === undefined ? '' : nullsFirst ? ' nulls first' : ' nulls last'}`)
    return this
  }
  limit(n) { this.lim = Math.max(0, Math.floor(Number(n) || 0)); return this }
  range(from, to) { this.off = Math.max(0, Math.floor(Number(from) || 0)); this.lim = Math.max(0, Math.floor(Number(to)) - this.off + 1); return this }
  single() { this.one = 'single'; return this }
  maybeSingle() { this.one = 'maybe'; return this }
  toSql() {
    const where = this.where.length ? ` where ${this.where.join(' and ')}` : ''
    const order = this.orders.length ? ` order by ${this.orders.join(', ')}` : ''
    const lim = this.lim !== null ? ` limit ${this.lim}` : ''
    const off = this.off ? ` offset ${this.off}` : ''
    return {
      rows: `select ${this.cols} from ${this.rel}${where}${order}${lim}${off}`,
      count: `select count(*)::bigint as n from ${this.rel}${where}`,
    }
  }
  async run() {
    const sql = this.toSql()
    try {
      let count = null
      if (this.countMode) count = Number((await this.exec(sql.count, this.params)).rows[0].n)
      if (this.head) return { data: null, error: null, count }
      const rows = (await this.exec(sql.rows, this.params)).rows
      if (this.one) {
        if (rows.length > 1) return { data: null, error: { message: `JSON object requested, multiple (${rows.length}) rows returned` }, count }
        if (!rows.length && this.one === 'single') return { data: null, error: { message: 'JSON object requested, no rows returned' }, count }
        return { data: rows[0] ?? null, error: null, count }
      }
      return { data: rows, error: null, count }
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code }, count: null }
    }
  }
  then(resolve, reject) { return this.run().then(resolve, reject) }
}

for (const m of ['insert', 'update', 'upsert', 'delete']) {
  Query.prototype[m] = function refused() { throw new Error(`read-only rest: ${m} is refused (diagnostics credential)`) }
}

/**
 * A supabase-js-shaped READ-ONLY client for one read-only PURPOSE (see READONLY_PURPOSES in
 * prod-db-credentials.mjs). The connection (role verified by connectReadOnlyDiagnostics) is
 * opened lazily on the first query; call close() when done.
 * @param {{ purpose?: string, connect?: () => Promise<any>, applicationName?: string }} opts
 */
export function readOnlyRestClient({ purpose, connect, applicationName } = {}) {
  if (!connect && !purpose) throw new Error('read-only rest: a read-only purpose is required')
  let clientP = null
  const client = () => (clientP ??= (connect ? connect() : connectReadOnlyDiagnostics({ purpose, applicationName: applicationName || `lc-ro-rest-${purpose}`, types: REST_TYPES })))
  const exec = async (text, values) => (await client()).query(text, values)
  return {
    from(table) { return new Query(exec, table) },
    rpc() { throw new Error('read-only rest: rpc is refused (diagnostics credential)') },
    schema() { throw new Error('read-only rest: schema() is not supported; use from("schema.table")') },
    async close() { if (clientP) { const c = await clientP; clientP = null; await c.end() } },
  }
}
