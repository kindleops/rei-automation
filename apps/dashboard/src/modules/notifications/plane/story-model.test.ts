import { describe, expect, it, vi } from 'vitest'

vi.mock('../../desktop/objects', () => {
  const mk = (type: string) => (a: Record<string, unknown>) => ({ type, id: String(type === "workflow" ? a.workflowKey : a.threadKey ?? a.campaignId ?? a.closingId ?? a.opportunityId ?? a.propertyId), label: a.label ?? null, hint: { ...a } })
  return { sellerObject: mk('seller'), campaignObject: mk('campaign'), closingObject: mk('closing'), dealObject: mk('deal'), propertyObject: mk('property'), workflowObject: mk('workflow') }
})

import { applyLocal, CACHE_INCREMENTAL_MS, dampSwipe, inverseAction, settleSwipe, storySource, SWIPE_COMMIT, SWIPE_REVEAL_PX, SWIPE_TRAY_PX, timeGroup, CACHE_MAX_STORIES, countLocal, defaultLens, degradedText, mergeStories, nextStoryIndex, parseCache, relTime, runObject, serializeCache, storyObject, storyTone, visibleOrder, type Story } from './story-model'

const story = (id: string, over: Partial<Story> = {}): Story => ({
  id, subject: { type: 'seller', id: '+1612', thread_key: '+1612', property_id: 'p1', label: 'Gale' }, subject_key: 'seller:+1612|p1', kind: 'message',
  primary_event: { id: `me:${id}`, type: 'seller.replied', at: '2026-10-02T15:00:00.000Z' }, title: 'Gale replied', summary: '$185K asking price', reason: null,
  priority: 'important', peak_priority: 'important', lens: 'now', state: { code: 'open', label: null, tone: null }, requires_operator: false, resolved: false,
  resolved_by: null, resolved_at: null, read: false, read_at: null, persistence: 'notification_rows', aged: false, created_at: '2026-10-02T15:00:00.000Z',
  updated_at: '2026-10-02T15:00:00.000Z', last_trigger_at: '2026-10-02T15:00:00.000Z', counts: { messages: 1, events: 1 }, chain: [], source_event_ids: [`me:${id}`],
  notification_ids: [], deep_link: '/inbox?thread=%2B1612', run_link: null, object: { type: 'seller', id: '+1612', label: 'Gale', hint: { thread_key: '+1612', property_id: 'p1' } },
  replay: { type: 'seller', id: '+1612', label: 'Gale' }, missions: [{ kind: 'work_seller', label: 'Work this seller' }], sound: null, ...over,
})

describe('notification plane model', () => {
  it('merges by stable id: arrivals vs morphs, and drops stories the server aged out', () => {
    const a = story('a')
    const { map } = mergeStories(new Map(), [a])
    const morphed = { ...a, updated_at: '2026-10-02T15:05:00.000Z', state: { code: 'response_sent', label: 'Response sent ✓', tone: 'green' as const }, resolved: true, lens: 'resolved' as const }
    const r = mergeStories(map, [morphed, story('b')], ['a', 'b'])
    expect(r.arrived.map((s) => s.id)).toEqual(['b'])
    expect(r.changed.map((s) => s.id)).toEqual(['a'])
    expect(r.map.get('a')?.state.label).toBe('Response sent ✓')
    expect(mergeStories(r.map, [], ['b']).map.has('a')).toBe(false)
  })

  it('"N new" without scroll jerk: while reading, arrivals are held and existing stories keep their place', () => {
    const s1 = story('1', { updated_at: '2026-10-02T15:01:00Z' })
    const s2 = story('2', { updated_at: '2026-10-02T15:02:00Z' })
    const frozen = visibleOrder([s1, s2], 'now', null, new Set()).map((s) => s.id)
    expect(frozen).toEqual(['2', '1'])
    const s1morph = { ...s1, updated_at: '2026-10-02T15:09:00Z' }
    const s3 = story('3', { updated_at: '2026-10-02T15:10:00Z' })
    const reading = visibleOrder([s1morph, s2, s3], 'now', frozen, new Set(['3']))
    expect(reading.map((s) => s.id)).toEqual(['2', '1'])
    const top = visibleOrder([s1morph, s2, s3], 'now', null, new Set())
    expect(top.map((s) => s.id)).toEqual(['3', '1', '2'])
  })

  it('local marks persist only stories the server cannot, and only until the next trigger', () => {
    const s = story('a', { persistence: 'none', requires_operator: true, lens: 'needs_you', priority: 'action' })
    const read = applyLocal(s, { a: { read_at: '2026-10-02T15:01:00Z' } })
    expect(read.read).toBe(true)
    expect(read.resolved).toBe(false)
    const done = applyLocal(s, { a: { resolved_at: '2026-10-02T15:01:00Z' } })
    expect(done.lens).toBe('resolved')
    expect(done.requires_operator).toBe(false)
    const again = applyLocal({ ...s, last_trigger_at: '2026-10-02T16:00:00Z' }, { a: { resolved_at: '2026-10-02T15:01:00Z' } })
    expect(again.resolved).toBe(false)
    expect(applyLocal({ ...s, persistence: 'table' }, { a: { read_at: '2026-10-02T15:01:00Z' } }).read).toBe(false)
  })

  it('badge counts meaningful unresolved stories', () => {
    const c = countLocal([
      story('needs', { lens: 'needs_you', requires_operator: true, priority: 'action' }),
      story('unread'),
      story('read', { read: true }),
      story('info', { priority: 'info' }),
      story('done', { lens: 'resolved', resolved: true, priority: 'info' }),
      story('sys', { lens: 'system', subject: { type: 'system', id: 'senders', label: 'Sender health' }, priority: 'important' }),
      story('crit', { lens: 'system', subject: { type: 'system', id: 'platform', label: 'Platform health' }, priority: 'critical' }),
    ])
    expect(c.badge).toBe(3)
    expect(c.needs_you).toBe(1)
    expect(c.system_active).toBe(2)
  })

  it('maps a story to the universal object registry (canonical ids only)', () => {
    expect(storyObject(story('a'))).toMatchObject({ type: 'seller', id: '+1612' })
    expect(storyObject(story('c', { object: { type: 'campaign', id: 'c1', label: 'Dallas' } }))).toMatchObject({ type: 'campaign', id: 'c1' })
    expect(storyObject(story('s', { object: null }))).toBeNull()
    const held = story('h', { run_link: '/workflow-studio?wf=seller_inbound&run=r1' })
    expect(runObject(held)).toMatchObject({ type: 'workflow', id: 'seller_inbound', hint: { runId: 'r1' } })
  })

  it('semantic tone: red only for real problems; resolved is green; a normal reply is cyan', () => {
    expect(storyTone(story('a'))).toBe('cyan')
    expect(storyTone(story('b', { requires_operator: true, priority: 'action' }))).toBe('gold')
    expect(storyTone(story('c', { priority: 'critical' }))).toBe('red')
    expect(storyTone(story('d', { resolved: true, resolved_by: 'machine' }))).toBe('green')
    expect(storyTone(story('e', { resolved: true, resolved_by: 'superseded' }))).toBe('neutral')
  })

  it('default lens, relative time and degraded copy', () => {
    expect(defaultLens(null)).toBe('needs_you')
    expect(defaultLens({ badge: 1, needs_you: 0, now: 3, now_unread: 1, resolved: 0, system: 0, system_active: 0 })).toBe('now')
    const now = Date.parse('2026-10-02T15:00:00Z')
    expect(relTime('2026-10-02T14:58:00Z', now)).toBe('2m')
    expect(relTime('2026-10-02T12:00:00Z', now)).toBe('3h')
    expect(degradedText(['workflow'])).toContain('automation runs')
    expect(degradedText([])).toBeNull()
  })

  it('session cache: newest stories round-trip; a fresh cache reconciles incrementally, an old one with page one; junk is ignored', () => {
    const now = Date.parse('2026-10-02T16:00:00.000Z')
    const list = Array.from({ length: CACHE_MAX_STORIES + 5 }, (_, i) => story(`s${i}`, { updated_at: new Date(now - i * 60e3).toISOString() }))
    const raw = serializeCache(list, { generatedAt: '2026-10-02T15:59:00.000Z', horizon: null, counts: countLocal(list), nextCursor: 'c1' }, now)
    const back = parseCache(raw, now + 1000)
    expect(back?.stories.length).toBe(CACHE_MAX_STORIES)
    expect(back?.stories[0].id).toBe('s0')
    expect(back?.incremental).toBe(true)
    expect(parseCache(raw, now + CACHE_INCREMENTAL_MS + 1)?.incremental).toBe(false)
    expect(parseCache(raw, now + 9 * 864e5)).toBeNull()
    expect(parseCache('{nope', now)).toBeNull()
    expect(parseCache(JSON.stringify({ v: 2, stories: [] }), now)).toBeNull()
  })

  it('arrow keys: ↓ from nothing lands on the first story, clamps at the ends, Home/End jump; other keys are not ours', () => {
    expect(nextStoryIndex(-1, 'ArrowDown', 3)).toBe(0)
    expect(nextStoryIndex(0, 'ArrowDown', 3)).toBe(1)
    expect(nextStoryIndex(2, 'ArrowDown', 3)).toBe(2)
    expect(nextStoryIndex(0, 'ArrowUp', 3)).toBe(0)
    expect(nextStoryIndex(1, 'End', 3)).toBe(2)
    expect(nextStoryIndex(2, 'Home', 3)).toBe(0)
    expect(nextStoryIndex(1, 'Enter', 3)).toBeNull()
    expect(nextStoryIndex(-1, 'ArrowDown', 0)).toBeNull()
  })

  it('source identity: every story wears its app (Rail icon), never a colour guess', () => {
    expect(storySource(story('a')).app).toBe('inbox')
    expect(storySource(story('a')).icon).toBe('inbox')
    expect(storySource(story('b', { primary_event: { id: 'ne:1', type: 'inbox_follow_up_due', at: '2026-10-02T15:00:00.000Z' } })).app).toBe('calendar')
    expect(storySource(story('c', { primary_event: { id: 'lse:1', type: 'stage.advanced', at: '2026-10-02T15:00:00.000Z' } })).app).toBe('pipeline')
    const sub = (type: string, id = 'x') => ({ subject: { type, id, label: null } }) as Partial<Story>
    expect(storySource(story('d', sub('campaign'))).app).toBe('campaign')
    expect(storySource(story('e', sub('workflow'))).app).toBe('workflow')
    expect(storySource(story('f', sub('closing'))).app).toBe('closing')
    expect(storySource(story('g', sub('system', 'senders'))).app).toBe('queue')
    expect(storySource(story('h', sub('system', 'email'))).app).toBe('email')
    expect(storySource(story('i', sub('system', 'platform'))).app).toBe('system')
    expect(storySource(story('j', { ...sub('system', 'templates'), signal: { rule_keys: ['r'], signal_ids: [], severity: 'warning' } })).app).toBe('signal')
    expect(storySource(story('k', sub('inbox', 'new_replies'))).app).toBe('inbox')
  })

  it('time sections: last hour, earlier today, yesterday, this week, older', () => {
    const now = new Date('2026-10-03T15:00:00').getTime()
    expect(timeGroup(new Date(now - 20 * 60e3).toISOString(), now)).toBe('hour')
    expect(timeGroup(new Date('2026-10-03T08:00:00').toISOString(), now)).toBe('today')
    expect(timeGroup(new Date('2026-10-02T23:00:00').toISOString(), now)).toBe('yesterday')
    expect(timeGroup(new Date('2026-09-29T12:00:00').toISOString(), now)).toBe('week')
    expect(timeGroup(new Date('2026-09-20T12:00:00').toISOString(), now)).toBe('older')
    expect(timeGroup('nope', now)).toBe('older')
  })

  it('swipe: a short move springs back, past reveal it opens the tray, past the commit line it runs the primary', () => {
    const w = 440
    expect(settleSwipe(-20, w)).toEqual({ open: null, commit: null })
    expect(settleSwipe(-(SWIPE_REVEAL_PX + 1), w)).toEqual({ open: 'end', commit: null })
    expect(settleSwipe(SWIPE_REVEAL_PX + 1, w)).toEqual({ open: 'start', commit: null })
    expect(settleSwipe(-w * SWIPE_COMMIT, w)).toEqual({ open: null, commit: 'end' })
    expect(settleSwipe(w * SWIPE_COMMIT, w)).toEqual({ open: null, commit: 'start' })
    expect(settleSwipe(-200, w, { canEnd: false })).toEqual({ open: null, commit: null })
    // rubber band: free up to the tray, then damped and bounded
    expect(dampSwipe(-100, w)).toBe(-100)
    expect(Math.abs(dampSwipe(-1000, w))).toBeLessThanOrEqual(w * 0.7)
    expect(Math.abs(dampSwipe(-(SWIPE_TRAY_PX + 100), w))).toBeLessThan(SWIPE_TRAY_PX + 100)
  })

  it('undo is the inverse state action (no deletes)', () => {
    expect(inverseAction('resolve')).toBe('reopen')
    expect(inverseAction('reopen')).toBe('resolve')
    expect(inverseAction('read')).toBe('unread')
    expect(inverseAction('unread')).toBe('read')
  })
})
