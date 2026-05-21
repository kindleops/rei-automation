#!/usr/bin/env node
/**
 * REPAIR SCRIPT: backfill-message-event-thread-keys.mjs
 *
 * Repairs existing message_events rows where thread_key is null or blank.
 *
 * Rules:
 * - dry-run default
 * - --apply required to mutate
 * - For message_events missing thread_key:
 *   - derive thread_key from to_phone_number + '|' + from_phone_number when both exist
 *   - if queue_id exists, fallback to send_queue.thread_key
 *   - if still missing, report unresolved
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

const IS_APPLY = process.argv.includes('--apply');
const VERBOSE  = process.argv.includes('--verbose');

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
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_KEY');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function deriveThreadKey(toPhone, fromPhone, direction) {
  if (!toPhone || !fromPhone) return null;
  // Canonical format: seller_phone|our_phone
  if (direction === 'inbound') {
    // from = seller, to = us
    return `${fromPhone}|${toPhone}`;
  } else {
    // from = us, to = seller
    return `${toPhone}|${fromPhone}`;
  }
}

async function run() {
  console.log('='.repeat(66));
  console.log('  REPAIR: backfill-message-event-thread-keys');
  console.log(`  Mode: ${IS_APPLY ? 'LIVE APPLY' : 'DRY RUN'}`);
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log('='.repeat(66));

  // 1. Fetch message_events missing thread_key
  console.log('\n[1] Fetching message_events with null/blank thread_key ...');
  const { data: events, error: evtErr } = await supabase
    .from('message_events')
    .select('id,queue_id,to_phone_number,from_phone_number,direction,created_at')
    .or('thread_key.is.null,thread_key.eq.""');

  if (evtErr) {
    console.error('FATAL: message_events fetch failed:', evtErr.message);
    process.exit(1);
  }

  console.log(`  Found ${events.length} rows missing thread_key`);

  if (events.length === 0) {
    console.log('  Nothing to repair.');
    process.exit(0);
  }

  // 2. Try to resolve each
  let repaired = 0;
  let unresolved = 0;
  let errors = 0;

  for (const evt of events) {
    let toPhone = evt.to_phone_number;
    let fromPhone = evt.from_phone_number;
    let source = 'phone_pair';

    if (!fromPhone && evt.queue_id) {
      // Try fetching from send_queue
      const { data: sqData } = await supabase
        .from('send_queue')
        .select('from_phone_number,thread_key')
        .eq('id', evt.queue_id)
        .single();
      
      if (sqData) {
        if (sqData.from_phone_number) {
          fromPhone = sqData.from_phone_number;
          source = 'send_queue_phones';
        }
        // If send_queue already has a thread_key, that's even better
        if (sqData.thread_key) {
          console.log(`  ${IS_APPLY ? 'REPAIRING' : 'WOULD REPAIR'} event_id=${evt.id}`);
          console.log(`    thread_key: ${sqData.thread_key} (direct from send_queue)`);
          
          if (IS_APPLY) {
            const { error: updErr } = await supabase
              .from('message_events')
              .update({ 
                thread_key: sqData.thread_key, 
                from_phone_number: fromPhone, // backfill this too if we got it
                updated_at: new Date().toISOString() 
              })
              .eq('id', evt.id);
            
            if (updErr) {
              console.error(`    ERROR updating: ${updErr.message}`);
              errors++;
              continue;
            }
            console.log(`    SUCCESS`);
            repaired++;
            continue;
          } else {
            repaired++;
            continue;
          }
        }
      }
    }

    let threadKey = deriveThreadKey(toPhone, fromPhone, evt.direction);

    if (threadKey) {
      console.log(`  ${IS_APPLY ? 'REPAIRING' : 'WOULD REPAIR'} event_id=${evt.id}`);
      console.log(`    thread_key: ${threadKey} (derived via ${source})`);
      console.log(`    phones:     to=${toPhone} from=${fromPhone}`);
      console.log(`    direction:  ${evt.direction}`);

      if (IS_APPLY) {
        const { error: updErr } = await supabase
          .from('message_events')
          .update({ 
            thread_key: threadKey, 
            from_phone_number: fromPhone, // backfill if it was missing
            updated_at: new Date().toISOString() 
          })
          .eq('id', evt.id);
        
        if (updErr) {
          console.error(`    ERROR updating: ${updErr.message}`);
          errors++;
        } else {
          console.log(`    SUCCESS`);
          repaired++;
        }
      } else {
        repaired++;
      }
    } else {
      console.warn(`  UNRESOLVED event_id=${evt.id}`);
      console.warn(`    phones missing or invalid. to=${toPhone} from=${fromPhone}`);
      unresolved++;
    }
  }

  console.log('\n' + '='.repeat(66));
  console.log('  SUMMARY');
  console.log(`  Processed:    ${events.length}`);
  console.log(`  Repaired:     ${repaired}`);
  console.log(`  Unresolved:   ${unresolved}`);
  console.log(`  Errors:       ${errors}`);
  console.log('='.repeat(66));
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(2); });
