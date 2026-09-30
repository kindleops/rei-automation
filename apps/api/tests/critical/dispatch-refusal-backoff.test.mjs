/**
 * dispatch-refusal-backoff.test.mjs
 *
 * 2026-09-29/30: 166 carrier-filtered retries were due. The ledger refused 50
 * of them on every run (their successor action collided with the one-per-touch
 * index), the processor released each one with its ORIGINAL scheduled_for, and
 * those same 50 rows filled every 50-row claim batch for ~25 hours. The other
 * 116 were never reached. Zero sent.
 *
 * Two fixes, two contracts:
 *   - a refused row backs off (1, 2, 4 ... 60 min), so it cannot hold the head
 *     of the queue;
 *   - the ledger accepts a campaign-touch successor, but ONLY over a settled,
 *     carrier-failed predecessor (migration 20260930160000). The behaviour was
 *     proven on production in a rolled-back statement:
 *     scripts/proof/s11-campaign-touch-successor-proof.sql.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildDispatchRefusalBackoff } from "@/lib/domain/queue/dispatch-refusal-backoff.js";

const NOW = "2026-09-30T14:00:00.000Z";
const minutesAfter = (iso) => (Date.parse(iso) - Date.parse(NOW)) / 60_000;

test("first refusal waits one run; each consecutive refusal doubles, capped at an hour", () => {
  const seen = [];
  let row = { metadata: {} };
  for (let i = 0; i < 9; i += 1) {
    const b = buildDispatchRefusalBackoff(row, NOW);
    seen.push(minutesAfter(b.next_eligible_at));
    row = { metadata: { ...row.metadata, ...b.metadata } };
  }
  assert.deepEqual(seen, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  assert.equal(row.metadata.dispatch_refusal_count, 9);
});

test("the first refusal time is kept; the latest one moves", () => {
  const first = buildDispatchRefusalBackoff({ metadata: {} }, NOW);
  const later = buildDispatchRefusalBackoff({ metadata: first.metadata }, "2026-09-30T15:00:00.000Z");
  assert.equal(first.metadata.dispatch_refusal_first_at, NOW);
  assert.equal(later.metadata.dispatch_refusal_first_at, undefined, "never overwritten");
  assert.equal(later.metadata.dispatch_refusal_last_at, "2026-09-30T15:00:00.000Z");
});

test("garbage counts and clocks cannot produce a past or NaN schedule", () => {
  for (const md of [{ dispatch_refusal_count: "abc" }, { dispatch_refusal_count: -4 }, null, undefined]) {
    const b = buildDispatchRefusalBackoff({ metadata: md }, NOW);
    assert.equal(minutesAfter(b.next_eligible_at), 1);
  }
  const b = buildDispatchRefusalBackoff({ metadata: {} }, "not-a-date");
  assert.ok(Number.isFinite(Date.parse(b.next_eligible_at)));
  assert.ok(Date.parse(b.next_eligible_at) > Date.now());
});

test("the processor's pre-wire refusal path releases WITH the backoff", async () => {
  const src = await readFile(new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf("if (dispatch.provider_invoked === false)"));
  const body = branch.slice(0, branch.indexOf("const send_result"));
  assert.match(body, /buildDispatchRefusalBackoff\(queue_row, now\)/);
  assert.match(body, /releaseSkippedQueueRow\([\s\S]*metadata_patch:\s*\{\s*\.\.\.backoff\.metadata,\s*next_eligible_at: backoff\.next_eligible_at\s*\}/);
});

test("releaseSkippedQueueRow turns next_eligible_at into the row's schedule", async () => {
  const src = await readFile(new URL("../../src/lib/supabase/sms-engine.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function releaseSkippedQueueRow"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /if \(metadata_patch\.next_eligible_at\)[\s\S]*payload\.scheduled_for = metadata_patch\.next_eligible_at/);
});

test("migration: one root per touch, a linear successor chain, and only carrier-failed predecessors", async () => {
  const sql = await readFile(
    new URL("../../../../supabase/migrations/20260930160000_campaign_touch_successor_actions.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_campaign_touch_root[\s\S]*?supersedes_communication_id IS NULL;/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_logical_communications_supersedes_once[\s\S]*?\(supersedes_communication_id\)/);
  assert.match(sql, /DROP INDEX IF EXISTS public\.uq_seller_logical_communications_campaign_touch;/);
  // the relaxed index is created BEFORE the strict one is dropped
  assert.ok(sql.indexOf("campaign_touch_root") < sql.indexOf("DROP INDEX"));
  for (const reason of [
    "campaign_touch_predecessor_delivered",
    "campaign_touch_predecessor_forbids_successor",
    "campaign_touch_predecessor_not_carrier_failed",
    "campaign_touch_predecessor_in_flight",
    "campaign_touch_key_version_mismatch",
    "campaign_touch_supersedes_mismatch",
    "logical_communication_uniqueness_conflict",
  ]) {
    assert.ok(sql.includes(`'${reason}'`), `refusal ${reason} present`);
  }
  // successors are only minted over a provider-accepted predecessor with a failed receipt
  assert.match(sql, /v_tail\.state <> 'provider_accepted' OR v_tail\.delivery_possibility <> 'provider_accepted'/);
  assert.match(sql, /q\.delivery_confirmed = 'failed'/);
  assert.match(sql, /m\.delivery_status = 'failed'/);
  // grants unchanged: service_role only
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.seller_logical_communication_get_or_create[^;]*FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.seller_logical_communication_get_or_create[^;]*TO service_role;/);
});
