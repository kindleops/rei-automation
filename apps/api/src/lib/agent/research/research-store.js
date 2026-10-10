// Durable store for the read-only research agent: runs, the append-only audit,
// and the reserve → settle spend ledger (PROPOSED_20261010130000_agent_research_ro.sql).
//
// FAIL CLOSED: every method throws on any database error; the caller stops the
// run before the next model call or tool result. The cap authority is the DB
// trigger agent.spend_ledger_guard (serialized; refuses day / cycle / run /
// escalation overruns and a switched-off agent.research_limits). The memory store
// below mirrors those exact rules for unit tests only — it is refused in production.
import crypto from 'node:crypto'
import { AgentError } from '../runtime/store.js'
import { DEFAULT_ORG_ID } from '../runtime/pg-store.js'
import { round6 } from '../budget/budget-config.js'

const CODE_RE = /^(AGENT_[A-Z_]+)/

function pgError(err, fallback = 'AGENT_STORE_UNAVAILABLE') {
  const m = CODE_RE.exec(String(err?.message || ''))
  const e = new AgentError(m ? m[1] : fallback, m ? m[1] : 'research store unavailable')
  e.refusal = Boolean(m)
  return e
}

export const committedOf = (r) => (r.state === 'settled' ? Number(r.actual_usd) : r.state === 'released' ? 0 : Number(r.reserved_usd))

const utcDay = (d) => d.toISOString().slice(0, 10)
const utcCycle = (d) => d.toISOString().slice(0, 7)

/** @param {{ pool: import('pg').Pool, org_id?: string, statementTimeoutMs?: number }} opts */
export function createResearchPgStore({ pool, org_id = DEFAULT_ORG_ID, statementTimeoutMs = 15_000 } = {}) {
  if (!pool) throw new AgentError('RESEARCH_STORE_POOL_REQUIRED', 'a pg Pool is required')

  async function tx(fn) {
    let client
    try {
      client = await pool.connect()
    } catch (err) {
      throw pgError(err)
    }
    try {
      await client.query('begin isolation level read committed')
      await client.query(`set local statement_timeout = ${Number(statementTimeoutMs) | 0}`)
      const out = await fn(client)
      await client.query('commit')
      return out
    } catch (err) {
      try { await client.query('rollback') } catch { /* connection already broken */ }
      if (err instanceof AgentError) throw err
      throw pgError(err)
    } finally {
      client.release()
    }
  }
  const q = (sql, params) => tx((c) => c.query(sql, params))

  return Object.freeze({
    kind: 'postgres',
    async assertLeastPrivilege() {
      const { rows } = await q('select rolsuper, rolbypassrls from pg_roles where rolname = current_user')
      if (!rows[0] || rows[0].rolsuper || rows[0].rolbypassrls) throw new AgentError('AGENT_STORE_ROLE_PRIVILEGED', 'the research store must connect as agent_api (no superuser, no BYPASSRLS)')
      return true
    },
    async limits() {
      const { rows } = await q('select enabled, day_usd, cycle_usd, run_usd, escalation_calls_per_run, escalation_usd_per_run from agent.research_limits where id = 1')
      const r = rows[0]
      if (!r) throw new AgentError('AGENT_RESEARCH_DISABLED', 'research limits row missing')
      return { enabled: r.enabled === true, day_usd: Number(r.day_usd), cycle_usd: Number(r.cycle_usd), run_usd: Number(r.run_usd), escalation_calls_per_run: Number(r.escalation_calls_per_run), escalation_usd_per_run: Number(r.escalation_usd_per_run) }
    },
    async totals({ run_id = null } = {}) {
      const { rows } = await q(
        `select
           coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where day = (clock_timestamp() at time zone 'utc')::date), 0) day_usd,
           coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where cycle = to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM')), 0) cycle_usd,
           coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where run_id = $1), 0) run_usd,
           coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)) filter (where run_id = $1 and purpose = 'escalation'), 0) run_escalation_usd,
           count(*) filter (where run_id = $1 and purpose = 'escalation' and state <> 'released') run_escalation_calls
         from agent.spend_ledger
         where cycle = to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM') or run_id = $1`,
        [run_id],
      )
      const r = rows[0]
      return { day_usd: round6(Number(r.day_usd)), cycle_usd: round6(Number(r.cycle_usd)), run_usd: round6(Number(r.run_usd)), run_escalation_usd: round6(Number(r.run_escalation_usd)), run_escalation_calls: Number(r.run_escalation_calls) }
    },
    async createRun({ run_id, operator_id, question_sha256, question_chars, default_model = null, escalation_model = null, doc = {} }) {
      await q(`insert into agent.research_run (run_id, org_id, operator_id, state, question_sha256, question_chars, default_model, escalation_model, doc) values ($1, $2, $3, 'running', $4, $5, $6, $7, $8)`, [run_id, org_id, operator_id, question_sha256, question_chars, default_model, escalation_model, doc])
      return run_id
    },
    async audit(a) {
      await q(
        `insert into agent.research_audit (run_id, actor_user_id, kind, name, params_sha256, rows_returned, cost_usd, latency_ms, outcome, doc) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [a.run_id, a.actor_user_id, a.kind, a.name ?? null, a.params_sha256 ?? null, a.rows_returned ?? null, a.cost_usd ?? null, a.latency_ms ?? null, a.outcome ?? null, a.doc || {}],
      )
    },
    async reserve({ run_id, operator_id, model, purpose, reserved_usd }) {
      // day / cycle / created_at are overwritten by the trigger from server time
      const now = new Date()
      const { rows } = await q(
        `insert into agent.spend_ledger (run_id, operator_id, model, purpose, day, cycle, reserved_usd, state) values ($1,$2,$3,$4,$5,$6,$7,'reserved') returning reserve_id`,
        [run_id, operator_id, model, purpose, utcDay(now), utcCycle(now), reserved_usd],
      )
      return rows[0].reserve_id
    },
    async settle(reserve_id, { actual_usd, usage = null, price_ref = null }) {
      await q(`update agent.spend_ledger set state = 'settled', actual_usd = $2, usage = $3, price_ref = $4 where reserve_id = $1`, [reserve_id, actual_usd, usage, price_ref])
    },
    async release(reserve_id) {
      await q(`update agent.spend_ledger set state = 'released' where reserve_id = $1 and state = 'reserved'`, [reserve_id])
    },
    async markUnknown(reserve_id) {
      await q(`update agent.spend_ledger set state = 'unknown' where reserve_id = $1 and state = 'reserved'`, [reserve_id])
    },
    async updateRun(run_id, p) {
      await q(
        `update agent.research_run set model_calls = coalesce($2, model_calls), escalated_calls = coalesce($3, escalated_calls), escalated_usd = coalesce($4, escalated_usd), tool_calls = coalesce($5, tool_calls), cost_usd = coalesce($6, cost_usd), default_model = coalesce($7, default_model), escalation_model = coalesce($8, escalation_model) where run_id = $1 and state = 'running'`,
        [run_id, p.model_calls ?? null, p.escalated_calls ?? null, p.escalated_usd ?? null, p.tool_calls ?? null, p.cost_usd ?? null, p.default_model ?? null, p.escalation_model ?? null],
      )
    },
    async finishRun(run_id, { state, outcome, answer = null, latency_ms = null, cost_usd = null, doc = null }) {
      await q(
        `update agent.research_run set state = $2, outcome = $3, answer = $4, latency_ms = $5, cost_usd = coalesce($6, cost_usd), doc = coalesce($7, doc), ended_at = clock_timestamp() where run_id = $1 and state = 'running'`,
        [run_id, state, outcome, answer, latency_ms, cost_usd, doc],
      )
    },
    async getRun(run_id) {
      const { rows } = await q('select * from agent.research_run where run_id = $1 and org_id = $2', [run_id, org_id])
      return rows[0] ? normalizeRun(rows[0]) : null
    },
    async listAudit(run_id) {
      const { rows } = await q('select id, at, kind, name, params_sha256, rows_returned, cost_usd, latency_ms, outcome, doc from agent.research_audit where run_id = $1 order by id limit 400', [run_id])
      return rows.map((r) => ({ ...r, id: Number(r.id), cost_usd: r.cost_usd == null ? null : Number(r.cost_usd) }))
    },
    async listRuns(operator_id, limit = 20) {
      const { rows } = await q('select * from agent.research_run where operator_id = $1 and org_id = $2 order by created_at desc limit $3', [operator_id, org_id, Math.min(Number(limit) || 20, 100)])
      return rows.map(normalizeRun)
    },
    async runsToday(operator_id) {
      const { rows } = await q(`select count(*)::int n from agent.research_run where operator_id = $1 and created_at >= date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'`, [operator_id])
      return rows[0].n
    },
    async interruptStale({ olderThanMs = 10 * 60 * 1000 } = {}) {
      // a run left 'running' by a crashed instance: its open reserves become 'unknown' (still counted)
      return tx(async (c) => {
        const { rows } = await c.query(`select run_id from agent.research_run where state = 'running' and created_at < clock_timestamp() - ($1::int * interval '1 millisecond')`, [olderThanMs])
        for (const r of rows) {
          await c.query(`update agent.spend_ledger set state = 'unknown' where run_id = $1 and state = 'reserved'`, [r.run_id])
          await c.query(`update agent.research_run set state = 'failed', outcome = 'INTERRUPTED_BY_RESTART', ended_at = clock_timestamp() where run_id = $1 and state = 'running'`, [r.run_id])
        }
        return rows.length
      })
    },
  })
}

function normalizeRun(r) {
  return { ...r, cost_usd: Number(r.cost_usd), escalated_usd: Number(r.escalated_usd), model_calls: Number(r.model_calls), escalated_calls: Number(r.escalated_calls), tool_calls: Number(r.tool_calls) }
}

/**
 * In-memory twin for unit tests: identical cap rules (day / cycle / run /
 * escalation, enabled switch, actor match, running-only). Never used by a server
 * process (the research agent refuses a non-postgres store in production).
 */
export function createResearchMemoryStore({ limits: initialLimits = {}, now = () => new Date(), failOn = null } = {}) {
  const lim = { enabled: true, day_usd: 10, cycle_usd: 150, run_usd: 2.5, escalation_calls_per_run: 2, escalation_usd_per_run: 2, ...initialLimits }
  const runs = new Map()
  const audits = []
  const ledger = []
  const maybeFail = (op) => { if (failOn && failOn(op)) throw new AgentError('AGENT_STORE_UNAVAILABLE', `injected failure: ${op}`) }
  const sum = (rows) => round6(rows.reduce((a, r) => a + committedOf(r), 0))
  return {
    kind: 'memory',
    _state: { runs, audits, ledger, lim },
    async assertLeastPrivilege() { return true },
    async limits() { maybeFail('limits'); return { ...lim } },
    async totals({ run_id = null } = {}) {
      maybeFail('totals')
      const d = utcDay(now())
      const c = utcCycle(now())
      const runRows = ledger.filter((r) => r.run_id === run_id)
      return { day_usd: sum(ledger.filter((r) => r.day === d)), cycle_usd: sum(ledger.filter((r) => r.cycle === c)), run_usd: sum(runRows), run_escalation_usd: sum(runRows.filter((r) => r.purpose === 'escalation')), run_escalation_calls: runRows.filter((r) => r.purpose === 'escalation' && r.state !== 'released').length }
    },
    async createRun(r) {
      maybeFail('createRun')
      if (/^(principal:|system:|service|anon$|authenticated$|ops[-_]dashboard|shared[:_-])/i.test(r.operator_id)) throw new AgentError('AGENT_STORE_UNAVAILABLE', 'run_operator_named')
      runs.set(r.run_id, { ...r, state: 'running', created_at: now().toISOString(), ended_at: null, model_calls: 0, escalated_calls: 0, escalated_usd: 0, tool_calls: 0, cost_usd: 0, outcome: null, answer: null, latency_ms: null, doc: r.doc || {} })
      return r.run_id
    },
    async audit(a) {
      maybeFail(`audit:${a.kind}`)
      const run = runs.get(a.run_id)
      if (!run || run.operator_id !== a.actor_user_id) throw new AgentError('AGENT_AUDIT_ACTOR_MISMATCH', 'audit actor must equal the run operator')
      audits.push({ id: audits.length + 1, at: now().toISOString(), ...a })
    },
    async reserve({ run_id, operator_id, model, purpose, reserved_usd }) {
      maybeFail('reserve')
      if (!lim.enabled) throw new AgentError('AGENT_RESEARCH_DISABLED', 'research model spend is switched off')
      if (!(reserved_usd > 0 && reserved_usd <= 2.5)) throw new AgentError('AGENT_STORE_UNAVAILABLE', 'reserved_usd check')
      const run = runs.get(run_id)
      if (!run || run.state !== 'running') throw new AgentError('AGENT_SPEND_RUN_NOT_RUNNING', 'run not running')
      if (run.operator_id !== operator_id) throw new AgentError('AGENT_SPEND_ACTOR_MISMATCH', 'actor mismatch')
      const t = await this.totals({ run_id })
      if (t.day_usd + reserved_usd > lim.day_usd) throw new AgentError('AGENT_SPEND_CAP_DAY', 'day cap')
      if (t.cycle_usd + reserved_usd > lim.cycle_usd) throw new AgentError('AGENT_SPEND_CAP_CYCLE', 'cycle cap')
      if (t.run_usd + reserved_usd > lim.run_usd) throw new AgentError('AGENT_SPEND_CAP_RUN', 'run cap')
      if (purpose === 'escalation') {
        if (t.run_escalation_calls + 1 > lim.escalation_calls_per_run) throw new AgentError('AGENT_ESCALATION_CAP_CALLS', 'escalation calls cap')
        if (t.run_escalation_usd + reserved_usd > lim.escalation_usd_per_run) throw new AgentError('AGENT_ESCALATION_CAP_USD', 'escalation usd cap')
      }
      const id = crypto.randomUUID()
      ledger.push({ reserve_id: id, run_id, operator_id, model, purpose, reserved_usd: round6(reserved_usd), actual_usd: null, state: 'reserved', day: utcDay(now()), cycle: utcCycle(now()) })
      return id
    },
    async settle(id, { actual_usd, usage = null, price_ref = null }) {
      maybeFail('settle')
      const r = ledger.find((x) => x.reserve_id === id)
      if (!r || !['reserved', 'unknown'].includes(r.state)) throw new AgentError('AGENT_SPEND_TRANSITION', 'settle refused')
      Object.assign(r, { state: 'settled', actual_usd: round6(actual_usd), usage, price_ref })
    },
    async release(id) { maybeFail('release'); const r = ledger.find((x) => x.reserve_id === id); if (r && r.state === 'reserved') r.state = 'released' },
    async markUnknown(id) { maybeFail('markUnknown'); const r = ledger.find((x) => x.reserve_id === id); if (r && r.state === 'reserved') r.state = 'unknown' },
    async updateRun(run_id, p) {
      maybeFail('updateRun')
      const r = runs.get(run_id)
      if (!r || r.state !== 'running') return
      for (const [k, v] of Object.entries(p)) if (v != null) r[k] = v
    },
    async finishRun(run_id, p) {
      maybeFail('finishRun')
      const r = runs.get(run_id)
      if (!r || r.state !== 'running') return
      Object.assign(r, { state: p.state, outcome: p.outcome, answer: p.answer ?? null, latency_ms: p.latency_ms ?? null, ended_at: now().toISOString(), ...(p.cost_usd != null ? { cost_usd: p.cost_usd } : {}), ...(p.doc ? { doc: p.doc } : {}) })
    },
    async getRun(run_id) { return runs.get(run_id) ? { ...runs.get(run_id) } : null },
    async listAudit(run_id) { return audits.filter((a) => a.run_id === run_id) },
    async listRuns(operator_id, limit = 20) { return [...runs.values()].filter((r) => r.operator_id === operator_id).slice(-limit).reverse() },
    async runsToday(operator_id) { const d = utcDay(now()); return [...runs.values()].filter((r) => r.operator_id === operator_id && String(r.created_at).slice(0, 10) === d).length },
    async interruptStale() { return 0 },
  }
}
