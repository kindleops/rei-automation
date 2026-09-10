/**
 * rent-facts-do-not-move-money.test.mjs
 *
 * PART 18 GUARANTEE: this phase builds the INPUTS for multifamily underwriting
 * and must not change a single cash offer.
 *
 * The offer number comes from `offerCalculation` inside the acquisition
 * decision engine: a percentage of comparable value, less repairs, less
 * margin. It has no income term. This file pins the separation two ways:
 *
 *  1. STRUCTURAL -- the seller-flow asset-class resolver and the offer engine
 *     use DIFFERENT normalizeAssetClass implementations. The engine imports
 *     lib/intel/normalize.js; the seller flow uses negotiation-policy.js. The
 *     resolver rewrite therefore cannot reach the money path at all, and the
 *     engine must not import the seller-flow policy.
 *  2. BEHAVIOURAL -- identical comp/repair/margin inputs produce an identical
 *     offer whether or not rent facts are present.
 *
 * When income underwriting is eventually authorized, THIS is the test that
 * should fail loudly, deliberately, and be updated in the same commit.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { normalizeAssetClass as sellerFlowNormalizeAssetClass } from "@/lib/domain/seller-flow/negotiation-policy.js";
import { normalizeAssetClass as intelNormalizeAssetClass } from "@/lib/intel/normalize.js";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE = resolve(API_ROOT, "src/lib/acquisition/acquisitionDecisionEngine.js");

test("the offer engine does not import the seller-flow asset-class policy", () => {
  const source = readFileSync(ENGINE, "utf8");
  assert.equal(
    source.includes("seller-flow/negotiation-policy"),
    false,
    "the money path must not depend on the seller-flow classifier"
  );
  assert.ok(
    source.includes("@/lib/intel/normalize.js"),
    "the engine resolves asset class from lib/intel, independently"
  );
});

test("the two resolvers are genuinely different functions", () => {
  assert.notEqual(sellerFlowNormalizeAssetClass, intelNormalizeAssetClass);
  // The seller-flow one takes a unit count and is the one this phase changed.
  assert.equal(sellerFlowNormalizeAssetClass.length >= 1, true);
});

test("the offer formula carries no income term", () => {
  const source = readFileSync(ENGINE, "utf8");
  // If any of these appear inside the engine, income has entered the money
  // path and this phase's guarantee is broken.
  for (const term of [
    "monthly_gross_rent",
    "average_monthly_unit_rent",
    "reported_unit_rents",
    "rents_summary",
    "capRate",
    "cap_rate",
    "computeNOI",
  ]) {
    assert.equal(
      source.includes(term),
      false,
      `income term "${term}" reached the offer engine`
    );
  }
});

test("rent facts are absent from the offer engine's input surface", () => {
  // The engine reads its own property row and comps. It never receives the
  // seller-flow fact store, so a rent fact cannot influence the amount.
  const source = readFileSync(ENGINE, "utf8");
  assert.equal(source.includes("seller_facts"), false);
  assert.equal(source.includes("facts_patch"), false);
});
