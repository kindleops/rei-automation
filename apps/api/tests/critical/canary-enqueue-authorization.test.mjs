import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  ENQUEUE_SCOPE,
  DISPATCH_SCOPE,
  ENQUEUE_AUTH_REASONS,
  enqueueAuthorizationMatchesRequest,
  campaignPermitsCanaryEnqueue,
  recipientIsAllowlisted,
  normalizeRecipient,
  validateCanaryEnqueueAuthorization,
  consumeEnqueueAuthorization,
} from "@/lib/domain/campaigns/canary-enqueue-authorization.js";
import { authorizationMatchesRequest } from "@/lib/domain/queue/queue-canary-authorization.js";

// SCOPED ENQUEUE AUTHORIZATION
//
// campaign_mode is `paused`, closing the global campaign gate. This is the one
// explicit exception: it may create exactly one internal-canary opener for one
// (campaign, target, recipient) triple, and nothing else.
//
// The dangerous shape is scope confusion. A dispatch authorization is matched by
// comparing sorted queue_row_ids lists; an enqueue authorization necessarily has
// queue_row_ids = [], which against an empty requested list would compare EQUAL.
// An empty list must never behave as a wildcard, so scope is resolved before any
// list semantics and each validator rejects the other's scope explicitly.

const CAMPAIGN = "b299ddde-43ea-48b6-ac7b-c7e53688d49e";
const TARGET = "618dc4d9-08e3-42b5-8c21-4d2aa9d586d9";
const RECIPIENT = "+13059807795";
const TOKEN = "canary-token-under-test";
const RUN_ID = "canary_run_enqueue_test";
const ALLOWLIST = "+14045551212,+13059807795,+19995551234";

const hash = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const future = () => new Date(Date.now() + 30 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const CANARY_CAMPAIGN = Object.freeze({
  id: CAMPAIGN,
  status: "draft",
  metadata: { internal_canary: true, do_not_activate: true },
});

const enqueueAuth = (over = {}) => ({
  id: "auth-1",
  canary_run_id: RUN_ID,
  campaign_id: CAMPAIGN,
  queue_row_ids: [],
  authorization_token_hash: hash(TOKEN),
  expires_at: future(),
  consumed_at: null,
  metadata: { scope: ENQUEUE_SCOPE, campaign_target_id: TARGET, recipient: RECIPIENT },
  ...over,
});

const request = (over = {}) => ({
  campaign_id: CAMPAIGN,
  campaign_target_id: TARGET,
  recipient: RECIPIENT,
  ...over,
});

// Minimal supabase double for the async validator/consumer.
function makeSupabase(rows = []) {
  const state = { rows: rows.map((r) => ({ ...r })) };
  return {
    _state: state,
    from() {
      const ctx = { filters: {}, op: "select", patch: null, nullFilters: [] };
      const self = {
        select: () => self,
        update: (p) => { ctx.op = "update"; ctx.patch = p; return self; },
        eq: (c, v) => { ctx.filters[c] = v; return self; },
        is: (c, v) => { ctx.nullFilters.push([c, v]); return self; },
        maybeSingle: () => run(),
        then: (res, rej) => run().then(res, rej),
      };
      async function run() {
        const match = (r) =>
          Object.entries(ctx.filters).every(([k, v]) => r[k] === v) &&
          ctx.nullFilters.every(([k, v]) => (v === null ? r[k] == null : r[k] === v));
        if (ctx.op === "update") {
          const hit = state.rows.find(match);
          if (!hit) return { data: null, error: null };
          Object.assign(hit, ctx.patch);
          return { data: { id: hit.id, consumed_at: hit.consumed_at }, error: null };
        }
        return { data: state.rows.find(match) ?? null, error: null };
      }
      return self;
    },
  };
}

// ── 1. normal enqueue remains blocked while campaign_mode=paused ────────────

test("1. an absent authorization authorizes nothing", async () => {
  const supabase = makeSupabase([]);
  const r = await validateCanaryEnqueueAuthorization(
    supabase,
    { canary_run_id: RUN_ID, ...request(), campaign: CANARY_CAMPAIGN, allowlist_value: ALLOWLIST },
    TOKEN
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, ENQUEUE_AUTH_REASONS.NOT_FOUND);
});

test("1b. a valid authorization without a token authorizes nothing", async () => {
  const supabase = makeSupabase([enqueueAuth()]);
  const r = await validateCanaryEnqueueAuthorization(
    supabase,
    { canary_run_id: RUN_ID, ...request(), campaign: CANARY_CAMPAIGN, allowlist_value: ALLOWLIST },
    ""
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, ENQUEUE_AUTH_REASONS.TOKEN_REQUIRED);
});

test("1c. a wrong token authorizes nothing", async () => {
  const supabase = makeSupabase([enqueueAuth()]);
  const r = await validateCanaryEnqueueAuthorization(
    supabase,
    { canary_run_id: RUN_ID, ...request(), campaign: CANARY_CAMPAIGN, allowlist_value: ALLOWLIST },
    "not-the-token"
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, ENQUEUE_AUTH_REASONS.TOKEN_INVALID);
});

// ── 2-4. exact identity: campaign, target, recipient ───────────────────────

test("2. wrong campaign rejected", () => {
  const v = enqueueAuthorizationMatchesRequest(
    enqueueAuth(),
    request({ campaign_id: "00000000-0000-4000-8000-000000000000" })
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.CAMPAIGN_MISMATCH);
});

test("3. wrong target rejected", () => {
  const v = enqueueAuthorizationMatchesRequest(
    enqueueAuth(),
    request({ campaign_target_id: "11111111-1111-4111-8111-111111111111" })
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.TARGET_MISMATCH);
});

test("4. wrong recipient rejected", () => {
  const v = enqueueAuthorizationMatchesRequest(
    enqueueAuth(),
    request({ recipient: "+16128072000" })
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.RECIPIENT_MISMATCH);
});

test("4b. recipient comparison is normalized, not textual", () => {
  assert.equal(normalizeRecipient("(305) 980-7795"), RECIPIENT);
  assert.equal(normalizeRecipient("3059807795"), RECIPIENT);
  const v = enqueueAuthorizationMatchesRequest(enqueueAuth(), request({ recipient: "(305) 980-7795" }));
  assert.equal(v.ok, true, "same number in another format is the same recipient");
});

test("4c. a missing recipient can never match", () => {
  for (const recipient of ["", null, undefined]) {
    const v = enqueueAuthorizationMatchesRequest(enqueueAuth(), request({ recipient }));
    assert.equal(v.ok, false, `recipient ${String(recipient)} must not match`);
  }
  const blankAuth = enqueueAuth({ metadata: { scope: ENQUEUE_SCOPE, campaign_target_id: TARGET, recipient: "" } });
  assert.equal(enqueueAuthorizationMatchesRequest(blankAuth, request()).ok, false);
});

// ── 5. campaign conditions ─────────────────────────────────────────────────

test("5. non-canary campaign rejected", () => {
  assert.equal(
    campaignPermitsCanaryEnqueue({ status: "draft", metadata: {} }).reason,
    ENQUEUE_AUTH_REASONS.CAMPAIGN_NOT_CANARY
  );
  assert.equal(
    campaignPermitsCanaryEnqueue({ status: "draft", metadata: { internal_canary: true } }).reason,
    ENQUEUE_AUTH_REASONS.CAMPAIGN_ACTIVATABLE
  );
});

test("5b. live campaign rejected even when marked canary", () => {
  for (const status of ["active", "running", "live", "sending", "launched"]) {
    const v = campaignPermitsCanaryEnqueue({
      status,
      metadata: { internal_canary: true, do_not_activate: true },
    });
    assert.equal(v.ok, false, `${status} must be refused`);
    assert.equal(v.reason, ENQUEUE_AUTH_REASONS.CAMPAIGN_LIVE);
  }
  assert.equal(campaignPermitsCanaryEnqueue(CANARY_CAMPAIGN).ok, true);
});

test("5c. non-allowlisted recipient rejected", async () => {
  const supabase = makeSupabase([enqueueAuth()]);
  const r = await validateCanaryEnqueueAuthorization(
    supabase,
    {
      canary_run_id: RUN_ID,
      ...request(),
      campaign: CANARY_CAMPAIGN,
      allowlist_value: "+14045551212,+19995551234",
    },
    TOKEN
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, ENQUEUE_AUTH_REASONS.RECIPIENT_NOT_ALLOWLISTED);
  assert.equal(recipientIsAllowlisted(ALLOWLIST, RECIPIENT), true, "and passes when listed");
});

// ── 6-7. expiry and one-time consumption ───────────────────────────────────

test("6. expired authorization rejected", () => {
  const v = enqueueAuthorizationMatchesRequest(enqueueAuth({ expires_at: past() }), request());
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.EXPIRED);
});

test("6b. an authorization with no expiry is rejected, not treated as eternal", () => {
  for (const expires_at of [null, undefined, "", "not-a-date"]) {
    const v = enqueueAuthorizationMatchesRequest(enqueueAuth({ expires_at }), request());
    assert.equal(v.ok, false);
    assert.equal(v.reason, ENQUEUE_AUTH_REASONS.EXPIRED);
  }
});

test("7. consumed authorization rejected", () => {
  const v = enqueueAuthorizationMatchesRequest(
    enqueueAuth({ consumed_at: new Date().toISOString() }),
    request()
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.CONSUMED);
});

// ── SCOPE CONFUSION + EMPTY-LIST WILDCARD DEFENCE ──────────────────────────

test("SCOPE: enqueue validator rejects a dispatch-scoped authorization", () => {
  const dispatchAuth = enqueueAuth({
    metadata: { scope: DISPATCH_SCOPE, campaign_target_id: TARGET, recipient: RECIPIENT },
    queue_row_ids: ["row-1"],
  });
  const v = enqueueAuthorizationMatchesRequest(dispatchAuth, request());
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.WRONG_SCOPE);
});

test("SCOPE: a legacy authorization with no scope is dispatch, not enqueue", () => {
  const legacy = enqueueAuth({ metadata: { campaign_target_id: TARGET, recipient: RECIPIENT } });
  const v = enqueueAuthorizationMatchesRequest(legacy, request());
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.WRONG_SCOPE);
});

test("SCOPE: dispatch validator rejects an enqueue-scoped authorization", () => {
  const v = authorizationMatchesRequest(enqueueAuth(), {
    campaign_id: CAMPAIGN,
    canary_run_id: RUN_ID,
    queue_row_ids: [],
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "authorization_wrong_scope");
});

test("WILDCARD DEFENCE: empty queue_row_ids never authorizes a dispatch", () => {
  // Without the guard, [] vs [] compares equal and would authorize sending.
  const emptyDispatch = {
    id: "auth-legacy",
    canary_run_id: RUN_ID,
    campaign_id: CAMPAIGN,
    queue_row_ids: [],
    expires_at: future(),
    consumed_at: null,
    metadata: {},
  };
  const v = authorizationMatchesRequest(emptyDispatch, {
    campaign_id: CAMPAIGN,
    canary_run_id: RUN_ID,
    queue_row_ids: [],
  });
  assert.equal(v.ok, false, "an empty authorized list must authorize nothing");
  assert.equal(v.reason, "authorization_no_rows_authorized");
});

test("WILDCARD DEFENCE: enqueue scope requires queue_row_ids to be empty", () => {
  const v = enqueueAuthorizationMatchesRequest(
    enqueueAuth({ queue_row_ids: ["row-1"] }),
    request()
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, ENQUEUE_AUTH_REASONS.ROW_IDS_NOT_EMPTY);
});

// ── 8-10. consumption semantics and crash/replay ───────────────────────────

test("8. a fully valid authorization validates", async () => {
  const supabase = makeSupabase([enqueueAuth()]);
  const r = await validateCanaryEnqueueAuthorization(
    supabase,
    { canary_run_id: RUN_ID, ...request(), campaign: CANARY_CAMPAIGN, allowlist_value: ALLOWLIST },
    TOKEN
  );
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(supabase._state.rows[0].consumed_at, null, "validation alone never consumes");
});

test("9. a real consumption spends the authorization exactly once", async () => {
  const supabase = makeSupabase([enqueueAuth()]);
  const first = await consumeEnqueueAuthorization(supabase, "auth-1");
  assert.equal(first.ok, true);
  assert.equal(first.already_consumed, false);
  assert.ok(supabase._state.rows[0].consumed_at);

  const second = await consumeEnqueueAuthorization(supabase, "auth-1");
  assert.equal(second.ok, true);
  assert.equal(second.already_consumed, true, "second attempt is idempotent, not a new spend");
});

test("10. once consumed, the authorization can never validate again", async () => {
  const supabase = makeSupabase([enqueueAuth()]);
  await consumeEnqueueAuthorization(supabase, "auth-1");
  const r = await validateCanaryEnqueueAuthorization(
    supabase,
    { canary_run_id: RUN_ID, ...request(), campaign: CANARY_CAMPAIGN, allowlist_value: ALLOWLIST },
    TOKEN
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, ENQUEUE_AUTH_REASONS.CONSUMED);
});

test("CRASH/REPLAY: interrupted consumption still ends at one consumed authorization", async () => {
  // Simulate: the queue row was inserted, then the process died before
  // consuming. The authorization is still live.
  const supabase = makeSupabase([enqueueAuth()]);
  assert.equal(supabase._state.rows[0].consumed_at, null, "authorization survived the crash");

  // Replay: the row already exists (deterministic queue_key uniqueness), so the
  // endpoint lands on an already_queued path and settles the authorization
  // there. Consumption is idempotent, so the terminal state is exactly one
  // consumed authorization.
  const recovery = await consumeEnqueueAuthorization(supabase, "auth-1");
  assert.equal(recovery.ok, true);
  assert.equal(recovery.already_consumed, false, "the replay is what finally spends it");

  const again = await consumeEnqueueAuthorization(supabase, "auth-1");
  assert.equal(again.already_consumed, true, "further replays cannot spend it twice");

  const consumedCount = supabase._state.rows.filter((r) => r.consumed_at).length;
  assert.equal(consumedCount, 1, "exactly one consumed authorization");
});
