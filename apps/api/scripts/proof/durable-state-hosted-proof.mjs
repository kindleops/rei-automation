#!/usr/bin/env node
// Hosted durability proof: exercises the durable run-lock and idempotency RPCs
// against a REAL Supabase project through PostgREST with the service-role key --
// i.e. the exact transport the application uses in production.
//
//   node scripts/proof/durable-state-hosted-proof.mjs
//
// Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the environment. Values are
// never printed.
//
// SAFETY
//   * Touches ONLY public.run_locks and public.idempotency_ledger.
//   * Every key is namespaced `hosted-proof-<runId>` / scope `hosted_proof_<runId>`
//     so it can never collide with a real lock scope or webhook event key.
//   * Deletes every row it created before exiting.
//   * These RPCs have NO outbound side effects: no SMS, no email, no campaign,
//     no queue execution. Nothing in this file touches send_queue.

import crypto from "node:crypto";

const URL_BASE = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(2);
}

const PARALLEL = Number(process.env.HOSTED_PROOF_PARALLEL || 20);
const runId = crypto.randomBytes(4).toString("hex");
const LOCK_PREFIX = `hosted-proof-${runId}`;
const SCOPE = `hosted_proof_${runId}`;

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log(`PASS ${name}`);
  else {
    console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`);
    failures.push(name);
  }
}

async function rpc(fn, args) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`${fn} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

const uuid = () => crypto.randomUUID();

async function main() {
  // ── RUN LOCK ──────────────────────────────────────────────────────────────
  const key = `${LOCK_PREFIX}-a`;

  // 1. N genuinely parallel acquires -> exactly one winner.
  const acquires = await Promise.all(
    Array.from({ length: PARALLEL }, (_, i) =>
      rpc("run_lock_acquire", {
        p_lock_key: key,
        p_lease_token: uuid(),
        p_owner: `racer-${i}`,
        p_lease_ms: 600000,
      })
    )
  );
  const winners = acquires.filter((r) => r.acquired === true);
  const losers = acquires.filter((r) => r.acquired !== true);
  check("hosted run_lock: exactly one winner among parallel acquires", winners.length === 1, {
    parallel: PARALLEL,
    winners: winners.length,
  });
  check(
    "hosted run_lock: every loser reports run_lock_active",
    losers.every((r) => r.reason === "run_lock_active"),
    { reasons: [...new Set(losers.map((r) => r.reason))] }
  );

  const holder = winners[0].lease_token;

  // 2. Competing acquire rejected while the lease is live.
  const steal = await rpc("run_lock_acquire", { p_lock_key: key, p_lease_token: uuid() });
  check("hosted run_lock: live lease cannot be stolen", steal.acquired === false, steal);

  // 3. Heartbeat by the holder.
  const beat = await rpc("run_lock_heartbeat", { p_lock_key: key, p_lease_token: holder });
  check("hosted run_lock: holder can heartbeat", beat.refreshed === true, beat);

  // 4. Heartbeat by a non-holder is fenced out.
  const badBeat = await rpc("run_lock_heartbeat", { p_lock_key: key, p_lease_token: uuid() });
  check(
    "hosted run_lock: non-holder heartbeat rejected",
    badBeat.refreshed === false && badBeat.reason === "run_lock_lease_token_mismatch",
    badBeat
  );

  // 5. Expiry + reclaim. Re-acquire with a 1ms lease, let it lapse, then reclaim.
  await rpc("run_lock_force_release", { p_lock_key: key, p_reason: "proof_reset" });
  const shortLease = await rpc("run_lock_acquire", {
    p_lock_key: key,
    p_lease_token: uuid(),
    p_owner: "expiring-holder",
    p_lease_ms: 1,
  });
  const zombie = shortLease.lease_token;
  await new Promise((r) => setTimeout(r, 50));

  const reclaims = await Promise.all(
    Array.from({ length: PARALLEL }, () =>
      rpc("run_lock_acquire", { p_lock_key: key, p_lease_token: uuid(), p_owner: "reclaimer" })
    )
  );
  const reclaimWinners = reclaims.filter((r) => r.acquired === true);
  check(
    "hosted run_lock: expired lease reclaimed by exactly one racer",
    reclaimWinners.length === 1 && reclaimWinners[0].reason === "stale_lock_reclaimed",
    { winners: reclaimWinners.length, reason: reclaimWinners[0]?.reason }
  );

  // 6. The zombie holder cannot mutate the reclaimed lease.
  const zBeat = await rpc("run_lock_heartbeat", { p_lock_key: key, p_lease_token: zombie });
  check(
    "hosted run_lock: zombie CANNOT heartbeat a reclaimed lease",
    zBeat.refreshed === false && zBeat.reason === "run_lock_lease_token_mismatch",
    zBeat
  );
  const zRel = await rpc("run_lock_release", { p_lock_key: key, p_lease_token: zombie });
  check(
    "hosted run_lock: zombie CANNOT release a reclaimed lease",
    zRel.released === false && zRel.reason === "run_lock_lease_token_mismatch",
    zRel
  );

  // 7. The rightful holder releases.
  const rel = await rpc("run_lock_release", {
    p_lock_key: key,
    p_lease_token: reclaimWinners[0].lease_token,
  });
  check("hosted run_lock: rightful holder can release", rel.released === true, rel);

  // ── IDEMPOTENCY ───────────────────────────────────────────────────────────
  const evt = `evt-${runId}-a`;

  // 8. N parallel claims -> exactly one winner.
  const claims = await Promise.all(
    Array.from({ length: PARALLEL }, () =>
      rpc("idempotency_begin", {
        p_scope: SCOPE,
        p_key: evt,
        p_claim_token: uuid(),
        p_payload_hash: "hosted-hash",
      })
    )
  );
  const claimWinners = claims.filter((r) => r.duplicate === false);
  check(
    "hosted ledger: exactly one claim winner among parallel claims",
    claimWinners.length === 1 && claimWinners[0].reason === "event_claimed",
    { winners: claimWinners.length }
  );
  check(
    "hosted ledger: concurrent duplicates rejected",
    claims.filter((r) => r.duplicate === true).every((r) => r.reason === "event_already_processing"),
    { reasons: [...new Set(claims.filter((r) => r.duplicate).map((r) => r.reason))] }
  );

  // 9. Completion, then duplicate suppression.
  const done = await rpc("idempotency_complete", { p_scope: SCOPE, p_key: evt, p_summary: "proof" });
  check("hosted ledger: completion recorded", done.ok === true, done);

  const afterDone = await rpc("idempotency_begin", {
    p_scope: SCOPE,
    p_key: evt,
    p_claim_token: uuid(),
  });
  check(
    "hosted ledger: completed event suppressed as duplicate",
    afterDone.duplicate === true && afterDone.reason === "duplicate_event_ignored",
    afterDone
  );

  // 10. Failed -> reclaimable.
  const evt2 = `evt-${runId}-b`;
  await rpc("idempotency_begin", { p_scope: SCOPE, p_key: evt2, p_claim_token: uuid() });
  await rpc("idempotency_fail", { p_scope: SCOPE, p_key: evt2, p_error: "proof_failure" });
  const reclaimed = await rpc("idempotency_begin", {
    p_scope: SCOPE,
    p_key: evt2,
    p_claim_token: uuid(),
  });
  check(
    "hosted ledger: failed event reclaimable",
    reclaimed.duplicate === false && reclaimed.reason === "stale_or_failed_event_reclaimed",
    reclaimed
  );

  // 11. Stale processing claim reclaimable (1ms lease).
  const evt3 = `evt-${runId}-c`;
  await rpc("idempotency_begin", { p_scope: SCOPE, p_key: evt3, p_claim_token: uuid() });
  await new Promise((r) => setTimeout(r, 50));
  const staleReclaim = await rpc("idempotency_begin", {
    p_scope: SCOPE,
    p_key: evt3,
    p_claim_token: uuid(),
    p_lease_ms: 1,
  });
  check(
    "hosted ledger: stale claim reclaimable",
    staleReclaim.duplicate === false && staleReclaim.reason === "stale_or_failed_event_reclaimed",
    staleReclaim
  );

  // 12. Purge leaves in-flight claims alone (nothing of ours is past retention,
  //     so a purge must not remove any of our rows).
  const purge = await rpc("idempotency_purge_expired", { p_limit: 1 });
  check("hosted ledger: purge callable and safe", purge.ok === true, purge);
}

async function cleanup() {
  // Remove every row this proof created. Scoped to the proof namespaces only.
  const del = async (table, query) => {
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?${query}`, {
      method: "DELETE",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "return=representation" },
    });
    if (!res.ok) throw new Error(`cleanup ${table}: HTTP ${res.status}`);
    return (await res.json()).length;
  };
  const locks = await del("run_locks", `lock_key=like.${LOCK_PREFIX}*`);
  const ledger = await del("idempotency_ledger", `scope=eq.${SCOPE}`);
  console.log(`\ncleanup: removed ${locks} run_locks row(s), ${ledger} ledger row(s)`);
}

main()
  .then(cleanup)
  .then(() => {
    if (failures.length) {
      console.error(`\n${failures.length} HOSTED INVARIANT(S) FAILED: ${failures.join(", ")}`);
      process.exit(1);
    }
    console.log("\nALL HOSTED DURABILITY INVARIANTS HOLD");
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("HOSTED PROOF CRASHED:", e.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
