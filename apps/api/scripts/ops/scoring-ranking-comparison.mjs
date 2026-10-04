#!/usr/bin/env node
/**
 * Legacy vs canonical ranking comparison — READ-ONLY.
 *
 * Legacy:    properties.final_acquisition_score   (Podio import; Campaign Build ordering today)
 * Canonical: property_acquisition_scores.aos_score (Acquisition Decision Engine)
 *
 * Reports coverage, Spearman rank correlation, top-decile / top-quintile
 * overlap overall and per market, and where the legacy top decile lands under
 * the canonical decision tier. The owner retires the legacy score only after
 * this shows complete coverage and an understood ranking difference.
 *
 *   cd apps/api
 *   node --env-file=.env.local scripts/ops/scoring-ranking-comparison.mjs [--backfill-only] [--min-n=30] [--json]
 *
 * Load safety: read-only transaction, statement_timeout 30 s, keyset pages of
 * 5,000 over property_acquisition_scores (driven by the score table, joined to
 * properties by its unique property_id index).
 */
import pg from 'pg';

import { buildRankComparison } from '../../src/lib/acquisition/scoringRankComparison.js';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : fallback;
};

const PAGE = 5_000;

async function main() {
  const url = String(process.env.SUPABASE_DB_URL || '').trim();
  if (!url) throw new Error('SUPABASE_DB_URL is required');
  const backfillOnly = Boolean(arg('backfill-only', false));
  const client = new pg.Client({ connectionString: url, statement_timeout: 30_000 });
  await client.connect();
  const rows = [];
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='30s'");
    // scoring_version exists only after the PROPOSED migration.
    const { rows: cols } = await client.query(
      "select 1 from information_schema.columns where table_schema='public' and table_name='property_acquisition_scores' and column_name='scoring_version'",
    );
    const hasVersion = cols.length > 0;
    if (backfillOnly && !hasVersion) throw new Error('--backfill-only needs the scoring_version column (migration not applied)');
    let after = '';
    for (;;) {
      const { rows: page } = await client.query(
        `select s.property_id, coalesce(p.market, '(none)') as market,
                p.final_acquisition_score as legacy, s.aos_score as canonical, s.decision_tier
           from property_acquisition_scores s
           join properties p on p.property_id = s.property_id
          where s.property_id > $1 ${backfillOnly ? "and s.scoring_version is not null" : ''}
          order by s.property_id
          limit ${PAGE}`,
        [after],
      );
      rows.push(...page);
      if (page.length < PAGE) break;
      after = page[page.length - 1].property_id;
    }
    const { rows: [universe] } = await client.query(
      "select reltuples::bigint as properties from pg_class where relname='properties'",
    );
    await client.query('COMMIT');
    const report = buildRankComparison(rows, { minN: Number(arg('min-n', 30)) || 30 });
    report.universe_properties = Number(universe.properties);
    report.canonical_coverage_of_universe = Math.round((rows.length / Number(universe.properties)) * 10_000) / 100;
    report.generated_at = new Date().toISOString();
    report.scope = backfillOnly ? 'backfill_rows_only' : 'all_canonical_rows';
    if (arg('json', false)) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`Canonical rows: ${rows.length} (${report.canonical_coverage_of_universe}% of ~${report.universe_properties} properties)`);
    console.log(`Coverage among canonical rows: both=${report.coverage.both} canonical_only=${report.coverage.canonical_only} legacy_only=${report.coverage.legacy_only}`);
    const o = report.overall;
    console.log(`OVERALL n=${o.n} spearman=${o.spearman} top10% overlap=${o.top_decile?.overlap}/${o.top_decile?.k} (${o.top_decile?.share}) top20%=${o.top_quintile?.share}`);
    console.log('Legacy top decile by canonical tier:', JSON.stringify(report.legacy_top_decile_by_canonical_tier));
    console.log('\nmarket'.padEnd(28), 'n'.padStart(7), 'rho'.padStart(7), 'top10%'.padStart(8), 'top20%'.padStart(8));
    for (const m of report.markets) {
      console.log(
        String(m.market).slice(0, 27).padEnd(27),
        String(m.n).padStart(7),
        String(m.spearman ?? '-').padStart(7),
        String(m.top_decile?.share ?? '-').padStart(8),
        String(m.top_quintile?.share ?? '-').padStart(8),
        m.low_sample ? ' (low n)' : '',
      );
    }
    console.log(`\n${report.verdict_inputs.note}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
