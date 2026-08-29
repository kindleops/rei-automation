import { clean } from "@/lib/utils/strings.js";

export function digitsOnly(value) {
  return clean(value).replace(/\D+/g, "");
}

/**
 * Shapes we accept as a phone number BEFORE any digit extraction.
 *
 * The old normalizePhone stripped every non-digit and then judged the result,
 * which meant an encrypted payload could be "repaired" into a sendable number:
 * a `IV:ciphertext` base64 blob from seller.owner_phone salvaged 12 stray digits
 * and normalized to +363870619616 (Hungary). 13% of production blob samples
 * produced a syntactically valid E.164 this way, some of them +1.
 *
 * So the shape is validated first and digits are only extracted from input that
 * already looks like a phone number. Anything else is rejected outright.
 */
const ACCEPTED_PHONE_SHAPES = [
  /^\d{10}$/,                                   // 5551234567
  /^1\d{10}$/,                                  // 15551234567
  /^\+1\d{10}$/,                                // +15551234567
  /^\+[1-9]\d{7,14}$/,                          // E.164, general
  /^\(\d{3}\)\s?\d{3}-?\d{4}$/,                 // (555) 123-4567
  /^\d{3}[-. ]\d{3}[-. ]\d{4}$/,                // 555-123-4567 / 555.123.4567
  /^1[-. ]\d{3}[-. ]\d{3}[-. ]\d{4}$/,          // 1-555-123-4567
  /^\+1[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$/, // +1 (555) 123-4567
];

/**
 * True when the raw value is shaped like a phone number at all.
 *
 * Rejects: `IV:ciphertext` blobs, base64 payloads, arbitrary alphanumerics —
 * anything carrying a letter, or the `:`/`=`/`/`/`+`-inside characters that mark
 * an encrypted value rather than a number.
 */
export function isPhoneShaped(value) {
  const raw = clean(value);
  if (!raw) return false;
  // A letter or base64/structural punctuation means this is not a phone number,
  // regardless of how many digits happen to be embedded in it.
  if (/[A-Za-z]/.test(raw)) return false;
  if (/[:=/_,;|]/.test(raw)) return false;
  if (raw.includes("+") && !raw.startsWith("+")) return false;
  return ACCEPTED_PHONE_SHAPES.some((shape) => shape.test(raw));
}

export function normalizePhone(value) {
  if (!isPhoneShaped(value)) return "";

  const raw = clean(value);
  const digits = digitsOnly(raw);

  if (raw.startsWith("+")) {
    // Already E.164-shaped: trust the caller's country code.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return "";
}

export function isValidUsPhone(value) {
  const normalized = normalizePhone(value);
  return normalized.startsWith("+1") && normalized.length === 12;
}

export function formatUsPhone(value) {
  const digits = digitsOnly(value);

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  return clean(value);
}

export default {
  digitsOnly,
  isPhoneShaped,
  normalizePhone,
  isValidUsPhone,
  formatUsPhone,
};
