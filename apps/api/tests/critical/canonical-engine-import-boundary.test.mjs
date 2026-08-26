// ─── canonical-engine-import-boundary.test.mjs ───────────────────────────────
// Certification guard (closure pass 2026-08-26, Phase 12): the canonical
// inbound engine must never import a quarantined/dead competing engine. These
// modules have zero production callers and exist only for historical tests;
// a future contributor accidentally re-wiring one would split the brain.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src");

const CANONICAL_ENGINE_FILES = [
  "lib/flows/handle-textgrid-inbound.js",
  "lib/domain/seller-flow/process-seller-inbound-message.js",
  "lib/domain/seller-flow/apply-inbound-automation-decision.js",
  "lib/domain/seller-flow/run-inbound-intelligence-phase.js",
  "lib/domain/queue/run-send-queue.js",
  "lib/domain/queue/process-send-queue.js",
];

const QUARANTINED_MODULES = [
  "automation/intentMap",
  "automation/queueAutoReply",
  "automation/templateSelector",
  "sms/next_action_from_classification",
  "acquisition/inbound-dispatcher",
  "seller-flow/autonomous-seller-reply",
  "sms/flow_map",
  "sms/template_resolver",
];

test("the canonical engine imports no quarantined competing engine", () => {
  const violations = [];
  for (const file of CANONICAL_ENGINE_FILES) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const quarantined of QUARANTINED_MODULES) {
      if (source.includes(`${quarantined}.js`) || source.includes(`${quarantined}"`)) {
        violations.push(`${file} imports ${quarantined}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("quarantined engines carry the deprecation banner", () => {
  const missing = [];
  for (const quarantined of [
    "lib/automation/intentMap.js",
    "lib/automation/queueAutoReply.js",
    "lib/automation/templateSelector.js",
    "lib/sms/next_action_from_classification.js",
    "lib/domain/acquisition/inbound-dispatcher.js",
  ]) {
    const source = readFileSync(path.join(ROOT, quarantined), "utf8");
    if (!/@deprecated|QUARANTINED|DEAD|ISOLATED/.test(source.slice(0, 1200))) {
      missing.push(quarantined);
    }
  }
  assert.deepEqual(missing, []);
});
