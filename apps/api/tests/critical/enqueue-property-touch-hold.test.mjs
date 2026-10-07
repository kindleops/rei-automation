/**
 * Acquisition OS v1 §61–62 on the campaign enqueue path: a property already
 * opened on another phone gets NO second opener (flag CAMPAIGN_PROPERTY_TOUCH_HOLD
 * = on), "shadow" only stamps the verdict, default OFF changes nothing.
 * Follow-up touches are never held. No network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ENQUEUE_REASON, enqueueCampaignTargetOne } from "@/lib/domain/campaigns/enqueue-campaign-target-one.js";

const ROTATION_OK = {
  renderableRotationPoolSize: async () => 2,
  resolveSenderSpreadInstant: async (_supabase, { nowIso }) => ({ scheduled_for: nowIso, spread_applied: false, interval_seconds: null }),
};


const TARGET_ID = "0cc25ba6-353f-4fa8-beeb-d0471c324a79";

// ── fixtures ──────────────────────────────────────────────────────────────

const baseTarget = (over = {}) => ({
  id: TARGET_ID,
  campaign_id: "camp-1",
  target_status: "ready",
  routing_status: "ready",
  identity_status: "verified",
  suppression_status: "clear",
  to_phone_number: "+19514720295",
  language: "Spanish",
  timezone: "Pacific",
  state: "CA",
  market: "Los Angeles, CA",
  property_id: "prop-1",
  master_owner_id: "mo-1",
  property_address: "618 Hoefner Ave, Los Angeles, Ca 90022",
  touch_number: 1,
  metadata: {
    template_id: "201362",
    candidate_snapshot: { seller_first_name: "Rodolfo" },
  },
  ...over,
});

const baseTemplate = (over = {}) => ({
  template_id: "201362",
  is_active: true,
  language: "Spanish",
  use_case: "ownership_check",
  stage_code: "S1",
  template_name: "ownership_check_S1_Spanish_201362",
  template_body:
    "Hola {{seller_first_name}}, {{agent_name}} aqui. Pregunta rapida. Sigues siendo el dueno de {{property_address}}?",
  ...over,
});

const baseGov = (over = {}) => ({
  template_id: "201362",
  rotation_status: "testing",
  language: "Spanish",
  daily_cap: 20,
  last_40d_total_sent: 0,
  ...over,
});

const baseSender = (over = {}) => ({
  id: "tg-1",
  phone_number: "+13105559881",
  market: "Los Angeles, CA",
  status: "active",
  daily_limit: 800,
  messages_sent_today: 1,
  health_score: 1,
  ...over,
});

/**
 * Supabase double. Returns whatever the fixture map holds for each table, and
 * records every table touched so a test can assert the feeder's view was never
 * consulted.
 */
function makeSupabase(fixtures = {}) {
  const touched = [];

  const make = (table) => {
    const state = { table, filters: {}, inFilter: null };
    const rowsFor = () => {
      const value = fixtures[table];
      const rows = typeof value === "function" ? value(state) : value;
      return Array.isArray(rows) ? rows : rows ? [rows] : [];
    };
    const applyFilters = (rows) =>
      rows.filter((row) =>
        Object.entries(state.filters).every(([k, v]) => row[k] === v)
      );

    const api = {
      select() { return api; },
      eq(column, value) { state.filters[column] = value; return api; },
      in(column, values) { state.inFilter = { column, values }; return api; },
      order() { return api; },
      async range() {
        let rows = applyFilters(rowsFor());
        if (state.inFilter) {
          rows = rows.filter((r) => state.inFilter.values.includes(r[state.inFilter.column]));
        }
        return { data: rows, error: null };
      },
      async maybeSingle() {
        const rows = applyFilters(rowsFor());
        return { data: rows[0] ?? null, error: null };
      },
    };
    return api;
  };

  const updates = [];

  return {
    touched,
    updates,
    from(table) {
      touched.push(table);
      return {
        select: (...a) => make(table).select(...a),
        update(patch) {
          const record = { table, patch, filters: {} };
          const api = {
            eq(column, value) {
              record.filters[column] = value;
              updates.push(record);
              return Promise.resolve({ data: null, error: null });
            },
          };
          return api;
        },
      };
    },
  };
}

const okFixtures = (over = {}) => ({
  system_control: [{ key: "campaign_mode", value: "live_limited" }],
  campaign_targets: baseTarget(),
  campaigns: { id: "camp-1", name: "Los Angeles- Multifamily" },
  sms_suppression_list: [],
  automation_suppressions: [],
  send_queue: [],
  sms_templates: baseTemplate(),
  ownership_template_rotation_control: [baseGov()],
  properties: { property_id: "prop-1", property_address_state: "CA", property_address_zip: "90022" },
  master_owners: { master_owner_id: "mo-1", agent_persona: "Carmen Rivera" },
  textgrid_numbers: [baseSender()],
  ...over,
});

// Noon Pacific — safely inside the 08:00-21:00 window.
const NOON_PT = "2026-07-15T19:00:00Z";

function runDeps(fixtures, over = {}) {
  const inserted = [];
  const supabase = makeSupabase(fixtures);
  return {
    inserted,
    supabase,
    deps: {
      ...ROTATION_OK,
      supabase,
      now: NOON_PT,
      insertQueueImpl: async (payload) => {
        inserted.push(payload);
        return { queue_row_id: "qr-1" };
      },
      ...over,
    },
  };
}

/** Fixture whose send_queue read-back returns the inserted row. */
function fixturesWithReadback(inserted, over = {}) {
  return okFixtures({
    send_queue: (state) => {
      if (state.filters.id === "qr-1") {
        const p = inserted[0];
        return p
          ? [{ id: "qr-1", campaign_target_id: p.campaign_target_id, queue_status: p.queue_status,
               to_phone_number: p.to_phone_number, from_phone_number: p.from_phone_number }]
          : [];
      }
      return [];
    },
    ...over,
  });
}


const priorOnOtherPhone = (prospect_id = null) => (state) => {
  if (state.filters.property_id === "prop-1") {
    return [{ id: "old-1", queue_status: "sent", sent_at: "2026-09-01T00:00:00Z", to_phone_number: "+19515550000", prospect_id, property_id: "prop-1", metadata: {} }];
  }
  return [];
};

async function run(env, fixturesOver = {}, targetOver = {}) {
  const inserted = [];
  const supabase = makeSupabase(okFixtures({ send_queue: priorOnOtherPhone(), campaign_targets: baseTarget(targetOver), ...fixturesOver }));
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    ...ROTATION_OK, supabase, now: NOON_PT, env,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });
  return { result, inserted };
}

test("flag OFF (default): property history on another phone does not change enqueue", async () => {
  const { inserted } = await run({});
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].metadata.property_touch_hold, undefined);
});

test("flag on: an opener to a property already texted on another phone is held", async () => {
  const { result, inserted } = await run({ CAMPAIGN_PROPERTY_TOUCH_HOLD: "on" });
  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.PROPERTY_PRIOR_TOUCH);
  assert.equal(inserted.length, 0);
});

test("flag on: a proven different person (all prior recipients known, phone owned) is released", async () => {
  const { inserted } = await run(
    { CAMPAIGN_PROPERTY_TOUCH_HOLD: "on" },
    { send_queue: priorOnOtherPhone("person-A") },
    { prospect_id: "person-B", metadata: { template_id: "201362", candidate_snapshot: { seller_first_name: "Rodolfo" }, phone_owned_by_person: true } },
  );
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].metadata.property_touch_hold.release, "known_different_person");
});

test("flag on: a follow-up touch is never held by the property rule", async () => {
  const { inserted } = await run({ CAMPAIGN_PROPERTY_TOUCH_HOLD: "on" }, {}, { touch_number: 2 });
  assert.equal(inserted.length, 1);
});

test("shadow: the verdict is stamped on the row, nothing is held", async () => {
  const { inserted } = await run({ CAMPAIGN_PROPERTY_TOUCH_HOLD: "shadow" });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].metadata.property_touch_hold.hold, true);
  assert.equal(inserted[0].metadata.property_touch_hold.mode, "shadow");
  assert.equal(inserted[0].metadata.property_touch_hold.category, "ambiguous_identity", "prior recipient unknown");
});
