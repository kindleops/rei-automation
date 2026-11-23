/**
 * p0-final-dispatch-gate-adversarial.test.mjs
 *
 * FOUNDER P0 2026-11-23, items 1, 2, 5, 6 and 9 on the LeadCommand production
 * line. Adversarial regression tests, named as the founder named them:
 *
 *   global unpause · campaign resume · stale approval (Cockpit approve of an
 *   old row) · archived record · suppression-reader failure (automated AND
 *   manual) · raw-number dispatch · provider retry · concurrent worker
 *   dispatch · service restart
 *
 * plus the gate's own checks (paused_operator_review, quarantine, legal and
 * repair holds, quiet hours with an unknown zone, claim proof, campaign state,
 * brake state now) and the route inventory ratchet.
 *
 * Every dispatch-level case runs the REAL bridge (dispatchSellerQueueRow /
 * dispatchManualOperatorSend) through the REAL seam with a provider spy: the
 * property under test is always "the provider was / was not called".
 * Nothing here sends anything.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchSellerQueueRow } from "@/lib/domain/communications/dispatch-seller-queue-row.js";
import { dispatchManualOperatorSend } from "@/lib/domain/communications/dispatch-manual-operator-send.js";
import {
  GATE_REASONS,
  REAUTHORIZATION_MAX_AGE_MS,
  __setFinalDispatchGateModeForTests,
  buildReauthorizationHoldPatch,
  decideFinalDispatch,
  evaluateReauthorization,
  evaluateReleaseGate,
  isHistoricalRow,
  isPausedReviewRow,
  rowHoldHistory,
} from "@/lib/domain/queue/final-dispatch-gate.js";
import { holdCampaignRowsForReauthorization } from "@/lib/domain/queue/no-automatic-reactivation.js";
import { reconcileCanonicalQueueLifecycle } from "@/lib/supabase/sms-engine.js";
import { runQueueAction, OWNER_RELEASE_CONFIRM } from "@/lib/cockpit/cockpit-service.js";
import { evaluateCanonicalContactability } from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import { handleSendNowRequestData } from "@/lib/domain/outbound/send-now-request.js";
import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const PHONE = "+13125550100";
const OTHER = "+13125550199";
const FROM = "+18885551212";
const NOW = "2026-11-23T18:00:00.000Z";
const nowMs = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString();

// Control plane: unrestricted live execution, no stop, no shutdown.
const ALLOW = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  return null;
};
// Emergency stop set (the global brake).
const BRAKED = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  if (key === "queue_emergency_stop_at") return "2026-11-23T00:00:00.000Z";
  return null;
};

// Live facts: a healthy, contactable, unarchived thread.
const healthyReaders = (over = {}) => ({
  readSuppression: async () => ({ suppressed: false, lookup_error: null }),
  readAutomationSuppression: async () => ({ active: false }),
  readThreadState: async () => ({ thread_key: PHONE, status: "active", is_archived: false, last_inbound_at: null, metadata: {} }),
  readAutomationHold: async () => ({ held: false, fail_closed: false }),
  readCampaign: async () => ({ id: "camp-1", status: "active" }),
  // Round 2 history reads: a row inserted queued, claimed to processing, the
  // latest freeze/brake event an hour before NOW, the atomic claim held.
  readStatusHistory: async () => [
    { from_status: null, to_status: "queued", changed_at: iso(nowMs - 60_000) },
    { from_status: "queued", to_status: "processing", changed_at: iso(nowMs - 1_000) },
  ],
  readLatestAuthorityEvent: async () => iso(nowMs - 3600_000),
  readReleaseAudit: async () => ({ found: false }),
  verifyDispatchClaim: async () => ({ ok: true }),
  ...over,
});

// The gate refuses a read with no client, so the dispatch tests hand it one
// whose every direct read would throw: only the injected readers may answer.
const NO_DIRECT_READS = { from() { throw new Error("unexpected direct read: inject a reader"); } };

let seq = 0;
const queueRow = (over = {}) => ({
  id: `q-p0-${++seq}`,
  thread_key: PHONE,
  to_phone_number: PHONE,
  from_phone_number: FROM,
  campaign_target_id: `33333333-3333-4333-8333-${String(100000000000 + seq).slice(-12)}`,
  touch_number: 1,
  queue_status: "processing",
  lock_token: "claim-token-1",
  created_at: iso(nowMs - 60_000),
  metadata: {},
  ...over,
});

function spy() {
  const calls = [];
  return { calls, fn: async (args) => { calls.push(args); return { ok: true, sid: `SM${calls.length}` }; } };
}

/** Run the REAL queue bridge, gate facts enforced, every collaborator injected. */
async function dispatchQueue(row, { readers = healthyReaders(), getSystemValue = ALLOW, store = createMemoryS11Store(), provider = spy(), extra = {} } = {}) {
  const result = await dispatchSellerQueueRow(row, { to: row.to_phone_number, from: FROM, body: "Hello, checking in about the property." }, {
    store,
    supabase: NO_DIRECT_READS,
    sendProvider: provider.fn,
    getSystemValue,
    now: NOW,
    contact_window: { allowed: true, hold: false, timezone: "America/Chicago" },
    // The gate re-reads the row fresh; by default the stored row IS this row.
    finalGateReaders: { readQueueRow: async () => row, ...readers },
    finalSenderContinuityCheck: async () => ({ ok: true, reason: null, verdict: null }),
    finalContactRestrictionCheck: async () => ({ refused: false, reason: null }),
    ...extra,
  });
  return { result, provider, store };
}

/** Run the REAL manual bridge (canonical authority; no operator principal needed for the gate). */
async function dispatchManual({ thread_key = PHONE, to = PHONE, readers = healthyReaders(), getSystemValue = ALLOW, provider = spy(), operator_action_id = `op-${++seq}`, queue_row = null } = {}) {
  const result = await dispatchManualOperatorSend({
    operator_action_id,
    thread_key,
    to_phone_number: to,
    message: { to, from: FROM, body: "Thanks for getting back to me." },
    store: createMemoryS11Store(),
    supabase: NO_DIRECT_READS,
    getSystemValue,
    sendProvider: provider.fn,
    finalGateReaders: readers,
    queue_row,
    now: NOW,
  });
  return { result, provider };
}

test.before(() => __setFinalDispatchGateModeForTests("enforce"));
test.after(() => __setFinalDispatchGateModeForTests(null));

// ── baseline: a clean send still sends ─────────────────────────────────────

test("baseline: a clean, claimed, in-window queue row passes the final gate and reaches the provider once", async () => {
  const { result, provider } = await dispatchQueue(queueRow());
  assert.equal(result.provider_invoked, true, JSON.stringify(result));
  assert.equal(provider.calls.length, 1);
  assert.equal(result.final_gate.ok, true);
});

test("baseline: an authorized manual send stays available when every check succeeds", async () => {
  const { result, provider } = await dispatchManual();
  assert.equal(result.provider_invoked, true, JSON.stringify(result));
  assert.equal(provider.calls.length, 1);
});

// ── 1. GLOBAL UNPAUSE ──────────────────────────────────────────────────────

function reconcileDb({ active = [], expired = [] } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      if (table === "send_queue") {
        return {
          select: () => ({
            in: () => ({ order: () => ({ limit: async () => ({ data: active, error: null }) }) }),
            eq: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: expired, error: null }) }) }) }),
          }),
          update: (patch) => ({ eq: async (_col, id) => { updates.push({ id, patch }); return { data: null, error: null }; } }),
        };
      }
      if (table === "campaigns") return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
    },
  };
}

test("GLOBAL UNPAUSE: while the brake is set, every waiting row is stamped as having sat through it", async () => {
  const waiting = { id: "w1", queue_status: "queued", created_at: iso(nowMs - 10 * 60_000), updated_at: iso(nowMs - 10 * 60_000), metadata: {}, retry_count: 0, max_retries: 3 };
  const db = reconcileDb({ active: [waiting] });
  await reconcileCanonicalQueueLifecycle({ supabase: db, now: NOW, queue_emergency_stop_at: "2026-11-23T00:00:00.000Z", queue_processor_mode: "off" });
  const patch = db.updates.find((u) => u.id === "w1")?.patch;
  assert.ok(patch?.metadata?.held_through_send_brake, JSON.stringify(db.updates));
  assert.equal(patch.queue_status, undefined, "stamping never changes the status");
});

test("GLOBAL UNPAUSE: lifting the brake moves held rows to review and revives NO expired row", async () => {
  const held = { id: "h1", queue_status: "queued", created_at: iso(nowMs - 30 * 60_000), updated_at: iso(nowMs - 30 * 60_000), scheduled_for_utc: iso(nowMs - 20 * 60_000), metadata: { held_through_send_brake: { at: iso(nowMs - 25 * 60_000) } }, retry_count: 0, max_retries: 3 };
  const pastDueHeld = { id: "h2", queue_status: "scheduled", created_at: iso(nowMs - 30 * 60_000), updated_at: iso(nowMs - 30 * 60_000), scheduled_for_utc: iso(nowMs - 5 * 60_000), metadata: { send_brake_hold: true, send_brake_held_at: iso(nowMs - 25 * 60_000) }, retry_count: 0, max_retries: 3 };
  const expired = { id: "e1", queue_status: "expired", failed_reason: "stale_runnable_row_expired", scheduled_for_utc: iso(nowMs - 3600_000), metadata: { expired_due_to_send_brake: true } };
  const db = reconcileDb({ active: [held, pastDueHeld], expired: [expired] });
  const result = await reconcileCanonicalQueueLifecycle({ supabase: db, now: NOW, queue_emergency_stop_at: "", queue_processor_mode: "live" });

  const byId = Object.fromEntries(db.updates.map((u) => [u.id, u.patch]));
  assert.equal(byId.h1.queue_status, "paused_operator_review");
  assert.equal(byId.h2.queue_status, "paused_operator_review", "a past-due held row is not promoted to queued");
  assert.equal(byId.h1.metadata.reauthorization_required.trigger, "send_brake_cleared");
  assert.ok(byId.h1.metadata.reauthorization_required.revalidation_blockers.includes("authorization_scope_invalid"), "revalidateBeforeDispatch ran");
  assert.equal(byId.e1.queue_status, undefined, "an expired brake row stays expired");
  assert.ok(byId.e1.metadata.reauthorization_required);
  for (const { patch } of db.updates) {
    assert.ok(!["queued", "scheduled"].includes(patch.queue_status), `no row is made sendable: ${JSON.stringify(patch)}`);
  }
  assert.equal(result.brake_rows_held_for_reauthorization, 2);
  assert.equal(result.brake_expired_rows_not_revived, 1);
});

test("GLOBAL UNPAUSE: even if a held row's status is flipped back to queued, the final gate refuses it", async () => {
  const row = queueRow({ queue_status: "queued", metadata: { held_through_send_brake: { at: iso(nowMs - 3600_000) } } });
  const { result, provider } = await dispatchQueue(row);
  assert.equal(result.provider_invoked, false);
  assert.equal(result.reason, GATE_REASONS.REAUTHORIZATION_REQUIRED);
  assert.equal(provider.calls.length, 0);
});

test("brake state NOW: an active emergency stop refuses at the final gate with no provider call", async () => {
  const { result, provider } = await dispatchQueue(queueRow(), { getSystemValue: BRAKED });
  assert.equal(result.provider_invoked, false);
  assert.equal(result.stage, "runtime_authority");
  assert.equal(provider.calls.length, 0);
});

// ── 2. CAMPAIGN RESUME ─────────────────────────────────────────────────────

function resumeDb(rows, { readError = null, writeError = null } = {}) {
  const writes = [];
  return {
    writes,
    from() {
      return {
        // Keyset pages (round 2): .eq().in()[.gt('id', after)].order('id').limit(n)
        select: () => {
          let after = null;
          const q = {
            eq: () => q, in: () => q,
            gt: (_col, v) => { after = v; return q; },
            order: () => q,
            limit: async (n) => {
              if (readError) return { data: null, error: readError };
              const page = rows.filter((r) => after === null || String(r.id) > String(after)).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, n);
              return { data: page, error: null };
            },
          };
          return q;
        },
        update: (patch) => {
          const filters = {};
          const q = {
            eq(k, v) { filters[k] = v; return q; },
            select: async () => {
              writes.push({ patch, filters: { ...filters } });
              return writeError ? { data: null, error: writeError } : { data: [{ id: filters.id }], error: null };
            },
          };
          return q;
        },
      };
    },
  };
}

test("CAMPAIGN RESUME: every pre-pause row is revalidated and held (CAS on its status); none goes back out", async () => {
  const rows = [queueRow({ id: "r1", campaign_id: "camp-1", queue_status: "queued" }), queueRow({ id: "r2", campaign_id: "camp-1", queue_status: "scheduled" })];
  const db = resumeDb(rows);
  const out = await holdCampaignRowsForReauthorization("camp-1", { supabase: db, now: NOW });
  assert.deepEqual([out.ok, out.examined, out.held], [true, 2, 2]);
  for (const w of db.writes) {
    assert.equal(w.patch.queue_status, "paused_operator_review");
    assert.equal(w.patch.metadata.reauthorization_required.trigger, "campaign_resume");
    assert.ok(w.patch.metadata.reauthorization_required.revalidation_blockers.includes("authorization_scope_invalid"));
    assert.ok(["queued", "scheduled"].includes(w.filters.queue_status), "compare-and-set on the status that was read");
  }
});

test("CAMPAIGN RESUME: unreadable rows or a failed hold write refuse the resume (fail closed)", async () => {
  const unreadable = await holdCampaignRowsForReauthorization("camp-1", { supabase: resumeDb([], { readError: new Error("db down") }) });
  assert.equal(unreadable.ok, false);
  const unwritable = await holdCampaignRowsForReauthorization("camp-1", { supabase: resumeDb([queueRow({ campaign_id: "camp-1", queue_status: "queued" })], { writeError: new Error("db down") }) });
  assert.equal(unwritable.ok, false);
  assert.equal(unwritable.reason, "campaign_row_hold_write_failed");
});

test("CAMPAIGN RESUME: the lifecycle holds the rows BEFORE the campaign status changes, and refuses on a failed hold", () => {
  const src = read("lib/domain/campaigns/campaign-automation-service.js");
  const branch = src.indexOf("if (action === 'resume' && fromStatus === 'paused')");
  const hold = src.indexOf("holdCampaignRowsForReauthorization", branch);
  const refuse = src.indexOf("CAMPAIGN_RESUME_HOLD_FAILED", branch);
  const transition = src.indexOf("await transitionCampaignStatus(supabase, campaignId, target", branch);
  assert.ok(branch > 0 && hold > branch && refuse > hold && transition > refuse, "hold -> refuse-on-failure -> transition");
});

test("CAMPAIGN RESUME: a row whose campaign is still paused is refused at the final gate", async () => {
  const row = queueRow({ campaign_id: "camp-1" });
  const { result, provider } = await dispatchQueue(row, { readers: healthyReaders({ readCampaign: async () => ({ id: "camp-1", status: "paused" }) }) });
  assert.equal(result.provider_invoked, false);
  assert.equal(result.reason, `${GATE_REASONS.CAMPAIGN_NOT_LIVE}:paused`);
  assert.equal(provider.calls.length, 0);
  const unreadable = await dispatchQueue(queueRow({ campaign_id: "camp-1" }), { readers: healthyReaders({ readCampaign: async () => { throw new Error("db"); } }) });
  assert.equal(unreadable.result.reason, GATE_REASONS.CAMPAIGN_UNREADABLE);
});

// ── 3. STALE APPROVAL (Cockpit approve of an old row) ───────────────────────

function cockpitDb(row, { thread = null, statusHistory = null, authorityEventAt = "2026-01-01T00:00:00.000Z" } = {}) {
  const calls = { updates: [] };
  // Round 2: the release path reads the trigger-written history. Default: the
  // row was inserted 'queued' and has never been anywhere else.
  const history = statusHistory || [{ from_status: null, to_status: "queued", changed_at: row.created_at || "2026-01-01T00:00:00.000Z" }];
  const dataFor = (table) => {
    if (table === "inbox_thread_state") return thread ? [thread] : [];
    if (table === "send_queue_status_history") return history;
    if (table === "send_authority_events") return authorityEventAt ? [{ changed_at: authorityEventAt, key: "p0_history_floor" }] : [];
    return [];
  };
  return {
    calls,
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, limit: () => chain, order: () => chain,
        maybeSingle: async () => ({ data: table === "send_queue" ? row : null, error: null }),
        then: (res, rej) => Promise.resolve({ data: dataFor(table), count: 0, error: null }).then(res, rej),
        update(patch) {
          calls.updates.push(patch);
          const u = { eq: () => u, select: () => ({ maybeSingle: async () => ({ data: { id: row.id, queue_status: patch.queue_status }, error: null }) }) };
          return u;
        },
      };
      return chain;
    },
  };
}
const OPERATOR = Object.freeze({ kind: "ops_dashboard_operator", authenticated: true, via: "header:x-ops-dashboard-secret", id: "founder-user-id" });
const SIGNING_ENV = { QUEUE_OWNER_RELEASE_SECRET: "p0-test-owner-release-secret" };
const cockpit = (action, row, payload = {}, { thread = null, operator = OPERATOR, env = SIGNING_ENV, statusHistory = null, authorityEventAt } = {}) => {
  const supabase = cockpitDb(row, { thread, statusHistory, ...(authorityEventAt !== undefined ? { authorityEventAt } : {}) });
  return runQueueAction({
    action,
    payload: { queue_item_id: row.id, dry_run: false, ...payload },
    supabase,
    getFlags: async () => ({ outbound_sms_enabled: true, queue_runner_enabled: true, followup_enabled: true }),
    getValue: async () => "live",
    dispatchGate: async () => ({ blocked: false }),
    releaseAudit: async () => ({ ok: true }),
    operator,
    env,
  }).then((r) => ({ r, supabase }));
};

test("STALE APPROVAL: Cockpit approve / retry / reschedule of an OLD row is refused (needs an owner release)", async () => {
  const old = { id: "old-1", queue_status: "approval", thread_key: PHONE, to_phone_number: PHONE, created_at: "2026-10-01T00:00:00.000Z", metadata: {} };
  for (const action of ["approve", "retry", "retry-routing", "reschedule"]) {
    const { r, supabase } = await cockpit(action, old, { scheduled_for: NOW });
    assert.equal(r.ok, false, action);
    assert.equal(r.reason, "historical_row_requires_owner_release", action);
    assert.equal(supabase.calls.updates.length, 0, `${action}: nothing written`);
  }
});

test("STALE APPROVAL: approve of a row with hold history, or one the seller has replied past, is refused", async () => {
  const fresh = new Date().toISOString();
  const heldBefore = { id: "hb-1", queue_status: "approval", thread_key: PHONE, to_phone_number: PHONE, created_at: fresh, metadata: { send_brake_hold: true } };
  const a = await cockpit("approve", heldBefore);
  assert.equal(a.r.reason, "historical_row_requires_owner_release");
  assert.deepEqual(a.r.hold_markers, ["send_brake_hold"]);

  const written = new Date(Date.now() - 60_000).toISOString();
  const overtaken = { id: "ov-1", queue_status: "approval", thread_key: PHONE, to_phone_number: PHONE, created_at: written, metadata: {} };
  const b = await cockpit("approve", overtaken, {}, { thread: { thread_key: PHONE, last_inbound_at: new Date().toISOString() } });
  assert.equal(b.r.reason, "historical_row_requires_owner_release");
  assert.equal(b.r.historical_reason, "seller_replied_after_row_written");
});

test("STALE APPROVAL: paused_operator_review cannot be approved (isPausedReview recognises it)", async () => {
  assert.equal(isPausedReviewRow({ queue_status: "paused_operator_review" }), true);
  const row = { id: "por-1", queue_status: "paused_operator_review", thread_key: PHONE, to_phone_number: PHONE, metadata: {} };
  for (const action of ["approve", "retry", "retry-routing"]) {
    const { r, supabase } = await cockpit(action, row);
    assert.equal(r.reason, "paused_review", action);
    assert.equal(supabase.calls.updates.length, 0);
  }
});

test("STALE APPROVAL: the owner release is the ONLY per-row authorization, and the gate expires it", async () => {
  const old = { id: "own-1", queue_status: "paused_operator_review", thread_key: PHONE, to_phone_number: PHONE, created_at: "2026-10-01T00:00:00.000Z", metadata: { reauthorization_required: { trigger: "campaign_resume", at: "2026-11-01T00:00:00.000Z" } } };
  // `actor` in the body is request text: ignored. The session user is the actor.
  const { r, supabase } = await cockpit("owner-release", old, { confirm: OWNER_RELEASE_CONFIRM, release_ids: ["own-1"], actor: "someone-typed-this", reason: "reviewed the full thread" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const patch = supabase.calls.updates[0];
  assert.equal(patch.queue_status, "scheduled");
  const reauth = patch.metadata.reauthorization;
  assert.deepEqual([reauth.queue_row_id, reauth.actor_user_id, reauth.reason, reauth.via], ["own-1", "founder-user-id", "reviewed the full thread", "cockpit_owner_release"]);

  const released = { ...old, ...patch, metadata: patch.metadata };
  const at = Date.parse(reauth.at);
  const env = SIGNING_ENV;
  assert.equal(evaluateReauthorization(released, { now: at + 60_000, env }).ok, true, "fresh signed release passes");
  assert.equal(evaluateReauthorization(released, { now: at + REAUTHORIZATION_MAX_AGE_MS + 1, env }).reason, GATE_REASONS.REAUTHORIZATION_STALE, "an old release has expired");
  assert.equal(evaluateReauthorization(released, { now: at + 60_000, last_inbound_at: iso(at + 1000), env }).reason, GATE_REASONS.REAUTHORIZATION_STALE, "the seller replied after the release");
  // A release bound to another row is no release at all.
  const forged = { ...released, id: "someone-else" };
  assert.equal(evaluateReauthorization(forged, { now: at + 60_000, env }).reason, GATE_REASONS.RELEASE_INVALID);
  // Without the server key nothing verifies (fail closed).
  assert.equal(evaluateReauthorization(released, { now: at + 60_000, env: {} }).reason, GATE_REASONS.RELEASE_INVALID);
});

test("STALE APPROVAL: an old Cockpit 'approve' marker is not an authorization at dispatch", async () => {
  const row = queueRow({ queue_status: "queued", metadata: { cockpit_action: "approve", cockpit_action_at: "2026-11-01T00:00:00.000Z", dispatch_hold: { reason: "nurture" } } });
  const { result, provider } = await dispatchQueue(row);
  assert.equal(result.provider_invoked, false);
  assert.equal(result.reason, GATE_REASONS.REAUTHORIZATION_REQUIRED);
  assert.equal(provider.calls.length, 0);
});

// ── 4. ARCHIVED RECORD ─────────────────────────────────────────────────────

const archivedThread = async () => ({ thread_key: PHONE, status: "active", is_archived: true, archive_scope: "lead", metadata: {} });

test("ARCHIVED RECORD: an archived thread blocks the automated send at the final gate", async () => {
  const { result, provider } = await dispatchQueue(queueRow(), { readers: healthyReaders({ readThreadState: archivedThread }) });
  assert.equal(result.provider_invoked, false);
  assert.equal(result.reason, GATE_REASONS.THREAD_ARCHIVED);
  assert.equal(provider.calls.length, 0);
});

test("ARCHIVED RECORD: an archived thread blocks the manual send too", async () => {
  const { result, provider } = await dispatchManual({ readers: healthyReaders({ readThreadState: archivedThread }) });
  assert.equal(result.provider_invoked, false);
  assert.equal(result.reason, GATE_REASONS.THREAD_ARCHIVED);
  assert.equal(provider.calls.length, 0);
});

test("ARCHIVED RECORD: a Cockpit release of a row on an archived thread is refused by the shared release gate", async () => {
  const verdict = await evaluateReleaseGate({ id: "x", queue_status: "approval", thread_key: PHONE, to_phone_number: PHONE, metadata: {} }, { supabase: NO_DIRECT_READS, ...healthyReaders({ readThreadState: archivedThread }) });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.reason, GATE_REASONS.THREAD_ARCHIVED);
});

// ── 5. SUPPRESSION-READER FAILURE (automated AND manual) ───────────────────

const suppressionDown = healthyReaders({ readSuppression: async () => { throw new Error("sms_suppression_list timeout"); } });
const automationSuppressionDown = healthyReaders({ readAutomationSuppression: async () => { throw new Error("timeout"); } });

test("SUPPRESSION-READER FAILURE (automated): the queue send fails closed, no provider call", async () => {
  for (const readers of [suppressionDown, automationSuppressionDown, healthyReaders({ readSuppression: async () => ({ lookup_error: "42P01" }) })]) {
    const { result, provider } = await dispatchQueue(queueRow(), { readers });
    assert.equal(result.provider_invoked, false);
    assert.equal(result.reason, GATE_REASONS.SUPPRESSION_UNREADABLE);
    assert.equal(provider.calls.length, 0);
  }
});

test("SUPPRESSION-READER FAILURE (manual): the founder manual send fails closed too", async () => {
  for (const readers of [suppressionDown, automationSuppressionDown]) {
    const { result, provider } = await dispatchManual({ readers });
    assert.equal(result.provider_invoked, false);
    assert.equal(result.reason, GATE_REASONS.SUPPRESSION_UNREADABLE);
    assert.equal(provider.calls.length, 0);
  }
});

test("SUPPRESSION-READER FAILURE: canonical contactability refuses a MANUAL send on a lookup error or with no client", async () => {
  const broken = {
    from: () => ({ select: () => ({ eq: () => ({ or: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "timeout" } }) }) }) }) }) }),
  };
  for (const mode of ["enqueue", "send_time"]) {
    const verdict = await evaluateCanonicalContactability(
      { thread_key: PHONE, to_phone_number: PHONE, manual_operator_send: true, fail_closed_for_automated: false, contact_check_mode: mode },
      { supabase: broken }
    );
    assert.equal(verdict.blocked, true, mode);
    assert.equal(verdict.reason, "suppression_check_unavailable", mode);
  }
  const noClient = await evaluateCanonicalContactability({ thread_key: PHONE, to_phone_number: PHONE, manual_operator_send: true, fail_closed_for_automated: false }, {});
  assert.equal(noClient.blocked, true);
});

test("an explicitly suppressed contact stays blocked for the manual send", async () => {
  const { result, provider } = await dispatchManual({ readers: healthyReaders({ readSuppression: async () => ({ suppressed: true }) }) });
  assert.equal(result.reason, GATE_REASONS.SUPPRESSED);
  assert.equal(provider.calls.length, 0);
});

test("SUPPRESSION-READER FAILURE: the fenced verification send refuses an allowlisted number when suppression cannot be read", async () => {
  const { runLiveTextgridSendVerification } = await import("@/lib/verification/live-textgrid.js");
  let sent = 0;
  const out = await runLiveTextgridSendVerification(
    { to: PHONE, from: FROM, body: "verification", confirm_live: true },
    {
      env: { ALLOW_LIVE_TEXTGRID_VERIFICATION_SENDS: "true" },
      getSystemFlag: async () => true,
      getSystemValue: async () => PHONE,
      // Authority open, so the refusal below is the suppression read, not the brake.
      evaluateAuthority: async () => ({ ok: true }),
      supabase: NO_DIRECT_READS, // every live read throws: suppression is unreadable
      sendTextgridSMS: async () => { sent += 1; return { sid: "SMx" }; },
    }
  );
  assert.equal(out.ok, false);
  assert.equal(out.reason, `final_gate:${GATE_REASONS.SUPPRESSION_UNREADABLE}`);
  assert.equal(sent, 0);
});

test("ROUND 2: the verification send runs the FULL gate: an active emergency stop refuses it before any read", async () => {
  const { runLiveTextgridSendVerification } = await import("@/lib/verification/live-textgrid.js");
  let sent = 0;
  const out = await runLiveTextgridSendVerification(
    { to: PHONE, from: FROM, body: "verification", confirm_live: true },
    {
      env: { ALLOW_LIVE_TEXTGRID_VERIFICATION_SENDS: "true" },
      getSystemFlag: async () => true,
      getSystemValue: async () => PHONE,
      evaluateAuthority: async () => ({ ok: false, reason: "queue_emergency_stop_active" }),
      supabase: NO_DIRECT_READS,
      finalGateReaders: healthyReaders(),
      sendTextgridSMS: async () => { sent += 1; return { sid: "SMx" }; },
    }
  );
  assert.equal(out.ok, false);
  assert.equal(out.reason, "final_gate:queue_emergency_stop_active");
  assert.equal(sent, 0);
  const src = read("lib/verification/live-textgrid.js");
  assert.match(src, /evaluateFinalDispatchGate/);
  assert.doesNotMatch(src, /evaluateReleaseGate/, "the release preview is not a dispatch gate");
});

// ── 6. RAW-NUMBER DISPATCH ─────────────────────────────────────────────────

test("RAW-NUMBER DISPATCH: a manual send addressed to a bare number (no thread) is refused", async () => {
  const { result, provider } = await dispatchManual({ thread_key: null });
  assert.equal(result.provider_invoked, false);
  assert.equal(result.reason, GATE_REASONS.IDENTITY_UNPROVEN);
  assert.equal(provider.calls.length, 0);
});

test("RAW-NUMBER DISPATCH: a destination that is not the thread's number is refused (queue and manual)", async () => {
  const q = await dispatchQueue(queueRow({ thread_key: PHONE, to_phone_number: OTHER }));
  assert.equal(q.result.reason, GATE_REASONS.IDENTITY_MISMATCH);
  assert.equal(q.provider.calls.length, 0);
  const m = await dispatchManual({ thread_key: PHONE, to: OTHER });
  assert.equal(m.result.reason, GATE_REASONS.IDENTITY_MISMATCH);
  assert.equal(m.provider.calls.length, 0);
});

test("RAW-NUMBER DISPATCH: a phone + message in a URL never sends (internal send-now GET is 405)", async () => {
  let queued = 0;
  const response = await handleSendNowRequestData(
    new Request(`http://localhost/api/internal/outbound/send-now?phone=${encodeURIComponent(PHONE)}&message_text=hi`, { headers: { "x-internal-api-secret": "test" } }),
    "GET",
    { getSystemValue: ALLOW, queueOutboundMessageImpl: async () => { queued += 1; return { ok: true, queue_item_id: 1 }; }, processSendQueueImpl: async () => ({ ok: true }) }
  );
  assert.equal(response.status, 405);
  assert.equal(queued, 0);
});

// ── 7. PROVIDER RETRY ──────────────────────────────────────────────────────

test("PROVIDER RETRY: a delivery-retry clone is born held and the final gate refuses it", async () => {
  const src = read("lib/domain/acquisition/delivery-retry-engine.js");
  assert.match(src, /queue_status: "paused_operator_review"/);
  assert.doesNotMatch(src, /queue_status: "scheduled",\s*\n\s*scheduled_for: timing/, "the clone is no longer born scheduled");
  const clone = queueRow({ queue_status: "queued", metadata: { retry_of_queue_row_id: "failed-row-1", reauthorization: null } });
  assert.ok(rowHoldHistory(clone).some((h) => h.marker === "delivery_retry_clone"));
  const { result, provider } = await dispatchQueue(clone);
  assert.equal(result.reason, GATE_REASONS.REAUTHORIZATION_REQUIRED);
  assert.equal(provider.calls.length, 0);
});

test("PROVIDER RETRY: after an ambiguous provider outcome, a second attempt for the same row never reaches the provider", async () => {
  const store = createMemoryS11Store();
  const row = queueRow();
  let calls = 0;
  const timeout = async () => { calls += 1; const e = new Error("socket hang up after write"); e.name = "TextGridError"; e.network_phase = "response"; e.may_have_transmitted = true; throw e; };
  const first = await dispatchSellerQueueRow(row, { to: PHONE, from: FROM, body: "hello" }, {
    store, supabase: NO_DIRECT_READS, sendProvider: timeout, getSystemValue: ALLOW, now: NOW,
    contact_window: { allowed: true, timezone: "America/Chicago" }, finalGateReaders: { readQueueRow: async () => row, ...healthyReaders() },
    finalSenderContinuityCheck: async () => ({ ok: true }), finalContactRestrictionCheck: async () => ({ refused: false }),
  });
  assert.equal(first.provider_invoked, true);
  const provider = spy();
  const retry = await dispatchQueue(row, { store, provider });
  assert.equal(retry.result.provider_invoked, false, "an ambiguous outcome is absorbing");
  assert.equal(provider.calls.length, 0);
  assert.equal(calls, 1);
});

test("RETRY-FAILED via Cockpit: a failed row that sat through a hold cannot be retried without an owner release", async () => {
  const row = { id: "rf-1", queue_status: "failed", thread_key: PHONE, to_phone_number: PHONE, created_at: new Date().toISOString(), metadata: { conversational_cap_release: { released_at: NOW } } };
  const { r, supabase } = await cockpit("retry", row);
  assert.equal(r.reason, "historical_row_requires_owner_release");
  assert.equal(supabase.calls.updates.length, 0);
});

// ── 8. CONCURRENT WORKER DISPATCH ──────────────────────────────────────────

test("CONCURRENT WORKER DISPATCH: two workers racing one claimed row produce exactly one provider call", async () => {
  const store = createMemoryS11Store();
  const provider = spy();
  const row = queueRow();
  const [a, b] = await Promise.all([dispatchQueue(row, { store, provider }), dispatchQueue(row, { store, provider })]);
  assert.equal([a.result, b.result].filter((r) => r.provider_invoked).length, 1);
  assert.equal(provider.calls.length, 1);
});

test("CONCURRENT WORKER DISPATCH: a worker without the atomic claim token never reaches the provider", async () => {
  const { result, provider } = await dispatchQueue(queueRow({ lock_token: null }));
  assert.equal(result.reason, GATE_REASONS.CLAIM_MISSING);
  assert.equal(provider.calls.length, 0);
});

// ── 9. SERVICE RESTART ─────────────────────────────────────────────────────

test("SERVICE RESTART: a fresh process (new module instance) still refuses a held row; nothing is in memory", async () => {
  const fresh = await import(`../../src/lib/domain/queue/final-dispatch-gate.js?restart=${Date.now()}`);
  const row = queueRow({ queue_status: "queued", metadata: { send_brake_hold: true, send_brake_held_at: iso(nowMs - 3600_000) } });
  const verdict = fresh.decideFinalDispatch({ path: "queue", authority: { ok: true }, row, to: PHONE, thread_key: PHONE, claim_token: "c", facts_loaded: false, sender_continuity: { ok: true }, now: NOW });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.refusals.includes(fresh.GATE_REASONS.REAUTHORIZATION_REQUIRED));
});

test("SERVICE RESTART: the start-up reconcile (brake clear) revives nothing and a sent row is not re-sent", async () => {
  const db = reconcileDb({
    active: [{ id: "rs-1", queue_status: "scheduled", created_at: iso(nowMs - 7200_000), updated_at: iso(nowMs - 7200_000), scheduled_for_utc: iso(nowMs - 3600_000), metadata: { held_through_send_brake: { at: iso(nowMs - 7000_000) } }, retry_count: 0, max_retries: 3 }],
    expired: [{ id: "rs-2", queue_status: "expired", failed_reason: "stale_runnable_row_expired", scheduled_for_utc: iso(nowMs - 3600_000), metadata: { send_brake_hold: true } }],
  });
  await reconcileCanonicalQueueLifecycle({ supabase: db, now: NOW, queue_emergency_stop_at: "", queue_processor_mode: "live", caller_route: "startup" });
  for (const { patch } of db.updates) assert.ok(!["queued", "scheduled"].includes(patch.queue_status), JSON.stringify(patch));

  // The §11 ledger is durable: after a "restart" (a new runner, the same store) the sent row is refused.
  const store = createMemoryS11Store();
  const row = queueRow();
  const first = await dispatchQueue(row, { store });
  assert.equal(first.result.provider_invoked, true);
  const afterRestart = await dispatchQueue(row, { store });
  assert.equal(afterRestart.result.provider_invoked, false);
  assert.equal(afterRestart.provider.calls.length, 0);
});

// ── the gate's own checks ──────────────────────────────────────────────────

test("paused_operator_review / quarantine rows never dispatch", async () => {
  for (const [over, reason] of [
    [{ queue_status: "paused_operator_review" }, GATE_REASONS.PAUSED_OPERATOR_REVIEW],
    [{ queue_status: "incident_quarantine" }, GATE_REASONS.QUARANTINED],
    [{ metadata: { incident_quarantine: true } }, GATE_REASONS.QUARANTINED],
    [{ queue_status: "held" }, `${GATE_REASONS.ROW_NOT_DISPATCHABLE}:held`],
    [{ queue_status: "cancelled" }, `${GATE_REASONS.ROW_NOT_DISPATCHABLE}:cancelled`],
  ]) {
    const { result, provider } = await dispatchQueue(queueRow(over));
    assert.equal(result.reason, reason, JSON.stringify(over));
    assert.equal(provider.calls.length, 0);
  }
});

test("thread paused review / quarantine / terminal: automation refused; operator may answer review, never quarantine", async () => {
  const review = healthyReaders({ readThreadState: async () => ({ thread_key: PHONE, status: "paused_operator_review", metadata: {} }) });
  assert.equal((await dispatchQueue(queueRow(), { readers: review })).result.reason, GATE_REASONS.THREAD_PAUSED_REVIEW);
  assert.equal((await dispatchManual({ readers: review })).result.provider_invoked, true, "an operator may answer a thread in review");
  const quarantine = healthyReaders({ readThreadState: async () => ({ thread_key: PHONE, status: "active", metadata: { incident_quarantine: true } }) });
  assert.equal((await dispatchManual({ readers: quarantine })).result.reason, GATE_REASONS.THREAD_QUARANTINED);
  const wrong = healthyReaders({ readThreadState: async () => ({ thread_key: PHONE, status: "active", contactability_status: "wrong_number", metadata: {} }) });
  assert.equal((await dispatchManual({ readers: wrong })).result.reason, `${GATE_REASONS.THREAD_TERMINAL}:wrong_number`);
  const unreadable = healthyReaders({ readThreadState: async () => { throw new Error("db"); } });
  assert.equal((await dispatchManual({ readers: unreadable })).result.reason, GATE_REASONS.THREAD_STATE_UNREADABLE);
});

test("legal and repair holds are enforced on MANUAL sends; an ownership hold stays manual-allowed", async () => {
  const legalThread = healthyReaders({ readThreadState: async () => ({ thread_key: PHONE, status: "active", paused_reason: "legal_threat_review", metadata: {} }) });
  assert.equal((await dispatchManual({ readers: legalThread })).result.reason, GATE_REASONS.LEGAL_HOLD);
  const repairThread = healthyReaders({ readThreadState: async () => ({ thread_key: PHONE, status: "active", metadata: { repair_hold: true } }) });
  assert.equal((await dispatchManual({ readers: repairThread })).result.reason, GATE_REASONS.REPAIR_HOLD);
  const legalHold = healthyReaders({ readAutomationHold: async () => ({ held: true, hold_type: "legal_hold", reason: "attorney letter" }) });
  assert.equal((await dispatchManual({ readers: legalHold })).result.reason, GATE_REASONS.LEGAL_HOLD);
  const repairHold = healthyReaders({ readAutomationHold: async () => ({ held: true, hold_type: "operator_hold", reason: "rehab_repair_reclassification" }) });
  assert.equal((await dispatchManual({ readers: repairHold })).result.reason, GATE_REASONS.REPAIR_HOLD);
  const holdUnreadable = healthyReaders({ readAutomationHold: async () => ({ held: true, hold_type: "lookup_error", fail_closed: true }) });
  assert.equal((await dispatchManual({ readers: holdUnreadable })).result.reason, GATE_REASONS.AUTOMATION_HOLD_UNREADABLE);
  const ownership = healthyReaders({ readAutomationHold: async () => ({ held: true, hold_type: "operator_hold", reason: "ownership_denial_property_unresolved" }) });
  assert.equal((await dispatchManual({ readers: ownership })).result.provider_invoked, true, "the operator resolves an ownership hold by hand");
  assert.equal((await dispatchQueue(queueRow(), { readers: ownership })).result.reason, GATE_REASONS.AUTOMATION_HOLD, "automation stays held");
});

test("quiet hours in the recipient's zone: unknown zone holds, outside the window refuses, an in-session reply may answer", async () => {
  const unknown = await dispatchQueue(queueRow(), { extra: { contact_window: { allowed: true, hold: true, timezone: null } } });
  assert.equal(unknown.result.reason, GATE_REASONS.TIMEZONE_UNKNOWN);
  const missing = await dispatchQueue(queueRow(), { extra: { contact_window: null } });
  assert.equal(missing.result.reason, GATE_REASONS.QUIET_HOURS_UNEVALUATED);
  const outside = await dispatchQueue(queueRow(), { extra: { contact_window: { allowed: false, timezone: "America/Denver" } } });
  assert.equal(outside.result.reason, GATE_REASONS.OUTSIDE_QUIET_HOURS);
  const inSession = await dispatchQueue(queueRow(), { extra: { contact_window: { allowed: false, timezone: "America/Denver" }, in_session_reply: true } });
  assert.equal(inSession.result.provider_invoked, true);
  const inSessionUnknownZone = await dispatchQueue(queueRow(), { extra: { contact_window: { allowed: true, hold: true, timezone: null }, in_session_reply: true } });
  assert.equal(inSessionUnknownZone.result.reason, GATE_REASONS.TIMEZONE_UNKNOWN, "an in-session reply never goes out on a guessed zone");
  const attended = await dispatchQueue(queueRow(), { extra: { contact_window: { allowed: false, hold: true, timezone: null }, operator_attended: true } });
  assert.equal(attended.result.provider_invoked, true, "a fresh operator-attended inbox send is judged like a manual send");
});

test("sender continuity is part of the gate and keeps its own reason for the visible hold", async () => {
  const { result, provider } = await dispatchQueue(queueRow(), { extra: { finalSenderContinuityCheck: async () => ({ ok: false, reason: "sender_continuity_mismatch" }) } });
  assert.equal(result.reason, "sender_continuity_mismatch");
  assert.equal(provider.calls.length, 0);
});

test("reauthorization holds are written as review holds that drop any copied authorization", () => {
  const patch = buildReauthorizationHoldPatch({ id: "z", queue_status: "queued", metadata: { reauthorization: { actor: "x" } } }, { trigger: "t", now: NOW, blockers: ["b"] });
  assert.equal(patch.queue_status, "paused_operator_review");
  assert.equal(patch.metadata.reauthorization, null);
  assert.deepEqual(patch.metadata.reauthorization_required.revalidation_blockers, ["b"]);
  assert.equal(isHistoricalRow({ id: "z", metadata: patch.metadata, created_at: NOW }, { now: nowMs }).historical, true);
});

test("decideFinalDispatch with no authority verdict refuses (the gate cannot be called without the brake)", () => {
  const verdict = decideFinalDispatch({ path: "queue", row: queueRow(), to: PHONE, thread_key: PHONE, claim_token: "c", facts_loaded: false, sender_continuity: { ok: true } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, GATE_REASONS.AUTHORITY_UNAVAILABLE);
});

// ── route inventory ratchet ────────────────────────────────────────────────

test("ROUTE INVENTORY: the seam has exactly two bridges, and both answer runtime authority with the shared final gate", () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js") && /executeSellerCommunicationAttempt\(/.test(fs.readFileSync(full, "utf8"))) callers.push(path.relative(SRC, full));
    }
  };
  walk(SRC);
  assert.deepEqual(callers.sort(), [
    "lib/domain/communications/canonical-communication-dispatch.js",
    "lib/domain/communications/dispatch-manual-operator-send.js",
    "lib/domain/communications/dispatch-seller-queue-row.js",
  ]);
  for (const bridge of ["lib/domain/communications/dispatch-manual-operator-send.js", "lib/domain/communications/dispatch-seller-queue-row.js"]) {
    const src = read(bridge);
    assert.match(src, /import \{ evaluateFinalDispatchGate \} from '@\/lib\/domain\/queue\/final-dispatch-gate\.js'/, bridge);
    const runtime = src.indexOf("evaluateRuntimeAuthority:");
    assert.ok(runtime > 0 && src.indexOf("evaluateFinalDispatchGate", runtime) > runtime, `${bridge}: the gate answers evaluateRuntimeAuthority`);
  }
  // The seam refuses outright when no runtime authority is wired.
  assert.match(read("lib/domain/communications/canonical-communication-dispatch.js"), /return denied\("runtime_authority", "runtime_authority_unavailable"\)/);
});

test("ROUTE INVENTORY: send_one_queue_row no longer crosses the brake with a fake control plane", () => {
  const src = read("app/api/cockpit/queue/control/route.js");
  assert.doesNotMatch(src, /if \(key === 'queue_processor_mode'\) return 'live'/);
  assert.doesNotMatch(src, /if \(key === 'queue_emergency_stop_at'\) return ''/);
  assert.match(src, /clear_one_send_window_removed/);
});

test("ROUTE INVENTORY: the internal send-now route exports no GET", () => {
  const src = read("app/api/internal/outbound/send-now/route.js");
  assert.doesNotMatch(src, /export async function GET/);
  assert.match(src, /export async function POST/);
});
