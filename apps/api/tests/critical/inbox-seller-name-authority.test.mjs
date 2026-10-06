// RC 8.4.3 — Inbox seller name authority.
//
// Prod 10-05: thread +18177347618 has inbox_thread_state.seller_display_name =
// "Jose G Deleon", yet the operator's manual sends carried the formatted phone
// as seller_full_name and every inbound reply after them was stamped
// message_events.seller_display_name = "(817) 734-7618". A phone is never a
// name; the canonical thread name outranks anything inherited from the latest
// send_queue / message_events row of the phone pair.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isPhoneLikeName,
  isRealPersonName,
  mergeLinkedContextIntoThreadRow,
  bulkHydrateInboxThreadLinkedContext,
} from "../../src/lib/domain/inbox/hydrate-inbox-thread-linked-context.js";
import {
  enrichMessageEventContext,
  buildMessageEventEnrichmentUpdate,
} from "../../src/lib/domain/inbox/enrich-message-event-context.js";
import { applyInboxRowComputedFields } from "../../src/lib/domain/inbox/live-inbox-service.js";

const JOSE_PHONE = "+18177347618";
const OUR_NUMBER = "+14693131600";

describe("isPhoneLikeName", () => {
  it("treats formatted, E.164, bare and fragment phones as not-a-name", () => {
    for (const value of ["(817) 734-7618", "+18177347618", "8177347618", "+1 (817) 734-7618", "817.734.7618", "(817)"]) {
      assert.equal(isPhoneLikeName(value), true, value);
      assert.equal(isRealPersonName(value), false, value);
    }
  });
  it("keeps real names, including names with digits or accents", () => {
    for (const value of ["Jose G Deleon", "José Deleón", "Abel M Arana Jr.", "2832 Milam LLC"]) {
      assert.equal(isPhoneLikeName(value), false, value);
      assert.equal(isRealPersonName(value), true, value);
    }
    assert.equal(isRealPersonName("Unknown Seller"), false);
  });
});

describe("linked-context merge prefers the canonical thread name", () => {
  it("drops a phone-shaped owner/seller name and takes inbox_thread_state.seller_display_name", () => {
    const merged = mergeLinkedContextIntoThreadRow(
      { thread_key: JOSE_PHONE, property_id: "2135720821", owner_name: "(817) 734-7618", seller_display_name: "(817) 734-7618", seller_phone: JOSE_PHONE },
      {
        propertyById: new Map([["2135720821", { property_id: "2135720821", property_address_full: "2832 Milam St, Fort Worth, Tx 76112" }]]),
        ownerById: new Map(),
        prospectById: new Map(),
        contextByThreadKey: new Map(),
        threadStateNameByKey: new Map([[JOSE_PHONE, "Jose G Deleon"]]),
      },
    );
    assert.equal(merged.seller_display_name, "Jose G Deleon");
    assert.equal(merged.owner_name, "Jose G Deleon");
  });

  it("bulk hydrate reads inbox_thread_state names only for rows that arrived nameless", async () => {
    const calls = [];
    const supabase = {
      from(table) {
        return {
          select() { return this; },
          async in(column, values) {
            calls.push({ table, values });
            if (table === "inbox_thread_state") {
              return { data: values.map((thread_key) => ({ thread_key, seller_display_name: thread_key === JOSE_PHONE ? "Jose G Deleon" : null })) };
            }
            return { data: [] };
          },
        };
      },
    };
    const rows = await bulkHydrateInboxThreadLinkedContext([
      { thread_key: JOSE_PHONE, seller_display_name: "(817) 734-7618" },
      { thread_key: "+16125550100", seller_display_name: "Gale D Leflore" },
    ], supabase);
    assert.equal(rows[0].seller_display_name, "Jose G Deleon");
    assert.equal(rows[1].seller_display_name, "Gale D Leflore");
    const stateCall = calls.find((call) => call.table === "inbox_thread_state");
    assert.deepEqual(stateCall.values, [JOSE_PHONE]);
  });
});

describe("live inbox row display name", () => {
  it("ranks the thread name above an event-inherited phone", () => {
    const row = applyInboxRowComputedFields(
      { thread_key: JOSE_PHONE, seller_display_name: null, event_seller_display_name: "(817) 734-7618", owner_display_name: "Jose Deleon" },
      { skip_keyword_analysis: true },
    );
    assert.equal(row.seller_display_name, "Jose Deleon");
  });
  it("returns null rather than a phone when no name exists", () => {
    const row = applyInboxRowComputedFields(
      { thread_key: JOSE_PHONE, event_seller_display_name: "(817) 734-7618" },
      { skip_keyword_analysis: true },
    );
    assert.equal(row.seller_display_name, null);
  });
});

// Minimal PostgREST-shaped fake: every filter is recorded; the row returned
// per table is chosen by whether the query asked for a named queue row.
function fakeSupabase({ threadState, latestQueue, namedQueue, latestEvent }) {
  return {
    from(table) {
      const q = { table, filters: [] };
      const chain = {
        select() { return chain; },
        eq(column, value) { q.filters.push(["eq", column, value]); return chain; },
        or(expr) { q.filters.push(["or", expr]); return chain; },
        not(column, op, value) { q.filters.push(["not", column, op, value]); return chain; },
        order() { return chain; },
        limit() { return chain; },
        async maybeSingle() {
          if (table === "inbox_thread_state") return { data: threadState, error: null };
          if (table === "send_queue") {
            const wantsNamed = q.filters.some((f) => f[0] === "not" && f[1] === "seller_display_name");
            return { data: wantsNamed ? namedQueue : latestQueue, error: null };
          }
          if (table === "message_events") return { data: latestEvent, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}

const MANUAL_SEND_ROW = {
  id: "q-manual",
  to_phone_number: JOSE_PHONE,
  from_phone_number: OUR_NUMBER,
  property_id: "2135720821",
  prospect_id: "1501934271",
  seller_display_name: null,
  seller_first_name: "(817)",
  metadata: { source: "inbox", candidate_snapshot: { seller_full_name: "(817) 734-7618" } },
};

const INBOUND = {
  direction: "inbound",
  from_phone_number: JOSE_PHONE,
  to_phone_number: OUR_NUMBER,
  message_body: "Yes",
  metadata: {},
};

describe("inbound enrichment never stamps a phone as seller_display_name", () => {
  it("inherits inbox_thread_state.seller_display_name after an operator manual send", async () => {
    const enriched = await enrichMessageEventContext(INBOUND, fakeSupabase({
      threadState: { thread_key: JOSE_PHONE, seller_display_name: "Jose G Deleon" },
      latestQueue: MANUAL_SEND_ROW,
      namedQueue: null,
      latestEvent: { direction: "outbound", seller_display_name: null, metadata: {} },
    }));
    const update = buildMessageEventEnrichmentUpdate(enriched);
    assert.equal(update.seller_display_name, "Jose G Deleon");
    assert.equal(update.metadata.enrichment.seller_name, "Jose G Deleon");
    assert.equal(update.property_id, "2135720821");
  });

  it("keeps the owner link from the thread when the manual-send queue row dropped it (same property only)", async () => {
    const same = await enrichMessageEventContext(INBOUND, fakeSupabase({
      threadState: { thread_key: JOSE_PHONE, seller_display_name: "Jose G Deleon", property_id: "2135720821", master_owner_id: "mo-1", prospect_id: "1501934271" },
      latestQueue: MANUAL_SEND_ROW,
      namedQueue: null,
      latestEvent: null,
    }));
    assert.equal(buildMessageEventEnrichmentUpdate(same).master_owner_id, "mo-1");

    const other = await enrichMessageEventContext(INBOUND, fakeSupabase({
      threadState: { thread_key: JOSE_PHONE, seller_display_name: "Jose G Deleon", property_id: "999", master_owner_id: "mo-other" },
      latestQueue: MANUAL_SEND_ROW,
      namedQueue: null,
      latestEvent: null,
    }));
    const otherUpdate = buildMessageEventEnrichmentUpdate(other);
    assert.equal(otherUpdate.property_id, "2135720821");
    assert.equal(otherUpdate.master_owner_id, null);
  });

  it("falls back to the latest NAMED queue row (the campaign target) when thread state has no name", async () => {
    const enriched = await enrichMessageEventContext(INBOUND, fakeSupabase({
      threadState: null,
      latestQueue: MANUAL_SEND_ROW,
      namedQueue: { ...MANUAL_SEND_ROW, id: "q-campaign", seller_display_name: "Jose G Deleon", metadata: { source: "campaign_launch_execution" } },
      latestEvent: null,
    }));
    assert.equal(buildMessageEventEnrichmentUpdate(enriched).seller_display_name, "Jose G Deleon");
  });

  it("leaves the name null (never the phone) when no real name exists anywhere", async () => {
    const enriched = await enrichMessageEventContext(INBOUND, fakeSupabase({
      threadState: null,
      latestQueue: MANUAL_SEND_ROW,
      namedQueue: null,
      latestEvent: { direction: "inbound", seller_display_name: "(817) 734-7618", metadata: { enrichment: { seller_name: "(817) 734-7618" } } },
    }));
    const update = buildMessageEventEnrichmentUpdate(enriched);
    assert.equal(update.seller_display_name, null);
    assert.equal(update.metadata.enrichment.seller_name, null);
  });
});
