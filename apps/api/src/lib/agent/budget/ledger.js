// Reserve → settle spend ledger (architecture §5.8, DR §5). ONE ledger for all
// AI spend: research, conversation and task runs share the org day/month pool.
//
//  * Every billable op reserves its worst case BEFORE the call, inside the
//    store transaction (serialized: the in-memory analogue of FOR UPDATE).
//  * committed = settled + open reserves + unbounded allowances (+ positive
//    reconcile discrepancies). The ledger never under-records.
//  * If the next op's worst case doesn't fit the tightest remaining cap, the op
//    is refused BEFORE the call (budget.stopped names the binding cap).
//  * Quick Scan is structurally $0: a reserve on a quick research run is
//    refused regardless of amount (QUICK_SCAN_BILLABLE_REFUSED).
//  * Unbounded sources are disabled; allowance sources reserve an allowance,
//    settle later (late_settle) and flag cost_not_precisely_bounded.
import { CAP_LABELS } from '../contracts/cost.js'
import { appendEventTx } from '../runtime/event-log.js'
import { AgentError } from '../runtime/store.js'
import { DEFAULT_BUDGET_CONFIG, round6 } from './budget-config.js'
import { DEFAULT_PRICE_BOOK, actualUsd, worstCaseUsd } from './price-book.js'
import { SPEND_HARD_CEILINGS, checkSpend, resolveSpendCaps, spendUsage } from './spend-guard.js'

const SETTLEMENT_KINDS = new Set(['settle', 'sweep_settle', 'late_settle'])

function utcDay(iso) {
  return String(iso).slice(0, 10)
}
function utcMonth(iso) {
  return String(iso).slice(0, 7)
}

/** committed USD over ledger rows matching `pred(reserveRow)`. */
function committedTx(tx, pred) {
  let sum = 0
  const settledByReserve = new Map()
  for (const r of tx.ledger) {
    if (SETTLEMENT_KINDS.has(r.kind) && r.reserve_id != null) {
      settledByReserve.set(r.reserve_id, (settledByReserve.get(r.reserve_id) || 0) + Number(r.cost_usd))
    }
  }
  for (const r of tx.ledger) {
    if (r.kind === 'reserve' && pred(r)) {
      sum += settledByReserve.has(r.id) ? settledByReserve.get(r.id) : Number(r.cost_usd)
    } else if (r.kind === 'reconcile' && pred(r) && Number(r.cost_usd) > 0) {
      sum += Number(r.cost_usd)
    }
  }
  return round6(sum)
}

/**
 * @param {{ store: import('../runtime/store.js').AgentStore, config?: Object, priceBook?: Array, now?: () => Date }} deps
 */
/**
 * spendCaps: Gate B per-user / global daily USD + token caps (spend-guard.js).
 * Default = the env-resolved caps, which are $0 / 0 tokens until the owner sets
 * them: with no owner-set caps, every billable reserve is refused.
 */
export function createBudgetLedger({ store, config = DEFAULT_BUDGET_CONFIG, priceBook = DEFAULT_PRICE_BOOK, now = () => new Date(), spendCaps = resolveSpendCaps() } = {}) {
  if (!store) throw new Error('store required')
  const evOpts = { now }
  // injected caps are clamped to the code ceilings too: no caller can raise them
  const guardCaps = Object.freeze({
    global_day_usd: Math.min(Number(spendCaps?.global_day_usd) || 0, SPEND_HARD_CEILINGS.global_day_usd),
    user_day_usd: Math.min(Number(spendCaps?.user_day_usd) || 0, SPEND_HARD_CEILINGS.user_day_usd, Number(spendCaps?.global_day_usd) || 0),
    global_day_tokens: Math.min(Number(spendCaps?.global_day_tokens) || 0, SPEND_HARD_CEILINGS.global_day_tokens),
    user_day_tokens: Math.min(Number(spendCaps?.user_day_tokens) || 0, SPEND_HARD_CEILINGS.user_day_tokens, Number(spendCaps?.global_day_tokens) || 0),
  })

  function capRowsTx(tx, run, property_id, atIso) {
    const day = utcDay(atIso)
    const month = utcMonth(atIso)
    const rows = []
    const isResearch = run.kind === 'research'
    if (isResearch) {
      const per = config.research.per_property_usd[run.depth || 'deep']
      rows.push({ cap_key: 'per_property', limit_usd: per, committed_usd: committedTx(tx, (r) => r.run_id === run.id && r.property_id === property_id) })
      rows.push({ cap_key: 'per_batch', limit_usd: Math.min(run.budget_cap_usd, config.research.per_batch_usd), committed_usd: committedTx(tx, (r) => r.run_id === run.id) })
    } else {
      const key = run.kind === 'conversation' ? 'per_conversation_task' : 'per_background_task'
      const cfgCap = run.kind === 'conversation' ? config.conversation.per_run_usd : config.task.per_run_usd
      rows.push({ cap_key: key, limit_usd: Math.min(run.budget_cap_usd, cfgCap), committed_usd: committedTx(tx, (r) => r.run_id === run.id) })
      rows.push({ cap_key: 'non_research_day', limit_usd: config.non_research.per_day_usd, committed_usd: committedTx(tx, (r) => r.run_kind !== 'research' && utcDay(r.at) === day) })
      rows.push({ cap_key: 'non_research_month', limit_usd: config.non_research.per_month_usd, committed_usd: committedTx(tx, (r) => r.run_kind !== 'research' && utcMonth(r.at) === month) })
    }
    rows.push({ cap_key: 'org_day', limit_usd: config.org.per_day_usd, committed_usd: committedTx(tx, (r) => utcDay(r.at) === day) })
    rows.push({ cap_key: 'org_month', limit_usd: config.org.per_month_usd, committed_usd: committedTx(tx, (r) => utcMonth(r.at) === month) })
    for (const r of rows) {
      r.label = CAP_LABELS[r.cap_key]
      r.remaining_usd = round6(Math.max(0, r.limit_usd - r.committed_usd))
      r.binding = false
    }
    return rows
  }

  /**
   * Reserve before a billable op. Never throws for a budget refusal: returns
   * { ok:false, code, binding_cap } and records budget.stopped (committed).
   * @param {{ run_id: string, property_id?: string|null, op: Object, route: string, task_id?: string|null, tool_call_id?: string|null, cost_bound?: 'bounded'|'allowance'|'unbounded', allowance_usd?: number }} input
   */
  function reserve(input) {
    return store.transaction((tx) => {
      const run = tx.runs.get(input.run_id)
      if (!run) throw new AgentError('RUN_NOT_FOUND', input.run_id)
      const refuse = (code, extra = {}) => {
        appendEventTx(tx, {
          run_id: run.id,
          type: 'budget.stopped',
          property_id: input.property_id || null,
          task_id: input.task_id || null,
          payload: { binding_cap: extra.binding_cap || code, next_op: `${input.op?.op_type || 'op'}:${input.route || ''}`, worst_case_usd: extra.worst_case_usd ?? null, remaining_usd: extra.remaining_usd ?? null },
        }, evOpts)
        return { ok: false, code, ...extra }
      }
      // Structural, not budgetary: no billable op can exist on a Quick Scan.
      if (run.kind === 'research' && run.depth === 'quick') return refuse('QUICK_SCAN_BILLABLE_REFUSED', { binding_cap: 'per_property' })
      if (run.kind === 'research' && !input.property_id) throw new AgentError('PROPERTY_REQUIRED', 'research reserves are per property')
      const cost_bound = input.cost_bound || 'bounded'
      if (cost_bound === 'unbounded') return refuse('UNBOUNDED_SOURCE_DISABLED')
      let worst
      let price_book_ids = []
      try {
        if (cost_bound === 'allowance') {
          if (!(Number(input.allowance_usd) > 0)) throw new AgentError('UNPRICED_OP', 'allowance sources need allowance_usd')
          worst = round6(Number(input.allowance_usd))
        } else {
          const wc = worstCaseUsd(input.op, priceBook, now().toISOString())
          worst = wc.usd
          price_book_ids = wc.price_book_ids
        }
      } catch (error) {
        if (error.code === 'UNPRICED_OP' || error.code === 'UNBOUNDED_OP') return refuse(error.code)
        throw error
      }
      const at = now().toISOString()
      if (run.kind !== 'research' && input.op?.op_type === 'model') {
        const perResp = run.kind === 'conversation' ? config.conversation.per_response_usd : config.task.per_response_usd
        if (worst > perResp) return refuse('BUDGET_EXCEEDED', { binding_cap: 'per_response', worst_case_usd: worst, remaining_usd: perResp })
      }
      const caps = capRowsTx(tx, run, input.property_id || null, at)
      let binding = caps[0]
      for (const c of caps) if (c.remaining_usd < binding.remaining_usd) binding = c
      if (worst > binding.remaining_usd) {
        binding.binding = true
        return refuse('BUDGET_EXCEEDED', { binding_cap: binding.cap_key, worst_case_usd: worst, remaining_usd: binding.remaining_usd, caps })
      }
      // Gate B spend guard: verified named actor + per-user / global daily USD and token caps
      const worstTokens = Math.max(0, Number(input.op?.max_input_tokens || 0)) + Math.max(0, Number(input.op?.max_tokens || 0))
      const guard = checkSpend({
        caps: guardCaps,
        actor: { user_id: run.operator_id, verified: run.operator_verified === true },
        worst_usd: worst,
        worst_tokens: worstTokens,
        usage: spendUsage(tx.ledger, { user_id: run.operator_id, day: utcDay(at) }),
      })
      if (!guard.ok) return refuse(guard.code, { binding_cap: guard.binding_cap, worst_case_usd: worst, remaining_usd: round6(Math.max(0, guard.binding_cap.endsWith('_usd') ? guard.limit - guard.committed : 0)) })
      tx.counters.ledger_id += 1
      const row = {
        id: tx.counters.ledger_id,
        kind: 'reserve',
        run_id: run.id,
        run_kind: run.kind,
        property_id: input.property_id || null,
        task_id: input.task_id || null,
        tool_call_id: input.tool_call_id || null,
        op_type: input.op.op_type,
        cost_bound,
        route: input.route,
        provider: input.op.provider || null,
        model: input.op.model || null,
        cost_usd: worst,
        price_book_ids,
        reserve_id: null,
        operator_id: run.operator_id,
        at,
        op: { ...input.op },
      }
      tx.ledger.push(row)
      run.open_reserve_usd = round6(run.open_reserve_usd + worst)
      if (cost_bound === 'allowance') run.cost_not_precisely_bounded = true
      appendEventTx(tx, {
        run_id: run.id,
        type: 'usage.reserved',
        property_id: row.property_id,
        task_id: row.task_id,
        tool_call_id: row.tool_call_id,
        payload: { reserve_id: String(row.id), op_type: row.op_type, route: row.route, provider: row.provider, model: row.model, worst_case_usd: worst, remaining_usd: round6(binding.remaining_usd - worst) },
      }, evOpts)
      return { ok: true, reserve_id: row.id, worst_case_usd: worst, binding_cap: binding.cap_key, remaining_usd: round6(binding.remaining_usd - worst) }
    })
  }

  function settlementOf(tx, reserve_id) {
    return tx.ledger.find((r) => SETTLEMENT_KINDS.has(r.kind) && r.reserve_id === reserve_id) || null
  }

  function settleTx(tx, { reserve_id, kind, actual }, extra = {}) {
    const res = tx.ledger.find((r) => r.kind === 'reserve' && r.id === reserve_id)
    if (!res) throw new AgentError('RESERVE_NOT_FOUND', String(reserve_id))
    if (settlementOf(tx, reserve_id)) throw new AgentError('ALREADY_SETTLED', String(reserve_id))
    const run = tx.runs.get(res.run_id)
    tx.counters.ledger_id += 1
    const row = { ...res, id: tx.counters.ledger_id, kind, cost_usd: round6(actual), reserve_id, at: now().toISOString(), ...extra }
    delete row.op
    tx.ledger.push(row)
    run.open_reserve_usd = round6(Math.max(0, run.open_reserve_usd - res.cost_usd))
    run.accrued_usd = round6(run.accrued_usd + row.cost_usd)
    if (row.cost_usd > res.cost_usd) run.cost_not_precisely_bounded = true
    appendEventTx(tx, {
      run_id: run.id,
      type: 'usage.settled',
      property_id: res.property_id,
      task_id: res.task_id,
      tool_call_id: res.tool_call_id,
      payload: { reserve_id: String(reserve_id), op_type: res.op_type, route: res.route, provider: res.provider, model: res.model, tokens: extra.tokens || null, actual_usd: row.cost_usd, accrued_usd: run.accrued_usd, remaining_usd: round6(Math.max(0, run.budget_cap_usd - run.accrued_usd - run.open_reserve_usd)) },
    }, evOpts)
    return { ok: true, actual_usd: row.cost_usd, accrued_usd: run.accrued_usd, over_reserve: row.cost_usd > res.cost_usd }
  }

  /** Settle from provider usage (or an explicit actual_usd for fees). */
  function settle({ reserve_id, usage = {}, after_cancel = false }) {
    return store.transaction((tx) => {
      const res = tx.ledger.find((r) => r.kind === 'reserve' && r.id === reserve_id)
      if (!res) throw new AgentError('RESERVE_NOT_FOUND', String(reserve_id))
      if (res.cost_bound === 'allowance') throw new AgentError('ALLOWANCE_REQUIRES_LATE_SETTLE', String(reserve_id))
      const actual = actualUsd(res.op, usage, priceBook, res.at)
      return settleTx(tx, { reserve_id, kind: 'settle', actual }, { after_cancel, tokens: { input: usage.input_tokens || 0, output: usage.output_tokens || 0, cache_read: usage.cache_read_input_tokens || 0 } })
    })
  }

  /** Allowance sources settle when the charge arrives. */
  function lateSettle({ reserve_id, actual_usd }) {
    return store.transaction((tx) => settleTx(tx, { reserve_id, kind: 'late_settle', actual: Number(actual_usd) }))
  }

  /** Crash recovery: open reserves older than max_age settle AT RESERVE VALUE. */
  function sweep({ max_age_ms = 15 * 60 * 1000 } = {}) {
    return store.transaction((tx) => {
      const t = now().getTime()
      const swept = []
      for (const r of tx.ledger) {
        if (r.kind !== 'reserve' || r.cost_bound === 'allowance') continue
        if (settlementOf(tx, r.id)) continue
        if (t - Date.parse(r.at) < max_age_ms) continue
        settleTx(tx, { reserve_id: r.id, kind: 'sweep_settle', actual: r.cost_usd })
        swept.push(r.id)
      }
      return swept
    })
  }

  /** Nightly reconcile vs provider export: discrepancy recorded, never absorbed. */
  function reconcile({ provider, day, provider_total_usd, run_id_for_attribution }) {
    return store.transaction((tx) => {
      const ours = round6(tx.ledger.filter((r) => SETTLEMENT_KINDS.has(r.kind) && r.provider === provider && utcDay(r.at) === day).reduce((s, r) => s + Number(r.cost_usd), 0))
      const discrepancy = round6(Number(provider_total_usd) - ours)
      tx.counters.ledger_id += 1
      const run = run_id_for_attribution ? tx.runs.get(run_id_for_attribution) : null
      tx.ledger.push({
        id: tx.counters.ledger_id,
        kind: 'reconcile',
        run_id: run?.id || null,
        run_kind: run?.kind || 'task',
        property_id: null,
        op_type: 'model',
        cost_bound: 'bounded',
        route: 'reconcile',
        provider,
        model: null,
        cost_usd: Math.max(0, discrepancy),
        discrepancy_usd: discrepancy,
        reserve_id: null,
        operator_id: run?.operator_id || null,
        at: `${day}T23:59:59.000Z`,
      })
      if (run && discrepancy !== 0) run.cost_not_precisely_bounded = true
      return { ours_usd: ours, provider_usd: Number(provider_total_usd), discrepancy_usd: discrepancy }
    })
  }

  /** CostDisplay (contracts/cost.js) for a run. */
  function costDisplay(run_id, { estimate = null, models_enabled = false, external_hold = true } = {}) {
    const tx = store.read()
    const run = tx.runs.get(run_id)
    if (!run) return null
    const settlements = tx.ledger.filter((r) => SETTLEMENT_KINDS.has(r.kind) && r.run_id === run_id)
    const byProvider = new Map()
    const byOp = new Map()
    for (const s of settlements) {
      const k = `${s.provider}|${s.model}`
      byProvider.set(k, round6((byProvider.get(k) || 0) + s.cost_usd))
      byOp.set(s.op_type, round6((byOp.get(s.op_type) || 0) + s.cost_usd))
    }
    const pendingLate = tx.ledger.filter((r) => r.kind === 'reserve' && r.run_id === run_id && r.cost_bound === 'allowance' && !settlementOf(tx, r.id)).reduce((s, r) => s + r.cost_usd, 0)
    const caps = capRowsTx(tx, run, null, now().toISOString()).filter((c) => c.cap_key !== 'per_property')
    const stop = [...tx.events].reverse().find((e) => e.run_id === run_id && e.type === 'budget.stopped')
    return {
      currency: 'USD',
      estimate,
      actual: {
        settled_usd: run.accrued_usd,
        open_reserve_usd: run.open_reserve_usd,
        pending_late_usd: round6(pendingLate),
        by_provider: [...byProvider].map(([k, usd]) => ({ provider: k.split('|')[0], model: k.split('|')[1] === 'null' ? null : k.split('|')[1], usd })),
        by_op_type: [...byOp].map(([op_type, usd]) => ({ op_type, usd })),
      },
      caps,
      flags: { cost_not_precisely_bounded: run.cost_not_precisely_bounded, budget_stopped: Boolean(stop), stopped_cap: stop?.payload?.binding_cap || null },
      models_enabled,
      external_hold,
    }
  }

  return { reserve, settle, lateSettle, sweep, reconcile, costDisplay, config }
}
