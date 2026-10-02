import { describe, expect, it } from 'vitest'
import type { ShownTransient } from '../rail/rail-model'
import { deckLine, missionCommands, missionSubject, placeholderFor, workspaceCommands } from './deck-model'

const t = (over: Partial<ShownTransient>): ShownTransient => ({
  key: 'k', app: '/queue', transient: 'processing', display: null, tone: 'exec', text: 'Dispatching', count: 1, durationMs: 1000, ...over,
})

describe('the deck line', () => {
  it('rests when nothing is moving', () => {
    expect(deckLine({})).toBeNull()
  })
  it('names the single highest-priority event, in words', () => {
    const line = deckLine({
      '/queue': t({ transient: 'processing', count: 25 }),
      '/inbox': t({ key: 'a', app: '/inbox', transient: 'attention', tone: 'attn' }),
    })!
    expect(line.text).toBe('Needs you · Inbox')
    expect(line.tone).toBe('attn')
  })
  it('a failure outranks everything', () => {
    const line = deckLine({ '/inbox': t({ app: '/inbox', transient: 'typing' }), '/queue': t({ key: 'f', transient: 'failure', tone: 'crit' }) })!
    expect(line.glyph).toBe('cross')
  })
  it('says how many are sending and keeps the canonical stage move', () => {
    expect(deckLine({ '/queue': t({ count: 25 }) })!.text).toBe('Sending 25')
    expect(deckLine({ '/pipeline': t({ app: '/pipeline', transient: 'stage', display: 'S2→S3' }) })!.text).toBe('S2 → S3')
  })
  it('workflow traces stay in the rail only', () => {
    expect(deckLine({ '/workflow-studio': t({ app: '/workflow-studio', transient: 'trace' }) })).toBeNull()
  })
})

describe('search speaks the focused app', () => {
  it('has an app-first placeholder and a safe default', () => {
    expect(placeholderFor('inbox')).toMatch(/replies/)
    expect(placeholderFor('map')).toMatch(/address/)
    expect(placeholderFor(null)).toMatch(/sellers/)
  })
})

describe('workspace commands are deterministic', () => {
  const ctx = { saved: [], multi: true, hasFocus: true }
  it('"map beside" opens Map beside the focused pane', () => {
    const [r] = workspaceCommands('map beside', ctx)
    expect(r.title).toBe('Open Map beside')
    expect((r.payload as { __workspace: { kind: string; path: string } }).__workspace).toMatchObject({ kind: 'beside', path: '/map' })
  })
  it('"campaign ops workspace" offers the template', () => {
    const results = workspaceCommands('campaign ops workspace', ctx)
    expect(results.some((r) => r.title === 'Campaign Ops workspace')).toBe(true)
  })
  it('does not invent commands for ordinary searches', () => {
    expect(workspaceCommands('wendy stuhr', ctx)).toEqual([])
    expect(workspaceCommands('ma', ctx)).toEqual([])
  })
  it('pane commands only exist when there are panes', () => {
    expect(workspaceCommands('close pane', { ...ctx, multi: false })).toEqual([])
    expect(workspaceCommands('close pane', ctx)).toHaveLength(1)
  })
})

describe('mission commands', () => {
  const loc = { propertyId: 'P1', threadKey: 'T1', prospectId: null, masterOwnerId: null, opportunityId: null, address: '3025 Sunbeam Ave' }

  it('the subject joins only identifiers the focused app actually reads', () => {
    expect(missionSubject({ locator: null, focusedPath: '/campaign-command?campaign=C1', focusedTitle: 'Probate MN' })).toMatchObject({ campaignId: 'C1', label: 'Probate MN' })
    expect(missionSubject({ locator: null, focusedPath: '/queue?campaign=C1', focusedTitle: null })).toBeNull()
    expect(missionSubject({ locator: loc, focusedPath: '/inbox', focusedTitle: null })).toMatchObject({ propertyId: 'P1', threadKey: 'T1', label: '3025 Sunbeam Ave' })
    expect(missionSubject({ locator: null, focusedPath: '/closing-desk?case=K1', focusedTitle: '3025 Sunbeam' })).toMatchObject({ closingId: 'K1' })
    // Campaign Command's published name wins for its own campaign; never another campaign's name
    expect(missionSubject({ locator: null, focusedPath: '/campaign-command?campaign=C1', focusedTitle: null, campaignSubject: { campaignId: 'C1', name: 'Map area · Dallas, TX' } })?.label).toBe('Map area · Dallas, TX')
    expect(missionSubject({ locator: null, focusedPath: '/campaign-command?campaign=C1', focusedTitle: null, campaignSubject: { campaignId: 'C2', name: 'Other' } })?.label).toBe('This subject')
  })

  it('offers the missions a subject supports, by verb or all at once', () => {
    const subject = missionSubject({ locator: loc, focusedPath: '/inbox', focusedTitle: null })
    expect(missionCommands('work this seller', { subject, active: null }).map((r) => r.id)).toEqual(['ws:mission-work_seller'])
    expect(missionCommands('start mission', { subject, active: null }).map((r) => r.id)).toEqual(['ws:mission-work_seller', 'ws:mission-move_deal'])
    expect(missionCommands('run campaign', { subject, active: null })).toEqual([])
    expect(missionCommands('end mission', { subject: null, active: { title: 'Work seller' } }).map((r) => r.id)).toEqual(['ws:exit-mission'])
    expect(missionCommands('end mission', { subject: null, active: null })).toEqual([])
  })
})
