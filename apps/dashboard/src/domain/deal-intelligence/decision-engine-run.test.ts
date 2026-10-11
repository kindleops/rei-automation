import { describe, expect, it, vi } from 'vitest'
import { ENGINE_RUN_PATH, engineErrorText, engineOutcome, engineRunUrl, parseEngineChunk, runPropertyEngine } from './decision-engine-run'

const streamOf = (lines: string[]) => {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() } })
}
const ndjson = (...events: object[]) => events.map((e) => `${JSON.stringify(e)}\n`)

describe('analyze wiring: property-scoped, no conversation required', () => {
  it('posts to the decision/run route for the PROPERTY; the thread is optional', () => {
    expect(ENGINE_RUN_PATH).toBe('/api/cockpit/deal-intelligence/decision/run')
    expect(engineRunUrl('', { propertyId: '237861730' })).toBe('/api/cockpit/deal-intelligence/decision/run?property_id=237861730')
    expect(engineRunUrl('https://x', { propertyId: '1', threadKey: '+15550000000' })).toBe('https://x/api/cockpit/deal-intelligence/decision/run?property_id=1&thread_key=%2B15550000000')
  })
  it('streams progress then succeeds only on the terminal decision_ready', async () => {
    const fetch = vi.fn(async () => new Response(streamOf([
      ...ndjson({ ok: true, stage: 'resolving_property', status: 'running' }, { ok: true, stage: 'loading_comps', status: 'done' }),
      // a terminal event split across two chunks must still parse
      '{"ok":true,"stage":"decision_rea', 'dy","status":"done","decision_status":"recomputed"}\n',
    ]), { status: 200 }))
    const seen: string[] = []
    const out = await runPropertyEngine({ propertyId: '1' }, (e) => { if (e.stage) seen.push(e.stage) }, { fetch: fetch as unknown as typeof globalThis.fetch, base: '', headers: { Authorization: 'Bearer t' } })
    expect(out).toEqual({ ok: true, decisionStatus: 'recomputed' })
    expect(seen).toEqual(['resolving_property', 'loading_comps', 'decision_ready'])
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/cockpit/deal-intelligence/decision/run?property_id=1')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t')
  })
  it('a run the engine REPORTED as failed is a failure — never read as done', async () => {
    const fetch = vi.fn(async () => new Response(streamOf(ndjson({ ok: true, stage: 'loading_comps', status: 'done' }, { ok: false, error: 'property_not_found', decision_status: 'engine_failed' })), { status: 200 }))
    const out = await runPropertyEngine({ propertyId: '1' }, undefined, { fetch: fetch as unknown as typeof globalThis.fetch, base: '', headers: {} })
    expect(out).toEqual({ ok: false, error: 'property_not_found' })
    expect(engineErrorText('property_not_found')).toContain('could not be found')
  })
  it('a stream that stops without a decision, or an HTTP error, is a failure', async () => {
    expect(engineOutcome(parseEngineChunk(ndjson({ ok: true, stage: 'loading_comps', status: 'done' }).join('')).events)).toEqual({ ok: false, error: 'run_ended_without_a_decision' })
    const fetch = vi.fn(async () => new Response('nope', { status: 401 }))
    const out = await runPropertyEngine({ propertyId: '1' }, undefined, { fetch: fetch as unknown as typeof globalThis.fetch, base: '', headers: {} })
    expect(out).toEqual({ ok: false, error: 'run_engine_http_401' })
    expect(engineErrorText('run_engine_http_401')).toContain('not authorized')
  })
})
