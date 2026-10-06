// Pure helpers of scripts/ops/reply-quality-report.mjs (no DB, no network).
import test from "node:test";
import assert from "node:assert/strict";

import {
  redactText,
  initials,
  suspectFlags,
  baseBucket,
  localMidnightUtc,
  memorySupabase,
} from "../../scripts/ops/reply-quality-report.mjs";

test("redaction: phones masked format-preserving, names → Pat, street names → placeholders, urls/emails replaced", () => {
  const out = redactText(
    "Hola Martin, call (817) 555-1234 or +1 214 808 0732, talk to Charles Smith about 1621 Michael St. See https://zillow.com/homedetails/1621-Michael-St/12345_zpid or me@x.com",
    { names: ["Martin Pulido"], addresses: ["1621 Michael St"] }
  );
  assert.ok(!/Martin|Pulido|Charles|Smith|Michael/.test(out), out);
  assert.ok(!/817|1234|808|0732/.test(out), out);
  assert.match(out, /Hola Pat/);
  assert.match(out, /talk to Pat/);
  assert.match(out, /1621 Main St/);
  assert.match(out, /https:\/\/example\.com\/listing\/\d+/);
  assert.match(out, /seller@example\.com/);
});

test("redaction keeps the words the classifier reads", () => {
  assert.equal(redactText("Si. Dejé de molestar"), "Si. Dejé de molestar");
  assert.equal(redactText("199k sale"), "199k sale");
  assert.equal(redactText("No i am not sell the house of 3521 Elmwood Dr", {}), "No i am not sell the house of 3521 Main St");
});

test("initials: names become initials; phone-like display names are withheld", () => {
  assert.equal(initials("Martin Pulido"), "M.P.");
  assert.equal(initials("(+1) 817-555-0100"), "—");
  assert.equal(initials(""), "—");
});

test("suspect: opt-out words read as ownership, URL read as price, bare Yes sent to review", () => {
  assert.deepEqual(suspectFlags({ body: "Si. Dejé de molestar", intent: "ownership_confirmed", base: "AUTO_OK" }).map((f) => f.code), ["optout_words_not_optout"]);
  assert.ok(suspectFlags({ body: "https://www.zillow.com/x/123", intent: "asking_price_provided", base: "AUTO_FAILED" }).some((f) => f.code === "url_read_as_price"));
  assert.ok(suspectFlags({ body: "Yes", intent: "ownership_confirmed", base: "REVIEW" }).some((f) => f.code === "bare_affirmative_to_review"));
  assert.ok(suspectFlags({ body: "Send a bid", intent: "unclear", base: "REVIEW" }).some((f) => f.code === "offer_request_unclear"));
  assert.deepEqual(suspectFlags({ body: "Stop", intent: "opt_out", base: "SUPPRESSED_OK", suppression_applied: true }), []);
});

test("bucket: a reply cancelled because the seller wrote again is not a failure", () => {
  const row = { intent: "ownership_confirmed", autopilot: [], reply: { queue_status: "cancelled", cancellation_reason: "superseded_by_newer_inbound", use_case: "consider_selling" } };
  assert.equal(baseBucket(row).bucket, "NO_REPLY_BY_DESIGN");
  assert.equal(baseBucket({ ...row, reply: { queue_status: "delivered", use_case: "consider_selling" } }).bucket, "AUTO_OK");
  assert.equal(baseBucket({ ...row, reply: { queue_status: "blocked_sender_ineligible", failed_reason: "outbound_number_daily_limit_reached" } }).bucket, "AUTO_FAILED");
  assert.equal(baseBucket({ intent: "asking_price_provided", autopilot: [{ reason: "template_render_failed", template_use_case: "condition_probe" }], should_queue_reply: true }).bucket, "AUTO_FAILED");
  assert.equal(baseBucket({ intent: "opt_out", autopilot: [], suppression_applied: true }).bucket, "SUPPRESSED_OK");
});

test("local day window is DST-correct for America/Chicago", () => {
  assert.equal(localMidnightUtc("2026-10-05", "America/Chicago").toISOString(), "2026-10-05T05:00:00.000Z");
  assert.equal(localMidnightUtc("2026-12-05", "America/Chicago").toISOString(), "2026-12-05T06:00:00.000Z");
});

test("memorySupabase applies eq/in/gt/lt/order/limit like the PostgREST chain", async () => {
  const sb = memorySupabase({ t: [{ k: "a", at: "2026-10-05T10:00:00Z" }, { k: "a", at: "2026-10-05T12:00:00Z" }, { k: "b", at: "2026-10-05T11:00:00Z" }] });
  const { data } = await sb.from("t").select("*").eq("k", "a").gt("at", "2026-10-05T09:00:00Z").order("at", { ascending: false }).limit(1);
  assert.deepEqual(data, [{ k: "a", at: "2026-10-05T12:00:00Z" }]);
});
