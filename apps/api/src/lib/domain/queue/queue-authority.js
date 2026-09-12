/**
 * OPS-1 — GENERATION vs QUEUE vs DISPATCH AUTHORITY.
 *
 * THE DEFECT. `auto_reply_mode = live_limited` produced a dispatchable
 * `queued` row for a real seller. Nothing stopped it becoming executable;
 * `queue_processor_mode = safe` merely happened to prevent the cron from
 * picking it up. Containment held by coincidence, not by construction — and
 * the row would have sent the instant processor mode flipped.
 *
 * THE FIX. Three authorities that were previously one:
 *
 *   generation_authority — may compose a candidate message
 *   queue_authority      — may create an EXECUTABLE row
 *   dispatch_authority   — may hand a row to the provider
 *
 * Being allowed to write a reply is not permission to schedule it, and having
 * a scheduled row is not permission to send it. Under containment an agent
 * keeps full generation authority (the content is useful for review) while
 * queue authority degrades to `review_hold` — so the contained system produces
 * a proposal, never a dispatchable row.
 *
 * THE RELEASE BOUNDARY. `execution_enrolled_at` is what makes flipping
 * processor mode safe: the dispatcher considers only enrolled rows, so rows
 * accumulated during containment cannot wake up. A row enrols when it is
 * created under live authority, or by explicit reauthorization — never by a
 * mode change.
 *
 * REVALIDATION. A row that was valid when queued is not valid now. Anything
 * that sat through containment must re-prove its objective, suppression,
 * template governance, sender health, contact window and authorization scope
 * immediately before the provider call.
 */

const clean = (value) => String(value ?? '').trim()

export const AUTHORITY = Object.freeze({
  GENERATION: 'generation_authority',
  QUEUE: 'queue_authority',
  DISPATCH: 'dispatch_authority',
})

/** What a producer is permitted to create. */
export const QUEUE_DISPOSITION = Object.freeze({
  EXECUTABLE: 'executable',
  REVIEW_HOLD: 'review_hold',
  PLANNED: 'planned',
  NON_EXECUTABLE: 'non_executable',
})

/** Canonical non-executable queue status already used in production. */
export const REVIEW_HOLD_STATUS = 'paused_operator_review'

export const EXECUTABLE_STATUSES = Object.freeze([
  'queued', 'pending', 'processing', 'scheduled', 'locked', 'retry',
])

export const EXECUTION_POLICY_VERSION = 'ops1_execution_enrollment_v1'

function containmentActive({ queue_processor_mode, queue_execution_mode } = {}) {
  const processor = clean(queue_processor_mode).toLowerCase()
  const execution = clean(queue_execution_mode).toLowerCase()
  // Absent control values count as contained. An unreadable control plane is
  // not a licence to create executable rows.
  if (!processor || !execution) return true
  return processor !== 'live' || execution !== 'live'
}

/**
 * What may this producer create right now?
 *
 * `scoped_canary` is the single exception: an explicitly allowlisted, single-use
 * authorization may still produce an executable row, because that mechanism
 * carries its own exact-row scope and consumption.
 */
export function resolveQueueAuthority({
  producer = null,
  control = {},
  scoped_canary_authorization = null,
} = {}) {
  const contained = containmentActive(control)
  const source = clean(producer) || 'unknown'

  if (!contained) {
    return {
      disposition: QUEUE_DISPOSITION.EXECUTABLE,
      generation_authority: true,
      queue_authority: true,
      queue_status: 'queued',
      execution_enrolled: true,
      execution_policy_version: EXECUTION_POLICY_VERSION,
      reason: 'live_execution_mode',
      producer: source,
    }
  }

  if (scoped_canary_authorization?.valid === true && Array.isArray(scoped_canary_authorization.queue_row_ids)) {
    return {
      disposition: QUEUE_DISPOSITION.EXECUTABLE,
      generation_authority: true,
      queue_authority: true,
      queue_status: 'queued',
      execution_enrolled: true,
      execution_policy_version: EXECUTION_POLICY_VERSION,
      reason: 'scoped_canary_authorization',
      scoped: true,
      allowlist: scoped_canary_authorization.queue_row_ids,
      producer: source,
    }
  }

  // The ordinary contained path. Content may still be composed — it is useful
  // for an operator — but it lands non-executable and unenrolled.
  return {
    disposition: QUEUE_DISPOSITION.REVIEW_HOLD,
    generation_authority: true,
    queue_authority: false,
    queue_status: REVIEW_HOLD_STATUS,
    execution_enrolled: false,
    execution_policy_version: null,
    reason: 'containment_active_generation_only',
    producer: source,
  }
}

/**
 * Is this row visible to the dispatcher?
 *
 * Enrollment is checked FIRST. An unenrolled row is out of scope entirely, not
 * "not yet due" — reporting it as merely un-due invites someone to fix the
 * timing later and release the backlog.
 */
export function isDispatchEligible(row = {}, { control = {} } = {}) {
  if (!row.execution_enrolled_at) {
    return {
      eligible: false,
      reason: 'not_execution_enrolled',
      requires_reauthorization: true,
    }
  }
  if (!EXECUTABLE_STATUSES.includes(clean(row.queue_status))) {
    return { eligible: false, reason: `queue_status_not_executable:${clean(row.queue_status)}` }
  }
  if (containmentActive(control) && !row.scoped_canary_authorization_id) {
    return { eligible: false, reason: 'containment_active_without_scoped_authorization' }
  }
  return { eligible: true, reason: null }
}

/**
 * Re-prove a queued row immediately before the provider call.
 *
 * Every check is a refusal reason. A row that sat through containment is the
 * dangerous case: the seller may have replied, opted out, or moved objective
 * while it waited, and "it was valid when we queued it" is not a reason to
 * send it now.
 */
export function revalidateBeforeDispatch({
  row = {},
  current_objective = null,
  new_inbound_since_plan = false,
  suppressed = false,
  dnc = false,
  contact_relationship_valid = true,
  current_stage = null,
  current_strategy = null,
  template_governed = true,
  sender_health = null,
  inside_contact_window = true,
  authorization_scope_valid = true,
} = {}) {
  const blockers = []

  // Compliance first — these are terminal regardless of anything else.
  if (suppressed) blockers.push('suppressed')
  if (dnc) blockers.push('dnc')

  // A reply while the row waited means the conversation moved on.
  if (new_inbound_since_plan) blockers.push('new_inbound_supersedes_queued_reply')

  const plannedObjective = clean(row.objective ?? row.use_case_template)
  const nowObjective = clean(current_objective)
  if (plannedObjective && nowObjective && plannedObjective !== nowObjective) {
    blockers.push(`objective_changed:${plannedObjective}->${nowObjective}`)
  }

  const plannedStage = clean(row.current_stage)
  if (plannedStage && current_stage && plannedStage !== clean(current_stage)) {
    blockers.push(`stage_changed:${plannedStage}->${clean(current_stage)}`)
  }

  const plannedStrategy = clean(row.strategy)
  if (plannedStrategy && current_strategy && plannedStrategy !== clean(current_strategy)) {
    blockers.push(`strategy_changed:${plannedStrategy}->${clean(current_strategy)}`)
  }

  if (!contact_relationship_valid) blockers.push('contact_relationship_invalid')
  if (!template_governed) blockers.push('template_not_governed')
  if (sender_health && sender_health !== 'active_healthy') blockers.push(`sender_not_healthy:${sender_health}`)
  if (!inside_contact_window) blockers.push('outside_contact_window')
  if (!authorization_scope_valid) blockers.push('authorization_scope_invalid')

  return {
    ok: blockers.length === 0,
    blockers,
    // A failed revalidation SUPERSEDES rather than deletes: the row and its
    // body stay as evidence of what we nearly sent.
    action: blockers.length === 0 ? 'dispatch' : 'hold_supersede',
    provider_attempts: 0,
  }
}

export default resolveQueueAuthority
