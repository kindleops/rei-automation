#!/usr/bin/env node
/**
 * Canonical scoring backfill — operator CLI.
 *
 *   status    read state via the production route (read-only)
 *   start     action=start  (resumes from the saved cursor unless --fresh)
 *   pause     action=pause
 *   dry-run   LOCAL: runs the real engine on a small sample against prod
 *             READ paths, computes rows, writes NOTHING (no score, no
 *             snapshot, no state). Measures ms/property, compact row bytes,
 *             and estimates total runtime.
 *
 * Remote commands need INTERNAL_API_BASE_URL (default https://ops.leadcommand.ai)
 * and INTERNAL_API_SECRET in the environment.
 *
 *   cd apps/api
 *   node --env-file=.env.local scripts/ops/scoring-backfill.mjs dry-run --n=20
 *   node --env-file=.env.local scripts/ops/scoring-backfill.mjs status
 *   node --env-file=.env.local scripts/ops/scoring-backfill.mjs start [--config='{"max_per_minute":60}'] [--fresh]
 *   node --env-file=.env.local scripts/ops/scoring-backfill.mjs pause
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./tests/alias-loader.mjs', pathToFileURL('./'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : fallback;
};

const command = process.argv[2];

async function remote(action, extra = {}) {
  const base = String(process.env.INTERNAL_API_BASE_URL || 'https://ops.leadcommand.ai').replace(/\/$/, '');
  const secret = String(process.env.INTERNAL_API_SECRET || '').trim();
  if (!secret) throw new Error('INTERNAL_API_SECRET is required for remote commands');
  const res = await fetch(`${base}/api/internal/acquisition/scoring-backfill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-api-secret': secret },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(JSON.stringify({ http: res.status, ...body }, null, 2));
}

async function dryRun() {
  const n = Math.min(50, Math.max(1, Number(arg('n', 20)) || 20));
  const pg = (await import('pg')).default;
  const url = String(process.env.SUPABASE_DB_URL || '').trim();
  if (!url) throw new Error('SUPABASE_DB_URL is required for the dry-run sample + load probe');
  const client = new pg.Client({ connectionString: url, statement_timeout: 30_000 });
  await client.connect();
  try {
    await client.query("SET statement_timeout='30s'");
    await client.query('SET default_transaction_read_only = on');
    const { rows: [{ universe }] } = await client.query("select reltuples::bigint as universe from pg_class where relname='properties'");
    // Spread sample: random blocks, so it is not N neighbours by property_id.
    const { rows: sample } = await client.query(
      'select property_id from properties tablesample system (0.2) where property_id is not null limit $1', [n],
    );
    const ids = sample.map((r) => String(r.property_id));

    const { runBackfillTick, estimateRuntime, resolveConfig } = await import('../../src/lib/acquisition/scoringBackfill.js');
    const { createScoringBackfillStore } = await import('../../src/lib/acquisition/scoringBackfillStore.js');
    const { getDefaultSupabaseClient } = await import('../../src/lib/supabase/default-client.js');
    const real = getDefaultSupabaseClient();
    // Belt and braces: the dry-run client cannot write even if a code path tried.
    const READ_RPCS = new Set(['get_comp_candidates_for_subject']);
    const readOnly = {
      from(table) {
        const builder = real.from(table);
        return new Proxy(builder, {
          get(target, prop) {
            if (['insert', 'update', 'upsert', 'delete'].includes(prop)) {
              return () => { throw new Error(`dry-run write refused: ${String(prop)} ${table}`); };
            }
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
      rpc(name, params) {
        if (!READ_RPCS.has(name)) throw new Error(`dry-run rpc refused: ${name}`);
        return real.rpc(name, params);
      },
    };
    const base = createScoringBackfillStore({ supabase: readOnly });
    let served = false;
    const probeSamples = [];
    const store = {
      ...base,
      readState: async () => null,
      writeState: async () => { throw new Error('dry-run must not write state'); },
      loadPropertyPage: async () => { if (served) return []; served = true; return ids; },
      // The PROPOSED RPC is not applied yet; run the identical SQL read-only.
      probeLoad: async () => {
        const t0 = Date.now();
        const { rows: [row] } = await client.query(`
          SELECT count(*) FILTER (WHERE a.state='active')::int active_backends,
                 count(*) FILTER (WHERE a.state='active' AND a.backend_type='client backend' AND now()-a.query_start > interval '20 seconds')::int long_running,
                 count(*) FILTER (WHERE a.wait_event_type='Lock')::int lock_waits,
                 count(*)::int total_backends
            FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()`);
        const out = { ok: true, latency_ms: Date.now() - t0, ...row };
        probeSamples.push(out);
        return out;
      },
    };
    const t0 = Date.now();
    const summary = await runBackfillTick({ store, dryRun: true, maxProperties: n, configOverrides: { checkpoint_every: Math.min(10, n) } });
    const wallMs = Date.now() - t0;
    const config = resolveConfig({});
    const bytes = [...summary.row_bytes].sort((a, b) => a - b);
    const est = estimateRuntime({ perPropertyMs: summary.per_property_ms, universe: Number(universe), config });
    console.log(JSON.stringify({
      dry_run: true,
      writes: 'none',
      sample_size: ids.length,
      scored: summary.scored,
      skipped_existing: summary.skipped_existing,
      failed: summary.failed,
      transient_failed: summary.transient_failed,
      failures: summary.failed + summary.transient_failed ? '(see recent errors below)' : null,
      wall_ms: wallMs,
      sample_wall_ms_per_property_at_concurrency_2: Math.round(wallMs / Math.max(1, ids.length)),
      compact_row_bytes: bytes.length ? { median: bytes[Math.floor(bytes.length / 2)], max: bytes[bytes.length - 1] } : null,
      projected_storage_gb_uncompressed_json: bytes.length ? Math.round((bytes.reduce((a, b) => a + b, 0) / bytes.length) * Number(universe) / 1e8) / 10 : null,
      load_probe: probeSamples.at(-1) ?? null,
      universe: Number(universe),
      default_config: { checkpoint_every: config.checkpoint_every, concurrency: config.concurrency, sleep_between_chunks_ms: config.sleep_between_chunks_ms, max_per_minute: config.max_per_minute, tick_budget_ms: config.tick_budget_ms },
      estimate: est,
      stopped_because: summary.stopped_because,
    }, null, 2));
  } finally {
    await client.end();
  }
}

try {
  if (command === 'status') await remote('status');
  else if (command === 'start') {
    const cfg = arg('config', null);
    await remote('start', { config: cfg ? JSON.parse(cfg) : {}, resume: !arg('fresh', false) });
  } else if (command === 'pause') await remote('pause', { reason: arg('reason', 'operator_pause') });
  else if (command === 'dry-run') await dryRun();
  else {
    console.error('usage: scoring-backfill.mjs <status|start|pause|dry-run> [--n=20] [--config=JSON] [--fresh]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
