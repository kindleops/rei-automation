/**
 * P0 round 4 (2026-11-26): manual Inbox send burst controls.
 *
 * The 2026-09-24 burst at 410 Roxbury Dr: TextGrid's content filter blocked a
 * manual reply; the operator reworded and re-sent five times in 4.5 minutes,
 * each reword a NEW send_queue row. These tests pin each control:
 *
 *   1. per-thread attempt cap + cooldown that counts FAILED attempts
 *   2. content-filter lock until a person explicitly clears it
 *   3. duplicate guard: fail closed, failed rows included, per thread, similar bodies
 *   4. repeated-failure suppression counts failed_transport + content filter
 *   5. operator identity on every manual row
 *   + the 6-attempt reword burst through the real manual path: only the first
 *     attempt reaches the provider.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  createInboxSendNowQueueRow,
  executeManualInboxSendNow,
  manualSendOperatorIdentity,
  repeatedFailureKindOf,
  shouldSuppressRecentDeliveryFailuresReconciled,
} from "@/lib/domain/inbox/send-now-service.js";
import {
  MANUAL_BURST_CONTROL_KEYS,
  MANUAL_BURST_DEFAULTS,
  MANUAL_BURST_REASONS,
  OPERATOR_SEND_MARKER,
  bodySimilarity,
  buildContentFilterLockClearance,
  contentFilterDispatchRefusal,
  contentFilterLockOf,
  evaluateManualSendBurst,
  isAttemptRow,
  isContentFilterFailureRow,
  loadManualBurstConfig,
  readThreadSendHistory,
  runManualSendBurstGuard,
} from "@/lib/domain/inbox/manual-send-burst-guard.js";
import {
  GATE_REASONS,
  __setFinalDispatchGateModeForTests,
  evaluateFinalDispatchGate,
} from "@/lib/domain/queue/final-dispatch-gate.js";
import { handleInternalInboxSendNow } from "@/lib/domain/inbox/internal-send-now-handler.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drainPostSendProjections } from "@/lib/domain/inbox/post-send-projection.js";
import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";

const THREAD = "+15005550006";
const FROM_88 = "+15005550088";
const FROM_70 = "+15005550070";
const NOW = "2026-11-26T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const minutesAgo = (m) => new Date(NOW_MS - m * 60 * 1000).toISOString();

const OPERATOR = Object.freeze({
  kind: "ops_dashboard_operator",
  authenticated: true,
  auth_source: "ops_dashboard_session",
  via: "header:x-ops-dashboard-secret",
  id: "22222222-2222-4222-8222-222222222222",
  email: "operator@example.test",
});

const MANUAL_ENABLED = Object.freeze({
  queue_emergency_stop_at: "2026-11-24T10:39:00.000Z",
  queue_processor_mode: "off",
  queue_execution_mode: "stopped",
  manual_send_mode: "enabled",
  global_send_shutdown_at: null,
});

const controlPlane = (values = {}) => async (key) => (key in values ? values[key] : null);

afterEach(async () => {
  __setFinalDispatchGateModeForTests(null);
  await drainPostSendProjections();
});

// ── an in-memory supabase that understands the reads this path makes ─────────

function parseOrFilter(filter) {
  // "thread_key.eq.\"+1500\",to_phone_number.eq.\"+1500\""
  const parts = String(filter).match(/[a-z0-9_]+\.eq\.("(?:[^"]|"")*"|[^,]+)/g) || [];
  return parts.map((p) => {
    const [col, , ...rest] = p.split(".");
    let val = rest.join(".");
    if (val.startsWith('"')) val = val.slice(1, -1).replaceAll('""', '"');
    return (row) => String(row?.[col] ?? "") === val;
  });
}

function makeFakeSupabase({ send_queue = [], message_events = [], extra_tables = {}, send_queue_error = null, send_queue_throws = false } = {}) {
  const tables = {
    send_queue: send_queue.map((r) => ({ ...r })),
    message_events: message_events.map((r) => ({ ...r })),
    ...Object.fromEntries(Object.entries(extra_tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))])),
  };
  const calls = { send_queue_reads: [], updates: 0 };

  function builder(table) {
    const st = { op: "select", filters: [], ors: null, order: null, limit: null, patch: null, inArgs: [] };
    const run = () => {
      if (table === "send_queue" && st.op === "select" && send_queue_throws) throw new Error("db_down");
      if (table === "send_queue" && st.op === "select" && send_queue_error) return { data: null, error: send_queue_error };
      const source = tables[table];
      if (!source) return { data: [], error: null, count: 0 };
      let rows = source.filter((r) => st.filters.every((f) => f(r)));
      if (st.ors) rows = rows.filter((r) => st.ors.some((f) => f(r)));
      if (st.op === "update") {
        calls.updates += 1;
        for (const r of rows) {
          const metadata = st.patch.metadata ? { ...(r.metadata || {}), ...st.patch.metadata } : r.metadata;
          Object.assign(r, st.patch, { metadata });
        }
        return { data: rows, error: null };
      }
      if (st.order) {
        const { col, asc } = st.order;
        rows = [...rows].sort((a, b) => (asc ? 1 : -1) * String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
      }
      if (st.limit != null) rows = rows.slice(0, st.limit);
      return { data: rows.map((r) => ({ ...r })), error: null, count: rows.length };
    };
    const b = {
      select() { if (table === "send_queue" && st.op === "select") calls.send_queue_reads.push(st); return b; },
      update(patch) { st.op = "update"; st.patch = patch; return b; },
      eq(col, val) { st.filters.push((r) => String(r?.[col] ?? "") === String(val)); return b; },
      in(col, vals) { st.inArgs.push({ col, vals }); st.filters.push((r) => vals.includes(r?.[col])); return b; },
      gte(col, val) { st.filters.push((r) => String(r?.[col] ?? "") >= String(val)); return b; },
      gt(col, val) { st.filters.push((r) => String(r?.[col] ?? "") > String(val)); return b; },
      or(filter) {
        // message_events delivery filter: delivery_status.eq.delivered,delivered_at.not.is.null
        if (String(filter).includes("delivered_at.not.is.null")) {
          st.filters.push((r) => r?.delivery_status === "delivered" || Boolean(r?.delivered_at));
          return b;
        }
        st.ors = parseOrFilter(filter);
        return b;
      },
      not() { return b; },
      contains() { return b; },
      // Honoured, not ignored: the send-time 21610 blacklist check is
      // `failed_reason ILIKE '%21610%'`, and ignoring it made every failed row
      // read as a carrier blacklist.
      ilike(col, pattern) {
        const re = new RegExp(`^${String(pattern).split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
        st.filters.push((r) => re.test(String(r?.[col] ?? "")));
        return b;
      },
      order(col, opts = {}) { st.order = { col, asc: opts.ascending !== false }; return b; },
      limit(n) { st.limit = n; return b; },
      maybeSingle: async () => {
        const r = run();
        if (r.error) return r;
        return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: null };
      },
      single: async () => b.maybeSingle(),
      then(resolve, reject) {
        try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    // Any other PostgREST filter (neq, is, lte, ...) is accepted and ignored.
    const proxy = new Proxy(b, {
      get(target, prop) {
        if (prop in target) {
          const v = target[prop];
          return typeof v === "function" && prop !== "then" && prop !== "maybeSingle" && prop !== "single"
            ? (...args) => { v(...args); return proxy; }
            : v;
        }
        if (typeof prop === "symbol") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return { tables, calls, from: (table) => builder(table) };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ATTEMPT CAP + COOLDOWN (failed attempts count)
// ═════════════════════════════════════════════════════════════════════════════

test("1a. config: defaults are 2 attempts / 10 minutes; out-of-range or unreadable values fall back to the strict default", async () => {
  assert.deepEqual(await loadManualBurstConfig({}), { ...MANUAL_BURST_DEFAULTS });
  assert.deepEqual(await loadManualBurstConfig({ getSystemValue: async () => { throw new Error("down"); } }), { ...MANUAL_BURST_DEFAULTS });
  const loose = await loadManualBurstConfig({
    getSystemValue: controlPlane({
      [MANUAL_BURST_CONTROL_KEYS.ATTEMPT_CAP]: "0",
      [MANUAL_BURST_CONTROL_KEYS.ATTEMPT_WINDOW_MINUTES]: "abc",
      [MANUAL_BURST_CONTROL_KEYS.DUPLICATE_WINDOW_MINUTES]: "99999",
    }),
  });
  assert.deepEqual(loose, { ...MANUAL_BURST_DEFAULTS }, "a typo cannot switch the brake off");
  const tuned = await loadManualBurstConfig({
    getSystemValue: controlPlane({
      [MANUAL_BURST_CONTROL_KEYS.ATTEMPT_CAP]: "3",
      [MANUAL_BURST_CONTROL_KEYS.ATTEMPT_WINDOW_MINUTES]: "15",
      [MANUAL_BURST_CONTROL_KEYS.DUPLICATE_WINDOW_MINUTES]: "60",
    }),
  });
  assert.deepEqual(tuned, { attempt_cap: 3, attempt_window_minutes: 15, duplicate_window_minutes: 60 });
});

test("1b. two FAILED attempts in 10 minutes stop the third, with the reason and when it lifts", () => {
  const rows = [
    { id: "a", thread_key: THREAD, queue_status: "failed", message_body: "first wording of the offer text", created_at: minutesAgo(6) },
    { id: "b", thread_key: THREAD, queue_status: "failed_transport", message_body: "something entirely different here now", created_at: minutesAgo(2) },
  ];
  const v = evaluateManualSendBurst({ rows, message_body: "a third unrelated message body text", now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, MANUAL_BURST_REASONS.ATTEMPT_CAP);
  assert.equal(v.hard_block, true);
  assert.equal(v.attempt_cap.counted_attempts, 2);
  assert.equal(v.attempt_cap.counted_failed_or_in_flight, 2);
  assert.equal(v.attempt_cap.retry_after, new Date(Date.parse(minutesAgo(6)) + 10 * 60 * 1000).toISOString());
  assert.match(v.detail_reason, /failed attempts count/);
  assert.match(v.detail_reason, /stopped until/);
});

test("1c. one attempt in the window, or attempts older than the window, do not stop a send", () => {
  const one = [{ id: "a", queue_status: "sent", message_body: "hello there how are you today friend", created_at: minutesAgo(3) }];
  assert.equal(evaluateManualSendBurst({ rows: one, message_body: "totally new words entirely in this one", now: NOW }).ok, true);
  const old = [
    { id: "a", queue_status: "failed", message_body: "x1 y1 z1 w1", created_at: minutesAgo(45) },
    { id: "b", queue_status: "sent", message_body: "x2 y2 z2 w2", created_at: minutesAgo(31) },
  ];
  assert.equal(evaluateManualSendBurst({ rows: old, message_body: "totally new words entirely in this one", now: NOW }).ok, true);
});

test("1d. what counts as an attempt: failures and in-flight MANUAL rows yes; cancelled, validation-paused and parked automation no", () => {
  for (const status of ["sent", "delivered", "failed", "failed_transport", "undelivered", "processing"]) {
    assert.equal(isAttemptRow({ queue_status: status }), true, status);
  }
  assert.equal(isAttemptRow({ queue_status: "queued", metadata: { manual_operator_send: true } }), true);
  assert.equal(isAttemptRow({ queue_status: "queued", metadata: {} }), false);
  // Review task_e46cf83a: a queued / scheduled queue-reply, auto-reply or
  // schedule-reply row (any operator path) counts too.
  assert.equal(isAttemptRow({ queue_status: "queued", metadata: { [OPERATOR_SEND_MARKER]: true } }), true);
  assert.equal(isAttemptRow({ queue_status: "scheduled", metadata: { [OPERATOR_SEND_MARKER]: true } }), true);
  assert.equal(isAttemptRow({ queue_status: "scheduled", metadata: {} }), false);
  assert.equal(isAttemptRow({ queue_status: "cancelled" }), false);
  assert.equal(isAttemptRow({ queue_status: "paused_invalid_queue_row" }), false);
  // A content-filtered row counts whatever status a later rotation gave it.
  assert.equal(isAttemptRow({ queue_status: "queued", metadata: { failure_class: "content_filter_blocked" } }), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. CONTENT-FILTER LOCK
// ═════════════════════════════════════════════════════════════════════════════

test("2a. a content-filter failure is recognised wherever it was recorded", () => {
  assert.equal(isContentFilterFailureRow({ metadata: { failure_class: "content_filter_blocked" } }), true);
  assert.equal(isContentFilterFailureRow({ metadata: { provider_error: { failure_class: "content_filter_blocked" } } }), true);
  assert.equal(isContentFilterFailureRow({ metadata: { normalized_reason: "blocked_by_textgrid_content_filter" } }), true);
  assert.equal(isContentFilterFailureRow({ failed_reason: "Blocked by TextGrid content filter" }), true);
  assert.equal(isContentFilterFailureRow({ queue_status: "failed", failed_reason: "timeout" }), false);
});

test("2b. a content-filter block locks the thread (any sender, any age) and tells the operator a person must clear it", () => {
  const rows = [
    { id: "cf1", thread_key: THREAD, from_phone_number: FROM_88, queue_status: "failed", message_body: "original text of the reply", created_at: "2026-11-20T00:00:00.000Z", metadata: { failure_class: "content_filter_blocked" } },
  ];
  const v = evaluateManualSendBurst({ rows, message_body: "completely reworded attempt number two", now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED);
  assert.equal(v.clearance_required, true);
  assert.equal(v.content_filter_lock.blocked_row_id, "cf1");
  assert.equal(v.content_filter_lock.blocked_from_phone_number, FROM_88);
  assert.match(v.detail_reason, /content filter/);
  assert.match(v.detail_reason, /rewording and resending is not allowed/);
  assert.match(v.detail_reason, /•••88/);
});

test("2c. clearance: needs a server-identified operator and a reason; a body-named actor is not one", () => {
  assert.deepEqual(buildContentFilterLockClearance({}), { requested: false });
  const no_actor = buildContentFilterLockClearance({ content_filter_lock_clearance: { reason: "reviewed, safe wording now", actor: "someone" } }, { operator: null });
  assert.equal(no_actor.ok, false);
  assert.equal(no_actor.reason, MANUAL_BURST_REASONS.CLEARANCE_INVALID);
  const short = buildContentFilterLockClearance({ content_filter_lock_clearance: { reason: "ok" } }, { operator: OPERATOR });
  assert.equal(short.ok, false);
  const good = buildContentFilterLockClearance({ content_filter_lock_clearance: { reason: "Reviewed the thread; plain wording, no link." } }, { operator: OPERATOR, now: NOW });
  assert.equal(good.ok, true);
  assert.equal(good.clearance.actor, OPERATOR.id);
  assert.equal(good.clearance.cleared_at, NOW);
  // The internal route's server-stamped actor (x-ops-user-id) also identifies a person.
  const stamped = buildContentFilterLockClearance({ content_filter_lock_clearance: { reason: "Reviewed the thread; plain wording." } }, { server_actor: "ops-user-7" });
  assert.equal(stamped.ok, true);
  assert.equal(stamped.clearance.actor, "ops-user-7");
});

test("2d. a valid clearance lifts the lock for this send only; a later clearance row unlocks; a block after the clearance locks again", () => {
  const blocked = { id: "cf1", queue_status: "failed", message_body: "aaa bbb ccc ddd", created_at: minutesAgo(60), metadata: { failure_class: "content_filter_blocked" } };
  const clearance = buildContentFilterLockClearance({ content_filter_lock_clearance: { reason: "Reviewed the thread; plain wording." } }, { operator: OPERATOR, now: NOW });
  const v = evaluateManualSendBurst({ rows: [blocked], message_body: "new plain wording for the seller here", clearance, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.content_filter_lock_cleared, true);

  const cleared_row = { id: "c1", queue_status: "sent", message_body: "eee fff ggg hhh", created_at: minutesAgo(30), metadata: { content_filter_lock_clearance: { actor: OPERATOR.id, cleared_at: minutesAgo(30) } } };
  assert.equal(contentFilterLockOf([blocked, cleared_row]).locked, false);

  const reblocked = { ...cleared_row, metadata: { ...cleared_row.metadata, failure_class: "content_filter_blocked" } };
  assert.equal(contentFilterLockOf([blocked, reblocked]).locked, true, "a cleared send that is blocked again locks again");
});

test("2e. an invalid clearance on a locked thread is refused with the clearance reason", () => {
  const blocked = { id: "cf1", queue_status: "failed", created_at: minutesAgo(5), metadata: { failure_class: "content_filter_blocked" } };
  const clearance = buildContentFilterLockClearance({ content_filter_lock_clearance: { reason: "x" } }, { operator: OPERATOR });
  const v = evaluateManualSendBurst({ rows: [blocked], message_body: "anything new to say here today", clearance, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, MANUAL_BURST_REASONS.CLEARANCE_INVALID);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. DUPLICATE GUARD
// ═════════════════════════════════════════════════════════════════════════════

test("3a. similar body to a FAILED attempt on the thread in the window is a duplicate (also for non-manual rows)", () => {
  const rows = [{ id: "f1", queue_status: "failed", message_body: "Hi John, would you take $50k cash for the house?", created_at: minutesAgo(20) }];
  const v = evaluateManualSendBurst({ rows, message_body: "Hi John - would you take $50k cash for your house??", now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, MANUAL_BURST_REASONS.DUPLICATE);
  assert.equal(v.duplicate.matched_row_id, "f1");
  assert.equal(v.duplicate.matched_status, "failed");
});

test("3a-2. no argument switches the lock or the cap off: an old caller's immediate_manual:false is ignored (review task_e46cf83a)", () => {
  const blocked = [{ id: "cf1", queue_status: "failed", message_body: "original text of the reply here", created_at: minutesAgo(30), metadata: { failure_class: "content_filter_blocked" } }];
  const locked = evaluateManualSendBurst({ rows: blocked, message_body: "a reworded attempt that is different", immediate_manual: false, now: NOW });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED);
  const two = [
    { id: "a", queue_status: "failed", message_body: "first wording of the offer text", created_at: minutesAgo(6) },
    { id: "b", queue_status: "queued", message_body: "something entirely different here now", created_at: minutesAgo(2), metadata: { [OPERATOR_SEND_MARKER]: true } },
  ];
  const capped = evaluateManualSendBurst({ rows: two, message_body: "a third unrelated message body text", immediate_manual: false, now: NOW });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, MANUAL_BURST_REASONS.ATTEMPT_CAP);
});

test("3b. similarity: exact after normalization is 1; short bodies match only exactly; unrelated bodies do not match", () => {
  assert.equal(bodySimilarity("Hello,  John!", "hello john"), 1);
  assert.equal(bodySimilarity("ok thanks", "ok thanks john"), 0);
  assert.ok(bodySimilarity("would you take fifty thousand cash", "would you consider fifty thousand cash") >= 0.6);
  assert.ok(bodySimilarity("what is the condition of the roof", "can we schedule a walkthrough tuesday") < 0.6);
  const rows = [{ id: "s1", queue_status: "sent", message_body: "What is the condition of the roof?", created_at: minutesAgo(2) }];
  assert.equal(evaluateManualSendBurst({ rows, message_body: "Can we schedule a walkthrough Tuesday afternoon?", now: NOW }).ok, true);
});

test("3c. history read: an error, a throw (live) or a non-list (live) is unreadable; the guard then refuses", async () => {
  const err = await readThreadSendHistory({ supabase: makeFakeSupabase({ send_queue_error: { message: "permission denied" } }), thread_key: THREAD, to_phone_number: THREAD });
  assert.equal(err.ok, false);
  const threw = await readThreadSendHistory({ supabase: makeFakeSupabase({ send_queue_throws: true }), thread_key: THREAD, to_phone_number: THREAD, live_reads: true });
  assert.equal(threw.ok, false);
  const not_list = await readThreadSendHistory({
    supabase: { from: () => ({ select: () => ({ or: () => ({ order: () => ({ limit: async () => ({ data: null, error: null }) }) }) }) }) },
    thread_key: THREAD, to_phone_number: THREAD, live_reads: true,
  });
  assert.equal(not_list.ok, false);
  const missing = await readThreadSendHistory({ supabase: null, thread_key: THREAD });
  assert.equal(missing.ok, false);

  const verdict = await runManualSendBurstGuard(
    { thread_key: THREAD, to_phone_number: THREAD, message_body: "hello there", now: NOW },
    { supabase: makeFakeSupabase({ send_queue_error: { message: "timeout" } }) }
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, MANUAL_BURST_REASONS.HISTORY_UNREADABLE);
  assert.equal(verdict.hard_block, true);
});

test("3d. the history read covers the thread key AND the recipient phone", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [
      { id: "other-key", thread_key: "legacy-thread-key", to_phone_number: THREAD, queue_status: "failed", created_at: minutesAgo(1) },
      { id: "unrelated", thread_key: "+15005550999", to_phone_number: "+15005550999", queue_status: "sent", created_at: minutesAgo(1) },
    ],
  });
  const read = await readThreadSendHistory({ supabase, thread_key: THREAD, to_phone_number: THREAD });
  assert.equal(read.ok, true);
  assert.deepEqual(read.rows.map((r) => r.id), ["other-key"]);
});

// ═════════════════════════════════════════════════════════════════════════════
// createInboxSendNowQueueRow wiring
// ═════════════════════════════════════════════════════════════════════════════

const ACTIVE_FLEET_SENDER = async (phone) => ({ id: "fleet", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 });

function rowDeps(supabase, extra = {}) {
  const inserted = [];
  return {
    inserted,
    deps: {
      supabase,
      getSystemValue: controlPlane({}),
      loadOutboundNumberByPhone: ACTIVE_FLEET_SENDER,
      resolveStickyThreadSenderImpl: async ({ proposed_from }) => ({ ok: true, phone: proposed_from, decision: "kept" }),
      hardComplianceCheckImpl: async () => ({ blocked: false }),
      canSendImpl: async () => ({ ok: true, reason: null }),
      checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
      recentDeliveryFailuresImpl: async () => ({ suppress: false }),
      manualOfferGuardImpl: async () => ({ mode: "off", decision: "off", record: null }),
      resolveOperatorAction: async () => ({ ok: true, operator_action_id: "opact-row" }),
      insertImpl: async (payload) => {
        inserted.push(payload);
        const row = { id: `row-${inserted.length}`, created_at: new Date().toISOString(), ...payload };
        supabase.tables?.send_queue?.push(row);
        return { ok: true, queue_row_id: row.id, queue_id: row.id, raw: { ...row } };
      },
      ...extra,
    },
  };
}

const SEND = Object.freeze({
  thread_key: THREAD,
  to_phone_number: THREAD,
  from_phone_number: FROM_88,
  message_body: "Hi there, are you still open to an offer on the property?",
  source: "inbox",
  action: "send_now",
});

test("3e. createInboxSendNowQueueRow: an unreadable history refuses BEFORE any row (the old guard proceeded)", async () => {
  const supabase = makeFakeSupabase({ send_queue_error: { message: "statement timeout" } });
  const h = rowDeps(supabase);
  const r = await createInboxSendNowQueueRow({ ...SEND }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, MANUAL_BURST_REASONS.HISTORY_UNREADABLE);
  assert.equal(r.queue_inserted, false);
  assert.equal(h.inserted.length, 0);

  // A THROWN read refuses too wherever live reads apply (production always).
  __setFinalDispatchGateModeForTests("enforce");
  const h2 = rowDeps(makeFakeSupabase({ send_queue_throws: true }));
  const r2 = await createInboxSendNowQueueRow({ ...SEND }, h2.deps);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, MANUAL_BURST_REASONS.HISTORY_UNREADABLE);
  assert.equal(h2.inserted.length, 0);
});

test("3f. createInboxSendNowQueueRow: a near-identical resend after a FAILED attempt is a duplicate", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [{ id: "f1", thread_key: THREAD, to_phone_number: THREAD, queue_status: "failed", message_body: SEND.message_body, created_at: new Date(Date.now() - 60 * 1000).toISOString() }],
  });
  const h = rowDeps(supabase);
  const r = await createInboxSendNowQueueRow({ ...SEND, message_body: "Hi there - are you still open to an offer on the property??" }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate_blocked");
  assert.equal(h.inserted.length, 0);
});

test("3g. a forged clearance or operator identity in the caller's metadata never reaches the row", async () => {
  const supabase = makeFakeSupabase();
  const h = rowDeps(supabase);
  const r = await createInboxSendNowQueueRow(
    {
      ...SEND,
      metadata: {
        content_filter_lock_clearance: { actor: "forged", cleared_at: new Date().toISOString() },
        operator_id: "forged-operator",
        manual_send_operator: { id: "forged-operator" },
      },
    },
    { ...h.deps, operator: OPERATOR }
  );
  assert.equal(r.ok, true, r.reason);
  const md = h.inserted[0].metadata;
  assert.equal("content_filter_lock_clearance" in md, false);
  assert.equal(md.operator_id, OPERATOR.id);
  assert.equal(md.manual_send_operator.id, OPERATOR.id);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. REPEATED-FAILURE SUPPRESSION
// ═════════════════════════════════════════════════════════════════════════════

test("4a. failure kinds: content filter and failed_transport count; non-delivery refusals do not", () => {
  assert.equal(repeatedFailureKindOf({ queue_status: "failed", metadata: { failure_class: "content_filter_blocked" } }), "content_filter");
  assert.equal(repeatedFailureKindOf({ queue_status: "failed_transport", failed_reason: "anything" }), "transport");
  assert.equal(repeatedFailureKindOf({ queue_status: "failed", failed_reason: "delivery_failed" }), "delivery_failed");
  assert.equal(repeatedFailureKindOf({ queue_status: "failed", failed_reason: "network timeout" }), "transport");
  assert.equal(repeatedFailureKindOf({ queue_status: "failed", failed_reason: "invalid_payload" }), null);
});

test("4b. two failed_transport / content-filter failures on the pair in 24h suppress (they were never read before)", async () => {
  const now = new Date().toISOString();
  const ago = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
  const supabase = makeFakeSupabase({
    send_queue: [
      { id: "t1", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "failed_transport", failed_reason: "Undelivered", provider_message_id: "SM1", created_at: ago(30), updated_at: ago(29) },
      { id: "c1", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "failed", failed_reason: "Blocked by TextGrid content filter", provider_message_id: "SM2", metadata: { failure_class: "content_filter_blocked" }, created_at: ago(10), updated_at: ago(9) },
    ],
  });
  const r = await shouldSuppressRecentDeliveryFailuresReconciled({ thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, supabase, now });
  assert.equal(r.suppress, true);
  assert.equal(r.reason, "repeated_delivery_failed_same_pair");
  assert.equal(r.pair_count, 2);
  assert.deepEqual(r.failure_kinds, { transport: 1, content_filter: 1 });
  const status_filter = supabase.calls.send_queue_reads[0].inArgs.find((a) => a.col === "queue_status");
  assert.ok(status_filter.vals.includes("failed_transport"));
  assert.ok(status_filter.vals.includes("failed"));
});

test("4c. a delivery or an inbound reply AFTER the failure clears it; one from BEFORE does not", async () => {
  const ago = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
  const failures = [
    { id: "t1", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "failed_transport", created_at: ago(30), updated_at: ago(29) },
    { id: "t2", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "failed_transport", created_at: ago(20), updated_at: ago(19) },
  ];
  const before = makeFakeSupabase({ send_queue: failures, message_events: [{ id: "e0", thread_key: THREAD, direction: "outbound", delivery_status: "delivered", created_at: ago(500) }] });
  assert.equal((await shouldSuppressRecentDeliveryFailuresReconciled({ thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, supabase: before })).suppress, true);
  const after = makeFakeSupabase({ send_queue: failures, message_events: [{ id: "e1", thread_key: THREAD, direction: "inbound", created_at: ago(1) }] });
  assert.equal((await shouldSuppressRecentDeliveryFailuresReconciled({ thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, supabase: after })).suppress, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. OPERATOR IDENTITY
// ═════════════════════════════════════════════════════════════════════════════

test("5a. identity comes from the server principal, else the route-stamped actor; never from the body", () => {
  assert.equal(manualSendOperatorIdentity(OPERATOR, {}).id, OPERATOR.id);
  assert.equal(manualSendOperatorIdentity(OPERATOR, {}).source, "server_operator_principal");
  assert.equal(manualSendOperatorIdentity(null, { repeat_ask_override_actor: "ops-user-7" }).id, "ops-user-7");
  const none = manualSendOperatorIdentity(null, { operator_email: "body@example.test", operator_id: "body" });
  assert.equal(none.id, null);
  assert.equal(none.source, "none");
  assert.equal(manualSendOperatorIdentity({ ...OPERATOR, authenticated: false }, {}).id, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// THE 2026-09-24 BURST through the real manual path
// ═════════════════════════════════════════════════════════════════════════════

function burstHarness({ provider, fake = {} }) {
  const supabase = makeFakeSupabase(fake);
  const provider_calls = [];
  let action_n = 0;
  const h = rowDeps(supabase);
  const deps = {
    ...h.deps,
    getSystemValue: controlPlane(MANUAL_ENABLED),
    operator: OPERATOR,
    store: createMemoryS11Store(),
    resolveOperatorAction: async () => ({ ok: true, operator_action_id: `opact-burst-${++action_n}`, reused: false }),
    sendTextgridImpl: async (args) => {
      provider_calls.push(args);
      return provider(provider_calls.length, args);
    },
    finalizeSendQueueSuccessImpl: async (row) => {
      const stored = supabase.tables.send_queue.find((r) => r.id === row.id);
      Object.assign(stored, { queue_status: "sent", sent_at: new Date().toISOString() });
      return { ...stored };
    },
    // What finalizeSendQueueFailure records for a TextGrid content-filter block.
    finalizeSendQueueFailureImpl: async (row) => {
      const stored = supabase.tables.send_queue.find((r) => r.id === row.id);
      Object.assign(stored, {
        queue_status: "failed",
        failed_reason: "Blocked by TextGrid content filter",
        metadata: { ...(stored.metadata || {}), failure_class: "content_filter_blocked", retry_allowed: false, provider_error: { failure_class: "content_filter_blocked" } },
      });
      return { ...stored };
    },
    writeOutboundSuccessMessageEventImpl: async () => ({ id: "evt" }),
    writeOutboundFailureMessageEventImpl: async () => null,
    promoteFirstContactOnProviderAcceptance: async () => ({ ok: true, promoted: false }),
  };
  return { supabase, deps, inserted: h.inserted, provider_calls };
}

const REWORDS = [
  "Hi Maria, I can pay cash and close fast. Can I send you a written offer today?",
  "Maria - we buy as-is for cash, quick close. OK to send an offer over?",
  "Hello Maria, would a cash offer with a fast closing work for you?",
  "Maria, cash purchase, any condition, close on your timeline. Want the number?",
  "Hi Maria! Quick question: open to hearing a cash number for the house?",
  "Maria, last try: can I text you our cash offer?",
];

test("BURST: a 6-attempt reword burst after a content-filter block -- only the first attempt reaches the provider", async () => {
  const h = burstHarness({
    provider: () => ({ ok: false, failure_class: "content_filter_blocked", error: "Blocked by TextGrid content filter", sid: "SMfiltered" }),
  });
  const results = [];
  for (const body of REWORDS) {
    results.push(await executeManualInboxSendNow({ ...SEND, message_body: body, client_send_id: `click-${results.length}` }, h.deps));
  }

  assert.equal(h.provider_calls.length, 1, "only the first attempt reaches TextGrid");
  assert.equal(h.inserted.length, 1, "refused rewords create no send_queue row");

  // Attempt 1: the operator is told the message was filtered and the thread is now locked.
  assert.equal(results[0].ok, false);
  assert.equal(results[0].reason, "content_filter_blocked");
  assert.equal(results[0].hard_block, true);
  assert.equal(results[0].operator_override_allowed, false);
  assert.match(results[0].detail_reason, /locked/);

  // Attempts 2-6: refused before any row, with the lock reason.
  for (const r of results.slice(1)) {
    assert.equal(r.ok, false);
    assert.equal(r.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED);
    assert.equal(r.hard_block, true);
    assert.equal(r.queue_inserted, false);
    assert.equal(r.manual_send_burst.clearance_required, true);
    assert.match(r.detail_reason, /A person must review the thread/);
  }

  // Item 5: the one row records who pressed Send.
  const row = h.supabase.tables.send_queue[0];
  assert.equal(row.metadata.operator_id, OPERATOR.id);
  assert.equal(row.metadata.manual_send_operator.source, "server_operator_principal");
});

test("BURST: a sender change (…88 -> …70, nationwide fallback) does not get round the lock", async () => {
  const h = burstHarness({ provider: () => ({ ok: false, failure_class: "content_filter_blocked", error: "Blocked by TextGrid content filter" }) });
  await executeManualInboxSendNow({ ...SEND, message_body: REWORDS[0] }, h.deps);
  const r = await executeManualInboxSendNow({ ...SEND, from_phone_number: FROM_70, message_body: REWORDS[1] }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED);
  assert.equal(h.provider_calls.length, 1);
});

test("BURST: after a person clears the lock (with a reason) one new send goes out and the clearance is on the row", async () => {
  let n = 0;
  const h = burstHarness({
    provider: () => (++n === 1
      ? { ok: false, failure_class: "content_filter_blocked", error: "Blocked by TextGrid content filter" }
      : { ok: true, sid: "SMcleared", provider_message_id: "SMcleared" }),
  });
  await executeManualInboxSendNow({ ...SEND, message_body: REWORDS[0] }, h.deps);
  const cleared = await executeManualInboxSendNow(
    { ...SEND, message_body: REWORDS[3], content_filter_lock_clearance: { reason: "Reviewed: removed the word cash, plain question." } },
    h.deps
  );
  assert.equal(cleared.ok, true, `${cleared.reason}: ${cleared.detail_reason}`);
  assert.equal(h.provider_calls.length, 2);
  const row = h.supabase.tables.send_queue[1];
  assert.equal(row.metadata.content_filter_lock_clearance.actor, OPERATOR.id);
  assert.equal(row.metadata.content_filter_lock_clearance.cleared_lock.blocked_row_id, "row-1");

  // The cap still applies after a clearance: 2 attempts in 10 minutes, the third stops.
  const third = await executeManualInboxSendNow(
    { ...SEND, message_body: REWORDS[5], content_filter_lock_clearance: { reason: "Reviewed again, still plain wording." } },
    h.deps
  );
  assert.equal(third.ok, false);
  assert.equal(third.reason, MANUAL_BURST_REASONS.ATTEMPT_CAP);
  assert.equal(h.provider_calls.length, 2);
});

// ── POLICY (founder 2026-11-26): a clearance authorizes ONE send through the
// content-filter lock and through the repeated-failure suppression those same
// failures caused. It never bypasses DNC / opt-out / sms_suppression_list /
// carrier blacklist / eligibility / duplicate / any other compliance block.

const FILTERED = () => ({ ok: false, failure_class: "content_filter_blocked", error: "Blocked by TextGrid content filter" });
const CLEARANCE = Object.freeze({ reason: "Reviewed: removed the word cash, plain question." });

test("CLEARANCE: the repeated-failure suppression caused by the content-filter failures does not stop the cleared send", async () => {
  // Locked thread (content-filter block 5 min ago) + a 4b verdict made of
  // content-filter / transport failures on the same pair.
  const blocked_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const supabase = makeFakeSupabase({
    send_queue: [{ id: "cf1", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "failed", message_body: REWORDS[0], created_at: blocked_at, metadata: { failure_class: "content_filter_blocked" } }],
  });
  const h = rowDeps(supabase, {
    recentDeliveryFailuresImpl: async () => ({ suppress: true, reason: "repeated_delivery_failed_same_pair", pair_count: 2, window: "24h", failure_kinds: { content_filter: 1, transport: 1 } }),
  });
  const r = await createInboxSendNowQueueRow({ ...SEND, message_body: REWORDS[3], content_filter_lock_clearance: CLEARANCE }, { ...h.deps, operator: OPERATOR });
  assert.equal(r.ok, true, `${r.reason}: ${r.detail_reason}`);
  assert.equal(h.inserted.length, 1);
  assert.deepEqual(r.warning_codes, ["recent_delivery_failures"], "recorded on the row, not a block");
  assert.equal(h.inserted[0].metadata.content_filter_lock_clearance.actor, OPERATOR.id);

  // Without the clearance the same thread is still locked.
  const h2 = rowDeps(makeFakeSupabase({ send_queue: supabase.tables.send_queue.filter((x) => x.id === "cf1") }));
  const locked = await createInboxSendNowQueueRow({ ...SEND, message_body: REWORDS[3] }, { ...h2.deps, operator: OPERATOR });
  assert.equal(locked.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED);
});

test("CLEARANCE: a cleared thread whose number is on the suppression list (opt-out) is still blocked, at enqueue AND at send time", async () => {
  const opt_out = { id: "sup-1", phone_number: THREAD, phone_e164: THREAD, is_active: true, suppression_reason: "opt_out", suppression_type: "stop" };

  // Enqueue: the real hard compliance check (not stubbed) refuses before any row.
  const h = burstHarness({ provider: FILTERED, fake: { extra_tables: { sms_suppression_list: [] } } });
  await executeManualInboxSendNow({ ...SEND, message_body: REWORDS[0] }, h.deps);
  assert.equal(h.provider_calls.length, 1);
  h.supabase.tables.sms_suppression_list.push(opt_out); // the seller opts out after the block
  const enqueue = await executeManualInboxSendNow(
    { ...SEND, message_body: REWORDS[3], content_filter_lock_clearance: CLEARANCE },
    { ...h.deps, hardComplianceCheckImpl: undefined }
  );
  assert.equal(enqueue.ok, false);
  assert.equal(enqueue.reason, "compliance_blocked");
  assert.equal(enqueue.detail_reason, "compliance_suppression_list");
  assert.equal(h.provider_calls.length, 1, "the clearance does not reach the provider");
  assert.equal(h.supabase.tables.send_queue.length, 1, "no row for the refused send");

  // Send time: enqueue check stubbed open, the send-time contactability check still refuses.
  const h2 = burstHarness({ provider: FILTERED, fake: { extra_tables: { sms_suppression_list: [] } } });
  await executeManualInboxSendNow({ ...SEND, message_body: REWORDS[0] }, h2.deps);
  h2.supabase.tables.sms_suppression_list.push(opt_out);
  const at_send = await executeManualInboxSendNow({ ...SEND, message_body: REWORDS[3], content_filter_lock_clearance: CLEARANCE }, h2.deps);
  assert.equal(at_send.ok, false);
  assert.equal(at_send.reason, "compliance_blocked_at_send_time");
  assert.equal(h2.provider_calls.length, 1);
});

test("CLEARANCE: a real carrier blacklist (21610) on the pair still blocks the cleared send", async () => {
  const h = burstHarness({ provider: FILTERED });
  await executeManualInboxSendNow({ ...SEND, message_body: REWORDS[0] }, h.deps);
  assert.equal(h.provider_calls.length, 1);
  // The carrier reports the pair blacklisted (an older attempt, outside the cap window).
  h.supabase.tables.send_queue.push({
    id: "bl1", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "failed",
    failed_reason: "Error 21610: attempt to send to unsubscribed recipient", message_body: "an older unrelated note about the weather",
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  });
  const r = await executeManualInboxSendNow({ ...SEND, message_body: REWORDS[3], content_filter_lock_clearance: CLEARANCE }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "compliance_blocked_at_send_time");
  assert.equal(h.provider_calls.length, 1);
});

test("BURST: transport failures (no content filter) are capped at 2 attempts per 10 minutes", async () => {
  const h = burstHarness({ provider: () => ({ ok: false, error: "carrier rejected" }) });
  // Failures recorded as failed_transport, not content filter.
  h.deps.finalizeSendQueueFailureImpl = async (row) => {
    const stored = h.supabase.tables.send_queue.find((r) => r.id === row.id);
    Object.assign(stored, { queue_status: "failed_transport", failed_reason: "carrier rejected" });
    return { ...stored };
  };
  const results = [];
  for (const body of REWORDS) results.push(await executeManualInboxSendNow({ ...SEND, message_body: body }, h.deps));
  assert.equal(h.provider_calls.length, 2, "failed attempts count toward the cap");
  for (const r of results.slice(2)) {
    assert.equal(r.ok, false);
    assert.equal(r.reason, MANUAL_BURST_REASONS.ATTEMPT_CAP);
    assert.match(r.detail_reason, /failed attempts count/);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. EVERY OPERATOR PATH (review task_e46cf83a, CHANGES REQUESTED)
//
// The lock and the cap used to run only for an immediate send-now. Cockpit's
// Queue reply / Auto-reply / Schedule reply and the internal send-now route
// with action "queue_reply" wrote rows (queued, scheduled_for = now) that
// skipped both, and nothing re-checked the lock at dispatch.
// ═════════════════════════════════════════════════════════════════════════════

const ago = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const ahead = (m) => new Date(Date.now() + m * 60 * 1000).toISOString();

/** A thread whose last send TextGrid's content filter blocked 5 minutes ago. */
const lockedThread = () => makeFakeSupabase({
  send_queue: [{ id: "cf1", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "failed", message_body: REWORDS[0], created_at: ago(5), metadata: { failure_class: "content_filter_blocked" } }],
});

/** Exactly what cockpit-service.js runInboxAction passes for these actions. */
function cockpitInput(action, body) {
  const svc_action = action === "auto-reply" ? "auto_reply" : action === "schedule-reply" ? "schedule_reply" : "queue_reply";
  return {
    ...SEND,
    message_body: body,
    repeat_ask_override: false,
    repeat_ask_override_actor: null,
    source: "inbox",
    action: svc_action,
    created_from: "leadcommand_inbox",
    message_type: action === "auto-reply" ? "auto_reply" : action === "schedule-reply" ? "manual_scheduled_reply" : "manual_reply",
    use_case_template: action === "auto-reply" ? "auto_reply" : "manual_reply",
    type: "outbound",
    ...(action === "schedule-reply" ? { scheduled_for: ahead(120) } : {}),
  };
}

const OPERATOR_PATHS = [
  ["cockpit queue-reply", (body) => cockpitInput("queue-reply", body)],
  ["cockpit auto-reply", (body) => cockpitInput("auto-reply", body)],
  ["cockpit schedule-reply (2 h ahead)", (body) => cockpitInput("schedule-reply", body)],
  ["map command", (body) => ({ ...SEND, message_body: body, source: "map_command", action: "send_ownership_check", created_from: "leadcommand_map", message_type: "ownership_check", use_case_template: "ownership_check" })],
  ["send-now scheduled ahead", (body) => ({ ...SEND, message_body: body, scheduled_for: ahead(60) })],
];

test("6a. a locked thread refuses EVERY operator path before any row (queue reply, auto reply, schedule reply, map command, scheduled send-now)", async () => {
  for (const [name, build] of OPERATOR_PATHS) {
    const h = rowDeps(lockedThread());
    const r = await createInboxSendNowQueueRow(build(REWORDS[3]), { ...h.deps, operator: OPERATOR });
    assert.equal(r.ok, false, name);
    assert.equal(r.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED, `${name}: ${r.reason}`);
    assert.equal(r.hard_block, true, name);
    assert.equal(r.queue_inserted, false, name);
    assert.equal(r.manual_send_burst.clearance_required, true, name);
    assert.equal(h.inserted.length, 0, `${name}: no row`);
  }
});

test("6b. every operator path counts against the per-thread cap, and the cap refuses every path", async () => {
  for (const [name, build] of OPERATOR_PATHS) {
    // One failed send-now 3 minutes ago, then this path writes a row: that is
    // two attempts in 10 minutes.
    const supabase = makeFakeSupabase({
      send_queue: [{ id: "f1", thread_key: THREAD, to_phone_number: THREAD, queue_status: "failed_transport", message_body: "an earlier note about the closing date", created_at: ago(3) }],
    });
    const h = rowDeps(supabase);
    const first = await createInboxSendNowQueueRow(build(REWORDS[1]), { ...h.deps, operator: OPERATOR });
    assert.equal(first.ok, true, `${name}: ${first.reason} ${first.detail_reason || ""}`);
    const row = h.inserted[0];
    assert.equal(row.queue_status, "queued", name);
    assert.equal(row.metadata[OPERATOR_SEND_MARKER], true, `${name}: the row is marked as an operator send`);
    assert.equal(row.metadata.manual_send_burst_guard.lock_and_cap_applied, true, name);
    assert.equal(row.metadata.operator_id, OPERATOR.id, `${name}: the row records who wrote it`);

    // Every path is now refused by the cap: the waiting row counted.
    for (const [other, build_other] of OPERATOR_PATHS) {
      const r = await createInboxSendNowQueueRow(build_other(REWORDS[4]), { ...h.deps, operator: OPERATOR });
      assert.equal(r.ok, false, `${name} then ${other}`);
      assert.equal(r.reason, MANUAL_BURST_REASONS.ATTEMPT_CAP, `${name} then ${other}: ${r.reason}`);
    }
    assert.equal(h.inserted.length, 1, `${name}: refused attempts write nothing`);
  }
});

test("6c. a scheduled operator row (status scheduled after the Cockpit patch) still counts against the cap", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [
      { id: "s1", thread_key: THREAD, to_phone_number: THREAD, queue_status: "scheduled", message_body: "the first scheduled reply about the roof", created_at: ago(2), scheduled_for: ahead(120), metadata: { [OPERATOR_SEND_MARKER]: true } },
      { id: "s2", thread_key: THREAD, to_phone_number: THREAD, queue_status: "scheduled", message_body: "the second scheduled reply about closing", created_at: ago(1), scheduled_for: ahead(240), metadata: { [OPERATOR_SEND_MARKER]: true } },
    ],
  });
  const h = rowDeps(supabase);
  const r = await createInboxSendNowQueueRow(cockpitInput("queue-reply", REWORDS[2]), { ...h.deps, operator: OPERATOR });
  assert.equal(r.reason, MANUAL_BURST_REASONS.ATTEMPT_CAP);
  assert.equal(h.inserted.length, 0);
});

test("6d. clearance on a queue reply: a server-identified person with a reason clears it; no principal or no reason is refused", async () => {
  const h = rowDeps(lockedThread());
  const no_operator = await createInboxSendNowQueueRow({ ...cockpitInput("queue-reply", REWORDS[3]), content_filter_lock_clearance: CLEARANCE }, h.deps);
  assert.equal(no_operator.reason, MANUAL_BURST_REASONS.CLEARANCE_INVALID, "no server identity, no clearance");
  const no_reason = await createInboxSendNowQueueRow({ ...cockpitInput("queue-reply", REWORDS[3]), content_filter_lock_clearance: { reason: "ok" } }, { ...h.deps, operator: OPERATOR });
  assert.equal(no_reason.reason, MANUAL_BURST_REASONS.CLEARANCE_INVALID);
  assert.equal(h.inserted.length, 0);
  const cleared = await createInboxSendNowQueueRow({ ...cockpitInput("queue-reply", REWORDS[3]), content_filter_lock_clearance: CLEARANCE }, { ...h.deps, operator: OPERATOR });
  assert.equal(cleared.ok, true, `${cleared.reason}: ${cleared.detail_reason}`);
  assert.equal(h.inserted[0].metadata.content_filter_lock_clearance.actor, OPERATOR.id);
  assert.equal(h.inserted[0].metadata.content_filter_lock_clearance.cleared_lock.blocked_row_id, "cf1");
});

// ── the internal route, action "queue_reply" ────────────────────────────────

function internalRoute(supabase) {
  const h = rowDeps(supabase);
  const dispatched = [];
  return {
    h,
    dispatched,
    call: (body, actor = "ops-user-7") =>
      handleInternalInboxSendNow(
        // What route.js builds: the body plus the x-ops-user-id actor.
        { ...body, repeat_ask_override_actor: actor },
        { queueRowDeps: h.deps, processSendQueueItem: async (id) => { dispatched.push(id); return { ok: true, id }; } }
      ),
  };
}

test("6e. POST /api/internal/inbox/send-now with action queue_reply on a locked thread: refused, no row, nothing dispatched", async () => {
  for (const action of ["queue_reply", "auto_reply", "send_now"]) {
    const route = internalRoute(lockedThread());
    const { payload } = await route.call({ ...SEND, action, source: "inbox", message_body: REWORDS[2] });
    assert.equal(payload.outcome, "blocked", action);
    assert.equal(payload.failure.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED, action);
    assert.equal(payload.failure.hard_block, true, action);
    assert.equal(payload.queue_row_id, null, action);
    assert.equal(route.h.inserted.length, 0, `${action}: no row`);
    assert.equal(route.dispatched.length, 0, `${action}: processSendQueueItem never called`);
  }
});

test("6f. the internal route's queue_reply counts against the cap; the next request is refused and not dispatched", async () => {
  const route = internalRoute(makeFakeSupabase({
    send_queue: [{ id: "f1", thread_key: THREAD, to_phone_number: THREAD, queue_status: "failed", message_body: "an earlier note about the closing date", created_at: ago(4) }],
  }));
  const first = await route.call({ ...SEND, action: "queue_reply", source: "inbox", message_body: REWORDS[1] });
  assert.equal(first.payload.outcome, "queued", JSON.stringify(first.payload.failure));
  assert.equal(route.dispatched.length, 1);
  assert.equal(route.h.inserted[0].metadata[OPERATOR_SEND_MARKER], true);
  assert.equal(route.h.inserted[0].metadata.operator_id, "ops-user-7", "the route-stamped actor is recorded");
  const second = await route.call({ ...SEND, action: "queue_reply", source: "inbox", message_body: REWORDS[4] });
  assert.equal(second.payload.outcome, "blocked");
  assert.equal(second.payload.failure.reason, MANUAL_BURST_REASONS.ATTEMPT_CAP);
  assert.equal(route.dispatched.length, 1, "the refused request was not dispatched");
  assert.equal(route.h.inserted.length, 1);
});

test("6g. the internal route: the stamped x-ops-user-id actor with a reason can clear; without an actor it cannot", async () => {
  const anon = internalRoute(lockedThread());
  const refused = await anon.call({ ...SEND, action: "queue_reply", source: "inbox", message_body: REWORDS[3], content_filter_lock_clearance: CLEARANCE }, null);
  assert.equal(refused.payload.failure.reason, MANUAL_BURST_REASONS.CLEARANCE_INVALID);
  assert.equal(anon.dispatched.length, 0);
  const named = internalRoute(lockedThread());
  const ok = await named.call({ ...SEND, action: "queue_reply", source: "inbox", message_body: REWORDS[3], content_filter_lock_clearance: CLEARANCE });
  assert.equal(ok.payload.outcome, "queued", JSON.stringify(ok.payload.failure));
  assert.equal(named.dispatched.length, 1);
  assert.equal(named.h.inserted[0].metadata.content_filter_lock_clearance.actor, "ops-user-7");
});

// ── dispatch: the final gate re-checks the lock on every path ───────────────

test("6h. contentFilterDispatchRefusal: locked thread; row written before the latest block (even after a clearance); clean cases pass", () => {
  const queued_before = { id: "q-old", thread_key: THREAD, queue_status: "queued", created_at: minutesAgo(20), metadata: { [OPERATOR_SEND_MARKER]: true } };
  const block = { id: "cf1", thread_key: THREAD, queue_status: "failed", created_at: minutesAgo(10), metadata: { failure_class: "content_filter_blocked" } };
  const clearance_row = { id: "c1", thread_key: THREAD, queue_status: "sent", created_at: minutesAgo(5), metadata: { content_filter_lock_clearance: { actor: OPERATOR.id, cleared_at: minutesAgo(5) } } };
  const fresh = { id: "q-new", thread_key: THREAD, queue_status: "queued", created_at: minutesAgo(1), metadata: {} };

  assert.equal(contentFilterDispatchRefusal({ row: queued_before, rows: [queued_before, block] }).reason, "content_filter_locked");
  assert.equal(contentFilterDispatchRefusal({ row: fresh, rows: [block] }).reason, "content_filter_locked", "any row, any path, on a locked thread");
  assert.equal(contentFilterDispatchRefusal({ row: null, rows: [block] }).reason, "content_filter_locked", "a manual send with no row yet");
  assert.equal(
    contentFilterDispatchRefusal({ row: queued_before, rows: [queued_before, block, clearance_row] }).reason,
    "content_filter_blocked_after_row_written",
    "the clearance reviewed the new wording, not the row queued before the block"
  );
  assert.equal(contentFilterDispatchRefusal({ row: fresh, rows: [block, clearance_row] }), null, "a row written after a person cleared the lock");
  assert.equal(contentFilterDispatchRefusal({ row: clearance_row, rows: [block] }), null, "the cleared row itself");
  assert.equal(contentFilterDispatchRefusal({ row: fresh, rows: [] }), null);
});

const GATE_NOW = NOW;
const gateIso = (m) => new Date(NOW_MS - m * 60 * 1000).toISOString();
const NO_DIRECT_READS = { from() { throw new Error("unexpected direct read: inject a reader"); } };

function gateDeps(row, history) {
  return {
    supabase: NO_DIRECT_READS,
    evaluateAuthority: async () => ({ ok: true }),
    checkSenderContinuity: async () => ({ ok: true, reason: null }),
    readQueueRow: async () => row,
    readSuppression: async () => ({ suppressed: false, lookup_error: null }),
    readAutomationSuppression: async () => ({ active: false }),
    readThreadState: async () => ({ thread_key: THREAD, status: "active", is_archived: false, last_inbound_at: null, metadata: {} }),
    readAutomationHold: async () => ({ held: false, fail_closed: false }),
    readCampaign: async () => null,
    readStatusHistory: async () => [
      { from_status: null, to_status: "queued", changed_at: row.created_at },
      { from_status: "queued", to_status: "processing", changed_at: gateIso(0) },
    ],
    readLatestAuthorityEvent: async () => gateIso(24 * 60 - 60),
    readReleaseAudit: async () => ({ found: false }),
    verifyDispatchClaim: async () => ({ ok: true }),
    readThreadSendHistory: typeof history === "function" ? history : async () => ({ ok: true, rows: history }),
  };
}

const gateInput = (row) => ({
  path: "queue",
  row,
  to: THREAD,
  from: FROM_88,
  thread_key: THREAD,
  claim_token: row.lock_token,
  contact_window: { allowed: true, hold: false, timezone: "America/Chicago" },
  now: GATE_NOW,
});

test("6i. FINAL DISPATCH GATE: a row queued before the block is refused at dispatch; a clean row passes; unreadable history refuses", async () => {
  __setFinalDispatchGateModeForTests("enforce");
  const queued = { id: "q-before", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM_88, queue_status: "processing", lock_token: "claim-q", created_at: gateIso(20), message_body: REWORDS[1], metadata: { [OPERATOR_SEND_MARKER]: true, action: "queue_reply" } };
  const block = { id: "cf1", thread_key: THREAD, to_phone_number: THREAD, queue_status: "failed", created_at: gateIso(10), message_body: REWORDS[0], metadata: { failure_class: "content_filter_blocked" } };
  const clearance_row = { id: "c1", thread_key: THREAD, to_phone_number: THREAD, queue_status: "sent", created_at: gateIso(5), message_body: REWORDS[3], metadata: { content_filter_lock_clearance: { actor: OPERATOR.id, cleared_at: gateIso(5) } } };

  // Baseline: the same row on a clean thread passes every check.
  const clean_verdict = await evaluateFinalDispatchGate(gateInput(queued), gateDeps(queued, [queued]));
  assert.equal(clean_verdict.ok, true, JSON.stringify(clean_verdict.refusals));

  // Blocked after it was queued: refused, provider never reached.
  const locked = await evaluateFinalDispatchGate(gateInput(queued), gateDeps(queued, [block, queued]));
  assert.equal(locked.ok, false);
  assert.ok(locked.refusals.includes(GATE_REASONS.CONTENT_FILTER_LOCKED), JSON.stringify(locked.refusals));
  assert.equal(locked.reason, GATE_REASONS.CONTENT_FILTER_LOCKED);

  // Still refused after a person cleared the thread with a NEW message.
  const after_clear = await evaluateFinalDispatchGate(gateInput(queued), gateDeps(queued, [clearance_row, block, queued]));
  assert.equal(after_clear.ok, false);
  assert.equal(after_clear.reason, GATE_REASONS.CONTENT_FILTER_BLOCK_AFTER_ROW);

  // An automated row (no operator marker) on a locked thread: refused too.
  const automated = { ...queued, id: "auto-1", created_at: gateIso(2), metadata: { follow_up_id: "fu-1" } };
  const auto_verdict = await evaluateFinalDispatchGate(gateInput(automated), gateDeps(automated, [block]));
  assert.equal(auto_verdict.reason, GATE_REASONS.CONTENT_FILTER_LOCKED);

  // Fail closed: an unreadable history refuses.
  for (const reader of [async () => ({ ok: false, error: "statement timeout" }), async () => { throw new Error("db down"); }, async () => ({ ok: true, rows: null })]) {
    const v = await evaluateFinalDispatchGate(gateInput(queued), gateDeps(queued, reader));
    assert.equal(v.ok, false);
    assert.equal(v.reason, GATE_REASONS.CONTENT_FILTER_HISTORY_UNREADABLE, JSON.stringify(v.refusals));
  }
});

test("6j. FINAL DISPATCH GATE, manual path: a manual send on a locked thread is refused at dispatch", async () => {
  __setFinalDispatchGateModeForTests("enforce");
  const block = { id: "cf1", thread_key: THREAD, to_phone_number: THREAD, queue_status: "failed", created_at: gateIso(10), metadata: { failure_class: "content_filter_blocked" } };
  const deps = gateDeps({ id: "unused", created_at: gateIso(1) }, [block]);
  delete deps.readQueueRow;
  const v = await evaluateFinalDispatchGate(
    { path: "manual", row: null, to: THREAD, thread_key: THREAD, operator_action_id: "opact-1", now: GATE_NOW },
    deps
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, GATE_REASONS.CONTENT_FILTER_LOCKED, JSON.stringify(v.refusals));
});

test("6k. wiring: Cockpit queue/auto/schedule reply pass the server principal; the internal route goes through the handler; the gate runs check 6b", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
  const cockpit = read("lib/cockpit/cockpit-service.js");
  const reply = cockpit.slice(cockpit.indexOf("if (action === 'queue-reply' || action === 'schedule-reply' || action === 'auto-reply')"));
  assert.match(reply, /createInboxSendNowQueueRow\(/);
  // The server principal is applied LAST, after any test-seam deps.
  assert.match(reply.slice(0, reply.indexOf("if (!queueResult.ok")), /supabase, operator \}/);
  const route = read("app/api/internal/inbox/send-now/route.js");
  assert.match(route, /handleInternalInboxSendNow\(/);
  assert.match(route, /processSendQueueItem/);
  const gate = read("lib/domain/queue/final-dispatch-gate.js");
  assert.match(gate, /contentFilterDispatchRefusal\(/);
  const svc = read("lib/domain/inbox/send-now-service.js");
  assert.doesNotMatch(svc, /immediate_manual/, "no flag left that could switch the lock or the cap off");
});
