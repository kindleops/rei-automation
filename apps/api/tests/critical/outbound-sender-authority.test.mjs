/**
 * SENDER AUTHORITY AT DISPATCH (§55).
 *
 * THE DEFECT. `selectAvailableTextgridNumber` short-circuited on any queue row
 * that already carried `from_phone_number` and returned it with NO eligibility
 * check whatsoever:
 *
 *     if (clean(normalized.from_phone_number)) return { ok: true, ... }
 *
 * Status, cooling and daily caps were consulted only on the ROTATION branch —
 * the one that runs when a row has no sender. For every normal campaign row,
 * where the sender is chosen at materialization, the sole dispatch-time
 * validation was therefore the operator blocklist inside
 * `evaluateSmsHealthGuard` (which checks blocked_sender_numbers and
 * blocked_template_ids, and nothing else). A number that went paused, went
 * cooling, or blew its daily cap AFTER the row was enqueued still sent.
 *
 * `validateQueuedOutboundNumberItem` in process-send-queue looked like it
 * covered this. It has zero callers, and it checks `hard_pause` / `pause_until`
 * columns that do not exist on `public.textgrid_numbers`.
 *
 * WHY ELIGIBILITY IS DENY-LISTED. Measured against the live fleet while writing
 * this: 12 numbers, ALL carrying `health_state:'unverified'` — including the 10
 * that are `status:'active'` and sending — with `registration_status` NULL on
 * every row, `daily_limit` 800 and a maximum `messages_sent_today` of 3. A gate
 * expressed as "must be healthy and registered" would have stopped every send in
 * the system. So a state has to be recognisably bad to block, and anything
 * unrecognised falls through to the layers that already govern sending.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOutboundNumberEligibility,
  selectAvailableTextgridNumber,
} from "@/lib/supabase/sms-engine.js";

const ACTIVE = {
  id: "num-active",
  phone_number: "+13055376631",
  status: "active",
  health_state: "unverified",
  daily_limit: 800,
  messages_sent_today: 3,
};

const rowWith = (from) => ({
  id: "queue-1",
  to_phone_number: "+13055550100",
  from_phone_number: from,
  message_body: "hello",
});

test("the production default — active and unverified — is allowed to send", () => {
  assert.equal(evaluateOutboundNumberEligibility(ACTIVE).ok, true);
});

test("a paused number is refused", () => {
  const verdict = evaluateOutboundNumberEligibility({ ...ACTIVE, status: "paused" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "outbound_number_status_paused");
});

test("a cooling number is refused", () => {
  const verdict = evaluateOutboundNumberEligibility({ ...ACTIVE, health_state: "cooling" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "outbound_number_health_cooling");
});

test("an open cooling window blocks, and a closed one does not", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  assert.equal(
    evaluateOutboundNumberEligibility({ ...ACTIVE, cooling_until: "2026-01-01T13:00:00.000Z" }, now).reason,
    "outbound_number_cooling_until"
  );
  assert.equal(
    evaluateOutboundNumberEligibility({ ...ACTIVE, cooling_until: "2026-01-01T11:00:00.000Z" }, now).ok,
    true
  );
});

test("a number at its daily cap is refused", () => {
  const verdict = evaluateOutboundNumberEligibility({ ...ACTIVE, messages_sent_today: 800 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "outbound_number_daily_limit_reached");
});

test("a sender that is not in the fleet is refused", () => {
  assert.equal(evaluateOutboundNumberEligibility(null).reason, "outbound_number_not_in_fleet");
});

test("an unrecognised state does not stop the fleet", () => {
  assert.equal(
    evaluateOutboundNumberEligibility({ ...ACTIVE, status: "warming", health_state: "probation" }).ok,
    true
  );
});

test("the intended sender dispatches while it is still eligible", async () => {
  const selection = await selectAvailableTextgridNumber(rowWith(ACTIVE.phone_number), {
    loadOutboundNumberByPhone: async () => ACTIVE,
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.from_phone_number, ACTIVE.phone_number);
  assert.equal(selection.reason, "queue_row_from_phone_number_revalidated");
});

for (const [label, patch, reason] of [
  ["paused after enqueue", { status: "paused" }, "outbound_number_status_paused"],
  ["cooling after enqueue", { health_state: "cooling" }, "outbound_number_health_cooling"],
  ["capped after enqueue", { messages_sent_today: 800 }, "outbound_number_daily_limit_reached"],
]) {
  test(`a sender that became ineligible does not send: ${label}`, async () => {
    const selection = await selectAvailableTextgridNumber(rowWith(ACTIVE.phone_number), {
      loadOutboundNumberByPhone: async () => ({ ...ACTIVE, ...patch }),
    });
    assert.equal(selection.ok, false);
    assert.equal(selection.reason, reason);
    assert.equal(selection.ineligible_sender, true);
    // The load-bearing property: no substitute sender is offered.
    assert.equal(selection.selected, null);
    assert.equal(selection.from_phone_number, ACTIVE.phone_number);
  });
}

test("an ineligible sender is never silently rotated to a different working number", async () => {
  const selection = await selectAvailableTextgridNumber(rowWith(ACTIVE.phone_number), {
    loadOutboundNumberByPhone: async () => ({ ...ACTIVE, status: "paused" }),
    // Rotation would put campaign traffic on a sender the campaign never chose
    // and the operator cannot see. It must not be reached for an intended sender.
    selectAvailableTextgridNumber: async () => {
      throw new Error("rotation must not be reached for an intended sender");
    },
  });
  assert.equal(selection.ok, false);
  assert.equal(selection.from_phone_number, ACTIVE.phone_number);
});

test("an unreadable fleet defers rather than sending", async () => {
  const selection = await selectAvailableTextgridNumber(rowWith(ACTIVE.phone_number), {
    loadOutboundNumberByPhone: async () => {
      throw new Error("supabase unreachable");
    },
  });
  assert.equal(selection.ok, false);
  assert.equal(selection.deferred, true);
  assert.equal(selection.ineligible_sender, true);
  assert.equal(selection.reason, "outbound_number_eligibility_unavailable");
});

test("rotation applies the same eligibility rules as revalidation", async () => {
  // The rotation filter used to carry its own partial rules — status and daily
  // cap, but not cooling — so a cooling number was excluded from a revalidated
  // send and eligible for a rotated one.
  const fleet = [
    { ...ACTIVE, id: "cooling", phone_number: "+13055376600", health_state: "cooling" },
    { ...ACTIVE, id: "healthy", phone_number: "+13055376611" },
  ];
  const supabase = {
    from: () => ({
      select: () => ({
        order: () => ({
          order: () => ({ limit: async () => ({ data: fleet, error: null }) }),
        }),
      }),
    }),
  };
  const selection = await selectAvailableTextgridNumber(rowWith(null), { supabase });
  assert.equal(selection.ok, true);
  assert.equal(selection.from_phone_number, "+13055376611");
});
