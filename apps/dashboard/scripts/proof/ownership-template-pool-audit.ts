/**
 * Audits ownership_check template catalog vs map picker eligibility.
 * Run: npx tsx scripts/proof/ownership-template-pool-audit.ts
 */
import * as dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import {
  buildOwnershipTemplatePool,
  evaluateOwnershipTemplate,
} from '../../src/views/map/seller-card/ownership-check-template-picker'
import { normalizeSmsTemplate } from '../../src/lib/data/templateData'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '../../.env.local') })

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or key')
  process.exit(1)
}

const supabase = createClient(url, key)

const sampleContext = {
  seller_first_name: 'Maria',
  seller_name: 'Maria',
  owner_name: 'Maria Lopez',
  property_address: '123 Main St, Miami, FL 33101',
  property_city: 'Miami',
  property_state: 'FL',
  property_zip: '33101',
  city: 'Miami',
  zip: '33101',
  county: 'Miami-Dade',
  agent_name: 'Chris',
  agent_first_name: 'Chris',
}

const REJECTION_CHECKS: Array<{ name: string; test: (t: ReturnType<typeof normalizeSmsTemplate>) => boolean }> = []

async function main() {
  const { data, error } = await supabase
    .from('sms_templates')
    .select('*')
    .eq('use_case', 'ownership_check')
    .eq('is_active', true)
    .limit(5000)

  if (error) {
    console.error('Query failed:', error.message)
    process.exit(1)
  }

  const templates = (data || []).map(normalizeSmsTemplate)
  console.log(`Active ownership_check templates: ${templates.length}`)

  const byLanguage = new Map<string, number>()
  for (const t of templates) {
    byLanguage.set(t.language, (byLanguage.get(t.language) || 0) + 1)
  }
  console.log('By language:', Object.fromEntries([...byLanguage.entries()].sort()))

  const weights = templates.map((t) => Number(t.raw.traffic_weight ?? t.raw.metadata?.traffic_weight ?? 1) || 1)
  const highWeight = templates.filter((_, i) => weights[i] > 5)
  console.log(`Templates with traffic_weight > 5: ${highWeight.length}`)
  if (highWeight.length) {
    console.log('High-weight sample:', highWeight.slice(0, 5).map((t) => ({
      id: t.templateId || t.id,
      weight: t.raw.traffic_weight,
      lang: t.language,
      text: t.templateText.slice(0, 60),
    })))
  }

  const pool = buildOwnershipTemplatePool(templates, sampleContext, 'English')
  console.log(`\nEnglish pool size (Maria/Chris context): ${pool.length}`)

  const rejectionReasons = new Map<string, number>()
  const englishTemplates = templates.filter((t) => t.language === 'English')
  for (const template of englishTemplates) {
    const result = evaluateOwnershipTemplate(template, sampleContext)
    if (result) continue

    const { renderedText, missingVariables } = await import('../../src/lib/data/templateData').then((m) =>
      m.renderTemplate(template, sampleContext),
    )
    const rendered = renderedText.trim()
    let reason = 'unknown'
    if (!rendered) reason = 'empty_render'
    else if (/^(Hello|Hi|Hey|Hola|Ola|Marhaba)\s*,/.test(rendered)) reason = 'blank_greeting'
    else if (/^(hi|hey|hello|hola|ola|marhaba)\s+there\b/i.test(rendered)) reason = 'hi_there'
    else if (/\[\[[a-z0-9_]+\]\]/i.test(rendered) || /\{\{[^}]+\}\}/.test(rendered)) reason = 'unresolved_tokens'
    else if (missingVariables.length) reason = `missing_vars:${missingVariables.join(',')}`
    else if (/\bright person\b|\bwho handles\b|\btrying to reach\b|\bhad a quick question\b|\bare you connected with\b/i.test(rendered)) reason = 'generic_wording'
    else reason = 'other_guard'
    rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1)
  }

  console.log('\nEnglish rejection breakdown:')
  for (const [reason, count] of [...rejectionReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`)
  }

  if (pool.length) {
    console.log('\nEligible English template IDs:', pool.map((p) => p.templateKey).join(', '))
  }

  for (const lang of ['Spanish', 'Mandarin']) {
    const langPool = buildOwnershipTemplatePool(templates, sampleContext, lang)
    console.log(`\n${lang} pool size: ${langPool.length}`)
  }

  const failedEnglish = englishTemplates.filter((t) => !evaluateOwnershipTemplate(t, sampleContext))
  console.log('\nRejected English templates:')
  for (const template of failedEnglish) {
    const { renderTemplate } = await import('../../src/lib/data/templateData')
    const { renderedText, missingVariables } = renderTemplate(template, sampleContext)
    console.log(`- ${template.templateId || template.id}: missing=[${missingVariables.join(',')}] text=${template.templateText.slice(0, 90)}`)
    console.log(`  rendered=${renderedText.slice(0, 90)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})