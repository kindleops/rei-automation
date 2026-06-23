#!/usr/bin/env node
/**
 * Preview deterministic metadata cleanup for mis-tagged consider_selling rows.
 * Does NOT apply production mutations.
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { normalizeTemplateDimensions } from '../../src/lib/domain/templates/template-metadata-normalization.js';

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

function classifyRow(row) {
  const normalized = normalizeTemplateDimensions(row);
  const ambiguous =
    !row.use_case ||
    (row.stage_code === 'S2' && row.use_case === 'consider_selling' && row.is_first_touch === true) === false &&
    row.stage_code !== normalized.stage_code;

  const before = {
    stage_code: row.stage_code ?? null,
    stage_label: row.stage_label ?? null,
    use_case: row.use_case ?? null,
  };
  const after = {
    stage_code: normalized.stage_code,
    stage_label: normalized.stage_label,
    use_case: normalized.use_case,
    touch_number: normalized.touch_number,
  };

  const changed =
    before.stage_code !== after.stage_code ||
    before.use_case !== after.use_case;

  return { before, after, changed, ambiguous, language: row.language, template_id: row.template_id || row.id };
}

async function main() {
  const { data, error } = await supabase
    .from('sms_templates')
    .select('id,template_id,template_name,use_case,language,stage_code,stage_label,is_first_touch,is_follow_up,is_active')
    .eq('is_active', true)
    .eq('use_case', 'consider_selling');

  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  const rows = data ?? [];
  const previews = rows.map(classifyRow);
  const changed = previews.filter((p) => p.changed && !p.ambiguous);
  const ambiguous = previews.filter((p) => p.ambiguous);
  const byLanguage = {};
  for (const p of changed) {
    byLanguage[p.language] = (byLanguage[p.language] || 0) + 1;
  }

  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const report = {
    generated: new Date().toISOString(),
    total_consider_selling_active: rows.length,
    would_update: changed.length,
    excluded_ambiguous: ambiguous.length,
    by_language: byLanguage,
    sample_before_after: changed.slice(0, 20),
    ambiguous_sample: ambiguous.slice(0, 10),
    canary_sql: `-- CANARY (max 10 rows) — DO NOT RUN WITHOUT APPROVAL
UPDATE sms_templates t
SET stage_code = 'S2', stage_label = 'S2 Selling Interest', updated_at = now()
FROM (
  SELECT id FROM sms_templates
  WHERE is_active = true AND use_case = 'consider_selling' AND stage_code IS DISTINCT FROM 'S2'
  LIMIT 10
) c
WHERE t.id = c.id;`,
    rollback_sql: `-- ROLLBACK canary
-- Restore from backup table sms_templates_metadata_backup_20260622 before applying.`,
  };

  const outPath = path.join(outDir, 'template-metadata-cleanup-preview.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== TEMPLATE METADATA CLEANUP PREVIEW ===');
  console.log('consider_selling active rows:', rows.length);
  console.log('deterministic updates:', changed.length);
  console.log('ambiguous (excluded):', ambiguous.length);
  console.log('by language:', JSON.stringify(byLanguage));
  console.log('report written:', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});