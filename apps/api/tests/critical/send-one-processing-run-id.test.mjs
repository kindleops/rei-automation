import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { atomicClaimSendQueueRow } from "@/lib/domain/queue/queue-atomic-claim.js";

/**
 * Regression cover for the canary #1 failure.
 *
 * queue_atomic_claim_send_row declares p_processing_run_id as UUID. The
 * send_one_queue_row route passed a label — `send-one-${queue_row_id}-${Date.now()}`
 * — which Postgres rejected with "invalid input syntax for type uuid", failing
 * the claim before any provider submission.
 *
 * These tests pin the TYPE CONTRACT at the RPC boundary. A mock that accepts
 * any string would not have caught the original defect, so the double asserts
 * UUID-ness the way Postgres does.
 */

// RFC 4122 shape, matching what Postgres accepts for a uuid parameter.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROW_ID = "a1728dc9-4903-4957-ad8b-6d3d46d86d53";

/**
 * Supabase double whose rpc() enforces the real column types: any non-UUID,
 * non-null p_processing_run_id raises the same error Postgres raises.
 */
function makeTypedRpcClient({ capture } = {}) {
  return {
    async rpc(fn, args) {
      capture?.push({ fn, args });
      for (const key of ["p_queue_row_id", "p_processing_run_id", "p_campaign_id"]) {
        const value = args?.[key];
        if (value === null || value === undefined) continue;
        if (typeof value !== "string" || !UUID_RE.test(value)) {
          const err = new Error(`invalid input syntax for type uuid: "${value}"`);
          err.code = "22P02";
          return { data: null, error: err };
        }
      }
      return {
        data: { ok: true, claimed: true, queue_row_id: args.p_queue_row_id,
                processing_run_id: args.p_processing_run_id },
        error: null,
      };
    },
  };
}

const routeSource = () =>
  fs.readFileSync(
    new URL("../../src/app/api/cockpit/queue/control/route.js", import.meta.url),
    "utf8"
  );

// ── the type contract ─────────────────────────────────────────────────────

test("a UUID processing_run_id is accepted by the claim RPC", async () => {
  const capture = [];
  const supabase = makeTypedRpcClient({ capture });
  const runId = crypto.randomUUID();

  const result = await atomicClaimSendQueueRow({ id: ROW_ID }, {
    supabase, processing_run_id: runId, claim_mode: "normal",
  });

  assert.notEqual(result?.ok, false, "valid UUID must not be rejected");
  assert.equal(capture[0].args.p_processing_run_id, runId);
  assert.match(capture[0].args.p_processing_run_id, UUID_RE);
});

test("the old send-one-${queue_row_id} shape is rejected", async () => {
  // The exact value production sent. atomicClaimSendQueueRow rethrows any RPC
  // error other than "function missing", which is how this surfaced in
  // production as a failed send with no provider submission.
  const legacy = `send-one-${ROW_ID}-${1787021279552}`;
  const supabase = makeTypedRpcClient();

  await assert.rejects(
    () => atomicClaimSendQueueRow({ id: ROW_ID }, {
      supabase, processing_run_id: legacy, claim_mode: "normal",
    }),
    /invalid input syntax for type uuid/i,
    "a label must not be accepted as a uuid"
  );
});

test("the legacy shape does not satisfy the UUID pattern", () => {
  assert.doesNotMatch(`send-one-${ROW_ID}-${Date.now()}`, UUID_RE);
  assert.match(crypto.randomUUID(), UUID_RE);
});

test("omitting the run id sends null, which the RPC defaults server-side", async () => {
  // queue_atomic_claim_send_row does COALESCE(p_processing_run_id, gen_random_uuid()),
  // so null is a legitimate value — it must not be coerced to a string.
  const capture = [];
  const supabase = makeTypedRpcClient({ capture });

  await atomicClaimSendQueueRow({ id: ROW_ID }, { supabase, claim_mode: "normal" });

  assert.equal(capture[0].args.p_processing_run_id, null);
});

test("the claim targets the intended queue row and does not alter its id", async () => {
  const capture = [];
  const supabase = makeTypedRpcClient({ capture });

  const result = await atomicClaimSendQueueRow({ id: ROW_ID }, {
    supabase, processing_run_id: crypto.randomUUID(), claim_mode: "normal",
  });

  assert.equal(capture[0].args.p_queue_row_id, ROW_ID, "claim must address the same row");
  assert.equal(result?.queue_row_id ?? capture[0].args.p_queue_row_id, ROW_ID);
});

test("a failed claim performs zero provider calls", async () => {
  // The original defect failed AT the claim step, so nothing downstream ran.
  // This is the property that kept the failure safe: no SMS reached anyone.
  let providerCalls = 0;
  const supabase = makeTypedRpcClient();

  await assert.rejects(() => atomicClaimSendQueueRow({ id: ROW_ID }, {
    supabase,
    processing_run_id: "send-one-not-a-uuid",
    claim_mode: "normal",
    sendSms: () => { providerCalls += 1; },
  }));

  assert.equal(providerCalls, 0, "no provider submission on a failed claim");
});

// ── the route itself ──────────────────────────────────────────────────────

test("send_one_queue_row no longer builds a label-shaped run id", () => {
  const src = routeSource();

  assert.ok(
    !/processing_run_id:\s*`send-one-\$\{/.test(src),
    "route must not construct a label-shaped processing_run_id"
  );
  assert.ok(
    /processing_run_id:\s*crypto\.randomUUID\(\)/.test(src),
    "route must use the canonical UUID generator"
  );
  assert.ok(
    /^import crypto from ['"]node:crypto['"]/m.test(src),
    "crypto must be imported"
  );
});

test("no queue caller passes a label-shaped processing_run_id", () => {
  // Guards the whole bug class, not just the one site that failed.
  const files = [
    "../../src/app/api/cockpit/queue/control/route.js",
    "../../src/lib/domain/queue/run-send-queue.js",
    "../../src/lib/domain/queue/run-scoped-campaign-canary.js",
    "../../src/lib/domain/queue/queue-atomic-claim.js",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), "utf8");
    const offenders = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .filter((line) => /processing_run_id:\s*[`'"](?!\s*$)[a-z]/i.test(line));
    assert.deepEqual(offenders, [], `${rel} assigns a literal-string processing_run_id`);
  }
});
