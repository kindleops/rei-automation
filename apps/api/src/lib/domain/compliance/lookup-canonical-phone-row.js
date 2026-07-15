import { normalizePhone } from "@/lib/utils/phones.js";
import { SEND_TIME_BLOCK_REASONS } from "@/lib/domain/compliance/canonical-no-contact-states.js";

/** Columns present on production public.phones — do not select legacy id or boolean flags. */
export const CANONICAL_PHONE_SELECT =
  "phone_id,canonical_e164,phone_contact_status,wrong_number_at,activity_status";

const PROOF_ACTIVITY_STATUSES = new Set(["internal_canary", "internal_test"]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/**
 * Normalize a phones row into the internal compliance contract regardless of
 * whether the source used phone_id or a legacy id alias.
 */
export function normalizeCanonicalPhoneRow(row = null) {
  if (!row || typeof row !== "object") return null;

  const phone_id = clean(row.phone_id) || clean(row.id) || null;
  const contact_status = lower(row.phone_contact_status);
  const wrong_number_at = clean(row.wrong_number_at);
  const activity_status = lower(row.activity_status);

  return {
    phone_id,
    canonical_e164: normalizePhone(row.canonical_e164) || clean(row.canonical_e164) || null,
    phone_contact_status: row.phone_contact_status || null,
    wrong_number_at: wrong_number_at || null,
    activity_status: row.activity_status || null,
    is_wrong_number:
      row.wrong_number === true ||
      contact_status === "wrong_number" ||
      Boolean(wrong_number_at),
    is_proof_phone: PROOF_ACTIVITY_STATUSES.has(activity_status),
    is_non_active:
      Boolean(activity_status) &&
      !activity_status.startsWith("active") &&
      activity_status !== "unknown" &&
      !PROOF_ACTIVITY_STATUSES.has(activity_status),
  };
}

/**
 * Schema-compatible phones lookup: canonical_e164 first, then phone_id.
 */
export async function lookupCanonicalPhoneRow(
  { phone_id = null, canonical_e164 = null, to_phone_number = null } = {},
  supabase
) {
  if (!supabase?.from) {
    return { row: null, error: null };
  }

  const normalized_e164 =
    normalizePhone(canonical_e164) ||
    normalizePhone(to_phone_number) ||
    clean(canonical_e164) ||
    clean(to_phone_number);
  const normalized_phone_id = clean(phone_id);

  const attempts = [];
  if (normalized_e164) {
    attempts.push({ column: "canonical_e164", value: normalized_e164 });
  }
  if (normalized_phone_id) {
    attempts.push({ column: "phone_id", value: normalized_phone_id });
  }

  for (const attempt of attempts) {
    try {
      const { data, error } = await supabase
        .from("phones")
        .select(CANONICAL_PHONE_SELECT)
        .eq(attempt.column, attempt.value)
        .maybeSingle();
      if (error) continue;
      if (data) {
        return { row: normalizeCanonicalPhoneRow(data), error: null };
      }
    } catch {
      // try next strategy
    }
  }

  return { row: null, error: null };
}

/**
 * Apply phone-row evidence using production columns only.
 */
export function evaluatePhoneRowContactability(phone_row) {
  if (!phone_row) return null;

  if (phone_row.is_wrong_number) {
    return {
      blocked: true,
      reason: "wrong_number",
      reason_code: SEND_TIME_BLOCK_REASONS.WRONG_NUMBER,
      fail_closed: false,
    };
  }

  if (phone_row.is_non_active) {
    return {
      blocked: true,
      reason: `phone_not_active:${lower(phone_row.activity_status)}`,
      reason_code: SEND_TIME_BLOCK_REASONS.INVALID_CONTACT,
      fail_closed: false,
    };
  }

  return null;
}

export default lookupCanonicalPhoneRow;