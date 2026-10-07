// 2026-10-07 live bug (prod 083f768d) — "A not interested is a 30 day follow up."
//
// A seller replied "NOT FOR SALE". The seller flow scheduled the 30-day
// nurture (send_queue type=followup, use_case_template=nurture_not_interested,
// scheduled_for_utc +30d). Five seconds later automation_actions shows
// stage.not_interested_cold → cancel_pending_queue with params
// {"reason":"not_interested"} cancelling it (guard_reason/failed_reason
// 'not_interested', safety_status 'blocked').
//
// Cause: the stored automation_rules row (seeded 2026-06-03) predates
// keep_nurture_follow_ups, and hydrateRule lets stored `actions` replace the
// code default. The fix must not depend on that flag being stored.

import test from "node:test";
import assert from "node:assert/strict";

import {
  executeAutomationAction,
  shouldKeepNurtureFollowUps,
} from "@/lib/domain/automation/automation-actions.js";
import { loadActiveAutomationRules } from "@/lib/domain/automation/automation-rules.js";

const PHONE = "+13145550101";

// Exact shape of the prod rows, read-only 2026-10-07.
const PROD_RULES = [
  {
    rule_key: "stage.not_interested_cold",
    event_type: "inbound_message_received",
    is_active: true,
    status: "active",
    priority: 22,
    dry_run_default: false,
    condition: { matcher: "not_interested" },
    actions: [
      { params: { stage: "not_interested", status: "open", metadata: { lead_temperature: "cold" }, priority: "low" }, action_type: "patch_thread_state" },
      { params: { reason: "not_interested" }, action_type: "cancel_pending_queue" },
    ],
  },
  {
    rule_key: "suppression.stop_dnc",
    event_type: "inbound_message_received",
    is_active: true,
    status: "active",
    priority: 1,
    dry_run_default: false,
    condition: { matcher: "stop_or_dnc" },
    actions: [{ params: { reason: "stop_or_dnc_keyword" }, action_type: "cancel_pending_queue" }],
  },
  {
    rule_key: "suppression.wrong_number",
    event_type: "inbound_message_received",
    is_active: true,
    status: "active",
    priority: 2,
    dry_run_default: false,
    condition: { matcher: "wrong_number" },
    actions: [{ params: { reason: "wrong_number_keyword" }, action_type: "cancel_pending_queue" }],
  },
  {
    rule_key: "suppression.not_owner_bad_contact",
    event_type: "inbound_message_received",
    is_active: true,
    status: "active",
    priority: 3,
    dry_run_default: false,
    condition: { matcher: "not_owner" },
    actions: [{ params: { reason: "not_owner_or_tenant" }, action_type: "cancel_pending_queue" }],
  },
];

function nurtureRow() {
  const now = Date.now();
  return {
    id: "e8c76c4b-0000-4000-8000-000000000001",
    type: "followup",
    message_type: "followup",
    source: "seller_inbound_orchestrator",
    use_case_template: "nurture_not_interested",
    queue_status: "scheduled",
    to_phone_number: PHONE,
    thread_key: PHONE,
    scheduled_for_utc: new Date(now + 30 * 86400000).toISOString(),
    metadata: {
      intent: "not_interested",
      followup_reason: "nurture_followup:not_interested",
      days_until_followup: 30,
      is_suppressed: false,
    },
  };
}

function stageRow() {
  return {
    id: "stage-fu-1",
    type: "followup",
    message_type: "followup",
    use_case_template: "ownership_check",
    queue_status: "scheduled",
    to_phone_number: PHONE,
    thread_key: PHONE,
    metadata: { followup_reason: "stage_no_reply_followup:S1" },
  };
}

// Minimal PostgREST-shaped fake: select/insert/update with eq/in/limit.
function createDb(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  let nextId = 1;
  const rowsOf = (t) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t);
  };
  function builder(table) {
    const filters = [];
    let op = "select";
    let payload = null;
    let limitN = null;
    let single = false;
    const run = () => {
      const rows = rowsOf(table);
      if (op === "insert" || op === "upsert") {
        const input = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id ?? `row_${nextId++}`, ...r }));
        rows.push(...input);
        return { data: single ? input[0] : input, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        return { data: single ? hit[0] ?? null : hit, error: null };
      }
      const out = limitN === null ? hit : hit.slice(0, limitN);
      return { data: single ? out[0] ?? null : out, error: null };
    };
    const chain = {
      select() { return proxy; },
      insert(p) { op = "insert"; payload = p; return proxy; },
      upsert(p) { op = "upsert"; payload = p; return proxy; },
      update(p) { op = "update"; payload = p; return proxy; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return proxy; },
      in(c, vs) { const s = new Set(vs.map(String)); filters.push((r) => s.has(String(r[c]))); return proxy; },
      limit(n) { limitN = n; return proxy; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    const proxy = new Proxy(chain, { get: (t, p) => (p in t ? t[p] : () => proxy) });
    return proxy;
  }
  return { from: (t) => builder(t), rows: rowsOf };
}

async function runStoredRule(db, rule_key, event_id) {
  const rules = await loadActiveAutomationRules({ supabaseClient: db });
  const rule = rules.find((r) => r.rule_key === rule_key);
  assert.ok(rule, `stored rule ${rule_key} loaded`);
  const action = rule.actions.find((a) => a.action_type === "cancel_pending_queue");
  const event = {
    id: event_id,
    event_type: "inbound_message_received",
    phone_e164: PHONE,
    payload: { canonical_e164: PHONE, message_body: "NOT FOR SALE" },
  };
  return executeAutomationAction({ event, run: { id: `run_${event_id}` }, rule, action, supabaseClient: db });
}

const row = (db, id) => db.rows("send_queue").find((r) => r.id === id);

test("prod sequence: stored not_interested rule (no keep flag) no longer cancels the 30-day nurture", async () => {
  const db = createDb({ automation_rules: PROD_RULES, send_queue: [nurtureRow(), stageRow()] });
  const nurture_id = nurtureRow().id;

  const res = await runStoredRule(db, "stage.not_interested_cold", "ev_not_for_sale");
  assert.equal(res.ok, true);

  assert.equal(row(db, nurture_id).queue_status, "scheduled", "nurture follow-up survives");
  assert.equal(row(db, nurture_id).guard_reason, undefined);
  assert.equal(row(db, "stage-fu-1").queue_status, "cancelled", "other pending outreach still withdrawn");
  assert.equal(row(db, "stage-fu-1").guard_reason, "not_interested");
});

for (const [rule_key, reason] of [
  ["suppression.stop_dnc", "stop_or_dnc_keyword"],
  ["suppression.wrong_number", "wrong_number_keyword"],
  ["suppression.not_owner_bad_contact", "not_owner_or_tenant"],
]) {
  test(`${rule_key} after "not interested" still cancels the nurture`, async () => {
    const db = createDb({ automation_rules: PROD_RULES, send_queue: [nurtureRow()] });
    await runStoredRule(db, "stage.not_interested_cold", "ev_1");
    assert.equal(row(db, nurtureRow().id).queue_status, "scheduled");

    await runStoredRule(db, rule_key, "ev_2");
    assert.equal(row(db, nurtureRow().id).queue_status, "cancelled");
    assert.equal(row(db, nurtureRow().id).guard_reason, reason);
  });
}

test("shouldKeepNurtureFollowUps: terminal reasons always cancel; business reasons keep", () => {
  for (const reason of [
    "stop_or_dnc_keyword", "opt_out", "wrong_number_keyword", "not_owner_or_tenant",
    "manual_suppression", "dnc", "compliance_terminal", "unsubscribe",
  ]) {
    assert.equal(shouldKeepNurtureFollowUps({ reason, keep_nurture_follow_ups: true }), false, reason);
  }
  assert.equal(shouldKeepNurtureFollowUps({ reason: "not_interested" }), true);
  assert.equal(shouldKeepNurtureFollowUps({ reason: "not_interested", keep_nurture_follow_ups: true }), true);
  assert.equal(shouldKeepNurtureFollowUps({}), true);
  assert.equal(shouldKeepNurtureFollowUps({ reason: "not_interested", keep_nurture_follow_ups: false }), false);
});
