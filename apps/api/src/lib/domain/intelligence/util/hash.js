/**
 * IC8 hashing primitives: stable JSON, sha256, uuid v5, salted unit hashes.
 *
 * Pure. Depends on node:crypto only, so every IC8 module that hashes a
 * definition, a dataset or a journal id agrees byte-for-byte across processes.
 */

import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, `undefined` and functions dropped,
 * non-finite numbers written as null, Dates as ISO strings, bigint as string.
 * Two structurally equal values always serialise identically.
 */
export function stableStringify(value) {
  if (value === undefined || typeof value === "function") return undefined;
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? JSON.stringify(value.toISOString()) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/** sha256 hex of a string or Buffer. */
export function sha256Hex(input) {
  const hash = createHash("sha256");
  hash.update(Buffer.isBuffer(input) ? input : String(input ?? ""));
  return hash.digest("hex");
}

/** sha256 hex of the stable serialisation of any value. */
export function hashObject(value) {
  return sha256Hex(stableStringify(value) ?? "null");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value ?? ""));
}

/** RFC 4122 URL namespace. */
export const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * RFC 4122 version-5 (SHA-1, name-based) UUID.
 * Test vector: uuidV5("www.example.com", DNS ns) = 2ed6657d-e927-568b-95e1-2665a8aea6a2.
 */
export function uuidV5(name, namespace) {
  if (!isUuid(namespace)) throw new TypeError("uuidV5: namespace must be a UUID");
  const nsBytes = Buffer.from(String(namespace).replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(nsBytes).update(Buffer.from(String(name), "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * IC8 root namespace and the per-record namespaces derived from it. Derived,
 * not random, so they can be re-computed anywhere; a test pins the values so
 * they can never drift (every journal id depends on them).
 */
export const IC8_NAMESPACE = uuidV5("https://leadcommand.ai/intelligence-core/8", UUID_NAMESPACE_URL);
export const IC8_DECISION_NAMESPACE = uuidV5("intelligence.decision_journal", IC8_NAMESPACE);
export const IC8_DATASET_NAMESPACE = uuidV5("intelligence.dataset_snapshots", IC8_NAMESPACE);
export const IC8_CORRECTION_NAMESPACE = uuidV5("intelligence.corrections", IC8_NAMESPACE);

/**
 * Salted, truncated sha256 for replacing a sensitive key (thread_key/phone)
 * inside a dataset. The salt is per dataset and is never written to the
 * manifest (only its fingerprint is): a phone number space is small enough to
 * brute-force an unsalted or published-salt hash.
 */
export function saltedHash(value, salt, { length = 32 } = {}) {
  if (!salt || String(salt).length < 16) {
    throw new TypeError("saltedHash: salt must be at least 16 characters");
  }
  return sha256Hex(`${salt}\u0000${value}`).slice(0, length);
}

/** Public fingerprint of a secret salt (safe to persist). */
export function saltFingerprint(salt) {
  return sha256Hex(`ic8-salt-fingerprint\u0000${salt}`).slice(0, 16);
}
