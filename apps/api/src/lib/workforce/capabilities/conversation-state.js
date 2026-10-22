// intel.conversation_state (read) — one opportunity's conversation: the thread context
// (thread-context-service loadThreadContext), the Inbound Action Center state
// (agent/operations/action-center deriveActionState over the normalized conversation facts, or the
// stored agent.conversation_action_state row when only that is readable), the hold registry and
// suppression. The thread key is resolved in memory (deal-context-service getDealContextByProperty)
// and never leaves this function: the output carries ids, timestamps and codes only.
import { normalizeConversationFacts } from '../../agent/operations/conversation-facts.js'
import { deriveActionState } from '../../agent/operations/action-center.js'
import { CapabilityError, arr, clean, code, decodePropertyRef, done, exclusionCode, iso, lower, ms, obj, ref, safeText, uuidOrNull } from './shared.js'

export const KEY = 'intel.conversation_state'

function summarizeThreadContext(tc) {
  const c = obj(tc)
  // loadThreadContext → { thread_key, context: { selected_thread: { message_events } }, … }
  const events = arr(obj(obj(c.context).selected_thread).message_events ?? obj(c.selected_thread).message_events ?? c.message_events)
  let last_in = null
  let last_out = null
  for (const e of events) {
    const t = ms(e?.event_timestamp ?? e?.created_at ?? e?.sent_at)
    if (t == null) continue
    const d = lower(e?.direction)
    if (d === 'inbound' && (last_in == null || t > last_in)) last_in = t
    if (d === 'outbound' && (last_out == null || t > last_out)) last_out = t
  }
  return {
    message_count: events.length,
    last_inbound_at: last_in == null ? null : new Date(last_in).toISOString(),
    last_outbound_at: last_out == null ? null : new Date(last_out).toISOString(),
  }
}

function projectActionState(st) {
  if (!st) return null
  return {
    state: code(st.state),
    owner: code(st.owner),
    next_action: safeText(st.next_action, 80),
    due_at: iso(st.due_at),
    verified_stage: code(st.verified_stage),
    stage_verified: st.stage_verified === true,
    lost: st.lost === true,
    reasons: arr(st.reasons).map(code).filter(Boolean).slice(0, 10),
    pending_approvals: arr(st.pending_approvals).length,
    last_inbound_at: iso(st.last_inbound_at),
    last_outbound_at: iso(st.last_outbound_at),
  }
}

export const capability = Object.freeze({
  key: KEY,
  class: 'read',
  roles: Object.freeze(['head_acquisitions', 'acquisition_agent', 'ops_supervisor']),
  escalates_on: Object.freeze([]),
  resourceOf: (_ctx, input) => ({ property_id: decodePropertyRef(input.property_ref), opportunity_id: input.opportunity_id ?? null, conversation_id: input.conversation_id ?? null, market: input.market ?? null }),
  async run(ctx, input = {}) {
    const s = ctx.services || {}
    const property_id = clean(decodePropertyRef(input.property_ref))
    if (!property_id) throw new CapabilityError('PROPERTY_REF_REQUIRED', { retryable: false })
    const sources = []
    let thread_key = null
    let conversation_id = uuidOrNull(input.conversation_id)
    if (typeof s.getDealContextByProperty === 'function') {
      const dc = obj(await s.getDealContextByProperty(property_id))
      thread_key = clean(dc.thread_key) || null
      conversation_id = conversation_id || uuidOrNull(obj(dc.thread_state_data).id ?? dc.inbox_thread_id)
      sources.push('deal-context-service.getDealContextByProperty')
    }
    const base = { property_ref: input.property_ref, opportunity_id: uuidOrNull(input.opportunity_id), conversation_id, has_thread: Boolean(thread_key) }
    // never revive / permanent exclusion: even the thread key's static exclusion (Maxwell is matched by its key hash)
    const never = exclusionCode({ property_id, opportunity_id: base.opportunity_id, conversation_id, thread_key })
    if (never) return done({ ...base, excluded: never, contact_permitted: false }, { outcome_class: 'refused', evidence: [ref('rule', 'never_revive')] })

    let hold = null
    if (typeof s.checkHold === 'function') {
      hold = obj(await s.checkHold({ propertyId: property_id, threadKey: thread_key, threadId: conversation_id, opportunityId: base.opportunity_id }))
      sources.push('automation-hold.checkAutomationHold')
    }
    if (hold?.held) return done({ ...base, held: true, hold_type: code(hold.hold_type), fail_closed: hold.fail_closed === true, contact_permitted: false }, { outcome_class: hold.fail_closed ? 'unknown' : 'verified', evidence: [ref('service', 'automation_holds')] })

    let suppression = null
    if (thread_key && typeof s.checkSuppression === 'function') {
      suppression = obj(await s.checkSuppression({ thread_key }))
      sources.push('compliance.queryActiveSuppression')
    }

    let action = null
    if (thread_key && typeof s.conversationFacts === 'function') {
      const raw = await s.conversationFacts({ thread_key, property_id })
      if (raw) { action = projectActionState(deriveActionState(normalizeConversationFacts(raw), { now: ctx.now ?? Date.now() })); sources.push('action-center.deriveActionState') }
    }
    if (!action && typeof s.storedActionState === 'function') {
      const st = await s.storedActionState({ property_ref: input.property_ref, conversation_id })
      if (st) { action = projectActionState(st); sources.push('agent.conversation_action_state') }
    }

    let thread = null
    if (thread_key && typeof s.loadThreadContext === 'function') {
      thread = summarizeThreadContext(await s.loadThreadContext({ thread_key }))
      sources.push('thread-context-service.loadThreadContext')
    }

    const suppressed = suppression ? suppression.suppressed === true : null
    const permitted = suppressed === true || action?.state === 'suppressed_ineligible' ? false : action || suppression ? true : null
    const last_in = action?.last_inbound_at ?? thread?.last_inbound_at ?? null
    const last_out = action?.last_outbound_at ?? thread?.last_outbound_at ?? null
    const output = {
      ...base,
      held: hold ? false : null,
      suppressed,
      suppression_lookup_error: suppression?.lookup_error ? true : false,
      contact_permitted: permitted,
      action_state: action?.state ?? null,
      action,
      seller_spoke_last: last_in && (!last_out || ms(last_in) > ms(last_out)) ? true : last_in || last_out ? false : null,
      last_inbound_at: last_in,
      last_outbound_at: last_out,
      message_count: thread?.message_count ?? null,
      sources,
    }
    const known = [hold, suppression, action, thread].filter(Boolean).length
    const outcome_class = !thread_key ? 'unknown' : known >= 3 && action ? 'verified' : known ? 'partial' : 'unknown'
    return done(output, { outcome_class, evidence: sources.map((x) => ref('service', x)) })
  },
})
