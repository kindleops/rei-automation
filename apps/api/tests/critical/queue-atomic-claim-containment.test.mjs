import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { runSendQueue } from "@/lib/domain/queue/run-send-queue.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { claimSendQueueRow, normalizeSendQueueRow } from "@/lib/supabase/sms-engine.js";
import {
  atomicClaimSendQueueRow,
  verifyDispatchAuthorization,
  guardedMutateScheduledFor,
  hashCanaryAuthorizationToken,
  CLAIM_MODES,
} from "@/lib/domain/queue/queue-atomic-claim.js";
import { QUEUE_EXECUTION_MODES } from "@/lib/domain/queue/queue-execution-mode.js";
import {
  buildSupabaseQueueRow,
  makeLiveQueueSystemValue,
  makeRunSendQueueDeps,
} from "../helpers/queue-run-test-harness.js";

const NOW = "2026-06-25T19:51:45.283Z";
const CAMPAIGN = "320c798a-84c9-45b8-a7c9-d166ddd7bd46";
const INCIDENT_RUN = "a470e1ab-e6a8-4517-a0b5-364775dcb954";
const AUTH_TOKEN = "incident-canary-auth-token";

function makeRow(id, overrides = {}) {
  return normalizeSendQueueRow(
    buildSupabaseQueueRow(id, {
      campaign_id: CAMPAIGN,
      scheduled_for: "2026-06-25T19:49:39.690Z",
      scheduled_for_utc: "2026-06-25T19:49:39.690Z",
      ...overrides,
    })
  );
}

function makeAtomicClaimSupabase(options = {}) {
  const controls = {
    queue_execution_mode: "stopped",
    queue_emergency_stop_at: "2026-06-25T19:12:44.295Z",
    queue_processor_mode: "off",
    ...options.controls,
  };
  const rows = new Map((options.rows || []).map((row) => [row.id, { ...row }]));
  const lock = { owner_type: options.lock_owner || null, canary_run_id: options.lock_canary || null };
  const authorizations = options.authorizations || new Map();
  const claim_audits = [];
  const scheduled_audits = [];
  let stale_cache_mode = options.stale_cached_mode || null;

  function normalizeMode() {
    if (stale_cache_mode) return stale_cache_mode;
    const raw = controls.queue_execution_mode || "stopped";
    if (raw === "normal") return "normal";
    if (raw === "scoped_canary_only") return "scoped_canary_only";
    return "stopped";
  }

  function emergencyActive() {
    const raw = controls.queue_emergency_stop_at;
    if (!raw) return false;
    return !["0", "false", "off", "none", "null", "cleared", "clear"].includes(String(raw).toLowerCase());
  }

  function processorMode() {
    const raw = (controls.queue_processor_mode || "off").toLowerCase();
    if (raw === "live") return "live";
    if (raw === "safe") return "safe";
    return "off";
  }

  return {
    claim_audits,
    scheduled_audits,
    rows,
    controls,
    setStaleCacheMode(mode) {
      stale_cache_mode = mode;
    },
    supabase: {
      rpc(name, params) {
        if (name === "queue_atomic_claim_send_row") {
          const row = rows.get(params.p_queue_row_id);
          const mode = normalizeMode();
          const claim_mode = params.p_claim_mode || "normal";
          const block = (reason) => {
            claim_audits.push({ ok: false, block_reason: reason, row_id: params.p_queue_row_id });
            return { data: { ok: false, claimed: false, reason, queue_execution_mode: mode }, error: null };
          };

          if (!row) return block("queue_row_not_found");
          if (row.metadata?.production_incident || row.metadata?.suppress_automatic_follow_up) {
            return block("incident_row_suppressed");
          }
          if (row.is_locked || row.lock_token) return block("queue_row_not_claimable");

          if (claim_mode === "scoped_canary") {
            if (mode !== "scoped_canary_only") return block("queue_execution_mode_not_scoped_canary_only");
            if (lock.owner_type !== "scoped_canary" || lock.canary_run_id !== params.p_canary_run_id) {
              return block("scoped_canary_execution_lock_mismatch");
            }
            const auth = authorizations.get(params.p_canary_run_id);
            if (!auth) return block("authorization_not_found");
            if (auth.authorization_token_hash !== params.p_authorization_token_hash) {
              return block("authorization_token_invalid");
            }
            if (auth.consumed_at) return block("authorization_already_consumed");
            if (auth.expires_at <= NOW) return block("authorization_expired");
            if (auth.campaign_id !== params.p_campaign_id) return block("authorization_campaign_mismatch");
            if (!auth.queue_row_ids.includes(params.p_queue_row_id)) return block("authorization_row_not_allowlisted");
          } else {
            if (mode !== "normal") {
              return block(mode === "stopped" ? "queue_execution_mode_stopped" : "queue_execution_mode_scoped_canary_only");
            }
            if (emergencyActive()) return block("queue_emergency_stop_active");
            if (processorMode() === "off") return block("queue_processor_paused");
            if (lock.owner_type && lock.owner_type !== "unrestricted") return block("global_execution_lock_held");
          }

          const claim_token = crypto.randomUUID();
          const claimed = {
            ...row,
            queue_status: "processing",
            is_locked: true,
            lock_token: claim_token,
            metadata: {
              ...(row.metadata || {}),
              processing_run_id: params.p_processing_run_id,
              claimed_by: claim_mode === "scoped_canary" ? "scoped_canary" : "queue_runner",
              claim_authorization_token: claim_token,
              claim_mode,
            },
          };
          rows.set(row.id, claimed);
          claim_audits.push({ ok: true, claim_token, row_id: row.id });
          return {
            data: {
              ok: true,
              claimed: true,
              reason: "claimed",
              claim_token,
              lock_token: claim_token,
              row: claimed,
              processing_run_id: params.p_processing_run_id,
            },
            error: null,
          };
        }

        if (name === "queue_verify_dispatch_authorization") {
          const row = rows.get(params.p_queue_row_id);
          if (!row) return { data: { ok: false, reason: "queue_row_not_found" }, error: null };
          if (row.lock_token !== params.p_claim_token) {
            return { data: { ok: false, reason: "claim_token_mismatch" }, error: null };
          }
          const mode = normalizeMode();
          const claim_mode = row.metadata?.claim_mode || "normal";
          if (claim_mode === "scoped_canary") {
            if (mode !== "scoped_canary_only") {
              return { data: { ok: false, reason: "queue_execution_mode_not_scoped_canary_only" }, error: null };
            }
          } else {
            if (mode !== "normal") {
              return {
                data: {
                  ok: false,
                  reason: mode === "stopped" ? "queue_execution_mode_stopped" : "queue_execution_mode_scoped_canary_only",
                },
                error: null,
              };
            }
            if (emergencyActive()) return { data: { ok: false, reason: "queue_emergency_stop_active" }, error: null };
            if (processorMode() === "off") return { data: { ok: false, reason: "queue_processor_paused" }, error: null };
          }
          return { data: { ok: true, reason: "dispatch_authorized", claim_mode }, error: null };
        }

        if (name === "queue_guarded_mutate_scheduled_for") {
          const mode = normalizeMode();
          if (mode !== "stopped") {
            scheduled_audits.push({ ok: false, reason: "execution_mode_must_be_stopped" });
            return { data: { ok: false, reason: "execution_mode_must_be_stopped" }, error: null };
          }
          if (lock.owner_type) {
            scheduled_audits.push({ ok: false, reason: "global_execution_lock_active" });
            return { data: { ok: false, reason: "global_execution_lock_active" }, error: null };
          }
          const updated = [];
          for (const id of params.p_row_ids) {
            const row = rows.get(id);
            if (!row) {
              scheduled_audits.push({ ok: false, reason: "queue_row_not_found", id });
              return { data: { ok: false, reason: "queue_row_not_found", queue_row_id: id }, error: null };
            }
            if (["processing", "sent", "delivered"].includes(row.queue_status) || row.lock_token) {
              scheduled_audits.push({ ok: false, reason: "queue_row_not_mutable", id });
              return { data: { ok: false, reason: "queue_row_not_mutable", queue_row_id: id }, error: null };
            }
            row.scheduled_for = params.p_scheduled_for;
            row.scheduled_for_utc = params.p_scheduled_for;
            rows.set(id, row);
            updated.push(id);
          }
          scheduled_audits.push({ ok: true, updated });
          return { data: { ok: true, updated_ids: updated, scheduled_for: params.p_scheduled_for }, error: null };
        }

        if (name === "queue_acquire_global_execution_lock") {
          if (lock.owner_type && lock.owner_type !== params.p_owner_type) {
            return { data: false, error: null };
          }
          lock.owner_type = params.p_owner_type;
          return { data: true, error: null };
        }
        if (name === "queue_release_global_execution_lock") {
          lock.owner_type = null;
          lock.canary_run_id = null;
          return { data: true, error: null };
        }
        return { data: null, error: { code: "42883", message: "function does not exist" } };
      },
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    },
  };
}

test("stopped mode claims zero rows via atomic claim", async () => {
  const row = makeRow("row-stopped-1");
  const { supabase } = makeAtomicClaimSupabase({ rows: [row] });
  const result = await atomicClaimSendQueueRow(row, { supabase, processing_run_id: INCIDENT_RUN });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "queue_execution_mode_stopped");
});

test("stopped mode plus due rows still claims zero", async () => {
  const row = makeRow("row-stopped-due", { scheduled_for: "2026-06-25T18:00:00.000Z" });
  const { supabase } = makeAtomicClaimSupabase({ rows: [row] });
  const result = await atomicClaimSendQueueRow(row, { supabase });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "queue_execution_mode_stopped");
});

test("active emergency stop claims zero in normal mode", async () => {
  const row = makeRow("row-emergency");
  const { supabase } = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "normal", queue_emergency_stop_at: NOW, queue_processor_mode: "live" },
  });
  const result = await atomicClaimSendQueueRow(row, { supabase });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "queue_emergency_stop_active");
});

test("processor off claims zero in normal mode", async () => {
  const row = makeRow("row-processor-off");
  const { supabase } = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "normal", queue_emergency_stop_at: "", queue_processor_mode: "off" },
  });
  const result = await atomicClaimSendQueueRow(row, { supabase });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "queue_processor_paused");
});

test("missing atomic claim RPC fails closed", async () => {
  const row = makeRow("row-rpc-missing");
  const supabase = { rpc: async () => ({ data: null, error: { code: "42883", message: "does not exist" } }) };
  const result = await atomicClaimSendQueueRow(row, { supabase });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "atomic_claim_function_unavailable");
  assert.equal(result.fail_closed, true);
});

test("stale cached normal cannot override database stopped at claim time", async () => {
  const row = makeRow("row-stale-cache");
  const harness = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "stopped" },
    stale_cached_mode: "normal",
  });
  harness.setStaleCacheMode(null);
  const result = await atomicClaimSendQueueRow(row, { supabase: harness.supabase });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "queue_execution_mode_stopped");
});

test("warm-instance simulation: route cache normal but DB stopped still claims zero", async () => {
  const row = makeRow("row-warm-bypass");
  const { deps, processed } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemValue = async (key) => {
    if (key === "queue_execution_mode") return QUEUE_EXECUTION_MODES.NORMAL;
    return makeLiveQueueSystemValue({ queue_execution_mode: "stopped" })(key);
  };
  const harness = makeAtomicClaimSupabase({ rows: [row], controls: { queue_execution_mode: "stopped" } });
  deps.supabaseClient = harness.supabase;
  deps.processSendQueueItem = processSendQueueItem;
  deps.sendTextgridSMS = async () => {
    throw new Error("TextGrid must not be called");
  };

  const route_result = await runSendQueue({ limit: 5, now: NOW }, deps);
  assert.equal(route_result.sent_count, 0);
  assert.equal(processed.length, 0);
});

test("scheduled_for changed to past while stopped still cannot dispatch", async () => {
  const row = makeRow("row-sched-patch", { scheduled_for: "2026-06-30T00:00:00.000Z" });
  const harness = makeAtomicClaimSupabase({ rows: [row], controls: { queue_execution_mode: "stopped" } });
  const mutation = await guardedMutateScheduledFor([row.id], "2026-06-25T19:49:39.690Z", {
    supabase: harness.supabase,
    operator_reason: "test_patch",
  });
  assert.equal(mutation.ok, true);
  const claim = await atomicClaimSendQueueRow(harness.rows.get(row.id), { supabase: harness.supabase });
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, "queue_execution_mode_stopped");
});

test("guarded scheduled_for mutation rejects when execution lock active", async () => {
  const row = makeRow("row-lock-block");
  const harness = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "stopped" },
    lock_owner: "scoped_canary",
  });
  const mutation = await guardedMutateScheduledFor([row.id], NOW, { supabase: harness.supabase });
  assert.equal(mutation.ok, false);
  assert.equal(mutation.reason, "global_execution_lock_active");
});

test("rows without database claim token cannot verify dispatch authorization", async () => {
  const missing = await verifyDispatchAuthorization(null, null, {
    supabase: { rpc: async () => ({ data: { ok: false }, error: null }) },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing_dispatch_authorization_inputs");

  const row = makeRow("row-no-token");
  const harness = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "normal", queue_processor_mode: "live", queue_emergency_stop_at: "" },
  });
  const claim = await atomicClaimSendQueueRow(row, { supabase: harness.supabase });
  assert.equal(claim.claimed, true);
  const bad_token = await verifyDispatchAuthorization(row.id, crypto.randomUUID(), {
    supabase: harness.supabase,
  });
  assert.equal(bad_token.ok, false);
  assert.equal(bad_token.reason, "claim_token_mismatch");
});

test("scoped authorization cannot be reused", async () => {
  const row = makeRow("row-auth-reuse");
  const canary_run_id = "canary-reuse-test";
  const harness = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "scoped_canary_only", queue_processor_mode: "live", queue_emergency_stop_at: "" },
    lock_owner: "scoped_canary",
    lock_canary: canary_run_id,
    authorizations: new Map([
      [
        canary_run_id,
        {
          authorization_token_hash: hashCanaryAuthorizationToken(AUTH_TOKEN),
          campaign_id: CAMPAIGN,
          queue_row_ids: [row.id],
          consumed_at: NOW,
          expires_at: "2026-06-25T20:30:00.000Z",
        },
      ],
    ]),
  });
  const result = await atomicClaimSendQueueRow(row, {
    supabase: harness.supabase,
    claim_mode: CLAIM_MODES.SCOPED_CANARY,
    canary_run_id,
    authorization_token: AUTH_TOKEN,
    campaign_id: CAMPAIGN,
  });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "authorization_already_consumed");
});

test("incident rows cannot be reclaimed", async () => {
  const row = makeRow("row-incident", {
    metadata: { production_incident: true, suppress_automatic_follow_up: true },
  });
  const harness = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "normal", queue_processor_mode: "live", queue_emergency_stop_at: "" },
  });
  const result = await atomicClaimSendQueueRow(row, { supabase: harness.supabase });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "incident_row_suppressed");
});

test("concurrency breach sequence: future rows, stopped mode, scheduled_for patched, cron fires, zero claimed", async () => {
  const ids = [
    "78c7fef7-f31d-40d3-bbe3-34068fa964ca",
    "9a792d18-83a3-4356-9ab4-fcc46ca98b6c",
    "9bc068a5-eca5-448b-a40b-40a3bb1f30de",
    "c54441eb-a9d1-4b60-902f-2baf942822d7",
    "d569d816-d50d-4d7a-bfb1-7a8c8ea2f5bb",
  ];
  const future = "2026-06-25T20:00:00.000Z";
  const past = "2026-06-25T19:49:39.690Z";
  const rows = ids.map((id) =>
    makeRow(id, { scheduled_for: future, scheduled_for_utc: future, metadata: { canary_run_id: "canary-live-miami-v2" } })
  );
  const harness = makeAtomicClaimSupabase({ rows, controls: { queue_execution_mode: "stopped" } });

  const mutation = await guardedMutateScheduledFor(ids, past, {
    supabase: harness.supabase,
    operator_reason: "breach_repro",
  });
  assert.equal(mutation.ok, true);

  const textgrid_calls = [];
  const { deps } = makeRunSendQueueDeps({ rows: [...harness.rows.values()], now: NOW });
  deps.getSystemValue = async (key) => {
    if (key === "queue_execution_mode") return QUEUE_EXECUTION_MODES.NORMAL;
    return makeLiveQueueSystemValue({ queue_execution_mode: "stopped" })(key);
  };
  deps.supabaseClient = harness.supabase;
  deps.processSendQueueItem = async (row, itemDeps) =>
    processSendQueueItem(row, {
      ...itemDeps,
      supabase: harness.supabase,
      sendTextgridSMS: async () => {
        textgrid_calls.push(row.id);
        return { sid: "SM_FAIL" };
      },
    });

  const cron_result = await runSendQueue({ limit: 5, now: NOW, processing_run_id: INCIDENT_RUN }, deps);
  assert.equal(cron_result.sent_count, 0);
  assert.equal(cron_result.claimed_count || 0, 0);
  assert.equal(textgrid_calls.length, 0);
  assert.equal(harness.claim_audits.filter((a) => a.ok).length, 0);
  assert.ok(harness.claim_audits.every((a) => !a.ok || a.block_reason !== undefined || a.ok === false));
});

test("verifyDispatchAuthorization blocks dispatch when brakes re-engage after claim", async () => {
  const row = makeRow("row-dispatch-verify");
  const harness = makeAtomicClaimSupabase({
    rows: [row],
    controls: { queue_execution_mode: "normal", queue_processor_mode: "live", queue_emergency_stop_at: "" },
  });
  const claim = await atomicClaimSendQueueRow(row, { supabase: harness.supabase, processing_run_id: INCIDENT_RUN });
  assert.equal(claim.claimed, true);
  harness.controls.queue_execution_mode = "stopped";
  const verify = await verifyDispatchAuthorization(row.id, claim.claim_token, { supabase: harness.supabase });
  assert.equal(verify.ok, false);
  assert.equal(verify.reason, "queue_execution_mode_stopped");
});

test("claimSendQueueRow delegates to atomic RPC and records block reason", async () => {
  const row = makeRow("row-delegate");
  const harness = makeAtomicClaimSupabase({ rows: [row], controls: { queue_execution_mode: "stopped" } });
  const result = await claimSendQueueRow(row, { supabase: harness.supabase });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "queue_execution_mode_stopped");
  assert.equal(harness.claim_audits.length, 1);
});