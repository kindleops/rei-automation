#!/usr/bin/env node
// Concurrency proof for the inbound idempotency claim contract.
//
// Runs against a REAL Postgres (never production): apply
//   supabase/migrations/20260801060000_inbound_processing_ledger.sql
//   supabase/migrations/20260802090000_inbound_claim_contract.sql
// first, then:
//   INBOUND_CLAIM_PROOF_DB_URL=postgres://... node scripts/proof/inbound-claim-concurrency-proof.mjs
//
// Proves, with genuinely parallel connections:
//   1. N concurrent claims for one key → exactly one claimed_new; every loser
//      observes already_processing (no second execution is ever authorized).
//   2. After the winner completes, N concurrent claims → all
//      duplicate_completed carrying the prior disposition; the duplicate
//      audit counter equals the delivery count.
//   3. After lease expiry, N concurrent claims → exactly one retry_claimed.
//   4. The fenced-out zombie (expired lease, old run id) cannot complete.
//   5. Mixed storm: concurrent claims across many distinct keys each get
//      exactly one winner per key.
// Exit code 0 only if every invariant holds.

import { setTimeout as sleep } from "node:timers/promises";
import pgPkg from "pg";

const { Pool } = pgPkg;

const DB_URL = process.env.INBOUND_CLAIM_PROOF_DB_URL || "";
if (!DB_URL) {
  console.error("INBOUND_CLAIM_PROOF_DB_URL is required (a disposable local Postgres, never production).");
  process.exit(2);
}
function assertLocalScratchDb(url, envName) {
  // FAIL-CLOSED allowlist: the proof/simulation may only ever touch a local
  // scratch Postgres. Anything that is not loopback/localhost is refused —
  // a managed host without "supabase.co"/"prod" in its name must not pass.
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error(`${envName} is not a parseable URL.`);
    process.exit(2);
  }
  const allowed = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!allowed.has(host)) {
    console.error(
      `${envName} host "${host}" is not a local scratch database (allowed: localhost/127.0.0.1/::1). Refusing.`
    );
    process.exit(2);
  }
}
assertLocalScratchDb(DB_URL, "INBOUND_CLAIM_PROOF_DB_URL");

const PARALLEL = Number(process.env.INBOUND_CLAIM_PROOF_PARALLEL || 24);
const pool = new Pool({ connectionString: DB_URL, max: PARALLEL + 2 });

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`);
    failures.push(name);
  }
}

async function claim(key, opts = {}) {
  const { rows } = await pool.query(
    `SELECT public.claim_inbound_processing($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS r`,
    [
      key,
      opts.sid ?? null,
      null,
      "+15550100",
      "+15550101",
      "digest",
      6,
      opts.received_at ?? new Date().toISOString(),
      opts.run_id ?? null,
      opts.lease_seconds ?? 600,
      opts.max_attempts ?? 5,
    ]
  );
  return rows[0].r;
}

async function complete(key, runId, disposition) {
  const { rows } = await pool.query(
    `SELECT public.complete_inbound_processing($1,$2,$3) AS r`,
    [key, runId, disposition]
  );
  return rows[0].r;
}

function tally(results, field = "outcome") {
  const counts = {};
  for (const r of results) counts[r[field]] = (counts[r[field]] || 0) + 1;
  return counts;
}

const run_stamp = process.env.INBOUND_CLAIM_PROOF_STAMP || `${process.pid}`;

try {
  // ── 1. Parallel first-delivery storm: exactly one winner ────────────────
  const key1 = `proof:concurrent:${run_stamp}:k1`;
  const storm1 = await Promise.all(
    Array.from({ length: PARALLEL }, () => claim(key1))
  );
  const c1 = tally(storm1);
  check("one_claimed_new_among_parallel_claims", c1.claimed_new === 1, c1);
  check(
    "all_losers_already_processing",
    (c1.already_processing || 0) === PARALLEL - 1,
    c1
  );

  // ── 2. Winner completes; duplicate storm sees prior disposition ─────────
  const winner = storm1.find((r) => r.outcome === "claimed_new");
  const done = await complete(key1, winner.processing_run_id, "no_reply_required");
  check("winner_completes", done.ok === true, done);

  const storm2 = await Promise.all(
    Array.from({ length: PARALLEL }, () => claim(key1))
  );
  const c2 = tally(storm2);
  check("all_duplicates_after_completion", c2.duplicate_completed === PARALLEL, c2);
  check(
    "duplicates_carry_prior_disposition",
    storm2.every((r) => r.prior_disposition === "no_reply_required"),
    storm2[0]
  );
  const { rows: dupRows } = await pool.query(
    `SELECT duplicate_delivery_count FROM public.inbound_processing_ledger WHERE idempotency_key = $1`,
    [key1]
  );
  check(
    "duplicate_audit_counter_matches_delivery_count",
    dupRows[0]?.duplicate_delivery_count === PARALLEL,
    dupRows[0]
  );

  // ── 3. Lease expiry: exactly one reclaim wins ────────────────────────────
  const key3 = `proof:concurrent:${run_stamp}:k3`;
  const first = await claim(key3, { lease_seconds: 30 });
  check("k3_first_claim", first.outcome === "claimed_new", first);
  await pool.query(
    `UPDATE public.inbound_processing_ledger SET lease_expires_at = now() - interval '1 second' WHERE idempotency_key = $1`,
    [key3]
  );
  const storm3 = await Promise.all(
    Array.from({ length: PARALLEL }, () => claim(key3))
  );
  const c3 = tally(storm3);
  check("one_retry_claimed_after_lease_expiry", c3.retry_claimed === 1, c3);
  check(
    "reclaim_losers_already_processing",
    (c3.already_processing || 0) === PARALLEL - 1,
    c3
  );

  // ── 4. Zombie fencing: the expired first holder cannot complete ─────────
  const zombie = await complete(key3, first.processing_run_id, "reply_sent");
  check("zombie_completion_fenced", zombie.ok === false && zombie.reason === "claim_fenced", zombie);
  const reclaimer = storm3.find((r) => r.outcome === "retry_claimed");
  const reclaimDone = await complete(key3, reclaimer.processing_run_id, "human_review_required");
  check("reclaimer_completes", reclaimDone.ok === true, reclaimDone);

  // ── 5. Mixed storm across many keys: one winner per key ─────────────────
  const KEYS = 12;
  const mixed = await Promise.all(
    Array.from({ length: KEYS * 6 }, (_, i) =>
      claim(`proof:concurrent:${run_stamp}:mixed:${i % KEYS}`).then((r) => ({
        key: i % KEYS,
        ...r,
      }))
    )
  );
  const perKey = new Map();
  for (const r of mixed) {
    const list = perKey.get(r.key) || [];
    list.push(r);
    perKey.set(r.key, list);
  }
  const badKeys = [...perKey.entries()].filter(
    ([, list]) => list.filter((r) => r.outcome === "claimed_new").length !== 1
  );
  check("exactly_one_winner_per_key_in_mixed_storm", badKeys.length === 0, badKeys);

  await sleep(10);
} finally {
  await pool.end();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} invariant(s) FAILED`);
  process.exit(1);
}
console.log("\nAll claim-contract concurrency invariants held.");
