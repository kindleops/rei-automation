// Runtime handler `property.research` (8.5.20-b; 8.5.21-b resumable steps) — autonomous
// property research on the R2 runtime, reusing the mission.research machinery for its web step.
//
// 8.5.21-b: the job is a CHECKPOINTED state machine whose steps each fit one runtime tick
// (default 25 s): checkpoint.phase = internal → web → findings → done.
//
//   internal  loadResearchInputs + runInternalResearch (domain/property-research): the typed
//             dossier from internal data FIRST, comps + local area, opportunity economics,
//             MAO + opening plan, the labelled ZIP prior. Read-only, $0. Decides whether a web
//             step is wanted (gaps, input, ask service, AGENT_WEB_RESEARCH_ENABLED, budget).
//             When the web step does not fit the rest of THIS tick, the job YIELDS (released
//             without burning an attempt) and the web step starts a fresh tick.
//   web       its OWN step: ONE bounded ask through the existing research ask service
//             (job-owned reserves; day / cycle / job caps; blocked-domain policy). Bounded by
//             a step timeout (≤ web_step_max_ms) and a per-model-call timeout (≤ 20 s); 2 model calls
//             (search, answer), each bound by what is left of the JOB budget. On a
//             timeout the attempt is cancelled, its cost is checkpointed, and the job yields
//             to RESUME in a later tick — up to web_attempts_max, then it completes on
//             internal evidence only (web status 'timed_out'). Before every attempt the
//             remaining JOB budget (budget_cap_usd − committed spend across attempts) must
//             cover one model-call reservation, else 'skipped_budget' (no budget_blocked
//             park, no lost findings). Parsed items must cite a server-observed URL; a web
//             price is a LISTING, never a sale.
//   findings  property.dossier · property.comps_area · property.economics ·
//             property.offer_plan (internal_only) · property.web_evidence · property.research.
//             Recorded once (checkpointed): a resumed attempt never re-records or re-spends.
//
// Nothing here sends, grants an envelope, writes a stage, a valuation or an offer.
import { RuntimePermanentError, RuntimeStop } from '../runtime/runtime-tick.js'
import { createJobAskStore } from './job-ask-store.js'
import { MISSION_LIMITS, missionIdentity, PROPERTY_RESEARCH_KIND } from './mission-kinds.js'
import { decodePropertyRef, encodePropertyRef, jsonBytes, storableUrl } from './mission-codec.js'
import { recordFindings } from './research-mission-handler.js'
import { encodeForStore, maskContacts } from '../research/pii.js'
import { isWebEnabled } from '../research/web-research.js'
import { paidResearchGate, webEvidenceIsFresh, usageFinding } from '../research/research-usage.js'
import { loadResearchInputs, runInternalResearch } from '../../domain/property-research/research-pipeline.js'
import { buildWebQuestion, parseWebAnswer } from '../../domain/property-research/web-listings.js'

export { PROPERTY_RESEARCH_KIND }
const CP_MAX = 14_000
const WEB_GAPS = new Set(['listing_status', 'zoning', 'flood_exposure', 'entitled_density'])
const safeCode = (v) => String(v || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60)

/**
 * Production-runtime limits (8.5.21-b). The job budget itself is the DB's budget_cap_usd
 * (event jobs: kind_limits.property.research.event_budget_cap_usd, clamped by
 * agent.runtime_event_budget_ceiling — PROPOSED 0.30, PROPOSED_20261016160000).
 */
export const PROPERTY_RESEARCH_LIMITS = Object.freeze({
  proposed_event_budget_usd: 0.30,
  /** the web step starts in this tick only with at least this much wall clock left; else it yields */
  web_step_min_ms: 21_000,
  /** one web attempt never runs longer than this (it is cancelled and resumed next tick) */
  web_step_max_ms: 22_000,
  /** no single model call longer than this */
  model_call_timeout_ms: 20_000,
  /** web attempts per job (a timed-out attempt is resumed in a later tick until this many) */
  web_attempts_max: 2,
  /** model calls per web attempt: the ask service answers WITHOUT tools on its last allowed call, so a web
   *  search needs 2 (search, then answer); the job budget binds every call (see jobReads below) */
  web_model_calls: 2,
  /** the reservation one web model call takes (measured 2026-10-16: $0.2559 worst-case reserve) */
  web_call_reserve_usd: 0.26,
  /** yields before the job gives up waiting for a fresh tick and completes on internal evidence */
  yields_max: 6,
})

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
    { finding_type: 'property.offer_plan', key: `property.${ref}`, source_id: 'property_research.offer_plan', value: storedValue({ visibility: 'internal_only', available: Boolean(plan.available), reason: plan.reason || null, recommendation: plan.recommendation || null, market_prior: plan.market_prior?.available ? plan.market_prior.label : null }, plan), confidence: plan.available ? 0.6 : 0.2 },
    { finding_type: 'property.research', key: `property.${ref}`, source_id: 'property_research.pipeline', value: { lane: r.lane, economics_class: r.economics.class, offer_plan_available: Boolean(plan.available), coverage_share: r.evidence.coverage.share, gaps: r.evidence.gaps.length, web_listings: r.evidence.web.listings, web_notes: r.evidence.web.notes }, confidence: 1 },
  ]
  if (web) fs.push({ finding_type: 'property.web_evidence', key: `property.${ref}`, source_id: 'public_web', value: storedValue({ listings: web.listings.length, notes: web.notes.length, dropped_uncited: web.dropped_uncited, cost_usd: web.cost_usd }, { listings: web.listings.map((l) => ({ ...l, url: storableUrl(l.url) })), notes: web.notes.map((n) => ({ ...n, url: storableUrl(n.url) })) }), confidence: 0.4 })
  return fs
}

/** Which web gaps the internal pass left (internal data holds recorded sales only: listings are always a gap). */
export function webGapsOf(research) {
  return [...research.dossier.gaps.filter((g) => WEB_GAPS.has(g)), ...(research.comps_area.evidence_counts.listings ? [] : ['nearby_listings'])]
}

const round6 = (n) => Math.round(Number(n || 0) * 1e6) / 1e6

/**
 * @param {{ source: object, reads: object, buildAsk?: Function|null, env?: object, now?: () => number,
 *           zipLookup?: Function|null, zipPriorFor?: Function|null, minAskMs?: number|null, limits?: object }} deps
 *   zipPriorFor({ zip5, lane, property, valuation }) → zip-prior.resolveZipPrior() result (optional)
 *   minAskMs: wall clock the web step needs left in THIS tick to start (default limits.web_step_min_ms)
 */
export function createPropertyResearchHandler({ source, reads, buildAsk = null, env = process.env, now = () => Date.now(), zipLookup = null, zipPriorFor = null, minAskMs = null, limits = {} } = {}) {
  if (!source || !reads) throw new Error('property.research: source and reads are required')
  const L = { ...PROPERTY_RESEARCH_LIMITS, ...limits }
  const startWebMs = minAskMs ?? L.web_step_min_ms
  return Object.freeze({
    kind: PROPERTY_RESEARCH_KIND,
    async run(ctx) {
      const input = ctx.job.input || {}
      const identity = missionIdentity(ctx.job.requested_by)
      if (!identity.verified) throw new RuntimePermanentError('MISSION_PRINCIPAL_INVALID')
      const pid = input.property_ref ? decodePropertyRef(String(input.property_ref)) : ''
      if (!/^[0-9A-Za-z_-]{1,64}$/.test(pid)) throw new RuntimePermanentError('PROPERTY_REF_INVALID')
      const ref = encodePropertyRef(pid)
      const cp = { v: 2, yields: 0, web_attempts: 0, web_cost_usd: 0, ...(ctx.job.checkpoint || {}) }
      const trigger = String(input.trigger || 'manual').slice(0, 40)
      const yieldFor = async (reason, progress) => {
        cp.yields = Number(cp.yields || 0) + 1
        await ctx.step(`yield.${reason}`, { progress, checkpoint: cp, payload: { reason, yields: cp.yields } })
        ctx.yield(reason)
      }

      // 1 internal ($0; recomputed on resume — cheaper than checkpointing the dossier)
      await ctx.step('internal', { progress: { step: 'internal', steps_done: 0, steps_total: 3, pct: 5 }, checkpoint: cp, payload: { trigger, resumed: Boolean(cp.phase) } })
      const inputs = await loadResearchInputs(source, pid, { now: now() })
      if (!inputs.found) throw new RuntimePermanentError('PROPERTY_NOT_FOUND')
      const zipCell = typeof zipLookup === 'function' ? await zipLookup({ zip5: inputs.zip, lane: null }).catch(() => null) : null
      let research = runInternalResearch(inputs, { now: now(), zip_cell: zipCell })
      const zipPrior = typeof zipPriorFor === 'function' ? await zipPriorFor({ zip5: inputs.zip, lane: research.lane, property: inputs.property, valuation: inputs.valuation }).catch(() => null) : null
      if (zipPrior) research = runInternalResearch(inputs, { now: now(), zip_cell: zipCell, zip_prior: zipPrior })
      if (!cp.phase) cp.phase = 'internal'

      // 2 web (its own step; bounded; resumable; budget-checked; optional)
      if (!cp.web) {
        const gaps = webGapsOf(research)
        const want = input.web !== false && buildAsk && isWebEnabled(env) && gaps.length > 0
        if (!want) {
          cp.web = { status: !buildAsk ? 'skipped_no_ask_service' : !isWebEnabled(env) ? 'skipped_web_disabled' : input.web === false ? 'skipped_by_input' : 'skipped_no_gaps', listings: [], notes: [], dropped_uncited: 0, cost_usd: 0 }
        } else {
          cp.phase = 'web'
          const cap = Number(ctx.job.budget_cap_usd || 0)
          const committed = typeof reads.jobSpend === 'function' ? Number((await reads.jobSpend(ctx.job.job_id).catch(() => null))?.committed_usd ?? cp.web_cost_usd) : Number(cp.web_cost_usd)
          const room$ = round6(cap - Math.max(committed, Number(cp.web_cost_usd || 0)))
          const reserve = Number(input.web_call_reserve_usd ?? L.web_call_reserve_usd)
          // at least ONE worst-case web-call reservation must fit what is left of the job budget
          const calls = room$ + 1e-9 >= reserve ? Math.min(Number(input.max_model_calls) || L.web_model_calls, MISSION_LIMITS.ask_max_model_calls) : 0
          // 8.5.21-b owner decision (3): dedupe first (recent web evidence is the cache), then DEFAULT-DENY paid
          // calls unless the owner approved them and the $10 testing ceiling has room
          const fresh = cp.web_attempts ? { fresh: false } : input.force_web === true ? { fresh: false } : await webEvidenceIsFresh({ reads, property_ref: ref, now: now() })
          const committedPaid = typeof reads.spendTotals === 'function' ? await reads.spendTotals().then((t) => Number(t?.cycle_usd), () => null) : null
          const gate = paidResearchGate({ env, committed_paid_usd: Number.isFinite(committedPaid) ? committedPaid : null, estimate_usd: reserve * Math.max(calls, 1) })
          if (fresh.fresh) {
            cp.web = { status: 'skipped_recent_web_evidence', listings: [], notes: [], dropped_uncited: 0, cost_usd: 0, dedupe: fresh.reason }
          } else if (!gate.ok) {
            cp.web = { status: `skipped_${gate.reason}`, listings: [], notes: [], dropped_uncited: 0, cost_usd: 0, paid_gate: { reason: gate.reason, ceiling_usd: gate.ceiling_usd, committed_usd: gate.committed_usd } }
          } else if (Number(cp.web_attempts || 0) >= L.web_attempts_max) {
            cp.web = { status: cp.web_last_timeout ? 'timed_out' : 'failed:attempts_exhausted', listings: [], notes: [], dropped_uncited: 0, cost_usd: round6(cp.web_cost_usd), attempts: cp.web_attempts }
          } else if (calls < 1) {
            cp.web = { status: 'skipped_budget', listings: [], notes: [], dropped_uncited: 0, cost_usd: round6(cp.web_cost_usd), budget: { cap_usd: cap, committed_usd: round6(committed), per_call_reserve_usd: reserve } }
          } else if (ctx.remainingMs() < startWebMs) {
            if (Number(cp.yields || 0) >= L.yields_max) cp.web = { status: 'skipped_no_tick_room', listings: [], notes: [], dropped_uncited: 0, cost_usd: round6(cp.web_cost_usd) }
            else await yieldFor('web_next_tick', { step: 'web', steps_done: 1, steps_total: 3, pct: 15 })
          }
          if (!cp.web) {
            cp.web_attempts = Number(cp.web_attempts || 0) + 1
            await ctx.step('web', { progress: { step: 'web', steps_done: 1, steps_total: 3, pct: 20 }, checkpoint: cp, payload: { gaps: gaps.length, attempt: cp.web_attempts, calls } })
            const question = buildWebQuestion(research.dossier, { gaps })
            // the ask service's per-run cap = what is LEFT of this job's budget (committed spend across attempts
            // is the job ask store's run total): a call that would exceed it is refused BEFORE it reserves —
            // the run ends with what it has, never a budget_blocked park
            const jobReads = { ...reads, researchLimits: async () => { const l = await reads.researchLimits(); return { ...l, run_usd: Math.min(Number(l?.run_usd ?? cap), cap) } } }
            const store = createJobAskStore({ ctx, reads: jobReads })
            const svc = buildAsk({ store, capabilityHook: null })
            const stepMs = Math.max(3_000, Math.min(L.web_step_max_ms, ctx.remainingMs() - 2_500))
            const modelMs = Math.max(2_000, Math.min(L.model_call_timeout_ms, stepMs - 1_000))
            const started = await svc.ask({ operator_id: ctx.job.requested_by, identity, question, context: { property_ids: [pid] }, limits: { run_timeout_ms: stepMs, answer_by_ms: Math.floor(stepMs * 0.6), model_timeout_ms: modelMs, max_model_calls: calls, max_default_calls: calls } })
            let stop = null
            let timedOut = false
            const onAbort = () => { if (!stop) { stop = new RuntimeStop('deadline'); try { svc.cancel(started.run_id, ctx.job.requested_by) } catch { /* ended */ } } }
            ctx.signal.addEventListener('abort', onAbort, { once: true })
            let timer
            const stepTimeout = new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; try { svc.cancel(started.run_id, ctx.job.requested_by) } catch { /* ended */ } resolve({ state: 'timed_out', outcome: 'WEB_STEP_TIMEOUT' }) }, stepMs) })
            let r
            try { r = await Promise.race([started.done, stepTimeout]) } finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort) }
            if (store.stopped) throw store.stopped
            if (stop) throw stop
            const spent = round6(Number(r?.cost_usd ?? store.settled_usd ?? 0))
            cp.web_cost_usd = round6(Number(cp.web_cost_usd || 0) + spent)
            cp.web_usage = { model_calls: Number(cp.web_usage?.model_calls || 0) + Number(r?.model_calls || 0), web_searches: Number(cp.web_usage?.web_searches || 0) + Number(r?.web_searches || 0) }
            const timeoutLike = timedOut || /TIMEOUT/.test(String(r?.outcome || ''))
            if (timeoutLike && cp.web_attempts < L.web_attempts_max) {
              cp.web_last_timeout = String(r?.outcome || 'WEB_STEP_TIMEOUT').slice(0, 40)
              await yieldFor('web_timeout_resume', { step: 'web', steps_done: 1, steps_total: 3, pct: 30 })
            }
            if (r?.state === 'cancelled' && !timedOut) throw new RuntimeStop('cancelled')
            const cites = (r?.result?.evidence?.public_web || []).map((c) => ({ url: c.url, retrieved_at: c.retrieved_at || null }))
            const parsed = r?.state === 'completed' ? parseWebAnswer(String(r.answer_md || ''), cites) : { listings: [], notes: [], dropped_uncited: 0 }
            cp.web = { status: r?.state === 'completed' ? 'completed' : timeoutLike ? 'timed_out' : `failed:${safeCode(r?.outcome)}`, ...parsed, cost_usd: cp.web_cost_usd, citations: cites.length, attempts: cp.web_attempts }
            while (jsonBytes(cp) > CP_MAX && (cp.web.listings.length || cp.web.notes.length)) { if (cp.web.listings.length) cp.web.listings.pop(); else cp.web.notes.pop() }
            await ctx.step('web.done', { progress: { step: 'web', steps_done: 2, steps_total: 3, pct: 60 }, checkpoint: cp, payload: { status: cp.web.status, listings: cp.web.listings.length, notes: cp.web.notes.length, cost_usd: cp.web.cost_usd, attempts: cp.web_attempts } })
          }
        }
      }
      if (cp.web.listings.length || cp.web.notes.length) research = runInternalResearch(inputs, { now: now(), zip_cell: zipCell, zip_prior: zipPrior, listings: cp.web.listings, web_notes: cp.web.notes })

      // 3 findings (once)
      if (!cp.findings) {
        cp.phase = 'findings'
        await ctx.step('findings', { progress: { step: 'findings', steps_done: 2, steps_total: 3, pct: 80 }, checkpoint: cp })
        const usage = usageFinding({ property_ref: ref, mission: PROPERTY_RESEARCH_KIND, provider: 'anthropic', model_calls: cp.web_usage?.model_calls || 0, web_searches: cp.web_usage?.web_searches || 0, usd: cp.web.cost_usd || 0, outcome: cp.web.status, deduped: cp.web.status === 'skipped_recent_web_evidence' })
        cp.findings = await recordFindings(ctx, [...propertyResearchFindings(ref, research, cp.web.status === 'completed' ? cp.web : null), usage])
        cp.phase = 'done'
        await ctx.step('findings.done', { progress: { step: 'findings', steps_done: 3, steps_total: 3, pct: 99 }, checkpoint: cp, payload: { written: cp.findings.written, refused: cp.findings.refused.length } })
      }
      const plan = research.offer_plan || {}
      return { result: { mission: 'property_research', property_ref: ref, trigger, lane: research.lane, economics_class: research.economics.class, judgment_path: research.economics.judgment?.path ?? null, offer_plan: { available: Boolean(plan.available), reason: plan.reason || null, visibility: 'internal_only', market_prior: plan.market_prior?.available ? plan.market_prior.label : null }, coverage_share: research.evidence.coverage.share, gaps: research.evidence.gaps, stale: research.evidence.stale, web: { status: cp.web.status, listings: cp.web.listings.length, notes: cp.web.notes.length, attempts: Number(cp.web_attempts || 0) }, cost_usd: Number(cp.web.cost_usd || 0), yields: Number(cp.yields || 0), findings: cp.findings.written, sends: 0 } }
    },
  })
}
