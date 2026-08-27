import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeSmsTextValue,
  prepareRenderedSmsForQueue,
} from "@/lib/sms/sanitize.js";
import {
  buildSafeFallback,
  UNCERTAINTY_TYPES,
} from "@/lib/domain/seller-flow/coverage-net/safe-fallback.js";

// Permanent guard (operator directive): no em dash (U+2014) or en dash (U+2013)
// may ever reach a seller, in a template body or a generated SMS. Two layers are
// asserted here:
//   1. the send-path sanitizer strips them from ANY generated SMS, so even a
//      catalog template that slipped one in produces a clean message, and
//   2. every code-authored SMS body (the coverage-net safe-fallback clarifiers)
//      is dash-free at the source.
const LONG_DASH = /[—–]/; // em dash or en dash

test("sanitizeSmsTextValue strips em/en dashes from any generated SMS", () => {
  assert.doesNotMatch(
    sanitizeSmsTextValue("Thanks — just checking on the property."),
    LONG_DASH
  );
  // Reads as a natural comma pause.
  assert.equal(
    sanitizeSmsTextValue("Thanks — just checking."),
    "Thanks, just checking."
  );
  // Adjacent / multiple / en-dash forms all cleared.
  assert.doesNotMatch(
    sanitizeSmsTextValue("We could do it—as-is—for you, 9–5 today."),
    LONG_DASH
  );
});

test("prepareRenderedSmsForQueue (final body prep) never emits a long dash", () => {
  const out = prepareRenderedSmsForQueue({
    rendered_message_text: "We could do it — as-is — for you.",
    template_id: "test",
  });
  assert.equal(out.ok, true);
  assert.doesNotMatch(out.text, LONG_DASH);
});

test("every stage x uncertainty safe-fallback clarifier is dash-free", () => {
  const stages = [
    null,
    "ownership_confirmation",
    "offer_interest",
    "asking_price",
    "property_condition",
    "offer",
    "formal_contract",
    "S1",
    "S5",
    "negotiation close",
  ];
  for (const uncertainty_type of UNCERTAINTY_TYPES) {
    for (const stage of stages) {
      const fb = buildSafeFallback({ stage, uncertainty_type });
      assert.ok(fb?.suggested_text, `no clarifier for ${uncertainty_type}/${stage}`);
      assert.doesNotMatch(
        fb.suggested_text,
        LONG_DASH,
        `clarifier ${uncertainty_type}/${stage} contains a long dash: ${fb.suggested_text}`
      );
    }
  }
});
