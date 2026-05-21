#!/usr/bin/env node
/**
 * Pipeline Stage Proof Script
 * Validates deterministic pipeline_stage / seller_status / seller_state derivation
 * in v_inbox_enriched against the required invariants.
 *
 * Usage: node scripts/proof/pipeline-stage-proof.mjs
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, '')]
    })
)

const supabase = createClient(
  env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

const pad = (s, n = 50) => String(s ?? '').padEnd(n)
const rpad = (s, n = 12) => String(s ?? '').padStart(n)

console.log('==================================================================')
console.log('  PIPELINE STAGE PROOF  —  v_inbox_enriched canonical derivation')
console.log(`  Run at: ${new Date().toISOString()}`)
console.log('==================================================================')

let violations = 0
const FAIL = (msg) => { console.log(`  FAIL  ${msg}`); violations++ }
const PASS = (msg) => console.log(`  PASS  ${msg}`)

// ── 1. Stage distribution ────────────────────────────────────────────────────
console.log('\n── 1. pipeline_stage distribution ─────────────────────────────────────')
{
  const { data } = await supabase.from('v_inbox_enriched')
    .select('pipeline_stage')
    .limit(10000)
  const dist = {}
  for (const r of (data ?? [])) dist[r.pipeline_stage] = (dist[r.pipeline_stage] ?? 0) + 1
  const total = Object.values(dist).reduce((a, b) => a + b, 0)
  console.log(`         Total rows: ${rpad(total)}`)
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1]))
    console.log(`           ${pad(k + ':', 30)} ${rpad(v)}`)

  const stages = Object.keys(dist)
  if (stages.length >= 3) PASS(`pipeline_stage diversity — ${stages.length} distinct stages`)
  else FAIL(`pipeline_stage diversity — only ${stages.length} stages (expected ≥ 3)`)
}

// ── 2. Status distribution ───────────────────────────────────────────────────
console.log('\n── 2. seller_status distribution ───────────────────────────────────────')
{
  const { data } = await supabase.from('v_inbox_enriched')
    .select('seller_status')
    .limit(10000)
  const dist = {}
  for (const r of (data ?? [])) dist[r.seller_status] = (dist[r.seller_status] ?? 0) + 1
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1]))
    console.log(`           ${pad(k + ':', 30)} ${rpad(v)}`)
}

// ── 3. Invariant checks ──────────────────────────────────────────────────────
console.log('\n── 3. Invariant violation checks ───────────────────────────────────────')

// 3a: No inbound_count > 0 stuck in ownership_check
{
  const { count } = await supabase.from('v_inbox_enriched')
    .select('*', { count: 'exact', head: true })
    .gt('inbound_count', 0)
    .eq('pipeline_stage', 'ownership_check')
  if (count === 0) PASS(`inbound_count > 0 NOT in ownership_check — 0 violations`)
  else FAIL(`${count} rows have inbound_count > 0 but pipeline_stage = ownership_check`)
}

// 3b: Positive intent not in ownership_check
{
  const { count } = await supabase.from('v_inbox_enriched')
    .select('*', { count: 'exact', head: true })
    .eq('seller_state', 'positive_intent')
    .eq('pipeline_stage', 'ownership_check')
  if (count === 0) PASS(`positive_intent NOT in ownership_check — 0 violations`)
  else FAIL(`${count} positive_intent rows stuck in ownership_check`)
}

// 3c: Asking price in price_discovery (except suppressed)
{
  const { count } = await supabase.from('v_inbox_enriched')
    .select('*', { count: 'exact', head: true })
    .eq('ui_intent', 'asking_price_provided')
    .neq('pipeline_stage', 'price_discovery')
    .eq('is_suppressed', false)
  if (count === 0) PASS(`asking_price_provided (non-suppressed) all in price_discovery`)
  else FAIL(`${count} non-suppressed asking_price_provided rows NOT in price_discovery`)
}

// 3d: Seller replied in active_communication or better (not ownership_check)
{
  const { count } = await supabase.from('v_inbox_enriched')
    .select('*', { count: 'exact', head: true })
    .gt('inbound_count', 0)
    .not('pipeline_stage', 'in', '("active_communication","price_discovery","interest_probe","dead_suppressed")')
  if (count === 0) PASS(`all inbound threads in active_communication or deeper stage`)
  else FAIL(`${count} inbound threads not in active_communication or deeper`)
}

// 3e: Suppressed/opt_out in dead_suppressed
{
  const { count } = await supabase.from('v_inbox_enriched')
    .select('*', { count: 'exact', head: true })
    .or('is_suppressed.eq.true,ui_intent.in.("opt_out","wrong_number")')
    .neq('pipeline_stage', 'dead_suppressed')
  if (count === 0) PASS(`suppressed/opt_out/wrong_number all in dead_suppressed`)
  else FAIL(`${count} suppressed rows NOT in dead_suppressed`)
}

// 3f: No inbound thread has seller_status = 'new' or 'not_contacted'
{
  const { count } = await supabase.from('v_inbox_enriched')
    .select('*', { count: 'exact', head: true })
    .gt('inbound_count', 0)
    .in('seller_status', ['not_contacted', 'ownership_check_sent'])
  if (count === 0) PASS(`no inbound thread has seller_status = not_contacted/ownership_check_sent`)
  else FAIL(`${count} inbound threads still show not_contacted or ownership_check_sent status`)
}

// ── 4. Sample rows ───────────────────────────────────────────────────────────
console.log('\n── 4. Sample rows (20) with key signals ────────────────────────────────')
{
  const { data } = await supabase.from('v_inbox_enriched')
    .select('thread_key,ui_intent,inbound_count,outbound_count,pipeline_stage,seller_status,seller_state,latest_message_body')
    .order('latest_message_at', { ascending: false, nullsFirst: false })
    .limit(20)

  for (const r of (data ?? [])) {
    const key = (r.thread_key ?? '').slice(-16)
    const snippet = (r.latest_message_body ?? '').slice(0, 30).replace(/\n/g, ' ')
    console.log(
      `  ${pad(key, 20)} | ${pad(r.ui_intent, 22)} | in:${String(r.inbound_count).padStart(2)} out:${String(r.outbound_count).padStart(2)}` +
      ` | ${pad(r.pipeline_stage, 20)} | ${pad(r.seller_status, 22)} | "${snippet}"`
    )
  }
}

// ── Result ───────────────────────────────────────────────────────────────────
console.log('\n==================================================================')
if (violations === 0) {
  console.log('  RESULT: ALL CHECKS PASSED — pipeline stage derivation is correct')
} else {
  console.log(`  RESULT: ${violations} VIOLATION(S) FOUND — see FAIL lines above`)
}
console.log('==================================================================\n')
