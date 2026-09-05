/**
 * canonical-communication-dispatch.js
 *
 * THE one place a seller-visible message may reach a provider.
 *
 * Every seller send resolves to a domain action, then to a logical
 * communication, then to a numbered attempt, and only then to the network. No
 * caller decides for itself whether a retry is safe, whether ambiguity may
 * resend, whether provider evidence may be cleared, or whether a queue status
 * means permission.
 *
 * THE ORDERING GUARANTEE THAT MATTERS MOST
 *
 *   provider_request_started_at is persisted AND its write is confirmed BEFORE
 *   the network call. If that persistence fails, the provider is never invoked.
 *
 *   This deliberately creates a conservative crash window: if the process dies
 *   between the marker committing and fetch() being issued, the attempt looks
 *   like "a request may have gone out" when in fact none did. That false hold
 *   is the correct trade. The alternative -- writing evidence after the call --
 *   makes a crash indistinguishable from a non-send, and a later worker then
 *   retries a message the seller may already have received.
 *
 * TWO AUTHORITIES, BOTH REQUIRED
 *
 *   TRANSPORT authority  would another attempt risk duplication?
 *   RUNTIME authority    are we operationally and legally allowed to send now?
 *
 *   A communication can be perfectly retry-safe and still be forbidden because
 *   the seller said STOP, the contact window closed, or the emergency brake is
 *   on. Transport safety never substitutes for compliance.
 *
 * DORMANT UNTIL MIGRATION. The §11 tables do not exist in production yet, so
 * this module is not wired into any live send path. It fails closed if its
 * store is unavailable; it never falls back to the legacy send semantics.
 */

import {
  buildLogicalCommunicationKey,
  LOGICAL_COMMUNICATION_KEY_VERSION,
} from "@/lib/domain/communications/logical-communication-key.js";
import {
  canAllocateAttempt,
  evaluateLogicalTransition,
  LOGICAL_STATES,
  DELIVERY_POSSIBILITY,
  RETRY_AUTHORITY,
  TRANSITION_CAUSES,
} from "@/lib/domain/communications/communication-transition-authority.js";
import { mapTransportOutcome } from "@/lib/domain/communications/transport-outcome-mapping.js";

function clean(value) {
  return String(value ?? "").trim();
}

/** Outcome shape shared by every refusal, so callers never have to guess. */
function denied(stage, reason, extra = {}) {
  return {
    ok: false,
    sent: false,
    provider_invoked: false,
    stage,
    reason,
    ...extra,
  };
}

/**
 * Execute one seller-visible communication attempt.
 *
 * @param {object} input
 * @param {string} input.communication_type
 * @param {object} input.anchors        durable identity anchors for the type
 * @param {object} input.lineage        thread/property/recipient lineage
 * @param {object} input.message        { to, from, body }
 * @param {object} deps                 every collaborator is injected so the
 *                                      ordering guarantee is testable with a
 *                                      network spy and fault injection.
 */
export async function executeSellerCommunicationAttempt(input = {}, deps = {}) {
  const {
    store,                       // logical communication + attempt persistence
    evaluateRuntimeAuthority,    // canonical send authority (brakes/compliance)
    assertOutboundContent,       // em-dash + content guards
    sendProvider,                // the ONLY network primitive
    classifyProviderError,       // Slice 0 classifier
    now = new Date().toISOString(),
    logger = null,
  } = deps;

  const emit = (event, payload = {}) => logger?.info?.(event, payload);

  if (!store?.getOrCreateLogicalCommunication) {
    // No durable authority available means no send. Never fall back to legacy.
    return denied("store", "logical_communication_store_unavailable");
  }

  // ── 1-2. domain action -> deterministic identity ─────────────────────────
  //
  // A caller may arrive with the action ALREADY identified (a queue row bound
  // to a logical communication). Then identity is a fact to read, not to
  // re-derive: re-deriving would let a drifting anchor silently mint a second
  // action for a row that already has one.
  const preresolved = clean(input.preresolved_logical_communication_id);
  if (preresolved) {
    const loaded = await store.getLogicalCommunicationById(preresolved);
    if (!loaded?.ok) {
      emit("logical_communication.load_refused", {
        logical_communication_id: preresolved, reason: loaded?.reason,
      });
      return denied("identity", loaded?.reason || "logical_communication_not_found");
    }
    return runAttempt(loaded.communication, input, deps, emit);
  }

  const key = buildLogicalCommunicationKey({
    communication_type: input.communication_type,
    ...(input.anchors || {}),
  });
  if (!key.ok) {
    // A caller that cannot name its domain action has not earned a send.
    emit("logical_communication.refused_missing_identity", {
      communication_type: input.communication_type, reason: key.reason, missing: key.missing,
    });
    return denied("identity", key.reason, { missing: key.missing });
  }

  // ── 3-5. atomic get-or-create, with lineage conflict refusal ─────────────
  const resolved = await store.getOrCreateLogicalCommunication({
    logical_key: key.key,
    logical_key_version: LOGICAL_COMMUNICATION_KEY_VERSION,
    communication_type: key.type,
    lineage: { ...(input.anchors || {}), ...(input.lineage || {}) },
  });

  if (!resolved?.ok) {
    if (resolved?.reason === "logical_communication_identity_conflict") {
      emit("logical_communication.identity_conflict", {
        logical_key: key.key, conflicting_fields: resolved.conflicting_fields,
      });
    }
    return denied("identity", resolved?.reason || "logical_communication_unavailable", {
      conflicting_fields: resolved?.conflicting_fields,
    });
  }

  const comm = resolved.communication;
  emit(resolved.reused ? "logical_communication.reused" : "logical_communication.created", {
    logical_communication_id: comm.id, logical_key: comm.logical_key,
  });

  return runAttempt(comm, input, deps, emit);
}

/**
 * Everything after identity is settled. Shared verbatim by both entry paths so
 * a bound queue row and a freshly-derived action cannot diverge in what they
 * are allowed to do.
 */
async function runAttempt(comm, input, deps, emit) {
  const {
    store,
    evaluateRuntimeAuthority,
    assertOutboundContent,
    sendProvider,
    classifyProviderError,
    now = new Date().toISOString(),
  } = deps;

  // ── 6-9. TRANSPORT authority: would another attempt risk duplication? ────
  const transport = canAllocateAttempt(comm);
  if (!transport.ok) {
    emit("dispatch.transport_denied", {
      logical_communication_id: comm.id, reason: transport.reason,
      state: comm.state, delivery_possibility: comm.delivery_possibility,
    });
    return denied("transport_authority", transport.reason, {
      logical_communication_id: comm.id,
      state: comm.state,
      delivery_possibility: comm.delivery_possibility,
      retry_authority: comm.retry_authority,
    });
  }

  // ── 10. RUNTIME authority: are we allowed to send RIGHT NOW? ─────────────
  // Re-evaluated on EVERY attempt: a seller may have sent STOP between
  // attempt 1 and attempt 2, and transport safety says nothing about that.
  if (typeof evaluateRuntimeAuthority === "function") {
    const runtime = await evaluateRuntimeAuthority({
      logical_communication_id: comm.id,
      to: input.message?.to,
      thread_key: input.lineage?.thread_key,
    });
    if (!runtime?.ok) {
      emit("dispatch.runtime_denied", {
        logical_communication_id: comm.id, reason: runtime?.reason,
      });
      return denied("runtime_authority", runtime?.reason || "runtime_authority_denied", {
        logical_communication_id: comm.id,
      });
    }
  } else {
    return denied("runtime_authority", "runtime_authority_unavailable");
  }

  // ── content guards BEFORE the wire (em dash, etc.) ───────────────────────
  if (typeof assertOutboundContent === "function") {
    const content = await assertOutboundContent(input.message || {});
    if (!content?.ok) {
      emit("dispatch.content_rejected", {
        logical_communication_id: comm.id, reason: content?.reason,
      });
      return denied("content", content?.reason || "outbound_content_rejected", {
        logical_communication_id: comm.id,
      });
    }
  }

  // ── 11-12. atomic attempt allocation + claim ─────────────────────────────
  const allocated = await store.allocateAttempt({
    logical_communication_id: comm.id,
    queue_row_id: input.queue_row_id || null,
  });
  if (!allocated?.ok) {
    emit("dispatch.attempt_allocation_denied", {
      logical_communication_id: comm.id, reason: allocated?.reason,
    });
    return denied("attempt_allocation", allocated?.reason || "attempt_allocation_denied", {
      logical_communication_id: comm.id,
    });
  }
  emit("attempt.created", {
    logical_communication_id: comm.id,
    attempt_id: allocated.attempt_id,
    attempt_number: allocated.attempt_number,
  });

  // ── 13-14. PROVIDER-START MARKER, COMMITTED BEFORE THE NETWORK ───────────
  // Everything above this line can fail with provider_invoked === false.
  // Nothing below may run unless this write is CONFIRMED durable.
  let marked;
  try {
    marked = await store.markProviderRequestStarted({
      attempt_id: allocated.attempt_id,
      logical_communication_id: comm.id,
      at: now,
    });
  } catch (error) {
    marked = { ok: false, reason: clean(error?.message) || "provider_request_start_persist_threw" };
  }

  if (!marked?.ok) {
    // The provider is NEVER called without durable evidence that we were about
    // to call it. Without the marker a crash would be indistinguishable from a
    // non-send, and a later worker would retry.
    emit("attempt.provider_request_start_failed", {
      logical_communication_id: comm.id, attempt_id: allocated.attempt_id, reason: marked?.reason,
    });
    return denied("provider_request_start", marked?.reason || "provider_request_start_not_durable", {
      logical_communication_id: comm.id,
      attempt_id: allocated.attempt_id,
    });
  }
  emit("attempt.provider_request_started", {
    logical_communication_id: comm.id, attempt_id: allocated.attempt_id,
  });

  // ── 15. the network call. From here, acceptance cannot be excluded. ──────
  let provider_result = null;
  let provider_error = null;
  emit("dispatch.provider_invoked", {
    logical_communication_id: comm.id, attempt_id: allocated.attempt_id,
  });
  try {
    provider_result = await sendProvider({
      to: input.message?.to,
      from: input.message?.from,
      body: input.message?.body,
    });
  } catch (error) {
    provider_error = error;
  }

  // ── 16. classify ─────────────────────────────────────────────────────────
  const classified = provider_error
    ? (typeof classifyProviderError === "function"
        ? classifyProviderError(provider_error)
        : { failure_class: "unknown_failure" })
    : { ok: true, provider_message_id: clean(provider_result?.sid || provider_result?.provider_message_id) };

  const outcome = mapTransportOutcome(classified);

  // ── 17. persist the attempt outcome (evidence first) ─────────────────────
  await store.recordAttemptOutcome({
    attempt_id: allocated.attempt_id,
    logical_communication_id: comm.id,
    provider_message_id: classified.provider_message_id || null,
    attempt_state: outcome.attempt_state,
    delivery_possibility: outcome.delivery_possibility,
    retry_authority: outcome.retry_authority,
    failure_class: outcome.reason,
    at: now,
  });
  emit(`attempt.${outcome.attempt_state}`, {
    logical_communication_id: comm.id, attempt_id: allocated.attempt_id, reason: outcome.reason,
  });

  // ── 18. advance the logical communication through the ONE authority ──────
  const transition = evaluateLogicalTransition({
    current: {
      state: LOGICAL_STATES.PROVIDER_REQUEST_STARTED,
      delivery_possibility: comm.delivery_possibility ?? DELIVERY_POSSIBILITY.UNKNOWN,
      retry_authority: comm.retry_authority ?? RETRY_AUTHORITY.RETRY_ALLOWED,
      retry_after_at: comm.retry_after_at ?? null,
    },
    requested: {
      state: outcome.logical_state,
      delivery_possibility: outcome.delivery_possibility,
      retry_authority: outcome.retry_authority,
    },
    cause: outcome.cause,
    now,
  });

  if (!transition.ok) {
    // The mapping produced a posture the authority refuses. Do not coerce it:
    // an unexplainable state is worse than a loud failure.
    emit("logical_communication.transition_refused", {
      logical_communication_id: comm.id, reason: transition.reason,
    });
    return {
      ok: false,
      provider_invoked: true,
      sent: Boolean(classified.provider_message_id),
      stage: "transition",
      reason: transition.reason,
      logical_communication_id: comm.id,
      attempt_id: allocated.attempt_id,
    };
  }

  await store.applyLogicalTransition({
    logical_communication_id: comm.id,
    next: transition.next,
    cause: transition.cause,
    at: now,
  });

  // ── 19-21. projections are LAST, and are not authority ───────────────────
  // If any of these fail the send has still happened and is durably recorded.
  // Reconciliation repairs projections; it never re-sends.
  const projection = { queue: false, message_event: false };
  try {
    if (store.updateQueueProjection) {
      await store.updateQueueProjection({
        queue_row_id: input.queue_row_id || null,
        logical_communication_id: comm.id,
        provider_message_id: classified.provider_message_id || null,
        outcome,
      });
      projection.queue = true;
    }
    if (store.writeMessageEventProjection && classified.provider_message_id) {
      await store.writeMessageEventProjection({
        logical_communication_id: comm.id,
        provider_message_id: classified.provider_message_id,
      });
      projection.message_event = true;
    }
  } catch (error) {
    emit("dispatch.projection_repair_needed", {
      logical_communication_id: comm.id,
      attempt_id: allocated.attempt_id,
      error: clean(error?.message) || "projection_failed",
    });
  }

  return {
    ok: Boolean(classified.provider_message_id),
    provider_invoked: true,
    sent: Boolean(classified.provider_message_id),
    stage: "complete",
    reason: outcome.reason,
    logical_communication_id: comm.id,
    logical_key: comm.logical_key,
    attempt_id: allocated.attempt_id,
    attempt_number: allocated.attempt_number,
    provider_message_id: classified.provider_message_id || null,
    delivery_possibility: outcome.delivery_possibility,
    retry_authority: outcome.retry_authority,
    logical_state: transition.next.state,
    projection,
  };
}

export default executeSellerCommunicationAttempt;
