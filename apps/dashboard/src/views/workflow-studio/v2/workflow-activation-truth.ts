import type { Workflow } from '../workflow.types'

/**
 * WORKFLOW-STUDIO-MOBILE-LOCK-1 §3/§4/§22 — what the list is allowed to claim.
 *
 * THE DEFECT. The catalog stamps `operational_mode: 'active_safe'` on all 14
 * published workflows, and the mobile row rendered `operational_mode` INSTEAD of
 * the lifecycle status, via `operational_mode.replace(/_/g, ' ')`. So every one
 * of them read as "active safe" — which an operator reads as "running, in a safe
 * mode". Measured against production on 2026-09-15, none of them can run:
 *
 *   - `matchDefinitions` (workflow-v2/execution-service.js) selects on
 *     trigger_type AND status='active'. All 14 are `published`, so the matcher
 *     never selects them. The only two `active` definitions are named "Test WF…".
 *   - Zero events of any `trigger.*` type have ever been emitted. Production
 *     emits `opportunity_created` / `opportunity_stage_changed` /
 *     `opportunity_manual_override` / `opportunity_status_changed`; the workflow
 *     library subscribes `trigger.inbound_message_received` and siblings. The
 *     namespaces are disjoint.
 *   - `/api/workflows/process` has no cron, so nothing advances an enrollment
 *     even if one existed.
 *
 * This module turns the measured evidence into one honest phrase. It introduces
 * NO new status: `workflow.status` remains the lifecycle authority and
 * `operational_mode` remains its qualifier. Everything here is derived from
 * fields the API measured, and an unmeasured field reports as unknown rather
 * than defaulting to a reassuring answer.
 */

export type ActivationTone = 'armed' | 'not-armed' | 'unsubscribed' | 'inert' | 'unknown'

export interface ActivationTruth {
  /** Short chip text for the row. */
  label: string
  tone: ActivationTone
  /** One line the operator can act on. Never speculative. */
  detail: string
  /** True only when this workflow can actually be entered right now. */
  canBeEntered: boolean
}

const formatWhen = (iso?: string | null): string => {
  if (!iso) return 'never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'never'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

export function describeActivation(workflow: Workflow): ActivationTruth {
  if (workflow.is_legacy) {
    return {
      label: 'read-only',
      tone: 'inert',
      detail: 'Legacy workflow. Read-only in V2 — it cannot be published or run.',
      canBeEntered: false,
    }
  }

  const trigger = (workflow.trigger_type ?? '').trim()
  if (!trigger) {
    return {
      label: 'no trigger',
      tone: 'inert',
      detail: 'No trigger configured, so nothing can enter this workflow.',
      canBeEntered: false,
    }
  }

  const events = workflow.trigger_event_count
  const matchable = workflow.trigger_matchable

  // Unmeasured is its own answer. Do not let a failed read look like calm.
  if (matchable == null || events == null) {
    return {
      label: 'unknown',
      tone: 'unknown',
      detail: `Could not measure trigger activity for ${trigger}. Treat its state as unverified.`,
      canBeEntered: false,
    }
  }

  // The status gate is the operator's nearest lever, so it leads — but the
  // detail must still say that the trigger has never fired, otherwise flipping
  // the status looks sufficient when it is not.
  if (!matchable) {
    const never = events === 0
    return {
      label: 'not armed',
      tone: 'not-armed',
      detail: never
        ? `Status is ${workflow.status}; the trigger matcher only selects status=active. ${trigger} has also never been emitted, so arming the status alone would not start it.`
        : `Status is ${workflow.status}; the trigger matcher only selects status=active. ${trigger} last fired ${formatWhen(workflow.trigger_last_seen_at)}.`,
      canBeEntered: false,
    }
  }

  if (events === 0) {
    return {
      label: 'never fired',
      tone: 'unsubscribed',
      detail: `Armed, but no ${trigger} event has ever been emitted, so nothing has entered this workflow.`,
      canBeEntered: true,
    }
  }

  return {
    label: 'armed',
    tone: 'armed',
    detail: `Armed on ${trigger} — ${events} event${events === 1 ? '' : 's'} observed, last ${formatWhen(workflow.trigger_last_seen_at)}.`,
    canBeEntered: true,
  }
}

/**
 * Whether this workflow can put a message in front of a seller, counted from
 * the graph. null means the count was not measurable (legacy steps are not
 * graph nodes) and must not be shown as "no sends".
 */
export function describeSendCapability(workflow: Workflow): { label: string; sends: boolean | null } {
  const count = workflow.send_node_count
  if (count == null) return { label: 'sends unknown', sends: null }
  if (count === 0) return { label: 'no sends', sends: false }
  return { label: count === 1 ? '1 send node' : `${count} send nodes`, sends: true }
}

/**
 * The lifecycle label. `operational_mode` is a QUALIFIER of the status, not a
 * replacement for it — returning it alone is what produced "active safe" for a
 * workflow whose status is `published` and which cannot run.
 */
export function lifecycleLabel(workflow: Workflow): string {
  const status = (workflow.status ?? '').trim() || 'unknown'
  const mode = (workflow.operational_mode ?? '').trim()
  if (!mode || mode === status) return status
  return `${status} · ${mode.replace(/_/g, ' ')}`
}
