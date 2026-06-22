/**
 * Canonical timestamp normalization for queue/feeder scheduling logic.
 * Never throws. Returns epoch milliseconds or null.
 */
export function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Epoch seconds (10-digit) are accepted when within a plausible range.
    if (value > 0 && value < 1_000_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return Math.trunc(value);
  }

  const text = String(value).trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(text)) {
    if (numeric > 0 && numeric < 1_000_000_000_000) {
      return Math.trunc(numeric * 1000);
    }
    return Math.trunc(numeric);
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @deprecated Prefer normalizeTimestamp — kept for existing imports. */
export function toTimestamp(value) {
  return normalizeTimestamp(value);
}

export default normalizeTimestamp;