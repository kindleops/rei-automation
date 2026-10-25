// rc-8.5.21 final integration: one file per migration VERSION in supabase/migrations (Supabase history keys
// on the version; two migrations with one stamp collide on a production apply).
import test from 'node:test'
import assert from 'node:assert/strict'

import { ALLOWLIST, RESERVED, findDuplicateVersions, scanDir, scanDuplicateVersions } from '../../../../scripts/db/scan-duplicate-migration-versions.mjs'

test('supabase/migrations: no duplicate migration version outside the frozen pre-existing allowlist', () => {
  const r = scanDir()
  assert.ok(r.checked > 100, `${r.checked} migration files read`)
  assert.deepEqual(r.findings, [], r.findings.map((f) => `[${f.rule}] ${f.version}: ${f.detail}`).join('\n'))
})

test('the rc-8.5.21 renumbers hold: 20261014120000 and 20261013160000 each carry ONE migration', () => {
  const dups = new Map(scanDir().duplicates.map((d) => [d.version, d.migrations]))
  assert.equal(dups.has('20261014120000'), false, String(dups.get('20261014120000')))
  assert.equal(dups.has('20261013160000'), false, String(dups.get('20261013160000')))
  // resolved 2026-10-20 from production history: the recorded version, and the later-added unapplied member
  assert.equal(dups.has('20261007170000'), false, String(dups.get('20261007170000')))
  assert.equal(dups.has('20261007120000'), false, String(dups.get('20261007120000')))
  assert.equal(dups.has('20261006150000'), false, String(dups.get('20261006150000')))
  assert.deepEqual(Object.keys(ALLOWLIST).sort(), ['20261010120000', '20261010130000'])
  // no rc-8.5.21 chain stamp is allowlisted
  for (const v of ['20261012140000', '20261013160000', '20261014120000', '20261015110000', '20261016200000', '20261017120000', '20261019120000', '20261019150000']) assert.equal(Object.hasOwn(ALLOWLIST, v), false, v)
})

test('companions are not duplicates; two distinct migrations are; a stale allowlist entry fails', () => {
  const companions = ['PROPOSED_20261099000000_x.sql', 'PROPOSED_20261099000000_x_pretest.sql', 'PROPOSED_20261099000000_x_posttest.sql', 'PROPOSED_20261099000000_x_rollback.sql', 'PROPOSED_20261099000000_x_rollback_posttest.sql', 'PROPOSED_20261099000000_x_verify.sql', 'PROPOSED_20261099000000_x_dryrun.sql']
  assert.deepEqual(findDuplicateVersions(companions), [])
  const collide = ['PROPOSED_20261099000000_a.sql', 'PROPOSED_20261099000000_b.sql', 'PROPOSED_20261099000000_b_pretest.sql', '20261099000000_c.sql', 'README.md']
  assert.deepEqual(findDuplicateVersions(collide), [{ version: '20261099000000', migrations: ['20261099000000_c.sql', 'PROPOSED_20261099000000_a.sql', 'PROPOSED_20261099000000_b.sql'] }])
  const r = scanDuplicateVersions({ names: collide, allowlist: { '20261088000000': 'gone' } })
  assert.deepEqual(r.findings.map((f) => `${f.rule}:${f.version}`), ['duplicate-version:20261099000000', 'stale-allowlist:20261088000000'])
  assert.deepEqual(scanDuplicateVersions({ names: collide, allowlist: { '20261099000000': 'pre-existing' } }).findings, [])
})

test('stamps reserved by another release branch are never reused here by a DIFFERENT migration (the 20261020120000 collision)', () => {
  assert.deepEqual(scanDir().findings.filter((f) => f.rule === 'reserved-version'), [])
  const clash = scanDuplicateVersions({ names: ['PROPOSED_20261020120000_inbox_bucket_views_declined_unverified.sql'], allowlist: {} })
  assert.deepEqual(clash.findings.map((f) => f.rule), ['reserved-version'])
  const same = scanDuplicateVersions({ names: ['PROPOSED_20261020120000_research_event_budget_ceilings.sql', 'PROPOSED_20261020120000_research_event_budget_ceilings_rollback.sql'], allowlist: {} })
  assert.deepEqual(same.findings, [], 'the reserved migration itself (and its companions) arriving by a merge is fine')
  assert.ok(Object.keys(RESERVED).every((v) => /^\d{14}$/.test(v)))
})
