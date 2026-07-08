import { test } from '@playwright/test'
import { MAP_ASSET_PROOF_MANIFEST } from '../../src/views/map/map-asset-proof-manifest'
import {
  enableMapVerification,
  flyMap,
  openMap,
  waitForMapIdle,
} from './map-verification-helpers'

const OUT_DIR = 'proof/map-cards'

const THEME_PROOFS = [
  { id: 'satellite', label: 'Satellite Recon' },
  { id: 'dark_ops', label: 'Dark Ops' },
  { id: 'red_ops', label: 'Red Ops' },
] as const

const captureCardProofs = async (
  page: import('@playwright/test').Page,
  slug: string,
) => {
  const peek = page.locator('.smc-shell.is-peek').first()
  if (await peek.isVisible().catch(() => false)) {
    await peek.screenshot({ path: `${OUT_DIR}/${slug}-hover-desktop.png` })
  }

  const focus = page.locator('.smc-shell.is-focus').first()
  if (await focus.isVisible().catch(() => false)) {
    await focus.screenshot({ path: `${OUT_DIR}/${slug}-expanded-desktop.png` })
    const financial = focus.locator('.smc-section--financial').first()
    if (await financial.isVisible().catch(() => false)) {
      await financial.screenshot({ path: `${OUT_DIR}/${slug}-financial-profile-desktop.png` })
    }
    const ownerPressure = focus.locator('.smc-section--owner-pressure').first()
    if (await ownerPressure.isVisible().catch(() => false)) {
      await ownerPressure.screenshot({ path: `${OUT_DIR}/${slug}-owner-pressure-desktop.png` })
    }
    const prospect = focus.locator('.smc-section--prospect').first()
    if (await prospect.isVisible().catch(() => false)) {
      await prospect.screenshot({ path: `${OUT_DIR}/${slug}-prospect-contactability-desktop.png` })
    }
  }

  const composer = page.locator('.smc-shell.is-conversation').first()
  if (await composer.isVisible().catch(() => false)) {
    await composer.screenshot({ path: `${OUT_DIR}/${slug}-composer-desktop.png` })
  }
}

test.describe('Desktop map card visual proofs', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  for (const entry of MAP_ASSET_PROOF_MANIFEST.filter((item) => (
    ['single_family', 'multifamily_5_plus', 'retail'].includes(item.markerKey)
  ))) {
    test(`${entry.markerKey} card proofs`, async ({ page }) => {
      await enableMapVerification(page)
      await openMap(page)
      await flyMap(page, 14, [entry.longitude, entry.latitude])
      await waitForMapIdle(page, 10000)

      const canvas = page.locator('.nx-icm__canvas').first()
      const box = await canvas.boundingBox()
      if (!box) return
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(1200)
      await captureCardProofs(page, entry.screenshotSlug)

      await canvas.click({ position: { x: box.width / 2, y: box.height / 2 }, force: true })
      await page.waitForTimeout(1200)
      await captureCardProofs(page, `${entry.screenshotSlug}-clicked`)

      const messageBtn = page.locator('.smc-action--message').first()
      if (await messageBtn.isVisible().catch(() => false)) {
        await messageBtn.click()
        await page.waitForTimeout(1000)
        await captureCardProofs(page, `${entry.screenshotSlug}-composer`)
      }
    })
  }

  for (const theme of THEME_PROOFS) {
    test(`${theme.label} readability`, async ({ page }) => {
      await enableMapVerification(page, theme.id)
      await openMap(page)
      await flyMap(page, 13, [-89.97, 35.12])
      await waitForMapIdle(page, 8000)
      await page.screenshot({ path: `${OUT_DIR}/readability-${theme.id}-desktop.png`, fullPage: false })
    })
  }
})