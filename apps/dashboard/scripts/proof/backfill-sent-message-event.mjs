#!/usr/bin/env node
/**
 * Backfill: create missing message_events row + inbox_thread_state for the
 * EST batch row that was successfully sent but had no event record due to
 * schema drift (auto_reply_queue_id / auto_reply_status missing from table).
 *
 * Safe to re-run — uses upsert on message_event_key / thread_key.
 * READ-MOSTLY with two targeted upserts.
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

const QUEUE_ROW_ID    = 'e2dba9b0-1383-4788-b3e5-007237432cee';
const QUEUE_KEY       = 'feed:99622cfdb14697515ce6358487cd14e6026d7829';
const MESSAGE_EVENT_KEY = `outbound_${QUEUE_KEY}`;
const THREAD_KEY      = '+13025077311';  // canonical E.164 phone — used as thread_key

console.log('\n======================================================');
console.log('  BACKFILL: message_events + inbox_thread_state');
console.log(`  DRY_RUN: ${DRY_RUN}`);
console.log('======================================================\n');

async function run() {
  // ── 1. Fetch the sent queue row ──────────────────────────────────────────
  const { data: row, error: rowErr } = await supabase
    .from('send_queue')
    .select('*')
    .eq('id', QUEUE_ROW_ID)
    .single();

  if (rowErr || !row) {
    console.error('Failed to fetch queue row:', rowErr?.message || 'not found');
    process.exit(1);
  }

  console.log('Queue row:', {
    id: row.id,
    queue_status: row.queue_status,
    sent_at: row.sent_at,
    textgrid_message_id: row.textgrid_message_id,
    to_phone_number: row.to_phone_number,
  });

  if (!row.textgrid_message_id || !row.sent_at) {
    console.error('Row has no textgrid_message_id or sent_at — not a completed send');
    process.exit(1);
  }

  // ── 2. Check if message_events row already exists ────────────────────────
  const { data: existing_me } = await supabase
    .from('message_events')
    .select('id, message_event_key, delivery_status')
    .eq('message_event_key', MESSAGE_EVENT_KEY)
    .maybeSingle();

  console.log('Existing message_event:', existing_me ? JSON.stringify(existing_me) : 'NONE');

  // ── 3. Build message_event payload (mirrors buildSuccessMessageEvent) ────
  const event_ts = row.sent_at;
  const me_payload = {
    message_event_key: MESSAGE_EVENT_KEY,
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
    thread_key: THREAD_KEY,
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
      queue_key: QUEUE_KEY,
      backfilled_at: new Date().toISOString(),
      backfill_reason: 'schema_drift_auto_reply_columns_missing',
      queue_row: { id: row.id, queue_key: row.queue_key, queue_status: row.queue_status },
    },
  };

  console.log('\n── message_event payload ──');
  console.log('  message_event_key:', me_payload.message_event_key);
  console.log('  provider_message_sid:', me_payload.provider_message_sid);
  console.log('  delivery_status:', me_payload.delivery_status);
  console.log('  thread_key:', me_payload.thread_key);
  console.log('  to_phone_number:', me_payload.to_phone_number);

  // ── 4. Upsert message_events ─────────────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n[DRY_RUN] Would upsert message_events — skipping write');
  } else {
    const { data: me_data, error: me_err } = await supabase
      .from('message_events')
      .upsert(me_payload, { onConflict: 'message_event_key', ignoreDuplicates: false })
      .select()
      .maybeSingle();

    if (me_err) {
      console.error('message_events upsert FAILED:', me_err.message, me_err.code);
      process.exit(1);
    }
    console.log('\n✓ message_events upserted:', me_data?.id || 'ok');
  }

  // ── 5. Build inbox_thread_state payload ──────────────────────────────────
  const now = new Date().toISOString();
  const its_payload = {
    thread_key: THREAD_KEY,
    seller_phone: row.to_phone_number,
    canonical_e164: row.to_phone_number,
    our_number: row.from_phone_number,
    master_owner_id: row.master_owner_id || null,
    prospect_id: row.prospect_id || null,
    property_id: row.property_id || null,
    market: row.market || null,
    stage: row.stage_after || row.stage_before || row.current_stage ||
           row.metadata?.selected_template_stage_code || 'S1',
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
      backfill_source: 'backfill-sent-message-event.mjs',
    },
  };

  console.log('\n── inbox_thread_state payload ──');
  console.log('  thread_key:', its_payload.thread_key);
  console.log('  latest_message_body:', its_payload.latest_message_body?.slice(0, 60));
  console.log('  latest_direction:', its_payload.latest_direction);
  console.log('  latest_message_at:', its_payload.latest_message_at);

  // ── 6. Upsert inbox_thread_state ─────────────────────────────────────────
  if (DRY_RUN) {
    console.log('\n[DRY_RUN] Would upsert inbox_thread_state — skipping write');
  } else {
    const { data: its_data, error: its_err } = await supabase
      .from('inbox_thread_state')
      .upsert(its_payload, { onConflict: 'thread_key' })
      .select()
      .maybeSingle();

    if (its_err) {
      console.error('inbox_thread_state upsert FAILED:', its_err.message, its_err.code);
      process.exit(1);
    }
    console.log('✓ inbox_thread_state upserted:', its_data?.id || 'ok');
  }

  // ── 7. Verify ─────────────────────────────────────────────────────────────
  if (!DRY_RUN) {
    const { data: me_check } = await supabase
      .from('message_events')
      .select('id,message_event_key,provider_message_sid,delivery_status,thread_key,direction,to_phone_number,sent_at')
      .eq('message_event_key', MESSAGE_EVENT_KEY)
      .maybeSingle();

    const { data: its_check } = await supabase
      .from('inbox_thread_state')
      .select('id,thread_key,latest_message_body,latest_direction,last_outbound_at,status')
      .eq('thread_key', THREAD_KEY)
      .maybeSingle();

    console.log('\n── VERIFY ──');
    console.log('message_events row:', me_check ? JSON.stringify(me_check, null, 2) : '❌ NOT FOUND');
    console.log('inbox_thread_state:', its_check ? JSON.stringify(its_check, null, 2) : '❌ NOT FOUND');

    const ok = me_check && its_check &&
               me_check.provider_message_sid === row.textgrid_message_id &&
               me_check.thread_key === THREAD_KEY;

    console.log('\n======================================================');
    console.log(ok ? '  RESULT: BACKFILL OK ✓' : '  RESULT: BACKFILL INCOMPLETE ✗');
    console.log('======================================================\n');

    process.exit(ok ? 0 : 1);
  }
}

run().catch(err => { console.error('BACKFILL ERROR:', err.message); process.exit(1); });
