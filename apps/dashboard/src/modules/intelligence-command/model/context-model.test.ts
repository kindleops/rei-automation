import { describe, expect, it } from 'vitest'
import { composeAsk } from '../../agent/ask/ask-model'
import { addManual, chipsForContext, contextKeyOf, EMPTY_CHIPS, EMPTY_PAGE, reconcile, removeChip, toMentionChips, visibleChips, type PageContext } from './context-model'

const inbox: PageContext = { ...EMPTY_PAGE, app: 'inbox', appLabel: 'Inbox', instanceId: 'i1', property: { id: '9100001', address: '1418 Larkspur Ct' }, thread: { key: '+15551234471' }, deal: { opportunityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }
const campaign: PageContext = { ...EMPTY_PAGE, app: 'campaign-command', appLabel: 'Campaign Command', instanceId: 'i2', campaign: { id: '11111111-2222-3333-4444-555555555555', name: 'Spring probate' } }
const eg: PageContext = { ...EMPTY_PAGE, app: 'entity-graph', appLabel: 'Entity Graph', instanceId: 'i3', property: { id: '9100002', address: null }, selection: { property_ids: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], count: 12 } }

describe('context chips — derived from ONE page, never leaking', () => {
  it('an Inbox page yields property, seller-thread and deal chips; the phone is never in a label or the request', () => {
    const chips = chipsForContext(inbox)
    expect(chips.map((c) => c.kind)).toEqual(['property', 'thread', 'deal'])
    expect(chips.every((c) => c.contextKey === contextKeyOf(inbox))).toBe(true)
    const all = JSON.stringify(chips)
    expect(all).not.toContain('5551234')
    expect(chips[1].label).toBe('Seller thread ••4471')
    expect(chips[1].sends).toBeNull()
    const req = composeAsk({ text: 'why is this hot?', command: null, chips: toMentionChips(chips) })
    expect(req.context).toEqual({ property_ids: ['9100001'] })
    expect(JSON.stringify(req)).not.toContain('5551234')
    expect(JSON.stringify(req)).not.toContain('aaaaaaaa')
  })

  it('switching pages drops every chip of the previous page and resets removals', () => {
    let st = reconcile(EMPTY_CHIPS, inbox)
    st = removeChip(st, inbox, chipsForContext(inbox)[0])
    expect(visibleChips(st, inbox).map((c) => c.kind)).toEqual(['thread', 'deal'])
    st = reconcile(st, campaign)
    const v = visibleChips(st, campaign)
    expect(v.map((c) => c.kind)).toEqual(['campaign'])
    expect(JSON.stringify(v)).not.toContain('9100001')
    expect(st.removed).toEqual([])
    // and back: the Inbox chips are re-derived fresh (the old removal does not persist)
    st = reconcile(st, inbox)
    expect(visibleChips(st, inbox).map((c) => c.kind)).toEqual(['property', 'thread', 'deal'])
  })

  it('a stale context key never filters (or shows) the current page', () => {
    const st = { contextKey: contextKeyOf(inbox), removed: ['campaign:11111111-2222-3333-4444-555555555555'], manual: [] }
    expect(visibleChips(st, campaign).map((c) => c.kind)).toEqual(['campaign'])
  })

  it('@-mentions survive a page change only while a draft is being written', () => {
    const m = { key: 'market:dal', kind: 'market' as const, id: 'dal', label: 'Dallas', detail: null, property_ids: [], auto: false, contextKey: null, sends: null }
    let st = addManual(reconcile(EMPTY_CHIPS, inbox), m)
    expect(reconcile(st, campaign, true).manual).toHaveLength(1)
    st = reconcile(st, campaign, false)
    expect(st.manual).toHaveLength(0)
  })

  it('an Entity Graph selection sends at most the server cap of property ids', () => {
    const chips = chipsForContext(eg)
    expect(chips).toHaveLength(1)
    expect(chips[0].kind).toBe('eg_filter')
    expect(chips[0].property_ids).toHaveLength(10)
    expect(chips[0].detail).toMatch(/first 10 sent/)
    const req = composeAsk({ text: 'compare', command: null, chips: toMentionChips(chips) })
    expect(req.context.property_ids).toHaveLength(10)
  })

  it('a campaign chip sends the campaign id only', () => {
    const req = composeAsk({ text: 'strongest targets', command: null, chips: toMentionChips(chipsForContext(campaign)) })
    expect(req.context).toEqual({ campaign_id: '11111111-2222-3333-4444-555555555555' })
  })
})
