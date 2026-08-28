// ─── resolve-seller-signer-email.js ─────────────────────────────────────────
// Autonomous signer-email resolution for the closing contract.
//
// A DocuSign envelope needs a seller EMAIL, but the seller conversation is SMS:
// the canonical graph carries a phone. Rather than parking the deal for a human,
// this resolves an email from the EXISTING contact graph, and when no
// trustworthy email exists the seller conversation ASKS for one by SMS.
//
// SOURCE (existing, not invented): public.emails — the scored contact-graph
// email entity keyed by master_owner_id, carrying email_role, email_rank,
// email_score_final, is_best_email_for_owner and email_eligible. (Verified in
// production: 165,655 email rows; 90,543 / 102,251 master owners carry a best
// email.) master_owners.best_email_1 and prospects.best_email are display-grade
// mirrors of the same graph and are NOT used to bind a signature.
//
// TRUST POLICY. This email receives a legally binding purchase agreement, so the
// bar is deliberately high and conservative:
//   * SELLER_PROVIDED (the seller replied with it in the conversation) is
//     first-party and always wins.
//   * Otherwise the graph email must be eligible, role=Primary, flagged
//     is_best_email_for_owner, and score >= GRAPH_MIN_SCORE.
//   * Business / Unknown / Secondary roles are REJECTED for signature: a
//     business address is frequently a property manager or LLC admin, not the
//     person with authority to sign.
// Anything below the bar is not "unknown" — it is a prompt to ask the seller.

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { warn } from "@/lib/logging/logger.js";

// Score floor for a graph-sourced signature email. The population runs 65..100
// (median 100) and best-for-owner rows start at 71, so 80 keeps the confident
// mass while excluding weakly-linked records.
export const GRAPH_MIN_SCORE = 80;

export const SIGNER_EMAIL_SOURCES = Object.freeze({
  SELLER_PROVIDED: "seller_provided",
  CONTACT_GRAPH: "contact_graph",
});

// Roles acceptable for binding a signature.
const SIGNATURE_ROLES = new Set(["primary"]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/** Conservative syntactic validity — a malformed address can never be used. */
export function isPlausibleEmail(value) {
  const email = lower(value);
  if (!email || email.length > 254) return false;
  if (/\s/.test(email)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email);
}

/**
 * Decide whether a contact-graph email row is trustworthy enough to receive a
 * binding contract. Pure and exported so the policy is directly assertable.
 */
export function isTrustworthyGraphEmail(row = {}) {
  if (!isPlausibleEmail(row.email_normalized || row.email)) return false;
  if (row.email_eligible === false) return false;
  if (!SIGNATURE_ROLES.has(lower(row.email_role))) return false;
  if (row.is_best_email_for_owner !== true) return false;
  const score = Number(row.email_score_final);
  return Number.isFinite(score) && score >= GRAPH_MIN_SCORE;
}

/**
 * Resolve the signer email for a closing case.
 *
 * Returns:
 *   { ok:true, email, source, provenance }              — usable email
 *   { ok:false, reason:"no_trustworthy_email",
 *     should_request_from_seller:true }                 — ASK the seller by SMS
 *
 * Never returns a human-review disposition: a missing email is a conversation
 * step, not an escalation.
 */
export async function resolveSellerSignerEmail({
  master_owner_id = null,
  seller_provided_email = null,
  supabase: injected = null,
} = {}) {
  // 1) First-party: the seller told us. Highest possible trust.
  if (isPlausibleEmail(seller_provided_email)) {
    return {
      ok: true,
      email: lower(seller_provided_email),
      source: SIGNER_EMAIL_SOURCES.SELLER_PROVIDED,
      provenance: {
        source: SIGNER_EMAIL_SOURCES.SELLER_PROVIDED,
        captured_from: "seller_sms_reply",
      },
    };
  }

  const owner_id = clean(master_owner_id);
  if (!owner_id) {
    return { ok: false, reason: "no_trustworthy_email", should_request_from_seller: true };
  }

  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, reason: "missing_supabase", should_request_from_seller: false };

  let rows = [];
  try {
    const { data, error } = await supabase
      .from("emails")
      .select(
        "email_id,email,email_normalized,email_role,email_rank,email_score_final,is_best_email_for_owner,email_eligible,master_owner_id"
      )
      .eq("master_owner_id", owner_id)
      .order("email_score_final", { ascending: false })
      .limit(10);
    if (error) throw error;
    rows = Array.isArray(data) ? data : [];
  } catch (error) {
    warn("[SIGNER_EMAIL_LOOKUP_FAILED]", {
      master_owner_id: owner_id,
      error: error?.message || "lookup_failed",
    });
    // A lookup failure is not evidence of absence — do not ask the seller for
    // an email we may already have.
    return { ok: false, reason: "lookup_failed", should_request_from_seller: false };
  }

  const candidate = rows.find(isTrustworthyGraphEmail);
  if (!candidate) {
    return {
      ok: false,
      reason: "no_trustworthy_email",
      should_request_from_seller: true,
      candidates_considered: rows.length,
    };
  }

  return {
    ok: true,
    email: lower(candidate.email_normalized || candidate.email),
    source: SIGNER_EMAIL_SOURCES.CONTACT_GRAPH,
    provenance: {
      source: SIGNER_EMAIL_SOURCES.CONTACT_GRAPH,
      table: "emails",
      email_id: clean(candidate.email_id) || null,
      email_role: clean(candidate.email_role) || null,
      email_rank: candidate.email_rank ?? null,
      email_score_final: candidate.email_score_final ?? null,
      is_best_email_for_owner: candidate.is_best_email_for_owner === true,
      min_score_policy: GRAPH_MIN_SCORE,
    },
  };
}

/**
 * Resolve and PERSIST the signer email onto a closing case (with provenance).
 * Returns { ok, email, source, persisted, should_request_from_seller, reason }.
 * An already-present signer email is never overwritten by a graph guess.
 */
export async function resolveAndPersistSignerEmail({
  closing_case = null,
  seller_provided_email = null,
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!closing_case?.closing_case_id) {
    return { ok: false, persisted: false, reason: "missing_closing_case" };
  }

  // Already bound: keep it. Only a first-party seller-provided address may
  // replace an existing graph-sourced address.
  const existing = clean(closing_case.signer_email);
  const provided_ok = isPlausibleEmail(seller_provided_email);
  if (existing && !provided_ok) {
    return { ok: true, persisted: false, email: existing, reason: "already_present" };
  }

  const resolved = await resolveSellerSignerEmail({
    master_owner_id: closing_case.master_owner_id,
    seller_provided_email,
    supabase,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      persisted: false,
      reason: resolved.reason,
      should_request_from_seller: Boolean(resolved.should_request_from_seller),
    };
  }

  const provenance = {
    ...(closing_case.provenance && typeof closing_case.provenance === "object"
      ? closing_case.provenance
      : {}),
    signer_email: resolved.provenance,
  };

  const { error } = await supabase
    .from("closing_cases")
    .update({ signer_email: resolved.email, provenance })
    .eq("closing_case_id", clean(closing_case.closing_case_id));

  if (error) {
    warn("[SIGNER_EMAIL_PERSIST_FAILED]", {
      closing_case_id: closing_case.closing_case_id,
      error: error?.message || "persist_failed",
    });
    return { ok: false, persisted: false, reason: "persist_failed" };
  }

  return {
    ok: true,
    persisted: true,
    email: resolved.email,
    source: resolved.source,
    provenance: resolved.provenance,
  };
}

export default resolveSellerSignerEmail;
