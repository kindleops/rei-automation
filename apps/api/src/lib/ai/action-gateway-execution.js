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
export const ACTION_EXECUTORS = Object.freeze({ queue_authorized_reply: 'sellerReply', execute_authorized_offer: 'offerSend', record_seller_counteroffer: 'recordCounter' })
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const clean = (v) => String(v ?? '').trim()
const code = (v, n = 80) => clean(v).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, n) || null
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
export function createGatewayExecution({ supabase, env = process.env, provider = null, trackerFor = null, r3deps = {}, readSwitch = null, now = () => Date.now(), offerSendDeps = {} } = {}) {
  const read = readSwitch || ((k) => getSystemValueFresh(k, { supabase }))
  const record = (intent_id, job_id, state, c, detail = {}, queue_row_id = null) =>
    rpc(supabase, 'lc_seller_action_receipt_record', { p_intent_id: intent_id, p_job_id: job_id, p_state: state, p_code: code(c), p_detail: detail, p_queue_row_id: queue_row_id ? String(queue_row_id) : null })

  /** The handed-off intent, verified: handed off, this action's kind, this job, receipt not final. */
  async function prologue(action, job) {
    const id = clean(job?.input?.action_intent_id)
    if (!UUID_RE.test(id)) return { stop: { code: 'ACTION_INPUT_INVALID' } }
    const l = await rpc(supabase, 'lc_seller_action_load', { p_intent_id: id })
    const i = l?.intent
    if (!i || i.state !== 'succeeded' || i.result_code !== 'HANDOFF_QUEUED' || i.action !== action) return { stop: { code: 'INTENT_NOT_HANDED_OFF' } }
    const r = l.receipt
    if (!r || r.job_id !== job.job_id) return { stop: { code: 'RECEIPT_JOB_MISMATCH' } }
    if (!['requested', 'executing'].includes(r.state)) return { stop: { code: 'RECEIPT_FINAL', state: r.state } }
    if (!(l.authorization?.approval_id || l.authorization?.envelope_ref)) {
      await record(id, job.job_id, 'refused', 'NO_PER_USE_AUTHORITY')
      return { stop: { code: 'NO_PER_USE_AUTHORITY' } }
    }
    await record(id, job.job_id, 'executing', 'EXECUTING')
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
    const fn = { sellerReply, offerSend, recordCounter }[ACTION_EXECUTORS[l?.intent?.action]]
    if (!fn) return { code: 'ACTION_NOT_EXECUTED_HERE' }
    return fn(job, ctx)
  }

  return Object.freeze({ execute, sellerReply, offerSend, recordCounter, reconcileReceipts, version: ACTION_EXECUTION_VERSION })
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
