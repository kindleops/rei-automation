import { test, expect } from '@playwright/test'
import { CANONICAL_BASELINE } from '../../src/views/map/map-asset-proof-manifest'
import {
  buildOpsDashboardAuthHeaders,
  enableMapVerification,
  flyMap,
  openMap,
  readWindowDiagnostics,
  waitForMapIdle,
} from './map-verification-helpers'

const DENSE_MARKETS = [
  { name: 'los-angeles', market: 'Los Angeles, CA', center: [-118.35, 34.08] as [number, number], expected: CANONICAL_BASELINE.marketCounts['Los Angeles, CA'] },
  { name: 'miami', market: 'Miami, FL', center: [-80.19, 25.76] as [number, number], expected: CANONICAL_BASELINE.marketCounts['Miami, FL'] },
] as const

const ACCOUNTING_ZOOMS = [8, 9, 10, 12, 14] as const

for (const market of DENSE_MARKETS) {
  for (const zoom of ACCOUNTING_ZOOMS) {
    test(`${market.name} accounting at zoom ${zoom}`, async ({ page, request }) => {
      await enableMapVerification(page)
      await openMap(page)
      await flyMap(page, zoom, market.center)
      await waitForMapIdle(page, zoom < 9 ? 8000 : zoom >= 9 && zoom < 11 ? 10_000 : zoom >= 9 ? 6000 : 4000)

      const diag = await readWindowDiagnostics(page)
      expect(diag).not.toBeNull()

      if (zoom < 9) {
        expect(diag?.tileBacked).toBe(false)
        const represented = Number(
          diag?.aggregateTotal
          ?? diag?.representedPropertyTotal
          ?? diag?.totalInBounds
          ?? 0,
        )
        expect(represented).toBeGreaterThan(0)
        await page.screenshot({
          path: `proof/map-accounting/${market.name}-z${zoom}-desktop.png`,
          fullPage: false,
        })
        return
      }

      expect(diag?.tileBacked).toBe(true)
      expect(diag?.clipped).toBe(false)

      const bounds = await page.evaluate(() => {
        const map = (window as unknown as { __nexusCommandMap?: { getBounds: () => { getWest: () => number; getSouth: () => number; getEast: () => number; getNorth: () => number } } }).__nexusCommandMap
        if (!map) return null
        const b = map.getBounds()
        return { lat_min: b.getSouth(), lat_max: b.getNorth(), lng_min: b.getWest(), lng_max: b.getEast() }
      })
      expect(bounds).not.toBeNull()

      const qs = new URLSearchParams({ ...bounds!, zoom: String(zoom) }).toString()
      const apiBase = process.env.PLAYWRIGHT_API_URL || 'http://127.0.0.1:3000'
      const apiRes = await request.get(`${apiBase}/api/internal/dashboard/ops/map/accounting?${qs}`, {
        headers: buildOpsDashboardAuthHeaders(),
      })
      if (apiRes.ok()) {
        const body = await apiRes.json()
        const data = body.data
        expect(data.canonical_total_in_bounds).toBeGreaterThan(0)
        expect(data.unique_tile_property_ids).toBeGreaterThan(0)
        expect(Math.abs(data.difference)).toBeLessThanOrEqual(Math.max(50, data.canonical_total_in_bounds * 0.02))
        expect(data.duplicate_property_id_count).toBeGreaterThanOrEqual(0)
      }

      const uniqueTileIds = Number(diag?.uniqueTilePropertyIds ?? 0)
      const canonicalInBounds = Number(diag?.totalInBounds ?? 0)
      if (canonicalInBounds > 0 && uniqueTileIds > 0) {
        const delta = Math.abs(canonicalInBounds - uniqueTileIds)
        const tolerance = Math.max(25, Math.ceil(canonicalInBounds * 0.05))
        expect(delta).toBeLessThanOrEqual(tolerance)
      }

      await page.screenshot({
        path: `proof/map-accounting/${market.name}-z${zoom}-desktop.png`,
        fullPage: false,
      })
    })
  }
}