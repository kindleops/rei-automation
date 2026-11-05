// Shared scenario pieces for the T3 / T4 PG tests (over t34Db): agents + grants, seeded threads, the human decide
// path, the LeadCommand worker (runtime tick with the action.* handlers), the simulated provider + the REAL runner.
import crypto from 'node:crypto'
import { registerAgent, seedThread, makeGateway, humanApprovals, sel, setControls, ORG, OWNER, OPERATOR, SELLER, OURS } from './action-gateway-pg.mjs'
import { pgSupabase } from './pg-supabase.mjs'
import { createRuntimePgStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createGatewayExecution, buildActionGatewayHandlers, ACTION_GATEWAY_EXECUTE_KIND } from '../../src/lib/ai/action-gateway-execution.js'
import { createSpendTracker } from '../../src/lib/domain/conversation-ai/model-client.js'
import { insertSupabaseSendQueueRow } from '../../src/lib/supabase/sms-engine.js'
import { makeDecision } from '../../src/lib/domain/conversation-ai/contract.js'
import { fakeProvider } from './conversation-ai-runtime-fakes.mjs'
import { pgReservations } from './conversation-e2e-pg.mjs'
import { claimRow, dispatchRow } from './followup-lifecycle-pg.mjs'
import { lookupAiGeneratedMessageByQueueKey, recordAiRowProviderOutcome } from '../../src/lib/domain/messages/ai-generated-message.js'
import { loadNewerInboundsForRow } from '../../src/lib/domain/queue/ai-conversation-row-gate.js'

export { sel, setControls, ORG, OWNER, OPERATOR, SELLER, OURS, crypto }
export const REPLY_TEXT = 'Good to know. Would you consider an offer on it?'

/** The production AI send capability, ACTIVATED (disposable DB only) for the seller's thread. */
export const replySwitches = (threads = [SELLER]) => ({ ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: threads } }) })

export async function seedT34(env, { tiers = 'T1,T2,T3,T4' } = {}) {
  await env.owner.query(`insert into agent.org (org_id, name) values ($1, 'gateway test org') on conflict do nothing`, [ORG])
  await env.owner.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'test'), ($1, $3, 'operator', 'test') on conflict do nothing`, [ORG, OWNER, OPERATOR])
  await setControls(env.owner, { action_gateway_enabled: 'true', action_gateway_tiers: tiers })
  await env.owner.query(`update public.conversation_ai_reply_policy set shadow_enabled = true, kill_switch_engaged = false where id = 1`)
  await env.owner.query(`insert into public.prospects (prospect_id, first_name, full_name) values ('pr1', 'Dana', 'Dana Q') on conflict do nothing`)
}

export const ALL_T34 = [['conversation.queue_reply', 3], ['offers.prepare', 4], ['offers.submit_for_approval', 4], ['offers.execute_authorized', 4], ['offers.record_counter', 2]]
export async function agent(env, { agent_id = 'agt_alpha', grants = ALL_T34, tier_ceiling = 4 } = {}) {
  return registerAgent(env.owner, { agent_id, grants, tier_ceiling })
}

/** A seller thread whose latest message is the seller's (unanswered). */
export async function replyThread(env, o = {}) {
  return seedThread(env.owner, { inboundBody: 'Yes I still own it', ...o })
}

/** Call → (approval) → a human approves through the EXISTING decide path → the retry authorizes + hands off. */
export async function approveAndRetry(env, gateway, cred, tool, args) {
  const first = await gateway.call({ credential: cred, tool, args })
  if (first.status !== 'approval_pending') return { first, final: first }
  const human = humanApprovals(env)
  const d = await human.decide(first.approval.approval_id)
  const final = await gateway.call({ credential: cred, tool, args })
  return { first, decided: d, final }
}

export const provider = () => fakeProvider((p) => (p.tools[0].input_schema?.properties?.message ? { message: REPLY_TEXT }
  : makeDecision({ intent: 'ownership_confirmed', seller_interest: 'unknown', outcome: 'REPLY_CANDIDATE', next_objective: 'gauge_interest', response_needed: true, proposed_message: 'R1 TEXT NEVER SENT', confidence: 0.93, source_message_ids: [], facts_extracted: [], stage_evidence: { stage: 'S2_interest', evidence_message_ids: [], rationale: 'x' } })))

/** LeadCommand's worker: the action.* handlers over the backend client (owner pool), R3 with PG reservations. */
// legacyComposer: the retired composer paths (queue_authorized_reply's writer) run for the links #28 / #31 record tests;
// the agent-text world passes false (production's default)
export function worker(env, { beforeQueueInsert = null, offerSendDeps = {}, prov = provider(), now = undefined, budgetMs = 30_000, capUsd = 0.05, legacyComposer = true } = {}) {
  const sb = pgSupabase(env.owner)
  const readSwitch = async (k) => (await sel(env.owner, 'select value from public.system_control where key = $1', [k]))[0]?.value ?? null
  const r3deps = {
    readSwitch, reservations: pgReservations(env.owner),
    insertQueueRow: (payload) => insertSupabaseSendQueueRow(payload, {
      supabase: sb, // the enqueue hold chokepoint reads the REAL registry
      insertSupabaseSendQueueRow: async (row) => {
        if (beforeQueueInsert) await beforeQueueInsert(row)
        const r = await sb.from('send_queue').insert(row).select('id,queue_status,paused_reason,queue_key').single()
        if (r.error) { if (process.env.T34_DEBUG) console.error('INSERTERR', r.error.message); return { ok: false, reason: r.error.message } }
        return { ok: true, queue_row_id: r.data.id, raw: r.data }
      },
    }),
  }
  const execution = createGatewayExecution({ supabase: sb, env: { AI_CONVERSATION_SHADOW_ENABLED: 'true', NEGOTIATION_COMPOSER_ENABLED: '1' }, provider: prov, trackerFor: () => createSpendTracker({ capUsd }), r3deps, readSwitch, offerSendDeps, legacyComposerForTests: legacyComposer, ...(now ? { now } : {}) })
  const store = createRuntimePgStore({ pool: env.db.api })
  const handlers = buildActionGatewayHandlers({ execution })
  const arm = async () => env.owner.query(`update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, max_concurrency_global = 2, tick_max_jobs = 4, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify({ [ACTION_GATEWAY_EXECUTE_KIND]: { enabled: true, max_concurrency: 2, armed_by: OPERATOR } })])
  const tick = async (workerId = 'lc-worker') => { await arm(); return runRuntimeTick({ store, handlers, workerId, budgetMs }) }
  return { execution, tick, sb, readSwitch }
}

export const receipt = async (env, intentId) => (await sel(env.owner, 'select * from action_gateway.seller_action_receipts where intent_id = $1', [intentId]))[0]
export const aiRows = (env) => sel(env.owner, `select * from public.send_queue where message_origin = 'ai_generated' order by created_at`)
export const workItems = (env) => sel(env.owner, `select * from agent.ops_work_item where scope = 'agent' and kind = 'escalation' order by created_at`)

/** The dispatcher's live posture (disposable DB only): processor live, normal execution, a healthy thread sender. */
export async function liveDispatch(env, { health = 'healthy', status = 'active' } = {}) {
  await setControls(env.owner, { queue_processor_mode: 'live', queue_execution_mode: 'normal' })
  await env.owner.query(`delete from public.textgrid_numbers where phone_number = $1`, [OURS])
  await env.owner.query(`insert into public.textgrid_numbers (phone_number, status, market, health_state) values ($1, $2, 'Chicago', $3)`, [OURS, status, health])
}

/** The REAL queue runner item path on one queued row (claim CAS + processSendQueueItem), a SIMULATED provider. */
/** `now` (ISO): the dispatch clock; omitted ⇒ the helpers' lawful test clock (a live world passes the real one). */
export async function dispatchQueued(env, w, rowId, provider, { now } = {}) {
  let claimed
  try { claimed = await claimRow(env.owner, rowId) } catch (e) { return { claimed: false, refused_by: String(e?.message || '').split(':')[0] } } // the hold registry trigger refuses the claim
  if (!claimed) return { claimed: false }
  const out = await dispatchRow({ pool: env.owner, sb: w.sb }, claimed, { provider, ...(now ? { now } : {}), extraDeps: {
    readAiConversationSwitch: w.readSwitch,
    loadAiGeneratedMessage: (k) => lookupAiGeneratedMessageByQueueKey(w.sb, k),
    loadNewerInbounds: (r) => loadNewerInboundsForRow(w.sb, r),
    recordAiRowProviderOutcome: (sb, r, o) => recordAiRowProviderOutcome(w.sb, r, o),
    // the post-send LEGACY cash-offer snapshot sync (non-blocking bookkeeping over the process-default client; the
    // offer authority of record is public.seller_offers, persisted BEFORE the send): stood in, never a network call
    syncOfferRecord: async () => ({ ok: true, skipped: true, reason: 'legacy_snapshot_sync_stood_in' }),
  } })
  return { claimed: true, out }
}

// ── T4 (offers) ──────────────────────────────────────────────────────────────
import { score } from './property-research-fixtures.mjs'
import { createPgCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { createThreadRefCodec } from '../../src/lib/agent/capabilities/thread-ref.js'
import { createSendAuthorizationApprovals, createSupabaseSendAuthorizationStore, grantSendAuthorization } from '../../src/lib/domain/negotiation/send-authorization.js'
import { createSupabaseNegotiationStore } from '../../src/lib/domain/negotiation/store.js'
import { encodePropertyRef } from '../../src/lib/domain/negotiation/envelope-approval.js'
import { createCapabilityPlane } from '../../src/lib/agent/capabilities/index.js'

export const OFFER_TEMPLATE = 'Thanks for the details. We could buy it as-is for {{offer_price}} with no repairs on your end. Would that work for you?'
export const REF_SECRET = 'test-capability-secret-0123456789abcdef'

/** A priced, offer-ready property on a seller thread with an opportunity and an approved offer template. */
export async function seedOfferWorld(env, { pid = '227876842', phone = SELLER, mao = 150000, offer = 140000, inboundBody = 'Yes I own it. What would you offer?' } = {}) {
  const sc = score({ mao, offer, computed: new Date(Date.now() - 2 * 864e5).toISOString() })
  await env.owner.query(`insert into public.properties (property_id, property_type, units_count, property_address_city, property_address_state, property_address_zip, property_address, market)
                         values ($1, 'SFR', 1, 'Chicago', 'IL', '60601', '12 Oak St', 'Chicago') on conflict (property_id) do nothing`, [pid])
  await env.owner.query(`insert into public.property_acquisition_scores (property_id, computed_at, decision_tier, valuation_mid, valuation_low, valuation_high, valuation_confidence, comp_count, investor_ceiling_mid,
                           recommended_cash_offer, minimum_acceptable_offer, estimated_repairs, buyer_demand_score, liquidity_score, evidence)
                         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
  [pid, sc.computed_at, sc.decision_tier, sc.valuation_mid, sc.valuation_low, sc.valuation_high, sc.valuation_confidence, sc.comp_count, sc.investor_ceiling_mid, sc.recommended_cash_offer, sc.minimum_acceptable_offer, sc.estimated_repairs, sc.buyer_demand_score, sc.liquidity_score, JSON.stringify(sc.evidence)])
  const t = await seedThread(env.owner, { phone, property: pid, inboundBody })
  await env.owner.query(`update public.inbox_thread_state set prospect_id = 'pr1' where id = $1`, [t.thread_id])
  const opp = (await env.owner.query(`insert into public.acquisition_opportunities (primary_property_id, primary_thread_key, acquisition_stage, opportunity_status, market) values ($1, $2, 'offer', 'active', 'Chicago') returning id`, [pid, phone])).rows[0].id
  await env.owner.query(`insert into public.sms_templates (template_id, use_case, language, is_active, safe_for_auto_reply, template_body) values ('t-offer-1', 'offer_reveal_cash', 'English', true, true, $1)`, [OFFER_TEMPLATE])
  return { pid, t, opp, mao, offer }
}

/** The operator side: a DISTINCT live send authorization, proposed by a named operator and decided through the D6 path. */
export async function operatorSendAuthorization(env, { thread_key, pid, ceiling = null, max_sends = 1, expires_in_hours = 24 }) {
  const sb = pgSupabase(env.owner)
  const store = createPgCapabilityStore({ pool: env.db.api })
  const refs = createThreadRefCodec({ secret: REF_SECRET })
  const neg = createSupabaseNegotiationStore({ supabase: sb })
  const sends = createSupabaseSendAuthorizationStore({ supabase: sb })
  const negotiation = { openThread: (ref, org) => refs.open(ref, org), latestEnvelope: (k) => neg.latestEnvelope(k), grantSendAuthorization: (a) => grantSendAuthorization(a, { store: sends }) }
  const proposals = createSendAuthorizationApprovals({ store, services: { negotiation } })
  const latest = await neg.latestEnvelope((await import('../../src/lib/domain/negotiation/envelope.js')).scopeKey(thread_key, pid))
  const identity = { verified: true, named: true, user_id: OPERATOR, method: 'test' }
  const p = await proposals.propose({ org_id: ORG, identity, input: { thread_ref: refs.seal(thread_key, ORG), property_ref: encodePropertyRef(pid), envelope_version: Number(latest.envelope.version), expires_in_hours, max_sends, ...(ceiling ? { ceiling } : {}) } })
  if (!p.ok) throw new Error(`send authorization proposal refused: ${JSON.stringify(p)}`)
  // D6: the ONE decide path of the capability plane (its decision registry carries the decide-only specs)
  const plane = createCapabilityPlane({ env: {}, store, services: { negotiationFor: () => negotiation }, secret: REF_SECRET })
  const approval = p.approval || p
  const a = await store.getApproval(ORG, approval.approval_id)
  const d = await plane.approvals.decide({ org_id: ORG, identity: { verified: true, named: true, user_id: OWNER, method: 'test' }, approval_id: a.approval_id, decision: 'approve', payload_hash: a.payload_hash })
  if (!d.ok) throw new Error(`send authorization decide refused: ${JSON.stringify(d)}`)
  return (await sends.latestFor(latest.envelope.scope_key)).authorization
}

export const offerRows = (env) => sel(env.owner, `select * from public.send_queue where queue_key like 'negotiation_offer:%' order by created_at`)
export const sellerOffers = (env) => sel(env.owner, `select * from public.seller_offers order by created_at`)
