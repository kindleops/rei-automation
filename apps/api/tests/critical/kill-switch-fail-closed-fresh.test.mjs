// ─── kill-switch-fail-closed-fresh.test.mjs ──────────────────────────────────
// Send-authorization fix (2026-11-11): the kill switches are read FRESH and a
// failed read never reads as "clear".
//
// Before: getSystemValue cached every key for 30s, so a stop written by one
// lambda was invisible to every other warm lambda for up to 30s; and any read
// error returned null (cached for 30s), which every brake evaluator treats as
// "no emergency stop" / "no global shutdown".

import assert from "node:assert/strict";
import test from "node:test";

import {
  KILL_SWITCH_KEYS,
  KILL_SWITCH_UNREADABLE,
  STOP_KILL_SWITCH_KEYS,
  clearSystemControlCache,
  getSystemFlag,
  getSystemFlags,
  getSystemValue,
  getSystemValueFresh,
  isKillSwitchKey,
} from "@/lib/system-control.js";
import { isEmergencyStopActive, evaluateQueueSendRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import { evaluateCanonicalSendAuthority } from "@/lib/domain/queue/canonical-send-authority.js";
import { evaluateManualSendAuthority } from "@/lib/domain/queue/manual-send-authority.js";

/** A system_control double whose rows can change between reads. */
function table(rows = {}) {
  const state = { rows: { ...rows }, reads: 0 };
  const supabase = {
    from() {
      return {
        select() {
          return {
            eq(_col, key) {
              return {
                async maybeSingle() {
                  state.reads += 1;
                  return Object.prototype.hasOwnProperty.call(state.rows, key)
                    ? { data: { value: state.rows[key] }, error: null }
                    : { data: null, error: null };
                },
              };
            },
            in(_col, keys) {
              state.reads += 1;
              return Promise.resolve({
                data: keys.filter((k) => k in state.rows).map((k) => ({ key: k, value: state.rows[k] })),
                error: null,
              });
            },
          };
        },
      };
    },
  };
  return { state, supabase };
}

const THROWING = {
  from() {
    return { select() { return { eq() { return { async maybeSingle() { throw new Error("connection reset"); } }; } }; } };
  },
};

const ERRORING = {
  from() {
    return { select() { return { eq() { return { async maybeSingle() { return { data: null, error: { message: "boom" } }; } }; } }; } };
  },
};

const OPERATOR = Object.freeze({ authenticated: true, auth_source: "ops_dashboard_session", via: "header:x-ops-dashboard-secret", id: "op-k", email: null });

test("the kill-switch key set covers both stops and the modes that close dispatch", () => {
  for (const key of ["queue_emergency_stop_at", "global_send_shutdown_at"]) {
    assert.ok(STOP_KILL_SWITCH_KEYS.includes(key), key);
  }
  for (const key of [...STOP_KILL_SWITCH_KEYS, "queue_processor_mode", "queue_execution_mode", "manual_send_mode", "outbound_sms_enabled"]) {
    assert.ok(KILL_SWITCH_KEYS.includes(key), key);
    assert.equal(isKillSwitchKey(key), true, key);
  }
  assert.equal(isKillSwitchKey("queue_run_limit"), false);
  assert.equal(isEmergencyStopActive(KILL_SWITCH_UNREADABLE), true, "the unreadable marker is an ACTIVE stop");
});

test("FRESH: an emergency stop written by another process is seen on the very next read (no 30s cache)", async () => {
  clearSystemControlCache();
  const { state, supabase } = table({ queue_emergency_stop_at: "" });
  assert.equal(await getSystemValue("queue_emergency_stop_at", { supabase }), "");
  state.rows.queue_emergency_stop_at = "2026-11-11T12:00:00.000Z"; // another lambda pressed stop
  assert.equal(await getSystemValue("queue_emergency_stop_at", { supabase }), "2026-11-11T12:00:00.000Z");
  state.rows.global_send_shutdown_at = "2026-11-11T12:01:00.000Z";
  assert.equal(await getSystemValue("global_send_shutdown_at", { supabase }), "2026-11-11T12:01:00.000Z");
  state.rows.manual_send_mode = "enabled";
  assert.equal(await getSystemValue("manual_send_mode", { supabase }), "enabled");
  state.rows.manual_send_mode = "disabled";
  assert.equal(await getSystemValue("manual_send_mode", { supabase }), "disabled");
});

test("FRESH: outbound_sms_enabled is re-read every time through getSystemFlag and getSystemFlags", async () => {
  clearSystemControlCache();
  const { state, supabase } = table({ outbound_sms_enabled: "true" });
  assert.equal(await getSystemFlag("outbound_sms_enabled", { supabase }), true);
  state.rows.outbound_sms_enabled = "false";
  assert.equal(await getSystemFlag("outbound_sms_enabled", { supabase }), false);
  state.rows.outbound_sms_enabled = "true";
  assert.deepEqual(await getSystemFlags(["outbound_sms_enabled"], { supabase }), { outbound_sms_enabled: true });
  state.rows.outbound_sms_enabled = "off";
  assert.deepEqual(await getSystemFlags(["outbound_sms_enabled"], { supabase }), { outbound_sms_enabled: false });
});

test("FAIL CLOSED: a thrown or errored read of a STOP key returns the unreadable marker, which every authority treats as active", async () => {
  for (const supabase of [THROWING, ERRORING]) {
    clearSystemControlCache();
    for (const key of STOP_KILL_SWITCH_KEYS) {
      assert.equal(await getSystemValue(key, { supabase }), KILL_SWITCH_UNREADABLE, key);
      assert.equal(await getSystemValueFresh(key, { supabase }), KILL_SWITCH_UNREADABLE, key);
    }

    const reader = (key) => getSystemValue(key, { supabase });
    const brakes = evaluateQueueSendRuntimeBrakes(
      { queue_emergency_stop_at: await reader("queue_emergency_stop_at"), queue_processor_mode: "live" },
      { action: "test" }
    );
    assert.equal(brakes.ok, false);
    assert.equal(brakes.reason, "queue_emergency_stop_active");

    const canonical = await evaluateCanonicalSendAuthority({ getSystemValue: reader });
    assert.equal(canonical.ok, false);
    assert.equal(canonical.reason, "global_send_shutdown_active", "the unreadable global shutdown denies first");

    const manual = await evaluateManualSendAuthority({ getSystemValue: reader, operator: OPERATOR });
    assert.equal(manual.ok, false);
    assert.equal(manual.reason, "global_send_shutdown_active");
  }
});

test("FAIL CLOSED: a failed read of a MODE key returns null, which normalizes to the closed posture", async () => {
  for (const supabase of [THROWING, ERRORING]) {
    clearSystemControlCache();
    for (const key of ["queue_processor_mode", "queue_execution_mode", "manual_send_mode"]) {
      assert.equal(await getSystemValue(key, { supabase }), null, key);
    }
    assert.equal(await getSystemFlag("outbound_sms_enabled", { supabase }), false);
  }
});

test("a failed read is never cached: the next successful read is served", async () => {
  clearSystemControlCache();
  assert.equal(await getSystemValue("queue_emergency_stop_at", { supabase: THROWING }), KILL_SWITCH_UNREADABLE);
  const { supabase } = table({ queue_emergency_stop_at: "" });
  assert.equal(await getSystemValue("queue_emergency_stop_at", { supabase }), "", "recovery is immediate, not after a TTL");
});

test("an absent stop row is clear (absence is not a failure)", async () => {
  clearSystemControlCache();
  const { supabase } = table({});
  assert.equal(await getSystemValue("queue_emergency_stop_at", { supabase }), null);
  assert.equal(isEmergencyStopActive(null), false);
});

test("in production with no Supabase configuration, a STOP key reads as unreadable (active), not clear", async () => {
  clearSystemControlCache();
  const original = process.env.NODE_ENV;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(await getSystemValue("queue_emergency_stop_at"), KILL_SWITCH_UNREADABLE);
    assert.equal(await getSystemValue("global_send_shutdown_at"), KILL_SWITCH_UNREADABLE);
    assert.equal(await getSystemValue("queue_execution_mode"), null);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test("non-kill-switch keys keep the 30s cache (unchanged behaviour)", async () => {
  clearSystemControlCache();
  const { state, supabase } = table({ queue_spacing_seconds: "45" });
  assert.equal(await getSystemValue("queue_spacing_seconds", { supabase }), "45");
  state.rows.queue_spacing_seconds = "90";
  assert.equal(await getSystemValue("queue_spacing_seconds", { supabase }), "45");
  assert.equal(state.reads, 1);
});
