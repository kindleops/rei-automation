#!/usr/bin/env node
/**
 * Repair: clear false suppression from rows where is_suppressed=true
 * but the suppression was caused by prospects.sms_eligible=false (a data-quality
 * flag, not a consent signal), not by a real opt-out/DNC/wrong-number event.
 *
 * Also removes the phantom ghost row that has 0 message_events and
 * is_suppressed=true with last_intent=null.
 *
 * Usage:
 *   node scripts/repair/fix-false-suppression.mjs          # dry-run (default)
 *   node scripts/repair/fix-false-suppression.mjs --apply  # mutate DB
 */

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../../.env') })
config({ path: resolve(__dirname, '../../.env.local'), override: true })

const isDryRun = !process.argv.includes('--apply')

const env = process.env
const SUPABASE_URL = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL / SUPABASE_KEY in .env.local')
  process.exit(1)
}
if (isDryRun === false && !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: --apply requires SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const TRUE_SUPPRESSION_INTENTS = ['opt_out', 'wrong_number', 'hostile', 'hostile_or_legal', 'legal_threat']

async function main() {
  console.log(`\n=== fix-false-suppression.mjs (${isDryRun ? 'DRY RUN' : 'APPLY'}) ===\n`)

  // ─── Baseline counts ──────────────────────────────────────────────────────

  const { count: totalSuppressed } = await supabase
    .from('inbox_thread_state')
    .select('*', { count: 'exact', head: true })
    .eq('is_suppressed', true)

  const { count: legitOptOut } = await supabase
    .from('inbox_thread_state')
    .select('*', { count: 'exact', head: true })
    .eq('is_suppressed', true)
    .in('last_intent', TRUE_SUPPRESSION_INTENTS)

  const { count: suppNoInbound } = await supabase
    .from('inbox_thread_state')
    .select('*', { count: 'exact', head: true })
    .eq('is_suppressed', true)
    .not('last_intent', 'in', `(${TRUE_SUPPRESSION_INTENTS.join(',')})`)

  console.log('─── Before counts ───────────────────────────────────')
  console.log(`  Total suppressed rows:                ${totalSuppressed}`)
  console.log(`  Suppressed with legit intent:         ${legitOptOut}`)
  console.log(`  Suppressed with non-suppression intent (candidates): ${suppNoInbound}`)

  // ─── Identify false positives ─────────────────────────────────────────────

  // Case A: suppressed but last_intent is not a true suppression signal
  const { data: falseByIntent, error: e1 } = await supabase
    .from('inbox_thread_state')
    .select('id, thread_key, last_intent, status, stage, updated_at')
    .eq('is_suppressed', true)
    .not('last_intent', 'in', `(${TRUE_SUPPRESSION_INTENTS.join(',')})`)

  if (e1) throw new Error(`Query failed: ${e1.message}`)

  // Case B: suppressed with null last_intent (phantom rows — check for 0 events)
  const { data: nullIntentRows } = await supabase
    .from('inbox_thread_state')
    .select('id, thread_key, last_intent, status, stage, updated_at')
    .eq('is_suppressed', true)
    .is('last_intent', null)

  // Filter phantom rows: those with 0 message_events
  const phantomRows = []
  for (const row of nullIntentRows || []) {
    const { count } = await supabase
      .from('message_events')
      .select('*', { count: 'exact', head: true })
      .eq('thread_key', row.thread_key)
    if (count === 0) phantomRows.push(row)
  }

  // Combine: false-by-intent + phantom (dedupe by id)
  const allFalseIds = new Set()
  const targets = []
  for (const row of [...(falseByIntent || []), ...phantomRows]) {
    if (!allFalseIds.has(row.id)) {
      allFalseIds.add(row.id)
      targets.push(row)
    }
  }

  console.log(`\n─── False positive rows identified: ${targets.length} ──────────────────`)
  for (const row of targets) {
    const isPhantom = phantomRows.some(p => p.id === row.id)
    console.log(`  thread_key: ${row.thread_key}`)
    console.log(`    last_intent: ${row.last_intent ?? 'null'}  status: ${row.status}  stage: ${row.stage}  phantom: ${isPhantom}`)
  }

  if (targets.length === 0) {
    console.log('\n✓ No false-positive suppressed rows found. Nothing to repair.')
    return
  }

  if (isDryRun) {
    console.log(`\n[DRY RUN] Would clear is_suppressed on ${targets.length} rows.`)
    console.log('  Phantom rows would be deleted (0 events, no activity).')
    console.log('  Non-phantom rows: is_suppressed=false; status/stage derived from re-run rebuild.')
    console.log('\nRun with --apply to commit changes.\n')
    return
  }

  // ─── Apply ────────────────────────────────────────────────────────────────

  let cleared = 0
  let deleted = 0
  const errors = []

  for (const row of targets) {
    const isPhantom = phantomRows.some(p => p.id === row.id)

    if (isPhantom) {
      // Phantom: no activity, safe to delete
      const { error } = await supabase
        .from('inbox_thread_state')
        .delete()
        .eq('id', row.id)
      if (error) {
        errors.push(`DELETE ${row.thread_key}: ${error.message}`)
      } else {
        deleted++
        console.log(`  ✓ Deleted phantom row ${row.thread_key}`)
      }
    } else {
      // False positive: clear suppression flag; rebuild script will set correct status
      const { error } = await supabase
        .from('inbox_thread_state')
        .update({
          is_suppressed: false,
          status: 'waiting',
          stage: row.stage === 'dead' ? 'ownership_check' : (row.stage || 'ownership_check'),
          automation_status: 'waiting',
          next_action: 'Waiting on seller'
        })
        .eq('id', row.id)
      if (error) {
        errors.push(`UPDATE ${row.thread_key}: ${error.message}`)
      } else {
        cleared++
        console.log(`  ✓ Cleared suppression on ${row.thread_key} (last_intent: ${row.last_intent})`)
      }
    }
  }

  // ─── After counts ─────────────────────────────────────────────────────────

  const { count: totalAfter } = await supabase
    .from('inbox_thread_state')
    .select('*', { count: 'exact', head: true })
    .eq('is_suppressed', true)

  const { count: legitAfter } = await supabase
    .from('inbox_thread_state')
    .select('*', { count: 'exact', head: true })
    .eq('is_suppressed', true)
    .in('last_intent', TRUE_SUPPRESSION_INTENTS)

  const { count: falseAfter } = await supabase
    .from('inbox_thread_state')
    .select('*', { count: 'exact', head: true })
    .eq('is_suppressed', true)
    .not('last_intent', 'in', `(${TRUE_SUPPRESSION_INTENTS.join(',')})`)

  console.log('\n─── After counts ────────────────────────────────────')
  console.log(`  Total suppressed rows:                ${totalAfter}`)
  console.log(`  Suppressed with legit intent:         ${legitAfter}`)
  console.log(`  Suppressed with non-suppression intent: ${falseAfter}`)
  console.log(`\n  Rows cleared (is_suppressed → false): ${cleared}`)
  console.log(`  Phantom rows deleted:                 ${deleted}`)

  if (errors.length > 0) {
    console.log(`\n  Errors (${errors.length}):`)
    errors.forEach(e => console.log(`    ✗ ${e}`))
  } else {
    console.log('\n✓ Repair complete with no errors.')
    console.log('\nNext step: run rebuild-thread-state for the cleared rows to compute correct status/stage:')
    console.log('  POST /api/internal/inbox/rebuild-thread-state { "include_suppressed": true, "apply": true }')
  }
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message)
  process.exit(1)
})
