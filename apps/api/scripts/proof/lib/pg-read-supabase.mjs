// READ-ONLY supabase-js-shaped client over ONE pg connection inside BEGIN READ ONLY (proof tooling,
// 8.5.21-b). It lets the EXISTING Decision Engine (ensurePropertyAcquisitionDecision → scoreProperty)
// read production through the pooler for a dry run WITHOUT PostgREST:
//   from(t).select(cols).eq/neq/gt/gte/lt/lte/in/is/not(c,'is',null)/order/limit → await | maybeSingle | single
//   rpc(fn, { p_a: v, … })  → select * from public.fn(p_a => $1, …)
// Every statement runs inside a SAVEPOINT so a missing column / relation (42703 / 42P01) is returned
// as { error } exactly like PostgREST (the engine's optional-source handling relies on it) without
// aborting the read-only transaction. insert / upsert / update / delete do not exist here, and the
// transaction itself is READ ONLY (the database refuses any write).
const IDENT = /^[a-z_][a-z0-9_]*$/i

function quoteIdent(c) {
  if (!IDENT.test(c)) throw Object.assign(new Error(`unsupported identifier ${c}`), { code: 'SHIM_IDENT' })
  return `"${c}"`
}

function selectList(cols) {
  const raw = String(cols || '*').trim()
  if (raw === '*') return '*'
  return raw.split(',').map((x) => x.trim()).filter(Boolean).map((part) => {
    const m = /^([a-z_][a-z0-9_]*):(.+)$/i.exec(part)
    const alias = m ? m[1] : null
    const expr = m ? m[2] : part
    // json path: col->a->>b
    const jm = /^([a-z_][a-z0-9_]*)((?:->>?[a-z_][a-z0-9_]*)+)$/i.exec(expr)
    if (jm) {
      const path = [...jm[2].matchAll(/(->>?)([a-z_][a-z0-9_]*)/gi)].map(([, op, k]) => `${op}'${k}'`).join('')
      return `${quoteIdent(jm[1])}${path} as ${quoteIdent(alias || [...jm[2].matchAll(/([a-z_][a-z0-9_]*)/gi)].pop()[1])}`
    }
    return alias ? `${quoteIdent(expr)} as ${quoteIdent(alias)}` : quoteIdent(expr)
  }).join(', ')
}

export function createPgReadSupabase({ client, schema = 'public', stats = { queries: 0, errors: 0, rows: 0 } } = {}) {
  let sp = 0
  // ONE connection: concurrent engine reads (Promise.all) are serialized so savepoints never interleave
  let chain = Promise.resolve()
  function run(sql, params) {
    const p = chain.then(() => runOne(sql, params))
    chain = p.then(() => undefined, () => undefined)
    return p
  }
  async function runOne(sql, params) {
    const name = `lc_sp_${++sp}`
    await client.query(`savepoint ${name}`)
    try {
      const r = await client.query(sql, params)
      await client.query(`release savepoint ${name}`)
      stats.queries += 1
      stats.rows += r.rows.length
      return { data: r.rows, error: null }
    } catch (e) {
      await client.query(`rollback to savepoint ${name}`)
      stats.errors += 1
      return { data: null, error: { code: e.code || 'SHIM_ERROR', message: String(e.message || ''), details: null, hint: null } }
    }
  }
  function builder(table) {
    const st = { cols: '*', where: [], params: [], order: [], limit: null }
    const p = (v) => { st.params.push(v); return `$${st.params.length}` }
    const exec = async (mode) => {
      const w = st.where.length ? ` where ${st.where.join(' and ')}` : ''
      const o = st.order.length ? ` order by ${st.order.join(', ')}` : ''
      const l = mode === 'one' ? ' limit 2' : st.limit != null ? ` limit ${Number(st.limit)}` : ''
      let cols
      try { cols = selectList(st.cols) } catch (e) { return { data: null, error: { code: '42703', message: e.message } } }
      const r = await run(`select ${cols} from ${quoteIdent(schema)}.${quoteIdent(table)}${w}${o}${l}`, st.params)
      if (r.error) return r
      if (mode === 'one') return r.data.length > 1 ? { data: null, error: { code: 'PGRST116', message: 'multiple rows' } } : { data: r.data[0] || null, error: null }
      if (mode === 'single') return r.data.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { code: 'PGRST116', message: `${r.data.length} rows` } }
      return r
    }
    const self = {
      select(cols = '*') { st.cols = cols; return self },
      eq(c, v) { st.where.push(`${quoteIdent(c)} = ${p(v)}`); return self },
      neq(c, v) { st.where.push(`${quoteIdent(c)} <> ${p(v)}`); return self },
      gt(c, v) { st.where.push(`${quoteIdent(c)} > ${p(v)}`); return self },
      gte(c, v) { st.where.push(`${quoteIdent(c)} >= ${p(v)}`); return self },
      lt(c, v) { st.where.push(`${quoteIdent(c)} < ${p(v)}`); return self },
      lte(c, v) { st.where.push(`${quoteIdent(c)} <= ${p(v)}`); return self },
      in(c, vs) { st.where.push(`${quoteIdent(c)}::text = any(${p((vs || []).map(String))}::text[])`); return self },
      is(c, v) { st.where.push(`${quoteIdent(c)} is ${v === null ? 'null' : v ? 'true' : 'false'}`); return self },
      not(c, op, v) { if (op === 'is' && v === null) st.where.push(`${quoteIdent(c)} is not null`); else st.where.push(`not (${quoteIdent(c)} = ${p(v)})`); return self },
      order(c, { ascending = true, nullsFirst = false } = {}) { st.order.push(`${quoteIdent(c)} ${ascending ? 'asc' : 'desc'} nulls ${nullsFirst ? 'first' : 'last'}`); return self },
      limit(n) { st.limit = Math.max(0, Math.trunc(Number(n) || 0)); return self },
      maybeSingle() { return exec('one') },
      single() { return exec('single') },
      then(res, rej) { return exec('many').then(res, rej) },
    }
    return self
  }
  return Object.freeze({
    stats,
    from: (t) => builder(t),
    async rpc(fn, args = {}) {
      const keys = Object.keys(args || {})
      const params = keys.map((k) => args[k])
      return run(`select * from ${quoteIdent(schema)}.${quoteIdent(fn)}(${keys.map((k, i) => `${quoteIdent(k)} => $${i + 1}`).join(', ')})`, params)
    },
  })
}
