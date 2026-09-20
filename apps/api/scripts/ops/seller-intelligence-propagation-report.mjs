#!/usr/bin/env node
/**
 * SELLER INTELLIGENCE PROPAGATION REPORT — read-only (§24).
 *
 * Answers one question: which `seller.property` rows do not have the downstream
 * Seller Intelligence projections they are owed, and why. Nothing here writes,
 * enqueues, sends, or refreshes anything; it opens a read-only transaction and
 * runs SELECTs.
 *
 * It exists because the failure it detects was invisible for three weeks. On
 * 2026-08-31 six DealMachine contact exports added 6,808 properties that never
 * propagated, and no surface in the product could have told anyone.
 *
 *   node scripts/ops/seller-intelligence-propagation-report.mjs [--group-by state|county_name] [--limit N]
 *
 * Requires SUPABASE_DB_URL (PostgREST does not expose the `seller` schema).
 */
import pg from 'pg';
import {
  buildCatchUpSql,
  buildPropagationReport,
  selectCatchUpWork,
  PROPAGATION_BLOCKED_NO_CANONICAL_ENGINE,
} from '../../src/lib/domain/seller-intelligence/propagation-status.js';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')
    ? process.argv[idx + 1]
    : fallback;
};

const GROUPABLE = new Set(['state', 'county_name']);

async function main() {
  const url = String(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.error('SUPABASE_DB_URL is required (the seller schema is not exposed over PostgREST).');
    process.exit(2);
  }

  const groupBy = arg('group-by');
  if (groupBy && !GROUPABLE.has(groupBy)) {
    console.error(`--group-by must be one of: ${[...GROUPABLE].join(', ')}`);
    process.exit(2);
  }
  const limit = Number(arg('limit', '250000'));

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Read-only by construction, not by convention: the transaction itself
    // refuses a write even if this script were later edited carelessly.
    await client.query('begin transaction read only');
    const { rows } = await client.query(buildCatchUpSql({ limit }));
    await client.query('commit');

    const report = buildPropagationReport(rows, { groupBy });
    const work = selectCatchUpWork(rows);

    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      ...report,
      catch_up: {
        ready: work.ready.length,
        blocked: work.blocked.length,
        // Stated explicitly so nobody reads a non-zero `ready` as "just run the
        // job": the job does not exist in this repository.
        runner_available: false,
        runner_blocked_reason: PROPAGATION_BLOCKED_NO_CANONICAL_ENGINE,
      },
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
