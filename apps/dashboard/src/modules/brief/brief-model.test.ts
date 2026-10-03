import { describe, expect, it } from 'vitest'
import { buildBrief, headline, isNewSince, type BriefFacts } from './brief-model'
import { briefDeckCommands } from './brief-commands'
import type { SignalCenterModel, SignalRow } from '../notifications/signals/signals-model'
import type { Story } from '../notifications/plane/story-model'
import type { PlatformEvent } from '../desktop/feed/feed-model'

const NOW = Date.parse('2026-10-03T18:00:00Z')
const ready = <T,>(data: T) => ({ status: 'ready' as const, data })
const signal = (over: Partial<SignalRow> = {}): SignalRow => ({
  id: 'sig-1', rule_key: 'campaign.opt_out_rate', severity: 'warning', subject_type: 'campaign', subject_id: 'camp-9', title: 'Opt-out rate rising on Dallas wave 3', body: null, evidence: {},
  source_event_id: null, deep_link: '/notifications?signal=sig-1', status: 'new', fired_at: '2026-10-03T16:00:00Z', acknowledged_at: null, resolved_at: null, resolve_reason: null, notification_event_id: null, ...over,
})
const center = (signals: SignalRow[]): SignalCenterModel => ({
  ok: true, generated_at: '', gate: { env_enabled: true, control_enabled: true, live: true }, tables_ready: true, missing_tables: [], rules: [], signals,
  counts: { open: signals.length, new: signals.length, acknowledged: 0, fired_24h: signals.length, armed_rules: 4 }, checkpoints: {}, watches: { items: [], count: 0, supported_types: [], error: null }, legacy: [],
})
const story = (over: Partial<Story> = {}): Story => ({
  id: 'st-1', subject: { type: 'seller', id: 'tk-1', thread_key: 'tk-1', label: 'Wendy Stuhr' }, subject_key: 'seller:tk-1', kind: 'message', primary_event: { id: 'e1', type: null, at: '2026-10-03T17:00:00Z' },
  title: 'Wendy Stuhr asked for a callback', summary: null, reason: 'Needs a call', priority: 'action', peak_priority: 'action', lens: 'needs_you', state: { code: 'x', label: null, tone: null },
  requires_operator: true, resolved: false, resolved_by: null, resolved_at: null, read: false, read_at: null, persistence: 'table', aged: false, created_at: '', updated_at: '2026-10-03T17:00:00Z', last_trigger_at: '',
  counts: { messages: 1, events: 1 }, chain: [], source_event_ids: [], notification_ids: [], deep_link: '/inbox?thread=tk-1', run_link: null,
  object: { type: 'seller', id: 'tk-1', label: 'Wendy Stuhr' }, replay: null, missions: [], sound: null, ...over,
})
const move = (over: Partial<PlatformEvent> = {}): PlatformEvent => ({
  event_id: 'ev-1', occurred_at: '2026-10-03T15:00:00Z', source_system: 'pipeline', event_type: 'stage.advanced', severity: 'info', actor: { kind: 'automation' },
  entity_refs: [{ type: 'property', id: 'p-1', label: '3831 Sheridan Ave N' }], summary: 'Advanced to S4 · Offer', deep_link: '/pipeline?opp=o-1',
  provenance: { table: 'acquisition_opportunity_history', row_id: 'h-1', adapter: 'pipeline' }, property_id: 'p-1', opportunity_id: 'o-1', ...over,
})
const base = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  now: NOW,
  signals: ready(center([signal()])),
  stories: ready([story()]),
  movement: ready([move(), move({ event_id: 'ev-2', event_type: 'stage.regressed', summary: 'Back to S2' })]),
  campaigns: ready({ live: 2, paused: 1, readyTargets: 0, attention: [{ id: 'c-1', name: 'Dallas wave 3', market: 'Dallas', status: 'active', ready: 0, total: 0, sent: 0, replies: 0, issue: 'Sender pool exhausted' }], highlighted: [], degraded: false }),
  inbox: ready({ newReplies: 4, priority: 1, needsAttention: 0, threads: [{ id: 't1', threadKey: 'tk-2', propertyId: 'p-2', prospectId: null, masterOwnerId: null, seller: 'Ann Lee', address: '12 Oak St', market: null, preview: '', at: '2026-10-03T10:00:00Z', unread: true, hot: false, urgent: false }] }),
  closings: ready({ underContract: 1, closingsThisWeek: 0, titleBlocked: 0, actionRequired: 1, next: null }),
  goals: ready({ goals: [], progress: {}, catalogue: [] }),
  ...over,
})

describe('intelligence brief', () => {
  it('every line cites an object or an app path, and the source it came from', () => {
    const b = buildBrief(base())
    expect(b.lines.length).toBeGreaterThan(5)
    for (const l of b.lines) {
      expect(l.cite.ref || l.cite.path).toBeTruthy()
      expect(l.cite.source).toBeTruthy()
    }
    const sig = b.lines.find((l) => l.id === 'signal:sig-1')!
    expect(sig.cite.ref).toMatchObject({ type: 'campaign', id: 'camp-9' })
    expect(b.lines.find((l) => l.id === 'story:st-1')!.cite.ref).toMatchObject({ type: 'seller', id: 'tk-1' })
    expect(b.lines.find((l) => l.id === 'move:ev-1')!.cite.ref).toMatchObject({ type: 'deal', id: 'o-1' })
    expect(b.lines.find((l) => l.id === 'campaign:c-1')!.cite.ref).toMatchObject({ type: 'campaign', id: 'c-1' })
  })
  it('is deterministic and ranked: critical / closings / stories before backlog, campaigns, movement', () => {
    const a = buildBrief(base()).lines.map((l) => l.id)
    expect(buildBrief(base()).lines.map((l) => l.id)).toEqual(a)
    expect(a.indexOf('closings:action')).toBeLessThan(a.indexOf('inbox:backlog'))
    expect(a.indexOf('stories:count')).toBeLessThan(a.indexOf('inbox:backlog'))
    expect(a.indexOf('inbox:backlog')).toBeLessThan(a.indexOf('pipeline:24h'))
    expect(buildBrief(base()).lines.find((l) => l.id === 'pipeline:24h')!.text).toBe('Pipeline in the last 24 hours: 1 stage advance, 1 regression.')
  })
  it('a source that did not load contributes no line and is named — never a zero', () => {
    const b = buildBrief(base({ inbox: { status: 'unavailable', reason: 'Timed out' }, closings: { status: 'loading' } }))
    expect(b.lines.some((l) => l.section === 'inbox' || l.section === 'closings')).toBe(false)
    expect(b.unavailable).toEqual([{ section: 'inbox', reason: 'Timed out' }])
    expect(b.loading).toEqual(['closings'])
  })
  it('a story folded from a signal already shown is not repeated', () => {
    const b = buildBrief(base({ stories: ready([story({ signal: { rule_keys: ['x'], signal_ids: ['sig-1'], severity: 'warning' } })]) }))
    expect(b.lines.some((l) => l.section === 'needs_you')).toBe(false)
    expect(b.quiet).toContain('needs_you')
  })
  it('quiet sources are stated; no open signals is a calm fact with its rule count', () => {
    const b = buildBrief(base({ signals: ready(center([])), stories: ready([]) }))
    expect(b.lines.find((l) => l.id === 'signals:clear')!.detail).toBe('4 rules armed · 0 firings in 24h')
    expect(b.quiet).toContain('needs_you')
  })
  it('goals behind pace are lines citing the Analytics question; on-pace goals are summarised', () => {
    const goal = { goal_id: 'g1', metric_id: 'sellers_reached', label: null, market: null, market_label: null, period_kind: 'month' as const, comparator: 'at_least' as const, target_value: 600, timezone: 'America/Chicago', status: 'active' as const, revision: 1, updated_at: null }
    const p = { goal_id: 'g1', metric_id: 'sellers_reached', unit: 'count' as const, period: { kind: 'month' as const, start: '2026-10-01T05:00:00.000Z', end: '2026-11-01T05:00:00.000Z', elapsed: 0.1, days_left: 28 }, target: 600, comparator: 'at_least' as const, status: 'ok' as const, reason: null, current: 20, n: 20, min_sample: null, additive: true, pace: 58, projection: 200, projection_basis: '', share: 0.03, verdict: 'behind' as const, cumulative: null }
    const b = buildBrief(base({ goals: ready({ goals: [goal], progress: { g1: p }, catalogue: [] }) }))
    const l = b.lines.find((x) => x.id === 'goal:g1')!
    expect(l.text).toBe('Sellers reached: 20 of 600 this month — behind pace.')
    expect(l.detail).toContain('run-rate 200 (modeled)')
    expect(l.cite.path).toMatch(/^\/analytics\?lab=/)
  })
  it('headline counts what is in the brief; "new" compares evidence time to the last opening', () => {
    const b = buildBrief(base())
    expect(headline(b)).toMatch(/items? for your attention\.$/)
    expect(headline(buildBrief(base({ signals: { status: 'loading' }, stories: { status: 'loading' }, movement: { status: 'loading' }, campaigns: { status: 'loading' }, inbox: { status: 'loading' }, closings: { status: 'loading' }, goals: { status: 'loading' } })))).toBe('Reading the machine…')
    const line = b.lines.find((x) => x.id === 'signal:sig-1')!
    expect(isNewSince(line, Date.parse('2026-10-03T12:00:00Z'))).toBe(true)
    expect(isNewSince(line, Date.parse('2026-10-03T17:00:00Z'))).toBe(false)
    expect(isNewSince(line, null)).toBe(false)
  })
  it('the deck answers "brief me" with a workspace command (no navigation)', () => {
    expect(briefDeckCommands('brief me')[0].payload).toEqual({ __workspace: { kind: 'brief' } })
    expect(briefDeckCommands('what did i miss')).toHaveLength(1)
    expect(briefDeckCommands('campaign')).toEqual([])
  })
})
