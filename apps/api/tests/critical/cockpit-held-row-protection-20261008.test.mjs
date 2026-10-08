/**
 * P1 (owner 2026-10-08): runQueueAction (cockpit approve / retry /
 * retry-routing / reschedule) can no longer release a held row. Only an
 * explicit, audited owner release moves it, and every releasing action
 * respects outbound/runner flags, queue_processor_mode and the final-dispatch
 * gate.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { runQueueAction, isDispatchHeld, OWNER_RELEASE_CONFIRM } from "@/lib/cockpit/cockpit-service.js";

function db(row) {
  const calls = { updates: [], cas: [] };
  return {
    calls,
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: table === "send_queue" ? row : null, error: null }),
        then: (res, rej) => Promise.resolve({ data: [], count: 0, error: null }).then(res, rej),
        update(patch) {
          calls.updates.push(patch);
          const u = {
            eq(k, v) { if (k === "queue_status") calls.cas.push(v); return u; },
            select: () => ({ maybeSingle: async () => ({ data: { id: row.id, queue_status: patch.queue_status, thread_key: row.thread_key }, error: null }) }),
          };
          return u;
        },
      };
      return chain;
    },
  };
}
const flags = async () => ({ outbound_sms_enabled: true, queue_runner_enabled: true, followup_enabled: true });
const live = async () => "live";
const open = async () => ({ blocked: false });
const held = (extra = {}) => ({ id: "q1", queue_status: "held", thread_key: "+13145550101", to_phone_number: "+13145550101", metadata: {}, ...extra });
const run = (action, row, payload = {}, deps = {}) => {
  const supabase = db(row);
  return runQueueAction({ action, payload: { queue_item_id: row.id, dry_run: false, ...payload }, supabase, getFlags: flags, getValue: live, dispatchGate: open, releaseAudit: async () => ({ ok: true }), ...deps }).then((r) => ({ r, supabase }));
};

test("held detection: status held OR metadata.dispatch_hold", () => {
  assert.equal(isDispatchHeld(held()), true);
  assert.equal(isDispatchHeld({ queue_status: "scheduled", metadata: { dispatch_hold: { reason: "nurture_staging" } } }), true);
  assert.equal(isDispatchHeld({ queue_status: "scheduled", metadata: {} }), false);
});

for (const action of ["approve", "retry", "retry-routing", "reschedule", "hold"]) {
  test(`${action} on a held row is refused without an owner release (no write)`, async () => {
    for (const row of [held(), held({ queue_status: "scheduled", metadata: { dispatch_hold: true } })]) {
      const { r, supabase } = await run(action, row, { scheduled_for: "2026-10-09T15:00:00Z" });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "held_row_requires_owner_release");
      assert.equal(supabase.calls.updates.length, 0);
    }
  });
}

test("cancel on a held row is allowed", async () => {
  const { r, supabase } = await run("cancel", held());
  assert.equal(r.ok, true);
  assert.equal(supabase.calls.updates[0].queue_status, "cancelled");
});

test("owner release needs confirm + id list naming the row + actor + reason, and the audit row first", async () => {
  const good = { confirm: OWNER_RELEASE_CONFIRM, release_ids: ["q1", "q2"], actor: "owner@leadcommand", reason: "nurture staging approved" };
  for (const [patch, reason] of [
    [{ confirm: "yes" }, "owner_release_confirmation_missing"],
    [{ release_ids: ["q2"] }, "owner_release_id_not_listed"],
    [{ actor: "" }, "owner_release_actor_missing"],
    [{ reason: "" }, "owner_release_reason_missing"],
  ]) {
    const { r, supabase } = await run("owner-release", held(), { ...good, ...patch });
    assert.equal(r.reason, reason);
    assert.equal(supabase.calls.updates.length, 0);
  }
  const failedAudit = await run("owner-release", held(), good, { releaseAudit: async () => ({ ok: false }) });
  assert.equal(failedAudit.r.reason, "owner_release_audit_write_failed");
  assert.equal(failedAudit.supabase.calls.updates.length, 0, "no unaudited release");
  const audits = [];
  const ok = await run("owner-release", held(), good, { releaseAudit: async (e) => (audits.push(e), { ok: true }) });
  assert.equal(ok.r.ok, true);
  assert.equal(ok.supabase.calls.updates[0].queue_status, "scheduled");
  assert.equal(ok.supabase.calls.updates[0].metadata.owner_release.actor, "owner@leadcommand");
  assert.deepEqual(ok.supabase.calls.cas, ["held"], "CAS on the status that was read");
  assert.equal(audits[0].previous_status, "held");
  const notHeld = await run("owner-release", held({ queue_status: "scheduled" }), good);
  assert.equal(notHeld.r.reason, "owner_release_row_not_held");
});

test("every releasing action respects queue_processor_mode (off or unreadable = refused)", async () => {
  const row = { id: "q9", queue_status: "approval", thread_key: "+13145550101", to_phone_number: "+13145550101", metadata: {} };
  for (const action of ["approve", "retry", "reschedule"]) {
    for (const getValue of [async () => "off", async () => null, async () => { throw new Error("db"); }]) {
      const { r, supabase } = await run(action, row, { scheduled_for: "2026-10-09T15:00:00Z" }, { getValue });
      assert.equal(r.reason, "queue_processor_mode_off", action);
      assert.equal(supabase.calls.updates.length, 0);
    }
  }
  const cancel = await run("cancel", row, {}, { getValue: async () => "off" });
  assert.equal(cancel.r.ok, true, "cancel is never blocked by the pause");
});

test("reschedule now needs the outbound flags (it used to ignore them)", async () => {
  const row = { id: "q9", queue_status: "scheduled", thread_key: "+13145550101", to_phone_number: "+13145550101", metadata: {} };
  const { r } = await run("reschedule", row, { scheduled_for: "2026-10-09T15:00:00Z" }, { getFlags: async () => ({ outbound_sms_enabled: false, queue_runner_enabled: true }) });
  assert.equal(r.reason, "outbound_sms_disabled");
});

test("the final-dispatch gate binds approve / retry / reschedule / owner release; a gate error fails closed", async () => {
  const row = { id: "q9", queue_status: "approval", thread_key: "+13145550101", to_phone_number: "+13145550101", metadata: {} };
  const suppressed = await run("approve", row, {}, { dispatchGate: async () => ({ blocked: true, reason: "sms_suppression_list_active" }) });
  assert.equal(suppressed.r.reason, "final_dispatch_gate:sms_suppression_list_active");
  assert.equal(suppressed.supabase.calls.updates.length, 0);
  const err = await run("retry", row, {}, { dispatchGate: async () => { throw new Error("timeout"); } });
  assert.equal(err.r.reason, "final_dispatch_gate:final_dispatch_gate_read_failed");
  const release = await run("owner-release", held(), { confirm: OWNER_RELEASE_CONFIRM, release_ids: ["q1"], actor: "owner", reason: "r" }, { dispatchGate: async () => ({ blocked: true, reason: "wrong_number" }) });
  assert.equal(release.r.reason, "final_dispatch_gate:wrong_number");
});
