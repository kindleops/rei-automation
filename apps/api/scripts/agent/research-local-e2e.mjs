#!/usr/bin/env node
// READ-ONLY research agent — LOCAL end-to-end proof (R1, 10-12): the real ask
// service + the real streamed provider + the real research registry, against real
// data through a DATABASE-ENFORCED read-only connection. Nothing is deployed, no
// production route is called, no row is written anywhere (the run / audit / ledger
// live in the in-memory store twin, which mirrors the DB cap rules).
//
//   AGENT_E2E_KEY_ENV_FILE=apps/api/.env.local      (holds ANTHROPIC_API_KEY=…; read, never printed)
//   AGENT_E2E_DB_URL_FILE=/tmp/.dburl.ro            (a postgres URL; every query runs in BEGIN READ ONLY)
//   AGENT_E2E_SPEND_USD=0.10                        (the day cap the budget engine enforces; default 0.10)
//   node --import ./tests/register-aliases.mjs scripts/agent/research-local-e2e.mjs
//
// Data path: a minimal PostgREST-shaped builder over pg (from/select/eq/in/ilike/
// order/limit), table + column names validated, values parameterized, each read
// inside `begin read only; set local statement_timeout = '5s'` — Postgres itself
// refuses any write. The Entity Graph dossier service is not wired (the tools that
// need it report "unavailable", which is the honest outcome).
//
// Prints models, per-call tokens / cost (ledger vs a re-computation from usage),
// tool calls, latency and whether the wire was a stream. Never prints the key, the
// DB URL, phone numbers or names; the answer is printed only as a short excerpt.
import fs from 'node:fs'
import pg from 'pg'
import { createAnthropicProvider } from '../../src/lib/ai/anthropic-provider.js'
import { createModelResolver, actualUsd } from '../../src/lib/agent/research/models.js'
import { createResearchMemoryStore } from '../../src/lib/agent/research/research-store.js'
import { createResearchToolRegistry } from '../../src/lib/agent/research/research-tools.js'
import { createAskService } from '../../src/lib/agent/research/ask-service.js'

const keyFile = process.env.AGENT_E2E_KEY_ENV_FILE
const dbFile = process.env.AGENT_E2E_DB_URL_FILE
if (!keyFile || !dbFile) { console.error('set AGENT_E2E_KEY_ENV_FILE and AGENT_E2E_DB_URL_FILE'); process.exit(2) }
const key = (/^ANTHROPIC_API_KEY=(.*)$/m.exec(fs.readFileSync(keyFile, 'utf8'))?.[1] || '').trim().replace(/^["']|["']$/g, '')
if (!key) { console.error('no ANTHROPIC_API_KEY in the key file'); process.exit(2) }
const spend = String(Math.min(Number(process.env.AGENT_E2E_SPEND_USD || 0.1), 0.25))

const pool = new pg.Pool({ connectionString: fs.readFileSync(dbFile, 'utf8').trim(), max: 2, ssl: { rejectUnauthorized: false } })
const TABLES = new Set(['properties', 'campaign_target_graph', 'probate_status', 'preforeclosure_status_v2', 'eg_property_facts', 'campaigns', 'campaign_targets'])
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/
const reads = []

function roDb() {
  function from(table) {
    if (!TABLES.has(table)) throw new Error(`table ${table} not allowlisted`)
    const st = { cols: '*', where: [], params: [], order: null, limit: 25, head: false, count: false }
    const col = (c) => { if (!IDENT.test(c)) throw new Error(`bad column ${c}`); return `"${c}"` }
    const api = {
      select(cols = '*', o = {}) { st.cols = cols; st.head = Boolean(o.head); st.count = Boolean(o.count); return api },
      eq(k, v) { st.params.push(String(v)); st.where.push(`${col(k)}::text = $${st.params.length}`); return api },
      in(k, vs) { st.params.push(vs.map(String)); st.where.push(`${col(k)}::text = any($${st.params.length}::text[])`); return api },
      ilike(k, p) { st.params.push(String(p)); st.where.push(`${col(k)} ilike $${st.params.length}`); return api },
      order(k, o = {}) { st.order = `${col(k)} ${o.ascending === false ? 'desc' : 'asc'} nulls last`; return api },
      limit(n) { st.limit = Math.min(Number(n) || 25, 200); return api },
      abortSignal() { return api },
      async then(res, rej) {
        const cols = st.cols === '*' ? '*' : st.cols.split(',').map((c) => col(c.trim())).join(',')
        const where = st.where.length ? ` where ${st.where.join(' and ')}` : ''
        const sql = st.head ? `select count(*)::int n from public."${table}"${where}` : `select ${cols} from public."${table}"${where}${st.order ? ` order by ${st.order}` : ''} limit ${st.limit}`
        const c = await pool.connect()
        const t0 = Date.now()
        try {
          await c.query('begin read only')
          await c.query("set local statement_timeout = '5s'")
          const r = await c.query(sql, st.params)
          await c.query('commit')
          reads.push({ table, rows: r.rowCount, ms: Date.now() - t0 })
          return res(st.head ? { data: null, error: null, count: r.rows[0].n } : { data: r.rows, error: null, count: null })
        } catch (err) {
          await c.query('rollback').catch(() => {})
          reads.push({ table, rows: 0, ms: Date.now() - t0, error: err.code || 'ERR' })
          return res({ data: null, error: { code: err.code || 'ERR', message: 'read failed' }, count: null })
        } finally {
          c.release()
        }
      },
    }
    return api
  }
  return { from, rpc: async () => ({ data: null, error: { code: 'RPC_NOT_WIRED' } }) }
}

// wire evidence: was the response a server-sent-event stream? (content-type + bytes; no bodies printed)
const wire = []
const baseFetch = async (url, init) => {
  const res = await globalThis.fetch(url, init)
  const path = new URL(String(url)).pathname
  if (path.endsWith('/messages')) {
    let stream = null
    try { stream = JSON.parse(String(init?.body || '{}')).stream === true } catch { /* not JSON */ }
    wire.push({ path, status: res.status, request_stream: stream, content_type: res.headers.get('content-type') })
  }
  return res
}

const env = { NODE_ENV: 'development', AGENT_ENABLED: '1', AGENT_LIVE_ROUTES: '1', AGENT_RESEARCH_ENABLED: '1', AGENT_MAX_MODE: 'read', AGENT_SPEND_GLOBAL_DAILY_USD: spend, AGENT_SPEND_USER_DAILY_USD: spend, AGENT_SPEND_CYCLE_USD: spend }
const provider = createAnthropicProvider({ env: { NODE_ENV: 'development', ANTHROPIC_API_KEY: key }, baseFetch })
const store = createResearchMemoryStore({ limits: { day_usd: Number(spend), cycle_usd: Number(spend) } })
const resolver = createModelResolver({ provider, env })
const registry = createResearchToolRegistry()
const ask = createAskService({ store, registry, provider, resolver, createServices: () => ({ db: roDb() }), env })
const OWNER = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const identity = { verified: true, named: true, user_id: OWNER, method: 'local_e2e' }

const flows = [
  { name: 'address only → eg.property_lookup → evidence', question: 'Find the property at 1947 Johnson St NE in Minneapolis, MN and summarize its distress signals. Cite tools.', context: {} },
  { name: 'id in text + context.property_id alias', question: 'What distress evidence do we have for property 273435535 (1947 Johnson St NE)? Cite tools.', context: { property_id: '273435535' } },
]

const models = await resolver.resolve()
console.log('models', { ok: models.ok, default: models.default?.id, escalation: models.escalation?.id, listed: models.listed_ids.length, reason: models.reason || null })
const summary = []
for (const f of flows) {
  const t0 = Date.now()
  const { run_id, done } = await ask.ask({ operator_id: OWNER, identity, question: f.question, context: f.context })
  const r = await done
  const s = await ask.status(run_id, OWNER)
  const ledger = store._state.ledger.filter((l) => l.run_id === run_id)
  console.log(`\n===== ${f.name} — ${s.state} (${s.outcome}) in ${Date.now() - t0} ms =====`)
  if (s.refusal) console.log('refusal', s.refusal)
  s.calls.forEach((c, i) => {
    const l = ledger.filter((x) => x.state === 'settled')[i]
    const recomputed = actualUsd(c.model, { input_tokens: c.input_tokens, output_tokens: c.output_tokens, cache_read_input_tokens: c.cache_read_input_tokens, cache_creation_input_tokens: c.cache_creation_input_tokens })
    console.log(`  call ${i + 1} ${c.model} [${c.route}] stop=${c.stop} ${c.latency_ms} ms in=${c.input_tokens} out=${c.output_tokens} cache_read=${c.cache_read_input_tokens} cache_write=${c.cache_creation_input_tokens} cost=$${c.cost_usd} ledger=$${l?.actual_usd} recomputed=$${recomputed?.usd} match=${l?.actual_usd === recomputed?.usd && c.cost_usd === recomputed?.usd}`)
  })
  for (const a of s.audit.filter((x) => x.kind === 'tool_call' || x.kind === 'tool_refused')) console.log(`  tool ${a.name} → ${a.outcome} rows=${a.rows_returned} ${a.latency_ms ?? '-'} ms`)
  const ans = String(r.answer_md || '')
  console.log(`  answer: ${ans.length} chars; property id present: ${/273435535/.test(ans)}; masked-phone tokens: ${(ans.match(/•••-••/g) || []).length}`)
  console.log(`  excerpt: ${ans.replace(/\s+/g, ' ').slice(0, 220)}`)
  summary.push({ flow: f.name, state: s.state, outcome: s.outcome, latency_ms: s.latency_ms, cost_usd: s.cost_usd, model_calls: s.counters.model_calls, tool_calls: s.counters.tool_calls, ledger_states: [...new Set(ledger.map((l) => l.state))].join(',') })
}
console.log('\nwire', wire)
console.log('db reads', reads)
console.table(summary)
const totals = await store.totals({})
console.log('total spend (ledger, all runs) $', totals.day_usd, 'cap $', spend)
await pool.end()
