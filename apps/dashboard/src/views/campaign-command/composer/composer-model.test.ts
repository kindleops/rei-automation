import { describe, expect, it } from 'vitest'
import {
  buildSegments, capacityPlan, checkSchedule, completionEstimate, compositionDiff, compositionPayload, deriveReadiness, eligibleOf, emptyComposition,
  coverageMarkets, launchSentence, parseCap, withCohort, serializeClauses, snapVolume, universeSegments, zoneWaves, type Composition,
  audienceFunnel, audienceFreshness, campaignSizeCheck, languageBreakdown,
} from './composer-model'
import type { ComposerAudience, ComposerCohort, ComposerCoverage, ComposerFleet, ComposerTemplates, CoverageMarket } from './composer-types'
import { intakeFromLocation, resolveDrop, COMPOSER_OBJECTS_MIME } from './composer-intake'
import { composerCommands } from './composer-commands'
import { isLegacyBuilderForced } from './composer-flag'

const NOW = Date.parse('2026-10-02T15:00:00Z') // 10:00 CT

function audience(over: Partial<ComposerAudience> = {}): ComposerAudience {
  return {
    ok: true, at: '', strategy: { use_case: 'ownership_check', stage_code: 'S1' },
    matched: 7738, addressable: 7741, reachable: 5708, sms_eligible: 4572, clean: 4525, eligible_in_audience: 4525,
    exclusions: { suppressed: 231, dnc: 0, wrong_number: 0, no_phone: 2030, sms_ineligible: 1136, no_sender_route: 0, pending_prior_touch: 0, active_queue: 0 },
    build: { ok: true, requested_limit: 1000, simulated_limit: 1000, rows_read: 1000, recipients: 881, duplicates_collapsed: 119, built: 881, ready: 737, held: 144, held_by_reason: { entity_contact_requires_review: 128, missing_identity_linkage: 16 }, sendable_now: 737, no_sendable_number: 0, sender_markets: [] },
    distributions: { markets: [{ value: 'Dallas, TX', label: 'Dallas, TX', count: 1000 }], languages: [], property_types: [], zips: [], zones: [{ value: 'America/Chicago', label: 'America/Chicago', count: 1000 }] },
    zones: { scanned: 1000, unresolved: 0 },
    inapplicable_filters: [], unsupported_filters: [], dropped_filter_count: 0, graph_freshness: {}, graph_unavailable: false, warnings: [],
    samples: [{ id: 'a', property_id: '1', recipient: 'Charles', place: 'Cedar Hill, TX', market: 'Dallas, TX', language: null, ok: true, text: 'Hello', template_id: '208481', reason: null }],
    ...over,
  }
}
const mkt = (over: Partial<CoverageMarket> = {}): CoverageMarket => ({ market_id: null, market: 'Dallas, TX', targets: 3323, coverage: 'LOCAL', serving_pool: 'Dallas, TX', serving_tier: 'exact_market_match', healthy_numbers: 1, daily_capacity: 798, unavailable: [], ...over })
const cov = (markets: CoverageMarket[], capacity = markets.reduce((s, m) => s + m.daily_capacity, 0)): ComposerCoverage => ({ ok: true, at: '', engine: 'legacy_router', markets, totals: { distinct_healthy_numbers: markets.reduce((s, m) => s + m.healthy_numbers, 0), distinct_daily_capacity: capacity, targets: markets.reduce((s, m) => s + m.targets, 0) }, v2_preview: null })
const fleet = (): ComposerFleet => ({ ok: true, at: '', numbers: [], markets: [], blocklist_readable: true, system: { per_number_cap: 800, processor_mode: 'live', emergency_stop_at: null, outbound_sms_enabled: true, contact_window: { start: '08:00', end: '21:00' }, auto_reply_mode: 'assisted', followup_automation_mode: 'off' } })
const templates = (sendable = 26): ComposerTemplates => ({ ok: true, at: '', governance_readable: true, strategies: [{ use_case: 'ownership_check', stage_code: 'S1', label: 'Ownership check', touch: 'First touch', languages: [], templates: 47, sendable, governed: [] }] })
const dallas = (): Composition => ({ ...emptyComposition(), name: 'Dallas', campaign_size: 'custom', total_cap: '1000', filters: [{ id: 'f', domain: 'properties', category: 'Location & Market', fieldKey: 'properties.market', label: 'Market', operator: 'is_any_of', value: ['Dallas, TX'] }] })

describe('composition payload', () => {
  it('never carries status or automation; a cap of 0 is stated as 0', () => {
    const p = compositionPayload({ ...dallas(), daily_cap: '0' }) as Record<string, unknown>
    expect('status' in p).toBe(false)
    expect('auto_send_enabled' in p).toBe(false)
    expect('auto_reply_mode' in p).toBe(false)
    expect(p.daily_cap).toBe('0')
    expect(parseCap('0')).toBe(0)
    expect(parseCap('')).toBeNull()
    expect(Number.isNaN(parseCap('-3') as number)).toBe(true)
  })
  it('serializes clauses into the grouped target_filters shape', () => {
    const g = serializeClauses(dallas().filters)
    expect(g.properties).toEqual([{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX'], domain: 'properties', category: 'Location & Market' }])
    expect(g.prospects).toEqual([])
  })
})

describe('audience', () => {
  it('eligible is the build’s sender-carried ready set; units stay apart', () => {
    const a = audience()
    expect(eligibleOf(a)).toBe(737)
    expect(universeSegments(a).find((s) => s.key === 'suppressed')?.count).toBe(231)
    expect(buildSegments(a).map((s) => s.key)).toEqual(['ready', 'held', 'dupes'])
    expect(eligibleOf(null)).toBeNull()
  })
})

describe('whole cohort', () => {
  const cohort: ComposerCohort = { ok: true, at: '', queue_eligible_in_audience: 4525, rows_read: 4525, capped_by_build_limit: false, build_limit: 100000, recipients: 3816, duplicates_collapsed: 709, ready: 3323, held: 493, held_by_reason: { entity_contact_requires_review: 432 }, sendable_now: 3323, no_sendable_number: 0, sender_markets: [], ready_by_zone: { 'America/Chicago': 3300, unresolved: 23 }, ready_by_market: {}, timings_ms: { read: 4500, total: 7900 } }
  it('replaces the sampled build with the authoritative count, zones included', () => {
    const merged = withCohort(audience(), cohort)!
    expect(eligibleOf(merged)).toBe(3323)
    expect(merged.build.whole_cohort).toBe(true)
    expect(merged.zones.unresolved).toBe(23)
    expect(merged.distributions.zones.map((z) => z.value)).toEqual(['America/Chicago'])
  })
  it('a sampled count alone never reads as ready', () => {
    const waves = zoneWaves([{ value: 'America/Chicago', count: 1 }], { start: '08:00', end: '21:00' }, NOW, 48)
    const r = deriveReadiness({ composition: dallas(), audience: audience(), audienceError: null, audienceLoading: false, templates: templates(), fleet: fleet(), coverage: cov([mkt()]), online: true, now: NOW, waves })
    expect(r.checks.find((c) => c.key === 'audience')?.state).toBe('checking')
  })
})

describe('readiness', () => {
  const base = { audienceError: null, audienceLoading: false, online: true, now: NOW, waves: zoneWaves([{ value: 'America/Chicago', count: 1000 }], { start: '08:00', end: '21:00' }, NOW, 48) }
  it('zero eligible disables launch', () => {
    const a = audience({ build: { ...audience().build, ready: 0, sendable_now: 0 } })
    const r = deriveReadiness({ ...base, composition: dallas(), audience: a, templates: templates(), fleet: fleet(), coverage: cov([mkt()]) })
    expect(r.state).toBe('blocked')
    expect(r.checks.find((c) => c.key === 'audience')?.text).toBe('Zero eligible prospects')
  })
  it('a ready Dallas composition reads ready', () => {
    const whole = { ...audience(), build: { ...audience().build, whole_cohort: true } }
    const r = deriveReadiness({ ...base, composition: dallas(), audience: whole, templates: templates(), fleet: fleet(), coverage: cov([mkt()]) })
    expect(r.blockers).toBe(0)
    expect(['ready', 'warning']).toContain(r.state)
  })
  it('no sender, no template, a lost connection and cap 0 each block', () => {
    expect(deriveReadiness({ ...base, composition: dallas(), audience: audience(), templates: templates(), fleet: fleet(), coverage: cov([mkt({ coverage: 'UNCOVERED', serving_pool: null, serving_tier: null, healthy_numbers: 0, daily_capacity: 0, unavailable: [{ pool: 'Dallas, TX', reasons: [{ phone: '•••1600', reason: 'outbound_number_health_cooling' }] }] })]) }).checks.find((c) => c.key === 'senders')?.state).toBe('block')
    expect(deriveReadiness({ ...base, composition: dallas(), audience: audience(), templates: templates(0), fleet: fleet(), coverage: cov([mkt()]) }).checks.find((c) => c.key === 'templates')?.state).toBe('block')
    expect(deriveReadiness({ ...base, online: false, composition: dallas(), audience: audience(), templates: templates(), fleet: fleet(), coverage: cov([mkt()]) }).state).toBe('blocked')
    expect(deriveReadiness({ ...base, composition: { ...dallas(), daily_cap: '0' }, audience: audience(), templates: templates(), fleet: fleet(), coverage: cov([mkt()]) }).checks.find((c) => c.key === 'capacity')?.text).toMatch(/sends nothing/)
  })
  it('nothing unanswered reads as ready (checking, never a zero)', () => {
    const r = deriveReadiness({ ...base, composition: dallas(), audience: null, audienceLoading: true, templates: null, fleet: null, coverage: null })
    expect(r.state).toBe('checking')
  })
  it('an unresolved recipient zone is a warning (held), never placed on a zone', () => {
    const a = audience({ zones: { scanned: 1000, unresolved: 40 } })
    const r = deriveReadiness({ ...base, composition: dallas(), audience: a, templates: templates(), fleet: fleet(), coverage: cov([mkt()]) })
    expect(r.checks.find((c) => c.key === 'windows')?.text).toMatch(/Timezone unavailable for 40/)
    const waves = zoneWaves([{ value: 'unresolved', count: 40 }, { value: 'America/Chicago', count: 960 }], { start: '08:00', end: '21:00' }, NOW, 48)
    expect(waves.map((w) => w.zone)).toEqual(['America/Chicago'])
  })
})

describe('capacity (routing engine coverage)', () => {
  const coverage = cov([
    mkt(),
    mkt({ market: 'Phoenix, AZ', targets: 2844, coverage: 'REGIONAL', serving_pool: 'Los Angeles, CA', serving_tier: 'approved_state_fallback', healthy_numbers: 0, daily_capacity: 0 }),
    mkt({ market: 'Miami, FL', targets: 9733, coverage: 'UNCOVERED', serving_pool: null, serving_tier: null, healthy_numbers: 0, daily_capacity: 0, unavailable: [{ pool: 'Miami, FL', reasons: [{ phone: '•••2999', reason: 'outbound_number_health_cooling' }, { phone: '•••5670', reason: 'outbound_number_blocked_by_operator' }] }] }),
  ], 800)
  const c = { daily_cap: '750', send_interval_seconds: '45', contact_window_start: '08:00', contact_window_end: '21:00' }
  it('takes capacity and coverage from the engine, never the raw fleet', () => {
    const p = capacityPlan(coverage, c)
    expect(p.available_per_day).toBe(800)
    expect(p.window_per_day).toBe(1040)
    expect(p.effective_per_day).toBe(750)
    expect(p.binding).toBe('daily_cap')
    expect(p.uncovered_markets).toEqual(['Miami, FL'])
    expect(p.uncovered_targets).toBe(9733)
    expect(p.covered_targets).toBe(3323 + 2844)
    expect(p.unavailable_reason).toBe('1 cooling, 1 blocked')
  })
  it('shared fallback numbers are counted once (nine markets on one Dallas number = one limit)', () => {
    const west = cov(Array.from({ length: 9 }, (_, i) => mkt({ market: `West ${i}, CA`, coverage: 'DEGRADED', serving_pool: 'Dallas, TX', daily_capacity: 798, shared_numbers: 1 })), 798)
    const p = capacityPlan(west, { ...c, daily_cap: '5000' })
    expect(p.available_per_day).toBe(798)
    expect(p.effective_per_day).toBe(798)
    expect(p.binding).toBe('sender_capacity')
  })
  it('a volume beyond routed capacity snaps back with the reason', () => {
    const s = snapVolume(1060, capacityPlan(coverage, c))
    expect(s.snapped).toBe(true)
    expect(s.value).toBe(800)
    expect(s.reason).toBe('+260/day unavailable: 1 cooling, 1 blocked')
  })
  it('readiness names the unrouted markets before launch; all unrouted blocks', () => {
    const base = { audience: audience(), audienceError: null, audienceLoading: false, templates: templates(), fleet: fleet(), online: true, now: NOW, waves: [] }
    const partial = deriveReadiness({ ...base, composition: dallas(), coverage })
    expect(partial.checks.find((x) => x.key === 'senders')?.text).toMatch(/No route for Miami, FL — 9,733 sellers won’t send/)
    const none = deriveReadiness({ ...base, composition: dallas(), coverage: cov([coverage.markets[2]]) })
    expect(none.checks.find((x) => x.key === 'senders')?.state).toBe('block')
  })
  it('the audience markets feed the engine (whole cohort when counted)', () => {
    const merged = withCohort(audience(), { ok: true, at: '', queue_eligible_in_audience: 1, rows_read: 1, capped_by_build_limit: false, build_limit: 100000, recipients: 1, duplicates_collapsed: 0, ready: 5, held: 0, held_by_reason: {}, sendable_now: 2, no_sendable_number: 3, sender_markets: [], ready_by_zone: {}, ready_by_market: { 'Phoenix, AZ': 3, 'Dallas, TX': 2 }, timings_ms: { read: 1, total: 1 } })
    expect(coverageMarkets(merged)).toEqual([{ market: 'Phoenix, AZ', state: 'AZ', targets: 3 }, { market: 'Dallas, TX', state: 'TX', targets: 2 }])
  })
  it('completion carries the held set as its uncertainty', () => {
    expect(completionEstimate(737, 144, 300)).toEqual({ low: 3, high: 3 })
    expect(completionEstimate(1482, 600, 750)).toEqual({ low: 2, high: 3 })
    expect(completionEstimate(0, 0, 750)).toBeNull()
  })
})

describe('schedule (D4 / D10)', () => {
  const waves = zoneWaves([{ value: 'America/New_York', count: 10 }, { value: 'America/Los_Angeles', count: 10 }, { value: 'America/Chicago', count: 10 }], { start: '08:00', end: '21:00' }, NOW, 48)
  it('orders zone waves east to west', () => {
    expect(waves.map((w) => w.short)).toEqual(['ET', 'CT', 'PT'])
  })
  it('a past start is missed: Start now or Reschedule, never fired late', () => {
    expect(checkSchedule({ mode: 'at', at: '2026-10-02T09:00:00Z' }, waves, NOW).state).toBe('missed')
    expect(checkSchedule({ mode: 'at', at: 'garbage' }, waves, NOW).state).toBe('invalid')
  })
  it('evaluates windows per recipient zone', () => {
    // 10:00 CT: ET and CT open, PT (08:00 local) open too
    expect(checkSchedule({ mode: 'now', at: null }, waves, NOW).state).toBe('ok')
    // 03:00 CT the next day: every zone closed
    const night = Date.parse('2026-10-03T08:00:00Z')
    const r = checkSchedule({ mode: 'at', at: new Date(night).toISOString() }, waves, NOW)
    expect(r.state).toBe('warn')
  })
  it('the confirmation names recipient-local windows', () => {
    expect(launchSentence(1482, { mode: 'at', at: 'x' })).toBe('1,482 eligible prospects will be scheduled through recipient-local contact windows.')
  })
})

describe('diff', () => {
  it('lists what an edit changes against the saved draft', () => {
    const base = dallas()
    const d = compositionDiff(base, { ...base, daily_cap: '500' })
    expect(d).toEqual([{ label: 'Daily cap', from: '750', to: '500' }])
    expect(compositionDiff(null, base)).toEqual([])
  })
})

describe('intake', () => {
  it('reads compose intents from the instance route, including the legacy builder link', () => {
    expect(intakeFromLocation('/campaign-command?compose=1')).toEqual({ kind: 'blank' })
    expect(intakeFromLocation('/campaign-command?campaign=abc&builder=edit')).toEqual({ kind: 'draft', campaignId: 'abc' })
    expect(intakeFromLocation('/campaign-command?compose=1&market=Dallas%2C%20TX')).toEqual({ kind: 'market', market: 'Dallas, TX', markets: ['Dallas, TX'] })
    expect(intakeFromLocation('/campaign-command?compose=1&property_ids=1,2')).toMatchObject({ kind: 'properties', propertyIds: ['1', '2'] })
    expect(intakeFromLocation('/campaign-command?campaign=abc')).toBeNull()
  })
  it('resolves dropped registry refs and canonical deep links to ids, explaining what it ignores', () => {
    const refs = [{ type: 'property', id: 'p1' }, { type: 'seller', id: 't1', hint: { property_id: 'p2' } }, { type: 'buyer', id: 'b1', label: 'Acme' }]
    const r = resolveDrop((t) => (t === COMPOSER_OBJECTS_MIME ? JSON.stringify(refs) : ''), [COMPOSER_OBJECTS_MIME])
    expect(r.propertyIds).toEqual(['p1', 'p2'])
    expect(r.ignored).toHaveLength(1)
    const links = resolveDrop((t) => (t === 'text/uri-list' ? 'http://localhost:5173/deal-intelligence?property_id=9\n/campaign-command?campaign=c1' : ''), ['text/uri-list'])
    expect(links.propertyIds).toEqual(['9'])
    expect(links.campaignIds).toEqual(['c1'])
  })
})

describe('command deck + rollback', () => {
  it('offers New campaign, and from-selection only with a session selection', () => {
    expect(composerCommands('new campaign', { selection: null }).map((r) => r.route)).toEqual(['/campaign-command?compose=1'])
    expect(composerCommands('new campaign', { selection: { propertyId: 'p9', address: '1 Main' } })[1].route).toContain('property_ids=p9')
    expect(composerCommands('ne', { selection: null })).toEqual([])
  })
  it('the legacy builder returns only behind the rollback flag', () => {
    expect(isLegacyBuilderForced('', { getItem: () => null })).toBe(false)
    expect(isLegacyBuilderForced('?composer=legacy', { getItem: () => null })).toBe(true)
    expect(isLegacyBuilderForced('', { getItem: () => 'legacy' })).toBe(true)
  })
})

describe('audience funnel (Minneapolis, 2026-10-03 numbers)', () => {
  const mpls = (): ComposerAudience => audience({
    matched: 5411, addressable: 5412, reachable: 4581, sms_eligible: 3525, clean: 3400, eligible_in_audience: 3400,
    exclusions: { suppressed: 212, dnc: 0, wrong_number: 1, no_phone: 830, sms_ineligible: 1056, no_sender_route: 0, pending_prior_touch: 0, active_queue: 0 },
    build: { ok: true, requested_limit: 1000, simulated_limit: 1000, rows_read: 1000, recipients: 851, duplicates_collapsed: 149, built: 851, ready: 552, held: 299, held_by_reason: { entity_contact_requires_review: 258 }, sendable_now: 552, no_sendable_number: 0, sender_markets: [] },
    universe: { count: 5411, location_filters: ['properties.market'], targeting_filters: [] },
  })
  const cohort = (): ComposerCohort => ({
    ok: true, at: '', queue_eligible_in_audience: 3400, rows_read: 3400, capped_by_build_limit: false, build_limit: 100000, recipients: 3104,
    duplicates_collapsed: 296, ready: 2552, held: 552, held_by_reason: { entity_contact_requires_review: 446, ambiguous_phone_ownership: 19, missing_identity_linkage: 87 },
    sendable_now: 2552, no_sendable_number: 0, sender_markets: [], ready_by_zone: { 'America/Chicago': 2552 }, ready_by_market: { 'Minneapolis, MN': 2552 }, timings_ms: { read: 1905, total: 4371 },
    personalization: { first_name: 600, deed_name: 1700, none: 252 }, sendable_after_personalization: 2300,
  })

  it('the sample build is labelled a sample capped by Campaign size — that is the ~640-class number', () => {
    const stages = audienceFunnel(mpls())
    expect(stages.map((s) => s.key)).toEqual(['universe', 'filters', 'reachable', 'sms', 'clean', 'built', 'language', 'personalization', 'routing'])
    expect(stages.find((s) => s.key === 'language')!.count).toBeNull()
    const built = stages.find((s) => s.key === 'built')!
    expect(built.basis).toBe('sample')
    expect(built.count).toBe(552)
    expect(built.note).toMatch(/first 1,000 rows/)
    expect(stages.find((s) => s.key === 'personalization')!.count).toBeNull()
    expect(stages.find((s) => s.key === 'reachable')!.dropped).toBe(830)
  })

  it('the whole cohort carries the render lint: eligible = ready, routable, and the greeting renders', () => {
    const a = withCohort(mpls(), cohort())!
    expect(eligibleOf(a)).toBe(2300)
    const stages = audienceFunnel(a)
    const p = stages.find((s) => s.key === 'personalization')!
    expect(p.count).toBe(2300)
    expect(p.dropped).toBe(252)
    expect(p.reasons[0].label).toMatch(/render lint/)
    expect(p.note).toMatch(/1,700 have no first name/)
    expect(stages.find((s) => s.key === 'built')!.reasons.map((r) => r.count)).toContain(446)
    expect(stages.at(-1)!.count).toBe(2300)
  })

  it('language holds are a funnel stage with a per-language breakdown, and eligible never includes them', () => {
    const c = { ...cohort(), language_holds: { held: 10, by_language: { Thai: 3, Farsi: 6, Pashto: 1 }, held_and_refused: 2 }, sendable_after_personalization: 2292 }
    const a = withCohort(mpls(), c)!
    const stages = audienceFunnel(a)
    const lang = stages.find((s) => s.key === 'language')!
    expect(lang.count).toBe(2542)
    expect(lang.dropped).toBe(10)
    expect(lang.reasons[0].label).toMatch(/Farsi 6 · Thai 3 · Pashto 1/)
    const p = stages.find((s) => s.key === 'personalization')!
    // 252 lint refusals, 2 of them already held for language
    expect(p.count).toBe(2552 - 10 - 250)
    expect(p.dropped).toBe(250)
    expect(eligibleOf(a)).toBe(2292)
    expect(languageBreakdown({ Thai: 3, Farsi: 6 })).toBe('Farsi 6 · Thai 3')
  })

  it('the sample build subtracts language holds from its eligible count', () => {
    const a = mpls()
    a.build = { ...a.build!, language_holds: { held: 9, by_language: { Farsi: 6, Thai: 3 }, held_and_refused: 0 }, sendable_after_language: 543 }
    expect(eligibleOf(a)).toBe(543)
    expect(audienceFunnel(a).find((s) => s.key === 'language')!.count).toBe(543)
  })

  it('a location-only universe shows what the targeting filters removed', () => {
    const a = audience({ ...mpls(), matched: 1200, universe: { count: 5411, location_filters: ['properties.market'], targeting_filters: ['properties.tax_delinquent'] } })
    const f = audienceFunnel(a, () => 'Tax Delinquent').find((s) => s.key === 'filters')!
    expect(f.dropped).toBe(4211)
    expect(f.reasons[0].label).toBe('Tax Delinquent')
  })

  it('freshness states the audience age; stale data and unmeasured coverage are said out loud', () => {
    const now = Date.parse('2026-10-03T21:00:00Z')
    const old = audienceFreshness(audience({ graph_freshness: { latest_generated_at: '2026-08-26T19:45:52Z' } }), now)!
    expect(old.label).toMatch(/Aug 26, 38 days old/)
    expect(old.stale).toBe(true)
    expect(old.coverage).toBeNull()
    const fresh = audienceFreshness(audience({ graph_freshness: { latest_generated_at: '2026-08-26T19:45:52Z' }, graph_coverage: { measured_at: '2026-10-03T09:00:00Z', sample_rows: 3400, latest_built_at: null, oldest_enriched_at: null, latest_enriched_at: '2026-10-03T08:58:00Z', coverage: { seller_first_name: 0.84, phone_type: 0.99 } } }), now)!
    expect(fresh.label).toMatch(/12 hours old/)
    expect(fresh.stale).toBe(false)
    expect(fresh.coverage).toEqual([{ label: 'First name', count: 84 }, { label: 'Phone type', count: 99 }])
  })
})

describe('campaign size is an explicit choice (no silent 1,000, no silent All)', () => {
  it('a new composition has no size; launch readiness blocks until one is chosen', () => {
    const c = emptyComposition()
    expect(c.campaign_size).toBeNull()
    expect(c.total_cap).toBe('')
    expect(campaignSizeCheck(c, 2552)).toMatchObject({ state: 'block', text: expect.stringMatching(/Choose a campaign size/) })
    const waves = zoneWaves([{ value: 'America/Chicago', count: 1 }], { start: '08:00', end: '21:00' }, NOW, 48)
    const r = deriveReadiness({ composition: { ...dallas(), campaign_size: null, total_cap: '' }, audience: audience(), audienceError: null, audienceLoading: false, templates: templates(), fleet: fleet(), coverage: cov([mkt()]), online: true, now: NOW, waves })
    expect(r.checks.find((x) => x.key === 'size')?.state).toBe('block')
    expect(r.state).toBe('blocked')
  })
  it('All eligible sends no cap; a number is stated and its shortfall said out loud', () => {
    expect(compositionPayload({ ...dallas(), campaign_size: 'all', total_cap: '1000' }).total_cap).toBe('')
    expect(compositionPayload({ ...dallas(), campaign_size: 'all' }).campaign_size).toBe('all')
    expect(campaignSizeCheck({ campaign_size: 'all', total_cap: '' }, 2552)).toMatchObject({ state: 'ok', builds: 2552 })
    expect(campaignSizeCheck({ campaign_size: 'custom', total_cap: '' }, 2552).state).toBe('block')
    expect(campaignSizeCheck({ campaign_size: 'custom', total_cap: '1000' }, 2552)).toMatchObject({ state: 'warn', builds: 1000, text: expect.stringMatching(/1,552 left out/) })
    expect(campaignSizeCheck({ campaign_size: 'custom', total_cap: '5000' }, 2552)).toMatchObject({ state: 'ok', builds: 2552 })
    expect(compositionPayload({ ...dallas(), campaign_size: 'custom', total_cap: '400' }).total_cap).toBe('400')
  })
})
