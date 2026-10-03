import { describe, expect, it } from 'vitest'
import {
  buildSegments, capacityPlan, checkSchedule, completionEstimate, compositionDiff, compositionPayload, deriveReadiness, eligibleOf, emptyComposition,
  launchSentence, parseCap, withCohort, serializeClauses, snapVolume, universeSegments, zoneWaves, type Composition,
} from './composer-model'
import type { ComposerAudience, ComposerCohort, ComposerFleet, ComposerTemplates, FleetNumber } from './composer-types'
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
const num = (over: Partial<FleetNumber> = {}): FleetNumber => ({ phone: '+1', label: 'DALLAS', market: 'Dallas, TX', state: 'TX', sender_state: 'active', reason: null, eligible: true, cooling_until: null, limit: 800, limit_basis: 'system', sent_today: 100, remaining_today: 700, ...over })
const fleet = (numbers: FleetNumber[]): ComposerFleet => ({ ok: true, at: '', numbers, markets: [], blocklist_readable: true, system: { per_number_cap: 800, processor_mode: 'live', emergency_stop_at: null, outbound_sms_enabled: true, contact_window: { start: '08:00', end: '21:00' }, auto_reply_mode: 'assisted', followup_automation_mode: 'off' } })
const templates = (sendable = 26): ComposerTemplates => ({ ok: true, at: '', governance_readable: true, strategies: [{ use_case: 'ownership_check', stage_code: 'S1', label: 'Ownership check', touch: 'First touch', languages: [], templates: 47, sendable, governed: [] }] })
const dallas = (): Composition => ({ ...emptyComposition(), name: 'Dallas', filters: [{ id: 'f', domain: 'properties', category: 'Location & Market', fieldKey: 'properties.market', label: 'Market', operator: 'is_any_of', value: ['Dallas, TX'] }] })

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
    const r = deriveReadiness({ composition: dallas(), audience: audience(), audienceError: null, audienceLoading: false, templates: templates(), fleet: fleet([num()]), online: true, now: NOW, waves })
    expect(r.checks.find((c) => c.key === 'audience')?.state).toBe('checking')
  })
})

describe('readiness', () => {
  const base = { audienceError: null, audienceLoading: false, online: true, now: NOW, waves: zoneWaves([{ value: 'America/Chicago', count: 1000 }], { start: '08:00', end: '21:00' }, NOW, 48) }
  it('zero eligible disables launch', () => {
    const a = audience({ build: { ...audience().build, ready: 0, sendable_now: 0 } })
    const r = deriveReadiness({ ...base, composition: dallas(), audience: a, templates: templates(), fleet: fleet([num()]) })
    expect(r.state).toBe('blocked')
    expect(r.checks.find((c) => c.key === 'audience')?.text).toBe('Zero eligible prospects')
  })
  it('a ready Dallas composition reads ready', () => {
    const whole = { ...audience(), build: { ...audience().build, whole_cohort: true } }
    const r = deriveReadiness({ ...base, composition: dallas(), audience: whole, templates: templates(), fleet: fleet([num()]) })
    expect(r.blockers).toBe(0)
    expect(['ready', 'warning']).toContain(r.state)
  })
  it('no sender, no template, a lost connection and cap 0 each block', () => {
    expect(deriveReadiness({ ...base, composition: dallas(), audience: audience(), templates: templates(), fleet: fleet([num({ eligible: false, sender_state: 'cooling' })]) }).checks.find((c) => c.key === 'senders')?.state).toBe('block')
    expect(deriveReadiness({ ...base, composition: dallas(), audience: audience(), templates: templates(0), fleet: fleet([num()]) }).checks.find((c) => c.key === 'templates')?.state).toBe('block')
    expect(deriveReadiness({ ...base, online: false, composition: dallas(), audience: audience(), templates: templates(), fleet: fleet([num()]) }).state).toBe('blocked')
    expect(deriveReadiness({ ...base, composition: { ...dallas(), daily_cap: '0' }, audience: audience(), templates: templates(), fleet: fleet([num()]) }).checks.find((c) => c.key === 'capacity')?.text).toMatch(/sends nothing/)
  })
  it('nothing unanswered reads as ready (checking, never a zero)', () => {
    const r = deriveReadiness({ ...base, composition: dallas(), audience: null, audienceLoading: true, templates: null, fleet: null })
    expect(r.state).toBe('checking')
  })
  it('an unresolved recipient zone is a warning (held), never placed on a zone', () => {
    const a = audience({ zones: { scanned: 1000, unresolved: 40 } })
    const r = deriveReadiness({ ...base, composition: dallas(), audience: a, templates: templates(), fleet: fleet([num()]) })
    expect(r.checks.find((c) => c.key === 'windows')?.text).toMatch(/Timezone unavailable for 40/)
    const waves = zoneWaves([{ value: 'unresolved', count: 40 }, { value: 'America/Chicago', count: 960 }], { start: '08:00', end: '21:00' }, NOW, 48)
    expect(waves.map((w) => w.zone)).toEqual(['America/Chicago'])
  })
})

describe('capacity', () => {
  const numbers = [num(), num({ label: 'HOUSTON', market: 'Houston, TX', eligible: false, sender_state: 'blocked', remaining_today: 0 }), num({ label: 'HOUSTON 2', market: 'Houston, TX', eligible: false, sender_state: 'cooling', remaining_today: 0 })]
  it('splits available from unavailable and names the binding limit', () => {
    const p = capacityPlan(numbers, { daily_cap: '750', send_interval_seconds: '45', contact_window_start: '08:00', contact_window_end: '21:00' })
    expect(p.available_per_day).toBe(800)
    expect(p.unavailable_per_day).toBe(1600)
    expect(p.window_per_day).toBe(1040)
    expect(p.effective_per_day).toBe(750)
    expect(p.binding).toBe('daily_cap')
  })
  it('a volume beyond capacity snaps back with the reason', () => {
    const p = capacityPlan(numbers, { daily_cap: '750', send_interval_seconds: '45', contact_window_start: '08:00', contact_window_end: '21:00' })
    const s = snapVolume(1060, p)
    expect(s.snapped).toBe(true)
    expect(s.value).toBe(800)
    expect(s.reason).toBe('+260/day unavailable: 1 blocked, 1 cooling')
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
