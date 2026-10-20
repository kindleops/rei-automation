// rc-8.5.21 final integration: one file per migration VERSION in supabase/migrations (Supabase history keys
// on the version; two migrations with one stamp collide on a production apply).
import test from 'node:test'
import assert from 'node:assert/strict'

import { ALLOWLIST, findDuplicateVersions, scanDir, scanDuplicateVersions } from '../../../../scripts/db/scan-duplicate-migration-versions.mjs'

test('supabase/migrations: no duplicate migration version outside the frozen pre-existing allowlist', () => {
  const r = scanDir()
  assert.ok(r.checked > 100, `${r.checked} migration files read`)
  assert.deepEqual(r.findings, [], r.findings.map((f) => `[${f.rule}] ${f.version}: ${f.detail}`).join('\n'))
})

test('the rc-8.5.21 renumbers hold: 20261014120000 and 20261013160000 each carry ONE migration', () => {
  const dups = new Map(scanDir().duplicates.map((d) => [d.version, d.migrations]))
  assert.equal(dups.has('20261014120000'), false, String(dups.get('20261014120000')))
  assert.equal(dups.has('20261013160000'), false, String(dups.get('20261013160000')))
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
