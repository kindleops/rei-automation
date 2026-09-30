/**
 * ANALYTICS LAB — THE METRIC ENGINE.
 *
 * Pure: facts in, values out. One model per fact load; every metric the Lab
 * shows, every breakdown row, every chart point and every VIEW RECORDS page is
 * derived from the SAME entity sets here, so a KPI always equals the sum of
 * its additive breakdown and the count of its records.
 *
 *   buildModel(facts)                   normalise + index + classify (canary, test campaigns, synthetic history)
 *   periodFacts(model, window, filters) the entity sets of one window
 *   evaluate(metric, pf)                value + numerator + denominator + interval + status
 *   compare(metric, cur, prev)          delta / pts / significance
 *   breakdown / series / heatmap / histogram / contribution / records
 */
import {
  CAMPAIGN_SOURCE_LABELS, CLASS_LABELS, DISPATCH_DISPOSITIONS, DISPOSITION_LABELS, RUN_CLASS_LABELS, WEEKDAYS,
  attemptTime, campaignIntegrity, campaignSource, canaryPhones, classifySend, historyActor, inboundFlags,
  isAttributableInbound, isCanaryInbound, isCanarySend, isSyntheticHistory, localClock, normalizeOwnerType,
  normalizePropertyType, propertyTimezone, runClass, sendFlags, sendOrigin, touchBucket, transitionDirection,
} from './fact-classifiers.js'
import { DIMENSION_REGISTRY, FILTER_FIELDS, METRICS_BY_ID } from './metric-registry.js'
import { bucketList, nextBucket } from './query-contract.js'
import { compareCounts, compareProportions, decomposeRateChange, distribution, mannWhitney, wilson } from './stats.js'
import { UNIVERSAL_STAGE_LABELS } from '@/lib/domain/opportunity/universal-pipeline-registry.js'
import { STAGE_INDEX } from '@/lib/domain/opportunity/pipeline-command-service.js'

const DAY = 86_400_000
const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const ms = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
const bool = (v) => (v === true || v === false ? v : ['true', 't', '1', 'yes'].includes(clean(v).toLowerCase()) ? true : ['false', 'f', '0', 'no'].includes(clean(v).toLowerCase()) ? false : null)
const UNRESOLVED = '__unresolved'
const byAt = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const FIELD = Object.fromEntries(FILTER_FIELDS.map((f) => [f.id, f]))

/* ═══ MODEL ═══════════════════════════════════════════════════════════════ */

export function buildModel(facts, { canary = canaryPhones(), basis = facts?.window?.basis || 'attempt' } = {}) {
  const excluded = { canarySends: 0, testCampaignSends: 0, canaryInbound: 0, unattributableInbound: 0, syntheticHistory: 0, replayRuns: 0, voidedClosings: 0 }
  const markets = new Map((facts.markets || []).map((m) => [m.id, m]))
  const senders = new Map((facts.senders || []).map((s) => [String(s.id), s]))
  const campaigns = new Map((facts.campaigns || []).map((c) => [String(c.id), { ...c, integrity: campaignIntegrity(c), source: campaignSource(c) }]))
  const templates = facts.templates instanceof Map ? facts.templates : new Map()
  const properties = facts.properties instanceof Map ? facts.properties : new Map()
  const buckets = facts.buckets instanceof Map ? facts.buckets : new Map()

  const propCache = new Map()
  function prop(pid) {
    const id = clean(pid)
    if (!id) return null
    if (propCache.has(id)) return propCache.get(id)
    const r = properties.get(id)
    if (!r) { propCache.set(id, null); return null }
    const state = clean(r.property_address_state).toUpperCase() || null
    const zip = clean(r.property_address_zip).slice(0, 5) || null
    const p = {
      id,
      market: clean(r.canonical_market_id) || null,
      state, zip,
      county: clean(r.property_address_county_name || r.property_county_name) || null,
      city: clean(r.property_address_city) || null,
      address: clean(r.property_address_full) || null,
      lat: num(r.latitude), lng: num(r.longitude),
      propertyType: normalizePropertyType(r.property_type),
      ownerType: normalizeOwnerType(r.owner_type),
      equityPercent: num(r.equity_percent), estimatedValue: num(r.estimated_value), yearBuilt: num(r.year_built),
      buildingSqft: num(r.building_square_feet), bedrooms: num(r.total_bedrooms), units: num(r.units_count), ownershipYears: num(r.ownership_years),
      taxDelinquent: bool(r.tax_delinquent), activeLien: bool(r.active_lien), corporateOwner: bool(r.is_corporate_owner), outOfStateOwner: bool(r.out_of_state_owner),
      tz: propertyTimezone(state, zip),
    }
    propCache.set(id, p)
    return p
  }

  /* sends */
  const sends = []
  for (const r of facts.sends || []) {
    if (isCanarySend(r, canary)) { excluded.canarySends += 1; continue }
    const f = sendFlags(r)
    const bucket = buckets.get(r.id) ?? null
    const { disposition, cls } = classifySend(r, bucket)
    const at = basis === 'created' ? ms(r.created_at) : attemptTime(r)
    if (at === null) continue
    const sched = ms(r.scheduled_for_utc || r.scheduled_for)
    const sentAt = ms(r.sent_at)
    const campaign = campaigns.get(clean(r.campaign_id)) || null
    sends.push({
      id: String(r.id), thread: clean(r.thread_key) || null, at, createdAt: ms(r.created_at), sentAt, deliveredAt: ms(r.delivered_at),
      status: f.status, v1: { isSent: f.isSent, isDelivered: f.isDelivered, isFailed: f.isFailedV1 },
      disposition, cls, bucket,
      campaignId: clean(r.campaign_id) || null, test: Boolean(campaign?.integrity?.test),
      propertyId: clean(r.property_id) || null, templateId: clean(r.template_id) || null, senderId: clean(r.textgrid_number_id) || null,
      touch: num(r.touch_number), origin: sendOrigin(r), language: clean(r.language) || null,
      delayMin: sentAt !== null && sched !== null && sentAt >= sched ? (sentAt - sched) / 60_000 : null,
      sellerName: clean(r.seller_display_name) || null,
      reason: clean(r.failed_reason || r.blocked_reason || r.guard_reason || r.paused_reason) || null,
    })
  }
  sends.sort(byAt)
  const sendsByThread = new Map()
  for (const s of sends) {
    if (!s.thread) continue
    if (!sendsByThread.has(s.thread)) sendsByThread.set(s.thread, [])
    sendsByThread.get(s.thread).push(s)
  }

  /* replies */
  const replies = []
  for (const r of facts.inbound || []) {
    if (isCanaryInbound(r, canary)) { excluded.canaryInbound += 1; continue }
    if (!isAttributableInbound(r)) { excluded.unattributableInbound += 1; continue }
    const at = ms(r.created_at)
    if (at === null) continue
    const fl = inboundFlags(r)
    replies.push({ id: String(r.id), thread: clean(r.thread_key), at, intent: fl.intent, isPositive: fl.isPositive, isOptOut: fl.isOptOut, ownPropertyId: clean(r.property_id) || null })
  }
  replies.sort(byAt)
  const repliesByThread = new Map()
  for (const r of replies) {
    if (!repliesByThread.has(r.thread)) repliesByThread.set(r.thread, [])
    repliesByThread.get(r.thread).push(r)
  }
  /** Latest send on the thread at/before t within 30 days (any disposition that left the queue). */
  function promptingSend(thread, t) {
    const list = sendsByThread.get(thread)
    if (!list) return null
    let best = null
    for (const s of list) {
      if (s.at > t) break
      if (['delivered', 'sent', 'undelivered'].includes(s.disposition) && t - s.at <= 30 * DAY) best = s
    }
    return best
  }
  for (const r of replies) {
    r.prompt = promptingSend(r.thread, r.at)
    r.propertyId = r.ownPropertyId || r.prompt?.propertyId || null
  }

  /* history */
  const opps = new Map()
  for (const o of facts.opportunities || []) {
    opps.set(String(o.id), {
      id: String(o.id), stage: clean(o.acquisition_stage) || null, status: clean(o.opportunity_status) || null,
      stageEnteredAt: ms(o.stage_entered_at), lastActivityAt: ms(o.last_activity_at), createdAt: ms(o.created_at),
      propertyId: clean(o.primary_property_id) || null, thread: clean(o.primary_thread_key) || null,
      campaignIds: Array.isArray(o.campaign_ids) ? o.campaign_ids.map(String) : [],
    })
  }
  const hist = []
  for (const h of facts.history || []) {
    if (isSyntheticHistory(h)) { excluded.syntheticHistory += 1; continue }
    const at = ms(h.created_at)
    if (at === null) continue
    hist.push({ id: String(h.id), oppId: String(h.opportunity_id), type: clean(h.event_type), from: clean(h.previous_value) || null, to: clean(h.new_value) || null, at, source: clean(h.source), actor: historyActor(h), reason: clean(h.reason) || null })
  }
  hist.sort((a, b) => (a.oppId < b.oppId ? -1 : a.oppId > b.oppId ? 1 : a.at - b.at))
  let prevOpp = null
  let prevAt = null
  for (const h of hist) {
    h.prevAt = h.oppId === prevOpp ? prevAt : null
    prevOpp = h.oppId
    prevAt = h.at
    h.direction = h.type === 'opportunity_created' ? 'created' : transitionDirection(h.from, h.to)
    h.opp = opps.get(h.oppId) || null
    h.propertyId = h.opp?.propertyId || null
  }
  hist.sort(byAt)
  const oppCreatedByThread = new Map()
  for (const h of hist) {
    if (h.type !== 'opportunity_created' || !h.opp?.thread) continue
    if (!oppCreatedByThread.has(h.opp.thread)) oppCreatedByThread.set(h.opp.thread, [])
    oppCreatedByThread.get(h.opp.thread).push(h)
  }

  /* runs */
  const runs = []
  for (const r of facts.runs || []) {
    if (r.replay_only === true) { excluded.replayRuns += 1; continue }
    const at = ms(r.created_at)
    if (at === null) continue
    const reason = clean(r.md_block_reason) || null
    runs.push({ id: String(r.id), at, status: clean(r.status), reason, cls: runClass(r.status, reason), propertyId: clean(r.property_id) || null, thread: clean(r.thread_id) || null, workflow: clean(r.workflow_id) || null })
  }
  runs.sort(byAt)

  /* offers / closings */
  const offers = (facts.offers || []).map((o) => ({
    id: String(o.id || o.offer_id), at: ms(o.created_at), direction: clean(o.direction) || null, status: clean(o.status) || null,
    ours: clean(o.direction).toLowerCase() !== 'inbound', price: num(o.purchase_price), propertyId: clean(o.property_id) || null, thread: clean(o.thread_key) || null, oppId: clean(o.opportunity_id) || null,
  })).filter((o) => o.at !== null).sort(byAt)
  const closings = []
  for (const c of facts.closings || []) {
    const voided = /void|cancel/i.test(`${clean(c.closing_status)} ${clean(c.terminal_outcome)}`)
    if (voided) { excluded.voidedClosings += 1; continue }
    closings.push({ id: String(c.id), status: clean(c.closing_status), contractAt: ms(c.contract_signed_date), closedAt: ms(c.recording_date || c.funding_date), propertyId: clean(c.property_id) || null, thread: clean(c.thread_key) || null, oppId: clean(c.opportunity_id) || null, at: ms(c.created_at) })
  }

  /* recorded buyer purchases (comp_private corpus): only when the caller supplies them */
  const purchases = Array.isArray(facts.purchases)
    ? facts.purchases.map((x, i) => ({ id: String(x.id ?? i), at: ms(x.event_date || x.at), zip: clean(x.zip) || null, market: clean(x.market) || null, buyerKind: clean(x.buyer_kind) || null, buyerId: clean(x.buyer_id) || null })).filter((x) => x.at !== null)
    : null

  const testCampaignSends = sends.filter((s) => s.test).length
  excluded.testCampaignSends = testCampaignSends

  return {
    basis, sends, sendsByThread, replies, repliesByThread, hist, opps, oppCreatedByThread, runs, offers, closings, purchases,
    purchasesThrough: facts.purchasesThrough || null,
    markets, senders, campaigns, templates, prop, excluded,
    everCounts: { offersIssued: offers.filter((o) => o.ours).length, contracts: closings.filter((c) => c.contractAt).length, closings: closings.filter((c) => c.closedAt).length },
  }
}

/* ═══ DIMENSIONS ══════════════════════════════════════════════════════════ */

const STAGE_SHORT = Object.fromEntries(Object.entries(STAGE_INDEX).map(([code, i]) => [code, `S${i}`]))
const label = (key, text) => ({ key: key ?? UNRESOLVED, label: key === null || key === undefined ? 'Unresolved' : text ?? String(key) })

function outreachOf(kind, e) {
  if (kind === 'message') return e
  if (kind === 'seller') return e.anchor
  if (kind === 'reply') return e.prompt
  return null
}
function propertyOf(model, kind, e) {
  if (kind === 'message') return model.prop(e.propertyId)
  if (kind === 'seller') return model.prop(e.anchor.propertyId)
  if (kind === 'reply') return model.prop(e.propertyId)
  if (kind === 'transition') return model.prop(e.propertyId)
  if (kind === 'opportunity') return model.prop(e.propertyId)
  if (kind === 'run') return model.prop(e.propertyId)
  if (kind === 'offer' || kind === 'closing') return model.prop(e.propertyId)
  return null
}
function momentOf(kind, e) {
  if (kind === 'seller') return e.anchor.at
  return e.at
}

/** {key, label} of `dim` for an entity. Unresolved values are counted, never assigned. */
export function dimValue(model, kind, e, dim) {
  e._d ||= {}
  if (dim in e._d) return e._d[dim]
  let v
  const p = propertyOf(model, kind, e)
  const o = outreachOf(kind, e)
  switch (dim) {
    case 'market': { const id = p?.market || null; v = label(id, id ? model.markets.get(id)?.display_name || id : null); break }
    case 'state': v = label(p?.state || null); break
    case 'county': v = label(p?.county ? `${p.county}|${p.state || ''}` : null, p?.county ? `${p.county}${p.state ? `, ${p.state}` : ''}` : null); break
    case 'zip': v = label(p?.zip || null); break
    case 'property_type': v = label(p?.propertyType || null); break
    case 'owner_type': v = label(p?.ownerType || null); break
    case 'campaign': {
      const id = kind === 'opportunity' ? e.campaignIds?.[0] || null : o?.campaignId || null
      const c = id ? model.campaigns.get(id) : null
      v = id ? { key: id, label: c?.name || 'Campaign', test: Boolean(c?.integrity?.test) } : { key: '__none', label: 'No campaign (direct / inbox)' }
      break
    }
    case 'campaign_source': {
      const c = o?.campaignId ? model.campaigns.get(o.campaignId) : null
      const k = c ? c.source : 'none'
      v = { key: k, label: CAMPAIGN_SOURCE_LABELS[k] || k }
      break
    }
    case 'sender': { const s = o?.senderId ? model.senders.get(o.senderId) : null; v = label(o?.senderId || null, s ? `${s.friendly_name || s.phone_number}` : o?.senderId); break }
    case 'template': { const t = o?.templateId ? model.templates.get(o.templateId) : null; v = label(o?.templateId || null, t ? `${t.template_name || t.use_case || 'Template'} · ${o.templateId}` : o?.templateId ? `Template ${o.templateId}` : null); break }
    case 'template_use_case': { const t = o?.templateId ? model.templates.get(o.templateId) : null; v = label(t?.use_case || null); break }
    case 'touch': { const b = touchBucket(o?.touch); v = b === 'unknown' ? label(null) : { key: b, label: `Touch ${b}` }; break }
    case 'origin': v = { key: o?.origin || 'unlabelled', label: { system: 'System (campaign / autopilot)', operator: 'Operator (inbox / map)', unlabelled: 'Unlabelled (legacy)' }[o?.origin || 'unlabelled'] }; break
    case 'language': v = label(o?.language || null); break
    case 'channel': v = { key: 'sms', label: 'SMS' }; break
    case 'disposition': v = { key: e.disposition, label: DISPOSITION_LABELS[e.disposition] || e.disposition }; break
    case 'failure_class': v = { key: e.cls, label: CLASS_LABELS[e.cls] || e.cls }; break
    case 'hour_local':
    case 'weekday_local': {
      const lc = localClock(momentOf(kind, e), p?.tz || null)
      if (!lc) { v = label(null); break }
      v = dim === 'hour_local' ? { key: String(lc.hour).padStart(2, '0'), label: `${String(lc.hour).padStart(2, '0')}:00` } : { key: String(lc.weekday), label: WEEKDAYS[lc.weekday] }
      break
    }
    case 'intent': v = label(e.intent || null, clean(e.intent).replace(/_/g, ' ')); break
    case 'stage': { const code = kind === 'transition' ? e.to : e.stage; v = label(code || null, code ? `${STAGE_SHORT[code] || ''} ${UNIVERSAL_STAGE_LABELS[code] || code}`.trim() : null); break }
    case 'from_stage': v = label(e.from || null, e.from ? `${STAGE_SHORT[e.from] || ''} ${UNIVERSAL_STAGE_LABELS[e.from] || e.from}`.trim() : null); break
    case 'actor': v = { key: e.actor, label: e.actor === 'autopilot' ? 'Autopilot' : 'Operator' }; break
    case 'direction': v = { key: e.direction, label: e.direction }; break
    case 'hold_class': v = { key: e.cls, label: RUN_CLASS_LABELS[e.cls] || e.cls }; break
    case 'block_reason': v = label(e.reason || null, clean(e.reason).replace(/_/g, ' ')); break
    case 'workflow': v = label(e.workflow || null); break
    default: v = label(null)
  }
  e._d[dim] = v
  return v
}

/* ═══ FILTERS ═════════════════════════════════════════════════════════════ */

function fieldValue(model, kind, e, field) {
  const p = propertyOf(model, kind, e)
  const o = outreachOf(kind, e)
  switch (field) {
    case 'market': case 'state': case 'county': case 'zip': case 'property_type': case 'owner_type':
    case 'campaign': case 'campaign_source': case 'sender': case 'template': case 'template_use_case': case 'disposition':
    case 'failure_class': case 'intent': case 'stage': case 'hold_class': case 'origin': case 'language': case 'channel': case 'weekday_local': {
      const d = dimValue(model, kind, e, field === 'weekday_local' ? 'weekday_local' : field)
      return d.key === UNRESOLVED || d.key === '__none' ? null : field === 'weekday_local' ? WEEKDAYS[Number(d.key)] : d.key
    }
    case 'hour_local': { const d = dimValue(model, kind, e, 'hour_local'); return d.key === UNRESOLVED ? null : Number(d.key) }
    case 'touch': return o?.touch ?? null
    case 'equity_percent': return p?.equityPercent ?? null
    case 'estimated_value': return p?.estimatedValue ?? null
    case 'year_built': return p?.yearBuilt ?? null
    case 'building_sqft': return p?.buildingSqft ?? null
    case 'bedrooms': return p?.bedrooms ?? null
    case 'units': return p?.units ?? null
    case 'ownership_years': return p?.ownershipYears ?? null
    case 'tax_delinquent': return p?.taxDelinquent ?? null
    case 'active_lien': return p?.activeLien ?? null
    case 'corporate_owner': return p?.corporateOwner ?? null
    case 'out_of_state_owner': return p?.outOfStateOwner ?? null
    default: return null
  }
}

function testOp(op, value, arg) {
  const has = value !== null && value !== undefined && value !== ''
  switch (op) {
    case 'exists': return has
    case 'missing': return !has
    case 'is_true': return value === true
    case 'is_false': return value === false
    case 'eq': return has && String(value) === String(arg)
    case 'neq': return !has || String(value) !== String(arg)
    case 'in': return has && arg.includes(String(value))
    case 'not_in': return !has || !arg.includes(String(value))
    case 'gt': return has && Number(value) > arg
    case 'lt': return has && Number(value) < arg
    case 'between': return has && Number(value) >= arg[0] && Number(value) <= arg[1]
    case 'before': return has && Number(value) < arg
    case 'after': return has && Number(value) >= arg
    default: return false
  }
}

/**
 * Compile filters + breadcrumb for one entity kind. Returns the predicate
 * and the list of filters that do NOT apply to this entity (the caller marks
 * the metric "not filterable by X" instead of silently ignoring the filter).
 */
export function compileFilters(model, kind, filters = [], segment = [], { includeTest = false } = {}) {
  const notApplicable = []
  const tests = []
  for (const f of filters) {
    if (f.field === 'include_test_campaigns') continue
    const def = FIELD[f.field]
    if (!def?.applies.includes(kind)) { notApplicable.push(f.field); continue }
    tests.push((e) => testOp(f.op, fieldValue(model, kind, e, f.field), f.value))
  }
  for (const s of segment) {
    const metricOk = Object.values(METRICS_BY_ID).some((m) => m.entity === kind && m.dimensions.includes(s.dim))
    if (!metricOk) { notApplicable.push(`segment:${s.dim}`); continue }
    tests.push((e) => { const d = dimValue(model, kind, e, s.dim); return String(d.key) === String(s.value ?? UNRESOLVED) })
  }
  const outreach = kind === 'message' || kind === 'seller' || kind === 'reply'
  const excludeTest = outreach && !includeTest
  const pass = (e) => {
    if (excludeTest) { const o = outreachOf(kind, e); if (o?.test) return false }
    for (const t of tests) if (!t(e)) return false
    return true
  }
  return { pass, notApplicable }
}

/* ═══ PERIOD FACTS ════════════════════════════════════════════════════════ */

/**
 * The entity sets of one window. Seller attributes come from the ANCHOR (first
 * delivered message in the window) so seller breakdowns are additive and a
 * breadcrumb step selects exactly the row it came from.
 */
export function periodFacts(model, W, { filters = [], segment = [] } = {}) {
  const includeTest = filters.some((f) => f.field === 'include_test_campaigns' && f.op === 'is_true')
  const F = {}
  const notApplicable = {}
  for (const kind of ['message', 'seller', 'reply', 'transition', 'opportunity', 'run', 'offer', 'closing']) {
    const c = compileFilters(model, kind, filters, segment, { includeTest })
    F[kind] = c.pass
    notApplicable[kind] = c.notApplicable
  }
  const inW = (t) => t !== null && t >= W.start && t < W.end
  let _messages; let _sellers; let _repliers; let _transitions; let _runs; let _offers; let _closings; let _opps
  const pf = {
    W, model, notApplicable,
    get messages() { return (_messages ||= model.sends.filter((s) => inW(s.at) && F.message(s))) },
    get sellers() {
      if (_sellers) return _sellers
      // Test/proof campaign messages are removed BEFORE anchoring (when excluded),
      // so a seller they touched is anchored on their first business message.
      const anchors = new Map()
      for (const s of model.sends) {
        if (!inW(s.at) || s.disposition !== 'delivered' || !s.thread || (!includeTest && s.test)) continue
        if (!anchors.has(s.thread)) anchors.set(s.thread, s)
      }
      _sellers = []
      for (const [thread, anchor] of anchors) {
        const seller = { id: thread, thread, anchor, at: anchor.at }
        if (!F.seller(seller)) continue
        const rs = (model.repliesByThread.get(thread) || []).filter((r) => r.at >= anchor.at && r.at < W.end)
        const first = rs[0] || null
        let latencyMin = null
        if (first) {
          let prior = null
          for (const s of model.sendsByThread.get(thread) || []) { if (s.at > first.at) break; if (s.disposition === 'delivered') prior = s }
          if (prior && first.at - prior.at <= 30 * DAY) latencyMin = (first.at - prior.at) / 60_000
        }
        const oppEvents = (model.oppCreatedByThread.get(thread) || []).filter((h) => h.at >= anchor.at && h.at < W.end)
        let deliveredInW = 0
        for (const s of model.sendsByThread.get(thread) || []) if (inW(s.at) && s.disposition === 'delivered' && (includeTest || !s.test)) deliveredInW += 1
        Object.assign(seller, {
          replied: Boolean(first), firstReply: first, replies: rs,
          positive: rs.some((r) => r.isPositive), optedOut: rs.some((r) => r.isOptOut),
          opportunity: oppEvents[0] || null, latencyMin, deliveredInW,
        })
        _sellers.push(seller)
      }
      return _sellers
    },
    get repliers() {
      if (_repliers) return _repliers
      const firsts = new Map()
      for (const r of model.replies) if (inW(r.at) && !firsts.has(r.thread)) firsts.set(r.thread, r)
      return (_repliers = [...firsts.values()].filter((r) => F.reply(r)))
    },
    get transitions() { return (_transitions ||= model.hist.filter((h) => inW(h.at) && F.transition(h))) },
    get opportunities() { return (_opps ||= [...model.opps.values()].filter((o) => F.opportunity(o))) },
    get runs() { return (_runs ||= model.runs.filter((r) => inW(r.at) && F.run(r))) },
    get offers() { return (_offers ||= model.offers.filter((o) => inW(o.at) && F.offer(o))) },
    get closings() { return (_closings ||= model.closings.filter((c) => F.closing(c))) },
    get purchases() { return model.purchases ? model.purchases.filter((x) => inW(x.at)) : [] },
  }
  return pf
}

/* ═══ METRIC DEFINITIONS (executable form of the registry) ════════════════ */

const SENT = new Set(['delivered', 'sent', 'undelivered'])
const cnt = (entity, set) => ({ kind: 'count', entity, set })
const rate = (num, den) => ({ kind: 'rate', num, den })

export const DEF = {
  sellers_reached: cnt('seller', (pf) => pf.sellers),
  sellers_replied: cnt('reply', (pf) => pf.repliers),
  reached_replied: cnt('seller', (pf) => pf.sellers.filter((s) => s.replied)),
  reply_rate: rate('reached_replied', 'sellers_reached'),
  interested_sellers: cnt('seller', (pf) => pf.sellers.filter((s) => s.positive)),
  positive_reply_rate: rate('interested_sellers', 'reached_replied'),
  interest_rate: rate('interested_sellers', 'sellers_reached'),
  opted_out_sellers: cnt('seller', (pf) => pf.sellers.filter((s) => s.optedOut)),
  opt_out_rate: rate('opted_out_sellers', 'sellers_reached'),
  touches_per_reply: { kind: 'ratio', entity: 'seller', numValue: (set) => set.reduce((a, s) => a + s.deliveredInW, 0), numSet: (pf) => pf.sellers, den: 'reached_replied' },
  median_reply_latency: { kind: 'duration', entity: 'seller', set: (pf) => pf.sellers.filter((s) => s.latencyMin !== null), value: (s) => s.latencyMin },

  messages_sent: cnt('message', (pf) => pf.messages.filter((s) => SENT.has(s.disposition))),
  messages_delivered: cnt('message', (pf) => pf.messages.filter((s) => s.disposition === 'delivered')),
  delivery_rate: rate('messages_delivered', 'messages_sent'),
  transport_failures: cnt('message', (pf) => pf.messages.filter((s) => s.disposition === 'undelivered')),
  transport_failure_rate: rate('transport_failures', 'messages_sent'),
  content_filtered: cnt('message', (pf) => pf.messages.filter((s) => s.cls === 'carrier_spam_filter')),
  content_filter_rate: rate('content_filtered', 'messages_sent'),
  provider_rejections: cnt('message', (pf) => pf.messages.filter((s) => s.disposition === 'rejected')),
  dispatch_decisions: cnt('message', (pf) => pf.messages.filter((s) => DISPATCH_DISPOSITIONS.has(s.disposition))),
  sender_health_blocks: cnt('message', (pf) => pf.messages.filter((s) => s.cls === 'sender_health')),
  sender_health_block_rate: rate('sender_health_blocks', 'dispatch_decisions'),
  template_health_blocks: cnt('message', (pf) => pf.messages.filter((s) => s.cls === 'template_health')),
  content_guard_blocks: cnt('message', (pf) => pf.messages.filter((s) => s.cls === 'content_guard')),
  send_gate_holds: cnt('message', (pf) => pf.messages.filter((s) => s.cls === 'send_gate')),
  send_gate_hold_rate: rate('send_gate_holds', 'dispatch_decisions'),
  median_send_delay: { kind: 'duration', entity: 'message', set: (pf) => pf.messages.filter((s) => s.delayMin !== null), value: (s) => s.delayMin },

  opportunities_created: cnt('transition', (pf) => pf.transitions.filter((h) => h.type === 'opportunity_created')),
  opportunity_rate: { kind: 'rate', num: '__opp_repliers', den: 'reached_replied' },
  __opp_repliers: cnt('seller', (pf) => pf.sellers.filter((s) => s.replied && s.opportunity)),
  stage_advancements: cnt('transition', (pf) => pf.transitions.filter((h) => h.type === 'stage_transition' && h.direction === 'forward')),
  stage_regressions: cnt('transition', (pf) => pf.transitions.filter((h) => h.type === 'stage_transition' && h.direction === 'backward')),
  median_stage_dwell: { kind: 'duration', entity: 'transition', set: (pf) => pf.transitions.filter((h) => h.type === 'stage_transition' && h.prevAt !== null), value: (h) => (h.at - h.prevAt) / 60_000 },
  offers_issued: cnt('offer', (pf) => pf.offers.filter((o) => o.ours)),
  contracts_signed: cnt('closing', (pf) => pf.closings.filter((c) => c.contractAt !== null && c.contractAt >= pf.W.start && c.contractAt < pf.W.end)),
  closings: cnt('closing', (pf) => pf.closings.filter((c) => c.closedAt !== null && c.closedAt >= pf.W.start && c.closedAt < pf.W.end)),
  __entered_offer: cnt('transition', (pf) => pf.transitions.filter((h) => h.type === 'stage_transition' && h.to === 'offer')),
  offer_rate: { kind: 'rate', num: 'offers_issued', den: '__entered_offer', gated: true },
  contract_rate: { kind: 'rate', num: 'contracts_signed', den: 'offers_issued', gated: true },
  close_rate: { kind: 'rate', num: 'closings', den: 'contracts_signed', gated: true },

  autopilot_runs: cnt('run', (pf) => pf.runs),
  autopilot_executed: cnt('run', (pf) => pf.runs.filter((r) => r.cls === 'executed')),
  __human_runs: cnt('run', (pf) => pf.runs.filter((r) => r.cls === 'human_review')),
  __held_runs: cnt('run', (pf) => pf.runs.filter((r) => ['send_gate', 'auto_reply_off', 'human_review', 'policy'].includes(r.cls))),
  human_intervention_rate: rate('__human_runs', 'autopilot_runs'),
  workflow_hold_rate: rate('__held_runs', 'autopilot_runs'),

  buyer_purchases: { ...cnt('purchase', (pf) => pf.purchases), external: 'purchases' },
}

/** The entity kind a metric counts (rates: their denominator's). */
export function entityOf(id) {
  const d = DEF[id]
  if (!d) return null
  if (d.kind === 'rate' || d.kind === 'ratio') return entityOf(d.den)
  return d.entity
}

function availability(model, id) {
  const reg = METRICS_BY_ID[id]
  const a = reg?.availability
  if (!a) return null
  const ever = { offers_issued: model.everCounts.offersIssued, contracts_signed: model.everCounts.contracts, closings: model.everCounts.closings }[a.requires] ?? 0
  return ever < a.min_records_ever ? { status: 'unavailable', reason: a.reason, everRecords: ever } : null
}

/**
 * Evaluate one metric over one window's entity sets.
 * status: ok | no_data | insufficient_sample | unavailable | not_applicable
 */
export function evaluate(id, pf) {
  const d = DEF[id]
  const reg = METRICS_BY_ID[id]
  if (!d) throw new Error(`metric ${id} has no executable definition`)
  const kind = entityOf(id)
  const na = pf.notApplicable[kind] || []
  if (na.length) return { id, status: 'not_applicable', value: null, reason: `Not filterable by ${na.map((x) => x.replace('segment:', '')).join(', ')}.`, notApplicable: na }
  const gate = availability(pf.model, id)
  if (gate) return { id, ...gate, value: null }
  if (d.external === 'purchases' && !pf.model.purchases) {
    return { id, status: 'unavailable', value: null, reason: 'The recorded-transaction corpus (comp_private) is not exposed to this read path; BUYERS mode reads it with its DATA-THROUGH date.' }
  }
  if (d.external === 'purchases' && pf.model.purchasesThrough && pf.W.start > Date.parse(pf.model.purchasesThrough)) {
    return { id, status: 'unavailable', value: null, reason: `The recorded corpus ends ${String(pf.model.purchasesThrough).slice(0, 10)}; this window is not yet recorded (not zero).` }
  }
  const minSample = reg?.min_sample ?? 0
  if (d.kind === 'count') {
    const set = d.set(pf)
    return { id, kind: 'count', status: 'ok', value: set.length, n: set.length }
  }
  if (d.kind === 'rate') {
    const numSet = DEF[d.num].set(pf)
    const denSet = DEF[d.den].set(pf)
    const n = denSet.length
    const x = numSet.length
    if (!n) return { id, kind: 'rate', status: 'no_data', value: null, num: x, den: 0, n: 0, reason: `No ${METRICS_BY_ID[d.den]?.label?.toLowerCase() || 'denominator records'} in this window.` }
    return { id, kind: 'rate', status: n < minSample ? 'insufficient_sample' : 'ok', value: x / n, num: x, den: n, n, ci: wilson(x, n), minSample }
  }
  if (d.kind === 'ratio') {
    const numSet = d.numSet(pf)
    const numValue = d.numValue(numSet)
    const n = DEF[d.den].set(pf).length
    if (!n) return { id, kind: 'ratio', status: 'no_data', value: null, num: numValue, den: 0, n: 0 }
    return { id, kind: 'ratio', status: n < minSample ? 'insufficient_sample' : 'ok', value: numValue / n, num: numValue, den: n, n, minSample }
  }
  if (d.kind === 'duration') {
    const vals = d.set(pf).map(d.value)
    const dist = distribution(vals)
    if (!dist.n) return { id, kind: 'duration', status: 'no_data', value: null, n: 0 }
    return { id, kind: 'duration', status: dist.n < minSample ? 'insufficient_sample' : 'ok', value: dist.p50, n: dist.n, dist, minSample, values: vals }
  }
  throw new Error(`unknown metric kind for ${id}`)
}

/** Entity sets behind a metric: its members (counts), or numerator + denominator (rates). */
export function cohortOf(id, pf, part = 'numerator') {
  const d = DEF[id]
  if (d.kind === 'count' || d.kind === 'duration') return d.set(pf)
  if (d.kind === 'rate') return DEF[part === 'denominator' ? d.den : d.num].set(pf)
  if (d.kind === 'ratio') return part === 'denominator' ? DEF[d.den].set(pf) : d.numSet(pf)
  return []
}

/* ═══ COMPARISON ══════════════════════════════════════════════════════════ */

/**
 * Current vs comparison under IDENTICAL definitions.
 *   counts     delta, % (only on a base ≥ 10), exposure-adjusted exact/normal test
 *   rates      Δ in POINTS with Newcombe 95% CI and a two-proportion z-test; both
 *              denominators must meet the metric's minimum sample
 *   durations  Δ minutes, Mann–Whitney U on the two samples
 */
export function compare(id, cur, prev, { lenCur = 1, lenPrev = 1, alpha = 0.05 } = {}) {
  if (!prev || prev.status === 'not_applicable' || prev.status === 'unavailable' || cur.status === 'not_applicable' || cur.status === 'unavailable') return { comparable: false, reason: 'not comparable' }
  const reg = METRICS_BY_ID[id]
  if (cur.kind === 'count') {
    const delta = cur.value - prev.value
    const t = compareCounts(cur.value, prev.value, lenCur, lenPrev)
    const material = Math.abs(delta) >= 5 && Math.max(cur.value, prev.value) >= 10
    return { comparable: true, kind: 'count', delta, pct: prev.value >= 10 ? delta / prev.value : null, p: t.p, significant: t.p < alpha && material, lengthAdjusted: Math.abs(lenCur - lenPrev) / Math.max(lenCur, lenPrev) > 0.02 }
  }
  if (cur.kind === 'rate') {
    if (cur.status === 'no_data' || prev.status === 'no_data') return { comparable: false, reason: 'no denominator in one window' }
    const min = reg?.min_sample ?? 0
    const t = compareProportions(cur.num, cur.den, prev.num, prev.den)
    const enough = cur.den >= min && prev.den >= min
    return { comparable: enough, kind: 'rate', pts: (cur.value - prev.value) * 100, ciPts: t ? [t.low * 100, t.high * 100] : null, p: t?.p ?? 1, significant: enough && t && t.p < alpha, reason: enough ? null : `needs n ≥ ${min} in both windows (${cur.den} vs ${prev.den})` }
  }
  if (cur.kind === 'ratio') {
    if (cur.value === null || prev.value === null) return { comparable: false, reason: 'no denominator in one window' }
    return { comparable: true, kind: 'ratio', delta: cur.value - prev.value, pct: prev.value ? (cur.value - prev.value) / prev.value : null, p: null, significant: false }
  }
  if (cur.kind === 'duration') {
    if (cur.value === null || prev.value === null) return { comparable: false, reason: 'no samples in one window' }
    const t = mannWhitney(cur.values || [], prev.values || [])
    return { comparable: true, kind: 'duration', delta: cur.value - prev.value, pct: prev.value ? (cur.value - prev.value) / prev.value : null, p: t?.p ?? null, significant: Boolean(t && t.p < alpha) }
  }
  return { comparable: false }
}

/* ═══ BREAKDOWN / SERIES / HEATMAP / HISTOGRAM / CONTRIBUTION ═════════════ */

function groupBy(model, kind, set, dim) {
  const g = new Map()
  for (const e of set) {
    const v = dimValue(model, kind, e, dim)
    const k = String(v.key)
    if (!g.has(k)) g.set(k, { key: k, label: v.label, test: v.test || false, members: [] })
    g.get(k).members.push(e)
  }
  return g
}

/** Value of `id` per group of `dim`. Rows add up to the total for additive metrics. */
export function breakdown(id, pf, dim, { limit = 50 } = {}) {
  const d = DEF[id]
  const kind = entityOf(id)
  const model = pf.model
  const rows = []
  if (d.kind === 'count') {
    for (const g of groupBy(model, kind, d.set(pf), dim).values()) rows.push({ key: g.key, label: g.label, test: g.test, value: g.members.length, n: g.members.length })
  } else if (d.kind === 'rate') {
    const num = new Set(DEF[d.num].set(pf))
    for (const g of groupBy(model, kind, DEF[d.den].set(pf), dim).values()) {
      const x = g.members.filter((e) => num.has(e)).length
      const n = g.members.length
      rows.push({ key: g.key, label: g.label, test: g.test, value: n ? x / n : null, num: x, den: n, n, ci: wilson(x, n), insufficient: n < (METRICS_BY_ID[id]?.min_sample ?? 0) })
    }
  } else if (d.kind === 'ratio') {
    const repl = new Set(DEF[d.den].set(pf))
    for (const g of groupBy(model, kind, d.numSet(pf), dim).values()) {
      const nv = d.numValue(g.members)
      const n = g.members.filter((e) => repl.has(e)).length
      rows.push({ key: g.key, label: g.label, value: n ? nv / n : null, num: nv, den: n, n })
    }
  } else if (d.kind === 'duration') {
    for (const g of groupBy(model, kind, d.set(pf), dim).values()) {
      const dist = distribution(g.members.map(d.value))
      rows.push({ key: g.key, label: g.label, value: dist.p50, n: dist.n, dist, insufficient: dist.n < (METRICS_BY_ID[id]?.min_sample ?? 0) })
    }
  }
  // Geography: each group's centroid = mean of its members' property coordinates (for the map layer).
  if (GEO_DIMS.has(dim)) {
    const set = d.kind === 'rate' ? DEF[d.den].set(pf) : d.kind === 'ratio' ? d.numSet(pf) : d.set(pf)
    const acc = new Map()
    for (const e of set) {
      const p = propertyOf(model, kind, e)
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) < 0.1) continue
      const k = String(dimValue(model, kind, e, dim).key)
      const a = acc.get(k) || { lat: 0, lng: 0, n: 0 }
      a.lat += p.lat; a.lng += p.lng; a.n += 1
      acc.set(k, a)
    }
    for (const r of rows) { const a = acc.get(r.key); if (a?.n) r.centroid = { lat: a.lat / a.n, lng: a.lng / a.n, n: a.n } }
  }
  // Test/proof campaigns never rank: they sort last and say so.
  rows.sort((a, b) => Number(a.test) - Number(b.test) || Number(a.key === UNRESOLVED) - Number(b.key === UNRESOLVED) || (b.n ?? 0) - (a.n ?? 0))
  return { dim, rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit }
}
const GEO_DIMS = new Set(['market', 'state', 'county', 'zip'])

/**
 * Several metrics × one dimension, merged by group key (campaign comparison,
 * sender / template tables). Each metric keeps its own entity and attribution
 * rule; a metric the dimension does not apply to is reported, not faked.
 */
export function table(ids, pf, dim, { limit = 100 } = {}) {
  const rows = new Map()
  const skipped = []
  for (const id of ids) {
    const reg = METRICS_BY_ID[id]
    if (!reg || !reg.dimensions.includes(dim)) { skipped.push({ id, reason: 'dimension not valid for this metric' }); continue }
    const ev = evaluate(id, pf)
    if (ev.status === 'not_applicable' || ev.status === 'unavailable') { skipped.push({ id, reason: ev.reason }); continue }
    for (const r of breakdown(id, pf, dim, { limit: 5000 }).rows) {
      const row = rows.get(r.key) || { key: r.key, label: r.label, test: Boolean(r.test), values: {} }
      row.test = row.test || Boolean(r.test)
      row.values[id] = { value: r.value, num: r.num ?? null, den: r.den ?? null, n: r.n, ci: r.ci ?? null, insufficient: Boolean(r.insufficient) }
      rows.set(r.key, row)
    }
  }
  const sortId = ids[0]
  const out = [...rows.values()].sort((a, b) => Number(a.test) - Number(b.test) || Number(a.key === UNRESOLVED) - Number(b.key === UNRESOLVED) || (b.values[sortId]?.n ?? 0) - (a.values[sortId]?.n ?? 0))
  return { dim, metrics: ids, rows: out.slice(0, limit), total: out.length, truncated: out.length > limit, skipped }
}

/**
 * THE STAGE MATRIX (canonical S1–S10), period events + current inventory.
 *   entered     transitions INTO the stage (incl. opportunities created at it)
 *   exits       transitions OUT of it; forward share = forward exits / exits (a proportion, Wilson)
 *   dwell       exit time − entry time (median / P75, n)
 *   by          who moved them in: autopilot (system-handled) vs operator (human)
 *   live/stalled current inventory: active, touched within DORMANT_DAYS; stalled = past the stage's own threshold
 */
export function stageMatrix(pf, { now = Date.now(), maxDays = {}, dormantDays = 30 } = {}) {
  const model = pf.model
  const codes = Object.keys(STAGE_INDEX).sort((a, b) => STAGE_INDEX[a] - STAGE_INDEX[b])
  const T = pf.transitions
  const inv = pf.opportunities.filter((o) => o.status === 'active')
  return codes.map((code) => {
    const entered = T.filter((h) => (h.type === 'stage_transition' || h.type === 'opportunity_created') && h.to === code)
    const exits = T.filter((h) => h.type === 'stage_transition' && h.from === code)
    const forward = exits.filter((h) => h.direction === 'forward')
    const dwell = distribution(exits.filter((h) => h.prevAt !== null).map((h) => (h.at - h.prevAt) / 60_000))
    const here = inv.filter((o) => o.stage === code)
    const live = here.filter((o) => o.lastActivityAt && now - o.lastActivityAt < dormantDays * DAY)
    const limitDays = maxDays[code] ?? null
    const stalled = limitDays ? live.filter((o) => o.stageEnteredAt && (now - o.stageEnteredAt) / DAY > limitDays) : []
    const ages = distribution(live.filter((o) => o.stageEnteredAt).map((o) => (now - o.stageEnteredAt) / 60_000))
    return {
      code, index: STAGE_INDEX[code], label: UNIVERSAL_STAGE_LABELS[code] || code,
      entered: entered.length, enteredBySystem: entered.filter((h) => h.actor === 'autopilot').length, enteredByHuman: entered.filter((h) => h.actor !== 'autopilot').length,
      exits: exits.length, forward: forward.length, backward: exits.filter((h) => h.direction === 'backward').length,
      forwardShare: exits.length ? forward.length / exits.length : null, forwardCi: wilson(forward.length, exits.length),
      dwell, active: here.length, live: live.length, dormant: here.length - live.length, stalled: stalled.length, stallThresholdDays: limitDays, liveAge: ages,
      stalledIds: stalled.map((o) => o.id).slice(0, 200),
    }
  })
}

/** Per-bucket values. Seller metrics bucket by anchor time, so buckets sum to the period. */
export function series(id, pf, { grain, tz }) {
  const d = DEF[id]
  const kind = entityOf(id)
  const starts = bucketList(pf.W.start, pf.W.end, grain, tz)
  const idx = (t) => { let lo = 0; let hi = starts.length - 1; let ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1 } return ans }
  const moment = (e) => (kind === 'seller' ? e.anchor.at : kind === 'closing' ? (id === 'contracts_signed' ? e.contractAt : e.closedAt) : e.at)
  const empty = () => starts.map(() => [])
  const place = (set) => { const b = empty(); for (const e of set) { const i = idx(moment(e)); if (i >= 0) b[i].push(e) } return b }
  const out = starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1] : nextBucket(s, grain, tz) }))
  if (d.kind === 'count') { place(d.set(pf)).forEach((m, i) => { out[i].value = m.length; out[i].n = m.length }) }
  else if (d.kind === 'rate') {
    const num = new Set(DEF[d.num].set(pf))
    place(DEF[d.den].set(pf)).forEach((m, i) => { const x = m.filter((e) => num.has(e)).length; Object.assign(out[i], { value: m.length ? x / m.length : null, num: x, den: m.length, n: m.length, ci: wilson(x, m.length) }) })
  } else if (d.kind === 'ratio') {
    const repl = new Set(DEF[d.den].set(pf))
    place(d.numSet(pf)).forEach((m, i) => { const n = m.filter((e) => repl.has(e)).length; const nv = d.numValue(m); Object.assign(out[i], { value: n ? nv / n : null, num: nv, den: n, n }) })
  } else if (d.kind === 'duration') {
    place(d.set(pf)).forEach((m, i) => { const dist = distribution(m.map(d.value)); Object.assign(out[i], { value: dist.p50, n: dist.n, p75: dist.p75 }) })
  }
  return out
}

/** Hour × weekday in SELLER-LOCAL time (property geography). Rows without a resolvable zone are counted apart. */
export function heatmap(id, pf) {
  const d = DEF[id]
  const kind = entityOf(id)
  const model = pf.model
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ num: 0, den: 0, n: 0 })))
  let unresolved = 0
  const place = (e) => {
    const h = dimValue(model, kind, e, 'hour_local')
    const w = dimValue(model, kind, e, 'weekday_local')
    if (h.key === UNRESOLVED || w.key === UNRESOLVED) { unresolved += 1; return null }
    return cells[Number(w.key)][Number(h.key)]
  }
  if (d.kind === 'rate') {
    const num = new Set(DEF[d.num].set(pf))
    for (const e of DEF[d.den].set(pf)) { const c = place(e); if (c) { c.den += 1; c.n += 1; if (num.has(e)) c.num += 1 } }
    for (const row of cells) for (const c of row) { c.value = c.den ? c.num / c.den : null; c.ci = wilson(c.num, c.den) }
  } else {
    const set = d.kind === 'ratio' ? d.numSet(pf) : d.set(pf)
    for (const e of set) { const c = place(e); if (c) { c.n += 1; c.num += 1 } }
    for (const row of cells) for (const c of row) c.value = c.n
  }
  return { weekdays: WEEKDAYS, cells, unresolved, basis: 'seller-local time from the property’s state/ZIP (canonical contact-window timezone rule)' }
}

/** Histogram with percentiles for duration metrics (log-spaced bins in minutes). */
export function histogram(id, pf, { bins = 24 } = {}) {
  const d = DEF[id]
  if (d.kind !== 'duration') return null
  const vals = d.set(pf).map(d.value).filter((v) => Number.isFinite(v) && v >= 0)
  const dist = distribution(vals)
  if (!vals.length) return { bins: [], dist }
  const lo = Math.max(0.5, Math.min(...vals.filter((v) => v > 0), 1))
  const hi = Math.max(lo * 2, Math.max(...vals))
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo * (hi / lo) ** (i / bins))
  edges[0] = 0
  const counts = new Array(bins).fill(0)
  for (const v of vals) { let i = edges.findIndex((e, k) => k > 0 && v <= e) - 1; if (i < 0) i = bins - 1; counts[Math.max(0, i)] += 1 }
  return { bins: counts.map((c, i) => ({ from: edges[i], to: edges[i + 1], count: c })), dist }
}

/**
 * Which groups contributed to the observed change between two windows.
 * Rates: midpoint decomposition (rate effect + mix effect) summing exactly to
 * the change in points. Counts: per-group deltas summing to the total delta.
 */
export function contribution(id, pfCur, pfPrev, dim, { limit = 12 } = {}) {
  const d = DEF[id]
  const kind = entityOf(id)
  if (d.kind === 'rate') {
    const g1 = groupBy(pfCur.model, kind, DEF[d.den].set(pfCur), dim)
    const g0 = groupBy(pfPrev.model, kind, DEF[d.den].set(pfPrev), dim)
    const n1 = new Set(DEF[d.num].set(pfCur))
    const n0 = new Set(DEF[d.num].set(pfPrev))
    const keys = new Set([...g1.keys(), ...g0.keys()])
    const groups = [...keys].map((k) => ({
      key: k, label: g1.get(k)?.label ?? g0.get(k)?.label, test: Boolean(g1.get(k)?.test || g0.get(k)?.test),
      d1: g1.get(k)?.members.length || 0, n1: (g1.get(k)?.members || []).filter((e) => n1.has(e)).length,
      d0: g0.get(k)?.members.length || 0, n0: (g0.get(k)?.members || []).filter((e) => n0.has(e)).length,
    }))
    const dec = decomposeRateChange(groups)
    if (!dec) return { dim, kind: 'rate', available: false, reason: 'One window has no denominator.' }
    const rows = dec.rows.map((r) => ({ key: r.key, label: r.label, test: r.test, cur: { num: r.n1, den: r.d1, rate: r.r1 }, prev: { num: r.n0, den: r.d0, rate: r.r0 }, contributionPts: r.contribution * 100, rateEffectPts: r.rateEffect * 100, mixEffectPts: r.mixEffect * 100 }))
      .sort((a, b) => Math.abs(b.contributionPts) - Math.abs(a.contributionPts))
    return { dim, kind: 'rate', available: true, totalPts: dec.total * 100, rows: rows.slice(0, limit), others: rows.slice(limit).reduce((a, r) => a + r.contributionPts, 0), language: 'contributed to the observed change' }
  }
  if (d.kind === 'count') {
    const g1 = groupBy(pfCur.model, kind, d.set(pfCur), dim)
    const g0 = groupBy(pfPrev.model, kind, d.set(pfPrev), dim)
    const keys = new Set([...g1.keys(), ...g0.keys()])
    const rows = [...keys].map((k) => {
      const c = g1.get(k)?.members.length || 0
      const p = g0.get(k)?.members.length || 0
      return { key: k, label: g1.get(k)?.label ?? g0.get(k)?.label, test: Boolean(g1.get(k)?.test || g0.get(k)?.test), cur: c, prev: p, contribution: c - p }
    }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    const total = rows.reduce((a, r) => a + r.contribution, 0)
    return { dim, kind: 'count', available: true, total, rows: rows.slice(0, limit), others: rows.slice(limit).reduce((a, r) => a + r.contribution, 0), language: 'contributed to the observed change' }
  }
  return { dim, kind: d.kind, available: false, reason: 'Contribution analysis applies to counts and rates.' }
}

/* ═══ v1 COMPATIBILITY (reconciliation only) ══════════════════════════════ */

/**
 * The v1 analytics_performance totals recomputed from the SAME fact rows,
 * with v1's own predicates and time basis. Build the model with
 * basis 'created' (v1 placed everything by created_at) for an exact match.
 * Used only by the reconciliation proof and tests: agreement here proves the
 * extraction and predicates; every lab-v2 difference is then definitional.
 */
export function v1Compatible(model, W) {
  const inW = (t) => t !== null && t >= W.start && t < W.end
  const sq = model.sends.filter((s) => inW(s.at))
  const inb = model.replies.filter((r) => inW(r.at))
  const hist = model.hist.filter((h) => inW(h.at))
  const runs = model.runs.filter((r) => inW(r.at))
  const distinct = (xs) => new Set(xs.filter(Boolean)).size
  const HUMAN = /(review|unclear|missing_context|low_confidence)/i
  return {
    send_rows: sq.length,
    sent: sq.filter((s) => s.v1.isSent).length,
    delivered: sq.filter((s) => s.v1.isDelivered).length,
    delivered_conversations: distinct(sq.filter((s) => s.v1.isDelivered).map((s) => s.thread)),
    failed: sq.filter((s) => s.v1.isFailed).length,
    failed_transport: sq.filter((s) => s.status === 'failed_transport').length,
    health_guard_blocks: sq.filter((s) => s.status === 'blocked_by_health_guard').length,
    expired: sq.filter((s) => s.status === 'expired').length,
    cancelled: sq.filter((s) => s.status === 'cancelled').length,
    replied_conversations: distinct(inb.map((r) => r.thread)),
    positive_conversations: distinct(inb.filter((r) => r.isPositive).map((r) => r.thread)),
    opt_out_conversations: distinct(inb.filter((r) => r.isOptOut).map((r) => r.thread)),
    opportunities_created: hist.filter((h) => h.type === 'opportunity_created' && h.opp).length,
    stage_advancements: hist.filter((h) => h.type === 'stage_transition' && h.opp).length,
    automation_runs: runs.length,
    automation_succeeded: runs.filter((r) => r.status === 'succeeded').length,
    automation_held_by_gate: runs.filter((r) => r.status === 'blocked' && r.reason === 'execution_gated').length,
    automation_needs_review: runs.filter((r) => r.status === 'blocked' && HUMAN.test(r.reason || '')).length,
    automation_failed: runs.filter((r) => r.status === 'failed').length,
  }
}

export { UNRESOLVED, DIMENSION_REGISTRY }
