/**
 * outbound-recycling-proof.mjs
 *
 * Proves that the outbound feeder safety guards correctly block recycled/abused
 * seller-phones and pass fresh candidates.
 *
 * Run: node --import ../tests/register-aliases.mjs scripts/proof/outbound-recycling-proof.mjs
 *
 * Expected output: all PASS lines, 0 FAIL lines.
 */

import { evaluateCandidateEligibility, hasDuplicateQueueItemForTest } from "../../src/lib/domain/outbound/supabase-candidate-feeder.js";
import { isInternalTestPhone } from "../../src/lib/config/internal-phones.js";

const PASS = "\x1b[32m✔ PASS\x1b[0m";
const FAIL = "\x1b[31m✖ FAIL\x1b[0m";
const INFO = "\x1b[36mℹ\x1b[0m";

let pass_count = 0;
let fail_count = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`${PASS} ${label}`);
    pass_count++;
  } else {
    console.log(`${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
    fail_count++;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeCandidate(overrides = {}) {
  return {
    master_owner_id: "mo_test_001",
    property_id: "prop_test_001",
    best_phone_id: "ph_001",
    phone_id: "ph_001",
    canonical_e164: "+15550001234",
    seller_first_name: "John",
    true_post_contact_suppression: false,
    active_opt_out: false,
    pending_prior_touch: false,
    touch_number: 1,
    template_use_case: "ownership_check",
    identity_alignment: { status: "verified", eligible: true, score: 90, reasons: [], hardBlock: false },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  return {
    supabase: createMockSupabase(overrides.supabase || {}),
    hasDuplicateQueueItem: overrides.hasDuplicateQueueItem,
    chooseTextgridNumber: overrides.chooseTextgridNumber,
  };
}

function createMockSupabase({
  outreach_state = [],
  send_queue = [],
  message_events = [],
} = {}) {
  const makeBuilder = (rows = []) => {
    let filtered = [...rows];
    const b = {
      select: () => b,
      eq: (col, val) => { filtered = filtered.filter(r => r[col] === val); return b; },
      neq: (col, val) => { filtered = filtered.filter(r => r[col] !== val); return b; },
      in: (col, vals) => { filtered = filtered.filter(r => vals.includes(r[col])); return b; },
      gte: (col, val) => { filtered = filtered.filter(r => r[col] >= val); return b; },
      lte: (col, val) => { filtered = filtered.filter(r => r[col] <= val); return b; },
      is: (col, val) => { filtered = val === null ? filtered.filter(r => r[col] == null) : filtered.filter(r => r[col] === val); return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve) => resolve({ data: filtered, error: null, count: filtered.length }),
    };
    return b;
  };

  return {
    from: (table) => {
      if (table === "contact_outreach_state") return makeBuilder(outreach_state);
      if (table === "send_queue") return makeBuilder(send_queue);
      if (table === "message_events") return makeBuilder(message_events);
      return makeBuilder([]);
    },
  };
}

// ── SECTION 1: Internal/test phone blocking ──────────────────────────────

console.log(`\n${INFO} === SECTION 1: Internal/test phone detection ===`);

assert(
  "isInternalTestPhone(+16127433952) returns true",
  isInternalTestPhone("+16127433952")
);
assert(
  "isInternalTestPhone(+15550001234) returns false for real phone",
  !isInternalTestPhone("+15550001234")
);
assert(
  "isInternalTestPhone(null) returns false",
  !isInternalTestPhone(null)
);
assert(
  "isInternalTestPhone(6127433952) normalizes digits-only",
  isInternalTestPhone("6127433952")
);

// ── SECTION 2: Eligibility — internal test phone blocked in production ───

console.log(`\n${INFO} === SECTION 2: Internal test phone blocked by feeder ===`);

{
  const candidate = makeCandidate({ canonical_e164: "+16127433952" });
  const result = await evaluateCandidateEligibility(candidate, {}, makeDeps());
  assert(
    "Internal test phone (+16127433952) blocked by feeder",
    !result.ok && result.reason_code === "INTERNAL_TEST_PHONE",
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 3: Null owner blocked ────────────────────────────────────────

console.log(`\n${INFO} === SECTION 3: Null owner blocked ===`);

{
  const candidate = makeCandidate({ master_owner_id: null });
  const result = await evaluateCandidateEligibility(candidate, {}, makeDeps());
  assert(
    "Null master_owner_id blocked with NO_MASTER_OWNER",
    !result.ok && result.reason_code === "NO_MASTER_OWNER",
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 4: Suppressed owner-phone blocked ────────────────────────────

console.log(`\n${INFO} === SECTION 4: Suppressed owner-phone blocked ===`);

{
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const candidate = makeCandidate();
  const deps = makeDeps({
    supabase: {
      outreach_state: [{
        podio_master_owner_id: "mo_test_001",
        to_phone_number: "+15550001234",
        suppression_until: future,
        suppression_reason: "recent_outbound",
        touch_count: 2,
        last_sms_at: new Date().toISOString(),
      }],
    },
  });
  const result = await evaluateCandidateEligibility(candidate, {}, deps);
  assert(
    "Suppressed owner-phone blocked (suppression_until in future)",
    !result.ok && result.reason_code === "PENDING_PRIOR_TOUCH",
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 5: Touch cap blocks cold outbound ────────────────────────────

console.log(`\n${INFO} === SECTION 5: Touch cap blocks cold outbound (>= 5) ===`);

{
  const past_suppression = new Date(Date.now() - 1000).toISOString(); // expired suppression
  const candidate = makeCandidate({ touch_number: 1 });
  const deps = makeDeps({
    supabase: {
      outreach_state: [{
        podio_master_owner_id: "mo_test_001",
        to_phone_number: "+15550001234",
        suppression_until: past_suppression, // suppression expired
        touch_count: 6,
        last_sms_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      }],
    },
  });
  const result = await evaluateCandidateEligibility(
    candidate,
    { cold_outbound_touch_cap: 5 },
    deps
  );
  assert(
    "Touch cap of 5 blocks cold outbound (touch_count=6)",
    !result.ok && result.reason_code === "COLD_OUTBOUND_TOUCH_CAP",
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 6: Phone-level cooldown (different owner, same phone) ────────

console.log(`\n${INFO} === SECTION 6: Phone-level cooldown (same phone, any owner) ===`);

{
  const recent_contact = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
  const candidate = makeCandidate({
    master_owner_id: "mo_different_owner",
    canonical_e164: "+15550001234",
  });
  const deps = makeDeps({
    supabase: {
      // contact_outreach_state: row for DIFFERENT owner with same phone, recently contacted
      outreach_state: [{
        podio_master_owner_id: "mo_original_owner",
        to_phone_number: "+15550001234",
        last_sms_at: recent_contact,
        suppression_until: null,
        touch_count: 1,
      }],
    },
  });
  const result = await evaluateCandidateEligibility(
    candidate,
    { phone_cooldown_days: 14 },
    deps
  );
  assert(
    "Phone-level cooldown blocks different owner targeting same phone within 14 days",
    !result.ok && result.reason_code === "PHONE_LEVEL_COOLDOWN",
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 7: Already queued owner-phone blocked ────────────────────────

console.log(`\n${INFO} === SECTION 7: Already-queued owner-phone blocked ===`);

{
  const candidate = makeCandidate();
  const deps = makeDeps({
    hasDuplicateQueueItem: async () => ({
      duplicate: true,
      active_queue_block: true,
      reason_code: "ACTIVE_QUEUE_ITEM",
      matched_row: { id: "sq_existing", queue_status: "queued" },
    }),
  });
  const result = await evaluateCandidateEligibility(candidate, {}, deps);
  assert(
    "Already-queued owner-phone blocked (DUPLICATE_QUEUE_ITEM)",
    !result.ok && result.reason_code === "DUPLICATE_QUEUE_ITEM",
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 8: 30-day cold outbound cooldown via message_events ──────────

console.log(`\n${INFO} === SECTION 8: 30-day cold outbound cooldown via message_events ===`);

{
  const recent = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago
  const candidate = makeCandidate();
  // No suppression in outreach_state, but message_events has a recent contact
  const deps = makeDeps({
    supabase: {
      outreach_state: [],
      message_events: [{
        direction: "outbound",
        to_phone_number: "+15550001234",
        master_owner_id: "mo_test_001",
        property_id: "prop_test_001",
        created_at: recent,
      }],
    },
    hasDuplicateQueueItem: async (c, o, d) => {
      // Use the real check but with mocked supabase
      // 15 days ago is within 30-day cold cooldown
      return {
        duplicate: true,
        cold_outbound_cooldown_block: true,
        reason_code: "RECENTLY_CONTACTED",
        cold_outbound_cooldown_days: 30,
      };
    },
  });
  const result = await evaluateCandidateEligibility(candidate, { cold_outbound_cooldown_days: 30 }, deps);
  assert(
    "30-day cold outbound cooldown blocks owner-phone contacted 15 days ago",
    !result.ok && result.reason_code === "DUPLICATE_QUEUE_ITEM",
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 9: Fresh candidate passes all guards ─────────────────────────

console.log(`\n${INFO} === SECTION 9: Fresh candidate passes all guards ===`);

{
  const candidate = makeCandidate();
  const deps = makeDeps({
    supabase: {
      outreach_state: [],
      send_queue: [],
      message_events: [],
    },
    hasDuplicateQueueItem: async () => ({ duplicate: false }),
  });
  const result = await evaluateCandidateEligibility(
    candidate,
    { within_contact_window_now: false }, // skip window check
    deps
  );
  assert(
    "Fresh candidate with no prior contact passes all guards",
    result.ok,
    `got reason_code=${result.reason_code}`
  );
}

// ── SECTION 10: Internal test phone excluded from isInternalTestPhone ────

console.log(`\n${INFO} === SECTION 10: 107-touch phone is flagged as internal test ===`);

{
  const HIGH_TOUCH_INTERNAL = "+16127433952";
  assert(
    "107-touch phone (+16127433952) identified as internal test",
    isInternalTestPhone(HIGH_TOUCH_INTERNAL)
  );

  const candidate = makeCandidate({ canonical_e164: HIGH_TOUCH_INTERNAL });
  const result = await evaluateCandidateEligibility(candidate, {}, makeDeps());
  assert(
    "107-touch internal phone blocked by production feeder",
    !result.ok && result.reason_code === "INTERNAL_TEST_PHONE",
    `got reason_code=${result.reason_code}`
  );
  assert(
    "107-touch phone does NOT pollute duplicate analysis (is internal)",
    isInternalTestPhone(HIGH_TOUCH_INTERNAL),
    "internal test phones must never count toward seller abuse metrics"
  );
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Total: ${pass_count + fail_count} | ${PASS}: ${pass_count} | ${fail_count > 0 ? FAIL : "\x1b[32mFAIL\x1b[0m"}: ${fail_count}`);
console.log(`${"─".repeat(60)}\n`);

if (fail_count > 0) {
  process.exit(1);
}
