// ─── classifier-negation-ownership.test.mjs ──────────────────────────────────
// Negation & contrast suite for the negation-blind ownership defect:
// messages that DENY ownership ("That's not my house", "I do not own that
// house", "esa no es mi casa", "My mother owns it, not me") must NEVER
// resolve to ownership_confirmed, and must land on the correct distinct
// production label instead:
//   * not owner / never owned → property_specific_non_owner (round 10, owner
//     2026-10-08: an ownership DENIAL closes the person x property and leaves
//     the phone usable); a person / phone mismatch stays wrong_number;
//   * sold / transferred → sold_property (PROPERTY-scoped disposition — the
//     contact stays reachable; see matchesSoldTransfer). Routing sold into
//     wrong_number's contact-scope suppression was a certified P0 defect;
//   * property mismatch ("Wrong house.") → property_correction;
//   * family decision-maker without an explicit not-me denial → unclear
//     (classify.js deliberately keeps family-only language out of both
//     false-ownership and forced-decline lanes);
//   * genuinely ambiguous → unclear.
// Negation scope is evaluated BEFORE positive ownership phrase matching
// (matchesNegatedOwnership feeds both resolveIntents §2 and the §11
// ownership_negated gate), which this suite pins with contractions,
// punctuation, typos, slang, Spanish, and compound statements.
// Everything runs heuristicOnly — deterministic, zero AI.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";

// Round 10: a denial lands property-scoped; an explicit person/phone mismatch
// in the same words ("not me, wrong number") keeps wrong_number.
const DENIAL = ["property_specific_non_owner", "wrong_number"];

/** Each case: text + acceptable distinct intents. ownership_confirmed is
 *  categorically forbidden for every case in NEGATION_CASES. */
const NEGATION_CASES = [
  // ── Plain not-owner denials ────────────────────────────────────────────────
  { text: "That's not my house.", any_of: DENIAL },
  { text: "That is not my house!", any_of: DENIAL },
  { text: "This isn't my property.", any_of: DENIAL },
  { text: "It's not my house.", any_of: DENIAL },
  { text: "Not my house.", any_of: DENIAL },
  { text: "not my property, sorry", any_of: DENIAL },
  { text: "not mine", any_of: DENIAL },
  { text: "That's not mine.", any_of: DENIAL },
  { text: "I do not own that house.", any_of: DENIAL },
  { text: "I don't own it.", any_of: DENIAL },
  { text: "we do not own that property", any_of: DENIAL },
  { text: "I'm not the owner.", any_of: DENIAL },
  { text: "Not the owner.", any_of: DENIAL },
  { text: "im not the owner of that house", any_of: DENIAL },
  { text: "It doesn't belong to me.", any_of: DENIAL },
  { text: "does not belong to me", any_of: DENIAL },

  // ── Contractions ───────────────────────────────────────────────────────────
  { text: "thats not my house", any_of: DENIAL },
  { text: "this isnt my property", any_of: DENIAL },
  { text: "It isn't my house", any_of: DENIAL },
  { text: "That isn't our property", any_of: DENIAL },
  { text: "its not our property", any_of: DENIAL },
  { text: "That ain't my house", any_of: DENIAL },
  { text: "aint my property", any_of: DENIAL },
  { text: "i dont own that house", any_of: DENIAL },
  { text: "Dont own it", any_of: DENIAL },

  // ── Punctuation / casing variants ──────────────────────────────────────────
  { text: "That's not my house!!!", any_of: DENIAL },
  { text: "NOT MY HOUSE", any_of: DENIAL },
  { text: "that's NOT my property...", any_of: DENIAL },
  { text: "no... that's not my house?", any_of: DENIAL },

  // ── Typos ──────────────────────────────────────────────────────────────────
  { text: "thats not my hosue", any_of: DENIAL },
  { text: "this isnt my propery", any_of: DENIAL },
  { text: "not my huose", any_of: DENIAL },

  // ── Slang ──────────────────────────────────────────────────────────────────
  { text: "nah not my crib", any_of: [...DENIAL, "not_interested"] },
  { text: "bro that aint my crib", any_of: DENIAL },
  { text: "that aint mine", any_of: DENIAL },

  // ── Never owned ────────────────────────────────────────────────────────────
  { text: "I never owned it.", any_of: DENIAL },
  { text: "never owned that property", any_of: DENIAL },
  { text: "I have never owned that house", any_of: DENIAL },
  { text: "Nope. Never owned it. Stop guessing.", any_of: DENIAL },
  { text: "i never owned anything there", any_of: DENIAL },

  // ── Former owner / sold ────────────────────────────────────────────────────
  { text: "I sold that property.", any_of: ["sold_property"] },
  { text: "I sold that house last year", any_of: ["sold_property"] },
  { text: "sold it years ago", any_of: ["sold_property"] },
  { text: "We sold the house.", any_of: ["sold_property"] },
  { text: "already sold it", any_of: ["sold_property"] },
  { text: "That was sold in 2022", any_of: ["sold_property"] },
  { text: "sold my house in March", any_of: ["sold_property"] },
  { text: "It sold last month", any_of: ["sold_property"] },
  { text: "no longer own that place", any_of: DENIAL },
  { text: "I used to own it but not anymore", any_of: DENIAL },
  { text: "was mine years ago", any_of: DENIAL },

  // ── Spanish ────────────────────────────────────────────────────────────────
  { text: "esa no es mi casa", any_of: DENIAL },
  { text: "Esa no es mi casa.", any_of: DENIAL },
  { text: "no es mi casa", any_of: DENIAL },
  { text: "Esa casa no es mía", any_of: DENIAL },
  { text: "no es mía", any_of: DENIAL },
  { text: "No soy el dueño", any_of: DENIAL },
  { text: "no soy el dueno", any_of: DENIAL },
  { text: "no soy dueña", any_of: DENIAL },
  { text: "No soy la propietaria", any_of: DENIAL },
  { text: "no soy propietario", any_of: DENIAL },
  { text: "La vendí", any_of: ["sold_property"] },
  { text: "la vendi", any_of: ["sold_property"] },
  { text: "Ya la vendí", any_of: ["sold_property"] },
  { text: "ya lo vendi", any_of: ["sold_property"] },
  { text: "La vendimos el año pasado", any_of: ["sold_property"] },
  { text: "vendí esa casa", any_of: ["sold_property"] },
  { text: "número equivocado", any_of: DENIAL },

  // ── Property mismatch (wrong property, not wrong person) ───────────────────
  { text: "Wrong house.", any_of: ["property_correction"] },
  { text: "wrong house", any_of: ["property_correction"] },
  { text: "You have the wrong property.", any_of: ["property_correction"] },
  { text: "wrong property buddy", any_of: ["property_correction"] },
  { text: "You've got the wrong home", any_of: ["property_correction"] },
  { text: "wrong address", any_of: ["property_correction"] },
  { text: "Sorry, you have the wrong house. Good luck!", any_of: ["property_correction"] },

  // ── Family decision-maker / referral ───────────────────────────────────────
  // Explicit "not me" is a personal ownership denial → wrong_number routing.
  { text: "My mother owns it, not me.", any_of: DENIAL },
  { text: "my brother owns it not me", any_of: DENIAL },
  // Family-only language without a personal denial stays deliberately unclear
  // (human lane) — never false ownership, never a forced decline.
  { text: "My mother owns it.", any_of: ["unclear"] },
  { text: "My wife owns the property, talk to her", any_of: ["unclear", "callback_requested"] },

  // ── Compound / contrast statements ─────────────────────────────────────────
  { text: "Yes I got your text but that's not my house", any_of: DENIAL },
  { text: "Yes, I know the house, but I do not own it", any_of: DENIAL },
  { text: "I own the one next door, but that's not my property", any_of: DENIAL },
  { text: "no, sold that property already", any_of: ["sold_property"] },

  // ── Genuinely ambiguous — unclear, never a guessed ownership ───────────────
  { text: "It's complicated right now", any_of: ["unclear"] },
  { text: "The ownership situation is complicated", any_of: ["unclear"] },
];

// Positive controls: real affirmations must STILL confirm ownership, proving
// the negation scope does not overfire.
const POSITIVE_CONTROLS = [
  "Yes I own it",
  "That's my house",
  "yes still own it",
  "Still my house",
  "I am the owner",
  "we own it",
  "yea thats mine",
  "sí, soy el dueño",
  "es mi casa",
];

test(`negation suite: ${NEGATION_CASES.length} negated/contrast ownership cases never resolve to ownership_confirmed`, async () => {
  assert.ok(NEGATION_CASES.length >= 60, "suite must stay >= 60 negation cases");
  const failures = [];
  for (const { text, any_of } of NEGATION_CASES) {
    const result = await classify(text, null, { heuristicOnly: true });
    if (result.primary_intent === "ownership_confirmed") {
      failures.push(`"${text}" resolved to ownership_confirmed`);
      continue;
    }
    if (!any_of.includes(result.primary_intent)) {
      failures.push(
        `"${text}" resolved to ${result.primary_intent}, expected one of [${any_of.join(", ")}]`
      );
    }
    // A negated-ownership reply is never an auto-reply lane.
    if (result.automation_decision?.auto_reply_allowed === true) {
      failures.push(`"${text}" allowed an auto-reply`);
    }
  }
  assert.deepEqual(failures, [], `negation violations:\n${failures.join("\n")}`);
});

test("negation suite: seller_state never reports ownership_confirmed for negated cases", async () => {
  for (const { text } of NEGATION_CASES) {
    const result = await classify(text, null, { heuristicOnly: true });
    assert.notEqual(
      result.seller_state?.ownership_confirmed,
      true,
      `"${text}" produced seller_state.ownership_confirmed=true`
    );
  }
});

test("positive controls: genuine affirmations still confirm ownership (negation scope does not overfire)", async () => {
  for (const text of POSITIVE_CONTROLS) {
    const result = await classify(text, null, { heuristicOnly: true });
    assert.equal(
      result.primary_intent,
      "ownership_confirmed",
      `"${text}" must remain ownership_confirmed, got ${result.primary_intent}`
    );
  }
});
