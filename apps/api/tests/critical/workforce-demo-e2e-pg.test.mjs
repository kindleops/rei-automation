// Workforce Phase A — the FIRST DEMONSTRATION as a repeatable test (scripts/workforce/demo-opportunity-triage.mjs):
// a fresh disposable PostgreSQL database with the real schema chain + seed, synthetic production-shaped domain
// inputs through the read-only services seam, the CEO directive through the real POST /command handler, the real
// runtime tick to completion with a crash-recovery segment, and the CEO's decision through the resolve route.
// Every proof check of the report must pass; the report's honesty is re-verified here from the raw rows.
// Skipped (reported, never vacuous) without AGENT_PG_TEST_DB_URL (a disposable local PostgreSQL 17).
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason, ADMIN_URL } from '../pg/agent-pg-harness.mjs'
import { runOpportunityTriageDemo, DEMO_OWNER, READ_SERVICES } from '../../scripts/workforce/demo-opportunity-triage.mjs'
import { isTerminalSuccess, verifyReportHonesty } from '../../src/lib/workforce/engine/report.js'

const skip = pgAvailable() ? false : skipReason

test('the first demonstration: directive → plan → dispatch (with a crash) → report → CEO decision, on PostgreSQL; nothing sent, offered or staged', { skip, timeout: 480_000 }, async () => {
  const r = await runOpportunityTriageDemo({ adminUrl: ADMIN_URL })
  const failed = r.checks.filter((c) => !c.ok)
  assert.deepEqual(failed, [], `failed checks: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}`)
  const { mission, all, report, jobs, calls } = r.report
  assert.equal(mission.status, 'completed')
  assert.equal(mission.plan_version, 3)
  // the report, re-verified from the rows
  assert.deepEqual(verifyReportHonesty(report, all), [])
  const byId = new Map(all.map((a) => [a.assignment_id, a]))
  for (const c of report.completed) assert.ok(isTerminalSuccess(byId.get(c.assignment_id)), c.step)
  assert.equal(report.ranked.length, 10)
  for (const x of report.ranked) {
    if (x.ev.status !== 'known') assert.equal(x.ev.value, null, 'an unknown EV is never a number')
    if (x.next_action) assert.ok(isTerminalSuccess(byId.get(x.next_assignment_id)))
  }
  assert.ok(report.ranked.some((x) => x.ev.status === 'known') && report.ranked.some((x) => x.ev.status === 'unknown'), 'EV known only where calibrated (Dallas)')
  assert.ok(report.escalations.some((e) => e.reasons.includes('EXEC_REVIEW_PRICE')))
  // nothing ran but Workforce and the research kind, all accountable to the named owner
  assert.ok(jobs.every((j) => (j.kind.startsWith('workforce.') || j.kind === 'property.research') && j.requested_by === DEMO_OWNER))
  assert.ok(Object.keys(calls).every((k) => READ_SERVICES.includes(k)))
  // the structure is stable (the CLI compares fingerprints across runs; here the shape is pinned)
  assert.equal(r.structure.plan_steps, 103)
  assert.deepEqual(r.structure.excluded_at_pool, { held: 1, closed: 1, suppressed: 1, no_property: 0, never_revive: 1, out_of_scope: 0 })
  assert.equal(r.structure.ceo_decision.join(','), '200,completed,true')
})
