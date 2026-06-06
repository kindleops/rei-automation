/**
 * /inbox CASCADE OWNERSHIP AUDIT (read-only)
 * ----------------------------------------------------------------------------
 * Proves, via the Chrome DevTools Protocol (CSS.getMatchedStylesForNode — the
 * exact API the DevTools "Styles" panel renders from), which CSS rule actually
 * WINS the cascade for each audited element, and flags any matched declaration
 * that is overridden ("crossed out" in DevTools).
 *
 * For each element it reports:
 *   1. rendered DOM class list
 *   2. computed background-color
 *   3. computed border-top-color (representative border edge)
 *   4. computed box-shadow
 *   5. winning rule selector + stylesheet URL (+ the full ordered match list)
 *
 * It does NOT modify any styles. Output: console table + JSON + an HTML render
 * of the matched-rules tables, screenshotted to
 * test-results/screenshots/cascade-audit-*.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, type Page } from '@playwright/test'

const SHOT_DIR = path.resolve('test-results/screenshots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const AUDIT_PROPS = ['background-color', 'border-top-color', 'box-shadow'] as const

type Target = {
  key: string
  label: string
  selector: string
  prepare: (page: Page) => Promise<boolean> // returns true if element became available
}

async function boot(page: Page, theme: string, accent: string) {
  await page.addInitScript(
    ([t, a]) => localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: t, accentPalette: a })),
    [theme, accent] as const,
  )
  await page.goto('/inbox')
  await page.locator('.nx-premium-inbox').first().waitFor({ state: 'visible', timeout: 20_000 })
}

async function openWorkspaceMenu(page: Page) {
  // Idempotent: only click the (toggle) button if the menu is not already open,
  // so re-preparing a second menu target does not close it.
  const menu = page.locator('.nx-topbar-workspace-menu')
  if (await menu.first().isVisible().catch(() => false)) return
  const btn = page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact')
  if (await btn.count()) await btn.first().click()
  await menu.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
}

async function closeWorkspaceMenu(page: Page) {
  const menu = page.locator('.nx-topbar-workspace-menu')
  if (await menu.first().isVisible().catch(() => false)) {
    const btn = page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact')
    if (await btn.count()) await btn.first().click()
  }
  await menu.first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
}

const targets: Target[] = [
  {
    key: 'workspace-menu',
    label: 'Workspace menu container',
    selector: '.nx-topbar-workspace-menu',
    prepare: async (page) => {
      await openWorkspaceMenu(page)
      return (await page.locator('.nx-topbar-workspace-menu').count()) > 0
    },
  },
  {
    key: 'submenu-panel',
    label: 'Workspace submenu panel',
    selector: '.nx-topbar-workspace-menu .nx-workspace-submenu-panel',
    prepare: async (page) => {
      await openWorkspaceMenu(page)
      return (await page.locator('.nx-topbar-workspace-menu .nx-workspace-submenu-panel').count()) > 0
    },
  },
  {
    key: 'accent-row',
    label: 'Accent palette row (active)',
    selector: '.nx-topbar-workspace-menu .nx-workspace-submenu-item.is-active',
    prepare: async (page) => {
      await openWorkspaceMenu(page)
      const accent = page.locator('.nx-topbar-workspace-menu .nx-workspace-menu-item', { hasText: 'Accent' })
      if (await accent.count()) await accent.first().click()
      const row = page.locator('.nx-topbar-workspace-menu .nx-workspace-submenu-item.is-active')
      await row.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
      return (await row.count()) > 0
    },
  },
  {
    key: 'notification-center',
    label: 'Notification center panel',
    selector: '.nxhud-panel.nx-notification-center',
    prepare: async (page) => {
      // close any open workspace menu first
      await closeWorkspaceMenu(page)
      const bell = page.locator('.nx-notification-button[title="Notifications"]')
      if (await bell.count()) await bell.first().click()
      const panel = page.locator('.nxhud-panel.nx-notification-center')
      await panel.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
      return (await panel.count()) > 0
    },
  },
  {
    key: 'thread-bubble',
    label: 'Thread bubble (outbound)',
    selector: '.nx-bubble-wrap.is-outbound .nx-chat-bubble',
    prepare: async (page) => {
      await closeWorkspaceMenu(page)
      const row = page.locator('.nx-thread-card-rebuilt, .nx-row25').first()
      if (await row.count()) await row.click().catch(() => {})
      const bubble = page.locator('.nx-bubble-wrap.is-outbound .nx-chat-bubble')
      await bubble.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
      return (await bubble.count()) > 0
    },
  },
  {
    key: 'filter-pill',
    label: 'Active filter pill',
    selector: '.nx-inbox-chip-v2.is-active',
    prepare: async (page) => {
      await closeWorkspaceMenu(page)
      const pill = page.locator('.nx-inbox-chip-v2.is-active')
      return (await pill.count()) > 0
    },
  },
]

type WinnerInfo = {
  property: string
  computed: string
  winningSelector: string | null
  winningValue: string | null
  important: boolean
  styleSheet: string | null
  ordered: Array<{ selector: string; value: string; important: boolean; styleSheet: string; overridden: boolean }>
}

function computeWinners(
  matchedCSSRules: any[],
  inlineStyle: any,
  sheetUrl: (id: string) => string,
  computed: Record<string, string>,
): WinnerInfo[] {
  return AUDIT_PROPS.map((prop) => {
    const decls: Array<{ selector: string; value: string; important: boolean; styleSheet: string }> = []
    // matchedCSSRules are in ascending cascade order (later = higher priority)
    for (const m of matchedCSSRules) {
      const rule = m.rule
      for (const p of rule.style.cssProperties || []) {
        if (p.name !== prop || p.disabled || p.value == null) continue
        decls.push({
          selector: rule.selectorList?.text ?? '(unknown)',
          value: p.value,
          important: !!p.important,
          styleSheet: sheetUrl(rule.styleSheetId),
        })
      }
    }
    if (inlineStyle) {
      for (const p of inlineStyle.cssProperties || []) {
        if (p.name !== prop || p.disabled || p.value == null) continue
        decls.push({ selector: 'element.style (inline)', value: p.value, important: !!p.important, styleSheet: '(inline)' })
      }
    }
    // Determine winner: iterate in order, later wins unless an earlier !important
    // outranks a later non-important.
    let winnerIdx = -1
    let winnerImportant = false
    decls.forEach((d, i) => {
      if (winnerIdx === -1) { winnerIdx = i; winnerImportant = d.important; return }
      if (d.important || !winnerImportant) { winnerIdx = i; winnerImportant = d.important }
    })
    const ordered = decls.map((d, i) => ({ ...d, overridden: i !== winnerIdx }))
    const w = winnerIdx >= 0 ? decls[winnerIdx] : null
    return {
      property: prop,
      computed: computed[prop] ?? '',
      winningSelector: w?.selector ?? null,
      winningValue: w?.value ?? null,
      important: w?.important ?? false,
      styleSheet: w?.styleSheet ?? null,
      ordered,
    }
  })
}

test('cascade ownership audit — dark/cyan', async ({ page }) => {
  test.setTimeout(120_000)
  await boot(page, 'dark', 'cyan')

  const client = await page.context().newCDPSession(page)
  const sheetById = new Map<string, string>()
  client.on('CSS.styleSheetAdded', (e: any) => {
    sheetById.set(e.header.styleSheetId, e.header.sourceURL || e.header.title || `sheet#${e.header.styleSheetId}`)
  })
  await client.send('DOM.enable')
  await client.send('CSS.enable') // re-fires styleSheetAdded for all existing sheets
  const sheetUrl = (id: string) => {
    const u = sheetById.get(id) || `sheet#${id}`
    return u.includes('/') ? u.split('/').pop()! : u
  }

  const report: any[] = []

  for (const t of targets) {
    const available = await t.prepare(page).catch(() => false)
    const exists = available && (await page.locator(t.selector).count()) > 0

    if (!exists) {
      report.push({ key: t.key, label: t.label, selector: t.selector, available: false, note: 'element not present in no-backend sandbox (requires live data) — not audited' })
      console.log(`\n## ${t.label}\n  selector: ${t.selector}\n  STATUS: NOT PRESENT (requires live data)`)
      continue
    }

    const handle = await page.locator(t.selector).first().elementHandle()
    if (!handle) { report.push({ key: t.key, label: t.label, available: false }); continue }

    const className = await handle.evaluate((el) => (el as HTMLElement).className)
    const computed = await handle.evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement)
      return {
        'background-color': cs.backgroundColor,
        'border-top-color': cs.borderTopColor,
        'box-shadow': cs.boxShadow,
      } as Record<string, string>
    })

    // Bridge Playwright handle → CDP nodeId
    const doc = await client.send('DOM.getDocument', { depth: 0 })
    const objectId = (handle as any)._objectId ?? undefined
    let nodeId: number
    if (objectId) {
      nodeId = (await client.send('DOM.requestNode', { objectId })).nodeId
    } else {
      nodeId = (await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: t.selector })).nodeId
    }

    const matched = await client.send('CSS.getMatchedStylesForNode', { nodeId })
    const winners = computeWinners(matched.matchedCSSRules || [], matched.inlineStyle, sheetUrl, computed)

    report.push({ key: t.key, label: t.label, selector: t.selector, available: true, className, winners })

    console.log(`\n## ${t.label}`)
    console.log(`  rendered class: "${className}"`)
    for (const w of winners) {
      console.log(`  • ${w.property}: computed=${w.computed}`)
      console.log(`      WINNER: ${w.winningSelector}  { ${w.property}: ${w.winningValue}${w.important ? ' !important' : ''} }  [${w.styleSheet}]`)
      const overridden = w.ordered.filter((o) => o.overridden)
      if (overridden.length) {
        for (const o of overridden) {
          console.log(`      overridden (crossed-out): ${o.selector}  { ${w.property}: ${o.value}${o.important ? ' !important' : ''} }  [${o.styleSheet}]`)
        }
      }
    }
  }

  fs.writeFileSync(path.join(SHOT_DIR, 'cascade-audit.json'), JSON.stringify(report, null, 2))

  // Render a DevTools-style visual of the matched rules and screenshot it.
  const html = renderReportHtml(report)
  await page.setContent(html, { waitUntil: 'load' })
  await page.screenshot({ path: path.join(SHOT_DIR, 'cascade-audit.png'), fullPage: true })
})

function esc(s: string) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

function renderReportHtml(report: any[]): string {
  const blocks = report.map((r) => {
    if (!r.available) {
      return `<section><h2>${esc(r.label)}</h2><div class="sel">${esc(r.selector || '')}</div><div class="missing">NOT PRESENT — ${esc(r.note || 'unavailable')}</div></section>`
    }
    const props = (r.winners || []).map((w: any) => {
      const rows = (w.ordered || []).map((o: any) =>
        `<div class="decl ${o.overridden ? 'ov' : 'win'}"><code>${esc(o.selector)}</code><span>{ ${esc(w.property)}: ${esc(o.value)}${o.important ? ' !important' : ''} }</span><em>${esc(o.styleSheet)}</em></div>`
      ).join('')
      return `<div class="prop"><div class="phead">${esc(w.property)} <b>= ${esc(w.computed)}</b> <small>(computed)</small></div>${rows || '<div class="decl none">no matched declaration</div>'}</div>`
    }).join('')
    return `<section><h2>${esc(r.label)}</h2><div class="sel">${esc(r.selector)}</div><div class="cls">class="${esc(r.className)}"</div>${props}</section>`
  }).join('')
  return `<!doctype html><meta charset=utf8><style>
  body{background:#0b0d12;color:#e6e9ef;font:12px/1.5 -apple-system,Segoe UI,Roboto,monospace;padding:22px;margin:0}
  h1{font-size:18px;margin:0 0 16px}
  section{background:#11141c;border:1px solid #232838;border-radius:10px;padding:14px 16px;margin:0 0 14px}
  h2{font-size:14px;margin:0 0 4px;color:#9 fdff;color:#7fd7ff}
  .sel{color:#ffb86c;font-family:monospace;margin-bottom:2px}
  .cls{color:#8a94a6;font-family:monospace;margin-bottom:10px;font-size:11px}
  .prop{border-top:1px dashed #232838;padding:8px 0}
  .phead{color:#cdd3df;margin-bottom:5px}
  .phead b{color:#7CFFB2}
  .decl{display:flex;gap:10px;align-items:baseline;padding:3px 8px;border-radius:6px;flex-wrap:wrap}
  .decl code{color:#79c0ff;min-width:280px}
  .decl span{color:#e6e9ef}
  .decl em{color:#6b7486;margin-left:auto;font-style:normal}
  .decl.win{background:rgba(124,255,178,.08)}
  .decl.win code{color:#7CFFB2}
  .decl.ov{opacity:.55}
  .decl.ov code,.decl.ov span{text-decoration:line-through}
  .missing,.none{color:#ff6b6b}
  </style><h1>/inbox Cascade Ownership Audit — winning rule per property (green = winner, struck = overridden)</h1>${blocks}`
}
