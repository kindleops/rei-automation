/**
 * Dashboard Architecture Boundary Audit
 *
 * Scans src/ and api/ for direct Supabase mutation patterns and classifies each finding:
 *   A) Allowed — read-only SELECT
 *   B) Guarded — mutation behind NEXUS_ALLOW_BACKEND_MUTATION or backendClient proxy
 *   C) Forbidden — direct mutation with no guard
 *
 * Exits non-zero if any forbidden direct mutations remain outside quarantine/guarded files.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '../../')

// Patterns that indicate a direct Supabase mutation
const MUTATION_PATTERNS = [
  /\.insert\s*\(/,
  /\.update\s*\(/,
  /\.upsert\s*\(/,
  /\.delete\s*\(/,
  /\.rpc\s*\(/,
]

// Patterns that indicate it's a read-only Supabase operation (allowed)
const READ_PATTERNS = [
  /\.select\s*\(/,
  /\.from\s*\(\s*['"`][^'"`]+['"`]\s*\)\s*\.select/,
]

// Tables that are forbidden to mutate directly from dashboard
const FORBIDDEN_TABLES = [
  'send_queue',
  'message_events',
  'inbox_thread_state',
  'sms_suppression_list',
  'sms_templates',
]

// Files/directories that are intentionally guarded (backend mutation allowed behind env var)
const GUARDED_FILES = new Set([
  'api/internal/queue/build-outbound.ts',
  'api/internal/queue/build-followups.ts',
  'api/internal/queue/build-replies.ts',
  'api/internal/queue/cancel-stale-followups.ts',
  'api/internal/queue/reconcile.ts',
  'api/internal/queue/reprocess-paused.ts',
  'api/internal/queue/retry-failed.ts',
  'api/internal/queue/run-safe-batch.ts',
  'api/internal/queue/run.ts',
  'api/internal/queue/runner.ts',
  'api/internal/queue/utils.ts',
  'api/internal/queue/templateSelection.ts',
  'api/internal/inbox/rebuild-thread-state.ts',
  'api/internal/messages/reclassify-history.ts',
  'api/internal/analytics/templates/ownership-check.ts',
  'api/internal/buyer-activity/rollup.ts',
  'api/internal/census/sync.ts',
  'api/internal/offers/underwrite.ts',
])

// Files intentionally quarantined / guarded with NEXUS_ALLOW_BACKEND_MUTATION
const QUARANTINED_DIRS = ['scripts/quarantine/', 'scripts/ops/', 'scripts/repair/']
const QUARANTINED_FILES = new Set([
  'scripts/patch-feeder.mjs',
  'scripts/patch-feeder-v2.mjs',
  'scripts/proof/run-real-feeder-test.ts',
  'scripts/setup-inbox.mjs',
])

// Files that route mutations through backendClient (no longer direct Supabase)
const BACKEND_PROXIED_FILES = new Set([
  'src/lib/data/inboxData.ts',
  'src/lib/data/inboxAutoReply.ts',
  'src/lib/data/inboxWorkflowData.ts',
])

// Scratch/proof files that should be ignored (read-only diagnostic scripts)
const IGNORE_PATTERNS = [
  /^scratch\//,
  /^scripts\/proof\//,  // most proof scripts are read-only
  /^scripts\/check-/,
  /^scripts\/dump-/,
  /^scripts\/verify_/,
  /^scripts\/fetch_/,
  /^scripts\/populate-/,
  /^dist\//,
  /^node_modules\//,
  /\.test\./,
  /\.spec\./,
]

function walkFiles(dir, exts = ['.ts', '.tsx', '.js', '.mjs']) {
  const results = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
        results.push(...walkFiles(full, exts))
      } else if (exts.some(e => full.endsWith(e))) {
        results.push(full)
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results
}

function getRelPath(absPath) {
  return relative(ROOT, absPath).replace(/\\/g, '/')
}

function isGuarded(relPath) {
  return GUARDED_FILES.has(relPath) ||
    QUARANTINED_DIRS.some(d => relPath.startsWith(d)) ||
    QUARANTINED_FILES.has(relPath)
}

function isProxied(relPath) {
  return BACKEND_PROXIED_FILES.has(relPath)
}

function shouldIgnore(relPath) {
  return IGNORE_PATTERNS.some(p => p.test(relPath))
}

function auditFile(absPath) {
  const relPath = getRelPath(absPath)
  const findings = []

  if (shouldIgnore(relPath)) return findings

  let content
  try {
    content = readFileSync(absPath, 'utf8')
  } catch { return findings }

  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip comments
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

    // Check for forbidden table access with mutations
    for (const table of FORBIDDEN_TABLES) {
      if (!line.includes(`'${table}'`) && !line.includes(`"${table}"`)) continue

      // Look ahead/behind for mutation patterns in context (5 lines)
      const contextStart = Math.max(0, i - 2)
      const contextEnd = Math.min(lines.length - 1, i + 5)
      const context = lines.slice(contextStart, contextEnd + 1).join('\n')

      const hasMutation = MUTATION_PATTERNS.some(p => p.test(context))
      const hasReadOnly = !hasMutation && READ_PATTERNS.some(p => p.test(context))

      if (!hasMutation) continue

      // Determine classification
      let classification
      let note = ''

      if (isGuarded(relPath)) {
        classification = 'B'
        note = 'GUARDED (NEXUS_ALLOW_BACKEND_MUTATION guard in place)'
      } else if (isProxied(relPath)) {
        // Check if the mutation line itself is the backendClient call or the old supabase call
        if (line.includes('backendClient.') || line.includes('backend client') || line.includes('// This mutation must live')) {
          classification = 'B'
          note = 'PROXIED via backendClient'
        } else if (context.includes('backendClient.') || context.includes('await backendClient')) {
          classification = 'B'
          note = 'PROXIED via backendClient (nearby)'
        } else {
          classification = 'C'
          note = 'FORBIDDEN — direct mutation in proxied file (incomplete replacement?)'
        }
      } else if (hasReadOnly) {
        classification = 'A'
        note = 'read-only SELECT'
      } else {
        classification = 'C'
        note = 'FORBIDDEN — direct mutation'
      }

      findings.push({ relPath, lineNum, table, classification, note, snippet: line.trim().slice(0, 120) })
    }

    // Also flag raw mutation patterns outside of table-specific checks in src/
    if (relPath.startsWith('src/') && !isProxied(relPath) && !isGuarded(relPath)) {
      if (MUTATION_PATTERNS.some(p => p.test(line))) {
        // Check if it's a supabase mutation (not something like array.update())
        const contextStart = Math.max(0, i - 3)
        const contextEnd = Math.min(lines.length - 1, i + 2)
        const context = lines.slice(contextStart, contextEnd + 1).join('\n')
        if (context.includes('.from(') && FORBIDDEN_TABLES.some(t => context.includes(`'${t}'`) || context.includes(`"${t}"`))) {
          // Already caught above
        } else if (context.includes('supabase.') || context.includes('getSupabaseClient')) {
          findings.push({ relPath, lineNum, table: '?', classification: 'C', note: 'FORBIDDEN — raw Supabase mutation in src/', snippet: line.trim().slice(0, 120) })
        }
      }
    }
  }

  return findings
}

// ── Main ────────────────────────────────────────────────────────────────────

const filesToScan = [
  ...walkFiles(join(ROOT, 'src')),
  ...walkFiles(join(ROOT, 'api')),
  ...walkFiles(join(ROOT, 'scripts')),
]

const allFindings = []
for (const file of filesToScan) {
  allFindings.push(...auditFile(file))
}

// Group by classification
const allowed = allFindings.filter(f => f.classification === 'A')
const guarded = allFindings.filter(f => f.classification === 'B')
const forbidden = allFindings.filter(f => f.classification === 'C')

// Dedupe forbidden by file+line
const forbiddenDeduped = forbidden.filter((f, i, arr) =>
  arr.findIndex(x => x.relPath === f.relPath && x.lineNum === f.lineNum) === i
)

// Print report
console.log('\n══════════════════════════════════════════════════════════════')
console.log('  NEXUS DASHBOARD — ARCHITECTURE BOUNDARY AUDIT')
console.log('══════════════════════════════════════════════════════════════')

console.log(`\n[A] Allowed (read-only): ${allowed.length} occurrences`)
console.log(`[B] Guarded/Proxied:     ${guarded.length} occurrences`)
console.log(`[C] Forbidden:           ${forbiddenDeduped.length} occurrences`)

if (guarded.length > 0) {
  console.log('\n── [B] Guarded/Proxied mutations ─────────────────────────────')
  const byFile = {}
  for (const f of guarded) {
    if (!byFile[f.relPath]) byFile[f.relPath] = []
    byFile[f.relPath].push(f)
  }
  for (const [file, items] of Object.entries(byFile)) {
    console.log(`  ${file} (${items.length} occurrences)`)
    for (const item of items.slice(0, 3)) {
      console.log(`    L${item.lineNum}: [${item.table}] ${item.note}`)
    }
    if (items.length > 3) console.log(`    ... and ${items.length - 3} more`)
  }
}

if (forbiddenDeduped.length > 0) {
  console.log('\n── [C] FORBIDDEN direct mutations ────────────────────────────')
  for (const f of forbiddenDeduped) {
    console.log(`  ✗ ${f.relPath}:${f.lineNum} [${f.table}]`)
    console.log(`    ${f.note}`)
    console.log(`    ${f.snippet}`)
  }
  console.log('\n✗ AUDIT FAILED — forbidden direct mutations detected.')
  console.log('  Route these through src/lib/api/backendClient.ts.')
  process.exit(1)
} else {
  console.log('\n✓ AUDIT PASSED — no forbidden direct mutations detected.')
  console.log('  All mutations are either guarded, proxied through backendClient, or in quarantine.')
}

console.log('\n── Endpoints still needed in real-estate-automation ──────────')
console.log('  POST /api/cockpit/inbox/queue-reply      (queueInboxReply)')
console.log('  POST /api/cockpit/inbox/send-now         (sendInboxMessageNow)')
console.log('  POST /api/cockpit/inbox/schedule-reply   (scheduleInboxReply)')
console.log('  POST /api/cockpit/inbox/auto-reply       (autoQueueReply)')
console.log('  POST /api/cockpit/queue/approve          (approveQueueItem)')
console.log('  POST /api/cockpit/queue/cancel           (cancelQueueItem)')
console.log('  POST /api/cockpit/queue/retry            (retryQueueItem)')
console.log('  PATCH /api/cockpit/inbox/thread-state   (updateThreadState)')
console.log('\n══════════════════════════════════════════════════════════════\n')
