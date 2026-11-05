// RECORDED PRODUCTION HISTORY: migrations that were APPLIED IN PRODUCTION out of band, kept in the repo only so
// that the repository matches the production migration history (Supabase list_migrations keys on the version).
// They are records, never migrations to run. Every entry is `applied_in_production: true`:
//   - no chain, deploy plan or migration test may reference one (migration-tests.manifest.mjs re-exports this list;
//     tests/critical/applied-in-production-history.test.mjs proves no entry does);
//   - scripts/db/run-migration-test.mjs refuses a test entry that names one, and refuses to apply one by path or
//     by its header marker, before any database is touched.
// The file body between the BEGIN / END markers is byte-identical to the applied SQL; body_sha256 pins it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const APPLIED_MARKER = '-- lc-applied-in-production: true'
const BEGIN = '-- ===== BEGIN APPLIED SQL (verbatim) =====\n'
const END = '\n-- ===== END APPLIED SQL =====\n'

const SOURCE = 'Claude Code session in the Prominent Cash Offer website project (transcript 0310cd0a), Supabase MCP apply_migration'
export const APPLIED_IN_PRODUCTION = Object.freeze([
  Object.freeze({
    version: '20261018040156',
    name: 'revoke_public_writes_spatial_ref_sys',
    file: 'supabase/migrations/20261018040156_revoke_public_writes_spatial_ref_sys.sql',
    applied_in_production: true,
    applied_at_utc: '2026-10-18T04:01:55Z',
    source: SOURCE,
    effect: 'INEFFECTIVE: the anon/authenticated write grants are supabase_admin\'s; postgres cannot revoke them',
    body_sha256: '6a273b6b20ee799942d7483bfe9b46c6db7bd5d4031a2ad18cba2097811f640d',
  }),
  Object.freeze({
    version: '20261018040244',
    name: 'guard_spatial_ref_sys_against_api_writes',
    file: 'supabase/migrations/20261018040244_guard_spatial_ref_sys_against_api_writes.sql',
    applied_in_production: true,
    applied_at_utc: '2026-10-18T04:02:43Z',
    source: SOURCE,
    effect: 'EFFECTIVE: statement-level guard triggers refuse writes as anon/authenticated (42501)',
    body_sha256: '937f0dc1f6e850a1eb0f8b83dc76c093619793774fe2b8d55b35d27d743cccb1',
  }),
])

const norm = (f) => path.relative(ROOT, path.resolve(ROOT, String(f)))
const FILES = new Set(APPLIED_IN_PRODUCTION.map((e) => e.file))

/** The verbatim applied SQL held between the markers (null when the markers are missing). */
export function extractAppliedBody(src) {
  const a = src.indexOf(BEGIN)
  const b = src.indexOf(END, a + BEGIN.length)
  if (a < 0 || b < 0) return null
  return src.slice(a + BEGIN.length, b)
}

/** true when the file is a recorded production migration: registered by path, or carrying the header marker. */
export function isAppliedInProductionFile(file) {
  const rel = norm(file)
  if (FILES.has(rel)) return true
  try {
    return fs.readFileSync(path.resolve(ROOT, rel), 'utf8').split('\n', 40).some((l) => l.trim() === APPLIED_MARKER)
  } catch {
    return false
  }
}

/** Throws before anything runs when asked to apply a recorded production migration. */
export function assertNotAppliedInProduction(file) {
  if (isAppliedInProductionFile(file)) {
    throw new Error(`refused: ${norm(file)} is APPLIED IN PRODUCTION (recorded history); it is never re-applied by any tool`)
  }
}

/** Every file path a migration-test entry names (setup, fixtures, apply, verify, posttest, rollback, …). */
export function filesOfTestEntry(t) {
  const out = []
  const add = (x) => {
    if (!x) return
    if (typeof x === 'string') out.push(x)
    else if (typeof x === 'object' && x.fixture) out.push(x.fixture)
  }
  for (const k of ['setup', 'preApply', 'apply', 'verify', 'posttest', 'rollback', 'rollbackPosttest']) for (const x of t[k] || []) add(x)
  add(t.pretest)
  return out
}

export function appliedInProductionReferences(t) {
  return filesOfTestEntry(t).filter((f) => typeof f === 'string' && isAppliedInProductionFile(f))
}

export function bodySha256(src) {
  const body = extractAppliedBody(src)
  return body == null ? null : crypto.createHash('sha256').update(body).digest('hex')
}
