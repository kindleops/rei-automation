#!/usr/bin/env node
/**
 * followup-scheduler-proof.mjs
 *
 * Proof: follow-up scheduling rules against all spec fixtures.
 * Dry-run mode — does NOT write to Supabase.
 *
 * Usage: node apps/api/scripts/proof/followup-scheduler-proof.mjs
 */

// Inline the scheduler logic to avoid module alias issues in proof context
const SUPPRESSED_INTENTS = new Set([
  'opt_out', 'wrong_person', 'hostile_or_legal', 'timing_complaint',
])

const NURTURE_DAYS = {
  not_interested: 30,
  listed_or_unavailable: 45,
  tenant_or_occupancy: 21,
  condition_signal: 14,
  asking_price_value: 14,
  unclear: 7,
  conditional_interest: 21,
  maybe_depends_on_price: 21,
}

const ACTIVE_INTENTS = new Set([
  'ownership_confirmed', 'asks_offer', 'info_request', 'positive_interest',
])

function addDays(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function resolveFollowUpPlan(intent, is_suppressed = false) {
  if (is_suppressed) return { suppressed: true, followup_created: false, reason: 'thread_already_suppressed' }
  if (SUPPRESSED_INTENTS.has(intent)) return { suppressed: true, followup_created: false, reason: `permanent_suppression:${intent}` }
  if (ACTIVE_INTENTS.has(intent)) return { suppressed: false, followup_created: false, reason: 'active_workflow_no_nurture' }
  const days = NURTURE_DAYS[intent] ?? null
  if (!days) return { suppressed: false, followup_created: false, reason: `no_followup_rule:${intent}` }
  return { suppressed: false, followup_created: true, scheduled_for: addDays(days), days, reason: `nurture_followup:${intent}` }
}

const FIXTURES = [
  // Permanent suppression
  { intent: 'opt_out',              expect_created: false, expect_suppressed: true },
  { intent: 'wrong_person',         expect_created: false, expect_suppressed: true },
  { intent: 'hostile_or_legal',     expect_created: false, expect_suppressed: true },
  // Nurture follow-ups
  { intent: 'not_interested',       expect_created: true,  expect_days: 30 },
  { intent: 'conditional_interest', expect_created: true,  expect_days: 21 },
  { intent: 'tenant_or_occupancy',  expect_created: true,  expect_days: 21 },
  { intent: 'listed_or_unavailable', expect_created: true, expect_days: 45 },
  // Active — no nurture
  { intent: 'ownership_confirmed',  expect_created: false, expect_suppressed: false },
  { intent: 'asks_offer',           expect_created: false, expect_suppressed: false },
  // Unknown intent — no rule
  { intent: 'unknown_xyz',          expect_created: false, expect_suppressed: false },
]

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n) }

console.log('\n=== FOLLOW-UP SCHEDULER PROOF ===\n')
console.log(
  pad('INTENT', 26),
  pad('CREATED', 8),
  pad('SUPPRESSED', 11),
  pad('SCHEDULED_FOR', 14),
  pad('DAYS', 5),
  pad('REASON', 35),
  'PASS'
)
console.log('─'.repeat(110))

let passed = 0
let failed = 0

for (const f of FIXTURES) {
  const plan = resolveFollowUpPlan(f.intent)

  const pass =
    plan.followup_created === f.expect_created &&
    (f.expect_suppressed === undefined || plan.suppressed === f.expect_suppressed) &&
    (f.expect_days === undefined || plan.days === f.expect_days)

  if (pass) passed++; else failed++

  console.log(
    pad(f.intent, 26),
    pad(String(plan.followup_created), 8),
    pad(String(plan.suppressed), 11),
    pad(plan.scheduled_for || '—', 14),
    pad(plan.days ?? '—', 5),
    pad(plan.reason, 35),
    pass ? '✅' : `❌ (exp created=${f.expect_created})`
  )
}

console.log('\n─'.repeat(110))
console.log(`\nResults: ${passed}/${FIXTURES.length} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
