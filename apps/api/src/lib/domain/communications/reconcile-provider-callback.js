/**
 * reconcile-provider-callback.js
 *
 * THE one place a provider callback may change what we believe about a seller
 * communication.
 *
 * Slice 1 established the mirror of this on the way out: `sendTextgridSMS` is
 * the only send primitive, and everything funnels through one dispatch seam.
 * Inbound has the same shape -- `syncDeliveryEvent` is the single function all
 * callback-derived state already flows through -- so convergence here means one
 * seam, not a rewrite of three routes.
 *
 * WHAT A CALLBACK MAY DO
 *   Increase certainty about an attempt that ALREADY EXISTS.
 *
 * WHAT A CALLBACK MAY NEVER DO
 *   Create a logical communication. Create an attempt. Mint retry authority.
 *   Replace a bound SID. Regress delivered. Resolve ambiguity downward into
 *   "definitely not sent".
 *
 * THE ASYMMETRY THAT DRIVES THE DESIGN
 *   Outbound evidence is ours: we know whether we called the provider, because
 *   we wrote provider_request_started before doing it. Inbound evidence is
 *   THEIRS, arrives out of order, may be duplicated arbitrarily, and -- as the
 *   audit established -- cannot be proven authentic from repository config
 *   alone. So a callback is treated as a claim to be recorded, then a
 *   transition to be authorised, never as an instruction to be executed.
 */

import crypto from 'node:crypto';
import { child } from '@/lib/logging/logger.js';
import { normalizePhone } from '@/lib/utils/phones.js';
import {
  normalizeProviderStatus,
  advanceProviderOutcome,
  deliveryPossibilityFor,
  PROVIDER_OUTCOME,
  PROVIDER_STATUS_POLICY_VERSION,
  PROVIDER_LATTICE_POLICY_VERSION,
} from '@/lib/domain/communications/provider-outcome-lattice.js';
import {
  TRUST_CLASS,
  mayAdvanceCanonicalTruthWithTrust,
  mayAdoptOrphanWithTrust,
  untrustedRefusal,
  CALLBACK_TRUST_POLICY_VERSION,
} from '@/lib/domain/communications/callback-trust-policy.js';

const logger = child({ module: 'domain.communications.callback_reconcile' });

export const CALLBACK_FINGERPRINT_POLICY_VERSION = 'cbfp_v1';
export const CALLBACK_ADOPTION_POLICY_VERSION = 'cb_adopt_v1';

/**
 * ORPHAN ADOPTION WINDOW.
 *
 * Bounded and versioned on purpose. An unbounded (or "same day") window would
 * let a callback attach to an attempt it has no relation to, which is the
 * misattribution this whole path exists to prevent.
 *
 * Derived from the outbound side: the provider request is abandoned at 15s
 * (AbortSignal.timeout), and a status callback for a message the provider
 * accepted arrives well inside minutes. 30 minutes is generous enough to cover
 * a slow provider and a redelivery, and far too short to span two unrelated
 * sends to the same seller.
 */
export const ORPHAN_ADOPTION_WINDOW_MS = 30 * 60 * 1000;

/**
 * Receipt-time trust. Immutable once recorded; never retroactively upgraded.
 *
 * Re-exported from the trust policy module, which owns the vocabulary. Existing
 * callers importing TRUST_CLASS from here keep working.
 */
export { TRUST_CLASS };

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Receipt trust, classified from what verification ACTUALLY established.
 *
 * The verifier returns `{ok:true, verified:false, required:false,
 * reason:'no_secrets_configured'}` when no secret is configured, and the caller
 * only rejects on `required && !ok` -- so an unverified callback is accepted.
 * That is a real fail-open, and this function refuses to launder it: trust
 * follows `verified`, never `ok`.
 */
export function classifyReceiptTrust(verification = {}) {
  if (verification.test_fixture === true) return TRUST_CLASS.TEST_FIXTURE;
  if (verification.internal_replay === true) return TRUST_CLASS.INTERNAL_REPLAY;
  if (verification.verified === true) return TRUST_CLASS.AUTHENTICATED;
  // ok:true with verified:false means "we did not check", not "it is genuine".
  return TRUST_CLASS.UNAUTHENTICATED;
}

/**
 * Deterministic callback identity.
 *
 * Built ONLY from stable provider evidence. Deliberately excludes received_at,
 * the worker, and any processing timestamp: including any of those would make
 * every redelivery a new event and defeat dedupe exactly as a random queue_key
 * defeated it on the outbound side.
 *
 * Trust class is excluded too. Trust is our interpretation of the environment,
 * not something the provider said, so the same callback arriving under two
 * signature modes is still one event.
 */
export function buildCallbackFingerprint(evidence = {}) {
  const parts = [
    CALLBACK_FINGERPRINT_POLICY_VERSION,
    clean(evidence.provider) || 'textgrid',
    clean(evidence.provider_message_sid),
    clean(evidence.provider_status).toLowerCase(),
    normalizePhone(evidence.to_phone_number) || '',
    normalizePhone(evidence.from_phone_number) || '',
    clean(evidence.provider_event_at),
    clean(evidence.provider_error_code),
  ];
  const seed = parts.join('|');
  return `${CALLBACK_FINGERPRINT_POLICY_VERSION}:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

function refusal(stage, reason, extra = {}) {
  return { ok: false, applied: false, provider_send_triggered: false, stage, reason, ...extra };
}

/**
 * Reconcile one provider callback.
 *
 * @param {object} callback normalized provider evidence
 * @param {object} deps     { store, verification, now, logger }
 */
export async function reconcileProviderCallback(callback = {}, deps = {}) {
  const { store, now = new Date().toISOString() } = deps;
  const emit = (event, payload = {}) => (deps.logger || logger).info?.(event, payload);

  if (!store?.getOrCreateCallbackEvent) {
    // A store that cannot record evidence is not permission to mutate truth.
    return refusal('store', 'callback_store_unavailable');
  }

  // ── 1-3. normalize + classify receipt trust ─────────────────────────────
  const evidence = {
    provider: clean(callback.provider) || 'textgrid',
    provider_message_sid: clean(callback.message_id || callback.provider_message_sid),
    provider_status: clean(callback.status || callback.provider_status),
    provider_error_code: clean(callback.error_code),
    provider_error_message: clean(callback.error_message),
    provider_event_at: clean(callback.delivered_at || callback.provider_event_at) || null,
    to_phone_number: normalizePhone(callback.to || callback.to_phone_number) || null,
    from_phone_number: normalizePhone(callback.from || callback.from_phone_number) || null,
    // The one human-readable failure detail TextGrid actually sends. Captured as
    // diagnostics only: it is prose, not a semantic delivery authority.
    provider_status_detail: clean(callback.status_detail || callback.SmsStatusDetail) || null,
    source_route: clean(callback.source_route) || null,
  };

  const trust_class = classifyReceiptTrust(deps.verification || {});
  const fingerprint = buildCallbackFingerprint(evidence);

  // ── 4-5. atomic ledger get-or-create ────────────────────────────────────
  const recorded = await store.getOrCreateCallbackEvent({
    fingerprint,
    fingerprint_policy: CALLBACK_FINGERPRINT_POLICY_VERSION,
    evidence,
    trust: { trust_class, signature_verified: deps.verification?.verified === true },
  });

  if (!recorded?.ok) {
    return refusal('ledger', recorded?.reason || 'callback_event_not_recorded');
  }

  const event_id = recorded.callback_event_id;

  // ── 6. EXACT DUPLICATE ──────────────────────────────────────────────────
  //
  // DEDUPE ON PROCESSED, NOT ON RECORDED.
  //
  // Recording the evidence and applying its transition are two writes. A crash
  // between them leaves a row whose fingerprint exists but whose transition
  // never landed. Short-circuiting on "the fingerprint is already there" would
  // make the provider's redelivery -- our one chance to recover -- a no-op, and
  // canonical truth would lag forever, silently.
  //
  // So a duplicate is inert only once its processing actually REACHED a verdict.
  // 'pending' means we recorded a claim and never ruled on it: work to resume,
  // not work to skip.
  //
  // Note the gate is the ROW'S OWN verdict, not whether we believe we created it.
  // "Did I insert this?" is a race-sensitive inference; "has this been ruled on?"
  // is a fact the row states directly. Only the second is safe to branch on.
  const processing_status = clean(recorded.processing_status);
  const already_processed = processing_status !== '' && processing_status !== 'pending';

  if (already_processed) {
    emit('provider_callback.duplicate', { callback_event_id: event_id, fingerprint });
    return {
      ok: true,
      applied: false,
      duplicate: true,
      provider_send_triggered: false,
      stage: 'duplicate',
      reason: 'callback_already_processed',
      callback_event_id: event_id,
    };
  }

  emit('provider_callback.received', {
    callback_event_id: event_id, trust_class,
    provider_status: evidence.provider_status,
    has_sid: Boolean(evidence.provider_message_sid),
  });

  // ── 6b. TRUST GATE ──────────────────────────────────────────────────────
  //
  // The evidence is already durable at this point, and that is deliberate: an
  // untrusted receipt is still a fact about what arrived, and discarding it
  // would destroy the only record that someone tried. What it may NOT do is
  // change what we believe.
  //
  // This runs BEFORE binding, because orphan adoption is itself a mutation --
  // it writes a caller-supplied SID onto one of our attempts on the strength of
  // a phone number and a time window.
  if (!mayAdvanceCanonicalTruthWithTrust(trust_class)) {
    const refusal_meta = untrustedRefusal(trust_class);
    await store.markCallbackEvent({
      callback_event_id: event_id,
      adoption_status: refusal_meta.adoption_status,
      adoption_reason: refusal_meta.adoption_reason,
      adoption_policy_version: CALLBACK_TRUST_POLICY_VERSION,
      processing_status: refusal_meta.processing_status,
      at: now,
    });
    emit('provider_callback.untrusted_receipt', {
      callback_event_id: event_id, trust_class, fingerprint,
    });
    return {
      ok: true,
      applied: false,
      provider_send_triggered: false,
      stage: 'trust',
      reason: refusal_meta.adoption_reason,
      trust_class,
      callback_event_id: event_id,
    };
  }

  // ── 7. resolve which attempt this evidence is about ─────────────────────
  const binding = await resolveBinding(evidence, {
    store, now, emit,
    // Orphan adoption carries its own, never-lower threshold. Known-SID at
    // least proves the caller knew a SID we issued; adoption proves nothing.
    may_adopt_orphan: mayAdoptOrphanWithTrust(trust_class),
    trust_class,
  });
  if (!binding.ok) {
    await store.markCallbackEvent({
      callback_event_id: event_id,
      adoption_status: binding.adoption_status,
      adoption_reason: binding.reason,
      adoption_policy_version: CALLBACK_ADOPTION_POLICY_VERSION,
      processing_status: 'no_action',
      at: now,
    });
    emit(`provider_callback.${binding.adoption_status}`, {
      callback_event_id: event_id, reason: binding.reason,
      candidate_count: binding.candidate_count,
    });
    return {
      ok: true,
      applied: false,
      provider_send_triggered: false,
      stage: 'binding',
      reason: binding.reason,
      adoption_status: binding.adoption_status,
      candidate_count: binding.candidate_count,
      callback_event_id: event_id,
    };
  }

  // ── 8-9. provider status -> outcome, then the MONOTONIC gate ────────────
  const normalized = normalizeProviderStatus(evidence.provider_status);
  // TWO DIFFERENT READS OF THE SAME FIELD, deliberately not merged.
  //
  //   stored_outcome  the literal persisted value, NULL included
  //   current         that value interpreted for the lattice, where an absent
  //                   outcome MEANS unknown
  //
  // The lattice needs the interpretation. The compare-and-swap below needs the
  // literal: `WHERE outcome_class = 'unknown'` never matches a NULL column.
  const stored_outcome = binding.attempt.outcome_class ?? null;
  const current = stored_outcome || PROVIDER_OUTCOME.UNKNOWN;
  const verdict = advanceProviderOutcome(current, normalized.outcome);

  if (verdict.action !== 'advance') {
    // stale / idempotent / conflict / inert: evidence kept, truth untouched.
    await store.markCallbackEvent({
      callback_event_id: event_id,
      adoption_status: verdict.action === 'conflict' ? 'conflict' : 'stale',
      adoption_reason: verdict.reason,
      adoption_policy_version: CALLBACK_ADOPTION_POLICY_VERSION,
      processing_status: 'no_action',
      bound_attempt_id: binding.attempt.id,
      bound_logical_communication_id: binding.attempt.logical_communication_id,
      at: now,
    });
    emit(`provider_callback.status_${verdict.action}`, {
      callback_event_id: event_id, from: current, to: normalized.outcome, reason: verdict.reason,
    });
    return {
      ok: true,
      applied: false,
      provider_send_triggered: false,
      stage: 'lattice',
      reason: verdict.reason,
      lattice_action: verdict.action,
      callback_event_id: event_id,
      attempt_id: binding.attempt.id,
    };
  }

  // ── 10. bind the SID, set-once ──────────────────────────────────────────
  // Only reached when the outcome genuinely advances. An attempt that already
  // holds a DIFFERENT SID is a hard conflict, never an overwrite.
  if (evidence.provider_message_sid) {
    const bind = await store.bindProviderSid({
      attempt_id: binding.attempt.id,
      provider_message_sid: evidence.provider_message_sid,
      at: now,
    });
    if (!bind?.ok) {
      await store.markCallbackEvent({
        callback_event_id: event_id,
        adoption_status: 'conflict',
        adoption_reason: bind?.reason || 'sid_bind_refused',
        adoption_policy_version: CALLBACK_ADOPTION_POLICY_VERSION,
        processing_status: 'refused',
        at: now,
      });
      emit('provider_callback.status_conflict', {
        callback_event_id: event_id, reason: bind?.reason,
      });
      return refusal('sid_binding', bind?.reason || 'sid_bind_refused', {
        callback_event_id: event_id, attempt_id: binding.attempt.id,
      });
    }
  }

  // ── 11-12. canonical provider truth ─────────────────────────────────────
  const delivery_possibility = deliveryPossibilityFor(normalized.outcome);

  // COMPARE-AND-SWAP, not a blind write.
  //
  // The lattice verdict above was computed against `current`. Between that read
  // and this write another callback may have advanced the same attempt. Writing
  // blindly would let two concurrent claims both pass the gate on the same stale
  // value and let the second overwrite the first -- which is precisely how a
  // late `failed` erases a delivery the seller received. Found by the integrated
  // race matrix; the sequential path never exposes it.
  const applied = await store.applyCallbackOutcome({
    attempt_id: binding.attempt.id,
    logical_communication_id: binding.attempt.logical_communication_id,
    expected_outcome_class: stored_outcome,
    outcome_class: normalized.outcome,
    delivery_possibility,
    provider_status: evidence.provider_status,
    provider_status_detail: evidence.provider_status_detail,
    // Deliberately absent: retry_authority. A callback records what the provider
    // did; whether another attempt may happen is a separate canonical decision.
    at: now,
    policy_versions: {
      status: PROVIDER_STATUS_POLICY_VERSION,
      lattice: PROVIDER_LATTICE_POLICY_VERSION,
      adoption: CALLBACK_ADOPTION_POLICY_VERSION,
    },
  });

  if (applied && applied.ok === false) {
    // Someone else advanced this attempt first. Our verdict was computed against
    // a value that no longer holds, so it is not ours to apply. Record the claim
    // and leave the winner's truth alone.
    await store.markCallbackEvent({
      callback_event_id: event_id,
      adoption_status: 'conflict',
      adoption_reason: applied.reason || 'outcome_changed_under_us',
      adoption_policy_version: CALLBACK_ADOPTION_POLICY_VERSION,
      processing_status: 'no_action',
      bound_attempt_id: binding.attempt.id,
      bound_logical_communication_id: binding.attempt.logical_communication_id,
      at: now,
    });
    emit('provider_callback.status_conflict', {
      callback_event_id: event_id, reason: applied.reason, expected: current,
    });
    return {
      ok: true, applied: false, provider_send_triggered: false,
      stage: 'lattice', reason: applied.reason || 'outcome_changed_under_us',
      lattice_action: 'conflict', callback_event_id: event_id,
      attempt_id: binding.attempt.id,
    };
  }

  await store.markCallbackEvent({
    callback_event_id: event_id,
    adoption_status: binding.adoption_status,
    adoption_reason: binding.reason,
    adoption_policy_version: CALLBACK_ADOPTION_POLICY_VERSION,
    processing_status: 'applied',
    bound_attempt_id: binding.attempt.id,
    bound_logical_communication_id: binding.attempt.logical_communication_id,
    at: now,
  });

  emit('provider_callback.status_advanced', {
    callback_event_id: event_id,
    attempt_id: binding.attempt.id,
    from: current,
    to: normalized.outcome,
    adoption_status: binding.adoption_status,
  });

  return {
    ok: true,
    applied: true,
    provider_send_triggered: false,
    stage: 'applied',
    reason: verdict.reason,
    callback_event_id: event_id,
    attempt_id: binding.attempt.id,
    logical_communication_id: binding.attempt.logical_communication_id,
    outcome_class: normalized.outcome,
    delivery_possibility,
    adoption_status: binding.adoption_status,
  };
}

/**
 * Which attempt is this callback about?
 *
 * Known SID first: an exact SID match is the strongest correlation available.
 * Then strict orphan adoption, which exists because there is no per-message
 * callback token -- StatusCallback is configured provider-side, so SID +
 * To/From + a bounded window is the only correlation evidence we have.
 */
async function resolveBinding(evidence, {
  store, now, emit, may_adopt_orphan = false, trust_class = null,
}) {
  const sid = evidence.provider_message_sid;

  if (sid) {
    const known = await store.findAttemptByProviderSid(sid);
    if (known?.ok && known.attempt) {
      // A SID match with contradictory routing is NOT this communication.
      // Timing proximity is not identity.
      const recipientMatches =
        !evidence.to_phone_number
        || !known.attempt.to_phone_number
        || normalizePhone(known.attempt.to_phone_number) === evidence.to_phone_number;

      if (!recipientMatches) {
        return {
          ok: false,
          adoption_status: 'identity_mismatch',
          reason: 'provider_callback_identity_mismatch',
        };
      }
      return { ok: true, attempt: known.attempt, adoption_status: 'bound_known_sid', reason: 'known_sid' };
    }
  }

  // ── ORPHAN PATH ─────────────────────────────────────────────────────────
  if (!evidence.to_phone_number) {
    // Without a recipient there is nothing to match on, and matching on time
    // alone would be guessing.
    return { ok: false, adoption_status: 'orphan_unmatched', reason: 'orphan_without_recipient', candidate_count: 0 };
  }

  const windowEnd = new Date(now).toISOString();
  const windowStart = new Date(new Date(now).getTime() - ORPHAN_ADOPTION_WINDOW_MS).toISOString();

  const candidates = await store.findOrphanCandidates({
    to_phone_number: evidence.to_phone_number,
    from_phone_number: evidence.from_phone_number,
    window_start: windowStart,
    window_end: windowEnd,
  });

  const count = candidates?.candidate_count ?? 0;

  // TRUST GATE FOR ADOPTION, checked before cardinality so the refusal reason
  // names the real cause. A caller who cannot be authenticated must never be
  // able to attach their claim to one of our unresolved attempts, no matter how
  // cleanly the candidate set resolves.
  if (!may_adopt_orphan) {
    return {
      ok: false,
      adoption_status: 'unprocessed',
      reason: `orphan_adoption_requires_trust:${trust_class || 'unknown'}`,
      candidate_count: count,
    };
  }

  if (count === 0) {
    return { ok: false, adoption_status: 'orphan_unmatched', reason: 'orphan_zero_candidates', candidate_count: 0 };
  }

  if (count > 1) {
    // NEVER pick a "best" candidate. Choosing between two possible seller
    // communications is how a delivery receipt gets credited to the wrong
    // person, and the evidence cannot distinguish them.
    return { ok: false, adoption_status: 'orphan_ambiguous', reason: 'orphan_multiple_candidates', candidate_count: count };
  }

  emit?.('provider_callback.orphan_adopted', { attempt_id: candidates.attempt_id });
  return {
    ok: true,
    attempt: {
      id: candidates.attempt_id,
      logical_communication_id: candidates.logical_communication_id,
      // The LITERAL stored value, un-normalized. Coercing NULL to 'unknown'
      // here would make the compare-and-swap below compare against a value the
      // column never held. Interpretation happens in exactly one place.
      outcome_class: candidates.outcome_class ?? null,
      to_phone_number: evidence.to_phone_number,
    },
    adoption_status: 'orphan_adopted',
    reason: 'orphan_exactly_one_candidate',
    candidate_count: 1,
  };
}

export default reconcileProviderCallback;
