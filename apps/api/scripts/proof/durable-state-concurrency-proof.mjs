#!/usr/bin/env node
// Concurrency proof for the durable run-lock and idempotency-ledger contracts.
//
// Runs against a REAL Postgres (never production). Apply
//   supabase/migrations/20260831000000_durable_run_locks_and_idempotency_ledger.sql
// first, then:
//   DURABLE_STATE_PROOF_DB_URL=postgres://... node scripts/proof/durable-state-concurrency-proof.mjs
//
// Every invariant below is exercised with genuinely parallel connections, not
// mocked functions. Exit code 0 only if every invariant holds.
//
// RUN LOCKS
//   1. N concurrent acquires of one key -> exactly one winner; every loser
//      reports run_lock_active.
//   2. Unrelated keys acquire concurrently without interfering.
//   3. A live (unexpired) lease can never be stolen.
//   4. An expired lease is reclaimable, and by exactly one racer.
//   5. The reclaimed-out zombie cannot heartbeat.
//   6. The reclaimed-out zombie cannot release the new holder's lock.
//   7. The rightful holder can release.
//   8. Crash simulation: holder vanishes, lease expires, next runner proceeds.
//
// IDEMPOTENCY LEDGER
//   9.  N simultaneous claims of one (scope,key) -> exactly one claim winner.
//   10. Distinct keys claim independently.
//   11. A completed event is never reprocessed.
//   12. A stale processing claim is reclaimable (exactly one winner).
//   13. A failed event is reclaimable.
//   14. payload_hash survives a reclaim.
//   15. Retention purge deletes terminal rows only, never an in-flight claim.

import crypto from "node:crypto";
import pgPkg from "pg";

const { Pool } = pgPkg;

const DB_URL = process.env.DURABLE_STATE_PROOF_DB_URL || "";
if (!DB_URL) {
  console.error(
    "DURABLE_STATE_PROOF_DB_URL is required (a disposable local Postgres, never production)."
  );
  process.exit(2);
}

function assertLocalScratchDb(url, envName) {
  // FAIL-CLOSED allowlist: this proof mutates rows, so it may only ever touch a
  // local scratch Postgres. Anything that is not loopback is refused.
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
assertLocalScratchDb(DB_URL, "DURABLE_STATE_PROOF_DB_URL");

const PARALLEL = Number(process.env.DURABLE_STATE_PROOF_PARALLEL || 24);
const pool = new Pool({ connectionString: DB_URL, max: PARALLEL + 4 });

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`);
    failures.push(name);
  }
}

const uuid = () => crypto.randomUUID();

async function acquire(key, token, opts = {}) {
  const { rows } = await pool.query(
    `SELECT public.run_lock_acquire($1,$2,$3,$4,$5) AS r`,
    [key, token, opts.owner ?? null, opts.lease_ms ?? 600000, opts.metadata ?? {}]
  );
  return rows[0].r;
}

async function heartbeat(key, token, lease_ms = null) {
  const { rows } = await pool.query(
    `SELECT public.run_lock_heartbeat($1,$2,$3) AS r`,
    [key, token, lease_ms]
  );
  return rows[0].r;
}

async function release(key, token, outcome = "completed") {
  const { rows } = await pool.query(
    `SELECT public.run_lock_release($1,$2,$3) AS r`,
    [key, token, outcome]
  );
  return rows[0].r;
}

async function expireLock(key) {
  await pool.query(
    `UPDATE public.run_locks SET lease_until = now() - interval '1 second' WHERE lock_key = $1`,
    [key]
  );
}

async function begin(scope, key, token, opts = {}) {
  const { rows } = await pool.query(
    `SELECT public.idempotency_begin($1,$2,$3,$4,$5,$6,$7) AS r`,
    [
      scope,
      key,
      token,
      opts.summary ?? null,
      opts.metadata ?? {},
      opts.lease_ms ?? 600000,
      opts.payload_hash ?? null,
    ]
  );
  return rows[0].r;
}

async function complete(scope, key, summary = "done") {
  const { rows } = await pool.query(
    `SELECT public.idempotency_complete($1,$2,$3) AS r`,
    [scope, key, summary]
  );
  return rows[0].r;
}

async function fail(scope, key, error = "boom") {
  const { rows } = await pool.query(
    `SELECT public.idempotency_fail($1,$2,$3) AS r`,
    [scope, key, error]
  );
  return rows[0].r;
}

async function ageClaim(scope, key, minutes) {
  await pool.query(
    `UPDATE public.idempotency_ledger
        SET started_at = now() - make_interval(mins => $3)
      WHERE scope = $1 AND key = $2`,
    [scope, key, minutes]
  );
}

async function main() {
  const run = Date.now().toString(36);

  // ── 1. N concurrent acquires, one key ─────────────────────────────────────
  {
    const key = `proof-lock-a-${run}`;
    const tokens = Array.from({ length: PARALLEL }, () => uuid());
    const results = await Promise.all(
      tokens.map((t, i) => acquire(key, t, { owner: `racer-${i}` }))
    );
    const winners = results.filter((r) => r.acquired === true);
    const losers = results.filter((r) => r.acquired !== true);

    check("run_lock: exactly one winner among concurrent acquires", winners.length === 1, {
      parallel: PARALLEL,
      winners: winners.length,
    });
    check(
      "run_lock: every loser reports run_lock_active",
      losers.length === PARALLEL - 1 && losers.every((r) => r.reason === "run_lock_active"),
      { losers: losers.length, reasons: [...new Set(losers.map((r) => r.reason))] }
    );

    // ── 3. A live lease cannot be stolen ────────────────────────────────────
    const steal = await acquire(key, uuid(), { owner: "thief" });
    check("run_lock: a live lease cannot be stolen", steal.acquired === false, steal);

    const holderToken = winners[0].lease_token;

    // ── 4. Expired lease is reclaimable by exactly one racer ────────────────
    await expireLock(key);
    const reclaimTokens = Array.from({ length: PARALLEL }, () => uuid());
    const reclaims = await Promise.all(
      reclaimTokens.map((t, i) => acquire(key, t, { owner: `reclaimer-${i}` }))
    );
    const reclaimWinners = reclaims.filter((r) => r.acquired === true);
    check(
      "run_lock: expired lease reclaimed by exactly one racer",
      reclaimWinners.length === 1,
      { winners: reclaimWinners.length }
    );
    check(
      "run_lock: reclaim is reported as stale_lock_reclaimed",
      reclaimWinners[0]?.reason === "stale_lock_reclaimed",
      { reason: reclaimWinners[0]?.reason }
    );

    const newHolderToken = reclaimWinners[0].lease_token;

    // ── 5/6. The zombie is fenced out of heartbeat AND release ──────────────
    const zombieBeat = await heartbeat(key, holderToken);
    check(
      "run_lock: reclaimed-out zombie CANNOT heartbeat",
      zombieBeat.refreshed === false &&
        zombieBeat.reason === "run_lock_lease_token_mismatch",
      zombieBeat
    );

    const zombieRelease = await release(key, holderToken);
    check(
      "run_lock: reclaimed-out zombie CANNOT release the new holder's lock",
      zombieRelease.released === false &&
        zombieRelease.reason === "run_lock_lease_token_mismatch",
      zombieRelease
    );

    // The new holder must still hold it after the zombie's attempts.
    const { rows: still } = await pool.query(
      `SELECT status, lease_token FROM public.run_locks WHERE lock_key = $1`,
      [key]
    );
    check(
      "run_lock: new holder still holds the lock after zombie interference",
      still[0].status === "locked" && still[0].lease_token === newHolderToken,
      still[0]
    );

    // ── 7. The rightful holder can release ──────────────────────────────────
    const goodRelease = await release(key, newHolderToken);
    check(
      "run_lock: rightful holder can release",
      goodRelease.released === true && goodRelease.reason === "run_lock_released",
      goodRelease
    );
  }

  // ── 2. Unrelated keys do not interfere ──────────────────────────────────────
  {
    const keys = Array.from({ length: PARALLEL }, (_, i) => `proof-lock-multi-${run}-${i}`);
    const results = await Promise.all(keys.map((k) => acquire(k, uuid(), { owner: "solo" })));
    check(
      "run_lock: unrelated keys all acquire concurrently",
      results.every((r) => r.acquired === true),
      { acquired: results.filter((r) => r.acquired).length, of: PARALLEL }
    );
  }

  // ── 8. Crash simulation ─────────────────────────────────────────────────────
  {
    const key = `proof-lock-crash-${run}`;
    const crashed = await acquire(key, uuid(), { owner: "runner-that-dies", lease_ms: 600000 });
    check("run_lock: crash sim - first runner holds", crashed.acquired === true, crashed);

    // The process dies. Nothing releases. Only the lease expiry frees it.
    const blockedWhileLeaseLive = await acquire(key, uuid(), { owner: "next-runner" });
    check(
      "run_lock: crash sim - next runner blocked while lease is live",
      blockedWhileLeaseLive.acquired === false,
      blockedWhileLeaseLive
    );

    await expireLock(key);
    const afterExpiry = await acquire(key, uuid(), { owner: "next-runner" });
    check(
      "run_lock: crash sim - next runner proceeds once the lease expires",
      afterExpiry.acquired === true && afterExpiry.reason === "stale_lock_reclaimed",
      afterExpiry
    );
  }

  // ── 9. N simultaneous ledger claims, one key ────────────────────────────────
  {
    const scope = "proof_webhook";
    const key = `evt-${run}-a`;
    const tokens = Array.from({ length: PARALLEL }, () => uuid());
    const results = await Promise.all(
      tokens.map((t) => begin(scope, key, t, { payload_hash: "hash-original" }))
    );
    const winners = results.filter((r) => r.duplicate === false);
    const dupes = results.filter((r) => r.duplicate === true);

    check(
      "ledger: exactly one claim winner among concurrent claims",
      winners.length === 1,
      { parallel: PARALLEL, winners: winners.length }
    );
    check(
      "ledger: winner reports event_claimed",
      winners[0]?.reason === "event_claimed",
      { reason: winners[0]?.reason }
    );
    check(
      "ledger: every duplicate is rejected with event_already_processing",
      dupes.length === PARALLEL - 1 &&
        dupes.every((r) => r.reason === "event_already_processing"),
      { dupes: dupes.length, reasons: [...new Set(dupes.map((r) => r.reason))] }
    );
    check(
      "ledger: exactly one distinct claim_token was issued",
      new Set(winners.map((r) => r.claim_token)).size === 1,
      { tokens: winners.map((r) => r.claim_token) }
    );

    // ── 11. A completed event is never reprocessed ──────────────────────────
    await complete(scope, key);
    const afterComplete = await Promise.all(
      Array.from({ length: PARALLEL }, () => begin(scope, key, uuid()))
    );
    check(
      "ledger: completed event is never reprocessed",
      afterComplete.every(
        (r) => r.duplicate === true && r.reason === "duplicate_event_ignored"
      ),
      { reasons: [...new Set(afterComplete.map((r) => r.reason))] }
    );

    // ── 14. payload_hash survives ───────────────────────────────────────────
    const { rows: hashRows } = await pool.query(
      `SELECT payload_hash FROM public.idempotency_ledger WHERE scope=$1 AND key=$2`,
      [scope, key]
    );
    check(
      "ledger: payload_hash preserved across completion",
      hashRows[0].payload_hash === "hash-original",
      hashRows[0]
    );
  }

  // ── 10. Distinct keys claim independently ───────────────────────────────────
  {
    const scope = "proof_webhook";
    const keys = Array.from({ length: PARALLEL }, (_, i) => `evt-${run}-multi-${i}`);
    const results = await Promise.all(keys.map((k) => begin(scope, k, uuid())));
    check(
      "ledger: distinct keys all claim independently",
      results.every((r) => r.duplicate === false && r.reason === "event_claimed"),
      { claimed: results.filter((r) => !r.duplicate).length, of: PARALLEL }
    );
  }

  // ── 12. Stale processing claim reclaimable by exactly one ───────────────────
  {
    const scope = "proof_webhook";
    const key = `evt-${run}-stale`;
    await begin(scope, key, uuid(), { payload_hash: "hash-stale" });
    await ageClaim(scope, key, 20); // older than the 10-minute default lease

    const racers = await Promise.all(
      Array.from({ length: PARALLEL }, () => begin(scope, key, uuid()))
    );
    const reclaimers = racers.filter((r) => r.duplicate === false);
    check(
      "ledger: stale claim reclaimed by exactly one racer",
      reclaimers.length === 1,
      { winners: reclaimers.length }
    );
    check(
      "ledger: reclaim reported as stale_or_failed_event_reclaimed",
      reclaimers[0]?.reason === "stale_or_failed_event_reclaimed",
      { reason: reclaimers[0]?.reason }
    );

    const { rows } = await pool.query(
      `SELECT attempts, payload_hash FROM public.idempotency_ledger WHERE scope=$1 AND key=$2`,
      [scope, key]
    );
    check("ledger: attempts incremented on reclaim", rows[0].attempts === 2, rows[0]);
    check(
      "ledger: payload_hash preserved across reclaim",
      rows[0].payload_hash === "hash-stale",
      rows[0]
    );
  }

  // ── 13. A failed event is reclaimable ───────────────────────────────────────
  {
    const scope = "proof_webhook";
    const key = `evt-${run}-failed`;
    await begin(scope, key, uuid());
    const failed = await fail(scope, key, "explode");
    check(
      "ledger: fail records the error",
      failed.ok === true && failed.error_message === "explode",
      failed
    );

    const racers = await Promise.all(
      Array.from({ length: PARALLEL }, () => begin(scope, key, uuid()))
    );
    const reclaimers = racers.filter((r) => r.duplicate === false);
    check(
      "ledger: failed event reclaimed by exactly one racer",
      reclaimers.length === 1 &&
        reclaimers[0].reason === "stale_or_failed_event_reclaimed",
      { winners: reclaimers.length, reason: reclaimers[0]?.reason }
    );
  }

  // ── 15. Retention purge: terminal rows only ─────────────────────────────────
  {
    // Run-scoped so a re-run never purges a previous run's rows and skews the count.
    const scope = `proof_retention_${run}`;
    const doneKey = `evt-${run}-retain-done`;
    const liveKey = `evt-${run}-retain-live`;

    await begin(scope, doneKey, uuid());
    await complete(scope, doneKey);
    await begin(scope, liveKey, uuid()); // still processing

    await pool.query(
      `UPDATE public.idempotency_ledger SET retain_until = now() - interval '1 day' WHERE scope=$1`,
      [scope]
    );

    const { rows } = await pool.query(`SELECT public.idempotency_purge_expired($1) AS r`, [1000]);
    const deleted = rows[0].r.deleted_count;

    const { rows: survivors } = await pool.query(
      `SELECT key, status FROM public.idempotency_ledger WHERE scope=$1 ORDER BY key`,
      [scope]
    );

    check("ledger: retention purge deleted the completed row", deleted === 1, { deleted });
    check(
      "ledger: retention purge NEVER deletes an in-flight claim",
      survivors.length === 1 && survivors[0].key === liveKey,
      { survivors }
    );
  }
}

main()
  .then(async () => {
    await pool.end();
    if (failures.length) {
      console.error(`\n${failures.length} INVARIANT(S) FAILED: ${failures.join(", ")}`);
      process.exit(1);
    }
    console.log("\nALL DURABLE-STATE CONCURRENCY INVARIANTS HOLD");
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("PROOF CRASHED:", error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
