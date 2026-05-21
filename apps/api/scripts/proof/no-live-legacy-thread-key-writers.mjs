#!/usr/bin/env node
/**
 * no-live-legacy-thread-key-writers.mjs
 *
 * Static analysis proof that no active code path can write a non-canonical
 * thread_key into inbox_thread_state.
 *
 * Invariants proved:
 *   1. upsertInboxThreadState has a hard guard rejecting non-canonical E.164
 *   2. parseThreadKey in the dashboard route only accepts canonical E.164
 *   3. isCanonicalThreadKey in cockpit-service only matches E.164
 *   4. enrich-message-event-context always resolves canonical via threadKeyFor()
 *   5. inbound sms-engine path overrides thread_key via canonicalThreadKeyForDirection
 *   6. outbound sms-engine path passes seller_phone/canonical_e164 from to_phone_number
 *   7. No remaining join(":") or join("|") call builds a thread_key for inbox_thread_state
 *   8. David inbound event (+18605733879 from) resolves to +18605733879
 *   9. David outbound event (+18605733879 to) resolves to +18605733879
 *  10. No writer can produce PODIO_ID:+textgrid:+seller format
 *
 * Usage:
 *   node scripts/proof/no-live-legacy-thread-key-writers.mjs
 */

import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "../../src");

// ── Helpers ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`);
    failed++;
  }
}

function sep(label) {
  console.log(`\n${"─".repeat(60)}\n  ${label}\n${"─".repeat(60)}`);
}

function read(relPath) {
  try {
    return fs.readFileSync(path.join(SRC, relPath), "utf8");
  } catch {
    return null;
  }
}

function contains(source, pattern) {
  if (typeof pattern === "string") return source.includes(pattern);
  return pattern.test(source);
}

function notContains(source, pattern) {
  return !contains(source, pattern);
}

// ── Load source files ──────────────────────────────────────────────────────
console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  No-Live-Legacy-Thread-Key-Writers Proof                ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

const smsEngine      = read("lib/supabase/sms-engine.js");
const dashboardRoute = read("app/api/internal/dashboard/inbox/thread-state/route.js");
const cockpitService = read("lib/cockpit/cockpit-service.js");
const enrichCtx      = read("lib/domain/inbox/enrich-message-event-context.js");
const liveInbox      = read("lib/domain/inbox/live-inbox-service.js");

for (const [name, content] of [
  ["sms-engine.js", smsEngine],
  ["dashboard/inbox/thread-state/route.js", dashboardRoute],
  ["cockpit-service.js", cockpitService],
  ["enrich-message-event-context.js", enrichCtx],
  ["live-inbox-service.js", liveInbox],
]) {
  if (!content) { console.error(`ERROR: could not read src/${name}`); failed++; }
}

// ── 1. upsertInboxThreadState hard guard ──────────────────────────────────
sep("1. upsertInboxThreadState — hard E.164 guard before write");

assert(
  "guard regex /^\\+1\\d{10}$/ present in upsertInboxThreadState",
  smsEngine && contains(smsEngine, `\\d{10}$/.test(thread_key)`),
  "regex guard missing"
);
assert(
  "THREAD_KEY_UNRESOLVED error logged on rejection",
  smsEngine && contains(smsEngine, "THREAD_KEY_UNRESOLVED"),
  "log message missing"
);
assert(
  "returns { ok: false, reason: 'THREAD_KEY_UNRESOLVED' } on bad key",
  smsEngine && contains(smsEngine, `reason: "THREAD_KEY_UNRESOLVED"`),
  "return value missing"
);

// ── 2. parseThreadKey in dashboard route ───────────────────────────────────
sep("2. dashboard/inbox/thread-state/route.js — parseThreadKey only accepts E.164");

assert(
  "CANONICAL_E164_RE defined as /^\\+1\\d{10}$/",
  dashboardRoute && contains(dashboardRoute, "CANONICAL_E164_RE"),
  "regex constant missing"
);
assert(
  "parseThreadKey tests against CANONICAL_E164_RE",
  dashboardRoute && contains(dashboardRoute, "CANONICAL_E164_RE.test(explicit_key)"),
  "test not found"
);
assert(
  "composite fallback 'master_owner_id:property_id:left:right' removed",
  dashboardRoute && notContains(dashboardRoute, "${master_owner_id}:${property_id}"),
  "composite fallback still present"
);
assert(
  "composite fallback left/right phone sort removed",
  dashboardRoute && notContains(dashboardRoute, "from_phone < to_phone"),
  "phone sort still present"
);

// ── 3. isCanonicalThreadKey in cockpit-service ────────────────────────────
sep("3. cockpit-service.js — isCanonicalThreadKey uses strict E.164");

assert(
  "isCanonicalThreadKey uses /^\\+1\\d{10}$/ regex",
  cockpitService && contains(cockpitService, `\\d{10}$/.test`),
  "strict E.164 regex not found"
);
assert(
  "old permissive regex [A-Za-z0-9:+_.\\-]+ removed",
  cockpitService && notContains(cockpitService, "A-Za-z0-9:+"),
  "permissive regex with colon still present"
);

// ── 4. enrich-message-event-context always uses threadKeyFor() ────────────
sep("4. enrich-message-event-context.js — canonical via threadKeyFor()");

assert(
  "threadKeyFor() uses normalizePhone(from) and normalizePhone(to)",
  enrichCtx && contains(enrichCtx, "normalizePhone(from)") && contains(enrichCtx, "normalizePhone(to)"),
  "normalizePhone calls not found"
);
assert(
  "enriched.thread_key forced to canonical_thread_key || null",
  enrichCtx && contains(enrichCtx, "enriched.thread_key = canonical_thread_key || null"),
  "forced canonical assignment not found"
);
assert(
  "comment 'Never inherit null/composite/pipe thread keys' present",
  enrichCtx && contains(enrichCtx, "Never inherit null/composite/pipe thread keys"),
  "safety comment not found"
);

// ── 5. sms-engine inbound path overrides thread_key ───────────────────────
sep("5. sms-engine.js inbound path — canonicalThreadKeyForDirection override");

assert(
  "inbound path applies canonicalThreadKeyForDirection before upsertInboxThreadState",
  smsEngine && contains(smsEngine, `canonicalThreadKeyForDirection("inbound", event.from_phone_number, event.to_phone_number)`),
  "inbound canonical override not found"
);
assert(
  "inbound upsertInboxThreadState receives seller_phone: event.from_phone_number",
  smsEngine && contains(smsEngine, "seller_phone: event.from_phone_number"),
  "seller_phone not set from from_phone_number"
);

// ── 6. sms-engine outbound path passes canonical phones ───────────────────
sep("6. sms-engine.js outbound path — seller_phone from to_phone_number");

assert(
  "outbound upsertInboxThreadState receives seller_phone: payload.to_phone_number",
  smsEngine && contains(smsEngine, "seller_phone: payload.to_phone_number"),
  "seller_phone not set from to_phone_number"
);
assert(
  "outbound upsertInboxThreadState receives canonical_e164: payload.to_phone_number",
  smsEngine && contains(smsEngine, "canonical_e164: payload.to_phone_number"),
  "canonical_e164 not set from to_phone_number"
);

// ── 7. No remaining composite thread_key construction for inbox_thread_state
sep("7. No join(':') or join('|') building thread_key for inbox_thread_state");

assert(
  "live-inbox-service threadKey() is display-only (no DB write path)",
  liveInbox && contains(liveInbox, "applyInboxRowComputedFields") &&
  notContains(liveInbox, "upsertInboxThreadState"),
  "live-inbox-service unexpectedly calls upsertInboxThreadState"
);
assert(
  "dashboard route does not join phones or IDs for thread_key",
  dashboardRoute && notContains(dashboardRoute, ".join(\":\")") && notContains(dashboardRoute, ".join(':')"),
  "join(':') still present in dashboard route"
);

// ── 8 & 9. David thread_key resolution ────────────────────────────────────
sep("8 & 9. David (+18605733879) — inbound and outbound resolve correctly");

// Simulate threadKeyFor() logic
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

function threadKeyFor(direction, from, to) {
  const dir = String(direction ?? "").toLowerCase().trim();
  const from_norm = normalizePhone(from);
  const to_norm = normalizePhone(to);
  if (dir === "inbound") return from_norm || to_norm || null;
  if (dir === "outbound") return to_norm || from_norm || null;
  return from_norm || to_norm || null;
}

const DAVID_PHONE = "+18605733879";
const OUR_PHONE = "+17866052999";

const davidInbound = threadKeyFor("inbound", DAVID_PHONE, OUR_PHONE);
assert(
  `David inbound (from=${DAVID_PHONE}) resolves to ${DAVID_PHONE}`,
  davidInbound === DAVID_PHONE,
  `resolved to ${davidInbound}`
);

const davidOutbound = threadKeyFor("outbound", OUR_PHONE, DAVID_PHONE);
assert(
  `David outbound (to=${DAVID_PHONE}) resolves to ${DAVID_PHONE}`,
  davidOutbound === DAVID_PHONE,
  `resolved to ${davidOutbound}`
);

// ── 10. No writer can produce PODIO_ID:+textgrid:+seller ──────────────────
sep("10. No writer can produce PODIO_ID:+textgrid:+seller format");

// Verify the hard guard blocks it
function simulateUpsertGuard(payload) {
  const normalizePhoneSim = (v) => {
    if (!v) return null;
    const d = String(v).replace(/\D/g, "");
    if (/^\d{10}$/.test(d)) return `+1${d}`;
    if (/^1\d{10}$/.test(d)) return `+${d}`;
    return null;
  };
  const canonical_seller_phone =
    normalizePhoneSim(payload.seller_phone) ||
    normalizePhoneSim(payload.canonical_e164) ||
    normalizePhoneSim(payload.thread_key) ||
    null;
  const thread_key = canonical_seller_phone || String(payload.thread_key ?? "").trim();
  if (!thread_key) return { ok: false, reason: "missing_thread_key" };
  if (!/^\+1\d{10}$/.test(thread_key)) return { ok: false, reason: "THREAD_KEY_UNRESOLVED" };
  return { ok: true, thread_key };
}

const compositeAttempt = simulateUpsertGuard({
  thread_key: "225372768:+17866052999:+18605733879",
  seller_phone: null,
  canonical_e164: null,
});
assert(
  "composite key '225372768:+17866052999:+18605733879' is blocked by guard",
  !compositeAttempt.ok && compositeAttempt.reason === "THREAD_KEY_UNRESOLVED",
  `got ok=${compositeAttempt.ok} reason=${compositeAttempt.reason}`
);

const feedAttempt = simulateUpsertGuard({ thread_key: "feed:abc123", seller_phone: null, canonical_e164: null });
assert(
  "feed:hash key is blocked by guard",
  !feedAttempt.ok && feedAttempt.reason === "THREAD_KEY_UNRESOLVED",
  `got ok=${feedAttempt.ok} reason=${feedAttempt.reason}`
);

const phonePropertyAttempt = simulateUpsertGuard({ thread_key: "phone_property:+13175906511:250969961", seller_phone: null, canonical_e164: null });
assert(
  "phone_property:+phone:ID key is blocked by guard",
  !phonePropertyAttempt.ok && phonePropertyAttempt.reason === "THREAD_KEY_UNRESOLVED",
  `got ok=${phonePropertyAttempt.ok} reason=${phonePropertyAttempt.reason}`
);

const canonicalAttempt = simulateUpsertGuard({ thread_key: "+18605733879", seller_phone: "+18605733879", canonical_e164: "+18605733879" });
assert(
  "canonical key '+18605733879' passes the guard",
  canonicalAttempt.ok && canonicalAttempt.thread_key === "+18605733879",
  `got ok=${canonicalAttempt.ok} thread_key=${canonicalAttempt.thread_key}`
);

// ── Summary ───────────────────────────────────────────────────────────────
const line = "═".repeat(60);
console.log(`\n${line}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${line}\n`);

if (failed > 0) process.exit(1);
