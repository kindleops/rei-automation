#!/usr/bin/env node
/**
 * Backfill: create missing message_events + inbox_thread_state for the 9 EST
 * batch rows sent at 15:00 UTC on 2026-05-19 but missing bookkeeping rows due
 * to schema drift (auto_reply_status / auto_reply_queue_id missing at send time).
 *
 * Safe to re-run — uses upsert on message_event_key / thread_key.
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
      if (eqIdx < 1 || line.trim().startsWith('#')) return;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && !(key in env)) env[key] = val;
    });
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const DRY_RUN = process.argv.includes('--dry-run');

// The 9 queue rows sent at 15:00 UTC but missing message_events
const QUEUE_ROW_IDS = [
  '392c7fc5-11c9-4837-ad07-009592086223',
  '01db15b9-5178-40eb-ba3c-2506253b857c',
  '113487f4-4f0f-4d71-8895-b1b876ad3441',
  '52a728c1-b2b3-4793-babb-410a35fb7ff3',
  'b66c51c3-dcbc-4a77-9c7d-5dda26b317af',
  'f4d4394b-1801-4114-b899-81d77dfdfd1f',
  'beeac294-820f-4369-99e7-b1669f536b10',
  '766b9476-48a5-42b9-bc47-d4e099c573ed',
  '68e3cd1a-87b6-4793-acb5-5851d57f1150',
];

console.log('\n======================================================');
console.log('  BACKFILL: 9 message_events + inbox_thread_state');
console.log(`  DRY_RUN: ${DRY_RUN}`);
console.log('======================================================\n');

async function backfillRow(row) {
  const queue_key = row.queue_key;
  const message_event_key = `outbound_${queue_key}`;
  const thread_key = row.to_phone_number; // canonical E.164 as thread_key

  console.log(`\n── Row ${row.id.slice(0, 8)} | ${row.to_phone_number} ──`);
  console.log(`  queue_status: ${row.queue_status}`);
  console.log(`  textgrid_message_id: ${row.textgrid_message_id}`);
  console.log(`  sent_at: ${row.sent_at}`);

  if (!row.textgrid_message_id || !row.sent_at) {
    console.error(`  ✗ SKIP: no textgrid_message_id or sent_at`);
    return { ok: false, reason: 'missing_sid_or_sent_at', id: row.id };
  }

  // Check for existing message_events row
  const { data: existing_me } = await supabase
    .from('message_events')
    .select('id, message_event_key, delivery_status')
    .eq('message_event_key', message_event_key)
    .maybeSingle();

  if (existing_me) {
    console.log(`  ✓ SKIP: message_events row already exists: ${existing_me.id}`);
    return { ok: true, reason: 'already_exists', id: row.id, me_id: existing_me.id };
  }

  const event_ts = row.sent_at;
  const me_payload = {
    message_event_key,
    provider_message_sid: row.textgrid_message_id,
    direction: 'outbound',
    event_type: 'outbound_send',
    message_body: row.message_body,
    to_phone_number: row.to_phone_number,
    from_phone_number: row.from_phone_number,
    queue_id: row.id,
    sent_at: event_ts,
    event_timestamp: event_ts,
    created_at: event_ts,
    delivery_status: row.queue_status === 'delivered' ? 'delivered' : 'sent',
    provider_delivery_status: null,
    character_count: row.character_count || (row.message_body || '').length,
    latency_ms: null,
    master_owner_id: row.master_owner_id || null,
    prospect_id: row.prospect_id || null,
    property_id: row.property_id || null,
    market_id: row.market_id || null,
    market: row.market || null,
    sms_agent_id: row.sms_agent_id || null,
    textgrid_number_id: row.textgrid_number_id || null,
    template_id: row.template_id || null,
    property_address: row.property_address || null,
    thread_key,
    auto_reply_status: row.type === 'auto_reply' ? 'sent' : null,
    auto_reply_queue_id: row.type === 'auto_reply' ? String(row.id) : null,
    detected_intent: row.detected_intent || null,
    stage_before: row.stage_before || row.current_stage || null,
    stage_after: row.stage_after || row.current_stage || null,
    safety_status: row.safety_status || 'pending',
    risk: row.risk || 'low',
    priority: row.priority || 'normal',
    language: row.language || null,
    classification_confidence: null,
    metadata: {
      source: 'supabase_send_queue',
      queue_key,
      backfilled_at: new Date().toISOString(),
      backfill_reason: 'schema_drift_auto_reply_columns_missing',
      queue_row: { id: row.id, queue_key, queue_status: row.queue_status },
    },
  };

  if (DRY_RUN) {
    console.log('  [DRY_RUN] Would upsert message_events');
  } else {
    const { data: me_data, error: me_err } = await supabase
      .from('message_events')
      .upsert(me_payload, { onConflict: 'message_event_key', ignoreDuplicates: false })
      .select()
      .maybeSingle();

    if (me_err) {
      console.error(`  ✗ message_events upsert FAILED: ${me_err.message} (${me_err.code})`);
      return { ok: false, reason: 'me_upsert_failed', id: row.id, error: me_err.message };
    }
    console.log(`  ✓ message_events upserted: ${me_data?.id}`);
  }

  // inbox_thread_state
  const now = new Date().toISOString();
  const stage = row.stage_after || row.stage_before || row.current_stage ||
    row.metadata?.selected_template_stage_code || 'S1';

  const its_payload = {
    thread_key,
    seller_phone: row.to_phone_number,
    canonical_e164: row.to_phone_number,
    our_number: row.from_phone_number,
    master_owner_id: row.master_owner_id || null,
    prospect_id: row.prospect_id || null,
    property_id: row.property_id || null,
    market: row.market || null,
    stage,
    status: 'active',
    priority: row.priority || 'normal',
    is_read: true,
    last_intent: row.detected_intent || null,
    latest_reply_template_id: row.template_id || null,
    latest_message_body: row.message_body,
    latest_message_at: row.sent_at,
    latest_direction: 'outbound',
    latest_delivery_status: row.queue_status === 'delivered' ? 'delivered' : 'sent',
    last_outbound_at: row.sent_at,
    updated_at: now,
    metadata: {
      last_sync_at: now,
      backfilled_at: now,
      backfill_source: 'backfill-9-sent-message-events.mjs',
    },
  };

  if (DRY_RUN) {
    console.log(`  [DRY_RUN] Would upsert inbox_thread_state for ${thread_key}`);
    return { ok: true, reason: 'dry_run', id: row.id };
  }

  const { data: its_data, error: its_err } = await supabase
    .from('inbox_thread_state')
    .upsert(its_payload, { onConflict: 'thread_key' })
    .select()
    .maybeSingle();

  if (its_err) {
    console.error(`  ✗ inbox_thread_state upsert FAILED: ${its_err.message} (${its_err.code})`);
    return { ok: false, reason: 'its_upsert_failed', id: row.id, error: its_err.message };
  }
  console.log(`  ✓ inbox_thread_state upserted: ${its_data?.id} (stage=${stage})`);
  return { ok: true, reason: 'backfilled', id: row.id };
}

async function run() {
  // Fetch all 9 rows
  const { data: rows, error: rows_err } = await supabase
    .from('send_queue')
    .select('*')
    .in('id', QUEUE_ROW_IDS);

  if (rows_err || !rows) {
    console.error('Failed to fetch queue rows:', rows_err?.message || 'no data');
    process.exit(1);
  }

  console.log(`Fetched ${rows.length} of ${QUEUE_ROW_IDS.length} expected rows\n`);

  const results = [];
  for (const row of rows) {
    const r = await backfillRow(row);
    results.push(r);
  }

  console.log('\n======================================================');
  console.log('  BACKFILL SUMMARY');
  console.log('======================================================');
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`  ok: ${ok} / ${results.length}`);
  if (failed > 0) {
    console.log(`  FAILED: ${failed}`);
    results.filter(r => !r.ok).forEach(r =>
      console.log(`    - ${r.id}: ${r.reason} ${r.error || ''}`)
    );
  }

  if (!DRY_RUN) {
    // Final verification
    console.log('\n── VERIFY ──');
    const { data: me_check } = await supabase
      .from('message_events')
      .select('id, queue_id, delivery_status')
      .in('queue_id', QUEUE_ROW_IDS);

    console.log(`message_events rows found: ${me_check?.length || 0} / ${QUEUE_ROW_IDS.length}`);

    const missing_me = QUEUE_ROW_IDS.filter(id => !me_check?.some(me => me.queue_id === id));
    if (missing_me.length > 0) {
      console.log(`MISSING message_events for: ${missing_me.join(', ')}`);
    }

    const all_ok = ok === results.length && failed === 0 && (me_check?.length || 0) === QUEUE_ROW_IDS.length;
    console.log('\n======================================================');
    console.log(all_ok ? '  RESULT: BACKFILL OK ✓' : '  RESULT: BACKFILL INCOMPLETE ✗');
    console.log('======================================================\n');
    process.exit(all_ok ? 0 : 1);
  } else {
    console.log('\n[DRY_RUN complete — no writes performed]\n');
  }
}

run().catch(err => { console.error('BACKFILL ERROR:', err.message); process.exit(1); });
