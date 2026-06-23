/**
 * Canonical inbound classification truth table.
 * Locks behavioral distinctions required for suppression and routing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "@/lib/domain/classification/classify.js";

const TRUTH_TABLE = [
  // wrong_number — disconnected contact / sold / not owner at this number
  { label: "wrong_number", text: "Wrong number", lang: "English" },
  { label: "wrong_number", text: "You have the wrong person", lang: "English" },
  { label: "wrong_number", text: "I don't own that house", lang: "English" },
  { label: "wrong_number", text: "Sold it 10 yrs ago", lang: "English" },
  { label: "wrong_number", text: "No It sold", lang: "English" },
  { label: "wrong_number", text: "No la Mia es 2711 Degen Dr. Bonita CA 91902", lang: "Spanish" },

  // wrong_person / identity mismatch (mapped to wrong_number in routing)
  { label: "wrong_number", text: "This is not Shirley...", lang: "English" },

  // who_is_this — identity clarification
  { label: "who_is_this", text: "Who is this?", lang: "English" },
  { label: "who_is_this", text: "How did you get my number?", lang: "English" },

  // opt_out — explicit stop
  { label: "opt_out", text: "Stop", lang: "English" },
  { label: "opt_out", text: "Remove me from your list", lang: "English" },
  { label: "opt_out", text: "No elimíname de tu lista", lang: "Spanish" },

  // not_interested — declines sale without disconnecting contact
  { label: "not_interested", text: "Not for sale", lang: "English" },
  { label: "not_interested", text: "Si pero No está en venta", lang: "Spanish" },

  // ambiguous — insufficient evidence
  { label: "unclear", text: "Maybe", lang: "English" },
  { label: "unclear", text: "Huh?", lang: "English" },

  // property_correction — type/address correction only
  { label: "property_correction", text: "This is not a duplex, it is a house", lang: "English" },
  { label: "property_correction", text: "Wrong address — it is 123 Oak not 456 Elm", lang: "English" },
];

test("canonical classification truth table", async (t) => {
  for (const row of TRUTH_TABLE) {
    await t.test(`${row.lang}: "${row.text}" → ${row.label}`, async () => {
      const result = await classify(row.text, null, { heuristicOnly: true });
      assert.strictEqual(
        result.primary_intent,
        row.label,
        `Expected ${row.label} for: "${row.text}" (got objection=${result.objection ?? "null"})`
      );
    });
  }
});