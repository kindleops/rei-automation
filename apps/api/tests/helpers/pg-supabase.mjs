// A Supabase-shaped query client over a DISPOSABLE PostgreSQL pool (rc-8.5.21 E2E tests). It
// implements exactly the PostgREST builder subset the conversation runtime uses — select / eq /
// neq / in / gte / gt / lte / lt / order / limit / maybeSingle / single, insert / upsert /
// update (+ select returning), and rpc(fn, named args) — as real SQL, so loaders, stores,
// triggers and CHECKs run for real. Anything else throws (no silent no-ops). Test-only.
import pg from 'pg'

const TS = new Set([1184, 1114]) // timestamptz, timestamp
/** A pool whose timestamps come back as ISO-8601 strings with full precision (what PostgREST returns). */
export function isoPool(connectionString, max = 4) {
  return new pg.Pool({
    connectionString, max,
    types: { getTypeParser: (oid, format) => (TS.has(oid) ? (v) => (v == null ? v : String(v).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : pg.types.getTypeParser(oid, format)) },
  })
}

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(String(s))) throw new Error(`pg-supabase: refused identifier ${s}`)
  return `"${s}"`
}

export function pgSupabase(pool, { schema = 'public' } = {}) {
  const typeCache = new Map()
  async function colTypes(table) {
    if (!typeCache.has(table)) {
      const r = await pool.query(`select column_name, data_type, udt_name from information_schema.columns where table_schema = $1 and table_name = $2`, [schema, table])
      typeCache.set(table, new Map(r.rows.map((x) => [x.column_name, x.data_type === 'ARRAY' ? 'array' : x.udt_name])))
    }
    return typeCache.get(table)
  }
  const encode = (types, col, v) => {
    if (v === undefined) return null
    const t = types.get(col)
    if ((t === 'jsonb' || t === 'json') && v !== null) return JSON.stringify(v)
    return v
  }
  const from = (table) => {
    const st = { op: 'select', cols: '*', filters: [], order: [], limit: null, single: false, payload: null, onConflict: null, ignoreDuplicates: false, returning: null }
    async function exec() {
      try {
        const types = await colTypes(table)
        if (!types.size) return { data: null, error: { message: `relation ${table} does not exist`, code: '42P01' } }
        const params = []
        const p = (v) => { params.push(v); return `$${params.length}` }
        const one = ([c, op, v]) => (op === 'in' ? `${ident(c)} = any(${p(v)})` : `${ident(c)} ${op} ${p(encode(types, c, v))}`)
        const where = st.filters.length ? ` where ${st.filters.map((f) => (f[1] === 'or' ? `(${f[2].map(one).join(' or ')})` : one(f))).join(' and ')}` : ''
        const colsSql = (cols) => (!cols || cols === '*' ? '*' : cols.split(',').map((c) => ident(c.trim())).join(', '))
        let sql
        if (st.op === 'select') {
          sql = `select ${colsSql(st.cols)} from ${schema}.${ident(table)}${where}${st.order.length ? ` order by ${st.order.map(([c, asc]) => `${ident(c)} ${asc ? 'asc' : 'desc'}`).join(', ')}` : ''}${st.limit != null ? ` limit ${Number(st.limit)}` : ''}`
        } else if (st.op === 'insert' || st.op === 'upsert') {
          const rows = Array.isArray(st.payload) ? st.payload : [st.payload]
          const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => types.has(c))
          const values = rows.map((r) => `(${cols.map((c) => p(encode(types, c, r[c]))).join(', ')})`).join(', ')
          const conflict = st.op === 'upsert' ? ` on conflict (${String(st.onConflict || 'id').split(',').map((c) => ident(c.trim())).join(', ')}) ${st.ignoreDuplicates ? 'do nothing' : `do update set ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`}` : ''
          sql = `insert into ${schema}.${ident(table)} (${cols.map(ident).join(', ')}) values ${values}${conflict} returning ${colsSql(st.returning)}`
        } else if (st.op === 'update') {
          const cols = Object.keys(st.payload).filter((c) => types.has(c))
          sql = `update ${schema}.${ident(table)} set ${cols.map((c) => `${ident(c)} = ${p(encode(types, c, st.payload[c]))}`).join(', ')}${where} returning ${colsSql(st.returning)}`
        } else throw new Error(`pg-supabase: unsupported op ${st.op}`)
        const r = await pool.query(sql, params)
        if (st.single) return { data: r.rows[0] ?? null, error: null }
        return { data: r.rows, error: null }
      } catch (e) {
        if (process.env.PG_SUPABASE_DEBUG) console.error('PG_SUPABASE_ERROR', table, st.op, e.message)
        return { data: null, error: { message: e.message, code: e.code || null } }
      }
    }
    const b = {
      select(cols = '*') { if (st.op === 'select') st.cols = cols; else st.returning = cols; return b },
      eq(c, v) { st.filters.push([c, '=', v]); return b },
      neq(c, v) { st.filters.push([c, '<>', v]); return b },
      gte(c, v) { st.filters.push([c, '>=', v]); return b },
      gt(c, v) { st.filters.push([c, '>', v]); return b },
      lte(c, v) { st.filters.push([c, '<=', v]); return b },
      lt(c, v) { st.filters.push([c, '<', v]); return b },
      in(c, v) { st.filters.push([c, 'in', Array.isArray(v) ? v : [v]]); return b },
      order(c, o = {}) { st.order.push([c, o.ascending !== false]); return b },
      // PostgREST or(): only "col.<eq|neq|gt|gte|lt|lte>.<value>" terms (quoted values allowed)
      or(expr) {
        const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
        const terms = String(expr).match(/(?:[^,"]|"(?:[^"]|"")*")+/g) || []
        st.filters.push([null, 'or', terms.map((t) => {
          const m = /^([a-z_][a-z0-9_]*)\.(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(t.trim())
          if (!m) { if (process.env.PG_SUPABASE_DEBUG) console.error('PG_SUPABASE_UNSUPPORTED', table, 'or', t); throw new Error(`pg-supabase: or term ${t} is not implemented`) }
          const raw = m[3]
          return [m[1], OPS[m[2]], /^".*"$/.test(raw) ? raw.slice(1, -1).replace(/""/g, '"') : raw]
        })])
        return b
      },
      limit(n) { st.limit = n; return b },
      maybeSingle() { st.single = true; return b },
      single() { st.single = true; return b },
      insert(payload) { st.op = 'insert'; st.payload = payload; return b },
      upsert(payload, o = {}) { st.op = 'upsert'; st.payload = payload; st.onConflict = o.onConflict || null; st.ignoreDuplicates = o.ignoreDuplicates === true; return b },
      update(payload) { st.op = 'update'; st.payload = payload; return b },
      then(res, rej) { return exec().then(res, rej) },
    }
    for (const k of ['contains', 'range', 'delete', 'is', 'like', 'ilike', 'not', 'match', 'filter', 'textSearch']) b[k] = () => { if (process.env.PG_SUPABASE_DEBUG) console.error('PG_SUPABASE_UNSUPPORTED', table, k); throw new Error(`pg-supabase: ${k} is not implemented (no silent no-ops)`) }
    return b
  }
  async function rpc(fn, args = {}) {
    try {
      const keys = Object.keys(args)
      const r = await pool.query(`select ${schema}.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => { const v = args[k]; return v != null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v }))
      return { data: r.rows[0]?.r ?? null, error: null }
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code || null } }
    }
  }
  return { from, rpc }
}
