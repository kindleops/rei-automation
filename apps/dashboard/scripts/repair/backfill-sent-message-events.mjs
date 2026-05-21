#!/usr/bin/env node
/**
 * REPAIR SCRIPT: backfill-sent-message-events.mjs
 *
 * Backfills missing message_events rows for sent send_queue rows.
 *
 * The problem: runner.ts marks rows queue_status='sent' and then inserts a
 * message_events record using the wrong column names ('body', 'thread_id',
 * 'status', 'phone'). The production message_events schema uses 'message_body',
 * 'thread_key', 'delivery_status', 'to_phone_number'. Supabase silently ignores
 * unknown columns, so the insert either fails or creates a near-empty row that
 * does not satisfy the queue_id join. The result: 7 sent rows (6 real + 1 test)
 * with no linked message_events — invisible to the inbox, Command Map, and Live
 * Activity.
 *
 * What this script does (DRY RUN by default):
 *   For every send_queue row where queue_status='sent' and no message_events
 *   row has queue_id = that row's id, insert a backfill message_events record
 *   using the CORRECT column names and values from the queue row.
 *
 * Also backfills thread_key on the send_queue row itself if null, deriving it
 * as to_phone_number|from_phone_number (the canonical format used everywhere).
 *
 * DEFAULT: DRY RUN — prints what WOULD be inserted, zero mutations.
 * LIVE:    Pass --apply flag.
 *
 * Usage:
 *   node scripts/repair/backfill-sent-message-events.mjs            # dry run
 *   node scripts/repair/backfill-sent-message-events.mjs --apply    # live
 *   node scripts/repair/backfill-sent-message-events.mjs --apply --skip-test-rows
 *
 * Flags:
 *   --apply           Execute mutations (default: dry run)
 *   --skip-test-rows  Skip rows where master_owner_id is null (test artifacts)
 *   --verbose         Print full message_body in output
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

const IS_APPLY      = process.argv.includes('--apply');
const SKIP_TEST     = process.argv.includes('--skip-test-rows');
const VERBOSE       = process.argv.includes('--verbose');

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
  console.error('       The anon key cannot write to message_events due to RLS.');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── thread_key derivation ─────────────────────────────────────────────────
// Canonical format: to_phone_number|from_phone_number
// This matches what the inbox_threads_hydrated view joins on.
function deriveThreadKey(toPhone, fromPhone) {
  if (!toPhone || !fromPhone) return null;
  return `${toPhone}|${fromPhone}`;
}

async function run() {
  console.log('='.repeat(66));
  console.log('  REPAIR: backfill-sent-message-events');
  console.log(`  Mode: ${IS_APPLY ? 'LIVE APPLY — MUTATIONS WILL OCCUR' : 'DRY RUN — no mutations'}`);
  console.log(`  Run at: ${new Date().toISOString()}`);
  if (!IS_APPLY) {
    console.log('\n  To apply: node scripts/repair/backfill-sent-message-events.mjs --apply');
  }
  console.log('='.repeat(66));

  // ── Counters ─────────────────────────────────────────────────────────────
  let inspected = 0;
  let toRepair  = 0;
  let repaired  = 0;
  let skipped   = 0;
  const errors  = [];

  // ── Step 1: Fetch all sent queue rows ────────────────────────────────────
  console.log('\n[1] Fetching sent queue rows ...');
  const { data: sentRows, error: sentErr } = await supabase
    .from('send_queue')
    .select('*')
    .eq('queue_status', 'sent')
    .order('sent_at', { ascending: false });

  if (sentErr) {
    console.error('FATAL: send_queue fetch failed:', sentErr.message);
    process.exit(1);
  }

  inspected = sentRows.length;
  console.log(`  Found ${inspected} sent queue rows`);

  // ── Step 2: Find which already have message_events ───────────────────────
  console.log('[2] Checking existing message_events linkage ...');
  const allIds = sentRows.map(r => r.id);
  const linkedIds = new Set();
  const BATCH = 500;

  for (let i = 0; i < allIds.length; i += BATCH) {
    const batch = allIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('message_events')
      .select('queue_id')
      .in('queue_id', batch);
    if (error) {
      console.error(`  Batch ${i} error:`, error.message);
      continue;
    }
    for (const r of data) if (r.queue_id) linkedIds.add(r.queue_id);
  }

  const orphaned = sentRows.filter(r => !linkedIds.has(r.id));
  toRepair = orphaned.length;
  console.log(`  Already linked: ${linkedIds.size}`);
  console.log(`  Orphaned (need repair): ${toRepair}`);

  if (toRepair === 0) {
    console.log('\n  Nothing to repair — all sent rows have linked message_events.');
    printSummary(inspected, 0, 0, skipped, errors);
    process.exit(0);
  }

  // ── Step 3: Process each orphan ──────────────────────────────────────────
  console.log(`\n[3] Processing ${toRepair} orphaned rows ...\n`);

  for (const sq of orphaned) {
    const isTestRow = !sq.master_owner_id || !sq.property_id;

    if (SKIP_TEST && isTestRow) {
      console.log(`  SKIP  [test artifact] queue_id=${sq.id}`);
      skipped++;
      continue;
    }

    const derivedThreadKey = sq.thread_key || deriveThreadKey(sq.to_phone_number, sq.from_phone_number);
    const sentAt  = sq.sent_at || sq.updated_at || new Date().toISOString();
    const now     = new Date().toISOString();

    // Build the backfill record using CORRECT production column names
    const eventRecord = {
      // Required by schema (message_event_key is NOT NULL)
      message_event_key:    `backfill:queue:${sq.id}`,
      direction:            'outbound',
      event_type:           'sms',
      // Core identification
      queue_id:             sq.id,                        // FK back to send_queue
      thread_key:           derivedThreadKey,             // correct column (not thread_id)
      // Message content — correct column (not 'body')
      message_body:         sq.message_body || sq.message_text || '',
      // Phone numbers — correct columns (not 'phone')
      to_phone_number:      sq.to_phone_number,
      from_phone_number:    sq.from_phone_number,
      // Delivery status — correct column (not 'status')
      delivery_status:      'sent',
      // Timestamps
      sent_at:              sentAt,
      event_timestamp:      sentAt,
      created_at:           now,
      updated_at:           now,
      // Context linkage
      master_owner_id:      sq.master_owner_id  || null,
      property_id:          sq.property_id      || null,
      prospect_id:          sq.prospect_id      || null,
      market:               sq.market           || null,
      market_id:            sq.market_id        || null,
      textgrid_number_id:   sq.textgrid_number_id || null,
      property_address:     sq.property_address || null,
      // Source metadata
      source_app:           'nexus_backfill',
      metadata: {
        backfill:           true,
        backfill_reason:    'runner_schema_mismatch',
        original_queue_id:  sq.id,
        routing_tier:       sq.routing_tier,
        routing_reason:     sq.routing_reason,
        backfilled_at:      now,
      },
    };

    // Also prepare thread_key backfill on send_queue row itself
    const queuePatch = sq.thread_key ? null : { thread_key: derivedThreadKey, updated_at: now };

    console.log(`  ${IS_APPLY ? 'APPLY' : 'WOULD INSERT'}  queue_id=${sq.id}`);
    console.log(`    thread_key:    ${derivedThreadKey || 'null (cannot derive — missing phone numbers)'}`);
    console.log(`    master_owner:  ${sq.master_owner_id || 'null'}`);
    console.log(`    property_id:   ${sq.property_id || 'null'}`);
    console.log(`    sent_at:       ${sentAt}`);
    console.log(`    is_test_row:   ${isTestRow}`);
    if (queuePatch) {
      console.log(`    also PATCH send_queue.thread_key = ${derivedThreadKey}`);
    }
    if (VERBOSE) {
      console.log(`    message_body:  ${(eventRecord.message_body || '').slice(0, 80)}`);
    }

    if (!IS_APPLY) {
      repaired++; // Count as "would repair" in dry run
      continue;
    }

    // ── Live mutations ────────────────────────────────────────────────────
    // Insert message_events row
    const { error: insertErr } = await supabase
      .from('message_events')
      .insert(eventRecord);

    if (insertErr) {
      console.error(`    ERROR inserting message_events: ${insertErr.message}`);
      errors.push({ queue_id: sq.id, error: insertErr.message });
      continue;
    }

    // Patch thread_key on send_queue row if it was null
    if (queuePatch) {
      const { error: patchErr } = await supabase
        .from('send_queue')
        .update(queuePatch)
        .eq('id', sq.id);
      if (patchErr) {
        console.error(`    WARNING: message_events inserted but send_queue thread_key patch failed: ${patchErr.message}`);
        errors.push({ queue_id: sq.id, error: `thread_key patch: ${patchErr.message}` });
      } else {
        console.log(`    PATCHED send_queue.thread_key = ${derivedThreadKey}`);
      }
    }

    console.log(`    INSERTED message_events record`);
    repaired++;
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  printSummary(inspected, toRepair, repaired, skipped, errors);
  process.exit(errors.length > 0 ? 1 : 0);
}

function printSummary(inspected, toRepair, repaired, skipped, errors) {
  console.log('\n' + '='.repeat(66));
  console.log('  SUMMARY');
  console.log(`  Mode:              ${IS_APPLY ? 'LIVE APPLY' : 'DRY RUN'}`);
  console.log(`  Rows inspected:    ${inspected}`);
  console.log(`  Rows needing fix:  ${toRepair}`);
  console.log(`  Rows ${IS_APPLY ? 'repaired' : 'would repair'}:   ${repaired}`);
  console.log(`  Rows skipped:      ${skipped}`);
  console.log(`  Errors:            ${errors.length}`);
  if (errors.length > 0) {
    console.log('\n  Error detail:');
    for (const e of errors) console.log(`    queue_id=${e.queue_id}  ${e.error}`);
  }
  if (!IS_APPLY && toRepair > 0) {
    console.log('\n  To apply, run:');
    console.log('  node scripts/repair/backfill-sent-message-events.mjs --apply');
  }
  console.log('='.repeat(66));
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
