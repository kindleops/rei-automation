#!/usr/bin/env node
/**
 * PROOF SCRIPT: queue-event-linkage.mjs
 *
 * Verifies every send_queue row with queue_status='sent' has a corresponding
 * message_events row with a non-null queue_id pointing back to it.
 *
 * Also surfaces the runner.ts schema mismatch bug:
 *   The runner inserts message_events using column names that do not exist
 *   in the production schema ('body', 'thread_id', 'status', 'phone').
 *   The correct production column names are:
 *     body        → message_body
 *     thread_id   → thread_key  (thread_id does not exist)
 *     status      → delivery_status
 *     phone       → to_phone_number
 *
 * READ-ONLY. Never mutates any data.
 * Exit 0 = clean. Exit 1 = violations found.
 *
 * Usage:
 *   node scripts/proof/queue-event-linkage.mjs
 *   node scripts/proof/queue-event-linkage.mjs --verbose
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
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
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_KEY');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let violations = 0;
function PASS(msg) { console.log(`  PASS  ${msg}`); }
function FAIL(msg) { console.error(`  FAIL  ${msg}`); violations++; }
function INFO(msg) { console.log(`        ${msg}`); }

async function run() {
  console.log('='.repeat(66));
  console.log('  PROOF: send_queue → message_events linkage');
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log('='.repeat(66));

  // ── Fetch all sent queue rows ───────────────────────────────────────────
  console.log('\n[1] Fetching all sent queue rows ...');
  const { data: sentRows, error: sentErr } = await supabase
    .from('send_queue')
    .select('id,sent_at,thread_key,master_owner_id,property_id,prospect_id,to_phone_number,from_phone_number,market,message_body,textgrid_number_id,created_at')
    .eq('queue_status', 'sent')
    .order('sent_at', { ascending: false });

  if (sentErr) { FAIL(`send_queue fetch: ${sentErr.message}`); process.exit(1); }
  INFO(`Total sent rows: ${sentRows.length}`);

  // ── Fetch all message_events queue_id index (batched) ──────────────────
  console.log('\n[2] Fetching message_events queue_id index ...');
  const allQueueIds = sentRows.map(r => r.id);

  // Supabase .in() has a 1000-item limit per call — batch it
  // Using smaller batch size (100) to avoid "URL too long" errors
  const BATCH = 100;
  const linkedQueueIds = new Set();
  for (let i = 0; i < allQueueIds.length; i += BATCH) {
    const batch = allQueueIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('message_events')
      .select('queue_id')
      .in('queue_id', batch);
    if (error) { FAIL(`message_events batch ${i}: ${error.message}`); continue; }
    for (const r of data) if (r.queue_id) linkedQueueIds.add(r.queue_id);
  }
  INFO(`Sent rows with linked message_events: ${linkedQueueIds.size}`);

  // ── Identify orphans ────────────────────────────────────────────────────
  console.log('\n[3] Computing orphaned sent rows ...');
  const orphaned = sentRows.filter(r => !linkedQueueIds.has(r.id));
  INFO(`Orphaned sent rows: ${orphaned.length}`);

  if (orphaned.length === 0) {
    PASS('All sent rows have at least one linked message_events record');
  } else {
    FAIL(`${orphaned.length} sent rows have NO linked message_events record`);

    // Classify: real sends vs test artifacts
    const realSends = orphaned.filter(r => r.master_owner_id && r.property_id);
    const testRows  = orphaned.filter(r => !r.master_owner_id || !r.property_id);

    INFO(`  Real sends (have owner + property): ${realSends.length}`);
    INFO(`  Test/artifact rows (null owner or property): ${testRows.length}`);

    console.log('\n  Full orphan list:');
    console.log('  ' + '-'.repeat(62));
    for (const r of orphaned) {
      console.log(`  queue_id: ${r.id}`);
      console.log(`    sent_at:       ${r.sent_at || 'null'}`);
      console.log(`    thread_key:    ${r.thread_key || 'null'}`);
      console.log(`    master_owner:  ${r.master_owner_id || 'null'}`);
      console.log(`    property_id:   ${r.property_id || 'null'}`);
      console.log(`    prospect_id:   ${r.prospect_id || 'null'}`);
      console.log(`    to_phone:      ${r.to_phone_number}`);
      console.log(`    from_phone:    ${r.from_phone_number}`);
      console.log(`    market:        ${r.market || 'null'}`);
      if (VERBOSE) {
        console.log(`    message_body:  ${(r.message_body || '').slice(0, 80)}`);
        console.log(`    tg_number_id:  ${r.textgrid_number_id || 'null'}`);
      }
      console.log('  ' + '-'.repeat(62));
    }
  }

  // ── Runner schema mismatch check ───────────────────────────────────────
  console.log('\n[4] Checking for runner.ts schema mismatch artifacts ...');
  // The runner.ts (api/internal/queue/runner.ts line 384) inserts:
  //   { thread_id: null, body: ..., status: 'pending', phone: ..., ... }
  // None of 'thread_id', 'body', 'status', 'phone' exist in the production
  // message_events schema. Supabase silently ignores unknown columns on insert.
  // This means every runner-inserted event is missing message_body and thread_key.
  //
  // Evidence: outbound events with null message_body
  const { data: nullBodyEvts, error: nullBodyErr } = await supabase
    .from('message_events')
    .select('id,queue_id,created_at,delivery_status')
    .eq('direction', 'outbound')
    .is('message_body', null);

  if (nullBodyErr) {
    FAIL(`null message_body check: ${nullBodyErr.message}`);
  } else if (nullBodyEvts.length > 0) {
    FAIL(`${nullBodyEvts.length} outbound message_events have null message_body`);
    INFO('  Root cause: runner.ts uses wrong column name "body" — production schema requires "message_body"');
    INFO('  Additional mismatches in runner.ts insert:');
    INFO('    thread_id   → does not exist, should be thread_key');
    INFO('    body        → does not exist, should be message_body');
    INFO('    status      → does not exist, should be delivery_status');
    INFO('    phone       → does not exist, should be to_phone_number');
    INFO('  See: api/internal/queue/runner.ts line ~384');
    INFO('  [HANDOFF TO GEMINI] Fix the message_events insert in runner.ts');
    if (VERBOSE) {
      for (const r of nullBodyEvts.slice(0, 10)) {
        console.log(`    event_id=${r.id}  queue_id=${r.queue_id}  created_at=${r.created_at}`);
      }
    }
  } else {
    PASS('No outbound message_events with null message_body');
  }

  // ── null queue_id on outbound events ───────────────────────────────────
  console.log('\n[5] Checking for outbound message_events with null queue_id ...');
  const { data: nullQueueIdEvts, error: nullQidErr } = await supabase
    .from('message_events')
    .select('id,created_at,direction,delivery_status,thread_key,master_owner_id')
    .eq('direction', 'outbound')
    .is('queue_id', null);

  if (nullQidErr) {
    FAIL(`null queue_id check: ${nullQidErr.message}`);
  } else if (nullQueueIdEvts.length > 0) {
    FAIL(`${nullQueueIdEvts.length} outbound message_events have null queue_id`);
    if (VERBOSE) {
      for (const r of nullQueueIdEvts.slice(0, 10)) {
        console.log(`    event_id=${r.id}  thread_key=${r.thread_key || 'null'}  created_at=${r.created_at}`);
      }
    }
  } else {
    PASS('All outbound message_events have queue_id');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(66));
  if (violations === 0) {
    console.log('  RESULT: CLEAN');
    process.exit(0);
  } else {
    console.error(`  RESULT: ${violations} VIOLATION(S) — see FAIL lines above`);
    process.exit(1);
  }
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
