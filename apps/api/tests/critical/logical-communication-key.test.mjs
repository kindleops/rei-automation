/**
 * logical-communication-key.test.mjs
 *
 * Identity of a seller-visible communication ACTION.
 *
 * The properties that matter, and why each one is a duplicate-send bug if broken:
 *   - a RETRY must produce the same key            (else a retry becomes a new action)
 *   - a TEMPLATE ROTATION must produce the same key (Slice 0's exact defect)
 *   - a different DOMAIN ACTION must produce a different key (else real sends are lost)
 *   - a missing anchor must REFUSE                  (the random-UUID fallback made
 *                                                    UNIQUE(queue_key) vacuous)
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildLogicalCommunicationKey,
  isLogicalCommunicationKey,
  COMMUNICATION_TYPES,
  FORBIDDEN_IDENTITY_FIELDS,
  LOGICAL_COMMUNICATION_KEY_VERSION,
} from "@/lib/domain/communications/logical-communication-key.js";

const reply = (over = {}) => ({
  communication_type: COMMUNICATION_TYPES.AUTONOMOUS_REPLY,
  decision_id: "decision:evt-123",
  ...over,
});

// ── stability: the whole point ──────────────────────────────────────────────

test("a retry produces the SAME key: attempt number is not identity", () => {
  const a = buildLogicalCommunicationKey(reply({ attempt_number: 1 }));
  const b = buildLogicalCommunicationKey(reply({ attempt_number: 7 }));
  assert.equal(a.ok, true);
  assert.equal(a.key, b.key);
});

test("TEMPLATE ROTATION produces the same key -- this is Slice 0's defect", () => {
  // A rotated body previously minted a new identity and authorised a second SMS.
  const original = buildLogicalCommunicationKey(reply({
    template_id: "tpl-A", message_body: "Hi, are you open to an offer?",
  }));
  const rotated = buildLogicalCommunicationKey(reply({
    template_id: "tpl-B", message_body: "Totally different wording here.",
  }));
  assert.equal(original.key, rotated.key, "rotating a template must not create a new action");
});

test("transport details never move identity", () => {
  const base = buildLogicalCommunicationKey(reply());
  for (const noise of [
    { queue_row_id: "row-1" },
    { queue_key: "inbox:send_now:abc" },
    { provider_message_id: "SM123" },
    { from_phone_number: "+18885551212" },
    { textgrid_number_id: "tg-9" },
    { scheduled_for: "2026-01-01T00:00:00Z" },
    { transport_fingerprint: "deadbeef" },
  ]) {
    const k = buildLogicalCommunicationKey(reply(noise));
    assert.equal(k.key, base.key, `identity moved for ${JSON.stringify(noise)}`);
  }
});

test("the key is deterministic across processes: pure function of its anchors", () => {
  const keys = new Set(Array.from({ length: 25 }, () => buildLogicalCommunicationKey(reply()).key));
  assert.equal(keys.size, 1, "repeated construction must be identical");
});

// ── distinctness: a genuinely different action IS different ─────────────────

test("different domain actions produce different keys", () => {
  const seen = new Map();
  const cases = [
    ["decision A", reply({ decision_id: "decision:evt-1" })],
    ["decision B", reply({ decision_id: "decision:evt-2" })],
    ["same decision, next turn", reply({ decision_id: "decision:evt-1", action_sequence: "2" })],
    ["offer v1", { communication_type: COMMUNICATION_TYPES.MONETARY_OFFER, offer_id: "offer:o1", offer_version: 1 }],
    ["offer v2", { communication_type: COMMUNICATION_TYPES.MONETARY_OFFER, offer_id: "offer:o1", offer_version: 2 }],
    ["campaign t1", { communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH, campaign_target_id: "ct-1", touch_number: 1 }],
    ["campaign t2", { communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH, campaign_target_id: "ct-1", touch_number: 2 }],
    ["other target", { communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH, campaign_target_id: "ct-2", touch_number: 1 }],
  ];
  for (const [label, input] of cases) {
    const r = buildLogicalCommunicationKey(input);
    assert.equal(r.ok, true, label);
    assert.ok(!seen.has(r.key), `${label} collided with ${seen.get(r.key)}`);
    seen.set(r.key, label);
  }
});

test("the communication TYPE is part of identity", () => {
  // The same anchor string under two types must not collide.
  const a = buildLogicalCommunicationKey({
    communication_type: COMMUNICATION_TYPES.AUTONOMOUS_REPLY, decision_id: "x",
  });
  const b = buildLogicalCommunicationKey({
    communication_type: COMMUNICATION_TYPES.CLARIFICATION_REPLY, decision_id: "x",
  });
  assert.notEqual(a.key, b.key);
});

// ── refusal: no fallback, ever ──────────────────────────────────────────────

test("a MISSING anchor refuses instead of inventing an identity", () => {
  const r = buildLogicalCommunicationKey({ communication_type: COMMUNICATION_TYPES.AUTONOMOUS_REPLY });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_required_anchors");
  assert.deepEqual(r.missing, ["decision_id"]);
  assert.equal(r.key, undefined, "no key may be produced");
});

test("a BLANK anchor is a missing anchor, not a hashable value", () => {
  // Hashing "" yields a stable-looking key that identifies nothing, and every
  // caller with the same gap would collide onto it.
  for (const blank of ["", "   ", null, undefined]) {
    const r = buildLogicalCommunicationKey(reply({ decision_id: blank }));
    assert.equal(r.ok, false, `decision_id=${JSON.stringify(blank)} must refuse`);
  }
});

test("every communication type refuses when its anchors are absent", () => {
  for (const type of Object.values(COMMUNICATION_TYPES)) {
    const r = buildLogicalCommunicationKey({ communication_type: type });
    assert.equal(r.ok, false, `${type} must refuse without anchors`);
  }
});

test("an unknown or absent type refuses", () => {
  assert.equal(buildLogicalCommunicationKey({}).reason, "missing_communication_type");
  assert.equal(
    buildLogicalCommunicationKey({ communication_type: "made_up" }).reason,
    "unknown_communication_type"
  );
});

test("action_sequence must be a deliberate ordinal, never a clock", () => {
  assert.equal(buildLogicalCommunicationKey(reply({ action_sequence: "2" })).ok, true);
  for (const bad of [String(Date.now()), "2026-01-01", "abc", "1.5", "-1"]) {
    const r = buildLogicalCommunicationKey(reply({ action_sequence: bad }));
    assert.equal(r.ok, false, `action_sequence=${bad} must be rejected`);
  }
});

// ── structural guarantees ───────────────────────────────────────────────────

test("the module contains NO randomness and NO clock", async () => {
  // The single most important structural property: identity cannot be minted.
  // Comments are stripped first -- the header explains the randomUUID fallback
  // defect by name, and matching prose would fail for the wrong reason.
  const raw = await readFileSync();
  const code = raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  for (const forbidden of ["randomUUID", "Math.random", "Date.now", "new Date("]) {
    assert.ok(!code.includes(forbidden), `identity must never use ${forbidden}`);
  }
});

function readFileSync() {
  return readFile(
    new URL("../../src/lib/domain/communications/logical-communication-key.js", import.meta.url),
    "utf8"
  );
}

test("no forbidden presentation field is referenced as an identity component", () => {
  return readFileSync().then((code) => {
    // They may appear in the FORBIDDEN list and in prose, but never inside the
    // parts array that feeds the hash.
    const partsBlock = code.slice(code.indexOf("const parts = ["), code.indexOf("];", code.indexOf("const parts = [")));
    for (const field of FORBIDDEN_IDENTITY_FIELDS) {
      assert.ok(!partsBlock.includes(field), `${field} must not contribute to the hash`);
    }
  });
});

test("keys are recognisable and version-tagged", () => {
  const r = buildLogicalCommunicationKey(reply());
  assert.ok(isLogicalCommunicationKey(r.key));
  assert.ok(r.key.startsWith(`${LOGICAL_COMMUNICATION_KEY_VERSION}:`));
  assert.equal(r.version, LOGICAL_COMMUNICATION_KEY_VERSION);

  // Legacy/hand-made identifiers must not pass as logical keys.
  for (const bad of ["inbox:send_now:abc", crypto.randomUUID?.() ?? "x", "logical:deadbeef", ""]) {
    assert.equal(isLogicalCommunicationKey(bad), false, `${bad} must not validate`);
  }
});
