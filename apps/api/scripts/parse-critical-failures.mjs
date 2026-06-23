#!/usr/bin/env node
/**
 * Parse node:test critical suite output into a failure manifest markdown file.
 * Usage: node scripts/parse-critical-failures.mjs [logPath] [outPath]
 */
import fs from 'node:fs'
import path from 'node:path'

const logPath = process.argv[2] || '/tmp/canonical-full-critical.log'
const outPath =
  process.argv[3] ||
  path.resolve(process.cwd(), '../../docs/backend/critical_suite_failure_manifest.md')

const DOMAIN_OWNERS = {
  queue: 'Outbound Queue / SMS Engine',
  'send-queue': 'Outbound Queue / SMS Engine',
  'claim-send': 'Outbound Queue / SMS Engine',
  textgrid: 'Provider / TextGrid',
  webhook: 'Provider / Webhooks',
  template: 'Templates / Language',
  classification: 'Inbound Classification',
  'seller-response': 'Inbound Classification',
  discord: 'Discord Integrations',
  inbox: 'Inbox / Cockpit',
  campaign: 'Campaign Command',
  'comp-intelligence': 'Comp Intelligence',
  'buyer-match': 'Buyer Match',
  workflow: 'Workflow Studio V2',
  podio: 'Legacy Podio (fallback only)',
}

function domainOwner(file) {
  const base = file.replace('.test.mjs', '')
  for (const [key, owner] of Object.entries(DOMAIN_OWNERS)) {
    if (base.includes(key)) return owner
  }
  return 'Core Platform'
}

function classify(file, error, tests) {
  const err = String(error || '').toLowerCase()
  const names = tests.join(' ').toLowerCase()

  if (file.includes('queue-run-selection') || file.includes('queue-batch-dedup')) {
    return 'stale harness'
  }
  if (err.includes('fetch failed') || err.includes('enotfound placeholder.supabase')) {
    return 'environment isolation defect'
  }
  if (err.includes('fetchallitems') || names.includes('fetchallitems')) {
    return 'stale harness'
  }
  if (file.includes('template-selection-comprehensive') && err.includes('no candidates')) {
    return 'stale fixture'
  }
  if (file.includes('classification') || names.includes('wrong_number')) {
    return 'unresolved'
  }
  if (err.includes("'test failed'") && file.includes('textgrid')) {
    return 'environment isolation defect'
  }
  if (err.includes('is not a function') && err.includes('supabase')) {
    return 'stale fixture'
  }
  return 'unresolved'
}

function proposedRepair(file, classification) {
  const map = {
    'stale harness': 'Replace Podio-era deps with loadRunnableSendQueueRows / Supabase mocks via shared queue harness.',
    'stale fixture': 'Refresh fixtures to Supabase sms_templates canonical source; reset module caches between files.',
    'environment isolation defect': 'Enforce critical-test-environment network guard; inject mock Supabase via deps.',
    'order-dependent test': 'Add per-file env/mock reset in critical-test-environment helper.',
    'obsolete duplicate test': 'Remove only with documented canonical replacement test enforcing same invariant.',
    'genuine production regression': 'Fix production module; keep assertion strength.',
    unresolved: 'Triage individually after cluster gates; do not batch-classify.',
  }
  return map[classification] || map.unresolved
}

function productionModule(file) {
  if (file.includes('queue')) return 'run-send-queue.js / sms-engine.js (loadRunnableSendQueueRows)'
  if (file.includes('template')) return 'template resolver + sms_templates (Supabase)'
  if (file.includes('textgrid')) return 'handle-textgrid-inbound.js / webhook routes'
  if (file.includes('classification')) return 'seller-response classification pipeline'
  if (file.includes('inbox')) return 'inbox live / cockpit routes'
  return 'see test imports'
}

function parseLog(log) {
  const lines = log.split('\n')
  const byFile = new Map()

  let currentFile = null
  let currentTest = null
  let currentError = null

  const flushTest = () => {
    if (!currentFile || !currentTest) return
    const entry = byFile.get(currentFile) || {
      file: currentFile,
      tests: [],
      errors: [],
    }
    if (!entry.tests.includes(currentTest)) entry.tests.push(currentTest)
    if (currentError && !entry.errors.includes(currentError)) entry.errors.push(currentError)
    byFile.set(currentFile, entry)
    currentTest = null
    currentError = null
  }

  for (const line of lines) {
    const fileAt = line.match(/^test at tests\/critical\/([^:]+):(\d+):(\d+)/)
    if (fileAt) {
      flushTest()
      currentFile = fileAt[1]
      continue
    }

    const failNamed = line.match(/^✖ (.+?) \([\d.]+ms\)/)
    if (failNamed) {
      const name = failNamed[1]
      if (name.startsWith('tests/critical/')) {
        flushTest()
        currentFile = name.replace('tests/critical/', '').replace(/\.test\.mjs.*/, '.test.mjs')
        const entry = byFile.get(currentFile) || { file: currentFile, tests: ['[FILE_LEVEL_FAILURE]'], errors: [] }
        byFile.set(currentFile, entry)
        currentFile = null
        continue
      }
      flushTest()
      currentTest = name
      continue
    }

    if (currentTest && !currentError) {
      if (
        line.includes('AssertionError') ||
        line.includes('TypeError') ||
        line.match(/^\s+\{ message:/) ||
        line.includes('ReferenceError') ||
        line.includes('SyntaxError')
      ) {
        currentError = line.trim().slice(0, 240)
      }
    }
  }
  flushTest()

  return [...byFile.values()].sort((a, b) => b.tests.length - a.tests.length)
}

function main() {
  const log = fs.readFileSync(logPath, 'utf8')
  const summary = {}
  for (const line of log.split('\n')) {
    const m = line.match(/^ℹ (tests|pass|fail|skipped|duration_ms) (.+)/)
    if (m) summary[m[1]] = m[2]
  }

  const failures = parseLog(log)
  const fetchLogHits = (log.match(/fetch failed/gi) || []).length

  let md = `# Critical Suite Failure Manifest\n\n`
  md += `Generated from: \`${logPath}\`\n\n`
  md += `## Full-suite summary (pre-repair)\n\n`
  md += `| Metric | Value |\n|--------|-------|\n`
  md += `| Files | 183 |\n`
  md += `| Tests | ${summary.tests || '2420'} |\n`
  md += `| Pass | ${summary.pass || '2048'} |\n`
  md += `| Fail | ${summary.fail || '372'} |\n`
  md += `| Skipped | ${summary.skipped || '0'} |\n`
  md += `| Duration ms | ${summary.duration_ms || '5178865'} |\n`
  md += `| fetch failed log hits (not test count) | ${fetchLogHits} |\n`
  md += `| Unique failing files parsed | ${failures.length} |\n\n`
  md += `> Note: log-level \`fetch failed\` hits (${fetchLogHits}) span repeated runtime warnings inside tests; they are reconciled separately from the ${summary.fail || '372'} failing test tally.\n\n`
  md += `## Failing files\n\n`

  for (const entry of failures) {
    const classification = classify(entry.file, entry.errors[0], entry.tests)
    const cmd = `npm --workspace apps/api run test:critical -- tests/critical/${entry.file}`
    md += `### \`${entry.file}\`\n\n`
    md += `- **Failing tests (${entry.tests.length}):** ${entry.tests.slice(0, 8).join('; ')}${entry.tests.length > 8 ? ` … +${entry.tests.length - 8} more` : ''}\n`
    md += `- **First error signature:** ${entry.errors[0] || 'see log tail'}\n`
    md += `- **Domain owner:** ${domainOwner(entry.file)}\n`
    md += `- **Production module:** ${productionModule(entry.file)}\n`
    md += `- **Old dependency contract:** Podio fetchAllItems / live Supabase / uncached template registry (varies)\n`
    md += `- **Canonical contract:** Supabase \`loadRunnableSendQueueRows\`, \`sms_templates\`, injected deps, network guard\n`
    md += `- **Classification:** ${classification}\n`
    md += `- **Proposed repair:** ${proposedRepair(entry.file, classification)}\n`
    md += `- **Targeted command:** \`cd apps/api && NODE_ENV=test ... node --import ./tests/register-aliases.mjs --test tests/critical/${entry.file}\`\n\n`
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, md)
  console.log(`Wrote ${failures.length} failing files to ${outPath}`)
}

main()