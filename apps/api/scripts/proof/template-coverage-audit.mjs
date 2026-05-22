#!/usr/bin/env node
/**
 * template-coverage-audit.mjs
 *
 * Audits sms_templates for live auto-reply coverage gaps.
 * Reports missing intents, missing safe_for_auto_reply flags,
 * and templates with ambiguous use_case.
 *
 * Usage:
 *   node apps/api/scripts/proof/template-coverage-audit.mjs
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
)

// Intents that must have auto-reply coverage
const REQUIRED_INTENTS = [
  { intent: 'ownership_confirmed', use_case: 'consider_selling' },
  { intent: 'asks_offer',          use_case: 'asking_price' },
  { intent: 'info_request',        use_case: 'who_is_this' },
  { intent: 'not_interested',      use_case: 'not_interested' },
  { intent: 'condition_signal',    use_case: 'price_high_condition_probe' },
  { intent: 'asking_price_value',  use_case: 'price_works_confirm_basics' },
]

const LANGUAGES = ['English', 'Spanish']

async function main() {
  const { data: templates, error } = await supabase
    .from('sms_templates')
    .select('id,template_id,template_name,use_case,language,is_active,safe_for_auto_reply,reply_mode,allowed_property_groups,template_body')
    .eq('is_active', true)

  if (error) {
    console.error('Failed to load sms_templates:', error.message)
    process.exit(1)
  }

  console.log(`\n=== TEMPLATE COVERAGE AUDIT (${templates.length} active templates) ===\n`)

  // ── 1. Check required intent coverage ───────────────────────────────────
  console.log('── 1. AUTO-REPLY INTENT COVERAGE ───────────────────────────────')
  for (const { intent, use_case } of REQUIRED_INTENTS) {
    for (const lang of LANGUAGES) {
      const matches = templates.filter(
        (t) => t.use_case === use_case && t.language === lang
      )
      const safeMatches = matches.filter((t) => t.safe_for_auto_reply === true)

      if (matches.length === 0) {
        console.log(`❌ MISSING  intent=${intent} use_case=${use_case} lang=${lang} — no templates`)
      } else if (safeMatches.length === 0) {
        console.log(`⚠️  UNSAFE   intent=${intent} use_case=${use_case} lang=${lang} — ${matches.length} templates but none have safe_for_auto_reply=true`)
      } else {
        console.log(`✅ COVERED  intent=${intent} use_case=${use_case} lang=${lang} — ${safeMatches.length} safe template(s)`)
      }
    }
  }

  // ── 2. Templates missing safe_for_auto_reply ─────────────────────────────
  const missingSafe = templates.filter((t) => t.safe_for_auto_reply === null || t.safe_for_auto_reply === undefined)
  console.log(`\n── 2. MISSING safe_for_auto_reply (${missingSafe.length}) ──────────────────`)
  for (const t of missingSafe.slice(0, 20)) {
    console.log(`   use_case=${t.use_case || '(none)'} lang=${t.language} id=${t.template_id || t.id}`)
  }
  if (missingSafe.length > 20) console.log(`   ... and ${missingSafe.length - 20} more`)

  // ── 3. Templates missing allowed_property_groups ─────────────────────────
  const missingGroups = templates.filter(
    (t) => t.safe_for_auto_reply === true && !t.allowed_property_groups?.length
  )
  console.log(`\n── 3. SAFE TEMPLATES MISSING allowed_property_groups (${missingGroups.length}) ──`)
  for (const t of missingGroups.slice(0, 10)) {
    console.log(`   use_case=${t.use_case || '(none)'} lang=${t.language} id=${t.template_id || t.id}`)
  }

  // ── 4. Templates with ambiguous use_case ─────────────────────────────────
  const ambiguous = templates.filter((t) => !t.use_case)
  console.log(`\n── 4. AMBIGUOUS (no use_case) (${ambiguous.length}) ─────────────────────`)
  for (const t of ambiguous.slice(0, 10)) {
    console.log(`   name=${t.template_name || '(none)'} lang=${t.language} id=${t.template_id || t.id}`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const safeCount = templates.filter((t) => t.safe_for_auto_reply === true).length
  console.log(`\n── SUMMARY ──────────────────────────────────────────────────────`)
  console.log(`   Total active templates:          ${templates.length}`)
  console.log(`   safe_for_auto_reply = true:      ${safeCount}`)
  console.log(`   safe_for_auto_reply = false:     ${templates.filter((t) => t.safe_for_auto_reply === false).length}`)
  console.log(`   safe_for_auto_reply = null:      ${missingSafe.length}`)
  console.log(`   Ambiguous (no use_case):         ${ambiguous.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
