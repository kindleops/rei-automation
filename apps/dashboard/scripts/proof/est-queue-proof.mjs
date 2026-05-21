#!/usr/bin/env node
/**
 * PROOF SCRIPT: est-queue-proof.mjs
 *
 * Outputs queue health metrics focused on EST outbound launch readiness.
 * READ-ONLY — never mutates any data.
 *
 * Usage:
 *   node scripts/proof/est-queue-proof.mjs
 *   node scripts/proof/est-queue-proof.mjs --verbose
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
      if (eqIdx < 1 || line.trim().startsWith('#')) return;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in env)) env[key] = val;
    });
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function isEasternTimezone(tz) {
  if (!tz) return false;
  const t = tz.toLowerCase();
  return t.includes('new_york') || t.includes('eastern') ||
    t === 'america/detroit' || t.startsWith('america/indiana/') ||
    t.startsWith('america/kentucky/') || t === 'et' || t === 'est' || t === 'edt';
}

const EST_STATES = new Set(['ny','nj','pa','md','va','de','ct','ri','ma','nh','vt','me',
  'dc','nc','sc','ga','fl','in','oh','mi','ky','tn','al','ms']);

const now = new Date();
const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
const suppressionWindowHours = 72;
const suppressionCutoff = new Date(now.getTime() - suppressionWindowHours * 60 * 60 * 1000);

console.log('\n======================================================');
console.log('  EST QUEUE PROOF  —  ' + now.toISOString());
console.log('======================================================\n');

async function run() {
  // ── 1. Load all send_queue rows (queued/scheduled/pending) ────────────────
  const { data: queueRows, error: queueErr } = await supabase
    .from('send_queue')
    .select('*')
    .in('queue_status', ['queued', 'scheduled', 'pending'])
    .order('scheduled_for_utc', { ascending: true })
    .limit(5000);

  if (queueErr) { console.error('send_queue query failed:', queueErr.message); process.exit(1); }

  const rows = queueRows || [];
  console.log(`Total active queue rows (queued/scheduled/pending): ${rows.length}`);

  // ── 2. Due counts ─────────────────────────────────────────────────────────
  const dueNow = rows.filter(r => {
    const sf = r.scheduled_for_utc ? new Date(r.scheduled_for_utc) : null;
    return !sf || sf <= now;
  });
  const dueNextHour = rows.filter(r => {
    const sf = r.scheduled_for_utc ? new Date(r.scheduled_for_utc) : null;
    return sf && sf > now && sf <= oneHourFromNow;
  });

  console.log(`\n── Due Counts ──`);
  console.log(`  due_now_count:        ${dueNow.length}`);
  console.log(`  due_next_hour_count:  ${dueNextHour.length}`);

  // ── 3. EST filter ─────────────────────────────────────────────────────────
  const estRows = rows.filter(r => {
    const tz = r.timezone || r.seller_timezone || '';
    const state = (r.seller_state || r.state_code || r.property_state || '').toLowerCase();
    return isEasternTimezone(tz) || EST_STATES.has(state);
  });
  console.log(`  scheduled_est_count:  ${estRows.length}`);

  // ── 4. Validity checks ────────────────────────────────────────────────────
  const invalidPhone = rows.filter(r => !normalizePhone(r.to_phone_number));
  const missingBody  = rows.filter(r => !r.message_body || String(r.message_body).trim() === '');
  const missingFrom  = rows.filter(r => !r.from_phone_number || String(r.from_phone_number).trim() === '');
  const suppressed   = rows.filter(r => r.suppressed || r.is_suppressed || r.opted_out || r.active_opt_out || r.dnc);

  console.log(`\n── Validity ──`);
  console.log(`  invalid_phone_count:       ${invalidPhone.length}`);
  console.log(`  missing_body_count:        ${missingBody.length}`);
  console.log(`  missing_from_number_count: ${missingFrom.length}`);
  console.log(`  suppressed_count:          ${suppressed.length}`);

  // ── 5. Duplicate owner+phone ──────────────────────────────────────────────
  const phoneSeen = new Map();
  let duplicateOwnerPhone = 0;
  for (const r of rows) {
    const key = `${r.master_owner_id || ''}:${normalizePhone(r.to_phone_number) || r.to_phone_number || ''}`;
    if (phoneSeen.has(key)) { duplicateOwnerPhone++; }
    else { phoneSeen.set(key, true); }
  }
  console.log(`  duplicate_owner_phone_count: ${duplicateOwnerPhone}`);

  // ── 6. Already contacted recently (check message_events) ─────────────────
  const phones = [...new Set(rows.map(r => r.to_phone_number).filter(Boolean))].slice(0, 2000);
  let alreadyContactedCount = 0;
  if (phones.length > 0) {
    const { data: recentEvents } = await supabase
      .from('message_events')
      .select('to_phone_number')
      .in('to_phone_number', phones.slice(0, 500))
      .eq('direction', 'outbound')
      .gte('created_at', suppressionCutoff.toISOString())
      .limit(2000);
    const recentPhones = new Set((recentEvents || []).map(e => e.to_phone_number));
    alreadyContactedCount = rows.filter(r => recentPhones.has(r.to_phone_number)).length;
  }
  console.log(`  already_contacted_recently_count (${suppressionWindowHours}h): ${alreadyContactedCount}`);

  // ── 7. By market ─────────────────────────────────────────────────────────
  const byMarket = {};
  for (const r of rows) {
    const m = r.market || r.filter_market || 'unknown';
    byMarket[m] = (byMarket[m] || 0) + 1;
  }
  console.log(`\n── queued_by_market ──`);
  Object.entries(byMarket).sort((a,b) => b[1]-a[1]).slice(0, 15).forEach(([m, n]) => {
    console.log(`  ${m.padEnd(30)} ${n}`);
  });

  // ── 8. By timezone ────────────────────────────────────────────────────────
  const byTz = {};
  for (const r of rows) {
    const tz = r.timezone || r.seller_timezone || 'unknown';
    byTz[tz] = (byTz[tz] || 0) + 1;
  }
  console.log(`\n── queued_by_timezone ──`);
  Object.entries(byTz).sort((a,b) => b[1]-a[1]).slice(0, 15).forEach(([tz, n]) => {
    console.log(`  ${tz.padEnd(35)} ${n}`);
  });

  // ── 9. First 20 due rows ─────────────────────────────────────────────────
  const first20 = [...dueNow, ...dueNextHour].slice(0, 20);
  console.log(`\n── first_20_due_rows ──`);
  if (first20.length === 0) {
    console.log('  (none due right now or in next hour)');
  } else {
    first20.forEach((r, i) => {
      const phone = normalizePhone(r.to_phone_number) || r.to_phone_number || 'NO PHONE';
      const from  = r.from_phone_number || 'NO FROM';
      const body  = r.message_body ? r.message_body.slice(0, 60) + '...' : 'NO BODY';
      const sf    = r.scheduled_for_utc || 'immediate';
      const tz    = r.timezone || r.seller_timezone || '?';
      console.log(`  [${i+1}] id=${r.id} status=${r.queue_status}`);
      console.log(`       to=${phone}  from=${from}`);
      console.log(`       scheduled=${sf}  tz=${tz}`);
      if (VERBOSE) console.log(`       body="${body}"`);
    });
  }

  // ── 10. Summary readiness gate ────────────────────────────────────────────
  console.log('\n======================================================');
  const ready = invalidPhone.length === 0 && missingBody.length === 0 &&
                missingFrom.length === 0 && (dueNow.length + dueNextHour.length) > 0;
  if (ready) {
    console.log('  RESULT: READY TO LAUNCH ✓');
    console.log(`  ${dueNow.length} due now + ${dueNextHour.length} due in next hour`);
  } else {
    console.log('  RESULT: NOT READY — see issues above');
    if (dueNow.length + dueNextHour.length === 0) console.log('  ✗ No rows due now or in next hour');
    if (invalidPhone.length > 0) console.log(`  ✗ ${invalidPhone.length} invalid phones`);
    if (missingBody.length > 0)  console.log(`  ✗ ${missingBody.length} missing message body`);
    if (missingFrom.length > 0)  console.log(`  ✗ ${missingFrom.length} missing from_phone_number`);
  }
  console.log('======================================================\n');

  process.exit(ready ? 0 : 1);
}

run().catch(err => { console.error('PROOF SCRIPT ERROR:', err.message); process.exit(1); });
