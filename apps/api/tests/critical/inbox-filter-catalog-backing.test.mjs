/**
 * INBOX-COMPOSER-LOCK-1 — an exposed filter must actually filter.
 *
 * The Advanced Filters sheet is generated from INBOX_FILTER_FIELDS. Three
 * separate things have to line up for a field in that list to do anything:
 *
 *   1. the options RPC must be allowed to read its column
 *      (inbox_filter_allowed_column, in SQL)
 *   2. buildInboxFilterConditions must emit a condition for its key
 *   3. inbox_filter_apply_conditions must understand the op that produces
 *
 * Each was maintained by hand and they had drifted apart. Measured on
 * production 2026-09-14, before the fix:
 *
 *   16 of 115 filters were broken in one of three ways
 *   - 14 selects opened EMPTY          (allowlist missing the column)
 *   - deliveryStatus                    (no column on the filter source at all)
 *   - phoneCarrier                      (15.7s -> statement timeout -> the whole
 *                                        Inbox came back degraded/threads:[])
 *   and 8 more applied nothing at all:
 *     {"pool":"No"}        -> 8,887 of 8,887
 *     {"storiesMin":3}     -> 8,887 of 8,887
 *
 * A filter that silently matches everything is worse than a missing one: it
 * answers a question the operator did not ask. These tests pin (2) and (3),
 * which live in JS; (1) lives in SQL and is asserted by shape here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { INBOX_FILTER_FIELDS } from "../../src/lib/domain/inbox/inbox-filter-catalog.js";
import { buildInboxFilterConditions } from "../../src/lib/domain/inbox/inbox-filter-conditions.js";

/** A value that is plausible for the field's type, so `isActive` accepts it. */
function sampleValue(field) {
  switch (field.type) {
    case "select": return "__sample__";
    case "multiselect": return ["__sample__"];
    case "tri": return true;
    case "text": return "__sample__";
    case "numberRange":
    case "dateRange": return /Max$|To$/.test(field.key) ? 999999 : 1;
    case "flags": return { mode: "any", values: ["__sample__"] };
    default: return "__sample__";
  }
}

const OPS_THE_APPLIER_UNDERSTANDS = new Set([
  // inbox_filter_apply_conditions. An op outside this set is skipped by its
  // loop, which means it constrains nothing -- the silent-everything shape.
  "eq", "in", "gte", "lte", "gt", "ilike", "is", "not_is", "not_ilike",
  "or_ilike", "flag_any", "flag_all", "flag_exclude", "inbox_category_eq",
]);

test("every exposed filter emits at least one condition", () => {
  const dead = [];
  for (const field of INBOX_FILTER_FIELDS) {
    const conditions = buildInboxFilterConditions({ [field.key]: sampleValue(field) });
    // inbox_category_eq is pushed for bucket scoping, not by the field itself.
    const own = conditions.filter((c) => c.op !== "inbox_category_eq");
    if (own.length === 0) dead.push(`${field.group}/${field.key} (${field.type})`);
  }
  assert.deepEqual(
    dead, [],
    `these filters are exposed but constrain nothing:\n  ${dead.join("\n  ")}`,
  );
});

test("every emitted condition uses an op the applier understands", () => {
  const unknown = new Set();
  for (const field of INBOX_FILTER_FIELDS) {
    for (const condition of buildInboxFilterConditions({ [field.key]: sampleValue(field) })) {
      if (!OPS_THE_APPLIER_UNDERSTANDS.has(condition.op)) {
        unknown.add(`${field.key} -> ${condition.op}`);
      }
    }
  }
  assert.deepEqual(
    [...unknown], [],
    "an op the applier does not know is skipped, which matches everything",
  );
});

test("every emitted condition names a column", () => {
  const columnless = [];
  for (const field of INBOX_FILTER_FIELDS) {
    for (const condition of buildInboxFilterConditions({ [field.key]: sampleValue(field) })) {
      if (condition.op === "inbox_category_eq") continue;
      const named = condition.column || (Array.isArray(condition.columns) && condition.columns.length > 0);
      if (!named) columnless.push(`${field.key} -> ${condition.op}`);
    }
  }
  assert.deepEqual(columnless, [], "a condition with no column cannot be applied");
});

test("a hand-written rule still wins over the generic pass", () => {
  // ownerName maps to owner_display_name via pushIlike, NOT via the catalog's
  // own column. The generic pass runs last and must not double-constrain or
  // override it.
  const conditions = buildInboxFilterConditions({ ownerName: "Bertha" });
  const onOwner = conditions.filter((c) => c.column === "owner_display_name");
  assert.equal(onOwner.length, 1, "exactly one condition per column");
  assert.equal(onOwner[0].op, "ilike", "the hand-written ilike wins over a generic eq");
});

test("a multi-select emits `in`, not a silent single value", () => {
  const conditions = buildInboxFilterConditions({ pool: ["No", "In-Ground Pool"] });
  const onPool = conditions.find((c) => c.column === "pool");
  assert.ok(onPool, "pool must constrain something");
  assert.equal(onPool.op, "in");
  assert.deepEqual(onPool.value, ["No", "In-Ground Pool"]);
});

test("a numeric range knows which end it is", () => {
  const min = buildInboxFilterConditions({ storiesMin: 3 }).find((c) => c.column === "stories");
  assert.equal(min.op, "gte");
  assert.equal(min.value, 3);
});

test("a tri over a value column asserts only the positive case", () => {
  // The condition vocabulary has no `neq`; emitting one would be skipped by the
  // applier and match everything. `false` therefore constrains nothing rather
  // than lying, and Detected Intent covers the inverse.
  const yes = buildInboxFilterConditions({ wrongNumber: true }).filter((c) => c.column === "ui_intent");
  const no = buildInboxFilterConditions({ wrongNumber: false }).filter((c) => c.column === "ui_intent");
  if (yes.length) {
    assert.equal(yes[0].op, "eq");
    assert.equal(yes[0].value, "wrong_number");
  }
  assert.equal(no.length, 0);
});

test("no filter is exposed without a column or a bespoke rule", () => {
  // A catalog entry with neither is a control that cannot be wired at all.
  const HANDLED_WITHOUT_COLUMN = new Set(["propertyFlags", "personFlags", "addressSearch", "phoneNumber"]);
  const orphans = INBOX_FILTER_FIELDS
    .filter((f) => !f.column && !HANDLED_WITHOUT_COLUMN.has(f.key))
    .map((f) => `${f.group}/${f.key}`);
  assert.deepEqual(orphans, [], `catalog entries with no column and no bespoke rule:\n  ${orphans.join("\n  ")}`);
});
