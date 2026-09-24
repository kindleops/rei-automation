import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CampaignSummary } from '../campaigns.types'
import { CampaignIndexCard } from './CampaignIndexCard'
import { indexMenuActions } from './CampaignIndexMenu'
import { getMemory, remember, resetIndexMemoryForTest } from './CampaignCommandMobile'
import {
  PRIMARY_FILTERS,
  cardKindOf,
  displayName,
  matchesIndexFilter,
  needsAttention,
  orderForIndex,
  plural,
  rollupCampaigns,
  setupSteps,
  tabCounts,
} from './campaign-index-model'

/**
 * The mobile Campaign index — what each card is allowed to claim.
 *
 * Fixtures are the shapes production held on 2026-09-24 (56 campaigns: active 1
 * in test mode, paused 3, built 4 — one quarantined 984-for-186 — draft 11,
 * archived 37, nothing scheduled or completed).
 */

// Vitest compiles JSX with the classic runtime here; the components expect
// React in scope, as the app's automatic runtime provides it.
;(globalThis as { React?: typeof React }).React = React

const base = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: 'c1',
  campaign_name: 'Campaign',
  status: 'draft',
  total_targets: 0,
  ready_targets: 0,
  scheduled_targets: 0,
  queued_targets: 0,
  sent_count: 0,
  delivered_count: 0,
  failed_count: 0,
  reply_count: 0,
  positive_reply_count: 0,
  negative_reply_count: 0,
  opt_out_count: 0,
  delivery_rate: 0,
  reply_rate: 0,
  positive_rate: 0,
  opt_out_rate: 0,
  failure_rate: 0,
  next_send_at: null,
  last_send_at: null,
  send_interval_seconds: 0,
  send_window_start: null,
  send_window_end: null,
  auto_send_enabled: false,
  health_score: 100,
  health_status: 'healthy',
  ...over,
} as CampaignSummary)

const BOOK = {
  live: base({ id: 'live', campaign_name: 'Houston Absentee', status: 'active', total_targets: 802, ready_targets: 400, sent_count: 350, delivered_count: 347, delivery_rate: 99.1, last_send_at: new Date(Date.now() - 12 * 60_000).toISOString() }),
  test: base({ id: 'test', campaign_name: 'Tax Delinquent - Poor and Unsound', status: 'active', operator_state: 'test_mode', sent_count: 9, delivered_count: 9 }),
  paused: base({ id: 'paused', campaign_name: 'Miami - Test Campaign', status: 'paused', operator_state: 'test_mode', total_targets: 802, ready_targets: 789, sent_count: 354, delivered_count: 351, delivery_rate: 99.2 }),
  scheduled: base({ id: 'sched', campaign_name: 'Dallas Probate', status: 'scheduled', total_targets: 854, ready_targets: 504, next_send_at: new Date(Date.now() + 26 * 3600_000).toISOString() }),
  ready: base({ id: 'ready', campaign_name: 'Test', status: 'built' as never, total_targets: 854, ready_targets: 504, has_target_definition: true }),
  hold: base({ id: 'hold', campaign_name: 'Entity Graph · 186 properties', status: 'built' as never, quarantined: true, quarantine_reason: 'target_integrity_violation', total_targets: 984, explicit_target_count: 186, target_mode: 'explicit' }),
  draft: base({ id: 'draft', campaign_name: 'DALLAS - Test', status: 'draft', has_target_definition: true }),
  completed: base({ id: 'done', campaign_name: 'Spring Probate', status: 'completed', total_targets: 802, sent_count: 802, delivered_count: 781, last_send_at: '2026-09-18T15:00:00Z' }),
  archived: base({ id: 'arch', campaign_name: 'Proof Build Targets 1780187485881', status: 'archived' }),
}
const ALL = Object.values(BOOK)

const render = (c: CampaignSummary) =>
  renderToStaticMarkup(
    <CampaignIndexCard campaign={c} onOpen={() => {}} onMenu={() => {}} onContinueSetup={() => {}} />,
  )
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('A · the state tabs partition the book', () => {
  it('puts every non-archived campaign in exactly one primary tab', () => {
    for (const c of ALL.filter((x) => x.status !== 'archived')) {
      const tabs = PRIMARY_FILTERS.filter(({ key }) => matchesIndexFilter(c, key)).map((f) => f.key)
      expect(tabs, c.campaign_name).toHaveLength(1)
    }
  })

  it('files each state under the tab an operator would look in', () => {
    expect(matchesIndexFilter(BOOK.live, 'live')).toBe(true)
    expect(matchesIndexFilter(BOOK.paused, 'live')).toBe(true)
    expect(matchesIndexFilter(BOOK.scheduled, 'scheduled')).toBe(true)
    expect(matchesIndexFilter(BOOK.scheduled, 'live')).toBe(false)
    expect(matchesIndexFilter(BOOK.ready, 'draft')).toBe(true)
    expect(matchesIndexFilter(BOOK.hold, 'draft')).toBe(true)
    expect(matchesIndexFilter(BOOK.completed, 'completed')).toBe(true)
    expect(matchesIndexFilter(BOOK.archived, 'completed')).toBe(false)
  })
})

describe('B · a filter never silently returns every campaign', () => {
  it('Active excludes drafts, schedules and finished campaigns', () => {
    const active = ALL.filter((c) => matchesIndexFilter(c, 'live')).map((c) => c.id)
    expect(active.sort()).toEqual(['live', 'paused', 'test'])
    const counts = tabCounts(ALL)
    for (const { key } of PRIMARY_FILTERS) expect(counts[key], key).toBeLessThan(ALL.length)
  })
})

describe('C · the state picks the card anatomy', () => {
  it('maps each lifecycle to its own card kind', () => {
    expect(cardKindOf(BOOK.live)).toBe('live')
    expect(cardKindOf(BOOK.test)).toBe('test')
    expect(cardKindOf(BOOK.paused)).toBe('paused')
    expect(cardKindOf(BOOK.scheduled)).toBe('scheduled')
    expect(cardKindOf(BOOK.ready)).toBe('ready')
    expect(cardKindOf(BOOK.hold)).toBe('hold')
    expect(cardKindOf(BOOK.draft)).toBe('draft')
    expect(cardKindOf(BOOK.completed)).toBe('completed')
    expect(cardKindOf(BOOK.archived)).toBe('archived')
    expect(cardKindOf(base({ status: 'failed' as never }))).toBe('attention')
    expect(cardKindOf(base({ status: 'active', total_targets: 20, ready_targets: 0, sent_count: 20 }))).toBe('attention')
  })

  it('renders the kind it computed', () => {
    for (const c of ALL) expect(render(c)).toContain(`data-kind="${cardKindOf(c)}"`)
  })
})

describe('D · a live card is about progress and outcomes, not setup', () => {
  it('shows progress against its audience and delivery, never setup or drafts', () => {
    const t = text(render(BOOK.live))
    expect(t).toContain('350')
    expect(t).toContain('of 802 sent')
    expect(t).toContain('99% delivered')
    expect(render(BOOK.live)).toContain('role="progressbar"')
    expect(t).not.toMatch(/Setup|Continue|Schedule/)
  })
})

describe('E · a draft never shows delivery metrics', () => {
  it('shows how far setup has come and the next step', () => {
    const t = text(render(BOOK.draft))
    expect(t).toContain('1 of 3')
    expect(t).toContain('Reach next')
    expect(t).toContain('Continue')
    expect(t).not.toMatch(/deliver|sent|repl/i)
    expect(render(BOOK.draft)).not.toContain('role="progressbar"')
  })

  it('reads setup from the row', () => {
    expect(setupSteps(base()).filter((s) => s.done)).toHaveLength(0)
    expect(setupSteps(BOOK.draft).filter((s) => s.done).map((s) => s.key)).toEqual(['build'])
    expect(setupSteps(BOOK.ready).filter((s) => s.done).map((s) => s.key)).toEqual(['build', 'reach'])
  })
})

describe('F · a scheduled card shows when and who, not zeros', () => {
  it('leads with the start and never prints delivery stats', () => {
    const t = text(render(BOOK.scheduled))
    expect(t).toContain('Starts')
    expect(t).toContain('tomorrow')
    expect(t).toContain('504 ready')
    expect(t).not.toMatch(/delivered|0 sent|repl/i)
  })
})

describe('G · test mode is its own state', () => {
  it('says seller delivery is off and keeps its real history', () => {
    const t = text(render(BOOK.test))
    expect(t).toMatch(/Test/)
    expect(t).toContain('Seller delivery off')
    expect(t).toContain('9 sent')
    expect(render(BOOK.test)).toContain('is-test')
  })

  it('keeps paused as the headline for a paused test campaign', () => {
    const t = text(render(BOOK.paused))
    expect(t).toContain('Paused')
    expect(t).toContain('Test mode')
    expect(t).toContain('of 802 sent')
  })
})

describe('H · attention names the real issue and the next step', () => {
  it('explains a quarantine with its own numbers', () => {
    const t = text(render(BOOK.hold))
    expect(t).toContain('On hold')
    expect(t).toContain('reaches beyond the properties that were selected')
    expect(t).toContain('984 targets for 186 selected properties')
    expect(t).toContain('Review targeting')
    expect(t).not.toContain('Setup needs attention')
  })

  it('counts the same campaigns the cards flag, and raises them first', () => {
    expect(ALL.filter(needsAttention).map((c) => c.id)).toEqual(['hold'])
    expect(rollupCampaigns(ALL).attention).toBe(1)
    expect(orderForIndex(ALL)[0].id).toBe('hold')
  })
})

describe('I · a finished campaign is a record, with nothing live on it', () => {
  it('shows outcomes and no progress rail or action', () => {
    const html = render(BOOK.completed)
    const t = text(html)
    expect(t).toContain('Completed')
    expect(t).toContain('802 sent')
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toMatch(/cxc__pill|cxc__action/)
    expect(indexMenuActions(BOOK.completed)).not.toContain('pause')
    expect(indexMenuActions(BOOK.completed)).not.toContain('resume')
  })

  it('offers only actions the state allows', () => {
    expect(indexMenuActions(BOOK.live)).toContain('pause')
    expect(indexMenuActions(BOOK.live)).not.toContain('resume')
    expect(indexMenuActions(BOOK.paused)).toContain('resume')
    expect(indexMenuActions(BOOK.draft)).toContain('setup')
    expect(indexMenuActions(BOOK.draft)).not.toContain('pause')
    expect(indexMenuActions(BOOK.archived)).toContain('restore')
    expect(indexMenuActions(BOOK.archived)).not.toContain('archive')
  })
})

describe('J · copy reads as English', () => {
  it('splits a generated name and pluralises its count', () => {
    expect(displayName(base({ campaign_name: 'Entity Graph · 1 properties' }))).toEqual({ title: 'Entity Graph', subtitle: '1 property selected' })
    expect(displayName(base({ campaign_name: 'Entity Graph · 186 properties' }))).toEqual({ title: 'Entity Graph', subtitle: '186 properties selected' })
    expect(displayName(base({ campaign_name: 'Miami - Test Campaign' }))).toEqual({ title: 'Miami - Test Campaign', subtitle: null })
    expect(displayName(base({ campaign_name: '' })).title).toBe('Untitled campaign')
  })

  it('never prints "1 sellers" or "1 properties"', () => {
    expect(plural(1, 'seller')).toBe('1 seller')
    expect(plural(2, 'seller')).toBe('2 sellers')
    const oneSeller = text(render(base({ status: 'built' as never, total_targets: 1, ready_targets: 1 })))
    expect(oneSeller).toContain('1 seller ready')
    expect(oneSeller).not.toMatch(/1 sellers|1 properties/)
  })
})

describe('K · the tab and search survive a trip into a campaign', () => {
  it('keeps them outside the component', () => {
    resetIndexMemoryForTest()
    remember({ filter: 'draft', search: 'dallas', scrollTop: 640 })
    expect(getMemory()).toMatchObject({ filter: 'draft', search: 'dallas', scrollTop: 640 })
    resetIndexMemoryForTest()
    // A fresh session starts on Active, not on "All".
    try { sessionStorage.clear() } catch { /* node: no storage */ }
    expect(getMemory().filter).toBe('live')
  })
})

describe('L · a refresh does not reorder what did not change', () => {
  it('keeps the API order within a state', () => {
    const drafts = [base({ id: 'd1' }), base({ id: 'd2' }), base({ id: 'd3' })]
    expect(orderForIndex(drafts).map((c) => c.id)).toEqual(['d1', 'd2', 'd3'])
    expect(orderForIndex([...drafts]).map((c) => c.id)).toEqual(orderForIndex(drafts).map((c) => c.id))
  })
})
