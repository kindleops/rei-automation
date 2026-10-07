// ─── seller-situation/backfillStore.js ──────────────────────────────────────
// pg-backed side effects for backfill.js. Uses a direct pg client (the ops
// script connects with SUPABASE_DB_URL, statement_timeout 30 s).
//
// WRITE-REFUSING BY CONSTRUCTION:
//   * `writes: false` (the default) makes every write method throw
//     `seller_situation_store_write_refused`, and the session is set
//     default_transaction_read_only = on — a dry run cannot write even by bug.
//   * `writes: true` additionally requires the PROPOSED table
//     public.seller_situation_scores to exist (checked once); it does not exist
//     until the owner applies PROPOSED_20261007000000_seller_situation_scores.sql.
//
// Writes performed in live mode only:
//   system_control[seller_situation_scoring_backfill]   run state / cursor
//   public.seller_situation_scores                      upsert on property_id
//   public.seller_situation_score_failures              failed ids (append)

import { loadSellerRawFacts } from './loader.js';
import { ROW_COLUMNS, ROW_COLUMN_TYPES } from './codec.js';
import { STATE_KEY } from './backfill.js';

export const SCORE_TABLE = 'public.seller_situation_scores';
export const FAILURE_TABLE = 'public.seller_situation_score_failures';

function clean(v) { return String(v ?? '').trim(); }

/** The chunk upsert. Exported for the read-only recordset test (dry run validates the decode). */
export function recordsetSql() {
  return `jsonb_to_recordset($1::jsonb) as r(${ROW_COLUMNS.map((c) => `${c} ${ROW_COLUMN_TYPES[c]}`).join(', ')})`;
}
export function upsertSql() {
  const cols = ROW_COLUMNS.filter((c) => c !== 'property_id');
  return `insert into public.seller_situation_scores (${ROW_COLUMNS.join(', ')}, updated_at)
    select ${ROW_COLUMNS.map((c) => `r.${c}`).join(', ')}, now() from ${recordsetSql()}
    on conflict (property_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = now()`;
}

export function createSellerSituationStore({ client, writes = false, stateKey = STATE_KEY } = {}) {
  if (!client || typeof client.query !== 'function') throw new Error('seller_situation_store_requires_pg_client');
  let tableExists = null;
  let sessionReady = false;

  async function session() {
    if (sessionReady) return;
    await client.query("SET statement_timeout = '30s'");
    if (!writes) await client.query('SET default_transaction_read_only = on');
    sessionReady = true;
  }
  async function hasScoreTable() {
    if (tableExists !== null) return tableExists;
    await session();
    const r = await client.query("select to_regclass('public.seller_situation_scores') is not null as ok");
    tableExists = Boolean(r.rows?.[0]?.ok);
    return tableExists;
  }
  async function requireWrites() {
    if (!writes) throw new Error('seller_situation_store_write_refused');
    if (!(await hasScoreTable())) throw new Error('seller_situation_scores_table_missing (apply the PROPOSED migration first)');
  }

  return {
    writes,
    hasScoreTable,

    async readState() {
      await session();
      const r = await client.query('select value from public.system_control where key = $1', [stateKey]);
      return r.rows?.[0]?.value ?? null;
    },
    async writeState(state) {
      await requireWrites();
      await client.query(
        `insert into public.system_control (key, value, updated_at) values ($1, $2, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [stateKey, JSON.stringify(state)],
      );
    },
    async readContactWindow() {
      await session();
      const r = await client.query("select key, value from public.system_control where key in ('queue_contact_window_start','queue_contact_window_end')");
      const m = Object.fromEntries((r.rows || []).map((x) => [x.key, clean(x.value)]));
      return { start: m.queue_contact_window_start || '08:00', end: m.queue_contact_window_end || '21:00' };
    },
    async probeLoad() {
      await session();
      const t0 = Date.now();
      try {
        const r = await client.query(`
          select count(*) filter (where state = 'active' and pid <> pg_backend_pid()) as active_backends,
                 count(*) filter (where state = 'active' and pid <> pg_backend_pid() and now() - query_start > interval '20 seconds') as long_running,
                 count(*) filter (where wait_event_type = 'Lock') as lock_waits
          from pg_stat_activity
          where datname = current_database() and backend_type = 'client backend'
            and query not ilike 'START_REPLICATION%'`); // walsenders (realtime slot) stay 'active' for hours and must not pin the gate
        const row = r.rows?.[0] ?? {};
        return { ok: true, active_backends: Number(row.active_backends), long_running: Number(row.long_running), lock_waits: Number(row.lock_waits), latency_ms: Date.now() - t0 };
      } catch (error) {
        return { ok: false, error: clean(error?.message) };
      }
    },
    /** Active campaign markets (active/scheduled campaigns + their targets' property markets). */
    async loadActiveMarkets() {
      await session();
      // Two keyed steps (no properties seq-scan join): live campaigns -> their target ids -> markets by PK lookup.
      const live = await client.query("select id::text id, market from public.campaigns where status in ('active','scheduled')");
      const liveIds = (live.rows || []).map((x) => x.id);
      const fromCampaigns = (live.rows || []).map((x) => clean(x.market)).filter(Boolean);
      if (!liveIds.length) return [...new Set(fromCampaigns)];
      const t = await client.query('select distinct property_id from public.campaign_targets where campaign_id::text = any($1::text[]) and property_id is not null', [liveIds]);
      const ids = (t.rows || []).map((x) => x.property_id);
      const counts = new Map();
      for (let i = 0; i < ids.length; i += 1000) {
        const r = await client.query('select market, count(*)::int n from public.properties where property_id = any($1::text[]) and market is not null group by market', [ids.slice(i, i + 1000)]);
        for (const row of r.rows || []) counts.set(row.market, (counts.get(row.market) || 0) + row.n);
      }
      const fromTargets = [...counts.entries()].filter(([, n]) => n >= 25).sort((x, y) => y[1] - x[1]).map(([m]) => clean(m));
      return [...new Set([...fromCampaigns, ...fromTargets])];
    },
    /** Keyset page inside one phase (uses idx_properties_eg_market (market, property_id) / uq_properties_property_id). */
    async loadPropertyPage({ phase, afterPropertyId = null, limit = 200 }) {
      await session();
      if (phase.kind === 'ids') {
        const ids = [...phase.ids].sort();
        const start = afterPropertyId ? ids.findIndex((x) => x > afterPropertyId) : 0;
        return start < 0 ? [] : ids.slice(start, start + limit);
      }
      if (phase.kind === 'market') {
        const r = await client.query(
          `select property_id from public.properties where market = $1 and property_id is not null and ($2::text is null or property_id > $2)
           order by property_id limit $3`, [phase.market, afterPropertyId, limit]);
        return (r.rows || []).map((x) => x.property_id);
      }
      const r = await client.query(
        `select property_id from public.properties where property_id is not null and ($1::text is null or property_id > $1)
           and (market is null or market <> all($2::text[])) order by property_id limit $3`,
        [afterPropertyId, phase.exclude_markets || [], limit]);
      return (r.rows || []).map((x) => x.property_id);
    },
    async loadRawFacts(ids) {
      await session();
      return loadSellerRawFacts(ids, client);
    },
    async loadExisting(ids) {
      if (!(await hasScoreTable())) return [];
      const r = await client.query(
        `select property_id, score_version, input_model_version, weights_version, features_as_of
           from public.seller_situation_scores where property_id = any($1::text[])`, [ids]);
      return r.rows || [];
    },
    async upsertRows(rows) {
      await requireWrites();
      if (!rows.length) return;
      // One statement per chunk (jsonb_to_recordset): no N+1, row locks only on the chunk's own keys.
      await client.query(upsertSql(), [JSON.stringify(rows)]);
    },
    async logFailures(failures) {
      await requireWrites();
      if (!failures.length) return;
      await client.query(
        `insert into public.seller_situation_score_failures (property_id, run_id, run_version, error, transient)
         select property_id, run_id, run_version, error, coalesce(transient, false)
           from jsonb_to_recordset($1::jsonb) as f(property_id text, run_id text, run_version text, error text, transient boolean)`,
        [JSON.stringify(failures)],
      );
    },
    /** Read-only: decode a chunk through the same recordset the upsert uses (validates types without writing). */
    async validateRecordset(rows) {
      await session();
      const r = await client.query(`select count(*)::int n, sum(cardinality(r.tier_reasons))::int reasons, sum(jsonb_array_length(r.evidence))::int ev from ${recordsetSql()}`, [JSON.stringify(rows)]);
      return r.rows?.[0] ?? null;
    },
    async tableBytes() {
      if (!(await hasScoreTable())) return null;
      const r = await client.query("select pg_total_relation_size('public.seller_situation_scores') as b");
      return Number(r.rows?.[0]?.b ?? 0);
    },
  };
}
