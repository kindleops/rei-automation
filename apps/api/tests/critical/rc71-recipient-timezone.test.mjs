/**
 * RC 7.1 D10 — quiet hours never fall back to Chicago.
 * rc-8.5.21 S3: the zone is resolved by queue/recipient-window-policy.js — the recipient's area code
 * first, the property / stored zone only narrows, no recipient evidence ⇒ the continental intersection.
 *
 * Owner: "missing timezone must never fall back to Chicago for recipient
 * contact windows. Recipient/property timezone needs to remain authoritative."
 * The recipient's zone is the property's (state + ZIP for split states), else
 * the zone recorded on the row; when neither exists the send is HELD.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSendQueueInsertPayload,
  evaluateContactWindow,
  loadRunnableSendQueueRows,
  normalizeSendQueueRow,
} from "@/lib/supabase/sms-engine.js";
import {
  resolveRecipientTimezone,
  rowNeedsPropertyGeography,
  storedTimezoneToIana,
} from "@/lib/domain/queue/recipient-timezone.js";
import { makeSendQueueRowsSupabase } from "../helpers/queue-run-test-harness.js";

// 08:30 Central = 06:30 Pacific (2026-04-04, both on DST).
const EARLY = "2026-04-04T13:30:00.000Z";
// 10:00 Central = 08:00 Pacific.
const MORNING = "2026-04-04T15:00:00.000Z";

const row = (over = {}) => ({
  id: "sq-tz-1",
  queue_key: "campaign:x:1",
  queue_status: "queued",
  scheduled_for: "2026-04-04T13:00:00.000Z",
  message_body: "Hi John, this is Chris. Do you still own 123 Main St?",
  to_phone_number: "+13235550100",
  from_phone_number: "+16125092623",
  seller_first_name: "John",
  template_id: "208481",
  campaign_target_id: "11111111-1111-4111-8111-111111111111",
  touch_number: 1,
  metadata: { selected_template_id: "208481", candidate_snapshot: { seller_first_name: "John" } },
  ...over,
});

test("a BLANK zone on a Pacific property is no longer a Central send at 06:30 local", () => {
  const verdict = evaluateContactWindow(row({ timezone: null, property_address_state: "CA", property_address_zip: "90011" }), { now: EARLY });
  assert.equal(verdict.allowed, false, "06:30 Pacific is outside the window");
  assert.equal(verdict.reason, "outside_local_send_window");
  assert.equal(verdict.timezone, "America/Los_Angeles");
  // rc-8.5.21 S3: the recipient's own area code (323, Los Angeles) is the basis; the property narrows
  assert.equal(verdict.timezone_basis, "recipient_area_code");
  assert.equal(verdict.next_open_at, "2026-04-04T15:00:00.000Z", "08:00 Pacific");
});

// rc-8.5.21 S3 (recipient-window-policy.js): the recipient's phone is evidence (323 above is Los
// Angeles), so "no zone anywhere" needs a non-geographic number. Nothing at all ⇒ HOLD (unchanged);
// a stored zone / the property alone ⇒ UNKNOWN ⇒ the conservative continental intersection
// (08:00 PT … 21:00 ET): 15:00Z on 2026-04-04 is 08:00 PT / 11:00 ET, its first open instant.
const NON_GEO = "+15005550100";
test("no zone anywhere → HOLD with a clear reason; no zone is assumed", () => {
  const verdict = evaluateContactWindow(row({ timezone: null, to_phone_number: NON_GEO }), { now: MORNING });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.hold, true);
  assert.equal(verdict.reason, "recipient_timezone_unresolved");
  assert.equal(verdict.timezone, null);
});

test("an unrecognised stored zone is not Chicago either", () => {
  const verdict = evaluateContactWindow(row({ timezone: "Narnia", to_phone_number: NON_GEO }), { now: MORNING });
  assert.equal(verdict.hold, true);
});

test("a stored zone or the property alone is never the recipient zone: a Central-stored, Illinois-property row with no recipient evidence waits for 08:00 Pacific", () => {
  for (const over of [{ timezone: "Central" }, { timezone: null, property_address_state: "IL", property_address_zip: "60601" }]) {
    const early = evaluateContactWindow(row({ to_phone_number: NON_GEO, ...over }), { now: EARLY });
    assert.equal(early.allowed, false, JSON.stringify(over));
    assert.equal(early.hold === true, false);
    assert.equal(early.timezone, null, "unknown is never shown as a zone");
    assert.equal(early.timezone_certainty, "unknown");
    assert.equal(early.next_open_at, MORNING);
    assert.equal(evaluateContactWindow(row({ to_phone_number: NON_GEO, ...over }), { now: MORNING }).allowed, true);
  }
});

test("the property is authoritative over a contradicting stored zone (geography wins)", () => {
  const verdict = evaluateContactWindow(row({ timezone: "Central", property_address_state: "CA", property_address_zip: "90011" }), { now: EARLY });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.timezone, "America/Los_Angeles");
  assert.equal(verdict.stored_timezone_corrected, true);
});

test("split-state ZIP decides (El Paso TX is Mountain); a split state without a ZIP falls to the stored zone", () => {
  assert.equal(resolveRecipientTimezone(row({ timezone: "Central", property_address_state: "TX", property_address_zip: "79901" })).iana, "America/Denver");
  const noZip = resolveRecipientTimezone(row({ timezone: "Central", property_address_state: "TX" }));
  assert.equal(noZip.iana, "America/Chicago");
  assert.equal(noZip.basis, "stored_recipient_timezone");
  assert.equal(resolveRecipientTimezone(row({ timezone: null, property_address_state: "TX" })).ok, false, "ambiguous and nothing stored → hold");
});

test("rows that carry only a property_id are placed from the properties table", () => {
  const onlyId = row({ timezone: null, property_id: "prop_la_1" });
  assert.equal(rowNeedsPropertyGeography(onlyId), true);
  const verdict = evaluateContactWindow(onlyId, { now: EARLY, propertyGeography: { state: "CA", zip: "90011" } });
  assert.equal(verdict.timezone, "America/Los_Angeles");
  assert.equal(verdict.timezone_basis, "recipient_area_code");
  assert.ok(verdict.zones.includes("America/Los_Angeles"));
  assert.equal(verdict.allowed, false);
  // the property record still narrows: an Eastern-area-code owner of the same LA property waits for 08:00 PT
  const absentee = evaluateContactWindow({ ...onlyId, to_phone_number: "+12125550100" }, { now: EARLY, propertyGeography: { state: "CA", zip: "90011" } });
  assert.deepEqual([absentee.allowed, absentee.timezone, absentee.next_open_at], [false, "America/New_York", MORNING]);
});

test("stored labels and IANA names are read; nothing defaults", () => {
  assert.equal(storedTimezoneToIana("Pacific"), "America/Los_Angeles");
  assert.equal(storedTimezoneToIana("America/Phoenix"), "America/Phoenix");
  assert.equal(storedTimezoneToIana(""), null);
  assert.equal(storedTimezoneToIana("Central Time-ish"), null);
});

test("normalisation and the insert payload no longer stamp America/Chicago", () => {
  assert.equal(normalizeSendQueueRow(row({ timezone: null })).timezone, null);
  assert.equal(normalizeSendQueueRow(row({ property_address_state: "CA" })).property_address_state, "CA");
  assert.equal(buildSendQueueInsertPayload(row({ timezone: null })).timezone, null);
});

test("pre-claim: an unplaceable row is HELD (paused, operator-visible) — not deferred to a guessed morning", async () => {
  const paused = [];
  const result = await loadRunnableSendQueueRows(10, {
    now: MORNING,
    stale_lock_recovery_enabled: false,
    supabaseClient: makeSendQueueRowsSupabase([row({ timezone: null, to_phone_number: NON_GEO })]),
    pauseInvalidQueueRow: async (normalized, payload) => { paused.push({ id: normalized.id, payload }); return { ...normalized, ...payload }; },
  });
  assert.equal(result.rows.length, 0);
  assert.equal(paused.length, 1);
  assert.equal(paused[0].payload.queue_status, "paused_invalid_queue_row");
  assert.equal(paused[0].payload.paused_reason, "recipient_timezone_unresolved");
});

test("pre-claim: one batched properties read places rows that carry only a property_id", async () => {
  const lookups = [];
  const result = await loadRunnableSendQueueRows(10, {
    now: EARLY,
    stale_lock_recovery_enabled: false,
    supabaseClient: makeSendQueueRowsSupabase([
      row({ id: "a", timezone: null, property_id: "prop_la_1" }),
      row({ id: "b", timezone: "Central", property_id: "prop_la_2", to_phone_number: "+13235550101" }),
    ]),
    loadPropertyGeography: async (_supabase, ids) => {
      lookups.push([...ids].sort());
      return new Map([["prop_la_1", { state: "CA", zip: "90011" }], ["prop_la_2", { state: "CA", zip: "90012" }]]);
    },
    pauseInvalidQueueRow: async () => { throw new Error("nothing should be paused"); },
  });
  assert.deepEqual(lookups, [["prop_la_1", "prop_la_2"]], "one read for the batch");
  assert.equal(result.rows.length, 0, "06:30 Pacific: both deferred — including the one stored as Central");
  assert.equal(result.preclaim_outside_window_excluded_count, 2);
});

test("an immediate reply to a seller who just texted is exempt from the window, so it is not held for a zone", async () => {
  const reply = row({
    id: "sq-reply",
    timezone: null,
    queue_key: "inbound_auto_reply:evt_1",
    type: "auto_reply",
    created_at: "2026-04-04T14:59:00.000Z",
    metadata: { source: "auto_reply", candidate_snapshot: { seller_first_name: "John" } },
  });
  const result = await loadRunnableSendQueueRows(10, {
    now: MORNING,
    stale_lock_recovery_enabled: false,
    supabaseClient: makeSendQueueRowsSupabase([reply]),
    pauseInvalidQueueRow: async () => { throw new Error("an exempt reply must not be held"); },
  });
  assert.equal(result.rows.length, 1);
});
