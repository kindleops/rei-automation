// Runtime handler `property.research` (8.5.20-b) — autonomous property research on
// the R2 runtime, reusing the mission.research machinery for its web step.
//
//   1 internal  loadResearchInputs + runInternalResearch (domain/property-research): the
//               typed dossier from internal data FIRST, comps + local area, opportunity
//               economics (+ Phase 7 judgment), MAO + opening plan. Read-only, $0.
//   2 web       ONLY when there are gaps (dossier gaps, or no listing evidence — internal data
//               holds recorded sales only), the job input allows it, a research ask
//               service is wired AND AGENT_WEB_RESEARCH_ENABLED=1: one bounded ask through
//               the existing research ask service (job-owned reserves, same day / cycle /
//               run caps, the web tool's blocked-domain policy). Parsed items must cite a
//               server-observed URL; a web price is a LISTING. Checkpointed: a resumed attempt
//               never re-spends.
//   3 findings  property.dossier · property.comps_area · property.economics ·
//               property.offer_plan (visibility internal_only) · property.web_evidence ·
//               property.research (summary). Values are contact-masked and store-encoded.
//
// Nothing here sends, grants an envelope, writes a stage or an offer: the offer plan is
// a recommendation for an operator; money reaches a seller only inside a granted
// negotiation envelope (8.5.19).
import { RuntimePermanentError, RuntimeStop } from '../runtime/runtime-tick.js'
import { createJobAskStore } from './job-ask-store.js'
import { MISSION_LIMITS, missionIdentity, PROPERTY_RESEARCH_KIND } from './mission-kinds.js'
import { decodePropertyRef, encodePropertyRef, jsonBytes, storableUrl } from './mission-codec.js'
import { recordFindings } from './research-mission-handler.js'
import { encodeForStore, maskContacts } from '../research/pii.js'
import { isWebEnabled } from '../research/web-research.js'
import { loadResearchInputs, runInternalResearch } from '../../domain/property-research/research-pipeline.js'
import { buildWebQuestion, parseWebAnswer } from '../../domain/property-research/web-listings.js'

export { PROPERTY_RESEARCH_KIND }
const CP_MAX = 14_000
const WEB_GAPS = new Set(['listing_status', 'zoning', 'flood_exposure', 'entitled_density'])
const safeCode = (v) => String(v || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60)

/** Finding value: a few scalars + the full payload contact-masked and store-encoded. */
export function storedValue(summary, payload) {
  const masked = maskContacts(payload).value
  return { ...summary, payload_v1: encodeForStore(JSON.stringify(masked)) }
}

export function propertyResearchFindings(ref, r, web = null) {
  const plan = r.offer_plan || {}
  const fs = [
    { finding_type: 'property.dossier', key: `property.${ref}`, source_id: 'property_research.dossier', value: storedValue({ lane: r.lane, contract_ok: r.dossier.contract.ok, coverage_share: r.dossier.coverage.share, gaps: r.dossier.gaps, stale: r.dossier.stale }, { ...r.dossier, sections: { ...r.dossier.sections, identity: { ...r.dossier.sections.identity, location: undefined } } }), confidence: r.dossier.contract.ok ? Math.max(0.2, r.dossier.coverage.share) : 0.1 },
    { finding_type: 'property.comps_area', key: `property.${ref}`, source_id: 'property_research.comps_area', value: storedValue({ sold: r.comps_area.evidence_counts.sold, market_sales: r.comps_area.evidence_counts.market_sales, listings: r.comps_area.evidence_counts.listings, uncertainty: r.comps_area.uncertainty.level }, { sections: r.comps_area.sections, evidence_counts: r.comps_area.evidence_counts, uncertainty: r.comps_area.uncertainty }), confidence: r.comps_area.uncertainty.level === 'low' ? 0.7 : r.comps_area.uncertainty.level === 'medium' ? 0.5 : 0.3 },
    { finding_type: 'property.economics', key: `property.${ref}`, source_id: 'property_research.economics', value: storedValue({ class: r.economics.class, judgment_path: r.economics.judgment?.path ?? null, friction: r.economics.execution_friction?.level ?? null }, r.economics), confidence: r.economics.uncertainty?.level === 'low' ? 0.75 : r.economics.uncertainty?.level === 'medium' ? 0.5 : 0.3 },
    { finding_type: 'property.offer_plan', key: `property.${ref}`, source_id: 'property_research.offer_plan', value: storedValue({ visibility: 'internal_only', available: Boolean(plan.available), reason: plan.reason || null, recommendation: plan.recommendation || null }, plan), confidence: plan.available ? 0.6 : 0.2 },
    { finding_type: 'property.research', key: `property.${ref}`, source_id: 'property_research.pipeline', value: { lane: r.lane, economics_class: r.economics.class, offer_plan_available: Boolean(plan.available), coverage_share: r.evidence.coverage.share, gaps: r.evidence.gaps.length, web_listings: r.evidence.web.listings, web_notes: r.evidence.web.notes }, confidence: 1 },
  ]
  if (web) fs.push({ finding_type: 'property.web_evidence', key: `property.${ref}`, source_id: 'public_web', value: storedValue({ listings: web.listings.length, notes: web.notes.length, dropped_uncited: web.dropped_uncited, cost_usd: web.cost_usd }, { listings: web.listings.map((l) => ({ ...l, url: storableUrl(l.url) })), notes: web.notes.map((n) => ({ ...n, url: storableUrl(n.url) })) }), confidence: 0.4 })
  return fs
}

/**
 * @param {{ source: object, reads: object, buildAsk?: Function|null, env?: object, now?: () => number, zipLookup?: Function|null, minAskMs?: number }} deps
 */
export function createPropertyResearchHandler({ source, reads, buildAsk = null, env = process.env, now = () => Date.now(), zipLookup = null, minAskMs = MISSION_LIMITS.min_ask_ms } = {}) {
  if (!source || !reads) throw new Error('property.research: source and reads are required')
  return Object.freeze({
    kind: PROPERTY_RESEARCH_KIND,
    async run(ctx) {
      const input = ctx.job.input || {}
      const identity = missionIdentity(ctx.job.requested_by)
      if (!identity.verified) throw new RuntimePermanentError('MISSION_PRINCIPAL_INVALID')
      const pid = input.property_ref ? decodePropertyRef(String(input.property_ref)) : ''
      if (!/^[0-9A-Za-z_-]{1,64}$/.test(pid)) throw new RuntimePermanentError('PROPERTY_REF_INVALID')
      const ref = encodePropertyRef(pid)
      const cp = { v: 1, ...(ctx.job.checkpoint || {}) }

      // 1 internal ($0; recomputed on resume — cheaper than checkpointing the dossier)
      await ctx.step('internal', { progress: { step: 'internal', steps_done: 0, steps_total: 3, pct: 5 }, checkpoint: cp, payload: { trigger: String(input.trigger || 'manual').slice(0, 40) } })
      const inputs = await loadResearchInputs(source, pid, { now: now() })
      if (!inputs.found) throw new RuntimePermanentError('PROPERTY_NOT_FOUND')
      const zipCell = typeof zipLookup === 'function' ? await zipLookup({ zip5: inputs.zip, lane: null }).catch(() => null) : null
      let research = runInternalResearch(inputs, { now: now(), zip_cell: zipCell })

      // 2 web (bounded, optional, checkpointed)
      if (!cp.web) {
        // internal sources hold recorded sales only: active / pending listings nearby are always a web gap
        const gaps = [...research.dossier.gaps.filter((g) => WEB_GAPS.has(g)), ...(research.comps_area.evidence_counts.listings ? [] : ['nearby_listings'])]
        const want = input.web !== false && buildAsk && isWebEnabled(env) && gaps.length > 0
        if (!want) {
          cp.web = { status: !buildAsk ? 'skipped_no_ask_service' : !isWebEnabled(env) ? 'skipped_web_disabled' : input.web === false ? 'skipped_by_input' : 'skipped_no_gaps', listings: [], notes: [], dropped_uncited: 0, cost_usd: 0 }
        } else {
          if (ctx.remainingMs() < minAskMs) ctx.yield('tick_budget')
          await ctx.step('web', { progress: { step: 'web', steps_done: 1, steps_total: 3, pct: 20 }, checkpoint: cp, payload: { gaps: gaps.length } })
          const question = buildWebQuestion(research.dossier, { gaps })
          const store = createJobAskStore({ ctx, reads })
          const svc = buildAsk({ store, capabilityHook: null })
          const room = Math.max(5_000, ctx.remainingMs() - 4_000)
          const calls = Math.min(Number(input.max_model_calls) || 2, MISSION_LIMITS.ask_max_model_calls)
          const started = await svc.ask({ operator_id: ctx.job.requested_by, identity, question, context: { property_ids: [pid] }, limits: { run_timeout_ms: Math.floor(room * 0.4), answer_by_ms: Math.floor(room * 0.25), model_timeout_ms: Math.min(90_000, Math.floor(room * 0.6)), max_model_calls: calls, max_default_calls: calls } })
          let stop = null
          const onAbort = () => { if (!stop) { stop = new RuntimeStop('deadline'); try { svc.cancel(started.run_id, ctx.job.requested_by) } catch { /* ended */ } } }
          ctx.signal.addEventListener('abort', onAbort, { once: true })
          let r
          try { r = await started.done } finally { ctx.signal.removeEventListener('abort', onAbort) }
          if (store.stopped) throw store.stopped
          if (stop) throw stop
          if (r?.state === 'cancelled') throw new RuntimeStop('cancelled')
          const cites = (r?.result?.evidence?.public_web || []).map((c) => ({ url: c.url, retrieved_at: c.retrieved_at || null }))
          const parsed = r?.state === 'completed' ? parseWebAnswer(String(r.answer_md || ''), cites) : { listings: [], notes: [], dropped_uncited: 0 }
          cp.web = { status: r?.state === 'completed' ? 'completed' : `failed:${safeCode(r?.outcome)}`, ...parsed, cost_usd: Number(r?.cost_usd || 0), citations: cites.length }
          while (jsonBytes(cp) > CP_MAX && (cp.web.listings.length || cp.web.notes.length)) { if (cp.web.listings.length) cp.web.listings.pop(); else cp.web.notes.pop() }
          await ctx.step('web.done', { progress: { step: 'web', steps_done: 2, steps_total: 3, pct: 60 }, checkpoint: cp, payload: { status: cp.web.status, listings: cp.web.listings.length, notes: cp.web.notes.length, cost_usd: cp.web.cost_usd } })
        }
      }
      if (cp.web.listings.length || cp.web.notes.length) research = runInternalResearch(inputs, { now: now(), zip_cell: zipCell, listings: cp.web.listings, web_notes: cp.web.notes })

      // 3 findings
      if (!cp.findings) {
        await ctx.step('findings', { progress: { step: 'findings', steps_done: 2, steps_total: 3, pct: 80 }, checkpoint: cp })
        cp.findings = await recordFindings(ctx, propertyResearchFindings(ref, research, cp.web.status === 'completed' ? cp.web : null))
        await ctx.step('findings.done', { progress: { step: 'findings', steps_done: 3, steps_total: 3, pct: 99 }, checkpoint: cp, payload: { written: cp.findings.written, refused: cp.findings.refused.length } })
      }
      const plan = research.offer_plan || {}
      return { result: { mission: 'property_research', property_ref: ref, trigger: String(input.trigger || 'manual').slice(0, 40), lane: research.lane, economics_class: research.economics.class, judgment_path: research.economics.judgment?.path ?? null, offer_plan: { available: Boolean(plan.available), reason: plan.reason || null, visibility: 'internal_only' }, coverage_share: research.evidence.coverage.share, gaps: research.evidence.gaps, stale: research.evidence.stale, web: { status: cp.web.status, listings: cp.web.listings.length, notes: cp.web.notes.length }, cost_usd: Number(cp.web.cost_usd || 0), findings: cp.findings.written } }
    },
  })
}
