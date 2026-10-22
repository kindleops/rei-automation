// acq.rank_opportunities (read) — rank the triage candidates from the UPSTREAM step outputs only
// (conversation state, decision, research, CFO verdict) with acquisitions/ranking.js. A candidate
// whose steps did not produce usable evidence is ranked on what is known and its unknowns stay unknown.
import { rankOpportunities } from '../acquisitions/ranking.js'
import { arr, depOutput, done, obj, ref, usable } from './shared.js'

export const KEY = 'acq.rank_opportunities'

export const capability = Object.freeze({
  key: KEY,
  class: 'read',
  roles: Object.freeze(['head_acquisitions']),
  escalates_on: Object.freeze([]),
  resourceOf: () => null,
  async run(ctx, input = {}) {
    const opps = input.opps_step ? depOutput(ctx, input.opps_step) : null
    const byRef = new Map(arr(opps?.output?.candidates).map((c) => [c.property_ref, c]))
    const items = []
    let partial = false
    for (const slot of arr(input.slots)) {
      const conv = depOutput(ctx, slot.conv)
      const dec = depOutput(ctx, slot.dec)
      const res = slot.res ? depOutput(ctx, slot.res) : null
      const fin = depOutput(ctx, slot.fin)
      if (!usable(conv) || !usable(dec) || !usable(fin)) partial = true
      const cand = byRef.get(slot.property_ref) || {}
      let calibration = null
      if (typeof ctx.services?.closeCalibration === 'function') {
        try { calibration = await ctx.services.closeCalibration({ market: cand.market ?? null, stage: conv?.output?.action?.verified_stage ?? cand.stage ?? null }) } catch { calibration = null }
      }
      items.push({
        property_ref: slot.property_ref,
        opportunity_id: cand.opportunity_id ?? null,
        conversation_id: conv?.output?.conversation_id ?? cand.conversation_id ?? null,
        market: cand.market ?? null,
        candidate: cand,
        conv: usable(conv) || conv?.outcome_class === 'refused' ? conv.output : null,
        decision: usable(dec) ? dec.output : null,
        cfo: usable(fin) ? fin.output : null,
        calibration,
        refs: { conversation_state: conv?.assignment_id ?? null, decision: dec?.assignment_id ?? null, research: res?.assignment_id ?? null, finance: fin?.assignment_id ?? null },
        escalated: fin?.outcome_class === 'refused' && obj(fin.output).authority === 'escalate',
      })
    }
    const r = rankOpportunities(items, { now: ctx.now ?? Date.now() })
    const esc = new Set(items.filter((i) => i.escalated).map((i) => i.property_ref))
    return done({
      version: r.version,
      method: r.method,
      considered: r.considered,
      n: Number(input.n) || null,
      ranked: r.ranked.map((x) => ({ ...x, escalated: esc.has(x.property_ref) })),
      excluded: r.excluded,
    }, { outcome_class: partial ? 'partial' : 'verified', evidence: items.flatMap((i) => Object.values(i.refs).filter(Boolean).map((id) => ref('assignment', id))).slice(0, 40) })
  },
})
