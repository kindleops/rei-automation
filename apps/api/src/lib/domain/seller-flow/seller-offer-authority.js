// ─── seller-offer-authority.js ──────────────────────────────────────────────
// THE canonical Seller Offer Term Authority.
//
// THE INVARIANT THIS EXISTS TO ENFORCE:
//   the amount in the seller's SMS must equal the amount in the persisted
//   active offer. There must never be a state where the seller received $X and
//   production has no durable record that $X was the active offer.
//
// So `persistActiveOffer` is called BEFORE the queue insert, and the resulting
// offer_id/offer_version is bound onto the queued row. If persistence fails,
// the caller must not send — the offer is the precondition of the send, not a
// post-hoc echo of it.
//
// This NORMALIZES the authority that already exists as
// `acquisition_opportunities.metadata.negotiation_state.offers_made[]`; it does
// not introduce a competing one. The opportunity stays the entity of record and
// carries active_offer_id / accepted_offer_id pointers.
//
// TERM POLICY: closing_date/closing_term and emd_amount/emd_term are written
// ONLY from an explicitly supplied policy. This system has NO canonical
// closing-date policy and NO canonical EMD policy, so they are normally null,
// and an offer missing them cannot complete a contract. Nothing is defaulted
// here — inventing 14 days or a deposit figure would fabricate a contract term.

import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const OFFER_STATUS = Object.freeze({
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  ACCEPTED: "accepted",
  WITHDRAWN: "withdrawn",
  EXPIRED: "expired",
});

// Outbound offer templates whose rendered body carries a monetary amount.
export const MONETARY_OFFER_USE_CASES = new Set([
  "initial_offer",
  "conditional_offer",
  "counter_offer",
  "final_offer",
  "offer_reveal_cash",
]);

export function buildOfferId(opportunity_id, version) {
  return `offer:${clean(opportunity_id)}:v${Number(version)}`;
}

/** Immutable hash of the contract-bearing terms of an offer. */
export function buildOfferTermsHash({
  opportunity_id = null,
  purchase_price = null,
  closing_date = null,
  closing_term = null,
  emd_amount = null,
  emd_term = null,
} = {}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        clean(opportunity_id),
        money(purchase_price),
        clean(closing_date) || null,
        clean(closing_term) || null,
        money(emd_amount),
        clean(emd_term) || null,
      ])
    )
    .digest("hex");
}

/** Current active offer for an opportunity (at most one, DB-enforced). */
export async function loadActiveOffer({ opportunity_id, supabase } = {}) {
  if (!clean(opportunity_id)) return null;
  const { data, error } = await supabase
    .from("seller_offers")
    .select("*")
    .eq("opportunity_id", clean(opportunity_id))
    .eq("status", OFFER_STATUS.ACTIVE)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function nextOfferVersion(supabase, opportunity_id) {
  const { data, error } = await supabase
    .from("seller_offers")
    .select("offer_version")
    .eq("opportunity_id", clean(opportunity_id))
    .order("offer_version", { ascending: false })
    .limit(1);
  if (error) throw error;
  const highest = Array.isArray(data) && data.length ? Number(data[0].offer_version) : 0;
  return (Number.isFinite(highest) ? highest : 0) + 1;
}

/**
 * Persist a new ACTIVE offer. MUST be called before (or atomically with) the
 * send. Supersedes any prior active offer without deleting history.
 *
 * Returns { ok, offer_id, offer_version, purchase_price, terms_hash } or
 * { ok:false, reason } — on failure the caller MUST NOT send.
 */
export async function persistActiveOffer({
  opportunity_id = null,
  property_id = null,
  thread_key = null,
  master_owner_id = null,
  purchase_price = null,
  offer_type = "initial_offer",
  direction = "outbound",
  // Lineage — recorded as provenance, NEVER used as the price itself.
  ade_snapshot_id = null,
  recommended_offer = null,
  authorized_ceiling = null,
  valuation_mid = null,
  strategy = null,
  // Terms only from an explicit policy; no defaults invented here.
  closing_date = null,
  closing_term = null,
  emd_amount = null,
  emd_term = null,
  source_message_event_id = null,
  metadata = {},
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, reason: "missing_supabase" };

  const price = money(purchase_price);
  if (!price) return { ok: false, reason: "missing_offer_price" };
  if (!clean(thread_key)) return { ok: false, reason: "missing_thread_key" };
  if (!clean(opportunity_id)) return { ok: false, reason: "missing_opportunity_id" };

  let version;
  try {
    version = await nextOfferVersion(supabase, opportunity_id);
  } catch (error) {
    warn("[OFFER_VERSION_LOOKUP_FAILED]", {
      opportunity_id,
      error: error?.message || "version_lookup_failed",
    });
    return { ok: false, reason: "version_lookup_failed" };
  }

  const offer_id = buildOfferId(opportunity_id, version);
  const terms_hash = buildOfferTermsHash({
    opportunity_id,
    purchase_price: price,
    closing_date,
    closing_term,
    emd_amount,
    emd_term,
  });

  // Supersede the prior active offer FIRST so the one-active unique index can
  // never reject the new row. History is preserved (status change only).
  try {
    await supabase
      .from("seller_offers")
      .update({
        status: OFFER_STATUS.SUPERSEDED,
        superseded_at: new Date().toISOString(),
        superseded_by_offer_id: offer_id,
      })
      .eq("opportunity_id", clean(opportunity_id))
      .eq("status", OFFER_STATUS.ACTIVE);
  } catch (error) {
    warn("[OFFER_SUPERSEDE_FAILED]", {
      opportunity_id,
      error: error?.message || "supersede_failed",
    });
    return { ok: false, reason: "supersede_failed" };
  }

  const row = {
    offer_id,
    opportunity_id: clean(opportunity_id),
    property_id: clean(property_id) || null,
    thread_key: clean(thread_key),
    master_owner_id: clean(master_owner_id) || null,
    offer_version: version,
    offer_type: clean(offer_type) || "initial_offer",
    direction: clean(direction) || "outbound",
    purchase_price: price,
    closing_date: clean(closing_date) || null,
    closing_term: clean(closing_term) || null,
    emd_amount: money(emd_amount),
    emd_term: clean(emd_term) || null,
    ade_snapshot_id: clean(ade_snapshot_id) || null,
    recommended_offer: money(recommended_offer),
    authorized_ceiling: money(authorized_ceiling),
    valuation_mid: money(valuation_mid),
    strategy: clean(strategy) || null,
    status: OFFER_STATUS.ACTIVE,
    source_message_event_id: clean(source_message_event_id) || null,
    terms_hash,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };

  const { data: inserted, error: insert_error } = await supabase
    .from("seller_offers")
    .insert(row)
    .select("*")
    .maybeSingle();

  if (insert_error) {
    warn("[OFFER_PERSIST_FAILED]", {
      opportunity_id,
      offer_id,
      error: insert_error?.message || "insert_failed",
    });
    return { ok: false, reason: "offer_persist_failed" };
  }

  // Point the opportunity at its active offer (best-effort pointer; the
  // seller_offers row is the authority).
  try {
    await supabase
      .from("acquisition_opportunities")
      .update({ active_offer_id: offer_id })
      .eq("id", clean(opportunity_id));
  } catch {
    /* pointer only */
  }

  info("[OFFER_PERSISTED]", { offer_id, offer_version: version, purchase_price: price });
  return {
    ok: true,
    offer_id,
    offer_version: version,
    purchase_price: price,
    terms_hash,
    offer: inserted || row,
  };
}

/** Bind the queued SMS row to the offer it advertises, and stamp sent_at. */
export async function bindOfferToQueueRow({
  offer_id = null,
  send_queue_row_id = null,
  sent_at = null,
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase || !clean(offer_id)) return { ok: false, reason: "missing_offer_id" };
  const { error } = await supabase
    .from("seller_offers")
    .update({
      send_queue_row_id: clean(send_queue_row_id) || null,
      sent_at: iso(sent_at) || new Date().toISOString(),
    })
    .eq("offer_id", clean(offer_id));
  if (error) {
    warn("[OFFER_QUEUE_BIND_FAILED]", { offer_id, error: error?.message || "bind_failed" });
    return { ok: false, reason: "bind_failed" };
  }
  return { ok: true, offer_id };
}

/**
 * Record a seller COUNTER as a new inbound offer version. History is never
 * overwritten; the counter supersedes the prior active proposal and becomes the
 * current negotiated terms.
 *
 * A counter price must come from the parsed CURRENT message. A historical
 * `asking_price` column value is explicitly NOT accepted as a counter, since
 * that field is known to carry extraction corruption (values like 2, 4, 331).
 */
export async function recordSellerCounter({
  opportunity_id = null,
  thread_key = null,
  property_id = null,
  master_owner_id = null,
  counter_price = null,
  source_message_event_id = null,
  metadata = {},
  supabase: injected = null,
} = {}) {
  const price = money(counter_price);
  if (!price) return { ok: false, reason: "missing_counter_price" };
  return persistActiveOffer({
    opportunity_id,
    property_id,
    thread_key,
    master_owner_id,
    purchase_price: price,
    offer_type: "seller_counter",
    direction: "inbound",
    source_message_event_id,
    metadata: { ...metadata, counter_source: "seller_message" },
    supabase: injected,
  });
}

/**
 * Bind an acceptance to the EXACT active offer.
 *
 * Acceptance must resolve to seller + property + opportunity + active offer
 * id/version + chronology. A bare "yes" is never acceptance on its own:
 *   * there must BE an active offer (otherwise there is nothing to accept);
 *   * the acceptance message must be NEWER than the offer it accepts, so a
 *     stale "yes" predating the current offer cannot accept it;
 *   * if the caller names an offer id/version, it must match the active one, so
 *     a "yes" to a superseded offer is rejected;
 *   * the same acceptance_event_id can only ever accept once (DB unique).
 *
 * Returns { ok, accepted, offer_id, offer_version, accepted_price, terms_hash }.
 */
export async function acceptActiveOffer({
  opportunity_id = null,
  acceptance_event_id = null,
  acceptance_at = null,
  expected_offer_id = null,
  expected_offer_version = null,
  offer_sent_before = true,
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, accepted: false, reason: "missing_supabase" };
  if (!clean(acceptance_event_id)) {
    return { ok: false, accepted: false, reason: "missing_acceptance_event_id" };
  }

  // Replay: this exact inbound already accepted something.
  const { data: prior } = await supabase
    .from("seller_offers")
    .select("offer_id,offer_version,accepted_price,terms_hash,status")
    .eq("acceptance_event_id", clean(acceptance_event_id))
    .maybeSingle();
  if (prior) {
    return {
      ok: true,
      accepted: false,
      reason: "duplicate_acceptance",
      offer_id: prior.offer_id,
      offer_version: prior.offer_version,
      accepted_price: prior.accepted_price,
      terms_hash: prior.terms_hash,
    };
  }

  let active;
  try {
    active = await loadActiveOffer({ opportunity_id, supabase });
  } catch (error) {
    warn("[OFFER_ACCEPT_LOOKUP_FAILED]", {
      opportunity_id,
      error: error?.message || "lookup_failed",
    });
    return { ok: false, accepted: false, reason: "lookup_failed" };
  }

  // A "yes" with no active offer is not acceptance of anything.
  if (!active) return { ok: false, accepted: false, reason: "no_active_offer" };

  // A "yes" naming a different (superseded) offer is not acceptance of the
  // current one.
  if (clean(expected_offer_id) && clean(expected_offer_id) !== clean(active.offer_id)) {
    return {
      ok: false,
      accepted: false,
      reason: "stale_offer_acceptance",
      active_offer_id: active.offer_id,
    };
  }
  if (
    expected_offer_version != null &&
    Number(expected_offer_version) !== Number(active.offer_version)
  ) {
    return {
      ok: false,
      accepted: false,
      reason: "stale_offer_acceptance",
      active_offer_version: active.offer_version,
    };
  }

  // Chronology: the acceptance must come AFTER the offer reached the seller.
  const accepted_iso = iso(acceptance_at) || new Date().toISOString();
  const offer_ts = iso(active.sent_at) || iso(active.created_at);
  if (offer_sent_before && offer_ts && accepted_iso < offer_ts) {
    return {
      ok: false,
      accepted: false,
      reason: "acceptance_predates_offer",
      offer_id: active.offer_id,
    };
  }

  const { data: updated, error } = await supabase
    .from("seller_offers")
    .update({
      status: OFFER_STATUS.ACCEPTED,
      accepted_at: accepted_iso,
      acceptance_event_id: clean(acceptance_event_id),
      accepted_price: active.purchase_price,
    })
    .eq("offer_id", clean(active.offer_id))
    .eq("status", OFFER_STATUS.ACTIVE)
    .select("*")
    .maybeSingle();

  if (error) {
    warn("[OFFER_ACCEPT_FAILED]", {
      offer_id: active.offer_id,
      error: error?.message || "accept_failed",
    });
    return { ok: false, accepted: false, reason: "accept_failed" };
  }
  if (!updated) {
    // Lost the race: something else moved it off active.
    return { ok: true, accepted: false, reason: "offer_no_longer_active" };
  }

  try {
    await supabase
      .from("acquisition_opportunities")
      .update({ accepted_offer_id: updated.offer_id, current_offer: updated.purchase_price })
      .eq("id", clean(opportunity_id));
  } catch {
    /* pointer only */
  }

  info("[OFFER_ACCEPTED]", {
    offer_id: updated.offer_id,
    offer_version: updated.offer_version,
    accepted_price: updated.accepted_price,
  });

  return {
    ok: true,
    accepted: true,
    offer_id: updated.offer_id,
    offer_version: updated.offer_version,
    accepted_price: updated.accepted_price,
    closing_date: updated.closing_date,
    closing_term: updated.closing_term,
    emd_amount: updated.emd_amount,
    emd_term: updated.emd_term,
    terms_hash: updated.terms_hash,
    accepted_at: updated.accepted_at,
    offer: updated,
  };
}

/** The accepted offer for an opportunity — the contract's term source. */
export async function loadAcceptedOffer({ opportunity_id, supabase: injected = null } = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase || !clean(opportunity_id)) return null;
  const { data, error } = await supabase
    .from("seller_offers")
    .select("*")
    .eq("opportunity_id", clean(opportunity_id))
    .eq("status", OFFER_STATUS.ACCEPTED)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export default persistActiveOffer;
