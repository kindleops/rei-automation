// rc-8.5.21 v3 (RT-44): a hold added AFTER a row was scheduled blocked the send at dispatch and recorded
// NO reason — the row looked merely "queued" forever. Every held action now leaves, ON THE ROW:
//   metadata.held_action = { reason, hold_type, hold_ids, capability, fail_closed, originating_event,
//                            resource, next_eligible_action, review_required, first_held_at, last_held_at,
//                            count }
// and ONE audited transition (automation_hold_events 'advancement_blocked', evidence.kind 'send_deferred') the first time a row is held by a
// given hold set. The row's status is untouched (a hold is reversible: the next claim re-checks it).
// Best-effort and never throws: the deferral itself never depends on the record.
const clean = (v) => String(v ?? '').trim()
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const SENDABLE = ['queued', 'pending', 'approved', 'ready', 'scheduled']

/** Pure: the held-action record for a row and a hold verdict. */
export function buildHeldActionRecord(row = {}, hold = {}, { capability = null, now = new Date().toISOString() } = {}) {
  const meta = obj(row.metadata)
  const prior = obj(meta.held_action)
  const hold_ids = (hold.hold_ids || []).map(String).sort()
  const same = JSON.stringify((prior.hold_ids || []).map(String).sort()) === JSON.stringify(hold_ids) && prior.reason === (hold.fail_closed ? 'automation_hold_lookup_failed' : 'automation_hold')
  return {
    reason: hold.fail_closed ? 'automation_hold_lookup_failed' : 'automation_hold',
    hold_type: clean(hold.holds?.[0]?.hold_type) || clean(hold.hold_type) || null,
    hold_ids,
    capability: clean(capability) || null,
    fail_closed: hold.fail_closed === true,
    originating_event: clean(meta.followup_intent_id) ? `followup_intent:${clean(meta.followup_intent_id)}` : clean(meta.source_event_id || row.source_event_id) ? `event:${clean(meta.source_event_id || row.source_event_id)}` : `queue_key:${clean(row.queue_key)}`,
    resource: { queue_row_id: clean(row.id) || null, thread_key: clean(row.thread_key) || null, property_id: clean(row.property_id) || null },
    next_eligible_action: 'dispatch_when_hold_released',
    review_required: hold.fail_closed ? 'hold_registry_unreadable_operator_check' : 'hold_owner_release_or_audited_override',
    first_held_at: same && prior.first_held_at ? prior.first_held_at : now,
    last_held_at: now,
    count: same ? Number(prior.count || 0) + 1 : 1,
    new_hold_set: !same,
  }
}

/** Stamp the record on the row (CAS: still sendable) and audit a NEW hold set once. Never throws. */
export async function recordHeldAction(row = {}, hold = {}, { supabase = null, capability = null, now = new Date().toISOString(), recordEvent = null } = {}) {
  const id = clean(row.id)
  if (!id || !supabase?.from) return { ok: false, reason: 'held_record_unwired' }
  const record = buildHeldActionRecord(row, hold, { capability, now })
  const { new_hold_set, ...held_action } = record
  try {
    const { error } = await supabase.from('send_queue').update({ metadata: { ...obj(row.metadata), held_action }, updated_at: now }).eq('id', id).in('queue_status', SENDABLE)
    if (error) return { ok: false, reason: clean(error.message) || 'held_record_write_failed' }
  } catch (error) {
    return { ok: false, reason: clean(error?.message) || 'held_record_write_failed' }
  }
  if (new_hold_set) {
    try {
      const write = recordEvent || (await import('@/lib/domain/holds/automation-hold.js')).recordAutomationHoldEvent
      await write({ event_type: 'advancement_blocked', scope: { thread_key: held_action.resource.thread_key, property_id: held_action.resource.property_id, master_owner_id: clean(row.master_owner_id) || null }, capability, hold_ids: held_action.hold_ids, evidence: { kind: 'send_deferred', queue_row_id: id, reason: held_action.reason, originating_event: held_action.originating_event, next_eligible_action: held_action.next_eligible_action }, supabase })
    } catch { /* the row record stands */ }
  }
  return { ok: true, held_action }
}
