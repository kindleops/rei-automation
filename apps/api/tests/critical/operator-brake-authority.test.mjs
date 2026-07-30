/**
 * Operator brakes outrank campaign state.
 *
 * Regression coverage for the containment failure of 2026-07-29: writing
 * system_control.queue_execution_mode='paused' was reverted to 'normal' within
 * ~80s by the campaign feeder cron, because buildProductionQueueRailsPatch
 * re-asserted the full execution posture on every 5-minute tick (and also
 * cleared queue_emergency_stop_at).
 *
 * These tests are intentionally key-agnostic where possible: they assert the
 * DENYLIST is enforced, not merely that one specific key is absent, so the next
 * key added to the rails patch cannot silently reintroduce the same bug.
 */

import test from "node:test";
import assert from "node:assert/strict";

import "../helpers/critical-test-environment.mjs";

import {
  OPERATOR_OWNED_SYSTEM_KEYS,
  OPERATOR_STOP_COMPANION_KEYS,
  CAMPAIGN_FORBIDDEN_SYSTEM_KEYS,
  SYSTEM_CONTROL_AUTHORITIES,
  isOperatorOwnedSystemKey,
  stripOperatorOwnedSystemKeys,
  assertNoOperatorOwnedSystemKeys,
  describeCampaignRequestedPosture,
} from "@/lib/domain/queue/operator-brake-authority.js";
import {
  buildProductionQueueRailsPatch,
  syncProductionQueueRailsFromCampaign,
  finalizeOperatorLiveActivation,
} from "@/lib/domain/campaigns/campaign-live-execution.js";
import {
  QUEUE_EXECUTION_MODES,
  normalizeQueueExecutionMode,
  evaluateUnrestrictedDispatchGate,
} from "@/lib/domain/queue/queue-execution-mode.js";

function liveProductionCampaign(overrides = {}) {
  return {
    id: "camp-brake-1",
    status: "active",
    auto_queue_enabled: true,
    auto_send_enabled: true,
    auto_reply_mode: "live_limited",
    batch_max: 50,
    daily_cap: 750,
    market_cap: 400,
    per_sender_cap: 150,
    market: "Miami, FL",
    metadata: { production_launch: true },
    ...overrides,
  };
}

/** In-memory system_control that any campaign automation path can write through. */
function makeSystemControl(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key) => store.get(key) ?? null,
    // Mirrors setSystemValues' campaign_automation authority contract.
    setSystemValues: async (pairs, opts = {}) => {
      const authority = opts.authority || SYSTEM_CONTROL_AUTHORITIES.OPERATOR;
      const { patch, removed } =
        authority === SYSTEM_CONTROL_AUTHORITIES.CAMPAIGN_AUTOMATION
          ? stripOperatorOwnedSystemKeys(pairs)
          : { patch: pairs, removed: [] };
      for (const [key, value] of Object.entries(patch)) store.set(key, String(value ?? ""));
      return { ok: true, updated: Object.keys(patch).length, blocked_keys: removed };
    },
  };
}

// ── denylist shape ───────────────────────────────────────────────────────────

test("operator-owned denylist covers every mandated execution-posture key", () => {
  for (const key of [
    "queue_execution_mode",
    "queue_emergency_stop_at",
    "queue_processor_mode",
    "queue_runner_enabled",
    "queue_auto_send_enabled",
    "outbound_sms_enabled",
  ]) {
    assert.ok(OPERATOR_OWNED_SYSTEM_KEYS.includes(key), `${key} must be operator-owned`);
    assert.equal(isOperatorOwnedSystemKey(key), true);
  }
  // Companion keys from rearmEmergencyStopAfterOneSend are also protected, so a
  // rails tick cannot partially undo an operator stop.
  for (const key of OPERATOR_STOP_COMPANION_KEYS) {
    assert.equal(isOperatorOwnedSystemKey(key), true);
    assert.ok(CAMPAIGN_FORBIDDEN_SYSTEM_KEYS.includes(key));
  }
  // Tuning keys stay writable by campaigns.
  assert.equal(isOperatorOwnedSystemKey("queue_daily_send_cap"), false);
  assert.equal(isOperatorOwnedSystemKey("queue_market_filter"), false);
});

test("stripOperatorOwnedSystemKeys removes only operator keys and reports them", () => {
  const { patch, removed } = stripOperatorOwnedSystemKeys({
    queue_execution_mode: "normal",
    queue_emergency_stop_at: "",
    queue_daily_send_cap: "750",
  });
  assert.deepEqual(Object.keys(patch), ["queue_daily_send_cap"]);
  assert.deepEqual(removed.sort(), ["queue_emergency_stop_at", "queue_execution_mode"]);
});

test("assertNoOperatorOwnedSystemKeys throws with the offending keys", () => {
  assert.throws(
    () => assertNoOperatorOwnedSystemKeys({ outbound_sms_enabled: "true" }, "unit"),
    (err) =>
      err.code === "operator_owned_system_key_write_blocked" &&
      err.keys.includes("outbound_sms_enabled"),
  );
  assert.equal(assertNoOperatorOwnedSystemKeys({ queue_run_limit: "5" }), true);
});

// ── 1. an active campaign cannot move stopped/paused → normal ────────────────

test("active campaign cannot change queue_execution_mode from stopped to normal", async () => {
  const sc = makeSystemControl({ queue_execution_mode: "stopped" });
  const res = await syncProductionQueueRailsFromCampaign(liveProductionCampaign(), {
    setSystemValues: sc.setSystemValues,
  });
  assert.equal(res.ok, true);
  assert.equal(sc.get("queue_execution_mode"), "stopped");
  assert.equal(normalizeQueueExecutionMode(sc.get("queue_execution_mode")), "stopped");
});

test("active campaign cannot change legacy 'paused' execution mode to normal", async () => {
  // Production currently stores the legacy literal 'paused'; it must stay put
  // AND stay fail-closed.
  const sc = makeSystemControl({ queue_execution_mode: "paused" });
  await syncProductionQueueRailsFromCampaign(liveProductionCampaign(), {
    setSystemValues: sc.setSystemValues,
  });
  assert.equal(sc.get("queue_execution_mode"), "paused");
  assert.equal(normalizeQueueExecutionMode("paused"), QUEUE_EXECUTION_MODES.STOPPED);
  assert.equal(evaluateUnrestrictedDispatchGate("paused").ok, false);
});

// ── 2. an active campaign cannot clear the emergency brake ───────────────────

test("active campaign cannot clear queue_emergency_stop_at", async () => {
  const stampedAt = "2026-07-29T06:14:21.151Z";
  const sc = makeSystemControl({ queue_emergency_stop_at: stampedAt });
  await syncProductionQueueRailsFromCampaign(liveProductionCampaign(), {
    setSystemValues: sc.setSystemValues,
  });
  assert.equal(sc.get("queue_emergency_stop_at"), stampedAt);
});

// ── 3. feeder cycles leave every operator brake unchanged ────────────────────

test("repeated campaign feeder cycles leave all operator brakes unchanged", async () => {
  const brakes = {
    queue_execution_mode: "stopped",
    queue_emergency_stop_at: "2026-07-29T06:14:21.151Z",
    queue_processor_mode: "off",
    queue_runner_enabled: "false",
    queue_auto_send_enabled: "false",
    outbound_sms_enabled: "false",
    campaign_mode: "paused",
    queue_auto_enqueue_enabled: "false",
  };
  const sc = makeSystemControl({ ...brakes });
  const campaigns = [
    liveProductionCampaign({ id: "camp-a" }),
    liveProductionCampaign({ id: "camp-b" }),
    liveProductionCampaign({ id: "camp-c" }),
  ];
  // 3 campaigns x 5 feeder ticks — the real cron shape that caused the revert.
  for (let tick = 0; tick < 5; tick += 1) {
    for (const campaign of campaigns) {
      await syncProductionQueueRailsFromCampaign(campaign, { setSystemValues: sc.setSystemValues });
    }
  }
  for (const [key, value] of Object.entries(brakes)) {
    assert.equal(sc.get(key), value, `${key} must survive every feeder tick`);
  }
  // Tuning rails did synchronize, proving the sync actually ran.
  assert.equal(sc.get("queue_daily_send_cap"), "750");
});

// ── 4. reactivating a campaign while stopped does not arm dispatch ───────────

test("reactivating a campaign while execution is stopped does not arm dispatch", async () => {
  const sc = makeSystemControl({ queue_execution_mode: "stopped" });
  const campaignRow = liveProductionCampaign();
  const supabase = {
    from(table) {
      assert.equal(table, "campaigns");
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: campaignRow }) }) }),
        update: () => ({
          eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: campaignRow }) }) }),
        }),
      };
    },
  };

  let dispatchArmed = false;
  const result = await finalizeOperatorLiveActivation(
    campaignRow.id,
    {},
    {
      supabase,
      setSystemValues: sc.setSystemValues,
      // Stand-in for runSendQueue: honours the same gate the real one applies at
      // run-send-queue.js before claiming any row.
      runSendQueue: async () => {
        const gate = evaluateUnrestrictedDispatchGate(sc.get("queue_execution_mode"), {
          action: "runSendQueue",
        });
        if (!gate.ok) return { ok: false, ...gate };
        dispatchArmed = true;
        return { ok: true, sent_count: 1, claimed_count: 1, results: [] };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(dispatchArmed, false, "activation must not arm dispatch while stopped");
  assert.equal(sc.get("queue_execution_mode"), "stopped");
  assert.equal(result.processor_result?.ok, false);
  assert.equal(result.processor_result?.reason, "queue_execution_mode_stopped");
  assert.equal(result.sent_count, 0);
});

// ── 5. the prior clobber regression is permanently covered ───────────────────

test("rails patch carries no operator-owned key for any campaign shape", () => {
  const shapes = [
    liveProductionCampaign(),
    liveProductionCampaign({ market: "Los Angeles, CA", metadata: { production_launch: true, state: "CA" } }),
    liveProductionCampaign({ batch_max: null, daily_cap: null, market_cap: null, per_sender_cap: null }),
    liveProductionCampaign({ market: "", metadata: { production_launch: true } }),
  ];
  for (const campaign of shapes) {
    const patch = buildProductionQueueRailsPatch(campaign);
    for (const key of CAMPAIGN_FORBIDDEN_SYSTEM_KEYS) {
      assert.equal(key in patch, false, `rails patch must never carry ${key}`);
    }
    assert.equal("auto_reply_mode" in patch, false);
  }
});

test("campaign automation authority blocks operator keys even if a patch smuggles them", async () => {
  // Defense in depth: even if a future caller hand-builds a patch, the write
  // seam refuses the operator keys.
  const sc = makeSystemControl({ queue_execution_mode: "stopped", outbound_sms_enabled: "false" });
  const res = await sc.setSystemValues(
    { queue_execution_mode: "normal", outbound_sms_enabled: "true", queue_run_limit: "10" },
    { authority: SYSTEM_CONTROL_AUTHORITIES.CAMPAIGN_AUTOMATION, context: "test" },
  );
  assert.deepEqual(res.blocked_keys.sort(), ["outbound_sms_enabled", "queue_execution_mode"]);
  assert.equal(sc.get("queue_execution_mode"), "stopped");
  assert.equal(sc.get("outbound_sms_enabled"), "false");
  assert.equal(sc.get("queue_run_limit"), "10");
});

test("operator authority may still write brakes (control plane is not blocked)", async () => {
  const sc = makeSystemControl({ queue_execution_mode: "stopped" });
  await sc.setSystemValues(
    { queue_execution_mode: "normal" },
    { authority: SYSTEM_CONTROL_AUTHORITIES.OPERATOR },
  );
  assert.equal(sc.get("queue_execution_mode"), "normal");
});

test("campaigns may request a posture but it is advisory only", async () => {
  const sc = makeSystemControl({ queue_execution_mode: "stopped" });
  const res = await syncProductionQueueRailsFromCampaign(liveProductionCampaign(), {
    setSystemValues: sc.setSystemValues,
  });
  const posture = res.requested_posture;
  assert.equal(posture.requested_queue_execution_mode, "normal");
  assert.equal(posture.authoritative, false);
  assert.equal(posture.campaign_id, "camp-brake-1");
  // Requesting normal changed nothing.
  assert.equal(sc.get("queue_execution_mode"), "stopped");
  assert.equal(describeCampaignRequestedPosture({}).authoritative, false);
});
