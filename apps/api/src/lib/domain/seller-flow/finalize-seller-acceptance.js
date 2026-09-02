// ─── finalize-seller-acceptance.js ──────────────────────────────────────────
// THE live acceptance -> closing seam (supersprint §12, P0 #5).
//
// Before this module the seam was broken on the live Supabase-native path: a
// seller "yes" flipped negotiation_state.terms_accepted to true in opportunity
// metadata and emitted a `terms_accepted` workflow event, and stopped. The
// durable seller_offers row was never moved active -> accepted, and no closing
// case was ever created. The only live contract trigger
// (maybeCreateContractFromAcceptedOffer) runs through Podio, which is dead in
// production (podio_business_writes = false), so acceptance never converged into
// a durable closing artifact.
//
// This module converges the acceptance deterministically using the existing,
// individually-tested authorities:
//
//   1. acceptActiveOffer()          — bind the acceptance to the EXACT active
//                                     seller_offer, flip active -> accepted,
//                                     freeze the accepted price + closing date +
//                                     EMD due date, key on acceptance_event_id.
//   2. createClosingCaseFromAcceptance() — create exactly ONE closing case from
//                                     the canonical Supabase authorities (never
//                                     from SMS text), keyed on a deterministic
//                                     closing_case_id.
//
// WHAT THIS IS NOT
//   • Not a send. No seller-visible SMS is produced here.
//   • Not a DocuSign envelope. Envelope creation stays a separate gated step;
//     this only records the accepted offer and the closing case.
//   • Not a term source. The seller's words route the conversation; the money
//     comes only from the persisted accepted offer.
//
// SAFETY / CONTAINMENT
//   • Fail-closed: a "yes" with no active offer accepts nothing and creates no
//     closing case (acceptActiveOffer returns no_active_offer). We never
//     fabricate an accepted price.
//   • Idempotent: acceptActiveOffer is keyed on acceptance_event_id (DB unique);
//     createClosingCaseFromAcceptance is keyed on a deterministic
//     closing_case_id (DB unique) and treats identical terms as a no-op. A crash
//     between the two steps is recovered on replay: a duplicate acceptance still
//     drives closing-case creation so a stranded accepted offer cannot exist.
//   • Failure-isolated: never throws into the orchestrator. Seller inbound
//     processing must not fail because a downstream record write failed.
//   • dry_run: validates nothing is written.

import { acceptActiveOffer, recordSellerCounter, loadActiveOffer, loadAcceptedOffer } from "@/lib/domain/seller-flow/seller-offer-authority.js";
import { createClosingCaseFromAcceptance } from "@/lib/domain/closings/create-closing-case-from-acceptance.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

export const FINALIZE_ACCEPTANCE_VERSION = "finalize_seller_acceptance_v1";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Detect the acceptance EDGE: terms_accepted transitioned false -> true on this
 * turn. Later turns keep terms_accepted = true, so without the edge check this
 * would attempt to finalize on every subsequent inbound. (acceptActiveOffer and
 * createClosingCaseFromAcceptance are both idempotent, so a redundant call is
 * harmless — but the edge check avoids the work and the log noise.)
 */
export function isAcceptanceEdge(previousState = null, negotiationState = null) {
  const wasAccepted = previousState?.terms_accepted === true;
  const nowAccepted = negotiationState?.terms_accepted === true;
  return nowAccepted && !wasAccepted;
}

/**
 * Converge a durable seller acceptance into an accepted offer and a closing case.
 *
 * @param {object} args
 * @param {string} args.opportunity_id      canonical opportunity id
 * @param {string} args.thread_key          conversation thread key
 * @param {string} args.acceptance_event_id the inbound event id (idempotency key)
 * @param {string} args.acceptance_at       ISO instant of the accepting message
 * @param {string} [args.expected_offer_id] optional — reject a "yes" to a stale offer
 * @param {number} [args.expected_offer_version]
 * @param {boolean} [args.dry_run]
 * @param {object} [args.provenance]        recorded on the closing case
 * @param {object} [args.supabase]
 * @returns {Promise<object>} structured result with lineage; never throws.
 */
export async function finalizeSellerAcceptance({
  opportunity_id = null,
  thread_key = null,
  property_id = null,
  master_owner_id = null,
  acceptance_event_id = null,
  acceptance_at = null,
  expected_offer_id = null,
  expected_offer_version = null,
  // WHICH price was agreed, and on what basis (from negotiation_state.accepted_terms):
  //   seller_accepted_our_offer -> the active OUTBOUND offer is the agreed one
  //   we_accepted_seller_ask    -> the seller's ASK is the agreed price; it must
  //                                become the accepted offer VERSION, never our
  //                                stale lower proposal
  accepted_price = null,
  acceptance_basis = null,
  dry_run = false,
  provenance = {},
  supabase: injected = null,
} = {}) {
  const base = {
    ok: false,
    version: FINALIZE_ACCEPTANCE_VERSION,
    offer_accepted: false,
    offer_id: null,
    offer_version: null,
    accepted_price: null,
    closing_case_id: null,
    closing_case_created: false,
    reason: null,
  };

  if (!clean(opportunity_id)) return { ...base, reason: "missing_opportunity_id" };
  if (!clean(acceptance_event_id)) return { ...base, reason: "missing_acceptance_event_id" };

  if (dry_run) {
    return { ...base, ok: true, dry_run: true, reason: "dry_run_no_writes" };
  }

  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ...base, reason: "missing_supabase" };

  // ── 0. Converge the offer VERSION to the agreed price ──────────────────────
  // When WE accepted the seller's ask, the agreed price is the ask -- not our
  // last (lower) proposal that is still the active offer. Binding the active
  // offer as-is would create a closing case at the WRONG price. So the ask is
  // first recorded as the seller's counter (a new immutable inbound version that
  // supersedes our proposal), and THAT version is what gets accepted.
  // Idempotent: if the active offer already carries the agreed price (a replay,
  // or the counter was already recorded), nothing new is written.
  const agreedPrice = Number.isFinite(Number(accepted_price)) && Number(accepted_price) > 0 ? Number(accepted_price) : null;
  let offerSentBefore = true;
  if (clean(acceptance_basis) === "we_accepted_seller_ask" && agreedPrice !== null) {
    let active = null;
    let accepted = null;
    try {
      [active, accepted] = await Promise.all([
        loadActiveOffer({ opportunity_id, supabase }),
        loadAcceptedOffer({ opportunity_id, supabase }),
      ]);
    } catch (error) {
      warn("[FINALIZE_ACCEPTANCE_ACTIVE_LOOKUP_FAILED]", { opportunity_id, error: error?.message || "lookup_failed" });
      return { ...base, reason: "active_offer_lookup_failed" };
    }
    // REPLAY: the agreed price is already the ACCEPTED version -> nothing to
    // converge; acceptActiveOffer will report duplicate_acceptance and the
    // closing case reconciles. Recording another counter here would churn a
    // spurious version on every replay.
    const alreadyAcceptedAtAgreed = accepted && Number(accepted.purchase_price) === agreedPrice;
    if (!alreadyAcceptedAtAgreed && (!active || Number(active.purchase_price) !== agreedPrice)) {
      const counter = await recordSellerCounter({
        opportunity_id,
        thread_key,
        property_id,
        master_owner_id,
        counter_price: agreedPrice,
        source_message_event_id: acceptance_event_id,
        metadata: { acceptance_basis: "we_accepted_seller_ask", converged_by: "finalize_seller_acceptance" },
        supabase,
      });
      if (!counter?.ok) {
        warn("[FINALIZE_ACCEPTANCE_COUNTER_FAILED]", { opportunity_id, agreed_price: agreedPrice, reason: counter?.reason || "counter_failed" });
        return { ...base, reason: counter?.reason || "counter_record_failed" };
      }
      // The counter was created at this instant; the acceptance is at the same
      // instant, so the chronology guard must not treat it as predating the offer.
      offerSentBefore = false;
    }
  }

  // ── 1. Bind the acceptance to the exact active offer ──────────────────────
  let acceptance;
  try {
    acceptance = await acceptActiveOffer({
      opportunity_id,
      acceptance_event_id,
      acceptance_at,
      expected_offer_id,
      expected_offer_version,
      offer_sent_before: offerSentBefore,
      supabase,
    });
  } catch (error) {
    warn("[FINALIZE_ACCEPTANCE_BIND_FAILED]", {
      opportunity_id,
      acceptance_event_id,
      error: error?.message || "accept_failed",
    });
    return { ...base, reason: "accept_exception" };
  }

  // A "yes" that binds nothing (no active offer / stale / predates / chronology)
  // must NOT create a closing case. Fail closed and surface the reason.
  const boundToOffer =
    acceptance?.ok === true &&
    (acceptance.accepted === true || acceptance.reason === "duplicate_acceptance") &&
    clean(acceptance.offer_id);

  if (!boundToOffer) {
    return {
      ...base,
      ok: acceptance?.ok === true, // ok:true, offer_accepted:false is a benign no-op (e.g. no active offer)
      reason: acceptance?.reason || "acceptance_not_bound",
    };
  }

  // PRICE INVARIANT: the bound offer's price must be the agreed price. If the
  // caller knows what was agreed and the durable offer says otherwise, no
  // closing case may be created from it -- fail closed and surface it.
  const boundPrice = Number(acceptance.accepted_price);
  if (agreedPrice !== null && Number.isFinite(boundPrice) && boundPrice !== agreedPrice) {
    warn("[FINALIZE_ACCEPTANCE_PRICE_MISMATCH]", {
      opportunity_id,
      offer_id: acceptance.offer_id,
      bound_price: boundPrice,
      agreed_price: agreedPrice,
    });
    return {
      ...base,
      ok: false,
      offer_accepted: acceptance.accepted === true,
      offer_id: acceptance.offer_id,
      offer_version: acceptance.offer_version ?? null,
      accepted_price: boundPrice,
      reason: "accepted_price_mismatch",
    };
  }

  const withOffer = {
    ...base,
    ok: true,
    offer_accepted: acceptance.accepted === true,
    offer_id: acceptance.offer_id,
    offer_version: acceptance.offer_version ?? null,
    accepted_price: acceptance.accepted_price ?? null,
    acceptance_basis: clean(acceptance_basis) || null,
    acceptance_reason: acceptance.reason || (acceptance.accepted ? "accepted" : null),
  };

  // ── 2. Create/reconcile exactly one closing case from canonical terms ─────
  // Runs even on a duplicate acceptance so a crash between step 1 and step 2 on
  // a prior turn is repaired here (the accepted offer already exists; the
  // closing case may not).
  let closing;
  try {
    closing = await createClosingCaseFromAcceptance({
      opportunity_id,
      thread_key,
      accepted_at: acceptance.accepted_at || acceptance_at,
      provenance: {
        source: "finalize_seller_acceptance",
        acceptance_event_id: clean(acceptance_event_id),
        accepted_offer_id: acceptance.offer_id,
        accepted_offer_version: acceptance.offer_version ?? null,
        ...(provenance && typeof provenance === "object" ? provenance : {}),
      },
      supabase,
    });
  } catch (error) {
    warn("[FINALIZE_ACCEPTANCE_CLOSING_FAILED]", {
      opportunity_id,
      offer_id: acceptance.offer_id,
      error: error?.message || "closing_case_failed",
    });
    // The accepted offer is durable; a missing closing case is recoverable on
    // the next turn or by the gap-recovery sweep. Report partial success.
    return { ...withOffer, reason: "closing_case_exception", closing_case_created: false };
  }

  if (!closing?.ok) {
    warn("[FINALIZE_ACCEPTANCE_CLOSING_BLOCKED]", {
      opportunity_id,
      offer_id: acceptance.offer_id,
      reason: closing?.reason || "closing_case_blocked",
    });
    return { ...withOffer, reason: closing?.reason || "closing_case_blocked", closing_case_created: false };
  }

  info("[FINALIZE_ACCEPTANCE_CONVERGED]", {
    opportunity_id,
    offer_id: acceptance.offer_id,
    offer_version: acceptance.offer_version ?? null,
    closing_case_id: closing.closing_case_id,
    closing_case_created: closing.created === true,
    accepted_price: acceptance.accepted_price ?? null,
  });

  return {
    ...withOffer,
    reason: "converged",
    closing_case_id: closing.closing_case_id || null,
    closing_case_created: closing.created === true,
    closing_case: closing.closing_case || null,
  };
}

export default finalizeSellerAcceptance;
