/**
 * Truthful launch readiness — uses canonical sms_templates via renderOutboundTemplate probe.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
async function launchCandidateFromTarget(target, campaign) {
  const { launchCandidateFromTarget: resolve } = await import('@/lib/domain/campaigns/campaign-automation-service.js')
  return resolve(target, campaign)
}

function clean(value) {
  return String(value ?? '').trim()
}

const BLOCKER_LABELS = {
  template_required: 'No approved template resolved for scenario/stage/language',
  no_ready_recipients: 'No ready recipients in target snapshot',
  missing_canonical_phone: 'Recipient missing canonical phone',
  suppression_blocked: 'Active suppression on ready recipients',
  routing_blocked: 'Sender route unavailable for ready recipients',
  identity_blocked: 'Identity confidence too low for activation',
  duplicate_queue_row: 'Duplicate active queue row exists',
  campaign_not_queueable: 'Campaign lifecycle does not allow activation',
  missing_launch_caps: 'Campaign missing required pacing caps',
}

export async function evaluateCampaignLaunchReadiness(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const blockers = []
  const blockerCodes = []
  const warnings = []

  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const { count: readyCount } = await supabase
    .from('campaign_targets')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('target_status', 'ready')

  const { data: readyTargets } = await supabase
    .from('campaign_targets')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('target_status', 'ready')
    .order('priority_score', { ascending: false, nullsFirst: false })
    .limit(20)

  const ready = readyTargets || []
  const readyTotal = Number(readyCount ?? ready.length)
  if (!readyTotal) {
    blockers.push(BLOCKER_LABELS.no_ready_recipients)
    blockerCodes.push('no_ready_recipients')
  }

  let templateResolved = 0
  let templateMissing = 0
  const sampleSize = Math.min(5, ready.length)

  for (let i = 0; i < sampleSize; i += 1) {
    const target = ready[i]
    const candidate = launchCandidateFromTarget(target, campaign)
    candidate.stage_code = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
    const rendered = await renderOutboundTemplate(candidate, {
      template_use_case: campaign.metadata?.template_use_case || campaign.objective || 'ownership_check',
      stage_code: normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1'),
      first_touch: true,
    }, deps)
    if (rendered.ok && (rendered.selected_template_id || rendered.template?.template_id)) {
      templateResolved += 1
    } else {
      templateMissing += 1
    }
  }

  if (readyTotal && templateMissing === sampleSize) {
    blockers.push(BLOCKER_LABELS.template_required)
    blockerCodes.push('template_required')
  } else if (templateMissing > 0) {
    warnings.push(`${templateMissing}/${sampleSize} sampled recipients missing template resolution`)
  }

  const level = blockers.length ? 'blocked' : warnings.length ? 'warnings' : 'ready'
  return {
    ok: true,
    launch_readiness: level,
    blocker_count: blockers.length,
    blocker_codes: blockerCodes,
    blockers,
    warnings,
    template_readiness: templateMissing === 0 && readyTotal ? 'resolved' : templateMissing === sampleSize ? 'missing' : 'partial',
    template_sample: { resolved: templateResolved, missing: templateMissing, sampled: sampleSize },
    ready_recipient_count: readyTotal,
    remediation: blockers.map((b) => BLOCKER_LABELS[blockers.indexOf(b)] || b),
  }
}

