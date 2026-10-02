/**
 * Seeded pseudo-random numbers for IC8 (bootstrap resampling, synthetic test
 * data). Never Math.random(): every IC8 result must be reproducible from its
 * seed.
 */

import { createHash } from "node:crypto";

/** mulberry32: small, fast, well-distributed 32-bit generator. Returns [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from any string or number (sha256-derived). */
export function seedFrom(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value >>> 0;
  return createHash("sha256").update(String(value)).digest().readUInt32BE(0);
}

/** Integer in [0, n) from a generator. */
export function randomIndex(next, n) {
  return Math.min(n - 1, Math.floor(next() * n));
}
