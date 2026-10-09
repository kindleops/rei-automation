/**
 * ENTITY GRAPH FACETS — one exact GROUP BY over the cohort, every value.
 *
 * The composition endpoint's categorical facets (market, state, county, city,
 * loan type, …) used to DISCOVER their candidate values from a 1,500-row
 * sample and then count the top nine one query at a time. Measured
 * 2026-10-07 on prod:
 *   - Market showed Miami … Rocky Mount, NC then "Everything else 99,000":
 *     Atlanta, GA (6,397 properties, #8 by size) was not offered at all,
 *     because the sample only chooses what is shown.
 *   - County never loaded: property_address_county_name has no index, so the
 *     total, five OFFSET sample slices and nine bucket counts were each a
 *     5–8 s sequential scan through v_entity_graph_properties, past the 8 s
 *     PostgREST statement timeout.
 *
 * PostgREST aggregates are disabled and a dynamic-SQL RPC is off the table,
 * so the grouped count runs over the API's direct Postgres pool (the same pool
 * the keyset sort uses). The WHERE clause is NOT re-implemented: the list's
 * own filter appliers (applyPropertyFilters / applyEntityGraphFieldFilters)
 * are run against a RECORDER that captures each builder call and translates
 * it to parameterised SQL, so a facet cannot describe a different cohort than
 * the rows beneath it. Any call the recorder does not understand throws
 * FacetUntranslatable and the caller falls back — it never guesses.
 *
 * Identifiers are whitelisted by shape (^[a-z_][a-z0-9_]*$) and quoted; every
 * value is a bind parameter.
 */
import { hasDatabaseUrl, queryWithTimeout } from '@/lib/postgres/client.js'

const IDENT = /^[a-z_][a-z0-9_]*$/
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 200
const cache = new Map()

export class FacetUntranslatable extends Error {
  constructor(detail) {
    super(`facet_untranslatable: ${detail}`)
    this.name = 'FacetUntranslatable'
  }
}

function ident(column) {
  const c = String(column ?? '')
  if (!IDENT.test(c)) throw new FacetUntranslatable(`identifier ${c}`)
  return `"${c}"`
}

const PART_START = /^(?:[a-z_][a-z0-9_]*\.(?:not\.)?(?:eq|neq|gt|gte|lt|lte|ilike|like|is|in)\.|(?:and|or)\()/

/**
 * Split a PostgREST logical expression body at its top-level commas: never
 * inside a "quoted value" or a nested (…) group, and only where the next part
 * starts like a condition (an unquoted comma inside a value stays a value).
 */
export function splitLogicalParts(expression) {
  const text = String(expression ?? '')
  const parts = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '\\') { i += 1; continue }
      if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0 && PART_START.test(text.slice(i + 1).trimStart())) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

const GROUP = /^(and|or)\(([\s\S]*)\)$/
const OR_PART = /^([a-z_][a-z0-9_]*)\.(not\.)?(eq|neq|gt|gte|lt|lte|ilike|like|is|in)\.([\s\S]*)$/

function unquote(raw) {
  const v = String(raw)
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, '$1')
  return v
}

/** A PostgREST `in` list body "(a,b,"c, d")" → values. */
function parseInList(raw) {
  const body = String(raw).trim().replace(/^\(/, '').replace(/\)$/, '')
  if (!body) return []
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '"') { quoted = !quoted; continue }
    if (ch === '\\' && quoted && i + 1 < body.length) { cur += body[i + 1]; i += 1; continue }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((v) => v.trim()).filter((v) => v !== '')
}

/**
 * A stand-in for the supabase-js filter builder. Each method appends one SQL
 * predicate (ANDed); `.or()` appends one parenthesised disjunction.
 */
export function createSqlRecorder() {
  const clauses = []
  const params = []
  const bind = (value) => { params.push(value); return `$${params.length}` }

  const compare = (column, op, value) => {
    const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]
    if (!sqlOp) throw new FacetUntranslatable(`operator ${op}`)
    if (value === null || value === undefined) {
      if (op === 'eq') return `${ident(column)} is null`
      if (op === 'neq') return `${ident(column)} is not null`
      throw new FacetUntranslatable(`null ${op}`)
    }
    // The parameter is sent UNTYPED, so Postgres reads it as the column's own
    // type — the same comparison PostgREST makes. Comparing the column's TEXT
    // form was wrong for numeric(…, 2) columns: total_loan_balance = 0 stores
    // as '0.00', so `total_loan_balance.eq.0` (the known-equity filter's
    // no-loan branch) matched nothing in the facet counts while the list,
    // through PostgREST, matched 4,276 of 8,656 sampled rows (audit 2026-10-09).
    if (typeof value === 'boolean') {
      if (op !== 'eq' && op !== 'neq') throw new FacetUntranslatable(`boolean ${op}`)
      return `${ident(column)} ${op === 'eq' ? 'is' : 'is not'} ${value ? 'true' : 'false'}`
    }
    if (typeof value === 'number') return `${ident(column)} ${sqlOp} ${bind(value)}::numeric`
    return `${ident(column)} ${sqlOp} ${bind(String(value))}`
  }

  const isClause = (column, value, negate = false) => {
    const target = value === null || value === 'null' ? 'null'
      : value === true || value === 'true' ? 'true'
        : value === false || value === 'false' ? 'false' : null
    if (!target) throw new FacetUntranslatable(`is ${value}`)
    return `${ident(column)} is ${negate ? 'not ' : ''}${target}`
  }

  const inClause = (column, values, negate = false) => {
    const list = (Array.isArray(values) ? values : parseInList(values)).map((v) => String(v))
    if (!list.length) throw new FacetUntranslatable('empty in')
    // untyped array parameter: Postgres resolves it as an array of the column's type
    return negate
      ? `not (${ident(column)} = any(${bind(list)}))`
      : `${ident(column)} = any(${bind(list)})`
  }

  const likeClause = (column, pattern, insensitive = true) => `${ident(column)} ${insensitive ? 'ilike' : 'like'} ${bind(String(pattern).replace(/\*/g, '%'))}`

  const orPart = (part) => {
    const group = GROUP.exec(part.trim())
    if (group) {
      const inner = splitLogicalParts(group[2])
      if (!inner.length) throw new FacetUntranslatable(`empty ${group[1]}`)
      return `(${inner.map(orPart).join(group[1] === 'and' ? ' and ' : ' or ')})`
    }
    const m = OR_PART.exec(part.trim())
    if (!m) throw new FacetUntranslatable(`or part ${part}`)
    const [, column, not, op, rawValue] = m
    const value = unquote(rawValue)
    let clause
    if (op === 'is') clause = isClause(column, value)
    else if (op === 'in') clause = inClause(column, rawValue)
    else if (op === 'ilike' || op === 'like') clause = likeClause(column, value, op === 'ilike')
    else clause = compare(column, op, value)
    return not ? `not (${clause})` : clause
  }

  const builder = {
    eq(column, value) { clauses.push(compare(column, 'eq', value)); return builder },
    neq(column, value) { clauses.push(compare(column, 'neq', value)); return builder },
    gt(column, value) { clauses.push(compare(column, 'gt', value)); return builder },
    gte(column, value) { clauses.push(compare(column, 'gte', value)); return builder },
    lt(column, value) { clauses.push(compare(column, 'lt', value)); return builder },
    lte(column, value) { clauses.push(compare(column, 'lte', value)); return builder },
    is(column, value) { clauses.push(isClause(column, value)); return builder },
    in(column, values) { clauses.push(inClause(column, values)); return builder },
    ilike(column, pattern) { clauses.push(likeClause(column, pattern, true)); return builder },
    like(column, pattern) { clauses.push(likeClause(column, pattern, false)); return builder },
    not(column, op, value) {
      if (op === 'is') clauses.push(isClause(column, value, true))
      else if (op === 'in') clauses.push(inClause(column, value, true))
      else if (op === 'eq') clauses.push(compare(column, 'neq', value))
      else if (op === 'like' || op === 'ilike') clauses.push(`not (${likeClause(column, value, op === 'ilike')})`)
      else throw new FacetUntranslatable(`not ${op}`)
      return builder
    },
    or(expression) {
      const parts = splitLogicalParts(expression)
      if (!parts.length) throw new FacetUntranslatable('empty or')
      clauses.push(`(${parts.map(orPart).join(' or ')})`)
      return builder
    },
    overlaps(column, values) {
      const list = (Array.isArray(values) ? values : [values]).map(String)
      clauses.push(`${ident(column)} && ${bind(list)}::text[]`)
      return builder
    },
    contains(column, values) {
      if (!Array.isArray(values)) throw new FacetUntranslatable('contains non-array')
      clauses.push(`${ident(column)} @> ${bind(values.map(String))}::text[]`)
      return builder
    },
  }
  return { builder, clauses, params }
}

/** Translate the list's own filter appliers into a WHERE clause. Throws FacetUntranslatable. */
export function compileFacetWhere(applyFilters) {
  const recorder = createSqlRecorder()
  let result
  try {
    result = applyFilters(recorder.builder)
  } catch (error) {
    // A builder method the recorder does not implement surfaces as a TypeError.
    if (error instanceof TypeError) throw new FacetUntranslatable(error.message)
    throw error
  }
  if (result && result !== recorder.builder) throw new FacetUntranslatable('applier returned a foreign builder')
  return { where: recorder.clauses.length ? `where ${recorder.clauses.join(' and ')}` : '', params: recorder.params }
}

export function facetsAvailable() {
  return hasDatabaseUrl()
}

/**
 * Exact count of every value of `column` in the cohort, one GROUP BY.
 * Returns [{ value: string | null, count: number }] (null = not recorded).
 */
export async function groupedFacetCounts({ source, column, applyFilters = (b) => b, query = queryWithTimeout, timeoutMs = 25_000, now = Date.now() }) {
  const { where, params } = compileFacetWhere(applyFilters)
  const sql = `select nullif(btrim(${ident(column)}::text), '') as value, count(*)::bigint as n from public.${ident(source)} ${where} group by 1`
  const key = `${sql}|${JSON.stringify(params)}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.rows

  const result = await query(sql, params, timeoutMs)
  // nullif + btrim can split one stored value into the same bucket twice; fold.
  const folded = new Map()
  for (const row of result?.rows || []) {
    const value = row.value === null || row.value === undefined ? null : String(row.value)
    folded.set(value, (folded.get(value) || 0) + Number(row.n || 0))
  }
  const rows = [...folded.entries()].map(([value, count]) => ({ value, count }))
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: now, rows })
  return rows
}

/**
 * Exact count of every TOKEN of a jsonb array column (property flags) in the
 * cohort, plus the cohort size. Tokens are not exclusive — a property carries
 * several — so the counts do not add up to the total (callers say so).
 */
export async function groupedTokenCounts({ source, column, split = null, applyFilters = (b) => b, query = queryWithTimeout, timeoutMs = 25_000, now = Date.now() }) {
  const { where, params: whereParams } = compileFacetWhere(applyFilters)
  const col = ident(column)
  const params = [...whereParams]
  // `split` = a delimited TEXT column ("a; b", "a, b"); otherwise a jsonb array.
  const tokens = split
    ? (() => {
        const core = String(split).trim() || String(split)
        params.push(`\\s*${core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`)
        return `regexp_split_to_table(coalesce(${col}::text, ''), $${params.length})`
      })()
    : `jsonb_array_elements_text(case when jsonb_typeof(${col}) = 'array' then ${col} else '[]'::jsonb end)`
  const sql = `select btrim(u.v) as value, count(*)::bigint as n from public.${ident(source)} cross join lateral ${tokens} as u(v) ${where} group by 1`
  const totalSql = `select count(*)::bigint as n from public.${ident(source)} ${where}`
  const key = `${sql}|${JSON.stringify(params)}`
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.rows
  const [grouped, counted] = await Promise.all([query(sql, params, timeoutMs), query(totalSql, whereParams, timeoutMs)])
  const folded = new Map()
  for (const row of grouped?.rows || []) {
    const value = String(row.value ?? '').trim()
    if (value) folded.set(value, (folded.get(value) || 0) + Number(row.n || 0))
  }
  const rows = { tokens: [...folded.entries()].map(([value, count]) => ({ value, count })), total: Number(counted?.rows?.[0]?.n ?? 0) }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: now, rows })
  return rows
}

export const __facetCacheTest = { reset: () => cache.clear() }
