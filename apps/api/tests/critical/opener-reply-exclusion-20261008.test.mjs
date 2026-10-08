// 2026-10-08: a seller who replied "not for sale — gave it to my daughter"
// (9-28) got a different campaign's touch-1 (10-06). The planner's "already
// queued" / "already contacted" gates looked rows up by the 10-digit target
// phone (send_queue stores E.164), and nothing read a not-owner reply.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createCampaignQueuePlan } from "@/lib/domain/campaigns/campaign-automation-service.js";
import {
  evaluateOpenerReplyExclusion,
  phoneKey,
  phoneLookupVariants,
} from "@/lib/domain/campaigns/opener-reply-exclusion.js";
import { makeCampaignQueuePlanStore, makeCampaignQueuePlanDeps } from "../helpers/campaign-queue-plan-store.mjs";

const NOW = "2026-05-04T15:00:00.000Z"; // Monday 10:00 America/Chicago
const MIAMI = "Miami, FL";
const BLOCKED = "+13058975670";

function makeCampaign(id, overrides = {}) {
  return {
    id,
    name: `Scheduling truth ${id}`,
    status: "built",
    objective: "ownership_check",
    market: MIAMI,
    auto_queue_enabled: true,
    auto_send_enabled: false,
    auto_reply_mode: "disabled",
    emergency_stop_at: null,
    daily_cap: 750,
    total_cap: 1000,
    batch_max: 2,
    market_cap: 400,
    per_sender_cap: 150,
    send_interval_seconds: 45,
    contact_window_start: "08:00",
    contact_window_end: "21:00",
    language_policy: "auto",
    metadata: { stage_code: "S1", template_use_case: "ownership_check" },
    scheduled_for: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeReadyTarget(index, overrides = {}) {
  return {
    id: `tgt_${index}`,
    campaign_id: "camp_1",
    target_status: "ready",
    routing_status: "ready",
    suppression_status: "clear",
    template_status: "pending",
    priority_score: 100 - index,
    master_owner_id: `mo_${index}`,
    prospect_id: `pr_${index}`,
    property_id: `prop_${index}`,
    to_phone_number: `+1555123${String(1000 + index).slice(-4)}`,
    market: MIAMI,
    state: "FL",
    timezone: "America/New_York",
    identity_status: "verified",
    language: null,
    owner_name: "John Smith",
    metadata: {
      candidate_snapshot: {
        seller_first_name: "John",
        seller_full_name: "John Smith",
        owner_display_name: "John Smith",
        property_address_full: `${index} Main St, Miami, FL 33101`,
        property_city: "Miami",
        property_zip: "33101",
      },
      outreach_snapshot: {
        never_contacted: true,
        touch_count: 0,
        true_post_contact_suppression: false,
        wrong_number: false,
        pending_prior_touch: false,
        active_queue_item: false,
      },
    },
    ...overrides,
  };
}

const TEMPLATE = {
  id: "tpl_en_1",
  template_id: "tpl_en_1",
  is_active: true,
  use_case: "ownership_check",
  language: "English",
  stage_code: "S1",
  is_first_touch: true,
  template_body: "Hi {{seller_first_name}}, this is {{agent_name}}. Do you still own {{property_address}}?",
  allowed_property_groups: [],
  prohibited_property_groups: [],
};

function number(phone, overrides = {}) {
  return {
    id: `tg_${phone.slice(-4)}`,
    phone_number: phone,
    market: MIAMI,
    status: "active",
    health_state: "unverified",
    cooling_until: null,
    daily_limit: 800,
    messages_sent_today: 0,
    last_used_at: null,
    ...overrides,
  };
}

/** Miami as production had it on 2026-09-30. */
const MIAMI_FLEET = [
  number("+13057604780", { status: "paused" }),
  number(BLOCKED), // active, never used — lowest usage, operator-blocked
  number("+17866052999", { health_state: "cooling", messages_sent_today: 2, last_used_at: "2026-09-12T18:23:12Z" }),
];

const blockedSets = async () => ({ template_ids: new Set(), sender_numbers: new Set([BLOCKED]) });

function setup({ fleet = MIAMI_FLEET, targets = 3, campaign = {} } = {}) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", makeCampaign("camp_1", campaign));
  store.seedRow("sms_templates", { ...TEMPLATE });
  store.seedRow("sms_templates", { ...TEMPLATE, id: "tpl_en_2", template_id: "tpl_en_2", template_body: "Hello {{seller_first_name}}, {{agent_name}} here. Is {{property_address}} still yours?" });
  for (const row of fleet) store.seedRow("textgrid_numbers", row);
  for (let i = 1; i <= targets; i += 1) store.seedRow("campaign_targets", makeReadyTarget(i));
  const deps = makeCampaignQueuePlanDeps(store, { loadDispatchBlockedSets: blockedSets });
  return { store, deps };
}


// ── pure ─────────────────────────────────────────────────────────────────────

test("phone shapes share one key; lookups carry both shapes", () => {
  assert.equal(phoneKey("6125550123"), "6125550123");
  assert.equal(phoneKey("+16125550123"), "6125550123");
  assert.deepEqual(phoneLookupVariants(["6125550123"]).sort(), ["+16125550123", "6125550123"]);
});

test("not-owner exclusion is person × property; wrong number is phone-wide", () => {
  const formerOwner = { threads: [{ property_id: "p1", disposition: "not_interested", last_intent: "former_owner_respondent" }] };
  assert.equal(evaluateOpenerReplyExclusion({ property_id: "p1", ...formerOwner }).excluded, true);
  assert.equal(evaluateOpenerReplyExclusion({ property_id: "p2", ...formerOwner }).excluded, false);
  const wrong = { threads: [{ property_id: "p1", disposition: "wrong_number" }] };
  assert.equal(evaluateOpenerReplyExclusion({ property_id: "p2", ...wrong }).scope, "phone");
  const reply = { replies: [{ property_id: "p1", detected_intent: "sold_property" }] };
  assert.equal(evaluateOpenerReplyExclusion({ property_id: "p1", ...reply }).source, "inbound_reply");
  assert.equal(evaluateOpenerReplyExclusion({ property_id: "p1", threads: [{ property_id: "p1", disposition: "not_interested", last_intent: "not_interested" }] }).excluded, false);
});

// ── the planner ──────────────────────────────────────────────────────────────

test("planner: 10-digit targets hit the active-queue gate and the not-owner reply gate", async () => {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", makeCampaign("camp_1", { batch_max: 10 }));
  store.seedRow("sms_templates", { ...TEMPLATE });
  store.seedRow("textgrid_numbers", number("+13055550100"));
  store.seedRow("textgrid_numbers", number("+13055550101"));
  const ten = (i) => `555123${String(1000 + i).slice(-4)}`;
  for (let i = 1; i <= 5; i += 1) store.seedRow("campaign_targets", makeReadyTarget(i, { to_phone_number: ten(i) }));
  // 1: a 30-day nurture is scheduled for this seller (E.164 in send_queue).
  store.seedRow("send_queue", { id: "sq_nurture", to_phone_number: `+1${ten(1)}`, queue_status: "scheduled", use_case_template: "nurture_not_interested" });
  // 2: thread says former owner of THIS property.
  store.seedRow("inbox_thread_state", { thread_key: `+1${ten(2)}`, property_id: "prop_2", disposition: "not_interested", last_intent: "former_owner_respondent" });
  // 3: not the owner of a DIFFERENT property — this property is still fair game.
  store.seedRow("inbox_thread_state", { thread_key: `+1${ten(3)}`, property_id: "prop_other", last_intent: "property_specific_non_owner" });
  // 4: the inbound reply itself was classified sold_property for this property.
  store.seedRow("message_events", { id: "me_4", direction: "inbound", from_phone_number: `+1${ten(4)}`, property_id: "prop_4", detected_intent: "sold_property" });

  const deps = makeCampaignQueuePlanDeps(store, { loadDispatchBlockedSets: blockedSets });
  const result = await createCampaignQueuePlan("camp_1", { now: NOW, dry_run: true, full_cohort: true }, deps);
  const skipped = result.skipped_counts_by_reason || {};
  assert.equal(skipped.active_queue_row_exists, 1, JSON.stringify(skipped));
  assert.equal(skipped.prior_reply_not_owner, 2, JSON.stringify(skipped));
  assert.equal(result.schedulable_target_count, 2, JSON.stringify(skipped));
});
