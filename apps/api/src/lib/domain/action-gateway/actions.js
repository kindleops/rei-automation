// Per-action logic, pluggable by name: resolve (authoritative LeadCommand ids, tenant scope), params (the
// stored, payload-clean form the database binds to the intent), policy (the EXISTING domain guards) and,
// for actions that are not a database domain write, execute.
//
// A policy returns { decision: 'allow' | 'deny' | 'approval', code?, policy_id, policy_version, evidence }.
// Policies never trust a model's claim: every fact is re-read here. A hold / STOP / suppression read that
// fails is a refusal (fail closed), never "no hold".
import crypto from 'node:crypto'
import { maskString } from '../../agent/research/pii.js'
import { encodePropertyRef } from '../../agent/missions/mission-codec.js'
import { researchMissionInput } from '../../agent/capabilities/defs/platform.js'
import { MISSION_LIMITS } from '../../agent/missions/mission-kinds.js'
import { gwErr } from './errors.js'
import { T2_LOGIC } from './actions/t2/index.js'
import { T34_LOGIC } from './actions/t34/index.js'
import { WF_LOGIC } from './actions/workforce/index.js'

export const POLICY_VERSION = 'v1'
const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex')

// The DB's phone-run rule (agent.payload_string_violation): such runs never reach a stored row
const PHONE_RUN = /[0-9](?:[\s().,:/_+·–—-]{0,4}[0-9]){9,14}/g
/** Free text an agent supplies → masked (phones / emails) and digit-run-neutralized, bounded. */
export function cleanText(v, max) {
  const [masked] = maskString(String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max * 2), {})
  return masked.replace(PHONE_RUN, '[number withheld]').replace(/\s+/g, ' ').trim().slice(0, max)
}

const held = (h) => h?.held !== false
async function holdOrRefuse(services, args, capability) {
  let h
  try { h = await services.holdCheck({ ...args, capability }) } catch { h = { held: true, fail_closed: true } }
  if (held(h)) return { decision: 'deny', code: h?.fail_closed ? 'AUTOMATION_HOLD_LOOKUP_FAILED' : 'AUTOMATION_HOLD', evidence: { hold: h?.fail_closed ? 'lookup_failed' : 'held', hold_type: h?.hold_type || null, capability } }
  return null
}

async function mustThread(reads, id) {
  const t = await reads.thread(id)
  if (!t?.thread_key) throw gwErr('not_found', 'THREAD_NOT_FOUND', 'no inbox thread with this id')
  return t
}
async function mustProperty(reads, id) {
  const p = await reads.property(id)
  if (!p) throw gwErr('not_found', 'PROPERTY_NOT_FOUND', 'no property with this id')
  return p
}

// ── the actions ──────────────────────────────────────────────────────────────
export const ACTION_LOGIC = Object.freeze({
  ...T2_LOGIC,
  ...T34_LOGIC,
  ...WF_LOGIC,
  create_research_job: {
    async resolve(input, { reads }) {
      for (const pid of input.property_ids || []) await mustProperty(reads, pid)
      const first = (input.property_ids || [])[0]
      if (!first) return { type: 'system', id: 'research', refs: {} }
      const p = await reads.property(first)
      return { type: 'property', id: String(first), refs: { property_id: String(first), market: p?.market || null } }
    },
    params(input) {
      const context = { ...(input.property_ids?.length ? { property_ids: input.property_ids.map(String) } : {}), ...(input.campaign_id ? { campaign_id: input.campaign_id } : {}) }
      const budget = Math.min(input.budget_usd ?? MISSION_LIMITS.research_default_usd, MISSION_LIMITS.research_max_usd)
      return {
        runtime_kind: 'mission.research',
        runtime_input: researchMissionInput({ kind: 'mission.research', question: input.question, context, ...(input.max_model_calls ? { max_model_calls: input.max_model_calls } : {}) }),
        budget_usd: Math.round(budget * 100) / 100,
        priority: 100,
      }
    },
    async policy({ input, params, grant, services, resource }) {
      for (const pid of input.property_ids || []) {
        const h = await holdOrRefuse(services, { propertyId: String(pid) }, 'property.research_enqueue')
        if (h) return h
      }
      // the standing grant's envelope bounds the autonomous spend (absent: the missions default, $0.50)
      const ceiling = Number.isFinite(Number(grant.envelope?.max?.budget_usd)) ? Math.min(Number(grant.envelope.max.budget_usd), MISSION_LIMITS.research_max_usd) : MISSION_LIMITS.research_default_usd
      const evidence = { budget_usd: params.budget_usd, autonomous_ceiling_usd: ceiling, properties: (input.property_ids || []).length, resource_type: resource.type }
      if (params.budget_usd > ceiling) return { decision: 'approval', code: 'BUDGET_ABOVE_AUTONOMOUS_CEILING', evidence }
      return { decision: 'allow', evidence }
    },
    summary: (params) => [`Research mission (read-only, findings only), budget $${params.budget_usd}`, 'Above the agent\'s autonomous research budget: a human approves the spend.'],
  },

  request_property_valuation: {
    async resolve(input, { reads }) {
      const p = await mustProperty(reads, input.property_id)
      return { type: 'property', id: String(input.property_id), refs: { property_id: String(input.property_id), market: p.market || null } }
    },
    params(input) {
      const ref = encodePropertyRef(String(input.property_id))
      return { property_ref: ref, runtime_kind: 'property.research', runtime_input: { property_ref: ref, trigger: 'valuation_stale_or_missing', web: false }, budget_usd: 0, priority: 120 }
    },
    async policy({ resource, services }) {
      const h = await holdOrRefuse(services, { propertyId: resource.refs.property_id }, 'valuation.refresh')
      if (h) return h
      return { decision: 'allow', evidence: { web: false, writes: 'findings_only' } }
    },
  },

  create_operator_task: {
    async resolve(input, { reads }) {
      if (!input.subject) return { type: 'system', id: 'tasks', refs: {} }
      if (input.subject.type === 'thread') { const t = await mustThread(reads, input.subject.id); return { type: 'thread', id: t.id, refs: { thread_key: t.thread_key, thread_id: t.id, market: t.market || null } } }
      const o = await reads.opportunity(input.subject.id)
      if (!o) throw gwErr('not_found', 'OPPORTUNITY_NOT_FOUND', 'no opportunity with this id')
      return { type: 'opportunity', id: String(o.id), refs: { opportunity_id: String(o.id), market: o.market || null } }
    },
    params(input, resource) {
      return {
        title: cleanText(input.title, 160),
        notes: input.note ? [cleanText(input.note, 600)] : [],
        priority: input.priority ?? 50,
        severity: input.severity || 'info',
        ...(input.due_at ? { due_at: new Date(input.due_at).toISOString() } : {}),
        subject_type: resource.type === 'thread' ? 'conversation' : resource.type === 'opportunity' ? 'opportunity' : 'system',
        ...(resource.type === 'system' ? {} : { subject_id: resource.id }),
      }
    },
    async policy({ input }) {
      if (input.due_at && !Number.isFinite(Date.parse(input.due_at))) return { decision: 'deny', code: 'DUE_AT_INVALID', evidence: {} }
      return { decision: 'allow', evidence: { subject: input.subject?.type || 'none' } }
    },
  },

  update_operator_task: {
    async resolve(input, { store }) {
      const w = await store.workItemGet(input.work_item_id)
      if (!w) throw gwErr('not_found', 'TASK_NOT_FOUND', 'no agent-created operator task with this id')
      return { type: 'work_item', id: String(w.work_item_id), refs: { work_item: w } }
    },
    params(input, resource) {
      return {
        work_item_id: resource.id,
        notes: input.note ? [cleanText(input.note, 600)] : [],
        ...(input.priority != null ? { priority: input.priority } : {}),
        ...(input.due_at ? { due_at: new Date(input.due_at).toISOString() } : {}),
        ...(input.resolve === true ? { state: 'resolved' } : {}),
      }
    },
    async policy({ resource, input }) {
      const w = resource.refs.work_item
      if (!['open', 'acknowledged'].includes(w.state)) return { decision: 'deny', code: 'TASK_CLOSED', evidence: { state: w.state } }
      if (input.note == null && input.priority == null && input.due_at == null && input.resolve !== true) return { decision: 'deny', code: 'NOTHING_TO_UPDATE', evidence: {} }
      return { decision: 'allow', evidence: { state: w.state } }
    },
  },

  draft_seller_reply: {
    async resolve(input, { reads }) {
      const t = await mustThread(reads, input.thread_id)
      return { type: 'thread', id: t.id, refs: { thread_key: t.thread_key, thread_id: t.id, property_id: t.property_id || null, market: t.market || null } }
    },
    async params(input, resource, { reads }) {
      const latest = await reads.latestInbound(resource.refs.thread_key)
      if (!latest?.id) throw gwErr('refused', 'NO_INBOUND', 'the thread has no inbound message to answer')
      return { thread_id: resource.id, inbound_message_id: String(latest.id) }
    },
    async policy({ resource, reads, services }) {
      const h = await holdOrRefuse(services, { threadKey: resource.refs.thread_key, threadId: resource.id, propertyId: resource.refs.property_id || null }, 'ai_reply_decision')
      if (h) return h
      let perm
      try { perm = await reads.permission({ id: resource.id, thread_key: resource.refs.thread_key }) } catch { return { decision: 'deny', code: 'PERMISSION_STATE_UNREADABLE', evidence: {} } }
      if (perm.blocked) return { decision: 'deny', code: perm.reasons.includes('stop_requested') ? 'STOP_REQUESTED' : 'CONTACT_NOT_PERMITTED', evidence: { reasons: perm.reasons } }
      return { decision: 'allow', evidence: { permission: 'clear', hold: 'clear' } }
    },
    /** decideAndCompose in shadow via the review-draft service; the permission state is re-read AFTER the draft. */
    async execute({ intent, reads, services }) {
      const p = intent.params
      const thread = await reads.thread(p.thread_id)
      if (!thread?.thread_key) return { status: 'failed', code: 'THREAD_NOT_FOUND', result: {} }
      const before = await reads.latestInbound(thread.thread_key)
      if (String(before?.id || '') !== String(p.inbound_message_id)) return { status: 'refused', code: 'NEWER_INBOUND_BEFORE_DRAFT', result: { stage: 'pre_draft' } }
      const r = await services.draft({ inboundMessageId: p.inbound_message_id })
      // STOP / a newer inbound / suppression that arrived WHILE the draft was prepared: the draft is discarded
      let perm
      try { perm = await reads.permission({ id: thread.id, thread_key: thread.thread_key }) } catch { return { status: 'refused', code: 'PERMISSION_STATE_UNREADABLE', result: { stage: 'post_draft' } } }
      if (perm.reasons.includes('stop_requested')) return { status: 'refused', code: 'STOP_RECEIVED_DURING_DRAFT', result: { stage: 'post_draft', discarded: true } }
      if (perm.blocked) return { status: 'refused', code: 'CONTACT_NOT_PERMITTED_DURING_DRAFT', result: { stage: 'post_draft', discarded: true, reasons: perm.reasons } }
      if (String(perm.latest_inbound_id || '') !== String(p.inbound_message_id)) return { status: 'refused', code: 'NEWER_INBOUND_DURING_DRAFT', result: { stage: 'post_draft', discarded: true } }
      const h = await holdOrRefuse(services, { threadKey: thread.thread_key, threadId: thread.id, propertyId: thread.property_id || null }, 'ai_reply_decision')
      if (h) return { status: 'refused', code: `${h.code}_DURING_DRAFT`, result: { stage: 'post_draft', discarded: true } }
      if (!r?.ok) return { status: 'refused', code: String(r?.code || 'DRAFT_REFUSED').toUpperCase().slice(0, 80), result: { stage: 'draft_service' } }
      const d = r.draft || {}
      const text = d.reply?.text || null
      return {
        status: 'succeeded',
        code: text ? 'DRAFT_COMPOSED' : 'DRAFT_NO_TEXT',
        // stored: hashes and codes only (agent.payload_is_clean refuses message text in the gateway tables)
        result: { send_status: 'never_sent_draft', terminal: d.terminal?.type || null, category: d.reply?.category || null, objective: d.reply?.objective || null,
          send_ready: d.reply?.send_ready ?? null, draft_hash: text ? sha(text) : null, draft_length: text ? text.length : 0, model_used: Boolean(r.model_used), stage: d.stage || null },
        // returned once to the caller, never stored, never queued
        response: { draft: { text, plan_reasons: d.plan_reasons || [], validation: d.validation || null, next_missing: d.next_missing || null, terminal: d.terminal || null, send_status: 'never_sent_draft' } },
      }
    },
  },

  set_thread_hold: {
    async resolve(input, { reads }) {
      const t = await mustThread(reads, input.thread_id)
      return { type: 'thread', id: t.id, refs: { thread_key: t.thread_key, thread_id: t.id, market: t.market || null } }
    },
    params(input, resource) {
      return { thread_id: resource.id, reason_code: input.reason_code, ...(input.note ? { note: cleanText(input.note, 300) } : {}) }
    },
    // holds are SET only and reversible by humans: the policy is "the thread exists in this tenant"
    async policy() { return { decision: 'allow', evidence: { reversible_by: 'operator', release: 'hold registry only' } } },
  },

  run_authorized_reconciliation: {
    async resolve(input) { return { type: 'system', id: `reconcile:${input.kind}`, refs: {} } },
    params(input) { return { kind: input.kind, mode: 'report_only', limit: input.limit ?? 200, ...(input.after_id ? { after_id: input.after_id } : {}) } },
    async policy() { return { decision: 'allow', evidence: { mode: 'report_only', writes: 0 } } },
    async execute({ intent, services, now }) {
      const p = intent.params
      if (p.kind !== 'pipeline') return { status: 'refused', code: 'RECONCILIATION_KIND_NOT_IMPLEMENTED', result: {} }
      const report = await services.pipelineReport({ after: p.after_id || null, limit: p.limit, now: now() })
      return { status: 'succeeded', code: 'REPORT_READY', result: { mode: 'report_only', scanned: report.scanned, mismatched: report.mismatched, by_issue: report.by_issue, writes: report.writes }, response: { report } }
    },
  },
})
