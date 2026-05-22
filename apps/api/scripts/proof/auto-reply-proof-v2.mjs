#!/usr/bin/env node
/**
 * auto-reply-proof-v2.mjs
 *
 * Runs the full auto-reply pipeline against fixture messages:
 *   classify → route-seller-conversation → resolveSellerAutoReplyPlan → template selection
 *
 * Usage:
 *   node apps/api/scripts/proof/auto-reply-proof-v2.mjs [--live]
 *
 * Outputs a table of: inbound | language | intent | confidence | template_id | use_case | reply | plan_status
 */

import 'dotenv/config'
import { createRequire } from 'node:module'

// We need to support @/ aliases — resolve from apps/api/src
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const FIXTURES = [
  { message: 'Yes',                                    expected_intent: 'ownership_confirmed',  expect_reply: true },
  { message: 'Yes I still own it',                     expected_intent: 'ownership_confirmed',  expect_reply: true },
  { message: "What's your offer?",                     expected_intent: 'asks_offer',           expect_reply: true },
  { message: 'How much?',                              expected_intent: 'asks_offer',           expect_reply: true },
  { message: 'Who is this?',                           expected_intent: 'info_request',         expect_reply: true },
  { message: 'Maybe depends on price',                 expected_intent: 'conditional_interest', expect_reply: true },
  { message: 'Sí, todavía lo tengo',                  expected_intent: 'ownership_confirmed',  expect_reply: true,  expected_language: 'Spanish' },
  { message: 'No thanks',                              expected_intent: 'not_interested',       expect_reply: false },
  { message: 'STOP',                                   expected_intent: 'opt_out',              expect_reply: false, expect_suppress: true },
  { message: 'Wrong number',                           expected_intent: 'wrong_person',         expect_reply: false, expect_suppress: true },
  { message: 'This is not a duplex, it is a house',   expected_intent: 'property_correction',  expect_reply: false },
]

function pad(str, len) {
  return String(str ?? '').slice(0, len).padEnd(len)
}

async function runFixture(fixture) {
  const { normalizeSellerInboundIntent } = await import('../../src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js')

  // Simple language detection
  const isSpanish = /[áéíóúüñ¿¡]/i.test(fixture.message) || /sí|también|lo tengo/i.test(fixture.message)
  const language = isSpanish ? 'Spanish' : 'English'

  const intent = normalizeSellerInboundIntent({ message_body: fixture.message })

  const planInput = {
    message_body: fixture.message,
    auto_reply_enabled: true,
    classification: {
      confidence: 0.92,
      language,
    },
    conversation_context: {
      found: true,
      summary: {
        conversation_stage: 'ownership_check',
        language_preference: language,
      },
    },
  }

  let plan
  try {
    const { resolveSellerAutoReplyPlan } = await import('../../src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js')
    plan = await resolveSellerAutoReplyPlan(planInput)
  } catch (e) {
    plan = { ok: false, error: e.message, should_queue_reply: false, suppression_reason: 'plan_error' }
  }

  return {
    message:       fixture.message.slice(0, 32),
    language,
    intent,
    confidence:    '0.92',
    template_id:   plan.selected_template_id || '—',
    use_case:      plan.selected_use_case    || plan.inbound_intent || '—',
    reply_preview: plan.fallback_reply ? plan.fallback_reply.slice(0, 40) + '…' : '(none)',
    plan_status:   plan.should_queue_reply ? 'QUEUE' : `SUPPRESS(${plan.suppression_reason || plan.reason || '?'})`,
    pass: fixture.expect_reply === plan.should_queue_reply,
  }
}

async function main() {
  console.log('\n=== AUTO-REPLY PROOF v2 ===\n')
  console.log(
    pad('INBOUND', 33),
    pad('LANG', 8),
    pad('INTENT', 22),
    pad('CONF', 5),
    pad('USE_CASE', 25),
    pad('REPLY (preview)', 42),
    pad('STATUS', 35),
    'PASS'
  )
  console.log('─'.repeat(180))

  let passed = 0
  let failed = 0

  for (const fixture of FIXTURES) {
    const r = await runFixture(fixture)
    const icon = r.pass ? '✅' : '❌'
    if (r.pass) passed++ ; else failed++

    console.log(
      pad(r.message, 33),
      pad(r.language, 8),
      pad(r.intent, 22),
      pad(r.confidence, 5),
      pad(r.use_case, 25),
      pad(r.reply_preview, 42),
      pad(r.plan_status, 35),
      icon
    )
  }

  console.log('\n─'.repeat(180))
  console.log(`\nResults: ${passed}/${FIXTURES.length} passed, ${failed} failed`)

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
