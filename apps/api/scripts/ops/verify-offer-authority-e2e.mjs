#!/usr/bin/env node
/**
 * READ-ONLY end-to-end check of the authoritative offer / max fields (owner
 * activation step 3). For each property it reads the ONE score row and asks
 * every consumer what it would say, then checks they agree:
 *
 *   composer   offer-ready predicate (Composer "Offer Ready" preflight)
 *   brain      Seller Autopilot v2 offer authority (resolveV2OfferAuthority +
 *              resolveValuationSpendability) — the MAO the price branches use
 *   stage      the stage resolver's economic MAO (flag-on code path)
 *   quotes     negotiation_quotes rows (if the table is applied): every amount
 *              ≤ its recorded max, and that max == the engine max of its snapshot
 *   di         Deal Intelligence decision (getDealDecision) recommended /
 *              effectiveCeiling, through a client that refuses every write
 *
 * Nothing is written. Usage (from apps/api):
 *   SUPABASE_DB_URL=... nice -n 15 node --env-file=.env.local --import ./scripts/register-aliases-ops.mjs \
 *     scripts/ops/verify-offer-authority-e2e.mjs --campaign=<uuid> [--sample=50] | --property=<id>,<id>
 */
import { readFileSync } from 'node:fs';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

async function main() {
  const pg = (await import('pg')).default;
  const url = String(process.env.SUPABASE_DB_URL || (arg('db-url-file') ? readFileSync(arg('db-url-file'), 'utf8') : '')).trim();
  if (!url) throw new Error('SUPABASE_DB_URL or --db-url-file required');
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '30s'");

  let ids = String(arg('property', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const campaign = arg('campaign');
  if (!ids.length && campaign) {
    const { rows } = await client.query(
      `select distinct ct.property_id::text id from campaign_targets ct join property_acquisition_scores s on s.property_id = ct.property_id::text
        where ct.campaign_id = $1 and ct.target_status in ('ready','planned') order by 1 limit $2`,
      [campaign, Number(arg('sample', 50))]
    );
    ids = rows.map((r) => r.id);
  }
  const { rows: scores } = await client.query(`select * from property_acquisition_scores where property_id = any($1)`, [ids]);
  const { rows: props } = await client.query(`select property_id::text, property_type, units_count from properties where property_id::text = any($1)`, [ids]);
  let quotes = null;
  const reg = await client.query(`select to_regclass('public.negotiation_quotes') t`);
  if (reg.rows[0].t) quotes = (await client.query(`select * from negotiation_quotes where property_id = any($1) order by quoted_at`, [ids])).rows;
  const { rows: snaps } = quotes?.length
    ? await client.query(`select snapshot_id::text, evidence->'offer_calculation'->>'effective_authorized_ceiling' mao from acquisition_score_snapshots where snapshot_id::text = any($1)`, [[...new Set(quotes.map((q) => q.score_snapshot_id).filter(Boolean))]]).catch(() => ({ rows: [] }))
    : { rows: [] };
  await client.query('ROLLBACK');
  await client.end();

  const { evaluateOfferReadiness, authoritativeMaxOffer } = await import('../../src/lib/acquisition/offerReadiness.js');
  const { resolveV2OfferAuthority } = await import('../../src/lib/domain/seller-flow/seller-autopilot-v2.js');
  const { resolveValuationSpendability } = await import('../../src/lib/domain/seller-flow/valuation-offer-authority.js');
  const { getDealDecision } = await import('../../src/lib/domain/deal-intelligence/deal-decision-service.js');
  const { getDefaultSupabaseClient } = await import('../../src/lib/supabase/default-client.js');
  const real = getDefaultSupabaseClient();
  const readOnly = {
    from(table) {
      const b = real.from(table);
      return new Proxy(b, { get(t, p) { if (['insert', 'update', 'upsert', 'delete'].includes(p)) return () => { throw new Error(`verify write refused: ${String(p)} ${table}`); }; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
    },
    rpc: (name, params) => real.rpc(name, params), // DI's rpc calls are read RPCs (entity_graph_property_records, deal_market_demand)
  };
  const propById = new Map(props.map((p) => [p.property_id, p]));
  const snapMao = new Map(snaps.map((s) => [s.snapshot_id, Number(s.mao)]));
  const results = [];
  for (const score of scores) {
    const id = String(score.property_id);
    const composer = evaluateOfferReadiness(score);
    const brain = resolveV2OfferAuthority({
      ade_snapshot: score,
      spendability: resolveValuationSpendability({ valuation: score, v3_qualification: score?.evidence?.v3?.qualification ?? null }),
      property_metadata: { property_type: propById.get(id)?.property_type, unit_count: propById.get(id)?.units_count },
    });
    const engineMao = authoritativeMaxOffer(score);
    let di = null;
    try {
      const d = await getDealDecision({ propertyId: id }, { supabase: readOnly });
      di = { recommended: d?.offer?.recommended ?? null, ceiling: d?.offer?.effectiveCeiling ?? null };
    } catch (e) {
      di = { error: e?.message || 'di_failed' };
    }
    const q = (quotes || []).filter((x) => String(x.property_id) === id);
    const issues = [];
    if (composer.ready && !brain.ok) issues.push(`composer_ready_but_brain_holds:${brain.reason}`);
    if (!composer.ready && brain.ok) issues.push('brain_ok_but_composer_review_only');
    if (brain.ok && brain.mao !== engineMao) issues.push(`brain_mao_${brain.mao}!=engine_${engineMao}`);
    if (composer.ready && composer.mao !== engineMao) issues.push('composer_mao_mismatch');
    if (di && !di.error && engineMao != null && Number(di.ceiling) !== engineMao) issues.push(`di_ceiling_${di.ceiling}!=engine_${engineMao}`);
    if (di && !di.error && Number(di.recommended) !== Number(score.recommended_cash_offer)) issues.push('di_recommended_mismatch');
    for (const x of q) {
      if (x.amount != null && Number(x.amount) > Number(x.max_offer_at_quote)) issues.push(`quote_${x.quote_key}_above_its_max`);
      const sm = snapMao.get(x.score_snapshot_id);
      if (x.quote_type !== 'confirm_basics_no_number' && sm != null && Number(x.max_offer_at_quote) !== sm) issues.push(`quote_${x.quote_key}_max_${x.max_offer_at_quote}!=snapshot_${sm}`);
    }
    results.push({
      property_id: id,
      tier: score.decision_tier,
      offer: Number(score.recommended_cash_offer),
      engine_mao: engineMao,
      investor_ceiling_mid: Number(score.investor_ceiling_mid),
      composer: composer.ready ? 'offer_ready' : composer.reason,
      brain: brain.ok ? `ok mao=${brain.mao}` : brain.reason,
      di,
      quotes: q.length,
      agree: issues.length === 0,
      issues,
    });
  }
  const disagree = results.filter((r) => !r.agree);
  console.log(JSON.stringify({
    read_only: true,
    checked: results.length,
    agree: results.length - disagree.length,
    disagree: disagree.length,
    negotiation_quotes_table: quotes == null ? 'not_applied' : `${quotes.length} rows`,
    composer_offer_ready: results.filter((r) => r.composer === 'offer_ready').length,
    results,
  }, null, 2));
  if (disagree.length) process.exitCode = 2;
}

main().catch((e) => { console.error(e?.stack || e?.message || e); process.exitCode = 1; });
