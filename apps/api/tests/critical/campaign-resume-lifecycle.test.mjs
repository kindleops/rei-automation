import test from "node:test";
import assert from "node:assert/strict";

import { fetchCampaignFailureRows } from "@/lib/domain/campaigns/campaign-failures.js";
import { buildCampaignCommandSummary } from "@/lib/domain/campaigns/campaign-command-summary.js";

const CAMPAIGN_ID = "320c798a-84c9-45b8-a7c9-d166ddd7bd46";

function makeChain(table, selectedColumns, terminalResult) {
  const chain = {
    select(columns) {
      selectedColumns.push({ table, columns });
      if (table === "send_queue") {
        assert.ok(
          !String(columns).includes("failure_category"),
          "must not query missing send_queue.failure_category"
        );
      }
      if (table === "campaign_targets") {
        assert.ok(
          !String(columns).includes("seller_full_name"),
          "must not query missing campaign_targets.seller_full_name"
        );
        assert.ok(
          !String(columns).includes("property_address_full"),
          "must not query missing campaign_targets.property_address_full"
        );
      }
      return chain;
    },
    eq() {
      return chain;
    },
    in() {
      return chain;
    },
    not() {
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    maybeSingle: async () => terminalResult,
    single: async () => terminalResult,
    head: true,
    then(resolve) {
      return Promise.resolve(terminalResult).then(resolve);
    },
  };
  return chain;
}

function schemaSafeSupabase() {
  const selectedColumns = [];
  return {
    selectedColumns,
    from(table) {
      if (table === "campaigns") {
        return makeChain(
          table,
          selectedColumns,
          {
            data: {
              id: CAMPAIGN_ID,
              status: "paused",
              auto_send_enabled: false,
              auto_queue_enabled: true,
              daily_cap: 5,
              batch_max: 5,
              market_cap: 5,
              per_sender_cap: 5,
              contact_window_start: "08:00",
              contact_window_end: "21:00",
              metadata: { stage_code: "S1", template_use_case: "ownership_check" },
            },
            error: null,
          }
        );
      }
      if (table === "campaign_runs") {
        return makeChain(table, selectedColumns, { data: null, error: null });
      }
      if (table === "send_queue") {
        return makeChain(table, selectedColumns, { data: [], error: null });
      }
      if (table === "campaign_targets") {
        return makeChain(table, selectedColumns, { data: [], count: 0, error: null });
      }
      if (table === "system_control") {
        return makeChain(table, selectedColumns, { data: null, error: null });
      }
      return makeChain(table, selectedColumns, { data: [], error: null });
    },
  };
}

test("fetchCampaignFailureRows does not query send_queue.failure_category", async () => {
  const supabase = schemaSafeSupabase();
  const result = await fetchCampaignFailureRows(CAMPAIGN_ID, { supabase });
  assert.equal(result.ok, true);
  const queueSelect = supabase.selectedColumns.find((entry) => entry.table === "send_queue");
  assert.ok(queueSelect);
  assert.ok(!queueSelect.columns.includes("failure_category"));
});

test("buildCampaignCommandSummary does not query send_queue.failure_category", async () => {
  const supabase = schemaSafeSupabase();
  const summary = await buildCampaignCommandSummary(CAMPAIGN_ID, {
    supabase,
    getSystemValue: async (key) => {
      if (key === "queue_emergency_stop_at") return "2026-06-25T18:32:22.386Z";
      if (key === "queue_processor_mode") return "off";
      if (key === "queue_auto_enqueue_enabled") return "false";
      if (key === "outbound_sms_enabled") return "true";
      return null;
    },
  });
  assert.equal(summary.ok, true);
  const queueSelect = supabase.selectedColumns.find((entry) => entry.table === "send_queue");
  assert.ok(queueSelect);
  assert.ok(!queueSelect.columns.includes("failure_category"));
});