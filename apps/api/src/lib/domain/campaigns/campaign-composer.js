/**
 * CAMPAIGN COMPOSER 2.0 — the composition surface's server contract.
 *
 * NOTHING HERE DECIDES ELIGIBILITY. Every number is read from the path that
 * already owns it, and every write goes through the canonical writer:
 *
 *   audience   previewCampaignTargets (dry run — the graph, the build
 *              simulation, the planner's router) shaped for the Composer;
 *              message samples rendered with the planner's renderer and the
 *              same governance / blocklist exclusions launch readiness uses.
 *   templates  sms_templates by use case × stage × language, minus the
 *              governed-but-not-sendable ids (template-governance.js, D8) and
 *              the operator blocklist (sms-health-guard.js).
 *   fleet      textgrid_numbers through loadTextgridNumberFleet (sent today
 *              derived from actual sends, D1), the router's eligibility
 *              (senderStateOf) and the operator blocklist.
 *   save       createCampaign / updateCampaign (D9: the PATCH states only what
 *              it carries — never status, never auto_send / auto_reply).
 *   prepare    buildCampaignTargets + evaluateCampaignLaunchReadiness — the
 *              legacy builder's preflight, unchanged.
 *   launch     prepare again, refuse unless ready and the confirmed count
 *              still holds, then the lifecycle route's own `schedule` (future
 *              start) or `activate` (start now, with an activation idempotency
 *              key). One audit event (campaign.composer_launched).
 *
 * IDEMPOTENCY. A composer session carries a composer_key (draft identity) and
 * a launch_key (one per confirmation). A LAUNCH is claimed in the database
 * (campaign-launch-claim.js — one per campaign across every process); saves
 * are single-flight per key and find the draft by metadata.composer_key.
 *
 * FAIL CLOSED. A read that fails is named; a launch whose readiness cannot be
 * read, whose start has passed (D4: Start now / Reschedule) or whose eligible
 * count is zero does nothing.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue } from '@/lib/system-control.js'
import {
  applyCampaignLifecycleAction,
  applyCanonicalSellerName,
  applyOwnerPersona,
  buildCampaignTargets,
  countCampaignAudienceCohort,
  countCampaignAudienceUniverse,
  createCampaign,
  launchCandidateFromTarget,
  loadOwnerPersonas,
  previewCampaignTargets,
  recordCampaignEvent,
  updateCampaign,
} from '@/lib/domain/campaigns/campaign-automation-service.js'
import { evaluateCampaignLaunchReadiness } from '@/lib/domain/campaigns/campaign-launch-readiness.js'
import { summarizeOfferReadiness, OFFER_READY_PROJECTION } from '@/lib/acquisition/offerReadiness.js'
import { fetchCanonicalLanguages } from '@/lib/domain/campaigns/campaign-recipient-metrics.js'
import { governanceApplies, governanceExcludedTemplateIds, evaluateTemplateGovernance, indexGovernance, loadGovernance } from '@/lib/domain/campaigns/template-governance.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { isValidCampaignCapInput, parseCampaignCap } from '@/lib/domain/campaigns/campaign-caps.js'
import { SCHEDULE_ACTIVATION_TOLERANCE_MS } from '@/lib/domain/campaigns/campaign-schedule-missed.js'
import { loadTextgridNumberFleet, renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { loadDispatchBlockedSets } from '@/lib/domain/delivery/sms-health-guard.js'
import { senderStateOf } from '@/lib/domain/campaigns/campaign-command-intel.js'
import { claimCampaignLaunch, finishCampaignLaunch } from '@/lib/domain/campaigns/campaign-launch-claim.js'

const clean = (value) => String(value ?? '').trim()
const lower = (value) => clean(value).toLowerCase()
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const posInt = (value) => {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}
const normalizePhone = (value) => {
  const digits = clean(value).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return clean(value) || null
}

/** The real campaign strategies: the use cases outbound campaigns render, each with its canonical stage. */
export const COMPOSER_STRATEGIES = Object.freeze([
  { use_case: 'ownership_check', stage_code: 'S1', label: 'Ownership check', touch: 'First touch' },
  { use_case: 'consider_selling', stage_code: 'S2', label: 'Consider selling', touch: 'Second touch' },
  { use_case: 'seller_asking_price', stage_code: 'S3', label: 'Asking price', touch: 'Price discovery' },
])
const STRATEGY_USE_CASES = COMPOSER_STRATEGIES.map((s) => s.use_case)

/** The draft states the Composer edits. Live campaigns are commanded in Campaign Command. */
export const COMPOSER_EDITABLE_STATUSES = Object.freeze(['draft', 'built'])

/* ── single-flight per key ──────────────────────────────────────────────── */

const flights = new Map()
function singleFlight(key, run) {
  if (!key) return run()
  const existing = flights.get(key)
  if (existing) return existing.then((result) => ({ ...result, idempotent: true }))
  const promise = Promise.resolve().then(run).finally(() => flights.delete(key))
  flights.set(key, promise)
  return promise
}
export function _resetComposerFlights() { flights.clear() }

/* ── composition → canonical campaign payload ───────────────────────────── */

const CAP_FIELDS = ['daily_cap', 'total_cap', 'market_cap', 'per_sender_cap']

/**
 * The campaign payload a composition states. Pure.
 *
 * NEVER carries `status` (D9: lifecycle is the state machine's), and never
 * `auto_send_enabled` / `auto_reply_mode` (campaignPatchScope writes any key a
 * PATCH carries — a builder that sent `false` on every save reset automation).
 * A cap of 0 stays 0 (D9b: send nothing); a blank cap is omitted, not invented.
 * No zone is written: recipient zones come from the built targets (D10).
 */
/** 'all' | 'custom' | null — the operator's explicit Campaign size choice. */
export function composerCampaignSize(value) {
  const v = clean(value).toLowerCase()
  return v === 'all' || v === 'custom' ? v : null
}

export function composerCampaignPayload(composition = {}, { isUpdate = false } = {}) {
  const c = obj(composition)
  const out = {}
  if (clean(c.name)) out.name = clean(c.name)
  if (c.description !== undefined) out.description = clean(c.description)
  const strategy = COMPOSER_STRATEGIES.find((s) => s.use_case === clean(c.template_use_case))
  if (strategy) {
    out.template_use_case = strategy.use_case
    out.stage_code = clean(c.stage_code) ? normalizeCampaignStageCode(c.stage_code, strategy.stage_code) : strategy.stage_code
  }
  // Campaign size is an explicit operator choice (owner rule 2026-10-03): "all"
  // = every eligible seller (no total cap, cleared on update), "custom" = the
  // stated number. Unchosen leaves the size unset and launch refuses.
  const size = composerCampaignSize(c.campaign_size)
  if (size === 'all') out.total_cap = null
  for (const field of CAP_FIELDS) {
    if (size === 'all' && field === 'total_cap') continue
    if (!(field in c)) continue
    const raw = c[field]
    if (raw === '' || raw === null || raw === undefined) continue
    if (!isValidCampaignCapInput(raw)) throw Object.assign(new Error(`invalid_cap:${field}`), { code: 'invalid_cap', field })
    out[field] = parseCampaignCap(raw)
  }
  const interval = posInt(c.send_interval_seconds)
  if (interval) out.send_interval_seconds = interval
  if (/^\d{2}:\d{2}$/.test(clean(c.contact_window_start))) out.contact_window_start = clean(c.contact_window_start)
  if (/^\d{2}:\d{2}$/.test(clean(c.contact_window_end))) out.contact_window_end = clean(c.contact_window_end)
  if (c.target_filters && typeof c.target_filters === 'object') {
    out.target_filters = {
      catalog_version: 'locked_approved_campaign_fields_v1',
      filter_mode: 'grouped_source_of_truth_domains',
      ...c.target_filters,
    }
  }
  const metadata = {}
  if (size) {
    if (size === 'custom' && out.total_cap === undefined) throw Object.assign(new Error('campaign_size_number_required'), { code: 'campaign_size_number_required', field: 'total_cap' })
    metadata.composer_campaign_size = size
    out.campaign_size = size
  }
  if (c.planned_start_at !== undefined) metadata.planned_first_scheduled_at = clean(c.planned_start_at) || null
  if (c.source && typeof c.source === 'object') metadata.composer_source = c.source
  if (!isUpdate && clean(c.composer_key)) metadata.composer_key = clean(c.composer_key)
  if (Object.keys(metadata).length) out.metadata = metadata
  if (!isUpdate) {
    out.status = 'draft'
    out.campaign_type = 'outbound_sms'
    out.auto_queue_enabled = true
  }
  return out
}

/* ── reads ──────────────────────────────────────────────────────────────── */

async function readControlValues(keys, deps) {
  const read = deps.getSystemValue || ((key) => getSystemValue(key, deps.supabase ? { supabase: deps.supabase } : undefined))
  const values = await Promise.all(keys.map((key) => Promise.resolve(read(key)).catch(() => null)))
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]))
}

const STATE_OF_MARKET = (market) => {
  const m = /,\s*([A-Za-z]{2})\s*$/.exec(clean(market))
  return m ? m[1].toUpperCase() : null
}

/**
 * The sender fleet as the Composer's delivery plane reads it: the router's
 * state per number, actual sends today, the effective per-number limit, and a
 * per-market roll-up. Projected fields only (the table holds provider config).
 */
export function summarizeComposerFleet(rows = [], { blocked = new Set(), perNumberCap = null, now = new Date() } = {}) {
  const numbers = rows.map((row) => {
    const verdict = senderStateOf(row, { blocked, now })
    const limit = posInt(perNumberCap) ?? posInt(row.daily_limit)
    const sentToday = Math.max(0, num(row.messages_sent_today) ?? 0)
    return {
      phone: normalizePhone(row.phone_number),
      label: clean(row.friendly_name) || null,
      market: clean(row.market) || null,
      state: STATE_OF_MARKET(row.market),
      sender_state: verdict.state,
      reason: verdict.reason,
      eligible: verdict.eligible,
      cooling_until: clean(row.cooling_until) || null,
      limit,
      limit_basis: posInt(perNumberCap) ? 'system' : posInt(row.daily_limit) ? 'number' : null,
      sent_today: sentToday,
      remaining_today: verdict.eligible && limit ? Math.max(0, limit - sentToday) : 0,
    }
  })
  const markets = new Map()
  for (const n of numbers) {
    const key = n.market || 'Unassigned'
    const m = markets.get(key) || { market: key, state: n.state, numbers: 0, by_state: {}, capacity_per_day: 0, remaining_today: 0, unavailable_per_day: 0, unknown_limit: 0 }
    m.numbers += 1
    m.by_state[n.sender_state] = (m.by_state[n.sender_state] || 0) + 1
    if (n.limit === null) m.unknown_limit += 1
    else if (n.eligible || n.sender_state === 'cap_reached') m.capacity_per_day += n.limit
    else m.unavailable_per_day += n.limit
    m.remaining_today += n.remaining_today
    markets.set(key, m)
  }
  return { numbers, markets: [...markets.values()].sort((a, b) => a.market.localeCompare(b.market)) }
}

export async function readComposerFleet(deps = {}) {
  const now = deps.now ? new Date(deps.now) : new Date()
  const [rows, blockedSets, controls] = await Promise.all([
    (deps.loadTextgridNumberFleet || loadTextgridNumberFleet)(deps),
    (deps.loadDispatchBlockedSets || loadDispatchBlockedSets)().catch(() => null),
    readControlValues(['queue_per_number_cap', 'queue_processor_mode', 'queue_emergency_stop_at', 'outbound_sms_enabled', 'queue_contact_window_start', 'queue_contact_window_end', 'auto_reply_mode', 'followup_automation_mode'], deps),
  ])
  const perNumberCap = posInt(controls.queue_per_number_cap)
  const fleet = summarizeComposerFleet(Array.isArray(rows) ? rows : [], {
    blocked: blockedSets?.sender_numbers instanceof Set ? blockedSets.sender_numbers : new Set(),
    perNumberCap,
    now,
  })
  return {
    ok: true,
    at: now.toISOString(),
    ...fleet,
    blocklist_readable: Boolean(blockedSets),
    system: {
      per_number_cap: perNumberCap,
      processor_mode: clean(controls.queue_processor_mode) || null,
      emergency_stop_at: clean(controls.queue_emergency_stop_at) || null,
      outbound_sms_enabled: controls.outbound_sms_enabled == null ? null : ['true', '1', 'yes', 'on'].includes(lower(controls.outbound_sms_enabled)),
      contact_window: { start: clean(controls.queue_contact_window_start) || '08:00', end: clean(controls.queue_contact_window_end) || '21:00' },
      auto_reply_mode: clean(controls.auto_reply_mode) || null,
      followup_automation_mode: clean(controls.followup_automation_mode) || null,
    },
  }
}

/** Is this template selectable as a campaign's message? A paused / blocklisted / inactive / quarantined one is not — with the reason. */
export function templateSelectability(template = {}, { governanceRow = null, governed = false, blocklisted = false } = {}) {
  if (blocklisted) return { selectable: false, reason: 'blocked_by_operator' }
  if (template.is_active !== true) return { selectable: false, reason: 'template_inactive' }
  const q = lower(template.quarantine_state)
  // 'active' is the sendable quarantine state (resolve-deferred-queue-message.js reads eq('quarantine_state','active'))
  if (q && q !== 'active') return { selectable: false, reason: 'template_quarantined' }
  if (governed && governanceRow) {
    const verdict = evaluateTemplateGovernance({ ...template, template_body: template.template_body ?? 'x' }, governanceRow, { applies: true })
    if (!verdict.ok) return { selectable: false, reason: verdict.reason, notes: clean(governanceRow.notes) || null }
  }
  return { selectable: true, reason: null }
}

/** Template coverage per strategy × language. Performance is reported only from the governance ledger's own sample, with its size. */
export function summarizeTemplateCoverage(templates = [], { governanceById = new Map(), blockedIds = new Set(), minSample = 200 } = {}) {
  const strategies = COMPOSER_STRATEGIES.map((s) => ({ ...s, languages: new Map(), governed: [] }))
  const byUseCase = new Map(strategies.map((s) => [s.use_case, s]))
  for (const t of templates) {
    const strategy = byUseCase.get(clean(t.use_case))
    if (!strategy) continue
    if (normalizeCampaignStageCode(t.stage_code, '') !== strategy.stage_code) continue
    const id = clean(t.template_id || t.id)
    const governed = governanceApplies(strategy.use_case)
    const row = governanceById.get(id) || null
    const verdict = templateSelectability(t, { governanceRow: row, governed, blocklisted: blockedIds.has(id) })
    const language = clean(t.language) || 'English'
    const entry = strategy.languages.get(language) || { language, templates: 0, sendable: 0, paused: 0, blocked: 0, inactive: 0 }
    entry.templates += 1
    if (verdict.selectable) entry.sendable += 1
    else if (verdict.reason === 'blocked_by_operator') entry.blocked += 1
    else if (verdict.reason === 'template_inactive') entry.inactive += 1
    else entry.paused += 1
    strategy.languages.set(language, entry)
    if (row) {
      const sent = num(row.last_40d_total_sent)
      strategy.governed.push({
        template_id: id,
        name: clean(t.template_name) || id,
        language,
        rotation_status: clean(row.rotation_status) || null,
        selectable: verdict.selectable,
        reason: verdict.reason,
        notes: clean(row.notes) || null,
        daily_cap: num(row.daily_cap),
        performance: sent !== null && sent >= minSample
          ? { sample: sent, reply_rate: num(row.last_40d_reply_rate), delivery_rate: num(row.last_40d_delivery_rate), opt_out_rate: num(row.last_40d_opt_out_rate) }
          : null,
        performance_sample: sent,
      })
    }
  }
  return strategies.map((s) => ({
    use_case: s.use_case,
    stage_code: s.stage_code,
    label: s.label,
    touch: s.touch,
    languages: [...s.languages.values()].sort((a, b) => b.templates - a.templates || a.language.localeCompare(b.language)),
    templates: [...s.languages.values()].reduce((sum, l) => sum + l.templates, 0),
    sendable: [...s.languages.values()].reduce((sum, l) => sum + l.sendable, 0),
    governed: s.governed.sort((a, b) => Number(b.selectable) - Number(a.selectable) || a.template_id.localeCompare(b.template_id)),
  }))
}

let templateCache = null
export async function readComposerTemplates(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const nowMs = Date.now()
  if (!deps.fresh && templateCache && nowMs - templateCache.at < 60_000) return templateCache.value
  // Active templates only (an inactive template is never selectable); the
  // first page carries the exact count, the rest are read in parallel.
  const page = (index, withCount) => supabase.from('sms_templates')
    .select('id,template_id,template_name,use_case,stage_code,language,is_active,quarantine_state', withCount ? { count: 'exact' } : undefined)
    .in('use_case', STRATEGY_USE_CASES)
    .eq('is_active', true)
    .order('id', { ascending: true })
    .range(index * 1000, index * 1000 + 999)
  const first = await page(0, true)
  if (first.error) throw first.error
  const rows = [...(first.data || [])]
  const pages = Math.min(20, Math.ceil(Number(first.count || rows.length) / 1000))
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => page(i + 1, false)))
  for (const r of rest) {
    if (r.error) throw r.error
    rows.push(...(r.data || []))
  }
  const [governanceById, blockedSets] = await Promise.all([
    (deps.loadGovernance || loadGovernance)(supabase).catch(() => null),
    (deps.loadDispatchBlockedSets || loadDispatchBlockedSets)().catch(() => null),
  ])
  const value = {
    ok: true,
    at: new Date(nowMs).toISOString(),
    governance_readable: governanceById instanceof Map,
    strategies: summarizeTemplateCoverage(rows, {
      governanceById: governanceById instanceof Map ? governanceById : indexGovernance([]),
      blockedIds: blockedSets?.template_ids instanceof Set ? blockedSets.template_ids : new Set(),
    }),
  }
  templateCache = { at: nowMs, value }
  return value
}

/* ── audience ───────────────────────────────────────────────────────────── */

const firstName = (value) => clean(value).split(/\s+/)[0] || null

/** Language holds for the funnel: totals + per-language counts (markets stay server-side). Null when not measured. */
function languageHoldsDigest(value) {
  if (!value || typeof value !== 'object') return null
  const byLanguage = {}
  for (const [language, count] of Object.entries(obj(value.by_language))) byLanguage[language] = num(count)
  return { held: num(value.held), by_language: byLanguage, held_and_refused: num(value.held_and_refused) }
}

/**
 * Shape a dry-run preview for the Composer. Units stay apart: graph counts
 * (the whole matched audience), the simulated build (the rows Build will
 * read, up to its limit) and the build's ready set are three numbers.
 */
export function composerAudienceFromPreview(preview = {}) {
  const p = obj(preview)
  const blocked = obj(p.blocked)
  const byReason = obj(p.blocked_counts_by_reason)
  const sim = obj(p.build_simulation)
  const dist = obj(p.distributions)
  const zones = Array.isArray(dist.recipientZones) ? dist.recipientZones : []
  const unresolved = zones.find((z) => z.value === 'unresolved')?.count || 0
  const scanned = zones.reduce((sum, z) => sum + Number(z.count || 0), 0)
  return {
    matched: num(p.filter_matched ?? p.total_matched),
    addressable: num(p.addressable_properties),
    reachable: num(obj(p.reach).reachableContacts),
    sms_eligible: num(p.sms_eligible_phones),
    clean: num(p.clean_targets),
    eligible_in_audience: num(p.ready_to_queue),
    exclusions: {
      suppressed: num(blocked.suppressed),
      dnc: num(blocked.dnc),
      wrong_number: num(blocked.wrongNumber),
      no_phone: num(blocked.noPhone ?? byReason.NO_PHONE),
      sms_ineligible: num(byReason.SMS_INELIGIBLE),
      no_sender_route: num(byReason.routing_blocked ?? blocked.noSenderCoverage),
      pending_prior_touch: num(byReason.PENDING_PRIOR_TOUCH),
      active_queue: num(byReason.ACTIVE_QUEUE_ITEM),
    },
    build: sim.ok === false ? { ok: false, error: clean(sim.error) || 'build_simulation_failed' } : {
      ok: sim.ok === true,
      requested_limit: num(sim.requested_limit),
      simulated_limit: num(sim.simulated_limit),
      capped_by_preview: sim.capped_by_preview === true,
      rows_read: num(sim.queue_eligible_rows_read),
      recipients: num(sim.recipients),
      duplicates_collapsed: num(sim.duplicate_phones_collapsed),
      built: num(sim.built),
      ready: num(sim.ready),
      held: num(sim.held),
      held_by_reason: obj(sim.held_by_reason),
      language_holds: languageHoldsDigest(sim.language_holds),
      sendable_after_language: sim.sendable_after_language ?? null,
      sendable_now: num(sim.sendable_now),
      no_sendable_number: num(sim.no_sendable_number),
      sender_markets: (Array.isArray(sim.sender_markets) ? sim.sender_markets : []).map((m) => ({
        market: m.market, sellers: num(m.sellers), sendable: m.sendable ?? null, route_tier: m.route_tier || null, block_reason: m.block_reason || null, summary: m.summary || null,
      })),
    },
    distributions: {
      markets: (dist.markets || []).slice(0, 24),
      languages: (dist.languages || []).slice(0, 12),
      property_types: (dist.propertyTypes || []).slice(0, 12),
      zips: (dist.zips || []).slice(0, 48),
      zones: zones.filter((z) => z.value !== 'unresolved'),
    },
    zones: { scanned, unresolved },
    inapplicable_filters: Array.isArray(p.inapplicable_filters) ? p.inapplicable_filters : [],
    unsupported_filters: Array.isArray(p.unsupported_in_preview) ? p.unsupported_in_preview : [],
    dropped_filter_count: num(p.dropped_filter_count) || 0,
    graph_freshness: obj(p.graph_freshness),
    graph_unavailable: p.graph_unavailable === true,
    warnings: Array.isArray(p.warnings) ? p.warnings.filter((w) => !/preview_source_normalized/.test(String(w))) : [],
  }
}

/**
 * The audience projection's latest measured coverage (share of rows with a
 * value per targeting column) and build/enrich times, from
 * campaign_target_graph_coverage (PROPOSED_20261003220000). Null — never a
 * guess — until that table exists and has a measurement.
 */
export async function readGraphCoverage(supabase, deps = {}) {
  if (deps.readGraphCoverage) return deps.readGraphCoverage()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('campaign_target_graph_coverage')
    .select('measured_at,sample_rows,latest_built_at,oldest_enriched_at,latest_enriched_at,coverage')
    .order('measured_at', { ascending: false })
    .limit(1)
  if (error || !Array.isArray(data) || !data.length) return null
  const row = data[0]
  return {
    measured_at: row.measured_at || null,
    sample_rows: num(row.sample_rows),
    latest_built_at: row.latest_built_at || null,
    oldest_enriched_at: row.oldest_enriched_at || null,
    latest_enriched_at: row.latest_enriched_at || null,
    coverage: obj(row.coverage),
  }
}

/** Render a few ready targets with the planner's renderer — the launch-readiness sample path. */
/**
 * The preview's target rows are raw graph snapshots: no canonical language and
 * no seller name (the graph carries neither). Build resolves both in
 * planCampaignTargetRows; the samples must render what Build will write, so
 * they get the same set-based enrichment (one prospects read for ≤3 rows).
 */
export async function enrichSampleRows(rows = [], deps = {}) {
  if (!rows.length) return rows
  const keyed = rows.map((row) => {
    const snapshot = obj(obj(row.metadata).candidate_snapshot)
    return { row, snapshot, probe: { seller_person_key: clean(snapshot.seller_person_key), master_owner_id: clean(row.master_owner_id) } }
  })
  const lookup = await (deps.fetchCanonicalLanguages || fetchCanonicalLanguages)(keyed.map((k) => k.probe), deps).catch(() => null)
  if (!lookup) return rows
  return keyed.map(({ row, snapshot, probe }) => {
    const named = applyCanonicalSellerName({ ...snapshot, seller_person_key: probe.seller_person_key }, lookup)
    const language = clean(row.language) || lookup.resolve(probe).language || null
    return { ...row, language, metadata: { ...obj(row.metadata), candidate_snapshot: named } }
  })
}

export async function renderComposerSamples(rows = [], { templateUseCase, stageCode, supabase } = {}, deps = {}) {
  const ready = await enrichSampleRows(rows.filter((row) => clean(row.target_status) === 'ready').slice(0, 3), { ...deps, supabase: deps.supabase || supabase })
  if (!ready.length) return []
  const [dispatchBlocked, governanceExcluded, personas] = await Promise.all([
    (deps.loadDispatchBlockedSets || loadDispatchBlockedSets)().catch(() => ({ template_ids: new Set() })),
    governanceApplies(templateUseCase)
      ? (deps.loadGovernance || loadGovernance)(supabase).then(governanceExcludedTemplateIds).catch(() => null)
      : Promise.resolve(new Set()),
    loadOwnerPersonas(supabase, ready.map((row) => row.master_owner_id)).catch(() => new Map()),
  ])
  // Governance unreadable: the plan refuses, so the preview does not pretend.
  if (governanceExcluded === null) return ready.map((row) => ({ id: row.campaign_key || row.property_id, ok: false, reason: 'governance_unreadable' }))
  const renderDeps = {
    ...deps,
    templateFetchCache: new Map(),
    getRecentTemplateIds: async () => ({ ok: true, template_ids: [], errors: [] }),
  }
  const out = []
  for (const row of ready) {
    const snapshot = obj(obj(row.metadata).candidate_snapshot)
    const candidate = applyOwnerPersona(launchCandidateFromTarget(row, { market: row.market }), personas)
    candidate.stage_code = stageCode
    const result = await renderOutboundTemplate(candidate, {
      template_use_case: templateUseCase,
      stage_code: stageCode,
      first_touch: true,
      campaign_template_assignment: true,
      allow_identity_unknown: true,
      blocked_template_ids: dispatchBlocked.template_ids,
      governance_excluded_template_ids: governanceExcluded,
    }, renderDeps).catch((error) => ({ ok: false, reason_code: 'TEMPLATE_RENDER_FAILED', reason: error?.message }))
    out.push({
      id: clean(row.campaign_key) || clean(row.property_id),
      property_id: clean(row.property_id) || null,
      // minimal PII: first name, city/state — never the phone
      recipient: firstName(snapshot.seller_first_name) || null,
      place: [clean(snapshot.property_city), clean(row.state)].filter(Boolean).join(', ') || clean(row.market) || null,
      market: clean(row.market) || null,
      language: clean(row.language) || null,
      ok: result?.ok === true,
      text: result?.ok ? clean(result.rendered_message_body) || null : null,
      template_id: result?.ok ? clean(result.selected_template_preview?.template_id || result.template?.template_id) || null : null,
      template_language: result?.ok ? clean(result.language) || null : null,
      reason: result?.ok ? null : clean(result?.reason_code || result?.reason) || 'render_failed',
    })
  }
  return out
}

export async function readComposerAudience(spec = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const s = obj(spec)
  const strategy = COMPOSER_STRATEGIES.find((x) => x.use_case === clean(s.template_use_case)) || COMPOSER_STRATEGIES[0]
  const stageCode = clean(s.stage_code) ? normalizeCampaignStageCode(s.stage_code, strategy.stage_code) : strategy.stage_code
  const totalCap = parseCampaignCap(s.total_cap)
  // The preview, the location universe and the coverage measurement are
  // independent reads: started together, not one after another.
  const [preview, universe, coverage] = await Promise.all([
    (deps.previewCampaignTargets || previewCampaignTargets)({
      filters: obj(s.filters),
      template_use_case: strategy.use_case,
      stage_code: stageCode,
      limitPreview: 25,
      ...(totalCap ? { build_limit: totalCap } : {}),
      ...(parseCampaignCap(s.daily_cap) !== null ? { daily_cap: parseCampaignCap(s.daily_cap) } : {}),
    }, deps),
    (deps.countCampaignAudienceUniverse || countCampaignAudienceUniverse)({ filters: obj(s.filters), template_use_case: strategy.use_case, stage_code: stageCode }, deps).catch(() => null),
    readGraphCoverage(supabase, deps).catch(() => null),
  ])
  if (!preview || preview.ok === false) {
    return { ok: false, error: clean(preview?.error) || 'audience_unavailable', message: clean(preview?.message) || null }
  }
  const audience = composerAudienceFromPreview(preview)
  audience.universe = universe?.ok
    ? { count: num(universe.count), location_filters: universe.location_filters || [], targeting_filters: universe.targeting_filters || [] }
    : null
  audience.graph_coverage = coverage
  const samples = s.render === false
    ? []
    : await renderComposerSamples(Array.isArray(preview.target_rows) ? preview.target_rows : [], { templateUseCase: strategy.use_case, stageCode, supabase }, deps).catch(() => [])
  return { ok: true, at: new Date().toISOString(), strategy: { use_case: strategy.use_case, stage_code: stageCode }, ...audience, samples }
}

/**
 * The authoritative cohort count for any audience size (the build's own
 * pipeline over every row Build could read — countCampaignAudienceCohort).
 * Aggregates only. Cached briefly per spec: a composition is re-read often.
 */
const cohortCache = new Map()
const cohortFlights = new Map()
/** How many cached cohorts keep their member identities (the map preview's input). */
const MEMBER_CACHE_ENTRIES = 4
const COHORT_TTL_MS = 60_000
const cohortKeyOf = (s, strategy) => JSON.stringify({ f: obj(s.filters), u: strategy.use_case })
const strategyOf = (s) => COMPOSER_STRATEGIES.find((x) => x.use_case === clean(s.template_use_case)) || COMPOSER_STRATEGIES[0]

export async function readComposerCohort(spec = {}, deps = {}) {
  const s = obj(spec)
  const strategy = strategyOf(s)
  const key = cohortKeyOf(s, strategy)
  const hit = cohortCache.get(key)
  if (!deps.fresh && hit && Date.now() - hit.at < COHORT_TTL_MS) return { ...hit.value, cached: true }
  // one run per spec at a time: the Composer and a Map preview asking together share it
  const inFlight = cohortFlights.get(key)
  if (inFlight) return inFlight
  const run = runComposerCohort(s, strategy, key, deps).finally(() => cohortFlights.delete(key))
  cohortFlights.set(key, run)
  return run
}

async function runComposerCohort(s, strategy, key, deps) {
  const result = await (deps.countCampaignAudienceCohort || countCampaignAudienceCohort)({
    filters: obj(s.filters),
    template_use_case: strategy.use_case,
    stage_code: strategy.stage_code,
    include_members: true,
  }, deps)
  if (!result?.ok) return { ok: false, error: clean(result?.error) || 'cohort_unavailable', message: clean(result?.message) || null }
  const value = {
    ok: true,
    at: new Date().toISOString(),
    queue_eligible_in_audience: result.queue_eligible_in_audience,
    rows_read: result.rows_read,
    capped_by_build_limit: result.capped_by_build_limit,
    build_limit: result.build_limit,
    recipients: result.recipients,
    duplicates_collapsed: result.duplicate_phones_collapsed,
    ready: result.ready,
    held: result.held,
    held_by_reason: result.held_by_reason,
    sendable_now: result.sendable_now,
    no_sendable_number: result.no_sendable_number,
    sender_markets: (result.sender_markets || []).map((m) => ({ market: m.market, sellers: m.sellers, sendable: m.sendable ?? null, route_tier: m.route_tier || null, block_reason: m.block_reason || null, summary: m.summary || null })),
    personalization: result.personalization
      ? { first_name: num(result.personalization.first_name), deed_name: num(result.personalization.deed_name), none: num(result.personalization.none) }
      : null,
    language_holds: languageHoldsDigest(result.language_holds),
    sendable_after_personalization: result.sendable_after_personalization ?? null,
    ready_by_zone: result.ready_by_zone,
    ready_by_market: result.ready_by_market,
    timings_ms: result.timings_ms,
  }
  // the ready set's identities stay on the server (the cohort response never carries them)
  const members = Array.isArray(result.members) ? result.members : null
  cohortCache.delete(key)
  cohortCache.set(key, { at: Date.now(), value, members })
  if (cohortCache.size > 50) cohortCache.delete(cohortCache.keys().next().value)
  // only the newest few keep their members (memory bound: ≤ build limit ids each)
  const entries = [...cohortCache.values()]
  for (const entry of entries.slice(0, Math.max(0, entries.length - MEMBER_CACHE_ENTRIES))) entry.members = null
  return value
}

/* ── Offer Ready preflight ─────────────────────────────────────────────── */

const OFFER_READY_ID_CHUNK = 200
// The predicate's own projection, so the sanity guard sees value/repairs/AVM/identity.
const OFFER_READY_SELECT = OFFER_READY_PROJECTION

/** The decision fields of property_acquisition_scores for a set of ids (projected; never full evidence). */
export async function readOfferReadinessScores(ids = [], deps = {}) {
  const db = deps.supabase || defaultSupabase
  const out = new Map()
  const unique = [...new Set(ids.map(clean).filter(Boolean))]
  for (let i = 0; i < unique.length; i += OFFER_READY_ID_CHUNK) {
    const { data, error } = await db.from('property_acquisition_scores').select(OFFER_READY_SELECT).in('property_id', unique.slice(i, i + OFFER_READY_ID_CHUNK))
    if (error) throw error
    for (const r of data || []) {
      out.set(clean(r.property_id), {
        ...r,
        evidence: {
          offer_calculation: { effective_authorized_ceiling: r.mao ?? null },
          ...(r.evidence_mode ? { backfill: { evidence_mode: r.evidence_mode, monetary_authority: false } } : {}),
        },
      })
    }
  }
  return out
}

/**
 * "2,348 sendable · 2,311 offer-ready · 37 review-only" — computed with the
 * SAME predicate Seller Autopilot v2 uses before it may quote money
 * (lib/acquisition/offerReadiness.js). Review-only properties are still
 * contacted; Autopilot converses with them but never sends a number.
 *   readComposerOfferReadiness({ campaign_id })  an existing campaign's queue-eligible targets
 *   readComposerOfferReadiness({ spec })         a composition's eligible cohort (shares the cohort cache)
 */
export async function readComposerOfferReadiness({ campaign_id = null, spec = null } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  let ids = []
  let source
  if (clean(campaign_id)) {
    source = 'campaign_targets'
    let from = 0
    for (;;) {
      const { data, error } = await db
        .from('campaign_targets')
        .select('property_id')
        .eq('campaign_id', clean(campaign_id))
        .in('target_status', ['ready', 'planned'])
        .not('property_id', 'is', null)
        .order('property_id', { ascending: true })
        .range(from, from + 999)
      if (error) return { ok: false, error: 'campaign_targets_unavailable', message: error.message }
      ids.push(...(data || []).map((r) => clean(r.property_id)))
      if (!data || data.length < 1000) break
      from += 1000
    }
  } else {
    source = 'composer_cohort'
    const s = obj(spec)
    const strategy = strategyOf(s)
    const key = cohortKeyOf(s, strategy)
    let entry = cohortCache.get(key)
    let cohort = entry && Date.now() - entry.at < COHORT_TTL_MS && entry.members ? entry.value : null
    if (!cohort) {
      cohort = await readComposerCohort(s, { ...deps, fresh: true })
      if (!cohort?.ok) return { ok: false, error: clean(cohort?.error) || 'cohort_unavailable', message: clean(cohort?.message) || null }
      entry = cohortCache.get(key)
    }
    if (!Array.isArray(entry?.members)) return { ok: false, error: 'cohort_members_unavailable' }
    ids = eligibleMembers(entry.members, cohort.sender_markets).eligible.map((m) => clean(m.property_id))
  }
  let scores
  try {
    scores = await (deps.readOfferReadinessScores || readOfferReadinessScores)(ids, deps)
  } catch (error) {
    return { ok: false, error: 'scores_unavailable', message: error?.message || String(error) }
  }
  return { ok: true, source, at: new Date().toISOString(), ...summarizeOfferReadiness(ids, scores, { now: deps.now || Date.now() }) }
}

/* ── campaign map preview: the eligible cohort's geography ─────────────── */

/** Ids per coordinate statement (one indexed ANY() read; 15K ids measured at ~0.7 s). */
const GEO_ID_CHUNK = 10_000
const GEO_REST_CHUNK = 200
const GEO_TTL_MS = 60_000
const geoCache = new Map()
const geoFlights = new Map()

const usableLngLat = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Math.abs(lat) < 0.1 && Math.abs(lng) < 0.1)
const round6 = (v) => Math.round(v * 1e6) / 1e6

/**
 * Canonical coordinates (properties.latitude / longitude) for a batch of
 * property ids. Direct Postgres when available — one `= ANY($1)` statement per
 * 10K ids on the unique property_id index, 30 s statement timeout — otherwise
 * PostgREST in 200-id slices. Never per property, never a geocode.
 */
export async function readPropertyCoordinates(ids = [], deps = {}) {
  if (deps.readPropertyCoordinates) return deps.readPropertyCoordinates(ids)
  const out = new Map()
  const unique = [...new Set(ids.map(clean).filter(Boolean))]
  if (!unique.length) return out
  const pg = await import('@/lib/postgres/client.js')
  if (pg.hasDatabaseUrl()) {
    for (let i = 0; i < unique.length; i += GEO_ID_CHUNK) {
      const slice = unique.slice(i, i + GEO_ID_CHUNK)
      const { rows } = await pg.queryWithTimeout(
        'SELECT property_id, latitude::float8 AS lat, longitude::float8 AS lng FROM public.properties WHERE property_id = ANY($1::text[])',
        [slice],
        30_000,
      )
      for (const row of rows || []) out.set(clean(row.property_id), { lat: Number(row.lat), lng: Number(row.lng) })
    }
    return out
  }
  const supabase = deps.supabase || defaultSupabase
  for (let i = 0; i < unique.length; i += GEO_REST_CHUNK) {
    const { data, error } = await supabase.from('properties').select('property_id,latitude,longitude').in('property_id', unique.slice(i, i + GEO_REST_CHUNK))
    if (error) throw new Error(error.message || 'coordinates_unreadable')
    for (const row of data || []) out.set(clean(row.property_id), { lat: Number(row.latitude), lng: Number(row.longitude) })
  }
  return out
}

/**
 * Which ready members are in "Eligible" — the same rule the whole-cohort count
 * applies (sendableAfterPersonalization): a sender carries the market
 * (sendable === true), the greeting renders (personalization ≠ none) and the
 * seller's language has a supported template (language_hold null). The
 * Map never decides this; it draws what this returns.
 */
export function eligibleMembers(members = [], senderMarkets = []) {
  const sendable = new Map((senderMarkets || []).map((m) => [clean(m?.market), m?.sendable ?? null]))
  const eligible = []
  const excludedByMarket = new Map()
  let notRoutable = 0
  let noGreeting = 0
  let languageHeld = 0
  const tally = (market, reason) => {
    const row = excludedByMarket.get(market) || { not_routable: 0, no_greeting: 0, language_held: 0 }
    row[reason] += 1
    excludedByMarket.set(market, row)
  }
  for (const m of members || []) {
    if (!m) continue
    const routeKey = clean(m.market) || 'Unknown market'
    if (sendable.get(routeKey) !== true) { notRoutable += 1; tally(routeKey, 'not_routable'); continue }
    if (m.greeting === 'none') { noGreeting += 1; tally(routeKey, 'no_greeting'); continue }
    if (m.language_hold) { languageHeld += 1; tally(routeKey, 'language_held'); continue }
    eligible.push(m)
  }
  return { eligible, not_routable: notRoutable, no_greeting: noGreeting, language_held: languageHeld, excluded_by_market: excludedByMarket }
}

/**
 * THE CAMPAIGN MAP PREVIEW's data: the eligible cohort (the same server
 * pipeline that produces the Composer's "Eligible: N" — readComposerCohort,
 * shared cache and single flight) placed on canonical coordinates. Eligible,
 * mapped and without-coordinates are reported separately; nothing is guessed.
 * Columnar points (ids / lng / lat / market index) keep 50K targets compact.
 * Read-only. Cached briefly per spec.
 */
export async function readComposerGeography(spec = {}, deps = {}) {
  const s = obj(spec)
  const strategy = strategyOf(s)
  const key = cohortKeyOf(s, strategy)
  const hit = geoCache.get(key)
  if (!deps.fresh && hit && Date.now() - hit.at < GEO_TTL_MS) return { ...hit.value, cached: true }
  const inFlight = geoFlights.get(key)
  if (inFlight) return inFlight
  const run = runComposerGeography(s, key, deps).finally(() => geoFlights.delete(key))
  geoFlights.set(key, run)
  return run
}

async function runComposerGeography(s, key, deps) {
  const startedAt = Date.now()
  let entry = cohortCache.get(key)
  let cohort = entry && Date.now() - entry.at < COHORT_TTL_MS && entry.members ? entry.value : null
  if (!cohort) {
    cohort = await readComposerCohort(s, { ...deps, fresh: true })
    if (!cohort?.ok) return { ok: false, error: clean(cohort?.error) || 'cohort_unavailable', message: clean(cohort?.message) || null }
    entry = cohortCache.get(key)
  }
  const members = entry?.members
  if (!Array.isArray(members)) return { ok: false, error: 'cohort_members_unavailable', message: 'The cohort did not return its ready set' }
  const cohortMs = Date.now() - startedAt
  const { eligible, not_routable: notRoutable, no_greeting: noGreeting, language_held: languageHeld, excluded_by_market: excludedByMarket } = eligibleMembers(members, cohort.sender_markets)
  let coords
  try {
    coords = await readPropertyCoordinates(eligible.map((m) => m.property_id), deps)
  } catch (error) {
    return { ok: false, error: 'coordinates_unavailable', message: error?.message || String(error) }
  }
  const marketIndex = new Map()
  const markets = []
  const ids = []
  const lng = []
  const lat = []
  const mi = []
  const marketRow = (label) => {
    let idx = marketIndex.get(label)
    if (idx === undefined) {
      idx = markets.length
      marketIndex.set(label, idx)
      const ex = excludedByMarket.get(label) || { not_routable: 0, no_greeting: 0, language_held: 0 }
      markets.push({ market: label, eligible: 0, mapped: 0, unmapped: 0, not_routable: ex.not_routable, no_greeting: ex.no_greeting, language_held: ex.language_held, bbox: null })
    }
    return idx
  }
  // a market whose every ready seller is excluded still appears (0 eligible, with why)
  for (const label of excludedByMarket.keys()) marketRow(label)
  for (const m of eligible) {
    const idx = marketRow(clean(m.market) || 'Unknown market')
    const row = markets[idx]
    row.eligible += 1
    const c = m.property_id ? coords.get(clean(m.property_id)) : null
    if (!c || !usableLngLat(c.lat, c.lng)) { row.unmapped += 1; continue }
    row.mapped += 1
    const x = round6(c.lng)
    const y = round6(c.lat)
    row.bbox = row.bbox ? [Math.min(row.bbox[0], x), Math.min(row.bbox[1], y), Math.max(row.bbox[2], x), Math.max(row.bbox[3], y)] : [x, y, x, y]
    ids.push(clean(m.property_id))
    lng.push(x)
    lat.push(y)
    mi.push(idx)
  }
  markets.sort((a, b) => b.eligible - a.eligible || a.market.localeCompare(b.market))
  const order = new Map(markets.map((m, i) => [m.market, i]))
  const remap = [...marketIndex.entries()].reduce((acc, [label, idx]) => { acc[idx] = order.get(label); return acc }, [])
  const serverEligible = typeof cohort.sendable_after_personalization === 'number' ? cohort.sendable_after_personalization : null
  const mapped = ids.length
  const value = {
    ok: true,
    at: new Date().toISOString(),
    cohort_at: cohort.at,
    eligible: eligible.length,
    mapped,
    unmapped: eligible.length - mapped,
    // the Composer's number, and whether the per-target rule reproduces it exactly
    reconciliation: {
      composer_eligible: serverEligible,
      matches: serverEligible === null ? null : serverEligible === eligible.length,
      delta: serverEligible === null ? null : eligible.length - serverEligible,
    },
    // why ready sellers are not in the preview — server-counted, never inferred client-side
    excluded: { held_by_build: num(cohort.held), not_routable: notRoutable, no_greeting: noGreeting, language_held: languageHeld },
    ready: num(cohort.ready),
    capped_by_build_limit: cohort.capped_by_build_limit === true,
    build_limit: num(cohort.build_limit),
    markets,
    points: { ids, lng, lat, market: mi.map((i) => remap[i]) },
    timings_ms: { cohort: cohortMs, coordinates: Date.now() - startedAt - cohortMs, total: Date.now() - startedAt },
  }
  geoCache.delete(key)
  geoCache.set(key, { at: Date.now(), value })
  while (geoCache.size > MEMBER_CACHE_ENTRIES) geoCache.delete(geoCache.keys().next().value)
  return value
}

export function _resetComposerPreviewCaches() { cohortCache.clear(); cohortFlights.clear(); geoCache.clear(); geoFlights.clear() }

/**
 * Sender coverage for an audience from the CANONICAL routing engine — the one
 * that dispatches under the current gate state (sender-routing-service.js
 * readAudienceSenderCoverage: the legacy router while Routing 2.0 is gated off,
 * plus a labelled 2.0 preview; Routing 2.0 when it is on). Never the fleet
 * model. markets: [{ market, state?, market_id?, targets }].
 */
export async function readComposerCoverage(markets = [], deps = {}) {
  const list = (Array.isArray(markets) ? markets : [])
    .map((m) => ({ market: clean(m?.market) || null, market_id: clean(m?.market_id) || null, state: clean(m?.state) || STATE_OF_MARKET(m?.market) || null, targets: Math.max(0, Math.trunc(Number(m?.targets) || 0)) }))
    .filter((m) => m.market || m.market_id)
    .slice(0, 60)
  if (!list.length) return { ok: true, engine: null, markets: [], totals: { distinct_healthy_numbers: 0, distinct_daily_capacity: 0, targets: 0 }, v2_preview: null }
  const read = deps.readAudienceSenderCoverage
    || (await import('@/lib/domain/routing/sender-routing/sender-routing-service.js')).readAudienceSenderCoverage
  const result = await read({ markets: list }, deps)
  if (!result || result.ok === false) return { ok: false, error: clean(result?.error) || 'coverage_unavailable' }
  return { ok: true, at: new Date().toISOString(), ...result }
}

/* ── draft save ─────────────────────────────────────────────────────────── */

async function findDraftByComposerKey(supabase, key) {
  const { data, error } = await supabase.from('campaigns')
    .select('id,status,metadata')
    .eq('metadata->>composer_key', key)
    .limit(2)
  if (error) throw error
  return (data || [])[0] || null
}

async function loadCampaignStatus(supabase, id) {
  const { data, error } = await supabase.from('campaigns').select('id,status,name,metadata,total_cap,daily_cap').eq('id', id).maybeSingle()
  if (error) throw error
  return data || null
}

/**
 * Create-or-update the composition's draft. Idempotent per composer_key: a
 * second save (or a double-click) finds the first one's campaign.
 */
export async function saveComposerDraft(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const key = clean(input.composer_key)
  const campaignId = clean(input.campaign_id)
  if (!key && !campaignId) return { ok: false, status: 400, error: 'composer_key_required' }
  return singleFlight(`save:${campaignId || key}`, async () => {
    let existingId = campaignId
    if (!existingId && key) existingId = (await (deps.findDraftByComposerKey || findDraftByComposerKey)(supabase, key))?.id || ''
    if (existingId) {
      const row = await (deps.loadCampaignStatus || loadCampaignStatus)(supabase, existingId)
      if (!row) return { ok: false, status: 404, error: 'campaign_not_found' }
      if (!COMPOSER_EDITABLE_STATUSES.includes(lower(row.status))) {
        return { ok: false, status: 409, error: 'campaign_not_editable', message: `A ${lower(row.status)} campaign is commanded in Campaign Command, not edited here.` }
      }
      let payload
      try { payload = composerCampaignPayload(input.composition, { isUpdate: true }) } catch (error) {
        return { ok: false, status: 400, error: error.code || 'invalid_composition', field: error.field || null }
      }
      const result = await (deps.updateCampaign || updateCampaign)(existingId, payload, deps)
      if (!result?.ok) return { ok: false, status: result?.status || 500, error: result?.error || 'campaign_update_failed', message: result?.message || null }
      return { ok: true, campaign_id: existingId, created: false, changed_fields: result.changed_fields || [], unchanged: result.unchanged === true }
    }
    let payload
    try { payload = composerCampaignPayload({ ...obj(input.composition), composer_key: key }, { isUpdate: false }) } catch (error) {
      return { ok: false, status: 400, error: error.code || 'invalid_composition', field: error.field || null }
    }
    if (!payload.name) return { ok: false, status: 400, error: 'name_required' }
    const result = await (deps.createCampaign || createCampaign)(payload, deps)
    if (!result?.ok) return { ok: false, status: result?.status || 500, error: result?.error || 'campaign_create_failed', message: result?.message || null }
    return { ok: true, campaign_id: result.campaign_id, created: true }
  })
}

/* ── prepare + launch ───────────────────────────────────────────────────── */

const READINESS_OPTIONS = Object.freeze({ guarded_live_launch: true, explicit_operator_action: true })

function readinessDigest(readiness = {}) {
  const r = obj(readiness)
  return {
    state: clean(r.launch_readiness) || null,
    blockers: Array.isArray(r.blockers) ? r.blockers : [],
    blocker_codes: Array.isArray(r.blocker_codes) ? r.blocker_codes : [],
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
    launch_ready: num(r.launch_ready_recipient_count),
    ready: num(r.ready_recipient_count),
    routable: num(r.routable_recipient_count),
    counts: obj(r.counts),
    language_coverage: Array.isArray(r.language_coverage) ? r.language_coverage : [],
    sender_coverage: Array.isArray(r.sender_coverage) ? r.sender_coverage : [],
    template_readiness: clean(r.template_readiness) || null,
  }
}

/** Build the draft's targets and read launch readiness — the legacy preflight. Writes campaign_targets only. */
export async function prepareComposerLaunch(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const id = clean(input.campaign_id)
  if (!id) return { ok: false, status: 400, error: 'campaign_id_required' }
  const row = await (deps.loadCampaignStatus || loadCampaignStatus)(supabase, id)
  if (!row) return { ok: false, status: 404, error: 'campaign_not_found' }
  if (!COMPOSER_EDITABLE_STATUSES.includes(lower(row.status))) return { ok: false, status: 409, error: 'campaign_not_editable' }
  // No silent size: neither a default 1,000 cap nor a silent "all".
  const size = composerCampaignSize(obj(row.metadata).composer_campaign_size)
  if (!size) return { ok: false, status: 409, error: 'campaign_size_required', message: 'Choose a campaign size — All eligible, or a number — before launch.' }
  if (size === 'custom' && !(parseCampaignCap(row.total_cap) > 0)) return { ok: false, status: 409, error: 'campaign_size_required', message: 'The chosen campaign size has no number. Set it, or choose All eligible.' }
  const limit = size === 'all' ? undefined : parseCampaignCap(row.total_cap) ?? undefined
  const build = await (deps.buildCampaignTargets || buildCampaignTargets)(id, limit ? { limit, target_limit: limit, max_targets: limit } : {}, deps)
  if (!build || build.ok === false || build.success === false) {
    return { ok: false, status: 409, error: clean(build?.error) || 'build_failed', message: clean(build?.message) || null }
  }
  const readiness = await (deps.evaluateCampaignLaunchReadiness || evaluateCampaignLaunchReadiness)(id, deps, READINESS_OPTIONS)
  if (!readiness || readiness.ok === false) return { ok: false, status: 503, error: 'readiness_unavailable' }
  return { ok: true, campaign_id: id, build: obj(build.build_summary), readiness: readinessDigest(readiness) }
}

/** D4: a start is "now", or strictly in the future; a past start is never fired late. */
export function resolveLaunchStart(start = {}, nowMs = Date.now()) {
  const mode = lower(start.mode)
  if (mode === 'now') return { ok: true, mode: 'now', at: null }
  if (mode !== 'at') return { ok: false, error: 'start_required' }
  const at = Date.parse(clean(start.at))
  if (!Number.isFinite(at)) return { ok: false, error: 'start_invalid' }
  if (at <= nowMs + 60_000) {
    return { ok: false, error: 'start_in_past', missed: at < nowMs - SCHEDULE_ACTIVATION_TOLERANCE_MS ? 'missed' : 'too_soon', message: 'That start has passed. Start now, or reschedule.' }
  }
  return { ok: true, mode: 'at', at: new Date(at).toISOString() }
}

/**
 * Launch a prepared draft. ONE launch per campaign is decided by the database
 * (campaign-launch-claim.js): concurrent requests from any process get exactly
 * one claim; the others answer already_launched / launch_in_progress /
 * campaign_not_launchable. A retry with the winner's launch key gets the
 * recorded result. Nothing is built, scheduled or activated without the claim.
 */
export async function launchComposedCampaign(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const id = clean(input.campaign_id)
  const launchKey = clean(input.launch_key)
  if (!id) return { ok: false, status: 400, error: 'campaign_id_required' }
  if (!launchKey) return { ok: false, status: 400, error: 'launch_key_required' }
  const start = resolveLaunchStart(obj(input.start), deps.nowMs ?? Date.now())
  if (!start.ok) return { ok: false, status: 409, ...start }
  const expected = num(input.expected_eligible)
  const claimFn = deps.claimCampaignLaunch || claimCampaignLaunch
  const finishFn = deps.finishCampaignLaunch || finishCampaignLaunch

  // in-process single-flight only saves a round trip; the claim is the guarantee
  return singleFlight(`launch:${id}:${launchKey}`, async () => {
    const claim = await claimFn(supabase, { campaignId: id, launchKey })
    if (!claim.claimed) {
      if (claim.reason === 'already_launched' && clean(claim.launch_key) === launchKey) {
        return { ok: true, idempotent: true, campaign_id: id, ...obj(claim.result) }
      }
      const status = claim.reason === 'launch_claim_unavailable' ? 503 : claim.reason === 'campaign_not_found' ? 404 : 409
      return { ok: false, status, error: claim.reason || 'not_claimed', campaign_state: claim.status ?? null, message: claim.error || null }
    }
    const release = (error, extra = {}) => finishFn(supabase, { campaignId: id, token: claim.token, mode: claim.mode, outcome: 'failed', error, result: extra })
      .catch((e) => console.warn('campaign_composer.release_failed', e?.message || e))

    try {
      const prepared = await prepareComposerLaunch({ campaign_id: id }, deps)
      if (!prepared.ok) { await release(prepared.error); return prepared }
      const r = prepared.readiness
      const refuse = async (body) => { await release(body.error); return body }
      if (r.state === 'blocked' || r.blockers.length) return refuse({ ok: false, status: 409, error: 'launch_blocked', readiness: r })
      if (!(r.launch_ready > 0)) return refuse({ ok: false, status: 409, error: 'zero_eligible', readiness: r })
      if (expected !== null && expected !== r.launch_ready) {
        return refuse({ ok: false, status: 409, error: 'eligible_changed', message: `Eligible changed from ${expected} to ${r.launch_ready}. Review again.`, readiness: r })
      }

      const lifecycle = deps.applyCampaignLifecycleAction || applyCampaignLifecycleAction
      const result = start.mode === 'now'
        ? await lifecycle(id, {
          action: 'activate',
          activation_idempotency_key: `composer:${launchKey}`,
          confirm_live: true,
          explicit_operator_action: true,
          batch_max: Math.min(r.launch_ready, 100),
          reason: 'operator:composer_launch',
        }, deps)
        : await lifecycle(id, { action: 'schedule', scheduled_for: start.at, reason: 'operator:composer_launch' }, deps)
      if (!result?.ok) {
        return refuse({ ok: false, status: 409, error: clean(result?.error) || 'lifecycle_refused', message: clean(result?.message) || null, blockers: result?.blockers || [], readiness: r })
      }

      const summary = {
        mode: start.mode,
        scheduled_for: start.at,
        state: clean(result.to) || null,
        eligible: r.launch_ready,
        inserted: num(result.inserted),
      }
      const finished = await finishFn(supabase, { campaignId: id, token: claim.token, mode: claim.mode, outcome: 'completed', result: summary })
      if (finished?.fenced) console.warn('campaign_composer.finish_fenced', id)
      await (deps.recordCampaignEvent || recordCampaignEvent)({
        campaign_id: id,
        event_type: 'campaign.composer_launched',
        severity: 'success',
        title: start.mode === 'now' ? 'Launched from Composer' : 'Scheduled from Composer',
        description: `${r.launch_ready.toLocaleString('en-US')} eligible ${start.mode === 'now' ? 'starting now' : `from ${start.at}`} through recipient-local contact windows`,
        metadata: {
          launch_key: launchKey,
          claim_mode: claim.mode,
          operator: clean(input.operator) || null,
          source: obj(input.audit).source || null,
          audit: obj(input.audit),
          readiness: { state: r.state, launch_ready: r.launch_ready, warnings: r.warnings.slice(0, 6) },
          result: summary,
        },
      }, deps).catch((error) => console.warn('campaign_composer.audit_failed', error?.message || error))
      return { ok: true, campaign_id: id, idempotent: Boolean(result.idempotent), ...summary, readiness: r }
    } catch (error) {
      await release(error?.message || 'launch_exception')
      throw error
    }
  })
}
