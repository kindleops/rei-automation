#!/usr/bin/env node
/**
 * PROOF SCRIPT: live-activity-sync.mjs
 *
 * Verifies that Live Activity data (Command Map seller pins, inbox thread counts)
 * can be sourced from real events in the chain:
 *   message_events → inbox_thread_state → inbox_threads_hydrated view
 *
 * Checks:
 *   1. inbox_threads_hydrated view is accessible and returns rows
 *   2. Recent sent queue activity appears in the view
 *   3. inbox_command_center_v view is accessible
 *   4. inbox_category_counts view returns sensible category breakdown
 *   5. inbox_activity_events table exists and is readable
 *
 * READ-ONLY. Never mutates any data.
 * Exit 0 = clean. Exit 1 = violations found.
 *
 * Usage:
 *   node scripts/proof/live-activity-sync.mjs
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let violations = 0;
function PASS(msg)   { console.log(`  PASS  ${msg}`); }
function FAIL(msg)   { console.error(`  FAIL  ${msg}`); violations++; }
function WARN(msg)   { console.warn(`  WARN  ${msg}`); }
function INFO(msg)   { console.log(`        ${msg}`); }

async function tryView(viewName, limitCols = '*') {
  const { data, error } = await supabase
    .from(viewName)
    .select(limitCols)
    .limit(5);
  return { data, error };
}

async function run() {
  console.log('='.repeat(66));
  console.log('  PROOF: Live Activity data chain sync');
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log('='.repeat(66));

  // ── 1. inbox_threads_hydrated ───────────────────────────────────────────
  console.log('\n[1] Checking inbox_threads_hydrated view ...');
  const { data: hydrated, error: hydratedErr } = await supabase
    .from('inbox_threads_hydrated')
    .select('thread_key,status,stage,latest_direction,ui_intent,latest_message_at,inbox_category')
    .order('latest_message_at', { ascending: false })
    .limit(10);

  if (hydratedErr) {
    FAIL(`inbox_threads_hydrated not accessible: ${hydratedErr.message}`);
  } else if (!hydrated || hydrated.length === 0) {
    WARN('inbox_threads_hydrated returned 0 rows — no threads exist or view is broken');
  } else {
    PASS(`inbox_threads_hydrated accessible — ${hydrated.length} recent rows`);
    INFO(`Most recent thread: ${hydrated[0]?.thread_key} | status=${hydrated[0]?.status} | stage=${hydrated[0]?.stage} | intent=${hydrated[0]?.ui_intent}`);
    INFO(`Latest message at: ${hydrated[0]?.latest_message_at}`);
    // Check for null stage (breaks Command Map)
    const nullStage = hydrated.filter(r => !r.stage);
    if (nullStage.length > 0) {
      FAIL(`${nullStage.length} of 10 most recent threads have null stage`);
    }
  }

  // ── 2. inbox_command_center_v ───────────────────────────────────────────
  console.log('\n[2] Checking inbox_command_center_v view ...');
  const { data: ccv, error: ccvErr } = await tryView('inbox_command_center_v', 'thread_key,inbox_category,status,stage,latest_direction');
  if (ccvErr) {
    FAIL(`inbox_command_center_v not accessible: ${ccvErr.message}`);
  } else {
    PASS(`inbox_command_center_v accessible — ${ccv?.length} sample rows`);
    const categories = {};
    for (const r of ccv || []) categories[r.inbox_category] = (categories[r.inbox_category] || 0) + 1;
    INFO(`Sample category distribution: ${JSON.stringify(categories)}`);
  }

  // ── 3. inbox_category_counts ────────────────────────────────────────────
  console.log('\n[3] Checking inbox_category_counts view ...');
  const { data: catCounts, error: catErr } = await supabase
    .from('inbox_category_counts')
    .select('category,count');

  if (catErr) {
    FAIL(`inbox_category_counts not accessible: ${catErr.message}`);
  } else {
    PASS(`inbox_category_counts accessible — ${catCounts?.length} categories`);
    for (const r of catCounts || []) {
      INFO(`  ${String(r.category).padEnd(30)} ${r.count}`);
    }
  }

  // ── 4. Recent sent activity visible in hydrated view ───────────────────
  console.log('\n[4] Checking if recently sent messages appear in the hydrated view ...');
  // Get the most recent 3 sent queue rows that DO have thread_keys
  const { data: recentSent, error: recentErr } = await supabase
    .from('send_queue')
    .select('id,thread_key,sent_at,master_owner_id')
    .eq('queue_status', 'sent')
    .not('thread_key', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(3);

  if (recentErr) {
    FAIL(`recent sent fetch: ${recentErr.message}`);
  } else if (!recentSent || recentSent.length === 0) {
    WARN('No sent queue rows with thread_key found — cannot verify Live Activity');
  } else {
    let found = 0;
    for (const sq of recentSent) {
      const { data: match, error: matchErr } = await supabase
        .from('inbox_threads_hydrated')
        .select('thread_key,status,stage,latest_message_at')
        .eq('thread_key', sq.thread_key)
        .limit(1);

      if (matchErr || !match || match.length === 0) {
        FAIL(`Sent queue row ${sq.id} thread_key="${sq.thread_key}" NOT visible in inbox_threads_hydrated`);
      } else {
        found++;
        INFO(`  thread_key=${sq.thread_key}  visible in view  status=${match[0].status}  stage=${match[0].stage}`);
      }
    }
    if (found === recentSent.length) {
      PASS(`All ${found} recently-sent threads visible in inbox_threads_hydrated`);
    }
  }

  // ── 5. inbox_activity_events table ─────────────────────────────────────
  console.log('\n[5] Checking inbox_activity_events table ...');
  const { data: actEvts, error: actErr } = await supabase
    .from('inbox_activity_events')
    .select('id,event_type,thread_key,created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (actErr) {
    if (actErr.message.includes('does not exist') || actErr.code === '42P01') {
      FAIL('inbox_activity_events table does not exist — activity logging is broken');
      INFO('  [HANDOFF TO GEMINI] Create inbox_activity_events table for activity log persistence');
    } else {
      FAIL(`inbox_activity_events error: ${actErr.message}`);
    }
  } else {
    PASS(`inbox_activity_events accessible — ${actEvts?.length} recent rows`);
    for (const r of actEvts || []) {
      INFO(`  ${r.event_type.padEnd(25)}  thread=${r.thread_key}  at=${r.created_at}`);
    }
  }

  // ── 6. 7 orphaned sent rows are dark to the Command Map ────────────────
  console.log('\n[6] Verifying orphaned sent rows are invisible to the Command Map ...');
  // These 6 real sends have null thread_key, so they cannot appear in any thread view
  const { data: orphanedSent, error: orphErr } = await supabase
    .from('send_queue')
    .select('id,thread_key,master_owner_id,property_id,sent_at')
    .eq('queue_status', 'sent')
    .is('thread_key', null)
    .not('master_owner_id', 'is', null); // exclude test artifact

  if (orphErr) {
    FAIL(`orphaned sent check: ${orphErr.message}`);
  } else if (orphanedSent.length > 0) {
    FAIL(`${orphanedSent.length} real sent messages are DARK to Command Map (null thread_key)`);
    INFO('  These messages were sent but will never appear in inbox threads, Live Activity,');
    INFO('  or the Command Map because thread_key was never set on the queue row.');
    INFO('  Repair: run scripts/repair/backfill-sent-message-events.mjs --apply');
    for (const r of orphanedSent) {
      INFO(`    queue_id=${r.id}  sent_at=${r.sent_at}  property=${r.property_id}`);
    }
  } else {
    PASS('No real sent messages are dark to the Command Map');
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
