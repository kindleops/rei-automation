#!/usr/bin/env node
/**
 * Seller Situation v2 (raw_facts_v1) nationwide scoring — operator CLI.
 * Owner commands are in the job RUNBOOK (acq-os/A1/RUNBOOK.md). Direct pg (SUPABASE_DB_URL).
 *
 * READ-ONLY (safe any time outside heavy-send windows):
 *   plan      active markets, phase sizes, table presence, saved state
 *   dry-run   score a sample, write NOTHING (read-only session + write-refusing store):
 *             --n=500 --sample=active-targets|phases  [--json=<out.json>] [--ignore-load (read-only measurement only; gate verdicts are recorded)]
 *   status    saved run state
 *
 * WRITES (owner only; need the PROPOSED migration applied, SELLER_SITUATION_BACKFILL_ENABLED=true and --confirm):
 *   start     [--fresh] [--config='{"batch_size":200}']   set state=running (resumes the cursor unless --fresh)
 *   run       [--max-minutes=360]                         run ticks locally until gate / window / done
 *   pause                                                state=paused (the next chunk stops)
 *
 *   cd apps/api
 *   SUPABASE_DB_URL=... node scripts/ops/seller-situation-backfill.mjs plan
 *   SUPABASE_DB_URL=... node scripts/ops/seller-situation-backfill.mjs dry-run --n=500 --sample=active-targets
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

register('./tests/alias-loader.mjs', pathToFileURL('./'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : fallback;
};
const command = process.argv[2];

const B = await import('../../src/lib/acquisition/seller-situation/backfill.js');
const { createSellerSituationStore } = await import('../../src/lib/acquisition/seller-situation/backfillStore.js');
const { encodeSellerSituationRow, scoreSellerSituation } = await import('../../src/lib/acquisition/seller-situation/index.js');

async function pgClient() {
  const pg = (await import('pg')).default;
  const url = String(process.env.SUPABASE_DB_URL || '').trim();
  if (!url) throw new Error('SUPABASE_DB_URL is required');
  const client = new pg.Client({ connectionString: url, statement_timeout: 30_000, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

function requireOwnerWrite() {
  if (String(process.env.SELLER_SITUATION_BACKFILL_ENABLED || '').trim().toLowerCase() !== 'true') {
    throw new Error('refused: SELLER_SITUATION_BACKFILL_ENABLED must be "true" for a writing command');
  }
  if (!arg('confirm')) throw new Error('refused: writing commands need --confirm');
}

const client = await pgClient();
try {
  if (command === 'plan' || command === 'status') {
    const store = createSellerSituationStore({ client, writes: false });
    const state = B.parseState(await store.readState());
    if (command === 'status') {
      console.log(JSON.stringify({ state, table_exists: await store.hasScoreTable(), table_bytes: await store.tableBytes() }, null, 2));
    } else {
      const markets = await store.loadActiveMarkets();
      const phases = state.phases ?? B.buildPhases(markets);
      const sizes = [];
      for (const p of phases) {
        const r = p.kind === 'market'
          ? await client.query('select count(*)::int n from public.properties where market = $1 and property_id is not null', [p.market])
          : await client.query('select count(*)::int n from public.properties where property_id is not null and (market is null or market <> all($1::text[]))', [p.exclude_markets]);
        sizes.push({ phase: p.market ?? 'nationwide', properties: r.rows[0].n });
      }
      const total = sizes.reduce((a, s) => a + s.properties, 0);
      console.log(JSON.stringify({ run_version: B.RUN_VERSION, live_campaign_markets: markets, phases: sizes, total, table_exists: await store.hasScoreTable(), state_status: state.status }, null, 2));
    }
  } else if (command === 'dry-run') {
    const store = createSellerSituationStore({ client, writes: false }); // read-only session; every write throws
    const n = Number(arg('n', 500));
    let dryRunPhases = null;
    if (arg('sample', 'active-targets') === 'active-targets') {
      const r = await client.query(`select distinct t.property_id from public.campaign_targets t
        where t.campaign_id in (select id from public.campaigns where status in ('active','scheduled')) and t.property_id is not null`);
      // Deterministic spread sample across the live targets (hash order), not the first N by id.
      const ids = r.rows.map((x) => x.property_id)
        .map((id) => [crypto.createHash('md5').update(id).digest('hex'), id]).sort().slice(0, n).map(([, id]) => id);
      dryRunPhases = [{ kind: 'ids', ids }];
    }
    const t0 = Date.now();
    const summary = await B.runTick({ store, dryRun: true, maxProperties: n, dryRunPhases, ignoreLoadInDryRun: Boolean(arg('ignore-load')), configOverrides: { tick_budget_ms: 3_600_000, max_per_minute: 20_000 } });
    const wall = Date.now() - t0;
    // Validate the exact upsert decode path read-only on the sampled rows.
    const sampleIds = dryRunPhases?.[0]?.ids?.slice(0, 200) ?? [];
    let recordset = null;
    if (sampleIds.length) {
      const facts = await store.loadRawFacts(sampleIds);
      const rows = [...facts.values()].map((rf) => encodeSellerSituationRow(scoreSellerSituation(rf), { featuresAsOf: rf.facts.as_of_date ? String(rf.facts.as_of_date).slice(0, 10) : null }));
      recordset = await store.validateRecordset(rows);
    }
    const universe = (await client.query('select count(*)::int n from public.properties where property_id is not null')).rows[0].n;
    const avgWrite = 400; // ms per 200-row upsert (estimate; measured on the first live chunk via state.last_tick)
    const estimate = B.estimateNationwide({ msPerProperty: summary.metrics.ms_per_property, rowBytesMean: summary.metrics.row_bytes.mean, universe, writeMsPerChunk: avgWrite });
    const out = { ...summary, wall_ms: wall, recordset_validation: recordset, nationwide_estimate: estimate };
    if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ ...out, sample_rows: out.sample_rows.slice(0, 1) }, null, 2));
  } else if (command === 'start') {
    requireOwnerWrite();
    const store = createSellerSituationStore({ client, writes: true });
    if (!(await store.hasScoreTable())) throw new Error('refused: public.seller_situation_scores does not exist (apply the PROPOSED migration)');
    const state = B.parseState(await store.readState());
    const config = arg('config') ? JSON.parse(arg('config')) : {};
    const next = B.applyStart(state, { runId: crypto.randomUUID(), activeMarkets: await store.loadActiveMarkets(), config, fresh: Boolean(arg('fresh')), tableBytes: await store.tableBytes() });
    await store.writeState(next);
    console.log(JSON.stringify({ started: true, run_id: next.run_id, phases: next.phases.map((p) => p.market ?? p.kind), resumed_from: next.cursor_property_id }, null, 2));
  } else if (command === 'run') {
    requireOwnerWrite();
    const store = createSellerSituationStore({ client, writes: true });
    const until = Date.now() + Number(arg('max-minutes', 360)) * 60_000;
    while (Date.now() < until) {
      const s = await B.runTick({ store });
      console.log(JSON.stringify({ at: new Date().toISOString(), scored: s.scored, failed: s.failed, stopped_because: s.stopped_because, cursor: s.cursor_after, ms_per_property: s.metrics.ms_per_property, row_bytes: s.metrics.row_bytes.mean, table_bytes: await store.tableBytes() }));
      if (['universe_exhausted', 'status_paused', 'status_stopped', 'status_completed', 'sending_window'].includes(s.stopped_because) || String(s.stopped_because).startsWith('status_')) break;
      if (s.stopped_because === 'backoff_active' || s.gate) await new Promise((r) => setTimeout(r, 60_000));
    }
  } else if (command === 'pause') {
    requireOwnerWrite();
    const store = createSellerSituationStore({ client, writes: true });
    await store.writeState(B.applyPause(B.parseState(await store.readState())));
    console.log('paused');
  } else {
    console.log('usage: plan | dry-run [--n=500] [--sample=active-targets|phases] [--json=f] | status | start [--fresh] --confirm | run --confirm | pause --confirm');
    process.exitCode = 2;
  }
} finally {
  await client.end();
}
