/**
 * Truthful launch readiness — evaluates execution gates before live send.
 *
 * CURRENT TRUTH, NOT STORED ROLL-UPS (2026-09-30).
 *
 * Readiness used to answer three questions from columns that were stale by
 * construction:
 *
 *   • Templates — a per-language roll-up of `template_status !== 'ready'` over
 *     EVERY target, blocked ones included. template_status is 'pending' from
 *     build until activation assigns templates, so before activation every
 *     campaign read "N English targets awaiting template assignment"; held
 *     targets never leave that state, so the line never went away; and targets
 *     with no stated language on an `auto` campaign were assigned the language
 *     "auto" and parked forever.
 *   • Senders — "is there any status='active' number whose market equals the
 *     campaign market (or one of seven hardcoded Los Angeles aliases)". It
 *     ignored the operator blocklist, health, cooling and the other markets in
 *     the audience, so Miami — one paused, one cooling and one operator-blocked
 *     number — passed, and its plan then placed 0 of 84.
 *   • Nothing looked at what the plan actually did.
 *
 * Now every answer comes from the path the plan itself runs:
 *
 *   • Templates — per language of the READY targets (no stated language →
 *     English, the documented default), a sample of that language is rendered
 *     with the planner's renderer and options. "No approved Spanish message"
 *     is said plainly, with how many sellers it affects.
 *   • Senders — per market of the READY targets, the planner's router
 *     (chooseTextgridNumber, first touch, operator blocklist applied) is asked
 *     for a sender, and every local number's state is reported when it can't.
 *   • The last real plan — for a campaign that has run, the feeder's last
 *     outcome (placed nothing, and why) is surfaced.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue } from '@/lib/system-control.js'
import { chooseTextgridNumber, loadTextgridNumberFleet, renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { canonicalLanguageLabel, resolveLanguage } from '@/lib/domain/campaigns/campaign-canonical-language.js'
import { resolveTargetMessageLanguage } from '@/lib/domain/campaigns/campaign-target-template-assignment.js'
import { loadDispatchBlockedSets } from '@/lib/domain/delivery/sms-health-guard.js'
import { governanceApplies, governanceExcludedTemplateIds, loadGovernance } from '@/lib/domain/campaigns/template-governance.js'
import {
  asBoolean,
  isEmergencyStopActive,
  normalizeQueueProcessorMode,
} from '@/lib/domain/queue/queue-control-safety.js'
import { evaluateGlobalSendBrakeState } from '@/lib/domain/queue/queue-send-brake-state.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import { parseCampaignCap, zeroCampaignCaps } from '@/lib/domain/campaigns/campaign-caps.js'

async function campaignServiceHelpers() {
  const service = await import('@/lib/domain/campaigns/campaign-automation-service.js')
  return {
    launchCandidateFromTarget: service.launchCandidateFromTarget,
    loadOwnerPersonas: service.loadOwnerPersonas,
    applyOwnerPersona: service.applyOwnerPersona,
    describePlanSkips: service.describePlanSkips,
  }
}

function clean(value) {
  return String(value ?? '').trim()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const nf = (value) => Number(value || 0).toLocaleString('en-US')

const BLOCKER_LABELS = {
  emergency_stop: 'Emergency stop is active',
  queue_processor_disabled: 'Global queue processor is disabled',
  global_auto_enqueue_disabled: 'Global campaign enqueue is disabled',
  campaign_auto_queue_disabled: 'Campaign auto-queue is disabled',
  transmission_disabled: 'Campaign transmission is disabled (test mode / auto-send off)',
  unrestricted_auto_send: 'Unrestricted auto-send must remain disabled for guarded launch',
  missing_daily_cap: 'Daily send cap is missing',
  missing_total_cap: 'Total send cap is missing',
  campaign_cap_zero: 'A send cap is set to 0 (send nothing)',
  missing_batch_max: 'Batch maximum is missing',
  missing_market_cap: 'Market cap is missing',
  missing_per_sender_cap: 'Per-sender cap is missing',
  missing_send_window: 'Send window is not configured',
  routing_zero: 'No routable recipients (routing allowed = 0)',
  template_required: 'No approved message renders for this audience',
  no_ready_recipients: 'No ready recipients in target snapshot',
  no_launch_ready_recipients: 'No seller in this audience can be sent right now',
  campaign_not_queueable: 'Campaign lifecycle does not allow activation',
  provider_disabled: 'Outbound SMS provider is disabled',
  zero_valid_senders: 'No sendable number covers this audience',
}

const SENDER_STATE_LABELS = {
  blocked_by_operator: 'blocked by operator',
  status_paused: 'paused',
  status_inactive: 'inactive',
  status_disabled: 'disabled',
  status_suspended: 'suspended',
  status_released: 'released',
  status_retired: 'retired',
  health_cooling: 'cooling',
  health_blocked: 'health-blocked',
  health_quarantined: 'quarantined',
  health_spam_flagged: 'spam-flagged',
  health_suspended: 'suspended',
  cooling_until: 'cooling',
  daily_limit_reached: 'at its daily limit (resets tomorrow)',
}

const RENDER_FAILURE_LABELS = {
  NO_TEMPLATE: 'no approved message',
  TEMPLATE_GOVERNANCE_PAUSED: 'every fitting message is paused by template governance',
  TEMPLATE_RENDER_LINT_FAILURE: 'the message failed the template check',
  TEMPLATE_RENDER_FAILED: 'the message could not be rendered',
  NAME_HYDRATION_FAILURE: 'the seller name is missing',
  OUTREACH_HISTORY_UNAVAILABLE: 'message history could not be read',
}

/** Languages rendered per readiness check, and samples per language. */
const MAX_LANGUAGES_SAMPLED = 12
const SAMPLES_PER_LANGUAGE = 3

/** Render failures that are about one seller's data, not the language's templates. */
const SELLER_LEVEL_RENDER_FAILURES = new Set([
  'TEMPLATE_RENDER_LINT_FAILURE',
  'NAME_HYDRATION_FAILURE',
  'OUTREACH_HISTORY_UNAVAILABLE',
])

function renderedTemplateId(result = {}) {
  return clean(
    result.selected_template_id ||
      result.template_rotation?.selected_template_id ||
      result.template?.template_id ||
      result.template?.id
  ) || null
}
const MAX_MARKETS_ROUTED = 40
const TARGET_PAGE = 1000
const TARGET_PAGE_LIMIT = 50
// Narrow projection: counting needs no candidate snapshot.
const TARGET_COLUMNS = 'id,target_status,routing_status,suppression_status,template_status,identity_status,language,market,state,block_reason'

function isTargetRoutingReady(row = {}) {
  return (
    clean(row.target_status) === 'ready' &&
    clean(row.routing_status) === 'ready' &&
    clean(row.suppression_status) !== 'blocked'
  )
}

export function resolveLaunchReadinessContext(options = {}) {
  const proof_hydration = options.proof_hydration === true || options.no_send === true || options.noSend === true
  const guarded_live_launch = !proof_hydration && (
    options.guarded_live_launch === true ||
    options.confirm_live === true ||
    options.confirmLive === true
  )
  const explicit_operator_action = options.explicit_operator_action === true || options.explicitOperatorAction === true
  const scheduled_activation = options.scheduled_activation === true || options.scheduledActivation === true
  const controlled_hydration = proof_hydration || guarded_live_launch || explicit_operator_action || scheduled_activation
  return {
    proof_hydration,
    guarded_live_launch,
    explicit_operator_action,
    scheduled_activation,
    controlled_hydration,
  }
}

/**
 * Every target of the campaign, paged. `.limit(50000)` is clamped to
 * PostgREST's 1,000 max-rows, so a larger campaign was judged on its first
 * thousand rows.
 */
async function fetchReadinessTargets(supabase, campaignId) {
  const rows = []
  const seen = new Set()
  for (let page = 0; page < TARGET_PAGE_LIMIT; page += 1) {
    const from = page * TARGET_PAGE
    const { data, error } = await supabase
      .from('campaign_targets')
      .select(TARGET_COLUMNS)
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true })
      .range(from, from + TARGET_PAGE - 1)
    if (error) throw error
    const batch = Array.isArray(data) ? data : []
    let fresh = 0
    for (const row of batch) {
      const key = clean(row?.id) || `row:${rows.length}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
      fresh += 1
    }
    if (batch.length < TARGET_PAGE || fresh === 0) break
  }
  return rows
}

async function fetchFullTargets(supabase, ids = []) {
  if (!ids.length) return []
  const { data, error } = await supabase.from('campaign_targets').select('*').in('id', ids)
  if (error) throw error
  return Array.isArray(data) ? data : []
}

function describeSenders(inventory = []) {
  return (Array.isArray(inventory) ? inventory : [])
    .map((entry) => `${entry.phone_number} ${SENDER_STATE_LABELS[entry.unavailable_reason] || clean(entry.unavailable_reason).replace(/_/g, ' ') || 'available'}`)
    .join('; ')
}

/**
 * Per market of the routing-ready targets: can the planner's router place a
 * first touch there right now? Same function, same options as the plan.
 */
async function evaluateSenderCoverage(routingReady, deps, blockedSenders) {
  const byMarket = new Map()
  for (const row of routingReady) {
    const market = clean(row.market) || 'Unknown market'
    const entry = byMarket.get(market) || { market, state: clean(row.state) || null, sellers: 0 }
    entry.sellers += 1
    byMarket.set(market, entry)
  }
  const markets = [...byMarket.values()].sort((left, right) => right.sellers - left.sellers)
  const routeDeps = { ...deps }
  if (!Array.isArray(deps.textgridNumberRows) && typeof deps.chooseTextgridNumber !== 'function') {
    routeDeps.textgridNumberRows = await loadTextgridNumberFleet(deps).catch(() => [])
  }
  const routeOptions = {
    first_touch: true,
    routing_safe_only: true,
    blocked_sender_numbers: blockedSenders,
    // Today's per-number cap resets tomorrow; it paces, it doesn't block.
    ignore_daily_limit: true,
  }
  const results = []
  for (const entry of markets.slice(0, MAX_MARKETS_ROUTED)) {
    const routing = await chooseTextgridNumber(
      { market: entry.market === 'Unknown market' ? null : entry.market, state: entry.state, is_first_touch: true, touch_number: 1 },
      routeOptions,
      routeDeps,
    ).catch((error) => ({ ok: false, routing_block_reason: 'ROUTER_ERROR', error: error?.message }))
    results.push({
      market: entry.market,
      sellers: entry.sellers,
      sendable: routing.ok === true,
      sender: routing.ok ? routing.selected_textgrid_number || routing.selected?.phone_number || null : null,
      route_tier: routing.ok ? routing.routing_tier || null : null,
      block_reason: routing.ok ? null : routing.routing_block_reason || routing.reason_code || 'routing_blocked',
      senders: Array.isArray(routing.local_sender_inventory)
        ? routing.local_sender_inventory.map((sender) => ({ phone_number: sender.phone_number, state: sender.unavailable_reason || 'available' }))
        : [],
    })
  }
  // Markets past the routing budget are reported, not guessed.
  for (const entry of markets.slice(MAX_MARKETS_ROUTED)) {
    results.push({ market: entry.market, sellers: entry.sellers, sendable: null, sender: null, route_tier: null, block_reason: 'not_evaluated', senders: [] })
  }
  return results
}

/**
 * For any set of target-shaped rows (market/state): how many sellers a sender
 * can reach today, and per market why not. Reach uses it on the simulated
 * build, readiness on the stored targets — the same router either way.
 */
export async function evaluateAudienceSenderCoverage(rows = [], deps = {}) {
  const dispatchBlocked = await (deps.loadDispatchBlockedSets || loadDispatchBlockedSets)()
    .catch(() => ({ template_ids: new Set(), sender_numbers: new Set() }))
  const markets = rows.length ? await evaluateSenderCoverage(rows, deps, dispatchBlocked.sender_numbers) : []
  const total = (predicate) => markets.filter(predicate).reduce((sum, entry) => sum + entry.sellers, 0)
  return {
    sendable_now: total((entry) => entry.sendable === true),
    no_sendable_number: total((entry) => entry.sendable === false),
    not_evaluated: total((entry) => entry.sendable === null),
    markets: markets.map((entry) => ({ ...entry, summary: entry.sendable === false ? describeUnsendableMarket(entry) : null })),
  }
}

function describeUnsendableMarket(entry) {
  const senders = describeSenders(entry.senders.map((sender) => ({ phone_number: sender.phone_number, unavailable_reason: sender.state })))
  const why = entry.block_reason === 'NO_VALID_LOCAL_TEXTGRID_NUMBER'
    ? 'there is no sender number in this market'
    : senders || 'no sender route'
  return `${entry.market} (${nf(entry.sellers)} ${entry.sellers === 1 ? 'seller' : 'sellers'}): ${why}`
}

/**
 * Per language of the routing-ready targets: does the planner's renderer
 * produce an approved message? No stated language → English (documented
 * default, resolveTargetMessageLanguage).
 */
async function evaluateLanguageCoverage(routingReady, campaign, deps, context) {
  const groups = new Map()
  for (const row of routingReady) {
    const stated = resolveTargetMessageLanguage(row, campaign)
    const resolved = resolveLanguage(stated)
    const language = canonicalLanguageLabel(stated) || 'English'
    const group = groups.get(language) || { language, sellers: 0, unsupported: resolved.unsupported === true, sample_ids: [], assigned: 0 }
    group.sellers += 1
    if (clean(row.template_status) === 'ready') group.assigned += 1
    if (group.sample_ids.length < SAMPLES_PER_LANGUAGE) group.sample_ids.push(row.id)
    groups.set(language, group)
  }
  const ordered = [...groups.values()].sort((left, right) => right.sellers - left.sellers)
  const sampled = ordered.filter((group) => !group.unsupported).slice(0, MAX_LANGUAGES_SAMPLED)
  const sampleRows = await fetchFullTargets(context.supabase, sampled.flatMap((group) => group.sample_ids)).catch(() => [])
  const rowsById = new Map(sampleRows.map((row) => [clean(row.id), row]))
  const helpers = await campaignServiceHelpers()
  const personas = clean(campaign.agent_persona)
    ? new Map()
    : await helpers.loadOwnerPersonas(context.supabase, sampleRows.map((row) => row.master_owner_id)).catch(() => new Map())
  // A sample render only asks "does an approved message exist and render?".
  // Recent-template history changes WHICH variant rotation picks, never
  // whether one exists (all-recent falls back to the full pool), so the two
  // history reads per render are skipped here.
  const renderDeps = {
    ...deps,
    templateFetchCache: deps.templateFetchCache instanceof Map ? deps.templateFetchCache : new Map(),
    getRecentTemplateIds: typeof deps.getRecentTemplateIds === 'function'
      ? deps.getRecentTemplateIds
      : async () => ({ ok: true, template_ids: [], errors: [] }),
  }

  let rendered = 0
  let failed = 0
  const results = []
  for (const group of ordered) {
    if (group.unsupported) {
      results.push({ language: group.language, sellers: group.sellers, renders: false, reason: 'unsupported_language', samples: 0, assigned: group.assigned })
      continue
    }
    if (!sampled.includes(group)) {
      results.push({ language: group.language, sellers: group.sellers, renders: null, reason: 'not_evaluated', samples: 0, assigned: group.assigned })
      continue
    }
    /**
     * The question is whether an approved message EXISTS for the language. A
     * sample that picked a template and then failed on that seller's own data
     * (no first name → "Hi ," is refused) proves the language is covered; the
     * seller-level miss shows up in the plan's own skip counts. Only "no
     * template at all" makes a language gap.
     */
    let covered = false
    let reason = null
    let sellerLevel = null
    let samples = 0
    for (const id of group.sample_ids) {
      const target = rowsById.get(clean(id))
      if (!target) continue
      samples += 1
      const candidate = helpers.applyOwnerPersona(helpers.launchCandidateFromTarget(target, campaign), personas)
      candidate.stage_code = context.stageCode
      const result = await renderOutboundTemplate(candidate, {
        template_use_case: context.templateUseCase,
        stage_code: context.stageCode,
        first_touch: true,
        campaign_template_assignment: true,
        allow_identity_unknown: true,
        blocked_template_ids: context.blockedTemplates,
        governance_excluded_template_ids: context.governanceExcluded,
        campaign_session_id: campaign.id,
      }, renderDeps).catch((error) => ({ ok: false, reason_code: 'TEMPLATE_RENDER_FAILED', reason: error?.message }))
      const code = clean(result.reason_code || result.reason) || 'render_failed'
      if (result.ok && renderedTemplateId(result)) {
        covered = true
        rendered += 1
        break
      }
      failed += 1
      if (renderedTemplateId(result) && SELLER_LEVEL_RENDER_FAILURES.has(code)) {
        covered = true
        sellerLevel = sellerLevel || code
        break
      }
      reason = reason || code
    }
    results.push({
      language: group.language,
      sellers: group.sellers,
      renders: samples ? covered : null,
      reason: covered ? null : reason,
      seller_level_failure: sellerLevel,
      samples,
      assigned: group.assigned,
    })
  }
  return { languages: results, rendered, failed }
}

function describeLanguageGap(entry) {
  const who = `${nf(entry.sellers)} ${entry.language}-speaking ${entry.sellers === 1 ? 'seller' : 'sellers'}`
  if (entry.reason === 'unsupported_language') return `${entry.language} isn’t a supported message language — ${who} can’t be messaged`
  const why = RENDER_FAILURE_LABELS[entry.reason] || clean(entry.reason).replace(/_/g, ' ').toLowerCase() || 'no approved message'
  return `No approved ${entry.language} message (${why}) — ${who} can’t be messaged`
}

/** What the last real plan did, from the feeder's own heartbeat on the campaign. */
async function describeLastPlan(campaign) {
  const last = metadataObject(metadataObject(campaign.metadata).feeder_last)
  if (!clean(last.at)) return null
  const skipped = metadataObject(last.skipped_counts_by_reason)
  const { describePlanSkips } = await campaignServiceHelpers()
  return {
    at: last.at,
    inserted: Number(last.inserted || 0),
    ready_remaining: Number(last.ready_remaining || 0),
    reason: last.reason || null,
    stalled: last.stalled === true,
    skipped_counts_by_reason: skipped,
    summary: clean(last.skip_summary) || describePlanSkips(skipped, metadataObject(last.routing_blocks_by_market)),
  }
}

export async function evaluateCampaignLaunchReadiness(campaignId, deps = {}, options = {}) {
  const supabase = deps.supabase || defaultSupabase
  const blockers = []
  const blockerCodes = []
  const warnings = []
  const context = resolveLaunchReadinessContext(options)
  const block = (code, text = BLOCKER_LABELS[code]) => {
    blockers.push(text)
    blockerCodes.push(code)
  }

  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const status = normalizeCampaignStatus(campaign.status)
  const loadSystemValue = deps.getSystemValue
    ? (key) => deps.getSystemValue(key, { supabase })
    : (key) => getSystemValue(key, { supabase })

  const [
    emergencyStop,
    processorModeRaw,
    globalAutoEnqueue,
    outboundSms,
    targets,
    dispatchBlocked,
  ] = await Promise.all([
    loadSystemValue('queue_emergency_stop_at'),
    loadSystemValue('queue_processor_mode'),
    loadSystemValue('queue_auto_enqueue_enabled'),
    loadSystemValue('outbound_sms_enabled'),
    fetchReadinessTargets(supabase, campaignId),
    (deps.loadDispatchBlockedSets || loadDispatchBlockedSets)().catch(() => ({ template_ids: new Set(), sender_numbers: new Set() })),
  ])

  const brakeState = evaluateGlobalSendBrakeState({
    queue_emergency_stop_at: emergencyStop,
    queue_processor_mode: processorModeRaw,
  })

  if (context.controlled_hydration) {
    if (brakeState.emergency_stop_active) {
      warnings.push('Emergency stop is active — queue hydration allowed, live sends remain blocked until cleared')
    }
    if (brakeState.processor_paused) {
      warnings.push('Queue processor is paused — rows will hydrate but will not transmit until processor resumes')
    }
  } else {
    if (isEmergencyStopActive(emergencyStop)) block('emergency_stop')
    const processorMode = normalizeQueueProcessorMode(processorModeRaw, 'off')
    if (processorMode === 'off') block('queue_processor_disabled')
  }

  if (!context.controlled_hydration) {
    if (!asBoolean(globalAutoEnqueue, false)) block('global_auto_enqueue_disabled')
    if (!campaign.auto_queue_enabled) block('campaign_auto_queue_disabled')
    if (!campaign.auto_send_enabled) block('transmission_disabled')
  } else if (
    asBoolean(campaign.auto_send_enabled, false) &&
    !context.guarded_live_launch &&
    !asBoolean(campaign.metadata?.production_launch, false)
  ) {
    block('unrestricted_auto_send')
  }

  if (!asBoolean(outboundSms, false)) block('provider_disabled')
  // 0 is a set cap meaning "send nothing" (campaign-caps.js), not a missing one.
  if (zeroCampaignCaps(campaign).length) block('campaign_cap_zero')
  else if (parseCampaignCap(campaign.daily_cap) === null) block('missing_daily_cap')
  if (parseCampaignCap(campaign.total_cap) === null) warnings.push('Total send cap is not set')
  /**
   * batch_max and market_cap are NOT launch requirements. batch_max is the
   * worker's hydration chunk (the feeder owns its own chunk/buffer and never
   * reads it as a campaign size), and market_cap only bounds how many rows one
   * planning pass gives a single market. Neither has an operator control, so
   * blocking on them showed a "safety" blocker nobody could resolve.
   */
  // per_sender_cap is an optional override: absent, system_control
  // queue_per_number_cap governs (sender-capacity.js). Not a launch blocker.
  if (!campaign.contact_window_start || !campaign.contact_window_end) block('missing_send_window')

  const persistedTargetCount = targets.length
  const readyTargets = targets.filter((row) => clean(row.target_status) === 'ready')
  const readyTotal = readyTargets.length
  const routingReadyTargets = targets.filter(isTargetRoutingReady)
  const routingReadyTotal = routingReadyTargets.length
  const templateReadyTotal = targets.filter((row) => clean(row.template_status) === 'ready').length
  const suppressedTotal = targets.filter((row) => clean(row.suppression_status) === 'blocked').length
  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code || campaign.stage_code, 'S1')
  const templateUseCase = clean(campaign.metadata?.template_use_case || campaign.template_use_case || campaign.objective || 'ownership_check') || 'ownership_check'

  if (!readyTotal) block('no_ready_recipients')
  if (readyTotal > 0 && routingReadyTotal === 0) block('routing_zero')

  // ── senders: the plan's own router, per market ─────────────────────────────
  const senderCoverage = routingReadyTotal
    ? await evaluateSenderCoverage(routingReadyTargets, deps, dispatchBlocked.sender_numbers)
    : []
  const unsendableMarkets = senderCoverage.filter((entry) => entry.sendable === false)
  const sendableMarketNames = new Set(senderCoverage.filter((entry) => entry.sendable !== false).map((entry) => entry.market))
  const senderCoveredTotal = senderCoverage.filter((entry) => entry.sendable === true).reduce((sum, entry) => sum + entry.sellers, 0)
  const outsideSenderTotal = unsendableMarkets.reduce((sum, entry) => sum + entry.sellers, 0)
  if (routingReadyTotal > 0 && unsendableMarkets.length) {
    const detail = unsendableMarkets.slice(0, 4).map(describeUnsendableMarket).join(' · ')
    if (outsideSenderTotal >= routingReadyTotal) {
      block('zero_valid_senders', `${BLOCKER_LABELS.zero_valid_senders} — ${detail}`)
    } else {
      warnings.push(`${nf(outsideSenderTotal)} ready ${outsideSenderTotal === 1 ? 'seller has' : 'sellers have'} no sendable number and won’t be scheduled — ${detail}`)
    }
  }

  // ── templates: the plan's own renderer, per language ───────────────────────
  // Same governance exclusion the plan applies (rc-7.1 D8). Readiness is
  // advisory, so an unreadable table excludes nothing here; the plan refuses.
  const governanceExcluded = governanceApplies(templateUseCase)
    ? await (deps.loadGovernance || loadGovernance)(supabase).then(governanceExcludedTemplateIds).catch(() => new Set())
    : new Set()
  const languageCoverage = routingReadyTotal
    ? await evaluateLanguageCoverage(routingReadyTargets, campaign, deps, {
        supabase,
        stageCode,
        templateUseCase,
        blockedTemplates: dispatchBlocked.template_ids,
        governanceExcluded,
      })
    : { languages: [], rendered: 0, failed: 0 }
  const languageGaps = languageCoverage.languages.filter((entry) => entry.renders === false)
  const renderableLanguages = new Set(languageCoverage.languages.filter((entry) => entry.renders !== false).map((entry) => entry.language))
  const languageGapTotal = languageGaps.reduce((sum, entry) => sum + entry.sellers, 0)
  if (routingReadyTotal > 0 && languageGaps.length) {
    const detail = languageGaps.slice(0, 3).map(describeLanguageGap)
    if (languageGapTotal >= routingReadyTotal) {
      // No ready seller has a language with an approved message: the plan
      // would place nothing, so say so before activating rather than after.
      block('template_required', `${BLOCKER_LABELS.template_required} — ${detail.join(' · ')}`)
    } else {
      for (const line of detail) warnings.push(line)
    }
  }

  const sellerLevelMisses = languageCoverage.languages.filter((entry) => entry.seller_level_failure)
  if (sellerLevelMisses.length) {
    const why = sellerLevelMisses.some((entry) => entry.seller_level_failure === 'TEMPLATE_RENDER_LINT_FAILURE')
      ? 'no first name on file, so the greeting would read “Hi ,” and is refused'
      : 'their message could not be personalized'
    warnings.push(`Some sampled sellers (${sellerLevelMisses.map((entry) => entry.language).join(', ')}) will be skipped: ${why}. The launch check counts exactly how many.`)
  }

  // Launch-ready = routing-ready, in a market a sender can reach, in a language
  // an approved message renders for.
  const launchReadyTotal = routingReadyTargets.filter((row) => {
    const market = clean(row.market) || 'Unknown market'
    const language = canonicalLanguageLabel(resolveTargetMessageLanguage(row, campaign)) || 'English'
    return sendableMarketNames.has(market) && renderableLanguages.has(language)
  }).length
  if (routingReadyTotal > 0 && launchReadyTotal === 0 && !blockerCodes.includes('zero_valid_senders') && !blockerCodes.includes('template_required')) {
    block('no_launch_ready_recipients')
  }

  // ── the last real plan ─────────────────────────────────────────────────────
  const lastPlan = await describeLastPlan(campaign)
  if (lastPlan && lastPlan.inserted === 0 && lastPlan.summary && ['active', 'scheduled', 'queued', 'paused'].includes(status)) {
    warnings.push(`The last refill placed nothing — ${lastPlan.summary}`)
  }

  if (['archived', 'completed', 'failed'].includes(status)) block('campaign_not_queueable')

  const uniqueBlockers = [...new Set(blockers)]
  const uniqueCodes = [...new Set(blockerCodes)]
  const uniqueWarnings = [...new Set(warnings)]
  const level = uniqueBlockers.length ? 'blocked' : uniqueWarnings.length ? 'warnings' : 'ready'
  const templateSample = {
    resolved: languageCoverage.rendered,
    missing: languageCoverage.failed,
    sampled: languageCoverage.languages.reduce((sum, entry) => sum + Number(entry.samples || 0), 0),
  }

  return {
    ok: true,
    launch_readiness: level,
    blocker_count: uniqueBlockers.length,
    blocker_codes: uniqueCodes,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    template_readiness: !routingReadyTotal
      ? 'missing'
      : languageGapTotal === 0
        ? 'resolved'
        : languageGapTotal >= routingReadyTotal ? 'missing' : 'partial',
    template_sample: templateSample,
    language_coverage: languageCoverage.languages,
    sender_coverage: senderCoverage,
    last_plan: lastPlan,
    counts: {
      candidates_discovered:
        Number(campaign.metadata?.candidate_count || campaign.metadata?.preview_ready_to_queue || 0) || null,
      targets_persisted: persistedTargetCount,
      deduplicated: persistedTargetCount,
      routing_ready: routingReadyTotal,
      template_ready: templateReadyTotal,
      template_assigned: templateReadyTotal,
      sender_covered: senderCoveredTotal,
      contactable: Math.max(0, routingReadyTotal - suppressedTotal),
      launch_ready: launchReadyTotal,
      // Ready sellers whose language has no approved message — not "unassigned".
      awaiting_template: languageGapTotal,
      unsupported_language: languageGaps.filter((entry) => entry.reason === 'unsupported_language').reduce((sum, entry) => sum + entry.sellers, 0),
      outside_sender_capacity: outsideSenderTotal,
      suppressed: suppressedTotal,
      blocked: targets.filter((row) => clean(row.target_status) === 'blocked').length,
      warnings_count: uniqueWarnings.length,
      hard_blockers_count: uniqueBlockers.length,
      excluded: languageGapTotal + suppressedTotal,
    },
    ready_recipient_count: readyTotal,
    routable_recipient_count: routingReadyTotal,
    launch_ready_recipient_count: launchReadyTotal,
    remediation: uniqueBlockers,
    readiness_context: context,
    send_brake_state: brakeState,
    stage_code: stageCode,
    default_language: 'English',
    false_routing_blocker_removed: true,
  }
}
