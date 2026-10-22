// memory.assert (internal) — organizational memory through workforce.memory_assert (supersede-only).
// An AI employee asserts INTERPRETATIONS only. "verified" needs at least one source ref (and the store
// re-checks it); "ceo_policy" is the CEO user's alone and is refused here outright.
import { arr, code, depOutput, done, ref } from './shared.js'

export const KEY = 'memory.assert'
const SCOPES = new Set(['company', 'department', 'employee', 'mission', 'property', 'market'])

/** The compact memory value of a ranking output: positions and refs, never a contact. */
export function rankingMemoryValue(rankOutput, nextOutputs = []) {
  const next = new Map(nextOutputs.filter(Boolean).map((o) => [o.position, o]))
  return {
    version: rankOutput?.version ?? null,
    method: rankOutput?.method ?? null,
    ranked: arr(rankOutput?.ranked).slice(0, 25).map((r) => ({
      rank: r.rank,
      property_ref: r.property_ref,
      cfo_verdict: r.cfo_verdict ?? null,
      ev: r.ev?.status === 'known' ? r.ev.value : null,
      ev_status: r.ev?.status ?? 'unknown',
      next_action: next.get(r.rank)?.action ?? null,
    })),
  }
}

/** A compact, number-and-code summary of an upstream read (counts, totals, stage counts). */
export function summaryOf(o = {}) {
  const pick = {}
  for (const k of ['mode', 'source', 'markets', 'scanned', 'eligible', 'excluded', 'totals', 'stages', 'stalled_by', 'generated_at', 'reads_failed']) if (o?.[k] !== undefined) pick[k] = o[k]
  if (Array.isArray(o?.candidates)) pick.candidates = o.candidates.length
  return pick
}

export const capability = Object.freeze({
  key: KEY,
  class: 'internal',
  roles: Object.freeze(['ceo', 'coo', 'cfo', 'head_acquisitions', 'acquisition_agent', 'head_marketing', 'campaign_manager', 'head_dispositions', 'dispositions_agent', 'head_data_intelligence', 'research_analyst', 'ops_supervisor', 'human_staff']),
  escalates_on: Object.freeze([]),
  resourceOf: () => null,
  async run(ctx, input = {}) {
    const epistemic = input.epistemic || 'interpretation'
    if (epistemic === 'ceo_policy') return done({ asserted: false, refused: 'ceo_policy_is_the_ceo_users_alone' }, { outcome_class: 'refused' })
    const scope = SCOPES.has(input.scope) ? input.scope : 'mission'
    const scope_key = String(input.scope_key || ctx.mission?.mission_id || '').slice(0, 80)
    const fact_key = code(input.fact) || 'note'
    let value = input.value ?? null
    const source_refs = []
    if (input.from_rank_step) {
      const rank = depOutput(ctx, input.from_rank_step)
      const nexts = arr(input.from_next_steps).map((k) => depOutput(ctx, k)?.output).filter(Boolean)
      if (!rank) return done({ asserted: false, reason: 'ranking_unavailable' }, { outcome_class: 'unknown' })
      value = rankingMemoryValue(rank.output, nexts)
      source_refs.push(ref('assignment', rank.assignment_id))
    }
    if (Array.isArray(input.from_steps) && input.from_steps.length) {
      const parts = {}
      for (const k of input.from_steps.slice(0, 10)) {
        const d = depOutput(ctx, k)
        if (!d) continue
        parts[k] = summaryOf(d.output)
        source_refs.push(ref('assignment', d.assignment_id))
      }
      if (!Object.keys(parts).length) return done({ asserted: false, reason: 'inputs_unavailable' }, { outcome_class: 'unknown' })
      value = parts
    }
    for (const r of arr(input.source_refs)) if (r?.type && r?.id) source_refs.push(ref(String(r.type).slice(0, 30), r.id))
    if (epistemic === 'verified' && !source_refs.length) return done({ asserted: false, refused: 'verified_needs_a_source_ref' }, { outcome_class: 'refused' })
    if (ctx.employee?.kind === 'ai' && epistemic !== 'interpretation' && epistemic !== 'verified') return done({ asserted: false, refused: 'ai_asserts_interpretations_only' }, { outcome_class: 'refused' })
    const fact = await ctx.store.assertMemoryFact({
      org_id: ctx.org_id, scope, scope_key, fact_key, value, epistemic: ctx.employee?.kind === 'ai' && epistemic === 'verified' && !source_refs.length ? 'interpretation' : epistemic,
      confidence: input.confidence ?? null, source_refs: source_refs.filter(Boolean), author_employee_id: ctx.employee?.employee_id ?? null,
    })
    return done({ asserted: true, fact_id: fact?.fact_id ?? null, scope, scope_key, fact: fact_key, epistemic }, { evidence: [ref('memory_fact', fact?.fact_id), ...source_refs] })
  },
})
