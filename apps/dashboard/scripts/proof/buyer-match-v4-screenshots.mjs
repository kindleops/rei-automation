#!/usr/bin/env node
/**
 * Buyer Match V4 Phase 2 screenshot checkpoint (22 states).
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../../proof/buyer-match-v4/screenshots')
const BASE = 'http://127.0.0.1:5173/dev/buyer-match-v4'
const PROPERTY = '2131309217'

const STATES = [
  { name: '01-market-command-center', params: `propertyId=${PROPERTY}&pane=100&tab=MARKET&theme=dark` },
  { name: '02-buyers-best-match', params: `propertyId=${PROPERTY}&pane=100&tab=BUYERS&theme=dark` },
  { name: '03-buyers-local-regional', params: `propertyId=${PROPERTY}&pane=100&tab=BUYERS&mode=local_regional&theme=dark` },
  { name: '04-buyers-institutional', params: `propertyId=${PROPERTY}&pane=100&tab=BUYERS&mode=institutional&theme=dark` },
  { name: '05-institutions-workspace', params: `propertyId=${PROPERTY}&pane=100&tab=INSTITUTIONS&theme=dark` },
  { name: '06-entity-tree-expanded', params: `propertyId=${PROPERTY}&pane=100&tab=INSTITUTIONS&expandFirst=1&theme=dark` },
  { name: '07-institutional-dossier', params: `propertyId=${PROPERTY}&pane=100&tab=INSTITUTIONS&selectFirst=institutional&theme=dark` },
  { name: '08-local-buyer-dossier', params: `propertyId=${PROPERTY}&pane=100&tab=BUYERS&mode=local_regional&selectFirst=1&theme=dark` },
  { name: '09-activity-windows', params: `propertyId=${PROPERTY}&pane=100&tab=BUYERS&selectFirst=1&theme=dark` },
  { name: '10-single-asset-detail', params: `propertyId=${PROPERTY}&pane=100&tab=PURCHASE_ACTIVITY&filter=single&theme=dark` },
  { name: '11-package-detail', params: `propertyId=${PROPERTY}&pane=100&tab=PURCHASE_ACTIVITY&filter=package&theme=dark` },
  { name: '12-purchase-activity-map', params: `propertyId=${PROPERTY}&pane=100&tab=PURCHASE_ACTIVITY&theme=dark` },
  { name: '13-purchase-activity-timeline', params: `propertyId=${PROPERTY}&pane=100&tab=PURCHASE_ACTIVITY&theme=dark` },
  { name: '14-government-classification', params: `propertyId=${PROPERTY}&pane=100&tab=PURCHASE_ACTIVITY&filter=nonmarket&theme=dark` },
  { name: '15-unknown-identity-research', params: `propertyId=${PROPERTY}&pane=100&tab=BUYERS&mode=research&theme=dark` },
  { name: '16-shortlist-mixed', params: `propertyId=${PROPERTY}&pane=100&tab=SHORTLIST&shortlistFirst=3&theme=dark` },
  { name: '17-light-mode', params: `propertyId=${PROPERTY}&pane=100&tab=BUYERS&theme=light` },
  { name: '18-dark-mode', params: `propertyId=${PROPERTY}&pane=100&tab=MARKET&theme=dark` },
  { name: '19-red-ops', params: `propertyId=${PROPERTY}&pane=100&tab=MARKET&theme=red-ops` },
  { name: '20-pane-75', params: `propertyId=${PROPERTY}&pane=75&sim=75&tab=BUYERS&theme=dark` },
  { name: '21-pane-50', params: `propertyId=${PROPERTY}&pane=50&sim=50&tab=MARKET&theme=dark` },
  { name: '22-pane-25-compact-rail', params: `propertyId=${PROPERTY}&pane=25&sim=25&theme=dark` },
]

fs.mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await context.newPage()
const manifest = []

for (const state of STATES) {
  const url = `${BASE}?${state.params}`
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 })
  await page.waitForTimeout(5000)

  const q = new URL(url).searchParams
  if (q.get('mode')) {
    await page.evaluate((mode) => {
      const btn = [...document.querySelectorAll('.bmv4-segmented__btn')].find((b) => b.textContent?.toLowerCase().includes(mode.replace('_', '')))
      btn?.click()
    }, q.get('mode')).catch(() => {})
    await page.waitForTimeout(800)
  }
  if (q.get('selectFirst')) {
    await page.evaluate(() => {
      const row = document.querySelector('.bmv4-dir-row, .bmv4-inst-card header')
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }).catch(() => {})
    await page.waitForTimeout(600)
  }
  if (q.get('expandFirst')) {
    await page.evaluate(() => {
      const btn = document.querySelector('.bmv4-inst-card .bmv4-btn')
      btn?.click()
    }).catch(() => {})
    await page.waitForTimeout(600)
  }
  if (q.get('filter') === 'package') {
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.bmv4-check input')].find((i) => i.parentElement?.textContent?.includes('Package'))
      if (cb) (cb).click()
    }).catch(() => {})
  }
  if (q.get('filter') === 'single') {
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.bmv4-check input')].find((i) => i.parentElement?.textContent?.includes('Single asset'))
      if (cb) (cb).click()
    }).catch(() => {})
  }
  if (q.get('filter') === 'nonmarket') {
    await page.evaluate(() => {
      const cb = [...document.querySelectorAll('.bmv4-check input')].find((i) => i.parentElement?.textContent?.includes('Non-market'))
      if (cb) (cb).click()
    }).catch(() => {})
  }

  const file = path.join(OUT_DIR, `${state.name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  const meta = await page.evaluate(() => {
    const tab = document.querySelector('.bmv4-nav__tab.is-active')?.textContent?.trim()
    const rows = document.querySelectorAll('.bmv4-dir-row').length
    const markers = document.querySelector('.bmv4-map__toolbar .bmv4-tabular')?.textContent?.trim()
    const dossier = document.querySelector('.bmv4-dossier__name')?.textContent?.trim()
    const summary = document.querySelector('.bmv4-directory__head .bmv4-tabular, .bmv4-rail__summary')?.textContent?.trim()
    return { tab, rows, markers, dossier, summary }
  })
  manifest.push({ ...state, url, file, meta })
  console.log(`saved ${state.name}`)
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
await browser.close()
console.log(`Screenshots written to ${OUT_DIR}`)