// 8.5.20 part C runtime handlers (R2 runtime; deterministic; no model; $0):
//
//   recovery.sweep        historical opportunity recovery → recovery.candidate findings +
//                         review work items. NEVER sends, queues or schedules; has no
//                         capability plane at all.
//   inbox.action_center   one durable state per conversation (agent.conversation_action_state)
//                         + the lost-conversation detector → findings + lost work items
//   pipeline.reconcile    projection / next action / due date / priority checks on every live
//                         opportunity → findings, work items, and ≤ max_proposals PENDING
//                         stage-change approvals (pipeline.propose_stage_change)
//   ops.supervisor        deterministic supervisor checks → findings, remediation work items,
//                         escalations (supervisor-checks.js)
//
// Incremental + bounded: recovery / action center walk inbox_thread_state by the keyset
// (updated_at, id) kept in the schedule watermark; a full pass restarts after
// full_pass_hours (time-based transitions — an expired follow-up date — need a re-read
// even when no row changed). The watermark advances only after a batch is fully recorded.
import { RuntimePermanentError } from '../runtime/runtime-tick.js'
import { missionIdentity } from '../missions/mission-kinds.js'
import { DEFAULT_ORG_ID } from '../capabilities/index.js'
import { createSession } from '../capabilities/registry.js'
import { normalizeConversationFacts } from './conversation-facts.js'
import { classifyRecoveryCandidate, recoveryPriority, RECOVERY_CLASSES } from './recovery-classifier.js'
import { deriveActionState, isLostConversation, summarizeActionStates, ACTION_RULES } from './action-center.js'
import { normalizeOpportunityFacts, reconcileOpportunity } from './pipeline-reconciler.js'
import { evaluateSupervisor } from './supervisor-checks.js'
import { recoveryNextAction, recoveryLinkRequests } from './recovery-linkage.js'
import { nurtureIntentFor } from './ownership-evidence.js'
import { consultHold, HOLD_CAPABILITIES, heldLabel } from './automation-hold-gate.js'
import { encodePropertyRef } from '../missions/mission-codec.js'
import { RECOVERY_SWEEP_KIND, ACTION_CENTER_KIND, PIPELINE_RECONCILE_KIND, OPS_SUPERVISOR_KIND, OPERATIONS_LIMITS } from './operations-kinds.js'

const clampInt = (v, d, lo, hi) => Math.min(Math.max(Math.trunc(Number(v) || d), lo), hi)
const fail = (code) => { throw new RuntimePermanentError(code) }

/** Keyset cursor across runs: restart after a finished pass older than full_pass_hours. */
export function sweepCursor(wm = {}, { now, full_pass_hours }) {
  if (!wm || !wm.pass_started_at) return { after_at: null, after_id: null, restart: true }
  if (wm.pass_done_at && now - Date.parse(wm.pass_done_at) >= full_pass_hours * 3_600_000) return { after_at: null, after_id: null, restart: true }
  return { after_at: wm.after_at || null, after_id: wm.after_id || null, restart: false }
}
function nextWatermark(wm, cur, rows, limit, nowIso, idKey) {
  const last = rows[rows.length - 1]
  return {
    after_at: last ? last.cursor_at : cur.after_at,
    after_id: last ? last[idKey] : cur.after_id,
    pass_started_at: cur.restart ? nowIso : wm?.pass_started_at || nowIso,
    pass_done_at: rows.length < limit ? nowIso : cur.restart ? null : wm?.pass_done_at || null,
  }
}
async function guarded(p, code) {
  try { return await p } catch (e) { throw Object.assign(new Error(code), { code: String(e?.code || code).toUpperCase().slice(0, 60) }) }
}
async function syncItems(ctx, store, items, close_missing = false) {
  if (!items.length && !close_missing) return { ok: true, inserted: 0, updated: 0, reopened: 0, resolved: 0 }
  const out = { ok: true, inserted: 0, updated: 0, reopened: 0, resolved: 0 }
  for (let i = 0; i < Math.max(items.length, 1); i += 500) {
    const r = await store.syncWorkItems({ ...ctx.lease, items: items.slice(i, i + 500), close_missing: close_missing && i + 500 >= items.length })
    if (!r?.ok) throw new RuntimePermanentError(`WORK_ITEMS_${String(r?.reason || 'REFUSED').toUpperCase()}`.slice(0, 60))
    for (const k of ['inserted', 'updated', 'reopened', 'resolved']) out[k] += Number(r[k] || 0)
  }
  return out
}
const detectionDigest = (d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => k !== 'intents' || Array.isArray(v)).map(([k, v]) => [k, v]))

// ── recovery.sweep ──────────────────────────────────────────────────────────
const RECOVERY_ITEM_KIND = { research_worthy: 'recovery_research', eligible_for_approved_followup: 'recovery_followup', needs_human_review: 'recovery_review' }

/**
 * @param {{ source: object, store: object, economicsFor?: ((facts: object) => Promise<object|null>)|null, now?: () => number,
 *           linkage?: { enqueueResearch?: (req: { property_id, trigger, discriminator }) => Promise<{ ok: boolean, reason?: string, deduped?: boolean }> } | null }} deps
 *   linkage (8.5.21-b): recovery candidates feed property.research (trigger recovery_finding) and the
 *   valuation refresh queue (the recovery.linkage finding the valuation.refresh job reads). Both are
 *   reads / research only; nothing here contacts a seller.
 */
export function createRecoverySweepHandler({ source, store, economicsFor = null, now = () => Date.now(), linkage = null } = {}) {
  if (!source || !store) throw new Error('recovery.sweep: source and store required')
  return Object.freeze({
    kind: RECOVERY_SWEEP_KIND,
    async run(ctx) {
      if (!missionIdentity(ctx.job.requested_by).verified) fail('MISSION_PRINCIPAL_INVALID')
      const input = ctx.job.input || {}
      const limit = clampInt(input.batch_limit, 300, 1, OPERATIONS_LIMITS.batch_max)
      const approved = Array.isArray(input.approved_programs) ? input.approved_programs.map(String) : []
      const t = now()
      const wm = input.schedule_watermark || {}
      const cur = ctx.job.schedule_id != null ? sweepCursor(wm, { now: t, full_pass_hours: clampInt(input.full_pass_hours, 24, 1, 168) }) : { after_at: input.after_at || null, after_id: input.after_id || null, restart: !input.after_at }
      // Lists stay in memory (agent.research_job.checkpoint is capped at 16 KB): a resumed
      // attempt re-reads the same cursor and re-records — findings upsert per (job, type, key),
      // work items de-duplicate per dedupe_key, so a replay writes nothing twice.
      await ctx.step('read', { progress: { step: 'read', steps_done: 0, steps_total: 4, pct: 5 } })
      const raw = await guarded(source.conversationFacts({ after_at: cur.after_at, after_id: cur.after_id, limit }), 'RECOVERY_SOURCE_UNAVAILABLE')
      const all = []
      let econ = 0
      const nurture = { built: 0, enqueued: 0, deduped: 0, refused: {}, skipped: {} }
      const intents = []
      for (const r of raw) {
        let f = normalizeConversationFacts(r)
        // 8.5.21-b: canonical-ledger ownership evidence when wired (a bare "No" to OUR ownership question is a denial)
        if (linkage?.ownershipEvidenceFor && !f.ownership_evidence) {
          const ev = await linkage.ownershipEvidenceFor(f).catch(() => null)
          if (ev?.ownership) f = { ...f, ownership_evidence: ev.ownership }
        }
        let economics = null
        if (economicsFor && f.opportunity?.asking_price && f.property_id && econ < 50) {
          economics = await economicsFor(f).catch(() => null)
          if (economics) econ += 1
        }
        const c = classifyRecoveryCandidate(f, { now: t, approved_programs: approved, economics })
        const next = recoveryNextAction(c)
        const ni = nurtureIntentFor(f, c, { now: t })
        if (ni.intent) { nurture.built += 1; intents.push(ni.intent) } else if (ni.reason !== 'not_disinterest') nurture.skipped[ni.reason] = (nurture.skipped[ni.reason] || 0) + 1
        all.push({ conversation_id: f.conversation_id, cursor_at: f.cursor_at, class: c.class, reasons: c.reasons, detections: c.detections.map(detectionDigest), permission: { permitted: c.permission.permitted, blocks: c.permission.blocks, ownership: c.permission.ownership }, program: c.program, priority: recoveryPriority(c), economics_class: c.economics_class, evidence_refs: c.evidence_refs, property_ref: c.property_ref, property_id: f.property_id, next_action: { action: next.action, owner: next.owner, research: next.research, valuation: next.valuation } })
      }
      const by_class = Object.fromEntries(RECOVERY_CLASSES.map((k) => [k, 0]))
      for (const c of all) by_class[c.class] += 1
      const cursor = nextWatermark(wm, cur, all, limit, new Date(t).toISOString(), 'conversation_id')
      const candidates = all.filter((c) => RECOVERY_ITEM_KIND[c.class]).sort((a, b) => b.priority - a.priority)
      const clear = all.filter((c) => !RECOVERY_ITEM_KIND[c.class]).map((c) => c.conversation_id)
      await ctx.step('classify.done', { progress: { step: 'findings', steps_done: 1, steps_total: 4, pct: 40 }, payload: { scanned: raw.length, actionable: candidates.length } })

      const fs = candidates.slice(0, OPERATIONS_LIMITS.findings_per_job)
      for (const c of fs) await ctx.recordFinding({ finding_type: 'recovery.candidate', key: `conv.${c.conversation_id}`, source_id: 'public.inbox_thread_state', citation: `inbox_thread_state:${c.conversation_id}`, value: { conversation_id: c.conversation_id, class: c.class, reasons: c.reasons, detections: c.detections, permission: c.permission, program: c.program, priority: c.priority, economics_class: c.economics_class, evidence_refs: c.evidence_refs, property_ref: c.property_ref, next_action: c.next_action }, confidence: 1 })

      // 8.5.21-b linkage: research + valuation requests for the conversations worth underwriting
      const links = recoveryLinkRequests(all)
      const research = { requested: links.research.length, enqueued: 0, deduped: 0, refused: {} }
      // owner P0: every act consults the automation-hold registry first (fail closed); held items are reported, never acted on
      const held = { count: 0, by_type: {}, items: [] }
      const factsById = new Map(all.map((c) => [c.conversation_id, c]))
      const holdFor = async (conversation_id, property_id, capability) => {
        const h = await consultHold(linkage?.checkAutomationHold || null, { threadId: conversation_id, propertyId: property_id || null, opportunityId: (factsById.get(conversation_id)?.evidence_refs || []).find((x) => x.source === 'public.acquisition_opportunities')?.record_id || null, capability })
        if (h.held) { held.count += 1; held.by_type[h.hold_type || 'unknown'] = (held.by_type[h.hold_type || 'unknown'] || 0) + 1; if (held.items.length < 20) held.items.push({ conversation_id, capability, label: heldLabel(h), hold_id: h.hold_id }) }
        return h
      }
      if (linkage?.enqueueResearch) {
        for (const req of links.research.slice(0, OPERATIONS_LIMITS.research_requests_per_job)) {
          if ((await holdFor(req.conversation_id, req.property_id, HOLD_CAPABILITIES.recovery_research)).held) { research.refused.AUTOMATION_HOLD = (research.refused.AUTOMATION_HOLD || 0) + 1; continue }
          const r = await linkage.enqueueResearch(req).catch((e) => ({ ok: false, reason: String(e?.code || 'ENQUEUE_FAILED') }))
          if (r?.ok && r.deduped) research.deduped += 1
          else if (r?.ok) research.enqueued += 1
          else research.refused[String(r?.reason || 'REFUSED').slice(0, 40)] = (research.refused[String(r?.reason || 'REFUSED').slice(0, 40)] || 0) + 1
        }
      } else research.refused.LINKAGE_NOT_CONFIGURED = links.research.length
      // genuine RECENT disinterest → the 30-day nurture intent for the 8.5.21-a follow-up pipeline (it owns execution)
      if (linkage?.enqueueFollowupIntent) {
        for (const intent of intents.slice(0, OPERATIONS_LIMITS.research_requests_per_job)) {
          if ((await holdFor(intent.conversation_id, null, HOLD_CAPABILITIES.recovery_nurture)).held) { nurture.refused.AUTOMATION_HOLD = (nurture.refused.AUTOMATION_HOLD || 0) + 1; continue }
          const r = await linkage.enqueueFollowupIntent(intent).catch((e) => ({ ok: false, reason: String(e?.code || 'ENQUEUE_FAILED') }))
          if (r?.ok && r.deduped) nurture.deduped += 1
          else if (r?.ok) nurture.enqueued += 1
          else nurture.refused[String(r?.reason || 'REFUSED').slice(0, 40)] = (nurture.refused[String(r?.reason || 'REFUSED').slice(0, 40)] || 0) + 1
        }
      } else if (intents.length) nurture.refused.FOLLOWUP_PIPELINE_NOT_CONFIGURED = intents.length
      await ctx.recordFinding({ finding_type: 'recovery.linkage', key: 'batch', source_id: 'agent.recovery_sweep', value: { research, nurture, held, valuation_requests: links.valuation.slice(0, 200).map((v) => ({ property_ref: encodePropertyRef(v.property_id), recovery_class: v.recovery_class, conversation_id: v.conversation_id })), by_next_action: links.by_action, sends: 0 }, confidence: 1 })
      await ctx.recordFinding({ finding_type: 'recovery.batch', key: 'batch', source_id: 'agent.recovery_sweep', value: { scanned: raw.length, by_class, actionable: candidates.length, findings_recorded: fs.length, economics_evaluated: econ, approved_programs: approved, pass_done: Boolean(cursor.pass_done_at), research_requests: research, valuation_requests: links.valuation.length, by_next_action: links.by_action, held: { count: held.count, by_type: held.by_type, items: held.items }, sends: 0 }, confidence: 1 })
      await ctx.step('findings.done', { progress: { step: 'review_items', steps_done: 2, steps_total: 4, pct: 70 }, payload: { written: fs.length + 1 } })

      const items = candidates.map((c) => ({
        dedupe_key: `recovery:conv:${c.conversation_id}`, kind: RECOVERY_ITEM_KIND[c.class], severity: c.class === 'needs_human_review' ? 'warning' : 'info',
        title: c.class === 'research_worthy' ? 'Recovery: research before any re-contact' : c.class === 'eligible_for_approved_followup' ? `Recovery: follow-up inside approved program ${c.program}` : `Recovery: human review (${c.reasons[c.reasons.length - 1] || 'review'})`,
        subject_type: 'conversation', subject_id: c.conversation_id, priority: Math.min(c.priority, 1000),
        detail: { class: c.class, reasons: c.reasons, program: c.program, economics_class: c.economics_class, evidence_refs: c.evidence_refs.slice(0, 8), next_action: c.next_action },
      }))
      for (const id of clear) items.push({ dedupe_key: `recovery:conv:${id}`, resolve: true })
      const synced = await syncItems(ctx, store, items)
      await ctx.step('items.done', { progress: { step: 'watermark', steps_done: 3, steps_total: 4, pct: 90 }, payload: synced })

      if (ctx.job.schedule_id != null) await ctx.setWatermark(cursor)
      await ctx.step('watermark', { progress: { step: 'watermark', steps_done: 4, steps_total: 4, pct: 99 } })
      return { result: { mission: 'recovery_sweep', scanned: raw.length, by_class, actionable: candidates.length, review_items: synced, findings: fs.length + 2, economics_evaluated: econ, research_requests: research, nurture_intents: nurture, held: { count: held.count, by_type: held.by_type }, valuation_requests: links.valuation.length, pass_done: Boolean(cursor.pass_done_at), sends: 0 } }
    },
  })
}

// ── inbox.action_center ─────────────────────────────────────────────────────
/** @param {{ source: object, store: object, now?: () => number, org_id?: string }} deps */
export function createActionCenterHandler({ source, store, now = () => Date.now(), org_id = DEFAULT_ORG_ID } = {}) {
  if (!source || !store) throw new Error('inbox.action_center: source and store required')
  return Object.freeze({
    kind: ACTION_CENTER_KIND,
    async run(ctx) {
      if (!missionIdentity(ctx.job.requested_by).verified) fail('MISSION_PRINCIPAL_INVALID')
      const input = ctx.job.input || {}
      const limit = clampInt(input.batch_limit, 500, 1, OPERATIONS_LIMITS.batch_max)
      const rules = { ...ACTION_RULES, ...(Number.isFinite(Number(input.wait_hours)) ? { wait_hours: clampInt(input.wait_hours, 72, 1, 720) } : {}), ...(Number.isFinite(Number(input.lost_after_minutes)) ? { lost_after_minutes: clampInt(input.lost_after_minutes, 60, 5, 10_080) } : {}) }
      const t = now()
      const wm = input.schedule_watermark || {}
      const cur = ctx.job.schedule_id != null ? sweepCursor(wm, { now: t, full_pass_hours: clampInt(input.full_pass_hours, 1, 1, 48) }) : { after_at: input.after_at || null, after_id: input.after_id || null, restart: !input.after_at }
      await ctx.step('read', { progress: { step: 'read', steps_done: 0, steps_total: 4, pct: 5 } })
      const raw = await guarded(source.conversationFacts({ after_at: cur.after_at, after_id: cur.after_id, limit }), 'ACTION_CENTER_SOURCE_UNAVAILABLE')
      const facts = raw.map(normalizeConversationFacts)
      const [approvals, work] = await Promise.all([
        store.pendingApprovalTargets({ org_id }).catch(() => []),
        store.workItemsFor({ conversation_ids: facts.map((f) => f.conversation_id) }).catch(() => []),
      ])
      const apByOpp = new Map()
      for (const a of approvals) if (a.opportunity_id) (apByOpp.get(a.opportunity_id) || apByOpp.set(a.opportunity_id, []).get(a.opportunity_id)).push(a)
      const wByConv = new Map()
      for (const w of work) (wByConv.get(w.subject_id) || wByConv.set(w.subject_id, []).get(w.subject_id)).push(w)
      const states = facts.map((f) => deriveActionState(f, { now: t, approvals: apByOpp.get(f.opportunity?.opportunity_id) || [], work: wByConv.get(f.conversation_id) || [], rules }))
      const rows = states.map((st) => ({ conversation_id: st.conversation_id, state: st.state, owner: st.owner, verified_stage: st.verified_stage, stage_verified: st.stage_verified, stage_note: st.stage_note, next_action: st.next_action, due_at: st.due_at, priority_reason: st.priority_reason, evidence_refs: st.evidence_refs, pending_approvals: st.pending_approvals, reasons: st.reasons, lost: st.lost, opportunity_id: st.opportunity_id, property_ref: st.property_ref, last_inbound_at: st.last_inbound_at, last_outbound_at: st.last_outbound_at, derived_from: st.derived_from, version: st.version }))
      const summary = summarizeActionStates(states)
      const cursor = nextWatermark(wm, cur, facts, limit, new Date(t).toISOString(), 'conversation_id')
      await ctx.step('derive.done', { progress: { step: 'write', steps_done: 1, steps_total: 4, pct: 40 }, payload: { conversations: states.length, lost: summary.lost } })

      const written = rows.length ? await store.upsertActionStates({ ...ctx.lease, rows }) : { ok: true, upserted: 0, changed: 0 }
      if (!written?.ok) fail(`ACTION_STATES_${String(written?.reason || 'REFUSED').toUpperCase()}`.slice(0, 60))
      const lost = rows.filter(isLostConversation)
      const items = [
        ...lost.map((st) => ({ dedupe_key: `action_center:lost:${st.conversation_id}`, kind: 'lost_conversation', severity: 'warning', title: 'Seller message without a next action', subject_type: 'conversation', subject_id: st.conversation_id, priority: 100, due_at: st.due_at, detail: { reasons: st.reasons, verified_stage: st.verified_stage, evidence_refs: st.evidence_refs.slice(0, 6) } })),
        ...rows.filter((st) => !st.lost).map((st) => ({ dedupe_key: `action_center:lost:${st.conversation_id}`, resolve: true })),
      ]
      const synced = await syncItems(ctx, store, items)
      for (const st of lost.slice(0, OPERATIONS_LIMITS.findings_per_job)) await ctx.recordFinding({ finding_type: 'inbox.lost_conversation', key: `conv.${st.conversation_id}`, source_id: 'public.inbox_thread_state', value: { conversation_id: st.conversation_id, reasons: st.reasons, due_at: st.due_at, verified_stage: st.verified_stage, evidence_refs: st.evidence_refs }, confidence: 1 })
      await ctx.recordFinding({ finding_type: 'inbox.action_center_batch', key: 'batch', source_id: 'agent.conversation_action_state', value: { ...summary, changed: written.changed, pass_done: Boolean(cursor.pass_done_at) }, confidence: 1 })
      await ctx.step('write.done', { progress: { step: 'watermark', steps_done: 3, steps_total: 4, pct: 90 }, payload: { upserted: written.upserted, changed: written.changed, lost: lost.length } })

      if (ctx.job.schedule_id != null) await ctx.setWatermark(cursor)
      await ctx.step('watermark', { progress: { step: 'watermark', steps_done: 4, steps_total: 4, pct: 99 } })
      return { result: { mission: 'action_center', ...summary, written: { upserted: written.upserted, changed: written.changed }, lost_items: synced, pass_done: Boolean(cursor.pass_done_at), sends: 0 } }
    },
  })
}

// ── pipeline.reconcile ──────────────────────────────────────────────────────
/** @param {{ source: object, store: object, getPlane?: () => Promise<object|null>, now?: () => number, org_id?: string }} deps */
export function createPipelineReconcileHandler({ source, store, getPlane = async () => null, now = () => Date.now(), org_id = DEFAULT_ORG_ID } = {}) {
  if (!source || !store) throw new Error('pipeline.reconcile: source and store required')
  return Object.freeze({
    kind: PIPELINE_RECONCILE_KIND,
    async run(ctx) {
      const identity = missionIdentity(ctx.job.requested_by)
      if (!identity.verified) fail('MISSION_PRINCIPAL_INVALID')
      const input = ctx.job.input || {}
      const limit = clampInt(input.batch_limit, 300, 1, OPERATIONS_LIMITS.batch_max)
      const maxProposals = input.propose === false ? 0 : clampInt(input.max_proposals, 5, 0, OPERATIONS_LIMITS.proposals_max)
      const t = now()
      const wm = input.schedule_watermark || {}
      const after = ctx.job.schedule_id != null ? (wm.pass_done_at ? null : wm.after_id || null) : input.after_id || null
      await ctx.step('read', { progress: { step: 'read', steps_done: 0, steps_total: 4, pct: 5 } })
      const raw = await guarded(source.pipelineFacts({ after_id: after, limit }), 'PIPELINE_SOURCE_UNAVAILABLE')
      const res = raw.map(normalizeOpportunityFacts).map((o) => reconcileOpportunity(o, { now: t }))
      const by_issue = {}
      for (const r of res) for (const i of r.issues) by_issue[i.code] = (by_issue[i.code] || 0) + 1
      const results = res.filter((r) => !r.ok)
      const clear = res.filter((r) => r.ok).map((r) => r.opportunity_id)
      const cursor = { after_id: raw.length ? String(raw[raw.length - 1].opportunity_id) : after, pass_done_at: raw.length < limit ? new Date(t).toISOString() : null }
      await ctx.step('read.done', { progress: { step: 'findings', steps_done: 1, steps_total: 4, pct: 35 }, payload: { scanned: raw.length, mismatched: results.length } })

      for (const r of results.slice(0, OPERATIONS_LIMITS.findings_per_job)) await ctx.recordFinding({ finding_type: 'pipeline.mismatch', key: `opp.${r.opportunity_id}`, source_id: 'public.acquisition_opportunities', value: { opportunity_id: r.opportunity_id, conversation_id: r.conversation_id, property_ref: r.property_ref, stage: r.stage, status: r.status, issues: r.issues, proposal: r.proposal }, confidence: 1 })

      // stage changes are PROPOSED (pending approvals); the capability's idempotency key (opportunity × stage) makes a replay a no-op
      const proposals = []
      const want = results.filter((r) => r.proposal).sort((a, b) => (b.issues.some((i) => i.severity === 'critical') ? 1 : 0) - (a.issues.some((i) => i.severity === 'critical') ? 1 : 0)).slice(0, maxProposals)
      const plane = want.length ? await getPlane().catch(() => null) : null
      if (want.length && !plane) for (const r of want) proposals.push({ opportunity_id: r.opportunity_id, to_stage: r.proposal.to_stage, status: 'skipped', code: 'CAPABILITIES_UNAVAILABLE' })
      for (const r of plane ? want : []) {
        const a = await plane.invoker.invoke({ capability_id: 'pipeline.propose_stage_change', input: { opportunity_id: r.opportunity_id, to_stage: r.proposal.to_stage, reason: r.proposal.reason.slice(0, 240) }, ctx: { org_id, identity, source: 'model', session: createSession() } })
        proposals.push(a.ok ? { opportunity_id: r.opportunity_id, to_stage: r.proposal.to_stage, status: 'approval_pending', approval_id: a.approval_id || null, deduped: Boolean(a.deduped) } : { opportunity_id: r.opportunity_id, to_stage: r.proposal.to_stage, status: 'refused', code: String(a.code || 'REFUSED').slice(0, 60) })
      }
      await ctx.step('proposals.done', { progress: { step: 'items', steps_done: 2, steps_total: 4, pct: 65 }, payload: { proposals: proposals.length } })

      const apBy = new Map(proposals.map((p) => [p.opportunity_id, p]))
      const items = results.map((r) => ({
        dedupe_key: `pipeline:opp:${r.opportunity_id}`, kind: 'pipeline_mismatch', severity: r.issues.some((i) => i.severity === 'critical') ? 'critical' : r.issues.some((i) => i.severity === 'warning') ? 'warning' : 'info',
        title: `Pipeline: ${r.issues.map((i) => i.code).join(', ')}`.slice(0, 200), subject_type: 'opportunity', subject_id: r.opportunity_id,
        priority: r.issues.some((i) => i.severity === 'critical') ? 200 : 50,
        detail: { stage: r.stage, issues: r.issues.map((i) => ({ code: i.code, severity: i.severity })), proposal: r.proposal ? { to_stage: r.proposal.to_stage } : null, approval: apBy.get(r.opportunity_id) || null, conversation_id: r.conversation_id },
      }))
      for (const id of clear) items.push({ dedupe_key: `pipeline:opp:${id}`, resolve: true })
      const synced = await syncItems(ctx, store, items)
      await ctx.recordFinding({ finding_type: 'pipeline.batch', key: 'batch', source_id: 'agent.pipeline_reconcile', value: { scanned: raw.length, mismatched: results.length, by_issue, proposals: proposals.slice(0, 10), pass_done: Boolean(cursor.pass_done_at) }, confidence: 1 })
      await ctx.step('items.done', { progress: { step: 'watermark', steps_done: 3, steps_total: 4, pct: 90 }, payload: synced })

      if (ctx.job.schedule_id != null) await ctx.setWatermark(cursor)
      await ctx.step('watermark', { progress: { step: 'watermark', steps_done: 4, steps_total: 4, pct: 99 } })
      return { result: { mission: 'pipeline_reconcile', scanned: raw.length, mismatched: results.length, by_issue, proposals: proposals.slice(0, 10), items: synced, stage_writes: 0 } }
    },
  })
}

// ── ops.supervisor ──────────────────────────────────────────────────────────
/**
 * @param {{ source: object, store: object, reads: object, now?: () => number, org_id?: string }} deps
 *   reads = the 8.5.18 mission read model (activitySince, spendTotals, researchLimits, pendingApprovals)
 */
export function createOpsSupervisorHandler({ source, store, reads, holdsSource = null, now = () => Date.now(), org_id = DEFAULT_ORG_ID } = {}) {
  if (!source || !store || !reads) throw new Error('ops.supervisor: source, store and reads required')
  const settle = (p, code) => p.then((v) => v ?? { unavailable: code }, (e) => ({ unavailable: String(e?.code || code).toUpperCase().slice(0, 60) }))
  return Object.freeze({
    kind: OPS_SUPERVISOR_KIND,
    async run(ctx) {
      if (!missionIdentity(ctx.job.requested_by).verified) fail('MISSION_PRINCIPAL_INVALID')
      const t = now()
      const since24 = new Date(t - 86_400_000).toISOString()
      await ctx.step('read', { progress: { step: 'read', steps_done: 0, steps_total: 3, pct: 5 } })
      const [snapshot, health, actionCenter, recovery, activity, spendTotals, limits, approvals, researchValuation, valuationBatch, holds] = await Promise.all([
        settle(source.supervisorSnapshot({ now: new Date(t).toISOString() }), 'SNAPSHOT_UNAVAILABLE'),
        settle(ctx.read.healthSnapshot({}), 'HEALTH_SNAPSHOT_UNAVAILABLE'),
        settle(store.actionCenterSummary().then((x) => (x.total ? x : null)), 'ACTION_CENTER_NOT_RUN'),
        settle(store.latestFinding({ finding_type: 'recovery.batch', since: since24 }).then((f) => (f ? { ...f.value, at: f.retrieved_at } : null)), 'RECOVERY_NOT_RUN'),
        settle(reads.activitySince({ since: since24 }), 'RUNTIME_UNAVAILABLE'),
        settle(reads.spendTotals(), 'SPEND_UNAVAILABLE'),
        settle(reads.researchLimits(), 'SPEND_UNAVAILABLE'),
        reads.pendingApprovals({ org_id, limit: 100 }).catch((e) => ({ unavailable: String(e?.code || 'APPROVALS_UNAVAILABLE') })),
        // 8.5.21-b: valuation coverage / overdue offers / negotiation authority + the latest valuation dry run
        typeof source.researchValuationSnapshot === 'function' ? settle(source.researchValuationSnapshot({ now: new Date(t).toISOString() }), 'RESEARCH_VALUATION_SNAPSHOT_UNAVAILABLE') : Promise.resolve({ unavailable: 'RESEARCH_VALUATION_SOURCE_NOT_CONFIGURED' }),
        settle(store.latestFinding({ finding_type: 'valuation.refresh_batch' }).then((f) => (f ? { ...f.value, at: f.retrieved_at } : null)), 'VALUATION_REFRESH_NOT_RUN'),
        // owner P0: the automation-hold registry (report only; rc-8.5.21: the runtime wiring passes the registry summary)
        holdsSource?.summary ? settle(holdsSource.summary(), 'AUTOMATION_HOLDS_UNAVAILABLE') : Promise.resolve({ unavailable: 'AUTOMATION_HOLDS_SOURCE_NOT_CONFIGURED' }),
      ])
      const runtime = activity.unavailable ? activity : { jobs: activity.jobs.filter((j) => j.job_id !== ctx.job.job_id) }
      const spend = spendTotals.unavailable ? spendTotals : limits.unavailable ? limits : { ...spendTotals, limits }
      const ev = evaluateSupervisor({ snapshot, health, actionCenter, recovery, runtime, spend, approvals, researchValuation, valuationBatch, holds, now: t, thresholds: ctx.job.input?.thresholds || {} })
      await ctx.step('evaluate.done', { progress: { step: 'record', steps_done: 1, steps_total: 3, pct: 50 }, payload: ev.counts })

      for (const c of ev.checks.filter((x) => x.status !== 'ok')) await ctx.recordFinding({ finding_type: 'supervisor.check', key: c.id, source_id: 'agent.ops_supervisor', value: c, confidence: 1 })
      for (const i of ev.issues.filter((x) => x.escalate)) await ctx.recordFinding({ finding_type: 'supervisor.escalation', key: i.check_id, source_id: 'agent.ops_supervisor', value: { title: i.title, severity: i.severity, remediation: i.remediation }, confidence: 1 })
      await ctx.recordFinding({ finding_type: 'supervisor.summary', key: 'summary', source_id: 'agent.ops_supervisor', value: { counts: ev.counts, all_clear: ev.all_clear, escalations: ev.escalations, statuses: Object.fromEntries(ev.checks.map((c) => [c.id, c.status])) }, confidence: 1 })
      const items = ev.issues.map((i) => ({ dedupe_key: i.dedupe_key, kind: i.kind, severity: i.severity, escalated: Boolean(i.escalate), title: i.title.slice(0, 200), subject_type: 'system', subject_id: i.check_id, priority: i.severity === 'critical' ? 500 : i.severity === 'warning' ? 100 : 10, detail: { check_id: i.check_id, recoverable: i.recoverable !== false, remediation: i.remediation || null } }))
      // close_missing resolves an issue that no longer reproduces — but only for checks READ this
      // run: an unavailable source never "clears" anything, so its open items are re-asserted
      const unread = new Set(ev.checks.filter((c) => c.status === 'unavailable').map((c) => c.id))
      const keep = (await store.listWorkItems({ scope: 'supervisor', limit: 200 }).catch(() => [])).filter((w) => unread.has(w.detail?.check_id) && !items.some((x) => x.dedupe_key === w.dedupe_key))
      for (const w of keep) items.push({ dedupe_key: w.dedupe_key, kind: w.kind, severity: w.severity, escalated: w.escalated, title: w.title, subject_type: w.subject_type, subject_id: w.subject_id, priority: w.priority, detail: w.detail })
      const synced = await syncItems(ctx, store, items, true)
      await ctx.step('record.done', { progress: { step: 'done', steps_done: 3, steps_total: 3, pct: 99 }, payload: synced })
      return { result: { mission: 'ops_supervisor', counts: ev.counts, all_clear: ev.all_clear, escalations: ev.escalations, statuses: Object.fromEntries(ev.checks.map((c) => [c.id, c.status])), items: synced, model_calls: 0 } }
    },
  })
}

/**
 * @param {{ source: object|null, store: object|null, reads: object, getPlane?: Function, economicsFor?: Function|null, now?: () => number }} deps
 * @returns {Record<string, { run: Function }>}  {} when the source or store is missing
 */
export function buildOperationsHandlers({ source, store, reads, getPlane = async () => null, economicsFor = null, linkage = null, holdsSource = null, now = () => Date.now() }) {
  if (!source || !store) return {}
  return {
    [RECOVERY_SWEEP_KIND]: createRecoverySweepHandler({ source, store, economicsFor, linkage, now }),
    [ACTION_CENTER_KIND]: createActionCenterHandler({ source, store, now }),
    [PIPELINE_RECONCILE_KIND]: createPipelineReconcileHandler({ source, store, getPlane, now }),
    ...(reads ? { [OPS_SUPERVISOR_KIND]: createOpsSupervisorHandler({ source, store, reads, holdsSource, now }) } : {}),
  }
}
