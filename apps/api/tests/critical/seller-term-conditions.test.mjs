/**
 * seller-term-conditions.test.mjs
 *
 * "I'll do 185 if you close before the 20th" is ONE fact. Flattening it to
 * `seller price = 185000` is the most expensive normalization mistake available
 * in this phase: the number survives, the condition does not, and weeks later
 * somebody offers 185 with a 45-day close and cannot understand why the seller
 * is angry.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractConditions,
  normalizeRelativeTime,
  hasMaterialCondition,
  CONDITION_KIND,
  EVENT_DRIVEN_CONDITIONS,
} from "../../src/lib/domain/seller-intelligence/term-conditions.js";

// A Tuesday, so weekday arithmetic is checkable by hand.
const WROTE_AT = "2026-09-08T18:00:00.000Z";

// ── conditions are found and kept ─────────────────────────────────────────

test("a closing deadline is captured, not dropped", () => {
  const conditions = extractConditions("I'd do 185 if you close before the 20th.", { reference_iso: WROTE_AT });
  const close = conditions.find((c) => c.kind === CONDITION_KIND.CLOSE_BEFORE);
  assert.ok(close, "the closing condition vanished");
  assert.equal(close.date, "2026-09-20");
});

test("as-is is a condition", () => {
  const conditions = extractConditions("190 as-is.", { reference_iso: WROTE_AT });
  assert.ok(conditions.some((c) => c.kind === CONDITION_KIND.AS_IS));
});

test("who pays the taxes is a condition", () => {
  const conditions = extractConditions("200 if you cover the taxes.", { reference_iso: WROTE_AT });
  assert.ok(conditions.some((c) => c.kind === CONDITION_KIND.BUYER_PAYS_TAXES));
});

test("cash-only and closing costs are conditions", () => {
  assert.ok(extractConditions("185 cash only.").some((c) => c.kind === CONDITION_KIND.CASH_ONLY));
  assert.ok(
    extractConditions("195 if you pay the closing costs.").some(
      (c) => c.kind === CONDITION_KIND.BUYER_PAYS_CLOSING_COSTS
    )
  );
});

test("a co-owner's approval is a condition, not a detail", () => {
  const conditions = extractConditions("I'd take 200 but my sister has to agree.");
  assert.ok(conditions.some((c) => c.kind === CONDITION_KIND.REQUIRES_CO_OWNER_APPROVAL));
});

test("an unconditional term carries no conditions", () => {
  assert.deepEqual(extractConditions("I'd take 185.", { reference_iso: WROTE_AT }), []);
  assert.equal(hasMaterialCondition([]), false);
});

// ── the dates we refuse to invent ─────────────────────────────────────────

test("an event-driven condition NEVER acquires a date", () => {
  // "Once the tenant is out" has no date in it. Inventing one -- a guess at 30
  // days, a lease we have not seen -- produces a deadline the seller never
  // agreed to, and it is wrong in the direction of chasing them too early.
  const conditions = extractConditions("180 once the tenant is out.", { reference_iso: WROTE_AT });
  const tenant = conditions.find((c) => c.kind === CONDITION_KIND.AFTER_TENANT_VACANCY);
  assert.ok(tenant);
  assert.equal(tenant.event_driven, true);
  assert.equal(tenant.date, null);
});

test("no event-driven condition anywhere carries a date", () => {
  for (const text of [
    "180 once the tenant is out.",
    "I can sell after the probate is settled.",
    "185 once the estate clears.",
  ]) {
    for (const condition of extractConditions(text, { reference_iso: WROTE_AT })) {
      if (EVENT_DRIVEN_CONDITIONS.has(condition.kind)) {
        assert.equal(condition.date, null, `${text} produced a date for ${condition.kind}`);
      }
    }
  }
});

test("a closing condition phrased around an event stays event-driven", () => {
  // "Close after the tenant moves out" uses a closing verb but is still an
  // event. The verb must not smuggle a date in.
  const conditions = extractConditions("We could close after the tenant moves out.", { reference_iso: WROTE_AT });
  const close_after = conditions.find((c) => c.kind === CONDITION_KIND.CLOSE_AFTER);
  if (close_after) assert.equal(close_after.date, null);
});

// ── relative time, against the moment the seller wrote it ─────────────────

test("relative time resolves against the COMMUNICATION timestamp, not now()", () => {
  // A message processed three days late would otherwise land three days wrong.
  const a = normalizeRelativeTime("tomorrow", WROTE_AT);
  assert.equal(a.date, "2026-09-09");

  const later = normalizeRelativeTime("tomorrow", "2026-10-01T00:00:00.000Z");
  assert.equal(later.date, "2026-10-02");
});

test("two weeks is a window, and it is days rather than a price", () => {
  const result = normalizeRelativeTime("two weeks", WROTE_AT);
  assert.equal(result.ok, true);
  assert.equal(result.days, 14);
});

test("end of month resolves to the last day of the seller's month", () => {
  assert.equal(normalizeRelativeTime("end of the month", WROTE_AT).date, "2026-09-30");
});

test("before the 20th means the NEXT 20th, not one already past", () => {
  // A seller writing this on the 25th means next month.
  assert.equal(normalizeRelativeTime("before the 20th", "2026-09-25T12:00:00.000Z").date, "2026-10-20");
  assert.equal(normalizeRelativeTime("before the 20th", "2026-09-08T12:00:00.000Z").date, "2026-09-20");
});

test("a weekday resolves forward and says it made an assumption", () => {
  // 2026-09-08 is a Tuesday; Friday is the 11th.
  const result = normalizeRelativeTime("Friday", WROTE_AT);
  assert.equal(result.date, "2026-09-11");
  assert.equal(result.weekday_assumed, true);
});

test("next Friday is a week beyond Friday", () => {
  assert.equal(normalizeRelativeTime("next Friday", WROTE_AT).date, "2026-09-18");
});

test("an unresolvable phrase is reported, never guessed", () => {
  for (const phrase of ["after Christmas", "when things settle down", "after the holidays", "soon"]) {
    const result = normalizeRelativeTime(phrase, WROTE_AT);
    assert.equal(result.ok, false, phrase);
    assert.equal(result.reason, "not_deterministically_resolvable");
  }
});

test("with no reference timestamp nothing resolves, rather than falling back to now()", () => {
  for (const reference of ["", null, undefined, "not a date"]) {
    const result = normalizeRelativeTime("Friday", reference);
    assert.equal(result.ok, false, String(reference));
    assert.equal(result.reason, "no_reference_timestamp");
  }
});

test("every normalization keeps the seller's original phrase", () => {
  // When a normalization is wrong -- and over enough sellers it will be -- the
  // original is what lets somebody see that it was.
  const resolved = normalizeRelativeTime("End Of The Month", WROTE_AT);
  assert.ok(resolved.phrase.length > 0);

  const unresolved = normalizeRelativeTime("after Christmas", WROTE_AT);
  assert.ok(unresolved.phrase.length > 0);
});

// ── multiple conditions ───────────────────────────────────────────────────

test("several conditions on one term are all kept", () => {
  const conditions = extractConditions(
    "I'd take 185 as-is if you close before the 20th and cover the taxes.",
    { reference_iso: WROTE_AT }
  );
  const kinds = conditions.map((c) => c.kind);
  assert.ok(kinds.includes(CONDITION_KIND.AS_IS));
  assert.ok(kinds.includes(CONDITION_KIND.BUYER_PAYS_TAXES));
  assert.ok(kinds.includes(CONDITION_KIND.CLOSE_BEFORE));
  assert.equal(hasMaterialCondition(conditions), true);
});

test("the same condition twice is recorded once", () => {
  const conditions = extractConditions("As-is. Strictly as is.", { reference_iso: WROTE_AT });
  assert.equal(conditions.filter((c) => c.kind === CONDITION_KIND.AS_IS).length, 1);
});

// ── hostile input ─────────────────────────────────────────────────────────

test("extraction never throws and never hangs", () => {
  for (const value of [null, undefined, "", 0, [], {}, { text: {} }, "if you close ".repeat(5_000)]) {
    const started = Date.now();
    assert.doesNotThrow(() => extractConditions(value, { reference_iso: WROTE_AT }), String(value).slice(0, 20));
    assert.ok(Date.now() - started < 5_000);
  }
});

test("relative-time normalization never throws", () => {
  for (const value of [null, undefined, "", 0, [], {}]) {
    assert.doesNotThrow(() => normalizeRelativeTime(value, WROTE_AT));
    assert.doesNotThrow(() => normalizeRelativeTime("Friday", value));
  }
});

test("hasMaterialCondition never throws on a non-array", () => {
  for (const value of [null, undefined, "", 0, {}, "nope"]) {
    assert.doesNotThrow(() => hasMaterialCondition(value));
    assert.equal(hasMaterialCondition(value), false);
  }
});

// ── who pays is the whole meaning ─────────────────────────────────────────

test("an elided subject after a conjunction still means the BUYER pays", () => {
  // "if you close before the 20th and cover the taxes" -- the second clause has
  // no subject of its own. Missing it drops a term the seller made material.
  const conditions = extractConditions(
    "I'd take 185 if you close before the 20th and cover the taxes.",
    { reference_iso: WROTE_AT }
  );
  assert.ok(conditions.some((c) => c.kind === CONDITION_KIND.BUYER_PAYS_TAXES));
});

test("a SELLER saying they will pay is never recorded as the buyer paying", () => {
  // The inverse error, and the worse one: it would invent an obligation on us
  // that the seller never asked for, and we would price against it.
  for (const text of [
    "I'll close quickly and cover the taxes myself.",
    "We can close whenever and pay the closing costs.",
    "I will handle repairs.",
  ]) {
    const conditions = extractConditions(text, { reference_iso: WROTE_AT });
    const inverted = conditions.filter((c) =>
      [
        CONDITION_KIND.BUYER_PAYS_TAXES,
        CONDITION_KIND.BUYER_PAYS_CLOSING_COSTS,
        CONDITION_KIND.BUYER_PAYS_REPAIRS,
      ].includes(c.kind)
    );
    assert.equal(inverted.length, 0, `${text} inverted who pays`);
  }
});

test("an explicit second-person subject still works on its own", () => {
  assert.ok(
    extractConditions("200 if you cover the taxes.").some((c) => c.kind === CONDITION_KIND.BUYER_PAYS_TAXES)
  );
  assert.ok(
    extractConditions("The buyer pays closing costs.").some(
      (c) => c.kind === CONDITION_KIND.BUYER_PAYS_CLOSING_COSTS
    )
  );
});

test("a capture stops at a conjunction rather than swallowing the next clause", () => {
  // Running greedily to the end of the clause captured "the 20th and cover the
  // taxes" as one date phrase, which resolved to nothing AND hid the taxes
  // condition entirely.
  const conditions = extractConditions(
    "close before the 20th and cover the taxes",
    { reference_iso: WROTE_AT }
  );
  const close = conditions.find((c) => c.kind === CONDITION_KIND.CLOSE_BEFORE);
  assert.equal(close.phrase, "the 20th");
  assert.equal(close.date, "2026-09-20");
});
