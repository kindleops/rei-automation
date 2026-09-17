/**
 * Central registry of internal/test phone numbers.
 * These numbers are used for development, QA, and internal testing.
 * They must NEVER appear in seller coverage metrics, duplicate abuse analytics,
 * or production outbound queues unless explicitly in test mode.
 *
 * To add a number: append to INTERNAL_TEST_PHONE_SET below.
 * Format: E.164 (e.g. +16127433952)
 */
export const INTERNAL_TEST_PHONE_SET = new Set([
  "+16127433952", // Ryan's internal test number (107-touch control)
  "+16124515970", // Approved internal test number (live negotiation certification, alternate physical phone)
  "+16128072000", // Approved internal canary recipient (Stage 1 transport-chain proof)
  // INTERNAL_CANARY / NOT BUSINESS DATA. Operator-controlled handset for the
  // Offer Authority opener proof lane. Registration alone grants NOTHING: the
  // enqueue-time window exemption additionally requires an exact
  // campaign + target + recipient + sender pin AND a live scoped authorization.
  "+13059807795", // Approved internal canary recipient (Offer Authority opener proof)
  /**
   * Operator-designated replacement canary handset (2026-09-17). +16128072000
   * returned `SEND FAILED - NO SID` twice, on 09-07 and 09-17, from two
   * DIFFERENT senders, while the provider itself was healthy (505 sends in the
   * prior 30 days), so the fault tracked the recipient rather than the sender.
   *
   * Registering it here is what makes excludeInternalCanaryRows keep it out of
   * KPIs and what lets isInternalTestPhone admit it; as the note above says,
   * registration alone grants NOTHING at dispatch.
   *
   * It carries prior two-way traffic, and that traffic is test traffic rather
   * than a seller conversation: every message_events row has master_owner_id,
   * prospect_id and property_id NULL, it is absent from the 169k-row `phones`
   * graph, it has never been a campaign_target, and on 2026-09-10 it INITIATED
   * contact. Campaign-contacted sellers are graph-linked; this is not.
   */
  "+13055376631", // Approved internal canary recipient (commissioning 1B)
]);

/**
 * Returns true if the given phone number is an internal/test number.
 * Accepts E.164, digits-only, or formatted strings.
 */
export function isInternalTestPhone(phone) {
  if (!phone) return false;
  const raw = String(phone).trim();
  if (INTERNAL_TEST_PHONE_SET.has(raw)) return true;
  // Normalize to E.164 format for comparison
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    const normalized = `+1${digits}`;
    return INTERNAL_TEST_PHONE_SET.has(normalized);
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    const normalized = `+${digits}`;
    return INTERNAL_TEST_PHONE_SET.has(normalized);
  }
  return false;
}

/**
 * Filters an array of phone strings to only internal/test numbers.
 */
export function filterInternalTestPhones(phones) {
  return (Array.isArray(phones) ? phones : []).filter(isInternalTestPhone);
}

/**
 * Returns { real, internal } partition of an array of phone strings.
 */
export function partitionByInternalTest(phones) {
  const internal = [];
  const real = [];
  for (const p of Array.isArray(phones) ? phones : []) {
    if (isInternalTestPhone(p)) internal.push(p);
    else real.push(p);
  }
  return { real, internal };
}

// ── Internal canary record quarantine ───────────────────────────────────────
// Canonical row-level marker contract for internal canary / proof traffic.
// A record is canary-quarantined when ANY of these hold:
//   • its seller-side phone (thread_key / to_phone_number / canonical_e164 /
//     inbound from_phone_number) is in the internal test registry, or
//   • it is explicitly stamped (source === "internal_canary" or
//     metadata.internal_canary === true).
// Quarantined records must be excluded from normal production selection and
// KPI aggregation, while remaining addressable by EXPLICITLY authorized
// internal canary execution (queue-run proof mode / scoped canary).

export const INTERNAL_CANARY_SOURCE = "internal_canary";

/** True when a fact/queue/event row belongs to internal canary traffic. */
export function isInternalCanaryFactRow(row = {}) {
  if (!row || typeof row !== "object") return false;
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  if (metadata.internal_canary === true) return true;
  // Queue-runner proof vocabulary (queue-run-request.js) counts too.
  if (metadata.exclude_from_kpis === true || metadata.internal_test_phone === true) return true;
  const source = String(row.source ?? metadata.source ?? "").trim().toLowerCase();
  if (source === INTERNAL_CANARY_SOURCE) return true;
  return [row.thread_key, row.to_phone_number, row.canonical_e164, row.from_phone_number].some(
    (phone) => isInternalTestPhone(phone)
  );
}

/** Aggregation helper: drop internal canary rows from KPI fact sets. */
export function excludeInternalCanaryRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !isInternalCanaryFactRow(row));
}
