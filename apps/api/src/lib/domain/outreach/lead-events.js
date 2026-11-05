// THE AGENTS' WAKE-UP FEED, writer side (link #32: action_gateway.lead_events through public.lc_lead_event_append).
// LeadCommand appends, at its own choke points, the events an agent acting on a lead needs to hear about:
//   inbound_message      a seller wrote (the inbound webhook, after message_events / inbox_thread_state are written)
//   opt_out              that message was a stop (any language the stop reader confirms)
//   lead_state_changed   temperature / operational status / stage changed through the canonical lead-state registry
//   delivery_changed     what happened to a message an agent asked for (the receipt writer appends it in the database)
// Event ids are idempotent (kind + the source record's id): a webhook retry appends nothing. The payload carries ids and
// codes only — never a phone number or message text (the database refuses an unclean payload). Appending NEVER blocks or
// fails the caller: a missing link / function or an unclean payload is reported as { ok: false } and ignored (the feed
// is at-least-once from LeadCommand's choke points, never a gate on them).
const clean = (v) => String(v ?? '').trim()

export const LEAD_EVENT_KINDS = Object.freeze(['inbound_message', 'lead_state_changed', 'delivery_changed', 'opt_out', 'lead_transferred'])

export async function appendLeadEvent(supabase, { kind, eventKey, threadKey = null, threadId = null, payload = {}, occurredAt = null } = {}) {
  try {
    if (!LEAD_EVENT_KINDS.includes(kind) || !clean(eventKey) || typeof supabase?.rpc !== 'function') return { ok: false, reason: 'not_appended' }
    const r = await supabase.rpc('lc_lead_event_append', {
      p_kind: kind, p_event_key: clean(eventKey).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160), p_thread_key: clean(threadKey) || null,
      p_thread_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean(threadId)) ? clean(threadId) : null,
      p_payload: payload && typeof payload === 'object' ? payload : {}, p_occurred_at: occurredAt || null,
    })
    if (r?.error) return { ok: false, reason: 'append_failed' }
    return { ok: true, appended: r?.data?.appended === true, cursor: r?.data?.cursor ?? null }
  } catch {
    return { ok: false, reason: 'append_threw' }
  }
}

/**
 * link #32: the CARRIER's verdict on a text an agent asked for (the TextGrid delivery webhook's reconciled queue row):
 * delivered / undelivered as a delivery_changed event on the agents' feed (public.lc_agent_text_delivery_record) and on
 * the ledger record's lifecycle (ai_generated_message_events). Rows without an agent intent are untouched. NEVER throws
 * and never blocks the webhook; the receipt itself stays 'sent' (nothing a carrier says can make anything resend).
 */
export async function recordAgentDeliveryVerdict(supabase, row = {}, { delivered, code = null } = {}) {
  try {
    const m = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    if (!clean(m.agent_text_intent_id) && !clean(m.agent_message_intent_id)) return { ok: false, reason: 'not_an_agent_row' }
    if (typeof supabase?.rpc !== 'function' || !clean(row?.id)) return { ok: false, reason: 'not_appended' }
    const state = delivered ? 'delivered' : 'undelivered'
    const r = await supabase.rpc('lc_agent_text_delivery_record', { p_queue_row_id: clean(row.id), p_state: state, p_code: clean(code).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || null })
    if (clean(m.ai_message_id) && typeof supabase?.from === 'function') {
      await supabase.from('ai_generated_message_events').insert({ ai_message_id: clean(m.ai_message_id), event_type: state, queue_row_id: row.id, delivery_state: state, detail: { source: 'carrier_receipt' } })
    }
    return r?.error ? { ok: false, reason: 'append_failed' } : { ok: true, appended: r?.data?.appended === true, state }
  } catch {
    return { ok: false, reason: 'append_threw' }
  }
}
