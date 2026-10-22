// Workforce store — Postgres (docs/WORKFORCE.md §11).
//
// Schema: supabase/migrations/PROPOSED_20261022100000_workforce_foundation.sql (PROPOSED).
// WRITES call the workforce.* SECURITY DEFINER functions only (the SQL enforces idempotency, the
// state graphs, lease tokens, supersede rules, exclusive resource claims and the payload CHECKs);
// one bounded READ COMMITTED transaction per call. READS run inside BEGIN READ ONLY and touch
// schema workforce only. Connect as agent_api (least privilege, no BYPASSRLS): agent_api has
// SELECT on the tables and EXECUTE on the writers, nothing else.
//
// Errors: WorkforceStoreError { code } (errors.js). Times: ISO strings in and out.
import { WorkforceStoreError, fromPgError } from './errors.js'
import {
  shapeEmployee, shapeMission, shapeAssignment, shapeClaim, shapeEvent, shapeExecMessage, shapeFact, shapePolicy, shapeSettings, shapeKpi,
} from './shape.js'

const clamp = (v, d, lo, hi) => Math.min(Math.max(Number.isFinite(Number(v)) && v != null ? Math.trunc(Number(v)) : d, lo), hi)
const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v))
const ts = (v) => (v == null ? null : new Date(v).toISOString())
const asList = (v) => (v == null ? null : Array.isArray(v) ? v.map(String) : [String(v)])

/**
 * @param {{ pool: import('pg').Pool, statementTimeoutMs?: number, lockTimeoutMs?: number }} opts
 */
export function createWorkforcePgStore({ pool, statementTimeoutMs = 5000, lockTimeoutMs = 2000 } = {}) {
  if (!pool) throw new WorkforceStoreError('UNAVAILABLE', 'workforce store: a pg Pool is required')
  const st = clamp(statementTimeoutMs, 5000, 500, 30_000)
  const lt = clamp(lockTimeoutMs, 2000, 100, 10_000)

  async function tx(readOnly, sql, params = []) {
    let client
    try {
      client = await pool.connect()
    } catch (err) {
      throw fromPgError(err)
    }
    try {
      await client.query(readOnly ? 'begin read only' : 'begin isolation level read committed')
      await client.query(`set local statement_timeout = ${st}`)
      await client.query(`set local lock_timeout = ${lt}`)
      const { rows } = await client.query(sql, params)
      await client.query(readOnly ? 'rollback' : 'commit')
      return rows
    } catch (err) {
      try { await client.query('rollback') } catch { /* connection already broken */ }
      throw fromPgError(err)
    } finally {
      client.release()
    }
  }
  const call = async (sql, params) => (await tx(false, sql, params))[0]?.r ?? null
  const read = (sql, params) => tx(true, sql, params)
  const one = async (sql, params) => (await read(sql, params))[0] ?? null

  const store = {
    kind: 'postgres',

    // ── org / employees ──
    async listEmployees({ org_id, status = null } = {}) {
      return (await read(`select * from workforce.employee where org_id = $1 and ($2::text[] is null or status = any ($2::text[]))
         order by department_key, role_key, employee_id`, [org_id, asList(status)])).map(shapeEmployee)
    },
    async getEmployee({ org_id, employee_id }) {
      return shapeEmployee(await one('select * from workforce.employee where org_id = $1 and employee_id = $2', [org_id, employee_id]))
    },
    async upsertEmployee({ org_id, employee, actor_user_id }) {
      return shapeEmployee(await call('select workforce.employee_upsert($1, $2::jsonb, $3::uuid) r', [org_id, j(employee || {}), actor_user_id ?? null]))
    },
    async heartbeatEmployee({ org_id, employee_id, at = null }) {
      await call('select workforce.employee_heartbeat($1, $2, $3::timestamptz) r', [org_id, employee_id, ts(at)])
    },

    // ── missions ──
    async openMission({ org_id, title, directive, requested_by, owner_employee_id, priority = null, due_at = null, idempotency_key }) {
      const r = await call('select workforce.mission_open($1, $2, $3, $4::uuid, $5, $6, $7::timestamptz, $8) r',
        [org_id, title, directive, requested_by ?? null, owner_employee_id, priority, ts(due_at), idempotency_key])
      return { mission: shapeMission(r.mission), created: r.created === true }
    },
    async getMission({ org_id, mission_id }) {
      return shapeMission(await one('select * from workforce.mission where org_id = $1 and mission_id = $2', [org_id, mission_id]))
    },
    async listMissions({ org_id, status = null, limit = 50, before = null } = {}) {
      return (await read(`select * from workforce.mission where org_id = $1 and ($2::text[] is null or status = any ($2::text[]))
           and ($3::timestamptz is null or created_at < $3::timestamptz)
         order by created_at desc, mission_id desc limit $4`, [org_id, asList(status), ts(before), clamp(limit, 50, 1, 200)])).map(shapeMission)
    },
    async setMissionPlan({ org_id, mission_id, objective = null, playbook_key = null, plan, expected_version }) {
      return shapeMission(await call('select workforce.mission_set_plan($1, $2, $3::jsonb, $4, $5::jsonb, $6) r',
        [org_id, mission_id, j(objective), playbook_key, j(plan ?? {}), expected_version ?? null]))
    },
    async transitionMission({ org_id, mission_id, to, report = null }) {
      return shapeMission(await call('select workforce.mission_transition($1, $2, $3, $4::jsonb) r', [org_id, mission_id, to, j(report)]))
    },

    // ── assignments ──
    async createAssignment({ org_id, mission_id, step_key, capability_key, assignee_employee_id, delegated_by_employee_id = null, depends_on = [],
      input = {}, resource_type = null, resource_key = null, max_attempts = null, parent_assignment_id = null }) {
      const r = await call('select workforce.assignment_create($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb, $9, $10, $11, $12) r',
        [org_id, mission_id, step_key, capability_key, assignee_employee_id, delegated_by_employee_id, depends_on || [], j(input || {}),
          resource_type, resource_key, max_attempts, parent_assignment_id])
      return { assignment: shapeAssignment(r.assignment), created: r.created === true }
    },
    async getAssignment({ org_id, assignment_id }) {
      return shapeAssignment(await one('select * from workforce.assignment where org_id = $1 and assignment_id = $2', [org_id, assignment_id]))
    },
    async listAssignments({ org_id, mission_id = null, status = null, assignee_employee_id = null, limit = 200 } = {}) {
      return (await read(`select * from workforce.assignment where org_id = $1 and ($2::text is null or mission_id = $2)
           and ($3::text[] is null or status = any ($3::text[])) and ($4::text is null or assignee_employee_id = $4)
         order by created_at, assignment_id limit $5`, [org_id, mission_id, asList(status), assignee_employee_id, clamp(limit, 200, 1, 1000)])).map(shapeAssignment)
    },
    async claimAssignments({ org_id, owner, limit = 1, lease_seconds = 60, now = null }) {
      const r = await call('select workforce.assignment_claim($1, $2, $3, $4, $5::timestamptz) r', [org_id, owner, limit, lease_seconds, ts(now)])
      return (r || []).map(shapeAssignment)
    },
    async progressAssignment({ org_id, assignment_id, lease_token, patch = {} }) {
      return shapeAssignment(await call('select workforce.assignment_progress($1, $2, $3::uuid, $4::jsonb) r', [org_id, assignment_id, lease_token ?? null, j(patch || {})]))
    },
    async waitAssignmentOnJob({ org_id, assignment_id, lease_token, runtime_job_id }) {
      return shapeAssignment(await call('select workforce.assignment_wait_job($1, $2, $3::uuid, $4) r', [org_id, assignment_id, lease_token ?? null, runtime_job_id ?? null]))
    },
    /** resolver(runtime_job_id) → { state, result?, error? } | null. completed → completed (verified); failed / dead_letter / cancelled → retry or failed. */
    async resumeWaitingAssignments({ org_id, resolver, limit = 200 }) {
      if (typeof resolver !== 'function') throw new WorkforceStoreError('PAYLOAD_REFUSED', 'resolver(runtime_job_id) is required')
      const waiting = await read(`select assignment_id, runtime_job_id from workforce.assignment where org_id = $1 and status = 'waiting_job'
         order by updated_at, assignment_id limit $2`, [org_id, clamp(limit, 200, 1, 1000)])
      let n = 0
      for (const w of waiting) {
        const job = await resolver(w.runtime_job_id)
        if (!job || !['completed', 'failed', 'dead_letter', 'cancelled'].includes(job.state)) continue
        const r = await call('select workforce.assignment_resume_job($1, $2, $3, $4, $5::jsonb, $6::jsonb) r',
          [org_id, w.assignment_id, w.runtime_job_id, job.state, j(job.result ?? null), j(job.error ?? null)])
        if (r?.changed) n += 1
      }
      return n
    },
    async finishAssignment({ org_id, assignment_id, lease_token, status, output = null, outcome_class = null, evidence = null, error = null, retry_after_seconds = null }) {
      return shapeAssignment(await call('select workforce.assignment_finish($1, $2, $3::uuid, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9) r',
        [org_id, assignment_id, lease_token ?? null, status, j(output), outcome_class, j(evidence), j(error), retry_after_seconds]))
    },
    /** §2 implementation note: release a waiting_approval / blocked assignment → ready | cancelled | failed. */
    async resolveHeldAssignment({ org_id, assignment_id, to, actor }) {
      return shapeAssignment(await call('select workforce.assignment_resolve_hold($1, $2, $3, $4) r', [org_id, assignment_id, to, actor ?? null]))
    },
    /** A PERSON decides an item parked in their queue: owner only, human assignee, waiting_approval → completed. → { changed, assignment } */
    async decideHeldAssignment({ org_id, assignment_id, decision, note = null, actor_user_id }) {
      const r = await call('select workforce.assignment_decide($1, $2, $3, $4, $5::uuid) r', [org_id, assignment_id, decision ?? null, note ?? null, actor_user_id ?? null])
      return { changed: r?.changed === true, assignment: shapeAssignment(r?.assignment ?? null) }
    },
    async transferAssignment({ org_id, assignment_id, to_employee_id, actor }) {
      return shapeAssignment(await call('select workforce.assignment_transfer($1, $2, $3, $4) r', [org_id, assignment_id, to_employee_id, actor ?? null]))
    },
    async cancelMissionAssignments({ org_id, mission_id }) {
      return Number(await call('select workforce.assignment_cancel_mission($1, $2) r', [org_id, mission_id]))
    },
    async reapAssignments({ org_id, now = null } = {}) {
      const r = await call('select workforce.assignment_reap($1, $2::timestamptz) r', [org_id, ts(now)])
      return { requeued: Number(r?.requeued || 0), failed: Number(r?.failed || 0) }
    },

    // ── resource ownership ──
    async acquireResourceClaim({ org_id, resource_type, resource_key, employee_id, assignment_id = null, ttl_seconds }) {
      return shapeClaim(await call('select workforce.resource_claim_acquire($1, $2, $3, $4, $5, $6) r', [org_id, resource_type, resource_key, employee_id, assignment_id, ttl_seconds]))
    },
    async releaseResourceClaim({ org_id, resource_type, resource_key, assignment_id = null }) {
      await call('select workforce.resource_claim_release($1, $2, $3, $4) r', [org_id, resource_type, resource_key, assignment_id])
    },
    async reapResourceClaims({ org_id, now = null } = {}) {
      return Number(await call('select workforce.resource_claim_reap($1, $2::timestamptz) r', [org_id, ts(now)]))
    },
    async listResourceClaims({ org_id, active = true } = {}) {
      return (await read(`select * from workforce.resource_claim where org_id = $1 and (not $2::boolean or released_at is null)
         order by claimed_at desc, claim_id limit 500`, [org_id, active !== false])).map(shapeClaim)
    },

    // ── events / conversation / memory ──
    async appendEvent({ org_id, type, mission_id = null, assignment_id = null, employee_id = null, payload = {} }) {
      return shapeEvent(await call('select workforce.event_append($1, $2, $3, $4, $5, $6::jsonb) r', [org_id, type, mission_id, assignment_id, employee_id, j(payload || {})]))
    },
    async listEvents({ org_id, after_event_id = null, mission_id = null, limit = 100 } = {}) {
      return (await read(`select * from workforce.event where org_id = $1 and ($2::bigint is null or event_id > $2::bigint) and ($3::text is null or mission_id = $3)
         order by event_id limit $4`, [org_id, after_event_id, mission_id, clamp(limit, 100, 1, 500)])).map(shapeEvent)
    },
    async appendExecMessage({ org_id, author, author_user_id = null, author_employee_id = null, content, refs = [], mission_id = null }) {
      return shapeExecMessage(await call('select workforce.exec_message_append($1, $2, $3::uuid, $4, $5, $6::jsonb, $7) r',
        [org_id, author, author_user_id, author_employee_id, content, j(refs || []), mission_id]))
    },
    async listExecMessages({ org_id, mission_id = null, limit = 50, before = null } = {}) {
      return (await read(`select * from workforce.exec_message where org_id = $1 and ($2::text is null or mission_id = $2)
           and ($3::timestamptz is null or created_at < $3::timestamptz)
         order by created_at desc, message_id desc limit $4`, [org_id, mission_id, ts(before), clamp(limit, 50, 1, 200)])).map(shapeExecMessage)
    },
    async assertMemoryFact({ org_id, scope, scope_key, fact_key, value, epistemic, confidence = null, source_refs = [], author_employee_id = null, author_user_id = null }) {
      return shapeFact(await call('select workforce.memory_assert($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10::uuid) r',
        [org_id, scope, scope_key, fact_key, value === undefined ? null : JSON.stringify(value), epistemic, confidence, j(source_refs ?? []), author_employee_id, author_user_id]))
    },
    async listMemoryFacts({ org_id, scope = null, scope_key = null, include_superseded = false } = {}) {
      return (await read(`select * from workforce.memory_fact where org_id = $1 and ($2::text is null or scope = $2) and ($3::text is null or scope_key = $3)
           and ($4::boolean or superseded_at is null)
         order by valid_from desc, fact_id limit 500`, [org_id, scope, scope_key, include_superseded === true])).map(shapeFact)
    },

    // ── authority / settings / KPIs ──
    async listPolicies({ org_id, status = null } = {}) {
      return (await read(`select * from workforce.authority_policy where org_id = $1 and ($2::text[] is null or status = any ($2::text[]))
         order by created_at desc, policy_id limit 500`, [org_id, asList(status)])).map(shapePolicy)
    },
    async putPolicy({ org_id, policy, actor_user_id }) {
      return shapePolicy(await call('select workforce.policy_put($1, $2::jsonb, $3::uuid) r', [org_id, j(policy || {}), actor_user_id ?? null]))
    },
    async revokePolicy({ org_id, policy_id, actor_user_id }) {
      return shapePolicy(await call('select workforce.policy_revoke($1, $2::uuid, $3::uuid) r', [org_id, policy_id, actor_user_id ?? null]))
    },
    async getSettings({ org_id }) {
      return shapeSettings(await one('select * from workforce.settings where org_id = $1', [org_id]))
    },
    async putSettings({ org_id, patch, actor_user_id }) {
      return shapeSettings(await call('select workforce.settings_put($1, $2::jsonb, $3::uuid) r', [org_id, j(patch || {}), actor_user_id ?? null]))
    },
    async putKpi({ org_id, subject_type, subject_key, kpi_key, window, value = null, status, source = {} }) {
      await call('select workforce.kpi_put($1, $2, $3, $4, $5, $6, $7, $8::jsonb) r', [org_id, subject_type, subject_key, kpi_key, window, value, status, j(source || {})])
    },
    async listKpis({ org_id, subject_type = null, subject_key = null } = {}) {
      return (await read(`select * from workforce.kpi_snapshot where org_id = $1 and ($2::text is null or subject_type = $2) and ($3::text is null or subject_key = $3)
         order by subject_type, subject_key, kpi_key, "window"`, [org_id, subject_type, subject_key])).map(shapeKpi)
    },
  }
  return Object.freeze(store)
}
