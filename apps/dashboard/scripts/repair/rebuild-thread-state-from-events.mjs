#!/usr/bin/env node
/**
 * REPAIR SCRIPT: rebuild-thread-state-from-events.mjs
 *
 * Rebuilds inbox_thread_state rows from message_events for two gap types:
 *
 *   Gap A — 172 stale thread_states with no message_events:
 *     These were pre-created during queue builds (May 13 batch) but the
 *     corresponding messages were later cancelled/blocked, so no events ever
 *     arrived. They have status='active', stage='' (blank). They are visible
 *     in the inbox as ghost threads and break the Command Map filter.
 *     Repair: set stage='needs_response' (safe default) to remove blank-stage
 *     violations. Optionally set status='closed' if they are confirmed dead.
 *
 *   Gap B — Event thread_keys with no inbox_thread_state row:
 *     message_events rows exist for a thread_key but no inbox_thread_state row
 *     has been created. The thread is invisible to the inbox UI.
 *     Repair: INSERT a minimal inbox_thread_state row from the event data.
 *
 * DEFAULT: DRY RUN — prints what WOULD change, zero mutations.
 * LIVE:    Pass --apply flag.
 *
 * Usage:
 *   node scripts/repair/rebuild-thread-state-from-events.mjs           # dry run
 *   node scripts/repair/rebuild-thread-state-from-events.mjs --apply   # live
 *   node scripts/repair/rebuild-thread-state-from-events.mjs --gap-a-only
 *   node scripts/repair/rebuild-thread-state-from-events.mjs --gap-b-only
 *   node scripts/repair/rebuild-thread-state-from-events.mjs --apply --gap-a-only
 *
 * Flags:
 *   --apply      Execute mutations (default: dry run)
 *   --gap-a-only Only repair Gap A (stale states with no events)
 *   --gap-b-only Only repair Gap B (events with no state)
 *   --verbose    Print full row detail
 */

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const IS_APPLY   = process.argv.includes('--apply');
const GAP_A_ONLY = process.argv.includes('--gap-a-only');
const GAP_B_ONLY = process.argv.includes('--gap-b-only');
const VERBOSE    = process.argv.includes('--verbose');

function loadEnv() {
  const env = {};
  for (const f of ['.env.local', '.env']) {
    const p = path.join(__dirname, '../../', f);
    if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, 'utf-8').split('\n').forEach(line => {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return;
      const k = line.slice(0, eqIdx).trim();
      const v = line.slice(eqIdx + 1).trim();
      if (k && v && !k.startsWith('#')) env[k] = v;
    });
    break;
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_KEY');
  process.exit(2);
}

if (IS_APPLY && !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: --apply requires SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const stats = {
  gapA: { inspected: 0, toRepair: 0, repaired: 0, skipped: 0, errors: [] },
  gapB: { inspected: 0, toRepair: 0, repaired: 0, skipped: 0, errors: [] },
};

async function run() {
  console.log('='.repeat(66));
  console.log('  REPAIR: rebuild-thread-state-from-events');
  console.log(`  Mode: ${IS_APPLY ? 'LIVE APPLY — MUTATIONS WILL OCCUR' : 'DRY RUN — no mutations'}`);
  console.log(`  Run at: ${new Date().toISOString()}`);
  if (!IS_APPLY) {
    console.log('\n  To apply: node scripts/repair/rebuild-thread-state-from-events.mjs --apply');
  }
  console.log('='.repeat(66));

  // ── Load all state rows and event thread_keys ────────────────────────────
  console.log('\n[0] Loading base data (with pagination) ...');

  const fetchAll = async (table, select = '*') => {
    let allData = [];
    let from = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      allData = allData.concat(data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return allData;
  };

  const stateRows = await fetchAll('inbox_thread_state');
  const evtRows = await fetchAll('message_events', 'thread_key,direction,delivery_status,master_owner_id,property_id,prospect_id,market,to_phone_number,from_phone_number,created_at,event_timestamp');


  const stateByKey = new Map(stateRows.map(r => [r.thread_key, r]));
  const evtsByKey  = new Map();
  for (const r of evtRows) {
    if (!r.thread_key) continue;
    if (!evtsByKey.has(r.thread_key)) evtsByKey.set(r.thread_key, []);
    evtsByKey.get(r.thread_key).push(r);
  }

  console.log(`  Total inbox_thread_state rows: ${stateRows.length}`);
  console.log(`  Distinct thread_keys in message_events: ${evtsByKey.size}`);

  // ═══════════════════════════════════════════════════════════════════════
  // GAP A: Stale thread_state rows — have state, no events
  // ═══════════════════════════════════════════════════════════════════════
  if (!GAP_B_ONLY) {
    console.log('\n' + '─'.repeat(66));
    console.log('  GAP A: Stale thread_state rows (no message_events)');
    console.log('─'.repeat(66));

    const staleRows = stateRows.filter(r => !evtsByKey.has(r.thread_key));
    stats.gapA.inspected = staleRows.length;
    const blankStage = staleRows.filter(r => !r.stage || r.stage.trim() === '');
    stats.gapA.toRepair = blankStage.length;

    console.log(`  Stale state rows total:          ${staleRows.length}`);
    console.log(`  Of those with blank stage:       ${blankStage.length}`);
    console.log(`  Action: set stage='needs_response' (safe default for UI render)`);

    if (blankStage.length === 0) {
      console.log('  Nothing to repair in Gap A.');
    } else {
      console.log(`\n  ${IS_APPLY ? 'Applying' : 'Would apply'} ${blankStage.length} stage patches ...\n`);

      // Batch updates — process in groups
      const BATCH = 50;
      for (let i = 0; i < blankStage.length; i += BATCH) {
        const batch = blankStage.slice(i, i + BATCH);
        const batchIds = batch.map(r => r.id);

        console.log(`  ${IS_APPLY ? 'PATCH' : 'WOULD PATCH'} ${batch.length} rows (batch ${Math.floor(i/BATCH)+1}) — stage: '' -> 'needs_response'`);
        if (VERBOSE) {
          for (const r of batch) {
            console.log(`    id=${r.id}  thread_key=${r.thread_key}  status=${r.status}  stage="${r.stage}"`);
          }
        }

        if (!IS_APPLY) {
          stats.gapA.repaired += batch.length;
          continue;
        }

        const { error: patchErr } = await supabase
          .from('inbox_thread_state')
          .update({ stage: 'needs_response', updated_at: new Date().toISOString() })
          .in('id', batchIds);

        if (patchErr) {
          console.error(`    ERROR batch ${i}: ${patchErr.message}`);
          stats.gapA.errors.push({ batch: i, error: patchErr.message });
        } else {
          console.log(`    PATCHED ${batch.length} rows`);
          stats.gapA.repaired += batch.length;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GAP B: Event thread_keys with no thread_state row
  // ═══════════════════════════════════════════════════════════════════════
  if (!GAP_A_ONLY) {
    console.log('\n' + '─'.repeat(66));
    console.log('  GAP B: Event thread_keys missing inbox_thread_state row');
    console.log('─'.repeat(66));

    const evtKeysNoState = [...evtsByKey.keys()].filter(k => !stateByKey.has(k));
    stats.gapB.inspected = evtKeysNoState.length;
    stats.gapB.toRepair  = evtKeysNoState.length;

    console.log(`  Event thread_keys with no state row: ${evtKeysNoState.length}`);

    if (evtKeysNoState.length === 0) {
      console.log('  Nothing to repair in Gap B.');
    } else {
      console.log(`\n  ${IS_APPLY ? 'Inserting' : 'Would insert'} ${evtKeysNoState.length} state rows ...\n`);

      for (const threadKey of evtKeysNoState) {
        const evts = evtsByKey.get(threadKey);
        // Find the most recent event to derive context
        evts.sort((a, b) => {
          const ta = a.event_timestamp || a.created_at;
          const tb = b.event_timestamp || b.created_at;
          return new Date(tb) - new Date(ta);
        });
        const latest = evts[0];
        const inbound = evts.find(e => e.direction === 'inbound');
        const firstEvt = evts[evts.length - 1];

        const isLegacyKey = threadKey.startsWith('phone:');
        const phones = isLegacyKey ? [threadKey.replace('phone:', '')] : threadKey.split('|');
        const sellerPhone = phones[0] || null;
        const ourNumber   = phones[1] || null;

        const newState = {
          thread_key:      threadKey,
          master_owner_id: latest.master_owner_id || null,
          property_id:     latest.property_id || null,
          prospect_id:     latest.prospect_id || null,
          market:          latest.market || null,
          // Derive phones correctly
          canonical_e164:  sellerPhone,
          our_number:      ourNumber,
          seller_phone:    sellerPhone,
          // Default stage/status
          stage:           inbound ? 'needs_response' : 'needs_response',
          status:          inbound ? 'unread' : 'open',
          priority:        'normal',
          is_archived:     false,
          is_read:         !inbound,
          is_pinned:       false,
          is_urgent:       false,
          is_hot_lead:     false,
          metadata: {
            backfill:      true,
            backfill_reason: 'missing_state_row',
            event_count:   evts.length,
            backfilled_at: new Date().toISOString(),
          },
          created_at:      firstEvt.created_at || new Date().toISOString(),
          updated_at:      new Date().toISOString(),
        };

        console.log(`  ${IS_APPLY ? 'INSERT' : 'WOULD INSERT'}  thread_key=${threadKey}`);
        if (VERBOSE) {
          console.log(`    master_owner:  ${newState.master_owner_id || 'null'}`);
          console.log(`    property_id:   ${newState.property_id || 'null'}`);
          console.log(`    status:        ${newState.status}`);
          console.log(`    stage:         ${newState.stage}`);
          console.log(`    event_count:   ${evts.length}`);
        }

        if (!IS_APPLY) {
          stats.gapB.repaired++;
          continue;
        }

        const { error: insertErr } = await supabase
          .from('inbox_thread_state')
          .insert(newState);

        if (insertErr) {
          if (insertErr.message.includes('duplicate') || insertErr.code === '23505') {
            console.log(`    SKIP (already exists — race condition)`);
            stats.gapB.skipped++;
          } else {
            console.error(`    ERROR: ${insertErr.message}`);
            stats.gapB.errors.push({ thread_key: threadKey, error: insertErr.message });
          }
        } else {
          console.log(`    INSERTED`);
          stats.gapB.repaired++;
        }
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  console.log('  SUMMARY');
  console.log(`  Mode: ${IS_APPLY ? 'LIVE APPLY' : 'DRY RUN'}`);
  if (!GAP_B_ONLY) {
    console.log(`\n  Gap A (stale states — blank stage fix):`);
    console.log(`    Inspected:  ${stats.gapA.inspected}`);
    console.log(`    To repair:  ${stats.gapA.toRepair}`);
    console.log(`    ${IS_APPLY ? 'Repaired' : 'Would repair'}:  ${stats.gapA.repaired}`);
    console.log(`    Errors:     ${stats.gapA.errors.length}`);
  }
  if (!GAP_A_ONLY) {
    console.log(`\n  Gap B (missing state rows — insert from events):`);
    console.log(`    Inspected:  ${stats.gapB.inspected}`);
    console.log(`    To repair:  ${stats.gapB.toRepair}`);
    console.log(`    ${IS_APPLY ? 'Repaired' : 'Would repair'}:  ${stats.gapB.repaired}`);
    console.log(`    Skipped:    ${stats.gapB.skipped}`);
    console.log(`    Errors:     ${stats.gapB.errors.length}`);
  }
  const totalErrors = stats.gapA.errors.length + stats.gapB.errors.length;
  if (totalErrors > 0) {
    console.log('\n  Error detail:');
    for (const e of [...stats.gapA.errors, ...stats.gapB.errors]) {
      console.log(`    ${JSON.stringify(e)}`);
    }
  }
  if (!IS_APPLY) {
    console.log('\n  To apply, run:');
    console.log('  node scripts/repair/rebuild-thread-state-from-events.mjs --apply');
  }
  console.log('='.repeat(66));
  process.exit(totalErrors > 0 ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
