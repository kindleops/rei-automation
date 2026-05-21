#!/usr/bin/env node
/**
 * Backfill: populate top-level send_queue visibility columns for the 10 EST rows
 * sent 2026-05-19 that are missing market/thread_key/city/state/zip/agent/etc.
 *
 * Source of truth: metadata.candidate_snapshot + metadata root-level fields.
 * Safe to re-run — only patches null/empty columns.
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

const ROW_IDS = [
  'e2dba9b0-1383-4788-b3e5-007237432cee',
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

function clean(value) {
  return String(value ?? '').trim();
}

console.log('\n======================================================');
console.log('  BACKFILL: send_queue visibility fields (10 EST rows)');
console.log(`  DRY_RUN: ${DRY_RUN}`);
console.log('======================================================\n');

async function run() {
  const { data: rows, error } = await supabase
    .from('send_queue')
    .select(`
      id, to_phone_number,
      market, thread_key, property_address_state, language,
      property_address_city, property_address_zip,
      agent_name, template_key, pipeline_stage, seller_status,
      use_case_template, property_type,
      metadata
    `)
    .in('id', ROW_IDS);

  if (error || !rows) {
    console.error('Failed to fetch rows:', error?.message || 'no data');
    process.exit(1);
  }

  console.log(`Fetched ${rows.length} of ${ROW_IDS.length} expected rows\n`);

  const results = [];

  for (const row of rows) {
    const meta = row.metadata || {};
    const snap = meta.candidate_snapshot || {};
    const tmpl = meta.template || {};

    // Derive values from metadata/snapshot
    const market           = clean(row.market || meta.seller_market || snap.seller_market);
    const thread_key       = clean(row.thread_key || row.to_phone_number);
    const state            = clean(row.property_address_state || snap.seller_state || meta.seller_state);
    const city             = clean(row.property_address_city || snap.property_address_city);
    const zip              = clean(row.property_address_zip || snap.property_address_zip);
    const agent_name       = clean(row.agent_name || snap.agent_name || meta.agent_name);
    const template_key     = clean(row.template_key || snap.template_key || tmpl.id || meta.selected_template_id);
    const pipeline_stage   = clean(row.pipeline_stage || snap.pipeline_stage || snap.stage_code);
    const seller_status    = clean(row.seller_status || snap.seller_status || snap.contact_status);
    const use_case_template = clean(row.use_case_template || snap.template_use_case || meta.template_use_case);

    console.log(`── ${row.id.slice(0,8)} | ${row.to_phone_number}`);
    console.log(`   market=${market||'—'} state=${state||'—'} city=${city||'—'} zip=${zip||'—'}`);
    console.log(`   agent=${agent_name||'—'} template_key=${template_key||'—'} pipeline_stage=${pipeline_stage||'—'}`);
    console.log(`   seller_status=${seller_status||'—'} use_case_template=${use_case_template||'—'}`);

    const patch = {};
    if (market           && !row.market)                patch.market                = market;
    if (thread_key       && !row.thread_key)            patch.thread_key            = thread_key;
    if (state            && !row.property_address_state) patch.property_address_state = state;
    if (city             && !row.property_address_city) patch.property_address_city = city;
    if (zip              && !row.property_address_zip)  patch.property_address_zip  = zip;
    if (agent_name       && !row.agent_name)            patch.agent_name            = agent_name;
    if (template_key     && !row.template_key)          patch.template_key          = template_key;
    if (pipeline_stage   && !row.pipeline_stage)        patch.pipeline_stage        = pipeline_stage;
    if (seller_status    && !row.seller_status)         patch.seller_status         = seller_status;
    if (use_case_template && !row.use_case_template)    patch.use_case_template     = use_case_template;
    patch.updated_at = new Date().toISOString();

    if (Object.keys(patch).length === 1) { // only updated_at
      console.log('   ✓ already fully populated — skip\n');
      results.push({ ok: true, reason: 'already_populated', id: row.id });
      continue;
    }

    if (DRY_RUN) {
      console.log(`   [DRY_RUN] Would patch: ${JSON.stringify(patch)}\n`);
      results.push({ ok: true, reason: 'dry_run', id: row.id });
      continue;
    }

    const { error: upd_err } = await supabase
      .from('send_queue')
      .update(patch)
      .eq('id', row.id);

    if (upd_err) {
      console.error(`   ✗ UPDATE FAILED: ${upd_err.message}\n`);
      results.push({ ok: false, reason: 'update_failed', id: row.id, error: upd_err.message });
    } else {
      console.log(`   ✓ patched ${Object.keys(patch).filter(k => k !== 'updated_at').join(', ')}\n`);
      results.push({ ok: true, reason: 'updated', id: row.id });
    }
  }

  console.log('======================================================');
  console.log('  SUMMARY');
  console.log('======================================================');
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`  ok: ${ok} / ${results.length}`);
  if (failed > 0) {
    results.filter(r => !r.ok).forEach(r =>
      console.log(`  FAILED: ${r.id} — ${r.reason} ${r.error || ''}`)
    );
  }

  if (!DRY_RUN) {
    console.log('\n── VERIFY ──');
    const { data: verify } = await supabase
      .from('send_queue')
      .select('id,to_phone_number,market,thread_key,property_address_state,property_address_city,agent_name,template_key,pipeline_stage,use_case_template')
      .in('id', ROW_IDS);

    const counts = {
      market:                verify?.filter(r => r.market).length ?? 0,
      thread_key:            verify?.filter(r => r.thread_key).length ?? 0,
      property_address_state: verify?.filter(r => r.property_address_state).length ?? 0,
      property_address_city:  verify?.filter(r => r.property_address_city).length ?? 0,
      agent_name:            verify?.filter(r => r.agent_name).length ?? 0,
      template_key:          verify?.filter(r => r.template_key).length ?? 0,
      pipeline_stage:        verify?.filter(r => r.pipeline_stage).length ?? 0,
      use_case_template:     verify?.filter(r => r.use_case_template).length ?? 0,
    };

    const total = ROW_IDS.length;
    for (const [col, count] of Object.entries(counts)) {
      const mark = count === total ? '✓' : '✗';
      console.log(`  ${mark} ${col}: ${count} / ${total}`);
    }

    console.log('\n  Per-row:');
    verify?.forEach(r =>
      console.log(`  ${r.to_phone_number} | market=${r.market||'—'} | state=${r.property_address_state||'—'} | city=${r.property_address_city||'—'} | agent=${r.agent_name||'—'} | tmpl=${r.template_key||'—'}`)
    );

    const all_critical_ok = counts.market === total && counts.thread_key === total && counts.property_address_state === total;
    console.log('\n======================================================');
    console.log(all_critical_ok ? '  RESULT: BACKFILL OK ✓' : '  RESULT: BACKFILL INCOMPLETE ✗');
    console.log('======================================================\n');
    process.exit(all_critical_ok ? 0 : 1);
  } else {
    console.log('\n[DRY_RUN complete — no writes performed]\n');
  }
}

run().catch(err => { console.error('BACKFILL ERROR:', err.message); process.exit(1); });
