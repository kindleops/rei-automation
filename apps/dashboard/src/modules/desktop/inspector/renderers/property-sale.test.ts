import { beforeEach, describe, expect, it, vi } from 'vitest'
// Recorded from the local API (production read, 2026-10-02): comp 3722 Fremont Ave N,
// property 273330226 — a recorded sale with no `properties` row.
import saleRecord from './__fixtures__/property-sale-record.json'
import propertySubject from './__fixtures__/property-subject.json'

type Res = { ok: boolean; status: number; error: string; data: unknown }
const routes = new Map<string, Res>()
const calls: string[] = []
vi.mock('../../../../lib/api/backendClient', () => ({
  callBackend: vi.fn(async (path: string) => {
    calls.push(path)
    return routes.get(path) ?? { ok: false, status: 404, error: 'not_found', data: { ok: false, error: 'not_found' } }
  }),
}))

const { propertyInspector } = await import('./property')
const { shapeSaleRecord } = await import('./property-sale')
const { InspectorReadError } = await import('../inspector-read')

const SUBJECT = '/api/cockpit/properties/273330226/subject'
const SALE = '/api/cockpit/properties/273330226/sale-record'
const REF = { type: 'property' as const, id: '273330226', label: '3722 Fremont Ave N, Minneapolis, Mn 55412' }
const notFound: Res = { ok: false, status: 404, error: 'property_not_found', data: { ok: false, error: 'property_not_found' } }
const load = () => propertyInspector.load(REF, new AbortController().signal)

beforeEach(() => { routes.clear(); calls.length = 0 })

describe('comp-derived property that is not a canonical property', () => {
  it('shapes the recorded sale, labelled as a sale record, with no property surfaces', () => {
    const m = shapeSaleRecord(saleRecord.data as never, REF)
    expect(m.title).toBe('3722 Fremont Ave N, Minneapolis, MN 55412')
    expect(m.status).toEqual({ label: 'Recorded sale · not a tracked property', tone: 'neutral' })
    expect(m.facts.find((f) => f.label === 'Layout')?.value).toBe('3 bd · 1 ba · 1,473 sq ft')
    expect(m.value?.find((f) => f.label === 'Last sale')?.value).toBe('$110,000 · Apr 3, 2026')
    expect(m.activity?.[0]).toEqual({ at: '2026-04-03', text: 'Sold $110,000 · Warranty Deed · Public record' })
    // never a fabricated property: no owner / valuation / equity, nothing to open that would 404
    for (const label of ['Owner', 'Estimated value', 'Equity', 'Parcel']) {
      expect([...m.facts, ...(m.value ?? [])].some((f) => f.label === label), label).toBe(false)
    }
    expect(m.open).toEqual([])
    expect(m.relations).toBeUndefined()
    expect(m.mission).toBeNull()
  })

  it('Inspect: subject 404 -> the sale record', async () => {
    routes.set(SUBJECT, notFound)
    routes.set(SALE, { ok: true, status: 200, error: '', data: saleRecord })
    const m = await load()
    expect(calls).toEqual([SUBJECT, SALE])
    expect(m.status?.label).toBe('Recorded sale · not a tracked property')
  })

  it('a canonical property still resolves to the property and never reads sales', async () => {
    routes.set(SUBJECT, { ok: true, status: 200, error: '', data: propertySubject })
    const m = await load()
    expect(calls).toEqual([SUBJECT])
    expect(m.status).toBeUndefined()
    expect(m.open?.[0]?.label).toBe('Deal Intelligence')
  })

  it('no property and no recorded sale: honest "not on record"', async () => {
    routes.set(SUBJECT, notFound)
    await expect(load()).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('a failed subject read (not a not-found) is not papered over with sales', async () => {
    routes.set(SUBJECT, { ok: false, status: 500, error: 'subject_load_failed', data: null })
    const err = await load().catch((e) => e)
    expect(err).toBeInstanceOf(InspectorReadError)
    expect(err.kind).toBe('unavailable')
    expect(calls).toEqual([SUBJECT])
  })
})
