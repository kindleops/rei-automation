import test from "node:test";
import assert from "node:assert/strict";

import { describeCampaignLineage, explicitPropertyIds } from "@/lib/domain/campaigns/campaign-lineage.js";
import { compactLiveQueue } from "@/lib/domain/campaigns/campaign-live-queue.js";
import { listCampaigns } from "@/lib/domain/campaigns/campaign-automation-service.js";
import {
  COCKPIT_CONTROL_KEYS,
  OVERDUE_GRACE_MS,
  TARGET_PAGE_MAX,
  buildCampaignCockpit,
  buildCampaignCohortPoints,
  buildCampaignMarketIndex,
  buildCampaignTargetPage,
  clampTargetPage,
  isProofQueueRow,
  sanitizeTargetSearch,
  summarizeActiveQueue,
} from "@/lib/domain/campaigns/campaign-cockpit.js";

/**
 * CAMPAIGN COCKPIT READ — the desktop operating room's one detail read.
 *
 * The data below is production's shape on 2026-09-30 10:38Z, read-only:
 * "Map area · Minneapolis, MN · 944 properties" — 563 targets (487 planned,
 * 60 held, 16 ready), 160 live rows queued and due since 13:00Z the day
 * before, 50 of them released with logical_communication_store_error, two
 * Minneapolis numbers carrying it, the contact window closed (05:38 CDT).
 */

const CAMPAIGN_ID = "7f2ba659-16ad-463b-851d-3381c81e2e38";
const NOW = "2026-09-30T10:38:38.000Z";
const SECRET_KEY = "queue_engine_shared_secret";

const minneapolis = {
  id: CAMPAIGN_ID,
  name: "Map area · Minneapolis, MN · 944 properties",
  status: "active",
  daily_cap: 750,
  total_cap: 1000,
  batch_max: 50,
  market_cap: 400,
  per_sender_cap: 800,
  send_interval_seconds: 45,
  contact_window_start: "08:00",
  contact_window_end: "21:00",
  auto_queue_enabled: true,
  auto_send_enabled: false,
  auto_reply_mode: "disabled",
  emergency_stop_at: null,
  scheduled_for: "2026-09-29T13:00:00Z",
  activated_at: "2026-09-28T14:35:33Z",
  paused_at: "2026-09-28T20:04:13Z",
  resumed_at: "2026-09-28T14:47:08Z",
  completed_at: null,
  execution_heartbeat_at: "2026-09-30T10:35:08Z",
  created_at: "2026-09-28T12:20:21Z",
  updated_at: "2026-09-30T10:35:08Z",
  last_transition_reason: "operator: resume now to test improved templates",
  last_transition_at: "2026-09-28T20:05:00Z",
  metadata: {
    source: "map_area",
    area: { bbox: [-93.3198, 44.9755, -93.2726, 45.0633], label: null, vertices: 68, truncated: false, property_count: 944 },
    timezone: "America/Chicago",
    launch_timezone: "America/Chicago",
    stage_code: "S1",
    template_use_case: "ownership_check",
    campaign_type: "outbound_sms",
    feeder_last: {
      at: "2026-09-30T10:35:08.043Z", bound: "buffer_full", reason: "buffer_full", stalled: false, inserted: 0,
      ready_remaining: 16, active_live_rows: 160, last_refill_at: "2026-09-29T01:45:50.288Z", skipped_counts_by_reason: {},
    },
    target_filters: {
      phones: [], outreach: [], prospects: [],
      properties: [{ value: Array.from({ length: 944 }, (_, i) => String(273000000 + i)), domain: "properties", category: "", operator: "in", field_key: "properties.property_id" }],
      filter_mode: "grouped_source_of_truth_domains",
    },
  },
};

const controls = [
  { key: "queue_processor_mode", value: "live" },
  { key: "queue_execution_mode", value: "normal" },
  { key: "queue_auto_send_enabled", value: "true" },
  { key: "queue_auto_enqueue_enabled", value: "true" },
  { key: "outbound_sms_enabled", value: "true" },
  { key: "queue_emergency_stop_at", value: "" },
  { key: "queue_processor_heartbeat_at", value: "2026-09-30T10:38:08.550Z" },
  { key: "queue_processor_last_claimed_at", value: "2026-09-30T01:59:42.848Z" },
  { key: "campaign_feeder_heartbeat_at", value: "2026-09-30T10:35:10.978Z" },
  { key: "campaign_feeder_last_batch_at", value: "2026-09-29T01:45:52.142Z" },
  { key: "queue_per_number_cap", value: "800" },
  { key: "queue_contact_window_start", value: "08:00" },
  { key: "queue_contact_window_end", value: "21:00" },
  { key: "sms_blocked_sender_numbers", value: "+13235589881,+19804589889" },
  { key: SECRET_KEY, value: "must-never-leave-the-server" },
];

function activeRows() {
  const rows = [];
  for (let i = 0; i < 160; i += 1) {
    const at = new Date(Date.parse("2026-09-29T13:00:00Z") + i * 34_000).toISOString();
    rows.push({
      id: `q-${String(i).padStart(4, "0")}`,
      campaign_id: CAMPAIGN_ID,
      queue_status: "queued",
      scheduled_for: at,
      from_phone_number: i % 2 ? "+16125092623" : "+16125092382",
      updated_at: "2026-09-30T01:59:42.938Z",
      skip_reason: i < 50 ? "logical_communication_store_error" : null,
      no_send: "false",
      proof_no_send: null,
      launch_mode: "guarded_live_queue_creation",
      spam_retry_generation: "1",
      // The processor re-claimed the first 50 every minute; the rest never.
      processing_started_at: i < 50 ? "2026-09-30T01:59:42.345815+00:00" : null,
      finalized_at: i < 50 ? "2026-09-30T01:59:07.291Z" : "2026-09-29T01:59:18.247Z",
    });
  }
  // A proof row is never a live queue row (the feeder's own test).
  rows.push({ id: "proof-1", campaign_id: CAMPAIGN_ID, queue_status: "queued", scheduled_for: "2026-09-29T13:00:00Z", from_phone_number: "+16125092382", no_send: "true", launch_mode: "proof_hydration_no_send" });
  return rows;
}

function eventRows() {
  const rows = [
    { id: "e1", campaign_id: CAMPAIGN_ID, event_type: "campaign.activated", severity: "success", title: "Campaign activated", description: null, created_at: "2026-09-28T14:35:33Z" },
    { id: "e2", campaign_id: CAMPAIGN_ID, event_type: "campaign.targets_built", severity: "success", title: "Targets built", description: null, created_at: "2026-09-28T12:20:42Z" },
    { id: "e3", campaign_id: CAMPAIGN_ID, event_type: "campaign.launch_scheduled", severity: "success", title: "Campaign launch planned", description: "100 queue rows created.", created_at: "2026-09-29T01:45:50Z", "metadata->>send_queue_rows_created": "100", rows_created: "100" },
  ];
  for (let i = 0; i < 7; i += 1) {
    rows.push({ id: `idle-${i}`, campaign_id: CAMPAIGN_ID, event_type: "campaign.launch_scheduled", severity: "success", title: "Campaign launch planned", created_at: `2026-09-30T10:${String(5 + i * 5).padStart(2, "0")}:00Z`, "metadata->>send_queue_rows_created": "0", rows_created: "0" });
  }
  return rows;
}

function targetRows() {
  const rows = [];
  const push = (n, status, extra = {}) => {
    for (let i = 0; i < n; i += 1) rows.push({ id: `t-${status}-${String(i).padStart(4, "0")}`, campaign_id: CAMPAIGN_ID, target_status: status, market: "Minneapolis, MN", state: "MN", ...extra });
  };
  // Production: 392 planned targets still carry an advisory block_reason.
  push(392, "planned", { block_reason: "insufficient_template_rotation_pool:auto:0<2" });
  push(95, "planned");
  push(49, "blocked", { block_reason: "entity_contact_requires_review" });
  push(11, "blocked", { block_reason: "missing_identity_linkage" });
  push(16, "ready");
  return rows;
}

/**
 * PostgREST-shaped fake. Filters: eq/neq/in/not(is null)/gt/gte; order;
 * limit; range with an exact count; head counts; maybeSingle; the two
 * read-only aggregate RPCs. Any write method throws — the read must never
 * reach one.
 */
function fakeSupabase(tables, { failTables = [], rowCap = Infinity } = {}) {
  const calls = [];
  const writes = [];
  function from(table) {
    const state = { table, columns: null, options: null, filters: [], orders: [], limit: null };
    calls.push(state);
    const matches = () => {
      let out = (tables[table] || []).filter((row) => state.filters.every(([op, column, value]) => {
        const v = row[column];
        if (op === "eq") return v === value;
        if (op === "neq") return v !== value;
        if (op === "in") return value.includes(v);
        if (op === "notnull") return v !== null && v !== undefined;
        if (op === "gt") return v !== null && v !== undefined && String(v) > String(value);
        if (op === "gte") return v !== null && v !== undefined && String(v) >= String(value);
        return true;
      }));
      for (const { column, ascending } of [...state.orders].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[column] ?? null;
          const bv = b[column] ?? null;
          if (av === bv) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      return out;
    };
    const failing = () => failTables.includes(table);
    const chain = {
      select(columns, options) { state.columns = columns; state.options = options ?? null; return chain; },
      eq(column, value) { state.filters.push(["eq", column, value]); return chain; },
      neq(column, value) { state.filters.push(["neq", column, value]); return chain; },
      in(column, values) { state.filters.push(["in", column, values]); return chain; },
      not(column, op, value) { if (op === "is" && value === null) state.filters.push(["notnull", column]); return chain; },
      gt(column, value) { state.filters.push(["gt", column, value]); return chain; },
      gte(column, value) { state.filters.push(["gte", column, value]); return chain; },
      filter(column, op, value) { if (op === "eq") state.filters.push(["eq", column, value]); return chain; },
      or(expr) { state.or = expr; return chain; },
      order(column, opts = {}) { state.orders.push({ column, ascending: opts.ascending !== false }); return chain; },
      limit(n) { state.limit = n; return chain; },
      async range(fromIndex, toIndex) {
        state.range = [fromIndex, toIndex];
        if (failing()) return { data: null, error: new Error(`${table} unavailable`), count: null };
        const all = matches();
        const size = Math.min(toIndex - fromIndex + 1, rowCap);
        return { data: all.slice(fromIndex, fromIndex + size), count: state.options?.count === "exact" ? all.length : null, error: null };
      },
      async maybeSingle() {
        if (failing()) return { data: null, error: new Error(`${table} unavailable`) };
        return { data: matches()[0] ?? null, error: null };
      },
      insert() { writes.push(["insert", table]); throw new Error("write attempted"); },
      update() { writes.push(["update", table]); throw new Error("write attempted"); },
      upsert() { writes.push(["upsert", table]); throw new Error("write attempted"); },
      delete() { writes.push(["delete", table]); throw new Error("write attempted"); },
      then(resolve, reject) {
        if (failing()) return Promise.resolve({ data: null, count: null, error: new Error(`${table} unavailable`) }).then(resolve, reject);
        const all = matches();
        const result = state.options?.head
          ? { data: null, count: all.length, error: null }
          : { data: state.limit != null ? all.slice(0, state.limit) : all, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  async function rpc(name, args) {
    calls.push({ rpc: name, args });
    const ids = args?.p_campaign_ids || [];
    if (name === "campaign_target_status_counts") {
      const groups = new Map();
      for (const row of tables.campaign_targets || []) {
        if (!ids.includes(row.campaign_id)) continue;
        const key = `${row.campaign_id}|${row.target_status}|${row.block_reason || ""}`;
        const g = groups.get(key) || { campaign_id: row.campaign_id, target_status: row.target_status, block_reason: row.block_reason || null, row_count: 0 };
        g.row_count += 1;
        groups.set(key, g);
      }
      return { data: [...groups.values()], error: null };
    }
    if (name === "campaign_send_state_counts") {
      const groups = new Map();
      for (const row of tables.send_queue || []) {
        if (!ids.includes(row.campaign_id)) continue;
        const key = `${row.campaign_id}|${row.queue_status}`;
        const g = groups.get(key) || { campaign_id: row.campaign_id, queue_status: row.queue_status, row_count: 0 };
        g.row_count += 1;
        groups.set(key, g);
      }
      return { data: [...groups.values()], error: null };
    }
    writes.push(["rpc", name]);
    throw new Error(`unexpected rpc ${name}`);
  }
  return { from, rpc, calls, writes };
}

function minneapolisTables() {
  const sent = [];
  for (let i = 0; i < 283; i += 1) sent.push({ id: `d-${i}`, campaign_id: CAMPAIGN_ID, queue_status: "delivered", from_phone_number: i % 2 ? "+16125092623" : "+16125092382", sent_at: `2026-09-28T${String(15 + (i % 9)).padStart(2, "0")}:00:00Z`, updated_at: "2026-09-29T00:30:00Z" });
  for (let i = 0; i < 182; i += 1) sent.push({ id: `ft-${i}`, campaign_id: CAMPAIGN_ID, queue_status: "failed_transport", from_phone_number: "+16128060495", sent_at: "2026-09-28T19:00:00Z", updated_at: "2026-09-29T00:30:48Z" });
  return {
    campaigns: [minneapolis],
    system_control: controls,
    campaign_targets: targetRows(),
    send_queue: [...activeRows(), ...sent],
    campaign_events: eventRows(),
    email_queue: [],
    email_senders: [],
    textgrid_numbers: [
      { phone_number: "+16125092382", friendly_name: "MINNEAPOLIS 2", market: "Minneapolis, MN", status: "active", health_state: "unverified", health_reason: "no_structured_health_evidence", daily_limit: 800, last_used_at: "2026-09-29T00:33:19Z" },
      { phone_number: "+16125092623", friendly_name: "MINNEAPOLIS 3", market: "Minneapolis, MN", status: "active", health_state: "unverified", daily_limit: 800 },
      { phone_number: "+16128060495", friendly_name: "MINNEAPOLIS", market: "Minneapolis, MN", status: "active", health_state: "unverified", daily_limit: 800 },
      { phone_number: "+13235589881", friendly_name: "LOS ANGELES-#4", market: "Los Angeles, CA", status: "active" },
    ],
  };
}

const stubReads = {
  fetchResponses: async () => ({ ok: true, sellers_messaged: 300, sellers_replied: 18, reply_messages: 25, sellers_asked_to_stop: 5, latest_reply_at: "2026-09-29T02:00:00Z", truncated: false, intents: { not_interested: 7 }, latest: [] }),
  fetchFailures: async () => ({ ok: true, run_id: null, execution: { total: 188, truncated: false, groups: [{ failure_category: "undelivered", count: 182 }] }, target_preparation: { total: 60, truncated: false, groups: [] } }),
};

// ── lineage ────────────────────────────────────────────────────────────────

test("lineage: a Map-area campaign's cohort is its pinned id list and area summary, never its name", () => {
  const lineage = describeCampaignLineage({ ...minneapolis, name: "Renamed by an operator" });
  assert.equal(lineage.kind, "map_area");
  assert.equal(lineage.explicit_property_count, 944);
  assert.deepEqual(lineage.area.bbox, [-93.3198, 44.9755, -93.2726, 45.0633]);
  assert.equal(lineage.area.vertices, 68);
  assert.equal(lineage.area.property_count, 944);
  assert.equal(lineage.area.polygon_stored, false, "only the bbox + vertex count are stored — the outline itself is not");
  assert.equal(lineage.filters.length, 0, "the pinned id list is the cohort, not a filter dimension");
  assert.equal(lineage.timezone, "America/Chicago");
  assert.equal(lineage.channel, "sms");
});

test("lineage: Entity Graph selection, field filters, and nothing at all", () => {
  const eg = describeCampaignLineage({ metadata: { source: "entity_graph", handoff_mode: "selection", target_filters: { properties: [{ field_key: "properties.property_id", operator: "in", value: ["1", "2", "2", ""] }] } } });
  assert.equal(eg.kind, "entity_graph");
  assert.equal(eg.explicit_property_count, 2, "de-duplicated, blanks dropped");
  assert.equal(eg.handoff_mode, "selection");
  assert.equal(eg.area, null);

  const filtered = describeCampaignLineage({
    name: "Tax Delinquent - Poor and Unsound",
    metadata: { target_filters: { properties: [
      { field_key: "properties.property_type", operator: "is_any_of", category: "Asset Type & Structure", value: ["SFR", "Multifamily 2-4", "Multifamily 5+"] },
      { field_key: "properties.tax_delinquent", operator: "is_true", value: true },
      { field_key: "properties.market", operator: "is_any_of", value: ["Los Angeles, CA"] },
    ] }, launch_timezone: "America/Los_Angeles" },
  });
  assert.equal(filtered.kind, "filters");
  assert.equal(filtered.filters.length, 3);
  assert.deepEqual(filtered.filters[0].value, { kind: "list", count: 3, sample: ["SFR", "Multifamily 2-4", "Multifamily 5+"] });
  assert.deepEqual(filtered.market_values, ["Los Angeles, CA"]);
  assert.equal(filtered.timezone, "America/Los_Angeles", "falls back to launch_timezone");

  const none = describeCampaignLineage({ name: "Map area · Atlanta, GA · 220 properties", metadata: {} });
  assert.equal(none.kind, "none", "a name that says 'Map area' is not a source");
  assert.equal(none.explicit_property_count, null);
  assert.deepEqual(explicitPropertyIds(null), []);
});

// ── the live queue ─────────────────────────────────────────────────────────

test("queue summary: proof rows are counted apart, overdue needs the grace, release reasons are tallied", () => {
  const nowMs = Date.parse(NOW);
  const rows = activeRows();
  rows.push({ id: "future", queue_status: "scheduled", scheduled_for: "2026-09-30T13:00:00Z", from_phone_number: "+16125092382", no_send: "false" });
  rows.push({ id: "just-due", queue_status: "queued", scheduled_for: new Date(nowMs - OVERDUE_GRACE_MS + 60_000).toISOString(), no_send: "false" });
  const q = summarizeActiveQueue(rows, nowMs);
  assert.equal(q.proof, 1);
  assert.equal(q.live, 162);
  assert.equal(q.due, 161);
  assert.equal(q.overdue, 160, "a row one minute inside the grace is due, not overdue");
  assert.equal(q.oldest_due_at, "2026-09-29T13:00:00.000Z");
  assert.equal(q.next_scheduled_at, "2026-09-30T13:00:00.000Z");
  assert.equal(q.release_reasons.logical_communication_store_error, 50);
  assert.equal(q.spam_retries, 160);
  assert.equal(q.by_sender["+16125092382"], 81);
  assert.equal(q.by_sender["+16125092623"], 80);
  assert.equal(q.last_claimed_at, "2026-09-30T01:59:42.345Z", "when the processor last picked one up");
  assert.equal(q.last_released_at, "2026-09-30T01:59:07.291Z");
  assert.equal(q.last_release_reason, "logical_communication_store_error", "and why it put one back");
});

test("proof test is the feeder's: no_send ?? proof_no_send, or the proof launch mode", () => {
  assert.equal(isProofQueueRow({ no_send: "true" }), true);
  assert.equal(isProofQueueRow({ no_send: null, proof_no_send: "true" }), true);
  assert.equal(isProofQueueRow({ no_send: "false", proof_no_send: "true" }), false, "an explicit no_send=false wins, as in countActiveLiveQueueRows");
  assert.equal(isProofQueueRow({ launch_mode: "proof_hydration_no_send" }), true);
  assert.equal(isProofQueueRow({}), false);
});

// ── the cockpit read ───────────────────────────────────────────────────────

test("cockpit: composes the operating room for Minneapolis without a single write", async () => {
  const db = fakeSupabase(minneapolisTables());
  const out = await buildCampaignCockpit(CAMPAIGN_ID, { supabase: db, now: NOW, ...stubReads });

  assert.equal(out.ok, true);
  assert.deepEqual(db.writes, [], "no insert / update / upsert / delete / write rpc");
  assert.deepEqual(out.unavailable, []);

  // lineage + lifecycle
  assert.equal(out.lineage.kind, "map_area");
  assert.equal(out.lifecycle.activated_at, minneapolis.activated_at);

  // audience accounting from the aggregate RPC
  assert.equal(out.targets.total, 563);
  assert.equal(out.targets.held, 60);
  assert.equal(out.targets.ready, 16);
  assert.equal(out.targets.committed, 487);
  assert.deepEqual(out.targets.held_by_reason, { entity_contact_requires_review: 49, missing_identity_linkage: 11 },
    "a reason left on a planned target is not a hold");
  assert.deepEqual(out.targets.advisories, { planned: { "insufficient_template_rotation_pool:auto:0<2": 392 } });

  // provider truth, list semantics: sent = sent + delivered; failed = failed + failed_transport
  assert.equal(out.send_states.sent, 283);
  assert.equal(out.send_states.delivered, 283);
  assert.equal(out.send_states.failed, 182);

  // the live queue: 160 due since yesterday, all overdue, 50 released with a store error
  assert.equal(out.queue.live, 160);
  assert.equal(out.queue.proof, 1);
  assert.equal(out.queue.overdue, 160);
  assert.equal(out.queue.release_reasons.logical_communication_store_error, 50);
  assert.equal(out.queue.truncated, false);

  // pacing is the feeder's own resolveFeedLimit: 160 queued >= the 150 buffer
  assert.equal(out.feed.bound, "buffer_full");
  assert.equal(out.feed.limit, 0);
  assert.equal(out.feed.daily_remaining, 750 - 0 - 160);

  // the contact window, canonically, in the campaign's zone: closed at 05:38 CDT
  assert.equal(out.window.open, false);
  assert.equal(out.window.timezone, "America/Chicago");
  assert.equal(out.window.next_open_at, "2026-09-30T13:00:00.000Z");
  assert.equal(out.window.source, "campaign");

  // sends: nothing today (campaign-local), last message 2026-09-28
  assert.equal(out.sends.sent_today, 0);
  assert.equal(out.sends.day_timezone, "America/Chicago");
  assert.equal(out.sends.day_start, "2026-09-30T05:00:00.000Z");
  assert.equal(out.sends.last_sent_at, "2026-09-28T23:00:00Z");
  assert.equal(out.sends.failed_last_hour, 0);

  // processor + feeder heartbeats
  assert.equal(out.processor.mode, "live");
  assert.equal(out.processor.emergency_stop_at, null);
  assert.equal(out.feeder.heartbeat_at, "2026-09-30T10:35:10.978Z");
  assert.equal(out.feeder.campaign_last.bound, "buffer_full");

  // senders: the two carrying numbers first, the market's third number in the pool, an operator block flagged
  assert.deepEqual(out.senders.slice(0, 2).map((s) => [s.phone, s.carrying_campaign, s.campaign_queued]), [
    ["+16125092382", true, 80],
    ["+16125092623", true, 80],
  ]);
  const pool = out.senders.find((s) => s.phone === "+16128060495");
  assert.equal(pool.carrying_campaign, true, "it carried this campaign's earlier sends");
  assert.equal(pool.label, "MINNEAPOLIS");
  assert.equal(out.senders.some((s) => s.phone === "+13235589881"), false, "another market's number is not this campaign's");
  assert.equal(out.caps.configured_per_number_cap, 800);

  // email is its own channel, never merged into SMS health
  assert.deepEqual(out.email, { campaign_rows: 0, sender_identities: 0 });

  // timeline: operational events + real refills; the feeder's no-op checks collapse to a count
  assert.deepEqual(out.timeline.events.map((e) => e.type), ["campaign.launch_scheduled", "campaign.activated", "campaign.targets_built"]);
  assert.equal(out.timeline.events[0].rows_created, 100);
  assert.deepEqual(out.timeline.idle_feeder_checks, { count: 7, last_at: "2026-09-30T10:35:00Z" });

  // geography from the targets themselves
  assert.deepEqual(out.geography.markets, [{ market: "Minneapolis, MN", state: "MN", targets: 563 }]);
  assert.equal(out.responses.sellers_replied, 18);
  assert.equal(out.exceptions.execution.total, 188);
});

test("cockpit: system_control is read by allowlist only — credentials never leave the server", async () => {
  const db = fakeSupabase(minneapolisTables());
  const out = await buildCampaignCockpit(CAMPAIGN_ID, { supabase: db, now: NOW, ...stubReads });
  const read = db.calls.find((c) => c.table === "system_control");
  const keys = read.filters.find(([op, column]) => op === "in" && column === "key")?.[2];
  assert.ok(Array.isArray(keys), "system_control is filtered by key, never select('*') over the table");
  assert.equal(keys.some((k) => /secret|token|password|key$/i.test(k)), false);
  assert.deepEqual([...keys].sort(), [...COCKPIT_CONTROL_KEYS].sort());
  assert.equal(JSON.stringify(out).includes("must-never-leave-the-server"), false);
});

test("cockpit: an unreadable section is named in `unavailable`, never reported as zero", async () => {
  const db = fakeSupabase(minneapolisTables(), { failTables: ["textgrid_numbers", "email_senders"] });
  const out = await buildCampaignCockpit(CAMPAIGN_ID, {
    supabase: db,
    now: NOW,
    fetchResponses: async () => { throw new Error("message_events timed out"); },
    fetchFailures: stubReads.fetchFailures,
  });
  assert.equal(out.ok, true);
  assert.deepEqual([...out.unavailable].sort(), ["email", "responses", "senders"]);
  assert.equal(out.responses, null, "replies unknown, not 0 replies");
  assert.equal(out.email.sender_identities, null);
  assert.equal(out.email.campaign_rows, 0, "the readable half still answers");
  assert.equal(out.queue.live, 160, "one failed section does not take the others down");
  assert.equal(out.senders.every((s) => s.known === false), true, "numbers without a readable fleet row are marked unknown");
});

test("cockpit: an answered-but-not-ok read is unavailable too; a missing campaign is a 404", async () => {
  const db = fakeSupabase(minneapolisTables());
  const out = await buildCampaignCockpit(CAMPAIGN_ID, { supabase: db, now: NOW, fetchResponses: async () => ({ ok: false, error: "x" }), fetchFailures: stubReads.fetchFailures });
  assert.ok(out.unavailable.includes("responses"));
  assert.equal(out.responses, null);

  const missing = await buildCampaignCockpit("00000000-0000-4000-8000-000000000000", { supabase: db, now: NOW, ...stubReads });
  assert.deepEqual(missing, { ok: false, status: 404, error: "campaign_not_found" });
});

test("cockpit: the live-queue scan pages past a server row cap instead of truncating silently", async () => {
  const db = fakeSupabase(minneapolisTables(), { rowCap: 40 });
  const out = await buildCampaignCockpit(CAMPAIGN_ID, { supabase: db, now: NOW, ...stubReads });
  // 5 pages x 40 rows = 200 >= 161 active rows: complete, and exact.
  assert.equal(out.queue.live, 160);
  assert.equal(out.queue.truncated, false);
  const capped = fakeSupabase(minneapolisTables(), { rowCap: 20 });
  const partial = await buildCampaignCockpit(CAMPAIGN_ID, { supabase: capped, now: NOW, ...stubReads });
  assert.equal(partial.queue.truncated, true, "a page ceiling reached is reported, not passed off as the total");
});

// ── targets page ───────────────────────────────────────────────────────────

test("targets page: size is capped, search is words not a filter, 'held' means blocked", () => {
  assert.deepEqual(clampTargetPage({ page: "0", pageSize: "500" }), { page: 1, pageSize: TARGET_PAGE_MAX });
  assert.deepEqual(clampTargetPage({ page: "3", pageSize: "5" }), { page: 3, pageSize: 10 });
  assert.equal(sanitizeTargetSearch("Lewis),target_status.eq.ready,(x*"), "Lewis target_status.eq.ready x");
  assert.equal(sanitizeTargetSearch("a".repeat(200)).length, 80);
});

test("targets page: latest LIVE row is the state; a reply counts only to the sender, after the send", async () => {
  const T1 = "11111111-1111-4111-8111-111111111111";
  const T2 = "22222222-2222-4222-8222-222222222222";
  const tables = {
    campaign_targets: [
      { id: T1, campaign_id: CAMPAIGN_ID, owner_name: "Rachel Lewis", property_address: "1 Main St", to_phone_number: "+17152225733", target_status: "planned", priority_score: 90, market: "Minneapolis, MN" },
      { id: T2, campaign_id: CAMPAIGN_ID, owner_name: "Held Owner", property_address: "2 Main St", to_phone_number: "+17150000000", target_status: "blocked", block_reason: "entity_contact_requires_review", priority_score: 80 },
    ],
    send_queue: [
      { id: "old", campaign_id: CAMPAIGN_ID, campaign_target_id: T1, queue_status: "failed_transport", sent_at: "2026-09-28T19:00:00Z", from_phone_number: "+16125092382", to_phone_number: "+17152225733", created_at: "2026-09-28T18:00:00Z", failed_reason: "delivery_failed", thread_key: "th-1" },
      { id: "retry", campaign_id: CAMPAIGN_ID, campaign_target_id: T1, queue_status: "queued", scheduled_for: "2026-09-29T13:17:15Z", from_phone_number: "+16125092382", to_phone_number: "+17152225733", created_at: "2026-09-29T00:52:00Z", skip_reason: "logical_communication_store_error" },
      { id: "proof", campaign_id: CAMPAIGN_ID, campaign_target_id: T1, queue_status: "queued", created_at: "2026-09-30T00:00:00Z", no_send: "true" },
    ],
    message_events: [
      // Before the send: not a reply to this campaign.
      { direction: "inbound", from_phone_number: "+17152225733", to_phone_number: "+16125092382", created_at: "2026-09-28T10:00:00Z", detected_intent: "unclear", thread_key: "th-1" },
      // To a different number: not a reply to this campaign's message.
      { direction: "inbound", from_phone_number: "+17152225733", to_phone_number: "+19999999999", created_at: "2026-09-28T20:00:00Z", detected_intent: "asks_offer" },
      { direction: "inbound", from_phone_number: "+17152225733", to_phone_number: "+16125092382", created_at: "2026-09-28T21:00:00Z", detected_intent: "not_interested", is_opt_out: false, thread_key: "th-1" },
    ],
  };
  const db = fakeSupabase(tables);
  const out = await buildCampaignTargetPage(CAMPAIGN_ID, { page: 1, pageSize: 50, status: "all" }, { supabase: db });
  assert.equal(out.ok, true);
  assert.deepEqual(db.writes, []);
  assert.equal(out.total, 2);
  const [first, held] = out.targets;
  assert.equal(first.seller, "Rachel Lewis");
  assert.equal(first.queue.id, "retry", "the newest live row — never the proof row");
  assert.equal(first.queue.reason, "logical_communication_store_error");
  assert.equal(first.queue_rows, 2);
  assert.equal(first.proof_rows, 1);
  assert.equal(first.reply.intent, "not_interested");
  assert.equal(first.reply.messages, 1, "the pre-send and wrong-number messages are not replies");
  assert.equal(first.thread_key, "th-1");
  assert.equal(held.block_reason, "entity_contact_requires_review");
  assert.equal(held.queue, null);
  assert.equal(held.reply, null);

  const heldOnly = await buildCampaignTargetPage(CAMPAIGN_ID, { status: "held" }, { supabase: fakeSupabase(tables) });
  assert.deepEqual(heldOnly.targets.map((t) => t.id), [T2]);
  assert.equal(heldOnly.status, "blocked");
});

// ── cohort points ──────────────────────────────────────────────────────────

test("cohort points: a pinned id list is the source cohort; a filter campaign falls back to its audience", async () => {
  const ids = Array.from({ length: 450 }, (_, i) => String(1000 + i));
  const properties = ids.map((id, i) => ({ property_id: id, latitude: i === 0 ? null : 44.98 + i / 1e4, longitude: -93.3, property_address_full: `${id} Elm St` }));
  const pinned = { id: CAMPAIGN_ID, name: "EG", metadata: { source: "entity_graph", target_filters: { properties: [{ field_key: "properties.property_id", value: ids }] } } };
  const db = fakeSupabase({ campaigns: [pinned], properties });
  const out = await buildCampaignCohortPoints(CAMPAIGN_ID, { supabase: db });
  assert.equal(out.basis, "source_cohort");
  assert.equal(out.total_ids, 450);
  assert.equal(out.located, 449);
  assert.equal(out.missing, 1, "a property without coordinates is counted, never placed");
  const propertyReads = db.calls.filter((c) => c.table === "properties");
  assert.equal(propertyReads.length, 3, "ids are looked up in bounded chunks");
  assert.deepEqual(db.writes, []);

  const filtered = { id: CAMPAIGN_ID, name: "Tax", metadata: { target_filters: { properties: [{ field_key: "properties.tax_delinquent", value: true }] } } };
  const db2 = fakeSupabase({ campaigns: [filtered], campaign_targets: [{ id: "t1", campaign_id: CAMPAIGN_ID, property_id: "1000" }, { id: "t2", campaign_id: CAMPAIGN_ID, property_id: "1000" }], properties });
  const aud = await buildCampaignCohortPoints(CAMPAIGN_ID, { supabase: db2 });
  assert.equal(aud.basis, "audience");
  assert.equal(aud.total_ids, 1, "one property, however many targets it produced");
});

// ── routes ─────────────────────────────────────────────────────────────────

test("routes: authenticated, and a non-UUID id is refused before any read", async () => {
  // The gate is only enforced when OPS_DASHBOARD_SECRET is configured (outside
  // production an unset secret is the documented local-dev bypass; production
  // refuses with 500). The harness resets env per file, so configure it here —
  // otherwise the anonymous request is let through and the test times out
  // against the blocked network instead of proving the 401.
  const previousSecret = process.env.OPS_DASHBOARD_SECRET
  process.env.OPS_DASHBOARD_SECRET = "test"
  try {
  const { GET: cockpit } = await import("@/app/api/cockpit/campaigns/[id]/cockpit/route.js");
  const { GET: targets } = await import("@/app/api/cockpit/campaigns/[id]/cockpit/targets/route.js");
  const { GET: cohort } = await import("@/app/api/cockpit/campaigns/[id]/cockpit/cohort/route.js");
  const authed = (path) => new Request(`http://localhost:3000${path}`, { headers: { "x-ops-dashboard-secret": "test" } });
  for (const [handler, path] of [[cockpit, "/api/cockpit/campaigns/nope/cockpit"], [targets, "/api/cockpit/campaigns/nope/cockpit/targets"], [cohort, "/api/cockpit/campaigns/nope/cockpit/cohort"]]) {
    const res = await handler(authed(path), { params: Promise.resolve({ id: "nope" }) });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_campaign_id");
    const anon = await handler(new Request(`http://localhost:3000${path}`), { params: Promise.resolve({ id: CAMPAIGN_ID }) });
    assert.equal(anon.status, 401, "no dashboard credential, no campaign data");
  }
  } finally {
    if (previousSecret === undefined) delete process.env.OPS_DASHBOARD_SECRET
    else process.env.OPS_DASHBOARD_SECRET = previousSecret
  }
});

// ── the campaign list carries lineage + the live queue, from reads it already makes ──

test("list: every campaign carries its lineage and a compact live-queue summary, with no extra query", async () => {
  const draft = { id: "f9bcf5a9-c98c-41ec-b0b0-e95dd1892bbf", name: "Map area · Atlanta, GA · 220 properties", status: "draft", created_at: "2026-09-28T23:46:41Z", metadata: {} };
  const tables = minneapolisTables();
  tables.campaigns = [minneapolis, draft];
  tables.campaign_send_windows = [];
  // the list's proof reader selects the projected scalars, like production
  tables.send_queue = tables.send_queue.map((row) => ({ ...row, "metadata->>launch_mode": row.launch_mode ?? null }));
  const db = fakeSupabase(tables);
  const out = await listCampaigns({ supabase: db });
  assert.equal(out.ok, true);
  assert.deepEqual(db.writes, []);
  const mpls = out.campaigns.find((c) => c.id === CAMPAIGN_ID);
  assert.equal(mpls.lineage.kind, "map_area");
  assert.equal(mpls.lineage.explicit_property_count, 944);
  assert.equal(mpls.live_queue.live, 160);
  assert.ok(mpls.live_queue.overdue >= 160, "due since the day before");
  assert.equal(mpls.live_queue.release_reasons.logical_communication_store_error, 50);
  assert.equal("live_queue" in (mpls.execution_proof || {}), false, "reported once, not inside execution_proof too");
  const atl = out.campaigns.find((c) => c.id === draft.id);
  assert.equal(atl.lineage.kind, "none", "the name says Map area; the row carries no source");
  assert.deepEqual(atl.live_queue, { live: 0, due: 0, overdue: 0, oldest_due_at: null, next_scheduled_at: null, release_reasons: {}, last_claimed_at: null, last_released_at: null, last_release_reason: null });
  assert.equal(db.calls.some((c) => c.table === "system_control"), false, "the list never reads system_control");
});

test("compact live queue: the list's shape of the same summary", () => {
  const nowMs = Date.parse(NOW);
  const out = compactLiveQueue(activeRows(), nowMs);
  assert.deepEqual(Object.keys(out).sort(), ["due", "last_claimed_at", "last_release_reason", "last_released_at", "live", "next_scheduled_at", "oldest_due_at", "overdue", "release_reasons"]);
  assert.equal(out.last_claimed_at, "2026-09-30T01:59:42.345Z");
  assert.equal(out.live, 160);
  assert.equal(out.overdue, 160);
});

test("market index: markets come from each audience's targets, archived campaigns excluded, never names", async () => {
  const tables = {
    campaigns: [
      { id: "a", name: "Map area · Minneapolis, MN · 944 properties", status: "active", created_at: "2026-09-28" },
      { id: "b", name: "Dallas - Test", status: "draft", created_at: "2026-08-08" },
      { id: "z", name: "Old", status: "archived", created_at: "2026-06-01" },
    ],
    campaign_targets: [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, campaign_id: "a", market: "Minneapolis, MN" })),
      { id: "a9", campaign_id: "a", market: "St. Paul, MN" },
      { id: "z1", campaign_id: "z", market: "Miami, FL" },
      { id: "b1", campaign_id: "b", market: null },
    ],
  };
  const db = fakeSupabase(tables);
  const out = await buildCampaignMarketIndex({ supabase: db });
  assert.equal(out.ok, true);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(out.campaigns.a.top, [{ market: "Minneapolis, MN", targets: 5 }, { market: "St. Paul, MN", targets: 1 }]);
  assert.equal(out.campaigns.b, undefined, "no built audience, no market — the name 'Dallas' is not evidence");
  assert.equal(out.markets.some((m) => m.market === "Miami, FL"), false, "archived campaigns are out of the index");
});
