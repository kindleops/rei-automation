import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ fn: string; path: string; where?: unknown }> = []
let running = true
let openResult: string = 'opened'

vi.mock('../../app/router', () => ({ pushRoutePath: (path: string) => { calls.push({ fn: 'push', path }) } }))
vi.mock('../desktop/workspace/workspace-store', () => ({
  isWorkspaceRunning: () => running,
  openApp: (path: string, where: unknown) => { calls.push({ fn: 'openApp', path, where }); return openResult },
  announceWorkspace: () => {},
}))

const { researchMenuEntries, researchTargetOf, researchProperty } = await import('./research-launch')
const { parseIntent } = await import('./intent')

const property = { type: 'property', id: 'p-1', label: '3635 Emerson Ave N', hint: { property_id: 'p-1', source: 'deal-intelligence' } }
const comp = { type: 'property', id: 'c-9', label: '3601 Emerson Ave N', hint: { property_id: 'c-9', source: 'comp-intelligence' } }
const company = { type: 'company', id: 'org-1', label: 'Kindle Enterprises LLC', hint: { organization_id: 'org-1' } }
const seller = { type: 'seller', id: 'tk-1', label: 'Wendy', hint: { thread_key: 'tk-1', property_id: 'p-1', property_label: '3635 Emerson Ave N' } }
const campaign = { type: 'campaign', id: 'cmp-1', label: 'MN', hint: {} }

type Sub = { kind: 'sub'; items: Array<{ id: string; label?: string; kind?: string; onSelect?: () => void }> }
const sub = (entries: unknown[]) => entries[0] as Sub
const ids = (entries: unknown[]) => sub(entries).items.filter((i) => i.kind !== 'separator').map((i) => i.id)

beforeEach(() => { calls.length = 0; running = true; openResult = 'opened' })

describe('object registry — Research actions', () => {
  it('a property gets Research + assessor / county records / GIS / recorder / web (never Open, Inspect or Show on Map)', () => {
    const e = researchMenuEntries(property)
    expect(e).toHaveLength(1)
    expect((e[0] as { label: string }).label).toBe('Research')
    expect(ids(e)).toEqual(['research:open', 'research:assessor', 'research:county', 'research:gis', 'research:recorder', 'research:web'])
    expect(ids(e).some((id) => /open$|inspect|map$/.test(id) && id !== 'research:open')).toBe(false)
  })

  it('a company gets state corporate records and web search', () => {
    expect(ids(researchMenuEntries(company))).toEqual(['research:company', 'research:corp', 'research:web'])
  })

  it('a seller researches its property; a campaign has nothing to research', () => {
    expect(researchTargetOf(seller)).toEqual({ kind: 'property', id: 'p-1', label: '3635 Emerson Ave N', role: 'subject' })
    expect(researchMenuEntries(campaign)).toEqual([])
  })

  it('a comp is researched AS a comp (its own context group; the subject tabs stay)', () => {
    expect(researchTargetOf(comp)?.role).toBe('comp')
    expect(sub(researchMenuEntries(comp)).items[0].label).toBe('Research this comp')
  })

  it('Open assessor opens the Browser BESIDE with a destination intent naming the canonical id only', () => {
    sub(researchMenuEntries(property)).items.find((i) => i.id === 'research:assessor')!.onSelect!()
    expect(calls).toHaveLength(1)
    expect(calls[0].fn).toBe('openApp')
    expect(calls[0].where).toBe('beside')
    const it = parseIntent(calls[0].path.split('?')[1])
    expect(it).toMatchObject({ do: 'dest', type: 'ASSESSOR', kind: 'property', id: 'p-1', label: '3635 Emerson Ave N' })
    expect(calls[0].path).not.toMatch(/phone|owner|score|note/i)
  })

  it('a full workspace (refused) falls back to opening in place; outside the workspace it navigates', () => {
    openResult = 'refused'
    expect(researchProperty({ kind: 'property', id: 'p-1', label: null })).toBe('navigated')
    expect(calls.map((c) => c.fn)).toEqual(['openApp', 'push'])
    calls.length = 0
    running = false
    expect(researchProperty({ kind: 'property', id: 'p-1', label: null }, 'GIS')).toBe('navigated')
    expect(calls.map((c) => c.fn)).toEqual(['push'])
  })

  it('an open Browser is focused and handed the intent (never duplicated)', () => {
    openResult = 'focused'
    expect(researchProperty({ kind: 'property', id: 'p-1', label: null })).toBe('focused')
  })
})
