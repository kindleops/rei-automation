#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = '/Users/ryankindle/rei-automation'
const DASHBOARD_SRC = path.join(ROOT, 'apps/dashboard/src')
const BACKEND_CLIENT = path.join(ROOT, 'apps/dashboard/src/lib/api/backendClient.ts')

const REQUIRED_ENDPOINTS = [
  'POST /api/cockpit/queue/approve',
  'POST /api/cockpit/queue/cancel',
  'POST /api/cockpit/queue/retry',
  'POST /api/cockpit/queue/hold',
  'POST /api/cockpit/queue/reschedule',
  'POST /api/cockpit/queue/retry-routing',
  'POST /api/cockpit/inbox/queue-reply',
  'POST /api/cockpit/inbox/send-now',
  'POST /api/cockpit/inbox/schedule-reply',
  'POST /api/cockpit/inbox/auto-reply',
  'PATCH /api/cockpit/inbox/thread-state',
  'GET /api/cockpit/health',
  'GET /api/cockpit/queue/status',
  'GET /api/cockpit/inbox/live',
]

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo'])
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name)))
      continue
    }
    if (EXTS.has(path.extname(entry.name))) out.push(path.join(dir, entry.name))
  }
  return out
}

function rel(p) {
  return path.relative(ROOT, p)
}

function findAllLineMatches(text, regex) {
  const results = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (regex.test(lines[i])) results.push({ line: i + 1, text: lines[i].trim() })
  }
  return results
}

const backendClientText = fs.readFileSync(BACKEND_CLIENT, 'utf8')
const missingEndpoints = REQUIRED_ENDPOINTS.filter((entry) => {
  const [, endpoint] = entry.split(' ')
  return !backendClientText.includes(endpoint)
})

const files = walk(DASHBOARD_SRC)
const oldInternalMutationRefs = []
const directActionFetches = []
const fakeSuccessSignals = []
const backendClientCalls = []

const INTERNAL_MUTATION_RE = /\/api\/internal\/(queue|inbox)\//
const DIRECT_ACTION_FETCH_RE = /fetch\(\s*['"`]\/api\/(cockpit|internal)\/(queue|inbox)\//
const FAKE_SUCCESS_RE = /(success via backend|SUCCESS via backend|queued successfully|action completed)/i
const BACKEND_CLIENT_CALL_RE = /backendClient\.[a-zA-Z0-9_]+\(/g

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const relPath = rel(file)

  if (relPath.endsWith('src/lib/api/backendClient.ts')) continue

  const internalMatches = findAllLineMatches(text, INTERNAL_MUTATION_RE)
  for (const match of internalMatches) {
    oldInternalMutationRefs.push({ file: relPath, ...match })
  }

  const fetchMatches = findAllLineMatches(text, DIRECT_ACTION_FETCH_RE)
  for (const match of fetchMatches) {
    directActionFetches.push({ file: relPath, ...match })
  }

  const bcCalls = findAllLineMatches(text, BACKEND_CLIENT_CALL_RE)
  for (const match of bcCalls) {
    backendClientCalls.push({ file: relPath, ...match })
  }

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (!FAKE_SUCCESS_RE.test(lines[i])) continue
    if (/console\.(log|info|debug)\(/.test(lines[i])) continue
    const windowStart = Math.max(0, i - 12)
    const windowText = lines.slice(windowStart, i + 1).join('\n')
    if (!/!\s*[a-zA-Z0-9_]+\.ok/.test(windowText) && !/throw new Error/.test(windowText)) {
      fakeSuccessSignals.push({ file: relPath, line: i + 1, text: lines[i].trim() })
    }
  }
}

console.log('Dashboard Cockpit Wiring Proof')
console.log('================================')
console.log(`Required endpoint mappings found: ${REQUIRED_ENDPOINTS.length - missingEndpoints.length}/${REQUIRED_ENDPOINTS.length}`)
if (missingEndpoints.length > 0) {
  console.log('Missing required endpoint mappings:')
  for (const miss of missingEndpoints) console.log(`  - ${miss}`)
}

console.log(`\nbackendClient action callsites found: ${backendClientCalls.length}`)
console.log(`old /api/internal queue|inbox refs in src: ${oldInternalMutationRefs.length}`)
console.log(`direct fetch action calls in src: ${directActionFetches.length}`)
console.log(`potential fake-success signals: ${fakeSuccessSignals.length}`)

function printBucket(title, entries, limit = 40) {
  if (entries.length === 0) return
  console.log(`\n${title}:`)
  for (const row of entries.slice(0, limit)) {
    console.log(`  - ${row.file}:${row.line} :: ${row.text}`)
  }
  if (entries.length > limit) console.log(`  ... ${entries.length - limit} more`)
}

printBucket('Old internal mutation references', oldInternalMutationRefs)
printBucket('Direct action fetches (should use backendClient)', directActionFetches)
printBucket('Potential fake-success strings', fakeSuccessSignals)

if (missingEndpoints.length > 0 || oldInternalMutationRefs.length > 0 || directActionFetches.length > 0 || fakeSuccessSignals.length > 0) {
  process.exitCode = 1
} else {
  console.log('\nPASS: Dashboard cockpit wiring checks passed.')
}
