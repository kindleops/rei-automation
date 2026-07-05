import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFilterTokenDigest,
  exposeFilterTokenDigest,
  stableStringify,
  verifyFilterTokenScope,
} from "../../src/lib/domain/map-filters/filter-scope.js";
import { MAP_FILTER_LIMITS, assertExpressionWithinLimits } from "../../src/lib/domain/map-filters/map-filter-limits.js";

const EMPTY_EXPRESSION = {
  id: "root",
  type: "group",
  combinator: "AND",
  negated: false,
  enabled: true,
  children: [],
};

test("stableStringify sorts object keys deterministically", () => {
  const a = stableStringify({ b: 1, a: 2 });
  const b = stableStringify({ a: 2, b: 1 });
  assert.equal(a, b);
});

test("token digest changes with organization scope", () => {
  const base = {
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: 1,
    registryVersion: "2026-07-05.1",
    normalizedExpression: EMPTY_EXPRESSION,
  };
  const orgA = buildFilterTokenDigest({ ...base, organizationId: "org-a" });
  const orgB = buildFilterTokenDigest({ ...base, organizationId: "org-b" });
  assert.notEqual(orgA, orgB);
});

test("token digest changes with permission scope", () => {
  const base = {
    organizationId: "org-1",
    filterSchemaVersion: 1,
    registryVersion: "2026-07-05.1",
    normalizedExpression: EMPTY_EXPRESSION,
  };
  const authed = buildFilterTokenDigest({ ...base, permissionScope: "ops_dashboard_authenticated" });
  const guest = buildFilterTokenDigest({ ...base, permissionScope: "ops_dashboard_unauthenticated" });
  assert.notEqual(authed, guest);
});

test("exposed token exposes at least 128 bits", () => {
  const digest = buildFilterTokenDigest({
    organizationId: "org-1",
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: 1,
    registryVersion: "2026-07-05.1",
    normalizedExpression: EMPTY_EXPRESSION,
  });
  assert.equal(digest.length, 64);
  assert.equal(exposeFilterTokenDigest(digest).length, 32);
});

test("verifyFilterTokenScope rejects cross-tenant token records", () => {
  const authScope = {
    organizationId: "org-1",
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: 1,
    registryVersion: "2026-07-05.1",
  };
  const foreign = {
    organizationId: "org-2",
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: 1,
    registryVersion: "2026-07-05.1",
  };
  assert.equal(verifyFilterTokenScope(foreign, authScope), false);
  assert.equal(verifyFilterTokenScope(authScope, authScope), true);
});

test("expression limits reject oversized trees", () => {
  const errors = assertExpressionWithinLimits({
    ruleCount: MAP_FILTER_LIMITS.maxRules + 1,
    groupCount: 1,
    maxDepth: 1,
    paramCount: 1,
  });
  assert.ok(errors.includes(`rule_limit_exceeded:${MAP_FILTER_LIMITS.maxRules + 1}`));
});