/**
 * A programmable, chainable stand-in for the Supabase client used by the
 * Command Wall tests. `handlers[table](query)` returns { data, error, count };
 * `rpcs[name](args)` likewise. Every executed query is recorded in `log`, so a
 * test can assert exactly how many reads a tick or snapshot costs.
 */
export function createFakeDb({ handlers = {}, rpcs = {} } = {}) {
  const log = []
  const from = (table) => {
    const q = { table, filters: [], order: null, limit: null, select: null, head: false, count: null, op: 'select', payload: null }
    const exec = async () => {
      log.push({ table, filters: q.filters, op: q.op })
      const h = handlers[table]
      if (!h) return { data: [], error: null, count: 0 }
      try {
        const out = await h(q)
        return { data: out?.data ?? null, error: out?.error ?? null, count: out?.count ?? null }
      } catch (error) {
        return { data: null, error }
      }
    }
    const builder = {
      select(cols, opts = {}) { q.select = cols; q.head = Boolean(opts.head); q.count = opts.count || null; return builder },
      insert(row) { q.op = 'insert'; q.payload = row; return builder },
      update(row) { q.op = 'update'; q.payload = row; return builder },
      eq(k, v) { q.filters.push(['eq', k, v]); return builder },
      neq(k, v) { q.filters.push(['neq', k, v]); return builder },
      gt(k, v) { q.filters.push(['gt', k, v]); return builder },
      gte(k, v) { q.filters.push(['gte', k, v]); return builder },
      lt(k, v) { q.filters.push(['lt', k, v]); return builder },
      in(k, v) { q.filters.push(['in', k, v]); return builder },
      is(k, v) { q.filters.push(['is', k, v]); return builder },
      order(k, o) { q.order = [k, o]; return builder },
      limit(n) { q.limit = n; return builder },
      then(resolve, reject) { return exec().then(resolve, reject) },
    }
    return builder
  }
  return {
    log,
    from,
    async rpc(name, args) {
      log.push({ rpc: name })
      const h = rpcs[name]
      if (!h) return { data: null, error: { code: 'PGRST202', message: 'rpc missing' } }
      try { return { data: await h(args), error: null } } catch (error) { return { data: null, error } }
    },
  }
}
