/**
 * email-eligibility-store.js
 *
 * Fetches the facts that evaluateEmailOutreachEligibility() decides on.
 *
 * SPLIT ON PURPOSE. The decision is pure and lives next door; this file is the
 * only part that touches the database. That split is what makes every
 * eligibility rule testable without a Supabase client, and what makes a verdict
 * replayable later from the facts that produced it.
 *
 * THE DISTINCTION THIS FILE EXISTS TO PRESERVE.
 *
 *     null       we looked, and there is no such record
 *     undefined  we could not look
 *
 *   The evaluator treats `undefined` as a refusal. That is not pedantry: the
 *   previous implementation of this lookup queried columns that do not exist,
 *   caught the resulting error, and returned "no recent outreach" -- so the only
 *   duplicate-contact protection in the system failed OPEN, silently, for every
 *   row. A read error must never be indistinguishable from a clean read.
 *
 * COLUMN NAMES ARE THE ONES PRODUCTION HAS.
 *   contact_outreach_state keys owner and property as `podio_master_owner_id`
 *   and `podio_property_id`, and records recency as last_sms_at / last_email_at /
 *   last_outbound_at. There is no `master_owner_id`, no `property_id` and no
 *   `last_outreach_at` on that table. Every one of those was queried by the
 *   previous code.
 *
 * SUPPRESSION IS CHECKED ON BOTH FORMS OF THE ADDRESS.
 *   The normalized address is what we would send to; the mailbox identity is
 *   where plus-tags and Gmail dots have been folded away. A seller who
 *   unsubscribed as bob+house@gmail.com has unsubscribed as bob@gmail.com too,
 *   and checking only one form would let the other through.
 */

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { child } from "@/lib/logging/logger.js";
import { normalizeEmailAddress } from "@/lib/domain/email/normalize-email-address.js";
import {
  evaluateEmailOutreachEligibility,
} from "@/lib/domain/email/email-outreach-eligibility.js";

const logger = child({ module: "domain.email.eligibility_store" });

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @returns {Promise<{suppression: object|null|undefined}>}
 *          `undefined` when the lookup itself failed.
 */
export async function loadEmailSuppression(address, deps = {}) {
  const db = deps.supabase || defaultSupabase;
  const normalized = normalizeEmailAddress(address);
  if (!normalized.ok) return { suppression: null, reason: normalized.reason };

  const candidates = normalized.normalized === normalized.mailbox_identity
    ? [normalized.normalized]
    : [normalized.normalized, normalized.mailbox_identity];

  const { data, error } = await db
    .from("email_suppression")
    .select("email_address, reason, source, is_active, expires_at, last_event_at, metadata")
    .in("email_address", candidates)
    .eq("is_active", true);

  if (error) {
    logger.error("email.suppression_lookup_failed", {
      reason: clean(error.message) || "unknown",
    });
    // Deliberately undefined, not null. See the header.
    return { suppression: undefined, reason: "suppression_lookup_failed" };
  }

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return { suppression: null };

  // More than one row can match when both address forms are suppressed under
  // different reasons. Take the most durable one, so a soft bounce cannot mask
  // an unsubscribe recorded against the folded form.
  const DURABILITY = ["unsubscribed", "complaint", "hard_bounce", "blocked", "invalid_address", "manual", "soft_bounce"];
  const ranked = [...rows].sort(
    (a, b) => DURABILITY.indexOf(clean(a.reason)) - DURABILITY.indexOf(clean(b.reason))
  );
  return { suppression: ranked[0] };
}

/**
 * @returns {Promise<{contact_state: object|null|undefined}>}
 */
export async function loadContactOutreachState({ master_owner_id, property_id, email_address } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase;
  const owner = clean(master_owner_id);
  const property = clean(property_id);

  // Without an owner anchor there is no row to find. That is a clean "no prior
  // contact recorded", not a failed read -- the caller genuinely has nothing to
  // look up, and saying so is different from being unable to look.
  if (!owner) return { contact_state: null, reason: "no_owner_anchor" };

  let query = db
    .from("contact_outreach_state")
    .select([
      "podio_master_owner_id", "podio_property_id", "to_email", "to_phone_number", "channel",
      "last_sms_at", "last_email_at", "last_outbound_at", "last_inbound_at",
      "next_allowed_sms_at", "next_allowed_email_at", "next_allowed_any_contact_at",
      "is_paused", "dnc", "pause_reason", "suppression_until", "suppression_reason",
      "touch_count", "current_touch_number", "current_campaign_key", "current_stage",
    ].join(","))
    .eq("podio_master_owner_id", owner);

  if (property) query = query.eq("podio_property_id", property);

  const { data, error } = await query.limit(50);

  if (error) {
    logger.error("email.contact_state_lookup_failed", {
      reason: clean(error.message) || "unknown",
    });
    return { contact_state: undefined, reason: "contact_state_lookup_failed" };
  }

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return { contact_state: null };

  // One (owner, property) can carry a row per channel. Contact history is a
  // property of the SELLER, not of a transport, so they are folded into a single
  // view taking the most restrictive value of each field. Reading only the
  // channel === 'email' row would let an SMS sent an hour ago go unseen, which
  // is the exact duplicate-contact case this whole path exists to prevent.
  return { contact_state: foldContactStateRows(rows, email_address) };
}

function maxTime(values) {
  const times = values
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((ts) => Number.isFinite(ts));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export function foldContactStateRows(rows = [], email_address = null) {
  const normalized_target = normalizeEmailAddress(email_address);
  // A row addressed to a DIFFERENT mailbox still constrains us: it records that
  // this seller was contacted. The address is used to pick which row's own
  // fields to prefer, never to discard the others' recency.
  const relevant = rows.filter((row) => {
    if (!normalized_target.ok) return true;
    const row_email = normalizeEmailAddress(row.to_email);
    return !row_email.ok || row_email.mailbox_identity === normalized_target.mailbox_identity;
  });
  const preferred = relevant[0] || rows[0] || {};

  return {
    podio_master_owner_id: preferred.podio_master_owner_id ?? null,
    podio_property_id: preferred.podio_property_id ?? null,
    to_email: preferred.to_email ?? null,
    // Any row saying "do not contact" or "paused" wins over every row that does not.
    dnc: rows.some((row) => row.dnc === true),
    is_paused: rows.some((row) => row.is_paused === true),
    pause_reason: rows.find((row) => row.is_paused === true)?.pause_reason ?? null,
    suppression_until: maxTime(rows.map((row) => row.suppression_until)),
    suppression_reason: rows.find((row) => row.suppression_until)?.suppression_reason ?? null,
    // Latest contact across every channel: the most restrictive reading.
    last_sms_at: maxTime(rows.map((row) => row.last_sms_at)),
    last_email_at: maxTime(rows.map((row) => row.last_email_at)),
    last_outbound_at: maxTime(rows.map((row) => row.last_outbound_at)),
    last_inbound_at: maxTime(rows.map((row) => row.last_inbound_at)),
    next_allowed_email_at: maxTime(rows.map((row) => row.next_allowed_email_at)),
    next_allowed_any_contact_at: maxTime(rows.map((row) => row.next_allowed_any_contact_at)),
    // Touches are per (owner, property) across channels, so the largest count is
    // the true one; summing would double-count a touch recorded on two rows.
    touch_count: rows.reduce(
      (max, row) => Math.max(max, Number(row.touch_count) || 0),
      0
    ),
    current_campaign_key: preferred.current_campaign_key ?? null,
    current_stage: preferred.current_stage ?? null,
  };
}

/**
 * The one call an email sender should make before asking for an attempt.
 *
 * Returns the full verdict, including the facts it was computed from, so the
 * decision can be logged and later explained without a second query.
 */
export async function resolveEmailOutreachEligibility(
  { email_address, master_owner_id = null, property_id = null, address_record = null, policy = null, now = null } = {},
  deps = {}
) {
  const [suppression_result, contact_result] = await Promise.all([
    loadEmailSuppression(email_address, deps),
    loadContactOutreachState({ master_owner_id, property_id, email_address }, deps),
  ]);

  const verdict = evaluateEmailOutreachEligibility({
    email_address,
    suppression: suppression_result.suppression,
    contact_state: contact_result.contact_state,
    address_record,
    policy: policy || undefined,
    now: now || undefined,
  });

  return {
    ...verdict,
    facts: {
      suppression: suppression_result.suppression ?? null,
      suppression_read: suppression_result.suppression === undefined ? "failed" : "ok",
      contact_state: contact_result.contact_state ?? null,
      contact_state_read: contact_result.contact_state === undefined ? "failed" : "ok",
      master_owner_id: clean(master_owner_id) || null,
      property_id: clean(property_id) || null,
    },
  };
}

export default resolveEmailOutreachEligibility;
