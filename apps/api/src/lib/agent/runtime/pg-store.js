// Postgres agent store (S3 minimum durable persistence). SAME interface as the
// in-memory and local file adapters (runtime/store.js):
//   transaction(fn) · read() · onCommit(cb) · kind
// plus async lifecycle helpers the live wiring calls:
//   open() · refresh() · hydrateRun(run_id) · close()
//
// Schema: supabase/migrations/PROPOSED_20261010120000_agent_s3_persistence.sql
// (PROPOSED — not applied to production).
//
// HOW A TRANSACTION WORKS (one writer at a time, across every process):
//   BEGIN; SET LOCAL statement_timeout/lock_timeout;
//   SELECT … FROM agent.store_head WHERE id = 1 FOR UPDATE      ← global serialization
//   if head.generation ≠ ours → pull every row written since (gen > ours) and
//     the new events of the runs we hold, so fn() sees the latest state
//   snapshot → fn(state) → diff → write changed rows (gen = head+1) and the new
//     events (append-only; the DB re-checks seq gaplessness, event_id
//     monotonicity, sanitizer CHECKs, source-class/status rules) → bump head
//   COMMIT — then listeners run. Any error → ROLLBACK and the in-memory state is
//   restored exactly, so "state change + event in one transaction" holds in
//   Postgres just as it does in memory.
//
// WORKING SET: run + research_job rows are cached for the org (bounded by the
// retention policy). Child rows (events, tasks, tool calls, findings,
// conflicts) are cached only for HOT runs: runs that are not terminal, runs
// created/touched by this process, and runs explicitly hydrated (hydrateRun)
// before a snapshot/replay of an older run.
//
// NOT PERSISTED IN S3: approvals, artifacts, the usage ledger and the action
// audit. A transaction that writes any of them is REFUSED
// (PG_STORE_TABLE_NOT_PERSISTED) — a second structural net under "Quick Scan
// is $0 and AI is disabled".
//
// Tool idempotency entries are persisted in the EXISTING public.idempotency_ledger
// (scope 'agent.tool'), reused rather than duplicated.
import { emptyState, AgentError } from './store.js'

export const PG_STORE_UNPERSISTED_TABLES = Object.freeze(['approvals', 'artifacts', 'ledger', 'audit'])
export const DEFAULT_ORG_ID = '00000000-0000-4000-8000-00000000a001'
const TERMINAL = new Set(['completed', 'completed_partial', 'budget_exhausted', 'cancelled', 'failed', 'expired'])
const IDEM_PREFIX = 'agent.tool:'

// ── property-id codec (security review M2 residue) ─────────────────────────
// Property ids are 9–10 digit numbers that are indistinguishable from phone
// numbers, so they are NEVER stored raw inside jsonb: under property-id keys
// (property_id, property_ids, *_property_ids) and in property:<id> refs (*_refs)
// the digits are written as letters g–p (0–9), e.g. 2128263281 → pid_imimiogmio.
// The DB CHECK refuses raw digits there. Relational property_id columns stay raw.
const PID_KEY = /(^|_)property_ids?$/i
const REFS_KEY = /_refs$/i
const toLetters = (d) => d.replace(/[0-9]/g, (c) => 'ghijklmnop'[Number(c)])
const toDigits = (l) => l.replace(/[g-p]/g, (c) => String('ghijklmnop'.indexOf(c)))
function codec(value, key, enc) {
  if (Array.isArray(value)) return value.map((v) => codec(v, key, enc))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = codec(v, k, enc)
    return out
  }
  if (typeof value === 'string' && key) {
    if (PID_KEY.test(key)) {
      if (enc && /^[0-9]{1,20}$/.test(value)) return `pid_${toLetters(value)}`
      if (!enc && /^pid_[g-p]{1,20}$/.test(value)) return toDigits(value.slice(4))
    }
    if (REFS_KEY.test(key)) {
      if (enc && /^property:[0-9]{1,20}$/.test(value)) return `property:pid_${toLetters(value.slice(9))}`
      if (!enc && /^property:pid_[g-p]{1,20}$/.test(value)) return `property:${toDigits(value.slice(13))}`
    }
  }
  return value
}
export const encodePropertyIds = (v) => codec(v, null, true)
export const decodePropertyIds = (v) => codec(v, null, false)

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))

/** Table specs: state map ↔ table. `row(obj)` → column object (doc = the runtime object). */
const TABLES = Object.freeze({
  runs: {
    table: 'agent.run', key: 'run_id', objKey: 'id', child: false,
    cols: { run_id: 'text', org_id: 'uuid', operator_id: 'text', kind: 'text', depth: 'text', state: 'text', budget_cap_usd: 'numeric', accrued_usd: 'numeric', lease_owner: 'text', lease_until: 'timestamptz', heartbeat_at: 'timestamptz', cancel_requested_at: 'timestamptz', last_seq: 'int', created_at: 'timestamptz', updated_at: 'timestamptz', ended_at: 'timestamptz', gen: 'bigint', doc: 'jsonb' },
    row: (o, ctx) => ({ run_id: o.id, org_id: ctx.org_id, operator_id: String(o.operator_id), kind: o.kind, depth: o.depth ?? null, state: o.state, budget_cap_usd: Number(o.budget_cap_usd ?? 0), accrued_usd: Number(o.accrued_usd ?? 0), lease_owner: o.lease_owner ?? null, lease_until: o.lease_owner ? iso(o.lease_until) : null, heartbeat_at: iso(o.heartbeat_at), cancel_requested_at: iso(o.cancel_requested_at), last_seq: ctx.seq[o.id] || 0, created_at: iso(o.created_at), updated_at: iso(o.updated_at), ended_at: TERMINAL.has(o.state) ? iso(o.ended_at || o.updated_at) : null, gen: ctx.gen, doc: o }),
  },
  researchJobs: {
    table: 'agent.research_job', key: 'job_id', objKey: 'job_id', child: false,
    cols: { job_id: 'text', run_id: 'text', org_id: 'uuid', depth: 'text', state: 'text', scope_hash: 'text', property_ids: 'text[]', created_at: 'timestamptz', ended_at: 'timestamptz', gen: 'bigint', doc: 'jsonb' },
    row: (o, ctx) => ({ job_id: o.job_id, run_id: o.run_id, org_id: ctx.org_id, depth: o.depth, state: o.state, scope_hash: o.scope_hash, property_ids: o.property_ids, created_at: iso(o.created_at), ended_at: iso(o.ended_at), gen: ctx.gen, doc: o }),
  },
  researchTasks: {
    table: 'agent.research_task', key: 'task_id', objKey: 'task_id', child: true,
    cols: { task_id: 'text', job_id: 'text', run_id: 'text', org_id: 'uuid', property_id: 'text', tool: 'text', finding_type: 'text', state: 'text', attempt: 'int', billable: 'boolean', output: 'jsonb', gen: 'bigint', doc: 'jsonb' },
    row: (o, ctx) => ({ task_id: o.task_id, job_id: o.job_id, run_id: o.run_id, org_id: ctx.org_id, property_id: String(o.property_id), tool: o.tool || o.adapter_id, finding_type: o.finding_type, state: o.state, attempt: o.attempt, billable: Boolean(o.billable), output: o.output ?? null, gen: ctx.gen, doc: o }),
  },
  toolCalls: {
    table: 'agent.tool_call', key: 'tool_call_id', objKey: 'id', child: true,
    cols: { tool_call_id: 'text', run_id: 'text', org_id: 'uuid', tool: 'text', tier: 'text', state: 'text', created_at: 'timestamptz', gen: 'bigint', doc: 'jsonb' },
    row: (o, ctx) => ({ tool_call_id: o.id, run_id: o.run_id, org_id: ctx.org_id, tool: o.tool, tier: o.tier, state: o.state, created_at: iso(o.created_at), gen: ctx.gen, doc: o }),
  },
  findings: {
    table: 'agent.finding', key: 'finding_id', objKey: 'finding_id', child: true,
    cols: { finding_id: 'text', run_id: 'text', org_id: 'uuid', property_id: 'text', finding_type: 'text', key: 'text', evidence_status: 'text', source_class: 'text', source_id: 'text', citation: 'text', basis_finding_ids: 'text[]', value: 'jsonb', is_negative_claim: 'boolean', confidence: 'numeric', retrieved_at: 'timestamptz', observed_at: 'text', actor_user_id: 'text', gen: 'bigint', doc: 'jsonb' },
    row: (o, ctx) => ({ finding_id: o.finding_id, run_id: o.run_id, org_id: ctx.org_id, property_id: String(o.property_id), finding_type: o.finding_type, key: o.key, evidence_status: o.evidence_status, source_class: o.source_class, source_id: o.source_id, citation: o.citation ?? null, basis_finding_ids: o.basis_finding_ids || [], value: o.value ?? null, is_negative_claim: Boolean(o.is_negative_claim), confidence: Number(o.confidence ?? 0), retrieved_at: iso(o.retrieved_at), observed_at: o.observed_at == null ? null : String(o.observed_at), actor_user_id: o.actor_user_id == null ? null : String(o.actor_user_id), gen: ctx.gen, doc: o }),
  },
  conflicts: {
    table: 'agent.finding_conflict', key: 'conflict_group_id', objKey: 'conflict_group_id', child: true,
    cols: { conflict_group_id: 'text', run_id: 'text', org_id: 'uuid', property_id: 'text', rule: 'text', resolution_state: 'text', gen: 'bigint', doc: 'jsonb' },
    row: (o, ctx) => ({ conflict_group_id: o.conflict_group_id, run_id: o.run_id, org_id: ctx.org_id, property_id: String(o.property_id), rule: o.rule, resolution_state: o.resolution_state, gen: ctx.gen, doc: o }),
  },
})
const EVENT_COLS = { event_id: 'bigint', run_id: 'text', org_id: 'uuid', seq: 'int', type: 'text', at: 'timestamptz', attempt: 'int', visibility: 'text', property_id: 'text', task_id: 'text', tool_call_id: 'text', actor_user_id: 'text', payload: 'jsonb', fixture: 'boolean' }

function recordsetSql(cols) {
  return Object.entries(cols).map(([c, t]) => `${c} ${t}`).join(', ')
}

function upsertSql(spec) {
  const cols = Object.keys(spec.cols)
  const updates = cols.filter((c) => c !== spec.key && c !== 'org_id').map((c) => `${c} = excluded.${c}`).join(', ')
  return `insert into ${spec.table} (${cols.join(', ')})
    select ${cols.join(', ')} from jsonb_to_recordset($1::jsonb) as x(${recordsetSql(spec.cols)})
    on conflict (${spec.key}) do update set ${updates}
    where ${spec.table}.org_id = excluded.org_id`
}

const EVENT_INSERT_SQL = `insert into agent.run_event (${Object.keys(EVENT_COLS).join(', ')})
  select ${Object.keys(EVENT_COLS).join(', ')} from jsonb_to_recordset($1::jsonb) as x(${recordsetSql(EVENT_COLS)}) order by event_id`

function eventFromRow(r) {
  const e = { event_id: Number(r.event_id), run_id: r.run_id, seq: Number(r.seq), type: r.type, at: iso(r.at), attempt: Number(r.attempt), visibility: r.visibility, property_id: r.property_id, task_id: r.task_id, tool_call_id: r.tool_call_id, actor_user_id: r.actor_user_id, payload: decodePropertyIds(r.payload) }
  return e
}

function snapshotState(state) {
  const json = {}
  for (const k of [...Object.keys(TABLES), 'idempotency', 'approvals', 'artifacts']) {
    json[k] = new Map([...state[k].entries()].map(([id, v]) => [id, JSON.stringify(v)]))
  }
  return { json, events: state.events.length, ledger: state.ledger.length, audit: state.audit.length, counters: structuredClone(state.counters) }
}

function restoreState(state, snap) {
  for (const [k, m] of Object.entries(snap.json)) state[k] = new Map([...m.entries()].map(([id, s]) => [id, JSON.parse(s)]))
  state.events.length = snap.events
  state.ledger.length = snap.ledger
  state.audit.length = snap.audit
  state.counters = snap.counters
}

/**
 * @param {{ pool: import('pg').Pool, org_id?: string, statementTimeoutMs?: number }} opts
 */
/**
 * @param {{ pool: import('pg').Pool, org_id?: string, statementTimeoutMs?: number, allowPrivilegedRole?: boolean }} opts
 *   allowPrivilegedRole: proofs/tests ONLY — production wiring never sets it
 */
export function createPgAgentStore({ pool, org_id = DEFAULT_ORG_ID, statementTimeoutMs = 30_000, allowPrivilegedRole = false } = {}) {
  if (!pool) throw new AgentError('PG_STORE_POOL_REQUIRED', 'a pg Pool is required')
  let state = emptyState()
  let gen = -1 // last generation this process has seen
  const hot = new Set() // run ids whose child rows are cached
  let chain = Promise.resolve()
  const listeners = new Set()
  let opened = false

  async function loadChildren(client, runIds) {
    const ids = [...runIds]
    if (!ids.length) return
    for (const [name, spec] of Object.entries(TABLES)) {
      if (!spec.child) continue
      const { rows } = await client.query(`select doc from ${spec.table} where org_id = $1 and run_id = any($2::text[])`, [org_id, ids])
      for (const r of rows) state[name].set(r.doc[spec.objKey], decodePropertyIds(r.doc))
    }
    const { rows } = await client.query('select * from agent.run_event where org_id = $1 and run_id = any($2::text[]) order by event_id', [org_id, ids])
    const have = new Set(state.events.map((e) => e.event_id))
    for (const r of rows) if (!have.has(Number(r.event_id))) state.events.push(eventFromRow(r))
    state.events.sort((a, b) => a.event_id - b.event_id)
    for (const id of ids) hot.add(id)
  }

  function evict(runIds) {
    for (const [name, spec] of Object.entries(TABLES)) {
      if (!spec.child) continue
      for (const [id, obj] of state[name]) if (runIds.has(obj.run_id)) state[name].delete(id)
    }
    state.events = state.events.filter((e) => !runIds.has(e.run_id))
    for (const id of runIds) hot.delete(id)
  }

  /** Pull everything written since `gen` (caller holds a consistent snapshot or the head lock). */
  async function syncFrom(client, head) {
    if (Number(head.generation) === gen) return
    const since = gen < 0 ? -1 : gen
    const newlyHot = new Set()
    for (const [name, spec] of Object.entries(TABLES)) {
      if (spec.child) continue
      const { rows } = await client.query(`select doc${name === 'runs' ? ', last_seq' : ''} from ${spec.table} where org_id = $1 and gen > $2`, [org_id, since])
      for (const r of rows) {
        state[name].set(r.doc[spec.objKey], decodePropertyIds(r.doc))
        if (name === 'runs') {
          state.counters.seq[r.doc.id] = Number(r.last_seq)
          if (!TERMINAL.has(r.doc.state) && !hot.has(r.doc.id)) newlyHot.add(r.doc.id)
        }
      }
    }
    if (gen >= 0 && hot.size) {
      for (const [name, spec] of Object.entries(TABLES)) {
        if (!spec.child) continue
        const { rows } = await client.query(`select doc from ${spec.table} where org_id = $1 and gen > $2 and run_id = any($3::text[])`, [org_id, since, [...hot]])
        for (const r of rows) state[name].set(r.doc[spec.objKey], decodePropertyIds(r.doc))
      }
      const last = state.events.length ? state.events[state.events.length - 1].event_id : 0
      const { rows } = await client.query('select * from agent.run_event where org_id = $1 and event_id > $2 and run_id = any($3::text[]) order by event_id', [org_id, last, [...hot]])
      for (const r of rows) state.events.push(eventFromRow(r))
    }
    // retention / delete-on-request done in SQL: evict what the DB no longer holds
    const expired = [...state.runs.values()].filter((r) => r.evidence_expired_at && hot.has(r.id)).map((r) => r.id)
    if (gen >= 0) {
      const { rows: gone } = await client.query('select run_id from agent.deletion_log where gen > $1 and run_id is not null and (org_id = $2 or org_id is null)', [since, org_id])
      for (const g of gone) {
        state.runs.delete(g.run_id)
        for (const [jid, j] of state.researchJobs) if (j.run_id === g.run_id) state.researchJobs.delete(jid)
        delete state.counters.seq[g.run_id]
        expired.push(g.run_id)
      }
    }
    if (expired.length) evict(new Set(expired))
    await loadChildren(client, [...newlyHot].filter((id) => !state.runs.get(id)?.evidence_expired_at))
    const { rows: idem } = await client.query("select key, metadata from public.idempotency_ledger where scope = 'agent.tool' and retain_until > now()")
    state.idempotency = new Map(idem.map((r) => [`${IDEM_PREFIX}${r.key}`, r.metadata?.entry ?? r.metadata]))
    state.counters.event_id = Number(head.event_id)
    gen = Number(head.generation)
  }

  async function open() {
    const client = await pool.connect()
    try {
      await client.query('begin isolation level repeatable read read only')
      const { rows } = await client.query('select generation, event_id from agent.store_head where id = 1')
      if (!rows.length) throw new AgentError('PG_STORE_SCHEMA_MISSING', 'agent.store_head is missing — the S3 migration is not applied')
      // the store must run as the least-privilege role: never superuser, never BYPASSRLS
      const { rows: me } = await client.query('select current_user u, rolsuper, rolbypassrls from pg_roles where rolname = current_user')
      if (!allowPrivilegedRole && (me[0]?.rolsuper || me[0]?.rolbypassrls)) {
        throw new AgentError('PG_STORE_ROLE_TOO_PRIVILEGED', `the agent store refuses to run as ${me[0]?.u} (superuser or BYPASSRLS); connect as agent_api`)
      }
      // and must not be able to reach SECURITY DEFINER functions outside agent (allowlist: PostGIS metadata)
      const { rows: exposed } = await client.query(`select p.oid::regprocedure::text sig
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where p.prosecdef and n.nspname not in ('agent', 'pg_catalog', 'information_schema')
           and p.proname not in ('st_estimatedextent')
           and has_schema_privilege(current_user, n.oid, 'USAGE') and has_function_privilege(current_user, p.oid, 'EXECUTE')
         limit 5`)
      if (!allowPrivilegedRole && exposed.length) {
        throw new AgentError('PG_STORE_DEFINER_EXPOSURE', `the store role can execute SECURITY DEFINER functions outside agent: ${exposed.map((r) => r.sig).join(', ')}`)
      }
      const { rows: org } = await client.query('select 1 from agent.org where org_id = $1', [org_id])
      if (!org.length) throw new AgentError('PG_STORE_ORG_UNKNOWN', `org ${org_id} does not exist`)
      state = emptyState()
      hot.clear()
      gen = -1
      await syncFrom(client, rows[0])
      await client.query('commit')
      opened = true
    } catch (e) {
      await client.query('rollback').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  function diffWrites(before, ctx) {
    const writes = {}
    for (const [name, spec] of Object.entries(TABLES)) {
      const changed = []
      for (const [id, obj] of state[name].entries()) {
        const s = JSON.stringify(obj)
        if (before.json[name].get(id) !== s || (name === 'runs' && (before.counters.seq[id] || 0) !== (state.counters.seq[id] || 0))) changed.push(spec.row(obj, ctx))
      }
      for (const id of before.json[name].keys()) {
        if (!state[name].has(id)) throw new AgentError('PG_STORE_DELETE_REFUSED', `${spec.table} rows are never deleted by the runtime (${id})`)
      }
      if (changed.length) writes[name] = changed
    }
    for (const t of PG_STORE_UNPERSISTED_TABLES) {
      const touched = Array.isArray(state[t]) ? state[t].length !== before[t] : JSON.stringify([...state[t].entries()]) !== JSON.stringify([...before.json[t].entries()].map(([k, v]) => [k, JSON.parse(v)]))
      if (touched) throw new AgentError('PG_STORE_TABLE_NOT_PERSISTED', `${t} is not persisted in S3 (approvals, artifacts, ledger and audit are S4)`)
    }
    const events = state.events.slice(before.events)
    const idemUpserts = []
    const idemDeletes = []
    for (const [k, v] of state.idempotency.entries()) if (before.json.idempotency.get(k) !== JSON.stringify(v)) idemUpserts.push([k, v])
    for (const k of before.json.idempotency.keys()) if (!state.idempotency.has(k)) idemDeletes.push(k)
    return { writes, events, idemUpserts, idemDeletes }
  }

  async function transaction(fn) {
    if (!opened) throw new AgentError('PG_STORE_NOT_OPEN', 'call open() first')
    const run = async () => {
      const client = await pool.connect()
      let snap = null
      try {
        await client.query('begin')
        await client.query(`set local statement_timeout = ${Math.trunc(statementTimeoutMs)}`)
        await client.query("set local lock_timeout = '10s'")
        const { rows } = await client.query('select generation, event_id from agent.store_head where id = 1 for update')
        await syncFrom(client, rows[0])
        snap = snapshotState(state)
        const result = await fn(state)
        const nextGen = gen + 1
        const { writes, events, idemUpserts, idemDeletes } = diffWrites(snap, { org_id, gen: nextGen, seq: state.counters.seq })
        for (const e of events) {
          if (e.fixture) throw new AgentError('FIXTURE_EVENT_REFUSED', 'fixture events never enter the durable store')
          hot.add(e.run_id)
        }
        // parents before children (FKs); runs again after events is unnecessary: last_seq is in the same row write
        for (const name of ['runs', 'researchJobs', 'researchTasks', 'toolCalls', 'findings', 'conflicts']) {
          if (!writes[name]) continue
          await client.query(upsertSql(TABLES[name]), [JSON.stringify(writes[name].map((r) => ({ ...r, doc: encodePropertyIds(r.doc), ...('output' in r ? { output: encodePropertyIds(r.output) } : {}), ...('value' in r ? { value: encodePropertyIds(r.value) } : {}) })))])
          if (name === 'runs') for (const r of writes[name]) hot.add(r.run_id)
        }
        if (events.length) {
          await client.query(EVENT_INSERT_SQL, [JSON.stringify(events.map((e) => ({ ...e, payload: encodePropertyIds(e.payload), org_id, fixture: false })))])
        }
        for (const [k, v] of idemUpserts) {
          await client.query(`insert into public.idempotency_ledger (scope, key, status, metadata, started_at, completed_at, retain_until)
            values ('agent.tool', $1, $2, $3::jsonb, now(), case when $2 = 'completed' then now() end, now() + interval '30 days')
            on conflict (scope, key) do update set status = excluded.status, metadata = excluded.metadata, completed_at = excluded.completed_at, updated_at = now()`,
          [k.slice(IDEM_PREFIX.length), v?.state === 'succeeded' ? 'completed' : v?.state === 'failed' ? 'failed' : 'processing', JSON.stringify({ entry: v })])
        }
        for (const k of idemDeletes) await client.query("delete from public.idempotency_ledger where scope = 'agent.tool' and key = $1", [k.slice(IDEM_PREFIX.length)])
        await client.query('update agent.store_head set generation = $1, event_id = $2, updated_at = now() where id = 1', [nextGen, state.counters.event_id])
        await client.query('commit')
        gen = nextGen
        if (events.length) for (const cb of listeners) {
          try { cb(events) } catch { /* listener errors never roll back a commit */ }
        }
        return result
      } catch (error) {
        await client.query('rollback').catch(() => {})
        if (snap) restoreState(state, snap)
        throw mapPgError(error)
      } finally {
        client.release()
      }
    }
    const p = chain.then(run, run)
    chain = p.then(() => undefined, () => undefined)
    return p
  }

  /** Pull other processes' commits without writing (call before a read path). */
  async function refresh() {
    const go = async () => {
      const client = await pool.connect()
      try {
        await client.query('begin isolation level repeatable read read only')
        const { rows } = await client.query('select generation, event_id from agent.store_head where id = 1')
        await syncFrom(client, rows[0])
        await client.query('commit')
      } catch (e) {
        await client.query('rollback').catch(() => {})
        throw mapPgError(e)
      } finally {
        client.release()
      }
    }
    const p = chain.then(go, go)
    chain = p.then(() => undefined, () => undefined)
    return p
  }

  /** Load an older (terminal) run's events + child rows before a snapshot/replay. */
  async function hydrateRun(run_id) {
    if (hot.has(run_id) || !state.runs.has(run_id) || state.runs.get(run_id).evidence_expired_at) return
    const go = async () => {
      const client = await pool.connect()
      try {
        await client.query('begin isolation level repeatable read read only')
        await loadChildren(client, [run_id])
        await client.query('commit')
      } finally {
        client.release()
      }
    }
    const p = chain.then(go, go)
    chain = p.then(() => undefined, () => undefined)
    return p
  }

  return {
    kind: 'postgres',
    namespace: 'live',
    org_id,
    open,
    refresh,
    hydrateRun,
    transaction,
    read: () => state,
    onCommit(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    async close() {
      await chain.catch(() => {})
    },
  }
}

function mapPgError(error) {
  if (error instanceof AgentError) return error
  const code = error?.code
  const msg = String(error?.message || '')
  if (code === '23514' || code === '23505' || code === '23503' || code === '42501') {
    const e = new AgentError('PG_STORE_CONSTRAINT', msg.slice(0, 300), { pg_code: code, constraint: error.constraint || null })
    return e
  }
  if (code === '57014') return new AgentError('PG_STORE_TIMEOUT', 'statement timeout')
  if (code === '55P03') return new AgentError('PG_STORE_LOCK_TIMEOUT', 'lock timeout')
  return error
}

