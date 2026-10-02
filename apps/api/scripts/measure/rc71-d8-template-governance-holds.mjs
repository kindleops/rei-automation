#!/usr/bin/env node
/**
 * RC 7.1 D8 — MEASURE (read-only): how many current ready campaign targets would
 * template governance hold on the bulk plan path?
 *
 * Renders every ready target of every non-archived campaign through the REAL
 * campaign renderer (renderOutboundTemplate, the planner's own call shape)
 * three ways and counts the outcomes:
 *   baseline     operator blocklist only (today's bulk path)
 *   pause_only   + governance exclusion of governed-but-not-sendable templates
 *                (what RC 7.1 D8 enforces)
 *   fail_closed  + every template WITHOUT a sendable governance row excluded
 *                (what target assignment / target-one enqueue enforce)
 *
 * READ-ONLY BY CONSTRUCTION: the Supabase client is wrapped so insert / update
 * / upsert / delete / rpc throw before reaching the network.
 *
 * Usage (from apps/api; needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
 *   node --import ./tests/register-aliases.mjs scripts/measure/rc71-d8-template-governance-holds.mjs
 */
import { createClient } from '@supabase/supabase-js'
import {
  applyOwnerPersona,
  launchCandidateFromTarget,
  loadOwnerPersonas,
} from '@/lib/domain/campaigns/campaign-automation-service.js'
import { renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import {
  governanceExcludedTemplateIds,
  indexGovernance,
} from '@/lib/domain/campaigns/template-governance.js'
import { loadDispatchBlockedSets } from '@/lib/domain/delivery/sms-health-guard.js'

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

function readOnly(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'rpc') return () => { throw new Error('read-only measurement: rpc refused') }
      if (prop !== 'from') return Reflect.get(target, prop)
      return (table) => {
        const builder = target.from(table)
        return new Proxy(builder, {
          get(b, method) {
            if (WRITE_METHODS.has(method)) return () => { throw new Error(`read-only measurement: ${String(method)} on ${table} refused`) }
            return Reflect.get(b, method)
          },
        })
      }
    },
  })
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  process.exit(2)
}
const supabase = readOnly(createClient(url, key, { auth: { persistSession: false } }))

async function all(build, page = 1000) {
  const out = []
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < page) return out
  }
}

const getSystemValue = async (k) => {
  const { data, error } = await supabase.from('system_control').select('value').eq('key', k).maybeSingle()
  if (error) throw error
  return data?.value ?? null
}

const governanceRows = await all(() => supabase.from('ownership_template_rotation_control').select('template_id,rotation_status,language,daily_cap,last_40d_total_sent').order('template_id'))
const governanceById = indexGovernance(governanceRows)
const pauseOnly = governanceExcludedTemplateIds(governanceById)
const sendableGoverned = new Set(governanceRows.filter((r) => !pauseOnly.has(String(r.template_id))).map((r) => String(r.template_id)))
const activeTemplateIds = await all(() => supabase.from('sms_templates').select('template_id').eq('is_active', true).order('template_id'))
const failClosed = new Set(activeTemplateIds.map((t) => String(t.template_id)).filter((id) => !sendableGoverned.has(id)))
const blocked = await loadDispatchBlockedSets({ getSystemValue })

const campaigns = await all(() => supabase.from('campaigns').select('*').in('status', ['active', 'activating', 'scheduled', 'paused', 'built', 'queued', 'draft']).order('id'))

const modes = {
  baseline: {},
  pause_only: { governance_excluded_template_ids: pauseOnly },
  fail_closed: { governance_excluded_template_ids: failClosed },
}
const tally = {}
const byCampaign = []
const templateCache = new Map()
for (const campaign of campaigns) {
  const targets = await all(() => supabase.from('campaign_targets').select('*').eq('campaign_id', campaign.id).eq('target_status', 'ready').order('id'))
  if (!targets.length) continue
  const personas = campaign.agent_persona ? new Map() : await loadOwnerPersonas(supabase, targets.map((t) => t.master_owner_id)).catch(() => new Map())
  const row = { campaign: campaign.name, status: campaign.status, ready: targets.length }
  for (const [mode, extra] of Object.entries(modes)) {
    const counts = {}
    for (const target of targets) {
      const candidate = applyOwnerPersona(launchCandidateFromTarget(target, campaign), personas)
      const options = {
        template_use_case: campaign.metadata?.template_use_case || campaign.objective || 'ownership_check',
        stage_code: campaign.metadata?.stage_code || 'S1',
        routing_safe_only: true,
        allow_phone_fallback: false,
        first_touch: true,
        campaign_template_assignment: true,
        allow_identity_unknown: true,
        campaign_session_id: campaign.id,
        blocked_template_ids: blocked.template_ids,
        ...extra,
      }
      const result = await renderOutboundTemplate(candidate, options, {
        supabase,
        templateFetchCache: templateCache,
        getRecentTemplateIds: async () => [],
      }).catch((error) => ({ ok: false, reason_code: 'RENDER_THREW', reason: error?.message }))
      const outcome = result.ok ? 'ok' : (result.reason_code || result.reason || 'failed')
      counts[outcome] = (counts[outcome] || 0) + 1
      // Which template a successful render landed on: a paused one today
      // (baseline) is a seller D8 moves to a sendable sibling.
      const renderedId = String(result.template_id || result.template?.template_id || result.template?.id || '')
      if (result.ok && pauseOnly.has(renderedId)) counts.ok_on_paused_template = (counts.ok_on_paused_template || 0) + 1
    }
    row[mode] = counts
    for (const [outcome, n] of Object.entries(counts)) {
      tally[mode] ??= {}
      tally[mode][`${campaign.status}:${outcome}`] = (tally[mode][`${campaign.status}:${outcome}`] || 0) + n
    }
  }
  byCampaign.push(row)
}

console.log(JSON.stringify({
  measured_at: new Date().toISOString(),
  governance: { rows: governanceRows.length, pause_only_excluded: [...pauseOnly], sendable_governed: [...sendableGoverned], fail_closed_excluded_count: failClosed.size },
  operator_blocked_template_ids: [...blocked.template_ids],
  by_campaign: byCampaign,
  totals: tally,
}, null, 2))
