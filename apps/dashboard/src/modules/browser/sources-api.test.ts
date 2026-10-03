import { beforeEach, describe, expect, it } from 'vitest'
import { createSourcesApi, validateSource } from './sources-api'

const mem = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = (globalThis as unknown as { window?: unknown }).window ?? {}
Object.assign((globalThis as unknown as { window: Record<string, unknown> }).window, {
  localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) } },
  location: { origin: 'https://ops.leadcommand.ai' },
})

type Call = { path: string; init?: { method?: string; body?: string } }
function fakeCall(answer: (c: Call) => unknown) {
  const calls: Call[] = []
  const fn = (async (path: string, init?: Call['init']) => { calls.push({ path, init }); return answer({ path, init }) }) as never
  return { fn, calls }
}

const input = { objectType: 'property' as const, objectId: 'p-1', url: 'https://www.hennepin.us/x', pageTitle: 'Assessor', destinationType: 'ASSESSOR' as const }

beforeEach(() => mem.clear())

describe('Save Source client', () => {
  it('validates on the way out', () => {
    expect(validateSource({ ...input, url: 'javascript:alert(1)' }).ok).toBe(false)
    expect(validateSource({ ...input, objectId: '' }).ok).toBe(false)
    expect(validateSource(input).ok).toBe(true)
  })

  it('posts the pointer only (no facts) and reports a server save', async () => {
    const f = fakeCall(() => ({ ok: true, status: 201, data: { ok: true, source: { research_source_id: 'u1', object_type: 'property', object_id: 'p-1', url: input.url, page_title: 'Assessor', destination_type: 'ASSESSOR', captured_at: '2026-10-02T00:00:00Z' } } }))
    const r = await createSourcesApi(f.fn).save(input)
    expect(r.ok && r.source.where).toBe('server')
    const body = JSON.parse(f.calls[0].init!.body!)
    expect(Object.keys(body.source).sort()).toEqual(['destination_type', 'object_id', 'object_type', 'page_title', 'url'])
    expect(f.calls[0].init!.method).toBe('POST')
  })

  it('keeps the source on this device while the store is not enabled (503)', async () => {
    const f = fakeCall(() => ({ ok: false, status: 503, error: 'x', message: 'x', upstream: { ok: false, error: 'research_store_unavailable' } }))
    const api = createSourcesApi(f.fn, () => new Date('2026-10-02T12:00:00Z'))
    const r = await api.save(input)
    expect(r.ok && r.source.where).toBe('device')
    const listed = await api.list('property', 'p-1')
    expect(listed.map((x) => [x.url, x.where])).toEqual([[input.url, 'device']])
  })

  it('a refusal is said, not hidden behind a local save', async () => {
    const f = fakeCall(() => ({ ok: false, status: 401, error: 'x', message: 'x', upstream: { ok: false, error: 'unauthorized' } }))
    const r = await createSourcesApi(f.fn).save(input)
    expect(r).toMatchObject({ ok: false, reason: 'unauthorized' })
  })
})
