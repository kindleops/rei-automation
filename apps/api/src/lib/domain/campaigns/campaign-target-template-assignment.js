/**
 * Repair campaign launch prerequisites — stage normalization + per-target template assignment.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { resolveLanguage } from '@/lib/domain/campaigns/campaign-canonical-language.js'
import { resolvePropertyTypeScope } from '@/lib/sms/property_scope.js'
import {
  launchCandidateFromTarget,
} from '@/lib/domain/campaigns/campaign-automation-service.js'

function clean(value) {
  return String(value ?? '').trim()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function increment(bucket, key, amount = 1) {
  bucket[key] = Number(bucket[key] || 0) + amount
}

export async function repairCampaignStageMetadata(campaign = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const metadata = metadataObject(campaign.metadata)
  const rawStage = clean(metadata.stage_code || campaign.stage_code)
  const canonicalStage = normalizeCampaignStageCode(rawStage, 'S1')
  const stageRepaired = canonicalStage !== rawStage

  if (!stageRepaired) {
    return { ok: true, stage_repaired: false, stage_code: canonicalStage, campaign }
  }

  const nextMetadata = {
    ...metadata,
    stage_code: canonicalStage,
    stage_code_normalized_from: rawStage || null,
    stage_code_normalized_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update({ metadata: nextMetadata })
    .eq('id', campaign.id)
    .select('*')
    .maybeSingle()

  if (error) throw error
  return {
    ok: true,
    stage_repaired: true,
    stage_code: canonicalStage,
    previous_stage_code: rawStage || null,
    campaign: data || { ...campaign, metadata: nextMetadata },
  }
}

async function assignTemplateForTarget(target, campaign, deps = {}) {
  const metadata = metadataObject(target.metadata)
  const snapshot = metadataObject(metadata.candidate_snapshot)
  const languageRaw = clean(target.language || snapshot.language || campaign.language_policy || 'English')
  const languageResolved = resolveLanguage(languageRaw)

  if (languageResolved.unsupported) {
    return {
      ok: false,
      excluded: true,
      reason: 'unsupported_language',
      language: languageRaw,
      template_status: 'blocked',
      block_reason: `unsupported_language:${languageRaw}`,
    }
  }

  const canonicalLanguage = languageResolved.canonical || languageRaw || 'English'
  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
  const templateUseCase = clean(
    campaign.metadata?.template_use_case || campaign.template_use_case || campaign.objective || 'ownership_check'
  ) || 'ownership_check'

  const candidate = launchCandidateFromTarget(target, campaign)
  candidate.stage_code = stageCode
  candidate.language = canonicalLanguage
  candidate.best_language = canonicalLanguage
  candidate.template_use_case = templateUseCase
  candidate.template_lookup_use_case = templateUseCase
  candidate.raw = {
    ...metadataObject(candidate.raw),
    ...snapshot,
    language: canonicalLanguage,
    language_preference: canonicalLanguage,
    property_type_scope: resolvePropertyTypeScope({
      use_case: templateUseCase,
      property_type: clean(snapshot.property_type || target.asset_type || metadata.property_type),
      unit_count: snapshot.unit_count ?? snapshot.units ?? null,
      owner_type: snapshot.owner_type_guess || snapshot.phone_owner || null,
    }),
  }

  const rendered = await renderOutboundTemplate(candidate, {
    template_use_case: templateUseCase,
    stage_code: stageCode,
    first_touch: true,
    campaign_template_assignment: true,
    allow_identity_unknown: true,
  }, deps)

  if (!rendered.ok) {
    return {
      ok: false,
      excluded: false,
      reason: rendered.reason || rendered.reason_code || 'template_render_failed',
      language: canonicalLanguage,
      template_status: 'blocked',
      block_reason: clean(rendered.reason || rendered.reason_code || 'template_render_failed'),
    }
  }

  const templateId = clean(
    rendered.selected_template_id || rendered.template?.template_id || rendered.template?.id
  )

  return {
    ok: true,
    excluded: false,
    language: canonicalLanguage,
    template_id: templateId || null,
    template_status: templateId ? 'ready' : 'blocked',
    template_name: rendered.template?.template_name || null,
    rendered_message_preview: clean(rendered.rendered_message_body).slice(0, 180),
    block_reason: templateId ? null : 'template_id_missing',
  }
}

export async function assignCampaignTargetTemplates(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const { data: targets, error: targetErr } = await supabase
    .from('campaign_targets')
    .select('*')
    .eq('campaign_id', campaignId)
    .limit(50000)
  if (targetErr) throw targetErr

  const assignedByLanguage = {}
  const unsupportedLanguages = {}
  let assigned = 0
  let awaitingTemplate = 0
  let unsupported = 0
  let skipped = 0
  const updates = []

  for (const target of targets || []) {
    if (clean(target.target_status) !== 'ready') {
      skipped += 1
      continue
    }
    if (clean(target.routing_status) !== 'ready') {
      skipped += 1
      continue
    }

    const result = await assignTemplateForTarget(target, campaign, deps)
    const lang = result.language || 'Unknown'

    if (result.excluded) {
      unsupported += 1
      increment(unsupportedLanguages, lang)
      updates.push({
        id: target.id,
        template_status: 'blocked',
        block_reason: result.block_reason,
        metadata: {
          ...metadataObject(target.metadata),
          template_assignment: {
            excluded: true,
            reason: result.reason,
            language: lang,
            assigned_at: new Date().toISOString(),
          },
        },
      })
      continue
    }

    if (result.ok && result.template_status === 'ready') {
      assigned += 1
      increment(assignedByLanguage, lang)
      updates.push({
        id: target.id,
        template_status: 'ready',
        block_reason: null,
        metadata: {
          ...metadataObject(target.metadata),
          template_id: result.template_id,
          template_use_case: campaign.metadata?.template_use_case || campaign.objective || 'ownership_check',
          template_name: result.template_name,
          rendered_message_preview: result.rendered_message_preview,
          template_assignment: {
            template_id: result.template_id,
            language: lang,
            assigned_at: new Date().toISOString(),
          },
        },
      })
      continue
    }

    awaitingTemplate += 1
    updates.push({
      id: target.id,
      template_status: 'blocked',
      block_reason: result.block_reason || result.reason || 'template_assignment_failed',
      metadata: {
        ...metadataObject(target.metadata),
        template_assignment: {
          reason: result.reason,
          language: lang,
          assigned_at: new Date().toISOString(),
        },
      },
    })
  }

  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100)
    await Promise.all(chunk.map((row) => {
      const { id, ...patch } = row
      return supabase.from('campaign_targets').update(patch).eq('id', id)
    }))
  }

  return {
    ok: true,
    campaign_id: campaignId,
    persisted_target_count: (targets || []).length,
    templates_assigned: assigned,
    awaiting_template: awaitingTemplate,
    unsupported_language_exclusions: unsupported,
    skipped,
    assigned_by_language: assignedByLanguage,
    unsupported_by_language: unsupportedLanguages,
  }
}

export async function repairCampaignLaunchPrerequisites(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle()
  if (error) throw error
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const stageResult = await repairCampaignStageMetadata(campaign, deps)
  const assignment = await assignCampaignTargetTemplates(campaignId, {
    ...deps,
    supabase,
  })

  return {
    ok: true,
    campaign_id: campaignId,
    stage_repaired: stageResult.stage_repaired,
    stage_code: stageResult.stage_code,
    ...assignment,
    campaign: stageResult.campaign,
  }
}