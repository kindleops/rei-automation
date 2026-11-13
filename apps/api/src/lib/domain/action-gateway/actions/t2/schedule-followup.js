// schedule_followup (T2, reversible): plan ONE follow-up through THE durable follow-up lifecycle
// (followup-lifecycle#planFollowUpIntent's writer, public.followup_intent_plan, via the lease-bound
// action_gateway_dw_followup_schedule). Every guard runs here AND again in the database / at materialization:
//   * holds AT PLAN (R7): the hold authority here, public.automation_hold_for in the write's own transaction;
//   * STOP / opt-out / suppression / wrong number / property denial: the send-time contact guard on the
//     would-be row and the thread's own suppression;
//   * no selling nurture after an ownership answer: followup-lifecycle#propertyContactBlock (a decline to the
//     ownership question is declined_unverified, held; a bare "No" is a property denial);
//   * the contact-window category: a follow-up is ALWAYS scheduled_followup (recipient-local hours applied at
//     materialization), never the 24/7 active-conversation category;
//   * "not interested" is the 30-day nurture: its due date is at least 21 days out.
// BORN UNDER followup_execution_mode OFF: the plan is recorded; only the lifecycle's own switch ('live')
// materializes it, re-checking every guard at due time.
import { UUID, enumOf, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { TIERS } from '../../constants.js'
import { client, ISO_TIME } from './_schema.js'
import { holdVerdict, neverReviveCode, deny, allow, mustThread, threadResource, permissionOf } from './shared.js'

export const FOLLOWUP_KINDS = Object.freeze({
  seller_requested_callback: Object.freeze({ intent: 'seller_callback', use_case: 'nurture_seller_callback', min_days: 0 }),
  not_interested_nurture: Object.freeze({ intent: 'not_interested', use_case: 'nurture_not_interested', min_days: 21 }),
})
export const FOLLOWUP_REASON_CODES = Object.freeze(['seller_asked_for_callback', 'seller_needs_time', 'not_interested_30_day', 'operator_requested', 'other'])
const DAY = 86_400_000

export const spec = {
  name: 'schedule_followup',
  title: 'Schedule a follow-up',
  description: 'Plan one follow-up (a seller-requested callback, or the 30-day not-interested nurture) in the durable follow-up lifecycle. Refused when the thread is held, opted out, suppressed, denied for this property, or its latest reply declined the ownership question. Planning records the intent; sending only ever follows the lifecycle\'s own switch and its guards at due time.',
  capability: 'followups.schedule', tier: TIERS.T2, resource: 'thread', reversible: true,
  input: obj({ ...client, thread_id: UUID, kind: enumOf(Object.keys(FOLLOWUP_KINDS)), due_at: ISO_TIME, reason_code: enumOf(FOLLOWUP_REASON_CODES) }, ['client_request_id', 'thread_id', 'kind', 'due_at', 'reason_code']),
  executor: { kind: 'domain_write', fn: 'action_gateway_dw_followup_schedule' },
  recovery: 'reexecute',
  limits: { per_min: 10 },
  wraps: { service: 'followups/followup-lifecycle#planFollowUpIntent writer (public.followup_intent_plan), lease-bound', module: 'apps/api/src/lib/domain/followups/followup-lifecycle.js' },
  touches: ['followup_intent'],
}

export const logic = {
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  params(input, resource) {
    const k = FOLLOWUP_KINDS[input.kind]
    const t = Date.parse(input.due_at)
    return { thread_id: resource.id, kind: input.kind, intent: k.intent, use_case: k.use_case, due_at: Number.isFinite(t) ? new Date(t).toISOString() : String(input.due_at), reason_code: input.reason_code }
  },
  async policy({ resource, params, reads, services, now }) {
    const r = resource.refs
    const never = neverReviveCode({ thread_id: r.thread_id, thread_key: r.thread_key, property_id: r.property_id })
    if (never) return deny(never)
    const due = Date.parse(params.due_at)
    const t = now()
    if (!Number.isFinite(due) || due < t + 10 * 60_000 || due > t + 120 * DAY) return deny('DUE_AT_OUT_OF_BOUNDS')
    if (due < t + FOLLOWUP_KINDS[params.kind].min_days * DAY) return deny('NURTURE_TOO_SOON', { min_days: FOLLOWUP_KINDS[params.kind].min_days })
    const { classifyMessagingCategory, MESSAGING_CATEGORIES } = await import('../../../queue/recipient-window-policy.js')
    const category = classifyMessagingCategory({ kind: 'followup' }).category
    if (category !== MESSAGING_CATEGORIES.SCHEDULED_FOLLOWUP) return deny('CONTACT_WINDOW_CATEGORY_REFUSED', { category })
    const h = await holdVerdict(services, { threadKey: r.thread_key, threadId: r.thread_id, propertyId: r.property_id }, 'followup_enqueue')
    if (h) return h
    const perm = await permissionOf(reads, resource)
    if (perm.blocked) return deny(perm.reasons.includes('stop_requested') ? 'STOP_REQUESTED' : 'CONTACT_NOT_PERMITTED', { reasons: perm.reasons })
    // no selling nurture after an ownership answer / a property denial (the lifecycle's own rule; the
    // ownership-reply check applies to EVERY kind here, stricter than the scheduler)
    let block
    try { block = await services.t2.propertyContactBlock({ thread_key: r.thread_key, phone: r.thread_key, property_id: r.property_id, kind: 'not_interested_nurture' }) } catch { return deny('OWNERSHIP_FACTS_UNREADABLE') }
    if (block?.blocked) return deny(block.kind === 'property_denial' ? 'PROPERTY_DENIAL' : 'OWNERSHIP_DECLINED_UNVERIFIED', { reason: block.reason })
    let g
    try {
      g = await services.t2.sendTimeGuard({ thread_key: r.thread_key, to_phone_number: r.thread_key, property_id: r.property_id, use_case_template: params.use_case, type: 'followup', message_type: 'follow_up', metadata: { source: 'action_gateway' } })
    } catch { return deny('SEND_TIME_GUARD_UNREADABLE') }
    if (g?.blocked) return deny(`SEND_TIME_GUARD_${String(g.reason || 'BLOCKED').toUpperCase()}`.slice(0, 80), { reason: g.reason || null })
    return allow({ category, plan_only: true, execution: 'follows system_control.followup_execution_mode' })
  },
}
