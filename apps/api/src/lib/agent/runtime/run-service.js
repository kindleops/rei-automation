// Agent run orchestration + lifecycle state machine (architecture §5.1, §5.6).
//
// One runtime for conversation | task | research runs. Every state change and
// its event commit in one transaction. Cancellation is cooperative and honest:
// runs that are not executing cancel immediately; executing runs get an
// AbortSignal and are only `cancelled` once the worker acknowledges at its
// next boundary (an in-flight billable op settles at real cost, flagged
// after_cancel). The client never assumes a cancel succeeded until
// run.cancelled arrives.
import {
  RUN_KINDS,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  TOOL_CALL_TRANSITIONS,
  canTransition,
} from '../contracts/states.js'
import { reduceEvents } from '../contracts/reducer.js'
import { appendEventTx } from './event-log.js'
import { AgentError } from './store.js'
import { newId } from './canonical.js'
import { DEFAULT_BUDGET_CONFIG, runCapFor } from '../budget/budget-config.js'

export const ORG_ACTIVE_RUN_LIMIT = 6 // §5.8 cap 7 (non-research); research uses its own investigation slots

const EXECUTING_STATES = new Set(['running', 'waiting_tool', 'planning'])

export function assertRunTransition(from, to) {
  if (!canTransition(RUN_TRANSITIONS, from, to)) {
    throw new AgentError('ILLEGAL_RUN_TRANSITION', `run cannot move ${from} → ${to}`, { from, to })
  }
}

export function assertToolCallTransition(from, to) {
  if (!canTransition(TOOL_CALL_TRANSITIONS, from, to)) {
    throw new AgentError('ILLEGAL_TOOL_CALL_TRANSITION', `tool call cannot move ${from} → ${to}`, { from, to })
  }
}

function counters(run) {
  return { accrued_usd: run.accrued_usd, counters: { tool_calls: run.tool_call_count || 0 } }
}

/**
 * @param {{ store: import('./store.js').AgentStore, budgetConfig?: Object, now?: () => Date, activeRunLimit?: number }} deps
 */
/** Identities that are never a named person: shared secrets, principals, services, systems, anon. */
export const SHARED_IDENTITY_RE = /^(principal:|system:|service[:_-]?|service_role$|anon$|authenticated$|ops[-_]dashboard|shared[:_-])/i

/**
 * @param {{ store, budgetConfig?, now?, activeRunLimit?, requireVerifiedOperator?: boolean }} deps
 *   requireVerifiedOperator: every createRun must carry a verified named identity
 *   whose user_id is the operator (the live agent sets it; Gate B).
 */
export function createRunService({ store, budgetConfig = DEFAULT_BUDGET_CONFIG, now = () => new Date(), activeRunLimit = ORG_ACTIVE_RUN_LIMIT, requireVerifiedOperator = false } = {}) {
  if (!store) throw new Error('store required')
  const aborts = new Map()
  const evOpts = { now }

  function transitionTx(tx, run_id, to, reason = null) {
    const run = tx.runs.get(run_id)
    if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
    const from = run.state
    assertRunTransition(from, to)
    run.state = to
    run.updated_at = now().toISOString()
    if (RUN_TERMINAL_STATES.includes(to)) run.ended_at = run.updated_at
    appendEventTx(tx, { run_id, type: 'run.state', payload: { from, to, reason, ...counters(run) } }, evOpts)
    return run
  }

  async function createRun({ kind, operator_id, title = null, objective = null, budget_cap_usd = null, parent_run_id = null, depth = null, property_count = 1, identity = null } = {}) {
    if (!RUN_KINDS.includes(kind)) throw new AgentError('RUN_KIND_INVALID', String(kind))
    if (!operator_id) throw new AgentError('OPERATOR_REQUIRED', 'runs are attributed to an operator session')
    // Gate B: a run is a named person's run. A shared / service / principal identity never owns one.
    if (SHARED_IDENTITY_RE.test(String(operator_id))) throw new AgentError('OPERATOR_NOT_NAMED', 'runs are attributed to a named operator, never a shared or service identity')
    if (identity && (identity.verified !== true || identity.named !== true || String(identity.user_id || '') !== String(operator_id))) {
      throw new AgentError('OPERATOR_IDENTITY_MISMATCH', 'the run operator must be the verified session user')
    }
    if (requireVerifiedOperator && !(identity && identity.verified === true && identity.named === true)) {
      throw new AgentError('IDENTITY_REQUIRED', 'a verified named-user session is required to start a run')
    }
    const configCap = runCapFor(budgetConfig, { kind, depth, property_count })
    const cap = budget_cap_usd == null ? configCap : Number(budget_cap_usd)
    if (!Number.isFinite(cap) || cap < 0) throw new AgentError('BUDGET_CAP_INVALID', String(budget_cap_usd))
    if (cap > configCap) throw new AgentError('BUDGET_CAP_ABOVE_CONFIG', `cap ${cap} exceeds configured ${configCap}; caps can only be lowered`, { configCap })
    return store.transaction((tx) => {
      if (kind !== 'research') {
        const active = [...tx.runs.values()].filter((r) => r.kind !== 'research' && !RUN_TERMINAL_STATES.includes(r.state)).length
        if (active >= activeRunLimit) throw new AgentError('ACTIVE_RUN_LIMIT', `org active run limit ${activeRunLimit} reached`)
      }
      if (parent_run_id && !tx.runs.has(parent_run_id)) throw new AgentError('PARENT_RUN_NOT_FOUND', parent_run_id)
      const id = newId('run')
      const at = now().toISOString()
      const run = {
        id,
        kind,
        parent_run_id,
        operator_id,
        operator_verified: Boolean(identity?.verified),
        // actor stamp (Gate B): every event and finding of this run carries it too
        actor_user_id: String(operator_id),
        actor_verified_via: identity?.verified ? String(identity.method || 'verified') : null,
        title,
        objective,
        depth,
        state: 'created',
        budget_cap_usd: cap,
        accrued_usd: 0,
        open_reserve_usd: 0,
        cost_not_precisely_bounded: false,
        lease_owner: null,
        lease_until: null,
        heartbeat_at: null,
        checkpoint: {},
        cancel_requested_at: null,
        pause_requested_at: null,
        denied_hashes: [],
        tool_call_count: 0,
        created_at: at,
        updated_at: at,
        ended_at: null,
      }
      tx.runs.set(id, run)
      appendEventTx(tx, {
        run_id: id,
        type: 'run.created',
        payload: { kind, title, objective_summary: objective ? String(objective).slice(0, 240) : null, budget_cap_usd: cap, parent_run_id, depth },
      }, evOpts)
      return { ...run }
    })
  }

  function transition(run_id, to, reason = null) {
    return store.transaction((tx) => ({ ...transitionTx(tx, run_id, to, reason) }))
  }

  /** Cooperative cancel. Returns { state, pending }. */
  function requestCancel(run_id, { requested_by = null, scope = 'run', defer = false } = {}) {
    return store.transaction((tx) => {
      const run = tx.runs.get(run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
      if (RUN_TERMINAL_STATES.includes(run.state)) return { state: run.state, pending: false, already_terminal: true }
      if (!run.cancel_requested_at) {
        run.cancel_requested_at = now().toISOString()
        appendEventTx(tx, { run_id, type: 'run.cancel_requested', payload: { requested_by, scope } }, evOpts)
      }
      const ctl = aborts.get(run_id)
      if (ctl && !ctl.signal.aborted) ctl.abort(new AgentError('RUN_CANCELLED', 'cancel requested'))
      // defer: the caller (e.g. a research job with running tasks) owns acknowledgement
      if (defer || (EXECUTING_STATES.has(run.state) && run.lease_owner)) {
        return { state: run.state, pending: true }
      }
      transitionTx(tx, run_id, 'cancelled', 'cancel_requested')
      appendEventTx(tx, { run_id, type: 'run.cancelled', payload: { summary: 'Cancelled before any further work.', after_cancel_settled_usd: 0, ...counters(run) } }, evOpts)
      return { state: 'cancelled', pending: false }
    })
  }

  /** Worker acknowledges cancel at its next boundary. */
  function acknowledgeCancel(run_id, { after_cancel_settled_usd = 0, summary = 'Cancelled. Work finished before the cancel was kept.' } = {}) {
    return store.transaction((tx) => {
      const run = tx.runs.get(run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
      if (!run.cancel_requested_at) throw new AgentError('CANCEL_NOT_REQUESTED', run_id)
      if (run.state === 'cancelled') return { state: 'cancelled' }
      run.lease_owner = null
      run.lease_until = null
      transitionTx(tx, run_id, 'cancelled', 'cancel_acknowledged')
      appendEventTx(tx, { run_id, type: 'run.cancelled', payload: { summary, after_cancel_settled_usd, ...counters(run) } }, evOpts)
      return { state: 'cancelled' }
    })
  }

  function pause(run_id) {
    return store.transaction((tx) => {
      const run = tx.runs.get(run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
      run.pause_requested_at = now().toISOString()
      return { ...transitionTx(tx, run_id, 'paused', 'operator_pause') }
    })
  }

  function resume(run_id) {
    return store.transaction((tx) => {
      const run = tx.runs.get(run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
      if (run.cancel_requested_at) throw new AgentError('RUN_CANCEL_PENDING', 'a cancelled run cannot resume')
      run.pause_requested_at = null
      return { ...transitionTx(tx, run_id, 'running', 'operator_resume') }
    })
  }

  /** Lease for a worker (container restart → expiry → sweeper). */
  function claimLease(run_id, { owner, ttl_ms = 60_000 } = {}) {
    return store.transaction((tx) => {
      const run = tx.runs.get(run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', run_id)
      if (run.cancel_requested_at) throw new AgentError('RUN_CANCEL_PENDING', run_id)
      // S3: a finished run is never leased again (a late/paused worker must not re-acquire it)
      if (RUN_TERMINAL_STATES.includes(run.state)) throw new AgentError('RUN_TERMINAL', `run ${run_id} is ${run.state}`)
      const t = now().getTime()
      if (run.lease_owner && run.lease_owner !== owner && Date.parse(run.lease_until) > t) {
        throw new AgentError('LEASE_HELD', `leased by ${run.lease_owner}`)
      }
      run.lease_owner = owner
      run.lease_until = new Date(t + ttl_ms).toISOString()
      run.heartbeat_at = new Date(t).toISOString()
      if (!aborts.has(run_id)) aborts.set(run_id, new AbortController())
      return { lease_until: run.lease_until }
    })
  }

  function sweepExpiredLeases() {
    return store.transaction((tx) => {
      const t = now().getTime()
      const swept = []
      for (const run of tx.runs.values()) {
        if (run.lease_owner && Date.parse(run.lease_until) <= t && !RUN_TERMINAL_STATES.includes(run.state)) {
          swept.push({ run_id: run.id, previous_owner: run.lease_owner, checkpoint: run.checkpoint })
          run.lease_owner = null
          run.lease_until = null
        }
      }
      return swept
    })
  }

  /** AbortSignal workers check at every adapter / tool boundary. */
  function signalFor(run_id) {
    if (!aborts.has(run_id)) aborts.set(run_id, new AbortController())
    return aborts.get(run_id).signal
  }

  function getRun(run_id) {
    const r = store.read().runs.get(run_id)
    return r ? { ...r } : null
  }

  /** Reload snapshot: reduced from events server-side + last_event_id cursor. */
  function snapshot(run_id) {
    const run = store.read().runs.get(run_id)
    if (!run) return null
    const events = store.read().events.filter((e) => e.run_id === run_id)
    const view = reduceEvents(events)[run_id] || null
    return {
      run_id,
      kind: run.kind,
      state: run.state,
      phase: view?.phase ?? null,
      last_event_id: view?.last_event_id ?? 0,
      last_seq: view?.last_seq ?? 0,
      counters: view?.counters ?? {},
      cost: { accrued_usd: run.accrued_usd, open_reserve_usd: run.open_reserve_usd, cost_not_precisely_bounded: run.cost_not_precisely_bounded },
      fixture: false,
      view,
    }
  }

  return { createRun, transition, transitionTx, requestCancel, acknowledgeCancel, pause, resume, claimLease, sweepExpiredLeases, signalFor, getRun, snapshot }
}
