#!/usr/bin/env node
/**
 * Campaign Builder — filter mapping lock-in proof.
 *
 * Static (no server / no DB) regression guard for the Phase-2 invariant:
 *   Every field the catalog flags supported_in_preview MUST resolve to a real
 *   campaign_target_graph column. Otherwise an operator can apply a filter that
 *   the backend silently skips ("Filter applied but no graph column mapping
 *   found."), and the funnel reports counts that ignored an active filter.
 *
 * It also asserts the inverse hygiene rule: anything that has NO graph column
 * (e.g. master_owner portfolio financials/distress/scores) must NOT be flagged
 * supported_in_preview — so the UI hides it instead of offering a dead filter.
 *
 * Usage: node scripts/proof/campaign-builder-filter-mapping-proof.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname)
const SERVICE = path.join(ROOT, 'apps/api/src/lib/domain/campaigns/campaign-automation-service.js')
const CATALOG = path.join(ROOT, 'apps/api/src/lib/domain/campaigns/campaign-field-catalog.js')

function readBlock(src, startMarker, maxLen = 6000) {
  const i = src.indexOf(startMarker)
  if (i < 0) throw new Error(`marker not found: ${startMarker}`)
  return src.slice(i, i + maxLen)
}

function extractQuotedFieldKeys(block) {
  const keys = new Set()
  for (const m of block.matchAll(/'([a-z_]+\.[a-z_0-9]+)'/g)) keys.add(m[1])
  return keys
}

function extractGraphColumnKeys(block) {
  const keys = new Set()
  for (const m of block.matchAll(/'([a-z_]+\.[a-z_0-9]+)':/g)) keys.add(m[1])
  return keys
}

const serviceSrc = fs.readFileSync(SERVICE, 'utf8')
const catalogSrc = fs.readFileSync(CATALOG, 'utf8')

// Catalog "approved for preview" set.
const previewSupported = extractQuotedFieldKeys(
  readBlock(catalogSrc, 'PREVIEW_SUPPORTED_FIELD_KEYS = new Set([')
)

// Graph column mapping (left-hand domain.column keys) + special-cased columns
// resolved in graphApplicationColumn().
const graphMapped = extractGraphColumnKeys(
  readBlock(serviceSrc, 'CAMPAIGN_TARGET_GRAPH_FILTER_COLUMNS = Object.freeze({')
)
graphMapped.add('sender_coverage.sender_coverage_status') // -> sender_covered
graphMapped.add('outreach.duplicate_queue_status') // -> active_queue_item

const approvedButSkipped = [...previewSupported].filter((k) => !graphMapped.has(k)).sort()

console.log(`PREVIEW_SUPPORTED fields: ${previewSupported.size}`)
console.log(`GRAPH_MAPPED columns:     ${graphMapped.size}`)

let failed = false
if (approvedButSkipped.length > 0) {
  failed = true
  console.error('\n❌ Approved fields with NO campaign_target_graph column (would be silently skipped):')
  for (const k of approvedButSkipped) console.error(`   - ${k}`)
} else {
  console.log('\n✅ Every preview-supported field maps to a campaign_target_graph column (zero skipped active filters).')
}

// Sanity: the known-unsupported portfolio fields must NOT be preview-supported.
const mustBeHidden = [
  'master_owners.portfolio_total_value',
  'master_owners.portfolio_total_equity',
  'master_owners.portfolio_total_loan_balance',
  'properties.seller_tags_json',
]
const leaked = mustBeHidden.filter((k) => previewSupported.has(k))
if (leaked.length > 0) {
  failed = true
  console.error('\n❌ Fields that must stay hidden are flagged supported_in_preview:')
  for (const k of leaked) console.error(`   - ${k}`)
} else {
  console.log('✅ Unsupported portfolio / unmapped fields remain hidden from the operator UI.')
}

if (failed) {
  console.error('\nPROOF FAILED')
  process.exit(1)
}
console.log('\nPROOF PASSED')
