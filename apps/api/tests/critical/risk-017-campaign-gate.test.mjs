import test from "node:test";
import assert from "node:assert/strict";

import { runSupabaseOutboundFeeder } from "@/lib/domain/outbound/run-supabase-outbound-feeder.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandidateRow(overrides = {}) {
  return {
    master_owner_id: "own-1",
    property_id: "prop-1",
    to_phone_number: "+15005550001",
    touch_number: 1,
    template_use_case: "ownership_check",
    first_name: "John",
    last_name: "Doe",
    property_address_street: "123 Main St",
    property_address_city: "Austin",
    property_address_state: "TX",
    property_address_zip: "78701",
    ...overrides,
  };
}

function makePipelineDeps({ suppress = false, write_count_ref = { n: 0 }, candidates = null } = {}) {
  const rows = candidates ?? [makeCandidateRow()];
  return {
    _loadCandidates: async () => ({ rows, scanned_count: rows.length, source: "test" }),
    _resolveNextTouch: async (candidate) => ({
      ok: true,
      touch_number: candidate.touch_number ?? 1,
      template_use_case: candidate.template_use_case ?? "ownership_check",
      stage_code: "T1",
      is_first_touch: true,
    }),
    _evaluateEligibility: async () => ({ ok: true, scheduled_for: new Date().toISOString() }),
    _chooseNumber: async () => ({ ok: true, from_phone_number: "+15005550002", textgrid_number_id: "tg-1" }),
    _renderTemplate: async (candidate) => ({
      ok: true,
      rendered_message_body: `Hi ${candidate.first_name}, are you interested in selling ${candidate.property_address_street}?`,
      template_use_case: candidate.template_use_case ?? "ownership_check",
      language: "en",
      stage_code: "T1",
      selected_template: { id: "tpl-1", source: "supabase" },
      queue_payload: {
        to_phone_number: candidate.to_phone_number,
        from_phone_number: "+15005550002",
        message_body: `Hi ${candidate.first_name}, are you interested in selling?`,
        message_type: "outbound",
        template_id: "tpl-1",
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        touch_number: candidate.touch_number ?? 1,
        template_use_case: candidate.template_use_case ?? "ownership_check",
      },
    }),
    canSend: async ({ to_phone_number } = {}) => ({
      ok: !suppress,
      reason: suppress ? "phone_suppressed" : null,
    }),
    _insertRow: async () => { write_count_ref.n++; return { ok: true, id: `q-${write_count_ref.n}` }; },
    _acquireFeederLock: () => true,
    _releaseFeederLock: () => {},
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("RISK-017: suppressed candidate is skipped, writer not called", async () => {
  const write_count_ref = { n: 0 };
  const result = await runSupabaseOutboundFeeder(
    { limit: 10, dry_run: false },
    makePipelineDeps({ suppress: true, write_count_ref })
  );
  assert.equal(write_count_ref.n, 0, "writer must not be called for suppressed candidate");
  assert.ok(result.skipped_count >= 1, "suppressed candidate must appear in skipped_count");
  const reasons = Object.keys(result.skip_reasons);
  const hasSuppressReason = reasons.some(r => r.startsWith("CAN_SEND_GATE:"));
  assert.ok(hasSuppressReason, `expected CAN_SEND_GATE skip reason, got: ${reasons.join(", ")}`);
});

test("RISK-017: healthy candidate passes gate, writer called once", async () => {
  const write_count_ref = { n: 0 };
  const result = await runSupabaseOutboundFeeder(
    { limit: 10, dry_run: false },
    makePipelineDeps({ suppress: false, write_count_ref })
  );
  assert.equal(write_count_ref.n, 1, "writer must be called exactly once for healthy candidate");
  assert.equal(result.queued_count, 1);
  assert.equal(result.skipped_count, 0);
});

test("RISK-017: dry_run skips canSend gate entirely (gate not called in dry_run)", async () => {
  let gate_called = false;
  const deps = {
    ...makePipelineDeps(),
    canSend: async () => { gate_called = true; return { ok: true }; },
  };
  const result = await runSupabaseOutboundFeeder({ limit: 10, dry_run: true }, deps);
  assert.equal(gate_called, false, "canSend gate must not be called in dry_run mode");
  assert.equal(result.dry_run, true);
});

test("RISK-017: gate skip reason includes the gate.reason string", async () => {
  const deps = {
    ...makePipelineDeps({ suppress: true }),
    canSend: async () => ({ ok: false, reason: "phone_suppressed" }),
  };
  const result = await runSupabaseOutboundFeeder({ limit: 10, dry_run: false }, deps);
  const reasons = Object.keys(result.skip_reasons);
  assert.ok(
    reasons.includes("CAN_SEND_GATE:phone_suppressed"),
    `expected CAN_SEND_GATE:phone_suppressed in skip_reasons, got: ${reasons.join(", ")}`
  );
});

test("RISK-017: multiple candidates — gate blocks suppressed, passes healthy", async () => {
  let write_count = 0;

  const candidates = [
    makeCandidateRow({ master_owner_id: "own-1", property_id: "prop-1", to_phone_number: "+15005550001" }),
    makeCandidateRow({ master_owner_id: "own-2", property_id: "prop-2", to_phone_number: "+15005550002" }),
    makeCandidateRow({ master_owner_id: "own-3", property_id: "prop-3", to_phone_number: "+15005550003" }),
  ];
  const suppressedPhones = new Set(["+15005550001"]);

  const deps = {
    ...makePipelineDeps({ candidates }),
    canSend: async ({ to_phone_number }) => ({
      ok: !suppressedPhones.has(to_phone_number),
      reason: suppressedPhones.has(to_phone_number) ? "phone_suppressed" : null,
    }),
    _insertRow: async () => { write_count++; return { ok: true, id: `q-${write_count}` }; },
  };

  const result = await runSupabaseOutboundFeeder({ limit: 10, dry_run: false }, deps);

  assert.equal(write_count, 2, "2 healthy candidates should be written");
  assert.equal(result.queued_count, 2);
  assert.equal(result.skipped_count, 1);
});
