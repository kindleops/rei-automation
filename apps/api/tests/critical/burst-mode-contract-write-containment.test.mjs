import test from "node:test";
import assert from "node:assert/strict";

import { resolvePodioBusinessWritesEnabled } from "@/lib/flows/handle-textgrid-inbound.js";

// Permanent, explicit containment invariant (surfaced by the closing-loop
// trace): under seller-inbound BURST / internal-proof containment, Podio
// BUSINESS writes are suppressed — an accepted offer advances lead STATE but
// writes NO contract record. Only outside containment (Podio sync on AND not in
// burst) does the draft contract record get created. This pins the rule behind
// `podio_business_writes_enabled` so it cannot silently change: a live
// contract/closing artifact must never originate from a contained proof run.

test("burst/proof mode suppresses Podio business writes (no contract record)", () => {
  assert.equal(
    resolvePodioBusinessWritesEnabled({ podio_sync_enabled: true, seller_burst_enabled: true }),
    false,
    "burst containment => business writes OFF => acceptance creates no contract record"
  );
});

test("outside burst, with Podio sync on, business writes (contract record) are enabled", () => {
  assert.equal(
    resolvePodioBusinessWritesEnabled({ podio_sync_enabled: true, seller_burst_enabled: false }),
    true
  );
});

test("Podio sync off suppresses business writes regardless of burst", () => {
  assert.equal(
    resolvePodioBusinessWritesEnabled({ podio_sync_enabled: false, seller_burst_enabled: false }),
    false
  );
  assert.equal(
    resolvePodioBusinessWritesEnabled({ podio_sync_enabled: false, seller_burst_enabled: true }),
    false
  );
});

test("fails closed on missing inputs (defaults => writes OFF)", () => {
  assert.equal(resolvePodioBusinessWritesEnabled(), false);
  assert.equal(resolvePodioBusinessWritesEnabled({}), false);
});
