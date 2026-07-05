import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMapFilterCacheKey,
  buildAuthorizedMapPropertyPredicate,
} from "../../src/lib/domain/map-filters/map-filter-property-predicate.js";
import { buildFilterResponseMeta } from "../../src/lib/domain/map-filters/map-filter-runtime.js";

const EMPTY_EXPRESSION = {
  id: "root",
  type: "group",
  combinator: "AND",
  negated: false,
  enabled: true,
  children: [],
};

test("buildAuthorizedMapPropertyPredicate accepts camelCase token records", () => {
  const result = buildAuthorizedMapPropertyPredicate({
    compiledPredicateAst: EMPTY_EXPRESSION,
    params: [],
    summary: "Empty",
    activeRuleCount: 0,
    registryVersion: "2026-07-06.1",
    filterSchemaVersion: 1,
  });
  assert.equal(result.sqlFragment, "TRUE");
  assert.deepEqual(result.params, []);
  assert.equal(result.meta.summary, "Empty");
});

test("buildMapFilterCacheKey isolates token and tile scope", () => {
  const base = {
    publicToken: "abc123",
    organizationId: "org-1",
    permissionScope: "ops_dashboard_authenticated",
    schemaVersion: 1,
    registryVersion: "2026-07-06.1",
  };
  const tileA = buildMapFilterCacheKey({ ...base, scope: { zoom: 12, x: 1, y: 2 } });
  const tileB = buildMapFilterCacheKey({ ...base, scope: { zoom: 12, x: 1, y: 3 } });
  assert.notEqual(tileA, tileB);
});

test("buildFilterResponseMeta returns null without an active filter", () => {
  assert.equal(buildFilterResponseMeta({ active: false, filter: null }), null);
});