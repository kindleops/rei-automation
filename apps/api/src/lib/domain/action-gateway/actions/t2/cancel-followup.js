// cancel_followup (T2, reversible, risk-lowering): the durable follow-up lifecycle's cancel path
// (followup-lifecycle#closeFollowUpIntentsForThread's writer public.followup_intent_close_for_thread, or the
// same statements for one intent by id) via the lease-bound action_gateway_dw_followup_cancel. A reason is
// required; unsent rows are cancelled in the same transaction. Allowed under a hold or a STOP (it only stops
// automation).
import { UUID, enumOf, obj } from '../../../../agent/capabilities/defs/_schema.js'
import { TIERS } from '../../constants.js'
import { client } from './_schema.js'
import { deny, allow, mustThread, threadResource } from './shared.js'
import { FOLLOWUP_KINDS } from './schedule-followup.js'

export const CANCEL_REASON_CODES = Object.freeze(['seller_replied', 'seller_requested_no_followups', 'duplicate', 'plan_changed', 'operator_requested', 'other'])

export const spec = {
  name: 'cancel_followup',
  title: 'Cancel a follow-up',
  description: 'Cancel one planned follow-up (by id) or every live follow-up of a thread (optionally one kind) through the follow-up lifecycle\'s cancel path; unsent rows are cancelled too. Always allowed: it only stops automation.',
  capability: 'followups.cancel', tier: TIERS.T2, resource: 'thread', reversible: true,
  input: obj({ ...client, thread_id: UUID, followup_intent_id: UUID, kind: enumOf(Object.keys(FOLLOWUP_KINDS)), reason_code: enumOf(CANCEL_REASON_CODES) }, ['client_request_id', 'thread_id', 'reason_code']),
  executor: { kind: 'domain_write', fn: 'action_gateway_dw_followup_cancel' },
  recovery: 'reexecute',
  limits: { per_min: 20 },
  wraps: { service: 'followups/followup-lifecycle#closeFollowUpIntentsForThread writer (public.followup_intent_close_for_thread), lease-bound', module: 'apps/api/src/lib/domain/followups/followup-lifecycle.js' },
  touches: ['followup_intent'],
}

export const logic = {
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  params(input, resource) {
    return { thread_id: resource.id, reason_code: input.reason_code, ...(input.followup_intent_id ? { followup_intent_id: input.followup_intent_id } : {}), ...(input.kind ? { kind: input.kind } : {}) }
  },
  async policy({ resource, params, services }) {
    if (params.followup_intent_id) {
      let live
      try { live = await services.t2.followups(resource.id) } catch { return deny('FOLLOWUPS_UNREADABLE') }
      if (!live.some((f) => String(f.followup_intent_id) === String(params.followup_intent_id))) return deny('FOLLOWUP_NOT_FOUND')
    }
    return allow({ risk: 'lowering' })
  },
}
