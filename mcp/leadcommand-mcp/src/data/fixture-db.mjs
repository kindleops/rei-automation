// FIXTURE data source (tests, local protocol validation, Agntei dry runs).
// A tiny in-memory stand-in for the subset of the supabase-js query builder the
// adapters use. Every row it serves comes from fixtures/*.mjs — synthetic,
// labelled FIXTURE, no real people / phones / addresses. It refuses writes the
// same way the live guarded transport does, so adapter code cannot tell the
// two apart on the read path and cannot write on either.
const WRITE_METHODS = ['insert', 'update', 'upsert', 'delete']

function refuse(code, message) {
  return Object.assign(new Error(message), { code })
}

const cmp = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1)
const toNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? v : Number(v))
const likeRe = (pat) => new RegExp(`^${String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i')

/**
 * @param {{ tables: Record<string, object[]>, rpc?: Record<string, Function>, faults?: { failTables?: string[], failRpcs?: string[], delayMs?: number, errorCode?: string, rpcErrorCode?: string }, onRequest?: Function }} opts
 */
export function createFixtureDb({ tables = {}, rpc = {}, faults = {}, onRequest = null } = {}) {
  const requests = []
  function builder(table) {
    const st = { table, filters: [], order: [], limit: null, cols: '*', count: null, head: false, single: false, signal: null }
    const run = async () => {
      requests.push({ method: st.head ? 'HEAD' : 'GET', table })
      onRequest?.({ method: st.head ? 'HEAD' : 'GET', path: `/rest/v1/${table}`, kind: 'table_read' })
      if (faults.delayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, faults.delayMs)
          st.signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
        })
      }
      if (faults.failTables?.includes(table) || faults.failTables?.includes('*')) return { data: null, error: { code: faults.errorCode || 'PGRST000', message: 'fixture fault' }, count: null }
      if (!Object.prototype.hasOwnProperty.call(tables, table)) return { data: null, error: { code: 'PGRST205', message: 'relation not found' }, count: null }
      let rows = tables[table].filter((r) => st.filters.every((f) => f(r)))
      for (const o of [...st.order].reverse()) rows = [...rows].sort((a, b) => (o.asc ? 1 : -1) * cmp(toNum(a[o.col]), toNum(b[o.col])))
      const count = st.count ? rows.length : null
      if (st.limit != null) rows = rows.slice(0, st.limit)
      const pick = (r) => {
        if (st.cols === '*') return { ...r }
        const out = {}
        for (const c of st.cols.split(',').map((x) => x.trim()).filter(Boolean)) out[c] = r[c] ?? null
        return out
      }
      if (st.head) return { data: null, error: null, count }
      const data = rows.map(pick)
      if (st.single) return { data: data[0] ?? null, error: null, count }
      return { data, error: null, count }
    }
    const b = {
      select(cols = '*', opts = {}) { st.cols = cols.replace(/\s+/g, ''); st.count = opts.count || null; st.head = Boolean(opts.head); return b },
      eq(c, v) { st.filters.push((r) => String(r[c]) === String(v)); return b },
      neq(c, v) { st.filters.push((r) => String(r[c]) !== String(v)); return b },
      in(c, vs) { const s = new Set(vs.map(String)); st.filters.push((r) => s.has(String(r[c]))); return b },
      gt(c, v) { st.filters.push((r) => r[c] != null && toNum(r[c]) > toNum(v)); return b },
      gte(c, v) { st.filters.push((r) => r[c] != null && toNum(r[c]) >= toNum(v)); return b },
      lt(c, v) { st.filters.push((r) => r[c] != null && toNum(r[c]) < toNum(v)); return b },
      lte(c, v) { st.filters.push((r) => r[c] != null && toNum(r[c]) <= toNum(v)); return b },
      ilike(c, p) { const re = likeRe(p); st.filters.push((r) => r[c] != null && re.test(String(r[c]))); return b },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      // PostgREST `or=(a.eq.x,b.eq."y")` — only the eq form the compliance lookup uses
      or(expr) {
        const parts = String(expr).match(/[a-z_0-9]+\.eq\.(?:"(?:[^"]|"")*"|[^,]*)/gi) || []
        const preds = parts.map((p) => { const m = /^([a-z_0-9]+)\.eq\.(.*)$/i.exec(p); const v = m[2].startsWith('"') ? m[2].slice(1, -1).replaceAll('""', '"') : m[2]; return (r) => String(r[m[1]]) === v })
        if (!preds.length) throw refuse('PGRST100', 'unsupported or= expression')
        st.filters.push((r) => preds.some((f) => f(r)))
        return b
      },
      overlaps(c, vs) { st.filters.push((r) => Array.isArray(r[c]) && r[c].some((x) => vs.includes(x))); return b },
      order(col, { ascending = true } = {}) { st.order.push({ col, asc: ascending }); return b },
      limit(n) { st.limit = n; return b },
      abortSignal(s) { st.signal = s; return b },
      maybeSingle() { st.single = true; return b },
      then(res, rej) { return run().then(res, rej) },
    }
    for (const m of WRITE_METHODS) b[m] = () => { throw refuse('WRITE_REFUSED', `${m} on ${table} is not a read`) }
    return b
  }
  return {
    from: builder,
    async rpc(fn, args) {
      requests.push({ method: 'POST', rpc: fn })
      if (!rpc[fn]) return { data: null, error: { code: 'RPC_NOT_ALLOWLISTED', message: 'not allowlisted' } }
      if (faults.failRpcs?.includes(fn) || faults.failRpcs?.includes('*')) return { data: null, error: { code: faults.rpcErrorCode || 'PGRST000', message: 'fixture fault' } }
      // a fixture function refuses like the database does: a thrown { code } becomes PostgREST's { error }
      try { return { data: await rpc[fn](args), error: null } } catch (e) { if (e?.code) return { data: null, error: { code: String(e.code), message: 'fixture function refused' } }; throw e }
    },
    requests,
  }
}
