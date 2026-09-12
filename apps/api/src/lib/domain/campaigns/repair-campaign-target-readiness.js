/**
 * TARGET-SCOPED READINESS REPAIR.
 *
 * Why this exists: `enqueueCampaignTargetOne` assumes its target already
 * carries a `market` and a governance-approved `metadata.template_id`. Nothing
 * on the queue-engine path could produce either, so preparing a single row
 * required `repairCampaignLaunchPrerequisites` — reachable only through the
 * cockpit lifecycle surface, behind OPS_DASHBOARD_SECRET, and campaign-wide.
 * That made a one-row canary depend on an out-of-band dashboard action.
 *
 * This module closes that gap at the SMALLEST possible scope: exactly one
 * target, chosen by id, using the SAME governance-filtered selection the
 * campaign-wide repair uses (`loadOwnershipTemplates` -> `applyGovernance` ->
 * `assignTemplateForTargetFast`). It reuses that logic rather than restating
 * it, so a governance rule can never drift between the two paths.
 *
 * WHAT IT MAY DO
 *   - resolve and VALIDATE the target's market
 *   - select a template from the governed, sendable, dispatch-unblocked pool
 *   - write readiness metadata onto that ONE target row
 *   - report a readiness verdict
 *
 * WHAT IT CANNOT DO — structurally, not by convention
 *   - activate a campaign, or set auto_send_enabled
 *   - insert a send_queue row
 *   - dispatch anything
 * It imports no enqueue module, no dispatch module, and no provider client.
 * The only table it writes is `campaign_targets`, and only at `.eq('id', …)`
 * for the single requested id.
 *
 * MARKET IS VALIDATED, NEVER INVENTED. A market string that matches no
 * `textgrid_numbers` row is left unwritten and reported as unresolved. Writing
 * a plausible-looking market would manufacture the appearance of readiness for
 * a row that dispatch could never route.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  loadOwnershipTemplates,
  assignTemplateForTargetFast,
} from '@/lib/domain/campaigns/campaign-target-template-assignment.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { governanceApplies } from '@/lib/domain/campaigns/template-governance.js'
import {
  TEMPLATE_STATE,
  templateStatusForState,
} from '@/lib/domain/campaigns/template-status-semantics.js'

function clean(value) {
  return String(value ?? '').trim()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Stable reasons — these land in metadata and logs. */
export const READINESS_REASON = Object.freeze({
  TARGET_REQUIRED: 'campaign_target_id_required',
  TARGET_NOT_FOUND: 'campaign_target_not_found',
  CAMPAIGN_NOT_FOUND: 'campaign_not_found',
  TARGET_NOT_READY: 'target_status_not_ready',
  ROUTING_NOT_READY: 'routing_status_not_ready',
  MARKET_UNRESOLVED: 'market_unresolved',
  MARKET_UNPROVISIONED: 'market_has_no_sender_inventory',
  USE_CASE_UNGOVERNED: 'use_case_has_no_governance_surface',
  READY: 'ready',
})

/**
 * Resolve the market without inventing one.
 *
 * Order is narrowest-first: the target's own value wins, then the campaign's,
 * then the candidate snapshot captured at build time. Each is a value some
 * other part of the system already wrote; none is derived here.
 */
function resolveMarketCandidate(target, campaign) {
  const snapshot = metadataObject(metadataObject(target.metadata).candidate_snapshot)
  return (
    clean(target.market) ||
    clean(campaign?.market) ||
    clean(snapshot.market) ||
    ''
  )
}

/**
 * Repair readiness for exactly one campaign target.
 *
 * @param {{campaign_target_id: string}} input
 * @param {object} deps { supabase? }
 * @returns {Promise<object>} verdict — never throws for a routine "not ready"
 */
export async function repairCampaignTargetReadiness(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const targetId = clean(input.campaign_target_id ?? input.campaignTargetId)

  if (!targetId) {
    return { ok: false, reason: READINESS_REASON.TARGET_REQUIRED, repaired: false }
  }

  const { data: target, error: targetErr } = await supabase
    .from('campaign_targets')
    .select('*')
    .eq('id', targetId)
    .maybeSingle()
  if (targetErr) throw targetErr
  if (!target) {
    return { ok: false, reason: READINESS_REASON.TARGET_NOT_FOUND, repaired: false, campaign_target_id: targetId }
  }

  // Readiness repair prepares a target that is otherwise eligible. It is not a
  // mechanism for reviving a target the eligibility pipeline already rejected,
  // so a non-ready target is reported, not "fixed".
  if (clean(target.target_status) !== 'ready') {
    return {
      ok: false,
      reason: READINESS_REASON.TARGET_NOT_READY,
      detail: clean(target.target_status) || 'unset',
      repaired: false,
      campaign_target_id: targetId,
    }
  }
  if (clean(target.routing_status) !== 'ready') {
    return {
      ok: false,
      reason: READINESS_REASON.ROUTING_NOT_READY,
      detail: clean(target.routing_status) || 'unset',
      repaired: false,
      campaign_target_id: targetId,
    }
  }

  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', target.campaign_id)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) {
    return { ok: false, reason: READINESS_REASON.CAMPAIGN_NOT_FOUND, repaired: false, campaign_target_id: targetId }
  }

  // ── Market: resolve, then prove it against real sender inventory ─────────
  const marketCandidate = resolveMarketCandidate(target, campaign)
  if (!marketCandidate) {
    return {
      ok: false,
      reason: READINESS_REASON.MARKET_UNRESOLVED,
      repaired: false,
      campaign_target_id: targetId,
      market: null,
    }
  }

  const { data: senderRows, error: senderErr } = await supabase
    .from('textgrid_numbers')
    .select('phone_number, market, status')
    .eq('market', marketCandidate)
    .range(0, 99)
  if (senderErr) throw senderErr
  const provisioned = (Array.isArray(senderRows) ? senderRows : []).filter(
    (row) => clean(row.status) === 'active',
  )
  if (!provisioned.length) {
    // Deliberately NOT written to the row. A market with no sender is a
    // provisioning gap; recording it as readiness metadata would dress a
    // structural gap up as a prepared target.
    return {
      ok: false,
      reason: READINESS_REASON.MARKET_UNPROVISIONED,
      repaired: false,
      campaign_target_id: targetId,
      market: marketCandidate,
    }
  }

  // ── Template: the governed pool decides, never the caller ────────────────
  // Note there is no template_id input to this function at all. A caller
  // cannot propose one, so it cannot smuggle a paused or ungoverned template
  // past governance.
  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
  const templateUseCase =
    clean(
      campaign.metadata?.template_use_case || campaign.template_use_case || campaign.objective,
    ) || 'ownership_check'

  // ── The S1 boundary ──────────────────────────────────────────────────────
  // governanceApplies() is true ONLY for ownership_check. For any other use
  // case evaluateTemplateGovernance short-circuits to ok:true, so EVERY active
  // template is "eligible" and rotation control is not consulted at all. That
  // is survivable for a campaign-wide repair an operator has to launch by
  // hand; it is NOT survivable here, because this path is reachable
  // autonomously by the queue engine and feeds straight into
  // enqueueCampaignTargetOne.
  //
  // Refusing here keeps this route from becoming the on-ramp for ungoverned
  // outbound in a use case nobody has reviewed — S2/consider_selling has zero
  // governed templates today and must stay unreachable until that review
  // happens. The condition is the governance predicate itself, not a
  // hardcoded 'ownership_check', so the day consider_selling gains a
  // governance surface this opens on its own rather than needing to be
  // remembered.
  if (!governanceApplies(templateUseCase)) {
    return {
      ok: false,
      reason: READINESS_REASON.USE_CASE_UNGOVERNED,
      detail: templateUseCase,
      repaired: false,
      campaign_target_id: targetId,
      campaign_id: target.campaign_id,
      market: marketCandidate,
      template_id: null,
      queue_rows_created: 0,
      campaign_activated: false,
    }
  }

  // getSystemValue / dispatchBlockedSets are forwarded rather than resolved
  // here so this path subtracts exactly the same dispatch block lists as
  // assignment and the enqueue backstop — and so a test can inject them
  // instead of reaching the control plane.
  const catalog = await loadOwnershipTemplates(supabase, templateUseCase, stageCode, {
    getSystemValue: deps.getSystemValue,
    dispatchBlockedSets: deps.dispatchBlockedSets,
  })
  const assignment = assignTemplateForTargetFast(
    target,
    campaign,
    catalog.eligible,
    catalog.governed,
  )

  const existingMetadata = metadataObject(target.metadata)
  const assignedAt = new Date().toISOString()

  if (!assignment.ok || assignment.template_state !== TEMPLATE_STATE.ASSIGNED) {
    // Clear any stale assignment on the way out. Leaving a previous
    // template_id in place is exactly how "ready with a paused template" was
    // written in the first place.
    const patch = {
      market: marketCandidate,
      template_status: assignment.template_status,
      block_reason: assignment.block_reason || assignment.reason || 'template_assignment_failed',
      metadata: {
        ...existingMetadata,
        template_id: null,
        template_state: assignment.template_state,
        template_assignment: {
          reason: assignment.reason,
          language: assignment.language || null,
          governed: catalog.governed,
          assigned_at: assignedAt,
          repaired_by: 'repair_campaign_target_readiness',
        },
      },
    }
    const { error: updErr } = await supabase
      .from('campaign_targets')
      .update(patch)
      .eq('id', targetId)
    if (updErr) throw updErr

    return {
      ok: false,
      reason: assignment.reason || 'template_assignment_failed',
      repaired: true,
      campaign_target_id: targetId,
      campaign_id: target.campaign_id,
      market: marketCandidate,
      template_id: null,
      template_state: assignment.template_state,
      language: assignment.language || null,
      queue_rows_created: 0,
      campaign_activated: false,
    }
  }

  const patch = {
    market: marketCandidate,
    template_status: templateStatusForState(TEMPLATE_STATE.ASSIGNED),
    block_reason: null,
    metadata: {
      ...existingMetadata,
      template_id: assignment.template_id,
      template_state: assignment.template_state,
      template_use_case: templateUseCase,
      template_name: assignment.template_name,
      template_version: assignment.template_version,
      property_type_scope: assignment.property_type_scope,
      template_assignment: {
        template_id: assignment.template_id,
        template_name: assignment.template_name,
        template_version: assignment.template_version,
        language: assignment.language,
        stage_code: assignment.stage_code,
        use_case: templateUseCase,
        assignment_seed: assignment.assignment_seed,
        eligible_pool_size: assignment.eligible_pool_size,
        governed: catalog.governed,
        assigned_at: assignedAt,
        repaired_by: 'repair_campaign_target_readiness',
      },
    },
  }

  const { error: updErr } = await supabase
    .from('campaign_targets')
    .update(patch)
    .eq('id', targetId)
  if (updErr) throw updErr

  return {
    ok: true,
    reason: READINESS_REASON.READY,
    repaired: true,
    campaign_target_id: targetId,
    campaign_id: target.campaign_id,
    market: marketCandidate,
    template_id: assignment.template_id,
    template_state: assignment.template_state,
    language: assignment.language,
    stage_code: assignment.stage_code,
    use_case: templateUseCase,
    eligible_pool_size: assignment.eligible_pool_size,
    governed: catalog.governed,
    // Stated explicitly so a caller reading only this object can still assert
    // the safety properties this module guarantees.
    queue_rows_created: 0,
    campaign_activated: false,
    auto_send_enabled_changed: false,
  }
}
