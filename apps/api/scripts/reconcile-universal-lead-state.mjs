#!/usr/bin/env node
/**
 * Reconcile legacy inbox_thread_state rows to canonical universal lead state.
 * Does not send messages. Preserves legacy_stage/legacy_status for audit.
 *
 * Usage:
 *   node apps/api/scripts/reconcile-universal-lead-state.mjs --dry-run
 *   node apps/api/scripts/reconcile-universal-lead-state.mjs
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env.local') });

const { supabase } = await import('../src/lib/supabase/client.js');
const {
  normalizeLifecycleStage,
  normalizeOperationalStatus,
  normalizeLeadTemperature,
  normalizeDisposition,
  normalizeContactability,
  LIFECYCLE_STAGE_CODES,
} = await import('../src/lib/domain/lead-state/universal-lead-state-registry.js');

const PAGE_SIZE = 500;
const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

function deriveTemperature(row) {
  if (row.lead_temperature) return normalizeLeadTemperature(row.lead_temperature);
  if (row.is_hot_lead) return 'hot';
  const priority = String(row.priority || '').toLowerCase();
  if (priority === 'urgent') return 'hot';
  if (priority === 'high') return 'warm';
  if (String(row.stage || '').toLowerCase() === 'dead' || String(row.status || '').toLowerCase() === 'dead') {
    return 'cold';
  }
  return 'unscored';
}

function isAmbiguousStage(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return true;
  const derived = normalizeLifecycleStage(key, null);
  return !derived;
}

async function reconcile() {
  let offset = 0;
  let mapped = 0;
  let unchanged = 0;
  let ambiguous = 0;
  let failed = 0;
  const unmapped = [];

  while (true) {
    const { data, error } = await supabase
      .from('inbox_thread_state')
      .select([
        'thread_key', 'stage', 'status', 'priority', 'is_hot_lead',
        'is_suppressed', 'is_archived', 'disposition',
        'manual_stage_lock', 'manual_temperature_lock', 'manual_override',
        'lifecycle_stage', 'operational_status', 'lead_temperature',
        'contactability_status', 'legacy_stage', 'legacy_status',
      ].join(','))
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    const rows = data || [];
    if (!rows.length) break;

    for (const row of rows) {
      const patch = {};
      const legacyStage = row.stage || row.legacy_stage || null;
      const legacyStatus = row.status || row.legacy_status || null;

      if (legacyStage) patch.legacy_stage = legacyStage;
      if (legacyStatus) patch.legacy_status = legacyStatus;

      if (!row.manual_stage_lock) {
        if (!row.lifecycle_stage) {
          const raw = legacyStage;
          if (isAmbiguousStage(raw)) {
            ambiguous += 1;
            unmapped.push({ thread_key: row.thread_key, field: 'lifecycle_stage', raw });
            patch.operational_status = patch.operational_status || 'needs_review';
          } else {
            patch.lifecycle_stage = normalizeLifecycleStage(raw, LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION);
          }
        }
      }

      if (!row.manual_override && !row.operational_status) {
        patch.operational_status = normalizeOperationalStatus(legacyStatus);
      }

      if (!row.manual_temperature_lock && !row.lead_temperature) {
        patch.lead_temperature = deriveTemperature(row);
        patch.temperature = patch.lead_temperature;
      }

      if (!row.disposition) {
        patch.disposition = normalizeDisposition('none');
      }

      if (!row.contactability_status) {
        patch.contactability_status = normalizeContactability(row.is_suppressed ? 'opted_out' : 'contactable');
      }

      // Never unarchive or reactivate suppressed during reconciliation
      if (row.is_archived) {
        // preserve archive state — do not patch is_archived
      }
      if (row.is_suppressed && patch.contactability_status === 'contactable') {
        patch.contactability_status = 'opted_out';
      }

      if (!Object.keys(patch).length) {
        unchanged += 1;
        continue;
      }

      if (dryRun) {
        mapped += 1;
        continue;
      }

      const { error: updateError } = await supabase
        .from('inbox_thread_state')
        .update({
          ...patch,
          seller_stage: patch.lifecycle_stage ?? undefined,
          conversation_status: patch.operational_status ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .eq('thread_key', row.thread_key);

      if (updateError) {
        failed += 1;
        console.warn('[RECONCILE_FAILED]', row.thread_key, updateError.message);
        continue;
      }
      mapped += 1;
    }

    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(JSON.stringify({
    ok: true,
    dry_run: dryRun,
    mapped,
    unchanged,
    ambiguous,
    failed,
    unmapped_sample: unmapped.slice(0, 25),
  }, null, 2));
}

reconcile().catch((error) => {
  console.error('[RECONCILE_FATAL]', error);
  process.exit(1);
});