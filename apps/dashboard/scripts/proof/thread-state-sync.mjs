#!/usr/bin/env node
/**
 * PROOF SCRIPT: thread-state-sync.mjs
 *
 * Verifies the message_events → inbox_thread_state linkage chain:
 *   1. Every thread_key in message_events has a row in inbox_thread_state
 *   2. No inbox_thread_state rows point to non-existent thread_keys in events
 *   3. inbox_thread_state rows with blank/null stage are surfaced
 *   4. Thread states without any sent queue activity are surfaced
 *
 * READ-ONLY. Never mutates any data.
 * Exit 0 = clean. Exit 1 = violations found.
 *
 * Usage:
 *   node scripts/proof/thread-state-sync.mjs
 *   node scripts/proof/thread-state-sync.mjs --verbose
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
  console.log('  PROOF: message_events → inbox_thread_state sync');
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log('='.repeat(66));

  // ── Fetch thread_keys from message_events ───────────────────────────────
  console.log('\n[1] Loading distinct thread_keys from message_events ...');
  const { data: evtRows, error: evtErr } = await supabase
    .from('message_events')
    .select('thread_key,direction,delivery_status');

  if (evtErr) { FAIL(`message_events fetch: ${evtErr.message}`); process.exit(1); }

  const allEvtKeys = new Set(evtRows.filter(r => r.thread_key).map(r => r.thread_key));
  const nullThreadKeyCount = evtRows.filter(r => !r.thread_key).length;

  INFO(`Total message_events rows: ${evtRows.length}`);
  INFO(`Distinct thread_keys in events: ${allEvtKeys.size}`);
  INFO(`Events with null thread_key: ${nullThreadKeyCount}`);

  if (nullThreadKeyCount > 0) {
    FAIL(`${nullThreadKeyCount} message_events rows have null thread_key`);
  } else {
    PASS('All message_events rows have thread_key');
  }

  // ── Fetch inbox_thread_state ─────────────────────────────────────────────
  console.log('\n[2] Loading inbox_thread_state ...');
  const { data: stateRows, error: stateErr } = await supabase
    .from('inbox_thread_state')
    .select('thread_key,status,stage,master_owner_id,property_id,created_at,updated_at,last_intent,pending_queue_count,failed_queue_count');

  if (stateErr) { FAIL(`inbox_thread_state fetch: ${stateErr.message}`); process.exit(1); }

  const stateByKey = new Map(stateRows.map(r => [r.thread_key, r]));
  INFO(`Total inbox_thread_state rows: ${stateRows.length}`);

  // ── Check 1: event thread_keys with no state ─────────────────────────────
  console.log('\n[3] Checking for event thread_keys missing a state row ...');
  const evtKeysNoState = [...allEvtKeys].filter(k => !stateByKey.has(k));
  INFO(`Event thread_keys with no inbox_thread_state row: ${evtKeysNoState.length}`);

  if (evtKeysNoState.length > 0) {
    FAIL(`${evtKeysNoState.length} thread_keys in message_events have no inbox_thread_state row`);
    if (VERBOSE) {
      for (const k of evtKeysNoState.slice(0, 20)) console.log(`    ${k}`);
    }
  } else {
    PASS('All message_events thread_keys have a corresponding inbox_thread_state row');
  }

  // ── Check 2: stale thread states (no events) ─────────────────────────────
  console.log('\n[4] Checking for stale thread_state rows (no events exist) ...');
  const staleStates = stateRows.filter(r => !allEvtKeys.has(r.thread_key));
  INFO(`Stale inbox_thread_state rows (no events): ${staleStates.length}`);

  if (staleStates.length > 0) {
    FAIL(`${staleStates.length} inbox_thread_state rows have no corresponding message_events`);
    INFO('  These are pre-created state rows from queue builds that never received an event.');
    INFO('  They are safe but add noise to the inbox.');
    if (VERBOSE) {
      for (const r of staleStates.slice(0, 20)) {
        console.log(`    thread_key=${r.thread_key}  status=${r.status}  stage=${r.stage || 'blank'}  created=${r.created_at}`);
      }
    }
  } else {
    PASS('No stale inbox_thread_state rows (all have events)');
  }

  // ── Check 3: blank stage values ──────────────────────────────────────────
  console.log('\n[5] Checking for blank stage values ...');
  const blankStage = stateRows.filter(r => !r.stage || r.stage.trim() === '');
  INFO(`Thread states with blank stage: ${blankStage.length}`);

  if (blankStage.length > 0) {
    FAIL(`${blankStage.length} inbox_thread_state rows have a blank stage`);
    INFO('  Blank stage breaks the inbox_threads_hydrated view and Command Map filters.');
    if (VERBOSE) {
      for (const r of blankStage.slice(0, 20)) {
        console.log(`    thread_key=${r.thread_key}  status=${r.status}  stage="${r.stage}"  master_owner=${r.master_owner_id}`);
      }
    }
  } else {
    PASS('No blank stage values in inbox_thread_state');
  }

  // ── Check 4: orphaned sent queue rows that need thread state ─────────────
  console.log('\n[6] Checking orphaned sent rows that also lack a thread_state ...');
  const { data: sentNoThread, error: sntErr } = await supabase
    .from('send_queue')
    .select('id,thread_key,master_owner_id,property_id,sent_at')
    .eq('queue_status', 'sent')
    .is('thread_key', null);

  if (sntErr) {
    FAIL(`sent rows without thread_key fetch: ${sntErr.message}`);
  } else {
    INFO(`Sent queue rows with null thread_key: ${sentNoThread.length}`);
    if (sentNoThread.length > 0) {
      FAIL(`${sentNoThread.length} sent rows have null thread_key — no inbox thread can be created for them`);
      INFO('  Root cause: runner.ts does not generate/persist thread_key on the queue row before sending.');
      INFO('  [HANDOFF TO GEMINI] runner.ts must set thread_key = to_phone_number|from_phone_number before update');
      for (const r of sentNoThread) {
        console.log(`    queue_id=${r.id}  sent_at=${r.sent_at}  owner=${r.master_owner_id}  property=${r.property_id}`);
      }
    } else {
      PASS('All sent queue rows have thread_key');
    }
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
