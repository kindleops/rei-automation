/**
 * Repair campaign launch prerequisites — stage normalization + per-target template assignment.
 */

import crypto from 'node:crypto'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { resolveLanguage, templateCatalogLanguage } from '@/lib/domain/campaigns/campaign-canonical-language.js'
import { expandTemplatePropertyScopes } from '@/lib/sms/property_scope.js'
import {
  isTemplateAllowedForCommunicationClass,
  normalizeUnitsCount,
  resolvePropertyCommunicationClass,
} from '@/lib/domain/properties/property-communication-class.js'

function clean(value) {
  return String(value ?? '').trim()
}

function lower(value) {
  return clean(value).toLowerCase()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function increment(bucket, key, amount = 1) {
  bucket[key] = Number(bucket[key] || 0) + amount
}

async function loadOwnershipTemplates(supabase, useCase, stageCode) {
  const { data, error } = await supabase
    .from('sms_templates')
    .select('*')
    .eq('is_active', true)
    .eq('use_case', useCase)
    .eq('stage_code', stageCode)
    .limit(5000)
  if (error) throw error
  return Array.isArray(data) ? data : []
}

function templatesForLanguage(templates, language) {
  const lang = lower(language)
  const exact = templates.filter((row) => lower(row.language) === lang)
  if (exact.length) return exact
  if (lang === 'english') {
    return templates.filter((row) => lower(row.language) === 'english')
  }
  return []
}

function templatesForPropertyScopes(templates, scopes = []) {
  const scopeSet = new Set(scopes.map((scope) => lower(scope)))
  const exact = templates.filter((row) => scopeSet.has(lower(row.property_type_scope)))
  if (exact.length) return exact
  const relaxed = templates.filter((row) => {
    const scope = lower(row.property_type_scope)
    return scope === 'landlord / multifamily' || scope === 'any residential' || scope === 'residential'
  })
  return relaxed
}

function pickDeterministicTemplate(candidates, seed) {
  const sorted = [...candidates].sort((left, right) => {
    const leftId = clean(left.template_id || left.id)
    const rightId = clean(right.template_id || right.id)
    return leftId.localeCompare(rightId)
  })
  if (!sorted.length) return null
  const hash = crypto.createHash('sha1').update(seed).digest('hex')
  const index = Number.parseInt(hash.slice(0, 8), 16) % sorted.length
  return sorted[index]
}

export function assignTemplateForTargetFast(target, campaign, templateCatalog) {
  const metadata = metadataObject(target.metadata)
  const snapshot = metadataObject(metadata.candidate_snapshot)
  const languageRaw = clean(target.language || snapshot.language || campaign.language_policy || 'English')
  const languageResolved = resolveLanguage(languageRaw)
  const catalogLanguage = templateCatalogLanguage(languageRaw)

  if (languageResolved.unsupported || catalogLanguage.unsupported) {
    return {
      ok: false,
      excluded: true,
      reason: 'unsupported_language',
      language: languageRaw,
      template_status: 'blocked',
      block_reason: `unsupported_language:${languageRaw}`,
    }
  }

  const canonicalLanguage = catalogLanguage.language || languageResolved.canonical || languageRaw || 'English'
  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
  const templateUseCase = clean(
    campaign.metadata?.template_use_case || campaign.template_use_case || campaign.objective || 'ownership_check'
  ) || 'ownership_check'

  const propertyType = clean(snapshot.property_type || target.asset_type || metadata.property_type)
  // LIVE DEFECT FIX (spine §7 / G1): the snapshot column is `units_count`; the
  // previous read (`snapshot.unit_count ?? snapshot.units`) never matched, so
  // unit counts never reached property-scope resolution here. Legacy keys kept
  // as fallback for snapshots persisted before the fix.
  const unitsCount = normalizeUnitsCount(
    snapshot.units_count ?? snapshot.unit_count ?? snapshot.units
  )
  const communicationClass = resolvePropertyCommunicationClass({
    units_count: unitsCount,
    property_type: propertyType,
    property_class: snapshot.property_class,
    normalized_asset_class: snapshot.canonical_property_group,
  })
  const propertyScopes = expandTemplatePropertyScopes({
    use_case: templateUseCase,
    property_type: propertyType,
    units_count: unitsCount,
    owner_type: snapshot.owner_type_guess || snapshot.phone_owner || null,
  })

  const languageMatches = templatesForLanguage(templateCatalog, canonicalLanguage)
  const scopedMatches = templatesForPropertyScopes(languageMatches, propertyScopes)
  // HARD guarantee (spine §7): a template whose wording/placeholders conflict
  // with the property communication class is unselectable — filtered before
  // deterministic selection, never merely down-scored.
  const classSafeMatches = scopedMatches.filter(
    (row) => isTemplateAllowedForCommunicationClass(row, communicationClass).allowed
  )
  const seed = [
    target.id,
    target.master_owner_id,
    target.property_id,
    target.phone_id,
    canonicalLanguage,
    propertyScopes[0],
    // Rotation key includes the communication class so a retry can never flip
    // wording class (spine §7 / G2).
    communicationClass,
    stageCode,
    templateUseCase,
  ].join('|')
  const selected = pickDeterministicTemplate(classSafeMatches, seed)
  const templateId = clean(selected?.template_id || selected?.id)

  if (!templateId) {
    const classFiltered = scopedMatches.length > 0 && classSafeMatches.length === 0
    const blockReason = classFiltered
      ? 'no_template_for_communication_class'
      : 'no_template_for_language_scope'
    return {
      ok: false,
      excluded: false,
      reason: blockReason,
      language: canonicalLanguage,
      template_status: 'blocked',
      block_reason: blockReason,
      property_scopes: propertyScopes,
      property_communication_class: communicationClass,
      units_count: unitsCount,
    }
  }

  return {
    ok: true,
    excluded: false,
    language: canonicalLanguage,
    template_id: templateId,
    template_status: 'ready',
    template_name: selected?.template_name || null,
    property_type_scope: selected?.property_type_scope || propertyScopes[0] || null,
    property_communication_class: communicationClass,
    units_count: unitsCount,
    block_reason: null,
  }
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

export async function assignCampaignTargetTemplates(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
  const templateUseCase = clean(
    campaign.metadata?.template_use_case || campaign.template_use_case || campaign.objective || 'ownership_check'
  ) || 'ownership_check'
  const templateCatalog = await loadOwnershipTemplates(supabase, templateUseCase, stageCode)

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

    const result = assignTemplateForTargetFast(target, campaign, templateCatalog)
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
          template_use_case: templateUseCase,
          template_name: result.template_name,
          property_type_scope: result.property_type_scope,
          property_communication_class: result.property_communication_class || null,
          template_assignment: {
            template_id: result.template_id,
            language: lang,
            property_communication_class: result.property_communication_class || null,
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
          property_scopes: result.property_scopes || null,
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
    template_catalog_count: templateCatalog.length,
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