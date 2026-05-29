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
