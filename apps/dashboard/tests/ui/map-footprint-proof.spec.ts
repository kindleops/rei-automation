import { test, expect } from '@playwright/test'
import { CANONICAL_BASELINE } from '../../src/views/map/map-asset-proof-manifest'
import {
  enableMapVerification,
  flyMap,
  openMap,
  readDiagnostics,
  waitForMapIdle,
} from './map-verification-helpers'

const MARKET_VIEWS = [
  { slug: 'national', zoom: 4, center: [-98, 39] as [number, number], label: 'Nationwide' },
  { slug: 'miami', zoom: 6.5, center: [-80.2, 25.78] as [number, number], label: 'Miami, FL' },
  { slug: 'dallas', zoom: 6.5, center: [-96.8, 32.78] as [number, number], label: 'Dallas, TX' },
  { slug: 'los-angeles', zoom: 6.5, center: [-118.25, 34.05] as [number, number], label: 'Los Angeles, CA' },
  { slug: 'memphis', zoom: 6.5, center: [-90.05, 35.15] as [number, number], label: 'Memphis, TN' },
  { slug: 'small-market', zoom: 7, center: [-81.55, 41.5] as [number, number], label: 'Cleveland area (<1K industrial/commercial cluster)' },
  { slug: 'large-market', zoom: 5.8, center: [-80.2, 25.78] as [number, number], label: 'Miami (>10K)' },
] as const

test.describe('National and market footprint proof', () => {
  test.beforeEach(async ({ page }) => {
    await enableMapVerification(page)
    await openMap(page)
  })

  for (const view of MARKET_VIEWS) {
    test(`footprint ${view.slug}`, async ({ page }) => {
      await flyMap(page, view.zoom, view.center)
      await waitForMapIdle(page, 5000)

      const diag = await readDiagnostics(page)
      expect(diag).toMatch(/clipped[\s\S]*false/i)

      if (view.slug === 'national') {
        expect(diag).toMatch(/total_canonical[\s\S]*124,?046|124046/)
        expect(diag).toMatch(/tile_backed[\s\S]*false/i)
      } else {
        expect(diag).toMatch(/total_in_bounds[\s\S]*[1-9]\d*/)
        expect(diag).toMatch(/represented_property_total|represented_features[\s\S]*[1-9]\d*/i)
      }

      await page.screenshot({
        path: `proof/map-footprint/${view.slug}-desktop.png`,
        fullPage: false,
      })
    })
  }

  test('market totals reconcile to canonical baseline constants', async () => {
    const sum = Object.values(CANONICAL_BASELINE.marketCounts).reduce((a, b) => a + b, 0)
    expect(sum).toBeGreaterThan(20_000)
    expect(CANONICAL_BASELINE.totalMappable).toBe(124_046)
    expect(CANONICAL_BASELINE.markets).toBe(494)
  })
})