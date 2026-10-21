// Recorded production history (owner 2026-10-20): the two 2026-10-18 spatial_ref_sys migrations were applied in
// production out of band. The repo keeps them byte-for-byte as RECORDS. No chain, deploy plan, migration test or
// deploy tool may ever apply them.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  APPLIED_IN_PRODUCTION, APPLIED_MARKER, appliedInProductionReferences, assertNotAppliedInProduction, bodySha256, extractAppliedBody,
} from '../../../../scripts/db/applied-in-production.mjs'
import { MIGRATION_TESTS, APPLIED_IN_PRODUCTION as MANIFEST_APPLIED } from '../../../../scripts/db/migration-tests.manifest.mjs'
import { runMigrationTest } from '../../../../scripts/db/run-migration-test.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')

test('the two recorded files exist under their exact production versions, with the APPLIED / DO NOT RE-APPLY header and the verbatim body', () => {
  assert.deepEqual(APPLIED_IN_PRODUCTION.map((e) => `${e.version}_${e.name}`), [
    '20261018040156_revoke_public_writes_spatial_ref_sys',
    '20261018040244_guard_spatial_ref_sys_against_api_writes',
  ])
  for (const e of APPLIED_IN_PRODUCTION) {
    assert.equal(e.applied_in_production, true)
    assert.equal(e.file, `supabase/migrations/${e.version}_${e.name}.sql`)
    const src = read(e.file)
    const head = src.split('\n', 4).join('\n')
    assert.match(head, /APPLIED IN PRODUCTION 2026-10-18T04:0\d:\d\dZ/)
    assert.match(head, /DO NOT RE-APPLY/)
    assert.ok(src.split('\n').some((l) => l.trim() === APPLIED_MARKER), `${e.file}: header marker`)
    assert.match(src, /EFFECT:/)
    assert.match(src, /ROLLBACK:/)
    // the body between the markers is byte-identical to the statement production applied
    assert.equal(bodySha256(src), e.body_sha256, `${e.file}: applied body changed`)
  }
  // the effects the owner recorded
  assert.match(read(APPLIED_IN_PRODUCTION[0].file), /INEFFECTIVE[\s\S]*supabase_admin/)
  assert.match(read(APPLIED_IN_PRODUCTION[1].file), /EFFECTIVE\./)
  assert.match(extractAppliedBody(read(APPLIED_IN_PRODUCTION[0].file)), /^-- Security incident fix[\s\S]*REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.spatial_ref_sys FROM anon, authenticated;$/)
  assert.match(extractAppliedBody(read(APPLIED_IN_PRODUCTION[1].file)), /create trigger spatial_ref_sys_api_truncate_guard before truncate on public\.spatial_ref_sys\n {2}for each statement execute function public\.block_api_role_writes\(\);$/)
})

test('manifest: re-exports the registry, and no chain / test entry references a recorded production migration', () => {
  assert.equal(MANIFEST_APPLIED, APPLIED_IN_PRODUCTION)
  for (const t of MIGRATION_TESTS) assert.deepEqual(appliedInProductionReferences(t), [], `${t.id} names an applied-in-production file`)
  const text = read('scripts/db/migration-tests.manifest.mjs')
  for (const e of APPLIED_IN_PRODUCTION) assert.equal(text.includes(`${e.version}_${e.name}`), false, `manifest names ${e.file}`)
})

test('runner: an entry naming one is refused before any database is touched; applying one by path is refused', () => {
  for (const e of APPLIED_IN_PRODUCTION) {
    // a loopback URL that nothing listens on: the refusal must come first (no connection is attempted)
    const r = runMigrationTest({ id: 'x', setup: [], apply: [e.file], posttest: [], rollback: [] }, { adminUrl: 'postgres://nobody@127.0.0.1:1/none', log: () => {} })
    assert.equal(r.ok, false)
    assert.equal(r.refused, true)
    assert.match(r.error, /APPLIED IN PRODUCTION/)
    const r2 = runMigrationTest({ id: 'y', setup: [e.file], apply: [], posttest: [], rollback: [] }, { adminUrl: 'postgres://nobody@127.0.0.1:1/none', log: () => {} })
    assert.equal(r2.refused, true)
    assert.throws(() => assertNotAppliedInProduction(e.file), /APPLIED IN PRODUCTION/)
    assert.throws(() => assertNotAppliedInProduction(path.join(REPO, e.file)), /APPLIED IN PRODUCTION/)
  }
  // an ordinary PROPOSED file is not refused
  assert.doesNotThrow(() => assertNotAppliedInProduction('supabase/migrations/PROPOSED_20261019120000_payload_clean_opaque_ids.sql'))
})

test('no deploy tooling, workflow, script or chain apply-order row references them', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean)
  const allowed = new Set([
    'scripts/db/applied-in-production.mjs',
    'apps/api/tests/critical/applied-in-production-history.test.mjs',
    'docs/rc-8.5.21-migration-chain.md',
    ...APPLIED_IN_PRODUCTION.map((e) => e.file),
  ])
  const scope = tracked.filter((f) => /^(\.github\/|scripts\/|apps\/api\/scripts\/|apps\/api\/src\/|package\.json$|apps\/api\/package\.json$)/.test(f) && /\.(mjs|js|cjs|ts|sh|ya?ml|json|sql|py)$/.test(f))
  const hits = []
  for (const f of scope) {
    if (allowed.has(f) || !fs.existsSync(path.join(REPO, f))) continue
    const s = fs.readFileSync(path.join(REPO, f), 'utf8')
    for (const e of APPLIED_IN_PRODUCTION) if (s.includes(e.name) || s.includes(`${e.version}_`)) hits.push(`${f}: ${e.name}`)
  }
  assert.deepEqual(hits, [])
  // the chain doc lists them ONLY as recorded history, never in the production apply-order table
  const doc = read('docs/rc-8.5.21-migration-chain.md')
  const table = doc.slice(doc.indexOf('## Production apply order'), doc.indexOf('## Integration notes'))
  for (const e of APPLIED_IN_PRODUCTION) {
    assert.equal(table.includes(e.name), false, `${e.name} is in the apply-order table`)
    assert.ok(doc.includes(`${e.version}_${e.name}`), `${e.name} is recorded in the chain doc`)
  }
})
