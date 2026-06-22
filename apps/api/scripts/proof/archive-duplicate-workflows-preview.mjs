#!/usr/bin/env node
/**
 * Read-only proof for archiving empty duplicate workflow drafts.
 * Does NOT mutate production.
 */

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const TARGETS = [
  { id: '41fdc8a9-87ae-42ac-8b5d-359d757dde85', short: '41fdc8a9' },
  { id: 'a0b497b2-2cd0-4241-b396-e315b82118eb', short: 'a0b497b2' },
];

const CANONICAL_REPLACEMENT = {
  definition_key: 'system_master_acquisition_orchestrator',
  id: '82a08034-c1a5-4eeb-9623-dab7e1527b52',
};

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

async function inspectWorkflow(id) {
  const [defRes, nodesRes, edgesRes, versionsRes, enrollRes, runsRes] = await Promise.all([
    supabase.from('workflow_definitions').select('*').eq('id', id).maybeSingle(),
    supabase.from('workflow_nodes').select('id', { count: 'exact', head: true }).eq('workflow_definition_id', id),
    supabase.from('workflow_edges').select('id', { count: 'exact', head: true }).eq('workflow_definition_id', id),
    supabase.from('workflow_versions').select('id,version_number,created_at').eq('workflow_definition_id', id),
    supabase.from('workflow_enrollments').select('id', { count: 'exact', head: true }).eq('workflow_definition_id', id),
    supabase.from('workflow_runs').select('id', { count: 'exact', head: true }).eq('workflow_definition_id', id),
  ]);

  return {
    definition: defRes.data,
    definition_error: defRes.error?.message ?? null,
    node_count: nodesRes.count ?? 0,
    edge_count: edgesRes.count ?? 0,
    versions: versionsRes.data ?? [],
    enrollment_count: enrollRes.count ?? 0,
    run_count: runsRes.count ?? 0,
  };
}

async function main() {
  console.log('\n=== DUPLICATE WORKFLOW ARCHIVE PREVIEW (read-only) ===\n');

  for (const target of TARGETS) {
    const report = await inspectWorkflow(target.id);
    const def = report.definition;
    console.log(`Workflow ${target.short} (${target.id})`);
    console.log('  name:', def?.name ?? '(missing)');
    console.log('  definition_key:', def?.definition_key ?? '(none)');
    console.log('  lifecycle:', def?.lifecycle_status ?? def?.status ?? '(unknown)');
    console.log('  created_at:', def?.created_at ?? '(unknown)');
    console.log('  nodes:', report.node_count, 'edges:', report.edge_count);
    console.log('  versions:', report.versions.length);
    console.log('  enrollments:', report.enrollment_count, 'runs:', report.run_count);
    const safe =
      report.node_count === 0 &&
      report.edge_count === 0 &&
      report.enrollment_count === 0 &&
      report.run_count === 0;
    console.log('  safe_to_archive:', safe ? 'YES (pending operator approval)' : 'NO');
    console.log('');
  }

  console.log('Canonical replacement:', CANONICAL_REPLACEMENT);
  console.log('\nProposed archive mutation (DO NOT RUN without approval):');
  console.log(`  UPDATE workflow_definitions SET lifecycle_status = 'archived', is_active = false, updated_at = now()`);
  console.log(`  WHERE id IN ('${TARGETS.map((t) => t.id).join("','")}');`);
  console.log('\nRollback:');
  console.log(`  UPDATE workflow_definitions SET lifecycle_status = 'draft', is_active = false`);
  console.log(`  WHERE id IN ('${TARGETS.map((t) => t.id).join("','")}');`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});