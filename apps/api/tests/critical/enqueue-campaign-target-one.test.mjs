import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCampaignMode } from "@/lib/domain/queue/queue-control-safety.js";
import {
  ENQUEUE_REASON,
  buildCampaignTargetQueueKey,
  enqueueCampaignTargetOne,
  previewCampaignTargetOne,
} from "@/lib/domain/campaigns/enqueue-campaign-target-one.js";

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

// ── happy path ────────────────────────────────────────────────────────────

test("an eligible target produces exactly one queue row", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase,
    now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  assert.equal(result.created, true);
  assert.equal(result.queue_row_id, "qr-1");
  assert.equal(inserted.length, 1, "exactly one row");
  assert.equal(
    result.review.rendered_body,
    "Hola Rodolfo, Carmen aqui. Pregunta rapida. Sigues siendo el dueno de 618 Hoefner Ave, Los Angeles, Ca 90022?"
  );
});

test("requested target always equals created row target", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  assert.equal(result.requested_campaign_target_id, TARGET_ID);
  assert.equal(result.resulting_campaign_target_id, TARGET_ID);
  assert.equal(inserted[0].campaign_target_id, TARGET_ID);
});

// ── non-throwing insert outcomes ──────────────────────────────────────────
// insertSupabaseSendQueueRow signals duplicates and failures by RETURN VALUE
// as well as by throwing. Treating any returned id as success would report
// creation for a row this call did not create, or whose insert failed.

test("an idempotent replay is reported as already_queued, not created", async () => {
  const supabase = makeSupabase(okFixtures());
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async () => ({
      ok: true, idempotent_replay: true, reason: "idempotent_replay", queue_row_id: "pre-existing",
    }),
  });

  assert.equal(result.created, false, "a replay is not a creation");
  assert.equal(result.reason, ENQUEUE_REASON.ALREADY_QUEUED);
  assert.equal(result.queue_row_id, "pre-existing");
});

test("duplicate_blocked returned without throwing maps to already_queued", async () => {
  const supabase = makeSupabase(okFixtures({
    send_queue: (state) =>
      state.filters.queue_key === buildCampaignTargetQueueKey(TARGET_ID, 1)
        ? [{ id: "winner-row", campaign_target_id: TARGET_ID, queue_key: buildCampaignTargetQueueKey(TARGET_ID, 1) }]
        : [],
  }));
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async () => ({ ok: false, reason: "duplicate_blocked", queue_row_id: null }),
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.ALREADY_QUEUED);
  assert.equal(result.queue_row_id, "winner-row");
});

test("a failed insert that still returns an id is not reported as created", async () => {
  const supabase = makeSupabase(okFixtures());
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async () => ({ ok: false, reason: "insert_rejected", queue_row_id: "half-written" }),
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.INSERT_FAILED);
  // And the row it may have left behind is cancelled.
  const cancel = supabase.updates.find((u) => u.filters.id === "half-written");
  assert.ok(cancel, "a row left by a failed insert must be neutralized");
  assert.equal(cancel.patch.queue_status, "cancelled");
});

test("an invariant violation is fatal and creates nothing usable", async () => {
  // Simulate the row coming back bound to a different target.
  const inserted = [];
  const supabase = makeSupabase(okFixtures({
    send_queue: (state) =>
      state.filters.id === "qr-1"
        ? [{ id: "qr-1", campaign_target_id: "SOME-OTHER-TARGET", queue_status: "queued" }]
        : [],
  }));

  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.INVARIANT_VIOLATION);
  assert.equal(result.fatal, true);
  assert.equal(result.resulting_campaign_target_id, "SOME-OTHER-TARGET");

  // The committed row must be cancelled, not merely reported. Left as
  // 'queued' the processor would dispatch a message bound to another target
  // -- the exact failure this primitive exists to prevent.
  assert.equal(result.neutralized, true);
  const cancel = supabase.updates.find((u) => u.table === "send_queue" && u.filters.id === "qr-1");
  assert.ok(cancel, "invariant-violating row must be neutralized");
  assert.equal(cancel.patch.queue_status, "cancelled");
  assert.match(cancel.patch.blocked_reason, /campaign_target_id_mismatch/);
});

test("a read-back failure neutralizes the row instead of throwing", async () => {
  // The insert already committed; throwing would leave a runnable row the
  // caller never learns about.
  const supabase = makeSupabase(okFixtures());
  const original = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const b = original(table);
    if (table !== "send_queue") return b;
    return {
      ...b,
      select: (cols) => {
        const inner = b.select(cols);
        return {
          ...inner,
          eq: (col, val) => {
            const e = inner.eq(col, val);
            if (col !== "id") return e;
            return { ...e, maybeSingle: async () => ({ data: null, error: new Error("readback boom") }) };
          },
        };
      },
    };
  };

  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async () => ({ ok: true, queue_row_id: "qr-1" }),
  });

  assert.equal(result.created, false);
  assert.equal(result.neutralized, true);
  assert.equal(result.queue_row_id, "qr-1", "caller must still learn the row id");
  const cancel = supabase.updates.find((u) => u.filters.id === "qr-1");
  assert.equal(cancel.patch.queue_status, "cancelled");
});

// ── rejection matrix ──────────────────────────────────────────────────────

const rejects = [
  ["nonexistent target", { campaign_targets: [] }, ENQUEUE_REASON.TARGET_NOT_FOUND],
  ["campaign row missing", { campaigns: [] }, ENQUEUE_REASON.CAMPAIGN_MISSING],
  ["target not ready", { campaign_targets: baseTarget({ target_status: "planned" }) }, ENQUEUE_REASON.TARGET_NOT_READY],
  ["blocked routing", { campaign_targets: baseTarget({ routing_status: "blocked" }) }, ENQUEUE_REASON.BLOCKED],
  ["unverified identity", { campaign_targets: baseTarget({ identity_status: "renter_risk" }) }, ENQUEUE_REASON.BLOCKED],
  ["suppressed target", { campaign_targets: baseTarget({ suppression_status: "suppressed" }) }, ENQUEUE_REASON.SUPPRESSED],
  ["invalid recipient", { campaign_targets: baseTarget({ to_phone_number: "5551234" }) }, ENQUEUE_REASON.INVALID_RECIPIENT],
  ["DNC listed", { sms_suppression_list: [{ id: "s1", phone_e164: "+19514720295", is_active: true }] }, ENQUEUE_REASON.DNC],
  ["automation suppression", { automation_suppressions: [{ id: "a1", phone_e164: "+19514720295", expires_at: null }] }, ENQUEUE_REASON.AUTOMATION_SUPPRESSED],
  ["no template assigned", { campaign_targets: baseTarget({ metadata: { candidate_snapshot: { seller_first_name: "Rodolfo" } } }) }, ENQUEUE_REASON.TEMPLATE_MISSING],
  ["template not in catalog", { sms_templates: [] }, ENQUEUE_REASON.TEMPLATE_NOT_FOUND],
  ["paused template", { ownership_template_rotation_control: [baseGov({ rotation_status: "pause", daily_cap: 0 })] }, ENQUEUE_REASON.TEMPLATE_UNGOVERNED],
  ["ungoverned template", { ownership_template_rotation_control: [] }, ENQUEUE_REASON.TEMPLATE_UNGOVERNED],
  ["exhausted cap", { ownership_template_rotation_control: [baseGov({ daily_cap: 20, last_40d_total_sent: 20 })] }, ENQUEUE_REASON.TEMPLATE_UNGOVERNED],
  ["language mismatch", { sms_templates: baseTemplate({ language: "English" }) }, ENQUEUE_REASON.LANGUAGE_MISMATCH],
  ["no agent persona", { master_owners: { master_owner_id: "mo-1", agent_persona: "" } }, ENQUEUE_REASON.IDENTITY_MISSING],
  ["unresolvable timezone", { properties: { property_id: "prop-1", property_address_state: "TX", property_address_zip: "" }, campaign_targets: baseTarget({ state: "TX" }) }, ENQUEUE_REASON.TZ_UNRESOLVED],
  ["no sender in market", { textgrid_numbers: [] }, ENQUEUE_REASON.NO_SENDER],
  ["sender has no capacity", { textgrid_numbers: [baseSender({ messages_sent_today: 800 })] }, ENQUEUE_REASON.NO_SENDER],
];

for (const [label, override, expected] of rejects) {
  test(`rejects: ${label}`, async () => {
    const { deps, inserted } = runDeps(okFixtures(override));
    const result = await enqueueCampaignTargetOne(TARGET_ID, deps);

    assert.equal(result.created, false, `${label} must not create`);
    assert.equal(result.reason, expected);
    assert.equal(inserted.length, 0, "zero rows created");
  });
}

test("blank merge value is refused by render validation", async () => {
  const { deps, inserted } = runDeps(okFixtures({
    campaign_targets: baseTarget({ metadata: { template_id: "201362", candidate_snapshot: { seller_first_name: "   " } } }),
  }));
  const result = await enqueueCampaignTargetOne(TARGET_ID, deps);

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.RENDER_FAILED);
  assert.equal(inserted.length, 0);
});

test("outside the contact window nothing is created", async () => {
  // 13:00Z = 06:00 Pacific, before the 08:00 open.
  const { deps, inserted } = runDeps(okFixtures());
  const result = await enqueueCampaignTargetOne(TARGET_ID, { ...deps, now: "2026-07-15T13:00:00Z" });

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.OUTSIDE_WINDOW);
  assert.equal(inserted.length, 0);
});

test("sender equal to recipient is refused", async () => {
  const { deps, inserted } = runDeps(okFixtures({
    textgrid_numbers: [baseSender({ phone_number: "+19514720295" })],
  }));
  const result = await enqueueCampaignTargetOne(TARGET_ID, deps);

  assert.equal(result.created, false);
  // Filtered out as a candidate, so it surfaces as "no eligible sender".
  assert.equal(result.reason, ENQUEUE_REASON.NO_SENDER);
  assert.equal(inserted.length, 0);
});

// ── prior contact / idempotency ───────────────────────────────────────────

test("a prior delivered row to the same recipient blocks", async () => {
  const { deps, inserted } = runDeps(okFixtures({
    send_queue: [{ id: "old", queue_status: "delivered", to_phone_number: "+19514720295" }],
  }));
  const result = await enqueueCampaignTargetOne(TARGET_ID, deps);

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.PRIOR_CONTACT);
  assert.equal(inserted.length, 0);
});

test("an existing live row returns already_queued and creates nothing", async () => {
  const { deps, inserted } = runDeps(okFixtures({
    send_queue: [{ id: "live-1", queue_status: "queued", to_phone_number: "+19514720295", campaign_target_id: TARGET_ID }],
  }));
  const result = await enqueueCampaignTargetOne(TARGET_ID, deps);

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.ALREADY_QUEUED);
  assert.equal(result.queue_row_id, "live-1");
  assert.equal(inserted.length, 0, "no duplicate row");
});

test("concurrent duplicate insert is stopped by the unique index, not by a pre-check", async () => {
  // Simulates the loser of a race: the pre-check saw no live row, but the
  // unique index on queue_key rejects the second insert. This is the
  // guarantee that survives true concurrency.
  const supabase = makeSupabase(okFixtures({
    send_queue: (state) =>
      state.filters.queue_key === buildCampaignTargetQueueKey(TARGET_ID, 1)
        ? [{
            id: "winner-row",
            campaign_target_id: TARGET_ID,
            queue_key: buildCampaignTargetQueueKey(TARGET_ID, 1),
          }]
        : [],
  }));

  let attempts = 0;
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase,
    now: NOON_PT,
    insertQueueImpl: async () => {
      attempts += 1;
      const err = new Error('duplicate key value violates unique constraint "send_queue_queue_key_key"');
      err.code = "23505";
      throw err;
    },
  });

  assert.equal(attempts, 1, "insert attempted exactly once, no retry loop");
  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.ALREADY_QUEUED);
  assert.equal(result.queue_row_id, "winner-row");
  assert.equal(result.resulting_campaign_target_id, TARGET_ID);
});

test("the queue key is deterministic and target-scoped", () => {
  assert.equal(buildCampaignTargetQueueKey(TARGET_ID, 1), `campaign_target_one:${TARGET_ID}:t1`);
  assert.equal(
    buildCampaignTargetQueueKey(TARGET_ID, 1),
    buildCampaignTargetQueueKey(TARGET_ID, 1),
    "same input -> same key"
  );
  assert.notEqual(
    buildCampaignTargetQueueKey(TARGET_ID, 1),
    buildCampaignTargetQueueKey("other-target", 1),
    "different targets must not collide"
  );
  assert.notEqual(
    buildCampaignTargetQueueKey(TARGET_ID, 1),
    buildCampaignTargetQueueKey(TARGET_ID, 2),
    "a later touch is still possible"
  );
});

// ── cardinality and feeder bypass ─────────────────────────────────────────

test("one request never produces more than one row", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  assert.equal(inserted.length, 1);
});

test("the legacy feeder view is never consulted", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  const forbidden = ["v_feeder_candidates_fast", "v_sms_ready_contacts_expanded"];
  for (const table of forbidden) {
    assert.ok(!supabase.touched.includes(table), `${table} must never be read`);
  }
  // And it did read the campaign tables, proving it resolved by target.
  assert.ok(supabase.touched.includes("campaign_targets"));
});

test("the module does not import the feeder", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.promises.readFile(
      new URL("../../src/lib/domain/campaigns/enqueue-campaign-target-one.js", import.meta.url),
      "utf8"
    )
  );

  // Strip comments first. The module's own header documents the feeder in
  // order to explain what it deliberately avoids, and a naive substring match
  // would flag that prose as a violation.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  assert.ok(!code.includes("supabase-candidate-feeder"), "must not import the feeder module");
  assert.ok(!code.includes("runSupabaseCandidateFeeder"), "must not call the feeder");
  assert.ok(!code.includes("v_feeder_candidates_fast"), "must not reference the feeder view");
});

// ── send_one_queue_row compatibility ──────────────────────────────────────

test("the created row satisfies every send_one_queue_row precondition", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  const row = inserted[0];

  // Mirrors preclaimInvalidQueueRowReason in lib/supabase/sms-engine.js.
  assert.ok(row.message_body, "missing_message_body");
  assert.ok(row.to_phone_number, "missing_to_phone_number");
  assert.ok(row.from_phone_number, "missing_from_phone_number");
  assert.notEqual(row.queue_status, "paused_review", "paused_review_not_runnable");
  assert.equal(row.thread_key, row.to_phone_number, "noncanonical_thread_key");
  assert.ok(
    row.template_id || row.metadata.selected_template_id || row.metadata.template_id,
    "missing_selected_template_id"
  );
  assert.ok(
    row.metadata.candidate_snapshot && typeof row.metadata.candidate_snapshot === "object",
    "missing_candidate_snapshot"
  );
  assert.ok(
    row.seller_first_name || row.metadata.candidate_snapshot.seller_first_name,
    "missing_seller_first_name"
  );
  // Executable status the send path accepts.
  assert.equal(row.queue_status, "queued");
});

test("the rendered body carries no unresolved token", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  assert.ok(!/\{\{/.test(inserted[0].message_body));
  assert.ok(!/,\s{2,}/.test(inserted[0].message_body), "no blank merge gap");
});

// ── dry run ───────────────────────────────────────────────────────────────

test("preview validates fully and inserts nothing", async () => {
  const supabase = makeSupabase(okFixtures());
  const result = await previewCampaignTargetOne(TARGET_ID, { supabase, now: NOON_PT });

  assert.equal(result.dry_run, true);
  assert.equal(result.created, true, "would have been created");
  assert.equal(result.would_insert.campaign_target_id, TARGET_ID);
  assert.equal(
    result.would_insert.message_body,
    "Hola Rodolfo, Carmen aqui. Pregunta rapida. Sigues siendo el dueno de 618 Hoefner Ave, Los Angeles, Ca 90022?"
  );
});

test("preview surfaces the same rejection the real call would", async () => {
  const supabase = makeSupabase(okFixtures({
    ownership_template_rotation_control: [baseGov({ rotation_status: "pause", daily_cap: 0 })],
  }));
  const result = await previewCampaignTargetOne(TARGET_ID, { supabase, now: NOON_PT });

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.TEMPLATE_UNGOVERNED);
  assert.equal(result.would_insert, null);
});

// ── campaign-mode contract ────────────────────────────────────────────────
// The row is admitted by send_one_queue_row only when metadata.campaign_mode
// normalizes to 'live_limited'. A row without it defaults to 'paused' at the
// route and is rejected -- which is exactly how canary #1 aborted.

test("the resolved campaign mode is stamped on the created row", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  const result = await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  assert.equal(result.created, true);
  assert.equal(inserted[0].metadata.campaign_mode, "live_limited");
  assert.equal(inserted[0].metadata.campaign_mode_source, "system_control.campaign_mode");
});

test("the mode is resolved, not hardcoded", async () => {
  // 'automatic' is an alias that normalizes to live_limited. If the value were
  // hardcoded this test could not distinguish it from a literal.
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted, {
    system_control: [{ key: "campaign_mode", value: "automatic" }],
  }));
  await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  assert.equal(normalizeCampaignMode("automatic"), "live_limited");
  assert.equal(inserted[0].metadata.campaign_mode, "live_limited");
});

for (const [label, value, reason] of [
  ["paused",        "paused",   ENQUEUE_REASON.CAMPAIGN_MODE_NOT_SENDABLE],
  ["dry_run",       "dry_run",  ENQUEUE_REASON.CAMPAIGN_MODE_NOT_SENDABLE],
  ["malformed",     "!!bogus!!", ENQUEUE_REASON.CAMPAIGN_MODE_NOT_SENDABLE],
  ["missing value", "",         ENQUEUE_REASON.CAMPAIGN_MODE_UNRESOLVED],
]) {
  test(`campaign mode ${label} creates zero rows`, async () => {
    const { deps, inserted } = runDeps(okFixtures({
      system_control: [{ key: "campaign_mode", value }],
    }));
    const result = await enqueueCampaignTargetOne(TARGET_ID, deps);

    assert.equal(result.created, false, `${label} must not create`);
    assert.equal(result.reason, reason);
    assert.equal(inserted.length, 0, "zero rows created");
  });
}

test("an absent campaign_mode row fails closed", async () => {
  const { deps, inserted } = runDeps(okFixtures({ system_control: [] }));
  const result = await enqueueCampaignTargetOne(TARGET_ID, deps);

  assert.equal(result.created, false);
  assert.equal(result.reason, ENQUEUE_REASON.CAMPAIGN_MODE_UNRESOLVED);
  assert.equal(inserted.length, 0);
});

test("stamping the mode does not drop any other metadata key", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  const m = inserted[0].metadata;
  for (const key of [
    "source", "campaign_target_id", "selected_template_id", "template_id",
    "template_name", "agent_persona", "agent_name", "seller_first_name",
    "language", "timezone_status", "timezone_basis", "candidate_snapshot",
    "no_direct_provider_send",
  ]) {
    assert.ok(key in m, `metadata.${key} must survive`);
  }
});

test("dry-run previews the same campaign mode that would be persisted", async () => {
  const supabase = makeSupabase(okFixtures());
  const preview = await previewCampaignTargetOne(TARGET_ID, { supabase, now: NOON_PT });

  assert.equal(preview.created, true);
  assert.equal(preview.would_insert.metadata.campaign_mode, "live_limited");
  assert.equal(preview.review.campaign_mode, "live_limited");
});

// ── full route-level admission chain ──────────────────────────────────────
// The previous compatibility test only covered preclaimInvalidQueueRowReason,
// the validator INSIDE the send engine. It missed the control route's own
// gates, which run first -- and one of them rejected canary #1.

test("the created row clears the entire send_one_queue_row admission chain", async () => {
  const inserted = [];
  const supabase = makeSupabase(fixturesWithReadback(inserted));
  await enqueueCampaignTargetOne(TARGET_ID, {
    supabase, now: NOON_PT,
    insertQueueImpl: async (p) => { inserted.push(p); return { queue_row_id: "qr-1" }; },
  });

  const row = inserted[0];
  const meta = row.metadata;
  const status = String(row.queue_status).toLowerCase();

  // Route constants mirrored from app/api/cockpit/queue/control/route.js:120-127
  const SENDABLE = new Set(["queued", "scheduled", "pending", "approved", "ready"]);
  const REJECT = new Set([
    "expired", "failed", "paused", "paused_operator_review",
    "paused_name_missing", "paused_invalid_queue_row",
  ]);

  // ROUTE GATE 1 -- campaign mode
  assert.equal(
    normalizeCampaignMode(meta.campaign_mode || row.campaign_mode || "paused"),
    "live_limited",
    "route gate 1: queue_row_not_live_limited"
  );

  // ROUTE GATE 2 -- rejectOneRowStatusReason
  assert.ok(!REJECT.has(status) && !status.startsWith("paused"), "route gate 2: status rejected");
  assert.ok(SENDABLE.has(status), "route gate 2: status not sendable");

  // ROUTE GATE 3 -- queueRowIsNoSend
  const isNoSend =
    meta.no_send === true || meta.proof_no_send === true ||
    String(meta.proof_mode ?? "").toLowerCase() === "no_send" ||
    row.sms_eligible === false || row.routing_allowed === false;
  assert.equal(isNoSend, false, "route gate 3: row marked no_send");

  // ROUTE GATE 4 -- not scheduled in the future
  const schedAt = row.scheduled_for_utc || row.scheduled_for;
  assert.ok(!schedAt || new Date(schedAt).getTime() <= new Date(NOON_PT).getTime(),
    "route gate 4: scheduled in future");

  // INTERNAL PRECLAIM -- preclaimInvalidQueueRowReason
  assert.ok(row.message_body, "missing_message_body");
  assert.ok(row.to_phone_number, "missing_to_phone_number");
  assert.ok(row.from_phone_number, "missing_from_phone_number");
  assert.notEqual(status, "paused_review", "paused_review_not_runnable");
  assert.equal(row.thread_key, row.to_phone_number, "noncanonical_thread_key");
  assert.ok(row.template_id || meta.selected_template_id || meta.template_id, "missing_selected_template_id");
  assert.ok(meta.candidate_snapshot && typeof meta.candidate_snapshot === "object", "missing_candidate_snapshot");
  assert.ok(row.seller_first_name || meta.candidate_snapshot.seller_first_name, "missing_seller_first_name");
  assert.ok(!/\{\{/.test(row.message_body), "unresolved token");
});

test("a row missing campaign_mode would fail route gate 1 — the canary #1 defect", async () => {
  // Pins the exact regression: the pre-fix row shape.
  const preFixRow = { queue_status: "queued", metadata: { template_id: "201362" } };

  assert.notEqual(
    normalizeCampaignMode(preFixRow.metadata.campaign_mode || preFixRow.campaign_mode || "paused"),
    "live_limited"
  );
  assert.equal(
    normalizeCampaignMode(preFixRow.metadata.campaign_mode || preFixRow.campaign_mode || "paused"),
    "paused"
  );
});
