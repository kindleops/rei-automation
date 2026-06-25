import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { handleQueueRunRequest } from "@/lib/domain/queue/queue-run-request.js";
import { runSendQueue } from "@/lib/domain/queue/run-send-queue.js";
import {
  runScopedCampaignCanary,
  validateScopedCanaryAllowlist,
} from "@/lib/domain/queue/run-scoped-campaign-canary.js";
import {
  authorizationMatchesRequest,
  validateCanaryAuthorizationToken,
} from "@/lib/domain/queue/queue-canary-authorization.js";
import { requireScopedCanaryExecutionAuth } from "@/lib/security/scoped-canary-auth.js";
import {
  evaluateUnrestrictedDispatchGate,
  evaluateScopedCanaryDispatchGate,
  QUEUE_EXECUTION_MODES,
} from "@/lib/domain/queue/queue-execution-mode.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { normalizeSendQueueRow } from "@/lib/supabase/sms-engine.js";
import {
  buildSupabaseQueueRow,
  makeLiveQueueSystemValue,
  makeRunSendQueueDeps,
} from "../helpers/queue-run-test-harness.js";

const CAMPAIGN_A = "320c798a-84c9-45b8-a7c9-d166ddd7bd46";
const CAMPAIGN_B = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-06-25T18:00:00.000Z";
const CANARY_RUN = "canary-lockdown-test";
const AUTH_TOKEN = "test-canary-auth-token";

function makeAuth(authorized = true) {
  return () => ({
    authorized,
    auth: { authenticated: true, is_vercel_cron: true },
    response: null,
  });
}

function makeJsonResponse() {
  const responses = [];
  const fn = (body, init) => {
    const r = { body, status: init?.status ?? 200 };
    responses.push(r);
    return r;
  };
  return { responses, fn };
}

function liveRow(id, campaignId = CAMPAIGN_A, overrides = {}) {
  return normalizeSendQueueRow({
    id,
    campaign_id: campaignId,
    queue_status: "queued",
    scheduled_for: NOW,
    scheduled_for_utc: NOW,
    message_body: "Hi Alex, checking ownership for 123 Main St.",
    to_phone_number: "+13053315715",
    from_phone_number: "+17866052999",
    template_id: "840906",
    seller_first_name: "Berta",
    sms_eligible: true,
    routing_allowed: true,
    metadata: {
      no_send: false,
      launch_mode: "guarded_live_queue_creation",
      candidate_snapshot: {
        master_owner_id: "mo_1",
        property_id: "prop_1",
        phone_id: "ph_1",
        seller_first_name: "Berta",
        touch_number: 1,
      },
    },
    ...overrides,
  });
}

function makeScopedSupabase(rowsById = new Map(), options = {}) {
  let lock_owner = options.lock_owner || null;
  const authorizations = options.authorizations || new Map();
  const audits = [];

  return {
    audits,
    rpc(name, params) {
      if (name === "queue_acquire_global_execution_lock") {
        if (lock_owner && lock_owner !== params.p_owner_type) {
          return Promise.resolve({ data: false, error: null });
        }
        lock_owner = params.p_owner_type;
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "queue_release_global_execution_lock") {
        lock_owner = null;
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "unknown_rpc" } });
    },
    from(table) {
      if (table === "send_queue") {
        const filters = { ids: null, campaign_id: null, not_null_campaign: false };
        const builder = {
          select() {
            return builder;
          },
          in(_field, ids) {
            filters.ids = ids;
            return builder;
          },
          eq(field, value) {
            if (field === "campaign_id") filters.campaign_id = value;
            return builder;
          },
          not(field, op) {
            if (field === "campaign_id" && op === "is") filters.not_null_campaign = true;
            return builder;
          },
          then(resolve, reject) {
            const rows = [...rowsById.values()].filter((row) => {
              if (filters.ids && !filters.ids.includes(row.id)) return false;
              if (filters.campaign_id && row.campaign_id !== filters.campaign_id) return false;
              if (filters.not_null_campaign && !row.campaign_id) return false;
              return true;
            });
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          },
        };
        return builder;
      }
      if (table === "queue_canary_authorizations") {
        return {
          select() {
            return {
              eq(_field, canary_run_id) {
                return {
                  maybeSingle: async () => ({
                    data: authorizations.get(canary_run_id) || null,
                    error: null,
                  }),
                };
              },
            };
          },
          update() {
            return {
              eq() {
                return {
                  is() {
                    return {
                      select() {
                        return {
                          maybeSingle: async () => ({ data: { id: "auth-1", consumed_at: NOW }, error: null }),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "queue_canary_execution_audits") {
        return {
          insert(row) {
            audits.push(row);
            return {
              select() {
                return {
                  single: async () => ({ data: { id: "audit-1", created_at: NOW }, error: null }),
                };
              },
            };
          },
        };
      }
      return {
        select() {
          return this;
        },
      };
    },
  };
}

test("evaluateUnrestrictedDispatchGate blocks stopped and scoped_canary_only", () => {
  const stopped = evaluateUnrestrictedDispatchGate(QUEUE_EXECUTION_MODES.STOPPED);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "queue_execution_mode_stopped");

  const scoped = evaluateUnrestrictedDispatchGate(QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY);
  assert.equal(scoped.ok, false);
  assert.equal(scoped.reason, "queue_execution_mode_scoped_canary_only");

  const normal = evaluateUnrestrictedDispatchGate(QUEUE_EXECUTION_MODES.NORMAL);
  assert.equal(normal.ok, true);
});

test("evaluateScopedCanaryDispatchGate requires scoped_canary_only", () => {
  const blocked = evaluateScopedCanaryDispatchGate(QUEUE_EXECUTION_MODES.STOPPED);
  assert.equal(blocked.ok, false);

  const allowed = evaluateScopedCanaryDispatchGate(QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY);
  assert.equal(allowed.ok, true);
});

test("runSendQueue sends zero rows in scoped_canary_only", async () => {
  const row = buildSupabaseQueueRow(4001);
  const { deps } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemValue = async (key) => {
    if (key === "queue_execution_mode") return QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY;
    return makeLiveQueueSystemValue()(key);
  };

  const result = await runSendQueue({ limit: 10, now: NOW }, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.sent_count, 0);
  assert.equal(result.claimed_count, 0);
  assert.equal(result.reason, "queue_execution_mode_scoped_canary_only");
});

test("runSendQueue no-ops when scoped canary holds global lock", async () => {
  const row = buildSupabaseQueueRow(4002);
  const { deps, processed } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemValue = makeLiveQueueSystemValue({ queue_execution_mode: QUEUE_EXECUTION_MODES.NORMAL });
  deps.supabaseClient = {
    rpc(name) {
      if (name === "queue_acquire_global_execution_lock") {
        return Promise.resolve({ data: false, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      return {
        select() {
          return this;
        },
        update() {
          return {
            eq() {
              return {
                lt() {
                  return { select: async () => ({ data: [], error: null }) };
                },
              };
            },
          };
        },
      };
    },
  };

  const result = await runSendQueue({ limit: 10, now: NOW }, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.sent_count, 0);
  assert.equal(result.claimed_count, 0);
  assert.equal(processed.length, 0);
});

test("handleQueueRunRequest blocks unrestricted cron in scoped_canary_only", async () => {
  const { responses, fn } = makeJsonResponse();
  const run_calls = [];

  await handleQueueRunRequest(
    { url: "https://app.example.com/api/internal/queue/run", json: async () => ({}) },
    "GET",
    {
      requireCronAuth: makeAuth(true),
      getSystemValue: async (key) => {
        if (key === "queue_execution_mode") return QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY;
        return makeLiveQueueSystemValue()(key);
      },
      runSendQueue: async (opts) => {
        run_calls.push(opts);
        return { ok: true, sent_count: 0 };
      },
      jsonResponse: fn,
    }
  );

  assert.equal(run_calls.length, 0);
  assert.equal(responses[0].status, 423);
  assert.equal(responses[0].body.reason, "queue_execution_mode_scoped_canary_only");
  assert.equal(responses[0].body.sent_count, 0);
});

test("feeder-created rows cannot dispatch through unrestricted runner in scoped_canary_only", async () => {
  const feeder_row = buildSupabaseQueueRow(4003, { campaign_id: null });
  const { deps, processed } = makeRunSendQueueDeps({ rows: [feeder_row], now: NOW });
  deps.getSystemValue = async (key) => {
    if (key === "queue_execution_mode") return QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY;
    return makeLiveQueueSystemValue()(key);
  };

  const result = await runSendQueue({ limit: 10, now: NOW }, deps);
  assert.equal(result.sent_count, 0);
  assert.equal(result.claimed_count, 0);
  assert.equal(processed.length, 0);
});

test("requireScopedCanaryExecutionAuth rejects missing secret", async () => {
  const original = process.env.SCOPED_CANARY_EXECUTION_SECRET;
  delete process.env.SCOPED_CANARY_EXECUTION_SECRET;
  delete process.env.QUEUE_ENGINE_SHARED_SECRET;

  const result = await requireScopedCanaryExecutionAuth({
    headers: {
      get() {
        return null;
      },
    },
  });

  if (original) process.env.SCOPED_CANARY_EXECUTION_SECRET = original;
  assert.equal(result.authorized, false);
  assert.ok([401, 500].includes(result.status));
});

test("validateCanaryAuthorizationToken rejects stale authorization", async () => {
  const supabase = {
    from(table) {
      assert.equal(table, "queue_canary_authorizations");
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: {
                    id: "auth-1",
                    canary_run_id: CANARY_RUN,
                    campaign_id: CAMPAIGN_A,
                    queue_row_ids: ["row-1"],
                    authorization_token_hash: crypto
                      .createHash("sha256")
                      .update(AUTH_TOKEN, "utf8")
                      .digest("hex"),
                    expires_at: "2020-01-01T00:00:00.000Z",
                    consumed_at: null,
                  },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  };

  const result = await validateCanaryAuthorizationToken(
    supabase,
    { campaign_id: CAMPAIGN_A, canary_run_id: CANARY_RUN, queue_row_ids: ["row-1"] },
    AUTH_TOKEN
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authorization_expired");
});

test("authorizationMatchesRequest rejects mismatched row ids", () => {
  const result = authorizationMatchesRequest(
    {
      id: "auth-1",
      campaign_id: CAMPAIGN_A,
      canary_run_id: CANARY_RUN,
      queue_row_ids: ["row-1", "row-2"],
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    {
      campaign_id: CAMPAIGN_A,
      canary_run_id: CANARY_RUN,
      queue_row_ids: ["row-1", "row-3"],
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "authorization_row_ids_mismatch");
});

test("scoped validate-only returns exact allowlist and sends zero SMS", async () => {
  const ids = ["row-1", "row-2", "row-3", "row-4", "row-5"];
  const rows = new Map(ids.map((id) => [id, liveRow(id)]));
  const supabase = makeScopedSupabase(rows);

  const result = await runScopedCampaignCanary(
    {
      scoped: true,
      campaign_id: CAMPAIGN_A,
      queue_row_ids: ids,
      max_rows: 5,
      canary_run_id: CANARY_RUN,
      validate_only: true,
    },
    {
      supabase,
      now: NOW,
      authorization_validated: true,
      authorization_id: "auth-1",
      queue_execution_mode: QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY,
      getSystemValue: async (key) => {
        if (key === "queue_emergency_stop_at") return "2026-06-25T18:32:22.386Z";
        if (key === "queue_execution_mode") return QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY;
        return null;
      },
      processSendQueueItem: async () => {
        throw new Error("validate_only_must_not_send");
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.validate_only, true);
  assert.equal(result.sent_count, 0);
  assert.deepEqual(result.candidate_ids, ids);
  assert.equal(result.emergency_stop_active, true);
  assert.equal(supabase.audits.length, 1);
  assert.equal(supabase.audits[0].validate_only, true);
});

test("scoped runner rejects without authorization validation", async () => {
  const result = await runScopedCampaignCanary(
    {
      scoped: true,
      campaign_id: CAMPAIGN_A,
      queue_row_ids: ["row-1"],
      canary_run_id: CANARY_RUN,
      validate_only: true,
    },
    {
      queue_execution_mode: QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY,
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.reason, "authorization_not_validated");
});

test("validateScopedCanaryAllowlist excludes campaign-null, wrong-campaign, and sixth row", () => {
  const nullCampaign = validateScopedCanaryAllowlist([liveRow("row-1", null)], {
    campaign_id: CAMPAIGN_A,
    queue_row_ids: ["row-1"],
    max_rows: 5,
  });
  assert.equal(nullCampaign.reason, "scoped_canary_null_campaign_row");

  const wrongCampaign = validateScopedCanaryAllowlist([liveRow("row-1", CAMPAIGN_B)], {
    campaign_id: CAMPAIGN_A,
    queue_row_ids: ["row-1"],
    max_rows: 5,
  });
  assert.equal(wrongCampaign.reason, "scoped_canary_wrong_campaign_row");

  const tooMany = validateScopedCanaryAllowlist(
    ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"].map((id) => liveRow(id)),
    {
      campaign_id: CAMPAIGN_A,
      queue_row_ids: ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"],
      max_rows: 6,
    }
  );
  assert.equal(tooMany.reason, "queue_row_ids_exceeds_max_rows");
});

test("completed rows cannot resend in scoped allowlist", () => {
  const completed = validateScopedCanaryAllowlist(
    [liveRow("row-1", CAMPAIGN_A, { queue_status: "delivered" })],
    { campaign_id: CAMPAIGN_A, queue_row_ids: ["row-1"], max_rows: 5 }
  );
  assert.equal(completed.reason, "scoped_canary_completed_row_excluded");
});

test("processSendQueueItem bypasses emergency stop only for scoped canary", async () => {
  const row = buildSupabaseQueueRow(4010);
  const getSystemValue = async (key) => {
    if (key === "queue_emergency_stop_at") return "2099-01-01T00:00:00.000Z";
    if (key === "queue_processor_mode") return "off";
    return null;
  };

  const blocked = await processSendQueueItem(row, {
    getSystemValue,
    supabaseClient: {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({ data: row, error: null }),
        };
      },
    },
  });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, "queue_emergency_stop_active");

  const scoped_blocked = await processSendQueueItem(row, {
    scoped_canary: true,
    getSystemValue,
    supabaseClient: {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({ data: row, error: null }),
        };
      },
    },
  });
  assert.notEqual(scoped_blocked.reason, "queue_emergency_stop_active");
});

test("concurrent unrestricted and scoped runs cannot both claim", async () => {
  let lock_owner = "scoped_canary";
  const supabase = {
    rpc(name, params) {
      if (name === "queue_acquire_global_execution_lock") {
        if (lock_owner && lock_owner !== params.p_owner_type) {
          return Promise.resolve({ data: false, error: null });
        }
        lock_owner = params.p_owner_type;
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "queue_release_global_execution_lock") {
        lock_owner = null;
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      return {
        select() {
          return this;
        },
        update() {
          return {
            eq() {
              return {
                lt() {
                  return { select: async () => ({ data: [], error: null }) };
                },
              };
            },
          };
        },
      };
    },
  };

  const row = buildSupabaseQueueRow(4011);
  const { deps } = makeRunSendQueueDeps({ rows: [row], now: NOW });
  deps.getSystemValue = makeLiveQueueSystemValue({ queue_execution_mode: QUEUE_EXECUTION_MODES.NORMAL });
  deps.supabaseClient = supabase;

  const unrestricted = await runSendQueue({ limit: 5, now: NOW }, deps);
  assert.equal(unrestricted.skipped, true);
  assert.equal(unrestricted.sent_count, 0);
  assert.equal(unrestricted.claimed_count, 0);
});