/**
 * p0-final-dispatch-gate-round2.test.mjs
 *
 * FOUNDER P0 2026-11-23, round 2 (Sentry task_783e03da, CHANGES REQUESTED on
 * ea46238b). Adversarial tests for each blocking item:
 *
 *   1. marker-independent history: a status flipped back BY HAND (no markers),
 *      a row written before the latest freeze/brake event (the brake lifted
 *      immediately after deploy), a row older than 24 h, unreadable history,
 *      the caller's stale copy of the row.
 *   2. dashboard routes: retry-failed / reprocess-paused (and the rest) are
 *      fenced: authenticated, 410, no database client, nothing written.
 *   3. owner release: a bulk-SQL-forged metadata.reauthorization (unsigned,
 *      random signature, a signature copied from another row, a body edited
 *      after release, no audit event) never sends; the Cockpit route takes
 *      the actor from the session, never the request body.
 *
 * Plus: claim token must be the claim actually held; the runner wiring passes
 * a real client and the gate performs the live reads.
 *
 * Every dispatch case runs the REAL queue bridge through the REAL seam with a
 * provider spy. Nothing here sends anything.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dispatchSellerQueueRow } from "@/lib/domain/communications/dispatch-seller-queue-row.js";
import {
  GATE_REASONS,
  FINAL_DISPATCH_GATE_VERSION,
  evaluateFinalDispatchGate,
  __setFinalDispatchGateModeForTests,
  historicalVerdict,
  isHistoricalRow,
} from "@/lib/domain/queue/final-dispatch-gate.js";
import { signOwnerRelease, verifyOwnerReleaseRecord } from "@/lib/domain/queue/owner-release-signature.js";
import { holdCampaignRowsForReauthorization } from "@/lib/domain/queue/no-automatic-reactivation.js";
import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../src");
const DASH = path.resolve(__dirname, "../../../dashboard");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const PHONE = "+13125550100";
const FROM = "+18885551212";
const NOW = "2026-11-24T18:00:00.000Z";
const nowMs = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();
const BODY = "Hello, checking in about the property.";
const SECRET = "round2-owner-release-secret";

const ALLOW = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  return null;
};

const FRESH_HISTORY = [
  { from_status: null, to_status: "queued", changed_at: iso(nowMs - 60_000) },
  { from_status: "queued", to_status: "processing", changed_at: iso(nowMs - 1_000) },
];

let seq = 0;
const queueRow = (over = {}) => ({
  id: `q-r2-${++seq}`,
  thread_key: PHONE,
  to_phone_number: PHONE,
  from_phone_number: FROM,
  message_body: BODY,
  campaign_target_id: `44444444-4444-4444-8444-${String(100000000000 + seq).slice(-12)}`,
  touch_number: 1,
  queue_status: "processing",
  lock_token: "claim-token-r2",
  created_at: iso(nowMs - 60_000),
  metadata: {},
  ...over,
});

const readers = (row, over = {}) => ({
  readQueueRow: async () => row,
  readSuppression: async () => ({ suppressed: false, lookup_error: null }),
  readAutomationSuppression: async () => ({ active: false }),
  readThreadState: async () => ({ thread_key: PHONE, status: "active", is_archived: false, last_inbound_at: null, metadata: {} }),
  readAutomationHold: async () => ({ held: false, fail_closed: false }),
  readCampaign: async () => ({ id: "camp-1", status: "active" }),
  readStatusHistory: async () => FRESH_HISTORY,
  readLatestAuthorityEvent: async () => iso(nowMs - 3600_000),
  readReleaseAudit: async () => ({ found: false }),
  verifyDispatchClaim: async () => ({ ok: true }),
  ...over,
});

const NO_DIRECT_READS = { from() { throw new Error("unexpected direct read: inject a reader"); } };

function spy() {
  const calls = [];
  return { calls, fn: async (args) => { calls.push(args); return { ok: true, sid: `SM${calls.length}` }; } };
}

async function dispatch(row, { over = {}, provider = spy() } = {}) {
  // The REAL gate, observed: its full verdict (reauthorization detail included)
  // is kept so a test can prove WHICH check refused, not only that one did.
  let gate = null;
  const result = await dispatchSellerQueueRow(row, { to: row.to_phone_number, from: FROM, body: BODY }, {
    finalDispatchGate: async (input, deps) => { gate = await evaluateFinalDispatchGate(input, deps); return gate; },
    store: createMemoryS11Store(),
    supabase: NO_DIRECT_READS,
    sendProvider: provider.fn,
    getSystemValue: ALLOW,
    now: NOW,
    contact_window: { allowed: true, hold: false, timezone: "America/Chicago" },
    finalGateReaders: readers(row, over),
    finalSenderContinuityCheck: async () => ({ ok: true, reason: null, verdict: null }),
    finalContactRestrictionCheck: async () => ({ refused: false, reason: null }),
  });
  return { result, provider, gate };
}

// ROUND 3. The shared critical-test environment RESETS process.env before EVERY
// test (critical-test-environment.mjs beforeEach -> resetCriticalProcessEnv).
// Round 2 set the release secret once in test.before, so it was gone by the
// time each test ran: signOwnerRelease returned null, the "released" row had
// no release at all, releasedHistory(undefined) threw inside the injected
// history reader, and the gate (correctly) answered history_unreadable. The
// release tests never reached the signature or audit logic.
//
// Now: the secret is set in a beforeEach registered AFTER the helper's (node:test
// runs file-level hooks in registration order), fixtures sign with an explicit
// env, and every fixture asserts it really is what it claims to be, so a
// harness fault fails loudly instead of masquerading as a gate refusal.
const RELEASE_ENV = Object.freeze({ QUEUE_OWNER_RELEASE_SECRET: SECRET });
test.before(() => {
  __setFinalDispatchGateModeForTests("enforce");
});
test.beforeEach(() => {
  process.env.QUEUE_OWNER_RELEASE_SECRET = SECRET;
});
test.after(() => {
  __setFinalDispatchGateModeForTests(null);
  // The helper's own after/beforeEach restore the snapshot env.
});

test("HARNESS: inside every test the release key is present (an env reset cannot silently void the release fixtures)", () => {
  assert.equal(process.env.QUEUE_OWNER_RELEASE_SECRET, SECRET);
  const r = releasedRow();
  assert.equal(verifyOwnerReleaseRecord(r.metadata.reauthorization, r).ok, true, "the gate's default env verifies the fixture");
});

test("baseline: a fresh, claimed row with clean trigger history still reaches the provider once", async () => {
  const { result, provider } = await dispatch(queueRow());
  assert.equal(result.provider_invoked, true, JSON.stringify(result));
  assert.equal(provider.calls.length, 1);
  assert.equal(FINAL_DISPATCH_GATE_VERSION, "final_dispatch_gate_v2");
});

// ── 1. MARKER-INDEPENDENT HISTORY ──────────────────────────────────────────

for (const held of ["paused_global_lock", "paused_invalid_queue_row", "failed", "held", "paused_operator_review", "blocked_by_health_guard", "expired"]) {
  test(`STATUS FLIPPED BACK BY HAND: a row once '${held}' and UPDATEd back to queued, with NO markers, is refused`, async () => {
    const row = queueRow({ queue_status: "processing", metadata: {} });
    const history = [
      { from_status: null, to_status: "queued", changed_at: iso(nowMs - 50 * 60_000) },
      { from_status: "queued", to_status: held, changed_at: iso(nowMs - 40 * 60_000) },
      { from_status: held, to_status: "queued", changed_at: iso(nowMs - 2 * 60_000) }, // the hand-written UPDATE
      { from_status: "queued", to_status: "processing", changed_at: iso(nowMs - 1_000) },
    ];
    const { result, provider } = await dispatch(row, { over: { readStatusHistory: async () => history } });
    assert.equal(result.provider_invoked, false);
    assert.equal(result.reason, GATE_REASONS.REAUTHORIZATION_REQUIRED);
    assert.equal(provider.calls.length, 0);
  });
}

test("BRAKE LIFTED IMMEDIATELY AFTER DEPLOY: a row written before the latest brake event needs a release, markers or not", async () => {
  // Brake set (stamping never ran), the deploy, then the brake lifted 5 min ago.
  // The row was written 30 min ago, while the brake was on. Reconcile has not run.
  const row = queueRow({ created_at: iso(nowMs - 30 * 60_000), metadata: {} });
  const { result, provider } = await dispatch(row, { over: { readLatestAuthorityEvent: async () => iso(nowMs - 5 * 60_000) } });
  assert.equal(result.provider_invoked, false);
  assert.equal(result.reason, GATE_REASONS.REAUTHORIZATION_REQUIRED);
  assert.equal(provider.calls.length, 0);
  const hv = historicalVerdict(row, { now: nowMs, status_history: FRESH_HISTORY, latest_authority_event_at: iso(nowMs - 5 * 60_000) });
  assert.ok(hv.reasons.includes("created_before_latest_freeze_or_brake_event"), hv.reasons.join(","));
});

test("BRAKE LIFTED IMMEDIATELY AFTER DEPLOY: the migration's floor event makes every pre-deploy row historical", async () => {
  // Migration applied 10 min ago (floor event); brake not touched since. A row
  // created 20 min ago (before the deploy) with no markers and clean history.
  const row = queueRow({ created_at: iso(nowMs - 20 * 60_000) });
  const { result } = await dispatch(row, { over: { readLatestAuthorityEvent: async () => iso(nowMs - 10 * 60_000) } });
  assert.equal(result.reason, GATE_REASONS.REAUTHORIZATION_REQUIRED);
});

test("deploy order: code before migration (history tables missing / empty) refuses every automated send", async () => {
  for (const over of [
    { readStatusHistory: async () => { throw new Error('relation "send_queue_status_history" does not exist'); } },
    { readLatestAuthorityEvent: async () => { throw new Error("send_authority_events_empty"); } },
    { readStatusHistory: async () => [] }, // no INSERT history: written before the trigger existed
  ]) {
    const { result, provider } = await dispatch(queueRow(), { over });
    assert.equal(result.provider_invoked, false, JSON.stringify(over));
    assert.ok([GATE_REASONS.HISTORY_UNREADABLE, GATE_REASONS.REAUTHORIZATION_REQUIRED].includes(result.reason), result.reason);
    assert.equal(provider.calls.length, 0);
  }
});

test("a row older than 24 h, or created before the P0 floor, needs a release with no marker at all", async () => {
  for (const created_at of [iso(nowMs - 25 * 3600_000), "2026-11-22T12:00:00.000Z", null]) {
    const row = queueRow({ created_at });
    const { result } = await dispatch(row, { over: { readLatestAuthorityEvent: async () => "2026-11-01T00:00:00.000Z" } });
    assert.equal(result.reason, GATE_REASONS.REAUTHORIZATION_REQUIRED, String(created_at));
  }
});

test("the gate judges the row FRESH from send_queue, not the caller's copy (manual and queue)", async () => {
  const callerCopy = queueRow({ queue_status: "processing" });
  const stored = { ...callerCopy, queue_status: "paused_operator_review" };
  const a = await dispatch(callerCopy, { over: { readQueueRow: async () => stored } });
  assert.equal(a.result.reason, GATE_REASONS.PAUSED_OPERATOR_REVIEW);
  assert.equal(a.provider.calls.length, 0);
  const b = await dispatch(queueRow(), { over: { readQueueRow: async () => { throw new Error("timeout"); } } });
  assert.equal(b.result.reason, GATE_REASONS.ROW_UNREADABLE);
  assert.equal(b.provider.calls.length, 0);
});

test("Cockpit approve uses the trigger history too: a row flipped back by hand is historical", () => {
  const row = { id: "c1", queue_status: "queued", created_at: iso(nowMs - 60_000), metadata: {} };
  const history = { status_history: [{ to_status: "queued", changed_at: iso(nowMs - 60_000) }, { to_status: "failed", changed_at: iso(nowMs - 30_000) }, { to_status: "queued", changed_at: iso(nowMs - 10_000) }], latest_authority_event_at: iso(nowMs - 3600_000) };
  const v = isHistoricalRow(row, { now: nowMs, history });
  assert.equal(v.historical, true);
  assert.equal(v.reason, "status_history:failed");
  assert.equal(isHistoricalRow(row, { now: nowMs, history: { history_error: "x" } }).reason, "history_unreadable");
});

// ── 3. OWNER RELEASE: unforgeable ──────────────────────────────────────────

/** A historical row (written before the brake event) that an owner released 2 minutes ago. */
function releasedRow({ body = BODY, at = iso(nowMs - 2 * 60_000) } = {}) {
  const base = queueRow({ created_at: iso(nowMs - 3 * 3600_000), message_body: body });
  const signed = signOwnerRelease({ row: base, actor_user_id: "founder-user-id", reason: "reviewed the thread", at }, RELEASE_ENV);
  assert.ok(signed && /^[0-9a-f]{64}$/.test(signed.signature) && signed.at === at && signed.audit_key, "fixture: the release is really signed");
  return { ...base, metadata: { reauthorization: { ...signed, via: "cockpit_owner_release" } } };
}
const releasedHistory = (at) => {
  const atMs = Date.parse(at);
  assert.ok(Number.isFinite(atMs), `fixture: release time is a real time (${at})`);
  return [
    { from_status: null, to_status: "queued", changed_at: iso(nowMs - 3 * 3600_000) },
    { from_status: "queued", to_status: "paused_operator_review", changed_at: iso(nowMs - 2 * 3600_000) },
    { from_status: "paused_operator_review", to_status: "scheduled", changed_at: iso(atMs + 500) },
    { from_status: "scheduled", to_status: "processing", changed_at: iso(nowMs - 1_000) },
  ];
};
/**
 * Readers for a released row. History is computed ONCE, here, so a fixture
 * fault throws in the test body (loud) and never inside a reader, where the
 * gate would turn it into history_unreadable.
 */
const releaseOver = (row, extra = {}) => {
  const history = releasedHistory(row.metadata.reauthorization.at);
  return {
    readStatusHistory: async () => history,
    readLatestAuthorityEvent: async () => iso(nowMs - 2.5 * 3600_000),
    readReleaseAudit: async (r) => ({ found: r.signature === row.metadata.reauthorization.signature }),
    ...extra,
  };
};

test("OWNER RELEASE (positive): a signed release with its audit event authorizes exactly this row", async () => {
  const row = releasedRow();
  const audits = [];
  const { result, provider, gate } = await dispatch(row, { over: releaseOver(row, {
    readReleaseAudit: async (r) => { audits.push(r); return { found: r.signature === row.metadata.reauthorization.signature }; },
  }) });
  assert.equal(result.provider_invoked, true, JSON.stringify(result));
  assert.equal(provider.calls.length, 1);
  // It really was a historical row that only the release let through.
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(gate.reauthorization.required, true);
  assert.equal(gate.reauthorization.ok, true);
  assert.ok(gate.reauthorization.historical_reasons.includes("status_history:paused_operator_review"), gate.reauthorization.historical_reasons.join(","));
  assert.ok(gate.reauthorization.historical_reasons.includes("created_before_latest_freeze_or_brake_event"));
  assert.equal(audits.length, 1, "the audit event was read live");
  assert.equal(audits[0].audit_key, row.metadata.reauthorization.audit_key);

  // The same release does nothing for another row (exactly this row).
  const other = { ...queueRow({ created_at: row.created_at }), metadata: row.metadata };
  const o = await dispatch(other, { over: releaseOver(row) });
  assert.equal(o.result.reason, GATE_REASONS.RELEASE_INVALID);
  assert.equal(o.gate.reauthorization.detail, "release_row_mismatch");
  assert.equal(o.provider.calls.length, 0);
});

test("RELEASED ROW, history truly unreadable: still fail closed (status history, freeze events, or the live default reads)", async () => {
  const row = releasedRow();
  for (const extra of [
    { readStatusHistory: async () => { throw new Error("statement timeout"); } },
    { readLatestAuthorityEvent: async () => { throw new Error("send_authority_events_empty"); } },
    { readStatusHistory: async () => null },
  ]) {
    const { result, provider } = await dispatch(row, { over: releaseOver(row, extra) });
    assert.equal(result.reason, GATE_REASONS.HISTORY_UNREADABLE, Object.keys(extra).join(","));
    assert.equal(provider.calls.length, 0);
  }
  // No history readers at all and a client that cannot read: the live reads fail, the gate refuses.
  const noReaders = readers(row);
  delete noReaders.readStatusHistory;
  delete noReaders.readLatestAuthorityEvent;
  const provider = spy();
  let gate = null;
  const result = await dispatchSellerQueueRow(row, { to: PHONE, from: FROM, body: BODY }, {
    store: createMemoryS11Store(),
    supabase: NO_DIRECT_READS,
    sendProvider: provider.fn,
    getSystemValue: ALLOW,
    now: NOW,
    contact_window: { allowed: true, hold: false, timezone: "America/Chicago" },
    finalGateReaders: noReaders,
    finalDispatchGate: async (i, d) => { gate = await evaluateFinalDispatchGate(i, d); return gate; },
    finalSenderContinuityCheck: async () => ({ ok: true }),
    finalContactRestrictionCheck: async () => ({ refused: false }),
  });
  assert.equal(result.reason, GATE_REASONS.HISTORY_UNREADABLE, JSON.stringify(gate));
  assert.equal(provider.calls.length, 0);
});

test("BULK SQL FAKED RELEASE: an unsigned round-1 style metadata.reauthorization is refused", async () => {
  const row = queueRow({ created_at: iso(nowMs - 3 * 3600_000), metadata: { reauthorization: { queue_row_id: null, actor: "founder", reason: "bulk", at: iso(nowMs - 60_000), via: "cockpit_owner_release" } } });
  row.metadata.reauthorization.queue_row_id = row.id;
  // An audit row forged alongside it changes nothing: the signature is checked first.
  const { result, provider, gate } = await dispatch(row, { over: releaseOver(releasedRow(), { readReleaseAudit: async () => ({ found: true }) }) });
  assert.equal(result.reason, GATE_REASONS.RELEASE_INVALID, JSON.stringify(gate));
  assert.equal(gate.reauthorization.detail, "release_unsigned");
  assert.equal(provider.calls.length, 0);
});

test("BULK SQL FAKED RELEASE: a made-up signature, a signature copied from another row, or no server key is refused", async () => {
  const good = releasedRow();
  const random = { ...good, metadata: { reauthorization: { ...good.metadata.reauthorization, signature: "a".repeat(64) } } };
  const copied = { ...queueRow({ created_at: good.created_at }), metadata: { reauthorization: { ...good.metadata.reauthorization } } }; // another row id
  // The copy also carries the original row's id inside its record; rewriting that
  // id to the new row is the obvious forgery, and the signature then fails.
  const copiedRetargeted = (() => {
    const base = queueRow({ created_at: good.created_at });
    return { ...base, metadata: { reauthorization: { ...good.metadata.reauthorization, queue_row_id: base.id } } };
  })();
  // A row signed with a key the server does not hold.
  const wrongKey = (() => {
    const base = queueRow({ created_at: good.created_at });
    const signed = signOwnerRelease({ row: base, actor_user_id: "founder-user-id", reason: "reviewed", at: good.metadata.reauthorization.at }, { QUEUE_OWNER_RELEASE_SECRET: "attacker-guess" });
    return { ...base, metadata: { reauthorization: { ...signed, via: "cockpit_owner_release" } } };
  })();
  for (const [row, detail] of [[random, "release_signature_invalid"], [copied, "release_row_mismatch"], [copiedRetargeted, "release_signature_invalid"], [wrongKey, "release_signature_invalid"]]) {
    const { result, provider, gate } = await dispatch(row, { over: releaseOver(good, { readReleaseAudit: async () => ({ found: true }) }) });
    assert.equal(result.reason, GATE_REASONS.RELEASE_INVALID, `${detail}: ${JSON.stringify(gate)}`);
    assert.equal(gate.reauthorization.detail, detail);
    assert.equal(provider.calls.length, 0);
  }
  // No server key at send time: nothing verifies, even the genuine release.
  delete process.env.QUEUE_OWNER_RELEASE_SECRET;
  delete process.env.CRON_SECRET;
  const keyless = await dispatch(good, { over: releaseOver(good) });
  assert.equal(keyless.result.reason, GATE_REASONS.RELEASE_INVALID);
  assert.equal(keyless.gate.reauthorization.detail, "release_key_unavailable");
  assert.equal(keyless.provider.calls.length, 0);
  process.env.QUEUE_OWNER_RELEASE_SECRET = SECRET;
  assert.equal(verifyOwnerReleaseRecord(good.metadata.reauthorization, good, {}).reason, "release_key_unavailable");
  assert.equal(verifyOwnerReleaseRecord(good.metadata.reauthorization, good, { QUEUE_OWNER_RELEASE_SECRET: "another-key" }).reason, "release_signature_invalid");
});

test("BULK SQL FAKED RELEASE: editing the message or the recipient after the release invalidates it", async () => {
  const good = releasedRow();
  const edited = { ...good, message_body: "A different message the owner never saw." };
  const a = await dispatch(edited, { over: releaseOver(good, { readReleaseAudit: async () => ({ found: true }) }) });
  assert.equal(a.result.reason, GATE_REASONS.RELEASE_INVALID, JSON.stringify(a.gate));
  assert.equal(a.gate.reauthorization.detail, "release_signature_invalid");
  assert.equal(a.provider.calls.length, 0);
  // Recipient edited in the row (thread_key kept consistent so identity alone does not refuse).
  const moved = { ...good, to_phone_number: "+13125550188", thread_key: "+13125550188" };
  const b = await dispatch(moved, { over: releaseOver(good, { readReleaseAudit: async () => ({ found: true }) }) });
  assert.equal(b.result.reason, GATE_REASONS.RELEASE_INVALID, JSON.stringify(b.gate));
  assert.equal(b.gate.reauthorization.detail, "release_signature_invalid");
  assert.equal(b.provider.calls.length, 0);
  assert.equal(verifyOwnerReleaseRecord(good.metadata.reauthorization, { ...good, to_phone_number: "+13125550188" }).reason, "release_signature_invalid");
});

test("BULK SQL FAKED RELEASE: a valid signature with NO matching audit event is refused (and an unreadable audit too)", async () => {
  const row = releasedRow();
  const missing = await dispatch(row, { over: releaseOver(row, { readReleaseAudit: async () => ({ found: false }) }) });
  assert.equal(missing.result.reason, GATE_REASONS.RELEASE_AUDIT_MISSING, JSON.stringify(missing.gate));
  assert.equal(missing.gate.reauthorization.historical_reasons.includes("history_unreadable"), false, "history was readable; only the audit was missing");
  assert.equal(missing.provider.calls.length, 0);
  // An audit event for a DIFFERENT signature does not count either.
  const otherSig = await dispatch(row, { over: releaseOver(row, { readReleaseAudit: async (r) => ({ found: r.signature === "b".repeat(64) }) }) });
  assert.equal(otherSig.result.reason, GATE_REASONS.RELEASE_AUDIT_MISSING);
  assert.equal(otherSig.provider.calls.length, 0);
  const down = await dispatch(row, { over: releaseOver(row, { readReleaseAudit: async () => { throw new Error("timeout"); } }) });
  assert.equal(down.result.reason, GATE_REASONS.HISTORY_UNREADABLE);
  assert.equal(down.gate.reauthorization.detail, "release_audit_unreadable", "the AUDIT read failed, not the history read");
  assert.equal(down.provider.calls.length, 0);
});

test("a release is overtaken by a later hold status (even flipped back by hand) or a later brake event", async () => {
  const row = releasedRow();
  const at = Date.parse(row.metadata.reauthorization.at);
  const flipped = [...releasedHistory(row.metadata.reauthorization.at),
    { from_status: "processing", to_status: "paused_global_lock", changed_at: iso(at + 30_000) },
    { from_status: "paused_global_lock", to_status: "queued", changed_at: iso(at + 40_000) }];
  const a = await dispatch(row, { over: releaseOver(row, { readStatusHistory: async () => flipped }) });
  assert.equal(a.result.reason, GATE_REASONS.REAUTHORIZATION_STALE, JSON.stringify(a.gate));
  assert.equal(a.gate.reauthorization.detail, "status_hold_after_authorization");
  assert.equal(a.provider.calls.length, 0);
  const b = await dispatch(row, { over: releaseOver(row, { readLatestAuthorityEvent: async () => iso(at + 30_000) }) });
  assert.equal(b.result.reason, GATE_REASONS.REAUTHORIZATION_STALE, "lifting the brake after a release does not carry the release");
  assert.equal(b.gate.reauthorization.detail, "freeze_or_brake_event_after_authorization");
  assert.equal(b.provider.calls.length, 0);
  // Control: the same row with the un-overtaken history is authorized, so the two refusals above are the overtaking.
  const c = await dispatch(row, { over: releaseOver(row) });
  assert.equal(c.result.provider_invoked, true, JSON.stringify(c.gate));
});

test("Cockpit owner-release route: the actor is the session user; body text is ignored; no session user = 403", async () => {
  const { POST } = await import("@/app/api/cockpit/queue/owner-release/route.js");
  const calls = [];
  const runAction = async (args) => { calls.push(args); return { ok: true }; };
  const env = { OPS_ALLOWED_USER_IDS: "founder-user-id,other-op" };
  const req = (headers, body) => new Request("http://localhost/api/cockpit/queue/owner-release", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const body = { queue_item_id: "q1", release_ids: ["q1"], reason: "reviewed", confirm: "OWNER_RELEASE", actor: "attacker", actor_user_id: "attacker" };

  const ok = await POST(req({ "x-ops-dashboard-secret": process.env.OPS_DASHBOARD_SECRET || "test", "x-ops-user-id": "founder-user-id" }, body), { runAction, env });
  assert.equal(ok.status, 200);
  assert.equal(calls[0].operator.id, "founder-user-id");
  assert.equal(calls[0].payload.actor, undefined, "request text never names the actor");
  assert.equal(calls[0].payload.actor_user_id, undefined);

  const noUser = await POST(req({ "x-ops-dashboard-secret": process.env.OPS_DASHBOARD_SECRET || "test" }, body), { runAction, env });
  assert.equal(noUser.status, 403);
  const notAllowed = await POST(req({ "x-ops-dashboard-secret": process.env.OPS_DASHBOARD_SECRET || "test", "x-ops-user-id": "stranger" }, body), { runAction, env });
  assert.equal(notAllowed.status, 403);
  const emptyAllowlist = await POST(req({ "x-ops-dashboard-secret": process.env.OPS_DASHBOARD_SECRET || "test", "x-ops-user-id": "founder-user-id" }, body), { runAction, env: {} });
  assert.equal(emptyAllowlist.status, 403);
  const noSecret = await POST(req({ "x-ops-user-id": "founder-user-id" }, body), { runAction, env });
  assert.ok([401, 500].includes(noSecret.status));
  assert.equal(calls.length, 1, "only the authenticated, allowlisted session reached the service");
});

// ── claim actually held ────────────────────────────────────────────────────

test("CLAIM: a token that is not the fresh row's lock_token, or that the atomic verifier rejects, never sends", async () => {
  const row = queueRow({ lock_token: "my-token" });
  const stolen = await dispatch(row, { over: { readQueueRow: async () => ({ ...row, lock_token: "another-workers-token" }) } });
  assert.equal(stolen.result.reason, `${GATE_REASONS.CLAIM_NOT_HELD}:lock_token_mismatch`);
  assert.equal(stolen.provider.calls.length, 0);
  const rejected = await dispatch(queueRow(), { over: { verifyDispatchClaim: async () => ({ ok: false, reason: "claim_expired" }) } });
  assert.equal(rejected.result.reason, `${GATE_REASONS.CLAIM_NOT_HELD}:claim_expired`);
  const thrown = await dispatch(queueRow(), { over: { verifyDispatchClaim: async () => { throw new Error("rpc down"); } } });
  assert.equal(thrown.result.reason, `${GATE_REASONS.CLAIM_NOT_HELD}:dispatch_claim_verify_failed`);
});

// ── runner wiring with LIVE reads (no reader overrides) ────────────────────

/** A generic Supabase double: any query chain, answered per table; records every read. */
function liveDb(tables) {
  const reads = [];
  const rpcs = [];
  const chainFor = (table) => {
    const result = () => ({ data: typeof tables[table] === "function" ? tables[table]() : tables[table] ?? [], error: null });
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result()).then(res, rej);
        if (prop === "maybeSingle" || prop === "single") return async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }; };
        return () => chain;
      },
    });
    return chain;
  };
  return {
    reads,
    rpcs,
    from(table) { reads.push(table); return chainFor(table); },
    rpc: async (name) => { rpcs.push(name); return { data: { ok: true }, error: null }; },
  };
}

test("RUNNER WIRING (live reads): with a real client the gate reads the fresh row, trigger history, freeze events and the atomic claim", async () => {
  const row = queueRow({ lock_token: "live-claim" });
  const db = liveDb({
    send_queue: [{ ...row }],
    send_queue_status_history: [
      { from_status: null, to_status: "queued", changed_at: iso(nowMs - 60_000) },
      { from_status: "queued", to_status: "paused_global_lock", changed_at: iso(nowMs - 30_000) },
      { from_status: "paused_global_lock", to_status: "processing", changed_at: iso(nowMs - 1_000) },
    ],
    send_authority_events: [{ changed_at: iso(nowMs - 3600_000), key: "p0_history_floor" }],
    campaigns: [],
  });
  const provider = spy();
  const result = await dispatchSellerQueueRow(row, { to: PHONE, from: FROM, body: BODY }, {
    store: createMemoryS11Store(),
    supabase: db,
    sendProvider: provider.fn,
    getSystemValue: ALLOW,
    now: NOW,
    contact_window: { allowed: true, hold: false, timezone: "America/Chicago" },
    finalSenderContinuityCheck: async () => ({ ok: true }),
    finalContactRestrictionCheck: async () => ({ refused: false }),
  });
  for (const table of ["send_queue", "send_queue_status_history", "send_authority_events", "inbox_thread_state", "automation_suppressions"]) {
    assert.ok(db.reads.includes(table), `live read of ${table}: ${db.reads.join(",")}`);
  }
  assert.ok(db.rpcs.includes("queue_verify_dispatch_authorization"), "the atomic claim verifier was called");
  assert.equal(result.provider_invoked, false);
  assert.ok(result.final_gate.refusals.includes(GATE_REASONS.REAUTHORIZATION_REQUIRED), JSON.stringify(result.final_gate));
  assert.equal(provider.calls.length, 0);
});

test("RUNNER WIRING (source): the runner hands the bridge its real client and the atomic claim token", () => {
  const src = read("lib/domain/queue/process-send-queue.js");
  const call = src.indexOf("await dispatchSellerQueueRow(");
  assert.ok(call > 0);
  const window = src.slice(call, call + 4000);
  assert.match(window, /supabase: getSupabase\(deps\)/);
  assert.match(window, /claim_token: lock_token/);
});

// ── campaign resume pages through every row ────────────────────────────────

test("CAMPAIGN RESUME: the hold pages through every waiting row (no 10,000 cap)", async () => {
  const rows = Array.from({ length: 1234 }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, campaign_id: "camp-big", queue_status: "queued", metadata: {} }));
  const writes = [];
  const db = {
    from() {
      return {
        select: () => {
          let after = null;
          const q = {
            eq: () => q, in: () => q, order: () => q,
            gt: (_c, v) => { after = v; return q; },
            limit: async (n) => ({ data: rows.filter((r) => after === null || r.id > after).slice(0, n), error: null }),
          };
          return q;
        },
        update: (patch) => {
          const f = {};
          const u = { eq(k, v) { f[k] = v; return u; }, select: async () => { writes.push(f.id); return { data: [{ id: f.id }], error: null }; } };
          return u;
        },
      };
    },
  };
  const out = await holdCampaignRowsForReauthorization("camp-big", { supabase: db, page_size: 100 });
  assert.equal(out.ok, true);
  assert.equal(out.examined, 1234);
  assert.equal(out.held, 1234);
  assert.equal(new Set(writes).size, 1234);
  assert.doesNotMatch(read("lib/domain/queue/no-automatic-reactivation.js"), /limit = 10000/);
});

// ── 2. DASHBOARD ROUTES ────────────────────────────────────────────────────

const FENCED = ["retry-failed", "reprocess-paused", "reconcile", "run", "run-safe-batch", "build-outbound", "build-followups", "build-replies", "cancel-stale-followups"];

test("DASHBOARD retry-failed / reprocess-paused (and every queue writer) are fenced: authenticated, 410, nothing written", async () => {
  const { fencedQueueHandler, authenticateQueueRoute } = await import(pathToFileURL(path.join(DASH, "api/_lib/queueRouteFence.ts")).href);
  const savedMutation = process.env.NEXUS_ALLOW_BACKEND_MUTATION;
  process.env.NEXUS_ALLOW_BACKEND_MUTATION = "true"; // the old guard, fully open: still fenced
  // A real secret for this test (the env is reset before every test).
  const savedSecret = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = "round3-internal-secret";
  const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; } }; return r; };
  try {
    // ROUND 3: the REAL route modules' default exports, not only the fence
    // factory. (The dashboard's .ts files import siblings without an
    // extension; tests/alias-loader.mjs resolves those as .ts.)
    for (const route of FENCED) {
      const mod = await import(pathToFileURL(path.join(DASH, `api/internal/queue/${route}.ts`)).href);
      const handler = mod.default;
      assert.equal(typeof handler, "function", route);
      const unauth = res();
      await handler({ method: "POST", headers: {}, body: { ids: ["q1"] } }, unauth);
      assert.equal(unauth.code, 401, route);
      const wrong = res();
      await handler({ method: "POST", headers: { "x-internal-api-secret": "not-the-secret" }, body: { ids: ["q1"] } }, wrong);
      assert.equal(wrong.code, 401, route);
      const authed = res();
      await handler({ method: "POST", headers: { "x-internal-api-secret": "round3-internal-secret" }, body: { ids: ["q1"], status: "queued" } }, authed);
      assert.equal(authed.code, 410, route);
      assert.equal(authed.body.error, "QUEUE_ROUTE_FENCED", route);
      assert.equal(authed.body.route, `dashboard/api/internal/queue/${route}`, "each file fences ITSELF, not another route");
      assert.equal(authed.body.writes, 0);
    }
    // Same behaviour from the factory, and no configured secret authorizes nobody.
    const viaFactory = res();
    await fencedQueueHandler("retry-failed")({ method: "POST", headers: { "x-internal-api-secret": "round3-internal-secret" } }, viaFactory);
    assert.equal(viaFactory.code, 410);
    assert.equal(authenticateQueueRoute({ headers: { "x-internal-api-secret": "x" } }, {}).status, 503, "no secret configured authorizes nobody");
    delete process.env.INTERNAL_API_SECRET;
    const noSecret = res();
    await (await import(pathToFileURL(path.join(DASH, "api/internal/queue/reprocess-paused.ts")).href)).default({ method: "POST", headers: { "x-internal-api-secret": "" } }, noSecret);
    assert.equal(noSecret.code, 503);
  } finally {
    if (savedMutation === undefined) delete process.env.NEXUS_ALLOW_BACKEND_MUTATION;
    else process.env.NEXUS_ALLOW_BACKEND_MUTATION = savedMutation;
    if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = savedSecret;
  }
  // Source shape, CODE only: the fenced files may explain in comments what they
  // used to do (send_queue ...), but their code is exactly the fence and nothing else.
  // Whole-line `//` comments go FIRST: a line comment may contain a `/*` (the
  // fence's header says "api/internal/queue/*"), and stripping block comments
  // first let that fake opener swallow real code up to the next `*/`.
  const codeOnly = (src) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const route of FENCED) {
    const code = codeOnly(fs.readFileSync(path.join(DASH, `api/internal/queue/${route}.ts`), "utf8"));
    assert.deepEqual(code, [
      "import { fencedQueueHandler } from '../../_lib/queueRouteFence'",
      `export default fencedQueueHandler('${route}')`,
    ], `${route}: the file is the fence and nothing else`);
  }
  const fenceCode = codeOnly(fs.readFileSync(path.join(DASH, "api/_lib/queueRouteFence.ts"), "utf8")).join("\n");
  assert.doesNotMatch(fenceCode, /supabase|createClient|(?<!Buffer)\.from\(|\.rpc\(|\.update\(|\.insert\(|fetch\(/i, "the fence creates no client and touches no table");
  const fenceImports = fenceCode.split("\n").filter((l) => l.startsWith("import "));
  assert.deepEqual(fenceImports, ["import crypto from 'node:crypto'"]);
  const runner = fs.readFileSync(path.join(DASH, "api/internal/queue/runner.ts"), "utf8");
  assert.match(runner, /if \(QUEUE_RUNNER_FENCED\)/);
});
