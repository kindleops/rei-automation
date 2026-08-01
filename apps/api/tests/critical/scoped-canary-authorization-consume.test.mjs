import test from "node:test";
import assert from "node:assert/strict";

import { handleQueueRunRequest } from "@/lib/domain/queue/queue-run-request.js";
import {
  parseScopedCanaryRequest,
  SCOPED_CANARY_MAX_ROWS,
} from "@/lib/domain/queue/run-scoped-campaign-canary.js";

// Regression cover for the scoped-canary authorization deadlock:
// the route used to consume the authorization before dispatch, after which
// queue_atomic_claim_send_row rejected that same authorization
// ("authorization_already_consumed") and no scoped canary could ever send.
// Consumption now belongs to the claim RPC. These tests pin the route side of
// that contract: the route must never write consumed_at itself.

const SECRET = "scoped-canary-consume-regression-secret";
const CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";
const ROW_ID = "4d211395-bc7b-4bfe-8afb-16a329e636a4";
const RUN_ID = "canary-consume-regression";
const TOKEN = "consume-regression-token";
const TOKEN_HASH = "7a6ac18fa625450c6861dace95671c690bc321d619162fc59528debc04dedd99"; // sha256(TOKEN)

function makeAuthorizationRow(overrides = {}) {
  return {
    id: "auth-1",
    canary_run_id: RUN_ID,
    campaign_id: CAMPAIGN,
    queue_row_ids: [ROW_ID],
    authorization_token_hash: TOKEN_HASH,
    consumed_at: null,
    expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Minimal supabase double. Its only job is to answer the authorization lookup
// and to record any attempt by the route to mutate the authorization row.
function makeSupabase(authorization) {
  const update_calls = [];
  const rpc_calls = [];
  return {
    update_calls,
    rpc_calls,
    client: {
      from(table) {
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: async () => ({ data: authorization, error: null }),
          single: async () => ({ data: authorization, error: null }),
          update: (patch) => {
            update_calls.push({ table, patch });
            return chain;
          },
        };
        return chain;
      },
      rpc: async (name, params) => {
        rpc_calls.push({ name, params });
        // Fail the global execution lock so the run stops immediately after the
        // route has done its work. Nothing is claimed and nothing is dispatched.
        return { data: { ok: false, acquired: false, reason: "mock_lock_unavailable" }, error: null };
      },
    },
  };
}

function makeRequest(body) {
  const headers = new Map([
    ["content-type", "application/json"],
    ["x-scoped-canary-secret", SECRET],
    ["x-canary-authorization-token", TOKEN],
  ]);
  return {
    url: "https://api.test/api/internal/queue/run",
    headers: { get: (key) => headers.get(String(key).toLowerCase()) ?? null },
    json: async () => body,
  };
}

function makeDeps(supabase) {
  return {
    supabase,
    jsonResponse: (body, init) => ({ body, status: init?.status ?? 200 }),
    getSystemValue: async (key) => {
      if (key === "queue_execution_mode") return "scoped_canary_only";
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_run_limit") return 50;
      return null;
    },
    requireCronAuth: () => ({
      authorized: true,
      auth: { authenticated: true, is_vercel_cron: false },
      response: null,
    }),
    runSendQueue: async () => ({ ok: true, sent_count: 0 }),
  };
}

function scopedBody(extra = {}) {
  return {
    scoped_canary: true,
    campaign_id: CAMPAIGN,
    canary_run_id: RUN_ID,
    queue_row_ids: [ROW_ID],
    max_rows: 1,
    ...extra,
  };
}

async function runScopedRequest(body, authorization) {
  const previous = process.env.SCOPED_CANARY_EXECUTION_SECRET;
  process.env.SCOPED_CANARY_EXECUTION_SECRET = SECRET;
  const supabase = makeSupabase(authorization);
  try {
    const response = await handleQueueRunRequest(makeRequest(body), "POST", makeDeps(supabase.client));
    return { response, supabase };
  } finally {
    if (previous === undefined) delete process.env.SCOPED_CANARY_EXECUTION_SECRET;
    else process.env.SCOPED_CANARY_EXECUTION_SECRET = previous;
  }
}

function authorizationUpdates(supabase) {
  return supabase.update_calls.filter((call) => call.table === "queue_canary_authorizations");
}

test("validate_only leaves the authorization unconsumed", async () => {
  const authorization = makeAuthorizationRow();
  const { supabase } = await runScopedRequest(scopedBody({ validate_only: true }), authorization);

  assert.deepEqual(authorizationUpdates(supabase), []);
  assert.equal(authorization.consumed_at, null);
});

test("dry_run leaves the authorization unconsumed", async () => {
  const authorization = makeAuthorizationRow();
  const { supabase } = await runScopedRequest(scopedBody({ dry_run: true }), authorization);

  assert.deepEqual(authorizationUpdates(supabase), []);
  assert.equal(authorization.consumed_at, null);
});

test("real execution does not pre-consume the authorization at the route", async () => {
  const authorization = makeAuthorizationRow();
  const { supabase } = await runScopedRequest(scopedBody(), authorization);

  // The defect: the route consumed here, and the claim RPC then rejected its
  // own request. The route must leave consumption to the atomic claim.
  assert.deepEqual(authorizationUpdates(supabase), []);
  assert.equal(authorization.consumed_at, null);
});

test("real execution is not rejected by its own authorization", async () => {
  const authorization = makeAuthorizationRow();
  const { response } = await runScopedRequest(scopedBody(), authorization);

  assert.notEqual(response.body?.error, "authorization_already_consumed");
  assert.notEqual(response.body?.reason, "authorization_already_consumed");
});

test("an already consumed authorization is still rejected at the route", async () => {
  const authorization = makeAuthorizationRow({ consumed_at: "2026-07-31T22:04:29.543Z" });
  const { response, supabase } = await runScopedRequest(scopedBody(), authorization);

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "authorization_already_consumed");
  assert.deepEqual(authorizationUpdates(supabase), []);
});

test("an expired authorization is rejected at the route", async () => {
  const authorization = makeAuthorizationRow({ expires_at: "2020-01-01T00:00:00.000Z" });
  const { response } = await runScopedRequest(scopedBody(), authorization);

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "authorization_expired");
});

test("an authorization for another campaign is rejected at the route", async () => {
  const authorization = makeAuthorizationRow({ campaign_id: "00000000-0000-0000-0000-0000000000ff" });
  const { response } = await runScopedRequest(scopedBody(), authorization);

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "authorization_campaign_mismatch");
});

test("an authorization for another row manifest is rejected at the route", async () => {
  const authorization = makeAuthorizationRow({ queue_row_ids: ["11111111-1111-1111-1111-111111111111"] });
  const { response } = await runScopedRequest(scopedBody(), authorization);

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "authorization_row_ids_mismatch");
});

test("an invalid authorization token is rejected at the route", async () => {
  const authorization = makeAuthorizationRow({ authorization_token_hash: "not-the-right-hash" });
  const { response } = await runScopedRequest(scopedBody(), authorization);

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "authorization_token_invalid");
});

test("max_rows=1 remains enforced for a single-row manifest", () => {
  const parsed = parseScopedCanaryRequest(scopedBody());
  assert.equal(parsed.max_rows, 1);
  assert.deepEqual(parsed.queue_row_ids, [ROW_ID]);
});

test("max_rows cannot be widened past the scoped canary ceiling", () => {
  const parsed = parseScopedCanaryRequest(scopedBody({ max_rows: 500 }));
  assert.ok(parsed.max_rows <= SCOPED_CANARY_MAX_ROWS);
});
