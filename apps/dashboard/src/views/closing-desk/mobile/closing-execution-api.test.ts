import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/api/backendClient', () => ({ callBackend: vi.fn() }))
import { callBackend } from '../../../lib/api/backendClient'
import { fetchPortfolio } from './closing-execution-api'
import demo from './closing-demo.generated.json'

describe('closing execution client', () => {
  it('a failed read throws — it never becomes demo or empty data', async () => {
    vi.mocked(callBackend).mockResolvedValueOnce({ ok: true, data: { ok: false, error: 'closing_portfolio_failed' } } as never)
    await expect(fetchPortfolio('most_urgent')).rejects.toThrow('closing_portfolio_failed')
    vi.mocked(callBackend).mockResolvedValueOnce({ ok: false, error: 'timeout' } as never)
    await expect(fetchPortfolio('most_urgent')).rejects.toThrow('timeout')
  })

  it('demo data is the server derivation (no hand-written states), and every closing names a state', () => {
    const items = (demo as { portfolio: { items: Array<{ state: { key: string }; ready: boolean; closed: boolean; requirements: Array<{ met: boolean }> }> } }).portfolio.items
    expect(items.length).toBeGreaterThan(5)
    for (const x of items) {
      expect(x.state.key).toBeTruthy()
      // Ready is only ever the conjunction of every requirement.
      if (x.ready) expect(x.requirements.every((r) => r.met)).toBe(true)
    }
    expect(items.some((x) => x.closed)).toBe(true)
  })
})
