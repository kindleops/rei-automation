// ─── create-closing-case-from-acceptance.js ─────────────────────────────────
// THE canonical Supabase-native contract creator.
//
// Accepted seller terms create exactly ONE closing case, built from the existing
// Supabase authorities — never from SMS text. The seller's words route the
// conversation; they do not set the contract terms. Canonical persisted terms
// (the ADE/negotiation-authorized offer on acquisition_opportunities) are the
// only source of the purchase price, so a seller message cannot move money.
//
// Authorities (in precedence order):
//   * public.acquisition_opportunities — identity + canonical negotiated terms
//     (current_offer / recommended_offer, property_address_full,
//     primary_property_id, master_owner_id, seller_display_name,
//     primary_thread_key, version)
//   * public.deal_thread_state        — thread/contact identity fallback
//   * public.property_cash_offer_snapshots — property address fallback
//
// IDEMPOTENCY. closing_case_id is deterministic per opportunity, and the DB
// carries a UNIQUE index on opportunity_id, so replaying the same acceptance
// cannot create a second closing case. Re-acceptance with IDENTICAL terms is a
// no-op. Re-acceptance with NEWER terms updates terms in place. A STALE
// acceptance (older than the recorded acceptance) is REJECTED and never
// overwrites newer negotiated terms. A DocuSign envelope id, once persisted, is
// never overwritten here.
//
// This module performs NO send. It only records the contract that an autonomous
// acceptance produced; envelope creation is a separate, gated step.

import crypto from "node:crypto";

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Deterministic case id — one closing case per opportunity. */
export function buildClosingCaseId(opportunity_id) {
  const id = clean(opportunity_id);
  return id ? `closing:${id}` : null;
}

/**
 * Stable hash of the contract-bearing terms. Any change to a term that would
 * alter the signed document changes the hash, which is what distinguishes a
 * replay (same hash -> no-op) from a renegotiation (new hash -> update).
 */
export function buildTermsHash(terms = {}) {
  const canonical = JSON.stringify([
    clean(terms.opportunity_id),
    clean(terms.property_id),
    clean(terms.property_address),
    toNumber(terms.seller_contract_price),
    toNumber(terms.earnest_money),
    toIso(terms.scheduled_closing_date),
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Resolve canonical contract terms from persisted Supabase authorities.
 * Returns { ok, terms, reason }. Fails closed when no canonical price exists —
 * a contract is never created from an unpriced or SMS-derived amount.
 */
export function resolveCanonicalTerms({
  opportunity = null,
  thread_state = null,
  offer_snapshot = null,
  overrides = {},
} = {}) {
  if (!opportunity?.id) {
    return { ok: false, reason: "missing_opportunity" };
  }

  // The accepted purchase price comes ONLY from persisted negotiation authority.
  // current_offer is the live negotiated number; recommended_offer is the ADE
  // baseline used when acceptance lands before a counter was recorded.
  const seller_contract_price =
    toNumber(opportunity.current_offer) ?? toNumber(opportunity.recommended_offer);

  if (!seller_contract_price) {
    return { ok: false, reason: "missing_canonical_offer_price" };
  }

  const property_address =
    clean(opportunity.property_address_full) ||
    clean(offer_snapshot?.property_address) ||
    null;

  const terms = {
    opportunity_id: clean(opportunity.id),
    property_id:
      clean(opportunity.primary_property_id) ||
      clean(thread_state?.property_id) ||
      clean(offer_snapshot?.property_id) ||
      null,
    property_address,
    master_owner_id:
      clean(opportunity.master_owner_id) || clean(thread_state?.master_owner_id) || null,
    thread_key: clean(opportunity.primary_thread_key) || clean(thread_state?.thread_key) || null,
    seller_display_name: clean(opportunity.seller_display_name) || null,
    seller_contract_price,
    // Optional terms: only persisted when supplied by canonical state. Never
    // invented, so a template tab stays empty rather than showing a guess.
    earnest_money: toNumber(overrides.earnest_money),
    scheduled_closing_date: toIso(overrides.scheduled_closing_date),
    // Signer identity is frequently absent for SMS-sourced sellers (the
    // canonical graph carries a phone, not an email). Nullable by design; the
    // envelope step fails closed when it is still missing.
    signer_email: clean(overrides.signer_email) || null,
    signer_name: clean(overrides.signer_name) || clean(opportunity.seller_display_name) || null,
    negotiation_id: clean(overrides.negotiation_id) || null,
    offer_id: clean(overrides.offer_id) || null,
    opportunity_version: opportunity.version ?? null,
  };

  return { ok: true, terms };
}

async function loadAuthorities(supabase, { opportunity_id, thread_key }) {
  let opportunity = null;

  if (clean(opportunity_id)) {
    const { data, error } = await supabase
      .from("acquisition_opportunities")
      .select("*")
      .eq("id", clean(opportunity_id))
      .maybeSingle();
    if (error) throw error;
    opportunity = data || null;
  } else if (clean(thread_key)) {
    const { data, error } = await supabase
      .from("acquisition_opportunities")
      .select("*")
      .eq("primary_thread_key", clean(thread_key))
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    opportunity = Array.isArray(data) && data.length ? data[0] : null;
  }

  const resolved_thread_key = clean(opportunity?.primary_thread_key) || clean(thread_key);
  let thread_state = null;
  if (resolved_thread_key) {
    const { data, error } = await supabase
      .from("deal_thread_state")
      .select("thread_key,master_owner_id,property_id,best_phone")
      .eq("thread_key", resolved_thread_key)
      .maybeSingle();
    if (error) throw error;
    thread_state = data || null;
  }

  const property_id = clean(opportunity?.primary_property_id) || clean(thread_state?.property_id);
  let offer_snapshot = null;
  if (property_id) {
    const { data, error } = await supabase
      .from("property_cash_offer_snapshots")
      .select("property_id,property_address,cash_offer,generated_at")
      .eq("property_id", property_id)
      .order("generated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    offer_snapshot = Array.isArray(data) && data.length ? data[0] : null;
  }

  return { opportunity, thread_state, offer_snapshot };
}

/**
 * Create (or idempotently reconcile) the closing case for an accepted offer.
 *
 * Returns { ok, created, closing_case_id, closing_case, reason }.
 *   created:true  — a new closing case was written
 *   created:false — an existing case was reused (replay) or updated (renegotiation)
 *   ok:false      — nothing was written (missing authority / stale acceptance)
 */
export async function createClosingCaseFromAcceptance({
  opportunity_id = null,
  thread_key = null,
  accepted_at = null,
  overrides = {},
  provenance = {},
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, created: false, reason: "missing_supabase" };

  let authorities;
  try {
    authorities = await loadAuthorities(supabase, { opportunity_id, thread_key });
  } catch (error) {
    warn("[CLOSING_CASE_AUTHORITY_LOAD_FAILED]", {
      opportunity_id,
      thread_key,
      error: error?.message || "authority_load_failed",
    });
    return { ok: false, created: false, reason: "authority_load_failed" };
  }

  const resolved = resolveCanonicalTerms({ ...authorities, overrides });
  if (!resolved.ok) {
    return { ok: false, created: false, reason: resolved.reason };
  }

  const terms = resolved.terms;
  const closing_case_id = buildClosingCaseId(terms.opportunity_id);
  const terms_hash = buildTermsHash(terms);
  const accepted_iso = toIso(accepted_at) || new Date().toISOString();

  // Existing case for this opportunity (idempotency + staleness gate).
  const { data: existing, error: existing_error } = await supabase
    .from("closing_cases")
    .select("*")
    .eq("closing_case_id", closing_case_id)
    .maybeSingle();
  if (existing_error) {
    warn("[CLOSING_CASE_LOOKUP_FAILED]", {
      closing_case_id,
      error: existing_error?.message || "lookup_failed",
    });
    return { ok: false, created: false, reason: "lookup_failed" };
  }

  const base_row = {
    closing_case_id,
    opportunity_id: terms.opportunity_id,
    property_id: terms.property_id,
    property_address: terms.property_address,
    master_owner_id: terms.master_owner_id,
    thread_key: terms.thread_key,
    offer_id: terms.offer_id,
    negotiation_id: terms.negotiation_id,
    universal_stage: "formal_contract",
    closing_status: "not_scheduled",
    contract_status: "draft",
    accepted_at: accepted_iso,
    terms_hash,
    seller_contract_price: terms.seller_contract_price,
    earnest_money: terms.earnest_money,
    scheduled_closing_date: terms.scheduled_closing_date,
    signer_email: terms.signer_email,
    signer_name: terms.signer_name,
    last_activity_at: accepted_iso,
    provenance: {
      source: "supabase_native_acceptance",
      opportunity_version: terms.opportunity_version,
      ...(provenance && typeof provenance === "object" ? provenance : {}),
    },
  };

  if (existing) {
    // Wrong-bind guard: a case id is derived from the opportunity, so a
    // mismatch means the caller tried to bind another seller's closing.
    if (
      clean(existing.opportunity_id) &&
      clean(existing.opportunity_id) !== clean(terms.opportunity_id)
    ) {
      warn("[CLOSING_CASE_OPPORTUNITY_MISMATCH]", {
        closing_case_id,
        existing_opportunity_id: existing.opportunity_id,
        incoming_opportunity_id: terms.opportunity_id,
      });
      return { ok: false, created: false, reason: "opportunity_mismatch" };
    }

    // Replay: identical terms -> no write at all.
    if (clean(existing.terms_hash) === terms_hash) {
      return {
        ok: true,
        created: false,
        closing_case_id,
        closing_case: existing,
        reason: "already_exists",
      };
    }

    // Staleness: an acceptance older than the recorded one must never
    // overwrite newer negotiated terms.
    const existing_accepted = toIso(existing.accepted_at);
    if (existing_accepted && accepted_iso < existing_accepted) {
      warn("[CLOSING_CASE_STALE_ACCEPTANCE_REJECTED]", {
        closing_case_id,
        existing_accepted_at: existing_accepted,
        incoming_accepted_at: accepted_iso,
      });
      return {
        ok: false,
        created: false,
        closing_case_id,
        closing_case: existing,
        reason: "stale_acceptance",
      };
    }

    // Renegotiated terms: update in place. The envelope id is NEVER rewritten
    // here — an already-sent envelope keeps its binding.
    const { data: updated, error: update_error } = await supabase
      .from("closing_cases")
      .update(base_row)
      .eq("closing_case_id", closing_case_id)
      .select("*")
      .maybeSingle();
    if (update_error) {
      warn("[CLOSING_CASE_UPDATE_FAILED]", {
        closing_case_id,
        error: update_error?.message || "update_failed",
      });
      return { ok: false, created: false, reason: "update_failed" };
    }

    info("[CLOSING_CASE_TERMS_UPDATED]", { closing_case_id, terms_hash });
    return {
      ok: true,
      created: false,
      closing_case_id,
      closing_case: updated || existing,
      reason: "terms_updated",
    };
  }

  const { data: inserted, error: insert_error } = await supabase
    .from("closing_cases")
    .insert(base_row)
    .select("*")
    .maybeSingle();

  if (insert_error) {
    // A concurrent creator won the race; the unique indexes make that safe.
    warn("[CLOSING_CASE_INSERT_FAILED]", {
      closing_case_id,
      error: insert_error?.message || "insert_failed",
    });
    return { ok: false, created: false, closing_case_id, reason: "insert_failed" };
  }

  info("[CLOSING_CASE_CREATED]", {
    closing_case_id,
    opportunity_id: terms.opportunity_id,
    terms_hash,
  });
  return {
    ok: true,
    created: true,
    closing_case_id,
    closing_case: inserted,
    reason: "created",
  };
}

export default createClosingCaseFromAcceptance;
