import test from "node:test";
import assert from "node:assert/strict";
import { buildInboxFilterConditions, resolveInboxCategoryList } from "../../src/lib/domain/inbox/inbox-filter-conditions.js";
import { applyHydratedInboxFilters } from "../../src/lib/domain/inbox/inbox-hydrated-filter-service.js";

// The Advanced Filters "Inbox categories" multi-select never reached the server,
// and multi-value selects were counted on their first value only.

const fakeQuery = () => {
  const calls = [];
  const q = new Proxy({}, { get: (_, k) => (k === "calls" ? calls : (...a) => { calls.push([k, ...a]); return q; }) });
  return q;
};

test("categories map to canonical inbox_category values (OR)", () => {
  assert.deepEqual(resolveInboxCategoryList(["new_replies", "priority"]), ["new_inbound", "hot_leads"]);
  assert.deepEqual(resolveInboxCategoryList(["dead", "cold_no_response"]), ["cold_no_response"]);
  assert.equal(resolveInboxCategoryList(["new_replies", "spanish_language"]), null);
  assert.equal(resolveInboxCategoryList([]), null);
});

test("counts and options get an IN condition for categories", () => {
  const c = buildInboxFilterConditions({ categories: ["new_replies", "needs_review"] });
  assert.deepEqual(c.find((x) => x.op === "in" && x.column === "inbox_category"), { op: "in", column: "inbox_category", value: ["new_inbound", "needs_review"] });
});

test("the list applies the same categories", () => {
  const q = applyHydratedInboxFilters(fakeQuery(), { categories: ["new_replies", "priority"] });
  assert.ok(q.calls.some(([m, col, v]) => m === "in" && col === "inbox_category" && JSON.stringify(v) === '["new_inbound","hot_leads"]'));
});

test("a multi-value select counts every value, as the list does", () => {
  const c = buildInboxFilterConditions({ status: ["active", "read"] });
  assert.deepEqual(c.find((x) => x.column === "status"), { op: "in", column: "status", value: ["active", "read"] });
  const single = buildInboxFilterConditions({ status: ["active"] });
  assert.deepEqual(single.find((x) => x.column === "status"), { op: "eq", column: "status", value: "active" });
});
