import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bulkHydrateInboxThreadLinkedContext,
  isRealDisplayValue,
  mergeLinkedContextIntoThreadRow,
} from "../../src/lib/domain/inbox/hydrate-inbox-thread-linked-context.js";

describe("Inbox linked context hydration", () => {
  it("rejects placeholder condition values", () => {
    assert.equal(isRealDisplayValue("Unknown"), false);
    assert.equal(isRealDisplayValue("Good"), true);
  });

  it("merges owner, property, and financial fields from linked records", () => {
    const maps = {
      propertyById: new Map([[
        "prop-1",
        {
          property_id: "prop-1",
          property_address_full: "123 Main St, Dallas, TX 75001",
          market: "Dallas, TX",
          property_type: "SFR",
          units_count: 4,
          estimated_value: 300000,
          equity_percent: 55,
          equity_amount: 165000,
          final_acquisition_score: 82,
          building_condition: "Good",
        },
      ]]),
      ownerById: new Map([[
        "mo-1",
        { master_owner_id: "mo-1", display_name: "Jane Owner", priority_score: 77 },
      ]]),
      prospectById: new Map([[
        "pros-1",
        { prospect_id: "pros-1", full_name: "Jane Prospect" },
      ]]),
      contextByThreadKey: new Map([[
        "thread-1",
        { thread_key: "thread-1", universal_stage: "stage_2" },
      ]]),
    };

    const merged = mergeLinkedContextIntoThreadRow({
      thread_key: "thread-1",
      property_id: "prop-1",
      master_owner_id: "mo-1",
      prospect_id: "pros-1",
      seller_phone: "+15551234567",
    }, maps);

    assert.equal(merged.owner_name, "Jane Owner");
    assert.equal(merged.property_address_full, "123 Main St, Dallas, TX 75001");
    assert.equal(merged.market, "Dallas, TX");
    assert.equal(merged.property_type, "SFR");
    assert.equal(merged.units_count, 4);
    assert.equal(merged.estimated_value, 300000);
    assert.equal(merged.equity_percent, 55);
    assert.equal(merged.equity_amount, 165000);
    assert.equal(merged.final_acquisition_score, 82);
    assert.equal(merged.building_condition, "Good");
    assert.equal(merged.conversation_stage, "stage_2");
  });

  it("hides unknown condition and uses formatted phone when names are missing", () => {
    const maps = {
      propertyById: new Map([[
        "prop-2",
        {
          property_id: "prop-2",
          property_address_full: "9 Oak Ave",
          building_condition: "Unknown",
        },
      ]]),
      ownerById: new Map(),
      prospectById: new Map(),
      contextByThreadKey: new Map(),
    };

    const merged = mergeLinkedContextIntoThreadRow({
      thread_key: "thread-2",
      property_id: "prop-2",
      seller_phone: "+15559876543",
    }, maps);

    assert.equal(merged.owner_name, "(555) 987-6543");
    assert.equal(merged.building_condition, null);
  });

  it("bulk hydrates rows with batched lookups", async () => {
    const calls = [];
    const supabase = {
      from(table) {
        return {
          select() {
            return this;
          },
          async in(column, values) {
            calls.push({ table, column, values });
            if (table === "properties") {
              return {
                data: values.map((property_id) => ({
                  property_id,
                  property_address_full: `${property_id} Main`,
                  estimated_value: 100000,
                  property_type: "SFR",
                })),
              };
            }
            if (table === "master_owners") {
              return {
                data: values.map((master_owner_id) => ({
                  master_owner_id,
                  display_name: `Owner ${master_owner_id}`,
                })),
              };
            }
            if (table === "prospects") return { data: [] };
            if (table === "deal_context_index") return { data: [] };
            return { data: [] };
          },
        };
      },
    };

    const rows = await bulkHydrateInboxThreadLinkedContext([
      { thread_key: "t1", property_id: "p1", master_owner_id: "mo1" },
      { thread_key: "t2", property_id: "p2", master_owner_id: "mo2" },
    ], supabase);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].owner_name, "Owner mo1");
    assert.equal(rows[0].property_address_full, "p1 Main");
    assert.equal(calls.filter((call) => call.table === "properties").length, 1);
    assert.equal(calls.filter((call) => call.table === "master_owners").length, 1);
  });
});