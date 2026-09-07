/**
 * fus2-batch-template-rotation.test.mjs
 *
 * A batch must not queue the same sentence to every seller.
 *
 * Anti-repeat used to be per-thread only. That stopped ONE seller seeing the
 * same words twice, but every recipient in a batch ranks identically, so a
 * fresh thread always resolved to ranked[0] -- thirteen sellers, one sentence,
 * same day. Reported from the Conversation Restart sheet, where two English
 * recipients showed byte-identical copy.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { selectFus2Template } from "../../src/lib/domain/inbox/fus2-follow-up-service.js";

const templates = Array.from({ length: 6 }, (_, i) => ({
  template_id: `fus2-en-${i + 1}`,
  language: "English",
  stage_code: "FUS2",
  template_body: `variant ${i + 1} {{seller_first_name}} {{property_address}}`,
  approved: true,
}));

function runBatch(size, { history = () => [], useBatchUsage = true } = {}) {
  const batchUsage = useBatchUsage ? new Map() : null;
  const picked = [];
  for (let i = 0; i < size; i += 1) {
    const selection = selectFus2Template({
      templates,
      usedTemplateIds: history(i),
      context: { language: "English" },
      batchUsage,
    });
    assert.equal(selection.ok, true);
    const id = selection.template.template_id;
    picked.push(id);
    if (batchUsage) batchUsage.set(id, (batchUsage.get(id) || 0) + 1);
  }
  return picked;
}

test("the OLD behaviour is pinned: without batch usage every recipient gets one variant", () => {
  const picked = runBatch(5, { useBatchUsage: false });
  assert.equal(new Set(picked).size, 1, "this is the reported defect");
});

test("a batch smaller than the pool gives every recipient a DIFFERENT variant", () => {
  const picked = runBatch(5);
  assert.equal(new Set(picked).size, 5, `expected 5 distinct variants, got ${picked.join(", ")}`);
});

test("a batch larger than the pool spreads evenly instead of repeating one", () => {
  const picked = runBatch(13);
  const counts = new Map();
  for (const id of picked) counts.set(id, (counts.get(id) || 0) + 1);
  assert.equal(counts.size, 6, "every variant should be in play");
  const values = [...counts.values()];
  // 13 across 6 variants: no variant used more than twice, none skipped.
  assert.ok(Math.max(...values) - Math.min(...values) <= 1, `uneven: ${values.join(",")}`);
});

test("per-thread history still outranks batch variety", () => {
  // This thread has already seen variants 1-5, so it must get 6 even though
  // 6 may already have been used in the batch. A seller must never be re-sent
  // copy they have had just to spread a batch.
  const batchUsage = new Map([["fus2-en-6", 3]]);
  const selection = selectFus2Template({
    templates,
    usedTemplateIds: ["fus2-en-1", "fus2-en-2", "fus2-en-3", "fus2-en-4", "fus2-en-5"],
    context: { language: "English" },
    batchUsage,
  });
  assert.equal(selection.template.template_id, "fus2-en-6");
});

test("selection is deterministic -- the same batch produces the same assignment", () => {
  assert.deepEqual(runBatch(9), runBatch(9));
});

test("a thread that has seen everything still gets a template, flagged exhausted", () => {
  const selection = selectFus2Template({
    templates,
    usedTemplateIds: templates.map((t) => t.template_id),
    context: { language: "English" },
    batchUsage: new Map(),
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.exhausted, true);
  assert.ok(selection.template);
});

test("omitting batchUsage keeps the previous single-thread contract intact", () => {
  const selection = selectFus2Template({
    templates,
    usedTemplateIds: [],
    context: { language: "English" },
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.rotation_reason, "unused_variant_preferred");
});
