// Deep Research job interfaces (DR §3, architecture §5.9 A1). A research job
// IS an agent run (kind='research'); research.job is its 1:1 extension
// (depth, cohort, property counters, phase). One runtime, one event log, one
// ledger — nothing here duplicates the agent spine.
//
// S1 scope: lifecycle + interfaces only. No adapter executes, no dispatcher
// claims tasks, nothing is fetched. Implemented and enforced now:
//   * estimate → draft job (structural $0 for Quick Scan; worst case otherwise)
//   * confirm: immutable scope (depth, cohort hash, cap); cap lower-only;
//     ≤ 50 queued per batch (larger cohorts split into sequential batches);
//     test_batch_mode → ≤ 10 properties
//   * Quick Scan planner may only emit non-billable `supabase` tasks
//   * dispatcher guard refuses billable tasks on Quick Scan
//   * investigation concurrency 2 (org-wide)
//   * pause / resume / cooperative cancel with honest events
import { RESEARCH_DEPTHS, RESEARCH_DEPTH_LABELS, RESEARCH_JOB_TRANSITIONS, RESEARCH_TASK_TRANSITIONS, canTransition } from '../contracts/states.js'
import { renderOperationLabel } from '../contracts/events.js'
import { FINDING_TYPES } from '../contracts/evidence.js'
import { appendEventTx } from '../runtime/event-log.js'
import { AgentError } from '../runtime/store.js'
import { hashCanonical, newId } from '../runtime/canonical.js'
import { DEFAULT_BUDGET_CONFIG, round6 } from '../budget/budget-config.js'

export const SOURCE_ACCESS_MODES_NONBILLABLE = Object.freeze(['supabase'])

/**
 * Source adapter contract (DR §6.1). Pure + injected fetch. S1 registers none
 * that can execute; the contract is validated so S3/S4 adapters conform.
 */
export function defineSourceAdapter(spec) {
  const req = ['id', 'version', 'finding_types', 'jurisdictions', 'access_mode', 'hosts', 'supports_negative', 'timeout_ms', 'billable', 'cost_bound', 'buildRequest', 'parse', 'classifyFailure']
  for (const k of req) if (spec?.[k] === undefined) throw new AgentError('ADAPTER_SPEC_INVALID', `${spec?.id || '<adapter>'}: ${k} required`)
  if (spec.access_mode === 'supabase' && spec.billable) throw new AgentError('ADAPTER_SPEC_INVALID', 'supabase adapters are non-billable')
  if (spec.cost_bound === 'unbounded' && !spec.owner_enabled) throw new AgentError('ADAPTER_UNBOUNDED_DISABLED', `${spec.id}: unbounded sources are disabled for automated research`)
  for (const h of spec.hosts) if (!/^[a-z0-9.-]+$/i.test(h)) throw new AgentError('ADAPTER_SPEC_INVALID', `host ${h} must be a plain hostname`)
  return Object.freeze({ ...spec })
}

function assertJobTransition(from, to) {
  if (!canTransition(RESEARCH_JOB_TRANSITIONS, from, to)) throw new AgentError('ILLEGAL_JOB_TRANSITION', `${from} → ${to}`)
}

export function assertTaskTransition(from, to) {
  if (!canTransition(RESEARCH_TASK_TRANSITIONS, from, to)) throw new AgentError('ILLEGAL_TASK_TRANSITION', `${from} → ${to}`)
}

/** Quick Scan planner guard: only non-billable supabase tasks may be planned. */
export function assertQuickScanPlan(tasks, adapters) {
  for (const t of tasks) {
    const a = adapters.get ? adapters.get(t.adapter_id) : adapters[t.adapter_id]
    if (!a || a.billable || !SOURCE_ACCESS_MODES_NONBILLABLE.includes(a.access_mode)) {
      throw new AgentError('QUICK_SCAN_BILLABLE_REFUSED', `Quick Scan cannot plan ${t.adapter_id}`)
    }
  }
  return true
}

/** Dispatcher guard (DR §5): billable task on a quick job → refused. */
export function assertDispatchable(task, job, adapter) {
  if (job.depth === 'quick' && (adapter?.billable || task.billable)) throw new AgentError('QUICK_SCAN_BILLABLE_REFUSED', task.task_id || 'task')
  if (adapter?.cost_bound === 'unbounded' && !adapter.owner_enabled) throw new AgentError('ADAPTER_UNBOUNDED_DISABLED', adapter.id)
  return true
}

export function createResearchJobService({ store, runService, config = DEFAULT_BUDGET_CONFIG, now = () => new Date() } = {}) {
  const evOpts = { now }
  const slots = new Set()

  function estimateFor(depth, count) {
    const per = config.research.per_property_usd[depth]
    if (depth === 'quick') return { low_usd: 0, high_usd: 0, basis: 'structural_zero', label: 'Quick Scan: no billable operations ($0)' }
    const high = Math.min(config.research.per_batch_usd, round6(per * count))
    return { low_usd: 0, high_usd: high, basis: 'worst_case', label: `No measured history yet: worst case $${high.toFixed(2)} = ${count} × $${per.toFixed(2)} cap` }
  }

  /**
   * Estimate → draft job (writes only a draft; nothing executes).
   * @returns {Promise<{ job_id, run_id, batches: Array<{ index, property_ids }>, estimate, scope_sentence, scope_hash }>}
   */
  async function estimate({ operator_id, property_ids = [], depth = 'deep', cohort_hash = null, identity = null }) {
    if (!RESEARCH_DEPTHS.includes(depth)) throw new AgentError('RESEARCH_DEPTH_INVALID', String(depth))
    const ids = [...new Set(property_ids.map(String))]
    if (!ids.length) throw new AgentError('RESEARCH_EMPTY_SCOPE', 'no properties')
    const maxQ = config.research.max_queued_per_batch
    const batches = []
    for (let i = 0; i < ids.length; i += maxQ) batches.push({ index: batches.length + 1, property_ids: ids.slice(i, i + maxQ) })
    const first = batches[0].property_ids
    if (config.research.test_batch_mode && first.length > config.research.test_batch_max_properties) {
      throw new AgentError('TEST_BATCH_LIMIT', `test batches are limited to ${config.research.test_batch_max_properties} properties until the owner lifts test_batch_mode`)
    }
    const est = estimateFor(depth, first.length)
    const run = await runService.createRun({ kind: 'research', operator_id, title: `${RESEARCH_DEPTH_LABELS[depth]} · ${first.length} properties`, depth, property_count: first.length, budget_cap_usd: est.high_usd, identity })
    const scope_hash = hashCanonical({ depth, ids: [...first].sort(), cohort_hash, cap: est.high_usd })
    const per = config.research.per_property_usd[depth]
    const scope_sentence = `Research ${first.length} ${first.length === 1 ? 'property' : 'properties'} · ${RESEARCH_DEPTH_LABELS[depth]} · hard cap $${per.toFixed(2)} each · batch cap $${est.high_usd.toFixed(2)} (≤ $${config.research.per_batch_usd})`
    const job = await store.transaction((tx) => {
      const job_id = newId('rjob')
      const row = { job_id, run_id: run.id, depth, state: 'draft', property_ids: first, scope_hash, budget_cap_usd: est.high_usd, estimate: est, batch_index: 1, batch_of: batches.length, created_at: now().toISOString(), expires_at: new Date(now().getTime() + 30 * 60 * 1000).toISOString() }
      tx.researchJobs.set(job_id, row)
      appendEventTx(tx, { run_id: run.id, type: 'job.created', payload: { depth, property_count: first.length, estimate: est, cap: { per_property_usd: per, batch_usd: est.high_usd } } }, evOpts)
      return row
    })
    return { job_id: job.job_id, run_id: run.id, batches, estimate: est, scope_sentence, scope_hash }
  }

  /** Confirm a draft: the scope hash must match exactly; cap may only be lowered. */
  async function confirm({ job_id, scope_hash, budget_cap_usd = null }) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      if (!job) throw new AgentError('JOB_NOT_FOUND', job_id)
      if (Date.parse(job.expires_at) <= now().getTime() && job.state === 'draft') {
        job.state = 'expired'
        throw new AgentError('JOB_DRAFT_EXPIRED', job_id)
      }
      assertJobTransition(job.state, 'queued')
      if (scope_hash !== job.scope_hash) throw new AgentError('JOB_SCOPE_CHANGED', 'a different scope is a new job')
      if (budget_cap_usd != null) {
        if (Number(budget_cap_usd) > job.budget_cap_usd) throw new AgentError('BUDGET_CAP_ABOVE_CONFIG', 'caps can only be lowered')
        job.budget_cap_usd = Number(budget_cap_usd)
        tx.runs.get(job.run_id).budget_cap_usd = job.budget_cap_usd
      }
      job.state = 'queued'
      const per = config.research.per_property_usd[job.depth]
      appendEventTx(tx, { run_id: job.run_id, type: 'job.confirmed', payload: { depth: job.depth, property_count: job.property_ids.length, estimate: job.estimate, cap: { per_property_usd: per, batch_usd: job.budget_cap_usd }, scope_sentence: null } }, evOpts)
      return { job_id, state: job.state, budget_cap_usd: job.budget_cap_usd }
    })
  }

  /** Plan tasks for a job (interface; S3 planner emits real tasks). */
  async function planTasks({ job_id, tasks, adapters }) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      if (!job) throw new AgentError('JOB_NOT_FOUND', job_id)
      if (job.depth === 'quick') assertQuickScanPlan(tasks, adapters)
      const out = []
      for (const t of tasks) {
        const a = adapters.get ? adapters.get(t.adapter_id) : adapters[t.adapter_id]
        const task_id = t.task_id || newId('rtask')
        const idempotency_key = hashCanonical({ property_id: t.property_id, finding_type: t.finding_type, adapter_id: a.id, adapter_version: a.version, query: t.normalized_query || null, bucket: t.freshness_bucket || null })
        const row = { task_id, job_id, run_id: job.run_id, property_id: t.property_id, finding_type: t.finding_type, adapter_id: a.id, state: 'planned', attempt: 1, idempotency_key, billable: Boolean(a.billable) }
        tx.researchTasks.set(task_id, row)
        const vars = { jurisdiction: t.jurisdiction || 'county', finding_label: FINDING_TYPES[t.finding_type]?.label.toLowerCase() || t.finding_type, source_name: a.name || a.id }
        appendEventTx(tx, { run_id: job.run_id, property_id: t.property_id, task_id, type: 'plan.task_added', payload: { task_id, operation: 'research.check', adapter_id: a.id, source_id: a.source_id || a.id, finding_type: t.finding_type, depends_on: t.depends_on || [], billable: Boolean(a.billable) }, label_vars: vars }, evOpts)
        out.push({ ...row, label: renderOperationLabel('research.check', vars) })
      }
      return out
    })
  }

  /** Investigation slots (org-wide concurrency 2). */
  function claimInvestigationSlot(property_key) {
    if (slots.has(property_key)) return true
    if (slots.size >= config.research.concurrency) return false
    slots.add(property_key)
    return true
  }
  function releaseInvestigationSlot(property_key) {
    slots.delete(property_key)
  }

  /** Cooperative cancel: queued/planned tasks → cancelled now; running tasks get the abort signal. */
  async function cancel({ job_id, requested_by = null }) {
    const res = await store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      if (!job) throw new AgentError('JOB_NOT_FOUND', job_id)
      if (['completed', 'completed_partial', 'cancelled', 'failed', 'expired', 'budget_exhausted'].includes(job.state)) return { state: job.state, pending: false }
      appendEventTx(tx, { run_id: job.run_id, type: 'job.cancel_requested', payload: { requested_by } }, evOpts)
      let running = 0
      for (const t of tx.researchTasks.values()) {
        if (t.job_id !== job_id) continue
        if (!t.final_unavailable && (t.state === 'planned' || t.state === 'queued' || t.state === 'unavailable' || t.state === 'needs_input')) { // S3: a task whose final outcome was 'unavailable' is done, not cancellable
          assertTaskTransition(t.state, 'cancelled')
          t.state = 'cancelled'
          appendEventTx(tx, { run_id: job.run_id, task_id: t.task_id, property_id: t.property_id, type: 'task.cancelled', payload: { after_cancel: false } }, evOpts)
        } else if (t.state === 'running') running += 1
      }
      if (running === 0) {
        assertJobTransition(job.state, 'cancelled')
        job.state = 'cancelled'
        appendEventTx(tx, { run_id: job.run_id, type: 'job.cancelled', payload: { summary: 'Cancelled. Findings gathered so far are kept.', accrued_usd: tx.runs.get(job.run_id).accrued_usd } }, evOpts)
      }
      return { state: job.state, pending: running > 0, running }
    })
    // running tasks → the run stays cancel-pending until the dispatcher acknowledges
    await runService.requestCancel(store.read().researchJobs.get(job_id).run_id, { requested_by, scope: 'research_job', defer: res.pending })
    return res
  }

  async function pause({ job_id }) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      assertJobTransition(job.state, 'paused')
      job.state = 'paused'
      appendEventTx(tx, { run_id: job.run_id, type: 'job.paused', payload: { accrued_usd: tx.runs.get(job.run_id).accrued_usd } }, evOpts)
      return { state: 'paused' }
    })
  }

  async function resume({ job_id }) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      assertJobTransition(job.state, 'running')
      job.state = 'running'
      appendEventTx(tx, { run_id: job.run_id, type: 'job.resumed', payload: { accrued_usd: tx.runs.get(job.run_id).accrued_usd } }, evOpts)
      return { state: 'running' }
    })
  }

  /** Test/worker hook: mark queued → running (the S3 dispatcher owns this). */
  async function markRunning({ job_id }) {
    return store.transaction((tx) => {
      const job = tx.researchJobs.get(job_id)
      assertJobTransition(job.state, 'running')
      job.state = 'running'
      appendEventTx(tx, { run_id: job.run_id, type: 'job.phase', payload: { phase: 'researching' } }, evOpts)
      return { state: 'running' }
    })
  }

  return { estimate, confirm, planTasks, cancel, pause, resume, markRunning, claimInvestigationSlot, releaseInvestigationSlot, estimateFor }
}
