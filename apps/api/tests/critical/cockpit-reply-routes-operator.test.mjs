/**
 * Review task_96738436 F1 (REQUEST CHANGES on 18ca2379).
 *
 * Cockpit Queue reply, Auto reply, Schedule reply and Bulk follow-up called
 * runInboxAction with no operator, so every row they wrote recorded
 * operator_id null / operator_identity_missing true, and the content-filter
 * lock could not be cleared from those screens. The routes now pass
 * auth.operator (the same pattern as send-now).
 *
 * These tests call each ROUTE HANDLER with an authenticated operator session
 * and assert the row it writes records that operator; and that an
 * unauthenticated call is still refused (401) with no row written.
 * Nothing here sends anything: the queue insert is a fake, no dispatch runs.
 */

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { __setInboxActionDepsForTests } from "@/lib/cockpit/cockpit-service.js";
import { __setBulkFollowUpPlanForTests } from "@/lib/domain/inbox/bulk-follow-up-plan.js";
import { MANUAL_BURST_REASONS, OPERATOR_SEND_MARKER } from "@/lib/domain/inbox/manual-send-burst-guard.js";

const THREAD = "+15005550006";
const FROM = "+15005550088";
const OPERATOR_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "test";

let prevSecret;
beforeEach(() => {
  prevSecret = process.env.OPS_DASHBOARD_SECRET;
  process.env.OPS_DASHBOARD_SECRET = SECRET;
});
afterEach(() => {
  __setInboxActionDepsForTests(null);
  __setBulkFollowUpPlanForTests(null);
  delete globalThis.__rea_default_supabase_client__;
  if (prevSecret === undefined) delete process.env.OPS_DASHBOARD_SECRET;
  else process.env.OPS_DASHBOARD_SECRET = prevSecret;
});

// ── a permissive in-memory supabase (send_queue history + thread state) ──────

function parseOrFilter(filter) {
  const parts = String(filter).match(/[a-z0-9_]+\.eq\.("(?:[^"]|"")*"|[^,]+)/g) || [];
  return parts.map((p) => {
    const [col, , ...rest] = p.split(".");
    let val = rest.join(".");
    if (val.startsWith('"')) val = val.slice(1, -1).replaceAll('""', '"');
    return (row) => String(row?.[col] ?? "") === val;
  });
}

function makeFakeSupabase({ send_queue = [] } = {}) {
  const tables = { send_queue: send_queue.map((r) => ({ ...r })) };
  function builder(table) {
    const st = { op: "select", filters: [], ors: null, order: null, limit: null, patch: null };
    const run = () => {
      const source = tables[table];
      if (!source) return { data: [], error: null, count: 0 };
      let rows = source.filter((r) => st.filters.every((f) => f(r)));
      if (st.ors) rows = rows.filter((r) => st.ors.some((f) => f(r)));
      if (st.op === "update") {
        for (const r of rows) Object.assign(r, st.patch);
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
      select() { return b; },
      update(patch) { st.op = "update"; st.patch = patch; return b; },
      eq(col, val) { st.filters.push((r) => String(r?.[col] ?? "") === String(val)); return b; },
      in(col, vals) { st.filters.push((r) => vals.includes(r?.[col])); return b; },
      or(filter) { st.ors = parseOrFilter(filter); return b; },
      order(col, opts = {}) { st.order = { col, asc: opts.ascending !== false }; return b; },
      limit(n) { st.limit = n; return b; },
      maybeSingle: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: null };
      },
      single: async () => b.maybeSingle(),
      then(resolve, reject) {
        try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
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
  return { tables, from: (table) => builder(table) };
}

const ALL_FLAGS_ON = async () => ({
  automation_enabled: true,
  operator_send_enabled: true,
  outbound_sms_enabled: true,
  queue_runner_enabled: true,
  auto_reply_enabled: true,
  followup_enabled: true,
  feeder_enabled: true,
  queue_auto_enqueue_enabled: true,
});

/** The collaborators createInboxSendNowQueueRow needs, with a recording insert. */
function install(supabase) {
  const inserted = [];
  __setInboxActionDepsForTests({
    supabase,
    getFlags: ALL_FLAGS_ON,
    queueRowDeps: {
      getSystemValue: async () => null,
      loadOutboundNumberByPhone: async (phone) => ({ id: "fleet", phone_number: phone, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 }),
      resolveStickyThreadSenderImpl: async ({ proposed_from }) => ({ ok: true, phone: proposed_from, decision: "kept" }),
      hardComplianceCheckImpl: async () => ({ blocked: false }),
      canSendImpl: async () => ({ ok: true, reason: null }),
      checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
      recentDeliveryFailuresImpl: async () => ({ suppress: false }),
      manualOfferGuardImpl: async () => ({ mode: "off", decision: "off", record: null }),
      resolveOperatorAction: async () => ({ ok: true, operator_action_id: "opact-route" }),
      // A test seam can never supply the principal: the route's operator wins.
      operator: { kind: "forged", authenticated: true, id: "forged-by-seam" },
      insertImpl: async (payload) => {
        inserted.push(payload);
        const row = { id: `row-${inserted.length}`, created_at: new Date().toISOString(), ...payload };
        supabase.tables.send_queue.push(row);
        return { ok: true, queue_row_id: row.id, queue_id: row.id, raw: { ...row } };
      },
    },
  });
  return inserted;
}

function tomorrowNoonCentralUtc() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setUTCHours(18, 0, 0, 0); // 12:00 CT, inside 9AM-8PM
  return d.toISOString();
}

const BODY = Object.freeze({
  thread_key: THREAD,
  to_phone_number: THREAD,
  from_phone_number: FROM,
  message_body: "Hi there, are you still open to an offer on the property?",
  dry_run: false,
  timezone: "America/Chicago",
  contact_window: "9AM-8PM CT",
});

function request(path, body, { authenticated = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (authenticated) {
    headers["x-ops-dashboard-secret"] = SECRET;
    headers["x-ops-user-id"] = OPERATOR_ID;
  }
  return new Request(`http://localhost:3000${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const SINGLE_ROUTES = [
  ["queue-reply", "@/app/api/cockpit/inbox/queue-reply/route.js", () => ({ ...BODY })],
  ["auto-reply", "@/app/api/cockpit/inbox/auto-reply/route.js", () => ({ ...BODY })],
  ["schedule-reply", "@/app/api/cockpit/inbox/schedule-reply/route.js", () => ({ ...BODY, scheduled_for: tomorrowNoonCentralUtc() })],
];

test("F1: queue-reply, auto-reply and schedule-reply routes record the logged-in operator on the row", async () => {
  for (const [name, mod, body] of SINGLE_ROUTES) {
    const supabase = makeFakeSupabase();
    const inserted = install(supabase);
    const route = await import(mod);
    const res = await route.POST(request(`/api/cockpit/inbox/${name}`, body()));
    const json = await res.json();
    assert.equal(res.status, 200, `${name}: ${JSON.stringify(json)}`);
    assert.equal(json.ok, true, name);
    assert.equal(inserted.length, 1, `${name}: one row`);
    const md = inserted[0].metadata;
    assert.equal(md.operator_id, OPERATOR_ID, `${name}: the route's operator, not null and not the seam's`);
    assert.equal(md.manual_send_operator.source, "server_operator_principal", name);
    assert.equal("operator_identity_missing" in md, false, name);
    assert.equal(md[OPERATOR_SEND_MARKER], true, name);
  }
});

test("F1: bulk follow-up records the logged-in operator on every scheduled row", async () => {
  const supabase = makeFakeSupabase();
  globalThis.__rea_default_supabase_client__ = supabase;
  const inserted = install(supabase);
  const scheduled_for = tomorrowNoonCentralUtc();
  __setBulkFollowUpPlanForTests(async () => ({
    ok: true,
    label: "Conversation Restart",
    eligible_count: 1,
    recipients: [{
      eligible: true,
      thread_key: THREAD,
      from_phone_number: FROM,
      message_body: "Hi Maria, just checking back in about the house on Main St.",
      schedule: { scheduled_for_utc: scheduled_for, timezone: "America/Chicago" },
      template_id: "tpl-1",
      seller_name: "Maria",
      agent_name: "Alex",
      property_address: "1 Main St",
    }],
  }));
  // The window the schedule resolves against (as recorded on an earlier row).
  supabase.tables.send_queue.push({ id: "old", thread_key: THREAD, to_phone_number: THREAD, queue_status: "sent", timezone: "America/Chicago", contact_window: "9AM-8PM CT", message_body: "an old unrelated note", created_at: new Date(Date.now() - 3 * 86400_000).toISOString() });
  const route = await import("@/app/api/cockpit/inbox/bulk-follow-up/route.js");
  const res = await route.POST(request("/api/cockpit/inbox/bulk-follow-up", { mode: "schedule", thread_keys: [THREAD] }));
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.scheduled_count, 1, JSON.stringify(json.results));
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].metadata.operator_id, OPERATOR_ID);
  assert.equal(inserted[0].metadata.manual_send_operator.source, "server_operator_principal");
});

test("F1: the lock can now be cleared from Queue reply by the logged-in operator (and still not without a reason)", async () => {
  const blocked = { id: "cf1", thread_key: THREAD, to_phone_number: THREAD, from_phone_number: FROM, queue_status: "failed", message_body: "original filtered wording", created_at: new Date(Date.now() - 5 * 60_000).toISOString(), metadata: { failure_class: "content_filter_blocked" } };
  const route = await import("@/app/api/cockpit/inbox/queue-reply/route.js");

  const s1 = makeFakeSupabase({ send_queue: [blocked] });
  const i1 = install(s1);
  const locked = await (await route.POST(request("/api/cockpit/inbox/queue-reply", { ...BODY }))).json();
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, MANUAL_BURST_REASONS.CONTENT_FILTER_LOCKED);
  assert.equal(i1.length, 0);

  const s2 = makeFakeSupabase({ send_queue: [blocked] });
  const i2 = install(s2);
  const cleared = await (await route.POST(request("/api/cockpit/inbox/queue-reply", { ...BODY, content_filter_lock_clearance: { reason: "Reviewed the thread; plain wording, no link." } }))).json();
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(i2[0].metadata.content_filter_lock_clearance.actor, OPERATOR_ID);
});

test("F1: an unauthenticated call to each route is refused (401) and writes nothing, as today", async () => {
  const routes = [
    ...SINGLE_ROUTES.map(([name, mod, body]) => [name, mod, body()]),
    ["bulk-follow-up", "@/app/api/cockpit/inbox/bulk-follow-up/route.js", { mode: "schedule", thread_keys: [THREAD] }],
  ];
  for (const [name, mod, body] of routes) {
    const supabase = makeFakeSupabase();
    const inserted = install(supabase);
    let planned = 0;
    __setBulkFollowUpPlanForTests(async () => { planned += 1; return { ok: false, error: "should_not_run" }; });
    const route = await import(mod);
    const res = await route.POST(request(`/api/cockpit/inbox/${name}`, body, { authenticated: false }));
    assert.equal(res.status, 401, name);
    assert.equal(inserted.length, 0, `${name}: no row`);
    assert.equal(planned, 0, `${name}: nothing planned`);
  }
});

test("F1 wiring: each route passes the server principal (auth.operator), never a payload field", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/app/api/cockpit/inbox");
  for (const name of ["queue-reply", "auto-reply", "schedule-reply", "bulk-follow-up", "send-now"]) {
    const src = fs.readFileSync(path.join(root, name, "route.js"), "utf8");
    assert.match(src, /operator(: auth\.operator| = auth\.operator)/, name);
    assert.doesNotMatch(src, /payload\.operator/, name);
  }
});
