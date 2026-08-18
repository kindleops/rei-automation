/**
 * Repair campaign launch prerequisites — stage normalization + per-target template assignment.
 */

import crypto from 'node:crypto'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { resolveLanguage, templateCatalogLanguage } from '@/lib/domain/campaigns/campaign-canonical-language.js'
import { expandTemplatePropertyScopes } from '@/lib/sms/property_scope.js'
import { loadTemplatePool } from '@/lib/domain/campaigns/template-pool-pagination.js'
import { applyGovernance, loadGovernance } from '@/lib/domain/campaigns/template-governance.js'
import {
  TEMPLATE_STATE,
  templateStatusForState,
} from '@/lib/domain/campaigns/template-status-semantics.js'

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

/**
 * Load the governed, completely-paginated, canonically-ordered template pool.
 *
 * The previous implementation used `.limit(5000)` on a bare select. PostgREST
 * clamps that to max-rows (1,000), so the default ownership_check/S1 pool of
 * 4,638 templates was silently cut to its first ~22% — and with no ORDER BY,
 * *which* 22% was left to the planner.
 */
async function loadOwnershipTemplates(supabase, useCase, stageCode) {
  const pool = await loadTemplatePool(supabase, useCase, stageCode)
  const governanceById = await loadGovernance(supabase)
  const { eligible, rejected, governed } = applyGovernance(pool, governanceById, useCase)
  return { pool, eligible, rejected, governed, governanceById }
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

/**
 * Deterministic selection over a canonically ordered pool.
 *
 * The hash was always deterministic; the POOL was not. Selection indexes into
 * an ordered list, so if the list order or membership can move between runs,
 * the same target resolves to a different template. Two things guarantee
 * stability now: the pool is loaded completely (no server-side truncation) and
 * sorted by a total order whose final key, template_id, is unique.
 *
 * The sort here is retained as a defensive re-assertion — `canonicalTemplateOrder`
 * already ordered the governed pool, but this function is reachable with any
 * candidate array and must not depend on its caller having done that.
 */
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

function assignTemplateForTargetFast(target, campaign, templateCatalog, governedPool = false) {
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
      template_state: TEMPLATE_STATE.BLOCKED,
      template_status: templateStatusForState(TEMPLATE_STATE.BLOCKED),
      block_reason: `unsupported_language:${languageRaw}`,
    }
  }

  const canonicalLanguage = catalogLanguage.language || languageResolved.canonical || languageRaw || 'English'
  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
  const templateUseCase = clean(
    campaign.metadata?.template_use_case || campaign.template_use_case || campaign.objective || 'ownership_check'
  ) || 'ownership_check'

  const propertyType = clean(snapshot.property_type || target.asset_type || metadata.property_type)
  const propertyScopes = expandTemplatePropertyScopes({
    use_case: templateUseCase,
    property_type: propertyType,
    unit_count: snapshot.unit_count ?? snapshot.units ?? null,
    owner_type: snapshot.owner_type_guess || snapshot.phone_owner || null,
  })

  const languageMatches = templatesForLanguage(templateCatalog, canonicalLanguage)
  const scopedMatches = templatesForPropertyScopes(languageMatches, propertyScopes)
  const seed = [
    target.id,
    target.master_owner_id,
    target.property_id,
    target.phone_id,
    canonicalLanguage,
    propertyScopes[0],
    stageCode,
    templateUseCase,
  ].join('|')
  const selected = pickDeterministicTemplate(scopedMatches, seed)
  const templateId = clean(selected?.template_id || selected?.id)

  if (!templateId) {
    // Fail closed. The pool reaching this point is already governance-filtered,
    // so "nothing matched" can mean the language/scope genuinely has no
    // template OR that every candidate was paused. Both block; the distinction
    // is carried in the reason so operators can tell them apart.
    const state = governedPool
      ? TEMPLATE_STATE.GOVERNANCE_BLOCKED
      : TEMPLATE_STATE.MISSING_TEMPLATE
    return {
      ok: false,
      excluded: false,
      reason: 'no_governed_template_for_language_scope',
      language: canonicalLanguage,
      template_state: state,
      template_status: templateStatusForState(state),
      block_reason: 'no_governed_template_for_language_scope',
      property_scopes: propertyScopes,
      assignment_seed: seed,
    }
  }

  return {
    ok: true,
    excluded: false,
    language: canonicalLanguage,
    template_id: templateId,
    template_state: TEMPLATE_STATE.ASSIGNED,
    template_status: templateStatusForState(TEMPLATE_STATE.ASSIGNED),
    template_name: selected?.template_name || null,
    template_body: selected?.template_body || null,
    template_version: selected?.version ?? null,
    stage_code: stageCode,
    property_type_scope: selected?.property_type_scope || propertyScopes[0] || null,
    block_reason: null,
    // Provenance: the exact seed the selection hashed. Re-running the hash
    // against the same governed pool must reproduce this template, which is
    // what makes an assignment auditable rather than merely recorded.
    assignment_seed: seed,
    eligible_pool_size: scopedMatches.length,
  }
}

/**
 * Page through a campaign's targets.
 *
 * The previous `.limit(50000)` had the same defect as the template pool: it is
 * clamped to PostgREST max-rows, so assignment silently skipped every target
 * past the first 1,000. No campaign is that large today (largest is 802), which
 * is precisely why it would have gone unnoticed until one was.
 *
 * Deliberately self-contained rather than importing the shared paginator from
 * the campaign-truncation branch — these PRs must stay independently
 * mergeable, and a shared import would couple them.
 */
async function fetchAllCampaignTargetsForAssignment(supabase, campaignId) {
  const PAGE = 1000
  const rows = []

  for (let page = 0; page < 200; page += 1) {
    const from = page * PAGE
    const { data, error } = await supabase
      .from('campaign_targets')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) throw error
    const batch = Array.isArray(data) ? data : []
    rows.push(...batch)
    if (batch.length < PAGE) break
  }

  return rows
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
  const catalog = await loadOwnershipTemplates(supabase, templateUseCase, stageCode)
  const templateCatalog = catalog.eligible
  const governedPool = catalog.governed

  const targets = await fetchAllCampaignTargetsForAssignment(supabase, campaignId)

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

    const result = assignTemplateForTargetFast(target, campaign, templateCatalog, governedPool)
    const lang = result.language || 'Unknown'

    if (result.excluded) {
      unsupported += 1
      increment(unsupportedLanguages, lang)
      updates.push({
        id: target.id,
        template_status: result.template_status,
        block_reason: result.block_reason,
        metadata: {
          ...metadataObject(target.metadata),
          // Clear any stale assignment. A target that is now blocked must not
          // keep a template_id from a previous run — that is exactly how
          // "ready with no template" and "ready with a paused template" got
          // written in the first place.
          template_id: null,
          template_state: result.template_state,
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

    if (result.ok && result.template_state === TEMPLATE_STATE.ASSIGNED) {
      assigned += 1
      increment(assignedByLanguage, lang)
      updates.push({
        id: target.id,
        template_status: result.template_status,
        block_reason: null,
        metadata: {
          ...metadataObject(target.metadata),
          template_id: result.template_id,
          template_state: result.template_state,
          template_use_case: templateUseCase,
          template_name: result.template_name,
          template_version: result.template_version,
          property_type_scope: result.property_type_scope,
          template_assignment: {
            template_id: result.template_id,
            template_name: result.template_name,
            template_version: result.template_version,
            language: lang,
            stage_code: result.stage_code,
            use_case: templateUseCase,
            // Provenance sufficient to reconstruct the decision: re-hashing
            // this seed over the same governed pool must yield the same
            // template.
            assignment_seed: result.assignment_seed,
            eligible_pool_size: result.eligible_pool_size,
            governed: governedPool,
            assigned_at: new Date().toISOString(),
          },
        },
      })
      continue
    }

    awaitingTemplate += 1
    updates.push({
      id: target.id,
      template_status: result.template_status,
      block_reason: result.block_reason || result.reason || 'template_assignment_failed',
      metadata: {
        ...metadataObject(target.metadata),
        template_id: null,
        template_state: result.template_state,
        template_assignment: {
          reason: result.reason,
          language: lang,
          property_scopes: result.property_scopes || null,
          governed: governedPool,
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
    // Both numbers matter: the raw pool proves truncation is gone, the eligible
    // count shows what governance actually permits.
    template_pool_count: catalog.pool.length,
    template_catalog_count: templateCatalog.length,
    template_governance_applied: governedPool,
    template_governance_rejected: catalog.rejected.length,
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