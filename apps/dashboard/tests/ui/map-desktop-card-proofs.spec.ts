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

  const criticalTag = peek.locator('.smc-flag.is-critical').first()
  if (await criticalTag.isVisible().catch(() => false)) {
    await peek.locator('.smc-flags--weighted, .smc-flags').first().screenshot({
      path: `${OUT_DIR}/critical-red-tag-mix-desktop.png`,
    })
  }

  const weightedFlags = peek.locator('.smc-flags--weighted, .smc-flags').first()
  if (await weightedFlags.isVisible().catch(() => false)) {
    await weightedFlags.screenshot({ path: `${OUT_DIR}/amber-green-tag-mix-desktop.png` })
  }

  await clickPropertyPin(page, entry.propertyId, entry.longitude, entry.latitude)
  await page.waitForTimeout(1400)

  const focus = await ensureFocusCard(page)
  await focus.screenshot({ path: `${OUT_DIR}/${aliases.expanded}` })

  const financial = focus.locator('.smc-section--financial').first()
  if (await financial.isVisible().catch(() => false)) {
    await financial.screenshot({ path: `${OUT_DIR}/financial-profile-desktop.png` })
  }

  const ownerPressure = focus.locator('.smc-section--owner-pressure').first()
  if (await ownerPressure.isVisible().catch(() => false)) {
    await ownerPressure.screenshot({ path: `${OUT_DIR}/master-owner-pressure-desktop.png` })
  }

  const prospect = focus.locator('.smc-section--prospect').first()
  if (await prospect.isVisible().catch(() => false)) {
    await prospect.screenshot({ path: `${OUT_DIR}/prospect-contactability-desktop.png` })
    const meterLabel = await prospect.locator('.smc-contact-meter__head strong').innerText().catch(() => '')
    if (/ready/i.test(meterLabel)) {
      await prospect.screenshot({ path: `${OUT_DIR}/contactable-prospect-state-desktop.png` })
    }
    if (/not ready|partial/i.test(meterLabel)) {
      await prospect.screenshot({ path: `${OUT_DIR}/no-resolved-prospect-state-desktop.png` })
    }
  }

  const propertyProfile = focus.locator('.smc-section--profile').first()
  if (await propertyProfile.isVisible().catch(() => false)) {
    await propertyProfile.screenshot({ path: `${OUT_DIR}/property-profile-desktop.png` })
  }

  const contactPill = focus.locator('.smc-contact-state__pill').first()
  if (await contactPill.isVisible().catch(() => false)) {
    const pillText = await contactPill.innerText().catch(() => '')
    if (/not contacted/i.test(pillText)) {
      await focus.screenshot({ path: `${OUT_DIR}/no-contact-card-desktop.png` })
    }
    if (/contacted|reply|follow/i.test(pillText)) {
      await focus.screenshot({ path: `${OUT_DIR}/active-communication-card-desktop.png` })
    }
  }

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

      const emptyThread = page.locator('.smc-thread__state--empty').first()
      if (await emptyThread.isVisible().catch(() => false)) {
        await emptyThread.screenshot({ path: `${OUT_DIR}/message-composer-empty-state-desktop.png` })
      }

      const threadList = page.locator('.smc-thread__list .nx-msg-lane, .nx-message-list .nx-msg-lane').first()
      if (await threadList.isVisible().catch(() => false)) {
        await composer.screenshot({ path: `${OUT_DIR}/message-composer-existing-thread-desktop.png` })
      }
    }
  }
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