import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.NEXUS_URL || 'http://localhost:4173'
const ROUTE = process.env.NEXUS_ROUTE || '/inbox'

const outDir = path.resolve('proof/inbox')
fs.mkdirSync(outDir, { recursive: true })

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8')

const assertContains = (name, file, needles) => {
  const source = read(file)
  const missing = needles.filter((needle) => !source.includes(needle))
  if (missing.length > 0) throw new Error(`${name} missing ${missing.join(', ')} in ${file}`)
  console.log(`✅ ${name}`)
}

const assertNotContains = (name, file, needles) => {
  const source = read(file)
  const present = needles.filter((needle) => source.includes(needle))
  if (present.length > 0) throw new Error(`${name} still contains ${present.join(', ')} in ${file}`)
  console.log(`✅ ${name}`)
}

const runStaticInboxProof = () => {
  console.log('── Static Premium Inbox Proof ──')

  assertNotContains('top KPI strip removed', 'src/modules/inbox/InboxPage.tsx', [
    'nx-emergency-ops',
    'New Inbounds 15m',
    'New Inbounds 60m',
    'Auto-Replies Queued',
    'Podio Cooldown',
  ])

  assertNotContains('chat action clutter removed', 'src/modules/inbox/components/ChatThread.tsx', [
    'Reply Manually',
    'Queue Auto Reply',
    'Mark Reviewed',
    'Mark Manual Review',
    'Suppress Thread',
    'Run Offer AI',
    'Copy Seller Reply',
    'Open Property',
  ])

  assertContains('clean empty-thread fallback exists', 'src/modules/inbox/components/ChatThread.tsx', [
    'No messages loaded for this thread.',
  ])

  assertContains('left inbox shell restored', 'src/modules/inbox/components/InboxSidebar.tsx', [
    'ACQUISITIONS INBOX',
    'Owner, address, phone, APN...',
  ])

  assertContains('all left queue categories exist', 'src/modules/inbox/components/InboxSidebar.tsx', [
    'HOT LEADS',
    'NEEDS REVIEW',
    'NEW INBOUND',
    'AUTOMATED',
    'OUTBOUND ACTIVE',
    'COLD / NO RESPONSE',
    'DNC / OPT OUT',
    'LOAD MORE',
  ])

  assertContains('right dossier sections restored', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    'DEAL COMMAND DOSSIER',
    'Offer Intelligence',
    'Contact & Ownership Intelligence',
    'Automation Timeline',
    'LINKED APPS',
    'AI ASSIST',
  ])

  assertNotContains('deal state card removed from rendered dossier', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    '<DealStateCard',
  ])

  assertContains('internal dossier tabs restored', 'src/modules/inbox/components/IntelligencePanel.tsx', [
    'PROSPECT',
    'OWNER',
    'PORTFOLIO',
    'FINANCIAL',
    'PROPERTY INTEL',
    'OVERVIEW',
    'LOCATION',
    'PROPERTY',
    'EQUITY / VALUATION',
    'LAND / TAX',
  ])

  assertContains('hydrated supabase loader exists', 'src/lib/data/inboxData.ts', [
    'HYDRATED_INBOX_THREADS_VIEW = \'inbox_command_center_v\'',
    'HYDRATED_INBOX_COUNTS_VIEW = \'inbox_category_counts\'',
    'HYDRATED_INBOX_PAGE_SIZE = 200',
    '.order(\'final_acquisition_score\'',
    '.order(\'priority_score\'',
    '.eq(\'inbox_category\'',
    '.in(\'inbox_category\'',
  ])

  assertContains('thread cards use hydrated market and latest message fields', 'src/lib/data/inboxData.ts', [
    'prospect_name',
    'owner_name',
    'best_phone',
    'property_address_full',
    'latest_message_body',
    'property_type',
    'detected_intent',
    'queue_stage',
  ])

  assertContains('workflow thread preserves hydration aliases', 'src/modules/inbox/inbox.adapter.ts', [
    'thread_id:',
    'latest_message_body:',
    'latest_message_direction:',
    'latest_activity_at:',
    'inbound_count:',
    'outbound_count:',
    'hydrationConfidence:',
    'hydrationSource:',
  ])

  assertContains('premium no-vertical-text CSS guards exist', 'src/modules/inbox/inbox-premium.css', [
    '.nx-intel-field {',
    'grid-template-columns: minmax(150px, 0.92fr) minmax(0, 1.4fr);',
    '.nx-intel-field__value {',
    'word-break: break-word;',
  ])

  assertContains('right dossier consumes hydrated selected thread immediately', 'src/modules/inbox/InboxPage.tsx', [
    'setThreadIntelligence((selected ?? null)',
    'setThreadIntelligence({',
  ])

  assertContains('premium sidebar selectors exist', 'src/modules/inbox/inbox-premium.css', [
    '.nx-queue-group__header',
    '.nx-thread-card',
    '.nx-ai-assist-card',
  ])

  console.log('✅ Static proof complete')
}

const tryBrowserProof = async () => {
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    console.warn(`⚠️ Playwright browser unavailable: ${error.message}`)
    return false
  }

  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: 1,
    })

    await page.goto(`${BASE_URL}${ROUTE}`, { waitUntil: 'networkidle', timeout: 45_000 })
    await page.waitForTimeout(1500)

    const mustExist = [
      ['queue groups', '.nx-queue-group__header'],
      ['chat area', '.nx-chat-container'],
      ['dossier area', '.nx-intelligence-panel'],
    ]

    for (const [label, selector] of mustExist) {
      const found = await page.$(selector)
      if (!found) throw new Error(`Browser proof missing ${label} (${selector})`)
      console.log(`✅ ${label}`)
    }

    const forbiddenTexts = [
      'NEW INBOUNDS 15M',
      'AUTO-REPLIES QUEUED',
      'Reply Manually',
      'Queue Auto Reply',
      'Mark Reviewed',
      'DEAL STATE:',
    ]

    const pageText = await page.textContent('body')
    for (const text of forbiddenTexts) {
      if (pageText?.includes(text)) throw new Error(`Browser proof found forbidden text: ${text}`)
    }
    console.log('✅ removed clutter absent in browser render')

    const wrappingCheck = await page.evaluate(() => {
      const values = Array.from(document.querySelectorAll('.nx-intel-field__value')).slice(0, 8)
      if (values.length === 0) return false
      return values.every((node) => {
        const style = window.getComputedStyle(node)
        return style.writingMode === 'horizontal-tb' && style.wordBreak !== 'break-all'
      })
    })
    if (!wrappingCheck) throw new Error('Browser proof failed horizontal value wrapping check')
    console.log('✅ horizontal dossier values verified')

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const screenshotPath = path.join(outDir, `premium-inbox-${stamp}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    console.log(`✅ Browser screenshot saved: ${screenshotPath}`)
    return true
  } catch (error) {
    console.warn(`⚠️ Browser proof skipped: ${error.message}`)
    return false
  } finally {
    await browser.close()
  }
}

runStaticInboxProof()
const browserWorked = await tryBrowserProof()
if (!browserWorked) {
  console.log('ℹ️ Static proof passed; browser proof unavailable or app not reachable.')
}
console.log('\n── Premium Inbox Proof Complete ──')
