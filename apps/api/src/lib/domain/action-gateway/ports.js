// Ports: the gateway's READS (authoritative LeadCommand ids) and the EXISTING domain services it calls.
// `db` is the Supabase-shaped client running AS lc_action_gateway (tenant claim lc_org). Nothing here
// writes: domain writes are the lease-bound database functions the store calls.
import { checkAutomationHold } from '../holds/automation-hold.js'
import { registerAutomationHoldChecker } from '../holds-port/automation-hold-port.js'
import { isStopRequest } from '../conversation-ai/stop-request.js'
import { createT2Services } from './actions/t2/services.js'
import { normalizeOpportunityFacts, reconcileOpportunity, PIPELINE_RECONCILER_VERSION } from '../../agent/operations/pipeline-reconciler.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A definer read (a jsonb-returning database function the role may execute); a failure is a read failure. */
async function definerRead(db, fn, args) {
  const r = await db.rpc(fn, args)
  if (r?.error) throw Object.assign(new Error(`${fn} read failed: ${r.error.message || r.error.code || 'error'}`), { code: 'READ_FAILED', what: fn })
  return r?.data ?? null
}

async function rows(q, what) {
  const r = await q
  if (r?.error) throw Object.assign(new Error(`${what} read failed`), { code: 'READ_FAILED', what })
  return Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : []
}

/**
 * The AI reply policy lives in a service-role-only table (#3). The draft service reads it with
 * supabase.from('conversation_ai_reply_policy'); this client answers that ONE read from the gateway's
 * allowlisted definer read (action_gateway_reply_policy) and forwards everything else unchanged.
 */
export function withReplyPolicyRead(db, readPolicy) {
  const answer = async () => {
    try { const row = await readPolicy(); return { data: row ? [row] : [], error: null } } catch { return { data: [], error: null } }
  }
  const builder = () => {
    const b = { select: () => b, eq: () => b, limit: () => b, order: () => b, maybeSingle: async () => { const r = await answer(); return { data: r.data[0] || null, error: null } }, then: (res, rej) => answer().then(res, rej) }
    return b
  }
  return {
    from: (table) => (table === 'conversation_ai_reply_policy' ? builder() : db.from(table)),
    rpc: (...a) => db.rpc(...a),
  }
}

/** @param {{ db: object }} o */
export function createGatewayReads({ db }) {
  if (!db?.from) throw new Error('gateway reads: a Supabase-shaped client is required')
  return Object.freeze({
    async thread(id) {
      if (!UUID_RE.test(String(id))) return null
      const [t] = await rows(db.from('inbox_thread_state').select('id,thread_key,property_id,master_owner_id,prospect_id,is_suppressed,contactability_status,market').eq('id', String(id)).limit(1), 'thread')
      return t || null
    },
    async property(id) {
      const [p] = await rows(db.from('properties').select('property_id,property_type,property_address_city,property_address_state,property_address_zip,market').eq('property_id', String(id)).limit(1), 'property')
      return p || null
    },
    async opportunity(id) {
      if (!UUID_RE.test(String(id))) return null
      const [o] = await rows(db.from('acquisition_opportunities').select('id,primary_property_id,primary_thread_key,acquisition_stage,opportunity_status,market').eq('id', String(id)).limit(1), 'opportunity')
      return o || null
    },
    /** The Supabase-shaped client itself (read-only use by the T3 / T4 read services; the role writes nothing). */
    client: db,
    /** system_control values the role may read (the key-allowlist policies), absent ⇒ null. */
    async switches(keys) {
      const r = await rows(db.from('system_control').select('key,value').in('key', keys.map(String)), 'switches')
      return Object.fromEntries(keys.map((k) => [k, r.find((x) => x.key === k)?.value ?? null]))
    },
    async message(id) {
      if (!UUID_RE.test(String(id))) return null
      const [m] = await rows(db.from('message_events').select('id,provider_message_sid,message_body,created_at,direction,thread_key,property_id').eq('id', String(id)).limit(1), 'message')
      return m || null
    },
    /** OHG (link #29): the receipts of the replies agents queued on a thread, with their queue rows and delivery states. */
    async replyStatus(threadId, limit = 20) { return (await definerRead(db, 'action_gateway_reply_status', { p_thread_id: threadId, p_limit: limit })) || [] },
    async annotations(threadId, limit = 50) { return (await definerRead(db, 'action_gateway_annotations', { p_thread_id: threadId, p_limit: limit })) || [] },
    async latestMessage(thread_key) {
      const [m] = await rows(db.from('message_events').select('id,direction,created_at').eq('thread_key', thread_key).order('created_at', { ascending: false }).limit(1), 'latest_message')
      return m || null
    },
    async opportunityFor(thread_key, property_id) {
      const [o] = await rows(db.from('acquisition_opportunities').select('id,primary_property_id,primary_thread_key,opportunity_status,automation_state,market').eq('primary_thread_key', thread_key).eq('primary_property_id', String(property_id)).limit(1), 'opportunity_for')
      return o || null
    },
    async sellerOffers(thread_key) {
      return rows(db.from('seller_offers').select('offer_id,opportunity_id,property_id,thread_key,offer_version,offer_type,direction,purchase_price,authorized_ceiling,status,sent_at,created_at').eq('thread_key', thread_key).limit(50), 'seller_offers')
    },
    async latestInbound(thread_key) {
      const [m] = await rows(db.from('message_events').select('id,provider_message_sid,message_body,created_at,direction').eq('thread_key', thread_key).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(1), 'latest_inbound')
      return m || null
    },
    /** Permission state of a thread (codes only): STOP on the latest inbound, thread suppression / opt-out, an active suppression row. */
    async permission(thread) {
      const latest = await this.latestInbound(thread.thread_key)
      const t = await this.thread(thread.id)
      const sup = await rows(db.from('sms_suppression_list').select('is_active').eq('phone_e164', thread.thread_key).limit(5), 'suppression')
      const contact = String(t?.contactability_status || '').toLowerCase()
      const reasons = []
      if (latest && isStopRequest(latest.message_body)) reasons.push('stop_requested')
      if (t?.is_suppressed === true) reasons.push('thread_suppressed')
      if (['opted_out', 'do_not_text', 'do_not_contact'].includes(contact)) reasons.push(`contactability_${contact}`)
      if (sup.some((s) => s.is_active !== false)) reasons.push('phone_suppressed')
      return { blocked: reasons.length > 0, reasons, latest_inbound_id: latest?.id || null, latest_inbound_at: latest?.created_at || null }
    },
  })
}

/**
 * The EXISTING domain services the policies / executors call, bound to the gateway's client.
 * @param {{ db: object, store: object, env?: object, provider?: object|null, draft?: Function }} o
 */
export function createGatewayServices({ db, store, env = {}, provider = null, draft = null, bindHoldPort = true }) {
  const policyDb = withReplyPolicyRead(db, () => store.replyPolicy())
  // COMPOSITION ROOT: bind THE hold authority's port (holds-port/automation-hold-port.js) to the gateway's own
  // client. Domain code that consults the port without an injected checker (e.g. the send-time guard facts
  // inside the draft service's eligibility dry run) otherwise resolves holds through the process-default
  // client, which the Action MCP fences to a refusal (fail closed, never a wrong "not held").
  if (bindHoldPort) registerAutomationHoldChecker((args) => checkAutomationHold(args, { supabase: db }))
  return Object.freeze({
    env,
    /** Tier-2 reads + the human-request writer call (actions/t2/services.js), on the gateway's own client. */
    t2: createT2Services({ db }),
    /** THE hold authority (holds/automation-hold.js#checkAutomationHold), fail closed. */
    holdCheck: (args) => checkAutomationHold(args, { supabase: db }),
    /** ai/conversation-ai-draft-service#draftReplyForInbound → decideAndCompose (never queues, writes nothing). */
    async draft({ inboundMessageId }) {
      if (typeof draft === 'function') return draft({ inboundMessageId, supabase: policyDb, env, provider })
      const { draftReplyForInbound } = await import('../../ai/conversation-ai-draft-service.js')
      return draftReplyForInbound({ inboundMessageId, caller: 'capability', env, supabase: policyDb, provider })
    },
    /** ai/conversation-canonical-inputs#loadCanonicalInputs (read-only; the context read projects it). */
    async canonicalInputs({ providerMessageSid, now }) {
      const { loadCanonicalInputs } = await import('../../ai/conversation-canonical-inputs.js')
      return loadCanonicalInputs({ supabase: policyDb, providerMessageSid, now })
    },
    /** agent.ops_pipeline_facts → operations/pipeline-reconciler#reconcileOpportunity, REPORT ONLY. */
    async pipelineReport({ after = null, limit = 200, now = Date.now() }) {
      const raw = await store.pipelineFacts({ after, limit })
      const res = (Array.isArray(raw) ? raw : []).map(normalizeOpportunityFacts).map((o) => reconcileOpportunity(o, { now }))
      const by_issue = {}
      for (const r of res) for (const i of r.issues) by_issue[i.code] = (by_issue[i.code] || 0) + 1
      const mismatched = res.filter((r) => !r.ok)
      return {
        mode: 'report_only', reconciler: PIPELINE_RECONCILER_VERSION, scanned: res.length, mismatched: mismatched.length, by_issue,
        sample: mismatched.slice(0, 25).map((r) => ({ opportunity_id: r.opportunity_id, stage: r.stage, issues: r.issues.map((i) => i.code), proposed_stage: r.proposal?.to_stage || null })),
        next_after_id: res.length >= limit && res.length ? res[res.length - 1].opportunity_id : null,
        writes: { stages: 0, work_items: 0, approvals: 0 },
      }
    },
  })
}
