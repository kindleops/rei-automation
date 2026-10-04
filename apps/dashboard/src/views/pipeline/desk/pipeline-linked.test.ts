import { describe, expect, it, vi } from 'vitest'
import { pickOpportunity, resolvePipelineItem } from './pipeline-linked'
import type { DeskCard } from './pipeline-desk-api'
import type { PropertyLocator } from '../../../domain/locator/property-locator'

vi.mock('../../../lib/api/backendClient', () => ({ callBackend: vi.fn() }))

const loc = (p: Partial<PropertyLocator>): PropertyLocator => ({ propertyId: null, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: null, setAt: 0, ...p })
const card = (id: string, propertyId: string | null, threadKey: string | null = null) => ({ id, propertyId, threadKey } as unknown as DeskCard)
const signal = () => new AbortController().signal

describe('pipeline linked resolver', () => {
  it('a locator that names the deal opens it without a read', async () => {
    const fetchOpportunities = vi.fn()
    const r = await resolvePipelineItem(loc({ propertyId: 'P', opportunityId: 'O1' }), { rows: [card('O1', 'P')], fetchOpportunities }, signal())
    expect(r).toMatchObject({ kind: 'open', id: 'O1' })
    expect(fetchOpportunities).not.toHaveBeenCalled()
  })

  it('a loaded row for the property opens with its seed', async () => {
    const fetchOpportunities = vi.fn()
    const r = await resolvePipelineItem(loc({ propertyId: 'P2' }), { rows: [card('O1', 'P1'), card('O2', 'P2')], fetchOpportunities }, signal())
    expect(r).toEqual({ kind: 'open', id: 'O2', seed: expect.objectContaining({ id: 'O2' }) })
    expect(fetchOpportunities).not.toHaveBeenCalled()
  })

  it('otherwise one read by property; a live deal outranks a closed one', async () => {
    const fetchOpportunities = vi.fn().mockResolvedValue([{ id: 'OLD', status: 'closed' }, { id: 'LIVE', status: 'active' }])
    const r = await resolvePipelineItem(loc({ propertyId: 'P9' }), { rows: [], fetchOpportunities }, signal())
    expect(fetchOpportunities).toHaveBeenCalledWith({ property_id: 'P9' }, expect.anything())
    expect(r).toMatchObject({ kind: 'open', id: 'LIVE' })
  })

  it('a thread-only locator reads by thread', async () => {
    const fetchOpportunities = vi.fn().mockResolvedValue([])
    await resolvePipelineItem(loc({ threadKey: 'T1' }), { rows: null, fetchOpportunities }, signal())
    expect(fetchOpportunities).toHaveBeenCalledWith({ thread_key: 'T1' }, expect.anything())
  })

  it('no deal for the property is an honest none (nothing is created)', async () => {
    const fetchOpportunities = vi.fn().mockResolvedValue([])
    const r = await resolvePipelineItem(loc({ propertyId: 'P0' }), { rows: [], fetchOpportunities }, signal())
    expect(r).toEqual({ kind: 'none' })
  })

  it('an owner-only locator is not resolvable here', async () => {
    const r = await resolvePipelineItem(loc({ masterOwnerId: 'M' }), { rows: [], fetchOpportunities: vi.fn() }, signal())
    expect(r).toEqual({ kind: 'unresolvable' })
  })

  it('pickOpportunity falls back to the only (closed) deal', () => {
    expect(pickOpportunity([{ id: 'X', status: 'dead' }])?.id).toBe('X')
    expect(pickOpportunity([])).toBeNull()
  })
})
