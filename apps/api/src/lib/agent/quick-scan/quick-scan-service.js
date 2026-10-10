// Entity Graph QUICK SCAN — planner + dispatcher on the S1 spine (S3).
//
// One run (kind 'research', depth 'quick') per confirmed batch, on the SAME
// run service, research job service, event log and store as everything else.
//
//   preflight  → research job draft (estimate): exact property ids, scope hash,
//                tools + sources, $0 structural estimate, approvals (none: T0),
//                cancellation behaviour, mode/flag blockers. Nothing executes.
//   confirm    → scope hash must match exactly (a different scope is a new
//                job); the agent mode must allow T0; then the dispatcher runs.
//   dispatch   → per property × tool task (plan.task_added), concurrency 2
//                properties org-wide (investigation slots), tools sequential
//                inside a property. Every tool goes through authorizeToolCall
//                (registry: schema, mode ceiling, capability, role, session).
//                Each task emits task.started → source.retrieved →
//                observation.extracted → finding.upserted → task.completed
//                (or task.unavailable / task.failed / task.cancelled), each in
//                the same transaction as the task's state change.
//   cross-check→ finding.conflict per detected conflict (decisive only when
//                the evidence supports it), deterministic brief sections that
//                restate findings with citations (no model), job.property_state.
//   cancel     → research job cancel: unstarted tasks cancelled at once, the
//                in-flight read is abandoned at its boundary, run.cancelled
//                only after the dispatcher acknowledges.
//   recover    → after an API restart, tasks left 'running' become
//                'unavailable' (interrupted_by_restart) and are re-queued as
//                attempt 2; the job resumes. No event is duplicated (task
//                events are idempotent on run/task/type/attempt).
//
// $0 BY STRUCTURE: this module imports no ledger, no gateway, no provider and
// no HTTP client. Every planned adapter is access_mode 'supabase',
// billable false, and assertQuickScanPlan / assertDispatchable re-check it.
import { RESEARCH_DEPTH_LABELS } from '../contracts/states.js'
import { FINDING_TYPES, QUICK_SCAN_FINDING_TYPES, BRIEF_SECTIONS } from '../contracts/evidence.js'
import { renderOperationLabel } from '../contracts/events.js'
import { appendEventTx } from '../runtime/event-log.js'
import { AgentError } from '../runtime/store.js'
import { hashCanonical, newId } from '../runtime/canonical.js'
import { assertQuickScanPlan, assertDispatchable, assertTaskTransition } from '../research/research-jobs.js'
import { authorizeToolCall, projectOutput } from '../tools/registry.js'
import { isAgentEnabled, isAgentReadOnly, modeAllowsTier, resolveAgentMode } from '../config/agent-config.js'
import { DEFAULT_BUDGET_CONFIG } from '../budget/budget-config.js'
import { QUICK_SCAN_TOOL_NAMES, QUICK_SCAN_CAPABILITIES } from './tools.js'
import { QUICK_SCAN_SOURCES, listQuickScanSources } from './sources.js'
import { findingsFromTool, unavailableFindingsForTool, detectConflicts } from './evidence.js'

/** Tool → planned finding type (label) + primary source. Order = execution order. */
export const QUICK_SCAN_PLAN = Object.freeze([
  { tool: 'eg.property_core', finding_type: 'property_facts', source_id: 'lc.property_record' },
  { tool: 'eg.ownership', finding_type: 'ownership', source_id: 'lc.property_record' },
  { tool: 'eg.recorded_documents', finding_type: 'lien', source_id: 'lc.recorded_documents' },
  { tool: 'eg.sales_history', finding_type: 'transfer_history', source_id: 'lc.recorded_documents' },
  { tool: 'valuation.read', finding_type: 'valuation', source_id: 'lc.decision_engine' },
  { tool: 'eg.outreach_state', finding_type: 'outreach_state', source_id: 'lc.outreach' },
  { tool: 'eg.sms_eligibility', finding_type: 'sms_eligibility', source_id: 'lc.campaign_target_graph' },
  { tool: 'mi.zip_context', finding_type: 'market_context', source_id: 'lc.market_intelligence' },
  { tool: 'eg.street_view_availability', finding_type: 'street_view', source_id: 'lc.property_record' },
])

const TERMINAL_JOB = new Set(['completed', 'completed_partial', 'cancelled', 'failed', 'expired', 'budget_exhausted'])
const TASK_DONE = new Set(['succeeded', 'blocked', 'failed', 'cancelled', 'budget_stopped', 'skipped_fresh'])
const PROPERTY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/

function findingLabel(ft) {
  return (FINDING_TYPES[ft]?.label || QUICK_SCAN_FINDING_TYPES[ft]?.label || ft).toLowerCase()
}

/** The planned "adapter" for each tool, in the research adapter vocabulary. */
function adapterFor(step) {
  const src = QUICK_SCAN_SOURCES[step.source_id]
  return { id: `tool:${step.tool}`, version: 1, name: src.name, source_id: src.source_id, access_mode: 'supabase', billable: false, cost_bound: 'bounded' }
}
export const QUICK_SCAN_ADAPTERS = Object.freeze(new Map(QUICK_SCAN_PLAN.map((s) => [`tool:${s.tool}`, adapterFor(s)])))

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AgentError('TOOL_TIMEOUT', `timed out after ${ms} ms`)), ms)
    if (typeof t.unref === 'function') t.unref()
    const onAbort = () => { clearTimeout(t); reject(new AgentError('RUN_CANCELLED', 'run cancelled')) }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** Hash-derived id with NO digits (the event sanitizer masks 10+ digit runs as phones). */
export function letterId(prefix, value, len = 24) {
  return `${prefix}_${hashCanonical(value).slice(0, len).replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`
}
const taskIdFor = (job_id, property_id, tool) => letterId('rtask', { job_id, property_id, tool })

/** The DB slot guard refused a lease write (agent.research_slot_guard). */
export const isSlotLimitError = (e) => e?.code === 'PG_STORE_CONSTRAINT' && /research slot limit/.test(String(e?.message || ''))

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref() })

/**
 * @param {{ store, runService, researchJobs, registry, createServices: (run_id: string) => object,
 *   env?: object, systemControlMode?: string|null, now?: () => Date, leaseOwner?: string, leaseTtlMs?: number }} deps
 */
export function createQuickScanService({ store, runService, researchJobs, registry, createServices, env = process.env, systemControlMode = null, now = () => new Date(), leaseOwner = `qs-${process.pid}-${Date.now().toString(36)}`, leaseTtlMs = 15_000, eventLog = null, config = DEFAULT_BUDGET_CONFIG, slotPollMs = 500 } = {}) {
  if (!store || !runService || !researchJobs || !registry || typeof createServices !== 'function') throw new Error('quick scan deps missing')
  const evOpts = { now }
  const active = new Map() // job_id → promise

  const mode = () => resolveAgentMode({ env, systemControlMode })

  function toolCtx(run) {
    // review-only: authorizeToolCall refuses anything but small T0 reads (AGENT_READ_ONLY)
    return { mode: mode(), enabled_capabilities: QUICK_SCAN_CAPABILITIES, role: 'operator', session_user_id: run.operator_id, identity: null, read_only: isAgentReadOnly(env) }
  }

  /** Kill switch (AGENT_ENABLED off): stop at the next task boundary, attributed to the system, $0. */
  async function killSwitchStop(job_id) {
    const job = store.read().researchJobs.get(job_id)
    if (!job || TERMINAL_JOB.has(job.state)) return
    try { await researchJobs.cancel({ job_id, requested_by: 'system:kill_switch' }) } catch { /* already terminal */ }
  }

  function describeTools() {
    return QUICK_SCAN_PLAN.map((step) => {
      const spec = registry.get(step.tool)
      return { name: spec.name, label: spec.label, tier: spec.tier, capability: spec.capability, cost_class: spec.cost_class, billable: false, sources: spec.sources, wraps: { route: spec.wraps.route, export: spec.wraps.export } }
    })
  }

  // ── preflight ─────────────────────────────────────────────────────────────
  async function preflight({ operator_id, property_ids, identity = null }) {
    if (!operator_id) throw new AgentError('SESSION_REQUIRED', 'an operator session is required')
    if (!isAgentEnabled(env)) throw new AgentError('AGENT_DISABLED', 'the agent kill switch is off (AGENT_ENABLED)')
    const ids = [...new Set((Array.isArray(property_ids) ? property_ids : []).map((x) => String(x ?? '').trim()).filter(Boolean))]
    if (!ids.length) throw new AgentError('RESEARCH_EMPTY_SCOPE', 'select at least one property')
    const bad = ids.filter((id) => !PROPERTY_ID_RE.test(id))
    if (bad.length) throw new AgentError('PROPERTY_ID_INVALID', `${bad.length} property id(s) are not valid ids`)
    const m = mode()
    const blockers = []
    if (!modeAllowsTier(m, 'T0')) blockers.push({ code: 'AGENT_MODE_CEILING', message: `Agent mode is "${m}": read tools are disabled (AGENT_MAX_MODE).` })
    const est = await researchJobs.estimate({ operator_id, property_ids: ids, depth: 'quick', identity })
    const job = store.read().researchJobs.get(est.job_id)
    return {
      ok: true,
      live: true,
      fixture: false,
      job_id: est.job_id,
      run_id: est.run_id,
      depth: 'quick',
      depth_label: RESEARCH_DEPTH_LABELS.quick,
      scope: { property_ids: job.property_ids, property_count: job.property_ids.length, batch_index: job.batch_index, batch_of: job.batch_of, deferred_property_count: ids.length - job.property_ids.length },
      scope_hash: est.scope_hash,
      scope_sentence: `Quick Scan ${job.property_ids.length} ${job.property_ids.length === 1 ? 'property' : 'properties'} · read-only LeadCommand records · $0 (no billable operations exist)`,
      estimate: est.estimate,
      max_budget_usd: 0,
      tools: describeTools(),
      sources: listQuickScanSources(),
      approval: { required: false, reason: 'Every Quick Scan tool is T0 (read). Nothing is written outside the local agent store.' },
      cancellation: 'Cancel stops before the next read. Unstarted reads are cancelled immediately; the read in flight is abandoned; findings already gathered are kept.',
      limits: { max_per_batch: 50, test_batch_max: 10, concurrency: 2 },
      ai: { enabled: false, reason: 'Model gateway refuses every call (models not approved).' },
      mode: m,
      can_run: blockers.length === 0,
      blockers,
      expires_at: job.expires_at,
    }
  }

  // ── confirm → run ─────────────────────────────────────────────────────────
  async function confirm({ job_id, scope_hash, operator_id }) {
    const job = store.read().researchJobs.get(job_id)
    if (!job) throw new AgentError('JOB_NOT_FOUND', job_id)
    if (job.depth !== 'quick') throw new AgentError('NOT_A_QUICK_SCAN', job_id)
    const run = store.read().runs.get(job.run_id)
    if (operator_id && run.operator_id !== operator_id) throw new AgentError('OPERATOR_MISMATCH', 'a job is confirmed by the operator who prepared it')
    if (!isAgentEnabled(env)) throw new AgentError('AGENT_DISABLED', 'the agent kill switch is off (AGENT_ENABLED)')
    if (!modeAllowsTier(mode(), 'T0')) throw new AgentError('AGENT_MODE_CEILING', `agent mode "${mode()}" does not allow read tools`)
    const res = await researchJobs.confirm({ job_id, scope_hash }) // JOB_SCOPE_CHANGED on mismatch
    const done = dispatch(job_id)
    return { ok: true, job_id, run_id: job.run_id, state: res.state, done }
  }

  function dispatch(job_id) {
    if (active.has(job_id)) return active.get(job_id)
    const p = runJob(job_id)
      .catch((error) => {
        if (error?.code !== 'LEASE_LOST') return failJob(job_id, error)
        // fenced out: the new owner continues; re-check later in case it dies too
        const tm = setTimeout(() => { recover().catch(() => {}) }, leaseTtlMs + 50)
        if (typeof tm.unref === 'function') tm.unref()
        return { state: 'lease_lost' }
      })
      .finally(() => active.delete(job_id))
    active.set(job_id, p)
    return p
  }

  async function failJob(job_id, error) {
    try {
      await store.transaction((tx) => {
        const job = tx.researchJobs.get(job_id)
        const run = tx.runs.get(job.run_id)
        if (TERMINAL_JOB.has(job.state)) return
        job.state = 'failed'
        appendEventTx(tx, { run_id: run.id, type: 'job.failed', payload: { error_code: error?.code || 'QUICK_SCAN_FAILED', accrued_usd: 0 } }, evOpts)
        if (!['completed', 'completed_partial', 'cancelled', 'failed', 'expired', 'budget_exhausted'].includes(run.state)) {
          runService.transitionTx(tx, run.id, 'failed', error?.code || 'quick_scan_failed')
          appendEventTx(tx, { run_id: run.id, type: 'run.failed', payload: { error_code: error?.code || 'QUICK_SCAN_FAILED', retryable: false, accrued_usd: 0 } }, evOpts)
        }
        run.lease_owner = null
      })
    } catch { /* already terminal */ }
    return { state: 'failed', error_code: error?.code || 'QUICK_SCAN_FAILED' }
  }

  function cancelPending(tx, job) {
    const run = tx.runs.get(job.run_id)
    return job.state === 'cancelled' || Boolean(run.cancel_requested_at)
  }

  async function heartbeat(run_id) {
    try { await runService.claimLease(run_id, { owner: leaseOwner, ttl_ms: leaseTtlMs }) } catch (e) {
      if (e.code === 'RUN_CANCEL_PENDING') return
      if (isSlotLimitError(e)) return // cap full while our lease lapsed: the next claim waits for a slot
      if (e.code === 'LEASE_HELD' || e.code === 'RUN_TERMINAL') throw new AgentError('LEASE_LOST', 'another worker took over (or finished) this run while our lease was expired')
      throw e
    }
  }

  function interruptRunningTasksTx(tx, job, run) {
    for (const t of tx.researchTasks.values()) {
      if (t.job_id !== job.job_id || t.state !== 'running') continue
      assertTaskTransition('running', 'unavailable')
      t.state = 'unavailable'
      appendEventTx(tx, { run_id: run.id, property_id: t.property_id, task_id: t.task_id, tool_call_id: t.tool_call_id, attempt: t.attempt, type: 'task.unavailable', payload: { reason: 'interrupted_by_restart', retry_at: now().toISOString() } }, evOpts)
      t.attempt += 1 // the retry is the next attempt: its events never collide with the interrupted one
    }
  }

  /**
   * Claim (or renew) the run lease AND a research slot in ONE transaction.
   * Slots: at most `config.research.concurrency` (2, lower-only) research runs
   * hold a live lease at once — counted over every run the store sees, so with
   * the Postgres store the cap holds across all workers/instances (and the DB
   * trigger agent.research_slot_guard re-checks it).
   * @returns {Promise<'claimed'|'held'|'full'|'cancel'|'terminal'>}
   */
  async function claimJobLease(job_id) {
    return claimJobLeaseTx(job_id).catch((e) => { if (isSlotLimitError(e)) return 'full'; throw e })
  }
  async function claimJobLeaseTx(job_id) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      const run = tx.runs.get(job.run_id)
      if (TERMINAL_JOB.has(job.state) && job.state !== 'cancelled') return 'terminal'
      if (run.cancel_requested_at || job.state === 'cancelled') return 'cancel'
      const t = now().getTime()
      const live = (r) => Boolean(r.lease_owner) && Date.parse(r.lease_until) > t
      if (live(run) && run.lease_owner !== leaseOwner) return 'held'
      if (!live(run)) {
        const cap = Math.max(1, Math.min(2, Number(config?.research?.concurrency ?? 2)))
        let active = 0
        for (const r of tx.runs.values()) {
          if (r.id !== run.id && r.kind === 'research' && !r.ended_at && !['completed', 'completed_partial', 'budget_exhausted', 'cancelled', 'failed', 'expired'].includes(r.state) && live(r)) active += 1
        }
        if (active >= cap) {
          if (!job.slot_wait_noted) {
            job.slot_wait_noted = true
            appendEventTx(tx, { run_id: run.id, type: 'decision', payload: { summary: `Waiting for a research slot: ${active} research ${active === 1 ? 'job is' : 'jobs are'} running (limit ${cap}). This scan starts when one finishes.`, criterion: 'research_slot_wait', basis_finding_ids: [], basis_refs: [] } }, evOpts)
          }
          return 'full'
        }
      }
      if (run.lease_owner && run.lease_owner !== leaseOwner) {
        // taking over from a worker whose lease EXPIRED: its in-flight reads are
        // reported interrupted and re-run as the next attempt (same transaction)
        interruptRunningTasksTx(tx, job, run)
      }
      run.lease_owner = leaseOwner
      run.lease_until = new Date(t + leaseTtlMs).toISOString()
      run.heartbeat_at = new Date(t).toISOString()
      return 'claimed'
    })
  }

  async function plan(job_id) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      const run = tx.runs.get(job.run_id)
      if (job.planned) return { already: true }
      if (job.state === 'queued') {
        job.state = 'running'
        if (run.state === 'created') runService.transitionTx(tx, run.id, 'running', 'quick_scan_confirmed')
      }
      appendEventTx(tx, { run_id: run.id, type: 'job.phase', payload: { phase: 'planning' } }, evOpts)
      const tasks = []
      for (const property_id of job.property_ids) {
        for (const step of QUICK_SCAN_PLAN) tasks.push({ property_id, finding_type: step.finding_type, adapter_id: `tool:${step.tool}`, tool: step.tool, source_id: step.source_id })
      }
      assertQuickScanPlan(tasks, QUICK_SCAN_ADAPTERS)
      for (const t of tasks) {
        const a = QUICK_SCAN_ADAPTERS.get(t.adapter_id)
        const task_id = taskIdFor(job_id, t.property_id, t.tool)
        const row = { task_id, job_id, run_id: run.id, property_id: t.property_id, finding_type: t.finding_type, adapter_id: a.id, tool: t.tool, source_id: t.source_id, state: 'planned', attempt: 1, billable: false, idempotency_key: hashCanonical({ property_id: t.property_id, finding_type: t.finding_type, adapter_id: a.id, adapter_version: a.version }), output: null, tool_call_id: null }
        tx.researchTasks.set(task_id, row)
        const vars = { jurisdiction: 'LeadCommand', finding_label: findingLabel(t.finding_type), source_name: a.name }
        appendEventTx(tx, { run_id: run.id, property_id: t.property_id, task_id, type: 'plan.task_added', payload: { task_id, operation: 'research.check', adapter_id: a.id, source_id: a.source_id, finding_type: t.finding_type, depends_on: t.tool === 'mi.zip_context' ? [taskIdFor(job_id, t.property_id, 'eg.property_core')] : [], billable: false }, label_vars: vars }, evOpts)
      }
      for (const property_id of job.property_ids) {
        appendEventTx(tx, { run_id: run.id, property_id, type: 'job.property_state', payload: { state: 'queued', phase: 'planning', opportunity_class: 'unknown', contact_readiness_class: 'unknown', counters: { tasks: QUICK_SCAN_PLAN.length } } }, evOpts)
      }
      appendEventTx(tx, { run_id: run.id, type: 'job.phase', payload: { phase: 'researching' } }, evOpts)
      job.planned = true
      return { already: false }
    })
  }

  async function runJob(job_id) {
    let job = store.read().researchJobs.get(job_id)
    if (!job) throw new AgentError('JOB_NOT_FOUND', job_id)
    if (TERMINAL_JOB.has(job.state)) return { state: job.state }
    // lease + research slot (org-wide cap, counted in the same transaction that claims)
    for (;;) {
      const r = await claimJobLease(job_id)
      if (r === 'claimed' || r === 'cancel') break
      if (r === 'terminal') return { state: store.read().researchJobs.get(job_id).state }
      await sleep(r === 'held' ? 250 : slotPollMs)
    }
    await plan(job_id)
    const signal = runService.signalFor(job.run_id)
    const services = createServices(job.run_id)
    job = store.read().researchJobs.get(job_id)
    const queue = [...job.property_ids]
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        const pid = queue.shift()
        const key = `${job_id}:${pid}`
        while (!researchJobs.claimInvestigationSlot(key)) await sleep(50)
        try {
          await scanProperty({ job_id, property_id: pid, services, signal })
        } finally {
          researchJobs.releaseInvestigationSlot(key)
        }
      }
    })
    await Promise.all(workers)
    return finish(job_id)
  }

  async function scanProperty({ job_id, property_id, services, signal }) {
    const started = await store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      if (cancelPending(tx, job)) return false
      if ((job.cross_checked_property_ids || []).includes(property_id)) return false // finished before a restart: nothing to redo
      appendEventTx(tx, { run_id: job.run_id, property_id, type: 'job.property_state', payload: { state: 'running', phase: 'researching' } }, evOpts)
      return true
    })
    if (!started) return
    for (const step of QUICK_SCAN_PLAN) {
      if (!isAgentEnabled(env)) { await killSwitchStop(job_id); return } // kill switch: nothing new starts
      const task_id = taskIdFor(job_id, property_id, step.tool)
      let r = await runTask({ job_id, task_id, services, signal })
      while (r === 'slot_wait') { // the DB refused renewing our lapsed lease while the cap is full: back off, retry
        await sleep(slotPollMs)
        r = await runTask({ job_id, task_id, services, signal })
      }
      if (r === 'cancelled') return
      await heartbeat(store.read().researchJobs.get(job_id).run_id)
    }
    await crossCheckProperty({ job_id, property_id })
  }

  function outputsFor(tx, job_id, property_id) {
    const outputs = {}
    for (const t of tx.researchTasks.values()) if (t.job_id === job_id && t.property_id === property_id && t.output) outputs[t.tool] = t.output
    return outputs
  }

  async function runTask({ job_id, task_id, services, signal }) {
    // claim: planned/unavailable → queued → running + task.started (one tx)
    let claim
    try {
    claim = await store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      const task = tx.researchTasks.get(task_id)
      if (!task || TASK_DONE.has(task.state) || task.final_unavailable) return { skip: task?.state || 'missing' }
      if (cancelPending(tx, job)) return { skip: 'cancelled' }
      const run = tx.runs.get(job.run_id)
      if (run.lease_owner !== leaseOwner) throw new AgentError('LEASE_LOST', 'this worker no longer holds the lease on this run')
      if (!(Date.parse(run.lease_until) > now().getTime())) {
        // still ours (nobody took over): renew inside this claim
        run.lease_until = new Date(now().getTime() + leaseTtlMs).toISOString()
        run.heartbeat_at = now().toISOString()
      }
      if (task.state === 'running') return { skip: 'running_elsewhere' } // never double-run a task
      const adapter = QUICK_SCAN_ADAPTERS.get(task.adapter_id)
      assertDispatchable(task, job, adapter)
      if (task.state === 'planned' || task.state === 'unavailable') {
        assertTaskTransition(task.state, 'queued')
        task.state = 'queued'
      }
      assertTaskTransition(task.state, 'running')
      task.state = 'running'
      const tool_call_id = letterId('tc', { task_id, attempt: task.attempt })
      task.tool_call_id = tool_call_id
      const spec = registry.get(task.tool)
      tx.toolCalls.set(tool_call_id, { id: tool_call_id, run_id: run.id, turn_id: null, tool: task.tool, tool_version: spec.version, tier: spec.tier, input: { property_id: task.property_id }, input_hash: hashCanonical({ property_id: task.property_id }), state: 'executing', target_refs: [`property:${task.property_id}`], created_at: now().toISOString(), task_id })
      run.tool_call_count = (run.tool_call_count || 0) + 1
      const vars = { jurisdiction: 'LeadCommand', finding_label: findingLabel(task.finding_type), source_name: adapter.name }
      appendEventTx(tx, { run_id: run.id, property_id: task.property_id, task_id, tool_call_id, attempt: task.attempt, type: 'task.started', payload: { operation: 'research.check', source_id: adapter.source_id, adapter_id: adapter.id, finding_type: task.finding_type }, label_vars: vars }, evOpts)
      return { task: { ...task }, run: { ...run }, spec, outputs: outputsFor(tx, job_id, task.property_id) }
    })
    } catch (e) {
      if (isSlotLimitError(e)) return 'slot_wait'
      throw e
    }
    if (claim.skip) return claim.skip === 'cancelled' ? 'cancelled' : 'skipped'
    const { task, run, spec, outputs } = claim

    let input = { property_id: task.property_id }
    let preUnavailable = null
    if (task.tool === 'mi.zip_context') {
      const zip = String(outputs['eg.property_core']?.facts?.property_address_zip ?? '').slice(0, 5)
      if (/^\d{5}$/.test(zip)) input = { zip, property_id: task.property_id }
      else preUnavailable = 'zip_unknown'
    }
    const t0 = Date.now()
    let output = null
    let error = null
    let refusal = null
    // keep the lease alive while a (possibly slow, ≤ 30 s) read is in flight
    const beat = setInterval(() => { heartbeat(run.id).catch(() => {}) }, Math.max(50, Math.floor(leaseTtlMs / 3)))
    if (typeof beat.unref === 'function') beat.unref()
    try {
    if (!preUnavailable) {
      const auth = authorizeToolCall({ registry, tool: task.tool, input, ctx: toolCtx(run) })
      if (auth.decision !== 'allow') refusal = auth.code
      else {
        const attempts = spec.failure.retry === 'read_retry_once' ? 2 : 1
        for (let i = 0; i < attempts; i += 1) {
          try {
            const raw = await withTimeout(Promise.resolve().then(() => spec.execute(input, { run_id: run.id, tool_call_id: task.tool_call_id, services, signal })), spec.limits.timeout_ms, signal)
            output = projectOutput(spec, raw).projected
            error = null
            break
          } catch (e) {
            error = e
            if (e?.code === 'RUN_CANCELLED' || e?.unavailable || e?.refusal === false) break
          }
        }
      }
    }
    } finally {
      clearInterval(beat)
    }
    const duration_ms = Date.now() - t0
    const retrieved_at = now().toISOString()

    return store.transaction((tx) => {
      const row = tx.researchTasks.get(task_id)
      const call = tx.toolCalls.get(task.tool_call_id)
      const base = { run_id: run.id, property_id: row.property_id, task_id, tool_call_id: task.tool_call_id, attempt: row.attempt }
      if (row.state !== 'running') return 'skipped' // cancelled underneath us
      if (row.tool_call_id !== task.tool_call_id) return 'skipped' // fenced: another worker re-ran this task (newer attempt)
      if (error?.code === 'RUN_CANCELLED') {
        assertTaskTransition('running', 'cancelled')
        row.state = 'cancelled'
        call.state = 'failed'
        call.error_code = 'RUN_CANCELLED'
        appendEventTx(tx, { ...base, type: 'task.cancelled', payload: { after_cancel: true } }, evOpts)
        return 'cancelled'
      }
      const fctx = { run_id: run.id, property_id: row.property_id, retrieved_at, now: now() }
      let findings
      let outcome
      if (refusal) {
        findings = unavailableFindingsForTool(row.tool, fctx, `tool_refused:${refusal}`)
        outcome = { type: 'task.failed', state: 'failed', payload: { error_code: refusal, duration_ms, retry_at: null } }
        call.state = 'refused'
        call.refusal_code = refusal
      } else if (preUnavailable || error?.unavailable) {
        const reason = preUnavailable || String(error.code || 'unavailable').toLowerCase()
        findings = unavailableFindingsForTool(row.tool, fctx, reason)
        outcome = { type: 'task.unavailable', state: 'unavailable', payload: { reason, retry_at: null } }
        call.state = 'succeeded'
        row.final_unavailable = true
      } else if (error) {
        const code = error.code === 'TOOL_TIMEOUT' || error.code === 'READ_TIMEOUT' ? 'timeout' : String(error.code || 'read_failed')
        findings = unavailableFindingsForTool(row.tool, fctx, code === 'timeout' ? 'timeout' : 'read_failed')
        outcome = { type: 'task.failed', state: 'failed', payload: { error_code: code, duration_ms, retry_at: null } }
        call.state = 'failed'
        call.error_code = code
        appendEventTx(tx, { ...base, type: 'source.failed', payload: { source_id: row.source_id, host: 'leadcommand', reason: code === 'timeout' ? 'timeout' : 'http_5xx', retry_at: null } }, evOpts)
      } else {
        findings = findingsFromTool(row.tool, output, fctx)
        row.output = output
        call.state = 'succeeded'
        call.duration_ms = duration_ms
        const fetch_id = letterId('fetch', { task_id, attempt: row.attempt }, 16)
        // one task-scoped source event (idempotent on run/task/type/attempt); secondary sources carry no task_id
        spec.sources.forEach((source_id, i) => {
          appendEventTx(tx, { ...base, task_id: i === 0 ? task_id : null, type: 'source.retrieved', payload: { source_id, host: 'leadcommand', http_class: '2xx', bytes: null, retrieved_at, fetch_id, purpose: findingLabel(row.finding_type) } }, evOpts)
        })
        outcome = { type: 'task.completed', state: 'succeeded', payload: { duration_ms, cost_usd: 0, finding_count: findings.filter((f) => f.value !== null).length } }
      }
      const valued = findings.filter((f) => f.value !== null)
      if (valued.length) {
        appendEventTx(tx, { ...base, type: 'observation.extracted', payload: { observation_ids: valued.map((f) => f.finding_id), finding_type: valued[0].finding_type, display_value: valued.length > 1 ? `${valued[0].display_value} (+${valued.length - 1} more)` : valued[0].display_value, citation: valued[0].citation } }, evOpts)
      }
      const actor_user_id = String(tx.runs.get(run.id).operator_id)
      for (const f of findings) {
        f.actor_user_id = actor_user_id // actor stamp (Gate B): the run's named operator
        tx.findings.set(f.finding_id, f)
        appendEventTx(tx, { ...base, type: 'finding.upserted', payload: { finding: f } }, evOpts)
      }
      assertTaskTransition('running', outcome.state)
      row.state = outcome.state
      row.duration_ms = duration_ms
      appendEventTx(tx, { ...base, type: outcome.type, payload: outcome.payload }, evOpts)
      return outcome.state
    })
  }

  async function crossCheckProperty({ job_id, property_id }) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      if (cancelPending(tx, job)) return
      if ((job.cross_checked_property_ids || []).includes(property_id)) return
      job.cross_checked_property_ids = [...(job.cross_checked_property_ids || []), property_id]
      const run_id = job.run_id
      const findings = [...tx.findings.values()].filter((f) => f.run_id === run_id && f.property_id === property_id)
      const outputs = outputsFor(tx, job_id, property_id)
      const conflicts = detectConflicts({ run_id, property_id, findings, outputs })
      for (const c of conflicts) {
        tx.conflicts.set(c.conflict_group_id, { ...c, run_id, job_id })
        appendEventTx(tx, { run_id, property_id, type: 'finding.conflict', payload: { conflict_group_id: c.conflict_group_id, finding_type: c.finding_type, members: c.members, rule: c.rule, resolution_state: c.resolution_state, best_supported: c.best_supported, reason: c.reason, remaining_uncertainty: c.remaining_uncertainty, follow_up: c.follow_up } }, evOpts)
        for (const m of c.members) {
          const f = tx.findings.get(m.finding_id)
          if (!f) continue
          f.conflict_group_id = c.conflict_group_id
          if (c.resolution_state === 'resolved_by_rule' && c.best_supported && m.finding_id !== c.best_supported.finding_id) f.contradicted_by = c.best_supported.finding_id
        }
        // re-emit members so the UI's finding view carries the conflict link
        for (const m of c.members) {
          const f = tx.findings.get(m.finding_id)
          if (!f) continue
          const winner = c.resolution_state === 'resolved_by_rule' && c.best_supported?.finding_id === f.finding_id
          const loser = c.members.find((x) => x.finding_id !== f.finding_id)
          appendEventTx(tx, { run_id, property_id, type: 'finding.upserted', payload: { finding: { ...f, ...(winner && loser ? { contradicts_id: loser.finding_id } : {}) } } }, evOpts)
        }
      }
      // deterministic brief: findings restated with citations; no model
      const sections = briefSections(findings, conflicts)
      for (const s of sections) {
        appendEventTx(tx, { run_id, property_id, type: 'brief.section', payload: { property_id, section_key: s.key, label: s.label, claims: s.claims, claim_count: s.claims.length, finding_refs: [...new Set(s.claims.flatMap((c) => c.finding_ids))] } }, evOpts)
      }
      const tasks = [...tx.researchTasks.values()].filter((t) => t.job_id === job_id && t.property_id === property_id)
      const partial = tasks.some((t) => t.state !== 'succeeded') || tasks.some((t) => t.final_unavailable)
      const sms = findings.find((f) => f.finding_type === 'sms_eligibility')
      const readiness = !sms || sms.value === null ? 'unknown' : sms.value.eligible ? 'ready' : 'ineligible'
      const pcore = outputs['eg.property_core']
      const open = conflicts.filter((c) => c.resolution_state === 'open').length
      const unavailableCount = findings.filter((f) => f.value === null).length
      appendEventTx(tx, { run_id, property_id, type: 'brief.completed', payload: { opportunity_class: 'unknown', contact_readiness_class: readiness, sections_missing: BRIEF_SECTIONS.map((b) => b.key).filter((k) => !sections.some((s) => s.key === k)) } }, evOpts)
      appendEventTx(tx, { run_id, property_id, type: 'job.property_state', payload: { state: partial ? 'completed_partial' : 'completed', phase: 'complete', opportunity_class: 'unknown', contact_readiness_class: readiness, display_address: pcore?.display_address || null, counters: { findings: findings.length, with_value: findings.length - unavailableCount, unavailable: unavailableCount, conflicts_open: open, conflicts_resolved: conflicts.length - open } } }, evOpts)
    })
  }

  async function finish(job_id) {
    const res = await store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      const run = tx.runs.get(job.run_id)
      if (TERMINAL_JOB.has(job.state) && job.state !== 'cancelled') return { state: job.state }
      if (cancelPending(tx, job)) {
        for (const t of tx.researchTasks.values()) {
          if (t.job_id !== job_id) continue
          if (!t.final_unavailable && (t.state === 'planned' || t.state === 'queued' || t.state === 'unavailable')) {
            t.state = 'cancelled'
            appendEventTx(tx, { run_id: run.id, property_id: t.property_id, task_id: t.task_id, attempt: t.attempt, type: 'task.cancelled', payload: { after_cancel: false } }, evOpts)
          }
        }
        if (job.state !== 'cancelled') {
          job.state = 'cancelled'
          appendEventTx(tx, { run_id: run.id, type: 'job.cancelled', payload: { summary: 'Cancelled. Findings gathered so far are kept.', accrued_usd: 0 } }, evOpts)
        }
        return { state: 'cancelled', acknowledge: true }
      }
      const tasks = [...tx.researchTasks.values()].filter((t) => t.job_id === job_id)
      const findings = [...tx.findings.values()].filter((f) => f.run_id === run.id)
      const conflicts = [...tx.conflicts.values()].filter((c) => c.job_id === job_id)
      const failed = tasks.filter((t) => t.state === 'failed').length
      const partial = tasks.some((t) => t.state !== 'succeeded' || t.final_unavailable)
      appendEventTx(tx, { run_id: run.id, type: 'job.phase', payload: { phase: 'cross_checking' } }, evOpts)
      const withValue = findings.filter((f) => f.value !== null).length
      const summary = `Quick Scan read ${job.property_ids.length} ${job.property_ids.length === 1 ? 'property' : 'properties'}: ${withValue} findings with a value, ${findings.length - withValue} unavailable, ${conflicts.filter((c) => c.resolution_state === 'open').length} unresolved and ${conflicts.filter((c) => c.resolution_state !== 'open').length} resolved conflicts${failed ? `, ${failed} failed reads` : ''}. $0.`
      appendEventTx(tx, { run_id: run.id, type: 'decision', payload: { summary, criterion: 'quick_scan_summary', basis_finding_ids: [], basis_refs: conflicts.map((c) => c.conflict_group_id) } }, evOpts)
      job.state = 'synthesizing' // required by the job machine; no model runs (deterministic assembly only)
      const final = partial ? 'completed_partial' : 'completed'
      job.state = final
      job.ended_at = now().toISOString()
      appendEventTx(tx, { run_id: run.id, type: 'job.phase', payload: { phase: 'complete' } }, evOpts)
      appendEventTx(tx, { run_id: run.id, type: 'job.completed', payload: { state: final, summary, accrued_usd: 0, counters: { tasks: tasks.length, failed, findings: findings.length, conflicts: conflicts.length } } }, evOpts)
      run.lease_owner = null
      run.lease_until = null
      runService.transitionTx(tx, run.id, final, 'quick_scan_finished')
      appendEventTx(tx, { run_id: run.id, type: 'run.completed', payload: { state: final, summary, accrued_usd: 0 } }, evOpts)
      return { state: final }
    })
    if (res.acknowledge) {
      const run = store.read().runs.get(store.read().researchJobs.get(job_id).run_id)
      if (run.state !== 'cancelled') await runService.acknowledgeCancel(run.id, { after_cancel_settled_usd: 0, summary: 'Cancelled. Findings gathered so far are kept. $0 spent.' })
      return { state: 'cancelled' }
    }
    return res
  }

  // ── cancel / reads ────────────────────────────────────────────────────────
  function jobForRun(run_id) {
    for (const j of store.read().researchJobs.values()) if (j.run_id === run_id) return j
    return null
  }

  async function cancel({ run_id, requested_by = null }) {
    const job = jobForRun(run_id)
    if (!job) throw new AgentError('RUN_NOT_FOUND', run_id)
    const wasDraft = job.state === 'draft'
    const res = await researchJobs.cancel({ job_id: job.job_id, requested_by })
    const runNow = store.read().runs.get(run_id)
    if (!active.has(job.job_id) && !['cancelled', 'completed', 'completed_partial', 'failed', 'expired', 'budget_exhausted'].includes(runNow.state) && runNow.cancel_requested_at) {
      // no dispatcher alive (draft, queued-not-started, or after a restart): acknowledge here
      await runService.acknowledgeCancel(run_id, { after_cancel_settled_usd: 0, summary: wasDraft ? 'Cancelled before it started. $0 spent.' : 'Cancelled. Findings gathered so far are kept. $0 spent.' })
    }
    return { ok: true, run_id, job_state: store.read().researchJobs.get(job.job_id).state, pending: active.has(job.job_id) && store.read().runs.get(run_id).state !== 'cancelled', ...('running' in res ? { running: res.running } : {}) }
  }

  function evidenceExpiry(run) {
    if (!run?.evidence_expired_at) return null
    return { expired: true, expired_at: run.evidence_expired_at, ...(run.evidence_expiry || {}), notice: `Evidence expired on ${String(run.evidence_expired_at).slice(0, 10)} under the retention policy. Findings, events and conflicts for this run are no longer available; the run summary is kept.` }
  }

  function snapshot(run_id) {
    const runRow = store.read().runs.get(run_id)
    const expiry = evidenceExpiry(runRow)
    if (expiry) {
      const job = jobForRun(run_id)
      return {
        run_id, kind: runRow.kind, state: runRow.state, live: true, fixture: false,
        store: { kind: store.kind, namespace: store.namespace || 'memory' },
        evidence_complete: false, evidence_expired: expiry,
        last_event_id: null, last_seq: null, view: null, findings: [], conflicts: [],
        cost: { accrued_usd: runRow.accrued_usd },
        job: job ? { job_id: job.job_id, state: job.state, depth: job.depth, property_ids: job.property_ids, created_at: job.created_at, ended_at: job.ended_at || null } : null,
        dispatcher_active: false,
      }
    }
    const snap = runService.snapshot(run_id)
    if (!snap) return null
    const job = jobForRun(run_id)
    const state = store.read()
    return {
      evidence_complete: true,
      evidence_expired: null,
      ...snap,
      live: true,
      fixture: false,
      store: { kind: store.kind, namespace: store.namespace || 'memory' },
      job: job ? { job_id: job.job_id, state: job.state, depth: job.depth, property_ids: job.property_ids, scope_hash: job.scope_hash, created_at: job.created_at, ended_at: job.ended_at || null } : null,
      findings: [...state.findings.values()].filter((f) => f.run_id === run_id),
      conflicts: [...state.conflicts.values()].filter((c) => c.run_id === run_id),
      dispatcher_active: job ? active.has(job.job_id) : false,
    }
  }


  function history({ limit = 50, operator_id = null } = {}) {
    const state = store.read()
    const rows = []
    for (const job of state.researchJobs.values()) {
      if (job.depth !== 'quick') continue
      const run = state.runs.get(job.run_id)
      if (!run || (operator_id && run.operator_id !== operator_id)) continue
      rows.push({ run_id: run.id, job_id: job.job_id, title: run.title, state: run.state, job_state: job.state, property_count: job.property_ids.length, created_at: run.created_at, ended_at: run.ended_at, accrued_usd: run.accrued_usd, evidence_expired_at: run.evidence_expired_at || null, live: true, fixture: false })
    }
    return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Math.max(1, Math.min(200, limit)))
  }

  /** After a restart: re-queue interrupted tasks and resume confirmed jobs. */
  let recoverTimer = null
  /**
   * Take over confirmed scans whose worker is gone. A run whose lease is still
   * live belongs to a running worker (possibly another instance): it is NOT
   * touched; a re-check is scheduled for when that lease would expire.
   * @returns {Promise<string[]>} job ids resumed now (`.deferred` = job ids waiting on a live lease)
   */
  async function recover() {
    if (!isAgentEnabled(env)) return Object.assign([], { deferred: [], disabled: true }) // kill switch: never resume
    const resumed = []
    const deferred = []
    let wakeAt = null
    const toResume = await store.transaction((tx) => {
      const out = []
      const t = now().getTime()
      for (const job of tx.researchJobs.values()) {
        if (job.depth !== 'quick' || !['queued', 'running'].includes(job.state)) continue
        if (active.has(job.job_id)) continue // this process is already running it
        const run = tx.runs.get(job.run_id)
        if (['completed', 'completed_partial', 'cancelled', 'failed', 'expired', 'budget_exhausted'].includes(run.state)) continue
        if (run.lease_owner && run.lease_owner !== leaseOwner && Date.parse(run.lease_until) > t) {
          deferred.push(job.job_id)
          wakeAt = Math.min(wakeAt ?? Infinity, Date.parse(run.lease_until))
          continue
        }
        // a run whose lease is still OURS (same process) but has no live dispatcher: release it so the claim re-runs its tasks
        if (run.lease_owner === leaseOwner) interruptRunningTasksTx(tx, job, run)
        out.push(job.job_id)
      }
      return out
    })
    for (const job_id of toResume) {
      resumed.push(job_id)
      dispatch(job_id)
    }
    if (deferred.length && !recoverTimer) {
      recoverTimer = setTimeout(() => { recoverTimer = null; recover().catch(() => {}) }, Math.max(50, wakeAt - now().getTime() + 50))
      if (typeof recoverTimer.unref === 'function') recoverTimer.unref()
    }
    resumed.deferred = deferred
    return resumed
  }

  async function idle() {
    await Promise.all([...active.values()])
  }

  return { preflight, confirm, cancel, snapshot, history, recover, idle, dispatch, describeTools, mode, eventLog, claimJobLease, evidenceExpiry }
}


const SECTION_OF = {
  property_facts: 'property_ownership', ownership: 'property_ownership', transfer_history: 'property_ownership', street_view: 'physical_condition',
  mortgage: 'taxes_liens', lien: 'taxes_liens', tax_status: 'taxes_liens', equity: 'taxes_liens', foreclosure: 'foreclosure_legal',
  valuation: 'comparable_sales', market_context: 'investor_demand', investor_demand: 'investor_demand',
}

function briefClaim(f, text = null) {
  return { text: text || f.display_value, finding_ids: [f.finding_id], evidence_status: f.evidence_status, source_class: f.source_class, confidence: f.confidence, freshness_state: f.freshness_state, source_name: f.source_name, is_inference: false }
}

/** Deterministic brief sections (DR §1K order). Restates findings; never adds a claim without a finding. */
export function briefSections(findings, conflicts) {
  const by = new Map(BRIEF_SECTIONS.map((s) => [s.key, []]))
  for (const f of findings) {
    if (f.value === null) continue
    const key = SECTION_OF[f.finding_type]
    if (key && by.has(key)) by.get(key).push(briefClaim(f))
  }
  const risks = by.get('risks_unresolved')
  for (const c of conflicts) {
    const member = findings.find((f) => f.finding_id === c.members[0]?.finding_id)
    risks.push({ text: c.resolution_state === 'open' ? `Unresolved: ${c.members.map((m) => m.claim).join(' vs ')}` : `Resolved by rule: ${c.best_supported?.claim} (${c.reason})`, finding_ids: c.members.map((m) => m.finding_id), evidence_status: member?.evidence_status || 'unverified', source_class: member?.source_class || 'derived_inferred', confidence: 0, freshness_state: member?.freshness_state || 'aging', source_name: null, is_inference: false })
  }
  for (const f of findings) {
    if (f.value !== null) continue
    risks.push({ text: `Unavailable — ${FINDING_TYPES[f.finding_type]?.label || QUICK_SCAN_FINDING_TYPES[f.finding_type]?.label || f.finding_type}: ${f.unavailable_reason}`, finding_ids: [f.finding_id], evidence_status: 'unavailable', source_class: 'unavailable_blocked', confidence: 0, freshness_state: 'never', source_name: f.source_name, is_inference: false })
  }
  const next = by.get('next_investigation')
  for (const c of conflicts) if (c.follow_up) next.push({ text: c.follow_up, finding_ids: c.members.map((m) => m.finding_id), evidence_status: 'unverified', source_class: 'derived_inferred', confidence: 0, freshness_state: 'aging', source_name: null, is_inference: false })
  for (const f of findings) if ((f.finding_type === 'sms_eligibility' || f.finding_type === 'outreach_state') && f.value !== null) next.push(briefClaim(f))
  return BRIEF_SECTIONS.filter((s) => by.get(s.key).length).map((s) => ({ key: s.key, label: s.label, claims: by.get(s.key) }))
}

export { renderOperationLabel }
