/**
 * fus2-street-address-copy.test.mjs
 *
 * Seller-facing copy names the STREET, not the postal address.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { streetAddressOnly } from "../../src/lib/domain/inbox/fus2-follow-up-service.js";

test("the city, state and ZIP are dropped from seller-facing copy", () => {
  const cases = [
    ["8111 N El Dorado St, Stockton, Ca 95210", "8111 N El Dorado St"],
    ["410 Roxbury Dr, Riverdale, Ga 30274", "410 Roxbury Dr"],
    ["3207 The Alameda, Baltimore, Md 21218", "3207 The Alameda"],
    ["8041 Filltop St, Houston, Tx 77028", "8041 Filltop St"],
  ];
  for (const [full, expected] of cases) {
    assert.equal(streetAddressOnly(full), expected);
  }
});

test("a unit or apartment stays -- it is part of the street line", () => {
  assert.equal(
    streetAddressOnly("4157 Pillsbury Ave S Unit B, Minneapolis, MN 55409"),
    "4157 Pillsbury Ave S Unit B",
  );
  assert.equal(streetAddressOnly("221B Baker St Apt 2, London, KY 40741"), "221B Baker St Apt 2");
});

test("an address with no comma is left alone", () => {
  assert.equal(streetAddressOnly("123 Main St"), "123 Main St");
});

test("it never collapses to an empty address", () => {
  // An empty value here would either trip the renderer's missing-variable gate
  // or produce "...talking numbers on ." Falling back to the full value is the
  // safe direction.
  assert.equal(streetAddressOnly(", Stockton, Ca 95210"), ", Stockton, Ca 95210");
  assert.equal(streetAddressOnly("  , Houston, Tx"), ", Houston, Tx");
});

test("empty and nullish inputs stay empty, so eligibility still decides", () => {
  for (const value of ["", "   ", null, undefined]) {
    assert.equal(streetAddressOnly(value), "");
  }
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(streetAddressOnly("  8111 N El Dorado St , Stockton, Ca  "), "8111 N El Dorado St");
});
