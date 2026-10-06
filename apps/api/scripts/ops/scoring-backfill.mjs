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
 *
 * OFFER-READY LAYER (campaign scope — production offer engine, full monetary
 * authority, only the properties of live campaigns; never the 171K backfill):
 *   campaign-count  READ-ONLY: queue-eligible properties per campaign, how many
 *                   are offer-ready today, runtime + DB-growth estimate
 *   campaign-run    LOCAL, WRITES property_acquisition_scores + snapshots for the
 *                   campaign scope through ensurePropertyAcquisitionDecision.
 *                   Same throttle, load probe, backoff and resumable cursor as the
 *                   backfill (own state key). --dry-run computes and writes nothing.
 *   node --env-file=.env.local scripts/ops/scoring-backfill.mjs campaign-count --campaign=cbc2a5d3-b4d4-4297-a168-1ac69e643ee0
 *   node --env-file=.env.local scripts/ops/scoring-backfill.mjs campaign-run --campaign=<uuid>[,<uuid>] [--max=N] [--dry-run] [--ignore-window]
 *   (remote, after deploy) start/status/pause accept --scope=campaign [--campaign=<uuid>,...]
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
const campaignIds = () => String(arg('campaign', '') || '').split(',').map((v) => v.trim()).filter(Boolean);
const scopeBody = () => (arg('scope', null) === 'campaign' ? { scope: { kind: 'campaign', campaign_ids: campaignIds() } } : {});

async function pgClient() {
  const pg = (await import('pg')).default;
  const url = String(process.env.SUPABASE_DB_URL || '').trim();
  if (!url) throw new Error('SUPABASE_DB_URL is required');
  const client = new pg.Client({ connectionString: url, statement_timeout: 30_000, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout='30s'");
  return client;
}

const SNAPSHOT_BYTES_MEASURED = 290_846; // avg acquisition_score_snapshots row, 2026-10-06
const SCORE_ROW_BYTES_MEASURED = 139_208; // avg full-evidence property_acquisition_scores row, 2026-10-06

async function campaignCount() {
  const ids = campaignIds();
  const client = await pgClient();
  try {
    await client.query('SET default_transaction_read_only = on');
    const { rows } = await client.query(`
      with scope as (
        select c.id, c.name, c.status from campaigns c
         where (cardinality($1::uuid[]) > 0 and c.id = any($1::uuid[]))
            or (cardinality($1::uuid[]) = 0 and c.status in ('active','scheduled','built'))
      ), t as (
        select s.id campaign_id, s.name, s.status, ct.property_id::text property_id, ct.target_status
          from scope s join campaign_targets ct on ct.campaign_id = s.id
         where ct.property_id is not null and ct.target_status in ('ready','planned')
      )
      select t.campaign_id::text, t.name, t.status,
             count(distinct t.property_id) eligible_properties,
             count(distinct t.property_id) filter (where p.property_id is not null) scored,
             count(distinct t.property_id) filter (where p.computed_at >= '2026-09-12' and p.computed_at >= now() - interval '30 days'
                                                     and coalesce(p.evidence->'backfill'->>'evidence_mode','') <> 'compact'
                                                     and p.decision_tier in ('AUTO_HARD_OFFER','AUTO_RANGE_OFFER')
                                                     and (p.evidence->'offer_calculation'->>'effective_authorized_ceiling')::numeric > 0
                                                     and p.recommended_cash_offer > 0) offer_ready,
             count(distinct t.property_id) filter (where p.computed_at >= '2026-09-12' and p.computed_at >= now() - interval '30 days'
                                                     and coalesce(p.evidence->'backfill'->>'evidence_mode','') <> 'compact') fresh_monetary
        from t left join property_acquisition_scores p on p.property_id = t.property_id
       group by 1,2,3 order by 4 desc`, [ids]);
    const { rows: [u] } = await client.query(`
      select count(distinct ct.property_id) n from campaign_targets ct join campaigns c on c.id = ct.campaign_id
       where ct.property_id is not null and ct.target_status in ('ready','planned')
         and ((cardinality($1::uuid[]) > 0 and c.id = any($1::uuid[])) or (cardinality($1::uuid[]) = 0 and c.status in ('active','scheduled','built')))`, [ids]);
    const { rows: tiers } = await client.query(`select decision_tier, count(*)::int n from property_acquisition_scores where computed_at >= '2026-09-12' group by 1 order by 2 desc`);
    const toScore = Math.max(0, Number(u.n) - rows.reduce((a, r) => a + Number(r.fresh_monetary), 0));
    const msPerProperty = Number(arg('ms', 6000));
    const { resolveConfig } = await import('../../src/lib/acquisition/scoringBackfill.js');
    const cfg = resolveConfig({});
    const perMinute = Math.min(cfg.max_per_minute, (60_000 / ((msPerProperty * cfg.checkpoint_every) / cfg.concurrency + cfg.sleep_between_chunks_ms)) * cfg.checkpoint_every);
    const authShare = tiers.length ? tiers.filter((t) => /AUTO_(HARD|RANGE)_OFFER/.test(t.decision_tier)).reduce((a, t) => a + t.n, 0) / tiers.reduce((a, t) => a + t.n, 0) : null;
    console.log(JSON.stringify({
      read_only: true,
      campaigns: rows,
      distinct_eligible_properties: Number(u.n),
      need_scoring: toScore,
      assumed_ms_per_property: msPerProperty,
      estimate_minutes_at_default_throttle: Math.round(toScore / perMinute),
      effective_per_minute: Math.round(perMinute * 10) / 10,
      db_growth_mb: Math.round((toScore * (SCORE_ROW_BYTES_MEASURED + SNAPSHOT_BYTES_MEASURED)) / 1e6),
      tier_mix_since_0912: tiers,
      expected_offer_ready_after_scoring: authShare == null ? null : Math.round(Number(u.n) * authShare),
    }, null, 2));
  } finally {
    await client.end();
  }
}

async function campaignRun() {
  const ids = campaignIds();
  if (!ids.length) throw new Error('--campaign=<uuid>[,<uuid>] is required (never the whole universe)');
  const dry = Boolean(arg('dry-run', false));
  const max = arg('max', null) ? Number(arg('max')) : null;
  const { runBackfillTick, applyStart, parseState, CAMPAIGN_SCOPE_STATE_KEY, SCOPE_KINDS } = await import('../../src/lib/acquisition/scoringBackfill.js');
  const { createScoringBackfillStore } = await import('../../src/lib/acquisition/scoringBackfillStore.js');
  const client = await pgClient();
  try {
    let supabase;
    if (dry) {
      // Belt and braces, as in dry-run: the client cannot write even if a path tried.
      const { getDefaultSupabaseClient } = await import('../../src/lib/supabase/default-client.js');
      const real = getDefaultSupabaseClient();
      const READ_RPCS = new Set(['get_comp_candidates_for_subject']);
      supabase = {
        from(table) {
          const builder = real.from(table);
          return new Proxy(builder, {
            get(target, prop) {
              if (['insert', 'update', 'upsert', 'delete'].includes(prop)) return () => { throw new Error(`dry-run write refused: ${String(prop)} ${table}`); };
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
    }
    const base = createScoringBackfillStore({ stateKey: CAMPAIGN_SCOPE_STATE_KEY, ...(supabase ? { supabase } : {}) });
    const store = {
      ...base,
      resolveCampaignIds: base.resolveCampaignIds,
      loadPropertyPage: (p) => base.loadPropertyPage.call(base, p),
      scoreOneMonetary: (id, o) => base.scoreOneMonetary.call(base, id, o),
      // the PROPOSED probe RPC may not be applied: the identical SQL, read-only
      probeLoad: async () => {
        const t0 = Date.now();
        const { rows: [row] } = await client.query(`
          SELECT count(*) FILTER (WHERE a.state='active')::int active_backends,
                 count(*) FILTER (WHERE a.state='active' AND a.backend_type='client backend' AND now()-a.query_start > interval '20 seconds')::int long_running,
                 count(*) FILTER (WHERE a.wait_event_type='Lock')::int lock_waits,
                 count(*)::int total_backends
            FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()`);
        return { ok: true, latency_ms: Date.now() - t0, ...row };
      },
      ...(dry ? { readState: async () => null, writeState: async () => {} } : {}),
    };
    const scope = { kind: SCOPE_KINDS.CAMPAIGN, campaign_ids: ids };
    if (!dry) {
      const started = applyStart(parseState(await store.readState()), { runId: `cli-${Date.now()}`, config: { scope }, resume: !arg('fresh', false) });
      await store.writeState(started);
    }
    const totals = { scored: 0, skipped_existing: 0, failed: 0, transient_failed: 0, ticks: 0, ms: [] };
    const t0 = Date.now();
    while (true) {
      const s = await runBackfillTick({
        store, dryRun: dry, maxProperties: max, ignoreWindow: Boolean(arg('ignore-window', false)),
        configOverrides: { scope },
      });
      totals.ticks += 1;
      for (const k of ['scored', 'skipped_existing', 'failed', 'transient_failed']) totals[k] += s[k] || 0;
      totals.ms.push(...(s.per_property_ms || []));
      console.log(JSON.stringify({ tick: totals.ticks, scored: s.scored, skipped: s.skipped_existing, failed: s.failed, stopped_because: s.stopped_because, gate: s.gate }));
      if (dry || max || ['universe_exhausted', 'status_paused', 'status_stopped', 'status_completed', 'sending_window'].includes(s.stopped_because)) break;
      if (['db_load', 'transient_failures', 'failure_ratio', 'backoff_active'].includes(s.stopped_because)) await new Promise((r) => setTimeout(r, 60_000));
    }
    const sorted = totals.ms.sort((a, b) => a - b);
    console.log(JSON.stringify({ done: true, dry_run: dry, wall_minutes: Math.round((Date.now() - t0) / 6000) / 10, ...totals, ms: sorted.length ? { median: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.floor(sorted.length * 0.9)] } : null }, null, 2));
  } finally {
    await client.end();
  }
}

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
  if (command === 'status') await remote('status', scopeBody());
  else if (command === 'start') {
    const cfg = arg('config', null);
    await remote('start', { config: cfg ? JSON.parse(cfg) : {}, resume: !arg('fresh', false), ...scopeBody() });
  } else if (command === 'pause') await remote('pause', { reason: arg('reason', 'operator_pause'), ...scopeBody() });
  else if (command === 'campaign-count') await campaignCount();
  else if (command === 'campaign-run') await campaignRun();
  else if (command === 'dry-run') await dryRun();
  else {
    console.error('usage: scoring-backfill.mjs <status|start|pause|dry-run|campaign-count|campaign-run> [--n=20] [--config=JSON] [--fresh] [--scope=campaign] [--campaign=<uuid>,...] [--max=N] [--dry-run] [--ignore-window]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
