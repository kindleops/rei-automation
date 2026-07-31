/**
 * Minimal PostgREST-shaped adapter over a real Postgres connection (`pg`).
 *
 * Purpose: run the REAL application code paths — not hand-written test doubles
 * of them — against a REAL Postgres database, so that comp retrieval,
 * idempotency, the 23505 conflict branch, the compensating delete, and
 * concurrency are proven by actual database behaviour rather than by an
 * in-memory imitation.
 *
 * It implements exactly the surface the Offerr spine and the acquisition comp
 * path use, and nothing more:
 *
 *   .rpc(fn, args)                                   -> comp candidate retrieval
 *   .from(t).select(cols).eq/.in/.gte/.lte/.ilike(...)
 *          .order(c,{ascending}).limit(n).maybeSingle()/.single()
 *   .from(t).insert(row).select(cols).single()
 *   .from(t).insert(row)                             (awaited directly)
 *   .from(t).delete().eq(c,v)
 *
 * Two behaviours matter for fidelity and are implemented deliberately:
 *
 *   1. COLUMN PROJECTION IS REAL. `.select('a,b,c')` emits `SELECT a, b, c`,
 *      not `SELECT *`. A column the application asks for but the database does
 *      not have therefore raises SQLSTATE 42703, which is what drives
 *      acquisitionDecisionEngine's optionalEnrichmentQuery column-narrowing
 *      retry loop. With `SELECT *` that loop could never execute and a missing
 *      column would be silently undefined instead of detected.
 *
 *   2. THE SUPABASE ERROR ENVELOPE IS REPRODUCED FAITHFULLY: `{ data, error }`
 *      where error carries the Postgres SQLSTATE in `.code`. The store branches
 *      on 23505 to detect an idempotency-key race, and the engine branches on
 *      42P01 to treat a source as optional-missing.
 *
 * Every operation is recorded so a caller can prove which tables were touched
 * and that the comp path performed no writes.
 *
 * NOT production code — verification tooling only.
 */

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ident(name) {
  const value = String(name ?? '');
  if (!IDENT.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

/** `'a, b , c'` -> `"a", "b", "c"`; `'*'` (or empty) -> `*`. */
function projection(select) {
  const raw = String(select ?? '*').trim();
  if (!raw || raw === '*') return '*';
  const cols = raw.split(',').map((c) => c.trim()).filter(Boolean);
  if (!cols.length) return '*';
  return cols.map(ident).join(', ');
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
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
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
      columns: '*',
    };

    async function run() {
      const params = [];
      const where = state.filters.map((f) => {
        if (f.op === 'in') {
          // An empty IN list must match nothing, exactly like PostgREST.
          if (!f.value.length) return 'FALSE';
          const placeholders = f.value.map((v) => {
            params.push(encode(v));
            return `$${params.length}`;
          });
          return `${ident(f.column)} IN (${placeholders.join(', ')})`;
        }
        params.push(encode(f.value));
        const op = { eq: '=', ilike: 'ILIKE', gte: '>=', lte: '<=', gt: '>', lt: '<' }[f.op] ?? '=';
        return `${ident(f.column)} ${op} $${params.length}`;
      });
      const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

      let sql;
      if (kind === 'select') {
        const order = state.orderBy
          ? ` ORDER BY ${ident(state.orderBy.column)} ${state.orderBy.ascending ? 'ASC' : 'DESC'}`
          : '';
        const limit = state.limitCount != null ? ` LIMIT ${Number(state.limitCount)}` : '';
        sql = `SELECT ${projection(state.columns)} FROM ${ident(table)}${whereSql}${order}${limit}`;
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
          (state.returning ? ` RETURNING ${projection(state.columns)}` : '');
      } else if (kind === 'delete') {
        sql =
          `DELETE FROM ${ident(table)}${whereSql}` +
          (state.returning ? ` RETURNING ${projection(state.columns)}` : '');
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

    const filter = (op) => (column, value) => {
      state.filters.push({ column, value, op });
      return api;
    };

    const api = {
      select(columns) {
        state.returning = true;
        if (columns !== undefined) state.columns = columns;
        return api;
      },
      eq: filter('eq'),
      ilike: filter('ilike'),
      gte: filter('gte'),
      lte: filter('lte'),
      gt: filter('gt'),
      lt: filter('lt'),
      in(column, values) {
        state.filters.push({ column, value: Array.isArray(values) ? values : [values], op: 'in' });
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
        select: (columns) => makeBuilder({ table, kind: 'select' }).select(columns),
        insert: (payload) => makeBuilder({ table, kind: 'insert', payload }),
        delete: () => makeBuilder({ table, kind: 'delete' }),
      };
    },
    /**
     * PostgREST `.rpc(fn, args)`. Supabase sends named arguments, so this emits
     * `SELECT * FROM fn(name := $n, ...)` — argument ORDER is irrelevant and a
     * renamed parameter surfaces as a real "function does not exist" error
     * (42883) exactly as it would against PostgREST.
     *
     * A set-returning function yields rows; a scalar function yields its value.
     */
    async rpc(fnName, args = {}) {
      const params = [];
      const named = Object.entries(args ?? {}).map(([key, value]) => {
        params.push(encode(value));
        return `${ident(key)} => $${params.length}`;
      });
      const sql = `SELECT * FROM ${ident(fnName)}(${named.join(', ')})`;
      const started = Date.now();
      try {
        const result = await pool.query(sql, params);
        record({
          table: `rpc:${fnName}`,
          method: 'rpc',
          ok: true,
          row_count: result.rowCount,
          duration_ms: Date.now() - started,
        });
        return { data: result.rows, error: null };
      } catch (error) {
        record({
          table: `rpc:${fnName}`,
          method: 'rpc',
          ok: false,
          code: error.code,
          duration_ms: Date.now() - started,
        });
        return { data: null, error: toPgError(error) };
      }
    },
  };
}

export default { createPgRestAdapter };
