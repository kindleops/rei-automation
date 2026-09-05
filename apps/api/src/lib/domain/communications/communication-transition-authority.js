/**
 * communication-transition-authority.js
 *
 * THE single authority for changing what Reivesti may do with a seller
 * communication. No handler writes `state`, `delivery_possibility`,
 * `retry_authority` or `retry_after_at` directly.
 *
 * THREE INDEPENDENT AXES, deliberately not collapsed:
 *
 *   state                 what stage of execution this action is in
 *   delivery_possibility  could the seller have received it?
 *   retry_authority       may another provider attempt happen automatically?
 *
 *   The second and third answer different questions. A provider rejecting an
 *   invalid phone number PROVES the seller received nothing
 *   (definitely_not_sent) while granting no retry at all (terminal). A timeout
 *   proves nothing about delivery (may_have_been_sent) and must also deny retry
 *   (retry_denied). Collapsing them into one "retryable" boolean is exactly how
 *   the Slice 0 duplicate-send defect was built, so this module refuses to
 *   expose such a boolean as authority.
 *
 * EVERY transition requires a CAUSE. A caller may not simply ask for
 * `state = delivered`; it must say which evidence authorises that, and the
 * cause must be compatible with the edge. This is what stops a convenient
 * "just mark it failed" from erasing an uncertain external side effect.
 */

export const COMMUNICATION_TRANSITION_POLICY_VERSION = "comm_transition_v1";
export const DELIVERY_POSSIBILITY_POLICY_VERSION = "delivery_possibility_v1";
export const RETRY_AUTHORITY_POLICY_VERSION = "retry_authority_v1";
export const ATTEMPT_TRANSITION_POLICY_VERSION = "attempt_transition_v1";
export const TRANSPORT_OUTCOME_MAPPING_POLICY_VERSION = "transport_outcome_map_v1";

// ── domains ────────────────────────────────────────────────────────────────

export const LOGICAL_STATES = Object.freeze({
  CREATED: "created",
  READY: "ready",
  CLAIMED: "claimed",
  PROVIDER_REQUEST_STARTED: "provider_request_started",
  PROVIDER_ACCEPTED: "provider_accepted",
  AMBIGUOUS: "ambiguous_provider_outcome",
  FAILED_RETRY_ALLOWED: "failed_retry_allowed",
  FAILED_TERMINAL: "failed_terminal",
  RECONCILIATION_PENDING: "reconciliation_pending",
  DELIVERED: "delivered",
  SUPPRESSED: "suppressed",
  NO_SEND: "no_send",
  CANCELLED: "cancelled",
});

export const DELIVERY_POSSIBILITY = Object.freeze({
  DEFINITELY_NOT_SENT: "definitely_not_sent",
  MAY_HAVE_BEEN_SENT: "may_have_been_sent",
  PROVIDER_ACCEPTED: "provider_accepted",
  DELIVERED: "delivered",
  UNKNOWN: "unknown",
});

export const RETRY_AUTHORITY = Object.freeze({
  RETRY_ALLOWED: "retry_allowed",
  RETRY_AFTER: "retry_after",
  RETRY_DENIED: "retry_denied",
  OPERATOR_HOLD: "operator_hold",
  TERMINAL: "terminal",
});

export const ATTEMPT_STATES = Object.freeze({
  CREATED: "created",
  CLAIMED: "claimed",
  PROVIDER_REQUEST_STARTED: "provider_request_started",
  PROVIDER_ACCEPTED: "provider_accepted",
  AMBIGUOUS: "ambiguous",
  FAILED_PROVABLY_UNSENT: "failed_provably_unsent",
  FAILED_TERMINAL: "failed_terminal",
  COMPLETED: "completed",
});

/** Why a transition is being requested. A transition without a cause is refused. */
export const TRANSITION_CAUSES = Object.freeze({
  DOMAIN_ACTION_CREATED: "domain_action_created",
  RUNTIME_READY: "runtime_ready",
  ATTEMPT_CLAIMED: "attempt_claimed",
  PROVIDER_REQUEST_START_RECORDED: "provider_request_start_recorded",
  PROVIDER_DEFINITIVE_REJECTION: "provider_definitive_rejection",
  PROVIDER_TRANSPORT_AMBIGUOUS: "provider_transport_ambiguous",
  PROVIDER_SID_OBSERVED: "provider_sid_observed",
  PROVIDER_DELIVERY_OBSERVED: "provider_delivery_observed",
  RETRY_BACKOFF: "retry_backoff",
  RETRY_WINDOW_ELAPSED: "retry_window_elapsed",
  RUNTIME_SUPPRESSION: "runtime_suppression",
  OPERATOR_CANCELLATION: "operator_cancellation",
  INTERNAL_NO_SEND: "internal_no_send",
  CONFIGURATION_HOLD: "configuration_hold",
  RECONCILIATION: "reconciliation",
});

// ── logical state edges ────────────────────────────────────────────────────
//
// Absent from a state's successor list == forbidden. Terminal states list no
// successors at all: a genuinely new business action must create a NEW logical
// communication rather than reopening a resolved one.

const S = LOGICAL_STATES;

export const LOGICAL_STATE_EDGES = Object.freeze({
  [S.CREATED]: [S.READY, S.SUPPRESSED, S.NO_SEND, S.CANCELLED],
  [S.READY]: [S.CLAIMED, S.SUPPRESSED, S.NO_SEND, S.CANCELLED],
  [S.CLAIMED]: [S.PROVIDER_REQUEST_STARTED, S.READY, S.FAILED_TERMINAL, S.CANCELLED],
  // From here the network may have happened. Note there is no path back to
  // READY or CLAIMED except via an explicit provably-unsent outcome.
  [S.PROVIDER_REQUEST_STARTED]: [
    S.PROVIDER_ACCEPTED,
    S.AMBIGUOUS,
    S.FAILED_RETRY_ALLOWED,
    S.FAILED_TERMINAL,
    S.RECONCILIATION_PENDING,
  ],
  [S.PROVIDER_ACCEPTED]: [S.DELIVERED, S.RECONCILIATION_PENDING, S.FAILED_TERMINAL],
  // ABSORBING for send authority. Only reconciliation may move it, and Slice 1
  // deliberately provides no edge back to a sendable state.
  [S.AMBIGUOUS]: [S.RECONCILIATION_PENDING, S.DELIVERED, S.PROVIDER_ACCEPTED],
  [S.FAILED_RETRY_ALLOWED]: [S.READY, S.FAILED_TERMINAL, S.CANCELLED, S.NO_SEND],
  [S.RECONCILIATION_PENDING]: [S.DELIVERED, S.PROVIDER_ACCEPTED, S.FAILED_TERMINAL, S.AMBIGUOUS],
  // Terminal.
  [S.DELIVERED]: [],
  [S.FAILED_TERMINAL]: [],
  [S.SUPPRESSED]: [],
  [S.NO_SEND]: [],
  [S.CANCELLED]: [],
});

/** States from which a provider attempt may ever be allocated. */
export const STATES_ALLOWING_ATTEMPT = Object.freeze([S.CREATED, S.READY, S.FAILED_RETRY_ALLOWED]);

/** States that are final: no successor, no attempt, ever. */
export const TERMINAL_STATES = Object.freeze([
  S.DELIVERED, S.FAILED_TERMINAL, S.SUPPRESSED, S.NO_SEND, S.CANCELLED,
]);

// ── delivery possibility edges ─────────────────────────────────────────────
//
// Knowledge may become MORE authoritative. It may not casually regress.
// `may_have_been_sent -> definitely_not_sent` is deliberately absent: proving a
// negative requires authoritative provider evidence that Slice 1 cannot obtain
// (TextGrid offers no caller idempotency key and no verified lookup). Slice 2
// may introduce that edge with a specific reconciliation proof.

const D = DELIVERY_POSSIBILITY;

export const DELIVERY_POSSIBILITY_EDGES = Object.freeze({
  [D.UNKNOWN]: [D.DEFINITELY_NOT_SENT, D.MAY_HAVE_BEEN_SENT, D.PROVIDER_ACCEPTED, D.DELIVERED],
  [D.DEFINITELY_NOT_SENT]: [D.MAY_HAVE_BEEN_SENT, D.PROVIDER_ACCEPTED, D.DELIVERED],
  [D.MAY_HAVE_BEEN_SENT]: [D.PROVIDER_ACCEPTED, D.DELIVERED],
  [D.PROVIDER_ACCEPTED]: [D.DELIVERED],
  [D.DELIVERED]: [],
});

// ── retry authority edges ──────────────────────────────────────────────────

const R = RETRY_AUTHORITY;

export const RETRY_AUTHORITY_EDGES = Object.freeze({
  [R.RETRY_ALLOWED]: [R.RETRY_AFTER, R.RETRY_DENIED, R.OPERATOR_HOLD, R.TERMINAL],
  [R.RETRY_AFTER]: [R.RETRY_ALLOWED, R.RETRY_DENIED, R.OPERATOR_HOLD, R.TERMINAL],
  [R.RETRY_DENIED]: [R.TERMINAL, R.OPERATOR_HOLD],
  [R.OPERATOR_HOLD]: [R.RETRY_ALLOWED, R.TERMINAL, R.RETRY_DENIED],
  [R.TERMINAL]: [],
});

/** Retry states that permit an automatic provider attempt. */
export const AUTOMATIC_RETRY_STATES = Object.freeze([R.RETRY_ALLOWED, R.RETRY_AFTER]);

// ── attempt edges ──────────────────────────────────────────────────────────

const A = ATTEMPT_STATES;

export const ATTEMPT_STATE_EDGES = Object.freeze({
  [A.CREATED]: [A.CLAIMED],
  [A.CLAIMED]: [A.PROVIDER_REQUEST_STARTED, A.FAILED_TERMINAL],
  [A.PROVIDER_REQUEST_STARTED]: [
    A.PROVIDER_ACCEPTED, A.AMBIGUOUS, A.FAILED_PROVABLY_UNSENT, A.FAILED_TERMINAL,
  ],
  [A.PROVIDER_ACCEPTED]: [A.COMPLETED],
  [A.FAILED_PROVABLY_UNSENT]: [A.COMPLETED],
  [A.FAILED_TERMINAL]: [A.COMPLETED],
  // An ambiguous attempt is NOT completed by time passing. Only authoritative
  // reconciliation may resolve it, which Slice 2 owns.
  [A.AMBIGUOUS]: [A.PROVIDER_ACCEPTED, A.COMPLETED],
  [A.COMPLETED]: [],
});

// ── which evidence authorises which outcome ────────────────────────────────
//
// A cause may only produce the delivery facts it actually evidences. This is
// what stops `runtime_suppression` from quietly erasing a provider acceptance,
// or a convenience "mark failed" from claiming a message was never sent.

const CAUSE_ALLOWED_DELIVERY = Object.freeze({
  [TRANSITION_CAUSES.PROVIDER_DEFINITIVE_REJECTION]: [D.DEFINITELY_NOT_SENT],
  [TRANSITION_CAUSES.PROVIDER_TRANSPORT_AMBIGUOUS]: [D.MAY_HAVE_BEEN_SENT],
  [TRANSITION_CAUSES.PROVIDER_SID_OBSERVED]: [D.PROVIDER_ACCEPTED],
  [TRANSITION_CAUSES.PROVIDER_DELIVERY_OBSERVED]: [D.DELIVERED],
  [TRANSITION_CAUSES.RECONCILIATION]: [D.PROVIDER_ACCEPTED, D.DELIVERED, D.MAY_HAVE_BEEN_SENT],
});

/** Causes that may drive a communication into a non-send terminal state. */
const NO_SEND_CAUSES = Object.freeze([
  TRANSITION_CAUSES.INTERNAL_NO_SEND,
  TRANSITION_CAUSES.RUNTIME_SUPPRESSION,
  TRANSITION_CAUSES.OPERATOR_CANCELLATION,
]);

function clean(value) {
  return String(value ?? "").trim();
}

function refuse(reason, detail = {}) {
  return { ok: false, reason, ...detail };
}

/**
 * Validate a requested transition. Pure: no I/O, no clock, no randomness, so it
 * is fully deterministic and replayable.
 *
 * @param {object} args
 * @param {object} args.current  { state, delivery_possibility, retry_authority, retry_after_at }
 * @param {object} args.requested { state?, delivery_possibility?, retry_authority?, retry_after_at? }
 * @param {string} args.cause     one of TRANSITION_CAUSES
 * @param {string} [args.now]     ISO time, injected. Never read from a clock here.
 * @returns {{ok:true, next:object} | {ok:false, reason:string}}
 */
export function evaluateLogicalTransition({ current = {}, requested = {}, cause, now = null } = {}) {
  const cause_id = clean(cause);
  if (!cause_id) return refuse("transition_cause_required");
  if (!Object.values(TRANSITION_CAUSES).includes(cause_id)) {
    return refuse("unknown_transition_cause", { cause: cause_id });
  }

  const from_state = clean(current.state);
  const from_delivery = clean(current.delivery_possibility);
  const from_retry = clean(current.retry_authority);

  if (!LOGICAL_STATE_EDGES[from_state]) return refuse("unknown_current_state", { from_state });
  if (from_delivery && !DELIVERY_POSSIBILITY_EDGES[from_delivery]) {
    return refuse("unknown_current_delivery_possibility", { from_delivery });
  }
  if (from_retry && !RETRY_AUTHORITY_EDGES[from_retry]) {
    return refuse("unknown_current_retry_authority", { from_retry });
  }

  // Requested values default to "unchanged" so a caller may move one axis alone.
  const to_state = clean(requested.state) || from_state;
  const to_delivery = clean(requested.delivery_possibility) || from_delivery;
  const to_retry = clean(requested.retry_authority) || from_retry;
  const to_retry_after_at = requested.retry_after_at ?? (to_retry === from_retry ? current.retry_after_at ?? null : null);

  // ── 1. state edge ────────────────────────────────────────────────────────
  if (to_state !== from_state) {
    const allowed = LOGICAL_STATE_EDGES[from_state] ?? [];
    if (!allowed.includes(to_state)) {
      return refuse("illegal_state_transition", { from_state, to_state });
    }
  }

  // ── 2. delivery possibility edge ─────────────────────────────────────────
  if (to_delivery !== from_delivery) {
    const allowed = DELIVERY_POSSIBILITY_EDGES[from_delivery] ?? [];
    if (!allowed.includes(to_delivery)) {
      return refuse("illegal_delivery_possibility_transition", { from_delivery, to_delivery });
    }
    // The cause must actually evidence this delivery fact.
    const permitted = CAUSE_ALLOWED_DELIVERY[cause_id];
    if (permitted && !permitted.includes(to_delivery)) {
      return refuse("cause_does_not_evidence_delivery_possibility", { cause: cause_id, to_delivery });
    }
    if (!permitted) {
      return refuse("cause_cannot_change_delivery_possibility", { cause: cause_id, to_delivery });
    }
  }

  // ── 3. retry authority edge ──────────────────────────────────────────────
  if (to_retry !== from_retry) {
    const allowed = RETRY_AUTHORITY_EDGES[from_retry] ?? [];
    if (!allowed.includes(to_retry)) {
      return refuse("illegal_retry_authority_transition", { from_retry, to_retry });
    }

    // Regaining automatic retry is the single most dangerous move in the model,
    // so it carries the strictest preconditions.
    if (AUTOMATIC_RETRY_STATES.includes(to_retry)) {
      if (to_delivery !== D.DEFINITELY_NOT_SENT) {
        return refuse("automatic_retry_requires_proven_unsent", { to_delivery, to_retry });
      }
      if (from_retry === R.RETRY_AFTER && to_retry === R.RETRY_ALLOWED) {
        if (cause_id !== TRANSITION_CAUSES.RETRY_WINDOW_ELAPSED) {
          return refuse("retry_window_requires_elapsed_cause", { cause: cause_id });
        }
        const deadline = current.retry_after_at ? Date.parse(current.retry_after_at) : NaN;
        const at = now ? Date.parse(now) : NaN;
        if (!Number.isFinite(deadline) || !Number.isFinite(at)) {
          return refuse("retry_window_requires_deadline_and_now");
        }
        if (at < deadline) return refuse("retry_window_not_elapsed", { retry_after_at: current.retry_after_at });
      }
      if (from_retry === R.OPERATOR_HOLD && cause_id !== TRANSITION_CAUSES.CONFIGURATION_HOLD) {
        return refuse("operator_hold_release_requires_remediation_cause", { cause: cause_id });
      }
    }
  }

  // ── 4. cross-field invariants (mirror the database CHECKs) ───────────────
  const ambiguous_now = to_state === S.AMBIGUOUS || to_delivery === D.MAY_HAVE_BEEN_SENT;
  if (ambiguous_now && AUTOMATIC_RETRY_STATES.includes(to_retry)) {
    return refuse("ambiguous_outcome_cannot_hold_retry_authority", { to_state, to_delivery, to_retry });
  }
  if (TERMINAL_STATES.includes(to_state) && AUTOMATIC_RETRY_STATES.includes(to_retry)) {
    return refuse("terminal_state_cannot_hold_retry_authority", { to_state, to_retry });
  }
  if ([D.PROVIDER_ACCEPTED, D.DELIVERED].includes(to_delivery) && AUTOMATIC_RETRY_STATES.includes(to_retry)) {
    return refuse("accepted_or_delivered_cannot_hold_retry_authority", { to_delivery, to_retry });
  }

  // ── 5. retry_after_at pairing ────────────────────────────────────────────
  // A stale deadline left on a non-retry_after row is a loaded gun: any scanner
  // reading retry_after_at would treat the row as due.
  if (to_retry === R.RETRY_AFTER && !to_retry_after_at) {
    return refuse("retry_after_requires_retry_after_at");
  }
  if (to_retry !== R.RETRY_AFTER && to_retry_after_at) {
    return refuse("retry_after_at_only_valid_with_retry_after", { to_retry });
  }

  // ── 6. non-send terminals need an authorising cause ──────────────────────
  if ([S.NO_SEND, S.SUPPRESSED, S.CANCELLED].includes(to_state) && to_state !== from_state) {
    if (!NO_SEND_CAUSES.includes(cause_id)) {
      return refuse("no_send_requires_authorising_cause", { to_state, cause: cause_id });
    }
    // Concealing an uncertain external side effect behind "no send" would lose
    // the one fact reconciliation needs.
    if (from_delivery === D.MAY_HAVE_BEEN_SENT || from_delivery === D.PROVIDER_ACCEPTED) {
      return refuse("cannot_mark_no_send_after_possible_transmission", { from_delivery, to_state });
    }
  }

  const changed =
    to_state !== from_state ||
    to_delivery !== from_delivery ||
    to_retry !== from_retry ||
    (to_retry_after_at ?? null) !== (current.retry_after_at ?? null);

  return {
    ok: true,
    changed,
    next: {
      state: to_state,
      delivery_possibility: to_delivery,
      retry_authority: to_retry,
      retry_after_at: to_retry_after_at ?? null,
    },
    cause: cause_id,
    policy_versions: {
      communication_transition: COMMUNICATION_TRANSITION_POLICY_VERSION,
      delivery_possibility: DELIVERY_POSSIBILITY_POLICY_VERSION,
      retry_authority: RETRY_AUTHORITY_POLICY_VERSION,
    },
  };
}

/** Attempt-level edge validation. Same shape, same strictness. */
export function evaluateAttemptTransition({ from, to } = {}) {
  const f = clean(from);
  const t = clean(to);
  if (!ATTEMPT_STATE_EDGES[f]) return refuse("unknown_current_attempt_state", { from: f });
  if (!ATTEMPT_STATE_EDGES[t] && t !== "") return refuse("unknown_requested_attempt_state", { to: t });
  if (f === t) return { ok: true, changed: false, next: t };
  if (!(ATTEMPT_STATE_EDGES[f] ?? []).includes(t)) {
    return refuse("illegal_attempt_transition", { from: f, to: t });
  }
  return {
    ok: true,
    changed: true,
    next: t,
    policy_version: ATTEMPT_TRANSITION_POLICY_VERSION,
  };
}

/** May a provider attempt be allocated for this communication right now? */
export function canAllocateAttempt(current = {}) {
  const state = clean(current.state);
  const delivery = clean(current.delivery_possibility);
  const retry = clean(current.retry_authority);

  if (delivery === D.MAY_HAVE_BEEN_SENT) return refuse("ambiguous_outcome_absorbing");
  if (state === S.AMBIGUOUS) return refuse("ambiguous_outcome_absorbing");
  if (!STATES_ALLOWING_ATTEMPT.includes(state)) return refuse("state_forbids_attempt", { state });
  if (!AUTOMATIC_RETRY_STATES.includes(retry)) return refuse("retry_authority_denies", { retry });
  return { ok: true };
}

export default evaluateLogicalTransition;
