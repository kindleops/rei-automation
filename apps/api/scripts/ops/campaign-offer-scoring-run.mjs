#!/usr/bin/env node
/**
 * CAMPAIGN OFFER-READY SCORING — controlled operator run (owner-approved scope only).
 *
 * Scores the queue-eligible properties of ONE campaign with the production
 * offer engine (ensurePropertyAcquisitionDecision, full monetary authority),
 * in resumable batches, measuring each batch and AUTO-PAUSING on any owner
 * threshold (2026-10-06):
 *   - DB pressure: > 12 active sessions, or any other query running > 10 s
 *   - timeout clustering: >= 3 timeouts in a batch
 *   - storage: > 300 KB per scored property (pg_total_relation_size delta of
 *     property_acquisition_scores + acquisition_score_snapshots), or > 0.8 GB total
 *   - scoring errors > 2% of a batch
 * It refuses to run outside the window (not 05:00–08:59, 09:15–11:59 UTC; never
 * before 12:00 UTC on the owner's day-1 rule) unless --allow-window-override.
 *
 * Writes (live only): property_acquisition_scores, acquisition_score_snapshots
 * (engine), system_control[acquisition_scoring_backfill:campaign_offer_ready]
 * (cursor/checkpoint). Sends nothing. Autopilot is not touched.
 *
 *   cd apps/api && export SUPABASE_DB_URL=... &&
 *   nice -n 15 node --env-file=.env.local scripts/ops/campaign-offer-scoring-run.mjs \
 *     --campaign=<uuid> --batch=25 --batches=1 [--dry-run] --log=<file>
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

register('./tests/alias-loader.mjs', pathToFileURL('./'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : fallback;
};

export const THRESHOLDS = Object.freeze({
  max_active_sessions: 12,
  max_query_seconds: 10,
  max_timeouts_per_batch: 3, // pause at >= 3
  max_bytes_per_property: 300 * 1024,
  max_total_bytes: 0.8 * 1024 ** 3,
  max_error_ratio: 0.02,
});

/** Busy windows (UTC minutes). Day-1 rule: nothing before 12:00 UTC. */
export function windowVerdict(now = new Date()) {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (m < 12 * 60) return { ok: false, reason: `before_12:00Z (now ${now.toISOString().slice(11, 16)}Z)` };
  return { ok: true };
}

export function evaluateBatchHealth({ load = {}, timeouts = 0, errors = 0, attempted = 0, scored = 0, deltaBytes = 0, totalBytes = 0 } = {}, t = THRESHOLDS) {
  const reasons = [];
  if ((load.active_sessions ?? 0) > t.max_active_sessions) reasons.push(`db_active_sessions_${load.active_sessions}>${t.max_active_sessions}`);
  if ((load.max_query_seconds ?? 0) > t.max_query_seconds) reasons.push(`db_query_running_${Math.round(load.max_query_seconds)}s>${t.max_query_seconds}s`);
  if (timeouts >= t.max_timeouts_per_batch) reasons.push(`timeouts_${timeouts}>=${t.max_timeouts_per_batch}`);
  if (attempted > 0 && errors / attempted > t.max_error_ratio) reasons.push(`errors_${errors}/${attempted}>${t.max_error_ratio * 100}%`);
  if (scored > 0 && deltaBytes / scored > t.max_bytes_per_property) reasons.push(`storage_${Math.round(deltaBytes / scored / 1024)}KB_per_property>300KB`);
  if (totalBytes > t.max_total_bytes) reasons.push(`storage_total_${(totalBytes / 1024 ** 3).toFixed(2)}GB>0.8GB`);
  return { healthy: reasons.length === 0, reasons };
}

async function main() {
  const campaign = String(arg('campaign', '') || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(campaign)) throw new Error('--campaign=<uuid> is required (exactly one campaign)');
  const dry = Boolean(arg('dry-run', false));
  const batchSize = Math.max(1, Math.min(200, Number(arg('batch', 25)) || 25));
  const maxBatches = Math.max(1, Number(arg('batches', 1)) || 1);
  const logFile = arg('log', null);
  const log = (o) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...o });
    console.log(line);
    if (logFile) appendFileSync(logFile, `${line}\n`);
  };
  if (!dry && !arg('allow-window-override', false)) {
    const w = windowVerdict();
    if (!w.ok) { log({ stop: 'window', reason: w.reason }); process.exitCode = 3; return; }
  }

  const pg = (await import('pg')).default;
  const url = String(process.env.SUPABASE_DB_URL || '').trim();
  if (!url) throw new Error('SUPABASE_DB_URL is required (read-only probes)');
  const probe = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await probe.connect();
  await probe.query("SET statement_timeout='30s'");
  await probe.query('SET default_transaction_read_only = on');

  const sizes = async () => {
    const { rows: [r] } = await probe.query(`select pg_total_relation_size('public.property_acquisition_scores')::bigint s,
      pg_total_relation_size('public.acquisition_score_snapshots')::bigint n,
      (select count(*) from public.property_acquisition_scores)::int sr, (select count(*) from public.acquisition_score_snapshots)::int nr`);
    return { scores: Number(r.s), snapshots: Number(r.n), total: Number(r.s) + Number(r.n), score_rows: r.sr, snapshot_rows: r.nr };
  };
  const dbLoad = async () => {
    const { rows: [r] } = await probe.query(`
      SELECT count(*) FILTER (WHERE state = 'active')::int active_sessions,
             coalesce(max(extract(epoch from now() - query_start)) FILTER (WHERE state = 'active' AND backend_type = 'client backend'), 0)::float max_query_seconds,
             count(*) FILTER (WHERE wait_event_type = 'Lock')::int lock_waits
        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
    return r;
  };

  const { runBackfillTick, applyStart, parseState, CAMPAIGN_SCOPE_STATE_KEY, SCOPE_KINDS } = await import('../../src/lib/acquisition/scoringBackfill.js');
  const { createScoringBackfillStore } = await import('../../src/lib/acquisition/scoringBackfillStore.js');
  const { evaluateOfferReadiness } = await import('../../src/lib/acquisition/offerReadiness.js');
  const { getDefaultSupabaseClient } = await import('../../src/lib/supabase/default-client.js');

  let supabase = getDefaultSupabaseClient();
  if (dry) {
    const real = supabase;
    const READ_RPCS = new Set(['get_comp_candidates_for_subject']);
    supabase = {
      from(table) {
        const b = real.from(table);
        return new Proxy(b, { get(t, p) { if (['insert', 'update', 'upsert', 'delete'].includes(p)) return () => { throw new Error(`dry-run write refused: ${String(p)} ${table}`); }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
      },
      rpc(name, params) { if (!READ_RPCS.has(name)) throw new Error(`dry-run rpc refused: ${name}`); return real.rpc(name, params); },
    };
  }
  const base = createScoringBackfillStore({ stateKey: CAMPAIGN_SCOPE_STATE_KEY, supabase });
  const scope = { kind: SCOPE_KINDS.CAMPAIGN, campaign_ids: [campaign] };
  let batchResults = [];
  const store = {
    ...base,
    resolveCampaignIds: async () => [campaign], // exactly this campaign, never a discovered set
    loadPropertyPage: (p) => base.loadPropertyPage.call({ ...base, resolveCampaignIds: async () => [campaign] }, { ...p, scope }),
    scoreOneMonetary: async (id, o) => {
      const t0 = Date.now();
      try {
        const r = await base.scoreOneMonetary.call(base, id, o);
        batchResults.push({ property_id: id, ok: r.ok, error: r.error, ms: Date.now() - t0, status: r.decision_status ?? null });
        return r;
      } catch (e) {
        batchResults.push({ property_id: id, ok: false, error: e?.message || 'threw', ms: Date.now() - t0 });
        throw e;
      }
    },
    probeLoad: async () => { const l = await dbLoad(); return { ok: true, latency_ms: 0, active_backends: l.active_sessions, long_running: l.max_query_seconds > THRESHOLDS.max_query_seconds ? 1 : 0, lock_waits: l.lock_waits }; },
    ...(dry ? { readState: async () => null, writeState: async () => {} } : {}),
  };
  if (!dry) {
    const state = parseState(await store.readState());
    if (state.status !== 'running' || state.config?.scope?.campaign_ids?.[0] !== campaign) {
      await store.writeState(applyStart(state, { runId: `campaign-${campaign.slice(0, 8)}-${Date.now()}`, config: { scope }, resume: state.config?.scope?.campaign_ids?.[0] === campaign }));
    }
  }

  const start = await sizes();
  log({ event: 'start', campaign, dry, batch_size: batchSize, max_batches: maxBatches, sizes: start, load: await dbLoad(), thresholds: THRESHOLDS });
  const totals = { attempted: 0, scored: 0, errors: 0, timeouts: 0, skipped: 0, ms: [] };
  const t0 = Date.now();
  for (let b = 1; b <= maxBatches; b++) {
    const before = await sizes();
    const loadBefore = await dbLoad();
    batchResults = [];
    const s = await runBackfillTick({
      store, dryRun: dry, maxProperties: batchSize, ignoreWindow: true,
      configOverrides: { scope, max_active_backends: THRESHOLDS.max_active_sessions, long_running_seconds: THRESHOLDS.max_query_seconds, max_long_running: 0 },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const after = await sizes();
    const loadAfter = await dbLoad();
    const attempted = batchResults.length;
    const errors = batchResults.filter((r) => !r.ok).length;
    const timeouts = batchResults.filter((r) => /timeout|timed out|57014/i.test(String(r.error || ''))).length;
    const scored = batchResults.filter((r) => r.ok).length;
    const deltaBytes = after.total - before.total;
    // verdict for every property touched in this batch, read back from the table
    const ids = batchResults.map((r) => r.property_id);
    const { rows } = ids.length ? await probe.query(`select property_id, computed_at, decision_tier, recommended_cash_offer, comp_count, confidence,
        jsonb_build_object('offer_calculation', jsonb_build_object('effective_authorized_ceiling', evidence->'offer_calculation'->'effective_authorized_ceiling'), 'backfill', evidence->'backfill') evidence,
        evidence->'subject'->>'asset_type' asset_type, left(coalesce(evidence->>'decision_tier_reasoning',''), 160) tier_reason
        from property_acquisition_scores where property_id = any($1)`, [ids]) : { rows: [] };
    const byId = new Map(rows.map((r) => [String(r.property_id), r]));
    const verdicts = batchResults.map((r) => {
      const row = byId.get(String(r.property_id));
      if (!r.ok) return { property_id: r.property_id, offer_ready: false, reason: `engine_error:${r.error}` };
      const v = evaluateOfferReadiness(row || null);
      return {
        property_id: r.property_id, offer_ready: v.ready, reason: v.reason, tier: row?.decision_tier ?? null, comps: row?.comp_count ?? null,
        asset: row?.asset_type ?? null, ms: r.ms, decision_status: r.status, tier_reason: v.ready ? undefined : row?.tier_reason || undefined,
      };
    });
    const health = evaluateBatchHealth({
      load: { active_sessions: Math.max(loadBefore.active_sessions, loadAfter.active_sessions), max_query_seconds: Math.max(loadBefore.max_query_seconds, loadAfter.max_query_seconds) },
      timeouts, errors, attempted, scored: dry ? 0 : scored, deltaBytes: dry ? 0 : deltaBytes, totalBytes: dry ? 0 : after.total - start.total,
    });
    totals.attempted += attempted; totals.scored += scored; totals.errors += errors; totals.timeouts += timeouts; totals.skipped += s.skipped_existing || 0;
    totals.ms.push(...batchResults.map((r) => r.ms));
    log({
      event: 'batch', batch: b, attempted, scored, skipped_existing: s.skipped_existing, errors, timeouts,
      offer_ready: verdicts.filter((v) => v.offer_ready).length, review_only: verdicts.filter((v) => !v.offer_ready).length,
      delta_bytes: deltaBytes, bytes_per_scored: scored ? Math.round(deltaBytes / scored) : null,
      rows_added: { scores: after.score_rows - before.score_rows, snapshots: after.snapshot_rows - before.snapshot_rows },
      load_before: loadBefore, load_after: loadAfter, stopped_because: s.stopped_because, gate: s.gate, cursor_after: s.cursor_after,
      health, verdicts,
    });
    if (!health.healthy) { log({ event: 'auto_pause', reasons: health.reasons }); if (!dry) await store.writeState({ ...parseState(await store.readState()), status: 'paused', paused_reason: health.reasons.join(';') }); break; }
    if (['universe_exhausted', 'status_paused', 'status_stopped', 'status_completed'].includes(s.stopped_because)) break;
    if (s.gate && s.stopped_because !== 'max_properties') { log({ event: 'gate_stop', gate: s.gate, stopped_because: s.stopped_because }); break; }
  }
  const end = await sizes();
  const ms = totals.ms.sort((a, c) => a - c);
  log({ event: 'done', dry, wall_minutes: Math.round((Date.now() - t0) / 6000) / 10, ...totals, ms: ms.length ? { median: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)] } : null, growth_bytes: end.total - start.total, sizes_end: end });
  await probe.end();
}

if (process.argv[1] && process.argv[1].endsWith('campaign-offer-scoring-run.mjs')) {
  main().catch((e) => { console.error(e?.stack || e?.message || e); process.exitCode = 1; });
}
