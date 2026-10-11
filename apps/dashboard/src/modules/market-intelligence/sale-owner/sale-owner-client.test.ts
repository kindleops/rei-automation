import { describe, expect, it, vi } from 'vitest'
import { createSaleOwnerClient, describeBuyerOfRecord, propSaleKey, type SaleOwnerRow } from './sale-owner-client'

const linkedCompany: SaleOwnerRow = {
  buyer_of_record: { label: 'Company (name not on record) · current owner of record', short: 'Company (name not on record)', basis: 'current_owner_of_record', kind: 'company', name: null, linked: true, reason: 'linked' },
  owner_link: { linked: true, reason: 'linked', explanation: 'This is the property’s most recent sale and no later transfer is recorded, so today’s owner of record is its buyer.', owner_observed_on: '2026-09-20', later_transfer_on: null },
  inferred: { tier: 'likely', label: 'Likely inferred investor', investor: true, evidence: ['entity_owner'], mailing_stack: 1 },
}
const named: SaleOwnerRow = { ...linkedCompany, buyer_of_record: { label: 'ABC Holdings LLC · current owner of record', short: 'ABC Holdings LLC', basis: 'current_owner_of_record', kind: 'company', name: 'ABC Holdings LLC', linked: true, reason: 'linked' } }
const resold: SaleOwnerRow = { buyer_of_record: { label: 'Buyer not on record', basis: 'not_on_record', kind: null, name: null, linked: false, reason: 'later_transfer' },
  owner_link: { linked: false, reason: 'later_transfer', explanation: 'The property sold again later; today’s owner is not this sale’s buyer.', owner_observed_on: null, later_transfer_on: '2026-03-02' }, inferred: null }

describe('buyer of record: exact copy', () => {
  it('current owner of record: the label verbatim, never as the deed buyer', () => {
    const d = describeBuyerOfRecord(named)
    expect(d.text).toBe('ABC Holdings LLC · current owner of record')
    expect(`${d.lead} · ${d.suffix}`).toBe(d.text)
    expect(d.tooltip).toContain('Owner observed 2026-09-20')
    expect(describeBuyerOfRecord(linkedCompany).text).toBe('Company (name not on record) · current owner of record')
    expect(describeBuyerOfRecord(linkedCompany).inferred?.text).toBe('Inferred investor · Likely')
  })
  it('older sales that later resold stay "Buyer not on record"; nothing names an individual', () => {
    const d = describeBuyerOfRecord(resold)
    expect(d.text).toBe('Buyer not on record')
    expect(d.tooltip).toContain('sold again later')
    expect(d.inferred).toBeNull()
    expect(describeBuyerOfRecord(null).text).toBe('Buyer not on record')
  })
  it('property keys', () => {
    expect(propSaleKey('12345', '2026-04-03T00:00:00Z')).toBe('12345@2026-04-03')
    expect(propSaleKey(null, '2026-04-03')).toBeNull()
    expect(propSaleKey('12345', null)).toBeNull()
  })
})

describe('the shared client: one batched, cached request per view', () => {
  it('batches every key asked in the same tick into ONE request and caches it', async () => {
    const fetcher = vi.fn(async (ids: string[], props: string[]) => [...ids, ...props].map((k) => (k === 't:2' ? resold : named)))
    const c = createSaleOwnerClient(fetcher)
    c.request(['t:1', 't:2'])
    c.request(['t:1', '77@2026-01-02'])   // another row/component in the same tick
    c.request(['bad id', null, undefined])
    await new Promise((r) => setTimeout(r, 5))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(['t:1', 't:2'], ['77@2026-01-02'])
    expect(c.peek('t:2')?.buyer_of_record?.basis).toBe('not_on_record')
    expect(c.peek('77@2026-01-02')?.buyer_of_record?.name).toBe('ABC Holdings LLC')
    c.request(['t:1', 't:2', '77@2026-01-02'])
    await new Promise((r) => setTimeout(r, 5))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('chunks above 100 keys; a failed batch is not re-asked for a minute', async () => {
    let now = 0
    const fetcher = vi.fn(async () => null)
    const c = createSaleOwnerClient(fetcher, () => now)
    c.request(Array.from({ length: 150 }, (_, i) => `t:${i}`))
    await new Promise((r) => setTimeout(r, 5))
    expect(fetcher).toHaveBeenCalledTimes(2)
    c.request(['t:1'])
    await new Promise((r) => setTimeout(r, 5))
    expect(fetcher).toHaveBeenCalledTimes(2)
    now = 61_000
    c.request(['t:1'])
    await new Promise((r) => setTimeout(r, 5))
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('primed rows (recent_sales already carries them) make no request; peek never fetches', async () => {
    const fetcher = vi.fn(async () => [])
    const c = createSaleOwnerClient(fetcher)
    c.prime([['t:9', named]])
    expect(c.peek('t:9')?.buyer_of_record?.label).toBe('ABC Holdings LLC · current owner of record')
    expect(c.peek('t:10')).toBeNull()
    c.request(['t:9'])
    await new Promise((r) => setTimeout(r, 5))
    expect(fetcher).not.toHaveBeenCalled()
  })
})
