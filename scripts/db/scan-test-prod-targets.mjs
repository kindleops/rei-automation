#!/usr/bin/env node
// "NO PRODUCTION TARGET IN TEST HARNESSES" scan (rc-8.5.15.1, after 2026-10-14).
//
// Fails when a test, pretest/posttest/verify fixture, migration harness or test
// environment file:
//   prod-ref        names the production project ref
//   pooler-host     names a Supabase pooler / db host (*.pooler.supabase.com, db.<ref>.supabase.co)
//   dburl-file      reads /tmp/.dburl (the operator's production URL file)
//   prod-secret-env READS SUPABASE_DB_URL or SUPABASE_SERVICE_ROLE_KEY from the environment
//                   (process.env.X / env.X / $X / ${X} / os.environ) — assigning a
//                   placeholder or deleting it is fine; reading the real one is not
//   ci-prod-secret  a CI test job is handed secrets.SUPABASE_DB_URL / secrets.SUPABASE_SERVICE_ROLE_KEY
//
// Scope (tracked files only):
//   *.test.* / *.spec.* · tests/ test/ __tests__/ e2e/ directories · supabase/tests ·
//   *pretest* / *posttest* / *_verify.sql fixtures · scripts/db/** · *harness* files ·
//   .env.test* · vitest / playwright / jest configs · any script that EXECUTES migration
//   files against a database (reads supabase/migrations|rollbacks/*.sql AND opens a DB
//   connection) · .github/workflows/*.yml (ci-prod-secret only).
// Operational proof / diagnostic scripts that read production deliberately are out of
// scope unless they execute migration SQL.
//
// Every exception is listed in ALLOWLIST with its reason; a file that is allowlisted
// for one rule is still checked for every other rule.
//
//   node scripts/db/scan-test-prod-targets.mjs [--json]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PRODUCTION_PROJECT_REF } from './db-target-guard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '../..')

export const RULES = Object.freeze([
  { id: 'prod-ref', re: new RegExp(PRODUCTION_PROJECT_REF, 'i'), detail: 'names the production project ref' },
  { id: 'pooler-host', re: /\bpooler\.supabase\.com\b|\bdb\.[a-z0-9]{20}\.supabase\.co\b/i, detail: 'names a Supabase pooler / database host' },
  { id: 'dburl-file', re: /\/tmp\/\.dburl\b/, detail: 'reads /tmp/.dburl (the production URL file)' },
  {
    id: 'prod-secret-env',
    // a READ: not followed by an assignment, not preceded by `delete `
    re: /(?<!delete\s)(?:\bprocess\.env\.|\bprocess\.env\[['"]|(?<![.\w])env\.|(?<![.\w])env\[['"]|\bos\.environ(?:\.get\(|\[)['"]?|\$\{?)(SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY)\b(?!['"]?\]?\s*=(?!=))/,
    detail: 'reads a production secret from the environment',
  },
])
const CI_RULE = { id: 'ci-prod-secret', re: /secrets\.(SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY)\b/, detail: 'hands a production secret to a CI job' }

/** file → { rules: [ids], reason } — every exception, with why it is safe. */
export const ALLOWLIST = Object.freeze({
  'scripts/db/db-target-guard.mjs': { rules: ['prod-ref', 'pooler-host'], reason: 'the guard\'s own denylist (refuses these targets)' },
  'scripts/db/scan-test-prod-targets.mjs': { rules: ['prod-ref', 'pooler-host', 'dburl-file', 'prod-secret-env', 'ci-prod-secret'], reason: 'this scanner\'s own patterns and documentation' },
  'apps/api/tests/critical/db-target-guard.test.mjs': { rules: ['prod-ref', 'pooler-host'], reason: 'proves the runner REFUSES these targets; never connects' },
  'apps/api/tests/critical/db-fixture-linter-and-scan.test.mjs': { rules: ['prod-ref', 'pooler-host', 'dburl-file', 'prod-secret-env'], reason: 'feeds forbidden strings to the scanner to prove it catches them; never connects' },
  'apps/api/tests/critical/agent-research-rehearsal.test.mjs': { rules: ['pooler-host'], reason: 'proves the rehearsal REFUSES pooler / Supabase hosts before connecting' },
  'apps/api/tests/critical/agent-db-tls.test.mjs': { rules: ['prod-ref', 'pooler-host'], reason: 'pure TLS hostname-verification unit test on fake sockets; never connects' },
  'apps/api/tests/critical/offerr-staging-guard.test.mjs': { rules: ['prod-ref', 'pooler-host'], reason: 'proves the Offerr staging guard REFUSES the production ref; never connects' },
  'apps/api/tests/critical/map-ownership-production-lookup.test.mjs': { rules: ['prod-ref'], reason: 'asserts the dashboard production config string; stubbed fetch, never connects' },
  'apps/api/tests/critical/inbound-recovery-signature-gate.test.mjs': { rules: ['prod-secret-env'], reason: 'saves and restores the variable around a placeholder value; never connects' },
})

const TEST_FILE = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const FIXTURE_SQL = /(pretest|posttest)[^/]*\.sql$|_verify\.sql$|^supabase\/tests\//
const HARNESS = /harness|rehearsal/i
const ENV_FILE = /(^|\/)\.env\.test[^/]*$|(^|\/)(vitest|playwright|jest)\.config\.[cm]?[jt]s$/
const SOURCE = /\.(m?[jt]sx?|cjs|sql|sh|py|ya?ml|json)$|(^|\/)\.env\.test/
// executes test fixtures / rollbacks / rehearsals (an apply tool or a read-only diagnostic is not a test harness)
const EXECUTES_MIGRATIONS = /(_pretest|_posttest|_verify|_rollback|\.rollback|_ROLLBACK)\.sql|stripOuterTransaction|rehears/i
const OPENS_DB = /new\s+pg\.(Client|Pool)|from\s+['"]pg['"]|require\(['"]pg['"]\)|\bpsql\b|postgres\(|PGlite/

export function listTrackedFiles(root = REPO_ROOT) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`)
  return r.stdout.split('\0').filter(Boolean)
}

/** Is a repo-relative file in the scan scope? `src` is read lazily for the migration-harness test. */
export function inScope(rel, readSrc) {
  if (/(^|\/)node_modules\//.test(rel) || /^tmp\//.test(rel)) return false
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(rel)) return 'workflow'
  if (!SOURCE.test(rel)) return false
  if (TEST_FILE.test(rel) || FIXTURE_SQL.test(rel) || ENV_FILE.test(rel) || /^scripts\/db\//.test(rel)) return 'test'
  if (HARNESS.test(path.basename(rel))) return 'test'
  if (/\.(m?[jt]s|cjs|sh|py)$/.test(rel)) {
    const src = readSrc()
    if (EXECUTES_MIGRATIONS.test(src) && OPENS_DB.test(src)) return 'migration-harness'
  }
  return false
}

/** Scan one file's text. Pure. */
export function scanSource(rel, src, scope = 'test') {
  const findings = []
  const rules = scope === 'workflow' ? [CI_RULE] : RULES
  const allowed = new Set(ALLOWLIST[rel]?.rules || [])
  src.split('\n').forEach((line, i) => {
    for (const rule of rules) {
      if (allowed.has(rule.id)) continue
      if (rule.re.test(line)) findings.push({ file: rel, line: i + 1, rule: rule.id, detail: rule.detail, scope })
    }
  })
  return findings
}

export function scanRepo(root = REPO_ROOT) {
  const findings = []
  let scanned = 0
  for (const rel of listTrackedFiles(root)) {
    let src = null
    const read = () => (src ??= fs.readFileSync(path.join(root, rel), 'utf8'))
    let scope
    try { scope = inScope(rel, read) } catch { continue }
    if (!scope) continue
    scanned++
    findings.push(...scanSource(rel, read(), scope))
  }
  return { scanned, findings }
}

function main(argv) {
  const { scanned, findings } = scanRepo()
  if (argv.includes('--json')) console.log(JSON.stringify({ scanned, findings }, null, 2))
  else {
    for (const f of findings) console.log(`${f.file}:${f.line}: [${f.rule}] ${f.detail} (${f.scope})`)
    console.log(`scan-test-prod-targets: ${scanned} file(s) in scope, ${findings.length} finding(s)`)
  }
  return findings.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
