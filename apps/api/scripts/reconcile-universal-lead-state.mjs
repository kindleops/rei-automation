#!/usr/bin/env node
/**
 * Reconcile legacy inbox_thread_state rows to canonical universal lead state.
 * Does not send messages. Preserves legacy_stage/legacy_status for audit.
 */
import { supabase } from '../src/lib/supabase/client.js';
import {
  normalizeLifecycleStage,
  normalizeOperationalStatus,
  normalizeLeadTemperature,
  normalizeDisposition,
  normalizeContactability,
} from '../src/lib/domain/lead-state/universal-lead-state-registry.js';

const PAGE_SIZE = 500;

async function reconcile() {
  let offset = 0;
  let updated = 0;
  let ambiguous = 0;
  const unmapped = [];

  while (true) {
    const { data, error } = await supabase
      .from('inbox_thread_state')
      .select('thread_key,seller_stage,stage,conversation_status,status,temperature,lead_temperature,wrong_number,not_interested,opt_out,is_suppressed,manual_stage_lock,manual_temperature_lock,lifecycle_stage,operational_status,disposition,contactability_status')
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    const rows = data || [];
    if (!rows.length) break;

    for (const row of rows) {
      const patch = {};
      if (!row.lifecycle_stage && !row.manual_stage_lock) {
        const derived = normalizeLifecycleStage(row.seller_stage || row.stage, null);
        if (derived) patch.lifecycle_stage = derived;
        else {
          ambiguous += 1;
          unmapped.push({ thread_key: row.thread_key, field: 'lifecycle_stage', raw: row.seller_stage || row.stage });
          patch.operational_status = patch.operational_status || 'needs_review';
        }
      }
      if (!row.operational_status) {
        patch.operational_status = normalizeOperationalStatus(row.conversation_status || row.status);
      }
      if (!row.lead_temperature && !row.manual_temperature_lock) {
        patch.lead_temperature = normalizeLeadTemperature(row.temperature || row.lead_temperature);
      }
      if (!row.disposition) {
        patch.disposition = normalizeDisposition(
          row.wrong_number ? 'wrong_number' : row.not_interested ? 'not_interested' : 'none',
        );
      }
      if (!row.contactability_status) {
        patch.contactability_status = normalizeContactability(
          row.opt_out || row.is_suppressed ? 'opted_out' : 'contactable',
        );
      }
      if (row.seller_stage || row.stage) {
        patch.legacy_stage = row.seller_stage || row.stage;
      }
      if (row.conversation_status || row.status) {
        patch.legacy_status = row.conversation_status || row.status;
      }

      if (!Object.keys(patch).length) continue;

      const { error: updateError } = await supabase
        .from('inbox_thread_state')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('thread_key', row.thread_key);

      if (updateError) {
        console.warn('[RECONCILE_FAILED]', row.thread_key, updateError.message);
        continue;
      }
      updated += 1;
    }

    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(JSON.stringify({
    ok: true,
    updated,
    ambiguous,
    unmapped_sample: unmapped.slice(0, 25),
  }, null, 2));
}

reconcile().catch((error) => {
  console.error('[RECONCILE_FATAL]', error);
  process.exit(1);
});