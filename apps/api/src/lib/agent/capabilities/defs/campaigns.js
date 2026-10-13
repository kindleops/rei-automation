// Campaign capabilities. Every one goes through the Campaign Composer /
// campaign service the UI uses; nothing here re-implements a targeting,
// readiness, cohort or launch rule.
import { hashCanonical } from '../../runtime/canonical.js'
import { refusal } from '../registry.js'
import { UUID, str, int, num, bool, enumOf, list, obj, clean, lower, n, isoOrNull } from './_schema.js'

export const STRATEGIES = Object.freeze(['ownership_check', 'consider_selling', 'seller_asking_price'])
export const FILTER_DOMAINS = Object.freeze(['properties', 'prospects', 'master_owners', 'phones', 'outreach', 'sender_coverage'])
export const FILTER_OPERATORS = Object.freeze(['is_any_of', 'is_not_any_of', 'contains', 'is_empty', 'is_not_empty', 'gte', 'lte', 'between', 'eq', 'on_or_after', 'on_or_before', 'is_true', 'is_false'])
const EDITABLE = new Set(['draft', 'built'])

const FILTER_ITEM = obj({
  field_key: str(80, { pattern: '^[a-z][a-z0-9_]*$' }),
  operator: enumOf(FILTER_OPERATORS),
  values: list(str(120), 200),
  number: num(-1e12, 1e12),
  range: list(num(-1e12, 1e12), 2),
  date: str(40, { pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}' }),
}, ['field_key', 'operator'])
export const FILTERS_SCHEMA = obj(Object.fromEntries(FILTER_DOMAINS.map((d) => [d, list(FILTER_ITEM, 30)])))

/** Capability filter shape → the composer's grouped target_filters (catalog keys, unchanged semantics). */
export function toTargetFilters(filters = {}) {
  const out = {}
  for (const d of FILTER_DOMAINS) {
    const items = Array.isArray(filters[d]) ? filters[d] : []
    if (!items.length) continue
    out[d] = items.map((f) => ({ field_key: f.field_key, operator: f.operator, value: f.values ?? f.range ?? (f.number !== undefined ? f.number : undefined) ?? f.date ?? null }))
  }
  return out
}

const pickFeeder = (f) => (f && typeof f === 'object'
  ? { at: isoOrNull(f.at), inserted: n(f.inserted), ready_remaining: n(f.ready_remaining), reason: clean(f.reason) || null, stalled: f.stalled === true, progress_state: clean(f.progress_state) || null, blocked_by: f.blocked_by ?? null, skipped_counts_by_reason: f.skipped_counts_by_reason || {}, skip_summary: clean(f.skip_summary).slice(0, 400) || null, routing_blocks_by_market: f.routing_blocks_by_market || {}, last_refill_at: isoOrNull(f.last_refill_at) }
  : null)

const filterDigest = (rows = []) => rows.slice(0, 40).map((r) => ({ domain: r.filter_type || null, field: r.field, operator: r.operator, value: Array.isArray(r.value) ? r.value.slice(0, 10) : r.value }))

function readinessDigest(lr) {
  const r = lr && typeof lr === 'object' ? lr : {}
  return {
    state: clean(r.launch_readiness) || null,
    blocker_codes: Array.isArray(r.blocker_codes) ? r.blocker_codes.slice(0, 20) : [],
    blockers: Array.isArray(r.blockers) ? r.blockers.slice(0, 10).map((b) => (typeof b === 'string' ? b.slice(0, 200) : clean(b?.message || b?.code).slice(0, 200))) : [],
    warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 10).map((w) => (typeof w === 'string' ? w.slice(0, 200) : clean(w?.message || w?.code).slice(0, 200))) : [],
    launch_ready: n(r.launch_ready_recipient_count),
    ready: n(r.ready_recipient_count),
    routable: n(r.routable_recipient_count),
    template_readiness: clean(r.template_readiness) || null,
  }
}

function campaignDigest(res) {
  const c = res?.campaign || {}
  const md = c.metadata && typeof c.metadata === 'object' ? c.metadata : {}
  const s = res?.summary || {}
  return {
    campaign: { campaign_id: c.id, name: clean(c.name).slice(0, 120), status: lower(c.status), objective: c.objective || null, market: c.market || null, state: c.state || null, created_at: isoOrNull(c.created_at), activated_at: isoOrNull(c.activated_at), daily_cap: n(c.daily_cap), total_cap: n(c.total_cap), stage_code: md.stage_code || null, template_use_case: md.template_use_case || null, campaign_size: md.composer_campaign_size || null, lineage: s.lineage || null },
    composition: { filters: filterDigest(res?.filters || []), filter_count: (res?.filters || []).length },
    sending_health: { launch_readiness: readinessDigest(res?.launch_readiness), operator_state: s.operator_state || null, mode: s.mode || null, target_integrity: s.target_integrity ? { applies: s.target_integrity.applies ?? null, contained: s.target_integrity.contained ?? null } : null },
    counts: { total_targets: n(s.total_targets), ready_targets: n(s.ready_targets), planned_targets: n(s.planned_targets), scheduled_queue_rows: n(s.scheduled_queue_rows), sent: n(s.sent_count), delivered: n(s.delivered_count), failed: n(s.failed_count), replies: n(s.reply_count), opt_outs: n(s.opt_out_count) },
    feeder_last: pickFeeder(md.feeder_last),
  }
}

/** The state a launch approval is bound to (drift ⇒ refuse). */
function launchSnapshot(res) {
  const c = res?.campaign || {}
  const md = c.metadata && typeof c.metadata === 'object' ? c.metadata : {}
  return { campaign_id: c.id || null, status: lower(c.status), total_cap: n(c.total_cap), daily_cap: n(c.daily_cap), campaign_size: md.composer_campaign_size || null, stage_code: md.stage_code || null, template_use_case: md.template_use_case || null, filters_hash: hashCanonical(md.target_filters || {}) }
}

async function loadCampaign(services, id) {
  try {
    const res = await services.campaigns.get(id)
    return res?.ok === false ? null : res
  } catch (e) {
    if (/0 rows|not found/i.test(String(e?.message || ''))) return null
    throw e
  }
}

const READ_LIMITS = { per_min: 30, per_day: 2000, timeout_ms: 30_000, rows_to_model: 25 }

export const campaignCapabilities = [
  {
    id: 'campaigns.search',
    version: 1,
    domain: 'campaigns',
    title: 'Search campaigns',
    description: 'List campaigns (newest first) with status, market and send counts. Filter by a name substring and/or statuses.',
    input_schema: obj({ query: str(80), statuses: list(enumOf(['draft', 'built', 'scheduled', 'active', 'paused', 'completed', 'archived']), 7), limit: int(1, 25) }),
    output_schema: { type: 'object', properties: { rows: { type: 'array' }, total: { type: 'integer' } } },
    side_effect: 'read',
    tier: 'autonomous_internal',
    cost_class: 'db_heavy',
    limits: READ_LIMITS,
    wraps: { service: 'campaign-automation-service#listCampaigns' },
    async execute(input, ctx) {
      const res = await ctx.services.campaigns.list()
      const q = lower(input.query)
      const st = input.statuses?.length ? new Set(input.statuses) : null
      const all = (res?.campaigns || []).filter((c) => (!q || lower(c.name || c.campaign_name).includes(q)) && (!st || st.has(lower(c.status))))
      const rows = all.slice(0, input.limit || 25).map((c) => ({ campaign_id: c.id, name: clean(c.name || c.campaign_name).slice(0, 120), status: lower(c.status), operator_state: c.operator_state || null, market: c.market || null, created_at: isoOrNull(c.created_at), total_targets: n(c.total_targets), ready_targets: n(c.ready_targets), sent: n(c.sent_count), replies: n(c.reply_count) }))
      return { rows, total: all.length, list_truncated: Boolean(res?.truncated) }
    },
    audit: (input, r) => ({ rows: r?.rows?.length ?? 0, query: Boolean(input.query) }),
  },
  {
    id: 'campaigns.inspect',
    version: 1,
    domain: 'campaigns',
    title: 'Inspect a campaign',
    description: 'One campaign: composition (filters), sending health from launch readiness, counts, and the feeder\'s last diagnostics (feeder_last).',
    input_schema: obj({ campaign_id: UUID }, ['campaign_id']),
    output_schema: { type: 'object' },
    side_effect: 'read',
    tier: 'autonomous_internal',
    cost_class: 'db_heavy',
    limits: READ_LIMITS,
    wraps: { service: 'campaign-automation-service#getCampaign (+ evaluateCampaignLaunchReadiness)' },
    async execute(input, ctx) {
      const res = await loadCampaign(ctx.services, input.campaign_id)
      if (!res) throw refusal('CAMPAIGN_NOT_FOUND')
      return campaignDigest(res)
    },
    audit: (input) => ({ campaign_id: input.campaign_id }),
  },
  {
    id: 'campaigns.create_draft',
    version: 1,
    domain: 'campaigns',
    title: 'Create a draft campaign',
    description: 'Create a DRAFT campaign through the Campaign Composer with a strategy and catalog filters. Never active; builds no targets unless build_targets is true (and then still a draft). Re-sending the same request returns the same draft.',
    input_schema: obj({
      name: str(80, { minLength: 3 }),
      template_use_case: enumOf(STRATEGIES),
      filters: FILTERS_SCHEMA,
      campaign_size: enumOf(['all', 'custom']),
      total_cap: int(1, 100_000),
      daily_cap: int(0, 100_000),
      build_targets: bool(),
    }, ['name', 'template_use_case', 'filters']),
    output_schema: { type: 'object', properties: { campaign_id: { type: 'string' }, status: { type: 'string' } } },
    side_effect: 'internal_write',
    tier: 'autonomous_internal',
    cost_class: 'db_light',
    limits: { per_min: 3, per_day: 25, timeout_ms: 60_000, rows_to_model: 25 },
    touches: ['campaign_draft'],
    wraps: { service: 'campaign-composer#saveComposerDraft → campaign-automation-service#createCampaign' },
    compensation: { kind: 'archive_draft', note: 'A draft never sends; archive it from Campaign Command (status → archived) to remove it.' },
    idempotency: (input) => hashCanonical({ name: input.name, uc: input.template_use_case, f: input.filters, size: input.campaign_size || null, tc: input.total_cap ?? null, dc: input.daily_cap ?? null }),
    async execute(input, ctx) {
      const filters = toTargetFilters(input.filters)
      if (!Object.keys(filters).length) throw refusal('AUDIENCE_REQUIRED', 'at least one filter is required (no filter = the whole graph)')
      const composer_key = `agent:${hashCanonical({ o: ctx.org_id, a: ctx.actor, i: this.idempotency(input) }).slice(0, 32)}`
      const composition = { name: input.name, template_use_case: input.template_use_case, target_filters: filters, source: { kind: 'agent_capability', capability: 'campaigns.create_draft' } }
      if (input.campaign_size) composition.campaign_size = input.campaign_size
      if (input.total_cap !== undefined) composition.total_cap = input.total_cap
      if (input.daily_cap !== undefined) composition.daily_cap = input.daily_cap
      const saved = await ctx.services.campaigns.saveDraft({ composer_key, composition })
      if (!saved?.ok) throw refusal(clean(saved?.error).toUpperCase() || 'DRAFT_SAVE_REFUSED', clean(saved?.message) || null)
      let build = null
      if (input.build_targets === true) {
        if (typeof ctx.services.campaigns.prepare !== 'function') throw refusal('BUILD_UNAVAILABLE')
        const p = await ctx.services.campaigns.prepare({ campaign_id: saved.campaign_id })
        build = p?.ok ? { built: true, launch_ready: n(p.readiness?.launch_ready), state: p.readiness?.state || null } : { built: false, error: clean(p?.error) || 'build_failed' }
      }
      // read back the resulting state: the row must exist and be a draft
      const back = await loadCampaign(ctx.services, saved.campaign_id)
      const status = lower(back?.campaign?.status)
      if (!back || !EDITABLE.has(status)) throw refusal('READBACK_FAILED', `campaign is ${status || 'missing'} after save`)
      return { campaign_id: saved.campaign_id, created: saved.created !== false, status, name: clean(back.campaign.name).slice(0, 120), readback: { exists: true, status, active: false }, build }
    },
    audit: (input, r) => ({ result: r ? { campaign_id: r.campaign_id, status: r.status, created: r.created } : null }),
  },
  {
    id: 'campaigns.build_proposed_cohort',
    version: 1,
    domain: 'campaigns',
    title: 'Preview a proposed cohort',
    description: 'Dry-run cohort for a composition (or an existing draft\'s filters) through the build\'s own planner: ready / held by reason / recipients / sendable now / by market. Aggregates only; writes nothing.',
    input_schema: obj({ campaign_id: UUID, template_use_case: enumOf(STRATEGIES), filters: FILTERS_SCHEMA }),
    output_schema: { type: 'object' },
    side_effect: 'read',
    tier: 'autonomous_internal',
    cost_class: 'db_heavy',
    limits: { per_min: 6, per_day: 300, timeout_ms: 60_000, rows_to_model: 25 },
    wraps: { service: 'campaign-composer#readComposerCohort → countCampaignAudienceCohort (planner, dry run)' },
    async execute(input, ctx) {
      let spec
      if (input.campaign_id) {
        const res = await loadCampaign(ctx.services, input.campaign_id)
        if (!res) throw refusal('CAMPAIGN_NOT_FOUND')
        const md = res.campaign?.metadata || {}
        spec = { filters: md.target_filters || {}, template_use_case: md.template_use_case || 'ownership_check' }
      } else {
        const filters = toTargetFilters(input.filters || {})
        if (!Object.keys(filters).length) throw refusal('AUDIENCE_REQUIRED')
        spec = { filters, template_use_case: input.template_use_case || 'ownership_check' }
      }
      const r = await ctx.services.campaigns.cohort(spec)
      if (!r?.ok) throw refusal(clean(r?.error).toUpperCase() || 'COHORT_UNAVAILABLE')
      return {
        dry_run: true,
        queue_eligible_in_audience: n(r.queue_eligible_in_audience), rows_read: n(r.rows_read), capped_by_build_limit: Boolean(r.capped_by_build_limit),
        recipients: n(r.recipients), duplicates_collapsed: n(r.duplicates_collapsed), ready: n(r.ready), held: n(r.held), held_by_reason: r.held_by_reason || {},
        sendable_now: n(r.sendable_now), no_sendable_number: n(r.no_sendable_number), no_sender_route_recipients: n(r.no_sender_route_recipients),
        ready_by_market: r.ready_by_market || {}, sender_markets: (r.sender_markets || []).slice(0, 25), language_holds: r.language_holds || null,
      }
    },
    audit: (input, r) => ({ ready: r?.ready ?? null, from_campaign: Boolean(input.campaign_id) }),
  },
  {
    id: 'campaigns.prepare_launch_approval',
    version: 1,
    domain: 'campaigns',
    title: 'Prepare a campaign launch for approval',
    description: 'Prepares a PENDING launch approval for a draft campaign. Nothing launches: a human approves it in the dashboard, which then runs the Composer launch (claim, build, readiness, lifecycle) with every existing gate.',
    input_schema: obj({ campaign_id: UUID, start: enumOf(['now', 'at']), start_at: str(40, { pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' }), expected_eligible: int(1, 1_000_000) }, ['campaign_id', 'start']),
    output_schema: { type: 'object' },
    side_effect: 'outbound_prepare',
    tier: 'requires_explicit_approval',
    approval_class: 'campaign_launch',
    cost_class: 'db_heavy',
    limits: { per_min: 2, per_day: 10, timeout_ms: 60_000, rows_to_model: 10 },
    touches: ['approval_request'],
    wraps: { service: 'campaign-composer#launchComposedCampaign (human approval only)' },
    compensation: { kind: 'pause_campaign', note: 'After launch the campaign is paused from Campaign Command (lifecycle pause); sent messages cannot be recalled.' },
    idempotency: (input) => hashCanonical({ c: input.campaign_id, s: input.start, at: input.start_at || null, e: input.expected_eligible ?? null }),
    async prepare(input, ctx) {
      if (input.start === 'at' && !input.start_at) return { ok: false, code: 'START_AT_REQUIRED' }
      const res = await loadCampaign(ctx.services, input.campaign_id)
      if (!res) return { ok: false, code: 'CAMPAIGN_NOT_FOUND' }
      const snap = launchSnapshot(res)
      if (!EDITABLE.has(snap.status)) return { ok: false, code: 'CAMPAIGN_NOT_LAUNCHABLE', detail: { status: snap.status } }
      if (!snap.campaign_size) return { ok: false, code: 'CAMPAIGN_SIZE_REQUIRED' }
      const lr = readinessDigest(res.launch_readiness)
      const name = clean(res.campaign?.name).slice(0, 80)
      return {
        ok: true,
        target: { campaign_id: input.campaign_id },
        intended_change: { action: 'launch', campaign_id: input.campaign_id, from_status: snap.status, start: { mode: input.start, at: input.start === 'at' ? input.start_at : null }, expected_eligible: input.expected_eligible ?? null },
        snapshot: snap,
        summary: [
          `Launch campaign "${name}" (${snap.status} → ${input.start === 'now' ? 'active, starting now' : 'scheduled for the start time in the intended change'})`,
          `Strategy ${snap.template_use_case || 'ownership_check'} (${snap.stage_code || 'S1'}) · size ${snap.campaign_size}${snap.total_cap ? ` (${snap.total_cap})` : ''}`,
          `Readiness now: ${lr.state || 'unknown'}${lr.blocker_codes.length ? ` · blockers: ${lr.blocker_codes.slice(0, 5).join(', ')}` : ''}`,
          'On approval the Composer launch re-builds targets and re-checks readiness, suppression, templates and sender coverage; any blocker refuses the launch.',
        ],
      }
    },
    async snapshot(target, ctx) {
      const res = await loadCampaign(ctx.services, target.campaign_id)
      return res ? launchSnapshot(res) : { campaign_id: target.campaign_id, missing: true }
    },
    async executeApproved(change, ctx) {
      const r = await ctx.services.campaigns.launch({ campaign_id: change.campaign_id, launch_key: `agent-approval:${ctx.approval_id}`, start: change.start, expected_eligible: change.expected_eligible ?? undefined, operator: ctx.approver, audit: { source: 'agent_approval', approval_id: ctx.approval_id } })
      const back = await loadCampaign(ctx.services, change.campaign_id)
      return { ok: r?.ok !== false, code: r?.ok === false ? clean(r?.error) || 'launch_refused' : null, state: clean(r?.state) || null, mode: r?.mode || change.start.mode, scheduled_for: r?.scheduled_for || null, eligible: n(r?.eligible), inserted: n(r?.inserted), idempotent: Boolean(r?.idempotent), readback: { status: lower(back?.campaign?.status) || null } }
    },
    audit: (input) => ({ campaign_id: input.campaign_id, start: input.start }),
  },
]
