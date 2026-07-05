// ─── is-uuid.js ─────────────────────────────────────────────────────────────
// Fail-closed UUID validation.
//
// The canonical `phones.phone_id` is a `ph_`-prefixed TEXT id (production: 121,287
// rows, 0 UUID-shaped). Columns `send_queue.phone_number_id` and
// `message_events.phone_number_id` are UUID. A `ph_` text value must NEVER be
// coerced into a UUID column — doing so silently corrupts provenance and hides
// real bugs. Use this guard before writing any value to a UUID-typed column:
//   - UUID value       → permitted in phone_number_id
//   - ph_ / non-UUID   → keep as phone_id / metadata.canonical_phone_id, never phone_number_id
//
// Do not coerce, hash, or invent UUIDs.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}
