#!/usr/bin/env node
/**
 * Read-only template catalog inventory — does NOT mutate production.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: '.env.local' });

import { supabase } from '../../src/lib/supabase/client.js';
import { LOCAL_TEMPLATE_CANDIDATES } from '../../src/lib/domain/templates/local-template-registry.js';
import { buildLanguageInventoryFromTemplates } from '../../src/lib/domain/templates/canonical-language-adapter.js';
import { resolveTemplateLifecycleStatus } from '../../src/lib/domain/templates/template-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '../..');

const PAGE_SIZE = 1000;

async function fetchAllSmsTemplates() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('sms_templates')
      .select('id,template_id,template_name,use_case,language,stage_code,stage_label,is_active,is_first_touch,is_follow_up,safe_for_auto_reply,metadata,created_at')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

function countCsvRows(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  return Math.max(0, lines.length - 1);
}

function lifecycleBreakdown(rows) {
  const counts = { enabled: 0, disabled: 0, retired: 0, draft: 0 };
  for (const row of rows) {
    const status = resolveTemplateLifecycleStatus(row);
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function compareS1PreviewPack(supabaseRows) {
  const previewPath = path.join(API_ROOT, 'supabase/seeds/acquisition_s1_template_pack.preview.json');
  const pack = JSON.parse(fs.readFileSync(previewPath, 'utf8'));
  const comparisons = [];

  for (const preview of pack.templates) {
    const matches = supabaseRows.filter((row) => {
      return (
        row.use_case === preview.use_case &&
        row.language === preview.language &&
        (row.stage_code === preview.stage_code || !preview.stage_code)
      );
    });
    const enabled = matches.filter((r) => resolveTemplateLifecycleStatus(r) === 'enabled');
    comparisons.push({
      preview_name: preview.template_name,
      use_case: preview.use_case,
      language: preview.language,
      existing_count: matches.length,
      enabled_count: enabled.length,
      status:
        matches.length === 0
          ? 'missing'
          : enabled.length > 0
            ? 'equivalent_exists'
            : 'exists_disabled',
    });
  }
  return comparisons;
}

async function main() {
  console.log('Running read-only template catalog inventory...');
  const supabaseRows = await fetchAllSmsTemplates();
  const lifecycle = lifecycleBreakdown(supabaseRows);
  const languageInventory = buildLanguageInventoryFromTemplates(
    supabaseRows.map((r) => ({ ...r, lifecycle_status: resolveTemplateLifecycleStatus(r) })),
  );

  const csvSources = {
    lifecycle_sms_template_pack: countCsvRows(path.join(API_ROOT, 'docs/templates/lifecycle-sms-template-pack.csv')),
    underwriting_template_pack: countCsvRows(path.join(API_ROOT, 'docs/templates/underwriting-template-pack.csv')),
    test_templates: countCsvRows(path.join(API_ROOT, 'tests/helpers/test-templates.csv')),
  };

  const report = {
    generated_at: new Date().toISOString(),
    read_only: true,
    production_mutated: false,
    sources: {
      supabase_sms_templates: {
        total: supabaseRows.length,
        ...lifecycle,
        canonical_runtime_source: true,
        production_reachable: true,
        migration_requirement: 'normalize_metadata_and_retire_duplicates',
      },
      local_template_registry: {
        total: LOCAL_TEMPLATE_CANDIDATES.length,
        enabled_count: LOCAL_TEMPLATE_CANDIDATES.filter((t) => t.active === 'Yes').length,
        canonical_runtime_source: false,
        production_reachable: false,
        migration_requirement: 'import_to_supabase_with_lifecycle_metadata',
      },
      csv_catalogs: {
        ...csvSources,
        total: Object.values(csvSources).reduce((a, b) => a + b, 0),
        canonical_runtime_source: false,
        production_reachable: false,
        migration_requirement: 'merge_into_supabase_or_deprecate',
      },
      podio_legacy: {
        total: 'unknown_without_live_query',
        canonical_runtime_source: false,
        production_reachable: false,
        migration_requirement: 'historical_import_to_supabase',
      },
    },
    grand_total_reachable:
      supabaseRows.length +
      LOCAL_TEMPLATE_CANDIDATES.length +
      Object.values(csvSources).reduce((a, b) => a + b, 0),
    language_inventory: languageInventory,
    s1_preview_comparison: compareS1PreviewPack(supabaseRows),
  };

  const outPath = path.join(__dirname, 'template-catalog-inventory-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    supabase_total: report.sources.supabase_sms_templates.total,
    lifecycle,
    language_count: languageInventory.length,
    grand_total: report.grand_total_reachable,
    output: outPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});