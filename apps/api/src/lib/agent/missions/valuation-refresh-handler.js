// Runtime handler `valuation.refresh` (8.5.21-b) — the bounded, prioritized valuation refresh
// queue on the R2 runtime. DRY RUN BY DEFAULT.
//
//   queue   source.candidates (read-only) + injected extra candidates (recovery linkage) →
//           buildValuationQueue (priority: active negotiation → offer request → motivated
//           plausible ask → recoverable conversation → INVESTIGATE / missing financials).
//           The ordered property refs are checkpointed (encoded, ≤ 50).
//   value   one property per step: runDecision (domain/valuation-refresh/dry-run.js — the
//           EXISTING engine entry point ensurePropertyAcquisitionDecision with unwritten
//           persisters and a write-refusing client). Each result → an agent-owned finding
//           (agent.finding, finding_type valuation.dry_run). The cursor is checkpointed after
//           every property; when the tick runs low the job YIELDS and resumes next tick.
//   summary valuation.refresh_batch finding: coverage before / after (offer-ready by the full
//           evaluateOfferReadiness gate), gained, failures, by class.
//
// It NEVER writes property_acquisition_scores / score snapshots in this wiring. Write mode needs
// VALUATION_REFRESH_WRITE_ENABLED=1 + an owner approval reference + a write-capable client the
// composition root does not provide (owner decision pending).
import { RuntimePermanentError } from '../runtime/runtime-tick.js'
import { missionIdentity } from './mission-kinds.js'
import { decodePropertyRef, encodePropertyRef } from './mission-codec.js'
import { buildValuationQueue, VALUATION_PRIORITY_CLASSES } from '../../domain/valuation-refresh/valuation-queue.js'
import { valuationWriteEnabled } from '../../domain/valuation-refresh/dry-run.js'

export const VALUATION_REFRESH_KIND = 'valuation.refresh'
export const VALUATION_REFRESH_FLAG = 'VALUATION_REFRESH_ENABLED'
/** OFF by default: the handler is wired only with VALUATION_REFRESH_ENABLED=1 (and the kind armed + enabled). */
export function valuationRefreshEnabled(env = process.env) {
  return String(env?.[VALUATION_REFRESH_FLAG] ?? '').trim() === '1'
}

/** Recovery linkage → valuation candidates (the latest recovery.linkage finding; refs decoded here). */
export async function recoveryValuationCandidates(store) {
  const f = await store?.latestFinding?.({ finding_type: 'recovery.linkage' })
  const reqs = Array.isArray(f?.value?.valuation_requests) ? f.value.valuation_requests : []
  return reqs.map((r) => { try { return { property_id: decodePropertyRef(String(r.property_ref)), recovery_class: r.recovery_class, status: 'recovery' } } catch { return null } }).filter((r) => r && /^[0-9A-Za-z_-]{1,64}$/.test(r.property_id))
}
export const VALUATION_REFRESH_LIMITS = Object.freeze({ default_limit: 25, max_limit: 50, per_property_min_ms: 8_000, candidates_read: 600 })

const clampInt = (v, d, lo, hi) => Math.min(Math.max(Math.trunc(Number(v) || d), lo), hi)
const r0 = (n) => (n == null ? null : Math.round(n))

/**
 * @param {{ source: { candidates: Function }, runDecision: (o: { property_id: string, write: boolean, now: Date }) => Promise<object>,
 *           extraCandidates?: () => Promise<Array<object>>, env?: object, now?: () => number, limits?: object }} deps
 */
export function createValuationRefreshHandler({ source, runDecision, extraCandidates = null, env = process.env, now = () => Date.now(), limits = {} } = {}) {
  if (!source || typeof runDecision !== 'function') throw new Error('valuation.refresh: source and runDecision required')
  const L = { ...VALUATION_REFRESH_LIMITS, ...limits }
  return Object.freeze({
    kind: VALUATION_REFRESH_KIND,
    async run(ctx) {
      if (!missionIdentity(ctx.job.requested_by).verified) throw new RuntimePermanentError('MISSION_PRINCIPAL_INVALID')
      const input = ctx.job.input || {}
      const write = input.write === true
      if (write && !valuationWriteEnabled(env)) throw new RuntimePermanentError('VALUATION_WRITE_DISABLED')
      if (write && !/^apr_[0-9a-f-]{36}$/.test(String(input.owner_approval_ref || ''))) throw new RuntimePermanentError('VALUATION_WRITE_NOT_APPROVED')
      const cp = { v: 1, i: 0, results: { ran: 0, reused: 0, failed: 0, before_offer_ready: 0, after_offer_ready: 0, gained_offer_ready: 0, gained_valuation: 0, by_class: {}, by_status: {}, owner_question_sfr_repairs: 0 }, ...(ctx.job.checkpoint || {}) }

      // 1 queue (once)
      if (!Array.isArray(cp.queue)) {
        await ctx.step('queue', { progress: { step: 'queue', steps_done: 0, steps_total: 3, pct: 5 }, checkpoint: cp })
        const rows = await source.candidates({ limit: L.candidates_read })
        const extra = typeof extraCandidates === 'function' ? await extraCandidates().catch(() => []) : []
        const q = buildValuationQueue([...rows, ...extra], { now: now(), limit: clampInt(input.limit, L.default_limit, 1, L.max_limit) })
        cp.queue = q.entries.map((e) => ({ ref: encodePropertyRef(e.property_id), class: e.class, need: e.need }))
        cp.queue_stats = { considered: q.considered, needing: q.needing, by_class: q.by_class, excluded: q.excluded }
        await ctx.step('queue.done', { progress: { step: 'value', steps_done: 1, steps_total: 3, pct: 10 }, checkpoint: cp, payload: { queued: cp.queue.length, needing: q.needing } })
      }

      // 2 value — one property per step, resumable
      const R = cp.results
      while (cp.i < cp.queue.length) {
        if (ctx.remainingMs() < L.per_property_min_ms) ctx.yield('valuation_next_tick')
        const e = cp.queue[cp.i]
        const pid = decodePropertyRef(e.ref)
        const r = await runDecision({ property_id: pid, write, now: new Date(now()) }).catch((err) => ({ ok: false, error: String(err?.code || err?.message || 'ENGINE_ERROR').slice(0, 80), before: { present: false }, after: { present: false } }))
        const before = r.before || { present: false }
        const after = r.after || { present: false }
        if (!r.ok) R.failed += 1
        else if (r.ran) R.ran += 1
        else R.reused += 1
        if (before.offer_ready) R.before_offer_ready += 1
        if (after.offer_ready) R.after_offer_ready += 1
        if (after.offer_ready && !before.offer_ready) R.gained_offer_ready += 1
        if (after.present && !before.present) R.gained_valuation += 1
        if (after.owner_question) R.owner_question_sfr_repairs += 1
        R.by_class[e.class] = (R.by_class[e.class] || 0) + 1
        R.by_status[r.status || (r.ok ? 'unknown' : 'failed')] = (R.by_status[r.status || (r.ok ? 'unknown' : 'failed')] || 0) + 1
        await ctx.recordFinding({
          finding_type: 'valuation.dry_run', key: `property.${e.ref}`, source_id: write ? 'decision_engine.write' : 'decision_engine.dry_run',
          value: { mode: write ? 'write' : 'dry_run', class: e.class, need: e.need, status: r.status || null, ran: Boolean(r.ran), ok: Boolean(r.ok), error: r.error || null,
            before: { present: Boolean(before.present), tier: before.decision_tier ?? null, offer_ready: Boolean(before.offer_ready), reason: before.offer_ready_reason ?? null },
            after: { present: Boolean(after.present), tier: after.decision_tier ?? null, offer_ready: Boolean(after.offer_ready), reason: after.offer_ready_reason ?? null, valuation_mid: r0(after.valuation_mid), valuation_confidence: after.valuation_confidence ?? null, comp_count: after.comp_count ?? null, mao: r0(after.mao), recommended_offer: r0(after.recommended_offer) },
            owner_question: after.owner_question || null, writes: write ? 'production' : 0 },
          confidence: r.ok ? 0.9 : 0.2,
        })
        cp.i += 1
        await ctx.step('value', { progress: { step: 'value', steps_done: 1, steps_total: 3, pct: Math.min(95, 10 + Math.round((cp.i / Math.max(cp.queue.length, 1)) * 85)) }, checkpoint: cp, payload: { done: cp.i, of: cp.queue.length, status: r.status || null } })
      }

      // 3 summary
      const summary = { mode: write ? 'write' : 'dry_run', queued: cp.queue.length, ...cp.queue_stats, ...R, priority_order: VALUATION_PRIORITY_CLASSES, production_writes: write ? 'approved_write_mode' : 0 }
      await ctx.recordFinding({ finding_type: 'valuation.refresh_batch', key: 'batch', source_id: 'agent.valuation_refresh', value: summary, confidence: 1 })
      await ctx.step('summary', { progress: { step: 'summary', steps_done: 3, steps_total: 3, pct: 99 }, checkpoint: cp })
      return { result: { mission: 'valuation_refresh', ...summary } }
    },
  })
}
