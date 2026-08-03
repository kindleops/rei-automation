#!/usr/bin/env node
// Concurrency proof for internal_proof_stamp_queue_row — the atomic
// server-side jsonb merge behind the runbook's stamp-reply step.
//
// Runs against a REAL disposable Postgres (never production):
//   INTERNAL_PROOF_STAMP_PROOF_DB_URL=postgres://... \
//     node scripts/proof/internal-proof-stamp-concurrency-proof.mjs
//
// The script creates a minimal public.send_queue (only the columns the
// function touches) IF it does not already exist, applies the migration, and
// proves:
//   1. A stamp racing an unrelated metadata writer preserves BOTH writes
//      (the jsonb merge cannot clobber concurrent keys — the exact defect
//      the old client-side snapshot write had).
//   2. Wrong expected_status → ok:false, nothing written.
//   3. A disallowed stamp key → stamp_key_not_allowed, nothing written.
//   4. 20 concurrent identical stamps → idempotent merge, campaign set,
//      zero errors, unrelated metadata intact.
//   5. The campaign guard rejects a row already owned by a foreign campaign.
// Exit code 0 only if every invariant holds.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pgPkg from "pg";

const { Pool } = pgPkg;

const DB_URL = process.env.INTERNAL_PROOF_STAMP_PROOF_DB_URL || "";
if (!DB_URL) {
  console.error(
    "INTERNAL_PROOF_STAMP_PROOF_DB_URL is required (a disposable local Postgres, never production)."
  );
  process.exit(2);
}
// FAIL-CLOSED allowlist: only a loopback/localhost scratch Postgres is ever
// acceptable — the proof creates and mutates a public.send_queue table, so a
// managed host that merely lacks "supabase.co"/"prod" in its name must not
// slip through a substring blocklist.
{
  let host;
  try {
    host = new URL(DB_URL).hostname;
  } catch {
    console.error("INTERNAL_PROOF_STAMP_PROOF_DB_URL is not a parseable URL.");
    process.exit(2);
  }
  const allowed = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!allowed.has(host)) {
    console.error(
      `INTERNAL_PROOF_STAMP_PROOF_DB_URL host "${host}" is not a local scratch database (allowed: localhost/127.0.0.1/::1). Refusing.`
    );
    process.exit(2);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  __dirname,
  "../../supabase/migrations/20260802092000_internal_proof_stamp_merge.sql"
);

const CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";
const FOREIGN_CAMPAIGN = "11111111-1111-4111-8111-111111111111";

const pool = new Pool({ connectionString: DB_URL, max: 24 });

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`);
    failures.push(name);
  }
}

async function insertRow({ status = "queued", campaign = null, metadata = {} } = {}) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO public.send_queue (id, queue_status, campaign_id, metadata) VALUES ($1,$2,$3,$4)`,
    [id, status, campaign, JSON.stringify(metadata)]
  );
  return id;
}

async function stamp(rowId, opts = {}) {
  const { rows } = await pool.query(
    `SELECT public.internal_proof_stamp_queue_row($1,$2,$3,$4,$5,$6,$7) AS r`,
    [
      rowId,
      opts.expected_status ?? "queued",
      opts.expected_campaign ?? null,
      opts.campaign ?? CAMPAIGN,
      JSON.stringify(
        opts.stamp ?? {
          internal_canary: true,
          campaign_id_stamped_for_internal_proof: true,
          campaign_stamped_at: "2026-08-02T00:00:00.000Z",
        }
      ),
      opts.session_id ?? "proof-STAMPTEST0000Z",
      opts.run_id ?? `stamp-${crypto.randomUUID()}`,
    ]
  );
  return rows[0].r;
}

async function readRow(rowId) {
  const { rows } = await pool.query(
    `SELECT id, queue_status, campaign_id, metadata FROM public.send_queue WHERE id = $1`,
    [rowId]
  );
  return rows[0] ?? null;
}

try {
  // Minimal shape: only what the function touches. Real prod send_queue has
  // many more columns; the function references none of them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.send_queue (
      id uuid PRIMARY KEY,
      queue_status text NOT NULL DEFAULT 'queued',
      campaign_id uuid,
      to_phone_number text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Roles referenced by the migration's grants may not exist on a scratch DB.
  await pool
    .query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$`)
    .catch(() => {});
  await pool.query(readFileSync(MIGRATION, "utf8"));

  // ── 1. Stamp racing an unrelated metadata writer: both land ─────────────
  const row1 = await insertRow({ metadata: { origin_surface: "canonical_automation" } });
  const [stampResult] = await Promise.all([
    stamp(row1),
    pool.query(
      `UPDATE public.send_queue
          SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"delivery_failure":"transient_timeout"}'::jsonb
        WHERE id = $1`,
      [row1]
    ),
  ]);
  const after1 = await readRow(row1);
  check("racing_stamp_reports_ok", stampResult.ok === true, stampResult);
  check(
    "concurrent_metadata_key_survives_the_stamp",
    after1.metadata.delivery_failure === "transient_timeout",
    after1.metadata
  );
  check(
    "stamp_keys_landed_alongside_concurrent_write",
    after1.metadata.internal_canary === true &&
      after1.metadata.campaign_id_stamped_for_internal_proof === true &&
      after1.metadata.internal_proof_session_id === "proof-STAMPTEST0000Z" &&
      typeof after1.metadata.internal_proof_processing_run_id === "string",
    after1.metadata
  );
  check(
    "original_metadata_key_preserved",
    after1.metadata.origin_surface === "canonical_automation",
    after1.metadata
  );
  check("campaign_stamped", after1.campaign_id === CAMPAIGN, after1);

  // ── 2. Wrong expected_status → refused, nothing written ─────────────────
  const row2 = await insertRow({ status: "sent", metadata: { keep: "me" } });
  const wrongStatus = await stamp(row2, { expected_status: "queued" });
  const after2 = await readRow(row2);
  check(
    "wrong_expected_status_refused",
    wrongStatus.ok === false && wrongStatus.reason === "row_not_in_expected_state",
    wrongStatus
  );
  check(
    "wrong_expected_status_wrote_nothing",
    after2.campaign_id === null &&
      after2.metadata.internal_canary === undefined &&
      after2.metadata.keep === "me",
    after2
  );

  // ── 3. Disallowed stamp key → refused, nothing written ──────────────────
  const row3 = await insertRow({ metadata: { keep: "me" } });
  const badKey = await stamp(row3, {
    stamp: { internal_canary: true, queue_status_override: "sent" },
  });
  const after3 = await readRow(row3);
  check(
    "disallowed_key_refused",
    badKey.ok === false && badKey.reason === "stamp_key_not_allowed",
    badKey
  );
  check(
    "disallowed_key_reported",
    JSON.stringify(badKey.disallowed_keys || []).includes("queue_status_override"),
    badKey
  );
  check(
    "disallowed_key_wrote_nothing",
    after3.campaign_id === null && after3.metadata.internal_canary === undefined,
    after3
  );

  // ── 4. 20 concurrent identical stamps → idempotent, zero errors ─────────
  const row4 = await insertRow({ metadata: { origin_surface: "canonical_automation" } });
  const storm = await Promise.all(
    Array.from({ length: 20 }, () =>
      // Re-stamps observe either NULL or the pinned campaign; both are legal
      // states for an idempotent re-run, so expected_campaign mirrors what a
      // re-reading runbook would pass on a second attempt.
      stamp(row4, { expected_campaign: null }).then(
        (r) => r,
        (e) => ({ thrown: e.message })
      )
    )
  );
  const okCount = storm.filter((r) => r.ok === true).length;
  const refusedCount = storm.filter((r) => r.ok === false).length;
  const thrownCount = storm.filter((r) => r.thrown).length;
  const after4 = await readRow(row4);
  check("concurrent_stamps_no_exceptions", thrownCount === 0, storm.filter((r) => r.thrown));
  check(
    "concurrent_stamps_all_settle_deterministically",
    okCount >= 1 && okCount + refusedCount === 20,
    { okCount, refusedCount }
  );
  check(
    "concurrent_stamps_idempotent_result",
    after4.campaign_id === CAMPAIGN &&
      after4.metadata.internal_canary === true &&
      after4.metadata.origin_surface === "canonical_automation",
    after4
  );

  // ── 5. Foreign campaign row → refused ────────────────────────────────────
  const row5 = await insertRow({ campaign: FOREIGN_CAMPAIGN });
  const foreign = await stamp(row5, { expected_campaign: null });
  const after5 = await readRow(row5);
  check(
    "foreign_campaign_refused",
    foreign.ok === false && foreign.reason === "row_not_in_expected_state",
    foreign
  );
  check(
    "foreign_campaign_untouched",
    after5.campaign_id === FOREIGN_CAMPAIGN && after5.metadata.internal_canary === undefined,
    after5
  );
} finally {
  await pool.end();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} invariant(s) FAILED`);
  process.exit(1);
}
console.log("\nAll internal-proof stamp-merge concurrency invariants held.");
