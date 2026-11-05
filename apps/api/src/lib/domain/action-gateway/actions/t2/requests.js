// The T2 REQUEST actions: an agent asks, a HUMAN decides, LeadCommand executes the EXISTING service.
//
// update_lead_stage, update_lead_disposition, request_thread_hold_release, request_campaign_resume and
// adjust_campaign_plan never change anything themselves. Their execution files ONE agent.approval_request of
// a FIXED capability (public.action_gateway_dw_human_request verifies every authority field against the
// intent); a named operator decides it through the existing path (POST /api/cockpit/agent/actions/approvals/
// :id/decide → capabilities/approvals.js#decide: drift re-check, single claim) and the capability's
// executeApproved runs the existing service AS that operator:
//   pipeline.propose_stage_change              opportunity-service#transitionOpportunityStage (REUSED as is)
//   inbox.prepare_disposition_change           lead-state/patch-universal-lead-state#patchUniversalLeadState
//   holds.prepare_release_approval             holds/automation-hold-release#releaseAutomationHoldByOperator
//   campaigns.prepare_resume_approval          campaigns/campaign-automation-service#applyCampaignLifecycleAction('resume')
//   campaigns.prepare_plan_adjustment_approval campaigns/campaign-automation-service#updateCampaign (bounded patch)
//
// This module is shared by BOTH sides so the drift snapshot is computed identically: the gateway (as
// lc_action_gateway, read-only) when it files the request, and the capability plane (service client) when the
// human decides. The loaders read raw rows through any Supabase-shaped client; nothing here writes.
import { hashCanonical } from '../../../../agent/runtime/canonical.js'
import { approvalPayloadHash, snapshotHash } from '../../../../agent/capabilities/approvals.js'
import { cleanText } from './shared.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const low = (v) => String(v ?? '').trim().toLowerCase()
const isoOrNull = (v) => (v ? String(v).slice(0, 40) : null)
const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export const REQUEST_CAPABILITIES = Object.freeze({
  update_lead_stage: Object.freeze({ capability_id: 'pipeline.propose_stage_change', ttl_seconds: 3600 }),
  update_lead_disposition: Object.freeze({ capability_id: 'inbox.prepare_disposition_change', ttl_seconds: 7200 }),
  update_lead_temperature: Object.freeze({ capability_id: 'inbox.prepare_temperature_change', ttl_seconds: 7200 }),
  request_thread_hold_release: Object.freeze({ capability_id: 'holds.prepare_release_approval', ttl_seconds: 43200 }),
  request_campaign_resume: Object.freeze({ capability_id: 'campaigns.prepare_resume_approval', ttl_seconds: 3600 }),
  adjust_campaign_plan: Object.freeze({ capability_id: 'campaigns.prepare_plan_adjustment_approval', ttl_seconds: 3600 }),
})
export const PLAN_FIELDS = Object.freeze(['daily_cap', 'total_cap', 'market_cap', 'per_sender_cap', 'batch_max', 'send_interval_seconds', 'contact_window_start', 'contact_window_end'])

async function one(q, what) {
  const r = await q
  if (r?.error) throw Object.assign(new Error(`${what} read failed`), { code: 'READ_FAILED', what })
  const d = Array.isArray(r?.data) ? r.data[0] : r?.data
  return d || null
}

// ── loaders (raw rows; any Supabase-shaped client) ──────────────────────────
export const loadOpportunityRow = (db, id) => (UUID_RE.test(String(id)) ? one(db.from('acquisition_opportunities').select('*').eq('id', String(id)).limit(1), 'opportunity') : null)
export const loadThreadRow = (db, id) => (UUID_RE.test(String(id)) ? one(db.from('inbox_thread_state').select('*').eq('id', String(id)).limit(1), 'thread') : null)
export const loadHoldRow = (db, id) => (UUID_RE.test(String(id))
  ? one(db.from('automation_holds').select('id,hold_key,hold_type,thread_key,inbox_thread_id,property_id,opportunity_id,master_owner_id,blocked_capabilities,released_at').eq('id', String(id)).limit(1), 'hold')
  : null)
/** The latest messages of a thread (newest first, ≤ 20): the ownership-answer rules read them. */
export async function loadThreadMessages(db, threadKey) {
  const r = await db.from('message_events').select('*').eq('thread_key', String(threadKey)).order('created_at', { ascending: false }).limit(20)
  if (r?.error) throw Object.assign(new Error('messages read failed'), { code: 'READ_FAILED' })
  return r.data || []
}
export const loadCampaignRow = (db, id) => (UUID_RE.test(String(id)) ? one(db.from('campaigns').select('*').eq('id', String(id)).limit(1), 'campaign') : null)

// ── snapshots (what a human approves; any change before the decision is drift → refused) ──
/** Mirror of defs/pipeline.js stageSnapshot over a NORMALIZED opportunity row (getOpportunityById's shape). */
export function stageSnapshotOf(row) {
  return { opportunity_id: row?.id || null, stage: low(row?.acquisition_stage) || null, status: low(row?.opportunity_status) || null, stage_entered_at: isoOrNull(row?.stage_entered_at) }
}
/** A raw opportunity row normalized exactly as opportunity-service#normalizeOpportunityRow does for the snapshot fields. */
export async function normalizedStageRow(raw) {
  if (!raw?.id) return null
  const { normalizeAcquisitionStageCode, normalizeOpportunityStatus } = await import('../../../opportunity/universal-pipeline-registry.js')
  return { ...raw, acquisition_stage: normalizeAcquisitionStageCode(raw.acquisition_stage), opportunity_status: normalizeOpportunityStatus(raw.opportunity_status) }
}
/** The temperature drift snapshot (gateway and decide path alike): the label, its source and the operator lock. */
export function temperatureSnapshot(row) {
  return { thread_id: row?.id || null, temperature: low(row?.lead_temperature || row?.temperature) || null, temperature_source: low(row?.temperature_source) || null, manual_temperature_lock: row?.manual_temperature_lock === true }
}
export function dispositionSnapshot(row) {
  return { thread_id: row?.id || null, disposition: low(row?.disposition) || null, is_suppressed: row?.is_suppressed === true, contactability_status: low(row?.contactability_status) || null }
}
export function holdSnapshot(row, holdId = null) {
  return { hold_id: row?.id || holdId || null, active: Boolean(row?.id) && !row?.released_at, hold_type: row?.hold_type || null }
}
export function campaignSnapshot(row, campaignId = null) {
  if (!row?.id) return { campaign_id: campaignId, missing: true }
  return { campaign_id: row.id, status: low(row.status) || null, ...Object.fromEntries(PLAN_FIELDS.map((k) => [k, k.startsWith('contact_window') ? (row[k] == null ? null : String(row[k]).slice(0, 5)) : n(row[k])])) }
}

/**
 * The approval request the gateway files (the database fills id, requester, provenance, tier and expiry).
 * Same hashing rules as capabilities/approvals.js#request: payload hash over capability / org / target /
 * change / snapshot; the idempotency key covers the capability's own idempotency AND the snapshot, so two
 * agents asking for the same change against the same state share ONE approval.
 */
export function buildHumanRequest({ action, org_id, target, intended_change, snapshot, summary = [], idempotency }) {
  const cap = REQUEST_CAPABILITIES[action]
  if (!cap) throw Object.assign(new Error(`no request capability for ${action}`), { code: 'REQUEST_ACTION_UNKNOWN' })
  const snapshot_hash = snapshotHash(snapshot)
  return {
    capability_id: cap.capability_id,
    capability_version: 1,
    target,
    intended_change,
    snapshot_hash,
    payload_hash: approvalPayloadHash({ capability_id: cap.capability_id, capability_version: 1, org_id, target, intended_change, snapshot_hash }),
    idempotency_key: hashCanonical({ k: idempotency, s: snapshot_hash }),
    summary: summary.slice(0, 12).map((s) => cleanText(s, 240)).filter(Boolean),
    ttl_seconds: cap.ttl_seconds,
  }
}

/** Run the request through the lease-bound writer; the gateway then answers with the RECORDED outcome. */
export async function fileHumanRequest({ intent, services, lease_token, request }) {
  const out = await services.t2.humanRequest(intent.intent_id, lease_token, request)
  return { recorded: true, outcome: out, response: out?.status === 'succeeded' ? { approval: { approval_id: out?.result?.approval_id || null, capability_id: request.capability_id, decided_by: 'a named operator', status: 'pending_human_decision' } } : null }
}
