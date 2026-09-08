/**
 * inbound-reply-outreach-cadence.test.mjs
 *
 * Defect E (2026-09-08): checkInboundAutoReplySuppression read
 * contact_outreach_state.suppression_reason -- which outreach-service stamps
 * 'recent_outbound' for 45 days after EVERY outbound we send -- and treated it
 * as a reason not to reply. Every reply to a first touch was suppressed
 * (4 of the first 7, including an ownership confirmation; still firing 3h later).
 *
 * Contract: a cadence marker written by our own outbound never blocks a reply.
 * The DNC list, a non-cadence outreach block, and the fail-closed lookup path
 * are unchanged.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { checkInboundAutoReplySuppression } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const OWNER = "owner-1";
const PHONE = "+13055550142";
const FUTURE = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

/** Fake supabase: sms_suppression_list + contact_outreach_state, optionally erroring. */
function fakeSupabase({ dnc = [], outreach = [], outreachError = null } = {}) {
  const chain = (rows, error = null) => {
    const q = {
      select() { return q; }, eq() { return q; }, in() { return q; }, or() { return q; }, is() { return q; }, gte() { return q; }, order() { return q; },
      limit: async () => ({ data: rows, error }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error }),
      then(res) { return Promise.resolve({ data: rows, error }).then(res); },
    };
    return q;
  };
  return {
    from(table) {
      if (table === "sms_suppression_list") return chain(dnc);
      if (table === "contact_outreach_state") return chain(outreach, outreachError);
      return chain([]);
    },
  };
}

const run = (supabase) => checkInboundAutoReplySuppression({ supabaseClient: supabase, supabase, ownerId: OWNER, phoneNumber: PHONE, phone: PHONE });

test("our own recent outbound (recent_outbound, 45-day window) does NOT suppress a reply", async () => {
  const r = await run(fakeSupabase({ outreach: [{ id: "o1", suppression_until: FUTURE, suppression_reason: "recent_outbound" }] }));
  assert.equal(r.suppressed, false, JSON.stringify(r));
  assert.equal(r.reason, null);
});

test("the default cadence label recent_contact does NOT suppress a reply either", async () => {
  const r = await run(fakeSupabase({ outreach: [{ id: "o1", suppression_until: FUTURE, suppression_reason: "recent_contact" }] }));
  assert.equal(r.suppressed, false, JSON.stringify(r));
});

test("a NON-cadence outreach block still suppresses", async () => {
  const r = await run(fakeSupabase({ outreach: [{ id: "o1", suppression_until: FUTURE, suppression_reason: "manual_block" }] }));
  assert.equal(r.suppressed, true);
  assert.equal(r.reason, "manual_block");
});

test("an expired cadence window is simply not a suppression", async () => {
  const r = await run(fakeSupabase({ outreach: [{ id: "o1", suppression_until: PAST, suppression_reason: "recent_outbound" }] }));
  assert.equal(r.suppressed, false);
});

test("the DNC list still wins regardless of outreach state", async () => {
  const r = await run(fakeSupabase({ dnc: [{ id: "d1", phone_number: PHONE, is_active: true, suppression_reason: "stop" }], outreach: [] }));
  assert.equal(r.suppressed, true, JSON.stringify(r));
});

test("an outreach lookup failure still fails CLOSED", async () => {
  const r = await run(fakeSupabase({ outreachError: { code: "XX000", message: "boom" } }));
  assert.equal(r.suppressed, true);
  assert.equal(r.reason, "outreach_suppression_lookup_failed");
});
