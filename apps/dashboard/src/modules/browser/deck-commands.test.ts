import { describe, expect, it } from 'vitest'
import { browserDeckCommands } from './deck-commands'
import { intentPath, parseIntent } from './intent'
import { pickItem, type LaunchItem } from './launch-plane'

const sel = { propertyId: 'p-1', address: '3635 Emerson Ave N' }
const pathOf = (r: { route?: string; payload?: Record<string, unknown> }) => r.route ?? ((r.payload?.__workspace as { path: string } | undefined)?.path ?? '')
const intentOf = (r: { route?: string; payload?: Record<string, unknown> }) => parseIntent(pathOf(r).split('?')[1] ?? '')

describe('Command Deck — Browser commands', () => {
  it('Open Browser / Open Browser beside', () => {
    const r = browserDeckCommands('open browser', { selection: null })
    expect(r.map((x) => x.title)).toEqual(['Open Browser', 'Open Browser beside'])
    expect(r[0].route).toBe('/browser')
    expect((r[1].payload?.__workspace as { kind: string }).kind).toBe('beside')
  })

  it('Research current property needs a selection', () => {
    expect(browserDeckCommands('research current property', { selection: null })).toEqual([])
    const r = browserDeckCommands('research current property', { selection: sel })
    expect(r[0].title).toBe('Research 3635 Emerson Ave N')
    expect(intentOf(r[0])).toMatchObject({ do: 'research', id: 'p-1' })
  })

  it.each([
    ['open assessor beside', 'ASSESSOR'],
    ['assessor current property', 'ASSESSOR'],
    ['open county records', 'COUNTY_PROPERTY_SEARCH'],
    ['search web for current property', 'WEB_SEARCH'],
  ])('%s → %s for the selection', (q, type) => {
    const r = browserDeckCommands(q, { selection: sel })
    const hit = r.find((x) => intentOf(x)?.do === 'dest')
    expect(hit, q).toBeTruthy()
    expect(intentOf(hit!)).toMatchObject({ do: 'dest', type, id: 'p-1' })
  })

  it('free text: "zillow 3635 emerson" → a Zillow find intent with the text', () => {
    const r = browserDeckCommands('zillow 3635 emerson', { selection: null })
    expect(r).toHaveLength(1)
    expect(intentOf(r[0])).toMatchObject({ do: 'find', type: 'ZILLOW', q: '3635 emerson' })
  })

  it('free text web search keeps the operator words', () => {
    const r = browserDeckCommands('search kindle enterprises llc', { selection: null })
    expect(intentOf(r[0])).toMatchObject({ do: 'search', q: 'kindle enterprises llc' })
  })

  it('an open Browser is focused by route instead of being moved', () => {
    const r = browserDeckCommands('open assessor beside', { selection: sel, browserOpen: true })
    expect(r[0].route?.startsWith('/browser?')).toBe(true)
    expect(r[0].payload).toBeUndefined()
  })

  it('stays silent for unrelated words', () => {
    expect(browserDeckCommands('reply to wendy', { selection: sel })).toEqual([])
    expect(browserDeckCommands('in', { selection: sel })).toEqual([])
  })
})

describe('intents', () => {
  it('round-trip and refuse incomplete or unknown kinds', () => {
    const p = intentPath({ do: 'dest', type: 'GIS', kind: 'property', id: 'p 1/2', label: 'A & B', role: 'comp', nonce: 'n1' })
    expect(parseIntent(p.split('?')[1])).toEqual({ do: 'dest', type: 'GIS', kind: 'property', id: 'p 1/2', label: 'A & B', role: 'comp', nonce: 'n1' })
    expect(parseIntent('do=dest&type=NOPE&kind=property&id=x&n=1')).toBeNull()
    expect(parseIntent('do=research&kind=property&id=x')).toBeNull()
    expect(parseIntent('do=search&n=1')).toBeNull()
  })
})

describe('launch plane — pick a destination honestly', () => {
  const item = (over: Partial<LaunchItem>): LaunchItem => ({ id: 'x', label: 'X', group: 'official', type: 'ASSESSOR', authority: 'Official', confidence: 'VERIFIED', embed: 'UNKNOWN', url: 'https://x.gov', host: 'x.gov', reason: null, copy: null, destinationId: 'x', ...over })

  it('a missing parcel id is said, not fabricated', () => {
    const r = pickItem([item({ url: null, reason: 'Parcel ID required' })], 'ASSESSOR')
    expect(r).toEqual({ item: null, reason: 'Parcel ID required' })
  })

  it('county records falls back through county search → assessor → recorder', () => {
    const r = pickItem([item({ id: 'rec', type: 'RECORDER' }), item({ id: 'ass', type: 'ASSESSOR' })], 'COUNTY_PROPERTY_SEARCH')
    expect(r.item?.id).toBe('ass')
  })

  it('no destination of that kind → null (the Browser says what exists instead)', () => {
    expect(pickItem([item({ type: 'GIS' })], 'RECORDER')).toEqual({ item: null, reason: null })
  })
})
