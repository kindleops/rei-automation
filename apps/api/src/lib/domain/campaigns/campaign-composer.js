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
 * a launch_key (one per confirmation). Saves and launches are single-flight
 * per key inside the process, and a key already recorded (the draft's
 * metadata.composer_key, the launch audit event) answers with the earlier
 * result instead of acting again: a double-click is one campaign, one launch.
 *
 * FAIL CLOSED. A read that fails is named; a launch whose readiness cannot be
 * read, whose start has passed (D4: Start now / Reschedule) or whose eligible
 * count is zero does nothing.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue } from '@/lib/system-control.js'
import {
  applyCampaignLifecycleAction,
  applyOwnerPersona,
  buildCampaignTargets,
  createCampaign,
  launchCandidateFromTarget,
  loadOwnerPersonas,
  previewCampaignTargets,
  recordCampaignEvent,
  updateCampaign,
} from '@/lib/domain/campaigns/campaign-automation-service.js'
import { evaluateCampaignLaunchReadiness } from '@/lib/domain/campaigns/campaign-launch-readiness.js'
import { governanceApplies, governanceExcludedTemplateIds, evaluateTemplateGovernance, indexGovernance, loadGovernance } from '@/lib/domain/campaigns/template-governance.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { isValidCampaignCapInput, parseCampaignCap } from '@/lib/domain/campaigns/campaign-caps.js'
import { SCHEDULE_ACTIVATION_TOLERANCE_MS } from '@/lib/domain/campaigns/campaign-schedule-missed.js'
import { loadTextgridNumberFleet, renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { loadDispatchBlockedSets } from '@/lib/domain/delivery/sms-health-guard.js'
import { senderStateOf } from '@/lib/domain/campaigns/campaign-command-intel.js'

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
  for (const field of CAP_FIELDS) {
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

/** Render a few ready targets with the planner's renderer — the launch-readiness sample path. */
export async function renderComposerSamples(rows = [], { templateUseCase, stageCode, supabase } = {}, deps = {}) {
  const ready = rows.filter((row) => clean(row.target_status) === 'ready').slice(0, 3)
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
  const preview = await (deps.previewCampaignTargets || previewCampaignTargets)({
    filters: obj(s.filters),
    template_use_case: strategy.use_case,
    stage_code: stageCode,
    limitPreview: 25,
    ...(totalCap ? { build_limit: totalCap } : {}),
    ...(parseCampaignCap(s.daily_cap) !== null ? { daily_cap: parseCampaignCap(s.daily_cap) } : {}),
  }, deps)
  if (!preview || preview.ok === false) {
    return { ok: false, error: clean(preview?.error) || 'audience_unavailable', message: clean(preview?.message) || null }
  }
  const audience = composerAudienceFromPreview(preview)
  const samples = s.render === false
    ? []
    : await renderComposerSamples(Array.isArray(preview.target_rows) ? preview.target_rows : [], { templateUseCase: strategy.use_case, stageCode, supabase }, deps).catch(() => [])
  return { ok: true, at: new Date().toISOString(), strategy: { use_case: strategy.use_case, stage_code: stageCode }, ...audience, samples }
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
  const limit = parseCampaignCap(row.total_cap) ?? undefined
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

async function findLaunchEvent(supabase, campaignId, launchKey) {
  const { data, error } = await supabase.from('campaign_events')
    .select('id,created_at,metadata')
    .eq('campaign_id', campaignId)
    .eq('event_type', 'campaign.composer_launched')
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw error
  return (data || []).find((e) => clean(obj(e.metadata).launch_key) === launchKey) || null
}

/**
 * Launch a prepared draft. Single-flight per launch_key; a key already
 * launched answers with its recorded result. Fails closed at every step.
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

  return singleFlight(`launch:${launchKey}`, async () => {
    const prior = await (deps.findLaunchEvent || findLaunchEvent)(supabase, id, launchKey)
    if (prior) return { ok: true, idempotent: true, campaign_id: id, ...obj(obj(prior.metadata).result) }

    const prepared = await prepareComposerLaunch({ campaign_id: id }, deps)
    if (!prepared.ok) return prepared
    const r = prepared.readiness
    if (r.state === 'blocked' || r.blockers.length) return { ok: false, status: 409, error: 'launch_blocked', readiness: r }
    if (!(r.launch_ready > 0)) return { ok: false, status: 409, error: 'zero_eligible', readiness: r }
    if (expected !== null && expected !== r.launch_ready) {
      return { ok: false, status: 409, error: 'eligible_changed', message: `Eligible changed from ${expected} to ${r.launch_ready}. Review again.`, readiness: r }
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
      return { ok: false, status: 409, error: clean(result?.error) || 'lifecycle_refused', message: clean(result?.message) || null, blockers: result?.blockers || [], readiness: r }
    }

    const summary = {
      mode: start.mode,
      scheduled_for: start.at,
      state: clean(result.to) || null,
      eligible: r.launch_ready,
      inserted: num(result.inserted),
    }
    // The audit is best-effort AFTER the canonical transition succeeded: the
    // lifecycle already recorded its own event; this one carries the composition.
    await (deps.recordCampaignEvent || recordCampaignEvent)({
      campaign_id: id,
      event_type: 'campaign.composer_launched',
      severity: 'success',
      title: start.mode === 'now' ? 'Launched from Composer' : 'Scheduled from Composer',
      description: `${r.launch_ready.toLocaleString('en-US')} eligible ${start.mode === 'now' ? 'starting now' : `from ${start.at}`} through recipient-local contact windows`,
      metadata: {
        launch_key: launchKey,
        operator: clean(input.operator) || null,
        source: obj(input.audit).source || null,
        audit: obj(input.audit),
        readiness: { state: r.state, launch_ready: r.launch_ready, warnings: r.warnings.slice(0, 6) },
        result: summary,
      },
    }, deps).catch((error) => console.warn('campaign_composer.audit_failed', error?.message || error))
    return { ok: true, campaign_id: id, idempotent: Boolean(result.idempotent), ...summary, readiness: r }
  })
}
