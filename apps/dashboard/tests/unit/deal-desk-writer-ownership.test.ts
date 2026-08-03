/**
 * N.2 — structural proof that each canonical field has ONE mutation owner.
 *
 * Behavioural tests can only show that the writers they know about behave. This one scans
 * the source tree, so a NEW independent writer added later fails the suite instead of
 * silently reintroducing the defect this lane removed.
 *
 * Scope is the Deal Desk surface: `src/modules/inbox/**` and
 * `src/modules/deal-intelligence/**`. Writers outside that surface are enumerated
 * explicitly below with the reason each is not a control writer.
 *
 * Run with `npx tsx --test apps/dashboard/tests/unit/deal-desk-writer-ownership.test.ts`.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

const relative = (file: string) => path.relative(SRC, file).split(path.sep).join('/')
const read = (file: string) => readFileSync(file, 'utf8')
const allFiles = walk(SRC)

const dealDeskFiles = allFiles.filter((file) => {
  const rel = relative(file)
  return rel.startsWith('modules/inbox/') || rel.startsWith('modules/deal-intelligence/')
})

/**
 * Strip block and line comments before scanning.
 *
 * Without this the scan reports its own explanatory comments — several of which name the
 * very writers they document as removed — and would never fail for a real reason.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ── one instantiation of the controls hook ───────────────────────────────────

test('useDealDeskThreadControls is instantiated in exactly one place', () => {
  const callers = allFiles.filter((file) => {
    const rel = relative(file)
    if (rel === 'modules/inbox/useDealDeskThreadControls.ts') return false
    return /useDealDeskThreadControls\s*\(/.test(stripComments(read(file)))
  }).map(relative)

  assert.deepEqual(callers, ['modules/inbox/DealDeskControlsProvider.tsx'],
    'a second call site would create a second in-flight state for the same fields')
})

// ── no second transport for a canonical field ────────────────────────────────

const CANONICAL_FIELD_KEYS = [
  'lifecycle_stage',
  'operational_status',
  'lead_temperature',
  'automation_state',
  'autopilot_mode',
  'is_read',
] as const

/**
 * The only modules permitted to name a canonical field in a write payload.
 *
 * `deal-desk-control-contract.ts` builds the payloads; `persistDealDeskControlField.ts`
 * sends them; `useDealDeskThreadControls.ts` and `deal-desk-controls-context.ts` route to
 * them. Everything else must go through those.
 */
const PAYLOAD_OWNERS = new Set([
  'modules/inbox/persistDealDeskControlField.ts',
  'modules/inbox/useDealDeskThreadControls.ts',
  'modules/inbox/deal-desk-controls-context.ts',
])

/** A `patchLeadStateFromView(...)` / `persistUniversalLeadState(...)` call site. */
const callsLeadStateTransport = (source: string): boolean =>
  /\b(patchLeadStateFromView|persistUniversalLeadState|updateThreadState|patchUniversalLeadState)\s*\(/
    .test(source)

test('no Deal Desk surface calls the lead-state transport outside the canonical writer', () => {
  const offenders = dealDeskFiles.filter((file) => {
    const rel = relative(file)
    if (PAYLOAD_OWNERS.has(rel)) return false
    return callsLeadStateTransport(stripComments(read(file)))
  }).map(relative)

  // `DealIntelligenceLeadStateBar.tsx` still calls the transport for star / pin / archive /
  // snooze / manual-lock — flag dimensions this lane does not own. It must NOT write any
  // canonical control field; that is asserted separately below.
  assert.deepEqual(offenders, ['modules/deal-intelligence/DealIntelligenceLeadStateBar.tsx'],
    'a new transport call site on the Deal Desk surface is a second writer')
})

test('no Deal Desk surface outside the payload owners names a canonical field in a patch', () => {
  const violations: string[] = []
  for (const file of dealDeskFiles) {
    const rel = relative(file)
    if (PAYLOAD_OWNERS.has(rel)) continue
    const source = stripComments(read(file))
    if (!callsLeadStateTransport(source)) continue
    for (const field of CANONICAL_FIELD_KEYS) {
      // Only an object-literal assignment counts (`operational_status: 'x'`), not a type
      // declaration (`operational_status?: string | null`) or a property read.
      const assignment = new RegExp(`(^|[{,\\s])${field}\\s*:\\s*(?!string|boolean|number|unknown)`, 'm')
      if (assignment.test(source)) violations.push(`${rel} → ${field}`)
    }
  }
  assert.deepEqual(violations, [],
    'a canonical field written outside the control contract is a second owner')
})

// ── the removed writers stay removed ─────────────────────────────────────────

test('the legacy per-field writers are no longer wired into the Deal Desk surface', () => {
  const removed = ['updateThreadStage', 'updateThreadStatus', 'markThreadRead', 'markThreadUnread',
    'markThreadHot', 'pauseAutomation', 'resumeAutomation']
  const violations: string[] = []
  for (const file of dealDeskFiles) {
    const source = stripComments(read(file))
    for (const symbol of removed) {
      if (new RegExp(`\\b${symbol}\\s*\\(`).test(source)) violations.push(`${relative(file)} → ${symbol}`)
    }
  }
  assert.deepEqual(violations, [])
})

test('the intelligence panel no longer plumbs status/stage writer callbacks', () => {
  const source = stripComments(read(path.join(SRC, 'modules/inbox/components/IntelligencePanel.tsx')))
  assert.doesNotMatch(source, /onStatusChange/, 'the WorkflowControl writer prop is gone')
  assert.doesNotMatch(source, /onStageChange/, 'the SellerCommandCard writer prop is gone')
})

test('no thread-state write anywhere uses autopilot_mode as a target', () => {
  // `autopilot_mode` is a view alias on `canonical_inbox_threads`, not a column, so
  // `buildRowPatch` has no branch for it: a write naming it is accepted and dropped.
  //
  // Scoped to files that call the lead-state transport. `templateIntelligenceData.ts` and
  // `template-intelligence.types.ts` also use the name, but as a query-string FILTER on
  // the template-analytics endpoint — a different concept from thread state, and never a
  // patch target.
  const violations: string[] = []
  for (const file of allFiles) {
    const source = stripComments(read(file))
    if (!callsLeadStateTransport(source)) continue
    if (/(^|[{,\s])autopilot_mode\s*:\s*(?!string|boolean|number|unknown)/m.test(source)) {
      violations.push(relative(file))
    }
  }
  assert.deepEqual(violations, [])
})

// ── the local optimistic-field pattern is gone ───────────────────────────────

test('the useOptimisticField pattern no longer exists on the Deal Desk surface', () => {
  const violations = dealDeskFiles
    .filter((file) => /function\s+useOptimisticField/.test(stripComments(read(file))))
    .map(relative)
  assert.deepEqual(violations, [],
    'it reassigned previousRef on every commit, so a rollback restored an optimistic value')
})

test('the canonical controls are consumed, not re-implemented, by every other surface', () => {
  const consumers = dealDeskFiles
    .filter((file) => /useDealDeskControlsForThread\s*\(/.test(stripComments(read(file))))
    .map(relative)
    .sort()

  assert.deepEqual(consumers, [
    'modules/deal-intelligence/DealIntelligenceLeadStateBar.tsx',
    'modules/inbox/components/IntelligencePanel.tsx',
    'modules/inbox/components/ThreadStateBar.tsx',
  ], 'every surface that shows canonical state reads it from the one owner')
})
