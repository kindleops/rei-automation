#!/usr/bin/env node
/**
 * CSS Import Order Guard — RISK-013
 *
 * Enforces that nx-ui-foundation-final.css is the last CSS import in InboxPage.tsx.
 * Run: node scripts/check-css-import-order.mjs
 * Exit 1 on violation, exit 0 on pass.
 */

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const inboxPage = resolve(__dir, '../src/modules/inbox/InboxPage.tsx')

const src = readFileSync(inboxPage, 'utf8')
const lines = src.split('\n')

const REQUIRED_LAST = 'nx-ui-foundation-final.css'

// Collect all CSS import line indices
const cssImportIndices = []
lines.forEach((line, i) => {
  if (/^\s*import\s+['"].*\.css['"]/.test(line)) {
    cssImportIndices.push(i)
  }
})

if (cssImportIndices.length === 0) {
  console.error('ERROR: No CSS imports found in InboxPage.tsx')
  process.exit(1)
}

const lastCssIndex = cssImportIndices[cssImportIndices.length - 1]
const lastCssLine = lines[lastCssIndex]

if (!lastCssLine.includes(REQUIRED_LAST)) {
  console.error('FAIL — CSS import order violation in InboxPage.tsx')
  console.error(`  Expected last CSS import to contain: ${REQUIRED_LAST}`)
  console.error(`  Actual last CSS import (line ${lastCssIndex + 1}): ${lastCssLine.trim()}`)
  console.error('')
  console.error('All CSS imports in order:')
  cssImportIndices.forEach((idx) => {
    const marker = idx === lastCssIndex ? '>>> LAST' : '        '
    console.error(`  ${marker} L${idx + 1}: ${lines[idx].trim()}`)
  })
  process.exit(1)
}

console.log('PASS — nx-ui-foundation-final.css is the last CSS import in InboxPage.tsx')
console.log(`  (line ${lastCssIndex + 1}): ${lastCssLine.trim()}`)
process.exit(0)
