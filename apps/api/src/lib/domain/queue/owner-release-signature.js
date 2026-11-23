// ─── owner-release-signature.js ──────────────────────────────────────────────
// FOUNDER P0 2026-11-23 (round 2, blocking item 3): an owner release must be
// UNFORGEABLE. Round 1 accepted `metadata.reauthorization` as written, so a bulk
// SQL UPDATE of that JSON authorized a send. Now a release is valid only when:
//
//   1. its record carries an HMAC-SHA256 signature, made with a SERVER secret
//      the database never holds, over the row id, the logged-in actor, the
//      time, the reason, the destination and a hash of the message body; and
//   2. a QUEUE_OWNER_RELEASE audit event with the SAME signature exists in
//      automation_events (checked live by the gate).
//
// Someone with database write access but not the server secret cannot produce
// a signature; copying a real signature to another row, another recipient or
// an edited message fails because those values are inside the signed text.
//
// THE KEY. QUEUE_OWNER_RELEASE_SECRET when set. Otherwise a key DERIVED (HMAC
// with a fixed label) from CRON_SECRET, which the production Worker already
// forwards to the container and which no browser, agent or database holds.
// Forwarding a dedicated secret needs an edit to infra/cloudflare/worker
// (outside this change); until then the derived key is used. No key at all =
// no release can be signed and none verifies (fail closed).

import crypto from "node:crypto";

export const OWNER_RELEASE_SIGNATURE_VERSION = "owner_release_hmac_v1";
const DERIVATION_LABEL = "leadcommand.queue_owner_release.v1";

const clean = (value) => String(value ?? "").trim();

/** The signing key, or null (fail closed). Never logged, never returned to a caller. */
export function resolveOwnerReleaseKey(env = process.env) {
  const dedicated = clean(env?.QUEUE_OWNER_RELEASE_SECRET);
  if (dedicated) return { key: Buffer.from(dedicated, "utf8"), key_id: "dedicated" };
  const base = clean(env?.CRON_SECRET);
  if (base) {
    return {
      key: crypto.createHmac("sha256", base).update(DERIVATION_LABEL, "utf8").digest(),
      key_id: "derived_cron",
    };
  }
  return null;
}

/** The body as the release saw it: NFKC, whitespace collapsed, trimmed. */
export function normalizeReleaseBody(body) {
  return clean(String(body ?? "").normalize("NFKC").replace(/\s+/g, " "));
}

/** Same field preference as the runner's pickMessageFields. */
export function releaseBodyOfRow(row = {}) {
  return normalizeReleaseBody(row?.message_body ?? row?.body ?? row?.message_text ?? row?.rendered_message ?? "");
}

export function hashReleaseBody(body) {
  return crypto.createHash("sha256").update(normalizeReleaseBody(body), "utf8").digest("hex");
}

const digits = (phone) => clean(phone).replace(/\D+/g, "");

function canonical(record) {
  return [
    OWNER_RELEASE_SIGNATURE_VERSION,
    clean(record.queue_row_id),
    clean(record.actor_user_id),
    clean(record.at),
    clean(record.reason),
    digits(record.to_phone_number),
    clean(record.body_sha256),
  ].join("\n");
}

/**
 * Build a signed release record for a row. Returns null when no key exists.
 * `actor_user_id` MUST come from the authenticated session, never request text.
 */
export function signOwnerRelease({ row = {}, actor_user_id, reason, at = new Date().toISOString() } = {}, env = process.env) {
  const k = resolveOwnerReleaseKey(env);
  if (!k) return null;
  const record = {
    queue_row_id: clean(row?.id),
    actor_user_id: clean(actor_user_id),
    at: clean(at),
    reason: clean(reason),
    to_phone_number: clean(row?.to_phone_number),
    body_sha256: hashReleaseBody(releaseBodyOfRow(row)),
  };
  if (!record.queue_row_id || !record.actor_user_id || !record.at || !record.reason) return null;
  const signature = crypto.createHmac("sha256", k.key).update(canonical(record), "utf8").digest("hex");
  return { ...record, signature, signature_version: OWNER_RELEASE_SIGNATURE_VERSION, key_id: k.key_id, audit_key: `queue_owner_release:${record.queue_row_id}:${record.at}` };
}

/**
 * Verify a release record against the row as it is NOW. Pure and synchronous.
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function verifyOwnerReleaseRecord(record, row = {}, env = process.env) {
  const r = record && typeof record === "object" ? record : null;
  if (!r) return { ok: false, reason: "release_missing" };
  if (clean(r.signature_version) !== OWNER_RELEASE_SIGNATURE_VERSION || !/^[0-9a-f]{64}$/.test(clean(r.signature))) {
    return { ok: false, reason: "release_unsigned" };
  }
  const k = resolveOwnerReleaseKey(env);
  if (!k) return { ok: false, reason: "release_key_unavailable" };
  if (clean(r.queue_row_id) !== clean(row?.id)) return { ok: false, reason: "release_row_mismatch" };
  if (!clean(r.actor_user_id) || !clean(r.reason) || !Number.isFinite(Date.parse(clean(r.at)))) {
    return { ok: false, reason: "release_incomplete" };
  }
  // The values that are verified are the ROW's, not the record's: a release
  // signed for another recipient or another message cannot be replayed here.
  const expected = crypto
    .createHmac("sha256", k.key)
    .update(canonical({ ...r, to_phone_number: row?.to_phone_number, body_sha256: hashReleaseBody(releaseBodyOfRow(row)) }), "utf8")
    .digest();
  const given = Buffer.from(clean(r.signature), "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "release_signature_invalid" };
  }
  return { ok: true, reason: null };
}
