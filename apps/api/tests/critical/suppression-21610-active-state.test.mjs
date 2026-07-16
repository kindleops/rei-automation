// ─── suppression-21610-active-state.test.mjs ─────────────────────────────────
// Contract for isPhoneSuppressedFor21610 is_active handling (PR #27 lineage):
//   • only is_active=true list rows block when canonical rows exist
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

/**
 * Mock supabase for the canonical-first 21610 resolver.
 * listRows: full sms_suppression_list rows for the phone
 * queueRows / eventRows: historical evidence ids
 */
function makeSupabase({ listRows = [], queueRows = [], eventRows = [], throwOn = null } = {}) {
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
          let rows = queueRows.slice();
          if (filters.to_phone_number) rows = rows.filter((r) => r.to_phone_number === filters.to_phone_number);
          if (filters.from_phone_number) {
            rows = rows.filter((r) => r.from_phone_number === filters.from_phone_number);
          }
          return { data: rows, error: null, count: rows.length };
        }
        if (table === "message_events") {
          let rows = eventRows.slice();
          if (filters.to_phone_number) rows = rows.filter((r) => r.to_phone_number === filters.to_phone_number);
          if (filters.from_phone_number) {
            rows = rows.filter((r) => r.from_phone_number === filters.from_phone_number);
          }
          if (filters.failure_bucket) {
            rows = rows.filter((r) => r.failure_bucket === filters.failure_bucket);
          }
          return { data: rows, error: null, count: rows.length };
        }
        if (table === "sms_suppression_list") {
          let rows = listRows.slice();
          if (filters.phone_e164) rows = rows.filter((r) => r.phone_e164 === filters.phone_e164);
          // New resolver loads all rows for the phone (active + inactive) then filters in JS.
          // Keep is_active filter for any legacy callers.
          if (filters.is_active !== undefined) {
            rows = rows.filter((r) => r.is_active === filters.is_active);
          }
          if (filters.sender_phone_e164) {
            rows = rows.filter((r) => r.sender_phone_e164 === filters.sender_phone_e164);
          }
          if (filters["is:sender_phone_e164"] === null) {
            rows = rows.filter((r) => r.sender_phone_e164 == null);
          }
          return { data: rows, error: null, count: rows.length };
        }
        return { data: [], error: null, count: 0 };
      }

      return chain;
    },
  };
}

test("active recipient suppression (null sender) blocks any from", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        id: "rec-active",
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
  assert.equal(withFrom.blocked_by_active_21610, true);

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
        id: "rec-inactive",
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
  assert.equal(result["21610_gate"], "clear");
});

test("active pair suppression blocks only matching sender/recipient", async () => {
  const supabase = makeSupabase({
    listRows: [
      {
        id: "pair-active",
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
        id: "pair-inactive",
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
        id: "a",
        phone_e164: TO,
        is_active: true,
        sender_phone_e164: null,
        suppression_reason: "21610 a",
      },
      {
        id: "b",
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
        id: "old",
        phone_e164: TO,
        is_active: false,
        sender_phone_e164: null,
        suppression_reason: "old 21610",
      },
      {
        id: "active-pair",
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
  assert.equal(match.blocked_by_active_21610, true);
});
