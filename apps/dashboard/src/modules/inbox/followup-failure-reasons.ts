/**
 * Failure presentation for bulk follow-up scheduling.
 *
 * The load-bearing distinction: a CONTAINMENT refusal means a deliberate safety
 * control said no. A VALIDATION failure means the software could not assemble a
 * valid send. Presenting the second as the first hides real defects behind a
 * reassuring message -- which is exactly what happened when an unresolved
 * sending number was reported as "blocked by containment".
 *
 * Extracted from the sheet so the classification itself is testable.
 */

export const CONTAINMENT_REASONS: Record<string, string> = {
  followup_disabled: 'Blocked by containment: follow-up automation is disabled. Nothing was queued.',
  queue_runner_disabled: 'Blocked by containment: the queue runner is disabled. Nothing was queued.',
  outbound_sms_disabled: 'Blocked by containment: outbound SMS is disabled. Nothing was queued.',
  auto_reply_disabled: 'Blocked by containment: auto-reply is disabled. Nothing was queued.',
  paused_operator_review: 'Blocked: this conversation is paused for operator review. Nothing was queued.',
}

export const VALIDATION_REASONS: Record<string, string> = {
  invalid_from_phone_number: 'No valid sending number could be resolved. Nothing was queued.',
  no_eligible_sender_number: 'No eligible sending number is available for this conversation. Nothing was queued.',
  invalid_to_phone_number: 'The recipient number is not valid. Nothing was queued.',
  invalid_canonical_thread_key: 'This conversation could not be identified. Nothing was queued.',
  no_fus2_templates_available: 'No approved templates are available. Nothing was queued.',
  no_fus2_template_for_language: 'No approved follow-up template exists for this seller language. Nothing was queued.',
}

export type FailureKind = 'containment' | 'validation' | 'unknown'

export function classifyFailureReason(reason?: string | null): FailureKind {
  if (!reason) return 'unknown'
  if (CONTAINMENT_REASONS[reason]) return 'containment'
  if (VALIDATION_REASONS[reason]) return 'validation'
  return 'unknown'
}

/**
 * Operator-facing text. An unrecognised reason yields a NEUTRAL failure that
 * preserves the raw code -- never a containment claim, because an unidentified
 * defect must not be dressed up as a deliberate brake.
 */
export function describeFailureReason(reason?: string | null): string | null {
  if (!reason) return null
  return (
    CONTAINMENT_REASONS[reason] ??
    VALIDATION_REASONS[reason] ??
    `Scheduling failed. Nothing was queued. (${reason})`
  )
}
