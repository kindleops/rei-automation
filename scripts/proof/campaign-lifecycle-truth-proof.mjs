#!/usr/bin/env node
/**
 * Campaign lifecycle truth proof — Miami test campaign.
 * Run from apps/api:
 *   node --env-file=.env.local --import ./tests/register-aliases.mjs ../../scripts/proof/campaign-lifecycle-truth-proof.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAMPAIGN_ID = process.env.PROOF_CAMPAIGN_ID || '320c798a-84c9-45b8-a7c9-d166ddd7bd46'

function loadEnv() {
  const envPath = resolve(__dirname, '../../apps/api/.env.local')
  const text = readFileSync(envPath, 'utf8')
  const env = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return env
}

const env = loadEnv()
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function countQueue(campaignId) {
  const { count } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  return Number(count || 0)
}

async function readCampaign() {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id,name,status,queued_count,sent_count,last_transition_from,last_transition_reason')
    .eq('id', CAMPAIGN_ID)
    .single()
  if (error) throw error
  return data
}

async function main() {
  const { applyCampaignLifecycleAction, getCampaign } = await import('../../apps/api/src/lib/domain/campaigns/campaign-automation-service.js')

  const before = await readCampaign()
  const queueBefore = await countQueue(CAMPAIGN_ID)
  console.log('BEFORE', { campaign: before, queue_rows_total: queueBefore })

  const activate = await applyCampaignLifecycleAction(CAMPAIGN_ID, {
    action: 'activate',
    activation_idempotency_key: `proof:${Date.now()}`,
    no_send: true,
    reason: 'proof:lifecycle_idempotent_activate',
  }, { supabase })

  const afterActivate = await readCampaign()
  const queueAfter = await countQueue(CAMPAIGN_ID)
  console.log('ACTIVATE', { http_ok: activate.ok, idempotent: activate.idempotent, from: activate.from, to: activate.to, error: activate.error, inserted: activate.inserted })
  console.log('AFTER_ACTIVATE', { campaign: afterActivate, queue_rows_total: queueAfter, queue_delta: queueAfter - queueBefore })

  const reschedule = await applyCampaignLifecycleAction(CAMPAIGN_ID, {
    action: 'schedule',
    reschedule: true,
    scheduled_for: new Date(Date.now() + 86400000).toISOString(),
  }, { supabase })
  console.log('RESCHEDULE_ACTIVE', { ok: reschedule.ok, error: reschedule.error, from: reschedule.from, to: reschedule.to, message: reschedule.message })

  const detail = await getCampaign(CAMPAIGN_ID, { supabase })
  console.log('EXECUTION_PROOF', detail.summary?.execution_proof)

  const { count: transitionCount } = await supabase
    .from('campaign_status_transitions')
    .select('*', { count: 'exact', head: true })

  console.log('TRANSITION_ROWS', transitionCount)

  if (!activate.ok) {
    process.exitCode = 1
    return
  }
  if (!activate.idempotent && afterActivate.status !== 'active') {
    console.error('Expected idempotent active activation')
    process.exitCode = 1
  }
  if (queueAfter !== queueBefore) {
    console.error('Repeat activate must not create duplicate queue rows')
    process.exitCode = 1
  }
  if (reschedule.ok || reschedule.from == null) {
    console.error('Reschedule on active must fail with from set')
    process.exitCode = 1
  }
  if (!detail.summary?.execution_proof?.proof_mode) {
    console.error('Expected proof_mode true')
    process.exitCode = 1
  }
  console.log('PROOF_OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})