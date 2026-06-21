#!/usr/bin/env node

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '../../apps/api');
process.chdir(apiRoot);

register(
  pathToFileURL(resolve(apiRoot, 'tests/alias-loader.mjs')).href,
  pathToFileURL(`${apiRoot}/`),
);

const [
  { supabase, hasSupabaseConfig },
  registry,
  { normalizeOpportunityRow, getPipelineMetrics },
] = await Promise.all([
  import('../../apps/api/src/lib/supabase/client.js'),
  import('../../apps/api/src/lib/domain/opportunity/universal-pipeline-registry.js'),
  import('../../apps/api/src/lib/domain/opportunity/opportunity-service.js'),
]);

function logSection(title) {
  console.log(`\n[proof] ${title}`);
}

async function main() {
  assert.equal(
    hasSupabaseConfig(),
    true,
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run with `node --env-file=apps/api/.env.local ...`.',
  );

  logSection('registry mapping smoke');
  assert.equal(
    registry.mapThreadToUniversalStage({ universal_stage: 'offer_sent' }),
    registry.UNIVERSAL_STAGE_CODES.OFFER,
  );
  assert.equal(
    registry.mapThreadToUniversalStage({
      last_inbound_at: '2026-06-01T00:00:00.000Z',
      inbox_bucket: 'new_replies',
    }),
    registry.UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  );
  assert.equal(
    registry.mapThreadToUniversalTemperature({}),
    registry.UNIVERSAL_TEMPERATURE_CODES.UNKNOWN,
  );
  console.log('registry mappings ok');

  logSection('report_pipeline_reconciliation_counts()');
  const { data: report, error: reportError } = await supabase.rpc(
    'report_pipeline_reconciliation_counts',
  );
  if (reportError) throw reportError;
  assert.ok(report?.before, 'report must include before snapshot');
  assert.ok(report?.after, 'report must include after snapshot');
  console.log(JSON.stringify(report, null, 2));

  logSection('acquisition_opportunities universal field coverage');
  const { count: totalCount, error: totalError } = await supabase
    .from('acquisition_opportunities')
    .select('id', { count: 'exact', head: true });
  if (totalError) throw totalError;

  const { count: missingStatusCount, error: missingStatusError } = await supabase
    .from('acquisition_opportunities')
    .select('id', { count: 'exact', head: true })
    .is('universal_status', null);
  if (missingStatusError) throw missingStatusError;

  const { count: aosWithoutRunCount, error: aosError } = await supabase
    .from('acquisition_opportunities')
    .select('id', { count: 'exact', head: true })
    .is('acquisition_engine_run_id', null)
    .not('aos', 'is', null);
  if (aosError) throw aosError;

  console.table({
    total_opportunities: totalCount ?? 0,
    missing_universal_status: missingStatusCount ?? 0,
    aos_without_engine_run: aosWithoutRunCount ?? 0,
  });

  logSection('sample normalized opportunity rows');
  const { data: sampleRows, error: sampleError } = await supabase
    .from('acquisition_opportunities')
    .select('*')
    .not('primary_thread_key', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(5);
  if (sampleError) throw sampleError;

  for (const raw of sampleRows ?? []) {
    const normalized = normalizeOpportunityRow(raw);
    console.log({
      id: normalized.id,
      stage: normalized.acquisition_stage,
      universal_status: normalized.universal_status,
      temperature: normalized.temperature,
      aos: normalized.aos,
      property_type: normalized.property_type,
    });
  }

  logSection('pipeline metrics (universal KPI contract)');
  const metrics = await getPipelineMetrics({}, { supabase });
  console.table({
    active_leads: metrics.active_leads,
    priority: metrics.priority,
    new_replies: metrics.new_replies,
    offer_ready: metrics.offer_ready,
    under_contract: metrics.under_contract,
    total: metrics.total,
  });
  assert.ok('by_universal_status' in metrics, 'metrics must expose by_universal_status');

  console.log('\n[proof] pipeline universal reconciliation proof passed');
}

main().catch((error) => {
  console.error('[proof] failed:', error);
  process.exit(1);
});