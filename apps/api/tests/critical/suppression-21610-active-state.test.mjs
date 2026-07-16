// ─── suppression-21610-active-state.test.mjs ─────────────────────────────────
// Contract for isPhoneSuppressedFor21610:
//   • only is_active=true list rows block
//   • pair-scoped vs recipient-scoped remain distinct
//   • inactive historical rows do not block
//   • lookup failures fail closed

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { isPhoneSuppressedFor21610 } from "@/lib/supabase/sms-engine.js";

const TO = "+16128072000";
const FROM = "+16128060495";
const OTHER_FROM = "+16125551212";

function makeSupabase({ listRows = [], queueCount = 0, eventCount = 0, throwOn = null } = {}) {
  return {
    from(table) {
      const filters = {};
      const chain = {
        select() {
          return chain;
        },
        eq(col, val) {
          filters[col] = val;
          return chain;
        },
        is(col, val) {
          filters[`is:${col}`] = val;
          return chain;
        },
        in(col, vals) {
          filters[`in:${col}`] = vals;
          return chain;
        },
        or(expr) {
          filters.or = expr;
          return chain;
        },
        ilike(col, val) {
          filters[`ilike:${col}`] = val;
          return chain;
        },
        then(resolve) {
          return Promise.resolve(run()).then(resolve);
        },
      };

      function run() {
        if (throwOn === table) {
          return { data: null, error: new Error(`forced_lookup_error:${table}`), count: null };
        }
        if (table === "send_queue") {
          return { data: null, error: null, count: queueCount };
        }
        if (table === "message_events") {
          return { data: null, error: null, count: eventCount };
        }
        if (table === "sms_suppression_list") {
          let rows = listRows.slice();
          if (filters.phone_e164) rows = rows.filter((r) => r.phone_e164 === filters.phone_e164);
          if (filters.is_active !== undefined) rows = rows.filter((r) => r.is_active === filters.is_active);
          if (filters.sender_phone_e164) {
            rows = rows.filter((r) => r.sender_phone_e164 === filters.sender_phone_e164);
          }
          if (filters["is:sender_phone_e164"] === null) {
            rows = rows.filter((r) => r.sender_phone_e164 == null);
          }
          // Simulate 21610 text filter when or/ilike present
          if (filters.or || filters["ilike:suppression_reason"]) {
            rows = rows.filter(
              (r) =>
                /21610/i.test(String(r.suppression_reason || "")) ||
                /21610/i.test(String(r.reason || ""))
            );
          }
          return { data: null, error: null, count: rows.length };
        }
        return { data: null, error: null, count: 0 };
      }

      // head:true select returns thenable with count
      return chain;
    },
  };
}

test("active recipient suppression (null sender) blocks any from", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        phone_e164: TO,
        is_active: true,
        sender_phone_e164: null,
        suppression_type: "blacklist_pair",
        suppression_reason: "code 21610 blacklist",
      },
    ],
  });
  const withFrom = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase }
  );
  assert.equal(withFrom.suppressed, true);
  assert.equal(withFrom.scope, "recipient");

  const other = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: OTHER_FROM },
    { supabase }
  );
  assert.equal(other.suppressed, true);
  assert.equal(other.scope, "recipient");
});

test("inactive recipient suppression does not block", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        phone_e164: TO,
        is_active: false,
        sender_phone_e164: null,
        suppression_reason: "code 21610 blacklist",
      },
    ],
  });
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase }
  );
  assert.equal(result.suppressed, false);
});

test("active pair suppression blocks only matching sender/recipient", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        phone_e164: TO,
        is_active: true,
        sender_phone_e164: FROM,
        suppression_type: "blacklist_pair",
        suppression_reason: "TextGrid 21610 pair",
      },
    ],
  });
  const match = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase }
  );
  assert.equal(match.suppressed, true);
  assert.equal(match.scope, "pair");

  const other = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: OTHER_FROM },
    { supabase }
  );
  assert.equal(other.suppressed, false, "different sender must not be pair-blocked");
});

test("inactive pair suppression does not block", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        phone_e164: TO,
        is_active: false,
        sender_phone_e164: FROM,
        suppression_reason: "21610",
      },
    ],
  });
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase }
  );
  assert.equal(result.suppressed, false);
});

test("duplicate active suppression rows still block once", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        phone_e164: TO,
        is_active: true,
        sender_phone_e164: null,
        suppression_reason: "21610 a",
      },
      {
        phone_e164: TO,
        is_active: true,
        sender_phone_e164: null,
        suppression_reason: "21610 b",
      },
    ],
  });
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase }
  );
  assert.equal(result.suppressed, true);
  assert.equal(result.scope, "recipient");
});

test("lookup failure fails closed", async () => {
  const supabase = makeSupabase({ throwOn: "sms_suppression_list" });
  const result = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase }
  );
  assert.equal(result.suppressed, true);
  assert.equal(result.scope, "lookup_failed");
  assert.equal(result.reason, "phone_suppressed_21610");
});

test("historical inactive evidence coexists with active pair without false clear", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        phone_e164: TO,
        is_active: false,
        sender_phone_e164: null,
        suppression_reason: "old 21610",
      },
      {
        phone_e164: TO,
        is_active: true,
        sender_phone_e164: FROM,
        suppression_reason: "active 21610 pair",
      },
    ],
  });
  const match = await isPhoneSuppressedFor21610(
    { to_phone_number: TO, from_phone_number: FROM },
    { supabase }
  );
  assert.equal(match.suppressed, true);
  assert.equal(match.scope, "pair");
});
