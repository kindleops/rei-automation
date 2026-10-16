// Operations read sources (8.5.20 part C) — one interface, three implementations:
//
//   createOperationsPgSource({ pool })     production: agent.ops_* SECURITY DEFINER read
//                                          functions over the agent_api pool, inside
//                                          BEGIN READ ONLY + statement_timeout
//   createOperationsSqlSource({ query })   the SAME SQL text (operations-sql.js) through a
//                                          read-only runner (the live proof over the pooler)
//   createOperationsMemorySource(fixture)  tests
//
// interface:
//   conversationFacts({ after_at, after_id, limit }) → raw rows (cursor order)
//   pipelineFacts({ after_id, limit })               → raw rows (id order)
//   supervisorSnapshot({ now })                      → one object
//   briefFacts({ since, until })                     → one object
//   researchValuationSnapshot({ now })               → one object (8.5.21-b; agent.ops_research_valuation_snapshot)
// A read failure throws an Error with code SOURCE_NOT_APPLIED (function / table missing),
// SOURCE_TIMEOUT or SOURCE_UNAVAILABLE. Nothing here writes.
import { OPERATIONS_SQL } from './operations-sql.js'
import { RESEARCH_VALUATION_SNAPSHOT_SQL } from './research-valuation-sql.js'

const NOT_APPLIED = new Set(['42883', '42P01', 'PGRST202', 'PGRST205', '3F000'])
function sourceError(err, what) {
  const c = String(err?.code || '')
  const code = NOT_APPLIED.has(c) ? 'SOURCE_NOT_APPLIED' : c === '57014' ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE'
  return Object.assign(new Error(`${what} read failed`), { code, source: what, pg_code: c || null })
}
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const clampLimit = (n, d = 200) => Math.min(Math.max(Math.trunc(Number(n) || d), 1), 500)
const sortConv = (rows) => rows.sort((a, b) => (iso(a.cursor_at) < iso(b.cursor_at) ? -1 : iso(a.cursor_at) > iso(b.cursor_at) ? 1 : String(a.conversation_id) < String(b.conversation_id) ? -1 : 1))
const sortOpp = (rows) => rows.sort((a, b) => (String(a.opportunity_id) < String(b.opportunity_id) ? -1 : 1))

/** @param {{ pool: import('pg').Pool, statementTimeoutMs?: number }} o */
export function createOperationsPgSource({ pool, statementTimeoutMs = 15_000 } = {}) {
  if (!pool) throw new Error('operations source: pool required')
  const st = Math.min(Math.max(Math.trunc(statementTimeoutMs), 1000), 30_000)
  async function one(sql, params, what) {
    let client
    try { client = await pool.connect() } catch (e) { throw sourceError(e, what) }
    try {
      await client.query('begin read only')
      await client.query(`set local statement_timeout = ${st}`)
      const { rows } = await client.query(sql, params)
      await client.query('rollback')
      return rows[0]?.r ?? null
    } catch (e) {
      try { await client.query('rollback') } catch { /* broken connection */ }
      throw sourceError(e, what)
    } finally {
      client.release()
    }
  }
  return Object.freeze({
    kind: 'postgres',
    async conversationFacts({ after_at = null, after_id = null, limit = 200 } = {}) {
      return sortConv([...((await one('select agent.ops_conversation_facts($1, $2, $3) r', [after_at, after_id, clampLimit(limit)], 'ops_conversation_facts')) || [])])
    },
    async pipelineFacts({ after_id = null, limit = 200 } = {}) {
      return sortOpp([...((await one('select agent.ops_pipeline_facts($1, $2) r', [after_id, clampLimit(limit)], 'ops_pipeline_facts')) || [])])
    },
    supervisorSnapshot: ({ now = null } = {}) => one('select agent.ops_supervisor_snapshot($1) r', [now], 'ops_supervisor_snapshot'),
    briefFacts: ({ since, until = null }) => one('select agent.ops_brief_facts($1, $2) r', [since, until], 'ops_brief_facts'),
    researchValuationSnapshot: ({ now = null } = {}) => one('select agent.ops_research_valuation_snapshot($1) r', [now], 'ops_research_valuation_snapshot'),
  })
}

/** @param {{ query: (sql: string, params: any[]) => Promise<Array<object>> }} o   query MUST run read-only */
export function createOperationsSqlSource({ query }) {
  const run = async (what, sql, params) => {
    try { return await query(sql, params) } catch (e) { throw sourceError(e, what) }
  }
  return Object.freeze({
    kind: 'sql',
    async conversationFacts({ after_at = null, after_id = null, limit = 200 } = {}) {
      return sortConv([...(await run('conversation_facts', OPERATIONS_SQL.conversation_facts, [after_at, after_id, clampLimit(limit)]))])
    },
    async pipelineFacts({ after_id = null, limit = 200 } = {}) {
      return sortOpp([...(await run('pipeline_facts', OPERATIONS_SQL.pipeline_facts, [after_id, clampLimit(limit)]))])
    },
    async supervisorSnapshot({ now = null } = {}) {
      return (await run('supervisor_snapshot', OPERATIONS_SQL.supervisor_snapshot, [now]))[0] || null
    },
    async briefFacts({ since, until = null }) {
      return (await run('brief_facts', OPERATIONS_SQL.brief_facts, [since, until]))[0] || null
    },
    async researchValuationSnapshot({ now = null } = {}) {
      return (await run('research_valuation_snapshot', RESEARCH_VALUATION_SNAPSHOT_SQL, [now]))[0]?.r || null
    },
  })
}

/**
 * Test source. `conversations` / `opportunities` are raw fact rows (the SQL shapes);
 * `fail` maps a method name to an error code to simulate an unavailable source.
 */
export function createOperationsMemorySource({ conversations = [], opportunities = [], snapshot = null, brief = null, researchValuation = null, fail = {} } = {}) {
  const calls = []
  const guard = (m) => { calls.push(m); if (fail[m]) throw Object.assign(new Error(`${m} failed`), { code: fail[m] }) }
  return Object.freeze({
    kind: 'memory',
    calls,
    async conversationFacts({ after_at = null, after_id = null, limit = 200 } = {}) {
      guard('conversationFacts')
      const key = (r) => `${iso(r.cursor_at)}|${r.conversation_id}`
      const after = after_at ? `${iso(after_at)}|${after_id || ''}` : null
      return sortConv(conversations.filter((r) => Number(r.inbound_count ?? 1) > 0).filter((r) => !after || key(r) > after).map((r) => ({ ...r }))).slice(0, clampLimit(limit))
    },
    async pipelineFacts({ after_id = null, limit = 200 } = {}) {
      guard('pipelineFacts')
      return sortOpp(opportunities.filter((r) => ['active', 'nurture'].includes(String(r.opportunity_status || '').toLowerCase())).filter((r) => !after_id || String(r.opportunity_id) > after_id).map((r) => ({ ...r }))).slice(0, clampLimit(limit))
    },
    async supervisorSnapshot() { guard('supervisorSnapshot'); return snapshot },
    async briefFacts() { guard('briefFacts'); return brief },
    async researchValuationSnapshot() { guard('researchValuationSnapshot'); return researchValuation },
  })
}
