import test from "node:test";
import assert from "node:assert/strict";

import { canonicalFlag, canonicalPropertyIds } from "../../src/lib/domain/comp-intelligence/canonical-property-ids.js";
import { canonicalPropertyIds as reExported } from "../../src/lib/domain/comp-intelligence/comps-workspace-service.js";
import { markCanonicalComps } from "../../src/lib/domain/deal-intelligence/deal-decision-service.js";

function propertiesClient(existing, reads = []) {
  return {
    from(table) {
      assert.equal(table, "properties");
      return { select: () => ({ in: (_k, ids) => { reads.push(ids); return Promise.resolve({ data: ids.filter((id) => existing.includes(id)).map((property_id) => ({ property_id })), error: null }); } }) };
    },
  };
}

test("Comps and Deal Intelligence share ONE helper", () => {
  assert.equal(reExported, canonicalPropertyIds);
});

test("DI decision: one batched read marks comp-only parcels false and tracked ones true", async () => {
  const reads = [];
  // 273330226 = 3722 Fremont Ave N: a recorded sale with no properties row
  const comps = [{ propertyId: "273312064" }, { propertyId: "273330226" }, { propertyId: "273312064" }, { propertyId: null }];
  await markCanonicalComps(propertiesClient(["273312064"], reads), comps);
  assert.deepEqual(comps.map((c) => c.canonicalProperty), [true, false, true, false]);
  assert.equal(reads.length, 1);
  assert.deepEqual([...reads[0]].sort(), ["273312064", "273330226"]);
});

test("DI decision: a failed existence read leaves every comp unknown (null), never 'not tracked'", async () => {
  const failing = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) };
  const comps = [{ propertyId: "1" }, { propertyId: "2" }];
  await markCanonicalComps(failing, comps);
  assert.deepEqual(comps.map((c) => c.canonicalProperty), [null, null]);
  const throwing = { from: () => { throw new Error("offline"); } };
  await markCanonicalComps(throwing, comps);
  assert.deepEqual(comps.map((c) => c.canonicalProperty), [null, null]);
});

test("DI decision: no comps, no read", async () => {
  const reads = [];
  assert.deepEqual(await markCanonicalComps(propertiesClient([], reads), []), []);
  assert.equal(reads.length, 0);
});

test("canonicalFlag: absent id is false; failed check is null", () => {
  assert.equal(canonicalFlag(new Set(["a"]), "a"), true);
  assert.equal(canonicalFlag(new Set(["a"]), "b"), false);
  assert.equal(canonicalFlag(null, "b"), null);
  assert.equal(canonicalFlag(null, ""), false);
});
