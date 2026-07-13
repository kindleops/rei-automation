import { test, expect } from '@playwright/test'
import { MAP_ASSET_PROOF_MANIFEST } from '../../src/views/map/map-asset-proof-manifest'
import {
  assertPropertyIconVisible,
  enableMapVerification,
  flyMap,
  openMap,
  waitForMapIdle,
} from './map-verification-helpers'

const OUT_DIR = 'proof/map-cards'

const THEME_PROOFS = [
  { id: 'satellite', file: 'readability-satellite-recon-desktop.png' },
  { id: 'dark_ops', file: 'readability-dark-ops-desktop.png' },
  { id: 'red_ops', file: 'readability-red-ops-desktop.png' },
] as const

const byMarker = (key: string) => MAP_ASSET_PROOF_MANIFEST.find((entry) => entry.markerKey === key)

const clickPropertyPin = async (
  page: import('@playwright/test').Page,
  propertyId: string,
  longitude: number,
  latitude: number,
) => {
  const point = await page.evaluate(({ propertyId, longitude, latitude }) => {
    const map = (window as unknown as {
      __nexusCommandMap?: {
        project: (coords: [number, number]) => { x: number; y: number }
        queryRenderedFeatures: (
          point: { x: number; y: number },
          options?: { layers?: string[] },
        ) => Array<{ properties?: Record<string, unknown> }>
      }
    }).__nexusCommandMap
    if (!map) return null

    const layers = ['prop-tiles-hit', 'prop-tiles-icon', 'prop-tiles-glass', 'prop-tiles-ring']
    const projected = map.project([longitude, latitude])
    const rendered = map.queryRenderedFeatures(projected, { layers })
    const hit = rendered.find((f) => String(f.properties?.property_id ?? '') === propertyId)
    if (hit) return { x: projected.x, y: projected.y }

    for (const dx of [-12, 0, 12]) {
      for (const dy of [-12, 0, 12]) {
        const probe = { x: projected.x + dx, y: projected.y + dy }
        const nearby = map.queryRenderedFeatures(probe, { layers })
        if (nearby.some((f) => String(f.properties?.property_id ?? '') === propertyId)) {
          return probe
        }
      }
    }
    return { x: projected.x, y: projected.y }
  }, { propertyId, longitude, latitude })

  expect(point).not.toBeNull()
  const canvas = page.locator('.nx-icm__canvas').first()
  await canvas.click({ position: point!, force: true })
}

const hoverPropertyPin = async (
  page: import('@playwright/test').Page,
  propertyId: string,
  longitude: number,
  latitude: number,
) => {
  const point = await page.evaluate(({ longitude, latitude }) => {
    const map = (window as unknown as {
      __nexusCommandMap?: { project: (coords: [number, number]) => { x: number; y: number } }
    }).__nexusCommandMap
    if (!map) return null
    const projected = map.project([longitude, latitude])
    return { x: projected.x, y: projected.y }
  }, { propertyId, longitude, latitude })

  expect(point).not.toBeNull()
  const canvas = page.locator('.nx-icm__canvas').first()
  const box = await canvas.boundingBox()
  if (!box) return
  await page.mouse.move(box.x + point!.x, box.y + point!.y)
}

const ensureFocusCard = async (page: import('@playwright/test').Page) => {
  const focus = page.locator('.smc-shell.is-focus').first()
  if (await focus.isVisible().catch(() => false)) return focus

  const peek = page.locator('.smc-shell.is-peek').first()
  if (await peek.isVisible().catch(() => false)) {
    await peek.click({ force: true })
    await page.waitForTimeout(1200)
  }

  await expect(page.locator('.smc-shell.is-focus').first()).toBeVisible({ timeout: 20000 })
  return page.locator('.smc-shell.is-focus').first()
}

const screenshotSectionIfVisible = async (
  focus: import('@playwright/test').Locator,
  selector: string,
  file: string,
) => {
  const section = focus.locator(selector).first()
  if (await section.isVisible().catch(() => false)) {
    await section.screenshot({ path: `${OUT_DIR}/${file}` })
  }
}

const captureAssetProofs = async (
  page: import('@playwright/test').Page,
  entry: NonNullable<ReturnType<typeof byMarker>>,
  aliases: { hover: string; expanded: string },
) => {
  await flyMap(page, 14, [entry.longitude, entry.latitude])
  await waitForMapIdle(page, 10000)
  await assertPropertyIconVisible(page, entry.propertyId, entry.longitude, entry.latitude)

  await hoverPropertyPin(page, entry.propertyId, entry.longitude, entry.latitude)
  await page.waitForTimeout(1400)

  const peek = page.locator('.smc-shell.is-peek').first()
  await expect(peek).toBeVisible({ timeout: 15000 })
  await peek.screenshot({ path: `${OUT_DIR}/${aliases.hover}` })

  const badgeRail = peek.locator('.smc-state-row--below-image, .smc-state-row').first()
  const image = peek.locator('.smc-image').first()
  if (await badgeRail.isVisible().catch(() => false) && await image.isVisible().catch(() => false)) {
    const imageBox = await image.boundingBox()
    const badgeBox = await badgeRail.boundingBox()
    if (imageBox && badgeBox) {
      expect(badgeBox.y).toBeGreaterThan(imageBox.y)
    }
  }

  const weightedFlags = peek.locator('.smc-flags--weighted, .smc-flags').first()
  if (await weightedFlags.isVisible().catch(() => false)) {
    await weightedFlags.screenshot({ path: `${OUT_DIR}/amber-green-tag-mix-desktop.png` })
  }

  await clickPropertyPin(page, entry.propertyId, entry.longitude, entry.latitude)
  await page.waitForTimeout(2400)

  const focus = await ensureFocusCard(page)
  await focus.screenshot({ path: `${OUT_DIR}/${aliases.expanded}` })

  await screenshotSectionIfVisible(focus, '.smc-section--property-details', 'sfr-construction-condition-desktop.png')
  await screenshotSectionIfVisible(focus, '.smc-section--valuation', 'valuation-assessment-desktop.png')
  await screenshotSectionIfVisible(focus, '.smc-section--loan', 'loan-transaction-desktop.png')
  await screenshotSectionIfVisible(focus, '.smc-section--distress', 'distress-legal-desktop.png')

  expect(await focus.locator('.smc-section--owner-pressure').count()).toBe(0)
  expect(await focus.locator('.smc-section--prospect').count()).toBe(0)
  expect(await focus.locator('.smc-section--financial').count()).toBe(0)

  const disabledPrimary = focus.locator('.smc-action--follow.is-disabled, .smc-action--follow:disabled').first()
  if (await disabledPrimary.isVisible().catch(() => false)) {
    await focus.locator('.smc-actions').first().screenshot({
      path: `${OUT_DIR}/send-disabled-reason-desktop.png`,
    })
  }

  const messageBtn = focus.locator('.smc-action--message').first()
  const messageEnabled = await messageBtn.isVisible().catch(() => false)
    && !(await messageBtn.isDisabled().catch(() => true))
  if (messageEnabled) {
    await messageBtn.click({ force: true })
    await page.waitForTimeout(1800)
    const composerShell = page.locator('.smc-shell.is-conversation').first()
    const flippedPane = page.locator('.smc-flip.is-flipped .smc-flip__back--sms').first()
    const composer = (await composerShell.isVisible().catch(() => false))
      ? composerShell
      : flippedPane
    if (await composer.isVisible().catch(() => false)) {
      await composer.screenshot({ path: `${OUT_DIR}/message-composer-desktop.png` })
    }
  }

  const scrollBody = focus.locator('.smc-body--dossier-scroll, .smc-body--focus').first()
  if (await scrollBody.isVisible().catch(() => false)) {
    await scrollBody.evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })
    await page.waitForTimeout(400)
    await focus.screenshot({ path: `${OUT_DIR}/bottom-of-scroll-visibility-desktop.png` })
  }
}

test.describe('Desktop map card visual proofs', () => {
  test.describe.configure({ timeout: 180_000 })
  test.use({ viewport: { width: 1440, height: 900 } })

  test('SFR card proofs', async ({ page }) => {
    const entry = byMarker('single_family')
    test.skip(!entry?.propertyId, 'SFR proof property unavailable')
    await enableMapVerification(page)
    await openMap(page)
    await captureAssetProofs(page, entry!, {
      hover: 'sfr-hover-card-desktop.png',
      expanded: 'sfr-expanded-card-desktop.png',
    })
  })

  test('Multifamily 5+ card proofs', async ({ page }) => {
    const entry = byMarker('multifamily_5_plus')
    test.skip(!entry?.propertyId, 'MF5+ proof property unavailable')
    await enableMapVerification(page)
    await openMap(page)
    await captureAssetProofs(page, entry!, {
      hover: 'multifamily-5-plus-hover-card-desktop.png',
      expanded: 'multifamily-5-plus-expanded-card-desktop.png',
    })
  })

  test('Commercial card proofs', async ({ page }) => {
    const entry = byMarker('retail_strip')
    test.skip(!entry?.propertyId, 'Commercial proof property unavailable')
    await enableMapVerification(page)
    await openMap(page)
    await captureAssetProofs(page, entry!, {
      hover: 'commercial-hover-card-desktop.png',
      expanded: 'commercial-expanded-card-desktop.png',
    })
  })

  for (const theme of THEME_PROOFS) {
    test(`${theme.id} readability`, async ({ page }) => {
      const sfr = byMarker('single_family')
      test.skip(!sfr?.propertyId, 'SFR proof property unavailable')
      await enableMapVerification(page, theme.id)
      await openMap(page)
      await flyMap(page, 14, [sfr!.longitude, sfr!.latitude])
      await waitForMapIdle(page, 8000)
      await hoverPropertyPin(page, sfr!.propertyId, sfr!.longitude, sfr!.latitude)
      await page.waitForTimeout(1200)
      const peek = page.locator('.smc-shell.is-peek').first()
      if (await peek.isVisible().catch(() => false)) {
        await peek.screenshot({ path: `${OUT_DIR}/${theme.file}` })
      } else {
        await page.screenshot({ path: `${OUT_DIR}/${theme.file}`, fullPage: false })
      }
    })
  }
})