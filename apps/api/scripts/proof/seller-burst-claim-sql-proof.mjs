#!/usr/bin/env node
// SQL-level proof for public.claim_seller_inbound_burst against a REAL
// Postgres (never production). Apply
//   supabase/migrations/20260726120000_seller_inbound_bursts.sql
// first, then:
//   SELLER_BURST_PROOF_DB_URL=postgres://... node scripts/proof/seller-burst-claim-sql-proof.mjs
//
// Proves the claim predicate the 3,000-line JS debounce suite mirrors is the
// predicate the DATABASE actually enforces:
//   1. an open burst before eligible_at is not claimable;
//   2. once eligible, N concurrent claimants get exactly one winner
//      (FOR UPDATE SKIP LOCKED) and the claim rotates token/attempt/version;
//   3. a live lease blocks reclaim; an expired lease allows exactly one
//      reclaim with a NEW claim token (old worker fenced by token);
//   4. safety-latched rows flip to suppressed on claim;
//   5. completed bursts are never claimable again;
//   6. one open burst per thread is enforced by the partial unique index.

import pgPkg from "pg";

const { Pool } = pgPkg;

const DB_URL = process.env.SELLER_BURST_PROOF_DB_URL || "";
if (!DB_URL) {
  console.error("SELLER_BURST_PROOF_DB_URL is required (a disposable local Postgres, never production).");
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
assertLocalScratchDb(DB_URL, "SELLER_BURST_PROOF_DB_URL");

const PARALLEL = Number(process.env.SELLER_BURST_PROOF_PARALLEL || 16);
const pool = new Pool({ connectionString: DB_URL, max: PARALLEL + 2 });

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else {
    console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`);
    failures.push(name);
  }
}

const stamp = process.env.SELLER_BURST_PROOF_STAMP || `${process.pid}`;
const thread = (k) => `proof:burst:${stamp}:${k}`;

async function insertBurst({ thread_key, eligible_in_ms = 0, status = "open", safety = false }) {
  const { rows } = await pool.query(
    `INSERT INTO public.seller_inbound_bursts
       (burst_id, thread_key, generation, status, first_received_at, last_received_at,
        eligible_at, hard_close_at, constituent_event_ids, constituent_messages,
        safety_latched, version, attempt_count, policy_version)
     VALUES (gen_random_uuid()::text, $1, 1, $2, now(), now(),
             now() + ($3 || ' milliseconds')::interval, now() + interval '90 seconds',
             '[]'::jsonb, '[]'::jsonb, $4, 1, 0, 'seller_inbound_burst_policy_v1')
     RETURNING burst_id`,
    [thread_key, status, String(eligible_in_ms), safety]
  );
  return rows[0].burst_id;
}

async function claim(thread_key, { lease_ms = 300000 } = {}) {
  const { rows } = await pool.query(
    `SELECT burst_id, status, claim_token, claimed_by, attempt_count, version
       FROM public.claim_seller_inbound_burst($1, NULL, now(), $2, gen_random_uuid()::text, $3)`,
    [thread_key, `worker-${Math.random().toString(16).slice(2, 8)}`, lease_ms]
  );
  return rows[0] || null;
}

try {
  // ── 1. Debounce window respected ─────────────────────────────────────────
  const t1 = thread("debounce");
  await insertBurst({ thread_key: t1, eligible_in_ms: 60_000 });
  const early = await claim(t1);
  check("burst_not_claimable_before_eligible_at", early === null, early);

  // ── 2. Concurrent claim storm: exactly one winner ────────────────────────
  const t2 = thread("storm");
  await insertBurst({ thread_key: t2, eligible_in_ms: 0 });
  const storm = await Promise.all(Array.from({ length: PARALLEL }, () => claim(t2)));
  const winners = storm.filter(Boolean);
  check("exactly_one_concurrent_claim_winner", winners.length === 1, {
    winners: winners.length,
  });
  check(
    "claim_rotates_token_and_attempt",
    winners[0]?.claim_token && winners[0]?.attempt_count === 1 && winners[0]?.version === 2,
    winners[0]
  );

  // ── 3. Live lease blocks reclaim; expired lease allows exactly one ──────
  const blocked = await claim(t2);
  check("live_lease_blocks_reclaim", blocked === null, blocked);
  await pool.query(
    `UPDATE public.seller_inbound_bursts
        SET claimed_at = now() - interval '10 minutes'
      WHERE thread_key = $1`,
    [t2]
  );
  const reclaim_storm = await Promise.all(
    Array.from({ length: PARALLEL }, () => claim(t2, { lease_ms: 300000 }))
  );
  const reclaimers = reclaim_storm.filter(Boolean);
  check("exactly_one_reclaim_after_lease_expiry", reclaimers.length === 1, {
    reclaimers: reclaimers.length,
  });
  check(
    "reclaim_rotates_claim_token",
    reclaimers[0]?.claim_token !== winners[0]?.claim_token &&
      reclaimers[0]?.attempt_count === 2,
    { old: winners[0]?.claim_token, next: reclaimers[0] }
  );

  // ── 4. Safety latch flips claimed row to suppressed ─────────────────────
  const t4 = thread("safety");
  await insertBurst({ thread_key: t4, eligible_in_ms: 0, safety: true });
  const latched = await claim(t4);
  check("safety_latched_claim_flips_suppressed", latched?.status === "suppressed", latched);

  // ── 5. Completed bursts never claimable ──────────────────────────────────
  const t5 = thread("done");
  await insertBurst({ thread_key: t5, eligible_in_ms: 0 });
  await pool.query(
    `UPDATE public.seller_inbound_bursts SET status='completed', completed_at=now() WHERE thread_key=$1`,
    [t5]
  );
  const done = await claim(t5);
  check("completed_burst_not_claimable", done === null, done);

  // ── 6. One open burst per thread (partial unique index) ─────────────────
  const t6 = thread("unique");
  await insertBurst({ thread_key: t6, eligible_in_ms: 0 });
  let dup_error = null;
  try {
    await insertBurst({ thread_key: t6, eligible_in_ms: 0 });
  } catch (error) {
    dup_error = error;
  }
  check("one_open_burst_per_thread_enforced", dup_error?.code === "23505", {
    code: dup_error?.code,
  });
} finally {
  await pool.query(`DELETE FROM public.seller_inbound_bursts WHERE thread_key LIKE $1`, [
    `proof:burst:${stamp}:%`,
  ]);
  await pool.end();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} invariant(s) FAILED`);
  process.exit(1);
}
console.log("\nAll seller-burst claim SQL invariants held.");
