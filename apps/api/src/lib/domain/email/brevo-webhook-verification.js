/**
 * brevo-webhook-verification.js
 *
 * WHO SENT THIS WEBHOOK, and how much may we let it change?
 *
 * THE HOLE THIS CLOSES.
 *   The previous implementation began:
 *
 *     const secret = clean(process.env.BREVO_WEBHOOK_SECRET);
 *     if (!secret) return { ok: true, configured: false };
 *
 *   An unset environment variable therefore made the endpoint accept anything.
 *   Not "accept and mark untrusted" -- accept, process, and write suppression
 *   rows and delivery state from an unauthenticated request. A misconfigured
 *   deploy and a hostile one were indistinguishable, and the failure was silent
 *   in the direction that loses data: anyone who found the URL could mark a
 *   seller unsubscribed, or mark an undelivered message delivered.
 *
 * FAIL CLOSED, AND SAY WHICH KIND OF CLOSED.
 *   Verification now always produces a TRUST CLASS, and an unverifiable request
 *   is UNAUTHENTICATED rather than accepted. The existing callback trust policy
 *   then decides what an unauthenticated receipt may do -- which, for advancing
 *   canonical truth, is nothing. That policy is shared with SMS and is not
 *   re-decided here, because a trust threshold that each channel sets for itself
 *   is a trust threshold that will eventually differ by accident.
 *
 * A MISSING SECRET IS A CONFIGURATION FAULT, NOT A TRUST LEVEL.
 *   It is reported separately (`configured: false`) so an operator can tell
 *   "nobody configured this" apart from "someone sent us a forged request".
 *   Both refuse; they need different fixes, and an alert that cannot tell them
 *   apart wastes the one thing an on-call engineer has.
 *
 * BREVO DOES NOT HMAC-SIGN TRANSACTIONAL WEBHOOKS.
 *   Its documented mechanism is a caller-chosen URL plus IP allow-listing, so
 *   the shared-secret comparison below is the strongest authentication
 *   available from repository configuration alone. That is stated rather than
 *   implied: the HMAC path exists because a proxy in front of the endpoint can
 *   add one, and if Brevo ships signing later it is the branch to use. Until
 *   then, treat the secret as the whole of the authentication story and keep the
 *   URL unguessable.
 */

import crypto from "node:crypto";

import { TRUST_CLASS } from "@/lib/domain/communications/callback-trust-policy.js";

export const BREVO_WEBHOOK_VERIFICATION_POLICY_VERSION = "brevo_webhook_verify_v1";

/** Headers a shared secret may legitimately arrive in. */
const SECRET_HEADERS = Object.freeze([
  "x-brevo-webhook-secret",
  "x-webhook-secret",
  "x-brevo-secret",
]);

/** Headers a proxy-added HMAC may arrive in. */
const SIGNATURE_HEADERS = Object.freeze([
  "x-brevo-signature",
  "x-sendinblue-signature",
  "x-webhook-signature",
]);

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Constant-time comparison that does not leak length through an early return.
 *
 * timingSafeEqual THROWS on unequal lengths, so a naive wrapper that returns
 * false early reveals whether the guess was the right size. Hashing both sides
 * to a fixed width first removes that channel.
 */
function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(clean(left), "utf8").digest();
  const b = crypto.createHash("sha256").update(clean(right), "utf8").digest();
  return crypto.timingSafeEqual(a, b) && clean(left).length > 0;
}

function hmacMatches(raw_body, secret, signature) {
  const provided = clean(signature).replace(/^sha256=/i, "");
  if (!provided) return false;
  const hex = crypto.createHmac("sha256", secret).update(raw_body, "utf8").digest("hex");
  const base64 = crypto.createHmac("sha256", secret).update(raw_body, "utf8").digest("base64");
  return safeEqual(provided, hex) || safeEqual(provided, base64);
}

function headerReader(headers) {
  if (!headers) return () => "";
  if (typeof headers.get === "function") return (name) => clean(headers.get(name));
  return (name) => clean(headers[name] ?? headers[name.toLowerCase()]);
}

/**
 * @param {object} input
 * @param {object|Headers} input.headers
 * @param {string} input.raw_body      the EXACT bytes received; an HMAC over a
 *                                     re-serialized body verifies nothing
 * @param {URL|string} [input.url]     for a secret passed as a query parameter
 * @param {string} [input.secret]      defaults to process.env.BREVO_WEBHOOK_SECRET
 *
 * @returns {{ok:boolean, trust_class:string, configured:boolean, mode:string|null, reason:string|null}}
 */
export function verifyBrevoWebhook(input = {}) {
  const secret = clean(input.secret ?? process.env.BREVO_WEBHOOK_SECRET);
  const raw_body = typeof input.raw_body === "string" ? input.raw_body : "";
  const header = headerReader(input.headers);

  if (!secret) {
    // Configuration fault. Reported as its own thing so an operator is not left
    // guessing whether they are misconfigured or under attack.
    return {
      ok: false,
      trust_class: TRUST_CLASS.UNAUTHENTICATED,
      configured: false,
      mode: null,
      reason: "brevo_webhook_secret_not_configured",
      policy_version: BREVO_WEBHOOK_VERIFICATION_POLICY_VERSION,
    };
  }

  const candidates = [
    ...SECRET_HEADERS.map((name) => header(name)),
    bearerToken(header("authorization")),
    queryParam(input.url, "secret"),
  ].filter(Boolean);

  if (candidates.some((candidate) => safeEqual(candidate, secret))) {
    return trusted("shared_secret");
  }

  const signatures = SIGNATURE_HEADERS.map((name) => header(name)).filter(Boolean);
  if (signatures.some((signature) => hmacMatches(raw_body, secret, signature))) {
    return trusted("hmac");
  }

  return {
    ok: false,
    trust_class: TRUST_CLASS.UNAUTHENTICATED,
    configured: true,
    mode: null,
    reason: candidates.length || signatures.length
      ? "brevo_webhook_credential_mismatch"
      : "brevo_webhook_credential_absent",
    policy_version: BREVO_WEBHOOK_VERIFICATION_POLICY_VERSION,
  };
}

function trusted(mode) {
  return {
    ok: true,
    trust_class: TRUST_CLASS.AUTHENTICATED,
    configured: true,
    mode,
    reason: null,
    policy_version: BREVO_WEBHOOK_VERIFICATION_POLICY_VERSION,
  };
}

function bearerToken(value) {
  const raw = clean(value);
  return raw.toLowerCase().startsWith("bearer ") ? clean(raw.slice(7)) : raw;
}

function queryParam(url, name) {
  if (!url) return "";
  try {
    return clean(new URL(String(url)).searchParams.get(name));
  } catch {
    return "";
  }
}

export { TRUST_CLASS };
export default verifyBrevoWebhook;
