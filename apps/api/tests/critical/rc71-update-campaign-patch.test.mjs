/**
 * RC 7.1 D9 — PATCH /api/cockpit/campaigns/{id} (updateCampaign).
 *
 * Owner: "saving a campaign must not silently reset autonomy settings or
 * bypass status gates."
 *   1. `status` is rejected with a pointer to /lifecycle (the state machine).
 *   2. Only the fields the request contains are written — auto_send_enabled,
 *      auto_reply_mode, template_use_case and the audience filters are no
 *      longer re-written by every save.
 *   3. The audit event records old → new values (truncated, secrets redacted),
 *      not just the payload's keys.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  campaignPatchChanges,
  campaignPatchScope,
  describeCampaignChanges,
  updateCampaign,
} from "@/lib/domain/campaigns/campaign-automation-service.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const ID = "9799d345-06c7-46d8-9b4d-db8b8a4e2bdc";
const FILTERS = {
  catalog_version: "locked_approved_campaign_fields_v1",
  filter_mode: "grouped_source_of_truth_domains",
  properties: [{ field_key: "properties.market", operator: "in", value: ["Miami, FL"] }],
};

function seeded(overrides = {}) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", {
    id: ID, name: "75+ ACQ SCORE", status: "scheduled", objective: "ownership_check", market: "Miami, FL", state: "FL",
    auto_queue_enabled: true, auto_send_enabled: true, auto_reply_mode: "assisted", emergency_stop_at: null,
    daily_cap: 750, total_cap: 1000, batch_max: 100, market_cap: 400, per_sender_cap: 150, send_interval_seconds: 45,
    contact_window_start: "08:00", contact_window_end: "21:00", language_policy: "auto", agent_persona: null,
    candidate_source: "campaign_target_graph", description: null,
    metadata: { template_use_case: "ownership_check", stage_code: "S1", campaign_type: "outbound_sms", target_filters: FILTERS, timezone: "America/New_York" },
    ...overrides,
  });
  return store;
}

const campaignRow = (store) => store.rows("campaigns")[0];
const events = (store) => store.rows("campaign_events").filter((e) => e.event_type === "campaign.updated");

test("status is rejected with a pointer to the lifecycle route; nothing is written", async () => {
  const store = seeded();
  for (const status of ["active", "scheduled", "draft"]) {
    const result = await updateCampaign(ID, { status, name: "x" }, { supabase: store.supabase });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, "status_not_patchable");
    assert.match(result.message, /\/api\/cockpit\/campaigns\/9799d345-06c7-46d8-9b4d-db8b8a4e2bdc\/lifecycle/);
  }
  assert.equal(campaignRow(store).status, "scheduled");
  assert.equal(campaignRow(store).name, "75+ ACQ SCORE");
  assert.equal(events(store).length, 0);
});

test("a rename writes the name only — autonomy settings, message type and audience filters are untouched", async () => {
  const store = seeded();
  const result = await updateCampaign(ID, { name: "75+ ACQ SCORE · Miami" }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed_fields, ["name"]);
  const row = campaignRow(store);
  assert.equal(row.name, "75+ ACQ SCORE · Miami");
  assert.equal(row.auto_send_enabled, true, "not silently reset to false");
  assert.equal(row.auto_reply_mode, "assisted", "not silently reset to disabled");
  assert.equal(row.status, "scheduled");
  assert.deepEqual(row.metadata.target_filters, FILTERS, "audience filters not replaced by the patch body");
  assert.equal(row.metadata.template_use_case, "ownership_check");
  assert.equal(row.metadata.campaign_type, "outbound_sms");
});

test("a cap change writes that cap only", async () => {
  const store = seeded();
  const result = await updateCampaign(ID, { daily_cap: 300 }, { supabase: store.supabase });
  assert.deepEqual(result.changed_fields, ["daily_cap"]);
  assert.equal(campaignRow(store).daily_cap, 300);
  assert.equal(campaignRow(store).auto_send_enabled, true);
});

test("autonomy fields are written only when sent — and still only to their safe values", async () => {
  const store = seeded();
  const off = await updateCampaign(ID, { auto_send_enabled: false, auto_reply_mode: "disabled" }, { supabase: store.supabase });
  assert.equal(off.ok, true);
  assert.equal(campaignRow(store).auto_send_enabled, false);
  assert.equal(campaignRow(store).auto_reply_mode, "disabled");
  const on = await updateCampaign(ID, { auto_send_enabled: true }, { supabase: store.supabase });
  assert.equal(on.ok, false);
  assert.equal(on.error, "auto_send_live_disabled");
});

test("the builder's own update payload changes targeting fields and leaves status alone", async () => {
  const store = seeded();
  const nextFilters = { ...FILTERS, properties: [{ field_key: "properties.market", operator: "in", value: ["Dallas, TX"] }] };
  const payload = {
    name: "75+ ACQ SCORE", description: "", campaign_type: "outbound_sms", template_use_case: "ownership_check",
    stage_code: "S1", market: "Dallas, TX", state: "TX", daily_cap: 750, total_cap: 1000, batch_max: 100, market_cap: 400,
    send_interval_seconds: 45, contact_window_start: "08:00", contact_window_end: "21:00", auto_queue_enabled: true,
    metadata: { launch_timezone: "America/Chicago", timezone: "America/Chicago", planned_first_scheduled_at: null, template_use_case: "ownership_check", stage_code: "S1", target_filters: nextFilters },
    target_filters: nextFilters,
  };
  const result = await updateCampaign(ID, payload, { supabase: store.supabase });
  assert.equal(result.ok, true);
  const row = campaignRow(store);
  assert.equal(row.market, "Dallas, TX");
  assert.deepEqual(row.metadata.target_filters, nextFilters);
  assert.equal(row.status, "scheduled", "status never written by a save");
  assert.equal(row.auto_reply_mode, "assisted", "not part of the builder payload, so untouched");
  assert.ok(store.rows("campaign_filters").length >= 1, "saved filters replaced from the new targeting");
});

test("the audit event records old → new values, not just keys", async () => {
  const store = seeded();
  await updateCampaign(ID, { daily_cap: 300, name: "Renamed" }, { supabase: store.supabase });
  const [event] = events(store);
  assert.deepEqual(event.metadata.changes.daily_cap, { from: 750, to: 300 });
  assert.deepEqual(event.metadata.changes.name, { from: "75+ ACQ SCORE", to: "Renamed" });
  assert.match(event.description, /^Changed: /);
  assert.doesNotMatch(event.description, /_/, "plain words, no column names");
});

test("audit values are truncated and secret-looking keys redacted", () => {
  const big = { values: Array.from({ length: 200 }, (_, i) => `zip_${i}`) };
  const changes = campaignPatchChanges(
    { metadata: { target_filters: {}, api_token: "old" } },
    { metadata: { target_filters: big, api_token: "new" } },
  );
  assert.match(changes["metadata.target_filters"].to.summary, /chars/);
  assert.equal(changes["metadata.api_token"].to, "[redacted]");
  assert.equal(describeCampaignChanges(changes), "audience filters, api token");
});

test("an unchanged save writes nothing and records no event", async () => {
  const store = seeded();
  const result = await updateCampaign(ID, { daily_cap: 750 }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(events(store).length, 0);
});

test("patch scope: only stated columns; the payload itself is never read as targeting", () => {
  const scope = campaignPatchScope({ name: "x" });
  assert.deepEqual([...scope.columns], ["name"]);
  assert.equal(scope.carriesFilters, false);
  const withFilters = campaignPatchScope({ target_filters: FILTERS });
  assert.ok(withFilters.columns.has("metadata") && withFilters.metadataKeys.has("target_filters"));
  assert.ok(withFilters.columns.has("market"), "targeting decides the market");
});
