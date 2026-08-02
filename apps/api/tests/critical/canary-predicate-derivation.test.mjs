import test from "node:test";
import assert from "node:assert/strict";

import {
  hasAbsoluteNoSendMarkers,
  hasQuarantineMarkers,
  isProofOrNoSendQueueRow,
} from "@/lib/domain/queue/run-scoped-campaign-canary.js";

// The absolute no-send list must live in exactly one place
// (hasAbsoluteNoSendMarkers); isProofOrNoSendQueueRow derives from it, so a
// marker added there automatically applies to both gates and the
// internal-canary exception can never bypass it. These tests pin that
// derivation and the current marker vocabularies.

const ABSOLUTE_MARKER_ROWS = [
  { name: "proof", metadata: { proof: true } },
  { name: "proof_mode", metadata: { proof_mode: "scoped" } },
  { name: "no_send", metadata: { no_send: true } },
  { name: "proof_hydration", metadata: { proof_hydration: true } },
  { name: "launch_mode", metadata: { launch_mode: "proof_hydration_no_send" } },
];

const QUARANTINE_MARKER_ROWS = [
  { name: "internal_test_phone", metadata: { internal_test_phone: true } },
  { name: "exclude_from_kpis", metadata: { exclude_from_kpis: true } },
];

test("every absolute no-send marker is honored by both predicates", () => {
  for (const { name, metadata } of ABSOLUTE_MARKER_ROWS) {
    const row = { metadata };
    assert.equal(hasAbsoluteNoSendMarkers(row), true, `absolute: ${name}`);
    assert.equal(isProofOrNoSendQueueRow(row), true, `derived: ${name}`);
    assert.equal(hasQuarantineMarkers(row), false, `not quarantine: ${name}`);
  }
});

test("quarantine markers exclude from the broad predicate without being absolute", () => {
  for (const { name, metadata } of QUARANTINE_MARKER_ROWS) {
    const row = { metadata };
    assert.equal(hasQuarantineMarkers(row), true, `quarantine: ${name}`);
    assert.equal(isProofOrNoSendQueueRow(row), true, `derived: ${name}`);
    assert.equal(hasAbsoluteNoSendMarkers(row), false, `not absolute: ${name}`);
  }
});

test("derivation: any row flagged absolute is always proof-excluded, even novel combinations", () => {
  for (const absolute of ABSOLUTE_MARKER_ROWS) {
    for (const quarantine of QUARANTINE_MARKER_ROWS) {
      const row = {
        metadata: {
          ...absolute.metadata,
          ...quarantine.metadata,
          internal_canary: true,
        },
        to_phone_number: "+16128072000",
      };
      // A genuine internal-canary row (stamped + registered phone) that ALSO
      // carries an absolute marker must remain absolutely excluded: the
      // canary dispatch exception only relaxes the quarantine vocabulary.
      assert.equal(
        hasAbsoluteNoSendMarkers(row),
        true,
        `${absolute.name}+${quarantine.name}`
      );
      assert.equal(
        isProofOrNoSendQueueRow(row),
        true,
        `${absolute.name}+${quarantine.name}`
      );
    }
  }
});

test("clean rows carry no markers under either predicate", () => {
  for (const row of [{}, { metadata: {} }, { metadata: { campaign_id: "c1" } }, { metadata: null }]) {
    assert.equal(hasAbsoluteNoSendMarkers(row), false);
    assert.equal(hasQuarantineMarkers(row), false);
    assert.equal(isProofOrNoSendQueueRow(row), false);
  }
});
