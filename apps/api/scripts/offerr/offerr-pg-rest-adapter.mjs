/**
 * Minimal PostgREST-shaped adapter over a real Postgres connection (`pg`).
 *
 * Purpose: run the REAL createSupabaseOfferrEvaluationStore() code path — not a
 * hand-written test double of it — against a REAL Postgres database, so that
 * idempotency, the 23505 conflict branch, the compensating delete, and
 * concurrency are proven by actual database constraints rather than by an
 * in-memory imitation.
 *
 * It implements only the surface the Offerr store uses:
 *   .from(t).select(cols).eq(c,v).order(c,{ascending}).limit(n).maybeSingle()/.single()
 *   .from(t).insert(row).select(cols).single()
 *   .from(t).insert(row)                       (awaited directly)
 *   .from(t).delete().eq(c,v)
 *
 * The Supabase error shape is reproduced faithfully: { data, error } envelopes
 * where error carries the Postgres SQLSTATE in `.code` (the store branches on
 * 23505 to detect an idempotency-key race).
 *
 * Every operation is recorded so a caller can prove which tables were touched.
 * NOT production code — verification tooling only.
 */

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ident(name) {
  const value = String(name ?? '');
  if (!IDENT.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

function toPgError(error) {
  if (!error) return null;
  return {
    code: error.code ?? 'UNKNOWN',
    message: error.message ?? String(error),
    details: error.detail ?? null,
    hint: error.hint ?? null,
  };
}

function encode(value) {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ onOperation?: (op: object) => void }} [options]
 */
export function createPgRestAdapter(pool, options = {}) {
  const operations = [];
  const record = (op) => {
    operations.push(op);
    options.onOperation?.(op);
  };

  function makeBuilder({ table, kind, payload = null }) {
    const state = {
      filters: [],
      orderBy: null,
      limitCount: null,
      returning: false,
    };

    async function run() {
      const params = [];
      const where = state.filters.map((f) => {
        params.push(encode(f.value));
        const op = f.op === 'ilike' ? 'ILIKE' : '=';
        return `${ident(f.column)} ${op} $${params.length}`;
      });
      const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

      let sql;
      if (kind === 'select') {
        const order = state.orderBy
          ? ` ORDER BY ${ident(state.orderBy.column)} ${state.orderBy.ascending ? 'ASC' : 'DESC'}`
          : '';
        const limit = state.limitCount != null ? ` LIMIT ${Number(state.limitCount)}` : '';
        sql = `SELECT * FROM ${ident(table)}${whereSql}${order}${limit}`;
      } else if (kind === 'insert') {
        const rows = Array.isArray(payload) ? payload : [payload];
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))].filter(
          (c) => rows.some((r) => r?.[c] !== undefined),
        );
        if (cols.length === 0) throw new Error('insert with no columns');
        const tuples = rows.map(
          (row) =>
            `(${cols
              .map((c) => {
                params.push(encode(row?.[c]));
                return `$${params.length}`;
              })
              .join(', ')})`,
        );
        sql =
          `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) ` +
          `VALUES ${tuples.join(', ')}` +
          (state.returning ? ' RETURNING *' : '');
      } else if (kind === 'delete') {
        sql = `DELETE FROM ${ident(table)}${whereSql}` + (state.returning ? ' RETURNING *' : '');
      } else {
        throw new Error(`unsupported operation kind: ${kind}`);
      }

      const started = Date.now();
      try {
        const result = await pool.query(sql, params);
        record({
          table,
          method: kind,
          ok: true,
          row_count: result.rowCount,
          duration_ms: Date.now() - started,
        });
        return { data: result.rows, error: null };
      } catch (error) {
        record({
          table,
          method: kind,
          ok: false,
          code: error.code,
          duration_ms: Date.now() - started,
        });
        return { data: null, error: toPgError(error) };
      }
    }

    const api = {
      select() {
        state.returning = true;
        return api;
      },
      eq(column, value) {
        state.filters.push({ column, value, op: 'eq' });
        return api;
      },
      ilike(column, pattern) {
        state.filters.push({ column, value: pattern, op: 'ilike' });
        return api;
      },
      order(column, opts = {}) {
        state.orderBy = { column, ascending: opts.ascending !== false };
        return api;
      },
      limit(count) {
        state.limitCount = count;
        return api;
      },
      async maybeSingle() {
        const { data, error } = await run();
        if (error) return { data: null, error };
        return { data: data.length ? data[0] : null, error: null };
      },
      async single() {
        const { data, error } = await run();
        if (error) return { data: null, error };
        if (!data.length) {
          return {
            data: null,
            error: {
              code: 'PGRST116',
              message: 'JSON object requested, multiple (or no) rows returned',
            },
          };
        }
        return { data: data[0], error: null };
      },
      // Awaiting the builder directly executes it (PostgREST thenable contract).
      then(resolve, reject) {
        return run().then(resolve, reject);
      },
    };
    return api;
  }

  return {
    _operations: operations,
    _reset() {
      operations.length = 0;
    },
    from(table) {
      return {
        select: () => makeBuilder({ table, kind: 'select' }).select(),
        insert: (payload) => makeBuilder({ table, kind: 'insert', payload }),
        delete: () => makeBuilder({ table, kind: 'delete' }),
      };
    },
  };
}

export default { createPgRestAdapter };
