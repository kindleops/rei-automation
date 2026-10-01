import { describe, expect, it } from 'vitest'
import { appendPage, buildQuery, DEFAULT_FILTERS, groupByDay, inspectorRefs, mergeTail, replayFromEvent, replaySubjectOf, sourceNotes, tailSince, toneOf, type PlatformEvent } from './feed-model'
import { machineCommands, replaySubjects } from '../deck/deck-model'

const ev = (id: string, at: string, o: Partial<PlatformEvent> = {}): PlatformEvent => ({
  event_id: id, occurred_at: at, source_system: 'inbox', event_type: 'seller.replied', severity: 'info', actor: { kind: 'seller' },
  entity_refs: [{ type: 'seller', id: 't1', label: 'Jane' }], summary: 'Jane replied', deep_link: '/inbox?thread=t1',
  provenance: { table: 'message_events', row_id: id, adapter: 'messages' }, thread_key: 't1', ...o,
})
const NOW = Date.parse('2026-10-01T18:00:00Z')

describe('machine feed model', () => {
  it('builds the envelope query from filters (window → since, app → sources, kind → types)', () => {
    const q = new URLSearchParams(buildQuery({ ...DEFAULT_FILTERS, app: 'queue', kind: 'messages', severity: 'warning', window: '1h', market: 'Dallas' }, { now: NOW }))
    expect(q.get('since')).toBe('2026-10-01T17:00:00.000Z')
    expect(q.get('sources')).toBe('queue,email')
    expect(q.get('types')).toContain('message.failed')
    expect(q.get('severity')).toBe('warning,critical')
    expect(q.get('market')).toBe('Dallas')
    expect(q.get('tail')).toBeNull()
    const t = new URLSearchParams(buildQuery(DEFAULT_FILTERS, { now: NOW, tailSince: '2026-10-01T17:58:00.000Z' }))
    expect(t.get('tail')).toBe('1')
    expect(t.get('since')).toBe('2026-10-01T17:58:00.000Z')
    const s = new URLSearchParams(buildQuery({ ...DEFAULT_FILTERS, subject: { type: 'seller', id: 't9' } }, { now: NOW }))
    expect([s.get('subject_type'), s.get('subject_id')]).toEqual(['seller', 't9'])
  })

  it('tail merge: new rows are reported once, a known row (growing batch) updates in place, order kept', () => {
    const cur = [ev('b', '2026-10-01T17:50:00.000000Z'), ev('a', '2026-10-01T17:40:00.000000Z')]
    const grown = ev('b', '2026-10-01T17:50:00.000000Z', { summary: 'updated' })
    const m = mergeTail(cur, [ev('c', '2026-10-01T17:55:00.000000Z'), grown])
    expect(m.added).toEqual(['c'])
    expect(m.events.map((e) => e.event_id)).toEqual(['c', 'b', 'a'])
    expect(m.events[1].summary).toBe('updated')
    expect(mergeTail(m.events, [ev('c', '2026-10-01T17:55:00.000000Z')]).added).toEqual([])
  })

  it('older pages append without overlap; tail asks from just before the newest row', () => {
    expect(appendPage([ev('a', '2026-10-01T17:00:00Z')], [ev('a', '2026-10-01T17:00:00Z'), ev('z', '2026-10-01T16:00:00Z')]).map((e) => e.event_id)).toEqual(['a', 'z'])
    expect(tailSince([ev('a', '2026-10-01T17:58:00.000Z')], NOW)).toBe('2026-10-01T17:56:00.000Z')
    expect(tailSince([], NOW)).toBe('2026-10-01T17:58:00.000Z')
  })

  it('groups by operator day and tones by severity first (red only for failures)', () => {
    const g = groupByDay([ev('a', '2026-10-01T17:00:00Z'), ev('b', '2026-09-30T12:00:00Z'), ev('c', '2026-09-20T12:00:00Z')], NOW)
    expect(g.map((x) => x.day).slice(0, 2)).toEqual(['Today', 'Yesterday'])
    expect(toneOf({ severity: 'warning', event_type: 'message.failed' })).toBe('crit')
    expect(toneOf({ severity: 'attention', event_type: 'workflow.held' })).toBe('attn')
    expect(toneOf({ severity: 'info', event_type: 'workflow.completed' })).toBe('flow')
    expect(toneOf({ severity: 'info', event_type: 'campaign.batch_sent' })).toBe('exec')
  })

  it('subject chips become inspector refs with the identifier the owning endpoint reads', () => {
    const e = ev('a', '2026-10-01T17:00:00Z', { property_id: 'p1', entity_refs: [{ type: 'seller', id: 't1', label: 'Jane' }, { type: 'property', id: 'p1' }, { type: 'market', id: 'x' }] })
    const refs = inspectorRefs(e)
    expect(refs.map((r) => r.type)).toEqual(['seller', 'property'])
    expect(refs[0].hint).toEqual({ thread_key: 't1', property_id: 'p1' })
  })

  it('replay is offered only for subjects the envelope resolves', () => {
    expect(replaySubjectOf({ type: 'seller', id: 'x', hint: { thread_key: 't1' } })).toEqual({ type: 'seller', id: 't1', label: null })
    expect(replaySubjectOf({ type: 'workflow', id: 'seller_inbound:r1' })?.type).toBe('workflow')
    expect(replaySubjectOf({ type: 'workflow', id: 'just-an-id' })).toBeNull()
    expect(replaySubjectOf({ type: 'buyer', id: 'b1' })).toBeNull()
    expect(replayFromEvent(ev('a', '2026-10-01T17:00:00Z', { entity_refs: [{ type: 'campaign', id: 'c1' }] }))).toEqual({ type: 'campaign', id: 'c1', label: null })
  })

  it('source notes separate unreadable ledgers from quiet ones', () => {
    const n = sourceNotes({ degraded: ['lead_state', 'workflow:wf_runs'], sources: { messages: { ok: true, freshness_at: null, systems: [], table: 'm', read: true }, closing: { ok: true, freshness_at: null, systems: [], table: 'c', read: false } } })
    expect(n.degraded).toEqual(['Seller state', 'Automation runs'])
    expect(n.quiet).toEqual(['Messages'])
  })
})

describe('deck commands for machine activity and replay', () => {
  const subject = { label: '12 Oak St', propertyId: 'p1', threadKey: 't1', prospectId: null, masterOwnerId: null, opportunityId: null, campaignId: null, closingId: null, address: '12 Oak St' }
  it('"machine activity" opens the feed; "replay" offers the focused subject', () => {
    expect(machineCommands('show machine activity', { subject: null }).map((r) => r.id)).toEqual(['ws:machine-feed'])
    expect(machineCommands('machine activity', { subject: null }).length).toBe(1)
    const r = machineCommands('replay', { subject })
    expect(r.map((x) => (x.payload as { __workspace: { kind: string } }).__workspace.kind)).toEqual(['replay'])
    expect(machineCommands('replay campaign', { subject })).toEqual([])
    expect(machineCommands('replay', { subject: null })).toEqual([])
    expect(replaySubjects({ ...subject, threadKey: null }).map((s) => s.type)).toEqual(['property'])
  })
})
