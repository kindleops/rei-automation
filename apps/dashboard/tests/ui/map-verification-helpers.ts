import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page } from '@playwright/test'
import {
  MAP_DIAGNOSTICS_DEBUG_KEY,
  MAP_DIAGNOSTICS_QUERY_PARAM,
  MAP_VERIFICATION_MODE_KEY,
} from '../../src/views/map/map-property-diagnostics-debug'
import { MAP_VISUAL_PRESET_STORAGE_KEY } from '../../src/views/map/map-visual-presets'

export const MAP_BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

const SELLER_PINS_SETTINGS_KEY = 'nexus.commandMap.sellerPinSettings.v3'
const OPS_DASHBOARD_SESSION_COOKIE = 'ops_dashboard_session'

const resolveOpsDashboardSecret = (): string => {
  if (process.env.VITE_OPS_DASHBOARD_SECRET) return process.env.VITE_OPS_DASHBOARD_SECRET
  if (process.env.OPS_DASHBOARD_SECRET) return process.env.OPS_DASHBOARD_SECRET
  try {
    const envPath = resolve(import.meta.dirname, '../../.env.local')
    const match = readFileSync(envPath, 'utf8').match(/^VITE_OPS_DASHBOARD_SECRET=(.+)$/m)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

const buildOpsDashboardSessionToken = (secret: string): string => (
  createHash('sha256').update(`ops-dashboard:${secret}`, 'utf8').digest('hex')
)

export const enableMapVerification = async (page: Page, themeId?: string) => {
  const secret = resolveOpsDashboardSecret()
  if (secret) {
    const host = new URL(MAP_BASE).hostname
    await page.context().addCookies([{
      name: OPS_DASHBOARD_SESSION_COOKIE,
      value: buildOpsDashboardSessionToken(secret),
      domain: host,
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }])
  }

  await page.addInitScript(([debugKey, verificationKey, presetKey, sellerPinsKey, preset]) => {
    window.localStorage.setItem(debugKey, '1')
    window.localStorage.setItem(verificationKey, '1')
    window.localStorage.setItem(sellerPinsKey, JSON.stringify({
      sellerPins: true,
      notContacted: true,
      contacted: true,
      newReplies: true,
      positive: true,
      negotiating: true,
      hot: true,
      issues: true,
      blocked: true,
      queued: true,
      scheduled: true,
      ready: true,
      activeSending: true,
      sent: true,
      delivered: true,
      failedIssue: true,
    }))
    if (preset) window.localStorage.setItem(presetKey, preset)
  }, [MAP_DIAGNOSTICS_DEBUG_KEY, MAP_VERIFICATION_MODE_KEY, MAP_VISUAL_PRESET_STORAGE_KEY, SELLER_PINS_SETTINGS_KEY, themeId ?? ''] as const)
}

export const openMap = async (page: Page, query = `${MAP_DIAGNOSTICS_QUERY_PARAM}=1`) => {
  await page.goto(`${MAP_BASE}/map?${query}`, { waitUntil: 'domcontentloaded' })
  await expect(
    page.locator('.nx-icm__canvas, region[aria-label="Map"]').first(),
  ).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => Boolean((window as unknown as { __nexusCommandMap?: unknown }).__nexusCommandMap), null, { timeout: 90_000 })
  await page.waitForFunction(() => {
    const map = (window as unknown as {
      __nexusCommandMap?: {
        isStyleLoaded?: () => boolean
        getLayer?: (id: string) => unknown
      }
    }).__nexusCommandMap
    if (!map?.isStyleLoaded?.()) return false
    try {
      return Boolean(
        map.getLayer?.('prop-tiles-icon')
        || map.getLayer?.('map-agg-cluster-core')
        || map.getLayer?.('map-agg-cluster-count'),
      )
    } catch {
      return false
    }
  }, null, { timeout: 120_000 })
}

export const flyMap = async (page: Page, zoom: number, center: [number, number]) => {
  await page.evaluate(({ zoom, center }) => new Promise<void>((resolve) => {
    const map = (window as unknown as {
      __nexusCommandMap?: {
        jumpTo: (o: object) => void
        once: (e: string, fn: () => void) => void
        triggerRepaint: () => void
        getZoom: () => number
        getCenter: () => { lng: number; lat: number }
      }
    }).__nexusCommandMap
    if (!map) {
      resolve()
      return
    }
    const settle = () => resolve()
    const timer = window.setTimeout(settle, 4000)
    map.jumpTo({ zoom, center })
    map.once('moveend', () => {
      window.clearTimeout(timer)
      settle()
    })
    map.triggerRepaint()
  }), { zoom, center })

  await page.waitForFunction(({ zoom, center }) => {
    const map = (window as unknown as { __nexusCommandMap?: { getCenter: () => { lng: number; lat: number }; getZoom: () => number } }).__nexusCommandMap
    if (!map) return false
    const c = map.getCenter()
    return Math.abs(c.lng - center[0]) < 0.02
      && Math.abs(c.lat - center[1]) < 0.02
      && Math.abs(map.getZoom() - zoom) < 0.2
  }, { zoom, center }, { timeout: 30000 })

  if (zoom >= 9) {
    await page.waitForFunction(() => {
      const map = (window as unknown as { __nexusCommandMap?: { getLayoutProperty: (id: string, key: string) => string } }).__nexusCommandMap
      return map?.getLayoutProperty('prop-tiles-icon', 'visibility') === 'visible'
    }, null, { timeout: 30000 }).catch(() => undefined)
  }
}

export const waitForMapIdle = async (page: Page, ms = 4000) => {
  await page.waitForTimeout(ms)
  await page.waitForFunction(() => {
    const diag = (window as unknown as {
      __nexusMapDiagnostics?: {
        zoom?: number
        totalCanonical?: number
        totalInBounds?: number
        tileBacked?: boolean
        uniqueTilePropertyIds?: number
        representedPropertyTotal?: number
      }
    }).__nexusMapDiagnostics
    if (!diag?.zoom) return false
    if (diag.tileBacked) {
      return Boolean(
        (diag.uniqueTilePropertyIds ?? 0) > 0
        || (diag.representedPropertyTotal ?? 0) > 0,
      )
    }
    return Boolean(diag.totalCanonical || diag.totalInBounds)
  }, null, { timeout: 45000 }).catch(() => undefined)
}

export const assertPropertyIconVisible = async (
  page: Page,
  propertyId: string,
  longitude: number,
  latitude: number,
) => {
  await page.waitForFunction(({ propertyId, longitude, latitude }) => {
    const map = (window as unknown as {
      __nexusCommandMap?: {
        project: (coords: [number, number]) => { x: number; y: number }
        queryRenderedFeatures: (
          geometry?: { x: number; y: number },
          options?: { layers?: string[] },
        ) => Array<{ id?: string | number; properties?: Record<string, unknown> }>
        querySourceFeatures: (
          sourceId: string,
          options?: { sourceLayer?: string },
        ) => Array<{ id?: string | number; properties?: Record<string, unknown> }>
        isSourceLoaded?: (sourceId: string) => boolean
      }
    }).__nexusCommandMap
    if (!map) return false

    const matchId = (feature: { id?: string | number; properties?: Record<string, unknown> }) => (
      String(feature.properties?.property_id ?? feature.id ?? '') === propertyId
    )

    const layers = ['prop-tiles-icon', 'prop-tiles-glass', 'prop-tiles-ring', 'prop-tiles-hit']
    const point = map.project([longitude, latitude])
    const rendered = map.queryRenderedFeatures(
      [{ x: point.x - 24, y: point.y - 24 }, { x: point.x + 24, y: point.y + 24 }],
      { layers },
    )
    if (rendered.some(matchId)) return true

    try {
      const sourceFeatures = map.querySourceFeatures('property-map-tiles', { sourceLayer: 'properties' })
      if (sourceFeatures.some(matchId)) return true
    } catch {
      // style reload in progress
    }

    try {
      return map.queryRenderedFeatures(undefined, { layers }).some(matchId)
    } catch {
      return false
    }
  }, { propertyId, longitude, latitude }, { timeout: 90000 })

  const visible = await page.evaluate(({ propertyId, longitude, latitude }) => {
    const map = (window as unknown as {
      __nexusCommandMap?: {
        project: (coords: [number, number]) => { x: number; y: number }
        queryRenderedFeatures: (
          geometry?: { x: number; y: number },
          options?: { layers?: string[] },
        ) => Array<{ id?: string | number; properties?: Record<string, unknown> }>
        querySourceFeatures: (
          sourceId: string,
          options?: { sourceLayer?: string },
        ) => Array<{ id?: string | number; properties?: Record<string, unknown> }>
      }
    }).__nexusCommandMap
    if (!map) return false
    const matchId = (feature: { id?: string | number; properties?: Record<string, unknown> }) => (
      String(feature.properties?.property_id ?? feature.id ?? '') === propertyId
    )
    const layers = ['prop-tiles-icon', 'prop-tiles-glass', 'prop-tiles-ring', 'prop-tiles-hit']
    const point = map.project([longitude, latitude])
    return map.queryRenderedFeatures(point, { layers }).some(matchId)
      || map.querySourceFeatures('property-map-tiles', { sourceLayer: 'properties' }).some(matchId)
  }, { propertyId, longitude, latitude })

  expect(visible).toBe(true)
}

export const readDiagnostics = async (page: Page) => {
  const overlay = page.getByTestId('map-property-diagnostics')
  await expect(overlay).toBeVisible({ timeout: 15000 })
  return overlay.innerText()
}

const parseDiagnosticsOverlay = async (page: Page): Promise<Record<string, unknown>> => page.evaluate(() => {
  const root = document.querySelector('[data-testid="map-property-diagnostics"]')
  if (!root) return {}
  const entries: Record<string, unknown> = {}
  root.querySelectorAll('dl > div').forEach((row) => {
    const key = row.querySelector('dt')?.textContent?.trim()
    const value = row.querySelector('dd')?.textContent?.trim()
    if (!key || value == null) return
    const numeric = Number(value.replace(/,/g, ''))
    if (key === 'zoom') entries.zoom = numeric
    else if (key === 'source_mode') entries.sourceMode = value
    else if (key === 'tile_backed') entries.tileBacked = value === 'true'
    else if (key === 'clipped') entries.clipped = value === 'false' ? false : value === 'true'
    else if (key === 'total_canonical') entries.totalCanonical = value === '—' ? undefined : numeric
    else if (key === 'total_in_bounds') entries.totalInBounds = value === '—' ? undefined : numeric
    else if (key === 'aggregate_total') entries.aggregateTotal = numeric
    else if (key === 'represented_property_total') entries.representedPropertyTotal = numeric
    else if (key === 'unique_tile_property_ids') entries.uniqueTilePropertyIds = numeric
    else if (key === 'rendered_individual_icons') entries.renderedIndividualIcons = numeric
    else if (key === 'rendered_clusters') entries.renderedClusters = numeric
    else if (key === 'clustered_property_total') entries.clusteredPropertyTotal = numeric
  })
  return entries
})

export const readWindowDiagnostics = async (page: Page) => {
  const overlay = page.getByTestId('map-property-diagnostics')
  await expect(overlay).toBeVisible({ timeout: 60_000 })
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="map-property-diagnostics"]')?.textContent ?? ''
    return /zoom[\s\S]*[1-9]\d*/i.test(text)
  }, null, { timeout: 60_000 })

  await page.waitForFunction(() => {
    const diag = (window as unknown as { __nexusMapDiagnostics?: { zoom?: number } }).__nexusMapDiagnostics
    return Boolean(diag && (diag.zoom ?? 0) > 0)
  }, null, { timeout: 15_000 }).catch(() => undefined)

  const windowDiag = await page.evaluate(() => (
    (window as unknown as { __nexusMapDiagnostics?: Record<string, unknown> }).__nexusMapDiagnostics ?? null
  ))
  if (windowDiag) return windowDiag
  return parseDiagnosticsOverlay(page)
}

export const assertNoInvariantViolations = async (page: Page) => {
  const violations = await page.evaluate(() => (
    (window as unknown as { __nexusMapInvariantViolations?: unknown[] }).__nexusMapInvariantViolations ?? []
  ))
  expect(violations).toHaveLength(0)
}

export const assertNoDuplicateMarkers = async (page: Page) => {
  const duplicates = await page.evaluate(() => (
    (window as unknown as { __nexusMapDuplicateMarkers?: string[] }).__nexusMapDuplicateMarkers ?? []
  ))
  expect(duplicates).toHaveLength(0)
}

export const waitForThemeLayers = async (page: Page, timeoutMs = 90000) => {
  await page.waitForFunction(() => {
    const diag = (window as unknown as {
      __nexusMapDiagnostics?: {
        tileBacked?: boolean
        representedPropertyTotal?: number
        renderedIndividualIcons?: number
        aggregateTotal?: number
        totalCanonical?: number
      }
    }).__nexusMapDiagnostics
    const map = (window as unknown as {
      __nexusCommandMap?: {
        isStyleLoaded?: () => boolean
        getLayer: (id: string) => unknown
      }
    }).__nexusCommandMap

    const hasLayer = Boolean(map?.getLayer('prop-tiles-icon') || map?.getLayer('map-agg-cluster-core'))
    const hasRepresentation = Boolean(
      (diag?.representedPropertyTotal ?? 0) > 0
      || (diag?.renderedIndividualIcons ?? 0) > 0
      || (diag?.aggregateTotal ?? 0) > 0
      || (diag?.totalCanonical ?? 0) > 0,
    )

    return hasLayer || hasRepresentation
  }, null, { timeout: timeoutMs })
}

const readActiveMapThemeId = async (page: Page): Promise<string | null> => page.evaluate(() => {
  const className = document.querySelector('.nx-icm')?.className ?? ''
  const match = className.match(/nx-icm--theme-([^\s]+)/)
  return match?.[1] ?? null
})

export const assertMapCanvasFillsContainer = async (page: Page) => {
  const footprint = await page.evaluate(() => {
    const container = document.querySelector('.nx-icm__canvas')
    const canvas = container?.querySelector('.maplibregl-canvas') as HTMLCanvasElement | null
    if (!container || !canvas) return null
    const containerRect = container.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    return {
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      canvasWidth: canvasRect.width,
      canvasHeight: canvasRect.height,
      canvasAttrWidth: canvas.width,
      canvasAttrHeight: canvas.height,
    }
  })
  expect(footprint).not.toBeNull()
  if (!footprint) return

  expect(footprint.containerWidth).toBeGreaterThan(200)
  expect(footprint.containerHeight).toBeGreaterThan(200)
  expect(footprint.canvasWidth).toBeGreaterThan(footprint.containerWidth * 0.92)
  expect(footprint.canvasHeight).toBeGreaterThan(footprint.containerHeight * 0.92)
}

export const switchThemeInApp = async (page: Page, themeId: string) => {
  const activeThemeId = await readActiveMapThemeId(page)
  if (activeThemeId === themeId) {
    await waitForThemeLayers(page, 15_000)
    await assertMapCanvasFillsContainer(page)
    return
  }

  await page.evaluate((nextThemeId) => new Promise<void>((resolve, reject) => {
    const setter = (window as unknown as { __nexusSetMapTheme?: (themeId: string) => void }).__nexusSetMapTheme
    const map = (window as unknown as {
      __nexusCommandMap?: {
        once: (event: string, handler: () => void) => void
        off: (event: string, handler: () => void) => void
        isStyleLoaded?: () => boolean
      }
    }).__nexusCommandMap
    if (!setter) {
      reject(new Error('__nexusSetMapTheme unavailable — enable map verification mode'))
      return
    }
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      window.clearTimeout(paintTimer)
      map?.off('style.load', onStyleLoad)
      map?.off('styledata', onStyleData)
      resolve()
    }
    const timer = window.setTimeout(settle, 8_000)
    const onStyleLoad = () => settle()
    const onStyleData = () => {
      if (map?.isStyleLoaded?.()) settle()
    }
    map?.once('style.load', onStyleLoad)
    map?.once('styledata', onStyleData)
    setter(nextThemeId)
    // Paint-only theme swaps (same vector basemap) never emit style.load.
    window.setTimeout(() => {
      if (map?.isStyleLoaded?.()) settle()
    }, 450)
    const paintTimer = window.setTimeout(settle, 2_500)
  }), themeId)

  await waitForThemeLayers(page, 12_000)
  await page.waitForTimeout(600)
  await page.evaluate(() => {
    const map = (window as unknown as { __nexusCommandMap?: { resize: () => void; triggerRepaint: () => void } }).__nexusCommandMap
    map?.resize()
    map?.triggerRepaint()
  })
  await assertMapCanvasFillsContainer(page)
}

export const buildOpsDashboardAuthHeaders = (): Record<string, string> => {
  const secret = resolveOpsDashboardSecret()
  if (!secret) return {}
  return {
    Cookie: `${OPS_DASHBOARD_SESSION_COOKIE}=${buildOpsDashboardSessionToken(secret)}`,
    'x-ops-dashboard-secret': secret,
  }
}