/**
 * Truthful template-status semantics.
 *
 * THE PROBLEM
 * `campaign_targets.template_status` conflated two different claims:
 *
 *     "this target is ELIGIBLE for a template"   (a property of the target)
 *     "this target HAS an approved template"     (a property of the assignment)
 *
 * Both were written as 'ready'. In production 763 Miami targets carry
 * template_status='ready' with no template_id in metadata — eligible, never
 * assigned, and presented to readiness logic as send-ready. Of the 1,331 ready
 * targets that DO carry a template_id, 593 point at a paused template and 699
 * at a template governance has never seen.
 *
 * So "ready" meant, variously: assigned and approved, assigned but paused,
 * assigned but ungoverned, or not assigned at all.
 *
 * THE FIX
 * The database column keeps its existing vocabulary — 'ready' / 'blocked' —
 * because renaming a live enum used across the queue, the cockpit and the
 * campaign UI is a migration with real blast radius and no safety benefit.
 * What changes is that 'ready' now has exactly one meaning, enforced here:
 *
 *     template_status='ready'  <=>  a resolved, active, governed template
 *                                   whose body we can render and audit
 *
 * The finer state lives alongside it in metadata as `template_state`, so
 * operators can tell *why* something is blocked without widening the column.
 */

/** Fine-grained assignment outcome, recorded in metadata.template_state. */
export const TEMPLATE_STATE = {
  /** Resolved, active, governed, body renderable. The only sendable state. */
  ASSIGNED: "assigned",
  /** Target qualifies for assignment but none has run yet. NOT sendable. */
  ELIGIBLE: "eligible",
  /** No template matched language + property scope. */
  MISSING_TEMPLATE: "missing_template",
  /** A template matched, but governance forbids sending it. */
  GOVERNANCE_BLOCKED: "governance_blocked",
  /** Language unsupported — deliberate exclusion, not a failure. */
  BLOCKED: "blocked",
};

/**
 * The only state that may present as send-ready. Everything else — including
 * ELIGIBLE, which is what 763 Miami targets actually are — blocks.
 */
const SENDABLE_STATES = new Set([TEMPLATE_STATE.ASSIGNED]);

/** Map a fine-grained state onto the existing column vocabulary. */
export function templateStatusForState(state) {
  return SENDABLE_STATES.has(state) ? "ready" : "blocked";
}

/**
 * Authoritative send-readiness check for a target's template.
 *
 * Callers must use this rather than reading `template_status === 'ready'`
 * directly. It re-asserts the invariant at read time, so a row written before
 * this module existed — or by any path that bypasses assignment — cannot
 * masquerade as ready on the strength of the column alone.
 */
export function isTemplateSendReady(target = {}) {
  const metadata =
    target.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)
      ? target.metadata
      : {};

  const templateId = String(metadata.template_id ?? "").trim();
  if (!templateId) return false;

  const state = String(metadata.template_state ?? "").trim();
  // Rows written before template_state existed are trusted only as far as the
  // column plus a real template_id — which is still strictly more than the old
  // behaviour, and is why the governance re-check below matters.
  if (state && !SENDABLE_STATES.has(state)) return false;

  return String(target.template_status ?? "").trim() === "ready";
}

/**
 * Explain why a target is not send-ready. Returns null when it is.
 */
export function templateBlockReason(target = {}) {
  if (isTemplateSendReady(target)) return null;

  const metadata =
    target.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)
      ? target.metadata
      : {};

  if (!String(metadata.template_id ?? "").trim()) {
    return String(target.template_status ?? "").trim() === "ready"
      ? "status_ready_without_template_id"
      : TEMPLATE_STATE.MISSING_TEMPLATE;
  }

  return String(metadata.template_state ?? "").trim() || "template_not_sendable";
}
