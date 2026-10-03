import { describe, expect, it, vi } from 'vitest'

const calls: Array<{ path: string; method?: string }> = []
vi.mock('../../../../lib/api/backendClient', () => ({
  callBackend: vi.fn(async (path: string, init: { method?: string } = {}) => {
    calls.push({ path, method: init.method })
    if (path.includes('fail')) return { ok: true, data: { ok: false, error: 'coordinates_unavailable', message: 'statement timeout' } }
    return { ok: true, data: { ok: true, eligible: 2, mapped: 1, unmapped: 1, points: { ids: ['1'], lng: [-93.2], lat: [44.9], market: [0] }, markets: [] } }
  }),
}))

import { readCampaignGeography } from './preview-api'

describe('preview read: one read-only GET per spec, the spec untouched', () => {
  it('asks part=geo once with the Composer spec and no write', async () => {
    calls.length = 0
    const spec = { filters: { properties: [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Minneapolis, MN'] }] }, template_use_case: 'ownership_check' }
    const r = await readCampaignGeography(spec)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].method ?? 'GET').toBe('GET')
    const url = new URL(calls[0].path, 'https://lc.local')
    expect(url.searchParams.get('part')).toBe('geo')
    expect(JSON.parse(url.searchParams.get('spec') || '{}')).toEqual(spec)
  })
  it('names a server failure instead of drawing anything', async () => {
    const r = await readCampaignGeography({ filters: { properties: [{ field_key: 'fail' }] }, template_use_case: 'x' })
    expect(r).toEqual({ ok: false, error: 'coordinates_unavailable', message: 'statement timeout' })
  })
})
