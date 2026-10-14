// Conversation Engine 2.0 — operator REVIEW + CONTROL read model (pure; no I/O of its own).
//
// The cockpit routes /api/cockpit/agent/conversation-ai/control wire the I/O (the agent_api
// pool, agent.runtime_status(), the service client). This module only:
//   - names the gates and reads env flags as BOOLEANS (never values),
//   - holds the bounded, read-only SQL the GET runs (indexed: research_job_runtime_recent_idx,
//     spend_ledger_day / spend_ledger_cycle),
//   - normalizes runtime_status() + budget + jobs into one control state,
//   - validates an operator control request. Controls are ONLY agent.runtime_emergency_stop and
//     agent.runtime_pause_kind('conversation.decide') — called by the route through the runtime
//     store; nothing here writes a table, and nothing here can send (static no-send test covers
//     every file in this directory).

export const REVIEW_KIND = 'conversation.decide'
export const CONTROL_ACTIONS = Object.freeze(['emergency_stop', 'pause_kind'])

// Env flags that gate the shadow, reported as booleans. CRON_AGENT_RUNTIME_ENABLED is a Worker
// var (infra/cloudflare); the container cannot see it unless forwarded, so it is reported as
// observed only when present.
export const SHADOW_FLAGS = Object.freeze({
  shadow: 'AI_CONVERSATION_SHADOW_ENABLED',
  runtime: 'AGENT_RUNTIME_ENABLED',
  cron: 'CRON_AGENT_RUNTIME_ENABLED',
})

const ON = new Set(['1', 'true', 'on'])
const on = (v) => ON.has(String(v ?? '').trim().toLowerCase())

/** Booleans only — a flag's value is never echoed. agentEnabled comes from agent-config.isAgentEnabled. */
export function readShadowFlags(env = process.env, { agentEnabled = false } = {}) {
  const cronRaw = env?.[SHADOW_FLAGS.cron]
  return {
    // the hook + handler read exactly 'true' (conversation-ai-shadow-hook.js)
    ai_conversation_shadow_enabled: String(env?.[SHADOW_FLAGS.shadow] ?? '').trim() === 'true',
    agent_runtime_enabled: on(env?.[SHADOW_FLAGS.runtime]),
    agent_enabled: Boolean(agentEnabled),
    cron_agent_runtime_enabled: cronRaw == null || String(cronRaw).trim() === '' ? null : on(cronRaw),
  }
}

// Bounded reads (read-only transaction, statement_timeout set by the caller).
export const SQL_RECENT_JOBS = `
select job_id, state, attempt, max_attempts, priority, trigger_kind, created_at, claimed_at, heartbeat_at,
       next_attempt_at, ended_at, updated_at, lease_owner, lease_until, budget_cap_usd,
       input ->> 'inbound_ref' as inbound_ref, input ->> 'deterministic_intent' as deterministic_intent,
       result, last_error
  from agent.research_job
 where runtime_managed and kind = $1
 order by created_at desc
 limit $2`

export const SQL_BUDGET = `
select l.enabled, l.day_usd, l.cycle_usd, l.run_usd,
       (select coalesce(sum(case when s.state = 'released' then 0 else coalesce(s.actual_usd, s.reserved_usd) end), 0)
          from agent.spend_ledger s where s.day = (now() at time zone 'utc')::date) as spent_day,
       (select coalesce(sum(case when s.state = 'released' then 0 else coalesce(s.actual_usd, s.reserved_usd) end), 0)
          from agent.spend_ledger s where s.cycle = to_char(now() at time zone 'utc', 'YYYY-MM')) as spent_cycle,
       (select coalesce(sum(case when s.state = 'released' then 0 else coalesce(s.actual_usd, s.reserved_usd) end), 0)
          from agent.spend_ledger s join agent.research_job j on j.job_id = s.job_id
         where s.day = (now() at time zone 'utc')::date and j.kind = $1) as spent_day_kind
  from agent.research_limits l where l.id = 1`

const NIB = 'abcdefghijklmnop'
/** Inverse of conversation-ai-shadow-hook encodeRef (kept local: this directory stays import-clean). */
export function decodeInboundRef(s) {
  const t = String(s ?? '')
  if (!t || t.length > 320 || !/^(?:[a-p]{2})+$/.test(t)) return null
  return Buffer.from(t.match(/../g).map((p) => (NIB.indexOf(p[0]) << 4) | NIB.indexOf(p[1]))).toString('utf8')
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const code = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : null)

/** One job row → display shape (codes only; the error payload is reduced to its code). */
export function normalizeJob(row = {}, inboundIdBySid = new Map()) {
  const sid = decodeInboundRef(row.inbound_ref)
  const err = row.last_error && typeof row.last_error === 'object' ? row.last_error : null
  const res = row.result && typeof row.result === 'object' ? row.result : null
  const created = iso(row.created_at)
  const ended = iso(row.ended_at)
  return {
    job_id: String(row.job_id || ''),
    state: String(row.state || 'unknown'),
    attempt: num(row.attempt) ?? 0,
    max_attempts: num(row.max_attempts) ?? 0,
    trigger: code(row.trigger_kind),
    created_at: created,
    claimed_at: iso(row.claimed_at),
    heartbeat_at: iso(row.heartbeat_at),
    next_attempt_at: iso(row.next_attempt_at),
    ended_at: ended,
    lease_owner: code(row.lease_owner),
    lease_until: iso(row.lease_until),
    budget_cap_usd: num(row.budget_cap_usd) ?? 0,
    deterministic_intent: code(row.deterministic_intent),
    inbound_message_id: sid ? inboundIdBySid.get(sid) ?? null : null,
    result: res ? { code: code(res.code), outcome: code(res.outcome), validation_status: code(res.validation_status), path: code(res.path), cost_usd: num(res.cost_usd) } : null,
    error_code: err ? code(err.code) || code(err.error) || 'error' : null,
    wall_ms: created && ended ? Math.max(0, Date.parse(ended) - Date.parse(created)) : null,
  }
}

/** Provider sids of the job rows (for the bounded message_events id lookup). */
export function jobInboundSids(rows = []) {
  return [...new Set(rows.map((r) => decodeInboundRef(r?.inbound_ref)).filter((s) => s && s.length <= 160))].slice(0, 100)
}

/**
 * The control state the panel renders.
 * @param {{ flags: object, status?: object|null, budget?: object|null, jobs?: object[], errors?: string[] }} a
 */
export function buildControlState({ flags, status = null, budget = null, jobs = [], errors = [] }) {
  const limits = status?.limits || null
  const k = limits?.kind_limits?.[REVIEW_KIND] || null
  const kind = {
    configured: Boolean(k),
    armed: Boolean(k?.armed_by),
    enabled: k?.enabled === true,
    max_concurrency: num(k?.max_concurrency),
    event_budget_cap_usd: num(k?.event_budget_cap_usd),
  }
  const hb = Array.isArray(status?.heartbeats) ? status.heartbeats[0] || null : null
  const gates = {
    env_shadow: flags.ai_conversation_shadow_enabled,
    env_runtime: flags.agent_runtime_enabled && flags.agent_enabled,
    db_runtime: limits ? limits.runtime_enabled === true : null,
    emergency_stop_clear: limits ? limits.emergency_stop !== true : null,
    kind_enabled: limits ? kind.enabled : null,
    spend_enabled: budget ? budget.enabled === true : null,
  }
  const known = Object.values(gates).every((v) => v !== null)
  const shadow_on = known && Object.values(gates).every(Boolean)
  return {
    mode: 'shadow',
    send_path: 'none',
    shadow: { on: shadow_on, state: !known ? 'unknown' : shadow_on ? 'on' : 'off', gates },
    flags,
    runtime: limits
      ? {
          runtime_enabled: limits.runtime_enabled === true,
          emergency_stop: limits.emergency_stop === true,
          emergency_stop_at: iso(limits.emergency_stop_at),
          max_concurrency_global: num(limits.max_concurrency_global),
          tick_max_jobs: num(limits.tick_max_jobs),
          lease_seconds: num(limits.lease_seconds),
          open: status?.open || {},
          ended_24h: status?.ended_24h || {},
          heartbeat: hb ? { worker_id: code(hb.worker_id), last_tick_at: iso(hb.last_tick_at), age_s: num(hb.age_s), ticks: num(hb.ticks) } : null,
        }
      : null,
    kind,
    budget: budget
      ? {
          spend_enabled: budget.enabled === true,
          day_cap_usd: num(budget.day_usd),
          cycle_cap_usd: num(budget.cycle_usd),
          run_cap_usd: num(budget.run_usd),
          spent_day_usd: num(budget.spent_day) ?? 0,
          spent_cycle_usd: num(budget.spent_cycle) ?? 0,
          spent_day_kind_usd: num(budget.spent_day_kind) ?? 0,
          per_event_reserve_usd: kind.event_budget_cap_usd,
        }
      : null,
    jobs,
    errors: errors.filter((e) => code(e)),
  }
}

/** Operator request → { ok, action, reason } (reason: ≤ 240 chars, digits stripped so no phone can ride it). */
export function parseControlRequest(body = {}) {
  const action = String(body?.action ?? '')
  if (!CONTROL_ACTIONS.includes(action)) return { ok: false, code: 'ACTION_INVALID' }
  if (body?.confirm !== true) return { ok: false, code: 'CONFIRM_REQUIRED' }
  const reason = String(body?.reason ?? '').replace(/[0-9]/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 240) || null
  return { ok: true, action, reason }
}

/**
 * Execute a control through the runtime store ONLY (agent.runtime_emergency_stop /
 * agent.runtime_pause_kind). `by` is the verified operator's user id.
 */
export async function runControlAction({ store, action, by, reason = null }) {
  if (!store) return { ok: false, code: 'RUNTIME_STORE_UNAVAILABLE' }
  if (action === 'emergency_stop') {
    const r = await store.emergencyStop({ by, reason: reason || 'conversation_ai_review_panel' })
    return r?.ok ? { ok: true, action, result: { emergency_stop: true } } : { ok: false, code: String(r?.reason || 'REFUSED').toUpperCase() }
  }
  if (action === 'pause_kind') {
    const r = await store.pauseKind({ kind: REVIEW_KIND, by })
    return r?.ok ? { ok: true, action, result: { kind: REVIEW_KIND, enabled: false } } : { ok: false, code: String(r?.reason || 'REFUSED').toUpperCase() }
  }
  return { ok: false, code: 'ACTION_INVALID' }
}
