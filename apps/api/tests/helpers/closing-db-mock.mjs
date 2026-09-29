/**
 * In-memory Supabase for closing-authority tests. Mirrors the PRODUCTION rules
 * that matter (verified against the live schema 2026-09-29):
 *   unique keys → 23505; emd verified requires provenance; settlement settled
 *   requires evidence + is immutable once settled; clear-to-close requires
 *   provenance; closed-won trigger on acquisition_opportunities;
 *   finalize_closing_case() re-checks the financial core and moves case +
 *   opportunity + milestone + event together.
 */
const UNIQUE = {
  closing_cases: [['closing_case_id']],
  closing_activity_events: [['idempotency_key']],
  closing_milestones: [['idempotency_key']],
  buyer_offers: [['buyer_offer_id']],
  buyer_agreements: [['agreement_id']],
  emd_receipts: [['receipt_id']],
  settlement_records: [['settlement_id']],
  closing_title_issues: [['issue_id']],
  closing_email_requests: [['request_key']],
}

const LOST = new Set(['dead', 'suppressed', 'lost', 'archived'])

export function makeClosingDb(seed = {}) {
  const state = {
    closing_cases: [], closing_activity_events: [], closing_milestones: [], buyer_offers: [], buyer_agreements: [],
    emd_receipts: [], settlement_records: [], closing_title_issues: [], closing_email_requests: [], acquisition_opportunities: [],
    system_control: [],
    ...JSON.parse(JSON.stringify(seed)),
  }

  const checkRow = (table, row, old = null) => {
    if (table === 'emd_receipts' && row.status === 'verified' && !(row.verified_at && row.verified_by && row.verification_method && row.evidence_reference)) return { code: '23514', message: 'emd_receipts_verified_requires_provenance' }
    if (table === 'settlement_records') {
      if (row.settlement_status === 'settled' && !(row.closed_at && row.closing_provider && row.verified_by && row.verified_at && row.verification_method && row.evidence_reference)) return { code: '23514', message: 'settlement_records_settled_requires_evidence' }
      if (old && old.settlement_status === 'settled') {
        for (const k of ['actual_seller_amount', 'actual_buyer_amount', 'actual_assignment_fee', 'actual_closing_costs', 'actual_other_costs', 'actual_net_proceeds', 'closed_at', 'evidence_reference', 'settlement_statement_reference', 'verified_by', 'verified_at']) {
          if ((row[k] ?? null) !== (old[k] ?? null)) return { code: 'P0001', message: 'SETTLEMENT_IMMUTABLE' }
        }
      }
    }
    if (table === 'closing_cases') {
      if (row.clear_to_close_at && !(row.clear_to_close_source && row.clear_to_close_evidence && row.clear_to_close_actor)) return { code: '23514', message: 'closing_cases_ctc_requires_provenance' }
      if (row.closing_status === 'closed' && !row.closed_at) return { code: '23514', message: 'closing_cases_closed_requires_closed_at' }
    }
    if (table === 'acquisition_opportunities') {
      const enteringClosed = row.acquisition_stage === 'closed' && (!old || old.acquisition_stage !== 'closed' || old.opportunity_status !== row.opportunity_status)
      const enteringWon = row.opportunity_status === 'won' && (!old || old.opportunity_status !== 'won')
      if ((enteringClosed && !LOST.has(row.opportunity_status || 'active')) || enteringWon) {
        const ok = state.closing_cases.some((c) => c.opportunity_id === row.id && c.closing_status === 'closed' && c.closed_at && !c.terminal_outcome)
        if (!ok) return { code: 'P0001', message: 'CLOSING_BLOCKED: closed-won requires a finalized closing' }
      }
    }
    for (const cols of UNIQUE[table] || []) {
      const dup = state[table].some((r) => r !== old && cols.every((c) => r[c] !== undefined && r[c] !== null && r[c] === row[c]))
      if (dup) return { code: '23505', message: `duplicate key value violates unique constraint on ${table}(${cols.join(',')})` }
    }
    return null
  }

  function query(table) {
    const filters = []
    let op = 'select'
    let payload = null
    let limitN = Infinity
    let wantRows = false
    const api = {
      select() { wantRows = true; return api },
      eq(c, v) { filters.push((r) => r[c] === v); return api },
      neq(c, v) { filters.push((r) => r[c] !== v); return api },
      in(c, arr) { filters.push((r) => arr.includes(r[c])); return api },
      is(c, v) { filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return api },
      order() { return api },
      limit(n) { limitN = n; return api },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return api },
      update(patch) { op = 'update'; payload = patch; return api },
      single() { limitN = 1; return api },
      maybeSingle() { limitN = 1; return api },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    const run = () => {
      const rows = state[table] || (state[table] = [])
      if (op === 'insert') {
        for (const r of payload) {
          const row = { id: `${table}-${rows.length + 1}`, created_at: new Date().toISOString(), ...r }
          const err = checkRow(table, row)
          if (err) return { data: null, error: err }
          rows.push(row)
        }
        return { data: wantRows ? payload : null, error: null }
      }
      const matched = rows.filter((r) => filters.every((f) => f(r))).slice(0, limitN)
      if (op === 'update') {
        const out = []
        for (const r of matched) {
          const next = { ...r, ...payload }
          const err = checkRow(table, next, r)
          if (err) return { data: null, error: err }
          Object.assign(r, payload)
          out.push({ ...r })
        }
        return { data: out, error: null }
      }
      return { data: matched.map((r) => ({ ...r })), error: null }
    }
    return api
  }

  function finalize({ p_closing_case_id: id, p_actor: actor, p_source: source }) {
    const c = state.closing_cases.find((x) => x.closing_case_id === id)
    if (!c) return { ok: false, code: 'CLOSING_NOT_FOUND' }
    if (c.closing_status === 'closed' && c.closed_at) return { ok: true, already_closed: true, closed_at: c.closed_at }
    const missing = []
    if (c.terminal_outcome || c.provenance?.voided || ['cancelled', 'declined'].includes(c.contract_status)) missing.push('closing_terminated')
    if (c.contract_status !== 'fully_executed') missing.push('seller_contract_not_executed')
    if (!c.clear_to_close_at) missing.push('title_not_clear_to_close')
    if (!c.closing_date_confirmed_at || !c.scheduled_closing_date) missing.push('closing_date_not_confirmed')
    if (state.closing_title_issues.some((i) => i.closing_case_id === id && ['open', 'in_progress'].includes(i.status))) missing.push('open_title_issues')
    const legs = state.settlement_records.filter((s) => s.closing_case_id === id)
    if (!legs.some((s) => s.settlement_status === 'settled')) missing.push('settlement_not_settled')
    if (legs.some((s) => ['pending', 'failed'].includes(s.settlement_status))) missing.push('settlement_leg_unsettled')
    if (missing.length) return { ok: false, code: 'CLOSING_BLOCKED', missing }
    const settled = legs.filter((s) => s.settlement_status === 'settled')
    const fee = settled.reduce((a, s) => a + (s.actual_assignment_fee ?? 0), 0)
    const net = settled.reduce((a, s) => a + (s.actual_net_proceeds ?? 0), 0)
    const closedAt = settled.map((s) => s.closed_at).sort().pop() || new Date().toISOString()
    Object.assign(c, { closing_status: 'closed', universal_stage: 'closed', closed_at: closedAt, closed_by: actor, confirmed_gross_revenue: fee, net_revenue: net, revenue_status: 'confirmed' })
    const opp = state.acquisition_opportunities.find((o) => o.id === c.opportunity_id)
    if (opp) {
      const next = { ...opp, acquisition_stage: 'closed', opportunity_status: 'won' }
      const err = checkRow('acquisition_opportunities', next, opp)
      if (err) throw new Error(err.message)
      Object.assign(opp, next)
    }
    if (!state.closing_milestones.some((m) => m.idempotency_key === `closing:${id}:closed:final`)) state.closing_milestones.push({ closing_case_id: id, milestone_type: 'closed', idempotency_key: `closing:${id}:closed:final`, actor })
    if (!state.closing_activity_events.some((m) => m.idempotency_key === `closing_finalized:${id}`)) state.closing_activity_events.push({ closing_case_id: id, event_type: 'closing_finalized', actor, source, idempotency_key: `closing_finalized:${id}` })
    return { ok: true, closed_at: closedAt, actual_assignment_fee: fee, actual_net_proceeds: net }
  }

  return {
    state,
    from: (t) => query(t),
    rpc: async (name, args) => {
      if (name !== 'finalize_closing_case') return { data: null, error: { message: `unknown rpc ${name}` } }
      return { data: finalize(args), error: null }
    },
  }
}

/** Lifecycle transitions recorded (the authority's only stage writer besides finalize). */
export function makeTransitionSpy(db) {
  const calls = []
  const fn = async (id, input) => {
    calls.push({ id, ...input })
    const o = db.state.acquisition_opportunities.find((x) => x.id === id)
    if (o) o.acquisition_stage = input.to_stage
    return { ok: true }
  }
  return { calls, fn }
}
