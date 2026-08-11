import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetCampaignRecommendationTestDeps,
  __setCampaignRecommendationTestDeps,
  RECOMMENDATION_MODEL_VERSION,
  computeCampaignRecommendations,
  computeMarketSaturation,
  generateCampaignRecommendations,
  persistCampaignRecommendations,
} from "@/lib/domain/recommendation/campaign-recommendation-service.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fixtureInputs() {
  return {
    window_label: "30d",
    window_days: 30,
    generated_at: "2026-08-07T12:00:00.000Z",
    markets: [
      {
        market: "Memphis, TN",
        sent: 400,
        deliveryRate: 95,
        replyRate: 12,
        positiveRate: 40,
        optOutRate: 0.5,
      },
      {
        market: "Dallas, TX",
        sent: 0,
        deliveryRate: 0,
        replyRate: 0,
        positiveRate: 0,
        optOutRate: 0,
      },
      {
        market: "Tampa, FL",
        sent: 100,
        deliveryRate: 70,
        replyRate: 2,
        positiveRate: 10,
        optOutRate: 1,
      },
    ],
    inventory_by_market: {
      "Memphis, TN": 5000,
      "Dallas, TX": 800,
      "Tampa, FL": 100,
    },
    capacity_by_market: {
      "Memphis, TN": { daily_capacity: 200, template_strength: 0.5 },
    },
    data_freshness: { window: "30d", sources: { market_metrics: "fixture" } },
  };
}

test.afterEach(() => {
  __resetCampaignRecommendationTestDeps();
});

// ── Determinism ───────────────────────────────────────────────────────────

test("same inputs produce byte-identical recommendations (deterministic scoring)", () => {
  const first = computeCampaignRecommendations(structuredClone(fixtureInputs()));
  const second = computeCampaignRecommendations(structuredClone(fixtureInputs()));

  assert.ok(first.length > 0, "fixture must produce recommendations");
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  // Deterministic ordering: score desc, then market, then campaign_type.
  for (let i = 1; i < first.length; i += 1) {
    const prev = first[i - 1];
    const curr = first[i];
    assert.ok(
      prev.score > curr.score ||
        (prev.score === curr.score && prev.market <= curr.market),
      "ordering must be deterministic"
    );
  }
});

test("saturation measure is deterministic and bounded", () => {
  assert.equal(computeMarketSaturation({ window_sent: 0, eligible: 0 }), 1);
  assert.equal(computeMarketSaturation({ window_sent: 100, eligible: 100 }), 0.5);
  assert.equal(computeMarketSaturation({ window_sent: 0, eligible: 500 }), 0);
  assert.equal(computeMarketSaturation({ window_sent: 300, eligible: 100 }), 0.75);
});

// ── Output contract ───────────────────────────────────────────────────────

test("every recommendation carries the full explainability contract", () => {
  const recommendations = computeCampaignRecommendations(fixtureInputs());

  for (const rec of recommendations) {
    assert.ok(rec.market);
    assert.equal(rec.property_class, "all");
    assert.ok(
      ["cold_outreach_expansion", "scale_active_market", "template_refresh"].includes(
        rec.campaign_type
      )
    );
    assert.equal(typeof rec.score, "number");
    assert.equal(rec.status, "proposed");
    assert.equal(rec.model_version, RECOMMENDATION_MODEL_VERSION);
    assert.ok(Array.isArray(rec.score_breakdown) && rec.score_breakdown.length > 0);
    assert.ok(Array.isArray(rec.reasons) && rec.reasons.length > 0);
    assert.ok(rec.data_freshness);

    // Declared-but-unfed inputs are visible in every breakdown with zero
    // contribution until a real feed exists.
    for (const slot of ["seller_score", "buyer_demand_liquidity"]) {
      const entry = rec.score_breakdown.find((s) => s.signal === slot);
      assert.ok(entry, `${slot} slot must be declared`);
      assert.equal(entry.status, "pending_unfed");
      assert.equal(entry.contribution, 0);
      assert.equal(entry.value, null);
    }

    // Score equals the sum of contributions (gate contribution included).
    const sum = rec.score_breakdown.reduce((acc, s) => acc + (s.contribution || 0), 0);
    assert.ok(Math.abs(sum - rec.score) < 0.001, `score must equal breakdown sum for ${rec.market}/${rec.campaign_type}`);
  }
});

test("a responsive market with inventory is recommended; a sub-85% delivery market is excluded", () => {
  const recommendations = computeCampaignRecommendations(fixtureInputs());

  const memphis = recommendations.filter((r) => r.market === "Memphis, TN");
  assert.ok(
    memphis.some((r) => r.campaign_type === "scale_active_market"),
    "healthy responsive market should be recommended for scaling"
  );
  assert.ok(
    memphis.some((r) => r.campaign_type === "cold_outreach_expansion"),
    "large untouched inventory should surface cold outreach"
  );

  const dallas = recommendations.filter((r) => r.market === "Dallas, TX");
  assert.ok(
    dallas.some((r) => r.campaign_type === "cold_outreach_expansion"),
    "untouched market with inventory should surface cold outreach"
  );

  // Tampa delivers at 70% on 100 sends: the delivery gate multiplies every
  // score below the emission threshold — no volume recommendation may appear.
  const tampa = recommendations.filter((r) => r.market === "Tampa, FL");
  assert.equal(tampa.length, 0, "sub-85% delivery markets must not be recommended for more volume");
});

// ── No-mutation guarantee + persistence behavior ──────────────────────────

function makeRecordingClient({ insert_error = null } = {}) {
  const ops = [];

  function thenable(result) {
    return {
      eq(column, value) {
        ops[ops.length - 1].filters = { [column]: value };
        return thenable(result);
      },
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  }

  const client = {
    from(table) {
      return {
        select(cols) {
          ops.push({ table, op: "select", cols });
          const data =
            table === "v_outbound_discovery_fresh"
              ? [{ market: "Memphis, TN" }, { market: "Memphis, TN" }, { market: "Dallas, TX" }]
              : table === "textgrid_numbers"
                ? [{ market: "Memphis, TN", is_active: true, daily_cap: 150 }]
                : [];
          return thenable({ data, error: null });
        },
        insert(row) {
          ops.push({ table, op: "insert", row });
          return {
            then(resolve, reject) {
              return Promise.resolve(
                insert_error ? { error: insert_error } : { error: null }
              ).then(resolve, reject);
            },
          };
        },
        update() {
          ops.push({ table, op: "update" });
          throw new Error(`forbidden update on ${table}`);
        },
        upsert() {
          ops.push({ table, op: "upsert" });
          throw new Error(`forbidden upsert on ${table}`);
        },
        delete() {
          ops.push({ table, op: "delete" });
          throw new Error(`forbidden delete on ${table}`);
        },
      };
    },
  };

  return { client, ops };
}

function mockWarRoom() {
  return {
    window: "30d",
    market_leaderboard: [
      {
        market: "Memphis, TN",
        sent: 400,
        deliveryRate: 95,
        replyRate: 12,
        positiveRate: 40,
        optOutRate: 0.5,
      },
      {
        market: "Dallas, TX",
        sent: 0,
        deliveryRate: 0,
        replyRate: 0,
        positiveRate: 0,
        optOutRate: 0,
      },
    ],
    sms_template_leaderboard: [
      { topMarket: "Memphis, TN", recommendation: "Scale" },
      { topMarket: "Memphis, TN", recommendation: "Testing" },
    ],
  };
}

test("recommender end-to-end never writes to campaigns or send_queue — insert-only into its own table", async () => {
  const { client, ops } = makeRecordingClient();

  __setCampaignRecommendationTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => client,
    buildWarRoom: async () => mockWarRoom(),
    logger: silentLogger,
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });

  const result = await generateCampaignRecommendations({ window: "30d", persist: true });

  assert.equal(result.ok, true);
  assert.equal(result.shadow_only, true);
  assert.ok(result.recommendations.length > 0);

  const writes = ops.filter((op) => op.op !== "select");
  assert.ok(writes.length > 0, "persistence should have been attempted");
  for (const write of writes) {
    assert.equal(write.op, "insert", "only inserts are permitted");
    assert.equal(write.table, "campaign_recommendations", "only the recommendations table may be written");
    assert.equal(write.row.status, "proposed");
  }

  const touched_tables = [...new Set(ops.map((op) => op.table))].sort();
  assert.deepEqual(touched_tables, [
    "campaign_recommendations",
    "textgrid_numbers",
    "v_outbound_discovery_fresh",
  ]);
  assert.ok(!touched_tables.includes("campaigns"));
  assert.ok(!touched_tables.includes("send_queue"));

  assert.equal(result.persistence.persisted, writes.length);
  assert.equal(result.persistence.reason, "campaign_recommendations_persisted");
});

test("persistence degrades to compute-only with an explicit reason while the table is absent", async () => {
  const { client } = makeRecordingClient({
    insert_error: {
      code: "PGRST205",
      message: "Could not find the table 'public.campaign_recommendations' in the schema cache",
    },
  });

  __setCampaignRecommendationTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => client,
    buildWarRoom: async () => mockWarRoom(),
    logger: silentLogger,
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });

  const result = await generateCampaignRecommendations({ window: "30d", persist: true });

  assert.equal(result.ok, true, "compute result survives missing persistence");
  assert.ok(result.recommendations.length > 0);
  assert.equal(result.persistence.reason, "campaign_recommendations_table_missing");
  assert.equal(result.persistence.persisted, 0);
});

test("same-day replays dedupe on the natural key (23505 treated as no-op)", async () => {
  const { client } = makeRecordingClient({
    insert_error: { code: "23505", message: "duplicate key value violates unique constraint" },
  });

  __setCampaignRecommendationTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => client,
    logger: silentLogger,
  });

  const recommendations = computeCampaignRecommendations(fixtureInputs());
  const persistence = await persistCampaignRecommendations(recommendations);

  assert.equal(persistence.persisted, 0);
  assert.equal(persistence.deduped, recommendations.length);
  assert.equal(persistence.failed, 0);
});

test("persist=false never touches the client", async () => {
  __setCampaignRecommendationTestDeps({
    hasSupabaseConfig: () => true,
    getClient: () => {
      throw new Error("client must not be requested when persistence is off — except for inputs");
    },
    buildWarRoom: async () => mockWarRoom(),
    logger: silentLogger,
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });

  // Inputs still need reads; provide a read-only recording client instead.
  const { client, ops } = makeRecordingClient();
  __setCampaignRecommendationTestDeps({ getClient: () => client });

  const result = await generateCampaignRecommendations({ window: "30d", persist: false });

  assert.equal(result.ok, true);
  assert.equal(result.persistence.attempted, false);
  assert.equal(result.persistence.reason, "persist_disabled");
  assert.ok(ops.every((op) => op.op === "select"), "no writes of any kind with persist=false");
});
