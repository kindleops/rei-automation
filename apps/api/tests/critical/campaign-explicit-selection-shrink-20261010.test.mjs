/**
 * P0 2026-10-10 — HOT LEADS (b8134925): 2,010 Entity Graph pinned property ids
 * became 183 on one Composer save. The Composer restored a session snapshot
 * taken after the first stack (183 ids, 00:10Z) and its autosave sent that
 * whole target_filters at 09:07Z; updateCampaign replaced the audience
 * definition wholesale and re-wrote campaign_filters from it.
 *
 *   1. An explicit property_id list round-trips the writer losslessly at any
 *      size (10,000 / 25,000 ids) — through updateCampaign and the Composer save.
 *   2. Any update that would drop a pinned id is refused (422), nothing written
 *      (campaigns, campaign_filters, campaign_events) — unless the request names
 *      the removal (remove_property_ids / clear_explicit_selection).
 *   3. Additions always pass.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { explicitSelectionShrink, explicitSelectedPropertyIds, updateCampaign } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { composerCampaignPayload, saveComposerDraft, _resetComposerFlights } from "@/lib/domain/campaigns/campaign-composer.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const ID = "b8134925-833a-4598-975f-4d77aacd5b2b";
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => String(210000000 + from + i));
const pinned = (list) => ({
  properties: [{ field_key: "properties.property_id", operator: "is_any_of", value: list, domain: "properties", category: "Identity" }],
});

function seeded(list) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", {
    id: ID, name: "HOT LEADS", status: "draft", objective: null, market: null, state: null,
    auto_queue_enabled: true, auto_send_enabled: false, auto_reply_mode: "disabled", emergency_stop_at: null,
    daily_cap: null, total_cap: null, batch_max: null, market_cap: null, per_sender_cap: null, send_interval_seconds: null,
    contact_window_start: null, contact_window_end: null, language_policy: "auto", agent_persona: null,
    candidate_source: "campaign_target_graph", description: null,
    metadata: { source: "entity_graph", handoff_mode: "stacked_explicit", target_filters: pinned(list) },
  });
  return store;
}
const row = (store) => store.rows("campaigns")[0];
const pinnedOnRow = (store) => [...explicitSelectedPropertyIds(row(store))];
const updates = (store) => store.rows("campaign_events").filter((e) => e.event_type === "campaign.updated");

test("the HOT LEADS save: a 183-id target_filters over a 2,010-id draft is refused 422 and nothing is written", async () => {
  const store = seeded(ids(2010));
  const before = JSON.stringify(row(store));
  const filtersBefore = JSON.stringify(store.rows("campaign_filters"));
  const result = await updateCampaign(ID, { description: "", daily_cap: 750, target_filters: pinned(ids(183)) }, { supabase: store.supabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.error, "explicit_selection_shrink_refused");
  assert.equal(result.pinned_before, 2010);
  assert.equal(result.pinned_after, 183);
  assert.equal(result.would_remove, 1827);
  assert.equal(JSON.stringify(row(store)), before, "campaign row untouched (not even daily_cap)");
  assert.equal(JSON.stringify(store.rows("campaign_filters")), filtersBefore, "campaign_filters not deleted / re-inserted");
  assert.equal(updates(store).length, 0);
});

test("the same refusal through the Composer save (POST /composer action=save) — status 422 reaches the route", async () => {
  _resetComposerFlights();
  const store = seeded(ids(2010));
  const result = await saveComposerDraft({
    composer_key: "ck-hot", campaign_id: ID,
    composition: { name: "HOT LEADS", description: "", template_use_case: "ownership_check", daily_cap: "750", target_filters: pinned(ids(183)) },
  }, { supabase: store.supabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.error, "explicit_selection_shrink_refused");
  assert.equal(pinnedOnRow(store).length, 2010);
});

test("10,000 and 25,000 pinned ids round-trip an unrelated save losslessly (metadata + campaign_filters)", async () => {
  for (const n of [10_000, 25_000]) {
    _resetComposerFlights();
    const list = ids(n);
    const store = seeded(list);
    const result = await saveComposerDraft({
      composer_key: `ck-${n}`, campaign_id: ID,
      composition: { name: "HOT LEADS", template_use_case: "ownership_check", daily_cap: "750", target_filters: pinned(list) },
    }, { supabase: store.supabase });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
    assert.deepEqual(row(store).metadata.target_filters.properties[0].value, list);
    assert.equal(row(store).metadata.target_filters.catalog_version, "locked_approved_campaign_fields_v1");
    assert.equal(row(store).daily_cap, 750);
  }
});

test("additions always pass (Entity Graph stacking more ids through a save)", async () => {
  const store = seeded(ids(2010));
  const result = await updateCampaign(ID, { target_filters: pinned(ids(10_000)) }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.equal(pinnedOnRow(store).length, 10_000);
});

test("a named removal passes: remove_property_ids drops exactly those ids, through the Composer payload", async () => {
  _resetComposerFlights();
  const list = ids(10_000);
  const store = seeded(list);
  const removed = list.slice(0, 3);
  const payload = composerCampaignPayload({ name: "HOT LEADS", target_filters: pinned(list.slice(3)), remove_property_ids: removed }, { isUpdate: true });
  assert.deepEqual(payload.remove_property_ids, removed);
  const result = await saveComposerDraft({
    composer_key: "ck-rm", campaign_id: ID,
    composition: { name: "HOT LEADS", target_filters: pinned(list.slice(3)), remove_property_ids: removed },
  }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.equal(pinnedOnRow(store).length, 9_997);
});

test("a removal list that does not cover every dropped id is still refused", async () => {
  const store = seeded(ids(100));
  const result = await updateCampaign(ID, { target_filters: pinned(ids(90)), remove_property_ids: ids(5, 90) }, { supabase: store.supabase });
  assert.equal(result.status, 422);
  assert.equal(result.would_remove, 5);
  assert.equal(pinnedOnRow(store).length, 100);
});

test("clear_explicit_selection drops the whole pinned set on purpose (switching to a market audience)", async () => {
  const store = seeded(ids(500));
  const refused = await updateCampaign(ID, { target_filters: { properties: [{ field_key: "properties.market", operator: "is_any_of", value: ["Dallas, TX"] }] } }, { supabase: store.supabase });
  assert.equal(refused.status, 422, "replacing the pinned set with a market filter is a shrink to zero");
  const result = await updateCampaign(ID, { clear_explicit_selection: true, target_filters: { properties: [{ field_key: "properties.market", operator: "is_any_of", value: ["Dallas, TX"] }] } }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.equal(pinnedOnRow(store).length, 0);
});

test("a save that does not carry target_filters is never judged (rename keeps 2,010)", async () => {
  const store = seeded(ids(2010));
  const result = await updateCampaign(ID, { name: "HOT LEADS · 10-10" }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.equal(pinnedOnRow(store).length, 2010);
});

test("explicitSelectionShrink is pure: no pinned set before → nothing to guard", () => {
  assert.equal(explicitSelectionShrink({ metadata: {} }, { target_filters: pinned([]) }, {}), null);
  assert.equal(explicitSelectionShrink({ metadata: { target_filters: pinned(ids(3)) } }, { target_filters: pinned(ids(3)) }, {}), null);
  assert.equal(explicitSelectionShrink({ metadata: { target_filters: pinned(ids(3)) } }, { target_filters: pinned(ids(2)) }, {}).status, 422);
});
