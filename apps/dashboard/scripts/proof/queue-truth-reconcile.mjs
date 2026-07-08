#!/usr/bin/env node

/**
 * Read-only Queue truth reconciliation report.
 *
 * Emits COUNTS ONLY for the launch-automation-control-plane §1/§2 slice. It
 * performs NO writes and NO mutations — only `SELECT count(*)` (head requests)
 * plus one bounded id fetch for the cross-table check. Safe to run against
 * production for verification.
 *
 * Usage: node scripts/proof/queue-truth-reconcile.mjs
 */

import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load env from .env.local / .env (same convention as sibling proof scripts).
const env = {}
for (const f of ['.env.local', '.env']) {
  const p = path.join(__dirname, '../../', f)
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
}
const pick = (...keys) => keys.map((k) => env[k] || process.env[k]).find(Boolean)

const supabaseUrl = pick('SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
// Prefer the service key for accurate counts (bypasses RLS); fall back to anon.
const supabaseKey = pick('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY')

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase env (SUPABASE_URL + a key). No queries run.')
  process.exit(1)
}
const usingServiceKey = Boolean(pick('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY'))
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

const PROOF_OR = [
  'metadata->>dry_run.eq.true',
  'metadata->>proof_mode.eq.true',
  'metadata->>test_mode.eq.true',
  'metadata->>no_sms_transmit.eq.true',
  'metadata->>no_send.eq.true',
  'metadata->>proof_hydration.eq.true',
  'metadata->>proof_mode.eq.no_send',
  'metadata->>launch_mode.eq.proof_hydration_no_send',
].join(',')

async function count(label, build) {
  try {
    const { count, error } = await build(supabase.from('send_queue').select('*', { count: 'exact', head: true }))
    if (error) throw error
    return { label, value: count ?? 0 }
  } catch (error) {
    return { label, value: `ERR: ${error.message || error}` }
  }
}

async function countEvents(label, build) {
  try {
    const { count, error } = await build(supabase.from('message_events').select('*', { count: 'exact', head: true }))
    if (error) throw error
    return { label, value: count ?? 0 }
  } catch (error) {
    return { label, value: `ERR: ${error.message || error}` }
  }
}

async function main() {
  console.log('🧪 Queue Truth Reconciliation (READ-ONLY) — 0 mutations\n')
  console.log(`   key: ${usingServiceKey ? 'service_role (RLS bypassed)' : 'anon (RLS may limit counts)'}\n`)

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

  const rows = []
  const totalRow = await count('total_send_queue', (q) => q)
  rows.push(totalRow)
  rows.push(await count('sent_with_failed_reason', (q) => q.eq('queue_status', 'sent').not('failed_reason', 'is', null)))
  rows.push(await count('stuck_sent_gt_2h_no_terminal', (q) => q.eq('queue_status', 'sent').is('delivered_at', null).lt('created_at', twoHoursAgo)))
  rows.push(await count('sent_or_delivered_missing_provider_id', (q) => q.in('queue_status', ['sent', 'delivered']).is('provider_message_id', null).is('textgrid_message_id', null)))
  rows.push(await countEvents('outbound_events_missing_provider_sid', (q) => q.eq('direction', 'outbound').is('provider_message_sid', null)))
  rows.push(await countEvents('events_provider_sid_no_final_status', (q) => q.eq('direction', 'outbound').not('provider_message_sid', 'is', null).not('delivery_status', 'in', '("delivered","failed","undelivered","Delivered","Failed")')))
  const proofRow = await count('proof_test_rows', (q) => q.or(PROOF_OR))
  rows.push(proofRow)
  // Rows that REMAIN in the live operational queue after proof/test quarantine.
  if (typeof totalRow.value === 'number' && typeof proofRow.value === 'number') {
    rows.push({ label: 'live_rows_after_proof_quarantine', value: totalRow.value - proofRow.value })
  }

  // Cross-table: send_queue rows carrying a provider id with no matching message_event.
  let sqProviderNoEvent = 'skipped'
  try {
    const { data: sqRows, error } = await supabase
      .from('send_queue')
      .select('provider_message_id,textgrid_message_id')
      .or('provider_message_id.not.is.null,textgrid_message_id.not.is.null')
      .limit(20000)
    if (error) throw error
    const sids = [...new Set((sqRows || []).map((r) => r.provider_message_id || r.textgrid_message_id).filter(Boolean))]
    let missing = 0
    for (let i = 0; i < sids.length; i += 200) {
      const batch = sids.slice(i, i + 200)
      const { data: found } = await supabase.from('message_events').select('provider_message_sid').in('provider_message_sid', batch)
      const foundSet = new Set((found || []).map((r) => r.provider_message_sid))
      missing += batch.filter((s) => !foundSet.has(s)).length
    }
    sqProviderNoEvent = missing
  } catch (error) {
    sqProviderNoEvent = `ERR: ${error.message || error}`
  }
  rows.push({ label: 'send_queue_provider_id_no_message_event', value: sqProviderNoEvent })

  // Queue-status conflict breakdown.
  rows.push(await count('conflict_delivered_with_failed_reason', (q) => q.eq('queue_status', 'delivered').not('failed_reason', 'is', null)))
  rows.push(await count('conflict_sent_with_delivered_at', (q) => q.eq('queue_status', 'sent').not('delivered_at', 'is', null)))

  const width = Math.max(...rows.map((r) => r.label.length))
  for (const r of rows) console.log(`   ${r.label.padEnd(width)}  ${r.value}`)
  console.log('\n✅ Read-only report complete. Production mutations: 0. SMS sent: 0.')
}

main().catch((e) => { console.error(e); process.exit(1) })
