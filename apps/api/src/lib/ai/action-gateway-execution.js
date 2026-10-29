// LEADCOMMAND EXECUTES: the worker half of the Action Gateway's handed-off actions (docs/ACTION-MCP.md §9).
// The gateway (lc_action_gateway; it writes no business table) authorizes an intent and hands it off: ONE runtime
// job per intent of the ONE executor kind `action_gateway.execute` (agent.runtime_enqueue, accountable to the agent's
// human sponsor). The handler loads the intent, dispatches by its ACTION to the executor registered for it, runs the
// CANONICAL service with LeadCommand's own backend client and records a receipt (public.lc_seller_action_receipt_record:
// a hold / failure / unknown outcome raises ONE operator work item):
//
//   queue_authorized_reply      createCanonicalTurnDecider (decideAndCompose + the shadow record + aiSendAuthorizedFor)
//                               → the ONE R3 dispatcher module (conversation-turn-dispatch.js) → insertSupabaseSendQueueRow
//                               → the queue runner. A STOP / newer inbound arriving while the reply is prepared refuses it.
//   execute_authorized_offer    negotiation/negotiation-send#sendAuthorizedOffer (composer, R4 persistence, ledger,
//                               canonical queue writer) — only with system_control negotiation_send_enabled AND
//                               NEGOTIATION_COMPOSER_ENABLED=1 in this process.
//   record_seller_counteroffer  negotiation/negotiation-send#recordAgentCounter (recordSellerCounter; never accepts).
//   queue_agent_message         (link #32) an AGENT-INITIATED message: every guard re-run on fresh reads (activation, lead
//                               owner, the AI-reply gate, holds, the send-time guard, pre-send eligibility, window), the
//                               day caps reserved, then canonical/composeAgentOutbound writes and validates the text →
//                               ONE immutable agent_outbound ledger record → ONE ai_generated queue row → the runner (AI
//                               row gate + agent-message row gate). The composer unavailable / refusing + a named
//                               governed template ⇒ that template through the canonical queue writer; otherwise refused.
//   input { sweep: 'receipts' } follows enqueued rows to their dispatch outcome: sent / failed / held, and an ambiguous
//                               provider accept ⇒ outcome_unknown + a critical operator item (NEVER a resend).
// The T2 executor (link #27's `action_gateway.execute` actions) registers its actions in the SAME dispatch table
// (ACTION_EXECUTORS) — one kind, one pattern, never a second executor kind.
//
// BORN OFF: actionGatewayExecutionHandlers() → {} unless LC_ACTION_GATEWAY_EXECUTION=1 (and the runtime gate); the
// database claims the kind only when an operator arms + enables it in agent.runtime_limits.kind_limits.
import { runtimeGate } from '@/lib/agent/runtime/runtime-service.js'
import { getSystemValueFresh } from '@/lib/system-control.js'
import { isStopRequest } from '@/lib/domain/conversation-ai/stop-request.js'

export const ACTION_EXECUTION_VERSION = 'lc.action-gateway-execution.v1'
export const ACTION_GATEWAY_EXECUTE_KIND = 'action_gateway.execute'
/** The actions this module executes under the one kind (T2 adds its own to the same table). */
export const ACTION_EXECUTORS = Object.freeze({ queue_authorized_reply: 'sellerReply', execute_authorized_offer: 'offerSend', record_seller_counteroffer: 'recordCounter',
  // Operation Hidden Gold (link #29): certified reversible pipeline writes under a STANDING grant, executed through the canonical lead-state registry
  set_lead_temperature: 'leadState', update_lead_status: 'leadState',
  // link #32: the agent-initiated message (AI-composed; governed template fallback)
  queue_agent_message: 'agentMessage' })
/** OHG actions a standing grant authorizes alone (mirrors action_gateway.standing_t2_actions() after link #29). */
export const OHG_STANDING_ACTIONS = Object.freeze(['set_lead_temperature', 'update_lead_status'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const clean = (v) => String(v ?? '').trim()
const code = (v, n = 80) => clean(v).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, n) || null
/** An error message as receipt detail: letters, digits (short runs), punctuation — never a phone-like run, never long. */
const brief = (v, n = 120) => clean(v).replace(/[^A-Za-z0-9 _.:()-]/g, ' ').replace(/[0-9]{5,}/g, '#').replace(/\s+/g, ' ').slice(0, n) || 'error'
const decodeRef = (r) => (/^pid_[g-p]{1,30}$/.test(String(r)) ? String(r).slice(4).split('').map((c) => 'ghijklmnop'.indexOf(c)).join('') : String(r ?? ''))

async function rpc(supabase, fn, args) {
  const r = await supabase.rpc(fn, args)
  if (r?.error) throw Object.assign(new Error(`${fn} failed`), { code: 'RECEIPT_STORE_UNAVAILABLE', detail: String(r.error.message || '').slice(0, 200) })
  return r?.data ?? null
}
async function rows(q) { const r = await q; if (r?.error) throw Object.assign(new Error('READ_FAILED'), { code: 'READ_FAILED' }); return Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : [] }

/**
 * @param {{ supabase: object, env?: object, provider?: object, trackerFor?: Function, r3deps?: object, readSwitch?: Function,
 *           now?: () => number, offerSendDeps?: object }} o
 */
export function createGatewayExecution({ supabase, env = process.env, provider = null, trackerFor = null, r3deps = {}, readSwitch = null, now = () => Date.now(), offerSendDeps = {}, agentMessageDeps = {} } = {}) {
  const read = readSwitch || ((k) => getSystemValueFresh(k, { supabase }))
  const record = (intent_id, job_id, state, c, detail = {}, queue_row_id = null) =>
    rpc(supabase, 'lc_seller_action_receipt_record', { p_intent_id: intent_id, p_job_id: job_id, p_state: state, p_code: code(c), p_detail: detail, p_queue_row_id: queue_row_id ? String(queue_row_id) : null })

  /** The handed-off intent, verified: handed off, this action's kind, this job, receipt not final. */
  async function prologue(action, job, { requireThread = true } = {}) {
    const id = clean(job?.input?.action_intent_id)
    if (!UUID_RE.test(id)) return { stop: { code: 'ACTION_INPUT_INVALID' } }
    const l = await rpc(supabase, 'lc_seller_action_load', { p_intent_id: id })
    const i = l?.intent
    if (!i || i.state !== 'succeeded' || i.result_code !== 'HANDOFF_QUEUED' || i.action !== action) return { stop: { code: 'INTENT_NOT_HANDED_OFF' } }
    const r = l.receipt
    if (!r || r.job_id !== job.job_id) return { stop: { code: 'RECEIPT_JOB_MISMATCH' } }
    if (!['requested', 'executing'].includes(r.state)) return { stop: { code: 'RECEIPT_FINAL', state: r.state } }
    // per-use authority: a human approval or a verified envelope — or, for an OHG standing T2 action, the standing
    // grant the gateway's domain write already admitted (recorded on the authorization; re-read here, never asserted)
    // (lc_seller_action_load exposes the authorization row, not the grant id: the database's domain write already
    // refused the handoff unless a standing grant or an approval backed the authorization, so its presence is the proof)
    // Agntei 5.4: the certified seller reply on an owner-minted standing seller-facing grant — the database derived
    // `standing` when authorizing and re-verifies the grant now (`standing_live`); a revoked grant stops it here
    const standing = (OHG_STANDING_ACTIONS.includes(action) && Number(l.authorization?.tier) === 2 && Boolean(l.authorization?.authorization_id))
      || (['queue_authorized_reply', 'queue_agent_message'].includes(action) && Number(l.authorization?.tier) === 3 && l.authorization?.standing === true && l.authorization?.standing_live === true)
    if (!(l.authorization?.approval_id || l.authorization?.envelope_ref || standing)) {
      await record(id, job.job_id, 'refused', 'NO_PER_USE_AUTHORITY')
      return { stop: { code: 'NO_PER_USE_AUTHORITY' } }
    }
    await record(id, job.job_id, 'executing', 'EXECUTING')
    // link #32: an agent message may address a lead with no thread (a first touch); its lead is resolved by its executor
    if (!requireThread) return { intent: i, auth: l.authorization, thread: null, id, job_id: job.job_id }
    const [t] = await rows(supabase.from('inbox_thread_state').select('id,thread_key,property_id').eq('id', clean(i.params?.thread_id)).limit(1))
    if (!t?.thread_key) { await record(id, job.job_id, 'failed', 'THREAD_NOT_FOUND'); return { stop: { code: 'THREAD_NOT_FOUND' } } }
    return { intent: i, auth: l.authorization, thread: t, id, job_id: job.job_id }
  }

  async function latestInbound(thread_key) {
    const [m] = await rows(supabase.from('message_events').select('id,message_body,direction,created_at').eq('thread_key', thread_key).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1))
    return m || null
  }
  async function suppressed(thread_key) {
    const s = await rows(supabase.from('sms_suppression_list').select('is_active').eq('phone_e164', thread_key).limit(5))
    return s.some((x) => x.is_active !== false)
  }

  /**
   * The inbound_reply reservation (THE one-reply-per-inbound scope, shared with the template engine and the turn
   * engine) held under THIS intent's token, so a crashed attempt's retry resumes R3 (the D2 resume path) instead of
   * finding its own reservation taken. 'mine' | 'answered' | 'taken'.
   */
  async function holdInbound(inboundId, token) {
    const ins = await supabase.from('idempotency_ledger').insert({ scope: 'inbound_reply', key: inboundId, claim_token: token, status: 'processing', summary: 'action_gateway_seller_reply', metadata: { engine: 'action_gateway', action_intent_id: token } })
    if (ins?.error && String(ins.error.code) !== '23505' && !/duplicate key/i.test(String(ins.error.message || ''))) throw Object.assign(new Error('RESERVATION_UNAVAILABLE'), { code: 'RESERVATION_UNAVAILABLE' })
    const [r] = await rows(supabase.from('idempotency_ledger').select('status,claim_token').eq('scope', 'inbound_reply').eq('key', inboundId).limit(1))
    if (r?.claim_token && clean(r.claim_token) === clean(token)) return r.status === 'processing' ? 'mine' : 'answered'
    return r?.status === 'completed' ? 'answered' : 'taken'
  }
  async function releaseInbound(inboundId, token, outcome) {
    await supabase.from('idempotency_ledger').update({ status: 'completed', completed_at: new Date(now()).toISOString(), metadata: { engine: 'action_gateway', action_intent_id: token, outcome } }).eq('scope', 'inbound_reply').eq('key', inboundId).eq('claim_token', token)
  }

  async function sellerReply(job, ctx = {}) {
    const p = await prologue('queue_authorized_reply', job)
    if (p.stop) return p.stop
    const { intent, thread, id, job_id } = p
    const inboundId = clean(intent.params.inbound_message_id)
    const before = await latestInbound(thread.thread_key)
    if (clean(before?.id) !== inboundId) {
      const c = isStopRequest(before?.message_body) ? 'STOP_RECEIVED_BEFORE_SEND' : 'NEWER_INBOUND_BEFORE_SEND'
      await record(id, job_id, 'refused', c); return { code: c }
    }
    const hold = await holdInbound(inboundId, id)
    if (hold !== 'mine') { const c = hold === 'answered' ? 'INBOUND_ALREADY_ANSWERED' : 'INBOUND_RESERVED_BY_ANOTHER_REPLY'; await record(id, job_id, 'held', c); return { code: c } }
    const { createCanonicalTurnDecider } = await import('./conversation-turn-wiring.js')
    const { createR3TurnDispatcher } = await import('./conversation-turn-dispatch.js')
    const tracker = trackerFor ? trackerFor(ctx) : (await import('@/lib/domain/conversation-ai/model-client.js')).createSpendTracker({ capUsd: 0.02 })
    const decide = createCanonicalTurnDecider({ supabase, env, tracker, provider, readSwitch: read })
    const decision = await decide({ latest_inbound_id: inboundId, persona_name: null })
    // STOP / suppression / a newer inbound that arrived WHILE the reply was prepared: refused, nothing queued
    const after = await latestInbound(thread.thread_key)
    if (clean(after?.id) !== inboundId) {
      const c = isStopRequest(after?.message_body) ? 'STOP_RECEIVED_DURING_PREPARATION' : 'NEWER_INBOUND_DURING_PREPARATION'
      // a STOP consumes the inbound's automated turn; a newer inbound frees it for the next decision
      if (isStopRequest(after?.message_body)) await releaseInbound(inboundId, id, 'stop_during_preparation')
      else await supabase.from('idempotency_ledger').update({ status: 'failed', failed_at: new Date(now()).toISOString(), last_error: 'newer_inbound' }).eq('scope', 'inbound_reply').eq('key', inboundId).eq('claim_token', id)
      await record(id, job_id, 'refused', c, { stage: 'post_compose', discarded: true }); return { code: c }
    }
    if (await suppressed(thread.thread_key)) { await releaseInbound(inboundId, id, 'suppressed'); await record(id, job_id, 'refused', 'SUPPRESSED_DURING_PREPARATION', { stage: 'post_compose', discarded: true }); return { code: 'SUPPRESSED_DURING_PREPARATION' } }
    if (!decision?.reply) { await releaseInbound(inboundId, id, 'no_authorized_reply'); await record(id, job_id, 'held', `NO_AUTHORIZED_REPLY:${code(decision?.send_authorization || decision?.code, 40)}`, { terminal: code(decision?.code, 40) }); return { code: 'NO_AUTHORIZED_REPLY' } }
    const dispatch = createR3TurnDispatcher({ supabase, jobId: job_id, deps: r3deps })
    // the reservation THIS intent holds is the "turn" R3 verifies (token = the intent id): a retry after a crash resumes
    const r3 = await dispatch({ turn_id: `gw-${id}`, version: 1, claim: { token: id, inbound_ids: [inboundId] }, decision, decisionId: `action_gateway:${id}` })
    const reasons = (r3?.reasons || []).map((x) => code(x, 60)).slice(0, 6)
    if (r3?.status === 'enqueued' || r3?.status === 'already_enqueued') {
      // an already-enqueued row is THIS intent's only when it carries this intent's decision id
      const [q] = r3.queue_row_id ? await rows(supabase.from('send_queue').select('id,metadata').eq('id', String(r3.queue_row_id)).limit(1)) : []
      if (q && clean(q.metadata?.decision_id) !== `action_gateway:${id}`) { await record(id, job_id, 'held', 'ANSWERED_BY_ANOTHER_REQUEST', { reasons }); return { code: 'ANSWERED_BY_ANOTHER_REQUEST' } }
      await record(id, job_id, 'enqueued', r3.status.toUpperCase(), { reasons }, r3.queue_row_id); return { code: 'REPLY_ENQUEUED', queue_row_id: r3.queue_row_id }
    }
    if (r3?.status === 'retry') throw Object.assign(new Error('R3_RETRY'), { code: 'R3_RETRY' })
    if (r3?.status === 'deferred') { await record(id, job_id, 'deferred', 'OUTSIDE_RECIPIENT_WINDOW', { next_permitted_at: r3.next_permitted_at || null }); return { code: 'DEFERRED' } }
    const st = r3?.status === 'refused' || r3?.status === 'stale_inbound' || r3?.status === 'suppressed' ? 'refused' : 'held'
    await record(id, job_id, st, `R3_${code(r3?.status, 30)}`.toUpperCase(), { reasons })
    return { code: `R3_${clean(r3?.status).toUpperCase()}` }
  }

  async function offerSend(job, ctx = {}) {
    void ctx
    const p = await prologue('execute_authorized_offer', job)
    if (p.stop) return p.stop
    const { intent, auth, thread, id, job_id } = p
    // the production negotiation capability, re-read at execution, in THIS process too
    if (clean(await read('negotiation_send_enabled').catch(() => null)).toLowerCase() !== 'true' || clean(env?.NEGOTIATION_COMPOSER_ENABLED) !== '1') {
      await record(id, job_id, 'held', 'NEGOTIATION_CAPABILITY_OFF_AT_EXECUTION'); return { code: 'NEGOTIATION_CAPABILITY_OFF_AT_EXECUTION' }
    }
    if (clean(auth?.envelope_ref) !== `send_authorization:${clean(intent.params.send_permit_id)}`) { await record(id, job_id, 'refused', 'ENVELOPE_REF_MISMATCH'); return { code: 'ENVELOPE_REF_MISMATCH' } }
    const inbound = await latestInbound(thread.thread_key)
    if (isStopRequest(inbound?.message_body) || (await suppressed(thread.thread_key))) { await record(id, job_id, 'refused', 'CONTACT_NOT_PERMITTED_AT_EXECUTION'); return { code: 'CONTACT_NOT_PERMITTED_AT_EXECUTION' } }
    const property_id = decodeRef(intent.params.property_ref)
    const [opp] = await rows(supabase.from('acquisition_opportunities').select('id').eq('primary_thread_key', thread.thread_key).eq('primary_property_id', property_id).limit(1))
    if (!opp?.id) { await record(id, job_id, 'held', 'NO_OPPORTUNITY'); return { code: 'NO_OPPORTUNITY' } }
    const { sendAuthorizedOffer } = await import('@/lib/domain/negotiation/negotiation-send.js')
    const r = await sendAuthorizedOffer({ intent_id: id, thread_key: thread.thread_key, property_id, opportunity_id: String(opp.id), amount: Number(intent.params.amount),
      send_authorization_id: clean(intent.params.send_permit_id), supabase, env, now: now(), ...offerSendDeps })
    await record(id, job_id, r.status, r.code, r.detail || {}, r.queue_row_id || null)
    return { code: r.code, queue_row_id: r.queue_row_id || null }
  }

  async function recordCounter(job) {
    const p = await prologue('record_seller_counteroffer', job)
    if (p.stop) return p.stop
    const { intent, thread, id, job_id } = p
    const { recordAgentCounter } = await import('@/lib/domain/negotiation/negotiation-send.js')
    const r = await recordAgentCounter({ intent_id: id, thread_key: thread.thread_key, property_id: decodeRef(intent.params.property_ref), opportunity_id: clean(intent.params.opportunity_id),
      counter_price: Number(intent.params.counter_price), inbound_message_id: clean(intent.params.inbound_message_id), supabase, now: now() })
    await record(id, job_id, r.status, r.code, r.detail || {})
    return { code: r.code }
  }

  /**
   * OHG: set_lead_temperature / update_lead_status through the ONE lead-state registry (patchUniversalLeadState) as an
   * AI change: dry run first (the registry's own rules: lock, enums, stage/opportunity guards), then the write; the
   * receipt records the field, the change and the registry's verdict. Never a stage, never contactability.
   */
  async function leadState(job) {
    const action = clean(job?.input?.action_intent_id) ? (await rpc(supabase, 'lc_seller_action_load', { p_intent_id: clean(job.input.action_intent_id) }))?.intent?.action : null
    const p = await prologue(action === 'update_lead_status' ? 'update_lead_status' : 'set_lead_temperature', job)
    if (p.stop) return p.stop
    const { intent, thread, id, job_id } = p
    const field = intent.action === 'update_lead_status' ? 'operational_status' : 'lead_temperature'
    const to = clean(intent.params?.[field])
    if (!to) { await record(id, job_id, 'failed', 'PARAMS_INVALID'); return { code: 'PARAMS_INVALID' } }
    const [row] = await rows(supabase.from('inbox_thread_state').select('id,lead_temperature,operational_status,manual_temperature_lock').eq('id', thread.id).limit(1))
    if (field === 'lead_temperature' && row?.manual_temperature_lock === true) { await record(id, job_id, 'refused', 'TEMPERATURE_LOCKED'); return { code: 'TEMPERATURE_LOCKED' } }
    const { patchUniversalLeadState } = await import('@/lib/domain/lead-state/patch-universal-lead-state.js')
    const meta = { change_source: 'ai', reason: clean(intent.params?.reason).slice(0, 240), source_view: 'action_gateway', actor: `action_gateway:${intent.agent_id}`, requested_by_agent: intent.agent_id, intent_id: id,
      ...(field === 'lead_temperature' ? { temperature_reason: `agent_standing:${clean(intent.params?.basis) || 'unstated'}`, manual_temperature_lock: false } : {}) }
    const args = { threadKey: thread.thread_key, patch: { [field]: to }, meta, supabase }
    let dry
    try { dry = await patchUniversalLeadState({ ...args, dryRun: true }) } catch (e) { if (process.env.T34_DEBUG) console.error('LEADSTATE_DRY', e); await record(id, job_id, 'failed', 'REGISTRY_DRY_RUN_FAILED', { error: brief(e?.message) }); return { code: 'REGISTRY_DRY_RUN_FAILED' } }
    if (dry && dry.ok === false) { const c = code(dry.reason || dry.code || 'REGISTRY_REFUSED', 60).toUpperCase(); await record(id, job_id, 'refused', c, { registry: dry.reason || dry.code || null }); return { code: c } }
    let res
    try { res = await patchUniversalLeadState(args) } catch (e) { if (process.env.T34_DEBUG) console.error('LEADSTATE_WRITE', e); await record(id, job_id, 'failed', 'REGISTRY_WRITE_FAILED', { error: brief(e?.message) }); return { code: 'REGISTRY_WRITE_FAILED' } }
    if (res && res.ok === false) { const c = code(res.reason || res.code || 'REGISTRY_REFUSED', 60).toUpperCase(); await record(id, job_id, 'refused', c, { registry: res.reason || res.code || null }); return { code: c } }
    const [after] = await rows(supabase.from('inbox_thread_state').select('lead_temperature,operational_status').eq('id', thread.id).limit(1))
    const applied = clean(after?.[field]).toLowerCase() === to.toLowerCase()
    await record(id, job_id, applied ? 'recorded' : 'failed', applied ? 'LEAD_STATE_RECORDED' : 'LEAD_STATE_NOT_APPLIED', { field, from: row?.[field] ?? null, to, changed: Boolean(res?.changed ?? applied) })
    return { code: applied ? 'LEAD_STATE_RECORDED' : 'LEAD_STATE_NOT_APPLIED', field, to }
  }

  /**
   * link #32: an AGENT-INITIATED message. Every guard re-run on fresh reads with LeadCommand's own client; the day caps
   * reserved (idempotent per intent); LeadCommand's canonical writer composes and validates; ONE immutable agent_outbound
   * ledger record, then ONE ai_generated queue row (queue_key agent_message:<intent>, unique: a retry never adds a
   * second). Composer unavailable / refusing + a named governed template ⇒ that template through the canonical queue
   * writer (its campaign / template gates); otherwise refused with the reason. Nothing is sent here: the runner sends.
   */
  async function agentMessage(job, ctx = {}) {
    const p = await prologue('queue_agent_message', job, { requireThread: false })
    if (p.stop) return p.stop
    const { intent, id, job_id } = p
    const at = new Date(now()).toISOString()
    const purpose = clean(intent.params?.purpose)
    const queueKey = `agent_message:${id}`
    const settle = (outcome) => rpc(supabase, 'lc_agent_message_settle', { p_intent_id: id, p_outcome: outcome }).catch(() => null)
    const refuse = async (state, c, detail = {}, { release = true } = {}) => { if (release) await settle('released'); await record(id, job_id, state, c, detail); return { code: c } }
    // a retry after the row was written: the row IS the outcome (never a second row)
    const [existing] = await rows(supabase.from('send_queue').select('id,metadata').eq('queue_key', queueKey).limit(1))
    if (existing?.id) {
      if (clean(existing.metadata?.agent_message_intent_id) !== id) return refuse('held', 'QUEUE_KEY_TAKEN_BY_ANOTHER_ROW', {}, { release: false })
      await settle('completed'); await record(id, job_id, 'enqueued', 'ALREADY_ENQUEUED', {}, existing.id); return { code: 'AGENT_MESSAGE_ENQUEUED', queue_row_id: existing.id }
    }
    // 1. the activation (both emergency stops, the AI-reply gate, this action's switch + policy), re-read NOW
    const act = await rpc(supabase, 'lc_agent_message_activation', {}).catch(() => null)
    if (!act?.available) return refuse('refused', `AGENT_MESSAGE_UNAVAILABLE:${code(act?.code || 'UNREADABLE', 40)}`)
    // 2. the lead, its owner (the sending agent must hold it), the AI send authorization for this recipient
    const lead = await rpc(supabase, 'lc_agent_message_lead', { p_intent_id: id }).catch(() => null)
    if (!lead?.phone) return refuse('failed', 'LEAD_NOT_FOUND')
    if (clean(lead.owner_agent_id) !== clean(lead.agent_id)) return refuse('refused', 'NOT_LEAD_OWNER')
    const { aiSendAuthorizedFor } = await import('./conversation-turn-wiring.js')
    const { checkAutomationHold } = await import('@/lib/domain/holds/automation-hold.js')
    const holdChecker = (a) => checkAutomationHold(a, { supabase })
    const auth = await aiSendAuthorizedFor({ threadKey: lead.phone, readSwitch: read, propertyId: lead.property_id || null, automationHoldChecker: holdChecker })
    if (!auth.ok) return refuse('refused', `AI_SEND_NOT_AUTHORIZED:${code(auth.reason, 40)}`)
    const { normalizeSendPolicy, AI_SEND_POLICY_KEY, AI_SEND_POLICY_VERSION, AI_SEND_KILL_SWITCH_KEY } = await import('@/lib/domain/conversation-ai/send-policy.js')
    const aiPolicy = normalizeSendPolicy(await read(AI_SEND_POLICY_KEY).catch(() => null))
    // 3. the lead's facts (fresh) and every guard
    const one = async (q) => (await rows(q))[0] || null
    const target = clean(intent.params?.campaign_target_id) ? await one(supabase.from('campaign_targets').select('*').eq('id', clean(intent.params.campaign_target_id)).limit(1)) : null
    const property = lead.property_id ? await one(supabase.from('properties').select('*').eq('property_id', String(lead.property_id)).limit(1)) : null
    const prospect = lead.prospect_id ? await one(supabase.from('prospects').select('*').eq('prospect_id', String(lead.prospect_id)).limit(1)) : null
    const thread = lead.thread_id ? await one(supabase.from('inbox_thread_state').select('*').eq('id', String(lead.thread_id)).limit(1)) : null
    const { evaluateAgentMessageGuards, loadThreadHistory, AGENT_MESSAGE_VERSION } = await import('@/lib/domain/outreach/agent-message.js')
    const messages = await loadThreadHistory(supabase, lead.phone)
    const g = await evaluateAgentMessageGuards({ supabase, lead, target, purpose, policy: act.policy, aiPolicy, messages, prospect, property, now: at, holdChecker })
    if (!g.ok) return refuse(g.code === 'OUTSIDE_RECIPIENT_WINDOW' ? 'deferred' : 'refused', g.code, { reason: code(g.evidence?.reason, 60), next_permitted_at: g.evidence?.next_permitted_at || null })
    // 4. the day caps (per lead, global): reserved now, completed with the row or released
    const cap = await rpc(supabase, 'lc_agent_message_reserve', { p_intent_id: id }).catch(() => null)
    if (!cap?.ok) return refuse('refused', code(cap?.code || 'CAP_RESERVATION_UNAVAILABLE', 60), { cap: cap?.cap ?? null }, { release: false })
    // 5. persona + sender: the thread's established persona and sticky sender (never a number change); a first touch
    //    gets the campaign path's persona resolution and its market sender routing
    const { loadThreadPersonas, personaStableKey } = await import('@/lib/domain/outbound/outbound-persona.js')
    const { buildOutboundMergeValues } = await import('@/lib/domain/campaigns/outbound-agent-identity.js')
    let threadPersona = []
    try { threadPersona = (await loadThreadPersonas(supabase, [lead.phone])).get(personaStableKey(lead.phone)) || [] } catch { return refuse('held', 'PERSONA_UNRESOLVED') }
    const masterOwner = lead.master_owner_id ? await one(supabase.from('master_owners').select('master_owner_id,agent_persona').eq('master_owner_id', String(lead.master_owner_id)).limit(1)).catch(() => null) : null
    const firstName = clean(target?.metadata?.candidate_snapshot?.seller_first_name) || clean(prospect?.first_name) || null
    const propertyLabel = clean(target?.property_address) || clean(property?.property_address) || null
    const merge = buildOutboundMergeValues({ target: { ...(target || {}), to_phone_number: lead.phone, property_address: propertyLabel, language: target?.language || 'English', metadata: { candidate_snapshot: { seller_first_name: firstName } } }, masterOwner, property, threadPersona })
    if (!merge.ok) return refuse('held', `PERSONA_UNRESOLVED:${code(merge.reason, 40)}`)
    let sender = clean(thread?.our_number) || null
    if (!sender && purpose === 'first_touch') {
      const { resolveSender } = await import('@/lib/domain/campaigns/enqueue-campaign-target-one.js')
      const s = await resolveSender(supabase, { market: clean(target?.market), recipient: lead.phone }).catch((e) => { if (process.env.T34_DEBUG) console.error('RESOLVE_SENDER', e); return null })
      sender = s?.blocked_by_dispatch ? null : clean(s?.phone_number) || null
    }
    if (!sender || sender === lead.phone) return refuse('held', 'SENDER_UNRESOLVED')
    // 6. LeadCommand writes the message (the canonical outbound entry: playbook v3 + the shared validator)
    const { composeAgentOutbound, WRITER_VERSION, CANONICAL_RUNTIME_VERSION } = await import('@/lib/domain/conversation-ai/runtime/canonical.js')
    const { loadCompanyIdentity } = await import('@/lib/domain/conversation-ai/company-identity.js')
    let modelClient = null
    let composerOff = null
    try {
      const { loadPolicy } = await import('./conversation-ai-shadow-wiring.js')
      const { shadowAllowed } = await import('@/lib/domain/conversation-ai/policy.js')
      const gate = shadowAllowed(await loadPolicy(supabase), env)
      if (!gate.allowed) composerOff = gate.code
      else {
        const { createConversationModelClient, createSpendTracker } = await import('@/lib/domain/conversation-ai/model-client.js')
        const tracker = trackerFor ? trackerFor(ctx) : createSpendTracker({ capUsd: 0.02 })
        modelClient = createConversationModelClient({ provider: provider || (await import('./anthropic-provider.js')).createAnthropicProvider({ env }), tracker, env })
        ctx.__spend = tracker
      }
    } catch (e) { composerOff = code(e?.code || 'COMPOSER_UNAVAILABLE', 40) }
    const { composeSpendFor } = await import('./conversation-canonical-inputs.js')
    const companyIdentity = await loadCompanyIdentity({ readSwitch: read }).catch(() => undefined)
    const composed = modelClient
      ? await composeAgentOutbound({ purpose, brief: clean(intent.params?.brief), thread: messages, recordFacts: { property_id: lead.property_id || null }, modelClient, spend: composeSpendFor(ctx.__spend),
        establishedPersona: merge.values.agent_name, ...(companyIdentity ? { companyIdentity } : {}), firstName, propertyLabel, propertyAddresses: [propertyLabel].filter(Boolean),
        eligibility: { blocked: false, reasons: [], timing: g.timing }, caller: 'agent_message', now: at, seed: id })
      : { ok: false, reason: `composer_unavailable:${String(composerOff || 'off').toLowerCase()}` }
    const insertQueue = agentMessageDeps.insertQueueRow || r3deps.insertQueueRow || (async (payload) => (await import('@/lib/supabase/sms-engine.js')).insertSupabaseSendQueueRow(payload, { supabase }))
    const baseMeta = { agent_message_intent_id: id, agent_id: intent.agent_id, agent_message: { purpose, generated_at: at, version: AGENT_MESSAGE_VERSION, brief_hash: code(intent.params?.brief ? (await import('node:crypto')).createHash('sha256').update(clean(intent.params.brief)).digest('hex') : null, 64) },
      is_first_touch: purpose === 'first_touch', type: purpose === 'first_touch' ? 'campaign' : 'followup', send_kind: purpose === 'first_touch' ? 'agent_first_touch' : `agent_${purpose}`,
      recipient_zones: g.timing?.zones || [], ...(target?.id ? { campaign_target_id: target.id } : {}), agent_persona: merge.persona, no_direct_provider_send: true }
    if (composed.ok) {
      const { buildAiGeneratedOutboundMessage, insertAiGeneratedMessage, lookupAiGeneratedMessageByQueueKey, recordAiGeneratedMessageEvent } = await import('@/lib/domain/messages/ai-generated-message.js')
      const text = composed.reply.text
      const prior = await lookupAiGeneratedMessageByQueueKey(supabase, queueKey)
      let rec = prior.record
      if (!rec) {
        const aiRecord = buildAiGeneratedOutboundMessage({ intentId: id, category: purpose, body: text, threadKey: lead.phone, propertyId: lead.property_id, contactId: lead.prospect_id, recipientPhone: lead.phone, senderPhone: sender,
          decisionId: `action_gateway:${id}`, jobId: job_id, model: composed.composition?.model || 'unknown', playbookVersion: composed.composition?.playbook_version, promptVersion: composed.composition?.prompt_version,
          contextVersion: AGENT_MESSAGE_VERSION, validation: { status: 'validated', validators: [composed.validation?.version, composed.validation?.style_version, 'agent-message-guards'].filter(Boolean), reasons: [] },
          ledgerSnapshot: composed.ledger_summary, policy: aiPolicy, approvalState: 'policy_authorized', generatedAt: at, costUsd: composed.cost_usd || 0,
          inputTokens: composed.composition?.usage?.input_tokens ?? null, outputTokens: composed.composition?.usage?.output_tokens ?? null,
          authorizationScope: { policy_key: AI_SEND_POLICY_KEY, policy_version: aiPolicy.policy_version, scope_match: 'thread_keys', kill_switch_key: AI_SEND_KILL_SWITCH_KEY, agent_message_policy_version: act.policy?.policy_version || null },
          auditRefs: { writer_version: WRITER_VERSION, runtime_version: CANONICAL_RUNTIME_VERSION, action_intent_id: id, agent_id: intent.agent_id, purpose, objective: composed.objective, reservations: { lead_slot: cap.lead_slot, global_slot: cap.global_slot, day: cap.day } } })
        const ins = await insertAiGeneratedMessage(supabase, aiRecord)
        if (!ins.ok) { const again = await lookupAiGeneratedMessageByQueueKey(supabase, queueKey); if (!again.record) throw Object.assign(new Error('AI_RECORD_INSERT_FAILED'), { code: 'AI_RECORD_INSERT_FAILED' }); rec = again.record } else rec = { ...aiRecord, id: ins.id }
      }
      const payload = {
        queue_key: queueKey, queue_id: queueKey, dedupe_key: queueKey, queue_status: 'queued', scheduled_for: at, scheduled_for_utc: at, scheduled_for_local: at,
        timezone: (g.timing?.zones || []).length === 1 ? g.timing.zones[0] : null, send_priority: 5, retry_count: 0, max_retries: 1,
        message_body: rec.message_body, message_text: rec.message_body, seller_first_name: firstName, to_phone_number: lead.phone, from_phone_number: sender, agent_name: merge.values.agent_name,
        master_owner_id: lead.master_owner_id || null, prospect_id: lead.prospect_id || null, property_id: lead.property_id || null, property_address: propertyLabel,
        message_origin: 'ai_generated', template_id: null, selected_template_id: null, template_source: 'ai_generated',
        message_type: 'ai_agent_message', type: 'ai_conversation', use_case_template: `ai_agent_${purpose}`, character_count: rec.message_body.length, thread_key: lead.phone, source: 'ai_conversation',
        language: 'English', sms_eligible: true, routing_allowed: true,
        metadata: { ...baseMeta, source: 'ai_conversation', action_type: 'ai_agent_message', decision_id: `action_gateway:${id}`, message_origin: 'ai_generated', ai_message_id: rec.id, ai_message_body_sha256: rec.body_sha256,
          ai_message_record_version: rec.record_version, ai_scope_category: purpose, writer_version: WRITER_VERSION, send_policy_version: AI_SEND_POLICY_VERSION, objective: composed.objective },
      }
      let res
      try { res = await insertQueue(payload) } catch (e) { res = { ok: false, reason: e?.message || 'insert_threw' } }
      const qid = res?.queue_row_id || res?.item_id || res?.id || null
      if (!res?.ok || !qid) { await recordAiGeneratedMessageEvent(supabase, { aiMessageId: rec.id, eventType: 'held', detail: { reason: 'queue_insert_failed' } }).catch(() => null); return refuse('held', `QUEUE_INSERT_REFUSED:${code(res?.reason, 40)}`) }
      await recordAiGeneratedMessageEvent(supabase, { aiMessageId: rec.id, eventType: 'queued', queueRowId: qid, detail: { queue_key: queueKey } }).catch(() => null)
      await settle('completed')
      await record(id, job_id, 'enqueued', 'AI_COMPOSED_ENQUEUED', { origin: 'ai_generated', purpose, objective: code(composed.objective, 30) }, qid)
      return { code: 'AGENT_MESSAGE_ENQUEUED', queue_row_id: qid, origin: 'ai_generated' }
    }
    // 7. the writer is unavailable or refused: the NAMED governed template, else nothing
    const why = code(composed.reason, 60)
    const templateId = clean(intent.params?.template_id)
    const why_detail = { validation: (composed.validation?.content_reasons || []).slice(0, 6).map((x) => code(x, 60)), attempts: (composed.composition?.attempt_reasons || []).slice(0, 2).map((a) => (a || []).slice(0, 4).map((x) => code(x, 60))) }
    if (!templateId) return refuse('refused', `COMPOSITION_REFUSED:${why}`, why_detail)
    if (!((act.policy?.fallback_templates || {})[purpose] || []).includes(templateId)) return refuse('refused', 'TEMPLATE_NOT_ALLOWED')
    const tpl = await one(supabase.from('sms_templates').select('*').eq('template_id', templateId).limit(1))
    const { applyGovernance, indexGovernance } = await import('@/lib/domain/campaigns/template-governance.js')
    const gov = await rows(supabase.from('ownership_template_rotation_control').select('*').eq('template_id', templateId).limit(5))
    const gv = tpl ? applyGovernance([tpl], indexGovernance(gov), clean(tpl.use_case)) : { eligible: [] }
    if (gv.eligible.length !== 1) return refuse('refused', 'TEMPLATE_NOT_GOVERNED')
    const { renderTemplateBody } = await import('@/lib/domain/campaigns/template-render-validation.js')
    const rendered = renderTemplateBody(tpl.template_body, merge.values)
    if (!rendered.ok) return refuse('refused', `TEMPLATE_RENDER_FAILED:${code(rendered.reason, 40)}`)
    const { enqueueCanonicalOutboundSms } = await import('@/lib/domain/queue/canonical-queue-writer.js')
    const w = await enqueueCanonicalOutboundSms({
      to_phone_number: lead.phone, from_phone_number: sender, message_body: rendered.body, thread_key: lead.phone, source_event_id: queueKey, idempotency_key: queueKey, queue_key: queueKey,
      template_id: templateId, use_case: tpl.use_case, language: tpl.language || 'English', message_type: purpose === 'first_touch' ? 'campaign_opener' : 'followup', action_type: 'agent_message_template_fallback',
      master_owner_id: lead.master_owner_id || null, property_id: lead.property_id || null, property_address_state: property?.property_address_state || null, property_address_zip: property?.property_address_zip || null,
      metadata: { ...baseMeta, origin_detail: 'agent_template', fallback_reason: why, template_name: tpl.template_name || null, seller_first_name: firstName, agent_name: merge.values.agent_name, candidate_snapshot: { seller_first_name: firstName, property_address: propertyLabel } },
    }, { supabase, getSystemValue: read, insertQueueImpl: agentMessageDeps.insertQueueRow || r3deps.insertQueueRow || undefined })
    if (!w?.ok || !w.queue_row_id) return refuse('refused', `TEMPLATE_FALLBACK_REFUSED:${code(w?.reason, 40)}`)
    await settle('completed')
    await record(id, job_id, 'enqueued', 'TEMPLATE_FALLBACK_ENQUEUED', { origin: 'template', purpose, fallback_reason: why }, w.queue_row_id)
    return { code: 'AGENT_MESSAGE_ENQUEUED', queue_row_id: w.queue_row_id, origin: 'template' }
  }

  /** Follow enqueued rows to their dispatch outcome. An ambiguous accept is recorded, escalated, NEVER resent. */
  async function reconcileReceipts({ limit = 50 } = {}) {
    const open = (await rpc(supabase, 'lc_seller_action_open_receipts', { p_limit: limit })) || []
    const out = []
    for (const r of open) {
      if (!r.queue_row_id) continue
      const [q] = await rows(supabase.from('send_queue').select('id,queue_status,provider_message_id,failed_reason,paused_reason,metadata').eq('id', r.queue_row_id).limit(1))
      const st = clean(q?.queue_status).toLowerCase()
      const md = q?.metadata || {}
      const pe = md.provider_error || {}
      const ambiguous = Boolean(md.no_sid_ambiguous_send || md.ambiguous_send || md.delivery_possibility === 'possible' || pe.failure_class === 'provider_ambiguous_accept' || md.failure_bucket === 'provider_no_sid'
        || /ambiguous|no_sid/i.test(`${q?.failed_reason || ''} ${md.failure_class || ''} ${md.provider_outcome_class || ''} ${pe.normalized_reason || ''}`))
      let next = null
      if (!q) next = ['failed', 'QUEUE_ROW_MISSING']
      else if (['sent', 'delivered'].includes(st)) next = ['sent', `QUEUE_${st.toUpperCase()}`]
      else if (ambiguous) next = ['outcome_unknown', 'PROVIDER_ACCEPT_AMBIGUOUS_NOT_RETRIED']
      else if (['failed', 'cancelled', 'canceled', 'expired'].includes(st) || st.startsWith('failed')) next = ['failed', `QUEUE_${code(st, 30).toUpperCase()}`]
      else if (st.startsWith('paused') || st.startsWith('blocked') || st === 'held' || st === 'deferred') next = ['held', `QUEUE_${code(st, 40).toUpperCase()}`]
      if (!next) continue
      await record(r.intent_id, r.job_id, next[0], next[1], { queue_status: code(st, 40) }, r.queue_row_id)
      out.push({ intent_id: r.intent_id, state: next[0], code: next[1] })
    }
    return { scanned: open.length, recorded: out }
  }

  /** THE handler body of action_gateway.execute: dispatch by the handed-off intent's action. */
  async function execute(job, ctx = {}) {
    if (job?.input?.sweep === 'receipts') return reconcileReceipts({})
    const id = clean(job?.input?.action_intent_id)
    if (!UUID_RE.test(id)) return { code: 'ACTION_INPUT_INVALID' }
    const l = await rpc(supabase, 'lc_seller_action_load', { p_intent_id: id })
    const fn = { sellerReply, offerSend, recordCounter, leadState, agentMessage }[ACTION_EXECUTORS[l?.intent?.action]]
    if (!fn) return { code: 'ACTION_NOT_EXECUTED_HERE' }
    return fn(job, ctx)
  }

  return Object.freeze({ execute, sellerReply, offerSend, recordCounter, leadState, agentMessage, reconcileReceipts, version: ACTION_EXECUTION_VERSION })
}

/** The runtime handler of the ONE executor kind (the tick route registers it). */
export function buildActionGatewayHandlers({ execution }) {
  return {
    [ACTION_GATEWAY_EXECUTE_KIND]: Object.freeze({ kind: ACTION_GATEWAY_EXECUTE_KIND, async run(ctx) {
      await ctx.step?.('execute', { progress: { step: 'execute', steps_done: 0, steps_total: 1, pct: 0 } })
      return { result: await execution.execute(ctx.job, ctx) }
    } }),
  }
}

/** Born OFF: {} unless LC_ACTION_GATEWAY_EXECUTION=1 and the runtime gate. */
export function actionGatewayExecutionHandlers(env = process.env) {
  if (clean(env?.LC_ACTION_GATEWAY_EXECUTION) !== '1' || !runtimeGate(env)?.enabled) return {}
  let execution = null
  const lazy = async () => execution || (execution = createGatewayExecution({ supabase: (await import('@/lib/supabase/default-client.js')).getDefaultSupabaseClient(), env }))
  return {
    [ACTION_GATEWAY_EXECUTE_KIND]: Object.freeze({ kind: ACTION_GATEWAY_EXECUTE_KIND, async run(ctx) { const e = await lazy(); return { result: await e.execute(ctx.job, ctx) } } }),
  }
}
