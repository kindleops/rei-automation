// RC 7.1 — "A not interested is a 30 day follow up" (owner rule 2026-09-30).
//
// Not-interested is a nurture, never a suppression: exactly one live 30-day
// follow-up, never a duplicate, and a NEW one each time the seller is not
// interested again after the previous cycle finished. DNC / STOP / manual
// suppression stay absolute, at schedule time and at send time.
//
// Production evidence (read-only, 2026-10-01): 69 threads ever got a
// nurture_not_interested row, none ever got a second one (queue_key is
// unique across all statuses, so every later "not interested" replayed onto
// the dead first row as duplicate_followup_exists).

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveFollowUpPlan,
  scheduleFollowUp,
  cancelPendingFollowUpsForThread,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import {
  cancelSupabasePendingOutbound,
  CANCELLATION_POLICIES,
} from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";
import { evaluateCanonicalContactability } from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import { opportunityStatusForReply } from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { isNurtureFollowUpRow } from "@/lib/domain/automation/automation-actions.js";
import { BLUEPRINTS } from "@/lib/domain/workflow-studio/orchestrator/definitions.js";

const PHONE = "+16125550101";
const DAY = 24 * 60 * 60 * 1000;
const LIVE = new Set([
  "queued", "ready", "runnable", "scheduled", "pending", "paused",
  "paused_after_hours", "processing", "approved", "approval", "held", "sending",
]);

// ── In-memory PostgREST-shaped fake ───────────────────────────────────────
function unquote(value) {
  return String(value).replace(/^"(.*)"$/, "$1");
}

function createDb(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  let nextId = 1;
  const rowsOf = (table) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  };

  function builder(table) {
    const filters = [];
    let op = "select";
    let payload = null;
    let limitN = null;
    let wantSingle = false;

    const match = (row) => filters.every((f) => f(row));
    const run = () => {
      const rows = rowsOf(table);
      if (op === "insert") {
        const input = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        for (const raw of input) {
          const row = { id: raw.id ?? `row_${nextId++}`, created_at: new Date().toISOString(), ...raw };
          if (table === "send_queue") {
            const dupKey = rows.some((r) => r.queue_key && r.queue_key === row.queue_key);
            const dupActive =
              row.dedupe_key &&
              rows.some(
                (r) => r.dedupe_key === row.dedupe_key && !r.sent_at && LIVE.has(String(r.queue_status))
              );
            if (dupKey || dupActive) {
              return { data: null, error: { code: "23505", message: "duplicate key value" } };
            }
          }
          rows.push(row);
          inserted.push(row);
        }
        return { data: wantSingle ? inserted[0] : inserted, error: null };
      }
      if (op === "update") {
        const hit = rows.filter(match);
        for (const row of hit) Object.assign(row, payload);
        return { data: hit, error: null };
      }
      let hit = rows.filter(match);
      if (limitN !== null) hit = hit.slice(0, limitN);
      if (wantSingle) return { data: hit[0] ?? null, error: null, count: hit.length };
      return { data: hit, error: null, count: hit.length };
    };

    const chain = {
      select() { return proxy; },
      insert(p) { op = "insert"; payload = p; return proxy; },
      update(p) { op = "update"; payload = p; return proxy; },
      eq(col, val) { filters.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col, val) { filters.push((r) => String(r[col]) !== String(val)); return proxy; },
      in(col, vals) { const set = new Set(vals.map(String)); filters.push((r) => set.has(String(r[col]))); return proxy; },
      is(col, val) { filters.push((r) => (r[col] ?? null) === val); return proxy; },
      or(expr) {
        const parts = String(expr).split(",").map((p) => p.split(".eq."));
        filters.push((r) => parts.some(([col, val]) => String(r[col]) === unquote(val)));
        return proxy;
      },
      limit(n) { limitN = n; return proxy; },
      maybeSingle() { wantSingle = true; return Promise.resolve(run()); },
      single() { wantSingle = true; return Promise.resolve(run()); },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    // Anything not modelled (order, gte, ilike, not, range...) is a no-op filter.
    const proxy = new Proxy(chain, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => proxy;
      },
    });
    return proxy;
  }

  return { from: (table) => builder(table), tables, rows: rowsOf };
}

function nurtureRows(db) {
  return db.rows("send_queue").filter((r) => r.use_case_template === "nurture_not_interested");
}
function liveNurture(db) {
  return nurtureRows(db).filter((r) => !r.sent_at && LIVE.has(String(r.queue_status)));
}

// ── Scheduling ─────────────────────────────────────────────────────────────

test("not interested → exactly one 30-day nurture follow-up", async () => {
  const db = createDb();
  const before = Date.now();
  const result = await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_1" }, db);

  assert.equal(result.ok, true);
  const rows = nurtureRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].queue_status, "scheduled");
  assert.equal(rows[0].type, "followup");
  assert.equal(rows[0].metadata.followup_reason, "nurture_followup:not_interested");
  assert.equal(isNurtureFollowUpRow(rows[0]), true, "the stage rule's keep-predicate recognises it");
  const due = Date.parse(rows[0].scheduled_for_utc);
  assert.ok(due - before >= 30 * DAY - 60_000 && due - before <= 30 * DAY + 60_000, "due in 30 days");
});

test("scheduled once → a repeat (same or later inbound) never duplicates the live follow-up", async () => {
  const db = createDb();
  await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_1" }, db);
  const replay = await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_1" }, db);
  const later = await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_2" }, db);

  assert.equal(replay.reason, "duplicate_followup_exists");
  assert.equal(later.reason, "duplicate_followup_exists");
  assert.equal(nurtureRows(db).length, 1);
  assert.equal(liveNurture(db).length, 1);
});

test("ROOT CAUSE: after the first cycle finished, the next 'not interested' gets a new 30-day follow-up", async () => {
  for (const finished of [
    { queue_status: "cancelled" },
    { queue_status: "sent", sent_at: new Date().toISOString() },
    { queue_status: "delivered", sent_at: new Date().toISOString() },
  ]) {
    const db = createDb();
    await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_1" }, db);
    Object.assign(nurtureRows(db)[0], finished);

    const second = await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_9" }, db);
    assert.equal(second.ok, true, `new cycle after ${finished.queue_status}`);
    assert.equal(nurtureRows(db).length, 2);
    assert.equal(liveNurture(db).length, 1, "exactly one live nurture");
    assert.match(liveNurture(db)[0].dedupe_key, /:cycle:ev_9$/);

    // A replay of that same inbound stays idempotent; a third inbound while
    // the cycle-2 row is live is a duplicate, not a third row.
    const replay = await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_9" }, db);
    const third = await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_10" }, db);
    assert.equal(replay.reason, "duplicate_followup_exists");
    assert.equal(third.reason, "duplicate_followup_exists");
    assert.equal(liveNurture(db).length, 1);
  }
});

test("not interested + DNC / opt-out → no follow-up", async () => {
  // The STOP itself is a permanent suppression intent.
  const plan = resolveFollowUpPlan("opt_out", { thread_key: PHONE });
  assert.equal(plan.suppressed, true);
  assert.equal(plan.followup_created, false);

  // "Not interested" on a thread that is already DNC-suppressed.
  const db = createDb();
  const result = await scheduleFollowUp("not_interested", PHONE, { is_suppressed: true }, db);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "thread_already_suppressed");
  assert.equal(nurtureRows(db).length, 0);
});

test("STOP after 'not interested' cancels the nurture even when nurture is being kept", async () => {
  const db = createDb();
  await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_1" }, db);
  const res = await cancelSupabasePendingOutbound(
    {
      thread_key: PHONE,
      to_phone_number: PHONE,
      policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
      reason: "opt_out",
      keep_nurture_follow_ups: true, // must not shield anything from a compliance stop
    },
    { supabase: db }
  );
  assert.equal(res.cancelled, 1);
  assert.equal(liveNurture(db).length, 0);
});

test("manual suppression → no follow-up, and a due nurture is blocked at send time", async () => {
  const db = createDb({
    sms_suppression_list: [
      { id: "sup_1", phone_e164: PHONE, is_active: true, suppression_type: "manual", suppression_reason: "manual_suppression" },
    ],
  });
  const result = await scheduleFollowUp("not_interested", PHONE, { is_suppressed: true }, db);
  assert.equal(result.reason, "thread_already_suppressed");

  const send = await evaluateCanonicalContactability(
    { thread_key: PHONE, to_phone_number: PHONE, queue_row_id: "q1", queue_status: "processing" },
    { supabase: db }
  );
  assert.equal(send.blocked, true);
  assert.equal(send.reason, "phone_suppressed");
});

// ── Send-time guard ────────────────────────────────────────────────────────

test("send-time guard: a not-interested nurture is NOT blocked; a real opt-out still is", async () => {
  const base = {
    inbox_thread_state: [
      { thread_key: PHONE, status: "open", contactability_status: "contactable", disposition: "not_interested", metadata: {} },
    ],
    message_events: [
      { id: "m1", thread_key: PHONE, direction: "inbound", detected_intent: "not_interested", message_body: "Not interested", is_opt_out: false, metadata: {} },
    ],
  };
  const nurture = await evaluateCanonicalContactability(
    { thread_key: PHONE, to_phone_number: PHONE, queue_row_id: "q1", queue_status: "processing" },
    { supabase: createDb(base) }
  );
  assert.equal(nurture.blocked, false, `nurture must send, got ${nurture.reason}`);

  for (const optOut of [
    { detected_intent: "opt_out", message_body: "Stop texting me", is_opt_out: true },
    { detected_intent: "not_interested", message_body: "STOP", is_opt_out: false },
  ]) {
    const db = createDb({
      ...base,
      message_events: [...base.message_events, { id: "m2", thread_key: PHONE, direction: "inbound", metadata: {}, ...optOut }],
    });
    const blocked = await evaluateCanonicalContactability(
      { thread_key: PHONE, to_phone_number: PHONE, queue_row_id: "q1", queue_status: "processing" },
      { supabase: db }
    );
    assert.equal(blocked.blocked, true, `opt-out "${optOut.message_body}" must block: ${JSON.stringify(blocked)}`);
  }

  const optedOutThread = createDb({
    inbox_thread_state: [{ thread_key: PHONE, status: "open", contactability_status: "opted_out", metadata: {} }],
  });
  const blockedThread = await evaluateCanonicalContactability(
    { thread_key: PHONE, to_phone_number: PHONE, queue_row_id: "q1", queue_status: "processing" },
    { supabase: optedOutThread }
  );
  assert.equal(blockedThread.blocked, true);
});

// ── Re-engagement and the follow-up sweeps ─────────────────────────────────

test("seller replies → the nurture deal re-enters active handling and the stale nurture is withdrawn", async () => {
  assert.equal(opportunityStatusForReply("active", "not_interested"), "nurture");
  assert.equal(opportunityStatusForReply("nurture", "seller_interested"), "active");
  assert.equal(opportunityStatusForReply("nurture", "asking_price_provided"), "active");
  assert.equal(opportunityStatusForReply("suppressed", "seller_interested"), null, "opt-out status is never reopened here");

  const db = createDb();
  await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_1" }, db);
  const takeover = await cancelPendingFollowUpsForThread({
    thread_key: PHONE,
    inbound_event_id: "ev_reply",
    supabase: db,
  });
  assert.equal(takeover.cancelled, 1);
  assert.equal(liveNurture(db).length, 0);

  // ...and if they later say "not interested" again, the nurture comes back.
  const again = await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_3" }, db);
  assert.equal(again.ok, true);
  assert.equal(liveNurture(db).length, 1);
});

test("the 'Not interested → stop follow-ups' workflow keeps the nurture and withdraws the rest", async () => {
  const graph = BLUEPRINTS.not_interested_stop.build();
  const stop = graph.nodes.find((n) => n.id === "stop");
  assert.equal(stop.config.inputs.keep_nurture_follow_ups, true);

  const db = createDb();
  await scheduleFollowUp("not_interested", PHONE, { inbound_message_event_id: "ev_1" }, db);
  db.rows("send_queue").push({
    id: "stage_fu",
    queue_key: "followup:stage",
    thread_key: PHONE,
    to_phone_number: PHONE,
    queue_status: "scheduled",
    type: "followup",
    message_type: "followup",
    use_case_template: "ownership_check",
    metadata: { followup_reason: "stage_no_reply_followup:S1" },
  });

  const res = await cancelPendingFollowUpsForThread({
    thread_key: PHONE,
    reason: "seller_not_interested",
    keep_nurture_follow_ups: true,
    supabase: db,
  });
  assert.equal(res.cancelled, 1);
  assert.equal(liveNurture(db).length, 1, "nurture kept");
  assert.equal(db.rows("send_queue").find((r) => r.id === "stage_fu").queue_status, "cancelled");
});
