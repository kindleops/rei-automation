/**
 * seller-attributable-text.test.mjs
 *
 * The failure this file exists to prevent, stated once:
 *
 *   Seller: "That's too low. You wrote 'we can offer $170,000.'"
 *
 * must never become SELLER ASKING PRICE = 170000. The seller said the opposite,
 * and 170000 is our own number quoted back at us. Every test below is a
 * variation on not fabricating a fact out of somebody else's sentence.
 *
 * All content is invented. No real seller text appears here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAttributableText,
  isAttributable,
  appearsOnlyInExcluded,
  EXCLUSION_REASON,
} from "../../src/lib/domain/seller-intelligence/attributable-text.js";

// ── the headline case ──────────────────────────────────────────────────────

test("OUR quoted offer is not the seller's asking price", () => {
  const result = resolveAttributableText({
    newest_reply: `That's too low. You wrote "we can offer $170,000."`,
  });

  assert.equal(appearsOnlyInExcluded(result, "170,000"), true, "our own number stayed attributable");
  assert.equal(isAttributable(result, "170,000"), false);
  // The seller's own framing must SURVIVE -- "that's too low" is a rejection,
  // and losing it would turn a clear no into silence.
  assert.match(result.attributable, /too low/i);
});

test("every phrasing of attributing a number to us excludes it", () => {
  const variants = [
    `You said "we can offer 170,000" and that's too low.`,
    `Your email said "$170,000" — no thanks.`,
    `your offer said "170,000". Not enough.`,
    `You offered "170,000" which I can't accept.`,
    `"170,000" is what you said. Too low.`,
  ];
  for (const text of variants) {
    const result = resolveAttributableText({ newest_reply: text });
    assert.equal(isAttributable(result, "170,000"), false, text);
  }
});

test("the seller CHARACTERISING us is their own sentence and survives", () => {
  // "you said the price was too low" has no quoted span. It is the seller
  // talking, and removing it would lose their meaning entirely.
  const result = resolveAttributableText({
    newest_reply: "You said the price would be fair but 170000 is not fair. I need 200000.",
  });
  assert.match(result.attributable, /I need 200000/);
  assert.equal(isAttributable(result, "200000"), true);
});

test("a third party's quoted words are not the seller's", () => {
  const result = resolveAttributableText({
    newest_reply: `My sister said "we should hold out for 250" but I just want it gone.`,
  });
  assert.equal(isAttributable(result, "250"), false);
  assert.match(result.attributable, /I just want it gone/);
});

// ── quoted history that survived into the newest reply ────────────────────

test("lines marked with > are not the seller writing now", () => {
  const result = resolveAttributableText({
    newest_reply: "No thanks.\n> Would you consider 165000?",
  });
  assert.equal(isAttributable(result, "165000"), false);
  assert.equal(result.attributable.trim(), "No thanks.");
});

test("a quote header and the block under it are excluded", () => {
  const result = resolveAttributableText({
    newest_reply: [
      "Not interested right now.",
      "On Mon, 8 Sep 2026 at 18:04, Acquisitions wrote:",
      "From: Acquisitions",
      "Subject: Your property",
    ].join("\n"),
  });
  assert.match(result.attributable, /Not interested right now/);
  assert.equal(result.attributable.includes("Acquisitions"), false);
});

test("a forwarded banner is recognised", () => {
  const result = resolveAttributableText({
    newest_reply: "See below.\n---------- Forwarded message ----------\nFrom: someone else",
  });
  assert.match(result.attributable, /See below/);
  assert.ok(result.excluded.some((e) => e.reason === EXCLUSION_REASON.FORWARDED));
});

// ── signatures and disclaimers ────────────────────────────────────────────

test("everything after the RFC signature divider is a signature", () => {
  const result = resolveAttributableText({
    newest_reply: "Yes, 185 works.\n-- \nJ. Doe\nDoe Property LLC\nCell: 555-0100",
  });
  assert.match(result.attributable, /185 works/);
  assert.equal(result.attributable.includes("Doe Property LLC"), false);
});

test("a corporate disclaimer is not a seller statement", () => {
  const result = resolveAttributableText({
    newest_reply:
      "I'd take 190.\nThis message is confidential and intended solely for the addressee.",
  });
  assert.match(result.attributable, /190/);
  assert.ok(result.excluded.some((e) => e.reason === EXCLUSION_REASON.DISCLAIMER));
});

test("a mobile signature does not survive as seller prose", () => {
  const result = resolveAttributableText({ newest_reply: "Sounds good.\nSent from my iPhone" });
  assert.equal(result.attributable.includes("iPhone"), false);
});

// ── the conservative direction ────────────────────────────────────────────

test("ordinary seller prose is never removed", () => {
  // Removing too much shows up as a missed fact; removing too little shows up
  // as a fabricated one. Only positively identified text is excluded.
  const text = [
    "Yes I own it outright.",
    "The tenant moves out October 1st and I owe about 90k.",
    "I'd want at least 200 but I could be flexible on timing.",
  ].join("\n");
  const result = resolveAttributableText({ newest_reply: text });
  assert.equal(result.attributable.trim(), text);
  assert.equal(result.excluded.length, 0);
});

test("a quoted phrase with NO attribution stays the seller's", () => {
  // People use quotation marks for emphasis and scare quotes. Without an
  // attribution verb there is no evidence it is anybody else's.
  const result = resolveAttributableText({
    newest_reply: `The place is a "fixer upper" but I'd take 185.`,
  });
  assert.equal(isAttributable(result, "185"), true);
});

test("a number the seller states alongside one they attribute to us keeps only theirs", () => {
  const result = resolveAttributableText({
    newest_reply: `You said "170,000" but I need 195,000.`,
  });
  assert.equal(isAttributable(result, "170,000"), false);
  assert.equal(isAttributable(result, "195,000"), true);
});

// ── it builds on EMAIL-3 rather than redoing it ───────────────────────────

test("the EMAIL-3 newest_reply is preferred over the whole body", () => {
  const result = resolveAttributableText({
    newest_reply: "Yes, still interested.",
    normalized_text: "Yes, still interested.\n\nOn Mon someone wrote:\n> Would you take 165000?",
    raw_text: "everything",
  });
  assert.equal(result.source, "newest_reply");
  assert.equal(isAttributable(result, "165000"), false);
});

test("with no newest reply it falls back, and says which view it used", () => {
  const result = resolveAttributableText({ normalized_text: "I'd take 185." });
  assert.equal(result.source, "normalized_text");
  assert.equal(isAttributable(result, "185"), true);
});

// ── ambiguity is an answer ────────────────────────────────────────────────

test("a reply that is ONLY quoted material is ambiguous, not empty", () => {
  // "They said nothing" and "we could not tell what was theirs" are different
  // facts, and the caller needs to tell them apart.
  const result = resolveAttributableText({
    newest_reply: "> Would you consider selling?\n> Let us know.",
  });
  assert.equal(result.attributable, "");
  assert.equal(result.ambiguous, true);
});

test("a genuinely empty reply is empty, not ambiguous", () => {
  const result = resolveAttributableText({ newest_reply: "   \n\n  " });
  assert.equal(result.ambiguous, false);
});

// ── hostile input ─────────────────────────────────────────────────────────

test("resolution never throws and never hangs", () => {
  const nasty = [
    null, undefined, "", 0, [], { newest_reply: {} },
    '"'.repeat(20_000),
    "> ".repeat(20_000),
    `You said "${"x".repeat(50_000)}"`,
    "a".repeat(200_000),
  ];
  for (const value of nasty) {
    const started = Date.now();
    let result;
    assert.doesNotThrow(() => { result = resolveAttributableText(value); }, String(value).slice(0, 30));
    assert.equal(result.ok, true);
    assert.ok(Date.now() - started < 5_000, "took too long");
  }
});

test("the attribution helpers never throw on hostile input", () => {
  for (const value of [null, undefined, "", 0, [], { excluded: "nope" }]) {
    assert.doesNotThrow(() => isAttributable(value, "x"));
    assert.doesNotThrow(() => appearsOnlyInExcluded(value, "x"));
  }
});

test("an empty needle is never attributable", () => {
  const result = resolveAttributableText({ newest_reply: "I'd take 185." });
  assert.equal(isAttributable(result, ""), false);
  assert.equal(appearsOnlyInExcluded(result, ""), false);
});
